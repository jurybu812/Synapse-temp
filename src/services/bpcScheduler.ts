import { store, type RootState } from '../store';
import {
  renameBpcConversation,
  resetBpcUi,
  setBpcUiState,
  type BpcUiStateEnum,
} from '../store/slices/bpc';
import { selectConversationById } from '../store/slices/conversation';
import { addNotification } from '../store/slices/notifications';
import { DEFAULT_BPC_CONFIG } from '../store/slices/agentSettings';
import type { AgentLoop } from './agentLoop';
import {
  captureRecordGenerationRuntime,
  sameRecordGenerationRuntime,
  type RecordGenerationRuntime,
  type RecordSourceMessage,
} from './recordGenerator';
import {
  discardPreparedCandidate,
  getContextGenerationState,
  publishPreparedCandidate,
  updateContextGenerationState,
  type PreparedRecordCandidate,
  type SynapseRecord,
} from './recordStore';

type SchedulerState = BpcUiStateEnum;
const BPC_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

interface BpcSnapshot {
  conversationId: string;
  snapshotStepCursor: number;
  snapshotRoundCursor: number;
  compressedSegment: RecordSourceMessage[];
  targetReplaceStep: number;
  createdAt: number;
  recordMd?: string | null;
  candidateId: string;
  inputHash?: string;
  candidate?: PreparedRecordCandidate | null;
  generationRuntime: RecordGenerationRuntime;
}

interface BpcRuntime {
  snapshot: BpcSnapshot | null;
  state: SchedulerState;
  abortControllers: Set<AbortController>;
  generationLoop: AgentLoop | null;
  genPromise: Promise<unknown> | null;
  generationToken: symbol | null;
  cooldownUntil: number | null;
  circuitBroken: boolean;
  lastReplaceStepCursor: number | null;
  consecutiveImmediateRetrigger: number;
  retryCount: number;
  backoffUntil: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  hardPaused: boolean;
  hydrated: boolean;
  hydrationPromise: Promise<void> | null;
  persistencePromise: Promise<void>;
}

function generationIdentityFromRuntime(runtime: RecordGenerationRuntime) {
  return {
    providerId: runtime.providerId,
    modelId: runtime.modelId,
    catalogGeneration: runtime.catalogGeneration,
    accountFingerprint: runtime.accountFingerprint,
    credentialGeneration: runtime.credentialGeneration,
  };
}

function generationIdentityPatch(runtime: RecordGenerationRuntime | null | undefined) {
  return runtime
    ? generationIdentityFromRuntime(runtime)
    : {
      providerId: null,
      modelId: null,
      catalogGeneration: null,
      accountFingerprint: null,
      credentialGeneration: null,
    };
}

export interface BpcWaterContext {
  triggerTokens: number;
  modelContextWindow: number;
  conversationId: string;
  currentStepCursor: number;
}

function createRuntime(): BpcRuntime {
  return {
    snapshot: null,
    state: 'idle',
    abortControllers: new Set<AbortController>(),
    generationLoop: null,
    genPromise: null,
    generationToken: null,
    cooldownUntil: null,
    circuitBroken: false,
    lastReplaceStepCursor: null,
    consecutiveImmediateRetrigger: 0,
    retryCount: 0,
    backoffUntil: null,
    retryTimer: null,
    hardPaused: false,
    hydrated: false,
    hydrationPromise: null,
    persistencePromise: Promise.resolve(),
  };
}

export class BpcScheduler {
  private readonly runtimes = new Map<string, BpcRuntime>();
  private readonly captureGenerationRuntime: () => RecordGenerationRuntime | null;

  constructor(
    captureGenerationRuntime: () => RecordGenerationRuntime | null = captureRecordGenerationRuntime,
  ) {
    this.captureGenerationRuntime = captureGenerationRuntime;
  }

