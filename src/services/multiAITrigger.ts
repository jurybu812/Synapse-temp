/**
 * Synapse Multi-AI 对话触发器（M3-2b）
 *
 * 职责：让用户在对话输入框用 `@MultiAI:模式名 <任务描述>` 显式触发一条【固定工作流】，
 *   走 agentOrchestrator.runWorkflow 而非普通 agentLoop.run。本模块只负责：
 *     1. 触发语法解析（parseMultiAITrigger）；
 *     2. 按名匹配【有 workflow 的】mode（resolveWorkflowMode）；
 *     3. 跑工作流并把 WorkflowResult 汇总成一条结构化 assistant 文本（formatWorkflowResult）；
 *     4. 串起 1~3 的入口（runMultiAITrigger），供 AgentPanel.handleSend 调用。
 *
 * ★ 触发语法（明确单一语法，不接受 `@模式名` 裸写以免与普通文本里的 @ 冲突）：
 *     `@MultiAI:模式名 任务描述`
 *   - 前缀 `@MultiAI:`【大小写不敏感】（@multiai:/@MULTIAI: 均可），紧跟模式名（到第一个空白/换行结束）。
 *   - 模式名后的剩余文本（去首尾空白）作为工作流的 userInput；省略时回退用整条原始输入兜底（见 runMultiAITrigger）。
 *   - 模式名匹配 state.multiAI.modes：先按 name 不区分大小写精确匹配，再按 id 匹配（容错用户填 id）。
 *
 * 设计取舍：
 *   - 不改 agentLoop / runWorkflow（M3-2a 既有实现），只在发送链路前面分流。无 @MultiAI 前缀 → 调用方照常走 agentLoop.run。
 *   - 匹配失败（无此模式 / 该模式无 workflow）→ 返回 error 结果（调用方走 notification 友好提示），绝不静默吞或误跑普通对话。
 *   - 结果先用结构化文本消息展示；卡片可视化留 M3-3（见 formatWorkflowResult 内 TODO）。
 */

import { store } from '@/store';
import { agentOrchestrator, type WorkflowResult } from './agentOrchestrator';
import type { MultiAIMode } from '@/store/slices/multiAI';

/** `@MultiAI:` 前缀（大小写不敏感匹配；展示/文档统一用此规范写法）。 */
export const MULTI_AI_TRIGGER_PREFIX = '@MultiAI:';

/** 解析结果：命中触发语法时返回模式名 + 任务描述；未命中返回 null（调用方据此判定走不走普通对话）。 */
export interface MultiAITriggerParse {
  /** 用户填写的模式名（原样，未做大小写归一；匹配在 resolveWorkflowMode 内做）。 */
  modeName: string;
  /** 模式名之后的任务描述（已去首尾空白；可能为空字符串）。 */
  taskInput: string;
}

/**
 * 解析 `@MultiAI:模式名 任务描述`。
 * - 仅当【整条输入去首空白后】以 `@MultiAI:`（大小写不敏感）开头才视为触发，避免句中出现 @MultiAI: 误触。
 * - 模式名取前缀后到第一个空白/换行之前的连续非空白串；其后为任务描述。
 * - 未命中返回 null。
 */
export function parseMultiAITrigger(rawInput: string): MultiAITriggerParse | null {
  const input = rawInput.replace(/^\s+/, ''); // 去前导空白（用户可能不小心打了空格），但只在开头判定前缀
  const prefixLen = MULTI_AI_TRIGGER_PREFIX.length;
  if (input.slice(0, prefixLen).toLowerCase() !== MULTI_AI_TRIGGER_PREFIX.toLowerCase()) {
    return null;
  }
  const rest = input.slice(prefixLen);
  // 模式名 = 到第一个空白/换行前的连续非空白；其后（含该空白）去首尾空白即任务描述。
  const match = rest.match(/^(\S+)([\s\S]*)$/);
  if (!match) {
    // `@MultiAI:` 后面什么都没有 → 模式名为空，交由 resolveWorkflowMode 报「未指定模式名」。
    return { modeName: '', taskInput: '' };
  }
  return {
    modeName: match[1],
    taskInput: (match[2] ?? '').trim(),
  };
}

