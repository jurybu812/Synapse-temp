/**
 * Agent Loop Engine
 * 多轮工具调用循环，默认单段 25 轮；用户可显式开启最多三段的自动续跑
 */

import { AIClient, type ChatMessage, type ToolCallRequest } from './aiClient';
import { normalizeToolCallArguments, parseToolCallArguments } from './toolCallArguments';
import { store, type RootState } from '../store';
import {
  addMessage, updateMessage, updateMessageMeta, appendAssistantStreamFrame,
  setMessageStreamState, setMessageReconnect, setStreaming, setCompacting,
  clearStreamingContent, setTitle, setTokenUsage, setProjectedTokenCount,
  addAssistantRun, addRunEvent, resetRunStreamEvents, addMessageDiff, addMessageArtifact, recordFileSnapshot, updateToolCallStatus, reconcileToolTaskStatus,
  appendTaskStep, beginTaskBoundary, endTaskBoundary, dequeueInterrupt, selectActiveConversation, selectConversationById,
  type AttachmentRef, type MessageContentPart, type StreamModeUsed, type QueuedMessage,
  type Message,
} from '../store/slices/conversation';
import { setConnectionStatus, type RecordLayeringConfig } from '../store/slices/agentSettings';
import { setProviderCredentialStatus } from '../store/slices/settings';
import { addNotification } from '../store/slices/notifications';
import { promptBuilder, renderOpenFilesSection, renderRuntimeContextSection, compressContext, COMPRESSION_THRESHOLD, estimateTokens, countConversationTokens } from './systemPrompt';
import {
  getRecord,
  appendBatch,
  getRecordSkeleton,
  extractSkeletonTitle,
  foldOldBatches,
  computeRenderLevels,
  prepareAppendCandidate,
  type PreparedRecordCandidate,
  type RecordBatch,
  type SynapseRecord,
} from './recordStore';
import { identifyRounds, floorStepToRoundStart, keepRecentRoundsStartStep } from './roundBoundary';
import { generateBatch, type RecordGenerationRuntime, type RecordSourceMessage } from './recordGenerator';
import { runSystemModelOnce } from './systemModelClient';
import { AUTOSAVE_ID, saveAutosaveSnapshot, renameConversation } from './conversationPersistence';
import { updateConversation } from '../store/slices/conversationHistory';
import { generateId } from './ids';
import { consumeTrackedFileChanges } from './fileChangeTracker';
import { consumeTrackedArtifacts } from './artifactTracker';
import { downgradeApiMessageImagesToText, restoreApiMessagesAttachments, chatContentToTextWithPlaceholder } from './attachmentRefs';
import { sanitizeMessagesForPersistence } from './attachmentRefs';
import { getModelContextWindow } from '../store/selectors/modelSelectors';
import { bpcScheduler } from './bpcScheduler';
import { createExecutionContext, type ExecutionContext, type ToolCallExecutionContext } from './executionContext';
import type { ToolTaskSnapshot } from '../platform';
import { executionRegistry } from './executionRegistry';
import { renderToolResultForModel, type ToolResult } from './toolResult';
import { resolveProviderModel } from './providerModelRuntime';
import { platform } from '@/platform';
import { queueDrainCoordinator, interruptContinuationFromBoundary, type InterruptContinuationTaskBoundary } from './queueDrainCoordinator';
import { captureExecutionWorkspaceSnapshot, releaseExecutionWorkspaceSnapshot } from './fileSystem';

/**
 * ★ M5-BPC-4：解析生效硬压缩阈值 = 本对话覆盖 ?? 全局 agentSettings.bpc.compactThreshold ?? COMPRESSION_THRESHOLD(0.9)。
 *   number override 一律 typeof + Number.isFinite 判定（绝不 x || fallback，防 0/NaN falsy 吞掉合法值），口径与
 *   bpcScheduler.effectiveBpcThreshold 一致。供 run() 下推 compressContext / overLimit truncate / BPC 边界判定。
 */
function resolveCompactThreshold(rootState: RootState, conversationId: string): number {
  const override = selectConversationById(rootState, conversationId).compactThresholdOverride;
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  const cfg = (rootState as any).agentSettings?.bpc?.compactThreshold;
  if (typeof cfg === 'number' && Number.isFinite(cfg)) return cfg;
  return COMPRESSION_THRESHOLD;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ToolExecutor {
  /**
   * @param contextId 当前执行上下文 id（worktree 按需 / M3 并行子代理隔离用）：
   *   透传给 toolRegistry.execute，由 worktree 相关工具据此定位「本上下文」的活动 worktree，避免并行串台。
   *   现阶段 = conversationId（含 AUTOSAVE_ID），M3 阶段 = agentId/subagentId。
   */
  (name: string, args: Record<string, any>, context: ToolCallExecutionContext & {
    signal?: AbortSignal;
    onTaskStarted?: (snapshot: ToolTaskSnapshot) => void | Promise<void>;
  }): Promise<ToolResult>;
}

const MAX_TOOL_ROUNDS = 25;
const MAX_AUTO_TOOL_SEGMENTS = 3;
const REPEATED_TOOL_ROUND_LIMIT = 3;
const HARD_COMPACT_TAIL_RATIOS = [0.16, 0.08, 0] as const;
const HARD_COMPACT_RETRY_DELAYS_MS = [250, 500] as const;

function resolveToolExecutionTime(result: ToolResult, fallbackStartedAt: number): number {
  if (result.status === 'cancelled' && result.error?.code === 'approval_denied') return 0;
  const structured = result.data?.structured;
  if (structured && typeof structured === 'object') {
    const executionTimeMs = Number((structured as { executionTimeMs?: unknown }).executionTimeMs);
    if (Number.isFinite(executionTimeMs) && executionTimeMs >= 0) return executionTimeMs;
  }
  return Math.max(0, Date.now() - fallbackStartedAt);
}

async function persistRuntimeConversationSnapshot(conversationId: string): Promise<void> {
  const conversation = selectConversationById(store.getState() as RootState, conversationId);
  const settings = (store.getState() as RootState).agentSettings;
  await saveAutosaveSnapshot({
    id: conversationId,
    title: conversation.title,
    messages: conversation.messages,
    model: conversation.model || settings.currentModel || '',
    mode: settings.mode,
    reasoningEffort: settings.reasoningEffort,
    assistantRuns: conversation.assistantRuns,
    fileSnapshots: conversation.fileSnapshots,
    pendingDiffs: conversation.pendingDiffs,
    workspacePath: conversation.workspacePath,
    goal: conversation.goal,
    bpcThresholdOverride: conversation.bpcThresholdOverride,
    compactThresholdOverride: conversation.compactThresholdOverride,
    taskBoundaries: conversation.taskBoundaries,
    taskHeadline: conversation.taskHeadline,
    timestamp: Date.now(),
  }, { runtimeOwned: true });
}

function interruptContinuationHeadline(continuation: InterruptContinuationTaskBoundary): string {
  const prior = continuation.previousHeadline?.trim() || '插队前任务';
  return `插队后继续：${prior}`;
}

function interruptContinuationSummary(continuation: InterruptContinuationTaskBoundary): string {
  const priorSummary = continuation.previousSummary?.trim();
  const suffix = priorSummary ? `原概述：${priorSummary}` : '后续工具、进度和收口写入这张 continuation 边界。';
  return `延续任务边界 ${continuation.previousBoundaryId}；用户插队消息已放在两张任务卡之间。${suffix}`;
}

type CompressionAppendResult = {
  recordMd: string | null;
  appended: boolean;
  totalSteps: number;
  totalRounds: number;
  outcome: 'appended' | 'no-new-segment' | 'failed';
};

/**
 * ★ M4-5-S3 工作区感知：<open_files> 注入的打开文件数上限（已决 20）。
 * 超出只列前 20，并标注「等 N 个」，避免几十个 tab 时 prompt 膨胀（M4-5 风险4）。
 */
const OPEN_FILES_LIMIT = 20;

/**
 * ★ M4-5 审查 medium#1：<open_files> 过滤的【非文件视图 tab type 黑名单】。
 * 这些 tab 不对应可读文件，filePath 要么为空（welcome/settings），要么是非文件协议/blob
 * （review='review://changes'、attachment=blob objectUrl）——一律不得注入 <open_files>，
 * 否则误导模型去读不存在/读不了的「文件」，attachment 的 objectUrl 还会随机漂移破坏 cache 前缀。
 */
const NON_FILE_TAB_TYPES = new Set<string>([
  'welcome', 'settings', 'workflow', 'review', 'showcase', 'unsupported', 'attachment',
]);

/** ★ M4-5-S4 自动标题：截断占位字符上限（首条消息立即可见的临时标题）。 */
const TITLE_PLACEHOLDER_CHARS = 30;
/** ★ M4-5-S4 自动标题：系统模型生成目标 ≤15 字，清洗时硬截留余量到此上限，防截断丢字（已决 ~20）。 */
const TITLE_HARD_CHARS = 20;
/** ★ M4-5-S4 自动标题：失败重试次数（已决 1 次）。 */
const TITLE_RETRY = 1;
/** ★ M4-5-S4 自动标题：重试间隔（毫秒，已决 ~800ms）。 */
const TITLE_RETRY_INTERVAL_MS = 800;
/** ★ M4-5-S4 自动标题：生成提示词（≤15 字、仅输出标题、无标点/引号/前缀）。 */
const TITLE_SYSTEM_PROMPT = '你是对话标题助手。只输出一个不超过 15 个汉字的中文短标题概括用户这轮提问的主题，不要任何标点、引号、书名号、前缀或解释，只输出标题本身。';

/**
 * ★ M4-5-S4：清洗系统模型生成的标题。
 * - trim；去掉外层成对引号 / 书名号 / 反引号；去掉「标题：」「Title:」类前缀；去换行只取首行；
 * - 硬截到 TITLE_HARD_CHARS（防超长）。清洗后为空返回 null（调用方据此走降级保留占位）。
 */
function sanitizeTitle(raw: string | null): string | null {
  if (!raw) return null;
  let t = raw.trim();
  if (!t) return null;
  // 只取首行（模型偶尔多吐解释行）
  t = t.split(/\r?\n/)[0].trim();
  // 去掉常见前缀（标题：/ 题目：/ Title:）
  t = t.replace(/^(标题|题目|title)\s*[:：]\s*/i, '').trim();
  // 去掉外层成对引号 / 书名号 / 反引号（可能嵌套，循环剥）
  let changed = true;
  while (changed && t.length >= 2) {
    changed = false;
    const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['「', '」'], ['『', '』'], ['《', '》'], ['`', '`'], ['"', '"'], ["'", "'"]];
    for (const [open, close] of pairs) {
      if (t.startsWith(open) && t.endsWith(close) && t.length > open.length + close.length) {
        t = t.slice(open.length, t.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  if (!t) return null;
  if (t.length > TITLE_HARD_CHARS) t = t.slice(0, TITLE_HARD_CHARS);
  return t || null;
}

/**
 * ★ M7-F1：从一段文本生成语义标题（≤15 字）。抽自自动标题 IIFE，让【自动标题（首条消息）】与
 *   【手动重新生成标题（ConversationList 按钮）】共用同一生成内核，行为一致。
 *   失败（系统模型未返回 / 全部重试失败）返回 null，调用方据此降级/提示。不做任何 dispatch（纯生成）。
 */
export async function generateTitleFromText(source: string, conversationId?: string): Promise<string | null> {
  const titleSource = (source ?? '').trim();
  if (!titleSource) return null;
  const prompt = `请为下面这轮用户提问拟一个不超过 15 个汉字的中文标题，只输出标题：\n\n${titleSource.slice(0, 2000)}`;
  let generated: string | null = null;
  for (let attempt = 0; attempt <= TITLE_RETRY; attempt++) {
    generated = sanitizeTitle(await runSystemModelOnce(prompt, {
      system: TITLE_SYSTEM_PROMPT,
      conversationId,
      runId: conversationId ? `title:${conversationId}` : undefined,
      ownerId: conversationId ? `system-title:${conversationId}` : 'system-title',
      requestKind: 'title',
    }));
    if (generated) break;
    if (attempt < TITLE_RETRY) await new Promise(r => setTimeout(r, TITLE_RETRY_INTERVAL_MS));
  }
  return generated;
}

/** ★ H6 消息小标题：目标 ≤12 字，清洗硬截留余量到此上限（比对话标题 20 更短，导航条窄）。 */
const SUBTITLE_HARD_CHARS = 14;
/** ★ H6 消息小标题：生成提示词（≤12 字、仅输出短标题、无标点/引号/前缀）。复用 sanitizeTitle 清洗内核。 */
const SUBTITLE_SYSTEM_PROMPT = '你是消息标题助手。只输出一个不超过 12 个汉字的中文短标题，概括用户这条消息的核心意图，不要任何标点、引号、书名号、前缀或解释，只输出标题本身。';

/**
 * ★ H6（M8 第七轮反馈）：从一条用户消息文本生成【语义小标题】（≤12 字），供「消息导航」浮层跳转定位。
 *   与 generateTitleFromText 同范式（runSystemModelOnce + sanitizeTitle 清洗 + 重试 1 次 + 失败降级 null），
 *   但口径更短（SUBTITLE_HARD_CHARS=14）。★铁律：失败返回 null，调用方据此放弃回写（保持「无标题=不进导航」）。
 *   纯生成，不做任何 dispatch。
 */
export async function generateSubtitleFromText(source: string, conversationId?: string): Promise<string | null> {
  const src = (source ?? '').trim();
  if (!src) return null;
  const prompt = `请为下面这条用户消息拟一个不超过 12 个汉字的中文短标题，只输出标题：\n\n${src.slice(0, 2000)}`;
  let generated: string | null = null;
  for (let attempt = 0; attempt <= TITLE_RETRY; attempt++) {
    // 复用 sanitizeTitle（trim / 去引号书名号 / 去前缀 / 取首行），再按更短的 SUBTITLE_HARD_CHARS 二次硬截。
    let t = sanitizeTitle(await runSystemModelOnce(prompt, {
      system: SUBTITLE_SYSTEM_PROMPT,
      conversationId,
      runId: conversationId ? `subtitle:${conversationId}` : undefined,
      ownerId: conversationId ? `system-subtitle:${conversationId}` : 'system-subtitle',
      requestKind: 'subtitle',
    }));
    if (t && t.length > SUBTITLE_HARD_CHARS) t = t.slice(0, SUBTITLE_HARD_CHARS);
    generated = t;
    if (generated) break;
    if (attempt < TITLE_RETRY) await new Promise(r => setTimeout(r, TITLE_RETRY_INTERVAL_MS));
  }
  return generated;
}

// ★ M4-2-S2：运行态 id 生成收敛到共享 services/ids.ts（crypto.randomUUID + 回退，保留 prefix），
//   治问题 2b(1) 弱熵同毫秒碰撞。原本地 generateId 已删，调用点签名不变（仍 generateId('run'/'evt'/...)）。

function getMessageText(message: any): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.contentParts)) {
    return message.contentParts
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part.text)
      .join('');
  }
  return '';
}

function toChatMessage(message: any): ChatMessage {
  let content: ChatMessage['content'] = Array.isArray(message.contentParts) && message.contentParts.length > 0
    ? message.contentParts
    : getMessageText(message);
  if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    const traces = message.toolCalls.slice(0, 12).map((toolCall: any) => {
      const args = String(toolCall.arguments ?? '').slice(0, 600);
      const result = String(toolCall.result ?? '').slice(0, 800);
      return [
        `- ${toolCall.name || '未知工具'}（${toolCall.status || 'unknown'}）`,
        args ? `  参数：${args}` : '',
        result ? `  结果：${result}` : '',
      ].filter(Boolean).join('\n');
    });
    if (message.toolCalls.length > 12) traces.push(`- 另有 ${message.toolCalls.length - 12} 次工具调用未展开`);
    const traceText = `【历史工具调用与结果】\n${traces.join('\n')}`;
    content = Array.isArray(content)
      ? [...content, { type: 'text', text: `\n\n${traceText}` } as any]
      : `${content}${content ? '\n\n' : ''}${traceText}`;
  }
  return { role: message.role, content } as ChatMessage;
}

function toRecordSourceMessage(message: any): RecordSourceMessage {
  const content = Array.isArray(message.contentParts) && message.contentParts.length > 0
    ? message.contentParts
    : getMessageText(message);
  const attachmentAnchors: NonNullable<RecordSourceMessage['attachmentAnchors']> = [];
  if (Array.isArray(content)) {
    content.forEach((part: any, ordinal: number) => {
      if (part?.type === 'image_url') {
        const sha256 = typeof part.sha256 === 'string' ? part.sha256 : undefined;
        attachmentAnchors.push({
          kind: 'image',
          ordinal,
          sha256,
          mime: typeof part.mime === 'string' ? part.mime : undefined,
          bytes: typeof part.size === 'number' ? part.size : undefined,
          name: typeof part.name === 'string' ? part.name : undefined,
          recoverable: Boolean(sha256),
        });
        return;
      }
      if (part?.type === 'file') {
        const sha256 = typeof part.file?.sha256 === 'string' ? part.file.sha256 : undefined;
        attachmentAnchors.push({
          kind: 'file',
          ordinal,
          sha256,
          mime: typeof part.file?.mimeType === 'string' ? part.file.mimeType : undefined,
          bytes: typeof part.file?.size === 'number' ? part.file.size : undefined,
          name: typeof part.file?.filename === 'string' ? part.file.filename : undefined,
          recoverable: Boolean(sha256),
        });
      }
    });
  }
  return {
    role: message.role,
    content: chatContentToTextWithPlaceholder(content),
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined,
    attachmentAnchors: attachmentAnchors.length > 0 ? attachmentAnchors : undefined,
    toolCalls: Array.isArray(message.toolCalls)
      ? message.toolCalls.map((toolCall: any) => ({
        name: toolCall.name,
        arguments: toolCall.arguments,
        result: toolCall.result,
        status: toolCall.status,
      }))
      : undefined,
  };
}

function chatContentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => part.text)
    .join('');
}

/**
 * M2-R4（问题2 多模态低估）→ M4-1（问题4 多模态严重高估治本）：
 * chatContentToText 只取文本 part，但图片/附件 part 会随请求体实际发送并占用 token，
 * 故对【非文本 part】单独折算 token 计入压缩触发判定，避免「带图/附件对话」组装量与触发判定失真。
 *
 * ★★ M4-1 核心口径修正（治本，根治问题4「新对话带图即触发上下文过长截断」）：
 *   传输字节数 ≠ token。旧实现把 base64 data URI 的【编码字符长度】当 token（`url.length * 0.25`）
 *   或把【原始字节数】当 token（`size / 3`），对图片高估约 11~1100 倍——3.9MB 图（base64≈520 万字符）
 *   被估成约 130 万 token，远超阈值 128000 * 0.9 = 115200，撑爆判定后误触发 truncate。
 *   真实情况：网关把图片按【视觉 token】计（与图片体积/base64 长度完全解耦），单图固定量级 85~1100 token。
 *
 * 修正后的口径：
 *   - image_url（data: 内联 / size 引用态 / 外链 http，三条分支统一）：一律走 imageVisionTokens(detail)，
 *     与 base64/字节体积彻底解耦——detail=low → 85，detail=high/auto/未指定 → 1100（OpenAI 视觉 token 量级）。
 *     单图无论多大固定约 1100 token，130 万 → 1100，约降 1100 倍，根治高估。
 *   - file：网关对 file 也是【解码后按内容算 token】，base64 传输长度不是真 token。
 *     故按 estimateFileContentTokens——有 base64 时先解出原始字节数（base64 长度 * 3/4），
 *     再按 FILE_TOKENS_PER_BYTE(0.3) 折算；仅 size 时 size * 0.3；都无走 FILE_ID_PLACEHOLDER_TOKENS。
 * 文本 part 不在此计（由 chatContentToText → countConversationTokens 统一计）。
 */
const IMAGE_TOKENS_LOW = 85;       // detail=low 视觉 token（OpenAI 量级，与图片体积无关）
const IMAGE_TOKENS_HIGH = 1100;    // detail=high/auto/未指定 视觉 token 上界近似（与图片体积无关）
const FILE_ID_PLACEHOLDER_TOKENS = 256; // 仅有 file_id（内容不可见）时的保守占位估值
/**
 * 文件内容 token / 原始字节系数：网关解码 base64 后按内容算 token，
 * 混合文本约 0.3 token/字节（英文真实约 0.25，取 0.3 保守上界，宁多勿少，方向与触发判定一致）。
 */
const FILE_TOKENS_PER_BYTE = 0.3;

/** 图片视觉 token：与 base64/字节体积完全解耦，仅由 detail 决定（low=85，high/auto/未指定=1100）。 */
function imageVisionTokens(detail?: string): number {
  return detail === 'low' ? IMAGE_TOKENS_LOW : IMAGE_TOKENS_HIGH;
}

/**
 * 文件内容 token 估算：网关解码后按内容算 token，传输 base64 长度不是真 token。
 *   - 有 base64（file_data/data，可能带 `data:...;base64,` 前缀）：剥头取 payload 长度 → 原始字节 ≈ 长度*3/4
 *     → token ≈ 原始字节 * FILE_TOKENS_PER_BYTE。零解码开销（只取长度不真解码）。
 *   - 仅 size（原始字节）：size * FILE_TOKENS_PER_BYTE。
 *   - 都无：FILE_ID_PLACEHOLDER_TOKENS 占位。
 */
function estimateFileContentTokens(data: string, size: number): number {
  if (data) {
    // 剥掉 `data:...;base64,` 头（与 attachmentRefs 的 comma 切法一致，但只取长度不解码，零开销）
    const commaIdx = data.indexOf(',');
    const b64Len = data.startsWith('data:') && commaIdx >= 0 ? data.length - commaIdx - 1 : data.length;
    const rawBytes = b64Len * 0.75; // base64 长度 * 3/4 ≈ 原始字节
    return Math.ceil(rawBytes * FILE_TOKENS_PER_BYTE);
  }
  if (size > 0) return Math.ceil(size * FILE_TOKENS_PER_BYTE);
  return FILE_ID_PLACEHOLDER_TOKENS;
}