  private runtime(conversationId: string): BpcRuntime {
    if (!conversationId) throw new Error('BPC runtime requires conversationId');
    const existing = this.runtimes.get(conversationId);
    if (existing) return existing;
    const created = createRuntime();
    this.runtimes.set(conversationId, created);
    return created;
  }

  private async ensureHydrated(conversationId: string, runtime = this.runtime(conversationId)): Promise<void> {
    if (runtime.hydrated) return;
    if (runtime.hydrationPromise) return runtime.hydrationPromise;
    runtime.hydrationPromise = (async () => {
      const persisted = await getContextGenerationState(conversationId);
      if (persisted?.state === 'prepared' && persisted.candidateId) {
        await discardPreparedCandidate(conversationId, persisted.candidateId, '应用重启后丢弃未发布候选');
      }
      runtime.retryCount = persisted?.retryCount ?? 0;
      runtime.backoffUntil = persisted?.backoffUntil ?? null;
      runtime.cooldownUntil = persisted?.cooldownUntil ?? null;
      runtime.circuitBroken = Boolean(persisted?.circuitBroken);
      runtime.lastReplaceStepCursor = persisted?.lastReplaceStepCursor ?? null;
      runtime.consecutiveImmediateRetrigger = persisted?.immediateRetriggerCount ?? 0;
      runtime.hardPaused = Boolean(persisted?.hardPaused);
      runtime.hydrated = true;
      if (runtime.hardPaused) {
        this.setState(conversationId, runtime, 'hard-paused', {
          progress: 0,
          lastError: persisted?.lastError ?? '上次硬压缩未完成，已保护性暂停',
        });
      } else if (runtime.circuitBroken) {
        this.setState(conversationId, runtime, 'circuit-broken', {
          progress: 0,
          lastError: persisted?.lastError ?? 'BPC 循环已停止',
        });
      } else if (runtime.cooldownUntil && runtime.cooldownUntil > Date.now()) {
        this.setState(conversationId, runtime, 'cooldown', {
          progress: 0,
          cooldownUntil: runtime.cooldownUntil,
        });
      } else {
        // Snapshot、定时器和生成 Promise 都是进程内运行态。应用重启后即使数据库仍记录
        // “snapshotting + retry backoff”，也没有可安全续跑的冻结输入，必须立即归一为空闲，
        // 不能让过期 retryCount/backoffUntil 一直留到用户下一次发送才被顺手覆盖。
        runtime.retryCount = 0;
        runtime.backoffUntil = null;
        runtime.cooldownUntil = null;
        this.setState(conversationId, runtime, 'idle', { progress: 0, cooldownUntil: null });
      }
    })().finally(() => {
      runtime.hydrationPromise = null;
    });
    return runtime.hydrationPromise;
  }

  private persistRuntime(
    conversationId: string,
    runtime: BpcRuntime,
    lastError?: string | null,
  ): Promise<void> {
    if (!runtime.hydrated) return runtime.persistencePromise;
    const patch = {
      schedulerState: runtime.state,
      retryCount: runtime.retryCount,
      backoffUntil: runtime.backoffUntil,
      hardPaused: runtime.hardPaused,
      cooldownUntil: runtime.cooldownUntil,
      circuitBroken: runtime.circuitBroken,
      lastReplaceStepCursor: runtime.lastReplaceStepCursor,
      immediateRetriggerCount: runtime.consecutiveImmediateRetrigger,
      ...generationIdentityPatch(runtime.snapshot?.generationRuntime),
      ...(lastError !== undefined ? { lastError } : {}),
    };
    runtime.persistencePromise = runtime.persistencePromise
      .catch(() => undefined)
      .then(async () => {
        await updateContextGenerationState(conversationId, patch);
      });
    return runtime.persistencePromise;
  }

  async ensureConversationReady(conversationId: string): Promise<boolean> {
    const runtime = this.runtime(conversationId);
    await this.ensureHydrated(conversationId, runtime);
    return !runtime.hardPaused;
  }

