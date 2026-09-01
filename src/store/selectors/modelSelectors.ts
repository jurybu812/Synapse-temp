/**
 * M4-1-S2：模型上下文窗口统一选择器（修问题2a）
 *
 * 此前三处各自读 contextWindow（StatusBar 硬编码模型名映射、AgentPanel 本地 ?? fallback、
 * agentLoop 本地三元 fallback），口径分散且 StatusBar 与真实 capabilities 脱节。
 * 这里收敛为单一真相源：当前模型的 capabilities.contextWindow，目录缺证据时使用明确标注的保守安全值。
 */
import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from '../index';
import type { AIModelOption } from '@/types/aiModel';
export const UNKNOWN_CONTEXT_SAFE_FALLBACK = 16_384;

/** 纯函数版：由已持有的 AIModelOption 解出上下文窗口，供已拿到 option 的组件复用。 */
export function getModelContextWindowForOption(option?: AIModelOption | null, override?: number): number {
  // 用户手动覆盖优先；其次只信目录字段；完全未知时按较小安全值处理，UI 同步标出 safe fallback。
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  return option?.capabilities?.contextWindow ?? option?.contextWindow ?? UNKNOWN_CONTEXT_SAFE_FALLBACK;
}

/**
 * 当前模型 option（agentSettings.availableModels 里 id === currentModel 的那个）。
 * 与 agentLoop / AgentPanel 同逻辑，集中一处；createSelector 缓存避免每次 render 重算 find。
 */
export const getCurrentModelOption = createSelector(
  [
    (state: RootState) => state.agentSettings.availableModels,
    (state: RootState) => state.agentSettings.currentModel,
  ],
  (availableModels, currentModel): AIModelOption | undefined =>
    availableModels.find((m) => m.id === currentModel),
);

/**
 * 当前模型的真实上下文窗口（token）。
 * fallback 链：capabilities.contextWindow ?? option.contextWindow ?? UNKNOWN_CONTEXT_SAFE_FALLBACK。
 */
export const getModelContextWindow = createSelector(
  [
    getCurrentModelOption,
    (state: RootState) => state.agentSettings.contextWindowOverrides,
    (state: RootState) => state.agentSettings.currentModel,
  ],
  (option, overrides, currentModel): number =>
    getModelContextWindowForOption(option, overrides?.[currentModel]),
);
