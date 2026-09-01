import { app } from 'electron';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
    ToolTaskAccessContext,
    ToolTaskArtifact,
    ToolTaskExecutor,
    ToolTaskListRequest,
    ToolTaskRebindRequest,
    ToolTaskSnapshot,
    ToolTaskStartRequest,
} from './types';

const PREVIEW_LIMIT = 10_000;
const STRUCTURED_LIMIT = 100_000;

interface ManagedTaskManifest extends ToolTaskSnapshot {
    requestHash: string;
    sideEffectPossible: boolean;
}

interface ManagedTaskRecord {
    manifest: ManagedTaskManifest;
    input: unknown;
    controller: AbortController;
    completion: Promise<void>;
}

export interface ManagedTaskExecutionContext {
    taskId: string;
    signal: AbortSignal;
    artifactRoot: string;
}

export interface ManagedTaskOutput {
    text: string;
    structured?: unknown;
    structuredFallback?: unknown;
    artifacts?: ToolTaskArtifact[];
}

export class ManagedTaskError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly unknownSideEffect: boolean,
        public readonly text = message,
        public readonly structured?: unknown,
        public readonly artifacts?: ToolTaskArtifact[],
    ) {
        super(message);
        this.name = 'ManagedTaskError';
    }
}

export abstract class ManagedTaskExecutor implements ToolTaskExecutor {
    abstract readonly kind: string;
    protected readonly cancellationMode: 'confirmed-by-abort' | 'unconfirmed' = 'confirmed-by-abort';
    private readonly records = new Map<string, ManagedTaskRecord>();

    canHandle(taskId: string): boolean {
        return taskId.startsWith(`${this.kind}_`);
    }

    async start(request: ToolTaskStartRequest): Promise<ToolTaskSnapshot> {
        const taskId = this.safeTaskId(request.taskId);
        const requestHash = this.hashInput(request.input);
        const access = { conversationId: request.identity.conversationId, ownerId: request.identity.ownerId };
        const active = this.records.get(taskId);
        if (active) {
            this.assertSameRequest(active.manifest, requestHash);
            this.assertAccess(active.manifest, access);
            this.assertExecutionIdentity(active.manifest, request.identity);
            return this.snapshot(active.manifest);
        }

        const persisted = this.readManifest(taskId);
        if (persisted) {
            this.assertSameRequest(persisted, requestHash);
            this.assertAccess(persisted, access);
            this.assertExecutionIdentity(persisted, request.identity);
            return this.snapshot(persisted);
        }

        const manifest: ManagedTaskManifest = {
            taskId,
            kind: this.kind,
            ...request.identity,
            status: 'running',
            startedAt: Date.now(),
            text: '',
            unknownSideEffect: false,
            requestHash,
            sideEffectPossible: this.hasUnknownSideEffect(request.input),
        };
        this.persist(manifest);

        const record: ManagedTaskRecord = {
            manifest,
            input: request.input,
            controller: new AbortController(),
            completion: Promise.resolve(),
        };
        this.records.set(taskId, record);
        record.completion = Promise.resolve()
            .then(() => this.execute(request.input, {
                taskId,
                signal: record.controller.signal,
                artifactRoot: this.artifactRoot(),
            }))
            .then(output => this.completeSuccess(record, output))
            .catch(error => this.completeFailure(record, error));
        return this.snapshot(manifest);
    }

    async status(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        return this.getSnapshot(taskId, access);
    }

    async wait(taskId: string, waitSeconds: number, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        const validTaskId = this.safeTaskId(taskId);
        const record = this.records.get(validTaskId);
        if (!record || this.isTerminal(record.manifest.status) || waitSeconds <= 0) {
            return this.getSnapshot(validTaskId, access);
        }
        this.assertAccess(record.manifest, access);
        const boundedWait = Math.max(0, Math.min(120, waitSeconds));
        await Promise.race([
            record.completion,
            new Promise<void>(resolve => setTimeout(resolve, boundedWait * 1000)),
        ]);
        return this.snapshot(record.manifest);
    }