  async pauseForHardFailure(conversationId: string, reason: string): Promise<void> {
    const runtime = this.runtime(conversationId);
    await this.ensureHydrated(conversationId, runtime);
    await this.discardCurrent(conversationId, reason);
    runtime.hardPaused = true;
    runtime.cooldownUntil = null;
    this.setState(conversationId, runtime, 'hard-paused', { progress: 0, lastError: reason });
    const reconciled = await updateContextGenerationState(conversationId, {
      schedulerState: 'hard-paused',
      hardPaused: true,
      cooldownUntil: null,
      lastError: reason,
    });
    if (!reconciled) throw new Error(`硬压缩暂停状态持久化失败: ${conversationId}`);
  }

  async clearHardPauseAfterRecovery(conversationId: string): Promise<void> {
    const runtime = this.runtime(conversationId);
    await this.ensureHydrated(conversationId, runtime);
    if (!runtime.hardPaused) return;
    runtime.hardPaused = false;
    runtime.retryCount = 0;
    this.setState(conversationId, runtime, 'idle', { progress: 0 });
    const reconciled = await updateContextGenerationState(conversationId, {
      schedulerState: 'idle',
      retryCount: 0,
      hardPaused: false,
      lastError: null,
    });
    if (!reconciled) throw new Error(`硬压缩恢复状态持久化失败: ${conversationId}`);
  }

  private get config() {
    const state = store.getState() as RootState;
    return state.agentSettings?.bpc ?? DEFAULT_BPC_CONFIG;
  }

  private effectiveCompactThreshold(conversationId: string): number {
    const state = store.getState() as RootState;
    const override = selectConversationById(state, conversationId).compactThresholdOverride;
    return typeof override === 'number' && Number.isFinite(override)
      ? override
      : this.config.compactThreshold;
  }

  private effectiveBpcThreshold(conversationId: string): number {
    const state = store.getState() as RootState;
    const override = selectConversationById(state, conversationId).bpcThresholdOverride;
    const raw = typeof override === 'number' && Number.isFinite(override)
      ? override
      : this.config.bpcThreshold;
    const compactCeil = this.effectiveCompactThreshold(conversationId) - 0.05;
    return Math.max(0, Math.min(raw, Math.max(0, compactCeil)));
  }

  getState(conversationId: string): SchedulerState {
    return this.runtime(conversationId).state;
  }

  isBusy(conversationId: string): boolean {
    return this.runtime(conversationId).state !== 'idle';
  }

  hasReadySnapshot(conversationId: string): boolean {
    const runtime = this.runtime(conversationId);
    return runtime.state === 'ready' && runtime.snapshot != null;
  }

  inCooldown(conversationId: string): boolean {
    const runtime = this.runtime(conversationId);
    if (runtime.cooldownUntil == null) return false;
    if (Date.now() >= runtime.cooldownUntil) {
      runtime.cooldownUntil = null;
      if (runtime.state === 'cooldown') {
        this.setState(conversationId, runtime, 'idle', { cooldownUntil: null });
      }
      return false;
    }
    return true;
  }

  private setState(
    conversationId: string,
    runtime: BpcRuntime,
    next: SchedulerState,
    extra?: { progress?: number; cooldownUntil?: number | null; lastError?: string },
  ): void {
    runtime.state = next;
    const payload: {
      conversationId: string;
      state: SchedulerState;
      progress?: number;
      cooldownUntil?: number | null;
      lastError?: string;
    } = { conversationId, state: next };
    if (extra && typeof extra.progress === 'number') payload.progress = extra.progress;
    if (extra && 'cooldownUntil' in extra) payload.cooldownUntil = extra.cooldownUntil;
    if (extra && 'lastError' in extra) payload.lastError = extra.lastError;
    store.dispatch(setBpcUiState(payload));
    const persistedError = extra && 'lastError' in extra
      ? (extra.lastError ?? null)
      : (next === 'idle' || next === 'ready' ? null : undefined);
    void this.persistRuntime(conversationId, runtime, persistedError);
  }

