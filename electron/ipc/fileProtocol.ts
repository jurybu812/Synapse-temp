/**
 * IPC File Protocol — synapse-file://
 *
 * ★ M4-4-S3：根治 Electron 下编辑器图片/视频/PDF「黑屏只剩文件名」。
 *
 * 根因：渲染进程在 http(dev)/file(prod) 源下、webSecurity 默认开启时，无法用裸 Windows 绝对路径
 * （`<img src="C:\...\x.png">`）加载本地资源。解法：注册一个自定义 standard + secure 协议
 * `synapse-file://`，由主进程把 URL 映射回真实本地路径并经 registerFileProtocol 回填，
 * 渲染进程直接用 `synapse-file://local/<encodeURIComponent(绝对路径)>` 访问。
 *
 * 结构对称 electron/ipc/wallpaper.ts：
 *   1) 顶层 protocol.registerSchemesAsPrivileged 注册 scheme（靠 main.ts import 触发此副作用，whenReady 前）。
 *   2) 导出 registerFileProtocol()，在 app.whenReady 内调用，registerFileProtocol(callback({path})) 旧 API。
 *
 * 与 wallpaper 的差异：wallpaper 限定在受管目录下；本协议放宽到「任意本地存在文件 + 扩展名白名单」，
 * 口径与 file:read / file:readBinary（resolveFilePath 接受任意绝对路径）一致，安全基线不低于现状。
 *
 * 安全（关键）：decodeURIComponent → path.normalize → 绝对路径/存在/是文件/扩展名白名单 校验。
 * 防 `..\` 与二次 URL 编码穿越；盘符大小写归一。
 */

import { protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { isFilePathAuthorized } from '../fileAccess';

const SCHEME = 'synapse-file';

// 扩展名白名单：仅允许「可视类型」——图片 + 常见视频 + pdf。
// 与 src/services/fileSystem.ts getDisplayUrl 的白名单保持一致（前后端两侧都校验）。
const ALLOWED_EXTENSIONS = new Set([
    // 图片
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
    // 视频
    '.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogg', '.ogv',
    // PDF
    '.pdf',
]);

protocol.registerSchemesAsPrivileged([
    {
        scheme: SCHEME,
        privileges: {
            standard: true,
            secure: true,
            // 开 fetch / stream，便于 pdf.js 等以 fetch 拉取、视频分段 range 请求；图片走 img.src 即可。
            supportFetchAPI: true,
            corsEnabled: false,
            stream: true,
        },
    },
]);

/**
 * 把 synapse-file:// URL 解析为真实本地路径，并做安全校验。
 * @returns 通过校验的绝对路径，否则 null。
 */
export function resolveProtocolPath(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    // URL 形态：synapse-file://local/<encodeURIComponent(绝对路径)>
    // 真实路径整段被 encode 进 pathname；host 固定为 'local'（仅作占位，不参与路径）。
    // 取 pathname 去前导斜杠后 decode。decode 一次即得原始绝对路径——若攻击者做了二次编码，
    // 这里只 decode 一次，残留的 %xx 不会被当作分隔符，normalize 后也不会穿越（仍是字面字符）。
    const encoded = url.pathname.replace(/^\/+/, '');
    if (!encoded) return null;

    let decoded: string;
    try {
        decoded = decodeURIComponent(encoded);
    } catch {
        // 非法百分号编码（如残缺 %）——拒绝。
        return null;
    }

    // 规范化：统一分隔符 → normalize 折叠 . / .. → 绝对路径校验。
    const normalized = path.normalize(decoded);

    // 必须是绝对路径（防相对路径经 process.cwd 解析到意外位置）。
    if (!path.isAbsolute(normalized)) return null;

    // 盘符大小写归一（Windows：把盘符字母统一大写，避免大小写绕过白名单/缓存差异）。
    let resolved = normalized;
    if (/^[a-zA-Z]:/.test(resolved)) {
        resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1);
    }

    // ★ M4-4 安全收口：把「绝对路径」收紧为「真正的本地盘符路径」。
    // path.isAbsolute('\\\\server\\share\\x.png') === true，故仅靠绝对判定无法挡掉：
    //   - UNC 网络路径（\\server\share\...）：statSync 会触发对远程 SMB 的出站连接，
    //     Windows 访问 UNC 自动协商 NTLM，泄露当前用户 NTLM hash（可离线爆破 / pass-the-hash）。
    //   - 设备/长路径命名空间（\\.\、\\?\）：可达物理设备、卷、命名管道等，超出本期设计声明。
    // 本期设计声明放宽范围是「任意本地存在文件」；UNC/网络/设备路径属设计取舍之外的越界暴露面，
    // 后果（凭据外泄）比单纯读本地文件更严重。这里仅放行 `盘符:\` 形式的真正本地盘符路径，
    // 其余（含一切 \\ 开头的 UNC / 设备前缀）一律拒绝。
    // 说明：normalize 在 Windows 上已把分隔符统一为 `\`，故用 \\ 匹配盘符后的分隔符。
    if (!/^[a-zA-Z]:\\/.test(resolved)) return null;

    // 扩展名白名单。
    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return null;

    // 自定义协议只展示主进程已登记的工作区或 Synapse 自己创建的临时产物。
    // 不能让 renderer 通过手工拼接 URL 绕过 file IPC 的访问范围。
    if (!isFilePathAuthorized(resolved)) return null;

    // 存在性 + 必须是文件（非目录/符号链接目标异常等由 statSync 抛出捕获）。
    try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) return null;
    } catch {
        return null;
    }

    return resolved;
}

export function registerFileProtocol(): void {
    protocol.registerFileProtocol(SCHEME, (request, callback) => {
        try {
            const resolved = resolveProtocolPath(request.url);
            if (!resolved) {
                // -6 = net::ERR_FILE_NOT_FOUND（与 wallpaper 一致，渲染端表现为加载失败而非崩溃）。
                callback({ error: -6 });
                return;
            }
            callback({ path: resolved });
        } catch {
            // -2 = net::ERR_FAILED。
            callback({ error: -2 });
        }
    });
}