function estimateNonTextPartsTokens(content: ChatMessage['content']): number {
  if (typeof content === 'string') return 0;
  let total = 0;
  for (const part of content as any[]) {
    if (!part || part.type === 'text') continue;
    if (part.type === 'image_url') {
      // 三条分支（data: 内联 / size 引用态 / 外链 http）统一走视觉固定值，与体积彻底解耦。
      total += imageVisionTokens(part.image_url?.detail);
    } else if (part.type === 'file') {
      const data: string = part.file?.file_data || part.file?.data || '';
      const size: number = typeof part.file?.size === 'number' ? part.file.size : 0;
      total += estimateFileContentTokens(data, size);
    }
  }
  return total;
}

function estimateRequestInputTokens(messages: ChatMessage[], toolsTokens: number): number {
  return toolsTokens
    + countConversationTokens(messages.map(message => ({
      role: message.role,
      content: chatContentToText(message.content),
    })))
    + messages.reduce((sum, message) => sum + estimateNonTextPartsTokens(message.content), 0);
}

/** 截断标记：超长单条被截断时插入，提示模型该消息内容已被裁剪。 */
const TRUNCATION_NOTICE = '\n\n[…内容过长，已截断以避免超出上下文窗口…]';

/**
 * M4-1-S4 护栏：truncate 时给文本侧的最小预算保底（token）。
 * 即便 fixedTokens 已逼近 threshold（budget 算出来 ≤ 0），也至少给当前消息留 1024 token 正文，
 * 宁可总量略超阈值也不发空消息（标准网关按真实 token 计、估算略超不影响）。
 */
const MIN_TEXT_BUDGET = 1024;

/**
 * ★ 性能：一次遍历同时算出「全量历史 token」与「去掉最后一条（当前消息）后的历史 token」。
 *   等价于分别调用 countConversationTokens(messages) 与 countConversationTokens(messages.slice(0,-1))，
 *   但只遍历一遍整个历史、且不产生 slice 数组拷贝。用于 run() 关键路径上同时喂 assembledTokens（压缩水位）
 *   与 historyOnlyTokens（compressContext 护栏）两个消费方。
 *
 *   口径严格复刻 systemPrompt.countConversationTokens：每条 +4 的消息格式开销、整体 +2。
 *   - full        = Σ_all(estimateTokens(content)+4) + 2
 *   - withoutLast = Σ_{除最后一条}(estimateTokens(content)+4) + 2  = full - (最后一条的 estimateTokens(content)+4)
 *   边界：空数组时二者皆 2（与 countConversationTokens([]) / countConversationTokens([].slice(0,-1)) 一致）；
 *        单元素时 withoutLast = 2（去掉唯一一条即空）。
 */
function countConversationTokensSplitLast(
  messages: Array<{ role: string; content: string }>,
): { full: number; withoutLast: number } {
  let full = 2;
  let lastContribution = 0;
  for (let i = 0; i < messages.length; i++) {
    const contribution = estimateTokens(messages[i].content) + 4;
    full += contribution;
    if (i === messages.length - 1) lastContribution = contribution;
  }
  // withoutLast = 全量减去最后一条的贡献；空数组时 lastContribution=0 → withoutLast=full=2，边界一致。
  return { full, withoutLast: full - lastContribution };
}

/**
 * M2-R4 问题4 修复：「少条超长」危险态（compressContext 返回 overLimitWithoutCompression=true）下，
 * 切片压缩无可压缩余量，直接全量发送会撑爆窗口。这里对发送体里【最长的文本 part】按比例截断，
 * 把组装总量压回 threshold 以下（尽力而为），避免请求被服务端拒绝或截断。
 *
 * 注意：只截断 text part，保留图片/附件 part 结构（它们体积无法靠裁字符缩小，且模型仍需感知其存在）；
 * 返回新的消息数组（不就地修改 requestHistory，避免污染 store / record 切片口径）。
 *
 * @param messages   待发送历史（apiHistory，含 string 或 ChatContentPart[] content）
 * @param fixedTokens systemPrompt + tools + 非文本 part 的固定占用（不可截断部分）
 * @param threshold  目标上限（token）；截断后总量尽量 ≤ 该值
 */
function truncateOverLongHistory(
  messages: ChatMessage[],
  fixedTokens: number,
  threshold: number,
): ChatMessage[] {
  // 当前文本侧总量
  const textTokensOf = (m: ChatMessage) => estimateTokens(chatContentToText(m.content));
  let textTotal = messages.reduce((s, m) => s + textTokensOf(m), 0);
  // M4-1-S4：budget 最小保底——即便 fixedTokens 逼近 threshold（budget ≤ 0），也至少给文本留 MIN_TEXT_BUDGET，
  // 保证再极端也不把当前消息正文截成空（宁可略超阈值也不发空消息）。
  const budget = Math.max(threshold - fixedTokens, MIN_TEXT_BUDGET);
  // 文本侧可用预算（给文本 part 的总额度）
  if (textTotal <= budget) return messages; // 固定占用已把超额吃掉，文本无需截断

  // M4-1-S4 当前消息保护：最后一条即本轮「当前消息」。若它自身文本 token < budget（不是超长的元凶），
  // 则绝不截它——只截更早的历史长文本。仅当当前消息自身就超 budget（单条巨型粘贴）时才允许截它（否则无法压回）。
  const currentIdx = messages.length - 1;
  const protectCurrent = currentIdx >= 0 && textTokensOf(messages[currentIdx]) < budget;

  // 找最长文本消息，按比例把它截到「让文本总量回到预算」所需的目标长度。
  // 一次只截最长的一条通常够用（少条超长场景往往是单条巨型粘贴）；循环兜底处理多条都很长的情况。
  const result = messages.map(m => ({ ...m })) as ChatMessage[];
  let truncatedAny = false;
  for (let guard = 0; guard < result.length && textTotal > budget; guard++) {
    // 选当前文本最长的一条（受保护的当前消息排除在候选外）
    let idx = -1;
    let maxTok = -1;
    for (let i = 0; i < result.length; i++) {
      if (protectCurrent && i === currentIdx) continue; // 保护当前消息：不参与截断选择
      const t = textTokensOf(result[i]);
      if (t > maxTok) { maxTok = t; idx = i; }
    }
    if (idx < 0 || maxTok <= 0) break;

    const overflow = textTotal - budget;            // 还需削减的 token
    const target = Math.max(0, maxTok - overflow);  // 该条文本截断后的目标 token
    // 目标 token → 目标字符数（按英文系数 0.25 反推，保守偏短，宁可多截一点不撑爆）
    const targetChars = Math.max(0, Math.floor(target / 0.25));

    const text = chatContentToText(result[idx].content);
    if (text.length <= targetChars) break; // 已无法再削（避免死循环）
    const kept = text.slice(0, targetChars) + TRUNCATION_NOTICE;

    // 写回：原为纯文本 → 直接替换；原为 parts → 只重建文本 part（合并为一个），保留非文本 part
    const orig = result[idx].content;
    if (typeof orig === 'string') {
      result[idx] = { ...result[idx], content: kept };
    } else {
      const nonText = (orig as any[]).filter(p => p?.type !== 'text');
      result[idx] = {
        ...result[idx],
        content: [{ type: 'text', text: kept } as any, ...nonText],
      };
    }
    truncatedAny = true;
    textTotal = result.reduce((s, m) => s + textTokensOf(m), 0);
  }

  if (truncatedAny) {
    console.warn(
      `[agentLoop] 少条超长历史已截断：固定占用 ${fixedTokens} tokens，目标阈值 ${Math.floor(threshold)} tokens。`,
    );
  }
  return result;
}

/** record 注入批拼接分隔符 */
const BATCH_JOIN = '\n\n---\n\n';

/**
 * ★ M4-5-S2 prompt cache 稳定化：稳定渲染头部全文批数（最老 N 批）。
 * 方案 B 固定规则：头 N 批全文 + 其余批一律骨架（带 record_read 可展开标注）。
 * 取 2（合理小值）：保住开头背景与早期关键决策，其余走骨架确定性渲染、cache 友好。
 *
 * ★ M4-5-S2 删死代码说明：原 buildRecordPrefix（按 contextWindow 预算动态骨架↔全文升降级）是
 *   prompt-cache 前缀漂移真因，已被 buildStableRecordPrefix 全量取代、无任何调用方，连同其独占的
 *   RECORD_HEAD_FULL / RECORD_TAIL_FULL / RECORD_BUDGET_RATIO 常量一并删除。record_read 工具的按需
 *   单批展开是独立路径（不经此函数），功能不回退。renderSkeletonBatch 仍由稳定版复用故保留。
 */
// ★ M5-RL：record 分层默认值（与 agentSettings.recordLayering 初值一致）。buildStableRecordPrefix 的
//   layering 参缺失 / 旧持久化无此字段时按此兜底，保证渲染不崩，且未配置时行为与改造前一致（headFull=2）。
const DEFAULT_LAYERING: RecordLayeringConfig = {
  headFull: 2, tailFull: 1, titleThreshold: 20, maxRatio: 0.4, foldThreshold: 30, foldBatchK: 10,
  // ★ #14 动态分级默认（默认开）：与 agentSettings.initialState / store/index.ts sanitize 三处同步。
  dynamicLevelEnabled: true, hitWeight: 0.6, distWeight: 0.2, hitBase: 0.4, fullThreshold: 0.6, summaryThreshold: 0.3, distFloor: 0.5,
};

/**
 * ★ M4-5-S2：压缩注入到 apiMessages[1] 的固定文案前缀（常量化，确保前缀字符串本身永不漂移）。
 * 与 buildStableRecordPrefix 的确定性渲染配合，让「record 批集合不变 → apiMessages[1].content 逐字不变」。
 */
const RECORD_INJECTION_PREFIX = '[对话历史摘要]\n\n';

/** 渲染一个被降级为骨架的批次：明确标注可用 record_read 展开全文。
 *  ★ R-L2：titleOnly=true 时进一步降级为【仅标题】骨架（extractSkeletonTitle 实时提 contentMd，约 1/3 量纲）。 */
function renderSkeletonBatch(batch: RecordBatch, titleOnly = false): string {
  const skeleton = titleOnly
    ? extractSkeletonTitle(batch.contentMd || '').trim()
    : (batch.skeleton || '').trim();
  const kind = titleOnly ? '标题' : '骨架';
  const header = `[批次${batch.index} ${kind}，可用 record_read(batchIndex=${batch.index}) 展开全文]`;
  return skeleton ? `${header}\n${skeleton}` : header;
}

/**
 * ★ #14 渲染形态枚举（统一三层优先级的中间表示）：
 *   'full' = 全文 contentMd；'summary' = 骨架（renderSkeletonBatch titleOnly=false）；'brief' = 仅标题（titleOnly=true）。
 *   静态位置分层、动态 renderLevel 升降级、R-L5 force 强制降级都先归约成这个枚举，再统一渲染，杜绝三处散落的渲染分支漂移。
 */
type RenderForm = 'full' | 'summary' | 'brief';

/** ★ #14：把渲染形态枚举落成字符串（单批）。 */
function renderForm(batch: RecordBatch, form: RenderForm): string {
  if (form === 'full') return batch.contentMd;
  return renderSkeletonBatch(batch, form === 'brief');
}

/**
 * ★ M4-5-S2 prompt cache 稳定化：record 注入前缀的【确定性渲染】版本（已落批确定性形态）。
 *
 * 真因（被本函数根治）：原 buildRecordPrefix 按 contextWindow 预算在【骨架 ↔ 全文】之间动态升降级
 *   （line 274-282 markFull 受 budget 约束），导致同一 record 在「窗口 / 批数」变化时渲染不同 →
 *   压缩注入拼到 apiMessages[1] 的前缀漂移 → prompt cache 失效。
 *
 * 修法 = 与窗口预算彻底解耦的固定规则（方案 B）：
 *   - 头 STABLE_HEAD_FULL 批（最老）全文：保住开头背景与早期关键决策。
 *   - 其余所有批一律骨架：渲染规则固定（renderSkeletonBatch，带 record_read 可展开标注，功能不回退）。
 *   - 完全不接受 contextWindow / 不跑 RECORD_BUDGET_RATIO / 不做任何动态升降级。
 *
 * 由此「record 批集合不变（contentMd / skeleton / index 不变）」时，本函数输出【逐字不变】——
 * apiMessages[1] 前缀稳定，是 cache 命中的前提（端点是否真命中由端点决定，见 Plan_5 openQuestion 5）。
 *
 * 边界（与 buildRecordPrefix 同口径，保确定性）：
 *   - 零批 → record.contentMd（旧单文档态兼容）。
 *   - 单批 → 该批全文。
 *
 * 服务对象：自动压缩（现有 ~90% 水位）与未来 /compact 手动压缩共用此稳定前缀。
 */
/**
 * ★ R-L4：从全量 batches 算出【注入视图批序列】——过滤 archived 原始批（已被 meta 元批代表，不进注入），
 *   保留 meta 元批，按【代表位置 stepStart 升序】重排（元批 index = 末批+1 排数组物理尾，但其 stepStart 最小、
 *   代表最老内容，必须排回头部才能走档1头全文而非被误当尾批渲全文）。getRecord/getBatch/record_read/UI 读全量。
 */
function injectionViewBatches(record: SynapseRecord): RecordBatch[] {
  return (record.batches ?? [])
    .filter(b => !b.archived)
    .sort((a, b) => (a.stepStart - b.stepStart) || (a.index - b.index));
}

/**
 * ★ R-L2/R-L4/R-L5/#14 共用渲染核心：三层优先级合成每批渲染形态后拼接注入前缀。
 *
 * 三层优先级（从低到高合成单批最终 RenderForm，杜绝散落分支漂移）：
 *   ① 静态位置基础档（R-L2，只依赖批序位 i 与总批数 N）：头 H 批/尾 T 批 → full；中段 → summary；
 *      中段批数 > titleThreshold 时最老一段 → brief。force=0 且无动态分级时与改造前逐字一致 → prompt cache 确定性。
 *   ② 动态分级升降级（#14，仅 dynamicLevelEnabled 且批有固化 renderLevel 时）：用批的 renderLevel【覆盖】基础档
 *      （full/summary/brief 三选一）。renderLevel 由 computeRenderLevels 在【压缩点】按「hit×距离」算好固化进批，
 *      渲染只【读取】不重算 → else 分支每轮前缀仍只依赖批集合（renderLevel 两次压缩间不变）→ prompt cache 不破（方案①）。
 *      ★ 关键：本层【绝不读 hit/距离/当前轮号】，只读已固化的 renderLevel 字段，逐轮变量被隔离在压缩点。
 *   ③ R-L5 force 强制降 brief（最高，token 硬闸危险态）：被 forceTitleOnlyCount 游标命中的批强制 brief，
 *      覆盖①②（保正确性优先于 cache）。force=0 时本层 no-op。
 *
 * forceTitleOnlyCount = R-L5 强制降级游标：从中段最老批起额外强制降 brief；极端时连尾/头也降。默认 0。
 * ★ forceTitleOnlyCount=0 且（dynamicLevelEnabled=false 或所有批无 renderLevel）时输出与改造前逐字一致。
 */
function renderRecordPrefix(
  record: SynapseRecord,
  layering: Partial<RecordLayeringConfig> | undefined,
  forceTitleOnlyCount: number,
): string {
  const cfg = { ...DEFAULT_LAYERING, ...(layering ?? {}) };
  const H = Math.max(0, Math.floor(cfg.headFull));
  const T = Math.max(0, Math.floor(cfg.tailFull));
  const dyn = cfg.dynamicLevelEnabled !== false; // 缺省视作开（默认开）

  const batches = injectionViewBatches(record);
  if (batches.length === 0) return record.contentMd ?? '';

  const N = batches.length;
  const force = Math.max(0, Math.floor(forceTitleOnlyCount));

  // —— 第①层：静态位置基础档（每批一个 RenderForm，仅依赖 i/N，cache 确定性）——
  //   单批 / N<=H+T：头尾全文区已覆盖全部 → 全 full。其余按 R-L2 三级位置分层。
  const baseForms: RenderForm[] = (() => {
    if (N === 1 || N <= H + T) return batches.map(() => 'full' as RenderForm);
    const midCount = N - H - T;
    const naturalTitleOnly = midCount > cfg.titleThreshold ? midCount - cfg.titleThreshold : 0;
    const titleOnlyEnd = H + Math.min(midCount, naturalTitleOnly);
    return batches.map((_b, i) => {
      if (i < H) return 'full';            // 头全文区
      if (i >= N - T) return 'full';       // 尾全文区
      return i < titleOnlyEnd ? 'brief' : 'summary'; // 中段：最老段 brief，其余 summary
    });
  })();

  // —— 第②层：动态分级 renderLevel 覆盖（仅开关开 + 批有固化档位时；否则保留基础档，向后兼容逐字一致）——
  const dynForms: RenderForm[] = baseForms.map((base, i) => {
    if (!dyn) return base;
    const lvl = batches[i].renderLevel;
    return (lvl === 'full' || lvl === 'summary' || lvl === 'brief') ? lvl : base;
  });

  // —— 第③层：R-L5 force 强制 brief（token 硬闸危险态，覆盖①②）。force=0 → no-op，dynForms 原样输出 ——
  let finalForms = dynForms;
  if (force > 0) {
    // force 命中顺序（与改造前 R-L5 一致）：先中段最老 → 尾批最老 → 头批最老（保正确性优先于 cache）。
    //   构造一个「按降级优先级排序的批下标列表」，取前 force 个强制降 brief。
    const midIdx: number[] = [];
    const tailIdx: number[] = [];
    const headIdx: number[] = [];
    for (let i = 0; i < N; i++) {
      if (i >= H && i < N - T) midIdx.push(i);      // 中段（i 升序 = 最老在前）
      else if (i >= N - T) tailIdx.push(i);          // 尾区（i 升序 = 最老尾批在前）
      else headIdx.push(i);                          // 头区（i 升序 = 最老在前）
    }
    const order = N === 1 || N <= H + T
      ? batches.map((_b, i) => i)                    // 边界态：从最老起降（与改造前 i<force 一致）
      : [...midIdx, ...tailIdx, ...headIdx];
    const forceSet = new Set(order.slice(0, Math.min(force, N)));
    finalForms = dynForms.map((f, i) => (forceSet.has(i) ? 'brief' : f));
  }

  return batches
    .map((b, i) => renderForm(b, finalForms[i]))
    .filter(Boolean)
    .join(BATCH_JOIN);
}

export function buildStableRecordPrefix(record: SynapseRecord, layering?: Partial<RecordLayeringConfig>): string {
  // ★ prompt cache 稳定路径：forceTitleOnlyCount=0，输出仅依赖批集合（含各批固化 renderLevel，两次压缩间不变）。
  return renderRecordPrefix(record, layering, 0);
}

type ReadyRecordScheduler = Pick<typeof bpcScheduler, 'hasReadySnapshot' | 'takeReadyPrefix'>;

export async function readRecordAfterReadyPublication(
  scheduler: ReadyRecordScheduler,
  conversationId: string,
  requestHistory: ReadonlyArray<{ role: string }>,
  readRecord: (id: string) => Promise<SynapseRecord | null>,
): Promise<SynapseRecord | null> {
  const publishReady = async (): Promise<boolean> => {
    if (!scheduler.hasReadySnapshot(conversationId)) return false;
    const currentStep = identifyRounds(requestHistory).totalSteps;
    return Boolean(await scheduler.takeReadyPrefix(conversationId, currentStep));
  };

  await publishReady();
  let record = await readRecord(conversationId);
  if (await publishReady()) record = await readRecord(conversationId);
  return record;
}

export function applyReadyRecordToActiveRequest(
  apiMessages: ChatMessage[],
  recordMd: string,
): ChatMessage[] {
  if (!recordMd || apiMessages.length === 0) return apiMessages;

  const roundStarts: number[] = [];
  let hasUserRound = false;
  let modelStepSinceUser = true;
  for (let index = 0; index < apiMessages.length; index += 1) {
    const role = apiMessages[index]?.role;
    if (role === 'tool') continue;
    if (role === 'user') {
      if (!hasUserRound || modelStepSinceUser) roundStarts.push(index);
      hasUserRound = true;
      modelStepSinceUser = false;
      continue;
    }
    if (hasUserRound) modelStepSinceUser = true;
  }

  const keepFromIndex = roundStarts[Math.max(0, roundStarts.length - 2)] ?? apiMessages.length;
  return [
    apiMessages[0],
    { role: 'system', content: `${RECORD_INJECTION_PREFIX}${recordMd}` },
    ...apiMessages.slice(keepFromIndex),
  ];
}

/**
 * ★ R-L5 token 硬闸（设计C）：组装 apiHistory 前的【危险态兜底】，防 record 注入前缀撑爆上下文窗口。
 *
 * ★★ 正常路径必须 no-op：estimateTokens(baseRecordMd) <= maxTokens 时【逐字返回 baseRecordMd】——
 *   不重渲、不引入任何 token/窗口依赖，保住 buildStableRecordPrefix 的 prompt cache 稳定性。
 *   只有超限（折叠没及时触发 / 单批超大等极端态）才触发降级，此时前缀会随窗口漂移、必然破 cache（可接受，仅危险态）。
 *
 * 降级策略：从中段骨架批最老侧起逐批强制降 titleOnly（forceTitleOnlyCount 游标递增），每降一批重估 token，
 *   直到 <= maxTokens；中段全 titleOnly 仍超则连尾/头也降（renderRecordPrefix 极端兜底）；全降满仍超则硬截断。
 *
 * ★ 纯函数：只读 record + 估算 token，不读 store/窗口（maxTokens 由调用方算好传入）。便于 fixture 直接驱动。
 */
