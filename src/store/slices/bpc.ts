/**
 * BPC UI 投影 slice —— Plan_5 M5-BPC ★极薄 UI 状态层（决策②：scheduler 持数据 + slice 持 UI 投影）。
 *
 * 职责边界（务必维持）：
 *   - 本 slice【只】承载 CompressionRing / StatusBar / context tab 三处 UI 可响应式订阅的【枚举态 + 进度数字】。
 *   - 真正的运行态数据（BpcSnapshot：深拷贝的 compressedSegment、step/round 游标、targetReplaceStep、生成结果 recordMd）
 *     全部留在 bpcScheduler 的按对话运行桶里，【绝不进本 slice】（大对象、纯运行态、重启即弃）。
 *   - 本 slice【绝不持久化】：store/index.ts 的 persistMiddleware 没有 'bpc/' 前缀分支，故 bpc 的 dispatch 永不落盘；
 *     store 重启后回到 initialState（state='idle'）。同 worktreeSession「运行态前缀不入 persist」思路。
 *
 * 数据流：bpcScheduler 状态机迁移时 dispatch 这里的 action（单向桥）；UI 组件纯 useAppSelector 订阅本 slice，
 *   不直接读 scheduler 内存（除按钮 abort/restart 主动调 scheduler 方法）。这样三处 UI 自动同步、口径一致。
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * BPC 调度状态机的 UI 可见枚举：
 *  - idle          空闲（无在途 BPC，CompressionRing 显常规 token% 文本）
 *  - snapshotting  拍快照中（极短瞬态，深拷贝被压段 + 锁定 step 游标）
 *  - generating    后台生成 record 中（generateBatch 不流式 → UI 显 indeterminate 环）
 *  - ready         生成完成、等待下一轮 run 无缝替换注入前缀
 *  - replacing     正在替换 apiHistory 前缀（极短瞬态）
 *  - aborted       已中止（一般立刻转 cooldown；保留枚举供边界态表达）
 *  - cooldown      用户手动中止后的冷却期（cooldownUntil 到期前不触发 BPC）
 *  - circuit-broken 熔断（替换后立即重触发连续 N 次 → 停 BPC 直到 restart）
 *  - hard-paused   硬压缩未能把请求降到安全预算，阻止继续调用模型，等待用户显式重启
 */
export type BpcUiStateEnum =
  | 'idle'
  | 'snapshotting'
  | 'generating'
  | 'ready'
  | 'replacing'
  | 'aborted'
  | 'cooldown'
  | 'circuit-broken'
  | 'hard-paused';

export interface BpcUiState {
  /** 当前调度状态枚举（UI 据此切渲染态）。 */
  state: BpcUiStateEnum;
  /** 进度 0~1。generateBatch 不流式无真百分比 → 用三档近似：snapshotting≈0.1 / generating≈0.5(indeterminate) / ready=1。 */
  progress: number;
  /** 冷却到期时间戳（ms，Date.now() 口径）；非冷却态为 null。供 UI 显「冷却中 Nm」倒计时。 */
  cooldownUntil: number | null;
  /** 是否处于熔断态（与 state==='circuit-broken' 同步，单列布尔便于 UI 条件判断）。 */
  circuitBroken: boolean;
  /** 最近一次错误简述（生成失败/中止原因），供 UI 提示；正常态为 undefined。 */
  lastError?: string;
}

export const EMPTY_BPC_UI_STATE: Readonly<BpcUiState> = Object.freeze({
  state: 'idle',
  progress: 0,
  cooldownUntil: null,
  circuitBroken: false,
  lastError: undefined,
});

interface BpcSliceState {
  byConversationId: Record<string, BpcUiState>;
}

const initialState: BpcSliceState = {
  byConversationId: {},
};

function createBpcUiState(): BpcUiState {
  return { ...EMPTY_BPC_UI_STATE };
}

function stateForConversation(state: BpcSliceState, conversationId: string): BpcUiState {
  if (!conversationId) throw new Error('BPC UI state requires conversationId');
  if (!state.byConversationId[conversationId]) {
    state.byConversationId[conversationId] = createBpcUiState();
  }
  return state.byConversationId[conversationId];
}

export const bpcSlice = createSlice({
  name: 'bpc',
  initialState,
  reducers: {
    /**
     * 设置调度状态（scheduler 状态机迁移时调）。可选携带 progress / cooldownUntil / lastError。
     * - circuitBroken 与 state==='circuit-broken' 保持同步（进熔断置 true，离开熔断态置 false）。
     * - 进 idle 顺手清 lastError（成功收尾不残留旧错误）。
     */
    setBpcUiState(
      state,
      action: PayloadAction<{
        conversationId: string;
        state: BpcUiStateEnum;
        progress?: number;
        cooldownUntil?: number | null;
        lastError?: string;
      }>,
    ) {
      const p = action.payload;
      const target = stateForConversation(state, p.conversationId);
      target.state = p.state;
      if (typeof p.progress === 'number' && Number.isFinite(p.progress)) {
        target.progress = p.progress;
      }
      // cooldownUntil：显式传（含 null）才覆盖；不传则维持。
      if ('cooldownUntil' in p) target.cooldownUntil = p.cooldownUntil ?? null;
      target.circuitBroken = p.state === 'circuit-broken';
      if ('lastError' in p) {
        target.lastError = p.lastError;
      } else if (p.state === 'idle' || p.state === 'ready') {
        target.lastError = undefined;
      }
    },
    /** 仅更新进度（generating 阶段脉冲/indeterminate 用）。 */
    setBpcProgress(state, action: PayloadAction<{ conversationId: string; progress: number }>) {
      const { conversationId, progress } = action.payload;
      if (typeof progress === 'number' && Number.isFinite(progress)) {
        stateForConversation(state, conversationId).progress = progress;
      }
    },
    /** 重置回 idle 空态（scheduler discardCurrent / 对话切换 / restart 收尾用）。 */
    resetBpcUi(state, action: PayloadAction<string>) {
      if (!action.payload) return;
      state.byConversationId[action.payload] = createBpcUiState();
    },
    renameBpcConversation(state, action: PayloadAction<{ fromId: string; toId: string }>) {
      const { fromId, toId } = action.payload;
      if (!fromId || !toId || fromId === toId) return;
      const source = state.byConversationId[fromId];
      if (!source) return;
      state.byConversationId[toId] = source;
      delete state.byConversationId[fromId];
    },
  },
});

export const { setBpcUiState, setBpcProgress, resetBpcUi, renameBpcConversation } = bpcSlice.actions;

export const selectBpcUiState = (
  state: { bpc: BpcSliceState },
  conversationId: string,
): BpcUiState => state.bpc.byConversationId[conversationId] ?? EMPTY_BPC_UI_STATE;