  private isSnapshotIdentityCurrent(snapshot: BpcSnapshot): boolean {
    return sameRecordGenerationRuntime(snapshot.generationRuntime, this.captureGenerationRuntime());
  }

  evaluateWater(ctx: BpcWaterContext, loop: AgentLoop): void {
    if (!ctx.conversationId || ctx.modelContextWindow <= 0) return;
    const runtime = this.runtime(ctx.conversationId);
    if (!runtime.hydrated) {
      void this.ensureHydrated(ctx.conversationId, runtime).then(() => this.evaluateWater(ctx, loop));
      return;
    }
    if (runtime.hardPaused) return;
    if (runtime.circuitBroken || runtime.state !== 'idle' || this.inCooldown(ctx.conversationId)) return;

    const ratio = ctx.triggerTokens / ctx.modelContextWindow;
    if (ratio < this.effectiveBpcThreshold(ctx.conversationId)) return;

    if (runtime.lastReplaceStepCursor != null) {
      const gap = ctx.currentStepCursor - runtime.lastReplaceStepCursor;
      if (gap <= this.config.circuitBreakGapSteps) {
        runtime.consecutiveImmediateRetrigger += 1;
        if (runtime.consecutiveImmediateRetrigger >= 2) {
          this.tripCircuitBreaker(ctx.conversationId, runtime);
          return;
        }
      } else {
        runtime.consecutiveImmediateRetrigger = 0;
      }
    }

    runtime.generationLoop = loop;
    this.triggerSnapshot(ctx.conversationId, ctx.currentStepCursor, loop);
  }

  triggerSnapshot(conversationId: string, currentStepCursor: number, loop?: AgentLoop): void {
    const runtime = this.runtime(conversationId);
    const generationLoop = loop ?? runtime.generationLoop;
    if (!generationLoop || runtime.state !== 'idle') return;
    runtime.generationLoop = generationLoop;
    void currentStepCursor;

    try {
      const input = generationLoop.computeBpcSnapshotInput(conversationId);
      if (input.compressedSegment.length === 0) {
        this.setState(conversationId, runtime, 'idle', { progress: 0 });
        return;
      }
      runtime.retryCount = 0;
      runtime.backoffUntil = null;
      if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
      runtime.retryTimer = null;
      const generationRuntime = this.captureGenerationRuntime();
      if (!generationRuntime) {
        runtime.snapshot = null;
        this.setState(conversationId, runtime, 'idle', { progress: 0 });
        return;
      }
      runtime.snapshot = {
        conversationId,
        candidateId: createCandidateId(),
        snapshotStepCursor: input.snapshotStepCursor,
        snapshotRoundCursor: input.snapshotRoundCursor,
        compressedSegment: deepCloneSegment(input.compressedSegment),
        targetReplaceStep: input.snapshotStepCursor + 1 + this.config.deltaSteps,
        createdAt: Date.now(),
        recordMd: null,
        generationRuntime,
      };
      this.setState(conversationId, runtime, 'snapshotting', { progress: 0.1 });
      void this.runGeneration(conversationId, runtime);
    } catch (error) {
      console.warn('[bpcScheduler] triggerSnapshot 失败，回 idle:', error);
      runtime.snapshot = null;
      this.setState(conversationId, runtime, 'idle', { progress: 0 });
    }
  }

