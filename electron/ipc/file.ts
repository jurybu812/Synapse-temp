/**
 * IPC File Handler
 * 文件系统操作：read/write/list/search/rename/delete
 */

import { app, ipcMain, shell, type WebContents } from 'electron';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { searchFilesInDirectory } from '../fileSearch';
import {
    cancelPendingFileAccessGrant,
    classifyAgentFileAccess,
    completeAgentFileAccessGrant,
    enforceAgentFileAccess,
    enforceAgentFileAccessRequests,
    getPendingFileAccessGrantDetails,
    isRegisteredTemporaryFileRoot,
    isWithinRegisteredRootForSender,
    prepareAgentFileAccessGrant,
    registerTemporaryFileRoot,
    revokeFileAccessGrantsForSender,
    resolveFilePath,
    unregisterTemporaryFileRoot,
    type AgentFileAccessContext,
    type AgentFileAccessRequest,
} from '../fileAccess';
import { writeUtf8FileAtomically } from '../atomicFile';

const OFFICE_EXTENSIONS = new Set(['.doc', '.docm', '.docx', '.ppt', '.pptm', '.pptx', '.xls', '.xlsx', '.xlsm']);
const cleanupRegisteredSenders = new Set<number>();
const fileApprovalPolicies = new Map<number, { autoApproveWrite: boolean }>();

interface ActiveSensitiveApproval {
    senderId: number;
    requestId: string;
    finish: (approved: boolean) => void;
    cancel: () => void;
}

const activeSensitiveApprovals = new Map<string, ActiveSensitiveApproval>();
const activeSensitiveApprovalRequestKeys = new Map<string, string>();
let sensitiveApprovalResponseHandlerRegistered = false;

type ExpectedContentOptions = { expectedContent?: string };

function readExpectedContentOption(options?: ExpectedContentOptions): string | undefined {
    if (!options || !Object.prototype.hasOwnProperty.call(options, 'expectedContent')) return undefined;
    if (typeof options.expectedContent !== 'string') throw new Error('删除内容校验参数无效');
    return options.expectedContent;
}

function contentDeleteConflict(currentContent: string | null) {
    return {
        conflict: true,
        message: '文件已在删除前被其它操作修改',
        currentContent,
    };
}

function deleteFileIfContentMatches(targetPath: string, expectedContent: string) {
    if (!fs.existsSync(targetPath)) return contentDeleteConflict(null);
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) return contentDeleteConflict(null);
    const currentContent = fs.readFileSync(targetPath, 'utf-8');
    if (currentContent !== expectedContent) return contentDeleteConflict(currentContent);
    fs.rmSync(targetPath, { force: true });
    return { success: true };
}

function sensitiveApprovalKey(senderId: number, approvalId: string): string {
    return `${senderId}:${approvalId}`;
}

type SensitiveApprovalLevel = 'auto' | 'read' | 'write' | 'command' | 'dangerous';

interface SensitiveApprovalRendererRequest {
    requestId: string;
    title: string;
    message: string;
    details: string[];
    confirmLabel: string;
    toolName: string;
    level: SensitiveApprovalLevel;
    conversationId?: string;
    ownerId?: string;
    runId?: string;
    callId?: string;
}

function registerSensitiveApprovalResponseHandler(): void {
    if (sensitiveApprovalResponseHandlerRegistered) return;
    sensitiveApprovalResponseHandlerRegistered = true;
    ipcMain.on('sensitive-approval:response', (event, payload: { requestId?: unknown; approved?: unknown }) => {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
        const registryKey = activeSensitiveApprovalRequestKeys.get(requestId);
        if (!registryKey) return;
        const active = activeSensitiveApprovals.get(registryKey);
        if (!active || active.senderId !== event.sender.id) return;
        active.finish(payload.approved === true);
    });
}

export function cancelSensitiveOperationApproval(senderId: number, approvalId: string): boolean {
    const active = activeSensitiveApprovals.get(sensitiveApprovalKey(senderId, approvalId));
    if (!active) return false;
    active.cancel();
    return true;
}

function cancelSensitiveOperationApprovalsForSender(senderId: number): void {
    for (const active of [...activeSensitiveApprovals.values()]) {
        if (active.senderId !== senderId) continue;
        active.cancel();
    }
}

