import {
  createExecutionContext,
  createOwnerId,
  createToolCallExecutionContext,
  type ExecutionContext,
  type ToolCallExecutionContext,
} from './executionContext';

export interface RegisteredAgentLoop {
  readonly isRunning: boolean;
  stop(): void;
}

interface ExecutionSlot<TLoop extends RegisteredAgentLoop = RegisteredAgentLoop> {
  readonly ownerId: string;
  conversationId: string;
  loop: TLoop;
}

interface CancelableEntry {
  cancel: () => void | Promise<void>;
  runId?: string;
}

const OWNER_STORAGE_KEY = 'synapse_execution_owners_v1';

class ExecutionRegistry {
  private readonly slotsByOwner = new Map<string, ExecutionSlot>();
  private readonly ownerByConversation = new Map<string, string>();
  private readonly activeCalls = new Map<string, ToolCallExecutionContext>();
  private readonly cancellablesByOwner = new Map<string, Map<string, CancelableEntry>>();
  private readonly parentByOwner = new Map<string, string>();
  private readonly childrenByOwner = new Map<string, Set<string>>();
  private readonly activeRunByOwner = new Map<string, string>();
  private readonly stoppingOwners = new Set<string>();
  private readonly stopOperations = new Map<string, Promise<number>>();
  private readonly lateCancellationsByOwner = new Map<string, Set<Promise<void>>>();

  getOrCreateLoop<TLoop extends RegisteredAgentLoop>(
    conversationId: string,
    factory: (ownerId: string) => TLoop,
  ): TLoop {
    if (!conversationId) throw new Error('getOrCreateLoop requires conversationId');
    const existingOwner = this.ownerForConversation(conversationId);
    if (existingOwner) {
      const existing = this.slotsByOwner.get(existingOwner);
      if (existing) return existing.loop as TLoop;
      const loop = factory(existingOwner);
      this.slotsByOwner.set(existingOwner, { ownerId: existingOwner, conversationId, loop });
      return loop;
    }
    const ownerId = createOwnerId();
    const loop = factory(ownerId);
    this.slotsByOwner.set(ownerId, { ownerId, conversationId, loop });
    this.ownerByConversation.set(conversationId, ownerId);
    this.persistOwnerMappings();
    return loop;
  }

  getLoop<TLoop extends RegisteredAgentLoop>(conversationId: string): TLoop | null {
    const ownerId = this.ownerByConversation.get(conversationId);
    return (ownerId ? this.slotsByOwner.get(ownerId)?.loop : null) as TLoop | null;
  }

  getOwnerId(conversationId: string): string | null {
    return this.ownerForConversation(conversationId);
  }

  restoreOwnerForConversation(conversationId: string, ownerId: string): boolean {
    const nextConversationId = conversationId?.trim();
    const nextOwnerId = ownerId?.trim();
    if (!nextConversationId || !this.isValidOwnerId(nextOwnerId)) return false;
    const existingOwner = this.ownerForConversation(nextConversationId);
    if (existingOwner) return existingOwner === nextOwnerId;
    for (const [mappedConversationId, mappedOwnerId] of this.ownerByConversation) {
      if (mappedConversationId !== nextConversationId && mappedOwnerId === nextOwnerId) return false;
    }
    const existingSlot = this.slotsByOwner.get(nextOwnerId);
    if (existingSlot && existingSlot.conversationId !== nextConversationId) return false;
    this.ownerByConversation.set(nextConversationId, nextOwnerId);
    if (existingSlot) existingSlot.conversationId = nextConversationId;
    this.persistOwnerMappings();
    return true;
  }

  createRun(conversationId: string): ExecutionContext {
    const ownerId = this.ownerForConversation(conversationId);
    if (!ownerId) throw new Error(`No execution owner registered for conversation ${conversationId}`);
    return createExecutionContext(conversationId, ownerId);
  }

  async activateOwner(ownerId: string, runId: string): Promise<void> {
    const pendingStop = this.stopOperations.get(ownerId);
    if (pendingStop) await pendingStop;
    this.stoppingOwners.delete(ownerId);
    this.activeRunByOwner.set(ownerId, runId);
  }

  isActiveRun(context: Pick<ExecutionContext, 'ownerId' | 'runId'>): boolean {
    return this.activeRunByOwner.get(context.ownerId) === context.runId;
  }

  completeRun(context: Pick<ExecutionContext, 'ownerId' | 'runId'>): void {
    if (this.activeRunByOwner.get(context.ownerId) === context.runId) {
      this.activeRunByOwner.delete(context.ownerId);
    }
  }