function enforceRecordTokenCap(
  record: SynapseRecord,
  baseRecordMd: string,
  maxTokens: number,
  layering?: Partial<RecordLayeringConfig>,
): string {
  // ★ 正常路径 no-op（逐字返回，保 cache）。maxTokens 非正数视作「不限制」也 no-op。
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return baseRecordMd;
  if (estimateTokens(baseRecordMd) <= maxTokens) return baseRecordMd;

  // —— 危险态：逐批强制降 titleOnly ——
  const visibleCount = injectionViewBatches(record).length;
  if (visibleCount <= 1) {
    // 0/1 批：renderRecordPrefix 已对单批做 titleOnly 兜底；再不够只能硬截断。
    const once = renderRecordPrefix(record, layering, 1);
    if (estimateTokens(once) <= maxTokens) return once;
    return hardTruncateToTokens(once, maxTokens);
  }

  // force 上限 = 可见批总数（连头带尾全降光，renderRecordPrefix 极端兜底覆盖）。逐步递增找首个达标。
  let rendered = baseRecordMd;
  for (let force = 1; force <= visibleCount; force++) {
    rendered = renderRecordPrefix(record, layering, force);
    if (estimateTokens(rendered) <= maxTokens) return rendered;
  }
  // 全批 titleOnly 仍超 → 最后兜底硬截断（极端，几乎不触达）。
  return hardTruncateToTokens(rendered, maxTokens);
}

/**
 * ★ R-L5 最后兜底：按估算 token 硬截断文本（保留头部，尾部加省略标记）。仅在「全批 titleOnly 仍超窗」的极端态用。
 *   estimateTokens 是字符粗估（中文1.5/其他0.25），这里按 maxTokens 反推一个保守字符上限截断（留 5% 余量）。
 */
function hardTruncateToTokens(text: string, maxTokens: number): string {
  if (!text) return text;
  if (estimateTokens(text) <= maxTokens) return text;
  const marker = '\n\n…[record 注入前缀超窗，已硬截断]';
  // 保守反推：最坏全中文 1.5 token/char → 字符上限 ≈ maxTokens/1.5，再留 5% 余量给 marker。
  const charBudget = Math.max(0, Math.floor((maxTokens / 1.5) * 0.95));
  if (charBudget <= 0) return marker.trim();
  let cut = text.slice(0, charBudget);
  // 二分收敛：估算仍超则继续砍（估算非线性，单次反推可能不够）。
  while (cut.length > 0 && estimateTokens(cut + marker) > maxTokens) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return cut + marker;
}

/**
 * ★ #5/#12 修复：全局【正在运行】的 AgentLoop 登记表。
 * 背景：loop 工厂 useEffect 在 run 进行中若被重建（已知触发：settings.safety 变更），其 cleanup 故意不停
 *   运行中的旧 loop（保 #3「发消息无回复」修复），旧 loop 失联但仍在写同一对话 =「幽灵 run」；而 handleStop
 *   只 stop agentLoopRef.current（新 loop），停不到幽灵 → 表现为 #5 双流且中断不了 + #12 中止卡 UI。
 * 用途：① run() 期间登记本实例、finally/stop 注销 → handleStop 遍历本表 stop【全部】running loop（含幽灵），
 *       从根上杜绝「停不掉的并发 run」；② dev 下挂到 window.__SYNAPSE_AGENTLOOPS__ 供 CDP 数实例验证。
 */
export const runningAgentLoops = new Set<AgentLoop>();
if (typeof window !== 'undefined') {
  (window as any).__SYNAPSE_AGENTLOOPS__ = runningAgentLoops;
}

export class AgentLoop {
  private client: AIClient;
  private supportsTools: boolean;
  private pendingClient: { client: AIClient; supportsTools: boolean } | null = null;
  private tools: ToolDefinition[] = [];
  /**
   * ★ M4-7 审查修复（MCP 启停后 schema 快照滞后）：可选的「动态取数函数」。
   * 提供时，本 AgentLoop 在每次发请求前实时从它取最新工具 schema（而非用 registerTools 当时的静态快照）；
   * 这样 SettingsPanel 启停 MCP server（mcpBridge.refresh 改了 toolRegistry）后，无需重建 AgentLoop / 切模型，
   * 下一轮 send 即能反映工具增删——启动的 MCP 工具立刻进 schema 让 AI 主动调用；停止的工具同步移出快照，
   * AI 不再因旧快照尝试调用已注销工具而拿到 'Tool not found'。缺省（未提供）时回退用 this.tools 静态快照。
   */
  private toolsProvider: (() => ToolDefinition[]) | null = null;
  private toolExecutor: ToolExecutor | null = null;
  private running = false;
  private activeRunSettled: Promise<void> | null = null;
  private runningListeners = new Set<(running: boolean) => void>();
  /**
   * ★ #8 选A（fork 重绑）：本 run 当前写入的【对话桶 key = conversationId】，可变。
   * - run() 入口由 execContextId 初值赋入；run 体内所有对话私有写入（dispatch 的 conversationId、
   *   身份守卫、toolExecutor/consume* 的 contextId、byId[..] 读后写）一律用本字段，而非不可变的 execContextId。
   * - 未保存对话（AUTOSAVE_ID）生成中被切走 → 外部 fork 成真 id 后调用 rebindConversation(realId)，
   *   把【正在跑的本 run】后续写入重绑到新桶，避免 fork 后旧 run 继续写已废弃的 AUTOSAVE_ID 草稿桶。
   * - public：让外部 fork helper 能读 loop.runConvId 找到对应 run。子代理（this.contextId 非空）不 fork、不被 rebind。
   * - run 不在跑时为 null（finally 收尾置回 null）。
   */
  private executionContext: ExecutionContext | null = null;
  private readonly boundConversationId?: string;
  private readonly ownerId?: string;

  public get runConvId(): string | null {
    return this.executionContext
      ? executionRegistry.resolveConversationId(this.executionContext)
      : null;
  }
  /** ★ 公开只读运行态（P0 发不出消息根因修复）：供 AgentPanel 在 run 进行中守卫——
   *  ① aiClient useMemo 运行中返回缓存（不因 isStreaming 轮间假性归零而重建 client → 不触发本 loop 被 useEffect cleanup 中止）；
   *  ② agentLoop useEffect cleanup 仅 stop 空闲 loop，运行中的 loop 让它带发起时的 client 快照跑完（与 #2「设置变不打断当前流」一致）。 */
  get isRunning(): boolean { return this.running; }
  subscribeRunning(listener: (running: boolean) => void): () => void {
    this.runningListeners.add(listener);
    listener(this.running);
    return () => this.runningListeners.delete(listener);
  }

  private setRunning(value: boolean): void {
    if (this.running === value) return;
    this.running = value;
    for (const listener of this.runningListeners) {
      try { listener(value); } catch { /* 运行态观察者失败不影响 AgentLoop */ }
    }
  }
  /**
   * ★ 性能：toolsTokens 记忆化缓存（按 activeTools 数组【引用相等】命中）。
   *   背景：原先每次 run 在「插入 user 消息 → 发起 fetch」关键路径上同步执行
   *   `estimateTokens(JSON.stringify(activeTools))`——工具集 schema 可能数十 KB，JSON.stringify + 字符估算
   *   是主线程上一笔可观开销，且工具集在一次 run 内（乃至跨 run 未启停 MCP 时）通常不变，纯属重复劳动。
   *   缓存键用 activeTools 的【引用】：getActiveTools() 回退静态快照（this.tools）时引用稳定，跨 run 命中；
   *   toolsProvider 每次返回新引用时缓存自然失效、重算一次——不会比现状（每次必算）更差，是纯增益、零语义风险。
   *   ★ 安全性：只缓存「估算值」这一【纯展示/水位输入的数字】，不缓存 activeTools 本身、更不影响实际发送的
   *     工具集（streamChat 始终用 line ~723 当轮取的 activeTools）。引用变即失效，绝不会用过期工具集的 token 数。
   */
  private toolsTokensCache: { toolsRef: ToolDefinition[]; tokens: number } | null = null;
  /**
   * M2-5 / M3：本 AgentLoop 实例的【执行上下文 id】。
   * - 单 agent（主对话）：构造时不传 → 执行工具时回退当前对话 id（conversation.id ?? AUTOSAVE_ID），
   *   worktree 活动态随对话身份走，与「切换对话不串台」配套。
   * - M3 子代理：构造时传 subagentId → 每个子代理实例各自一个稳定 contextId，并行 enter_worktree 互不覆盖。
   */
  private readonly contextId?: string;
  /**
   * R5 压缩点专用中止器【集合】：每个在途的【record 压缩 LLM 生成】（generateBatch）登记一个独立 controller。
   * 与 this.client（主对话 client）相互独立——主对话靠 this.client.abort()，压缩靠这里。
   *
   * ★ R5 修复（并发/重入归属）：原先用单个实例字段 this.compressController 跨 run 共享，
   *   快速连发/编辑重试触发的第二次 run 会无条件覆盖它、且其 finally 置 null 会误清别人的 controller，
   *   导致 stop() abort 不到旧压缩、或把新压缩的 controller 误置空（双双失去 stop 能力）。
   *   现改为：controller 为【每次 run 的局部变量】，进入压缩分支时 add 到本集合、finally 只 delete 自己那个；
   *   stop() 遍历集合 abort 全部在途压缩并 clear。归属清晰、互不误伤。
   *   （叠加 run() 入口重入闸后，正常情况下集合至多 1 个；集合是「即便重入闸将来被绕过也不误伤」的双保险。）
   */
  private compressControllers = new Set<AbortController>();
  private toolControllers = new Set<AbortController>();

  constructor(client: AIClient, opts?: { contextId?: string; conversationId?: string; ownerId?: string; supportsTools?: boolean }) {
    this.client = client;
    this.supportsTools = opts?.supportsTools === true;
    this.contextId = opts?.contextId;
    this.boundConversationId = opts?.conversationId;
    this.ownerId = opts?.ownerId;
  }

  updateClient(client: AIClient, supportsTools: boolean): void {
    if (this.running) {
      this.pendingClient = { client, supportsTools };
      return;
    }
    if (this.client !== client) this.client.abort();
    this.client = client;
    this.supportsTools = supportsTools;
    this.pendingClient = null;
  }

