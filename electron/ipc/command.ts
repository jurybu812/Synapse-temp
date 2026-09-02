import { app, ipcMain } from 'electron';
import { createHash, randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { resolveFilePath } from '../fileAccess';
import { confirmSensitiveOperationInMainWindow } from './file';

type CommandTaskStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown';
type CommandArtifactEncoding = 'empty' | 'utf-8-bom' | 'utf-8' | 'gbk';

interface CommandTaskArtifact {
    path: string;
    bytes: number;
    sha256?: string;
    encoding?: CommandArtifactEncoding;
}

export interface CommandTaskSnapshot {
    taskId: string;
    requestHash: string;
    conversationId?: string;
    runId?: string;
    callId?: string;
    ownerId?: string;
    processId?: number;
    processStartedAt?: number;
    processIdentityVerified?: boolean;
    status: CommandTaskStatus;
    startedAt: number;
    approvedAt?: number;
    finishedAt?: number;
    approvalWaitMs?: number;
    executionStartedAt?: number;
    executionFinishedAt?: number;
    executionTimeMs?: number;
    wallTimeMs?: number;
    exitCode?: number;
    stdout: string;
    stderr: string;
    stdoutArtifact: CommandTaskArtifact;
    stderrArtifact: CommandTaskArtifact;
    error?: string;
}

interface CommandTaskRecord extends CommandTaskSnapshot {
    child: ChildProcess | null;
    cancelRequested: boolean;
    cancelOutcomePending: boolean;
    cancelTerminationConfirmed: boolean;
    childClosed: boolean;
    observedExitCode: number | null;
    finalizing: boolean;
    cancelOperation: Promise<void> | null;
    waiters: Set<() => void>;
}

export interface CommandStartRequest {
    command: string;
    cwd?: string;
    taskId?: string;
    conversationId?: string;
    runId?: string;
    callId?: string;
    ownerId?: string;
    approvalStartedAt?: number;
    approvedAt?: number;
}

export interface CommandAccessContext {
    conversationId?: string;
    ownerId?: string;
}

export interface CommandRebindRequest {
    ownerId: string;
    fromId: string;
    toId: string;
}

const PREVIEW_LIMIT = 10_000;
const tasks = new Map<string, CommandTaskRecord>();
const persistedCancelOperations = new Map<string, Promise<CommandTaskSnapshot>>();

function artifactRoot(): string {
    const root = path.join(app.getPath('userData'), 'tool-artifacts', 'commands');
    fs.mkdirSync(root, { recursive: true });
    return root;
}

function safeTaskId(taskId?: string): string {
    const proposed = (taskId || `command_${randomUUID()}`).trim();
    if (!proposed.startsWith('command_') || !/^[A-Za-z0-9._-]{1,160}$/.test(proposed)) {
        throw new Error('taskId 只能包含字母、数字、点、下划线和连字符');
    }
    return proposed;
}

export function listCommandTasks(access: { conversationId: string; ownerId: string }): CommandTaskSnapshot[] {
    if (!access.conversationId?.trim() || !access.ownerId?.trim()) throw new Error('command:list 缺少对话或 owner 身份');
    const byTaskId = new Map<string, CommandTaskSnapshot>();
    for (const record of tasks.values()) {
        if (record.conversationId === access.conversationId && record.ownerId === access.ownerId) {
            byTaskId.set(record.taskId, snapshot(record));
        }
    }
    for (const entry of fs.readdirSync(artifactRoot(), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith('command_') || !entry.name.endsWith('.json')) continue;
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(artifactRoot(), entry.name), 'utf8')) as CommandTaskSnapshot;
            const taskId = safeTaskId(saved.taskId);
            if (entry.name !== `${taskId}.json` || byTaskId.has(taskId)) continue;
            if (saved.conversationId !== access.conversationId || saved.ownerId !== access.ownerId) continue;
            byTaskId.set(taskId, saved);
        } catch {
            continue;
        }
    }
    return [...byTaskId.values()].sort((left, right) => right.startedAt - left.startedAt);
}

function manifestPath(taskId: string): string {
    return path.join(artifactRoot(), `${taskId}.json`);
}