  beginCall(context: ExecutionContext, callId?: string): ToolCallExecutionContext {
    const currentConversationId = this.resolveConversationId(context);
    const call = createToolCallExecutionContext(
      { ...context, conversationId: currentConversationId },
      callId,
    );
    this.activeCalls.set(call.callId, call);
    return call;
  }

  endCall(callId: string): void {
    this.activeCalls.delete(callId);
  }

  registerCancelable(ownerId: string, key: string, cancel: () => void | Promise<void>, runId?: string): boolean {
    if (!ownerId || !key) return false;
    const activeRunId = this.activeRunByOwner.get(ownerId);
    if (this.stoppingOwners.has(ownerId) || (runId && activeRunId && runId !== activeRunId)) {
      this.trackLateCancellation(ownerId, cancel);
      return false;
    }
    const ownerTasks = this.cancellablesByOwner.get(ownerId) ?? new Map<string, CancelableEntry>();
    ownerTasks.set(key, { cancel, runId });
    this.cancellablesByOwner.set(ownerId, ownerTasks);
    return true;
  }

  releaseCancelable(ownerId: string, key: string): void {
    const ownerTasks = this.cancellablesByOwner.get(ownerId);
    if (!ownerTasks) return;
    ownerTasks.delete(key);
    if (ownerTasks.size === 0) this.cancellablesByOwner.delete(ownerId);
  }

  linkOwner(parentOwnerId: string, childOwnerId: string): void {
    if (!parentOwnerId || !childOwnerId || parentOwnerId === childOwnerId) return;
    this.unlinkOwner(childOwnerId);
    this.parentByOwner.set(childOwnerId, parentOwnerId);
    const children = this.childrenByOwner.get(parentOwnerId) ?? new Set<string>();
    children.add(childOwnerId);
    this.childrenByOwner.set(parentOwnerId, children);
    if (this.stoppingOwners.has(parentOwnerId)) {
      this.stoppingOwners.add(childOwnerId);
      this.trackLatePromise(parentOwnerId, this.cancelOwner(childOwnerId).then(() => undefined));
    }
  }

  unlinkOwner(childOwnerId: string): void {
    const parentOwnerId = this.parentByOwner.get(childOwnerId);
    if (!parentOwnerId) return;
    this.parentByOwner.delete(childOwnerId);
    const children = this.childrenByOwner.get(parentOwnerId);
    children?.delete(childOwnerId);
    if (children?.size === 0) this.childrenByOwner.delete(parentOwnerId);
  }

  async cancelOwner(ownerId: string): Promise<number> {
    const existing = this.stopOperations.get(ownerId);
    if (existing) return existing;
    const operation = (async () => {
      let total = 0;
      let stablePasses = 0;
      while (stablePasses < 2) {
        const owners = this.collectOwnerTree(ownerId);
        for (const targetOwnerId of owners) this.stoppingOwners.add(targetOwnerId);
        const pending: Promise<unknown>[] = [];
        let foundWork = false;
        for (const targetOwnerId of owners) {
          const ownerTasks = this.cancellablesByOwner.get(targetOwnerId);
          if (ownerTasks?.size) {
            this.cancellablesByOwner.delete(targetOwnerId);
            const cancellations = [...ownerTasks.values()];
            total += cancellations.length;
            foundWork = true;
            pending.push(...cancellations.map(entry => Promise.resolve().then(entry.cancel)));
          }
          const late = this.lateCancellationsByOwner.get(targetOwnerId);
          if (late?.size) {
            foundWork = true;
            pending.push(...late);
          }
        }
        if (pending.length) await Promise.allSettled(pending);
        await Promise.resolve();
        const nextOwners = this.collectOwnerTree(ownerId);
        const hasNewWork = nextOwners.some(targetOwnerId =>
          (this.cancellablesByOwner.get(targetOwnerId)?.size ?? 0) > 0
          || (this.lateCancellationsByOwner.get(targetOwnerId)?.size ?? 0) > 0,
        );
        stablePasses = !foundWork && !hasNewWork && nextOwners.length === owners.length
          ? stablePasses + 1
          : 0;
      }
      return total;
    })();
    this.stopOperations.set(ownerId, operation);
    try {
      return await operation;
    } finally {
      this.stopOperations.delete(ownerId);
    }
  }

