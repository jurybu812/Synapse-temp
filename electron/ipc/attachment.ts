/**
 * IPC Attachment Handler（M2-R6 附件分离存储 · 第1段 blob 存储层）
 *
 * 内容寻址（content-addressed）存储：对附件原始二进制算 sha256，按 sha256 寻址落盘，
 * 同一二进制天然去重。对话本体/messages 只存 sha256 引用，实体不进 DB、不进 record 源。
 *
 * 实体落盘：<userData>/attachments/<sha256[:2]>/<sha256>.<ext>（两级分桶防单目录文件爆炸）。
 * 账本表：attachments(sha256 PK, mime, kind, size, ref_count, created_at)，记 refCount 供 GC。
 *
 * 设计要点：
 * - sha256 = 对「原始二进制」算（dataUrl/纯 base64 先解码再算），与浏览器 crypto.subtle 口径严格一致：
 *   两端都走 base64 → raw bytes → SHA-256，保证同一二进制在桌面/网页算出同一 sha256（抽象边界）。
 *   非法 base64 两端都严格拒收（Electron 解码前校验字符集、Web atob 抛错），保证「同一输入要么两端
 *   都成功且字节一致、要么两端都拒收」——绝不出现一端宽容落字节、另一端拒收的跨端分叉。
 * - 路径穿越防护：仅接受严格 64 位小写 hex 的 sha256；非法直接拒绝。
 *   分桶/文件名全部由校验过的 sha256 拼成，绝不可能含 `..` 或分隔符。
 * - 落盘原子写：先写临时文件再 rename，杜绝半截文件（与全局「重要文件原子写」规则一致）。
 * - put 去重：sha256 命中（文件已在）→ 只 ref_count+1，不重复写盘；否则写盘 + 账本插入(ref_count=1)。
 * - delete = refCount-1，归零才删实体 + 删账本行（GC）。addRef/release 为引用层(第2段)预留的计数辅助。
 * - spawn 无关（不跑外部进程）；所有失败统一返回 { error:true, message }，不抛给渲染进程。
 */

import { ipcMain, app } from 'electron';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getDatabase } from '../database';

/** 统一失败返回结构 */
interface AttachmentError {
    error: true;
    message: string;
}

/** put 成功返回的引用元数据（第2段消息引用层据此写入 messages） */
interface AttachmentRef {
    sha256: string;
    size: number;
    mime: string;
    kind: string;
    name: string;
}

/** 账本行映射结果 */
interface AttachmentMeta {
    sha256: string;
    mime: string;
    kind: string;
    size: number;
    refCount: number;
    createdAt: number;
}

const ATTACHMENT_DIR_NAME = 'attachments';
/** 单附件大小上限，防滥用撑爆磁盘（与 wallpaper 25MB 同量级，附件可稍大）。 */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** sha256 严格校验：64 位小写 hex。任何不匹配的输入一律拒绝，从根上杜绝路径穿越。 */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * mime → 落盘扩展名（仅影响文件名可读性，sha256 才是真相源）。
 * 未知 mime 用 .bin 兜底；get 时按账本里的 mime 反推同一 ext 定位文件，无需扫目录。
 */
const EXT_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/zip': 'zip',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function attachmentRoot(): string {
    return path.join(app.getPath('userData'), ATTACHMENT_DIR_NAME);
}

function extForMime(mime: unknown): string {
    if (typeof mime === 'string') {
        const ext = EXT_BY_MIME[mime.trim().toLowerCase()];
        if (ext) return ext;
    }
    return 'bin';
}

/** 校验并返回归一化（小写）sha256，非法返回 null。 */
function safeSha256(sha256: unknown): string | null {
    if (typeof sha256 !== 'string') return null;
    const s = sha256.trim().toLowerCase();
    return SHA256_RE.test(s) ? s : null;
}

/** 由校验过的 sha256 + ext 拼出实体绝对路径：<root>/<前2位>/<sha256>.<ext>。 */
function entityPath(sha256: string, ext: string): string {
    return path.join(attachmentRoot(), sha256.slice(0, 2), `${sha256}.${ext}`);
}

/**
 * 解析 put 入参里的二进制载荷：支持 dataUrl（data:<mime>;base64,xxx）或纯 base64 串。
 * 返回 { buffer, mimeFromDataUrl? }；mimeFromDataUrl 用于在调用方未显式给 mime 时兜底。
 * 解析失败返回 null。
 */