function snapshot(record: CommandTaskRecord): CommandTaskSnapshot {
    return {
        taskId: record.taskId,
        requestHash: record.requestHash,
        conversationId: record.conversationId,
        runId: record.runId,
        callId: record.callId,
        ownerId: record.ownerId,
        processId: record.processId,
        processStartedAt: record.processStartedAt,
        processIdentityVerified: record.processIdentityVerified,
        status: record.status,
        startedAt: record.startedAt,
        approvedAt: record.approvedAt,
        finishedAt: record.finishedAt,
        approvalWaitMs: record.approvalWaitMs,
        executionStartedAt: record.executionStartedAt,
        executionFinishedAt: record.executionFinishedAt,
        executionTimeMs: record.executionTimeMs,
        wallTimeMs: record.wallTimeMs,
        exitCode: record.exitCode,
        stdout: record.stdout,
        stderr: record.stderr,
        stdoutArtifact: { ...record.stdoutArtifact },
        stderrArtifact: { ...record.stderrArtifact },
        error: record.error,
    };
}

function persistSnapshot(value: CommandTaskSnapshot): void {
    const target = manifestPath(value.taskId);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, target);
}

function persist(record: CommandTaskRecord): void {
    persistSnapshot(snapshot(record));
}

function notifyWaiters(record: CommandTaskRecord): void {
    for (const notify of record.waiters) notify();
    record.waiters.clear();
}

function isTerminal(status: CommandTaskStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'unknown';
}

function requestHash(command: string, cwd: string): string {
    return createHash('sha256').update(JSON.stringify({ command, cwd })).digest('hex');
}

function normalizeTimestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function elapsedMs(start: number | undefined, end: number | undefined): number | undefined {
    if (start === undefined || end === undefined) return undefined;
    return Math.max(0, end - start);
}

function applyFinishedTiming(task: CommandTaskSnapshot, finishedAt = Date.now()): void {
    task.finishedAt = finishedAt;
    task.approvalWaitMs = task.approvalWaitMs ?? elapsedMs(task.startedAt, task.approvedAt) ?? 0;
    task.wallTimeMs = elapsedMs(task.startedAt, finishedAt);
    const executionStartedAt = normalizeTimestamp(task.executionStartedAt) ?? normalizeTimestamp(task.processStartedAt);
    if (executionStartedAt !== undefined) {
        task.executionStartedAt = executionStartedAt;
        task.executionFinishedAt = finishedAt;
        task.executionTimeMs = elapsedMs(executionStartedAt, finishedAt);
    } else {
        task.executionTimeMs = task.executionTimeMs ?? 0;
    }
}

function assertTaskAccess(task: CommandTaskSnapshot, access?: CommandAccessContext): void {
    if (!task.conversationId && !task.ownerId) return;
    const conversationMatches = !task.conversationId
        || Boolean(access?.conversationId && task.conversationId === access.conversationId);
    const ownerMatches = !task.ownerId
        || Boolean(access?.ownerId && task.ownerId === access.ownerId);
    if (!conversationMatches || !ownerMatches) {
        throw new Error(`命令任务 ${task.taskId} 不属于当前对话，拒绝访问`);
    }
}

function findReusableCommandTask(taskId: string, expectedRequestHash: string, access?: CommandAccessContext): CommandTaskSnapshot | null {
    const existing = tasks.get(taskId);
    if (existing) {
        if (existing.requestHash !== expectedRequestHash) {
            throw new Error(`taskId ${taskId} 已被另一条命令使用，拒绝混用当前进程中的既有任务`);
        }
        assertTaskAccess(existing, access);
        return snapshot(existing);
    }
    const savedPath = manifestPath(taskId);
    if (!fs.existsSync(savedPath)) return null;
    try {
        const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8')) as CommandTaskSnapshot;
        if (!saved.requestHash || saved.requestHash !== expectedRequestHash) {
            throw new Error(`taskId ${taskId} 已被另一条命令使用，拒绝覆盖既有任务证据`);
        }
        assertTaskAccess(saved, access);
        return saved;
    } catch (error: any) {
        throw new Error(error?.message || `无法读取既有命令任务 ${taskId}`);
    }
}

function createEmptyArtifact(filePath: string): void {
    const handle = fs.openSync(filePath, 'wx');
    fs.closeSync(handle);
}