export function shutdownSensitiveOperationApprovals(): void {
    for (const active of [...activeSensitiveApprovals.values()]) {
        active.cancel();
    }
}

function ensureSenderCleanup(sender: WebContents): void {
    if (sender.isDestroyed()) {
        cleanupRegisteredSenders.delete(sender.id);
        fileApprovalPolicies.delete(sender.id);
        cancelSensitiveOperationApprovalsForSender(sender.id);
        revokeFileAccessGrantsForSender(sender.id);
        return;
    }
    if (cleanupRegisteredSenders.has(sender.id)) return;
    cleanupRegisteredSenders.add(sender.id);
    sender.once('destroyed', () => {
        cleanupRegisteredSenders.delete(sender.id);
        fileApprovalPolicies.delete(sender.id);
        cancelSensitiveOperationApprovalsForSender(sender.id);
        revokeFileAccessGrantsForSender(sender.id);
    });
}

export function confirmSensitiveOperationInMainWindow(
    sender: WebContents,
    options: {
        title: string;
        message: string;
        details: string[];
        confirmLabel: string;
        toolName?: string;
        level?: SensitiveApprovalLevel;
        approvalId?: string;
        timeoutMs?: number;
        conversationId?: string;
        ownerId?: string;
        runId?: string;
        callId?: string;
    },
): Promise<boolean> {
    if (sender.isDestroyed()) return Promise.resolve(false);
    ensureSenderCleanup(sender);
    registerSensitiveApprovalResponseHandler();
    const requestId = `sensitive_${randomUUID()}`;
    const registryKey = options.approvalId
        ? sensitiveApprovalKey(sender.id, options.approvalId)
        : `anonymous:${sender.id}:${requestId}`;
    if (options.approvalId) activeSensitiveApprovals.get(registryKey)?.cancel();

    return new Promise<boolean>(resolve => {
        let settled = false;
        const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 2 * 60 * 1000, 2 * 60 * 1000));
        let timeoutHandle: NodeJS.Timeout | null = null;
        let activeRecord: ActiveSensitiveApproval | null = null;

        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            sender.removeListener('destroyed', onSenderGone);
            sender.removeListener('render-process-gone', onSenderGone);
            sender.removeListener('did-start-navigation', onDidStartNavigation);
            if (activeSensitiveApprovals.get(registryKey) === activeRecord) {
                activeSensitiveApprovals.delete(registryKey);
                activeSensitiveApprovalRequestKeys.delete(requestId);
            }
        };

        const notifyRendererCancel = () => {
            if (sender.isDestroyed()) return;
            try {
                sender.send('sensitive-approval:cancel', { requestId });
            } catch {
                return;
            }
        };

        const finish = (approved: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (!approved) notifyRendererCancel();
            resolve(approved);
        };
        const cancel = () => finish(false);

        const onSenderGone = () => finish(false);
        const onDidStartNavigation = (
            _event: Electron.Event,
            _url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
        ) => {
            if (!isMainFrame || isInPlace) return;
            finish(false);
        };

        activeRecord = { senderId: sender.id, requestId, finish, cancel };
        activeSensitiveApprovals.set(registryKey, activeRecord);
        activeSensitiveApprovalRequestKeys.set(requestId, registryKey);
        timeoutHandle = setTimeout(cancel, timeoutMs);
        sender.once('destroyed', onSenderGone);
        sender.once('render-process-gone', onSenderGone);
        sender.on('did-start-navigation', onDidStartNavigation);

        const rendererRequest: SensitiveApprovalRendererRequest = {
            requestId,
            title: options.title,
            message: options.message,
            details: options.details,
            confirmLabel: options.confirmLabel,
            toolName: options.toolName ?? options.title,
            level: options.level ?? 'dangerous',
            conversationId: options.conversationId,
            ownerId: options.ownerId,
            runId: options.runId,
            callId: options.callId,
        };
        try {
            sender.send('sensitive-approval:request', rendererRequest);
        } catch {
            finish(false);
        }
    });
}