  private collectOwnerTree(ownerId: string): string[] {
    const result: string[] = [];
    const pending = [ownerId];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      result.push(current);
      pending.push(...(this.childrenByOwner.get(current) ?? []));
    }
    return result;
  }

  private trackLateCancellation(ownerId: string, cancel: () => void | Promise<void>): void {
    try {
      this.trackLatePromise(ownerId, Promise.resolve(cancel()));
    } catch {
      this.trackLatePromise(ownerId, Promise.resolve());
    }
  }

  private trackLatePromise(ownerId: string, promise: Promise<void>): void {
    const pending = this.lateCancellationsByOwner.get(ownerId) ?? new Set<Promise<void>>();
    pending.add(promise);
    this.lateCancellationsByOwner.set(ownerId, pending);
    void promise.finally(() => {
      pending.delete(promise);
      if (pending.size === 0) this.lateCancellationsByOwner.delete(ownerId);
    }).catch(() => undefined);
  }

  resolveConversationId(context: Pick<ExecutionContext, 'ownerId' | 'conversationId'>): string {
    return this.slotsByOwner.get(context.ownerId)?.conversationId ?? context.conversationId;
  }

  async promoteConversation(fromId: string, toId: string): Promise<void> {
    if (!fromId || !toId || fromId === toId) return;
    const ownerId = this.ownerByConversation.get(fromId);
    if (!ownerId) return;
    const occupiedOwner = this.ownerByConversation.get(toId);
    if (occupiedOwner && occupiedOwner !== ownerId) {
      throw new Error(`Cannot promote ${fromId}: target conversation ${toId} already has an execution owner`);
    }
    const slot = this.slotsByOwner.get(ownerId);
    if (!slot) throw new Error(`Execution owner ${ownerId} is missing`);
    const rebindToolTasks = typeof window !== 'undefined'
      ? window.synapse?.toolTask?.rebindConversation ?? window.synapse?.command.rebindConversation
      : undefined;
    if (rebindToolTasks) {
      await rebindToolTasks({ ownerId, fromId, toId });
    }
    this.ownerByConversation.delete(fromId);
    this.ownerByConversation.set(toId, ownerId);
    this.persistOwnerMappings([fromId]);
    slot.conversationId = toId;
  }

  async stopConversation(conversationId: string): Promise<boolean> {
    const ownerId = this.ownerForConversation(conversationId);
    const loop = this.getLoop(conversationId);
    if (!ownerId && !loop) return false;
    loop?.stop();
    if (ownerId) await this.cancelOwner(ownerId);
    const toolTask = typeof window !== 'undefined' ? window.synapse?.toolTask : undefined;
    if (ownerId && toolTask?.list) {
      try {
        const snapshots = await toolTask.list({ conversationId, ownerId });
        await Promise.allSettled(snapshots
          .filter(snapshot => snapshot.status === 'running' || snapshot.status === 'cancelling')
          .map(snapshot => toolTask.cancel(snapshot.taskId, { conversationId, ownerId })));
      } catch {
        // Stop 的本地复位不能被后台任务对账失败阻塞；未知任务会在工具卡重载对账时显式呈现。
      }
    }
    return true;
  }

  removeIdleLoop(conversationId: string): void {
    const ownerId = this.ownerByConversation.get(conversationId);
    if (!ownerId) return;
    const slot = this.slotsByOwner.get(ownerId);
    if (!slot || slot.loop.isRunning) return;
    this.slotsByOwner.delete(ownerId);
    this.activeRunByOwner.delete(ownerId);
    this.stoppingOwners.delete(ownerId);
  }

  private ownerForConversation(conversationId: string): string | null {
    const active = this.ownerByConversation.get(conversationId);
    if (active) return active;
    if (typeof localStorage === 'undefined') return null;
    try {
      const stored = JSON.parse(localStorage.getItem(OWNER_STORAGE_KEY) || '{}') as Record<string, unknown>;
      const ownerId = stored[conversationId];
      if (!this.isValidOwnerId(ownerId)) return null;
      this.ownerByConversation.set(conversationId, ownerId);
      return ownerId;
    } catch {
      return null;
    }
  }

  private isValidOwnerId(ownerId: unknown): ownerId is string {
    return typeof ownerId === 'string' && /^owner-[A-Za-z0-9._-]+$/.test(ownerId);
  }

  private persistOwnerMappings(removeConversationIds: string[] = []): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const stored = JSON.parse(localStorage.getItem(OWNER_STORAGE_KEY) || '{}') as Record<string, unknown>;
      for (const conversationId of removeConversationIds) delete stored[conversationId];
      localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify({ ...stored, ...Object.fromEntries(this.ownerByConversation) }));
    } catch {
      return;
    }
  }

  debugSnapshot(): Array<{ ownerId: string; conversationId: string; isRunning: boolean }> {
    return [...this.slotsByOwner.values()].map(slot => ({
      ownerId: slot.ownerId,
      conversationId: slot.conversationId,
      isRunning: slot.loop.isRunning,
    }));
  }
}

export const executionRegistry = new ExecutionRegistry();

if (typeof window !== 'undefined') {
  (window as any).__SYNAPSE_EXECUTION_REGISTRY__ = executionRegistry;
}