export function rebindConversationTasks(request: CommandRebindRequest): number {
    const ownerId = request.ownerId?.trim();
    const fromId = request.fromId?.trim();
    const toId = request.toId?.trim();
    if (!ownerId || !fromId || !toId || fromId === toId) return 0;

    let updated = 0;
    const updatedInMemory = new Set<string>();
    for (const record of tasks.values()) {
        if (record.ownerId !== ownerId || record.conversationId !== fromId) continue;
        record.conversationId = toId;
        persist(record);
        updatedInMemory.add(record.taskId);
        updated++;
    }

    const root = artifactRoot();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
            const filePath = path.join(root, entry.name);
            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CommandTaskSnapshot;
            const taskId = safeTaskId(saved.taskId);
            if (entry.name !== `${taskId}.json` || updatedInMemory.has(taskId)) continue;
            if (saved.ownerId !== ownerId || saved.conversationId !== fromId) continue;
            saved.conversationId = toId;
            persistSnapshot(saved);
            updated++;
        } catch {
            // 损坏或非本任务清单不影响其它条目的对话迁移。
        }
    }
    return updated;
}

function hashArtifact(filePath: string): string {
    const hash = createHash('sha256');
    const handle = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(handle);
    }
    return hash.digest('hex');
}

function isUtf8ContinuationByte(value: number): boolean {
    return value >= 0x80 && value <= 0xbf;
}

function trimLeadingPartialUtf8(buffer: Buffer): Buffer {
    let offset = 0;
    while (offset < Math.min(buffer.length, 3) && isUtf8ContinuationByte(buffer[offset])) {
        offset++;
    }
    return offset > 0 ? buffer.subarray(offset) : buffer;
}

function decodeArtifactBuffer(buffer: Buffer): { text: string; encoding: CommandArtifactEncoding } {
    const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const utf8Buffer = hasUtf8Bom ? buffer : trimLeadingPartialUtf8(buffer);
    try {
        return {
            text: new TextDecoder('utf-8', { fatal: true }).decode(utf8Buffer),
            encoding: hasUtf8Bom ? 'utf-8-bom' : 'utf-8',
        };
    } catch {
        return {
            text: new TextDecoder('gbk').decode(buffer),
            encoding: 'gbk',
        };
    }
}

function readArtifactPreview(filePath: string): { bytes: number; text: string; sha256?: string; encoding: CommandArtifactEncoding } {
    if (!fs.existsSync(filePath)) return { bytes: 0, text: '', encoding: 'empty' };
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, PREVIEW_LIMIT * 4);
    if (length === 0) return { bytes: 0, text: '', sha256: createHash('sha256').digest('hex'), encoding: 'empty' };
    const handle = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(handle, buffer, 0, length, stat.size - length);
        const decoded = decodeArtifactBuffer(buffer);
        return { bytes: stat.size, text: decoded.text.slice(-PREVIEW_LIMIT), sha256: hashArtifact(filePath), encoding: decoded.encoding };
    } finally {
        fs.closeSync(handle);
    }
}

function refreshRecordArtifacts(record: CommandTaskRecord): void {
    const stdout = readArtifactPreview(record.stdoutArtifact.path);
    const stderr = readArtifactPreview(record.stderrArtifact.path);
    record.stdout = stdout.text;
    record.stderr = stderr.text;
    record.stdoutArtifact.bytes = stdout.bytes;
    record.stdoutArtifact.sha256 = stdout.sha256;
    record.stdoutArtifact.encoding = stdout.encoding;
    record.stderrArtifact.bytes = stderr.bytes;
    record.stderrArtifact.sha256 = stderr.sha256;
    record.stderrArtifact.encoding = stderr.encoding;
}

async function finalizeTask(
    record: CommandTaskRecord,
    status: CommandTaskStatus,
    exitCode: number,
    error?: string,
): Promise<void> {
    if (record.finalizing || isTerminal(record.status)) return;
    record.finalizing = true;
    refreshRecordArtifacts(record);
    record.exitCode = exitCode;
    applyFinishedTiming(record);
    record.error = error ?? record.error;
    record.status = record.error && status === 'completed' ? 'failed' : status;
    record.child = null;
    try {
        persist(record);
    } catch (persistError: any) {
        record.status = 'unknown';
        record.error = [record.error, `任务清单落盘失败: ${persistError?.message || persistError}`].filter(Boolean).join('\n');
    }
    notifyWaiters(record);
}

