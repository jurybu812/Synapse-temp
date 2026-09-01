export type ToolTaskStatus = 'running' | 'cancelling' | 'success' | 'error' | 'cancelled' | 'unknown';

export interface ToolTaskIdentity {
    conversationId: string;
    runId: string;
    callId: string;
    ownerId: string;
}

export interface ToolTaskAccessContext {
    conversationId?: string;
    ownerId: string;
}

export interface ToolTaskArtifact {
    path: string;
    bytes?: number;
    sha256?: string;
    encoding?: string;
}

export interface ToolTaskSnapshot extends Partial<ToolTaskIdentity> {
    taskId: string;
    kind: string;
    status: ToolTaskStatus;
    startedAt: number;
    wallStartedAt?: number;
    approvedAt?: number;
    finishedAt?: number;
    approvalWaitMs?: number;
    executionStartedAt?: number;
    executionFinishedAt?: number;
    executionTimeMs?: number;
    wallTimeMs?: number;
    text: string;
    error?: string;
    errorCode?: string;
    unknownSideEffect: boolean;
    artifacts?: ToolTaskArtifact[];
    structured?: unknown;
}

export interface ToolTaskStartRequest {
    kind: string;
    taskId?: string;
    identity: ToolTaskIdentity;
    input: unknown;
}

export interface ToolTaskRebindRequest {
    ownerId: string;
    fromId: string;
    toId: string;
}

export interface ToolTaskListRequest {
    conversationId: string;
    ownerId: string;
}

export interface ToolTaskExecutor {
    readonly kind: string;
    canHandle(taskId: string): boolean;
    start(request: ToolTaskStartRequest): Promise<ToolTaskSnapshot>;
    status(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot>;
    wait(taskId: string, waitSeconds: number, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot>;
    cancel(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot>;
    list(request: ToolTaskListRequest): Promise<ToolTaskSnapshot[]>;
    rebindConversation?(request: ToolTaskRebindRequest): Promise<number>;
    restoreInterruptedTasks?(): void;
    shutdown?(): Promise<void>;
}