function decodePayload(input: unknown): { buffer: Buffer; mimeFromDataUrl?: string } | null {
    if (typeof input !== 'string' || !input) return null;
    let base64 = input.trim();
    let mimeFromDataUrl: string | undefined;

    const dataUrlMatch = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(base64);
    if (dataUrlMatch) {
        const declaredMime = dataUrlMatch[1]?.trim();
        const isBase64 = !!dataUrlMatch[2];
        const payload = dataUrlMatch[3] ?? '';
        if (declaredMime) mimeFromDataUrl = declaredMime;
        if (!isBase64) {
            // 非 base64 的 dataUrl（URL 编码文本）——解码成 UTF-8 字节存盘。
            try {
                return { buffer: Buffer.from(decodeURIComponent(payload), 'utf-8'), mimeFromDataUrl };
            } catch {
                return null;
            }
        }
        base64 = payload;
    }

    // 去掉可能的空白（换行等），仅保留 base64 字符。
    base64 = base64.replace(/\s/g, '');
    if (!base64) return null;
    try {
        // ★ 跨端对等修复：Buffer.from(base64,'base64') 对非法字符宽容（忽略后继续解码），
        //   而 Web 端 atob 遇到字符集外字符直接抛错 → 整个 put 失败。两端策略分叉会导致：
        //   同一坏 base64 桌面落「忽略坏字符后」的字节序列并算出某 sha256，网页直接拒收；
        //   即便都解码，「忽略坏字符」与「严格解码」的字节集也可能不同，破坏跨端 sha256 一致性。
        //   这里统一为「都严格」：解码前用 atob 接受的同一字符集校验，不匹配即返回 null（拒收），
        //   与 Web atob 抛错语义对齐——同一输入要么两端都成功且字节一致、要么两端都拒收。
        if (!/^[A-Za-z0-9+/=]*$/.test(base64)) return null;
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length === 0) return null;
        return { buffer, mimeFromDataUrl };
    } catch {
        return null;
    }
}

function mapRow(row: any): AttachmentMeta | null {
    if (!row) return null;
    return {
        sha256: row.sha256,
        mime: row.mime ?? '',
        kind: row.kind ?? '',
        size: row.size ?? 0,
        refCount: row.ref_count ?? 0,
        createdAt: row.created_at ?? 0,
    };
}

/**
 * 原子写盘：临时文件 → rename，避免并发/崩溃留半截文件。
 * ★ 异步化（fs.promises）：put 单次最大 50MB 的写盘是同步主进程事件循环的主要阻塞源
 *   （主进程单线程，期间所有窗口/IPC/菜单短暂卡顿）。改 await fsp.writeFile 把阻塞挪出事件循环。
 */
async function atomicWrite(targetPath: string, buffer: Buffer): Promise<void> {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, targetPath);
}