async function authorizeFileOperations(
    sender: WebContents,
    requests: Array<AgentFileAccessRequest & { label?: string }>,
    access: AgentFileAccessContext | undefined,
    options: { title: string; message: string; confirmLabel: string; cancelMessage: string },
): Promise<string[]> {
    try {
        return enforceAgentFileAccessRequests(requests, access, sender.id);
    } catch (error) {
        if (access?.grantId || requests.some(request => !isWithinRegisteredRootForSender(request.filePath, sender.id))) throw error;
        const resolvedRequests = requests.map(request => ({
            ...request,
            resolvedPath: resolveFilePath(request.filePath),
        }));
        const details = resolvedRequests.map(request => {
            const operation = request.operation === 'delete' ? '删除/移出' : request.operation === 'write' ? '创建/修改' : '读取';
            return `${request.label ?? '路径'}（${operation}）：${request.resolvedPath}`;
        });
        const approved = await confirmSensitiveOperationInMainWindow(sender, {
            title: options.title,
            message: options.message,
            details,
            confirmLabel: options.confirmLabel,
        });
        if (!approved) throw new Error(options.cancelMessage);
        return resolvedRequests.map(request => request.resolvedPath);
    }
}

async function authorizeFileMutation(
    sender: WebContents,
    targetPath: string,
    access: AgentFileAccessContext | undefined,
    operation: 'write' | 'delete',
): Promise<string> {
    const [resolved] = await authorizeFileOperations(sender, [{ filePath: targetPath, operation }], access, {
        title: operation === 'delete' ? '确认删除工作区文件' : '确认修改工作区文件',
        message: operation === 'delete'
            ? '这个操作会删除文件或目录。确认后只会处理下列路径。'
            : '这个操作会创建或修改文件。确认后只会处理下列路径。',
        confirmLabel: operation === 'delete' ? '确认删除' : '确认修改',
        cancelMessage: operation === 'delete' ? '用户取消了删除操作' : '用户取消了文件修改',
    });
    return resolved;
}

function findLibreOffice(): string | null {
    const candidates = [
        process.env.LIBREOFFICE_PATH,
        process.env.SOFFICE_PATH,
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        'soffice',
        'libreoffice',
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
        if (candidate.includes(path.sep) || candidate.includes('/')) {
            if (fs.existsSync(candidate)) return candidate;
            continue;
        }
        return candidate;
    }
    return null;
}

type OfficeConvertResult =
    | { success: true; outputPath: string; format: 'pdf'; tempDir?: string; cacheHit?: boolean }
    | { error: true; message: string };

type OfficeSourceIdentity = {
    canonicalPath: string;
    comparablePath: string;
    size: number;
    mtimeMs: number;
};

const OFFICE_PREVIEW_CACHE_VERSION = 'v1';
const officeConversionFlights = new Map<string, Promise<OfficeConvertResult>>();

function isReadablePdf(filePath: string): boolean {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size < 5) return false;
        const fd = fs.openSync(filePath, 'r');
        try {
            const header = Buffer.alloc(5);
            fs.readSync(fd, header, 0, header.length, 0);
            if (header.toString('ascii') !== '%PDF-') return false;
            const tailLength = Math.min(stat.size, 2048);
            const tail = Buffer.alloc(tailLength);
            fs.readSync(fd, tail, 0, tail.length, stat.size - tailLength);
            return tail.toString('latin1').includes('%%EOF');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
}

