import {
    cancelCommandTask,
    listCommandTasks,
    rebindConversationTasks,
    startCommandTask,
    waitForCommandTask,
    type CommandTaskSnapshot,
} from '../../ipc/command';
import type {
    ToolTaskAccessContext,
    ToolTaskExecutor,
    ToolTaskListRequest,
    ToolTaskRebindRequest,
    ToolTaskSnapshot,
    ToolTaskStartRequest,
    ToolTaskStatus,
} from '../types';

interface CommandTaskInput {
    command: string;
    cwd?: string;
}

function mapStatus(snapshot: CommandTaskSnapshot): ToolTaskStatus {
    if (snapshot.status === 'completed') return 'success';
    if (snapshot.status === 'failed') return 'error';
    return snapshot.status;
}

function elapsedMs(start: number | undefined, end: number | undefined): number | undefined {
    if (start === undefined || end === undefined) return undefined;
    return Math.max(0, end - start);
}

function formatMs(value: number | undefined): string {
    if (value === undefined) return '未知';
    return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function formatCommandText(snapshot: CommandTaskSnapshot): string {
    const stdoutEncoding = snapshot.stdoutArtifact.encoding || 'unknown';
    const stderrEncoding = snapshot.stderrArtifact.encoding || 'unknown';
    const executionTimeMs = snapshot.executionTimeMs
        ?? elapsedMs(snapshot.executionStartedAt ?? snapshot.processStartedAt, snapshot.executionFinishedAt ?? snapshot.finishedAt);
    const wallTimeMs = snapshot.wallTimeMs ?? elapsedMs(snapshot.startedAt, snapshot.finishedAt);
    return [
        `任务 ${snapshot.taskId}: ${snapshot.status}`,
        snapshot.stdout ? `stdout:\n${snapshot.stdout}` : '',
        snapshot.stderr ? `stderr:\n${snapshot.stderr}` : '',
        snapshot.error ? `错误: ${snapshot.error}` : '',
        snapshot.exitCode !== undefined ? `退出码: ${snapshot.exitCode}` : '',
        `耗时: 审批等待 ${formatMs(snapshot.approvalWaitMs ?? 0)}，命令执行 ${formatMs(executionTimeMs)}，总墙钟 ${formatMs(wallTimeMs)}`,
        `完整输出: ${snapshot.stdoutArtifact.path} (${snapshot.stdoutArtifact.bytes} bytes, encoding=${stdoutEncoding})`,
        `完整错误: ${snapshot.stderrArtifact.path} (${snapshot.stderrArtifact.bytes} bytes, encoding=${stderrEncoding})`,
    ].filter(Boolean).join('\n\n');
}

function toToolTaskSnapshot(snapshot: CommandTaskSnapshot): ToolTaskSnapshot {
    const status = mapStatus(snapshot);
    const executionStartedAt = snapshot.executionStartedAt ?? snapshot.processStartedAt ?? snapshot.startedAt;
    const executionFinishedAt = snapshot.executionFinishedAt ?? snapshot.finishedAt;
    const executionTimeMs = snapshot.executionTimeMs ?? elapsedMs(executionStartedAt, executionFinishedAt);
    const wallTimeMs = snapshot.wallTimeMs ?? elapsedMs(snapshot.startedAt, snapshot.finishedAt);
    return {
        taskId: snapshot.taskId,
        kind: 'command',
        conversationId: snapshot.conversationId,
        runId: snapshot.runId,
        callId: snapshot.callId,
        ownerId: snapshot.ownerId,
        status,
        startedAt: executionStartedAt,
        wallStartedAt: snapshot.startedAt,
        approvedAt: snapshot.approvedAt,
        finishedAt: snapshot.finishedAt,
        approvalWaitMs: snapshot.approvalWaitMs ?? 0,
        executionStartedAt,
        executionFinishedAt,
        executionTimeMs,
        wallTimeMs,
        text: formatCommandText(snapshot),
        error: status === 'error' || status === 'unknown' || status === 'cancelled'
            ? snapshot.error || (status === 'cancelled' ? `任务 ${snapshot.taskId} 已取消` : `命令退出码 ${snapshot.exitCode ?? 1}`)
            : undefined,
        errorCode: status === 'cancelled' ? 'aborted' : status === 'unknown' ? 'unknown' : status === 'error' ? 'provider' : undefined,
        unknownSideEffect: status === 'unknown',
        artifacts: [
            { path: snapshot.stdoutArtifact.path, bytes: snapshot.stdoutArtifact.bytes, sha256: snapshot.stdoutArtifact.sha256, encoding: snapshot.stdoutArtifact.encoding },
            { path: snapshot.stderrArtifact.path, bytes: snapshot.stderrArtifact.bytes, sha256: snapshot.stderrArtifact.sha256, encoding: snapshot.stderrArtifact.encoding },
        ],
        structured: snapshot,
    };
}

function readInput(input: unknown): CommandTaskInput {
    if (!input || typeof input !== 'object') throw new Error('command 任务缺少输入');
    const candidate = input as Partial<CommandTaskInput>;
    if (typeof candidate.command !== 'string' || !candidate.command.trim()) throw new Error('command 不能为空');
    return { command: candidate.command, cwd: candidate.cwd };
}

export class CommandTaskExecutor implements ToolTaskExecutor {
    readonly kind = 'command';

    canHandle(taskId: string): boolean {
        return taskId.startsWith('command_');
    }

    async start(request: ToolTaskStartRequest): Promise<ToolTaskSnapshot> {
        const input = readInput(request.input);
        return toToolTaskSnapshot(await startCommandTask({
            ...input,
            taskId: request.taskId,
            ...request.identity,
        }));
    }

    async status(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        return toToolTaskSnapshot(await waitForCommandTask(taskId, 0, access));
    }

    async wait(taskId: string, waitSeconds: number, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        return toToolTaskSnapshot(await waitForCommandTask(taskId, waitSeconds, access));
    }

    async cancel(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        return toToolTaskSnapshot(await cancelCommandTask(taskId, access));
    }

    async list(request: ToolTaskListRequest): Promise<ToolTaskSnapshot[]> {
        return listCommandTasks(request).map(toToolTaskSnapshot);
    }

    async rebindConversation(request: ToolTaskRebindRequest): Promise<number> {
        return rebindConversationTasks(request);
    }
}