function handleChildClose(record: CommandTaskRecord, code: number | null): void {
    record.childClosed = true;
    record.observedExitCode = code;
    if (record.cancelRequested && record.cancelOutcomePending) return;
    const status = record.cancelRequested && record.cancelTerminationConfirmed
        ? 'cancelled'
        : (code === 0 ? 'completed' : 'failed');
    void finalizeTask(record, status, code ?? 1);
}

function restoreInterruptedTasks(): void {
    const root = artifactRoot();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
            const filePath = path.join(root, entry.name);
            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CommandTaskSnapshot;
            if (saved.status !== 'running' && saved.status !== 'cancelling') continue;
            const taskId = safeTaskId(saved.taskId);
            if (entry.name !== `${taskId}.json`) continue;
            const stdoutPath = path.join(root, `${taskId}.stdout.log`);
            const stderrPath = path.join(root, `${taskId}.stderr.log`);
            const stdout = readArtifactPreview(stdoutPath);
            const stderr = readArtifactPreview(stderrPath);
            saved.stdout = stdout.text;
            saved.stderr = stderr.text;
            saved.stdoutArtifact = { path: stdoutPath, bytes: stdout.bytes, sha256: stdout.sha256, encoding: stdout.encoding };
            saved.stderrArtifact = { path: stderrPath, bytes: stderr.bytes, sha256: stderr.sha256, encoding: stderr.encoding };
            saved.status = 'unknown';
            applyFinishedTiming(saved);
            saved.error = 'Synapse 重启时该命令仍处于运行态，无法确认外部副作用是否完成';
            persistSnapshot(saved);
        } catch {
            // 单个损坏清单不阻塞其它任务恢复。
        }
    }
}

