import type { QueuedMessage } from '../store/slices/conversation';

export type QueueDrainSource = 'queue' | 'interrupt';

export interface QueueDrainItem {
  source: QueueDrainSource;
  message: QueuedMessage;
}

export interface InterruptContinuationTaskBoundary {
  previousBoundaryId: string;
  previousHeadline?: string;
  previousSummary?: string;
  continuationIndex?: number;
}

export interface QueueDrainBucketSnapshot {
  queuedMessages?: QueuedMessage[];
  interruptMessages?: QueuedMessage[];
  messages?: Array<{
    toolCalls?: Array<{ status?: string }>;
  }>;
}

export type QueueDrainBlockReason =
  | 'empty'
  | 'streaming'
  | 'running'
  | 'tool-task-running'
  | 'history-mutation'
  | 'hard-paused'
  | 'credential-unavailable'
  | 'loop-unavailable'
  | 'batch-changed'
  | 'attachment-blocked'
  | 'special-background-blocked';

export type QueueDrainResult =
  | { status: 'empty'; reason?: 'empty' }
  | { status: 'blocked'; reason: QueueDrainBlockReason }
  | { status: 'handled'; continueImmediately?: boolean }
  | { status: 'started' };

export type QueueDrainRequestReason =
  | 'foreground-idle'
  | 'agent-settled'
  | 'queue-mutated'
  | 'manual'
  | string;

export type QueueDrainHandler = (
  conversationId: string,
  reasons: QueueDrainRequestReason[],
) => Promise<QueueDrainResult> | QueueDrainResult;

export function buildQueueDrainBatch(bucket: QueueDrainBucketSnapshot): QueueDrainItem[] {
  const interrupts = bucket.interruptMessages ?? [];
  if (interrupts.length > 0) {
    return interrupts.map(message => ({ source: 'interrupt' as const, message }));
  }
  return (bucket.queuedMessages ?? []).map(message => ({ source: 'queue' as const, message }));
}

export function isQueueDrainBatchCurrent(bucket: QueueDrainBucketSnapshot, batch: QueueDrainItem[]): boolean {
  const expectedQueueIds = batch
    .filter(item => item.source === 'queue')
    .map(item => item.message.id);
  const expectedInterruptIds = batch
    .filter(item => item.source === 'interrupt')
    .map(item => item.message.id);
  const queue = bucket.queuedMessages ?? [];
  const interrupt = bucket.interruptMessages ?? [];
  if (expectedQueueIds.length > 0) {
    if (interrupt.length > 0 || queue.length !== expectedQueueIds.length) return false;
    return expectedQueueIds.every((id, index) => queue[index]?.id === id);
  }
  if (expectedInterruptIds.length > 0) {
    if (interrupt.length !== expectedInterruptIds.length) return false;
    return expectedInterruptIds.every((id, index) => interrupt[index]?.id === id);
  }
  return queue.length === 0 && interrupt.length === 0;
}

export function queueDrainBoundaryMode(batch: QueueDrainItem[]): 'none' | 'done' | 'interrupted' {
  if (batch.length === 0) return 'none';
  return batch[0].source === 'interrupt' ? 'interrupted' : 'done';
}

export function interruptContinuationFromBoundary(boundary: {
  id?: unknown;
  headline?: unknown;
  summary?: unknown;
  continuationIndex?: unknown;
} | null | undefined): InterruptContinuationTaskBoundary | undefined {
  if (!boundary || typeof boundary.id !== 'string' || !boundary.id) return undefined;
  const priorIndex = typeof boundary.continuationIndex === 'number' && Number.isFinite(boundary.continuationIndex)
    ? boundary.continuationIndex
    : 0;
  return {
    previousBoundaryId: boundary.id,
    previousHeadline: typeof boundary.headline === 'string' ? boundary.headline : undefined,
    previousSummary: typeof boundary.summary === 'string' ? boundary.summary : undefined,
    continuationIndex: priorIndex + 1,
  };
}

export function hasPendingToolTaskWork(bucket: QueueDrainBucketSnapshot): boolean {
  return (bucket.messages ?? []).some(message => (
    message.toolCalls?.some(toolCall => (
      toolCall.status === 'pending' || toolCall.status === 'running' || toolCall.status === 'cancelling'
    )) ?? false
  ));
}

export function queueDrainBlockReason(flags: {
  isStreaming?: boolean;
  isRunning?: boolean;
  hasPendingToolTasks?: boolean;
  hasHistoryMutation?: boolean;
  hasRunnableModel?: boolean;
  hasLoop?: boolean;
}): QueueDrainBlockReason | null {
  if (flags.isStreaming) return 'streaming';
  if (flags.isRunning) return 'running';
  if (flags.hasPendingToolTasks) return 'tool-task-running';
  if (flags.hasHistoryMutation) return 'history-mutation';
  if (flags.hasRunnableModel === false) return 'credential-unavailable';
  if (flags.hasLoop === false) return 'loop-unavailable';
  return null;
}

export class QueueDrainCoordinator {
  private handler: QueueDrainHandler | null = null;
  private readonly pendingReasons = new Map<string, Set<QueueDrainRequestReason>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly pendingInterruptContinuations = new Map<string, InterruptContinuationTaskBoundary>();