function getOfficeConverterIdentity(): string {
    const soffice = findLibreOffice();
    if (!soffice) return 'missing';
    if (!soffice.includes(path.sep) && !soffice.includes('/')) return `command:${soffice}`;
    try {
        const canonicalPath = fs.realpathSync.native(soffice);
        const stat = fs.statSync(canonicalPath);
        const comparablePath = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
        return `${comparablePath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
        return `path:${soffice}`;
    }
}

function readOfficeSourceIdentity(sourcePath: string): OfficeSourceIdentity {
    const canonicalPath = fs.realpathSync.native(sourcePath);
    const comparablePath = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    const stat = fs.statSync(canonicalPath);
    return { canonicalPath, comparablePath, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameOfficeSourceIdentity(left: OfficeSourceIdentity, right: OfficeSourceIdentity): boolean {
    return left.comparablePath === right.comparablePath
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs;
}

function removeOfficePathBestEffort(targetPath: string, recursive = false): void {
    try {
        fs.rmSync(targetPath, { recursive, force: true });
    } catch {}
}

function getOfficeCacheEntry(identity: OfficeSourceIdentity): { cacheDir: string; outputPath: string; key: string } {
    const key = createHash('sha256')
        .update(JSON.stringify({
            version: OFFICE_PREVIEW_CACHE_VERSION,
            path: identity.comparablePath,
            size: identity.size,
            mtimeMs: identity.mtimeMs,
            converter: getOfficeConverterIdentity(),
        }))
        .digest('hex');
    const cacheDir = path.join(app.getPath('userData'), 'cache', 'office-previews', key);
    return { cacheDir, outputPath: path.join(cacheDir, 'preview.pdf'), key };
}

/**
 * ★ FIX-1：把一个本地文件系统目录转成 LibreOffice 能吃的 file URL。
 *   Windows 下绝对路径含反斜杠与盘符（如 C:\Workspace\...），LibreOffice 的
 *   `-env:UserInstallation=file:///...` 只接受正斜杠的 file URL，故：
 *   ①反斜杠 → 正斜杠；②对路径段做编码（保留 ':' '/' 让盘符/分隔符不被转义）。
 */
function toFileUrl(dir: string): string {
    const normalized = dir.replace(/\\/g, '/');
    // 盘符前补一个 '/'（file:///C:/...）；非盘符绝对路径（理论上 Windows 用不到）原样拼。
    const withLeadingSlash = /^[a-zA-Z]:/.test(normalized) ? `/${normalized}` : normalized;
    // encodeURI 保留 :/，把空格/中文等转义，规避带空格用户名导致的 URL 解析失败。
    return `file://${encodeURI(withLeadingSlash)}`;
}

/**
 * ★ FIX-1/FIX-2：单次转换。每次调用都用【全新独立临时 profile + 全新 tempDir】，
 *   通过 `-env:UserInstallation` 隔离 LibreOffice 用户 profile，规避默认 profile
 *   `AppData/Roaming/LibreOffice/4` 的 `.lock` 脏锁与多实例并发抢锁（真机实证：
 *   默认 profile → exit 1 size 0；独立 profile → exit 0 成功）。
 *   profile 目录与 tempDir 同前缀（synapse-office-），随 cleanupTemp 白名单一起放行清理。
 */
function convertOnce(soffice: string, sourcePath: string): Promise<OfficeConvertResult> {
    return new Promise((resolve) => {
        // tempDir 放转换产物（PDF），profileDir 放本次独立的 LibreOffice 用户 profile。
        // 两者都用 synapse-office- 前缀，cleanupTemp 白名单可放行。
        const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'synapse-office-'));
        const profileDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'synapse-office-profile-'));

        const args = [
            // ★ FIX-1：独立临时 profile（必须放在最前，确保启动期就生效）。
            `-env:UserInstallation=${toFileUrl(profileDir)}`,
            '--headless',
            '--nologo',
            '--nofirststartwizard',
            '--convert-to',
            'pdf',
            '--outdir',
            tempDir,
            sourcePath,
        ];

        const child = spawn(soffice, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 60_000);

        const dropProfile = () => {
            // profile 目录是一次性的，转换结束即清，避免临时目录堆积。
            try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
        };

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => {
            clearTimeout(timer);
            dropProfile();
            // 失败时同样清掉本次空 tempDir（仅在 error/非 0 分支清，成功分支保留给调用方读 PDF）。
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
            resolve({ error: true, message: `启动 LibreOffice 失败: ${err.message}` });
        });
        child.on('close', code => {
            clearTimeout(timer);
            dropProfile();
            if (code !== 0) {
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
                resolve({ error: true, message: timedOut ? 'Office 转换超时（60 秒）' : `Office 转换失败: ${stderr || stdout || `exit ${code}`}` });
                return;
            }

            const baseName = path.basename(sourcePath, path.extname(sourcePath));
            const expected = path.join(tempDir, `${baseName}.pdf`);
            if (fs.existsSync(expected)) {
                resolve({ success: true, outputPath: expected, format: 'pdf', tempDir });
                return;
            }
            const produced = fs.readdirSync(tempDir).find(name => name.toLowerCase().endsWith('.pdf'));
            if (produced) {
                resolve({ success: true, outputPath: path.join(tempDir, produced), format: 'pdf', tempDir });
                return;
            }
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
            resolve({ error: true, message: `Office 转换未生成 PDF: ${stderr || stdout || sourcePath}` });
        });
    });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * ★ FIX-2：外层带重试的转换入口。
 *   瞬时锁冲突/并发抢锁是非确定性的——前一次失败、后一次（全新 profile + tempDir）
 *   很可能成功，故失败后短延时重试，最多 OFFICE_CONVERT_ATTEMPTS 次。
 *   全部失败时给【友好文案】（疑似 LibreOffice 实例冲突 + 原始错误附后供排查）。
 */