  private async runGeneration(conversationId: string, runtime: BpcRuntime): Promise<void> {
    const snapshot = runtime.snapshot;
    const loop = runtime.generationLoop;
    if (!snapshot || !loop || runtime.genPromise) return;
    if (!this.isSnapshotIdentityCurrent(snapshot)) {
      await this.discardCurrent(conversationId, 'BPC 快照的模型/账号身份已变化，已丢弃候选');
      return;
    }

    const controller = new AbortController();
    const generationToken = Symbol(conversationId);
    runtime.abortControllers.add(controller);
    runtime.generationToken = generationToken;
    this.setState(conversationId, runtime, 'generating', { progress: 0.5 });

    type GenDecision = { decision: 'ready' | 'no-new-segment' | 'failed' | 'discarded' | 'identity-changed'; failReason: string };
    const task = (async (): Promise<GenDecision> => {
      try {
        const candidateId = snapshot.candidateId;
        const inputHash = await hashBpcSegment(snapshot.compressedSegment);
        snapshot.inputHash = inputHash;
        const result = await loop.bpcGenerate(
          snapshot.conversationId,
          snapshot.compressedSegment,
          controller.signal,
          {
            candidateId,
            inputHash,
            sourceStepCursor: snapshot.snapshotStepCursor,
            sourceRoundCursor: snapshot.snapshotRoundCursor,
            generationRuntime: snapshot.generationRuntime,
          },
        );
        if (runtime.snapshot !== snapshot) return { decision: 'discarded', failReason: '' };
        if (controller.signal.aborted) return { decision: 'failed', failReason: '后台生成被中止' };
        if (!this.isSnapshotIdentityCurrent(snapshot)) {
          return { decision: 'identity-changed', failReason: 'BPC 生成期间模型/账号身份已变化，已丢弃候选' };
        }
        if (result.outcome === 'prepared' && result.candidate) {
          snapshot.recordMd = result.recordMd;
          snapshot.candidate = {
            ...result.candidate,
            ...generationIdentityFromRuntime(snapshot.generationRuntime),
          };
          return { decision: 'ready', failReason: '' };
        }
        if (result.outcome === 'no-new-segment') {
          return { decision: 'no-new-segment', failReason: '' };
        }
        return { decision: 'failed', failReason: '生成未产出 record 批' };
      } catch (error) {
        return { decision: 'failed', failReason: String((error as Error)?.message ?? error) };
      } finally {
        runtime.abortControllers.delete(controller);
        if (runtime.generationToken === generationToken) {
          runtime.generationToken = null;
          runtime.genPromise = null;
        }
      }
    })();
    runtime.genPromise = task;
    const { decision, failReason } = await task;

    if (runtime.snapshot !== snapshot || decision === 'discarded') return;
    if (decision === 'identity-changed') {
      await this.discardCurrent(conversationId, failReason);
      return;
    }
    if (decision === 'ready') {
      this.setState(conversationId, runtime, 'ready', { progress: 1 });
      void this.publishReadyIfIdle(conversationId);
      return;
    }
    if (decision === 'no-new-segment') {
      runtime.snapshot = null;
      runtime.generationLoop = null;
      runtime.retryCount = 0;
      runtime.backoffUntil = null;
      this.setState(conversationId, runtime, 'idle', { progress: 0 });
      return;
    }
    await this.handleGenerationFailureOrAbort(conversationId, runtime, snapshot, failReason);
  }

  async publishReadyIfIdle(conversationId: string): Promise<boolean> {
    const runtime = this.runtime(conversationId);
    if (runtime.state !== 'ready' || !runtime.snapshot || runtime.generationLoop?.isRunning) return false;
    if (!this.isSnapshotIdentityCurrent(runtime.snapshot)) {
      await this.discardCurrent(conversationId, '空闲发布前模型/账号身份已变化，已丢弃候选');
      return false;
    }
    const currentStep = this.currentStepFromStore(conversationId, runtime);
    if (currentStep == null) {
      await this.discardCurrent(conversationId, '空闲发布前无法确认当前对话水位');
      return false;
    }
    return Boolean(await this.takeReadyPrefix(conversationId, currentStep));
  }

