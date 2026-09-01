import type {
    ToolTaskAccessContext,
    ToolTaskExecutor,
    ToolTaskListRequest,
    ToolTaskRebindRequest,
    ToolTaskSnapshot,
    ToolTaskStartRequest,
} from './types';

function requireIdentity(request: ToolTaskStartRequest): void {
    const missing = Object.entries(request.identity)
        .filter(([, value]) => typeof value !== 'string' || !value.trim())
        .map(([name]) => name);
    if (missing.length) throw new Error(`tool-task:start 缺少运行身份: ${missing.join(', ')}`);
}

export class TaskBroker {
    private readonly executors = new Map<string, ToolTaskExecutor>();
    private readonly kindByTaskId = new Map<string, string>();

    register(executor: ToolTaskExecutor): void {
        if (this.executors.has(executor.kind)) throw new Error(`工具任务执行器已注册: ${executor.kind}`);
        this.executors.set(executor.kind, executor);
        executor.restoreInterruptedTasks?.();
    }

    async start(request: ToolTaskStartRequest): Promise<ToolTaskSnapshot> {
        requireIdentity(request);
        const executor = this.executors.get(request.kind);
        if (!executor) throw new Error(`不支持的工具任务类型: ${request.kind}`);
        const snapshot = await executor.start(request);
        if (snapshot.kind !== request.kind) throw new Error(`工具任务类型不一致: ${request.kind} -> ${snapshot.kind}`);
        if (!executor.canHandle(snapshot.taskId)) throw new Error(`工具任务 ID 与执行器不一致: ${request.kind} -> ${snapshot.taskId}`);
        return this.remember(snapshot);
    }

    async list(request: ToolTaskListRequest): Promise<ToolTaskSnapshot[]> {
        if (!request.conversationId?.trim() || !request.ownerId?.trim()) throw new Error('tool-task:list 缺少对话或 owner 身份');
        const snapshots = (await Promise.all([...this.executors.values()].map(executor => executor.list(request)))).flat();
        return snapshots.sort((left, right) => right.startedAt - left.startedAt).map(snapshot => this.remember(snapshot));
    }

    async status(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        return this.remember(await this.resolve(taskId).status(taskId, access));
    }

    async wait(taskId: string, waitSeconds: number, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        const boundedWait = Math.max(10, Math.min(120, Number(waitSeconds) || 10));
        return this.remember(await this.resolve(taskId).wait(taskId, boundedWait, access));
    }

    async cancel(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        return this.remember(await this.resolve(taskId).cancel(taskId, access));
    }

    async rebindConversation(request: ToolTaskRebindRequest): Promise<number> {
        const results = await Promise.all([...this.executors.values()].map(executor =>
            executor.rebindConversation?.(request) ?? Promise.resolve(0),
        ));
        return results.reduce((total, count) => total + count, 0);
    }

    async shutdown(): Promise<void> {
        await Promise.all([...this.executors.values()].map(executor => executor.shutdown?.() ?? Promise.resolve()));
    }

    private resolve(taskId: string): ToolTaskExecutor {
        const rememberedKind = this.kindByTaskId.get(taskId);
        if (rememberedKind) {
            const remembered = this.executors.get(rememberedKind);
            if (remembered) return remembered;
        }
        const matches = [...this.executors.values()].filter(executor => executor.canHandle(taskId));
        if (matches.length !== 1) throw new Error(`无法确定后台任务 ${taskId} 的执行器`);
        this.kindByTaskId.set(taskId, matches[0].kind);
        return matches[0];
    }

    private remember(snapshot: ToolTaskSnapshot): ToolTaskSnapshot {
        if (snapshot.status === 'running' || snapshot.status === 'cancelling') {
            this.kindByTaskId.set(snapshot.taskId, snapshot.kind);
        } else {
            this.kindByTaskId.delete(snapshot.taskId);
        }
        return snapshot;
    }
}