const OFFICE_CONVERT_ATTEMPTS = 3; // 1 次正常 + 2 次重试

async function convertOfficeToPdf(sourcePath: string): Promise<OfficeConvertResult> {
    const soffice = findLibreOffice();
    if (!soffice) {
        return { error: true, message: '未找到 LibreOffice/soffice，无法转换 Office 文件' };
    }

    const startedAt = Date.now();
    let lastMessage = '';
    let attempts = 0;
    for (let attempt = 1; attempt <= OFFICE_CONVERT_ATTEMPTS; attempt++) {
        attempts = attempt;
        const result = await convertOnce(soffice, sourcePath);
        if ('success' in result) return result;
        lastMessage = result.message;
        // 超时不重试（重试也大概率超时，徒增等待）；其余瞬时失败短延时后重试。
        if (result.message.includes('超时')) break;
        if (attempt < OFFICE_CONVERT_ATTEMPTS) {
            await sleep(400 * attempt); // 递增退避：400ms、800ms。
        }
    }
    const elapsedSeconds = Math.max(0.1, (Date.now() - startedAt) / 1000).toFixed(1);
    if (lastMessage.includes('超时')) {
        return { error: true, message: `${lastMessage}（本次等待 ${elapsedSeconds} 秒）` };
    }
    const looksLikeProfileConflict = /(?:lock|profile|another instance|already in use|userinstallation|正在使用)/i.test(lastMessage);
    return {
        error: true,
        message: looksLikeProfileConflict
            ? `Office 转换失败，LibreOffice 配置可能正被其它实例占用（尝试 ${attempts} 次，用时 ${elapsedSeconds} 秒）。\n${lastMessage}`
            : `Office 转换失败（尝试 ${attempts} 次，用时 ${elapsedSeconds} 秒）。\n${lastMessage}`,
    };
}

async function convertOfficeToPdfCached(
    sourcePath: string,
    sourceIdentity: OfficeSourceIdentity,
    remainingSourceChangeRetries = 1,
): Promise<OfficeConvertResult> {
    const cache = getOfficeCacheEntry(sourceIdentity);
    const inFlight = officeConversionFlights.get(cache.key);
    if (inFlight) return inFlight;

    if (isReadablePdf(cache.outputPath)) {
        const currentIdentity = readOfficeSourceIdentity(sourcePath);
        if (!sameOfficeSourceIdentity(sourceIdentity, currentIdentity)) {
            if (remainingSourceChangeRetries > 0) {
                return convertOfficeToPdfCached(sourcePath, currentIdentity, remainingSourceChangeRetries - 1);
            }
            return { error: true, message: 'Office 文件在预览期间持续变化，请保存完成后重试' };
        }
        return { success: true, outputPath: cache.outputPath, format: 'pdf', cacheHit: true };
    }
    if (fs.existsSync(cache.cacheDir)) {
        removeOfficePathBestEffort(cache.cacheDir, true);
    }

    const flight = (async (): Promise<OfficeConvertResult> => {
        const converted = await convertOfficeToPdf(sourcePath);
        if (!('success' in converted)) return converted;

        const temporaryOutput = `${cache.outputPath}.${randomUUID()}.tmp`;
        let retainConvertedTemp = false;
        try {
            if (!isReadablePdf(converted.outputPath)) {
                return { error: true, message: '转换结果不是有效 PDF' };
            }
            let currentIdentity: OfficeSourceIdentity;
            try {
                currentIdentity = readOfficeSourceIdentity(sourcePath);
            } catch {
                return { error: true, message: 'Office 文件在预览期间已移动或删除，请重新打开' };
            }
            if (!sameOfficeSourceIdentity(sourceIdentity, currentIdentity)) {
                if (remainingSourceChangeRetries > 0) {
                    return await convertOfficeToPdfCached(sourcePath, currentIdentity, remainingSourceChangeRetries - 1);
                }
                return { error: true, message: 'Office 文件在预览期间持续变化，请保存完成后重试' };
            }
            try {
                fs.mkdirSync(cache.cacheDir, { recursive: true });
                fs.copyFileSync(converted.outputPath, temporaryOutput);
                if (!isReadablePdf(temporaryOutput)) {
                    throw new Error('缓存副本不是有效 PDF');
                }
                fs.renameSync(temporaryOutput, cache.outputPath);
                return { success: true, outputPath: cache.outputPath, format: 'pdf', cacheHit: false };
            } catch {
                removeOfficePathBestEffort(cache.cacheDir, true);
                retainConvertedTemp = true;
                return { ...converted, cacheHit: false };
            }
        } finally {
            removeOfficePathBestEffort(temporaryOutput);
            if (!retainConvertedTemp && converted.tempDir) removeOfficePathBestEffort(converted.tempDir, true);
        }
    })();

    officeConversionFlights.set(cache.key, flight);
    try {
        return await flight;
    } finally {
        officeConversionFlights.delete(cache.key);
    }
}

