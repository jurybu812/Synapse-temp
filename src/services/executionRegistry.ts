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

export interface StopAuditSnapshot {
  ownerId: string;
  ownerIds: string[];
  startedAt: number;
  finishedAt: number;
  cancelledCount: number;
  passes: number;
  timedOut: boolean;
  timedOutCancellations: number;
  lateCancellations: number;
  exhaustedPasses: boolean;
  toolTaskTimedOut: boolean;
  toolTaskTimeoutPhase?: 'list' | 'cancel';
  toolTaskTimeoutCount: number;
}

interface TrackedStopPromise {
  promise: Promise<unknown>;
  settled: boolean;
}

interface StopWaitResult {
  timedOut: boolean;
  pendingCount: number;
}

type BoundedWaitResult<T> =
  | { status: 'settled'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' };

const OWNER_STORAGE_KEY = 'synapse_execution_owners_v1';
const STOP_CANCEL_SETTLE_TIMEOUT_MS = 750;
const STOP_TOOL_TASK_SETTLE_TIMEOUT_MS = 750;
const STOP_STABLE_PASSES = 2;
const STOP_MAX_PASSES = 6;

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
  private readonly lateCancellationsByOwner = new Map<string, Set<Promise<unknown>>>();
  private readonly stopAuditsByOwner = new Map<string, StopAuditSnapshot>();

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

  isConversationRunning(conversationId: string): boolean {
    const ownerId = this.ownerForConversation(conversationId);
    if (ownerId && this.activeRunByOwner.has(ownerId)) return true;
    return this.getLoop(conversationId)?.isRunning === true;
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
    const startedAt = Date.now();
    const operation = (async () => {
      let total = 0;
      let stablePasses = 0;
      let passes = 0;
      let timedOutCancellations = 0;
      let lastOwners = [ownerId];
      while (stablePasses < STOP_STABLE_PASSES && passes < STOP_MAX_PASSES) {
        passes += 1;
        const owners = this.collectOwnerTree(ownerId);
        lastOwners = owners;
        for (const targetOwnerId of owners) {
          this.stoppingOwners.add(targetOwnerId);
          this.activeRunByOwner.delete(targetOwnerId);
        }
        const pending: TrackedStopPromise[] = [];
        let foundWork = false;
        for (const targetOwnerId of owners) {
          const ownerTasks = this.cancellablesByOwner.get(targetOwnerId);
          if (ownerTasks?.size) {
            this.cancellablesByOwner.delete(targetOwnerId);
            const cancellations = [...ownerTasks.values()];
            total += cancellations.length;
            foundWork = true;
            pending.push(...cancellations.map(entry => this.invokeCancellation(entry.cancel)));
          }
        }
        const waitResult = await this.waitForTrackedCancellations(pending, STOP_CANCEL_SETTLE_TIMEOUT_MS);
        if (waitResult.timedOut) timedOutCancellations += waitResult.pendingCount;
        await Promise.resolve();
        const nextOwners = this.collectOwnerTree(ownerId);
        const hasNewWork = nextOwners.some(targetOwnerId =>
          (this.cancellablesByOwner.get(targetOwnerId)?.size ?? 0) > 0,
        );
        stablePasses = !foundWork && !hasNewWork && nextOwners.length === owners.length
          ? stablePasses + 1
          : 0;
      }
      const exhaustedPasses = stablePasses < STOP_STABLE_PASSES;
      const audit: StopAuditSnapshot = {
        ownerId,
        ownerIds: lastOwners,
        startedAt,
        finishedAt: Date.now(),
        cancelledCount: total,
        passes,
        timedOut: timedOutCancellations > 0 || exhaustedPasses,
        timedOutCancellations,
        lateCancellations: this.countLateCancellations(lastOwners),
        exhaustedPasses,
        toolTaskTimedOut: false,
        toolTaskTimeoutCount: 0,
      };
      this.stopAuditsByOwner.set(ownerId, audit);
      if (audit.timedOut) this.warnStopTimeout(audit);
      return total;
    })();
    this.stopOperations.set(ownerId, operation);
    try {
      return await operation;
    } finally {
      this.stopOperations.delete(ownerId);
    }
  }

  getLastStopAudit(ownerId: string): StopAuditSnapshot | null {
    const audit = this.stopAuditsByOwner.get(ownerId);
    return audit ? { ...audit, ownerIds: [...audit.ownerIds] } : null;
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
    this.trackLatePromise(ownerId, this.invokeCancellation(cancel).promise);
  }

  private trackLatePromise(ownerId: string, promise: Promise<unknown>): void {
    const pending = this.lateCancellationsByOwner.get(ownerId) ?? new Set<Promise<unknown>>();
    pending.add(promise);
    this.lateCancellationsByOwner.set(ownerId, pending);
    void promise.finally(() => {
      pending.delete(promise);
      if (pending.size === 0) this.lateCancellationsByOwner.delete(ownerId);
    }).catch(() => undefined);
  }

  private invokeCancellation(cancel: () => void | Promise<void>): TrackedStopPromise {
    const tracked: TrackedStopPromise = { promise: Promise.resolve(), settled: false };
    tracked.promise = Promise.resolve()
      .then(cancel)
      .catch(() => undefined)
      .finally(() => {
        tracked.settled = true;
      });
    return tracked;
  }

  private async waitForTrackedCancellations(
    pending: TrackedStopPromise[],
    timeoutMs: number,
  ): Promise<StopWaitResult> {
    if (pending.length === 0) return { timedOut: false, pendingCount: 0 };
    const result = await this.waitBounded(
      Promise.all(pending.map(item => item.promise)),
      timeoutMs,
    );
    const pendingCount = pending.filter(item => !item.settled).length;
    return {
      timedOut: result.status === 'timeout' && pendingCount > 0,
      pendingCount,
    };
  }

  private async waitBounded<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedWaitResult<T>> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const guarded: Promise<BoundedWaitResult<T>> = promise
      .then(value => ({ status: 'settled' as const, value }))
      .catch(error => ({ status: 'rejected' as const, error }));
    const timeout = new Promise<BoundedWaitResult<T>>(resolve => {
      timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });
    const result = await Promise.race([guarded, timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  }

  private countLateCancellations(ownerIds: string[]): number {
    return ownerIds.reduce(
      (total, ownerId) => total + (this.lateCancellationsByOwner.get(ownerId)?.size ?? 0),
      0,
    );
  }

  private recordToolTaskStopTimeout(
    ownerId: string,
    phase: 'list' | 'cancel',
    timeoutCount: number,
  ): void {
    const current = this.stopAuditsByOwner.get(ownerId);
    if (!current) return;
    const next = {
      ...current,
      finishedAt: Date.now(),
      timedOut: true,
      toolTaskTimedOut: true,
      toolTaskTimeoutPhase: phase,
      toolTaskTimeoutCount: timeoutCount,
    };
    this.stopAuditsByOwner.set(ownerId, next);
    this.warnStopTimeout(next);
  }

  private warnStopTimeout(audit: StopAuditSnapshot): void {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
    console.warn('[Synapse] Stop cancellation did not fully settle before timeout', {
      ownerId: audit.ownerId,
      ownerIds: audit.ownerIds,
      cancelledCount: audit.cancelledCount,
      timedOutCancellations: audit.timedOutCancellations,
      lateCancellations: audit.lateCancellations,
      exhaustedPasses: audit.exhaustedPasses,
      toolTaskTimedOut: audit.toolTaskTimedOut,
      toolTaskTimeoutPhase: audit.toolTaskTimeoutPhase,
      toolTaskTimeoutCount: audit.toolTaskTimeoutCount,
    });
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
        const snapshotsResult = await this.waitBounded(
          toolTask.list({ conversationId, ownerId }),
          STOP_TOOL_TASK_SETTLE_TIMEOUT_MS,
        );
        if (snapshotsResult.status === 'timeout') {
          this.recordToolTaskStopTimeout(ownerId, 'list', 1);
          return true;
        }
        if (snapshotsResult.status === 'rejected') throw snapshotsResult.error;
        const cancellations = snapshotsResult.value
          .filter(snapshot => snapshot.status === 'running' || snapshot.status === 'cancelling')
          .map(snapshot => Promise.resolve().then(() => toolTask.cancel(snapshot.taskId, { conversationId, ownerId })));
        const cancelResult = await this.waitBounded(
          Promise.allSettled(cancellations),
          STOP_TOOL_TASK_SETTLE_TIMEOUT_MS,
        );
        if (cancelResult.status === 'timeout') {
          this.recordToolTaskStopTimeout(ownerId, 'cancel', cancellations.length);
          return true;
        }
        if (cancelResult.status === 'rejected') throw cancelResult.error;
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