  private async handleGenerationFailureOrAbort(
    conversationId: string,
    runtime: BpcRuntime,
    snapshot: BpcSnapshot,
    reason: string,
  ): Promise<void> {
    if (runtime.snapshot !== snapshot) return;
    const currentStep = this.currentStepFromStore(conversationId, runtime);
    const withinWindow = currentStep != null && currentStep < snapshot.targetReplaceStep;
    if (withinWindow && runtime.retryCount < BPC_RETRY_DELAYS_MS.length) {
      const delay = BPC_RETRY_DELAYS_MS[runtime.retryCount];
      runtime.retryCount += 1;
      runtime.backoffUntil = Date.now() + delay;
      this.setState(conversationId, runtime, 'snapshotting', {
        progress: 0.1,
        lastError: `${reason || '后台压缩失败'}，${Math.round(delay / 1000)} 秒后重试`,
      });
      if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
      runtime.retryTimer = setTimeout(() => {
        runtime.retryTimer = null;
        runtime.backoffUntil = null;
        if (runtime.snapshot !== snapshot || runtime.hardPaused) return;
        const liveStep = this.currentStepFromStore(conversationId, runtime);
        if (liveStep == null || liveStep >= snapshot.targetReplaceStep) {
          void this.discardCurrent(conversationId, 'BPC 重试前历史已越过候选窗口');
          return;
        }
        void this.runGeneration(conversationId, runtime);
      }, delay);
      return;
    }
    await this.discardCurrent(conversationId, reason);
  }

  async takeReadyPrefix(
    conversationId: string,
    currentStepCursor: number,
  ): Promise<{ recordMd: string | null; snapshotStepCursor: number; snapshotRoundCursor: number } | null> {
    const runtime = this.runtime(conversationId);
    if (runtime.state !== 'ready' || !runtime.snapshot) return null;
    const snapshot = runtime.snapshot;
    if (!this.isSnapshotIdentityCurrent(snapshot)) {
      await this.discardCurrent(conversationId, '正式发布前模型/账号身份已变化，已丢弃候选');
      return null;
    }
    const candidate = snapshot.candidate;
    const loop = runtime.generationLoop;
    if (!candidate || !loop || !snapshot.inputHash) {
      await this.discardCurrent(conversationId, '候选状态不完整');
      return null;
    }
    this.setState(conversationId, runtime, 'replacing', { progress: 1 });
    const current = loop.computeBpcSnapshotInput(conversationId);
    const sourcePrefix = current.compressedSegment.slice(0, snapshot.compressedSegment.length);
    const currentInputHash = await hashBpcSegment(sourcePrefix);
    if (
      currentInputHash !== snapshot.inputHash
      || current.snapshotStepCursor < snapshot.snapshotStepCursor
      || current.snapshotRoundCursor < snapshot.snapshotRoundCursor
    ) {
      await this.discardCurrent(conversationId, '正式发布前发现历史来源已变化');
      return null;
    }
    const published = await publishPreparedCandidate(candidate, loop.getBpcPublishMessages(conversationId));
    if (!published) {
      await this.discardCurrent(conversationId, '父修订或候选身份已变化，拒绝发布');
      return null;
    }
    const finalized = await loop.finalizePublishedBpc(conversationId, published);
    await updateContextGenerationState(conversationId, {
      publishedRevision: finalized.revision,
    });
    const result = {
      recordMd: finalized.recordMd,
      snapshotStepCursor: snapshot.snapshotStepCursor,
      snapshotRoundCursor: snapshot.snapshotRoundCursor,
    };
    runtime.snapshot = null;
    runtime.generationLoop = null;
    runtime.retryCount = 0;
    runtime.backoffUntil = null;
    runtime.lastReplaceStepCursor = currentStepCursor;
    this.setState(conversationId, runtime, 'idle', { progress: 0 });
    return result;
  }