export async function startCommandTask(request: CommandStartRequest, allowLegacyUnscoped = false): Promise<CommandTaskSnapshot> {
    const command = typeof request.command === 'string' ? request.command.trim() : '';
    if (!command) throw new Error('command 不能为空');
    if (!allowLegacyUnscoped) {
        const missing = [
            ['conversationId', request.conversationId],
            ['runId', request.runId],
            ['callId', request.callId],
            ['ownerId', request.ownerId],
        ].filter(([, value]) => typeof value !== 'string' || !value.trim()).map(([name]) => name);
        if (missing.length) throw new Error(`command:start 缺少运行身份: ${missing.join(', ')}`);
    }
    const taskId = safeTaskId(request.taskId);

    const hasExplicitCwd = typeof request.cwd === 'string' && request.cwd.trim().length > 0;
    if (hasExplicitCwd) {
        request.cwd = resolveFilePath(request.cwd!.trim());
        if (!fs.existsSync(request.cwd)) throw new Error(`工作目录不存在: ${request.cwd}`);
    }
    const effectiveCwd = hasExplicitCwd ? request.cwd! : process.cwd();
    const expectedRequestHash = requestHash(command, effectiveCwd);
    const access = { conversationId: request.conversationId, ownerId: request.ownerId };
    const now = Date.now();
    const approvalStartedAt = normalizeTimestamp(request.approvalStartedAt);
    const approvedAt = normalizeTimestamp(request.approvedAt);
    const taskStartedAt = approvalStartedAt ?? approvedAt ?? now;
    const taskApprovedAt = approvedAt ?? (approvalStartedAt ? now : undefined);
    const approvalWaitMs = elapsedMs(taskStartedAt, taskApprovedAt) ?? 0;
    const reusableTask = findReusableCommandTask(taskId, expectedRequestHash, access);
    if (reusableTask) return reusableTask;
    const savedPath = manifestPath(taskId);
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
    const root = artifactRoot();
    const stdoutPath = path.join(root, `${taskId}.stdout.log`);
    const stderrPath = path.join(root, `${taskId}.stderr.log`);
    const runnerPayloadPath = path.join(root, `${taskId}.runner.json`);
    const startGatePath = path.join(root, `${taskId}.${randomUUID()}.start`);
    if (fs.existsSync(stdoutPath) || fs.existsSync(stderrPath)) {
        throw new Error(`taskId ${taskId} 存在孤立输出日志，拒绝覆盖；请先检查或更换 taskId`);
    }
    createEmptyArtifact(stdoutPath);
    try {
        createEmptyArtifact(stderrPath);
    } catch (error) {
        fs.rmSync(stdoutPath, { force: true });
        throw error;
    }
    const record: CommandTaskRecord = {
        taskId,
        requestHash: expectedRequestHash,
        conversationId: request.conversationId,
        runId: request.runId,
        callId: request.callId,
        ownerId: request.ownerId,
        status: 'running',
        startedAt: taskStartedAt,
        approvedAt: taskApprovedAt,
        approvalWaitMs,
        stdout: '',
        stderr: '',
        stdoutArtifact: { path: stdoutPath, bytes: 0, encoding: 'empty' },
        stderrArtifact: { path: stderrPath, bytes: 0, encoding: 'empty' },
        child: null,
        cancelRequested: false,
        cancelOutcomePending: false,
        cancelTerminationConfirmed: false,
        childClosed: false,
        observedExitCode: null,
        finalizing: false,
        cancelOperation: null,
        waiters: new Set(),
    };
    tasks.set(taskId, record);
    try {
        persist(record);
    } catch (error) {
        tasks.delete(taskId);
        fs.rmSync(stdoutPath, { force: true });
        fs.rmSync(stderrPath, { force: true });
        fs.rmSync(`${savedPath}.tmp`, { force: true });
        throw error;
    }

    try {
        fs.writeFileSync(runnerPayloadPath, JSON.stringify({
            shell,
            shellArgs,
            cwd: effectiveCwd,
            startGatePath,
            stdoutPath,
            stderrPath,
        }), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        tasks.delete(taskId);
        fs.rmSync(stdoutPath, { force: true });
        fs.rmSync(stderrPath, { force: true });
        fs.rmSync(savedPath, { force: true });
        fs.rmSync(`${savedPath}.tmp`, { force: true });
        throw error;
    }
    let child: ChildProcess;
    let stdoutFd: number | null = null;
    let stderrFd: number | null = null;
    try {
        stdoutFd = fs.openSync(stdoutPath, 'a');
        stderrFd = fs.openSync(stderrPath, 'a');
        const commandRunnerPath = path.join(__dirname, '..', 'commandRunner.js');
        child = spawn(process.execPath, [commandRunnerPath, runnerPayloadPath], {
            cwd: effectiveCwd,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true,
            detached: true,
            stdio: ['ignore', stdoutFd, stderrFd],
        });
        record.child = child;
        record.processId = child.pid;
    } catch (error: any) {
        fs.rmSync(runnerPayloadPath, { force: true });
        void finalizeTask(record, 'failed', 1, error?.message || String(error));
        throw error;
    } finally {
        if (stdoutFd !== null) fs.closeSync(stdoutFd);
        if (stderrFd !== null) fs.closeSync(stderrFd);
    }
    child.on('error', (error) => {
        void finalizeTask(record, record.cancelRequested ? 'unknown' : 'failed', 1, error.message);
    });
    child.on('close', (code) => {
        fs.rmSync(startGatePath, { force: true });
        handleChildClose(record, code);
    });
    if (process.platform === 'win32' && child.pid) {
        const exactStartedAt = await readWindowsProcessStartedAt(child.pid);
        if (exactStartedAt === null) {
            await terminateProcessTree(child.pid);
            await finalizeTask(record, 'failed', 1, '无法核验后台命令进程身份，拒绝启动用户命令');
            throw new Error('无法核验后台命令进程身份，拒绝启动用户命令');
        }
        record.processStartedAt = exactStartedAt;
        record.processIdentityVerified = true;
    } else {
        record.processStartedAt = Date.now();
        record.processIdentityVerified = false;
    }
    if (record.cancelRequested || record.childClosed || record.finalizing || record.status !== 'running') {
        fs.rmSync(startGatePath, { force: true });
        if (child.pid && !record.childClosed) await terminateProcessTree(child.pid);
        throw new Error('命令在身份核验完成前已被取消或终止，拒绝放行用户命令');
    }
    try {
        record.executionStartedAt = Date.now();
        record.executionTimeMs = 0;
        persist(record);
        fs.writeFileSync(startGatePath, 'start', { encoding: 'utf8', flag: 'wx' });
    } catch (error: any) {
        if (child.pid) await terminateProcessTree(child.pid);
        fs.rmSync(startGatePath, { force: true });
        await finalizeTask(record, 'failed', 1, `命令身份落盘或启动闸门失败: ${error?.message || error}`);
        throw error;
    }
    return snapshot(record);
}

export async function waitForCommandTask(taskId: string, waitSeconds: number, access?: CommandAccessContext): Promise<CommandTaskSnapshot> {
    const validTaskId = safeTaskId(taskId);
    const record = tasks.get(validTaskId);
    if (!record) {
        const savedPath = manifestPath(validTaskId);
        if (fs.existsSync(savedPath)) {
            const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8')) as CommandTaskSnapshot;
            assertTaskAccess(saved, access);
            return saved;
        }
        throw new Error(`未找到命令任务: ${validTaskId}`);
    }
    assertTaskAccess(record, access);
    refreshRecordArtifacts(record);
    if (isTerminal(record.status)) return snapshot(record);
    const waitMs = Math.max(0, Math.min(120, Number(waitSeconds) || 0)) * 1000;
    if (waitMs === 0) return snapshot(record);
    await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            record.waiters.delete(done);
            resolve();
        };
        const timer = setTimeout(done, waitMs);
        record.waiters.add(done);
    });
    refreshRecordArtifacts(record);
    return snapshot(record);
}

