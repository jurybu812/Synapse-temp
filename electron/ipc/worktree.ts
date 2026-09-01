/**
 * IPC Worktree Handler（M2-4）
 * 真 git worktree 管理：在一个 git 仓库基础上 开/列/删/查 独立工作树。
 *
 * 与「对话分支」(worktree-A，纯数据复制) 无关 —— 这里操作的是磁盘上真实的 git worktree，
 * 为后续「让 agent 任务在隔离工作树里改文件」(M2-5) 打基础。
 *
 * 安全约束：
 * - 所有 git 调用走 child_process.spawn + 数组传参（绝不拼 shell 字符串），防命令注入。
 * - 每个 handler 入参含目标 git 仓根 repoRoot，前置校验 `git -C repoRoot rev-parse --is-inside-work-tree`，
 *   非 git 仓返回明确错误（提示先 git init）。
 * - 路径一律 path.resolve 归一；create/remove 目标路径校验防穿越。
 * - 命令失败统一返回 { error: true, message }，不抛异常给渲染进程。
 * - remove 默认不带 --force（git worktree remove 会动 .git、可能丢未提交改动），仅显式 force 才加。
 *
 * 中文路径编码（M2-5 真机定位并修复，详见 decodeOutput / runGit 注释）：
 * - git 子进程输出统一按 UTF-8 解码（旧版照搬 command.ts 的 GBK 口径，对直接 spawn 的 git 是错的）。
 * - runGit 统一注入 `-c core.quotepath=false`，路径以原始 UTF-8 字节输出。
 * - 两端对齐后，含中文目录名的 repoRoot 全功能（create/list/remove/status）正常。
 */

import { ipcMain, app } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/** 统一的失败返回结构 */
interface WorktreeError {
    error: true;
    message: string;
}

interface GitResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** 解析后的单条 worktree 信息（来自 git worktree list --porcelain） */
interface WorktreeEntry {
    path: string;
    head: string | null;
    branch: string | null;
    bare: boolean;
    detached: boolean;
    locked: boolean;
}

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 20_000;

/** worktree 名校验：只允许字母数字、连字符、下划线、点，避免路径穿越与非法分支名。 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * git 子进程输出一律按 UTF-8 解码（含 Windows）。
 *
 * 中文路径根因（M2-5 真机定位）：
 *   git for Windows 直接 spawn 时，对路径/分支名等以 **UTF-8 字节** 输出 stdout/stderr
 *   （git 内部统一 UTF-8，与系统 ANSI 代码页 CP936/GBK 无关；本仓配 core.quotepath=false 见 runGit）。
 *   旧实现照搬 ipc/command.ts 的「Windows 按 GBK 解码」，但 command.ts 跑的是 cmd.exe
 *   （其内建命令输出确实是 GBK），而本文件直接跑 git——编码口径不同，照搬就错。
 *   结果：rev-parse --show-toplevel 的 UTF-8 中文路径被 GBK 误解成乱码（工具包→宸ュ叿鍖），
 *   ensureGitRepo 把乱码当 root，后续 `git -C <乱码>` 真的 cannot change to → worktree 全功能崩。
 *   修复：统一 UTF-8 解码。ASCII（英文路径/分支）在 UTF-8 与 GBK 下字节一致，故不影响英文路径。
 */
function decodeOutput(chunks: Buffer[]): string {
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * 跑一条 git 命令。数组传参 + shell:false（spawn 默认），从根上杜绝注入。
 * args 形如 ['-C', repoRoot, 'worktree', 'list', '--porcelain']。
 *
 * 中文路径防御（与 decodeOutput 配套）：统一注入 `-c core.quotepath=false`，
 * 让 git 把含非 ASCII 的路径/文件名以**原始 UTF-8 字节**输出，而非默认的八进制转义
 * （形如 "\345\267\245…"）——否则即便按 UTF-8 解码也拿不回中文。两端对齐后中文路径全链路通。
 */
function runGit(args: string[], cwd?: string): Promise<GitResult> {
    return new Promise((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        let child;
        try {
            child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
                cwd: cwd || process.cwd(),
                env: { ...process.env },
                timeout: GIT_TIMEOUT_MS,
                windowsHide: true,
            });
        } catch (err: any) {
            resolve({ stdout: '', stderr: err?.message ?? String(err), exitCode: 1 });
            return;
        }

        child.stdout?.on('data', (data: Buffer) => { stdoutChunks.push(data); });
        child.stderr?.on('data', (data: Buffer) => { stderrChunks.push(data); });

        child.on('error', (err) => {
            // git 不存在 / 无法启动
            resolve({ stdout: '', stderr: err.message, exitCode: 1 });
        });

        child.on('close', (code) => {
            resolve({
                stdout: decodeOutput(stdoutChunks).slice(0, MAX_OUTPUT_CHARS),
                stderr: decodeOutput(stderrChunks).slice(0, MAX_OUTPUT_CHARS),
                exitCode: code ?? 1,
            });
        });
    });
}