  registerHandler(handler: QueueDrainHandler): () => void {
    this.handler = handler;
    for (const conversationId of this.pendingReasons.keys()) {
      void this.start(conversationId);
    }
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  requestDrain(conversationId: string, reason: QueueDrainRequestReason = 'manual'): void {
    if (!conversationId) return;
    const reasons = this.pendingReasons.get(conversationId) ?? new Set<QueueDrainRequestReason>();
    reasons.add(reason);
    this.pendingReasons.set(conversationId, reasons);
    void this.start(conversationId);
  }

  retryPending(reason: QueueDrainRequestReason = 'manual'): void {
    for (const conversationId of this.pendingReasons.keys()) {
      const reasons = this.pendingReasons.get(conversationId) ?? new Set<QueueDrainRequestReason>();
      reasons.add(reason);
      this.pendingReasons.set(conversationId, reasons);
      void this.start(conversationId);
    }
  }

  async drainNow(conversationId: string, reason: QueueDrainRequestReason = 'manual'): Promise<void> {
    if (!conversationId) return;
    const reasons = this.pendingReasons.get(conversationId) ?? new Set<QueueDrainRequestReason>();
    reasons.add(reason);
    this.pendingReasons.set(conversationId, reasons);
    await this.start(conversationId);
  }

  cancelDrain(conversationId: string): void {
    if (!conversationId) return;
    this.pendingReasons.delete(conversationId);
    this.pendingInterruptContinuations.delete(conversationId);
  }

  rememberInterruptContinuation(conversationId: string, continuation: InterruptContinuationTaskBoundary | undefined): void {
    if (!conversationId || !continuation) return;
    this.pendingInterruptContinuations.set(conversationId, continuation);
  }

  peekInterruptContinuation(conversationId: string): InterruptContinuationTaskBoundary | undefined {
    return this.pendingInterruptContinuations.get(conversationId);
  }

  clearInterruptContinuation(conversationId: string): void {
    if (!conversationId) return;
    this.pendingInterruptContinuations.delete(conversationId);
  }

  debugSnapshot(): Array<{ conversationId: string; inFlight: boolean; pendingReasons: QueueDrainRequestReason[]; hasPendingInterruptContinuation: boolean }> {
    const ids = new Set([...this.pendingReasons.keys(), ...this.inFlight.keys(), ...this.pendingInterruptContinuations.keys()]);
    return [...ids].map(conversationId => ({
      conversationId,
      inFlight: this.inFlight.has(conversationId),
      pendingReasons: [...(this.pendingReasons.get(conversationId) ?? [])],
      hasPendingInterruptContinuation: this.pendingInterruptContinuations.has(conversationId),
    }));
  }

  private start(conversationId: string): Promise<void> {
    if (!this.handler) return Promise.resolve();
    const existing = this.inFlight.get(conversationId);
    if (existing) return existing;
    let restartAfterSettle = false;
    const task = this.flush(conversationId).catch(error => {
      console.warn('[QueueDrainCoordinator] drain failed; pending queue is preserved for the next safe trigger:', error);
    }).then(shouldRestart => {
      restartAfterSettle = shouldRestart === true;
    }).finally(() => {
      this.inFlight.delete(conversationId);
      if (restartAfterSettle && this.pendingReasons.has(conversationId) && this.handler) {
        void this.start(conversationId);
      }
    });
    this.inFlight.set(conversationId, task);
    return task;
  }

  private async flush(conversationId: string): Promise<boolean> {
    const handler = this.handler;
    if (!handler) return false;
    let exhaustedByBatchChanges = false;
    for (let pass = 0; pass < 20; pass += 1) {
      const reasons = [...(this.pendingReasons.get(conversationId) ?? [])];
      if (reasons.length === 0) return false;
      exhaustedByBatchChanges = false;
      this.pendingReasons.delete(conversationId);
      let result: QueueDrainResult;
      try {
        result = await handler(conversationId, reasons);
      } catch (error) {
        this.restorePendingReasons(conversationId, reasons);
        throw error;
      }
      if (result.status === 'blocked') {
        this.restorePendingReasons(conversationId, reasons);
        if (result.reason === 'batch-changed') {
          exhaustedByBatchChanges = true;
          continue;
        }
        return false;
      }
      if (result.status === 'handled' && result.continueImmediately) {
        const nextReasons = this.pendingReasons.get(conversationId) ?? new Set<QueueDrainRequestReason>();
        nextReasons.add('queue-mutated');
        this.pendingReasons.set(conversationId, nextReasons);
        continue;
      }
      return this.pendingReasons.has(conversationId);
    }
    if (exhaustedByBatchChanges) return this.pendingReasons.has(conversationId);
    return this.pendingReasons.has(conversationId);
  }

  private restorePendingReasons(conversationId: string, reasons: QueueDrainRequestReason[]): void {
    if (!conversationId || reasons.length === 0) return;
    const pending = this.pendingReasons.get(conversationId) ?? new Set<QueueDrainRequestReason>();
    for (const reason of reasons) pending.add(reason);
    this.pendingReasons.set(conversationId, pending);
  }
}

export const queueDrainCoordinator = new QueueDrainCoordinator();

if (typeof window !== 'undefined') {
  (window as any).__SYNAPSE_QUEUE_DRAIN_COORDINATOR__ = queueDrainCoordinator;
}