export function registerFileHandlers(): void {
    ipcMain.handle('file:setApprovalPolicy', async (e, policy: { autoApproveWrite?: boolean }) => {
        ensureSenderCleanup(e.sender);
        const requested = policy?.autoApproveWrite === true;
        const current = fileApprovalPolicies.get(e.sender.id)?.autoApproveWrite === true;
        let approved = requested;
        if (requested && !current) {
            approved = await confirmSensitiveOperationInMainWindow(e.sender, {
                title: '确认开启自动批准写入？',
                message: '开启后，当前窗口后续在已授权工作区内的文件写入与删除可跳过逐次确认；工作区外访问仍会单独确认。',
                details: [
                    '范围：当前 Synapse 窗口',
                    '操作：工作区内写入与删除',
                    '关闭方式：在「设置 → 安全」中关闭自动批准写入',
                ],
                confirmLabel: '开启自动批准写入',
                approvalId: 'file-policy:auto-write',
            });
        }
        fileApprovalPolicies.set(e.sender.id, { autoApproveWrite: approved });
        return { autoApproveWrite: approved };
    });

    ipcMain.handle('file:prepareAccessGrant', (e, access: AgentFileAccessContext) => {
        ensureSenderCleanup(e.sender);
        const challengeId = prepareAgentFileAccessGrant(e.sender.id, access);
        return challengeId;
    });

    ipcMain.handle('file:completeAccessGrant', async (e, challengeId: string) => {
        const pending = getPendingFileAccessGrantDetails(e.sender.id, challengeId);
        const autoApproveWorkspaceWrite = pending.scope === 'workspace'
            && pending.operations.some(operation => operation === 'write' || operation === 'delete')
            && fileApprovalPolicies.get(e.sender.id)?.autoApproveWrite === true;
        const approved = autoApproveWorkspaceWrite || await confirmSensitiveOperationInMainWindow(e.sender, {
            title: pending.scope === 'workspace' ? '确认工作区内文件修改' : '确认工作区外文件访问',
            message: pending.scope === 'workspace'
                ? 'Synapse 将只为这一次工具调用修改当前工作区中的下列路径。'
                : 'Synapse 将只为这一次工具调用授权下列工作区外路径与操作。',
            details: [
                `范围：${pending.scope === 'workspace' ? '当前工作区内' : pending.scope === 'mixed' ? '同时包含工作区内外路径' : '当前工作区外'}`,
                `操作：${pending.operations.join('、')}`,
                ...(pending.workspaceRoot ? [`当前工作区：${pending.workspaceRoot}`] : []),
                ...pending.approvedPaths.map(targetPath => `路径：${targetPath}`),
            ],
            confirmLabel: pending.scope === 'workspace' ? '允许本次修改' : '允许本次访问',
            approvalId: `file:${challengeId}`,
            timeoutMs: Math.max(1_000, pending.expiresAt - Date.now()),
        });
        return completeAgentFileAccessGrant(e.sender.id, challengeId, approved);
    });

    ipcMain.handle('file:cancelAccessGrant', (e, challengeId: string) => {
        cancelSensitiveOperationApproval(e.sender.id, `file:${challengeId}`);
        cancelPendingFileAccessGrant(e.sender.id, challengeId);
    });

    ipcMain.handle('file:showInFolder', async (e, targetPath: string) => {
        const resolved = resolveFilePath(targetPath);
        if (!resolved) return { error: true, message: '路径为空' };
        const approved = await confirmSensitiveOperationInMainWindow(e.sender, {
            title: '在资源管理器中打开',
            message: '确认后，Synapse 会把这个本机路径交给 Windows 资源管理器。',
            details: [`路径：${resolved}`],
            confirmLabel: '打开路径',
        });
        if (!approved) return { error: true, message: '已取消打开资源管理器' };
        if (fs.existsSync(resolved)) {
            const stat = fs.statSync(resolved);
            if (stat.isFile()) {
                shell.showItemInFolder(resolved);
                return { success: true, path: resolved };
            }
            const message = await shell.openPath(resolved);
            return message ? { error: true, message } : { success: true, path: resolved };
        }
        const parent = path.dirname(resolved);
        if (parent !== resolved && fs.existsSync(parent)) {
            const message = await shell.openPath(parent);
            return message ? { error: true, message } : { success: true, path: parent };
        }
        return { error: true, message: `路径不存在: ${resolved}` };
    });

    ipcMain.handle('file:classifyAccess', (_e, filePath: string, workspaceRoot: string | null) => {
        return classifyAgentFileAccess(filePath, workspaceRoot);
    });

    ipcMain.handle('file:exists', (e, filePath: string, access?: AgentFileAccessContext) => {
        return fs.existsSync(enforceAgentFileAccess(filePath, access, e.sender.id, 'read'));
    });

    // 读取文件（返回 string，与前端 SynapseAPI.file.read 类型一致）
    ipcMain.handle('file:read', (e, filePath: string, access?: AgentFileAccessContext) => {
        try {
            filePath = enforceAgentFileAccess(filePath, access, e.sender.id, 'read');
            if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
            const stat = fs.statSync(filePath);
            if (stat.size > 10 * 1024 * 1024) throw new Error('文件超过 10MB 限制');
            return fs.readFileSync(filePath, 'utf-8');
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    // 写入文件
    ipcMain.handle('file:write', async (
        e,
        filePath: string,
        content: string,
        access?: AgentFileAccessContext,
        options?: { expectedContent?: string },
    ) => {
        try {
            filePath = await authorizeFileMutation(e.sender, filePath, access, 'write');
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (options && Object.prototype.hasOwnProperty.call(options, 'expectedContent')) {
                const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
                if (currentContent !== options.expectedContent) {
                    return {
                        conflict: true,
                        message: '文件已在保存前被其它操作修改',
                        currentContent,
                    };
                }
            }
            writeUtf8FileAtomically(filePath, content);
            return { success: true, path: filePath, size: Buffer.byteLength(content) };
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    // 读取二进制文件。用于 PDF / DOCX / PPTX 等 viewer，避免把本地文件按 UTF-8 文本读取。
    ipcMain.handle('file:readBinary', (e, filePath: string, access?: AgentFileAccessContext) => {
        try {
            filePath = enforceAgentFileAccess(filePath, access, e.sender.id, 'read');
            if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
            const stat = fs.statSync(filePath);
            if (stat.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 限制');
            const buffer = fs.readFileSync(filePath);
            return Array.from(buffer);
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    ipcMain.handle('file:convertOffice', async (e, filePath: string, access?: AgentFileAccessContext) => {
        try {
            const resolved = enforceAgentFileAccess(filePath, access, e.sender.id, 'read');
            if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
            const sourceIdentity = readOfficeSourceIdentity(resolved);
            if (sourceIdentity.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 限制');
            const ext = path.extname(resolved).toLowerCase();
            if (!OFFICE_EXTENSIONS.has(ext)) throw new Error(`不支持的 Office 类型: ${ext}`);
            const result = await convertOfficeToPdfCached(resolved, sourceIdentity);
            if ('success' in result) {
                ensureSenderCleanup(e.sender);
                if (!e.sender.isDestroyed()) {
                    registerTemporaryFileRoot(path.dirname(result.outputPath), e.sender.id);
                }
            }
            return result;
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    ipcMain.handle('file:cleanupTemp', (e, targetPath: string) => {
        try {
            const resolved = resolveFilePath(targetPath);
            if (!isRegisteredTemporaryFileRoot(resolved, e.sender.id)) {
                throw new Error('只能清理由当前 Synapse 进程创建并登记的 Office 临时目录');
            }
            const tempRoot = app.getPath('temp');
            const rel = path.relative(tempRoot, resolved);
            // ★ FIX-1：白名单放行 synapse-office- 前缀（含 synapse-office-profile- 独立 profile 目录，
            //   因其同样以 synapse-office- 开头，startsWith 自然命中）。
            if (rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(resolved).startsWith('synapse-office-')) {
                throw new Error('只能清理 Synapse Office 临时目录');
            }
            fs.rmSync(resolved, { recursive: true, force: true });
            unregisterTemporaryFileRoot(resolved, e.sender.id);
            return { success: true };
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    ipcMain.handle('file:rename', async (e, oldPath: string, newPath: string, access?: AgentFileAccessContext) => {
        try {
            [oldPath, newPath] = await authorizeFileOperations(e.sender, [
                { filePath: oldPath, operation: 'delete', label: '源路径' },
                { filePath: newPath, operation: 'write', label: '目标路径' },
            ], access, {
                title: '确认重命名或移动文件',
                message: '这个操作会同时移出源路径并写入目标路径。确认后只会处理下列两个路径。',
                confirmLabel: '确认重命名',
                cancelMessage: '用户取消了重命名操作',
            });
            fs.renameSync(oldPath, newPath);
            return { success: true };
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    ipcMain.handle('file:delete', async (
        e,
        targetPath: string,
        access?: AgentFileAccessContext,
        options?: ExpectedContentOptions,
    ) => {
        try {
            targetPath = await authorizeFileMutation(e.sender, targetPath, access, 'delete');
            const expectedContent = readExpectedContentOption(options);
            if (expectedContent !== undefined) {
                return deleteFileIfContentMatches(targetPath, expectedContent);
            }
            fs.rmSync(targetPath, { recursive: true, force: true });
            return { success: true };
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    ipcMain.handle('file:mkdir', async (e, targetPath: string, access?: AgentFileAccessContext) => {
        try {
            targetPath = await authorizeFileMutation(e.sender, targetPath, access, 'write');
            fs.mkdirSync(targetPath, { recursive: true });
            return { success: true };
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    // 列出目录
    ipcMain.handle('file:list', (e, dirPath: string, access?: AgentFileAccessContext) => {
        try {
            dirPath = enforceAgentFileAccess(dirPath, access, e.sender.id, 'read');
            if (!fs.existsSync(dirPath)) return { error: true, message: `目录不存在: ${dirPath}` };
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.') && !e.isSymbolicLink())
                .map(e => ({
                    name: e.name,
                    path: path.join(dirPath, e.name),
                    type: e.isDirectory() ? 'directory' : 'file',
                    extension: e.isFile() ? path.extname(e.name).slice(1).toLowerCase() : undefined,
                    size: e.isFile() ? fs.lstatSync(path.join(dirPath, e.name)).size : undefined,
                }));
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    // 搜索文件内容
    ipcMain.handle('file:search', async (e, dirPath: string, pattern: string, access?: AgentFileAccessContext) => {
        dirPath = enforceAgentFileAccess(dirPath, access, e.sender.id, 'read');
        return (await searchFilesInDirectory(dirPath, pattern)).matches;
    });

    // grep 搜索（复用 file:search 的递归逻辑）
    ipcMain.handle('file:grep', async (e, dirPath: string, query: string, _opts?: { regex?: boolean }, access?: AgentFileAccessContext) => {
        dirPath = enforceAgentFileAccess(dirPath, access, e.sender.id, 'read');
        return (await searchFilesInDirectory(dirPath, query)).matches;
    });
}