/** repoRoot 必须是非空字符串且为有效绝对/可解析路径，返回归一化后的绝对路径或错误。 */
function normalizeRepoRoot(repoRoot: unknown): { ok: true; root: string } | WorktreeError {
    if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
        return { error: true, message: '缺少 git 仓库根路径 repoRoot' };
    }
    const resolved = path.resolve(repoRoot.trim());
    if (!fs.existsSync(resolved)) {
        return { error: true, message: `路径不存在: ${resolved}` };
    }
    if (!fs.statSync(resolved).isDirectory()) {
        return { error: true, message: `不是目录: ${resolved}` };
    }
    return { ok: true, root: resolved };
}

/**
 * 前置校验：repoRoot 是否在 git 工作树内，并解析出**真实的主工作树根**。
 *
 * 关键点（Codex review 修正）：不能只用 `--is-inside-work-tree`（它只证明「在仓库里」），
 * 否则传入仓库的子目录时，后续相对路径基准与「主工作树保护」判断都会偏。
 * 这里改用 `git rev-parse --show-toplevel` 拿到真正的主工作树绝对路径作为 root。
 *
 * 成功返回归一化后的真实仓库根；失败返回明确错误（含「先 git init」提示）。
 */
async function ensureGitRepo(repoRoot: unknown): Promise<{ ok: true; root: string } | WorktreeError> {
    const normalized = normalizeRepoRoot(repoRoot);
    if ('error' in normalized) return normalized;

    const result = await runGit(['-C', normalized.root, 'rev-parse', '--show-toplevel']);
    const top = result.stdout.trim();
    if (result.exitCode !== 0 || !top) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return {
            error: true,
            message: `不是 git 仓库: ${normalized.root}（请先在该目录执行 git init）${detail ? ` · ${detail}` : ''}`,
        };
    }
    // git 在 Windows 返回正斜杠路径，统一用 path.resolve 归一，便于后续与 path.resolve 结果比较。
    return { ok: true, root: path.resolve(top) };
}

/**
 * 列出该仓库登记的所有 worktree 的归一化绝对路径集合（含主工作树）。
 * 用于校验 status/remove 的目标确实属于该仓库，而非任意目录。
 * 解析失败时返回错误，调用方据此拒绝操作（安全优先，不放行）。
 */
async function listWorktreePaths(root: string): Promise<{ ok: true; paths: Set<string> } | WorktreeError> {
    const result = await runGit(['-C', root, 'worktree', 'list', '--porcelain']);
    if (result.exitCode !== 0) {
        return { error: true, message: result.stderr.trim() || `git worktree list 失败 (exit ${result.exitCode})` };
    }
    const paths = new Set(parseWorktreeList(result.stdout).map(wt => path.resolve(wt.path)));
    return { ok: true, paths };
}

/**
 * 解析 `git worktree list --porcelain` 输出。
 * porcelain 以空行分隔每条记录，每条形如：
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>     (或 detached / bare / locked)
 */
function parseWorktreeList(stdout: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | null = null;

    const flush = () => {
        if (current) entries.push(current);
        current = null;
    };

    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line === '') { flush(); continue; }

        if (line.startsWith('worktree ')) {
            flush();
            current = {
                path: line.slice('worktree '.length),
                head: null,
                branch: null,
                bare: false,
                detached: false,
                locked: false,
            };
        } else if (!current) {
            continue;
        } else if (line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
            // refs/heads/foo -> foo
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        } else if (line === 'bare') {
            current.bare = true;
        } else if (line === 'detached') {
            current.detached = true;
        } else if (line === 'locked' || line.startsWith('locked ')) {
            current.locked = true;
        }
    }
    flush();
    return entries;
}