/** 判断路径是否存在（异步，不阻塞事件循环）。 */
async function pathExists(p: string): Promise<boolean> {
    try {
        await fsp.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * 在分桶目录里定位 sha256 对应的实体文件（优先按账本 mime 推的 ext，失配则扫目录兜底）。
 * 找不到返回 null。get/has/删除三处共用，统一「ext 失配兜底」口径。
 * ★ 异步化：existsSync/readdirSync 改 fs.promises 版，避免主进程同步阻塞。
 */
async function locateEntity(sha256: string, mime: string): Promise<string | null> {
    const primary = entityPath(sha256, extForMime(mime));
    if (await pathExists(primary)) return primary;
    const bucket = path.join(attachmentRoot(), sha256.slice(0, 2));
    try {
        const entries = await fsp.readdir(bucket);
        const hit = entries.find(f => f.startsWith(`${sha256}.`) || f === sha256);
        if (hit) return path.join(bucket, hit);
    } catch { /* 目录不存在/读失败按未找到处理 */ }
    return null;
}

/** 删实体文件（含 ext 失配兜底）；失败不抛，删账本由调用方负责。异步化。 */
async function removeEntityFile(sha256: string, mime: string): Promise<void> {
    try {
        const found = await locateEntity(sha256, mime);
        if (found) await fsp.rm(found, { force: true });
    } catch { /* 实体删除失败不阻断账本清理 */ }
}

export function registerAttachmentHandlers(): void {
    const db = getDatabase();

    /**
     * 存入附件。入参: { data, mime?, name?, kind? }
     *   - data: dataUrl 或纯 base64（对其原始二进制算 sha256）
     *   - mime: 显式 MIME；缺省时取 dataUrl 里声明的，再缺省 application/octet-stream
     *   - name: 原始文件名（仅回传给引用层，不落账本）
     *   - kind: 业务分类（如 'image' / 'file'），落账本
     * 返回: { sha256, size, mime, kind, name } | { error, message }
     *
     * 去重：sha256 命中已有实体 → 仅 ref_count+1（复用）；否则写盘 + 账本插入(ref_count=1)。
     */
    ipcMain.handle('attachment:put', async (_e, opts: { data?: string; mime?: string; name?: string; kind?: string }): Promise<AttachmentRef | AttachmentError> => {
        const decoded = decodePayload(opts?.data);
        if (!decoded) {
            return { error: true, message: '附件载荷为空或无法解析（需 dataUrl 或 base64）' };
        }
        const { buffer } = decoded;
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
            return { error: true, message: `附件超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 限制` };
        }

        const mime = (typeof opts?.mime === 'string' && opts.mime.trim())
            ? opts.mime.trim()
            : (decoded.mimeFromDataUrl || 'application/octet-stream');
        const kind = (typeof opts?.kind === 'string' && opts.kind.trim()) ? opts.kind.trim() : 'file';
        const name = (typeof opts?.name === 'string') ? opts.name : '';

        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const ext = extForMime(mime);
        const dest = entityPath(sha256, ext);
        const size = buffer.length;

        try {
            const existing = mapRow(db.prepare('SELECT * FROM attachments WHERE sha256 = ?').get(sha256));
            if (existing) {
                // 账本已记：去重命中。确保实体文件在（账本/文件可能因外部清理失配，缺则补写）。
                if (!(await locateEntity(sha256, existing.mime || mime))) {
                    await atomicWrite(dest, buffer);
                }
                db.prepare('UPDATE attachments SET ref_count = ref_count + 1 WHERE sha256 = ?').run(sha256);
                return { sha256, size: existing.size || size, mime: existing.mime || mime, kind: existing.kind || kind, name };
            }

            // 新附件：写盘 + 账本插入(ref_count=1)。
            await atomicWrite(dest, buffer);
            db.prepare(
                `INSERT INTO attachments (sha256, mime, kind, size, ref_count, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)
                 ON CONFLICT(sha256) DO UPDATE SET ref_count = ref_count + 1`,
            ).run(sha256, mime, kind, size, Math.floor(Date.now() / 1000));
            return { sha256, size, mime, kind, name };
        } catch (err: any) {
            return { error: true, message: `附件写入失败: ${err?.message ?? err}` };
        }
    });

    /**
     * 读回附件为 base64 dataUrl。入参: sha256（字符串）。
     * 返回: { sha256, mime, size, dataUrl } | null（找不到/非法）。
     * dataUrl 形如 data:<mime>;base64,xxx，供渲染/发 API 还原。
     */
    ipcMain.handle('attachment:get', async (_e, sha256: string) => {
        const safe = safeSha256(sha256);
        if (!safe) return null;
        const meta = mapRow(db.prepare('SELECT * FROM attachments WHERE sha256 = ?').get(safe));
        const mime = meta?.mime || 'application/octet-stream';
        const filePath = await locateEntity(safe, mime);
        if (!filePath) return null;
        try {
            // ★ 异步读盘（fs.promises.readFile）：50MB 同步 readFileSync 会阻塞主进程事件循环。
            const buffer = await fsp.readFile(filePath);
            return {
                sha256: safe,
                mime,
                size: meta?.size ?? buffer.length,
                dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
            };
        } catch {
            return null;
        }
    });

    /**
     * 判断附件是否存在（账本有行 且 实体文件在）。入参: sha256。返回: boolean。
     */
    ipcMain.handle('attachment:has', async (_e, sha256: string) => {
        const safe = safeSha256(sha256);
        if (!safe) return false;
        const meta = mapRow(db.prepare('SELECT * FROM attachments WHERE sha256 = ?').get(safe));
        if (!meta) return false;
        return (await locateEntity(safe, meta.mime)) !== null;
    });

    /**
     * 释放一次引用（refCount-1），归零则删实体 + 删账本行（GC）。
     * delete 与 release 共用此实现（语义一致，两个 channel 是给引用层的两种命名习惯）。
     * 返回: { sha256, refCount, deleted }。
     */
    const releaseRef = async (sha256: unknown): Promise<{ sha256: string; refCount: number; deleted: boolean } | AttachmentError> => {
        const safe = safeSha256(sha256);
        if (!safe) return { error: true, message: '非法 sha256' };
        const meta = mapRow(db.prepare('SELECT * FROM attachments WHERE sha256 = ?').get(safe));
        if (!meta) return { sha256: safe, refCount: 0, deleted: true };

        const nextRef = meta.refCount - 1;
        if (nextRef > 0) {
            db.prepare('UPDATE attachments SET ref_count = ? WHERE sha256 = ?').run(nextRef, safe);
            return { sha256: safe, refCount: nextRef, deleted: false };
        }
        // 归零：删实体（含 ext 失配兜底，异步）+ 删账本行（GC）。
        await removeEntityFile(safe, meta.mime);
        db.prepare('DELETE FROM attachments WHERE sha256 = ?').run(safe);
        return { sha256: safe, refCount: 0, deleted: true };
    };

    ipcMain.handle('attachment:delete', (_e, sha256: string) => releaseRef(sha256));

    /**
     * 显式 +1 引用（引用层第2段用：同一 sha256 被多条消息复用时手动加计数）。
     * 入参: sha256。返回: { sha256, refCount } | { error, message }。
     * 注意: 仅对已存在账本行的 sha256 生效；不存在返回错误（addRef 不负责写盘，写盘走 put）。
     */
    ipcMain.handle('attachment:addRef', (_e, sha256: string) => {
        const safe = safeSha256(sha256);
        if (!safe) return { error: true, message: '非法 sha256' };
        const meta = mapRow(db.prepare('SELECT * FROM attachments WHERE sha256 = ?').get(safe));
        if (!meta) return { error: true, message: '附件不存在，无法 addRef（请先 put）' };
        db.prepare('UPDATE attachments SET ref_count = ref_count + 1 WHERE sha256 = ?').run(safe);
        return { sha256: safe, refCount: meta.refCount + 1 };
    });

    /**
     * release = delete 的同义辅助（refCount-1 + 归零 GC），语义对齐 addRef，供引用层成对调用。
     */
    ipcMain.handle('attachment:release', (_e, sha256: string) => releaseRef(sha256));
}