/** 模式匹配结果。ok=true 时 mode 可直接跑工作流；ok=false 时 error 为面向用户的失败说明。 */
export type ResolveModeResult =
  | { ok: true; mode: MultiAIMode }
  | { ok: false; error: string };

/**
 * 按名在 state.multiAI.modes 找【有 workflow 的】mode。
 * 匹配优先级：name 不区分大小写精确 > id 精确（容错用户填 id）。
 * 失败分两类（都不静默）：
 *   - 找不到任何同名/同 id 的 mode → 「未找到模式」。
 *   - 找到但该 mode 没有 workflow（是旧 subagents[] 语义的普通模式）→ 「该模式不是固定工作流」。
 */
export function resolveWorkflowMode(modeName: string): ResolveModeResult {
  const name = modeName.trim();
  if (!name) {
    return { ok: false, error: '未指定模式名。用法：@MultiAI:模式名 任务描述' };
  }
  const state = store.getState() as any;
  const modes: MultiAIMode[] = state?.multiAI?.modes ?? [];
  const lower = name.toLowerCase();
  // M6 收尾 C2/LOW-2：优先级反转为 id → name。原因：富文本 atomic token 的 plainText 占位用 mode.id
  // （英文 slug，无空格），所以 id 命中是主路径；name 匹配仅兼容【用户手打 `@MultiAI:模式名 ...`】的旧语法。
  const matched =
    modes.find(m => m.id === name) ??
    modes.find(m => m.name.toLowerCase() === lower);

  if (!matched) {
    const workflowModeNames = modes
      .filter(m => Array.isArray(m.workflow) && m.workflow.length > 0)
      .map(m => m.name);
    const hint = workflowModeNames.length
      ? `可用的工作流模式：${workflowModeNames.join('、')}`
      : '当前没有任何配置了固定工作流的模式。';
    return { ok: false, error: `未找到名为「${name}」的模式。${hint}` };
  }
  if (!Array.isArray(matched.workflow) || matched.workflow.length === 0) {
    return {
      ok: false,
      error: `模式「${matched.name}」不是固定工作流（未配置 workflow 节点），无法通过 @MultiAI 触发。请选择带工作流的模式，或在普通对话中使用该模式。`,
    };
  }
  return { ok: true, mode: matched };
}

/** 单条子代理结果在汇总文本里的摘要长度上限（防超长 report 把汇总消息撑爆）。 */
const REPORT_SUMMARY_MAX = 800;

function truncateReport(report: string): string {
  const r = report ?? '';
  return r.length > REPORT_SUMMARY_MAX ? `${r.slice(0, REPORT_SUMMARY_MAX)}…（已截断）` : r;
}

/**
 * 把 WorkflowResult 格式化成一条结构化 assistant 文本消息。
 * - 每个节点：标题（节点 id + 类型）+ 各子代理 role/状态/report 摘要；condition 节点显示判断语义 + 通过与否。
 * - aborted：开头醒目标注「无法推进: abortReason」。
 *
 * TODO(M3-3)：本轮用结构化文本展示；M3-3 会用工作流卡片（节点四色 + 子代理树 + 点进查看子对话）替代/增强本文本。
 */