/** dest 是否严格位于 baseDir 之内（不含 baseDir 本身）。用归一化相对路径判断，防 `..` 穿越。 */
function isInside(baseDir: string, dest: string): boolean {
    const rel = path.relative(baseDir, dest);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 默认 worktree 存放根：userData/worktrees。 */
function defaultWorktreeBase(): string {
    return path.resolve(app.getPath('userData'), 'worktrees');
}

/**
 * 计算 create 的目标路径（Codex review 修正：显式 path 也做边界约束，防穿越）。
 * - 未传 targetPath：默认放 <userData>/worktrees/<name>，校验归一化后仍在该根内（防 name 穿越）。
 * - 传了 targetPath：path.resolve 归一后，**必须落在 仓库根内 或 <userData>/worktrees 内**，
 *   否则拒绝（避免 `../../...` 把工作树落到任意位置）。
 */
function resolveCreatePath(
    repoRoot: string,
    name: string,
    targetPath: unknown,
): { ok: true; dest: string } | WorktreeError {
    const baseDir = defaultWorktreeBase();

    if (typeof targetPath === 'string' && targetPath.trim()) {
        const dest = path.isAbsolute(targetPath.trim())
            ? path.resolve(targetPath.trim())
            : path.resolve(repoRoot, targetPath.trim());
        if (!isInside(repoRoot, dest) && !isInside(baseDir, dest)) {
            return {
                error: true,
                message: '工作树路径必须位于仓库根目录内，或用户数据目录的 worktrees/ 内（已阻止路径穿越）',
            };
        }
        return { ok: true, dest };
    }

    if (!SAFE_NAME.test(name)) {
        return {
            error: true,
            message: '工作树名只能包含字母、数字、点、连字符、下划线（用于默认路径与分支名）',
        };
    }
    const dest = path.resolve(baseDir, name);
    if (!isInside(baseDir, dest)) {
        return { error: true, message: '非法的工作树名（路径穿越）' };
    }
    return { ok: true, dest };
}

export function registerWorktreeHandlers(): void {
    /**
     * 列出指定仓库的所有 worktree。
     * 入参: { repoRoot }
     * 返回: { worktrees: WorktreeEntry[] } | { error, message }
     */
    ipcMain.handle('worktree:list', async (_e, opts: { repoRoot: string }) => {
        const repo = await ensureGitRepo(opts?.repoRoot);
        if ('error' in repo) return repo;

        const result = await runGit(['-C', repo.root, 'worktree', 'list', '--porcelain']);
        if (result.exitCode !== 0) {
            return { error: true, message: result.stderr.trim() || `git worktree list 失败 (exit ${result.exitCode})` };
        }
        return { worktrees: parseWorktreeList(result.stdout) };
    });

    /**
     * 新建 worktree。
     * 入参: { repoRoot, branch, path?, name? }
     *   - branch: 新建分支名（git worktree add <dest> -b <branch>）
     *   - name: 默认路径用的名字（缺省取 branch）
     *   - path: 显式目标路径（可选，覆盖默认 userData/worktrees/<name>）
     * 返回: { success, path, branch } | { error, message }
     */
    ipcMain.handle('worktree:create', async (_e, opts: { repoRoot: string; branch: string; path?: string; name?: string }) => {
        const repo = await ensureGitRepo(opts?.repoRoot);
        if ('error' in repo) return repo;

        const branch = typeof opts?.branch === 'string' ? opts.branch.trim() : '';
        if (!branch) {
            return { error: true, message: '缺少分支名 branch' };
        }
        if (!SAFE_NAME.test(branch)) {
            return { error: true, message: '分支名只能包含字母、数字、点、连字符、下划线' };
        }

        const name = (typeof opts?.name === 'string' && opts.name.trim()) ? opts.name.trim() : branch;
        const destResult = resolveCreatePath(repo.root, name, opts?.path);
        if ('error' in destResult) return destResult;
        const dest = destResult.dest;

        if (fs.existsSync(dest)) {
            return { error: true, message: `目标路径已存在: ${dest}` };
        }

        // 确保父目录存在（git worktree add 不会自动建多级父目录）。
        // 为在 git 失败时精确回滚，先找出「最浅的、本次将要新建的目录」：
        // 从 dest 的父目录向上走，记录第一个尚不存在的祖先 —— 删它即可连带其下所有本次新建的空层，
        // 且绝不触碰用户已存在的目录（Codex review 修正：避免 git 失败后残留空目录）。
        const parent = path.dirname(dest);
        let shallowestCreated: string | null = null;
        if (!fs.existsSync(parent)) {
            let probe = parent;
            while (!fs.existsSync(probe)) {
                shallowestCreated = probe;
                const up = path.dirname(probe);
                if (up === probe) break; // 抵达根，停止
                probe = up;
            }
        }
        try {
            fs.mkdirSync(parent, { recursive: true });
        } catch (err: any) {
            return { error: true, message: `创建父目录失败: ${err?.message ?? err}` };
        }

        const result = await runGit(['-C', repo.root, 'worktree', 'add', dest, '-b', branch]);
        if (result.exitCode !== 0) {
            // git 失败：清理本次新建的空目录链（仅当确实是我们建的），不影响用户原有内容。
            if (shallowestCreated) {
                try { fs.rmSync(shallowestCreated, { recursive: true, force: true }); } catch { /* 清理失败无伤大雅，忽略 */ }
            }
            return { error: true, message: result.stderr.trim() || result.stdout.trim() || `git worktree add 失败 (exit ${result.exitCode})` };
        }
        return { success: true, path: dest, branch };
    });

    /**
     * 删除 worktree。
     * 入参: { repoRoot, path, force? }
     *   - force 默认 false：git worktree remove 不带 --force（有未提交改动时会拒绝，保护数据）。
     *     仅显式 force=true 才加 --force。
     * 返回: { success, path } | { error, message }
     */
    ipcMain.handle('worktree:remove', async (_e, opts: { repoRoot: string; path: string; force?: boolean }) => {
        const repo = await ensureGitRepo(opts?.repoRoot);
        if ('error' in repo) return repo;

        if (typeof opts?.path !== 'string' || !opts.path.trim()) {
            return { error: true, message: '缺少要删除的 worktree 路径 path' };
        }
        const target = path.resolve(opts.path.trim());

        // 不允许删除主工作树（即 repoRoot 自身）
        if (path.relative(repo.root, target) === '') {
            return { error: true, message: '不能删除主工作树（仓库根目录本身）' };
        }

        // 归属校验：target 必须是该仓库登记的 worktree，否则拒绝（兑现文件头注释承诺）。
        // 解析失败时安全优先不放行。git 原生虽会兜底拒绝非本仓 worktree，这里做显式纵深防御。
        const known = await listWorktreePaths(repo.root);
        if ('error' in known) return known;
        if (!known.paths.has(target)) {
            return { error: true, message: '目标不属于该仓库登记的工作树' };
        }

        const args = ['-C', repo.root, 'worktree', 'remove'];
        if (opts?.force === true) args.push('--force');
        args.push(target);

        const result = await runGit(args);
        if (result.exitCode !== 0) {
            const msg = result.stderr.trim() || result.stdout.trim() || `git worktree remove 失败 (exit ${result.exitCode})`;
            return { error: true, message: msg };
        }
        return { success: true, path: target };
    });

    /**
     * 查看某个 worktree 的工作区状态（git -C <path> status --porcelain）。
     * 入参: { repoRoot, path }
     *   - repoRoot 用于前置校验是否 git 仓；path 是要查状态的工作树目录。
     * 返回: { clean, files: { status, file }[] } | { error, message }
     */
    ipcMain.handle('worktree:status', async (_e, opts: { repoRoot: string; path: string }) => {
        const repo = await ensureGitRepo(opts?.repoRoot);
        if ('error' in repo) return repo;

        if (typeof opts?.path !== 'string' || !opts.path.trim()) {
            return { error: true, message: '缺少要查询状态的 worktree 路径 path' };
        }
        const target = path.resolve(opts.path.trim());

        // 归属校验：只允许对该仓库登记的 worktree 执行 status，杜绝对任意目录探测
        // 「是否为 git 仓 / 有何改动」。解析失败时安全优先不放行。
        const known = await listWorktreePaths(repo.root);
        if ('error' in known) return known;
        if (!known.paths.has(target)) {
            return { error: true, message: '目标不属于该仓库登记的工作树' };
        }

        const result = await runGit(['-C', target, 'status', '--porcelain']);
        if (result.exitCode !== 0) {
            return { error: true, message: result.stderr.trim() || `git status 失败 (exit ${result.exitCode})` };
        }
        const files = result.stdout
            .split(/\r?\n/)
            .filter(line => line.trim() !== '')
            .map(line => ({
                status: line.slice(0, 2).trim(),
                file: line.slice(3),
            }));
        return { clean: files.length === 0, files };
    });
}