export async function cancelCommandTask(taskId: string, access?: CommandAccessContext): Promise<CommandTaskSnapshot> {
    const validTaskId = safeTaskId(taskId);
    const record = tasks.get(validTaskId);
    if (!record) {
        const savedPath = manifestPath(validTaskId);
        if (!fs.existsSync(savedPath)) throw new Error(`未找到命令任务: ${validTaskId}`);
        const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8')) as CommandTaskSnapshot;
        assertTaskAccess(saved, access);
        const existingPersistedCancel = persistedCancelOperations.get(validTaskId);
        if (existingPersistedCancel) return existingPersistedCancel;
        const operation = cancelPersistedTask(validTaskId, access);
        persistedCancelOperations.set(validTaskId, operation);
        try {
            return await operation;
        } finally {
            persistedCancelOperations.delete(validTaskId);
        }
    }
    assertTaskAccess(record, access);
    if (isTerminal(record.status)) return snapshot(record);
    if (record.finalizing || record.childClosed) return waitForCommandTask(validTaskId, 5, access);
    const pid = record.child?.pid;
    if (!pid) {
        record.status = 'unknown';
        record.error = '命令进程缺少 PID，无法确认取消结果';
        applyFinishedTiming(record);
        persist(record);
        notifyWaiters(record);
        return snapshot(record);
    }

    if (!record.cancelOperation) {
        record.cancelOperation = (async () => {
            record.cancelRequested = true;
            record.cancelOutcomePending = true;
            record.cancelTerminationConfirmed = false;
            record.status = 'cancelling';
            persist(record);
            record.cancelTerminationConfirmed = await terminateProcessTree(pid);
            record.cancelOutcomePending = false;
        })();
    }
    try {
        await record.cancelOperation;
    } finally {
        record.cancelOperation = null;
    }
    if (record.childClosed) handleChildClose(record, record.observedExitCode);
    return waitForCommandTask(validTaskId, 5, access);
}

async function terminateProcessTree(pid: number): Promise<boolean> {
    if (process.platform === 'win32') {
        return new Promise<boolean>((resolve) => {
            const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
            killer.on('close', (code) => resolve(code === 0));
            killer.on('error', () => resolve(false));
        });
    }
    try {
        process.kill(-pid, 'SIGTERM');
        return true;
    } catch {
        try {
            process.kill(pid, 'SIGTERM');
            return true;
        } catch {
            return false;
        }
    }
}

async function readWindowsProcessStartedAt(pid: number): Promise<number | null> {
    if (process.platform !== 'win32') return null;
    return new Promise<number | null>((resolve) => {
        const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
        const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        let output = '';
        let settled = false;
        const finish = (value: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            probe.kill();
            finish(null);
        }, 5_000);
        probe.stdout.on('data', data => { output += data.toString(); });
        probe.on('error', () => finish(null));
        probe.on('close', code => {
            if (code !== 0) return finish(null);
            const parsed = Date.parse(output.trim());
            finish(Number.isFinite(parsed) ? parsed : null);
        });
    });
}