  private async runHardCompaction(
    conversationId: string,
    requestHistory: ChatMessage[],
    opts: {
      workspaceName?: string;
      currentModel: string;
      modelContextWindow: number;
      compactThreshold: number;
      systemTokens: number;
      toolsTokens: number;
      recordTokenCap: number;
      recordLayering?: RecordLayeringConfig;
    },
  ): Promise<{ recordMd: string; apiHistory: ChatMessage[]; estimatedInputTokens: number; revision: number } | null> {
    const recordSourceHistory = selectConversationById(store.getState() as RootState, conversationId).messages
      .filter((message: any) => message.role !== 'tool')
      .map(toRecordSourceMessage);
    const outputLimit = Number((store.getState() as RootState).agentSettings?.maxTokens ?? 0);
    const outputReserve = Math.min(
      Number.isFinite(outputLimit) && outputLimit > 0 ? outputLimit : 8192,
      Math.max(8192, Math.floor(opts.modelContextWindow * 0.08)),
    );
    const safeInputBudget = Math.max(
      1,
      Math.min(
        Math.floor(opts.modelContextWindow * opts.compactThreshold),
        opts.modelContextWindow - outputReserve,
      ),
    );

    for (let attempt = 0; attempt < HARD_COMPACT_TAIL_RATIOS.length; attempt += 1) {
      const tailRatio = HARD_COMPACT_TAIL_RATIOS[attempt];
      const keepStartIdx = keepRecentRoundsStartStep(
        requestHistory,
        opts.modelContextWindow * tailRatio,
        message => estimateTokens(chatContentToText(message.content)) + 4,
        1,
      );
      const compressedSegment = recordSourceHistory.slice(0, keepStartIdx);
      const keepHistory = requestHistory.slice(keepStartIdx);
      if (compressedSegment.length === 0) return null;

      const result = await this.compactWithOutcome(conversationId, {
        compressedSegment,
        workspaceName: opts.workspaceName,
        currentModel: opts.currentModel,
        source: 'auto',
      });
      if (result.outcome !== 'failed') {
        const compactedRecord = await getRecord(conversationId);
        const baseRecordMd = compactedRecord
          ? buildStableRecordPrefix(compactedRecord, opts.recordLayering)
          : result.recordMd;
        const recordMd = compactedRecord && baseRecordMd
          ? enforceRecordTokenCap(compactedRecord, baseRecordMd, opts.recordTokenCap, opts.recordLayering)
          : baseRecordMd;
        if (recordMd) {
          const apiHistory = [
            { role: 'system', content: `${RECORD_INJECTION_PREFIX}${recordMd}` } as ChatMessage,
            ...keepHistory,
          ];
          const historyTokens = countConversationTokens(apiHistory.map(message => ({
            role: message.role,
            content: chatContentToText(message.content),
          })));
          const keepNonTextTokens = keepHistory.reduce(
            (sum, message) => sum + estimateNonTextPartsTokens(message.content),
            0,
          );
          const estimatedInputTokens = opts.systemTokens + opts.toolsTokens + historyTokens + keepNonTextTokens;
          if (estimatedInputTokens <= safeInputBudget) {
            return { recordMd, apiHistory, estimatedInputTokens, revision: compactedRecord?.revision ?? 0 };
          }
        }
      }

      const retryDelay = HARD_COMPACT_RETRY_DELAYS_MS[attempt];
      if (typeof retryDelay === 'number') {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    return null;
  }

  /**
   * 注册工具集与执行器。
   * @param tools     初始静态 schema 快照（兜底用；toolsProvider 提供时优先走动态取数）。
   * @param executor  工具执行器（toolRegistry.execute 透传）。
   * @param toolsProvider 可选动态取数函数（如 () => toolRegistry.getSchemas()）；提供时每次发请求实时取，
   *   使 MCP server 启停后工具增删立即对当前会话生效（无需重建 AgentLoop）。见字段注释。
   */
  registerTools(tools: ToolDefinition[], executor: ToolExecutor, toolsProvider?: () => ToolDefinition[]) {
    this.tools = tools;
    this.toolExecutor = executor;
    this.toolsProvider = toolsProvider ?? null;
  }

  /** 取当前生效的工具 schema：优先动态取数函数（实时反映 MCP 启停），否则回退静态快照。 */
  private getActiveTools(): ToolDefinition[] {
    if (this.toolsProvider) {
      try {
        const dyn = this.toolsProvider();
        if (Array.isArray(dyn)) return dyn;
      } catch {
        // 取数失败（极端情况）→ 回退静态快照，绝不让取 schema 异常打断主对话。
      }
    }
    return this.tools;
  }

  /**
   * ★ 性能：估算工具集 token，按 activeTools 数组【引用相等】记忆化。
   *   见 toolsTokensCache 字段注释——仅缓存「估算数字」，引用未变即复用，引用变了重算并刷新缓存。
   *   纯增益、零语义风险：不缓存工具集本身，不影响实际发送。
   */
  private estimateToolsTokens(activeTools: ToolDefinition[]): number {
    const cached = this.toolsTokensCache;
    if (cached && cached.toolsRef === activeTools) return cached.tokens;
    const tokens = estimateTokens(JSON.stringify(activeTools));
    this.toolsTokensCache = { toolsRef: activeTools, tokens };
    return tokens;
  }

  stop() {
    this.setRunning(false);
    this.client.abort();
    for (const controller of this.toolControllers) controller.abort();
    this.toolControllers.clear();
    // R5：中断【所有】正在进行的 record 压缩生成（若有），让 generateBatch 立即返回 null 走降级，
    // 而非傻等 60s timeout。遍历集合 abort 全部在途 controller 后整体 clear（已 abort 的不再复用）。
    for (const controller of this.compressControllers) controller.abort();
    this.compressControllers.clear();
    // ★ #5/#12 修复：从全局 running 表注销（handleStop 遍历的是本表副本，stop 内 delete 安全）。
    runningAgentLoops.delete(this);
  }

  /** ★ #8 选A：对话 fork 成真 id 时由外部调用，把本 run 后续写入重绑到新 conversationId（迁桶/迁worktree 由调用方一并做）。 */
  async rebindConversation(toId: string): Promise<void> {
    if (!toId || !this.executionContext || this.contextId) return;
    await executionRegistry.promoteConversation(this.executionContext.conversationId, toId);
  }

  async run(userMessage: string, opts?: {
    skipUserMessage?: boolean;
    contentParts?: MessageContentPart[];
    attachments?: AttachmentRef[];
    additionalUserMessages?: Array<{
      content: string;
      contentParts?: MessageContentPart[];
      attachments?: AttachmentRef[];
      richTokens?: import('@/services/inputCommands/richInput/types').ExtractedToken[];
    }>;
    continuationTaskBoundary?: InterruptContinuationTaskBoundary;
    onUserMessagesAccepted?: () => void;
    /**
     * ★ M6 收尾 D1：发送时 RichTextInput.extract() 产出的有序 atomic token，仅用于编辑历史消息时无损还原
     *   @ 高亮块，不进 LLM 上下文。挂在 userMsg.richTokens 上落库。
     */
    richTokens?: import('@/services/inputCommands/richInput/types').ExtractedToken[];
    /**
     * ★ M4-6-S4 @对话引用：本轮一次性注入的附加上下文（被引用历史对话的 record 摘要 / 最近 N 条原文，
     *   由 AgentPanel handleSend 组装）。经 promptBuilder.build 的 context.referencedContext 渲染成
     *   <referenced_conversation> 系统段——不进可见对话流、不重复落库。仅本轮生效（下轮无引用则自然消失）。
     */
    injectedContext?: string;
  }): Promise<void> {
    // Stop 会立刻把可见 running 状态放下，但旧 run 仍可能正从附件恢复、BPC 或 owner 激活的 await 返回。
    // 新 run 必须等旧 run 的 finally 完整释放后再进入，避免复用同一 AgentLoop/client 时旧回调越过 Stop，
    // 或旧 finally 把新 run 的 executionContext / running 状态清掉。
    if (this.activeRunSettled && !this.running) await this.activeRunSettled;
    if (!this.running && this.pendingClient) {
      const pending = this.pendingClient;
      this.updateClient(pending.client, pending.supportsTools);
    }
    // ★ R5 修复（重入闸，问题1/2 核心防线）：run() 已在跑时拒绝二次进入。
    // 背景：压缩窗口期（可达 60s 的 generateBatch）原先 isStreaming 仍为 false——它要进 while 循环才首次
    // dispatch(setStreaming(true))，而压缩分支在它之前。UI 的 handleSend/autosave 都以 isStreaming 为闸门，
    // 压缩期被当空闲，用户再点发送/编辑/重试会复用同一 AgentLoop 单例再次 run()，造成两路压缩对同一
    // conversationId 并发（appendBatch 非事务 read-modify-write 交错 → 丢批/脏写），且第二次 run 覆盖
    // this.running 与压缩 controller（旧压缩失去 stop 控制）。这里入口即挡住二次 run，从源头杜绝并发重入。
    if (this.running) {
      console.warn('[AgentLoop] run() 被拒绝：上一轮仍在进行（压缩/生成中），忽略本次重入请求。');
      store.dispatch(addNotification({
        type: 'info',
        title: '正在处理中',
        message: '上一条还在生成或压缩历史，请稍候再发送',
        duration: 2500,
      }));
      return;
    }
    let resolveRunSettled!: () => void;
    const runSettled = new Promise<void>(resolve => { resolveRunSettled = resolve; });
    this.activeRunSettled = runSettled;
    this.setRunning(true);
    // ★ #5/#12 修复：登记进全局 running 表，让 handleStop 能遍历 stop【全部】running loop（含失联的幽灵 loop）。
    runningAgentLoops.add(this);

    // ★ #8 byId 真并发：run 入口即快照本 run 的【执行上下文 id = 对话桶 key】，整个 run 生命周期复用。
    //   此 id 用作下方所有【对话私有状态】写入 dispatch 的 conversationId，把它们恒定路由到 byId[execContextId] 桶——
    //   用户切到别的对话后，本 run 后台仍写自己的桶、绝不串台到当前活跃桶（与 worktree 隔离根的 contextId 同口径统一）。
    //   口径 = this.contextId（子代理固定）|| 入口活跃对话 id || AUTOSAVE_ID（草稿桶键，与 conversation.ts bucketOf 回退一致）。
    //   ★ 声明在 try 外（原在 while 前）：因 finally 收尾 + 首条 addMessage / 自动标题 setTitle 等私有写入都要用它，
    //     必须早于 try 块作用域才能被 finally 看见（try 内声明的 const 在 finally 不可见）。
    const execContextId = this.contextId
      || this.boundConversationId
      || (selectActiveConversation(store.getState() as RootState).id as string | null)
      || AUTOSAVE_ID;
    // 执行上下文本身不可变；AUTOSAVE 提升后由 registry 的 owner alias 解析新 conversationId，
    // 不修改 AgentLoop 实例身份，也不会让下一条草稿继承本轮晚返回。
    this.executionContext = this.contextId
      ? createExecutionContext(execContextId, this.ownerId ?? `subagent:${this.contextId}`)
      : this.ownerId
        ? createExecutionContext(execContextId, this.ownerId)
        : createExecutionContext(execContextId, `legacy:${execContextId}`);
    const executionWorkspaceContextId = this.executionContext.ownerId;
    try {
    await executionRegistry.activateOwner(this.executionContext.ownerId, this.executionContext.runId);
    await captureExecutionWorkspaceSnapshot(executionWorkspaceContextId, this.executionContext.runId, this.runConvId!);
    if (!this.running) return;
    this.client.updateConfig({
      conversationId: this.runConvId!,
      runId: this.executionContext.runId,
      ownerId: this.executionContext.ownerId,
    });

    // ★ R5 修复（问题1）：进入即点亮 isStreaming，让 handleSend/autosave 的 isStreaming 闸门【覆盖整个压缩窗口】，
    // 不再留「压缩期 isStreaming=false 被当空闲」的重入缝隙。下方 while 循环每轮也会 dispatch(true)（幂等无害）。
    // ★ #8：带 execContextId 路由到本 run 的桶（原在 try 外不带桶键，现带 execContextId，行为等价且不串台）。
    store.dispatch(setStreaming({ value: true, conversationId: this.runConvId! }));

    const conversationReady = await bpcScheduler.ensureConversationReady(this.runConvId!);
    if (!this.running) return;
    if (!conversationReady) {
      store.dispatch(addNotification({
        type: 'warning',
        title: '这条对话仍处于保护性暂停',
        message: '上次硬压缩未能得到安全请求体，请先在压缩状态环中显式恢复，或执行 /compact 完成恢复',
        duration: 0,
      }));
      return;
    }
    // Stage 14: 确保 RULES 已加载
    const { extensionManager } = await import('./extensionManager');
    await extensionManager.loadRulesFromFS().catch(() => { });
    if (!this.running) return;
    const rootState = store.getState() as RootState;
    const state = selectConversationById(rootState, this.runConvId!);
    const currentModel = state.model || (rootState as any).agentSettings?.currentModel || '';
    const beginInterruptContinuationTaskBoundary = (
      continuation: InterruptContinuationTaskBoundary | undefined,
      anchorMessageId: string | undefined,
    ): string | null => {
      if (!continuation?.previousBoundaryId || !anchorMessageId) return null;
      if (!this.executionContext || !executionRegistry.isActiveRun(this.executionContext)) return null;
      const boundaryId = generateId('tb');
      store.dispatch(beginTaskBoundary({
        id: boundaryId,
        headline: interruptContinuationHeadline(continuation),
        summary: interruptContinuationSummary(continuation),
        anchorMessageId,
        continuationOfId: continuation.previousBoundaryId,
        continuationReason: 'interrupt',
        continuationIndex: continuation.continuationIndex,
        at: Date.now(),
        conversationId: this.runConvId!,
      }));
      return boundaryId;
    };
    const messages: ChatMessage[] = state.messages
      .filter((m: any) => m.role !== 'tool') // tool 结果消息用 agentLoop 内部管理
      .map(toChatMessage);

    const userMessagesForRun = opts?.skipUserMessage
      ? []
      : [
        {
          content: userMessage,
          contentParts: opts?.contentParts,
          attachments: opts?.attachments,
          richTokens: opts?.richTokens,
        },
        ...(opts?.additionalUserMessages ?? []),
      ];

    // Add user message(s). A drained queue is one human turn: keep each queued entry as an independent,
    // editable bubble while issuing only one subsequent model request for the whole batch.
    const acceptedUserMessageIds: string[] = [];
    let initialContinuationNotice: string | null = null;
    if (!opts?.skipUserMessage) {
      const acceptedAt = Date.now();
      for (const [index, pendingUserMessage] of userMessagesForRun.entries()) {
        const userMsg = {
          id: generateId(),
          role: 'user' as const,
          content: pendingUserMessage.content,
          contentParts: pendingUserMessage.contentParts,
          attachments: pendingUserMessage.attachments,
          richTokens: pendingUserMessage.richTokens,
          timestamp: acceptedAt + index,
          model: currentModel,
        };
        store.dispatch(addMessage({ message: userMsg, conversationId: this.runConvId! }));
        acceptedUserMessageIds.push(userMsg.id);

        const subtitleSource = pendingUserMessage.content.trim();
        if (subtitleSource) {
          const subtitleMsgId = userMsg.id;
          const subtitleExecutionContext = this.executionContext!;
          void (async () => {
            const generated = await generateSubtitleFromText(subtitleSource, execContextId);
            if (!generated) return;
            const targetConversationId = executionRegistry.resolveConversationId(subtitleExecutionContext);
            const live = selectConversationById(store.getState() as RootState, targetConversationId);
            const target = live.messages.find((message: any) => message.id === subtitleMsgId);
            if (!target || (target as any).subtitle) return;
            store.dispatch(updateMessageMeta({
              id: subtitleMsgId,
              changes: { subtitle: generated, subtitleGeneratedAt: Date.now() },
              conversationId: targetConversationId,
            }));
          })();
        }
      }
      opts?.onUserMessagesAccepted?.();
      const continuationBoundaryId = beginInterruptContinuationTaskBoundary(
        opts?.continuationTaskBoundary,
        acceptedUserMessageIds[acceptedUserMessageIds.length - 1],
      );
      if (continuationBoundaryId && opts?.continuationTaskBoundary) {
        initialContinuationNotice = `【用户插队续接】系统已在插队消息之后建立新的 continuation task_boundary：${continuationBoundaryId}，它延续 ${opts.continuationTaskBoundary.previousBoundaryId}。后续若继续工具工作，请直接调用 update_task_progress() 写入进度，完成时调用 end_task_boundary() 收口；不要为同一段续接重复 begin_task_boundary。`;
      }
    }
    // Build system prompt with mode context
    const workspaceName = (rootState as any).workspace?.name;
    const currentMode = (rootState as any).agentSettings?.mode || 'planning';
    const configuredSegmentRounds = Number((rootState as any).agentSettings?.maxToolRounds ?? MAX_TOOL_ROUNDS);
    const segmentRounds = Number.isFinite(configuredSegmentRounds)
      ? Math.max(3, Math.min(100, Math.round(configuredSegmentRounds)))
      : MAX_TOOL_ROUNDS;
    const autoContinueToolRounds = !!(rootState as any).agentSettings?.autoContinueToolRounds;
    const maxRounds = currentMode === 'fast'
      ? 3
      : segmentRounds * (autoContinueToolRounds ? MAX_AUTO_TOOL_SEGMENTS : 1);
    const userContentsForApi = userMessagesForRun.map(message => (
      message.contentParts?.length ? message.contentParts : message.content
    ));
    const promptInjection = (rootState as any).settings?.promptInjection;
    const toolsEnabled = (promptInjection?.injectTools ?? true) && this.supportsTools;

    // ★ M4-5-S3 工作区感知：从 editorTabs 读当前打开的【文件 tab】，过滤非文件视图后映射为 openFiles 概要。
    //   - 只取路径/名/类型，绝不读正文（正文走读文件工具按需取）。
    //   - 上限 OPEN_FILES_LIMIT(20)：超出只列前 20，追加一个「等 N 个」占位项（path/type 空，渲染时优雅省略）。
    //   ★ M4-5 审查 medium#1：过滤判据从「filePath 非空」收紧为「filePath 非空 且 type 不属于非文件视图」。
    //     根因：原假设「非文件视图 filePath 必为空」与代码现实不符——review tab 的 filePath='review://changes'、
    //     attachment tab 的 filePath=blob objectUrl，均非空，会绕过原过滤被当成「可读文件」注入 <open_files>，
    //     诱导模型调读文件工具去读不存在的 review:// 协议 / 读不了的 blob URL；且 objectUrl 每次打开都变，
    //     会让该段内容随机漂移、进一步破坏 cache 前缀稳定性。故按 type 黑名单一并排除这些非文件视图 tab。
    const editorTabs = (rootState as any).editorTabs;
    const activeTabId: string | null = editorTabs?.activeTabId ?? null;
    const allTabs: Array<{ id: string; filePath?: string; fileName?: string; type?: string }> = Array.isArray(editorTabs?.tabs) ? editorTabs.tabs : [];
    const fileTabs = allTabs.filter(t =>
      typeof t.filePath === 'string'
      && t.filePath.trim().length > 0
      && !NON_FILE_TAB_TYPES.has(t.type ?? ''),
    );
    const activeTab = activeTabId ? fileTabs.find(t => t.id === activeTabId) : undefined;
    const activeFilePath = activeTab?.filePath || undefined;
    const openFiles = fileTabs.slice(0, OPEN_FILES_LIMIT).map(t => ({
      path: t.filePath as string,
      name: t.fileName || (t.filePath as string),
      type: t.type || 'file',
    }));
    if (fileTabs.length > OPEN_FILES_LIMIT) {
      // 溢出占位项：name 承载「等 N 个」提示，path/type 留空（systemPrompt 渲染时省略方括号与第二行）。
      openFiles.push({ path: '', name: `…等 ${fileTabs.length - OPEN_FILES_LIMIT} 个文件未列出`, type: '' });
    }

    // ★ 反馈#8a 当前对话 ID 注入：每轮从 store 取 conversation.id 注入 system prompt，让 AI 引用本对话 /
    //   写记忆来源时无需先调工具探测。草稿态（id 为 null）回退 AUTOSAVE_ID 并标注「未持久化草稿」。
    //   conversationId 同一对话内恒定，进 system prompt 不引入对话内 cache 前缀漂移（cache 友好）。
    const rawConversationId = this.runConvId;
    const conversationId = rawConversationId || AUTOSAVE_ID;
    const conversationIsDraft = !rawConversationId;

    const systemPrompt = promptBuilder.build({
      workspaceName: workspaceName || undefined,
      mode: currentMode,
      promptInjection,
      // ★ 反馈#8a：当前对话 ID（草稿态走 AUTOSAVE_ID + draft 标注）。
      conversationId,
      conversationIsDraft,
      // ★ M4-6-S4 /goal：每轮读 conversation.goal 注入 <current_goal>，使设目标后 AI 每轮自动对齐。
      //   goal 为空/未设时 build 跳过该段（无副作用）。
      goal: state.goal || undefined,
      // ★ M4-6-S4 @对话引用：本轮一次性附加上下文 → <referenced_conversation> 段（不污染可见流）。
      //   含在 systemPrompt 内 → systemTokens 估算天然计入它（设计风险2：引用须计入 token 判定），
      //   引用过大时与压缩阈值正常联动，不会绕过判定。
      referencedContext: opts?.injectedContext || undefined,
    });

    // ★ M4-5 审查 medium#2：<open_files> 不再进 system prompt(apiMessages[0])，改注入 messages【最末尾】。
    //   渲染受 injectContext 控制（与原 systemPrompt 内部 gating 等价）。空串表示无可注入项。
    //   实际拼接到最后一条 user 消息见下方 apiMessages 组装后（restore 之后）。
    const injectOpenFiles = promptInjection?.injectContext ?? true;
    const openFilesSection = injectOpenFiles ? renderOpenFilesSection(
      openFiles.length > 0 ? openFiles : undefined,
      activeFilePath,
    ) : '';

    // Apply context compression before sending
    const requestHistory: ChatMessage[] = opts?.skipUserMessage
      ? messages
      : [...messages, ...userContentsForApi.map(content => ({ role: 'user' as const, content }))];

    // ★ M4-7 审查修复：本轮取一次「当前生效工具集」（优先动态取数函数 → 实时反映 MCP server 启停后的工具增删），
    //   token 估算与下方 streamChat 发送统一用这一份，保证同口径且 MCP 启停立即对当前会话生效（无需重建 AgentLoop）。
    const activeTools = this.getActiveTools();

    // 用当前模型真实 contextWindow + API 真实 token 数驱动压缩（回退写死上限/字符估算）。
    // M4-1-S3：统一走 getModelContextWindow 选择器（capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS），
    // 与 StatusBar / AgentPanel 同一真相源，消除本地三元 fallback 不一致。
    const modelContextWindow = this.client.contextWindow ?? getModelContextWindow(rootState);
    const buildRuntimeContextSection = (requestTimestamp: number) => renderRuntimeContextSection({
      systemTimeUtc: new Date(requestTimestamp).toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
      providerId: this.client.providerId,
      modelId: this.client.modelId,
      contextWindow: modelContextWindow,
      mode: currentMode,
      reasoningEffort: this.client.reasoningEffort,
      speedTier: this.client.speedTier,
      supportsVision: this.client.supportsVision,
      supportsTools: toolsEnabled && currentMode !== 'fast' && activeTools.length > 0,
    });
    const appendTailContext = (messagesForRequest: ChatMessage[], tailContext: string): ChatMessage[] => {
      if (!tailContext) return messagesForRequest;
      const nextMessages = [...messagesForRequest];
      for (let index = nextMessages.length - 1; index >= 0; index--) {
        const message = nextMessages[index];
        if (message.role !== 'user') continue;
        if (typeof message.content === 'string') {
          nextMessages[index] = { ...message, content: `${message.content}\n\n${tailContext}` };
        } else if (Array.isArray(message.content)) {
          nextMessages[index] = { ...message, content: [...message.content, { type: 'text', text: `\n\n${tailContext}` }] };
        }
        break;
      }
      return nextMessages;
    };
    const initialRuntimeContextSection = buildRuntimeContextSection(Date.now());
    const appendRuntimeContext = (messagesForRequest: ChatMessage[], runtimeContext: string): ChatMessage[] => [
      ...messagesForRequest,
      { role: 'user', content: runtimeContext },
    ];
    // M2-R4（90% 触发 B方案）：压缩触发判定基于「本轮实际将发送的组装请求体」本地 tokenize，
    // 而非上一轮 API 滞后 token。组装 = systemPrompt + tools schema + 全部历史原文（文本 + 图片/附件体积近似）。
    // tools 计入条件对齐实际发送处（line ~422：mode!=='fast' && toolsEnabled && tools.length>0）。
    // 多模态修复（问题2）：历史里非文本 part（图片/附件）会随请求体发送，文本侧 countConversationTokens
    // 计不到，这里用 estimateNonTextPartsTokens 单独累加计入 assembledTokens，避免带图/附件对话组装量偏小、压缩偏晚。
    const requestHistoryText = requestHistory.map(m => ({ role: m.role, content: chatContentToText(m.content) }));
    // ★ M4-5 审查 medium#2：<open_files> 已从 systemPrompt 挪到 messages 末尾，systemTokens 不再涵盖它；
    //   但它仍随请求体发送、占用输入 token，故单独把 openFilesSection 的 token 计入估算口径，保持组装量准确。
    const systemTokens = estimateTokens(systemPrompt)
      + estimateTokens(openFilesSection)
      + estimateTokens(initialRuntimeContextSection);
    // ★ 性能：toolsTokens 走引用记忆化缓存（见 toolsTokensCache 字段注释）——避免每次 run 在关键路径上
    //   对可能数十 KB 的工具集做 JSON.stringify + 字符估算。activeTools 引用未变即命中，变了重算一次。
    //   仅缓存「估算数字」，不影响实际发送的工具集（streamChat 始终用当轮取的 activeTools）。
    const toolsTokens = (toolsEnabled && currentMode !== 'fast' && activeTools.length > 0)
      ? this.estimateToolsTokens(activeTools)
      : 0;
    const nonTextTokens = requestHistory.reduce((sum, m) => sum + estimateNonTextPartsTokens(m.content), 0);
    // ★ 性能：合并「全量历史 token」与「去掉最后一条（当前消息）的历史 token」两次全历史遍历为单次。
    //   原先 line ~753 的 countConversationTokens(requestHistoryText) 与 line ~763 的
    //   countConversationTokens(requestHistoryText.slice(0,-1)) 各遍历一遍整个历史（后者还多一次 slice 数组拷贝）。
    //   下面逐条累加一次即同时得到二者——数值与原两次调用【逐字节等价】（countConversationTokens 定义：
    //   Σ(estimateTokens(content)+4) + 2；去尾即全量减去最后一条的 (estimateTokens+4)），仅去重了一遍 O(总长度) 遍历。
    const { withoutLast: historyOnlyTokens } = countConversationTokensSplitLast(requestHistoryText);
    // 先按已发布 Record + raw tail 投影本轮真实发送视图。store.messages 始终保留全量历史，不能直接拿它
    // 判断硬阈值或驱动 UI，否则 Record 已把请求压到安全范围后仍会短暂显示 100%+ 并误报“硬压缩已触发”。
    const bpcConversationId = this.runConvId!;
    const recordLayeringSnapshot = (store.getState() as RootState).agentSettings?.recordLayering;
    const recordTokenCap = modelContextWindow * (recordLayeringSnapshot?.maxRatio ?? DEFAULT_LAYERING.maxRatio);
    const existingRecord = await readRecordAfterReadyPublication(
      bpcScheduler,
      bpcConversationId,
      requestHistory,
      getRecord,
    );
    if (!this.running) return;
    let requestCompressionGeneration = String(existingRecord?.revision ?? 0);
    const buildRecordBackedHistory = (record: SynapseRecord): ChatMessage[] => {
      const roundsOfRequest = identifyRounds(requestHistory);
      let keepFromIdx = floorStepToRoundStart(roundsOfRequest, record.totalSteps);
      keepFromIdx = Math.max(0, Math.min(keepFromIdx, requestHistory.length - 1));
      const recordMdBase = buildStableRecordPrefix(record, recordLayeringSnapshot);
      const recordMd = enforceRecordTokenCap(record, recordMdBase, recordTokenCap, recordLayeringSnapshot);
      return recordMd
        ? [{ role: 'system', content: `${RECORD_INJECTION_PREFIX}${recordMd}` } as ChatMessage, ...requestHistory.slice(keepFromIdx)]
        : requestHistory;
    };
    const projectedHistory = existingRecord && existingRecord.totalSteps > 0
      ? buildRecordBackedHistory(existingRecord)
      : requestHistory;
    const projectedMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...projectedHistory,
    ];
    const projectedTokens = estimateRequestInputTokens(
      appendRuntimeContext(
        appendTailContext(projectedMessages, openFilesSection),
        initialRuntimeContextSection,
      ),
      toolsTokens,
    );
    // 上一轮 Provider prompt usage 只在没有 Record 投影时用作 tokenizer 偏差兜底。Record 已发布后请求体代次已经变化，
    // 沿用压缩前的旧 usage 会再次把安全请求误判为超限。
    const apiRealTokens = state.tokenUsage?.promptTokens || 0;
    const triggerTokens = existingRecord && existingRecord.totalSteps > 0
      ? projectedTokens
      : Math.max(projectedTokens, apiRealTokens);
    // M4-1-S4 护栏入参：除最后一条（本轮当前消息）外的历史文本 token，与 compressContext 内同口径
    // （countConversationTokens）。仅历史本身也接近阈值才标 overLimitWithoutCompression，避免误截当前消息。
    // ★ 性能：historyOnlyTokens 已与 assembledTokens 的全量历史 token 在上方 countConversationTokensSplitLast
    //   一次遍历中同时算出（原先是单独再 countConversationTokens(slice(0,-1)) 跑第二遍），数值逐字节等价。
    // ★ M5-BPC-4：硬压缩阈值可配（本对话覆盖 ?? 全局 bpc.compactThreshold ?? 0.9）。下推 compressContext 与
    //   下方 overLimit truncate 阈值，使「90% 硬阈值」成为用户可调项（BPC 设置面板 / 本对话覆盖）。
    const effectiveCompactThreshold = resolveCompactThreshold(rootState, this.runConvId!);
    const requestPressureRatio = modelContextWindow > 0 ? triggerTokens / modelContextWindow : 0;
    // A cold-loaded or restored long conversation may already be above the soft BPC threshold even
    // though no preceding Agent turn exists in this renderer to trigger the usual end-of-turn hook.
    // Start the snapshot here as fire-and-forget while the request is still below the hard gate, so
    // the main Provider/tool loop can proceed concurrently and the candidate can publish when idle.
    if (requestPressureRatio < effectiveCompactThreshold) {
      this.evaluateBpcWater(modelContextWindow, triggerTokens);
    }
    const { wasCompressed, overLimitWithoutCompression } = compressContext(
      requestHistoryText,
      modelContextWindow,
      triggerTokens,
      historyOnlyTokens,
      effectiveCompactThreshold,
    );

    // M2-R1: 压缩时优先用 record（多批次结构化摘要）作稳定前缀以命中 prompt cache；
    // 压缩点【追加一个新批次】（appendBatch，已有批次永不重写），注入前缀按渐进式读拼接
    //（末批全文 + 之前批次骨架）。无对话 id / 生成失败时回退到 compressContext 的字符截断。
    //
    // ★ R5 健壮性契约（可中止 + 回到压缩前一刻 + 崩溃恢复），务必维持：
    //   1. 可中止：本批 generateBatch 透传 compressController.signal；用户 stop() 时 abort →
    //      generateBatch 立即返回 null（不傻等 60s），落入下方「batchResult 为假」分支 → 不调 appendBatch。
    //   2. 回到压缩前一刻：generateBatch 失败/中止 → 不进 appendBatch → record 维持压缩前状态（旧批不动）。
    //      此时 recordMd 仍可能是【旧 record 的渐进式前缀】（非空，line ~391 已先算好），那是压缩前的合法快照，
    //      apiHistory 用它作摘要前缀；旧 record 都没有时 recordMd 为 null → 走 compressContext 字符截断回退。
    //      两条路都不丢 store.messages（apiHistory 只是「本轮发送给模型的视图」，不改动 store）。
    //   3. 崩溃恢复：appendBatch 落库是【原子 + 幂等】的——
    //      原子：Electron 走 record:upsert 单条 INSERT...ON CONFLICT DO UPDATE（better-sqlite3 单语句即单事务），
    //            Web 走 writeWebRecord 单次 localStorage.setItem 整对象写入；二者皆「要么整批写入、要么完全没写」。
    //      幂等：appendBatch 要求 stepStart == 末批 stepEnd 才追加（否则脏写拒绝、原样返回旧 record）。
    //      故「generateBatch 成功但 appendBatch 写库中途崩溃」时，要么这批没落库（重启后 getRecord 拿压缩前一致态，
    //      下次压缩从同一 priorSteps 重算本批，不重复不丢）、要么整批已落库（下次压缩 priorSteps 前移、续记下一批）。
    // ★ M5-BPC-4：后台预压缩（BPC）边界处理。
    //   ready 候选已在上方预算投影前发布并重新读取；这里仅处理撞硬阈值时的在途候选，防止同步硬压缩双写。
    //   本轮要走同步硬压缩（wasCompressed / overLimit / ratio 已达硬阈值）时丢掉在途 BPC，
    //      防「BPC 后台 appendBatch」与「硬压缩 appendBatch」对同一 record 双写竞争。discardCurrent 只丢内存快照，
    //      BPC 已落库的批是持久的——下方 compactNow 增量切片会从该批 stepEnd 续记，BPC 成果不浪费。
    {
      const hitHardThreshold = wasCompressed || overLimitWithoutCompression || requestPressureRatio >= effectiveCompactThreshold;
      if (hitHardThreshold && bpcScheduler.isBusy(bpcConversationId)) {
        await bpcScheduler.discardCurrent(bpcConversationId, '撞硬压缩阈值，转同步压缩（防双写）');
        if (!this.running) return;
      }
    }

    let apiHistory: ChatMessage[];
    if (wasCompressed) {
      const conversationId = this.runConvId!;
      const hardResult = await this.runHardCompaction(conversationId, requestHistory, {
        workspaceName: workspaceName || undefined,
        currentModel,
        modelContextWindow,
        compactThreshold: effectiveCompactThreshold,
        systemTokens,
        toolsTokens,
        recordTokenCap,
        recordLayering: recordLayeringSnapshot,
      });
      if (!this.running) return;
      if (!hardResult) {
        const reason = '硬压缩三次后仍未得到安全请求体，已停止本对话继续调用模型';
        await bpcScheduler.pauseForHardFailure(conversationId, reason);
        if (!this.running) return;
        store.dispatch(addNotification({
          type: 'error',
          title: '硬压缩已保护性暂停',
          message: '没有继续发送可能超出窗口的请求，请检查压缩状态后显式恢复或执行 /compact',
          duration: 0,
        }));
        return;
      }
      apiHistory = hardResult.apiHistory;
      requestCompressionGeneration = String(hardResult.revision);
      store.dispatch(addNotification({
        type: 'info',
        title: '上下文压缩',
        message: '历史已压缩为 record 摘要，并重新确认请求体低于安全预算',
        duration: 3000,
      }));
    } else if (overLimitWithoutCompression) {
      // M2-R4 问题4：少条超长危险态——无法切片压缩，对发送体最长文本 part 做截断保护，防撑爆窗口。
      // fixedTokens = systemPrompt + tools + 非文本 part（图片/附件，不可靠裁字符缩小）的固定占用。
      const fixedTokens = systemTokens + toolsTokens + nonTextTokens;
      const threshold = modelContextWindow * effectiveCompactThreshold; // ★ M5-BPC-4：硬阈值可配（同 compressContext）
      apiHistory = truncateOverLongHistory(requestHistory, fixedTokens, threshold);
      store.dispatch(addNotification({
        type: 'warning',
        title: '上下文超长',
        message: '单条消息过长且无法压缩，已截断部分内容以避免超出上下文窗口',
        duration: 4000,
      }));
    } else {
      // ★ M5-1 遗留 blocker：统一 record 注入口径（规范 §0.3 / §2）。
      //   只要 record 已有内容（totalSteps>0，无论是自动压缩还是 /compact 手动生成的），就【按
      //   record prefix + 保留轮原文】组装请求体，不再只在 wasCompressed（触达 0.9 水位）分支注入。
      //   效果：/compact 生成 record 后【下一轮请求体立即用摘要】（不必等触达 token 水位才生效），
      //   且自动压缩行为保持一致（wasCompressed 分支照旧生成新批 + 注入，本分支只在「未触发新压缩
      //   但已有 record」时复用已有摘要前缀）。
      //   ★ 不生成新批、不改 store、不删消息——纯组装本轮发送视图（store 全量永远不动，规范 §0.2）。
      if (existingRecord && existingRecord.totalSteps > 0) {
        apiHistory = buildRecordBackedHistory(existingRecord);
      } else {
        apiHistory = requestHistory;
      }
    }

    // Prepend system prompt to compressed messages
    let apiMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...apiHistory,
    ];

    // ★ M2-R6 发送前还原：历史 / 当前消息里的 image_url / file part 在 store / DB 中是 sha256 引用态（无 base64），
    // 这里按 sha256 调 platform.attachment.get 还原成真 dataUrl 再发给模型（模型需要真图）。
    // 只还原【实际要发送的这部分】（压缩后 apiHistory 里保留的最近原文）——开销最小，被摘要替代的历史图不白还原。
    // 还原后的真 base64 仅活在本次发送的 apiMessages（局部变量），绝不回写 store / DB。
    // 实体缺失则降级为文字占位（见 restoreApiMessagesAttachments），不阻断发送。失败吞掉走原 apiMessages。
    const restoreResult = this.client.supportsVision
      ? {
        ...await restoreApiMessagesAttachments(apiMessages)
          .catch(() => ({ messages: apiMessages, skippedInvalidImages: 0 })),
        downgradedImages: 0,
      }
      : { ...downgradeApiMessageImagesToText(apiMessages), skippedInvalidImages: 0 };
    if (!this.running) return;
    apiMessages = restoreResult.messages;
    if (restoreResult.downgradedImages > 0) {
      store.dispatch(addNotification({
        type: 'info',
        title: '历史图片已转为文字锚点',
        message: `当前模型不支持 Vision，本轮没有上传 ${restoreResult.downgradedImages} 张历史图片；原附件仍保留在对话中`,
        duration: 4000,
      }));
    }

    // ★ M4-5 审查 medium#2：把 <open_files> 注入到整个 messages 数组【最末尾的最后一条 user 消息】内，
    //   而非 system prompt(apiMessages[0]) 末尾。这样 system prompt + record 摘要(apiMessages[1]) + 旧历史
    //   构成的稳定大前缀不受切 tab 影响，prompt cache 严格前缀匹配得以命中（与 S2 record 稳定化收益叠加）。
    //   注入在 attachment 还原之后：仅追加一个文本 part / 文本片段，不触碰已还原的 image_url / file part。
    //   ★ 绝不原地 mutate：apiMessages 元素可能是 store message 对象的浅拷贝引用，直接改 .content 会污染 store。
    //     故定位到目标消息后【替换为新对象】，新 content 仅活在本次发送的局部 apiMessages。
    // runtime_context 不固化进 apiMessages：每次真正请求前以同一个 requestTimestamp 重新生成，
    // 并作为该请求最末尾、仅存在于 wire body 的受控 user 元数据消息追加。不能用尾部 system 消息：
    // OpenAI Codex 适配会把所有 system/developer 内容抽到请求顶部，工具循环后模型无法可靠把它识别为最新上下文。
    // 尾部 user envelope 兼容老式 chat 协议，又不会写入 store/Record/Fork。这样工具结果之后的新请求也能看到最新元数据，
    // 同一次 streamChat 的自动重试保持完全相同，工具循环的下一次请求则获得新的当前时间。
    apiMessages = appendTailContext(apiMessages, openFilesSection);
    if (initialContinuationNotice) {
      apiMessages.push({ role: 'system', content: initialContinuationNotice });
    }
    // ★ M2-S 任务1：发送前图片有效性预检剔除了无效图（损坏/非图片字节），提示用户——
    // 避免「历史里混进一张坏图 → 上游对整条请求整体 400 → 有效图与正常对话一起被拖垮」。
    if (restoreResult.skippedInvalidImages > 0) {
      store.dispatch(addNotification({
        type: 'warning',
        title: '已跳过无效图片',
        message: `${restoreResult.skippedInvalidImages} 张无效图片已跳过（损坏或非图片格式），不影响本次发送`,
        duration: 4000,
      }));
    }

    // ★ M4-5-S4 自动标题（截断占位 + 异步系统模型语义标题）：
    //   1. 首条消息立即设【截断占位】标题（即时可见，不依赖任何网络）。
    //   2. 截断占位后【fire-and-forget】调系统模型生成 ≤15 字语义标题，成功清洗后回写、失败 retry 1 次、
    //      最终降级保留截断占位。★铁律：绝不 await——标题异步绝不阻塞首轮流式回复。
    //   3. 竞态守卫：回写前比对发起时的 conversation.id 快照一致 + 标题仍是占位（未被用户手改），否则不覆盖。
    //   4. 首条纯图片/附件（无可概括文本）：降级保留占位，不调系统模型。
    if (!opts?.skipUserMessage && selectConversationById(store.getState() as RootState, this.runConvId!).messages.length <= 1) {
      const placeholderTitle = userMessage.slice(0, TITLE_PLACEHOLDER_CHARS)
        + (userMessage.length > TITLE_PLACEHOLDER_CHARS ? '...' : '');
      store.dispatch(setTitle({ title: placeholderTitle, conversationId: this.runConvId! })); // ★ #8：占位标题写本 run 对话桶
      // ★ M6 验收 bug9：标题不仅改 conversation slice（顶部 header），还要同步对话列表数据源
      //   （conversationHistory），否则左侧列表 / @ 对话候选一直显示创建时的 fallback（首条消息内容）。
      //   占位先 best-effort 同步列表（列表项若尚未创建则 no-op，autosave 首存会带正确 title）。
      {
        const idForTitle = this.runConvId;
        if (idForTitle) store.dispatch(updateConversation({ id: idForTitle, title: placeholderTitle }));
      }

      // 仅当首条有可概括文本时才异步生成（纯图片/附件无文本 → 保留占位降级）。
      const titleSource = userMessage.trim();
      if (titleSource) {
        const titleExecutionContext = this.executionContext!;
        // ★ fire-and-forget：包在自执行 async IIFE，void 丢弃 promise，绝不被主流式 await。
        void (async () => {
          // ★ M7-F1：复用抽出的 generateTitleFromText（与手动「重新生成标题」同内核）。
          const generated = await generateTitleFromText(titleSource, execContextId);
          if (!generated) return; // 全失败 → 保留已设的截断占位（不再 dispatch）

          // 竞态守卫：回写前再读 live conversation——
          //   - id 必须与发起时快照一致（对话未切换/未清空）；
          //   - 当前标题必须仍是占位（未被用户在生成期间手动改过），否则尊重用户手改、不覆盖。
          const targetConversationId = executionRegistry.resolveConversationId(titleExecutionContext);
          const live = selectConversationById(store.getState() as RootState, targetConversationId);
          if (live.title !== placeholderTitle) return;
          store.dispatch(setTitle({ title: generated, conversationId: targetConversationId }));
          // ★ M6 验收 bug9：生成标题同步对话列表 slice（即时刷新左侧列表 / @ 对话候选）+ 落库
          //   （systemTouch=true：只写标题列不刷 updated_at，避免自动标题把对话顶到列表最前）。
          store.dispatch(updateConversation({ id: targetConversationId, title: generated }));
          void renameConversation(targetConversationId, generated, { systemTouch: true });
        })();
      }
    }

    // ★ M4-8-S4 端到端计时：记录本次 agent loop 的起点（用户发出此刻）。
    // 端到端总耗时 = loop 全程（含多轮工具调用）完成时的 now - loopStartedAt，
    // 只挂在【最终完成消息】那一条上（finalCompletedAssistantId），不在每条 run 上重复（Plan_5 风险四）。
    // 逐条 run 计时仍走各自 runStartedAt → durationMs，互不干扰。
    const loopStartedAt = Date.now();
    store.dispatch(addAssistantRun({
      run: {
        id: this.executionContext.runId,
        startedAt: loopStartedAt,
        model: currentModel,
        status: 'streaming',
        events: [],
      },
      conversationId: this.runConvId!,
    }));
    // ★ H5（反馈）：同轮干太久提醒——只在跨过阈值那一轮注入一次（防重复刷屏 + 防 prompt cache 每轮前缀漂移）。
    let reminderInjected = false;
    // 最终给出答复的 assistant 消息 id：每次「成功完成」分支更新；正常结束（无工具调用 break）时它就是最终答复。
    // 中止 / 错误 / 空响应分支不更新它（那几种结束态已有 Stopped / 错误态，不挂端到端徽标）。
    let finalCompletedAssistantId: string | null = null;
    // 标记 loop 是否「自然完成」（最终一轮无工具调用、正常给出答复）。仅此态才挂端到端徽标——
    // 避免「工具轮成功后用户中止」这种 finalCompletedAssistantId 指向非最终答复的轮次时误挂。
    let completedNaturally = false;
    let terminalStateRecorded = false;

    let round = 0;

    const endOwnedTaskBoundary = (status: 'done' | 'interrupted' | 'aborted' = 'done'): boolean => {
      if (!this.executionContext || !executionRegistry.isActiveRun(this.executionContext)) return false;
      store.dispatch(endTaskBoundary({ status, conversationId: this.runConvId! }));
      return true;
    };

    // ★ 审查 LOW（lens2）：execContextId 已在 run 入口快照（见上方），整轮 run 期间复用——不再 while 内每轮重读
    //   store.conversation.id。原每轮重读：流式中途用户切对话会让在途工具的 execContextId 漂移成新对话身份，去取新
    //   对话的 worktree 隔离根执行旧对话的在途工具（窄串台窗口）。入口快照后整轮身份不可变，与子代理路径（构造期固定
    //   contextId）口径统一；#8 起它还兼任所有对话私有写入 dispatch 的桶路由 key。

    // ★ Plan_7 #6：轮间【插队】消费——生成中用户用 Ctrl/Cmd+Enter 插话进 interruptMessages，
    //   每轮工具调用结束、下一轮 API 请求【前】把【全部】待插消息按入队序取出，作为 user 消息插入：
    //     ① dispatch addMessage(user) 进 UI（落到当前 run 的对话流里，正常渲染）；
    //     ② 转成 ChatMessage、还原附件 base64 后 push 进本次发送的 apiMessages（让 AI 下一轮 API 请求就看到）；
    //     ③ dequeueInterrupt 出队。
    //   语义边界：只在轮间插（不打断正在跑的工具/流），插入后当前 run 继续带着插话往下跑。
    //   竞态守卫：消费前确认对话身份未切换（conversation.id 与 execContextId 一致），切了就不消费（防串台/误插新对话）。
    const drainInterruptMessages = async (): Promise<void> => {
      let consumedInterrupt = false;
      let interruptedContinuation: InterruptContinuationTaskBoundary | undefined;
      let lastInterruptMessageId: string | undefined;
      while (this.running) {
        const liveConv = selectConversationById(store.getState() as RootState, this.runConvId!);
        const pending = liveConv.interruptMessages as QueuedMessage[];
        if (!pending || pending.length === 0) break;
        const activeBoundary = liveConv.taskBoundaries?.find((boundary: any) => boundary.status === 'active');
        if (!consumedInterrupt && activeBoundary) {
          // 插队是一次清楚的人类中断：先把此前过程标为中止收口，再把新 user 消息放到卡片外。
          const continuation = interruptContinuationFromBoundary(activeBoundary);
          if (endOwnedTaskBoundary('interrupted')) interruptedContinuation = continuation;
        }
        // 身份守卫：对话已切换（execContextId 是 contextId 或入口对话 id）→ 不消费（队列也会被 setConversation 清，双保险）。
        const head = pending[0];
        // 先出队（同步），防 await 期间重复消费同一条。★ #8：出队本 run 对话桶（守卫已确保 liveId===execContextId）。
        store.dispatch(dequeueInterrupt({ conversationId: this.runConvId! }));
        // 还原排队项为「就绪附件」（剥内存预览，发送态走 sent；与队列自动发同口径）。
        const interruptAttachments: AttachmentRef[] = (head.attachments ?? []).map(att => ({
          ...att,
          previewUrl: undefined,
          payloadUrl: undefined,
          status: 'sent' as const,
          error: undefined,
        }));
        // ① 进 UI：作为本 run 对话流里的一条 user 消息（含富文本 token，编辑回填无损还原）。★ #8：路由本 run 对话桶。
        const interruptMessageId = generateId();
        store.dispatch(addMessage({
          message: {
            id: interruptMessageId,
            role: 'user',
            content: head.text,
            contentParts: head.contentParts && head.contentParts.length > 0 ? head.contentParts : undefined,
            attachments: interruptAttachments.length > 0 ? interruptAttachments : undefined,
            richTokens: head.richTokens,
            timestamp: Date.now(),
          },
          conversationId: this.runConvId!,
        }));
        lastInterruptMessageId = interruptMessageId;
        // ② 进 API：转 ChatMessage（contentParts 优先，纯文本兜底），单条还原附件 base64 后 push。
        const interruptChat: ChatMessage = head.contentParts && head.contentParts.length > 0
          ? { role: 'user', content: head.contentParts as any }
          : { role: 'user', content: head.text };
        const restored = this.client.supportsVision
          ? await restoreApiMessagesAttachments([interruptChat])
            .catch(() => ({ messages: [interruptChat], skippedInvalidImages: 0 }))
          : downgradeApiMessageImagesToText([interruptChat]);
        if (!this.running) return;
        apiMessages.push(...restored.messages);
        consumedInterrupt = true;
      }
      if (consumedInterrupt) {
        const continuationBoundaryId = beginInterruptContinuationTaskBoundary(interruptedContinuation, lastInterruptMessageId);
        apiMessages.push({
          role: 'system',
          content: continuationBoundaryId && interruptedContinuation
            ? `【用户插队续接】以上用户消息在工具轮间插入；之前的任务边界 ${interruptedContinuation.previousBoundaryId} 已按 interrupted 收口，系统已在插队消息之后建立新的 continuation task_boundary：${continuationBoundaryId}。先响应最新指令；若仍需继续工具工作，请直接调用 update_task_progress() 写入这张续接边界，完成时调用 end_task_boundary() 收口，不要为同一段续接重复 begin_task_boundary。`
            : '【用户插队】以上用户消息在工具轮间插入。先响应最新指令；若仍需继续多步工具工作，请建立新的 task_boundary。',
        });
      }
    };

    const recordGuardStop = (title: string, message: string, errorCode: string): void => {
      if (terminalStateRecorded) return;
      terminalStateRecorded = true;
      const stoppedAt = Date.now();
      const messageId = generateId();
      store.dispatch(addMessage({
        message: {
          id: messageId,
          role: 'assistant',
          content: message,
          timestamp: stoppedAt,
          model: currentModel,
          runId: this.executionContext!.runId,
          isStreaming: false,
        },
        conversationId: this.runConvId!,
      }));
      store.dispatch(setMessageStreamState({
        id: messageId,
        streamState: 'error',
        durationMs: stoppedAt - loopStartedAt,
        error: errorCode,
        conversationId: this.runConvId!,
      }));
      store.dispatch(addRunEvent({
        event: {
          id: generateId('evt'),
          runId: this.executionContext!.runId,
          messageId,
          type: 'error',
          timestamp: stoppedAt,
          error: errorCode,
        },
        conversationId: this.runConvId!,
      }));
      endOwnedTaskBoundary('aborted');
      store.dispatch(addNotification({ type: 'warning', title, message, duration: 7000 }));
    };

    const configuredOutputLimit = Number((store.getState() as RootState).agentSettings?.maxTokens ?? 0);
    const loopOutputReserve = Math.min(
      Number.isFinite(configuredOutputLimit) && configuredOutputLimit > 0 ? configuredOutputLimit : 8192,
      Math.max(8192, Math.floor(modelContextWindow * 0.08)),
    );
    const loopSafeInputBudget = Math.max(
      1,
      Math.min(
        Math.floor(modelContextWindow * effectiveCompactThreshold),
        modelContextWindow - loopOutputReserve,
      ),
    );

    let previousToolRoundOutcome = '';
    let repeatedToolRoundCount = 0;
    while (this.running && round < maxRounds) {
      if (currentMode !== 'fast' && autoContinueToolRounds && round > 0 && round % segmentRounds === 0) {
        const segmentNumber = Math.floor(round / segmentRounds) + 1;
        store.dispatch(appendTaskStep({
          id: generateId('step'),
          text: `已完成 ${round} 轮模型与工具交互，自动续跑第 ${segmentNumber}/${MAX_AUTO_TOOL_SEGMENTS} 段`,
          conversationId: this.runConvId!,
        }));
        apiMessages.push({
          role: 'system',
          content: `【自动续跑】这是同一任务的第 ${segmentNumber}/${MAX_AUTO_TOOL_SEGMENTS} 段。继承现有任务边界、工具结果和文件状态继续执行；若任务已完成请先收口任务边界并给出最终答复。`,
        });
      }
      round++;
      // ★ Plan_7 #6：下一轮 API 请求【前】消费插队消息——把生成中用户插话作为 user 消息插入 UI + apiMessages，
      //   让 AI 本轮就看到。首轮队列必空（用户刚发、无机会插）→ no-op；工具轮 continue 回循环顶亦在此统一消费。
      await drainInterruptMessages();
      if (!this.running) break;
      if (bpcScheduler.hasReadySnapshot(bpcConversationId)) {
        const liveHistory = selectConversationById(store.getState() as RootState, bpcConversationId).messages
          .filter((message: any) => message.role !== 'tool')
          .map(toChatMessage);
        const publishedPrefix = await bpcScheduler.takeReadyPrefix(
          bpcConversationId,
          identifyRounds(liveHistory).totalSteps,
        );
        if (!this.running) break;
        if (publishedPrefix?.recordMd) {
          apiMessages = applyReadyRecordToActiveRequest(apiMessages, publishedPrefix.recordMd);
          const publishedRecord = await getRecord(bpcConversationId);
          requestCompressionGeneration = String(publishedRecord?.revision ?? requestCompressionGeneration);
        }
      }
      const activeBoundaryNeedsFinalReminder = round > 1
        && apiMessages[apiMessages.length - 1]?.role === 'tool'
        && selectConversationById(store.getState() as RootState, this.runConvId!).taskBoundaries?.some((boundary: any) => boundary.status === 'active');
      if (activeBoundaryNeedsFinalReminder) {
        apiMessages.push({
          role: 'system',
          content: '【任务边界收口提醒】如果当前任务已经完成，你必须先调用 end_task_boundary()，再发送面向用户的最终答复；如果仍需继续工具工作，则保持边界 active 并继续。不要在 active 边界中直接给出最终汇报。',
        });
      }
      // ★ #7（反馈修正 H5）：本轮连续干较多步(≥10)或耗时过长(>2min)时，按当前 task_boundary 状态注入 system 提醒，
      //   促 AI 用 task_boundary 把过程【结构化包裹】——而非「提醒向用户汇报」（task_boundary 是过程包裹，
      //   汇报应在收口后、无任务边界状态下做）。只注入一次（reminderInjected）；push 末尾不破坏前缀 prompt cache。
      if (!reminderInjected && (round >= 10 || Date.now() - loopStartedAt > 120_000)) {
        reminderInjected = true;
        const hasActiveBoundary = !!selectConversationById(store.getState() as RootState, this.runConvId!).taskBoundaries?.some((b: any) => b.status === 'active');
        const reminderText = hasActiveBoundary
          ? '【系统提醒】当前任务边界(task_boundary)已持续较长。它是「过程/干活的包裹」——若你已进入一个新阶段或新主题，请先 end_task_boundary 收口当前、再 begin_task_boundary 开新的；阶段性成果的汇报应在收口后、无任务边界状态下进行，不要在 task 进行中跟用户汇报。'
          : '【系统提醒】你已连续执行较多步骤却没有用 task_boundary 包裹过程。task_boundary 是把多步干活结构化收纳、避免刷屏的「过程包裹」——请调用 begin_task_boundary 把当前这段工作包起来，干完后 end 收口、在无任务边界状态下汇报结果。';
        apiMessages.push({ role: 'system', content: reminderText });
      }
      const providerRequestTimestamp = Date.now();
      const requestMessages = appendRuntimeContext(
        apiMessages,
        buildRuntimeContextSection(providerRequestTimestamp),
      );
      const loopRequestTokens = estimateRequestInputTokens(requestMessages, toolsTokens);
      if (loopRequestTokens > loopSafeInputBudget) {
        recordGuardStop(
          '本轮已安全停止',
          `当前尚未完成的一轮组装后约为 ${loopRequestTokens} tokens，超过本模型本轮安全输入预算 ${loopSafeInputBudget}。为避免把超长请求继续发给模型，Synapse 已保留现有改动和工具结果并停止本轮；检查后可在下一条消息继续。`,
          'unfinished_round_context_limit',
        );
        break;
      }
      // 在真正发给 Provider 之前就把“实际发送视图”的估算写给 UI。这样流式首包回来前也不会拿全量
      // retained transcript 冒充当前 context usage；Provider usage 到达后 setTokenUsage 会用实测 promptTokens 覆盖。
      store.dispatch(setProjectedTokenCount({
        count: loopRequestTokens,
        conversationId: this.runConvId!,
        allowApiOverride: true,
      }));
      store.dispatch(setStreaming({ value: true, conversationId: this.runConvId! }));
      store.dispatch(clearStreamingContent({ conversationId: this.runConvId! }));

      let fullContent = '';
      let lastError = '';
      let wasAborted = false;
      let streamCompleted = false;
      const pendingToolCalls: ToolCallRequest[] = [];
      const runId = this.executionContext!.runId;
      const assistantMessageId = generateId();
      const runStartedAt = Date.now();
      const agentRuntimeSettings = (store.getState() as RootState).agentSettings;
      const showThinking = agentRuntimeSettings.showThinking ?? true;
      const outputStrategy = agentRuntimeSettings.outputStrategy ?? ((agentRuntimeSettings.enableStreaming ?? true) ? 'auto' : 'off');
      const showStreamCursor = outputStrategy !== 'off' && (agentRuntimeSettings.showStreamCursor ?? true);
      const showGeneratingPlaceholder = agentRuntimeSettings.showGeneratingPlaceholder ?? true;
      let streamModeUsed: StreamModeUsed | undefined = outputStrategy === 'pseudo' ? 'pseudo' : outputStrategy === 'off' ? 'off' : undefined;
      let fallbackReason: string | undefined;
      let fallbackNotified = false;
      let streamModeRecorded = false;
      // M4-8-S3：本轮重连进度展示位置 = 气泡内「reconnect i/N」（主推）+ StatusBar checking（已有）。
      // 按 Plan_5 决策4，去掉原 M2-S 那条持续 notification（避免气泡 + 状态栏 + 通知三处冗余）。
      // reconnectShown 标记本轮气泡是否正显示重连进度，用于收尾兜底 clear。
      let reconnectShown = false;
      store.dispatch(addRunEvent({
        event: {
          id: generateId('evt'),
          runId,
          messageId: assistantMessageId,
          type: 'started',
          timestamp: runStartedAt,
        },
        conversationId: this.runConvId!,
      }));
      store.dispatch(addMessage({
        message: {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          timestamp: runStartedAt,
          model: currentModel,
          runId,
          isStreaming: true,
          streamState: 'pending',
          streamMode: streamModeUsed,
          showStreamCursor,
          showGeneratingPlaceholder,
        },
        conversationId: this.runConvId!,
      }));

      const noteStreamMode = (chunkMode?: StreamModeUsed, reason?: string) => {
        if (!chunkMode && !reason) return;
        const modeChanged = !!chunkMode && chunkMode !== streamModeUsed;
        const reasonChanged = !!reason && reason !== fallbackReason;
        if (streamModeRecorded && !modeChanged && !reasonChanged) return;
        if (chunkMode) streamModeUsed = chunkMode;
        if (reason) fallbackReason = reason;
        streamModeRecorded = true;
        store.dispatch(updateMessageMeta({
          id: assistantMessageId,
          changes: {
            streamMode: streamModeUsed,
            fallbackReason,
          },
          conversationId: this.runConvId!,
        }));
        store.dispatch(addRunEvent({
          event: {
            id: generateId('evt'),
            runId,
            messageId: assistantMessageId,
            type: 'stream_mode',
            timestamp: Date.now(),
            streamMode: streamModeUsed,
            fallbackReason,
          },
          conversationId: this.runConvId!,
        }));
        if (reason && !fallbackNotified) {
          fallbackNotified = true;
          store.dispatch(addNotification({
            type: 'info',
            title: '输出策略已降级',
            message: reason.slice(0, 200),
            duration: 3000,
          }));
        }
      };

      // ★ M6 验收 C2c：流式 dispatch rAF 批处理。原本每个 SSE token 三连 dispatch
      //   （appendMessageContent + setMessageStreamState + addRunEvent）把主线程打满——生成时整个界面卡死、
      //   滚动条/选模型/思考卡片全锁死。改为累积 buffer + requestAnimationFrame 合并 flush，dispatch 频率从
      //   「每 token」降到「每帧(~16ms)」。
      //   ★ 关键安全点：finalize 用 updateMessageMeta 不覆盖 content（content 全靠流式 appendMessageContent 累积），
      //     故所有收尾分支前必须 flushStreamBuffer() 把残余 buffer 上屏，否则丢末尾文本（见下方 try/catch 后）。
      let contentBuffer = '';
      let deltaBuffer = '';
      let thinkingBuffer = '';
      let streamFlushScheduled = false;
      let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushStreamBuffer = () => {
        if (streamFlushTimer) {
          clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        streamFlushScheduled = false;
        if (!this.running) {
          contentBuffer = '';
          deltaBuffer = '';
          thinkingBuffer = '';
          return;
        }
        if (!contentBuffer && !thinkingBuffer) return;
        const pendingContent = contentBuffer;
        const pendingDelta = deltaBuffer;
        const pendingThinking = thinkingBuffer;
        contentBuffer = '';
        deltaBuffer = '';
        thinkingBuffer = '';
        store.dispatch(appendAssistantStreamFrame({
          id: assistantMessageId,
          content: pendingContent || undefined,
          thinking: pendingThinking || undefined,
          streamMode: streamModeUsed,
          fallbackReason,
          conversationId: this.runConvId!,
        }));
        if (pendingDelta) {
          store.dispatch(addRunEvent({
            event: {
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId,
              type: 'content_delta',
              timestamp: Date.now(),
              content: pendingDelta,
            },
            conversationId: this.runConvId!,
          }));
        }
        if (pendingThinking) {
          store.dispatch(addRunEvent({
            event: {
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId,
              type: 'thinking_delta',
              timestamp: Date.now(),
              content: pendingThinking,
            },
            conversationId: this.runConvId!,
          }));
        }
      };
      // ★ M6 验收 C2c 调整：flush 用【时间节流】而非 rAF（每帧 ~60 次/秒）。主人反馈「卡=渲染频率过高」，
      //   要的是降频渲染而非不渲染——节流到 ~200ms 一次（≈5 次/秒），让流式期照常渲染 markdown 但解析频率降 ~12 倍。
      //   STREAM_FLUSH_MS 可调：太顿→调小(120)、长回复仍卡→调大(300)。
      const STREAM_FLUSH_MS = 200;
      const scheduleStreamFlush = () => {
        if (streamFlushScheduled) return;
        streamFlushScheduled = true;
        streamFlushTimer = setTimeout(flushStreamBuffer, STREAM_FLUSH_MS);
      };

      try {
        if (!this.running) break;
        this.client.updateConfig({ compressionGeneration: requestCompressionGeneration });
        const requestProviderId = this.client.providerId;
        const stream = this.client.streamChat(
          requestMessages,
          // Fast mode: don't pass tools (no agentic behavior)
          currentMode === 'fast' || !toolsEnabled ? undefined : (activeTools.length > 0 ? activeTools : undefined),
          providerRequestTimestamp,
        );

        // M4-8-S3：重试已恢复（收到任何实质数据）则清掉气泡「reconnect i/N」提示，避免残留。
        const clearRetryNotice = () => {
          if (reconnectShown) {
            reconnectShown = false;
            store.dispatch(setMessageReconnect({ id: assistantMessageId, reconnect: null, conversationId: this.runConvId! }));
          }
        };

        for await (const chunk of stream) {
          if (!this.running) break;
          noteStreamMode(chunk.streamMode, chunk.fallbackReason);

          // M4-8-S3：重连进度可观测——aiClient 在每次退避重试【前】发该事件（流式 real 与非流式 off/pseudo 同源）。
          // 写气泡瞬态 reconnect 字段（MessageBubble 渲染「reconnect i/N」）+ StatusBar checking。
          // 按决策4去掉了持续 notification（不再三处冗余）。
          if (chunk.type === 'retry' && chunk.retry) {
            const { attempt, maxRetries } = chunk.retry;
            store.dispatch(setConnectionStatus('checking'));
            reconnectShown = true;
            store.dispatch(setMessageReconnect({
              id: assistantMessageId,
              reconnect: { attempt, max: maxRetries },
              conversationId: this.runConvId!,
            }));
            // M4-8 审查修复（问题2/3）：真流式读流中途断线重试，重发会让模型从头重生成整段回复。
            // aiClient 在本轮已 yield 过实质内容时会带 resetContent，要求先丢弃本轮已上屏/已累积内容，
            // 让重试后的新流覆盖而非追加，杜绝「半截旧 + 完整新」拼接污染气泡与 conversation history。
            if (chunk.resetContent) {
              fullContent = '';
              contentBuffer = ''; // ★ C2c：重连重置时清掉未 flush 的残余 buffer，避免旧内容污染重生成的新流
              deltaBuffer = '';
              thinkingBuffer = '';
              store.dispatch(updateMessage({ id: assistantMessageId, content: '', conversationId: this.runConvId! }));
              store.dispatch(updateMessageMeta({ id: assistantMessageId, changes: { thinking: undefined }, conversationId: this.runConvId! }));
              store.dispatch(resetRunStreamEvents({
                runId,
                messageId: assistantMessageId,
                conversationId: this.runConvId!,
              }));
            }
            continue;
          }

          if (chunk.type === 'content' && chunk.content) {
            clearRetryNotice();
            fullContent += chunk.content;
            // ★ C2c：不再每 token 三连 dispatch，累积进 buffer 由 rAF 合并 flush（见 flushStreamBuffer）。
            contentBuffer += chunk.content;
            deltaBuffer += chunk.content;
            scheduleStreamFlush();
          }
          if (chunk.type === 'thinking' && chunk.thinking && showThinking) {
            clearRetryNotice();
            thinkingBuffer += chunk.thinking;
            scheduleStreamFlush();
          }
          if (chunk.type === 'tool_call' && chunk.toolCall) {
            const normalizedToolCall: ToolCallRequest = {
              ...chunk.toolCall,
              function: {
                ...chunk.toolCall.function,
                arguments: normalizeToolCallArguments(chunk.toolCall.function.arguments),
              },
            };
            pendingToolCalls.push(normalizedToolCall);
            store.dispatch(addRunEvent({
              event: {
                id: generateId('evt'),
                runId,
                messageId: assistantMessageId,
                type: 'tool_call',
                timestamp: Date.now(),
                toolCallId: normalizedToolCall.id,
              },
              conversationId: this.runConvId!,
            }));
          }
          if (chunk.type === 'error') {
            if (chunk.error === 'aborted') {
              wasAborted = true;
              break;
            }
            lastError = String(chunk.error);
            store.dispatch(setConnectionStatus('failed'));
            if (platform.provider) {
              try {
                const credentialStatus = await platform.provider.credentialStatus(requestProviderId);
                store.dispatch(setProviderCredentialStatus(credentialStatus));
              } catch (credentialError) {
                console.warn('[AgentLoop] 刷新 Provider 凭据状态失败:', credentialError);
              }
            }
            console.error('[AgentLoop] Stream error:', chunk.error);
            store.dispatch(addRunEvent({
              event: {
                id: generateId('evt'),
                runId,
                messageId: assistantMessageId,
                type: 'error',
                timestamp: Date.now(),
                error: lastError,
              },
              conversationId: this.runConvId!,
            }));
            break;
          }
          // Stage 5: 捕获 API 返回的真实 token 使用量
          if (chunk.type === 'done') {
            streamCompleted = true;
            if (chunk.usage) {
              const conversationId = this.runConvId!;
              const liveRootState = store.getState() as RootState;
              const liveConversation = selectConversationById(liveRootState, conversationId);
              const liveSelectionId = liveConversation.model || liveRootState.agentSettings.currentModel;
              const liveRuntime = resolveProviderModel(
                liveSelectionId,
                liveRootState.agentSettings.availableModels,
                liveRootState.settings.providerCredentials,
                liveRootState.settings.apiEndpoints,
              );
              const liveCatalogGeneration = liveRuntime.option?.catalog?.generation;
              const liveCredential = liveRootState.settings.providerCredentials[liveRuntime.providerId];
              const usageMatchesLiveSelection = chunk.usage.providerId === liveRuntime.providerId
                && chunk.usage.modelId === liveRuntime.modelId
                && chunk.usage.conversationId === conversationId
                && chunk.usage.runId === runId
                && (chunk.usage.accountFingerprint ?? null) === (liveCredential?.accountFingerprint ?? null)
                && (chunk.usage.credentialGeneration ?? 0) === (liveCredential?.credentialGeneration ?? 0)
                && (!liveCatalogGeneration || chunk.usage.catalogGeneration === liveCatalogGeneration)
                && String(chunk.usage.compressionGeneration ?? '0') === requestCompressionGeneration;
              if (usageMatchesLiveSelection) {
                store.dispatch(setTokenUsage({ ...chunk.usage, conversationId }));
              }
            }
          }
        }
      } catch (err: any) {
        lastError = err.message || '未知网络错误';
        console.error('[AgentLoop] Exception:', err);
        store.dispatch(addRunEvent({
          event: {
            id: generateId('evt'),
            runId,
            type: 'error',
            timestamp: Date.now(),
            error: lastError,
          },
          conversationId: this.runConvId!,
        }));
      }

      // 正常结束必须 flush 最后一段；用户 Stop 后则丢弃尚未上屏的缓冲和迟到增量，避免点击停止后正文继续增长。
      if (this.running) flushStreamBuffer();
      else {
        if (streamFlushTimer) {
          clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        streamFlushScheduled = false;
        contentBuffer = '';
        deltaBuffer = '';
        thinkingBuffer = '';
        wasAborted = true;
      }
      const ownsStreamingRun = this.executionContext
        ? executionRegistry.isActiveRun(this.executionContext)
        : false;
      if (ownsStreamingRun) {
        store.dispatch(setStreaming({ value: false, conversationId: this.runConvId! }));
      }
      // M4-8-S3：本轮收尾兜底清气泡「reconnect i/N」（成功/失败/中止/异常任一路径都清，不残留）。
      if (reconnectShown) {
        reconnectShown = false;
        store.dispatch(setMessageReconnect({ id: assistantMessageId, reconnect: null, conversationId: this.runConvId! }));
      }

      if (wasAborted) {
        const abortedAt = Date.now();
        // ★ H1（tb 卡住）：本轮被中止 → 收口未结束的 active task_boundary（aborted），否则边界永久 active、
        //   卡片一直挂着把后续每条消息都吞进去（"莫名一直在 task_boundary 状态"根因之一）。无 active 时 no-op。
        endOwnedTaskBoundary('aborted');
        const visibleContent = selectConversationById(store.getState() as RootState, this.runConvId!)
          .messages.find((message: any) => message.id === assistantMessageId)?.content?.trim();
        if (!visibleContent) {
          store.dispatch(updateMessage({ id: assistantMessageId, content: '已停止生成', conversationId: this.runConvId! }));
        }
        store.dispatch(updateMessageMeta({
          id: assistantMessageId,
          changes: {
            durationMs: abortedAt - runStartedAt,
            thinking: showThinking
              ? {
                content: selectConversationById(store.getState() as RootState, this.runConvId!)
                  .messages.find((m: any) => m.id === assistantMessageId)?.thinking?.content ?? '',
                startedAt: runStartedAt,
                endedAt: abortedAt,
                durationMs: abortedAt - runStartedAt,
                collapsed: true,
                status: 'error',
              }
              : undefined,
          },
          conversationId: this.runConvId!,
        }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'aborted', durationMs: abortedAt - runStartedAt, streamMode: streamModeUsed, fallbackReason, conversationId: this.runConvId! }));
        store.dispatch(addRunEvent({
          event: {
            id: generateId('evt'),
            runId,
            messageId: assistantMessageId,
            type: 'aborted',
            timestamp: abortedAt,
          },
          conversationId: this.runConvId!,
        }));
        break;
      }

      // P0-4 修复: 处理 3 种情况
      // 1. 有文本内容（可能附带 tool_calls）
      // 2. 无文本但有 tool_calls（OpenAI 合法情况）
      // 3. 完全空响应（异常）
      const responseError = lastError || (!streamCompleted ? '响应流在完成信号前中断' : '');
      if (!responseError && (fullContent || pendingToolCalls.length > 0)) {
        store.dispatch(setConnectionStatus('configured'));
        const completedAt = Date.now();
        store.dispatch(updateMessageMeta({
          id: assistantMessageId,
          changes: {
            durationMs: completedAt - runStartedAt,
            streamState: 'complete',
            streamMode: streamModeUsed,
            fallbackReason,
            isStreaming: false,
            toolCalls: pendingToolCalls.length > 0
              ? pendingToolCalls.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
                status: 'pending' as const,
              }))
              : undefined,
            thinking: showThinking
              ? {
                ...((selectConversationById(store.getState() as RootState, this.runConvId!)
                  .messages.find((m: any) => m.id === assistantMessageId)?.thinking) ?? {
                  content: '',
                  startedAt: runStartedAt,
                  collapsed: true,
                }),
                endedAt: completedAt,
                durationMs: completedAt - runStartedAt,
                status: 'complete',
              }
              : undefined,
          },
          conversationId: this.runConvId!,
        }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'complete', durationMs: completedAt - runStartedAt, streamMode: streamModeUsed, fallbackReason, conversationId: this.runConvId! }));
        if (pendingToolCalls.length === 0) {
          store.dispatch(addRunEvent({
            event: {
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId,
              type: 'done',
              timestamp: completedAt,
            },
            conversationId: this.runConvId!,
          }));
        }
        apiMessages.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        });
        // ★ M4-8-S4：记录本轮成功完成的 assistant 消息——若本轮无后续工具调用（下方 break），它就是最终答复，
        //   循环结束后给它挂端到端总计时徽标。有工具调用则 continue 进下一轮，本变量被下一轮覆盖。
        finalCompletedAssistantId = assistantMessageId;
      } else if (responseError) {
        // ★ H1（tb 卡住）：API 失败等异常 → 收口 active task_boundary（aborted）。这是「AI 没机会调 end、
        //   用户也没点停止」时边界永久挂住的主因（图六 context canceled 场景）。无 active 时 no-op。
        endOwnedTaskBoundary('aborted');
        const errorMsg = fullContent
          ? `${fullContent}\n\n⚠️ AI 请求失败，以上内容可能不完整: ${responseError}`
          : `⚠️ AI 请求失败: ${responseError}`;
        const errorAt = Date.now();
        store.dispatch(setConnectionStatus('failed'));
        store.dispatch(updateMessage({ id: assistantMessageId, content: errorMsg, conversationId: this.runConvId! }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'error', durationMs: errorAt - runStartedAt, error: responseError, streamMode: streamModeUsed, fallbackReason, conversationId: this.runConvId! }));
        store.dispatch(addNotification({
          type: 'error',
          title: 'AI 响应错误',
          message: responseError.slice(0, 200),
        }));
        terminalStateRecorded = true;
        break;
      } else {
        const emptyAt = Date.now();
        store.dispatch(updateMessage({ id: assistantMessageId, content: '⚠️ AI 返回了空响应，请检查模型选择或 API 配置。', conversationId: this.runConvId! }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'error', durationMs: emptyAt - runStartedAt, error: 'empty_response', streamMode: streamModeUsed, fallbackReason, conversationId: this.runConvId! }));
        store.dispatch(addRunEvent({
          event: {
            id: generateId('evt'),
            runId,
            type: 'error',
            timestamp: emptyAt,
            error: 'empty_response',
          },
          conversationId: this.runConvId!,
        }));
        terminalStateRecorded = true;
        break;
      }

      // Execute tool calls if any
      if (pendingToolCalls.length > 0 && this.toolExecutor) {
        const toolRoundOutcome: string[] = [];
        // execContextId 已在 run 入口快照（见 while 前），整轮 run 复用，不再每轮重读 store（防流式中切对话身份漂移）。
        for (const tc of pendingToolCalls) {
          if (!this.running) {
            // ★ 命令转圈修复：用户中断 → 把本轮【剩余未执行】的 pending/running 工具调用收尾为 cancelled，
            //   避免它们永久卡 spinner（已执行的上面已回写 success/error）。恢复路径另由 normalizeMessage 兜底。
            if (assistantMessageId) {
              // ★ #8：从本 run 对话桶读未完成工具调用（与下方 cancel 写入同桶），防读错桶漏 cancel。
              const abortMsg = selectConversationById(store.getState() as RootState, this.runConvId!).messages.find((m: any) => m.id === assistantMessageId);
              abortMsg?.toolCalls?.forEach((t: any) => {
                if (t.status === 'pending' || t.status === 'running') {
                  store.dispatch(updateToolCallStatus({ messageId: assistantMessageId, toolCallId: t.id, status: 'cancelled', result: '已取消（生成中断）', conversationId: this.runConvId! }));
                }
              });
            }
            break;
          }
          const toolStartedAt = Date.now();
          const callContext = executionRegistry.beginCall(this.executionContext!, tc.id);
          const toolController = new AbortController();
          this.toolControllers.add(toolController);
          try {
            const args = parseToolCallArguments(tc.function.arguments);
            const result = await this.toolExecutor(tc.function.name, args, {
              ...callContext,
              signal: toolController.signal,
              onTaskStarted: async snapshot => {
                if (!assistantMessageId || !this.running || !executionRegistry.isActiveRun(callContext)) return;
                store.dispatch(updateToolCallStatus({
                  messageId: assistantMessageId,
                  toolCallId: tc.id,
                  status: snapshot.status,
                  result: snapshot.text || snapshot.error,
                  structured: snapshot.structured,
                  artifacts: snapshot.artifacts,
                  taskId: snapshot.taskId,
                  taskOwnerId: snapshot.ownerId,
                  taskRunId: snapshot.runId,
                  taskCallId: snapshot.callId,
                  errorCode: snapshot.errorCode,
                  unknownSideEffect: snapshot.unknownSideEffect,
                  conversationId: this.runConvId!,
                }));
                await persistRuntimeConversationSnapshot(this.runConvId!);
              },
            });
            const resultText = renderToolResultForModel(result);
            const stoppedAfterResult = !this.running || !executionRegistry.isActiveRun(callContext);
            const ownerMessageStillExists = Boolean(
              assistantMessageId
              && selectConversationById(store.getState() as RootState, this.runConvId!).messages
                .some(message => message.id === assistantMessageId),
            );
            const stoppedResultText = result.unknownSideEffect
              ? '已停止；工具的最终副作用状态未知，相关文件变化仍会保留供审查'
              : '已停止；工具在停止后返回的结果未送入模型';
            // ★ medium#3/#5：按 execContextId 消费自己桶的改动，杜绝与并行子代理/其它上下文串台。
            const fileChanges = consumeTrackedFileChanges(callContext.callId);
            // 历史操作原则上会等旧 run 完全退出；这里再做最后一道归属闸。若 owner message 已被
            // 其它异常路径移除，绝不能把迟到结果写成无人可见、却仍可接受/拒绝的孤儿 Diff。
            const attributableFileChanges = ownerMessageStillExists ? fileChanges : [];
            for (const change of attributableFileChanges) {
              store.dispatch(recordFileSnapshot({ snapshot: change.snapshot, conversationId: this.runConvId! }));
              if (assistantMessageId) {
                store.dispatch(addMessageDiff({ messageId: assistantMessageId, diff: change.diff, conversationId: this.runConvId! }));
              }
              store.dispatch(addRunEvent({
                event: {
                  id: generateId('evt'),
                  runId,
                  messageId: assistantMessageId || undefined,
                  type: 'file_change',
                  timestamp: Date.now(),
                  diffId: change.diff.id,
                },
                conversationId: this.runConvId!,
              }));
            }
            // ★ #4：本批文件改动落地后，刷新「正打开这些文件」的 editor tab（clean 自动重读盘同步 / dirty 提示不覆盖）。
            //   dynamic import 局部化（与本文件 import('./extensionManager') 同范式）；内部自带 try/catch，失败不影响主流程。
            if (attributableFileChanges.length > 0) {
              void import('./openTabSync').then(m => m.refreshOpenTabsForChanges(attributableFileChanges)).catch(() => { /* 刷新失败静默 */ });
            }
            // ★ show_artifact：与文件改动同口径——按 execContextId 消费自己桶的产物卡片，挂到当前 assistant 消息上。
            //   artifact 只是「打开已存在文件」的入口（无 diff/snapshot/审阅），故只 addMessageArtifact，不发 file_change 事件。
            const artifacts = consumeTrackedArtifacts(callContext.callId);
            for (const artifact of artifacts) {
              if (assistantMessageId) {
                store.dispatch(addMessageArtifact({ messageId: assistantMessageId, artifact, conversationId: this.runConvId! }));
              }
            }

            if (assistantMessageId) {
              store.dispatch(updateToolCallStatus({
                messageId: assistantMessageId,
                toolCallId: tc.id,
                status: stoppedAfterResult ? 'cancelled' : result.status,
                result: stoppedAfterResult ? stoppedResultText : resultText,
                structured: stoppedAfterResult ? undefined : result.data?.structured,
                artifacts: stoppedAfterResult ? undefined : result.data?.artifacts,
                taskId: result.taskId ?? undefined,
                errorCode: result.error?.code,
                unknownSideEffect: result.unknownSideEffect,
                executionTime: resolveToolExecutionTime(result, toolStartedAt),
                conversationId: this.runConvId!,
              }));
              if (result.taskId && !stoppedAfterResult) {
                const taskFinished = !['running', 'cancelling'].includes(result.status);
                store.dispatch(reconcileToolTaskStatus({
                  taskId: result.taskId,
                  status: result.status,
                  result: taskFinished ? resultText : undefined,
                  structured: taskFinished ? result.data?.structured : undefined,
                  artifacts: taskFinished ? result.data?.artifacts : undefined,
                  errorCode: result.error?.code,
                  unknownSideEffect: result.unknownSideEffect,
                  excludeToolCallId: tc.id,
                  conversationId: this.runConvId!,
                }));
              }
            }
            toolRoundOutcome.push(JSON.stringify([
              tc.function.name,
              tc.function.arguments,
              stoppedAfterResult ? 'cancelled' : result.status,
              (stoppedAfterResult ? stoppedResultText : resultText).slice(0, 4000),
              attributableFileChanges.length,
              artifacts.length,
            ]));
            if (!this.running) break;
            store.dispatch(addMessage({
              message: {
                id: generateId(),
                role: 'tool',
                content: resultText,
                timestamp: Date.now(),
              },
              conversationId: this.runConvId!,
            }));
            apiMessages.push({
              role: 'tool',
              content: resultText,
              tool_call_id: tc.id,
            });
          } catch (err: any) {
            const errorResult = `Error: ${err.message}`;
            // ★ FIX-13：工具执行失败 → 回写该 toolCall status=error + 错误信息 + 耗时（停掉 spinner、显示 ✗）。
            if (assistantMessageId) {
              store.dispatch(updateToolCallStatus({
                messageId: assistantMessageId,
                toolCallId: tc.id,
                status: this.running ? 'error' : 'cancelled',
                result: this.running ? errorResult : '已取消（生成中断）',
                executionTime: Date.now() - toolStartedAt,
                conversationId: this.runConvId!,
              }));
            }
            toolRoundOutcome.push(JSON.stringify([tc.function.name, tc.function.arguments, this.running ? 'error' : 'cancelled', errorResult.slice(0, 4000)]));
            if (this.running) {
              apiMessages.push({
                role: 'tool',
                content: errorResult,
                tool_call_id: tc.id,
              });
            }
          } finally {
            this.toolControllers.delete(toolController);
            executionRegistry.endCall(callContext.callId);
          }
        }
        if (!this.running) {
          const stoppedAt = Date.now();
          endOwnedTaskBoundary('aborted');
          store.dispatch(addRunEvent({
            event: {
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId || undefined,
              type: 'aborted',
              timestamp: stoppedAt,
            },
            conversationId: this.runConvId!,
          }));
          terminalStateRecorded = true;
          break;
        }
        const toolRoundSignature = toolRoundOutcome.join('\n');
        if (toolRoundSignature && toolRoundSignature === previousToolRoundOutcome) {
          repeatedToolRoundCount++;
        } else {
          previousToolRoundOutcome = toolRoundSignature;
          repeatedToolRoundCount = toolRoundSignature ? 1 : 0;
        }
        if (repeatedToolRoundCount >= REPEATED_TOOL_ROUND_LIMIT) {
          recordGuardStop(
            '本轮已停止重复动作',
            `Agent 连续 ${REPEATED_TOOL_ROUND_LIMIT} 轮执行了完全相同的工具动作并得到相同结果，没有产生新的文件改动或产物。Synapse 已保留当前状态并停止，避免自动续跑形成无限循环。`,
            'repeated_tool_round',
          );
          break;
        }
        // ★ M5-BPC-4：工具轮末 step 收尾钩子——fire-and-forget 评估水位触发后台预压缩（绝不 await，不阻塞循环）。
        this.evaluateBpcWater(modelContextWindow, estimateRequestInputTokens(
          appendRuntimeContext(apiMessages, buildRuntimeContextSection(Date.now())),
          toolsTokens,
        ));
        // Continue loop for next round
        continue;
      }

      // ★ M5-BPC-4：自然完成轮末 step 收尾钩子——同工具轮末，fire-and-forget 评估水位。
      this.evaluateBpcWater(modelContextWindow, estimateRequestInputTokens(
        appendRuntimeContext(apiMessages, buildRuntimeContextSection(Date.now())),
        toolsTokens,
      ));
      // No tool calls = conversation complete
      const completionBucket = selectConversationById(store.getState() as RootState, this.runConvId!);
      const hasPendingCompletionInterrupt = (completionBucket.interruptMessages?.length ?? 0) > 0;
      const pendingCompletionContinuation = hasPendingCompletionInterrupt
        ? interruptContinuationFromBoundary(completionBucket.taskBoundaries?.find((boundary: any) => boundary.status === 'active'))
        : undefined;
      queueDrainCoordinator.rememberInterruptContinuation(this.runConvId!, pendingCompletionContinuation);
      endOwnedTaskBoundary(hasPendingCompletionInterrupt ? 'interrupted' : 'done');
      completedNaturally = true;
      break;
    }

    if (!completedNaturally && this.running && round >= maxRounds && !terminalStateRecorded) {
      recordGuardStop(
        '本轮已达到模型与工具交互上限',
        `Agent 已连续执行 ${maxRounds} 轮模型与工具交互（包含任务边界和进度工具，不等于 ${maxRounds} 个业务工具）。为避免无限循环，Synapse 已停止本轮并保留现有改动、Diff 和工具结果；检查当前结果后可继续下一轮。`,
        'tool_round_limit',
      );
    }

    // ★ M4-8-S4：loop 自然完成（最终一轮无工具调用）→ 给最终答复消息挂端到端总计时徽标。
    //   只挂这一条（finalCompletedAssistantId），含本轮所有工具调用全程的总耗时；逐条 run 计时不受影响。
    //   中止 / 错误 / 达轮次上限等非自然完成态不挂（completedNaturally=false）。
    if (completedNaturally && finalCompletedAssistantId) {
      store.dispatch(updateMessageMeta({
        id: finalCompletedAssistantId,
        changes: { endToEndMs: Date.now() - loopStartedAt },
        conversationId: this.runConvId!,
      }));
    }
    } finally {
      // ★ R5 修复（问题1）：无论正常结束 / break / 抛出未捕获异常，都在 finally 统一收尾：
      // 关掉 isStreaming 闸门、清流式残留、释放 running。避免「入口点亮 isStreaming 后中途抛异常」
      // 留下 isStreaming=true + running=true 永久卡死（handleSend/autosave 再也进不来）。
      // ★ #8：收尾也路由本 run 对话桶（execContextId 在 try 入口已快照，finally 可见）。
      const completedContext = this.executionContext;
      const completedConversationId = this.runConvId!;
      const ownsCurrentRun = completedContext ? executionRegistry.isActiveRun(completedContext) : false;
      if (completedContext) releaseExecutionWorkspaceSnapshot(executionWorkspaceContextId, completedContext.runId);
      try {
      await persistRuntimeConversationSnapshot(completedConversationId).catch(() => undefined);
      this.setRunning(false);
      this.executionContext = null;
      // ★ #5/#12 修复：run 结束（正常/break/异常）从全局 running 表注销本实例。
      runningAgentLoops.delete(this);
      // 先释放真实运行态，再 dispatch 流式下降沿，让 React 本次重渲染读到 isRunning=false。
      // 原顺序先 dispatch(false)、后改 ref 属性，ref 变化不会自行触发渲染，最终答复完成后按钮会永久残留“仍在运行”。
      if (ownsCurrentRun) {
        store.dispatch(clearStreamingContent({ conversationId: completedConversationId }));
        store.dispatch(setStreaming({ value: false, conversationId: completedConversationId }));
        void bpcScheduler.publishReadyIfIdle(completedConversationId);
      }
      if (completedContext) executionRegistry.completeRun(completedContext);
      if (ownsCurrentRun) queueDrainCoordinator.requestDrain(completedConversationId, 'agent-settled');
      } finally {
      if (this.activeRunSettled === runSettled) this.activeRunSettled = null;
      resolveRunSettled();
      }
    }
  }

  /**
   * ★ 可复用的「压缩落库」核心——生成 record 批次 + 落库 + 同步持久化 store.messages 一次，返回刷新后的注入前缀 recordMd。
   *
   * ★ M5-1 压缩归一：压缩有且仅有一套，手动 /compact ＝ 自动压缩，完全同一套逻辑，仅触发方式不同：
   *   - 自动压缩（run 内 ~90% 水位 compressContext 判定 wasCompressed 后）：传入它算好的 compressedSegment
   *     （= 本轮 requestHistory 去掉最近 keepCount 条原文之前的全部），行为与抽取前【逐字节一致】。
   *   - 手动压缩（/compact 命令）：不传 compressedSegment，由本方法从 store 当前对话历史自算被压缩段
   *     （与自动同口径：过滤 tool 后保留最近 KEEP_RECENT 条原文之前的全部）。归一后 store 永不被截断，
   *     故手动自算段与自动传入段【同源】，batchSlice 单一口径。
   *
   * 返回：
   *   - 落库成功 → buildStableRecordPrefix(updated)（含本批的确定性稳定前缀）。
   *   - 无新批 / 生成失败 / 中止 → 旧 record 的稳定前缀（existingRecord 存在时）或 null（无 record 时）。
   *   - 调用方据此组装注入前缀；null 时自动路径回退到 compressContext 字符截断（手动路径据此提示无可压缩内容）。
   *
   * ★★ 职责边界（核心原则：压缩绝不删 store.messages）：
   *   本方法【只负责】「生成 record 批次 + 落库 + 同步持久化 store.messages 一次」并返回注入前缀 recordMd。
   *   它【绝不】截断 / 收敛 store.conversation.messages —— UI 与本地完整对话文件永远全量保留，压缩只产出
   *   record 批次。压缩点在 UI 上由 AgentPanel.batchDividerByIdx 分隔线呈现（读 record 各批 stepEnd → 消息下标，
   *   store 全量时天然画对位置），自动 / 手动两条路径走完全相同的注入组装（run() 外层用 compressedSegment 算
   *   注入前缀，不删 store），无需调用方再补任何「截断 / 刷新前缀」步骤。
   *
   * ★ R5 健壮性契约沿用（务必维持）：
   *   - 为本次压缩生成新建独立 AbortController 登记到 this.compressControllers，stop() 可遍历 abort；
   *     finally 只 delete 自己这个 controller（归属隔离，不误清并发 run 的 controller）。
   *   - generateBatch 失败/中止 → 不 appendBatch → record 维持压缩前状态，绝不丢 store.messages。
   *   - appendBatch 落库原子 + 幂等（见 record 链路注释），崩溃恢复一致。
   *
   * @param conversationId 目标对话 id（新对话回退 AUTOSAVE_ID 由调用方传入）。
   * @param opts.compressedSegment 被压缩段（含 tool）。自动路径必传；手动路径缺省时从 store 计算。
   * @param opts.workspaceName   工作区名（写入 record 元数据，可空）。
   * @param opts.currentModel    当前模型（仅用于压缩后同步 autosave 的 model 字段；缺省读 store）。
   */
  async compactNow(
    conversationId: string,
    opts?: {
      compressedSegment?: RecordSourceMessage[];
      workspaceName?: string;
      currentModel?: string;
      // ★ M5-BPC-2：本次压缩来源标注（透传给 generateAndAppend → appendBatch → record 批 source）。
      //   /compact 传 'manual'，run() 自动兜底传 'auto'（缺省 'auto'）。BPC 后台走 bpcGenerate（'bpc'），不经本壳。
      source?: 'auto' | 'manual' | 'bpc';
    },
  ): Promise<string | null> {
    if (!conversationId) return null;

    // ★ M5-1 压缩归一：手动 /compact 与自动压缩【完全同源】，被压缩段语义统一。
    //   - 自动路径：run 在组装时传入 compressedSegment（= 从 store 头部累计的【全量】被压段，自动压缩不截断 store）。
    //   - 手动 /compact：不传 compressedSegment，本方法从 store 当前对话历史自算。归一后 store 永不被截断，
    //     故手动自算出的也是「从 store 头部累计的【全量】被压段」——与自动路径【同源同口径】。
    //   下方 batchSlice 因此统一为 coveredEligible.slice(priorSteps) 单一口径，不再有手动/自动分支差异。
    let compressedSegment = opts?.compressedSegment;
    if (!compressedSegment) {
      // 手动入口（/compact）：保留最近原文、其余作被压段交给增量切片。
      // step 口径：排除 tool（由 agentLoop 内部管理，不计入 step）。归一后 store 已无 system 压缩摘要消息，
      //   全程只按 user/assistant 算 step，与 record 首次建立 / 自动路径 / clampToBatch 一致。
      const liveMessages = selectConversationById(store.getState() as RootState, conversationId).messages
        .filter((m: any) => m.role !== 'tool')
        .map(toRecordSourceMessage);
      // ★ M5-2 轮次地基：保留最近 KEEP_RECENT_ROUNDS 个【整轮】（向轮边界取整，绝不轮中间切，规范 §1）。
      //   原实现保留固定 4 条原文，会在轮中间切（连发 user / 一轮多 model step 时把半轮留半轮压）；
      //   现按真轮识别，从末轮往前数 KEEP_RECENT_ROUNDS 整轮作为保留段，其余整轮作被压段——
      //   使手动 /compact 的被压段尾部一定落在轮边界，与自动路径（compressContext 按轮保留）口径统一。
      const KEEP_RECENT_ROUNDS = 2;
      const liveRounds = identifyRounds(liveMessages);
      const keepFromRoundIdx = Math.max(0, liveRounds.rounds.length - KEEP_RECENT_ROUNDS);
      const keepStartIdx = liveRounds.rounds[keepFromRoundIdx]?.stepStart ?? 0;
      compressedSegment = liveMessages.slice(0, keepStartIdx);
    }

    const result = await this.compactWithOutcome(conversationId, {
      compressedSegment,
      workspaceName: opts?.workspaceName,
      currentModel: opts?.currentModel,
      source: opts?.source ?? 'auto',
    });
    if (opts?.source === 'manual' && result.outcome === 'appended') {
      await bpcScheduler.clearHardPauseAfterRecovery(conversationId);
    }
    return result.recordMd;
  }

  private async compactWithOutcome(
    conversationId: string,
    opts: {
      compressedSegment: RecordSourceMessage[];
      workspaceName?: string;
      currentModel?: string;
      source: 'auto' | 'manual' | 'bpc';
    },
  ): Promise<CompressionAppendResult> {
    const compressController = new AbortController();
    this.compressControllers.add(compressController);
    store.dispatch(setCompacting({ value: true, conversationId }));
    try {
      return await this.generateAndAppend(conversationId, {
        ...opts,
        signal: compressController.signal,
      });
    } finally {
      store.dispatch(setCompacting({ value: false, conversationId }));
      this.compressControllers.delete(compressController);
    }
  }

  /**
   * ★ M5-BPC-2：record 压缩的【纯生成 + 落库】核心（从 compactNow 抽出，无 controller 归属语义）。
   *
   *   职责 = 「getRecord → batchSlice 切片 → generateBatch → appendBatch（带 source）→ R-L4 折叠 →
   *           压缩后同步 autosave → buildStableRecordPrefix」一体。与拆分前 compactNow 主体【行为逐字节等价】，
   *   仅两点变化：(a) AbortController 由【调用方传入 opts.signal】（本方法不建 controller）；
   *              (b) appendBatch 入参带 source（透传），返回结构含 appended + 落库后 totalSteps/totalRounds。
   *
   *   三条压缩路径共用本方法（决策③）：
   *     - compactNow 薄壳（主对话自动 'auto' / 手动 'manual'）：壳建 controller 登记 compressControllers，传 signal。
   *     - bpcGenerate（后台预压 'bpc'）：scheduler 用自己的 controller 集合，传其 signal（与 compressControllers 隔离）。
   *
   *   ★ 健壮性契约（沿用 compactNow R5，务必维持）：generateBatch 失败/中止 → 不 appendBatch → record 维持
   *     压缩前状态，绝不丢 store.messages；appendBatch 落库原子 + 幂等；压缩后同步 autosave 失败吞异常不阻塞。
   *
   * @returns recordMd  注入前缀（buildStableRecordPrefix；无 record / 异常时 null，调用方据此降级字符截断）。
   * @returns appended  本次是否真落了一个新批（batchSlice 非空 + generateBatch 成功 + appendBatch 成功）。
   * @returns totalSteps/totalRounds  落库后 record 派生水位（appended=false 时取 existingRecord 水位，无 record 为 0）。
   */
  private async generateAndAppend(
    conversationId: string,
    opts: {
      compressedSegment: RecordSourceMessage[];
      workspaceName?: string;
      currentModel?: string;
      source?: 'auto' | 'manual' | 'bpc';
      signal?: AbortSignal;
    },
  ): Promise<CompressionAppendResult> {
    if (!conversationId) return { recordMd: null, appended: false, totalSteps: 0, totalRounds: 0, outcome: 'failed' };

    const workspaceName = opts.workspaceName
      || ((store.getState() as RootState) as any).workspace?.name
      || undefined;
    const currentModel = opts.currentModel
      || ((store.getState() as RootState) as any).agentSettings?.currentModel
      || '';
    const source: 'auto' | 'manual' | 'bpc' = opts.source ?? 'auto';

    let recordMd: string | null = null;
    let appended = false;
    let totalSteps = 0;
    let totalRounds = 0;
    // ★ M5-BPC 审查 M1/H1：区分「无新增段（no-new-segment，正常无需 BPC，回 idle）」与「真失败（failed，δ retry）」，
    //   不再让旧前缀 recordMd 兜底掩盖真实失败（旧逻辑 appended||recordMd 会把「generateBatch 失败但有旧 record」
    //   误判成功 → 误熔断）。默认 no-new-segment（batchSlice 空时保持）；落批成功→appended；生成/落库失败或 catch→failed。
    let outcome: 'appended' | 'no-new-segment' | 'failed' = 'no-new-segment';
    try {
      const existingRecord = await getRecord(conversationId);

      // ★ M5-1 压缩归一：batchSlice 单一口径（手动 /compact 与自动压缩同源，不再分支）。
      //   step 口径对齐 record（全程不含 tool）。record 增量水位 priorSteps（末批 stepEnd）以「对话 step0 累计」为绝对基准。
      //   归一后两条路径的 compressedSegment 都是「从 store 头部累计的【全量】被压段」（压缩绝不截断 store），
      //   故 batchSlice = coveredEligible.slice(priorSteps) 恒切出「上次已覆盖之后的新增段」——单一口径全覆盖。
      const coveredEligible = opts.compressedSegment.filter(m => m.role !== 'tool');
      const priorSteps = existingRecord?.totalSteps ?? 0;       // = 末批 stepEnd（不含 tool）
      const priorRounds = existingRecord?.totalRounds ?? 0;     // = 末批 roundEnd
      const batchSlice = coveredEligible.slice(priorSteps);     // 从全量段切掉已覆盖前缀得本批增量
      // 默认水位（appended=false 兜底）= 现有 record 水位（无 record 为 0）。
      totalSteps = priorSteps;
      totalRounds = priorRounds;

      // ★ M4-5-S2：压缩注入改用确定性稳定前缀（不随 contextWindow 动态升降级），杜绝 apiMessages[1] 前缀漂移。
      recordMd = existingRecord ? buildStableRecordPrefix(existingRecord, (store.getState() as RootState).agentSettings?.recordLayering) : null;

      if (batchSlice.length > 0) {
        // ★ M5-2 轮次地基：本批覆盖的轮号由【真轮识别】推导，替换原「user 条数 = 轮数」近似。
        //   在整个全量被压段（coveredEligible，不含 tool）上识别轮边界，本批 = coveredEligible.slice(priorSteps)，
        //   故本批末 step 的真轮号 = 被压段最后一个 step 的轮号 = identifyRounds(coveredEligible).totalRounds。
        //   - roundStart = priorRounds + 1（接续上一批末轮 +1）。
        //   - roundEnd   = 被压段最后一个 step 的真轮号（连发 user / 一轮多 model step 时正确收敛，不再虚高）。
        //   退化等价：常规交替序列上 totalRounds === user 累计条数，roundEnd 与旧口径一致；仅合并场景才收敛。
        //   ★ stepEnd 仍是半开 step 计数（= coveredEligible.length），与 appendBatch 幂等水位门口径不变；
        //     因被压段由上游（compressContext 保留整轮后的剩余 / 手动入口下方按轮取整）保证尾部落在轮边界，
        //     故 stepEnd 天然 == 末轮 stepEnd，批边界 step/round 双口径同步落在轮边界（绝不轮中间切）。
        const coveredRounds = identifyRounds(coveredEligible);
        const roundStart = priorRounds + 1;
        // ★ Codex review High#2 防护：roundEnd 取真轮数，但【钳到 >= roundStart】，防 totalRounds 倒退。
        //   正常态（priorSteps 落轮边界、record 轮口径一致）下 coveredRounds.totalRounds >= roundStart 恒成立。
        //   但若 existingRecord 是 M5-2 前生成的旧批（priorRounds 按 user 条数算、可能虚高于真轮数），
        //   连发 user 场景下真轮数 coveredRounds.totalRounds 可能 < priorRounds+1 → roundStart>roundEnd、
        //   append 后 record.totalRounds 倒退污染水位。Math.max 兜住：宁可本批 round 跨度记为 0（roundStart==roundEnd），
        //   也绝不让派生 totalRounds 倒退（round 仅用于 UI 分隔线/裁剪 sanity，不影响请求体正确性）。
        const roundEnd = Math.max(roundStart, coveredRounds.totalRounds);
        const stepStart = priorSteps;
        const stepEnd = priorSteps + batchSlice.length;
        // 旧批骨架只读概览：本批之前所有批次的 skeleton 拼接（getRecordSkeleton）。
        const priorSkeleton = existingRecord
          ? await getRecordSkeleton(conversationId)
          : '';

        const batchResult = await generateBatch({
          conversationId,
          messages: batchSlice,
          priorSkeleton,
          roundStart,
          roundEnd,
          workspaceName: workspaceName || undefined,
        }, opts.signal); // ★ M5-BPC-2：透传【调用方】signal，用户 stop / scheduler abort 时立即降级返回 null
        if (batchResult) {
          const updated = await appendBatch({
            conversationId,
            stepStart,
            stepEnd,
            roundStart,
            roundEnd,
            contentMd: batchResult.contentMd,
            skeleton: batchResult.skeleton,
            phases: batchResult.phases,
            timeSpan: batchResult.timeSpan,
            source, // ★ M5-BPC-1/2：本批来源标注随 batch 落库（'auto'|'manual'|'bpc'）
            messages: sanitizeMessagesForPersistence(
              selectConversationById(store.getState() as RootState, conversationId).messages,
            ),
          });
          // ★ 审查 HIGH（verify 二轮）：appendBatch 拒写（脏写 recordStore:482 / 并发水位门 :519）返回的是【旧 record】
          //   (existing 非空) 而非 null——BPC 稳态(已有 record)下不能只判 updated 真值，否则并发拒写会被误判 appended →
          //   假 ready → 误熔断（M1 失败模式从 recordMd 层下移到 updated 层）。必须确认水位真推进(totalSteps>stepStart)才算真落本批。
          if (updated && updated.totalSteps > stepStart) {
            appended = true;
            outcome = 'appended';
            // ★ R-L4 折叠触发：appendBatch 成功落库后，若可见（非 archived、非 meta）批数 > foldThreshold，
            //   折叠最老 foldBatchK 批为 1 元批（原文 archived 留库），再用折叠后的 record 重算注入前缀。
            //   foldOldBatches 内部对未达阈值 no-op、且全程吞异常（record 是加速层，绝不阻塞主对话）。
            const layeringForFold = (store.getState() as RootState).agentSettings?.recordLayering;
            const foldThreshold = layeringForFold?.foldThreshold ?? DEFAULT_LAYERING.foldThreshold;
            const visibleRealCount = updated.batches.filter(b => !b.archived && !b.meta).length;
            let folded: SynapseRecord | null = updated;
            if (visibleRealCount > foldThreshold) {
              folded = await foldOldBatches(conversationId, {
                foldThreshold,
                foldBatchK: layeringForFold?.foldBatchK ?? DEFAULT_LAYERING.foldBatchK,
              }) || updated; // 折叠失败（返回 null）退回未折叠 updated，不破坏注入
            }
            // ★ #14 动态分级（压缩点重算，方案①核心）：折叠后、算注入前缀前，按「hit 命中强度 × 距离当前轮远近」
            //   给各批算固化档位 renderLevel 落库。这是【唯一】重算 renderLevel 的点——把"当前轮号 + 累计 hit"快照成
            //   固化值，两次压缩间 renderRecordPrefix 只读它（不读 hit/距离/轮号）→ else 分支每轮前缀稳定、prompt cache 不破。
            //   当前轮号取 folded.totalRounds（落库后水位轮号 = 本压缩点最新轮）。enabled=false 时内部清固化值回退静态分层。
            //   全程吞异常返回 null（record 是加速层）；失败/no-op 退回折叠后的 folded，绝不破坏注入。
            const dynEnabled = layeringForFold?.dynamicLevelEnabled ?? DEFAULT_LAYERING.dynamicLevelEnabled;
            const leveled = await computeRenderLevels(conversationId, folded.totalRounds, {
              enabled: dynEnabled,
              hitWeight: layeringForFold?.hitWeight ?? DEFAULT_LAYERING.hitWeight,
              distWeight: layeringForFold?.distWeight ?? DEFAULT_LAYERING.distWeight,
              hitBase: layeringForFold?.hitBase ?? DEFAULT_LAYERING.hitBase,
              fullThreshold: layeringForFold?.fullThreshold ?? DEFAULT_LAYERING.fullThreshold,
              summaryThreshold: layeringForFold?.summaryThreshold ?? DEFAULT_LAYERING.summaryThreshold,
              distFloor: layeringForFold?.distFloor ?? DEFAULT_LAYERING.distFloor, // ★ #14 Bug1：hit 命中后距离衰减地板，透传让 UI 可调链完整
            });
            folded = leveled || folded; // 重算失败/no-op 退回 folded，不破坏注入
            // ★ M4-5-S2：同样走稳定前缀，与上方分支口径一致，保证注入前缀确定性（用折叠 + 动态分级后 record）。
            recordMd = buildStableRecordPrefix(folded, layeringForFold);
            // ★ M5-BPC-2：落库后真实派生水位（供 BPC 算 targetReplaceStep；折叠不改水位，用 updated 口径即可）。
            totalSteps = updated.totalSteps;
            totalRounds = updated.totalRounds;
            // ★ R5 修复（问题3：record 水位 vs messages 缺口）：appendBatch 已把【本批覆盖到的 step】落库，
            // 但触发本轮压缩的新 user 消息此刻可能还没被 autosave（700ms 防抖 + 压缩期同步占住事件循环，
            // 且压缩成功后立即进 while 重新点亮 isStreaming 关掉 autosave 闸门）。这里主动同步持久化一次
            // store.messages，保证「record 已覆盖的消息」在 DB 里一定存在——否则崩溃恢复后 record 水位会指向
            // messages 里不存在的 step，造成水位错位。持久化失败吞掉（record/autosave 都是加速层，绝不阻塞主对话）。
            try {
              const liveConversation = selectConversationById(store.getState() as RootState, conversationId);
              await saveAutosaveSnapshot({
                id: liveConversation.id,
                title: liveConversation.title,
                messages: liveConversation.messages,
                model: currentModel,
                assistantRuns: liveConversation.assistantRuns,
                fileSnapshots: liveConversation.fileSnapshots,
                pendingDiffs: liveConversation.pendingDiffs,
                bpcThresholdOverride: liveConversation.bpcThresholdOverride,
                compactThresholdOverride: liveConversation.compactThresholdOverride,
                timestamp: Date.now(),
              }, { runtimeOwned: true });
            } catch (saveErr) {
              console.warn('[agentLoop] 压缩后同步 autosave 失败（不阻塞主对话）:', saveErr);
            }
          } else {
            // updated 为 null（首批被拒）或 totalSteps 未推进（拒写返回旧 record、水位没动）→ 本次未真落批，视作失败
            //   （交给 scheduler δ retry / discard，绝不假 ready）。
            outcome = 'failed';
          }
        } else {
          // generateBatch 返回 null（LLM 失败 / 超时 / 被 signal 中止）→ 失败。
          outcome = 'failed';
        }
      }
    } catch (err) {
      outcome = 'failed';
      console.warn('[agentLoop] record 压缩失败，回退字符截断:', err);
    }
    return { recordMd, appended, totalSteps, totalRounds, outcome };
  }

  /**
   * ★ M5-BPC-3：后台预压缩专用【public 包装】——供 bpcScheduler 调 generateAndAppend（决策④：用 public 包装
   *   而非把 generateAndAppend 改 public，封装更干净）。scheduler 持有本 AgentLoop 实例引用（attachLoop 注入），
   *   用【自己的 controller 集合】管 signal（与本类 compressControllers 隔离，stop() 不误伤 BPC、scheduler.abort 不误伤主对话）。
   *
   *   行为 = 直接转发 generateAndAppend，source 固定 'bpc'。返回结构原样透传（含 appended + 落库后水位，
   *   scheduler 据 totalSteps/totalRounds 算 targetReplaceStep / 熔断游标）。
   *
   * @param compressedSegment 被压段（含 tool，scheduler 在 triggerSnapshot 瞬间从 store 现算 + structuredClone 深拷贝冻结）。
   * @param signal scheduler 自己 controller 的 signal（discardCurrent/abort 时触发，generateBatch 立即降级返回 null）。
   */
  async bpcGenerate(
    conversationId: string,
    compressedSegment: RecordSourceMessage[],
    signal?: AbortSignal,
    opts?: {
      workspaceName?: string;
      currentModel?: string;
      candidateId: string;
      inputHash: string;
      sourceStepCursor: number;
      sourceRoundCursor: number;
      generationRuntime: RecordGenerationRuntime;
    },
  ): Promise<{
    recordMd: string | null;
    candidate: PreparedRecordCandidate | null;
    totalSteps: number;
    totalRounds: number;
    outcome: 'prepared' | 'no-new-segment' | 'failed';
  }> {
    if (!conversationId || !opts?.candidateId || !opts.inputHash) {
      return { recordMd: null, candidate: null, totalSteps: 0, totalRounds: 0, outcome: 'failed' };
    }
    try {
      const existingRecord = await getRecord(conversationId);
      const coveredEligible = compressedSegment.filter(message => message.role !== 'tool');
      const priorSteps = existingRecord?.totalSteps ?? 0;
      const priorRounds = existingRecord?.totalRounds ?? 0;
      const batchSlice = coveredEligible.slice(priorSteps);
      if (batchSlice.length === 0) {
        return {
          recordMd: existingRecord ? buildStableRecordPrefix(existingRecord, (store.getState() as RootState).agentSettings?.recordLayering) : null,
          candidate: null,
          totalSteps: priorSteps,
          totalRounds: priorRounds,
          outcome: 'no-new-segment',
        };
      }

      const coveredRounds = identifyRounds(coveredEligible);
      const roundStart = priorRounds + 1;
      const roundEnd = Math.max(roundStart, coveredRounds.totalRounds);
      const stepStart = priorSteps;
      const stepEnd = priorSteps + batchSlice.length;
      const priorSkeleton = existingRecord ? await getRecordSkeleton(conversationId) : '';
      const workspaceName = opts.workspaceName
        || ((store.getState() as RootState) as any).workspace?.name
        || undefined;
      const batchResult = await generateBatch({
        conversationId,
        messages: batchSlice,
        priorSkeleton,
        roundStart,
        roundEnd,
        workspaceName,
        generationRuntime: opts.generationRuntime,
      }, signal);
      if (!batchResult || signal?.aborted) {
        return { recordMd: null, candidate: null, totalSteps: priorSteps, totalRounds: priorRounds, outcome: 'failed' };
      }

      const candidate = await prepareAppendCandidate({
        conversationId,
        candidateId: opts.candidateId,
        inputHash: opts.inputHash,
        sourceStepCursor: opts.sourceStepCursor,
        sourceRoundCursor: opts.sourceRoundCursor,
        stepStart,
        stepEnd,
        roundStart,
        roundEnd,
        contentMd: batchResult.contentMd,
        skeleton: batchResult.skeleton,
        phases: batchResult.phases,
        timeSpan: batchResult.timeSpan,
        source: 'bpc',
      });
      if (!candidate || signal?.aborted) {
        return { recordMd: null, candidate: null, totalSteps: priorSteps, totalRounds: priorRounds, outcome: 'failed' };
      }
      return {
        recordMd: buildStableRecordPrefix(candidate.record, (store.getState() as RootState).agentSettings?.recordLayering),
        candidate,
        totalSteps: candidate.record.totalSteps,
        totalRounds: candidate.record.totalRounds,
        outcome: 'prepared',
      };
    } catch (error) {
      console.warn('[agentLoop] BPC 候选生成失败:', error);
      return { recordMd: null, candidate: null, totalSteps: 0, totalRounds: 0, outcome: 'failed' };
    }
  }

  async finalizePublishedBpc(
    conversationId: string,
    publishedRecord: SynapseRecord,
  ): Promise<{ recordMd: string; revision: number }> {
    const layering = (store.getState() as RootState).agentSettings?.recordLayering;
    const foldThreshold = layering?.foldThreshold ?? DEFAULT_LAYERING.foldThreshold;
    const visibleRealCount = publishedRecord.batches.filter(batch => !batch.archived && !batch.meta).length;
    let finalized = publishedRecord;
    if (visibleRealCount > foldThreshold) {
      finalized = await foldOldBatches(conversationId, {
        foldThreshold,
        foldBatchK: layering?.foldBatchK ?? DEFAULT_LAYERING.foldBatchK,
      }) || finalized;
    }
    finalized = await computeRenderLevels(conversationId, finalized.totalRounds, {
      enabled: layering?.dynamicLevelEnabled ?? DEFAULT_LAYERING.dynamicLevelEnabled,
      hitWeight: layering?.hitWeight ?? DEFAULT_LAYERING.hitWeight,
      distWeight: layering?.distWeight ?? DEFAULT_LAYERING.distWeight,
      hitBase: layering?.hitBase ?? DEFAULT_LAYERING.hitBase,
      fullThreshold: layering?.fullThreshold ?? DEFAULT_LAYERING.fullThreshold,
      summaryThreshold: layering?.summaryThreshold ?? DEFAULT_LAYERING.summaryThreshold,
      distFloor: layering?.distFloor ?? DEFAULT_LAYERING.distFloor,
    }) || finalized;
    try {
      const liveConversation = selectConversationById(store.getState() as RootState, conversationId);
      await saveAutosaveSnapshot({
        id: liveConversation.id,
        title: liveConversation.title,
        messages: liveConversation.messages,
        model: liveConversation.model || (store.getState() as RootState).agentSettings?.currentModel,
        assistantRuns: liveConversation.assistantRuns,
        fileSnapshots: liveConversation.fileSnapshots,
        pendingDiffs: liveConversation.pendingDiffs,
        bpcThresholdOverride: liveConversation.bpcThresholdOverride,
        compactThresholdOverride: liveConversation.compactThresholdOverride,
        timestamp: Date.now(),
      }, { runtimeOwned: true });
    } catch (error) {
      console.warn('[agentLoop] BPC 发布后同步消息失败:', error);
    }
    return {
      recordMd: buildStableRecordPrefix(finalized, layering),
      revision: finalized.revision,
    };
  }

  getBpcPublishMessages(conversationId: string): Message[] {
    const messages = selectConversationById(store.getState() as RootState, conversationId).messages;
    return sanitizeMessagesForPersistence(messages);
  }

  /**
   * ★ M5-BPC-3：从当前 store 现算 BPC 拍快照原料（被压段 + step/round 游标），口径与手动 /compact 入口完全一致。
   *   bpcScheduler.triggerSnapshot 调本方法拿原料后 structuredClone 深拷贝冻结 compressedSegment（store 后续照常发展不影响）。
   *
   *   - compressedSegment：全历史（去 tool）保留最近 KEEP_RECENT_ROUNDS=2 个【整轮】后的被压段（向轮边界取整，
   *     与 compactNow 手动入口同款，绝不轮中间切）。压缩绝不截断 store，故这是「从 store 头部累计的全量被压段」。
   *   - snapshotStepCursor / snapshotRoundCursor：identifyRounds(过滤 tool 的全量 store.messages) 的 totalSteps/totalRounds，
   *     在拍快照【瞬间】锁定（值拷贝），与 run()/compactNow 的现算口径一致（当前无持久 step 游标，见 BPC-0）。
   *
   *   ★ 复用内部 toChatMessage/getMessageText/identifyRounds 一处口径，scheduler 不碰 store message 内部结构、不重复实现转换。
   */
  computeBpcSnapshotInput(conversationId: string): {
    compressedSegment: RecordSourceMessage[];
    snapshotStepCursor: number;
    snapshotRoundCursor: number;
  } {
    const liveMessages = selectConversationById(store.getState() as RootState, conversationId).messages
      .filter((m: any) => m.role !== 'tool')
      .map(toRecordSourceMessage);
    const liveRounds = identifyRounds(liveMessages);
    // 与 compactNow 手动入口同款：保留最近 2 整轮原文，其余作被压段（尾部落轮边界）。
    const KEEP_RECENT_ROUNDS = 2;
    const keepFromRoundIdx = Math.max(0, liveRounds.rounds.length - KEEP_RECENT_ROUNDS);
    const keepStartIdx = liveRounds.rounds[keepFromRoundIdx]?.stepStart ?? 0;
    const compressedSegment = liveMessages.slice(0, keepStartIdx);
    return {
      compressedSegment,
      // ★ 锁定瞬间游标 = 全量 store（去 tool）的 totalSteps/totalRounds（不是被压段的，是整对话当前水位）。
      snapshotStepCursor: liveRounds.totalSteps,
      snapshotRoundCursor: liveRounds.totalRounds,
    };
  }

  /**
   * ★ M5-BPC-4：run() while 循环每轮末的 BPC 水位评估钩子（fire-and-forget，绝不阻塞主循环）。
   *   口径 = 当前 while 循环已经组装完成的 apiMessages + tools schema 估算，与下一次真实发送体保持一致。
   *   不再读取 store 全量历史或上一轮 API promptTokens，避免 Record 已缩短发送视图后仍被旧历史误判为硬阈值。
   *   currentStepCursor 用 identifyRounds(过滤 tool 的 store.messages).totalSteps，与 snapshotStepCursor 同口径。
   *   scheduler.evaluateWater 内部自判 idle/冷却/熔断/阈值，本方法只负责按同口径算好水位上下文传入。
   */
  private evaluateBpcWater(modelContextWindow: number, triggerTokens: number): void {
    try {
      const state = store.getState() as RootState;
      const conversationId = this.runConvId;
      if (!conversationId) return;
      const liveMessages = selectConversationById(state, conversationId).messages
        .filter((m: any) => m.role !== 'tool')
        .map(toChatMessage);
      const liveSteps = identifyRounds(liveMessages).totalSteps;
      bpcScheduler.evaluateWater({
        triggerTokens,
        modelContextWindow,
        conversationId,
        currentStepCursor: liveSteps,
      }, this);
    } catch (err) {
      // BPC 评估失败绝不影响主对话循环。
      console.warn('[AgentLoop] evaluateBpcWater 跳过：', err);
    }
  }

}