    async cancel(taskId: string, access: ToolTaskAccessContext): Promise<ToolTaskSnapshot> {
        const validTaskId = this.safeTaskId(taskId);
        const record = this.records.get(validTaskId);
        if (!record) return this.getSnapshot(validTaskId, access);
        this.assertAccess(record.manifest, access);
        if (this.isTerminal(record.manifest.status)) return this.snapshot(record.manifest);

        record.manifest.status = 'cancelling';
        record.manifest.text = `正在请求停止 ${this.kind} 任务 ${validTaskId}`;
        this.persist(record.manifest);
        record.controller.abort();

        if (this.cancellationMode === 'unconfirmed') {
            this.finalize(record, 'unknown', {
                error: '已停止本地等待，但无法确认远端执行是否停止',
                errorCode: 'unknown',
                unknownSideEffect: this.hasUnknownSideEffect(record.input),
                text: `任务 ${validTaskId} 已停止本地等待，远端状态无法确认`,
            });
            return this.snapshot(record.manifest);
        }

        await Promise.race([
            record.completion,
            new Promise<void>(resolve => setTimeout(resolve, 5000)),
        ]);
        if (!this.isTerminal(record.manifest.status)) {
            this.finalize(record, 'unknown', {
                error: '取消请求在 5 秒内未获执行器确认',
                errorCode: 'timeout',
                unknownSideEffect: this.hasUnknownSideEffect(record.input),
                text: `任务 ${validTaskId} 的取消结果无法确认`,
            });
        }
        return this.snapshot(record.manifest);
    }

