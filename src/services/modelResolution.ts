/**
 * Model Resolution
 * M4-5-S1：统一模型解析口径，避免散落多处 `||` 表达式口径不一致。
 *
 * 系统模型（systemModel）= 后台 LLM 任务（历史压缩摘要 recordGenerator、自动标题等）专用通路，
 * 与主对话模型（currentModel）解耦。铁律：systemModel 为空一律回退 currentModel。
 */

import type { RootState } from '../store';

/** 仅依赖 agentSettings 的最小形状，避免与完整 slice 类型强耦合（store getState() as any 调用方亦可用）。 */
interface AgentSettingsLike {
  systemModel?: string | null;
  currentModel?: string | null;
}

/**
 * 解析「系统模型」：systemModel 非空则用它，否则回退 currentModel；都空返回 ''。
 * 后台任务（record 压缩摘要 / 自动标题）统一调此函数，口径恒定。
 */
export function resolveSystemModel(state: { agentSettings?: AgentSettingsLike } | RootState): string {
  const agentSettings = (state as any)?.agentSettings as AgentSettingsLike | undefined;
  return (agentSettings?.systemModel || agentSettings?.currentModel || '') as string;
}