async function cancelPersistedTask(taskId: string, access?: CommandAccessContext): Promise<CommandTaskSnapshot> {
    const savedPath = manifestPath(taskId);
    if (!fs.existsSync(savedPath)) throw new Error(`未找到命令任务: ${taskId}`);
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8')) as CommandTaskSnapshot;
    assertTaskAccess(saved, access);
    if (saved.status !== 'unknown' && saved.status !== 'running' && saved.status !== 'cancelling') return saved;
    if (!saved.processId || !saved.processStartedAt || saved.processIdentityVerified !== true) {
        saved.status = 'unknown';
        saved.error = '命令任务缺少可验证的进程身份，拒绝盲目终止';
        applyFinishedTiming(saved);
        persistSnapshot(saved);
        return saved;
    }
    if (process.platform !== 'win32') {
        saved.status = 'unknown';
        saved.error = '当前平台无法验证重启前的进程身份，拒绝盲目终止';
        applyFinishedTiming(saved);
        persistSnapshot(saved);
        return saved;
    }
    const actualStartedAt = await readWindowsProcessStartedAt(saved.processId);
    if (actualStartedAt === null || actualStartedAt !== saved.processStartedAt) {
        saved.status = 'unknown';
        saved.error = '重启后未找到匹配的原命令进程，拒绝按可能复用的 PID 终止';
        applyFinishedTiming(saved);
        persistSnapshot(saved);
        return saved;
    }
    const terminated = await terminateProcessTree(saved.processId);
    saved.status = terminated ? 'cancelled' : 'unknown';
    applyFinishedTiming(saved);
    saved.exitCode = terminated ? 1 : saved.exitCode;
    saved.error = terminated ? '已在重启后核验进程身份并终止遗留进程树' : '遗留进程树终止失败，副作用状态仍未知';
    persistSnapshot(saved);
    return saved;
}

export function registerCommandHandlers(): void {
    restoreInterruptedTasks();
    ipcMain.handle('command:start', async (event, request: CommandStartRequest) => {
        const command = typeof request?.command === 'string' ? request.command.trim() : '';
        if (!command) throw new Error('command 不能为空');
        const taskId = safeTaskId(request.taskId);
        const hasExplicitCwd = typeof request.cwd === 'string' && request.cwd.trim().length > 0;
        const effectiveCwd = hasExplicitCwd ? resolveFilePath(request.cwd!.trim()) : process.cwd();
        if (hasExplicitCwd && !fs.existsSync(effectiveCwd)) throw new Error(`工作目录不存在: ${effectiveCwd}`);
        const reusableTask = findReusableCommandTask(taskId, requestHash(command, effectiveCwd), {
            conversationId: request.conversationId,
            ownerId: request.ownerId,
        });
        if (reusableTask) return reusableTask;
        const approvalStartedAt = Date.now();
        const approved = await confirmSensitiveOperationInMainWindow(event.sender, {
            title: '确认运行系统命令',
            message: '系统命令可能读取、修改或删除工作区外的数据。确认后只会启动下列这一条命令。',
            details: [
                `命令：${command}`,
                `工作目录：${effectiveCwd}`,
            ],
            confirmLabel: '运行命令',
            toolName: 'run_command',
            level: 'command',
            approvalId: `tool-task:${taskId}`,
        });
        if (!approved) throw new Error('用户取消了系统命令');
        return startCommandTask({ ...request, taskId, approvalStartedAt, approvedAt: Date.now() });
    });
    ipcMain.handle('command:status', (_event, taskId: string, access?: CommandAccessContext) => waitForCommandTask(taskId, 0, access));
    ipcMain.handle('command:wait', (_event, taskId: string, waitSeconds: number, access?: CommandAccessContext) => waitForCommandTask(taskId, waitSeconds, access));
    ipcMain.handle('command:cancel', (_event, taskId: string, access?: CommandAccessContext) => cancelCommandTask(taskId, access));
    ipcMain.handle('command:rebindConversation', (_event, request: CommandRebindRequest) => rebindConversationTasks(request));
}

export async function shutdownCommandTasks(): Promise<void> {
    const running = [...tasks.values()].filter(record => !isTerminal(record.status));
    await Promise.all(running.map(record => cancelCommandTask(record.taskId, {
        conversationId: record.conversationId,
        ownerId: record.ownerId,
    }).catch(() => undefined)));
}