  async discardCurrent(conversationId: string, reason?: string): Promise<void> {
    const runtime = this.runtime(conversationId);
    const candidateId = runtime.snapshot?.candidateId;
    for (const controller of runtime.abortControllers) controller.abort();
    runtime.abortControllers.clear();
    runtime.snapshot = null;
    runtime.generationLoop = null;
    runtime.genPromise = null;
    runtime.generationToken = null;
    runtime.retryCount = 0;
    runtime.backoffUntil = null;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    await discardPreparedCandidate(conversationId, candidateId, reason);
    if (reason) console.warn(`[bpcScheduler:${conversationId}] discardCurrent:`, reason);
    if (runtime.state !== 'cooldown' && runtime.state !== 'circuit-broken' && runtime.state !== 'hard-paused') {
      this.setState(conversationId, runtime, 'idle', { progress: 0 });
      await runtime.persistencePromise;
    }
  }

  async reconcileAfterHistoryMutation(
    conversationId: string,
    record: SynapseRecord | null,
  ): Promise<void> {
    const runtime = this.runtime(conversationId);
    await this.ensureHydrated(conversationId, runtime);
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    runtime.retryCount = 0;
    runtime.backoffUntil = null;
    runtime.lastReplaceStepCursor = null;
    runtime.consecutiveImmediateRetrigger = 0;
    runtime.state = 'idle';
    store.dispatch(setBpcUiState({ conversationId, state: 'idle', progress: 0 }));

    // record 被整条删除时，底层会连同 generation row 一起删除；这里不能再写一条 idle
    // 状态把它复活。仍有 Record 时则把发布水位同步到裁剪后的真实修订和轮/step 边界。
    if (!record) return;
    await updateContextGenerationState(conversationId, {
      state: 'published',
      schedulerState: 'idle',
      parentRevision: record.revision,
      publishedRevision: record.revision,
      sourceStepCursor: record.totalSteps,
      sourceRoundCursor: record.totalRounds,
      inputHash: null,
      retryCount: 0,
      backoffUntil: null,
      lastReplaceStepCursor: null,
      immediateRetriggerCount: 0,
      lastError: null,
    });
  }

  abort(conversationId: string): void {
    const runtime = this.runtime(conversationId);
    const candidateId = runtime.snapshot?.candidateId;
    const cooldownUntil = Date.now() + this.config.abortCooldownMin * 60_000;
    runtime.snapshot = null;
    for (const controller of runtime.abortControllers) controller.abort();
    runtime.abortControllers.clear();
    runtime.generationLoop = null;
    runtime.genPromise = null;
    runtime.generationToken = null;
    runtime.retryCount = 0;
    runtime.backoffUntil = null;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    runtime.cooldownUntil = cooldownUntil;
    void discardPreparedCandidate(conversationId, candidateId, '用户中止 BPC');
    this.setState(conversationId, runtime, 'cooldown', { progress: 0, cooldownUntil });
  }

  async restart(conversationId: string): Promise<void> {
    const runtime = this.runtime(conversationId);
    await this.ensureHydrated(conversationId, runtime);
    const candidateId = runtime.snapshot?.candidateId;
    for (const controller of runtime.abortControllers) controller.abort();
    runtime.abortControllers.clear();
    runtime.snapshot = null;
    runtime.generationLoop = null;
    runtime.genPromise = null;
    runtime.generationToken = null;
    runtime.retryCount = 0;
    runtime.backoffUntil = null;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    runtime.cooldownUntil = null;
    runtime.circuitBroken = false;
    runtime.hardPaused = false;
    runtime.consecutiveImmediateRetrigger = 0;
    runtime.lastReplaceStepCursor = null;
    runtime.state = 'idle';
    await discardPreparedCandidate(conversationId, candidateId, '用户显式恢复压缩');
    store.dispatch(resetBpcUi(conversationId));
    await updateContextGenerationState(conversationId, {
      schedulerState: 'idle',
      retryCount: 0,
      hardPaused: false,
      cooldownUntil: null,
      circuitBroken: false,
      lastReplaceStepCursor: null,
      immediateRetriggerCount: 0,
      lastError: null,
    });
  }