    async list(request: ToolTaskListRequest): Promise<ToolTaskSnapshot[]> {
        const byTaskId = new Map<string, ManagedTaskManifest>();
        for (const record of this.records.values()) {
            if (this.matchesAccess(record.manifest, request)) byTaskId.set(record.manifest.taskId, record.manifest);
        }
        for (const entry of fs.readdirSync(this.artifactRoot(), { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.startsWith(`${this.kind}_`) || !entry.name.endsWith('.json') || entry.name.endsWith('.result.json')) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(this.artifactRoot(), entry.name), 'utf8')) as ManagedTaskManifest;
                if (manifest.kind !== this.kind || !this.canHandle(manifest.taskId) || !this.matchesAccess(manifest, request)) continue;
                if (!byTaskId.has(manifest.taskId)) byTaskId.set(manifest.taskId, manifest);
            } catch {
                continue;
            }
        }
        return [...byTaskId.values()]
            .sort((left, right) => right.startedAt - left.startedAt)
            .map(manifest => this.snapshot(manifest));
    }

    restoreInterruptedTasks(): void {
        const root = this.artifactRoot();
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.startsWith(`${this.kind}_`) || !entry.name.endsWith('.json') || entry.name.endsWith('.result.json')) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8')) as ManagedTaskManifest;
                if (manifest.kind !== this.kind || !this.canHandle(manifest.taskId)) continue;
                if (manifest.status !== 'running' && manifest.status !== 'cancelling') continue;
                manifest.status = 'unknown';
                manifest.finishedAt = Date.now();
                manifest.error = 'Synapse 重启时该任务仍未结束，无法确认外部状态';
                manifest.errorCode = 'unknown';
                manifest.unknownSideEffect = manifest.sideEffectPossible ?? true;
                manifest.text = `任务 ${manifest.taskId} 在应用重启后状态无法确认`;
                this.persist(manifest);
            } catch {
                continue;
            }
        }
    }

    async rebindConversation(request: ToolTaskRebindRequest): Promise<number> {
        let updated = 0;
        const updatedIds = new Set<string>();
        for (const record of this.records.values()) {
            if (record.manifest.ownerId !== request.ownerId || record.manifest.conversationId !== request.fromId) continue;
            record.manifest.conversationId = request.toId;
            this.persist(record.manifest);
            updatedIds.add(record.manifest.taskId);
            updated++;
        }
        for (const entry of fs.readdirSync(this.artifactRoot(), { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.startsWith(`${this.kind}_`) || !entry.name.endsWith('.json') || entry.name.endsWith('.result.json')) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(this.artifactRoot(), entry.name), 'utf8')) as ManagedTaskManifest;
                if (manifest.kind !== this.kind || updatedIds.has(manifest.taskId)) continue;
                if (manifest.ownerId !== request.ownerId || manifest.conversationId !== request.fromId) continue;
                manifest.conversationId = request.toId;
                this.persist(manifest);
                updated++;
            } catch {
                continue;
            }
        }
        return updated;
    }

    async shutdown(): Promise<void> {
        const running = [...this.records.values()].filter(record => !this.isTerminal(record.manifest.status));
        await Promise.all(running.map(record => this.cancel(record.manifest.taskId, {
            conversationId: record.manifest.conversationId,
            ownerId: record.manifest.ownerId || '',
        }).catch(() => undefined)));
    }

    protected abstract execute(input: unknown, context: ManagedTaskExecutionContext): Promise<ManagedTaskOutput>;
    protected abstract hasUnknownSideEffect(input: unknown): boolean;

    private completeSuccess(record: ManagedTaskRecord, output: ManagedTaskOutput): void {
        if (this.isTerminal(record.manifest.status)) return;
        if (record.controller.signal.aborted || record.manifest.status === 'cancelling') {
            this.completeFailure(record, new DOMException('Aborted', 'AbortError'));
            return;
        }
        const artifacts = [...(output.artifacts ?? [])];
        let text = output.text;
        if (text.length > PREVIEW_LIMIT) {
            const outputPath = path.join(this.artifactRoot(), `${record.manifest.taskId}.output.txt`);
            fs.writeFileSync(outputPath, text, 'utf8');
            artifacts.push({
                path: outputPath,
                bytes: Buffer.byteLength(text, 'utf8'),
                sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
            });
            text = `${text.slice(0, 8000)}\n\n...[完整输出已保存，共 ${text.length} 字符]...\n\n${text.slice(-2000)}`;
        }

        let structured = output.structured;
        if (structured !== undefined) {
            let serialized: string;
            try {
                serialized = JSON.stringify(structured) ?? 'null';
            } catch (error) {
                this.completeFailure(record, new ManagedTaskError(
                    `任务结果无法序列化: ${error instanceof Error ? error.message : String(error)}`,
                    'invalid_result',
                    record.manifest.sideEffectPossible,
                ));
                return;
            }
            if (Buffer.byteLength(serialized, 'utf8') > STRUCTURED_LIMIT) {
                const structuredPath = path.join(this.artifactRoot(), `${record.manifest.taskId}.result.json`);
                fs.writeFileSync(structuredPath, serialized, 'utf8');
                artifacts.push({
                    path: structuredPath,
                    bytes: Buffer.byteLength(serialized, 'utf8'),
                    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
                });
                structured = output.structuredFallback;
            }
        }

        this.finalize(record, 'success', {
            text,
            structured,
            artifacts,
            unknownSideEffect: false,
        });
    }

    private completeFailure(record: ManagedTaskRecord, error: unknown): void {
        if (this.isTerminal(record.manifest.status)) return;
        if (record.controller.signal.aborted && this.cancellationMode === 'confirmed-by-abort') {
            this.finalize(record, 'cancelled', {
                error: '任务已由本地执行器确认停止',
                errorCode: 'aborted',
                unknownSideEffect: false,
                text: `任务 ${record.manifest.taskId} 已取消`,
            });
            return;
        }
        if (error instanceof ManagedTaskError) {
            this.finalize(record, error.unknownSideEffect ? 'unknown' : 'error', {
                error: error.message,
                errorCode: error.code,
                unknownSideEffect: error.unknownSideEffect,
                text: error.text,
                structured: error.structured,
                artifacts: error.artifacts,
            });
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const unknownSideEffect = record.manifest.sideEffectPossible;
        this.finalize(record, unknownSideEffect ? 'unknown' : 'error', {
            error: message,
            errorCode: 'transport',
            unknownSideEffect,
            text: `${this.kind} 任务失败: ${message}`,
        });
    }

    private finalize(record: ManagedTaskRecord, status: ToolTaskSnapshot['status'], patch: Partial<ManagedTaskManifest>): void {
        if (this.isTerminal(record.manifest.status)) return;
        Object.assign(record.manifest, patch, {
            status,
            finishedAt: Date.now(),
        });
        try {
            this.persist(record.manifest);
        } catch (error) {
            record.manifest.status = 'unknown';
            record.manifest.error = `任务结果落盘失败: ${error instanceof Error ? error.message : String(error)}`;
            record.manifest.errorCode = 'unknown';
            record.manifest.unknownSideEffect = this.hasUnknownSideEffect(record.input);
        }
        this.records.delete(record.manifest.taskId);
    }

    private getSnapshot(taskId: string, access: ToolTaskAccessContext): ToolTaskSnapshot {
        const validTaskId = this.safeTaskId(taskId);
        const active = this.records.get(validTaskId)?.manifest;
        const manifest = active ?? this.readManifest(validTaskId);
        if (!manifest) throw new Error(`后台任务不存在: ${validTaskId}`);
        this.assertAccess(manifest, access);
        return this.snapshot(manifest);
    }

    private snapshot(manifest: ManagedTaskManifest): ToolTaskSnapshot {
        const { requestHash: _requestHash, sideEffectPossible: _sideEffectPossible, ...snapshot } = manifest;
        return { ...snapshot, artifacts: snapshot.artifacts?.map(item => ({ ...item })) };
    }

    private safeTaskId(taskId?: string): string {
        const proposed = (taskId || `${this.kind}_${randomUUID()}`).trim();
        if (!this.canHandle(proposed) || !/^[A-Za-z0-9._-]{1,160}$/.test(proposed)) {
            throw new Error(`${this.kind} taskId 格式无效`);
        }
        return proposed;
    }

    private hashInput(input: unknown): string {
        const serialized = JSON.stringify({ kind: this.kind, input }) ?? 'null';
        return createHash('sha256').update(serialized).digest('hex');
    }

    private assertSameRequest(manifest: ManagedTaskManifest, requestHash: string): void {
        if (manifest.requestHash !== requestHash) throw new Error(`taskId ${manifest.taskId} 已被其它请求使用`);
    }

    private assertAccess(manifest: ManagedTaskManifest, access: ToolTaskAccessContext): void {
        if (!this.matchesAccess(manifest, access)) throw new Error(`后台任务 ${manifest.taskId} 不属于当前对话，拒绝访问`);
    }

    private matchesAccess(manifest: ManagedTaskManifest, access: ToolTaskAccessContext): boolean {
        return Boolean(
            access.conversationId
            && access.ownerId
            && manifest.conversationId === access.conversationId
            && manifest.ownerId === access.ownerId,
        );
    }

    private assertExecutionIdentity(manifest: ManagedTaskManifest, identity: ToolTaskStartRequest['identity']): void {
        if (manifest.runId !== identity.runId || manifest.callId !== identity.callId) {
            throw new Error(`后台任务 ${manifest.taskId} 已绑定其它 run/call，拒绝重放`);
        }
    }

    private artifactRoot(): string {
        const root = path.join(app.getPath('userData'), 'tool-artifacts', 'tasks', this.kind);
        fs.mkdirSync(root, { recursive: true });
        return root;
    }

    private manifestPath(taskId: string): string {
        return path.join(this.artifactRoot(), `${taskId}.json`);
    }

    private readManifest(taskId: string): ManagedTaskManifest | null {
        const filePath = this.manifestPath(taskId);
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ManagedTaskManifest;
    }

    private persist(manifest: ManagedTaskManifest): void {
        const target = this.manifestPath(manifest.taskId);
        const temp = `${target}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), 'utf8');
        fs.renameSync(temp, target);
    }

    private isTerminal(status: ToolTaskSnapshot['status']): boolean {
        return status === 'success' || status === 'error' || status === 'cancelled' || status === 'unknown';
    }

}