export function formatWorkflowResult(result: WorkflowResult): string {
  const lines: string[] = [];
  const header = result.status === 'aborted'
    ? `### ⚠️ 工作流「${result.modeName}」无法推进`
    : `### ✅ 工作流「${result.modeName}」执行完成`;
  lines.push(header);

  if (result.status === 'aborted' && result.abortReason) {
    lines.push('');
    lines.push(`> ${result.abortReason}`);
  }

  for (const nr of result.nodeResults) {
    lines.push('');
    if (nr.type === 'condition') {
      const passed = nr.condition?.passed;
      const verdict = passed === false
        ? (nr.skipped ? '判定为否（已跳过，继续后续节点）' : '判定为否（中止工作流）')
        : '判定为通过';
      lines.push(`#### 🔀 判断节点「${nr.nodeId}」`);
      if (nr.condition?.expr) lines.push(`- 判断语义：${nr.condition.expr}`);
      lines.push(`- 结果：${verdict}`);
      continue;
    }

    const typeLabel = nr.type === 'parallel' ? '并行节点' : '串行节点';
    lines.push(`#### 🧩 ${typeLabel}「${nr.nodeId}」`);
    for (const r of nr.results) {
      const statusIcon = r.status === 'error' ? '🔴' : '⚪';
      lines.push('');
      lines.push(`**${statusIcon} ${r.role}**（${r.status === 'error' ? '执行失败' : '完成'}，${r.toolCallsUsed} 次工具调用，${(r.duration / 1000).toFixed(1)}s）`);
      lines.push('');
      lines.push(truncateReport(r.report));
    }
  }

  return lines.join('\n');
}

/** runMultiAITrigger 的返回：调用方据此决定是否插消息 / 报错 / 回退普通对话。 */
export type MultiAITriggerOutcome =
  | { kind: 'not-trigger' }                 // 不是 @MultiAI 触发，调用方照常走普通 agentLoop.run
  | { kind: 'error'; message: string }      // 触发了但匹配失败，调用方应 notification 友好提示（不跑工作流、不发普通对话）
  | { kind: 'ran'; assistantText: string; runId: string }; // 工作流已跑完，assistantText 为汇总文本，runId 关联卡片

/**
 * ★ M3-3a 运行选项：
 *   - runId：调用方预生成的稳定运行实例 id。在【调用 runMultiAITrigger 之前】先 startWorkflowRun（或先插占位消息拿到 id）
 *     即可让卡片在工作流刚启动时就出现并实时刷新，而非等整个工作流跑完。
 *   - triggerMessageId：关联对话里触发它的那条消息（供 WorkflowCard 渲染锚点）。
 */
export interface MultiAITriggerOptions {
  runId?: string;
  triggerMessageId?: string;
}

/** ★ M3-3a：生成稳定 runId（供调用方在跑前预生成、关联占位消息 + 卡片实时显示）。 */
export function generateWorkflowRunId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 入口：解析 → 匹配 → 跑工作流 → 返回汇总文本。
 * 注意：本函数【不】直接 dispatch 对话消息——user 消息的插入、assistant 消息的插入由调用方（AgentPanel）负责，
 *   以复用其消息 id 生成 / 落库 / 滚动等既有逻辑，且保证「用户消息照常显示」与既有发送链路一致。
 *
 * ★ M3-3a：传 options.runId 时，runWorkflow 用该 id 建运行实例（卡片数据源），返回里带回同一 runId，
 *   调用方据此把汇总 assistant 消息标记 workflowRunId，让 MessageBubble 渲染实时四色卡片。
 *
 * @param rawInput 用户原始输入（含 @MultiAI: 前缀）。
 * @param options ★ M3-3a 运行选项（runId / triggerMessageId）。
 */
export async function runMultiAITrigger(
  rawInput: string,
  options?: MultiAITriggerOptions,
): Promise<MultiAITriggerOutcome> {
  const parsed = parseMultiAITrigger(rawInput);
  if (!parsed) return { kind: 'not-trigger' };

  const resolved = resolveWorkflowMode(parsed.modeName);
  if (!resolved.ok) return { kind: 'error', message: resolved.error };

  // 任务描述：优先用模式名后的文本；为空则兜底用整条原始输入（去掉前缀+模式名后仍空时，让工作流至少拿到用户原话）。
  const userInput = parsed.taskInput || rawInput.trim();
  const runId = options?.runId || generateWorkflowRunId();
  const result = await agentOrchestrator.runWorkflow(resolved.mode, userInput, {
    runId,
    triggerMessageId: options?.triggerMessageId,
  });
  return { kind: 'ran', assistantText: formatWorkflowResult(result), runId };
}