  async promoteConversation(fromId: string, toId: string): Promise<void> {
    if (!fromId || !toId || fromId === toId) return;
    const source = this.runtimes.get(fromId);
    if (source) {
      if (source.state !== 'idle' && source.state !== 'cooldown' && source.state !== 'circuit-broken') {
        await this.discardCurrent(fromId, '草稿提升为正式对话，丢弃旧身份候选');
      }
      await source.persistencePromise;
      const target = this.runtimes.get(toId);
      if (target && target !== source) await this.discardCurrent(toId, '对话身份迁移覆盖旧运行态');
      if (source.snapshot) source.snapshot.conversationId = toId;
      this.runtimes.set(toId, source);
      this.runtimes.delete(fromId);
    }
    store.dispatch(renameBpcConversation({ fromId, toId }));
  }

  private tripCircuitBreaker(conversationId: string, runtime: BpcRuntime): void {
    const candidateId = runtime.snapshot?.candidateId;
    runtime.circuitBroken = true;
    runtime.snapshot = null;
    runtime.generationLoop = null;
    for (const controller of runtime.abortControllers) controller.abort();
    runtime.abortControllers.clear();
    runtime.genPromise = null;
    runtime.generationToken = null;
    runtime.backoffUntil = null;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    void discardPreparedCandidate(conversationId, candidateId, 'BPC 熔断');
    this.setState(conversationId, runtime, 'circuit-broken', { progress: 0, lastError: 'BPC 循环已停止' });
    const title = selectConversationById(store.getState() as RootState, conversationId).title || conversationId;
    store.dispatch(addNotification({
      type: 'warning',
      title: `BPC 后台压缩已停止 · ${title}`,
      message: '检测到压缩后很快再次触发，已只停止这条对话的后台预压缩，可在压缩状态环中重启。',
      duration: 0,
    }));
  }

  private currentStepFromStore(conversationId: string, runtime: BpcRuntime): number | null {
    if (!runtime.generationLoop) return null;
    try {
      return runtime.generationLoop.computeBpcSnapshotInput(conversationId).snapshotStepCursor;
    } catch {
      return null;
    }
  }

  __debugSnapshotMeta(conversationId: string): {
    state: SchedulerState;
    hasSnapshot: boolean;
    snapshotStepCursor: number | null;
    targetReplaceStep: number | null;
    circuitBroken: boolean;
    cooldownUntil: number | null;
    lastReplaceStepCursor: number | null;
    providerId: string | null;
    modelId: string | null;
    catalogGeneration: string | null;
    credentialGeneration: number | null;
    accountFingerprintCaptured: boolean;
  } {
    const runtime = this.runtime(conversationId);
    return {
      state: runtime.state,
      hasSnapshot: runtime.snapshot != null,
      snapshotStepCursor: runtime.snapshot?.snapshotStepCursor ?? null,
      targetReplaceStep: runtime.snapshot?.targetReplaceStep ?? null,
      circuitBroken: runtime.circuitBroken,
      cooldownUntil: runtime.cooldownUntil,
      lastReplaceStepCursor: runtime.lastReplaceStepCursor,
      providerId: runtime.snapshot?.generationRuntime.providerId ?? null,
      modelId: runtime.snapshot?.generationRuntime.modelId ?? null,
      catalogGeneration: runtime.snapshot?.generationRuntime.catalogGeneration ?? null,
      credentialGeneration: runtime.snapshot?.generationRuntime.credentialGeneration ?? null,
      accountFingerprintCaptured: Boolean(runtime.snapshot?.generationRuntime.accountFingerprint),
    };
  }
}

function deepCloneSegment(segment: RecordSourceMessage[]): RecordSourceMessage[] {
  try {
    if (typeof structuredClone === 'function') return structuredClone(segment);
  } catch {
    // fall through
  }
  return JSON.parse(JSON.stringify(segment));
}

function createCandidateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function hashBpcSegment(segment: RecordSourceMessage[]): Promise<string> {
  const source = JSON.stringify(segment);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export const bpcScheduler = new BpcScheduler();
