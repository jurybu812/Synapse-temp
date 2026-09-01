import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ExtractedToken } from '@/services/inputCommands/richInput/types';
import type { EditorFileType } from '@/services/editorFileTypes';
// ★ #6/#10：同文件多次写合并成一条累积 diff 时，按「最早 before 基线 → 最新内容」重算 hunks/增删行。
//   fileChangeTracker 对本文件是 `import type`（运行时擦除），此处反向导入纯函数无运行时循环依赖。
import { countLineChanges, buildDiffHunks } from '@/services/fileChangeTracker';
import { findMergeableMessageDiffIndex } from '@/services/diffReviewLedger';
// ★ #8 byId 真并发：AUTOSAVE_ID 作为合法 bucket key（新对话 id=null 时统一用它当桶键，与
//   execContextId 回退口径 `this.contextId || conversation.id || AUTOSAVE_ID` 一致）。本文件 re-export 供同口径复用。
import { AUTOSAVE_ID } from '@/services/conversationPersistence';

// M2-R6 附件引用层：image_url / file part 内联 base64 不再落库/发送，统一以 sha256 内容寻址引用。
//   - sha256：put 返回的内容地址，落库/发送的唯一权威；url/data 是【内存态即时预览】(blobURL/dataUrl)，落库前必清。
//   - size/mime/name：引用元数据，R4 token 估算在「未还原成 base64」时按 size 折算视觉占用，不必先 get 还原。
//   - url 仍保留：发 API 前 agentLoop 按 sha256 get 还原成真 dataUrl 填回 url（模型需要真图）。
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' }; attachmentId?: string; sha256?: string; size?: number; mime?: string; name?: string }
  | { type: 'file'; file: { filename: string; mimeType?: string; data?: string; url?: string; sha256?: string; size?: number }; attachmentId?: string };

export interface AttachmentRef {
  id: string;
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'document' | 'text' | 'archive' | 'other';
  // previewUrl / payloadUrl 为【内存态】即时预览（blobURL 或 dataUrl），落库前会被 sanitize 清掉，DB 绝不含 base64。
  previewUrl?: string;
  payloadUrl?: string;
  // M2-R6：附件实体的 sha256 内容地址（落库/发送的唯一权威引用；上传时 platform.attachment.put 返回）。
  sha256?: string;
  status: 'pending' | 'ready' | 'error' | 'sent';
  error?: string;
}

export interface ThinkingBlock {
  content: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  collapsed?: boolean;
  status: 'pending' | 'streaming' | 'complete' | 'error';
}

export type StreamState = 'idle' | 'pending' | 'streaming' | 'complete' | 'error' | 'aborted';
export type StreamModeUsed = 'real' | 'pseudo' | 'off';

/**
 * ★ show_artifact：AI 主动推给用户的「产物卡片」——指向一个【已存在的文件】，用户点卡片在中部编辑器打开。
 *   是 FileDiffSummary（文件改动 diff chip）的孪生体，但更简单：只承载「打开这个文件」所需的最小信息，
 *   不含 diff/snapshot/行数统计（产物只展示已存在文件，工具不写盘）。
 *   - path：文件路径（工具 handler 记录时的原始路径，打开链路据此 openTab）。
 *   - label：卡片显示名（缺省取文件名）。
 *   - editorType：handler 预解析的编辑器类型（resolveEditorType 按扩展名判定），打开时直接用对的查看器
 *     （office/pdf/image 等），避免一律按 'code' 打开。旧数据/未解析时 undefined → 打开链路兜底 'code'。
 */
export interface MessageArtifact {
  id: string;
  path: string;
  label: string;
  editorType?: EditorFileType;
}

/**
 * ★ task_boundary（Plan_5 §10）：Plan 模式任务边界。对话级、随对话持久化（JSON 列）。
 *   不进请求体、不参与 record 摘要、不影响压缩/轮次/token——纯 UI 层结构。steps 内联在 boundary。
 */
export interface TaskBoundaryStep {
  id: string;
  text: string;
  timestamp: number;          // ms（Date.now()）
  toolCallIds?: string[];     // 可选：本 step 关联的 toolCall id（预留）
}

/** headline/summary 的一次历史变更（★ 比 Antigravity 多做的「历史标题概括变迁」时间线）。 */
export interface TaskHeadlineHistoryEntry {
  headline: string;
  summary: string;
  timestamp: number;          // ms
}

export interface TaskBoundary {
  id: string;
  headline: string;
  summary: string;
  status: 'active' | 'done' | 'aborted';
  startedAt: number;          // ms
  endedAt?: number;           // done/aborted 时回填
  anchorMessageId?: string;   // 边界【开始】锚定的 assistant 消息 id（卡片吞消息区间上界）
  endAnchorMessageId?: string;// ★ 边界【收口】时刻最后一条消息 id（卡片吞消息区间下界；active 未收口=延伸到当前末尾）
  startRound?: number;        // 对齐 M5-2 轮次地基（可选，首版可不填）
  endRound?: number;
  steps: TaskBoundaryStep[];
  history: TaskHeadlineHistoryEntry[];  // ★ 该边界 headline/summary 变更时间线（含初始项）
}

/** 对话级「当前大标题 + 概述」镜像（顶部/卡片直接读；变更同步进 active boundary.history）。 */
export interface TaskHeadline {
  headline: string;
  summary: string;
  updatedAt: number;          // ms
}

export interface FileDiffSummary {
  id: string;
  path: string;
  changeType: 'created' | 'edited' | 'deleted';
  additions: number;
  deletions: number;
  status: 'pending' | 'accepted' | 'rejected' | 'mixed' | 'superseded';
  snapshotId?: string;
  beforeHash?: string;
  afterHash?: string;
  hunks?: FileDiffHunk[];
  /** ★ worktree 隔离（审查 HIGH）：产生此 diff 时的执行上下文 id（= ctx.contextId）。回滚/审阅据此经
   *  resolveWorktreePath 重定向到当时的 worktree，避免落到主工作区（created 误删同名文件 / edited afterHash 不匹配）。
   *  旧 diff 无此字段（undefined）→ 重定向短路 = 主工作区，行为同改造前，向后兼容。 */
  contextId?: string;
  /** 产生此 diff 的对话 id。后台对话切走后，接受/拒绝仍据此解析原对话工作区，不能跟随当前界面漂移。 */
  conversationId?: string;
  /** ★ #6/#10 合并：累积 diff 链上「最早那次写之前」的快照 id / before hash。同一文件多次写合并成一条时，
   *  before 基线恒取这个最早快照（而非相邻快照），保证 accept 落最新内容、reject 回退到【最初态】非中间态。
   *  旧 diff 无此字段 → 合并逻辑 `?? snapshotId/beforeHash` 兜底降级，向后兼容。 */
  originalSnapshotId?: string;
  originalBeforeHash?: string;
  /** ★ #6/#10 合并：本次 write_to_file 的最新落盘内容（透传 args.content），【仅供 addMessageDiff 合并时重算】，
   *  存入 pendingDiffs 前会被剥除（不持久化，避免全文件内容落库膨胀）。 */
  afterContent?: string;
  reviewError?: string;
}

export interface FileDiffHunk {
  id?: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'mixed';
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  blocks?: FileDiffBlock[];
  lines: Array<{
    type: 'context' | 'add' | 'delete';
    content: string;
    oldLine?: number;
    newLine?: number;
  }>;
}

export interface FileDiffBlock {
  id?: string;
  status?: 'pending' | 'accepted' | 'rejected';
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lineStart: number;
  lineEnd: number;
  lines: FileDiffHunk['lines'];
}

export interface AssistantRunEvent {
  id: string;
  runId: string;
  messageId?: string;
  type: 'started' | 'stream_mode' | 'content_delta' | 'thinking_delta' | 'tool_call' | 'file_change' | 'done' | 'error' | 'aborted';
  timestamp: number;
  content?: string;
  toolCallId?: string;
  diffId?: string;
  error?: string;
  streamMode?: StreamModeUsed;
  fallbackReason?: string;
}

export interface AssistantRun {
  id: string;
  messageId?: string;
  startedAt: number;
  endedAt?: number;
  model?: string;
  status: StreamState;
  streamMode?: StreamModeUsed;
  fallbackReason?: string;
  events: AssistantRunEvent[];
}

export interface FileSnapshot {
  id: string;
  path: string;
  contentHash?: string;
  content?: string;
  createdAt: number;
  reason: 'before_ai_edit' | 'manual_checkpoint' | 'rollback';
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  contentParts?: MessageContentPart[];
  attachments?: AttachmentRef[];
  /**
   * ★ M6 收尾 D1：发送时 RichTextInput.extract() 产出的有序 atomic token（{type, id, value, displayLabel?}），
   *   仅用于「编辑历史消息时无损还原 @ 高亮块」，不进 LLM 上下文（不计入 token、不影响 record 摘要）。
   *   旧消息无此字段（DB rich_tokens=NULL）→ 编辑回填降级为纯文本（与 D1 之前完全一致，非回归）。
   */
  richTokens?: ExtractedToken[];
  thinking?: ThinkingBlock;
  timestamp: number;
  model?: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  streamState?: StreamState;
  streamMode?: StreamModeUsed;
  fallbackReason?: string;
  showStreamCursor?: boolean;
  showGeneratingPlaceholder?: boolean;
  durationMs?: number;
  /**
   * ★ M4-8-S3：重连进度【瞬态】字段——退避重试期间显示「reconnect i/N」，收到实质数据/本轮收尾即清。
   *   绝不持久化：sanitizeMessagesForPersistence 显式剔除、branchConversation 子集复制时剥离，
   *   保证历史恢复后消息不带残留假「重连中」（Plan_5 风险二）。
   */
  reconnect?: { attempt: number; max: number };
  /**
   * ★ M4-8-S4：端到端总计时（ms）——整个 agent loop 完成（用户发出 → 含多轮工具调用全部完成）耗时，
   *   只挂在 loop【最终完成消息】那一条上（不在每条 run 上重复，见 Plan_5 风险四）。
   *   逐条 run 计时仍走各自的 durationMs，互不干扰。
   */
  endToEndMs?: number;
  /**
   * ★ H6（M8 第七轮反馈）：本条【用户消息】的语义小标题（≤12 字）。本轮开始时由系统模型 fire-and-forget
   *   生成（generateSubtitleFromText），供「消息导航」浮层快速跳转定位。非瞬态——随消息落库（DB subtitle 列），
   *   sanitize 黑名单不剔除天然透传。仅 user 消息生成；assistant/tool 无此字段。可由用户手动改写覆盖。
   */
  subtitle?: string;
  /** ★ H6：subtitle 生成/手改的时间戳（ms）。竞态守卫与「是否已生成」判断据此。 */
  subtitleGeneratedAt?: number;
  runId?: string;
  runEvents?: AssistantRunEvent[];
  diffs?: FileDiffSummary[];
  /**
   * ★ show_artifact：本消息附带的产物卡片（AI 主动推的「已存在文件」入口）。与 diffs 并列、互不影响——
   *   diffs 是 AI 改动的文件（带 diff/审阅），artifacts 只是 AI 让用户「看一眼这个已存在文件」（点开即在编辑器打开）。
   *   消费链由 agentLoop 紧挨 consumeTrackedFileChanges 处 consumeTrackedArtifacts + dispatch addMessageArtifact。
   */
  artifacts?: MessageArtifact[];
  rollbackSnapshotId?: string;
  error?: string;
  /**
   * ★ M3-3a：本消息关联的 Multi-AI 工作流运行实例 id（multiAI.workflowRuns[runId]）。
   *   仅 @MultiAI 工作流触发的 assistant 汇总消息带此字段；MessageBubble 据此在消息体内渲染 <WorkflowCard runId=.../>
   *   （实时四色子代理卡片），纯文本汇总 content 作为 fallback/可折叠。普通对话消息无此字段，零回归。
   *   注：workflowRuns 是运行态（不持久化），重启后该 runId 查不到 → WorkflowCard 自然回退只显示文本汇总。
   */
  workflowRunId?: string;
}

/**
 * ★ H4-2（M8 第七轮反馈）：生成中插话的【排队消息】。运行态——绝不落库（刷新/重开自然清空，
 *   不进 sanitizeMessagesForPersistence、不进任何持久化快照）。
 *   生成中用户发消息不再被静默丢弃，而是入队，本轮 agent loop 结束（isStreaming true→false 下降沿）
 *   时由 AgentPanel 取队首走正常发送逻辑发出去（自然继承 H4-1 归属开关、@/斜杠命令分流等全部链路）。
 */
export interface QueuedMessage {
  id: string;                          // 队列项稳定 id（React key + 按 id 单独取消）
  text: string;                        // 入队时刻输入框纯文本（extract().plainText）
  contentParts?: MessageContentPart[]; // 入队时刻已组装的 content parts（含图片引用）
  attachments?: AttachmentRef[];       // 入队时刻就绪附件（status='ready'，发送时转 'sent'）
  richTokens?: ExtractedToken[];       // 富文本 atomic token 锚点（编辑历史无损还原；不进 LLM 上下文）
  enqueuedAt: number;                  // 入队时间戳（ms）
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  structured?: unknown;
  artifacts?: Array<{ path: string; bytes?: number; sha256?: string }>;
  status: 'pending' | 'running' | 'cancelling' | 'success' | 'error' | 'cancelled' | 'unknown';
  taskId?: string;
  taskOwnerId?: string;
  taskRunId?: string;
  taskCallId?: string;
  errorCode?: string;
  unknownSideEffect?: boolean;
  executionTime?: number; // ms，执行耗时（success/error 时回填，供 ToolCallCard 显示）
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  requestId?: string;
  conversationId?: string;
  runId?: string;
  callId?: string;
  ownerId?: string;
  requestKind?: 'agent' | 'record' | 'title' | 'subtitle' | 'subagent' | 'workflow' | 'system';
  providerId?: string;
  modelId?: string;
  accountFingerprint?: string | null;
  credentialGeneration?: number;
  catalogGeneration?: string;
  compressionGeneration?: string;
  inputImages?: Array<{ sha256: string; mime: string; bytes: number }>;
  bodySha256?: string;
  sentAt?: number;
  updatedAt: number;
}

export type TokenCountSource = 'none' | 'stale' | 'projected' | 'api';

/**
 * ★ #8 byId 真并发：单个对话桶（PerConversation）——一份对话的【私有】运行态。
 *   多个对话各占一个桶（state.byId[id]），互不串台：A 对话的 run 在后台继续写 byId[A]，
 *   切到 B 只换 activeId、不动 byId[A]，故 A 后台写不污染 B、切回 A 看到完整结果。
 *   字段语义与改造前 ConversationState 里的【对话私有】字段逐一对应（仅从扁平顶层下沉到桶）。
 */
export interface PerConversation {
  id: string;
  title: string;
  messages: Message[];
  assistantRuns: Record<string, AssistantRun>;
  fileSnapshots: Record<string, FileSnapshot>;
  pendingDiffs: FileDiffSummary[];
  isStreaming: boolean;
  isCompacting: boolean;
  streamingContent: string;
  // ★ H4-2：生成中插话的排队消息（运行态，绝不落库；刷新/重开自然清空）。本轮结束自动发队首。
  //   重载恢复暂不启用：队列项可能持有附件 sha256，缺少“已接受为 user message / 已发起模型请求”的发送一次账本前，
  //   自动落库恢复会有重复发送或引用计数错配风险；本轮只保证运行期前台/后台 drain。
  queuedMessages: QueuedMessage[];
  // ★ Plan_7 #6：生成中【插队】消息（interrupt，运行态，绝不落库）。与 queuedMessages 是孪生双队列：
  //   - queuedMessages（queue）：本轮 agent loop 彻底结束（isStreaming true→false）才发，由 AgentPanel 空闲 effect 驱动。
  //   - interruptMessages（interrupt）：run 进行中的【下个空闲轮间】（一轮工具调用结束、下轮 API 请求前）由 agentLoop
  //     取队首插入 messages，让 AI 当前 run 的下一轮就看到——不打断正在跑的工具/流，只在轮间插。
  interruptMessages: QueuedMessage[];
  model: string;
  tokenCount: number;
  tokenCountSource: TokenCountSource;
  tokenUsage: TokenUsage | null;
  // M2-3 对话分支溯源：分支出的对话记其来源（DB 一直对，此前 store 未接回 → 渲染显示 null）。
  //   parentId = 源对话 id；branchedFromMessageId = 在源对话哪条消息处「从此分支」。非分支对话为 null。
  parentId: string | null;
  branchedFromMessageId: string | null;
  // M4-2-S4 当前对话工作区归属：以工作区 path 为稳定身份键（null = Global 无归属）。
  //   新建对话默认归当前工作区（S5 接线），恢复/分支回填，UI 改归属经 setConversationWorkspace。
  workspacePath: string | null;
  // ★ M4-6-S4 对话目标（/goal 设定）：随对话持久化（DB goal 列 + autosave）。
  //   设目标后每轮 agentLoop.run 读取并经 promptBuilder.build 注入 <current_goal> 段（每轮自动注入）。
  //   空串/undefined 视为未设目标（build 不注入该段）。clearConversation 清空、setConversation 换身份时回填。
  goal?: string;
  // ★ task_boundary（Plan_5 §10）：对话级任务边界数组 + 当前大标题镜像。随对话持久化（JSON 列）。
  //   仅 Plan 模式 + taskBoundaryEnabled 时由 AI 工具写入；clearConversation 清空、setConversation 回填。
  taskBoundaries?: TaskBoundary[];
  taskHeadline?: TaskHeadline;
  // ★ M5-BPC：本对话【后台预压缩触发水位】覆盖（留空=用全局 agentSettings.bpc.bpcThreshold）。
  //   scheduler.evaluateWater 读 effectiveBpcThreshold = conversation.bpcThresholdOverride ?? agentSettings.bpc.bpcThreshold。
  //   ★ 是 number：undefined=未覆盖；持久化/回填严禁 `x||undefined`（0 falsy 陷阱），统一 typeof==='number' 判定。
  bpcThresholdOverride?: number;
  // ★ M5-BPC：本对话【硬阻塞压缩水位】覆盖（留空=用全局 agentSettings.bpc.compactThreshold）。同 number 口径。
  compactThresholdOverride?: number;
}

/**
 * ★ #8 byId 真并发：顶层 slice = 多对话桶（byId）+ 当前活跃桶指针（activeId）+ 全局 UI 态。
 *   activeId：当前展示的对话桶 key（null = 尚无对话，读取时回退 AUTOSAVE_ID 桶）。
 *   byId：所有对话桶（含后台仍在跑的对话），key = 对话 id（新对话/草稿 = AUTOSAVE_ID）。
 *   pendingMessage：全局输入草稿；isCompacting 已下沉到对话桶，避免 A 压缩时阻塞 B。
 */
interface ConversationState extends PerConversation {
  schemaVersion: number;
  // ★ #8：当前活跃对话桶的 key（null = 尚无活跃对话，读取回退 AUTOSAVE_ID 桶）。切对话只改它（不动其它桶）。
  activeId: string | null;
  // ★ #8：所有对话桶。key = 对话 id（新对话/草稿统一 AUTOSAVE_ID）。
  byId: Record<string, PerConversation>;
  // 输入框草稿（全局 UI 态，不属于任一对话桶）：保留顶层，不随桶路由。
  pendingMessage: string;
}

const CONVERSATION_SCHEMA_VERSION = 1;

/**
 * ★ #8：构造一个全空对话桶（所有私有字段归零）。新对话、缺桶兜底、clearConversation 重置都用它。
 */
function emptyBucket(id: string): PerConversation {
  return {
    id,
    title: '新对话',
    messages: [],
    assistantRuns: {},
    fileSnapshots: {},
    pendingDiffs: [],
    isStreaming: false,
    isCompacting: false,
    streamingContent: '',
    queuedMessages: [],
    interruptMessages: [],
    model: '',
    tokenCount: 0,
    tokenCountSource: 'none',
    tokenUsage: null,
    parentId: null,
    branchedFromMessageId: null,
    workspacePath: null,
    goal: undefined,
    taskBoundaries: undefined,
    taskHeadline: undefined,
    bpcThresholdOverride: undefined,
    compactThresholdOverride: undefined,
  };
}

function invalidateTokenProjection(bucket: PerConversation, preservePrior = false): void {
  if (preservePrior && bucket.tokenCountSource !== 'none' && bucket.tokenCount > 0) {
    bucket.tokenCountSource = 'stale';
    bucket.tokenUsage = null;
    return;
  }
  bucket.tokenCount = 0;
  bucket.tokenCountSource = 'none';
  bucket.tokenUsage = null;
}

function normalizeThresholdOverride(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function reconcileThresholdOverrides(bucket: PerConversation, changed: 'bpc' | 'compact' | 'both'): void {
  const bpc = bucket.bpcThresholdOverride;
  const compact = bucket.compactThresholdOverride;
  if (typeof bpc !== 'number' || typeof compact !== 'number' || bpc <= compact - 0.05) return;
  if (changed === 'compact') {
    bucket.compactThresholdOverride = Math.min(0.95, bpc + 0.05);
  } else {
    bucket.bpcThresholdOverride = Math.max(0.4, compact - 0.05);
  }
}

/**
 * ★ #8：桶路由——按 conversationId（缺省回退 activeId，再回退 AUTOSAVE_ID）取桶；缺桶即建，永不返 undefined。
 *   所有操作【对话私有字段】的 reducer 开头统一 `const b = bucketOf(state, payload?.conversationId)`，
 *   再在 b 上做原有 find/push/赋值。conversationId 缺省时落活跃桶 → 用户手动操作（编辑/接受 diff，
 *   不带 convId）仍写当前对话，向后兼容；agentLoop 显式带 execContextId → A 的 run 永远写 byId[A]。
 */
function snapshotActiveBucket(state: ConversationState): PerConversation {
  const snapshot = {} as PerConversation;
  for (const key of Object.keys(emptyBucket(state.id)) as (keyof PerConversation)[]) {
    (snapshot as any)[key] = (state as any)[key];
  }
  return snapshot;
}

function loadActiveBucket(state: ConversationState, bucket: PerConversation): void {
  for (const key of Object.keys(bucket) as (keyof PerConversation)[]) {
    (state as any)[key] = (bucket as any)[key];
  }
}

function bucketOf(state: ConversationState, conversationId?: string): PerConversation {
  const key = conversationId ?? state.activeId;
  if (!key) throw new Error('conversationId is required before mutating conversation state');
  if (key === state.activeId) return state;
  if (!state.byId[key]) state.byId[key] = emptyBucket(key);
  return state.byId[key];
}

/**
 * ★ task_boundary 截断同步（M7 第四轮，治 review HIGH「回溯/编辑/清空截断 messages 时不清理 taskBoundaries」）：
 *   回溯/编辑/清空把 state.messages 截短后调用——以保留下来的消息为界裁剪任务边界：
 *     ① anchorMessageId 已不在保留消息里的边界整条丢弃（其锚消息被截掉了，否则会漂到末尾成孤儿僵尸卡）；
 *     ② endAnchorMessageId 落在被截区的，清掉（区间下界失效，渲染退化为延伸到当前末尾）；
 *     ③ 仍保留但 status==='active' 的收口为 done（它的 end_task_boundary 工具调用随被截轮一起撤销、
 *        永不会再执行，不收口会永久脉冲「进行中」）。
 *   ⚠️ 只在【真发生截断】时调（保留消息数 < 原数）——回溯到最后一条 = no-op，不应误收口正在进行的边界。
 */
function clampTaskBoundariesAfterTruncation(bucket: PerConversation) {
  if (!bucket.taskBoundaries || bucket.taskBoundaries.length === 0) return;
  const ids = new Set(bucket.messages.map(m => m.id));
  const now = Date.now();
  bucket.taskBoundaries = bucket.taskBoundaries.filter(b => !!b.anchorMessageId && ids.has(b.anchorMessageId));
  for (const b of bucket.taskBoundaries) {
    if (b.endAnchorMessageId && !ids.has(b.endAnchorMessageId)) b.endAnchorMessageId = undefined;
    if (b.status === 'active') { b.status = 'done'; b.endedAt = now; }
  }
}

function textToContentParts(content: string): MessageContentPart[] {
  return content ? [{ type: 'text', text: content }] : [];
}

function normalizeMessage(message: Message, restoring = false, conversationId?: string): Message {
  const content = message.content ?? '';
  const contentParts = Array.isArray(message.contentParts)
    ? message.contentParts
    : textToContentParts(content);
  const diffs = message.diffs?.map(diff => normalizeDiff(conversationId
    ? { ...diff, conversationId }
    : diff));
  // ★ 命令转圈修复（恢复路径专属）：从持久化/切换对话恢复消息时，收尾上次会话残留的「未完成态」，
  //   避免重开后工具卡片永久转圈、消息卡在 streaming。仅 restoring=true 时生效——addMessage 新加
  //   正要流式的消息走 restoring=false，绝不能被强制收尾（否则打断刚发起的流式）。
  if (restoring) {
    const toolCalls = message.toolCalls?.map(tc => {
      if (tc.status !== 'pending' && tc.status !== 'running' && tc.status !== 'cancelling') return tc;
      return tc.taskId
        ? {
            ...tc,
            status: tc.status === 'pending' ? 'running' as const : tc.status,
            result: tc.result || '正在恢复后台任务状态…',
          }
        : {
            ...tc,
            status: 'cancelled' as const,
            result: tc.result || '⚠️ 上次会话中断，工具未执行完成',
          };
    });
    const restoredStream = (message.streamState === 'streaming' || message.streamState === 'pending')
      ? 'aborted' as const
      : message.streamState;
    return { ...message, content, contentParts, diffs, toolCalls, isStreaming: false, streamState: restoredStream };
  }
  return {
    ...message,
    content,
    contentParts,
    diffs,
    streamState: message.streamState ?? (message.isStreaming ? 'streaming' : undefined),
  };
}

function normalizeAssistantRuns(
  runs: Record<string, AssistantRun>,
  messages: Message[],
): Record<string, AssistantRun> {
  const byId = new Map(messages.map(message => [message.id, message]));
  const byRunId = new Map(messages.filter(message => message.runId).map(message => [message.runId!, message]));
  const unfinished = new Set<StreamState>(['idle', 'pending', 'streaming']);

  return Object.fromEntries(Object.entries(runs).map(([runId, run]) => {
    if (!unfinished.has(run.status)) return [runId, run];

    const message = (run.messageId ? byId.get(run.messageId) : undefined) ?? byRunId.get(run.id);
    const status: StreamState = message?.streamState === 'complete'
      ? 'complete'
      : message?.streamState === 'error'
        ? 'error'
        : 'aborted';
    const terminalType: AssistantRunEvent['type'] = status === 'complete'
      ? 'done'
      : status === 'error'
        ? 'error'
        : 'aborted';
    const endedAt = message
      ? message.timestamp + Math.max(0, message.durationMs ?? 0)
      : run.endedAt ?? run.startedAt;
    const hasTerminalEvent = run.events.some(event => event.type === 'done' || event.type === 'error' || event.type === 'aborted');
    const events = hasTerminalEvent
      ? run.events
      : [...run.events, {
          id: `${run.id}:restore:${terminalType}`,
          runId: run.id,
          messageId: message?.id ?? run.messageId,
          type: terminalType,
          timestamp: endedAt,
          error: status === 'error' ? message?.content || '上一会话在错误状态结束' : undefined,
        }];

    return [runId, {
      ...run,
      messageId: message?.id ?? run.messageId,
      status,
      endedAt,
      events,
    }];
  }));
}

function buildInlineBlocks(hunk: FileDiffHunk, hunkId: string): FileDiffBlock[] {
  const blocks: FileDiffBlock[] = [];
  let startIndex: number | null = null;

  const flush = (endIndex: number) => {
    if (startIndex === null) return;
    const lines = hunk.lines.slice(startIndex, endIndex + 1);
    const oldNumbers = lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const newNumbers = lines.map(line => line.newLine).filter((line): line is number => line !== undefined);
    blocks.push({
      id: `${hunkId}:block:${blocks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`,
      status: 'pending',
      oldStart: oldNumbers[0] ?? 0,
      newStart: newNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newLines: newNumbers.length,
      lineStart: startIndex,
      lineEnd: endIndex,
      lines,
    });
    startIndex = null;
  };

  hunk.lines.forEach((line, index) => {
    if (line.type === 'context') {
      flush(index - 1);
      return;
    }
    if (startIndex === null) startIndex = index;
  });
  flush(hunk.lines.length - 1);
  return blocks;
}

function normalizeHunk(diffId: string, hunk: FileDiffHunk, index: number): FileDiffHunk {
  const hunkId = hunk.id ?? `${diffId}:hunk:${index}`;
  const defaultBlockStatus = hunk.status === 'accepted' || hunk.status === 'rejected' ? hunk.status : 'pending';
  const blocks = (hunk.blocks && hunk.blocks.length > 0 ? hunk.blocks : buildInlineBlocks(hunk, hunkId)).map((block, blockIndex) => ({
    ...block,
    id: block.id ?? `${hunkId}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
    status: block.status ?? defaultBlockStatus,
  }));
  const normalized = {
    ...hunk,
    id: hunkId,
    status: hunk.status ?? 'pending',
    blocks,
  };
  return { ...normalized, status: summarizeBlockStatus(normalized) };
}

function normalizeDiff(diff: FileDiffSummary): FileDiffSummary {
  const normalized = {
    ...diff,
    hunks: diff.hunks?.map((hunk, index) => normalizeHunk(diff.id, hunk, index)),
  };
  return { ...normalized, status: summarizeDiffStatus(normalized) };
}

function summarizeBlockStatus(hunk: FileDiffHunk): NonNullable<FileDiffHunk['status']> {
  const blocks = hunk.blocks ?? [];
  if (blocks.length === 0) return hunk.status ?? 'pending';
  if (blocks.every(block => block.status === 'accepted')) return 'accepted';
  if (blocks.every(block => block.status === 'rejected')) return 'rejected';
  if (blocks.some(block => !block.status || block.status === 'pending')) return 'pending';
  return 'mixed';
}

function summarizeDiffStatus(diff: FileDiffSummary): FileDiffSummary['status'] {
  const hunks = diff.hunks ?? [];
  if (hunks.length === 0) return diff.status;
  if (hunks.every(hunk => hunk.status === 'accepted')) return 'accepted';
  if (hunks.every(hunk => hunk.status === 'rejected')) return 'rejected';
  if (hunks.some(hunk => !hunk.status || hunk.status === 'pending')) return 'pending';
  return 'mixed';
}

function markPendingEmptyHunkStatus(hunk: FileDiffHunk, status: NonNullable<FileDiffBlock['status']>): FileDiffHunk {
  if (status !== 'accepted' && status !== 'rejected') return hunk;
  const blocks = hunk.blocks ?? [];
  if (blocks.length > 0) return hunk;
  return (hunk.status ?? 'pending') === 'pending' ? { ...hunk, status } : hunk;
}

const initialState: ConversationState = {
  ...emptyBucket(AUTOSAVE_ID),
  schemaVersion: CONVERSATION_SCHEMA_VERSION,
  // ★ #8 byId 真并发：初始无活跃对话、桶空。首次写入由 bucketOf 缺桶即建（落 AUTOSAVE_ID 桶）。
  activeId: AUTOSAVE_ID,
  byId: {},
  pendingMessage: '',
};

export const conversationSlice = createSlice({
  name: 'conversation',
  initialState,
  reducers: {
    setConversation(state, action: PayloadAction<{
      id: string;
      title: string;
      messages: Message[];
      assistantRuns?: Record<string, AssistantRun>;
      fileSnapshots?: Record<string, FileSnapshot>;
      pendingDiffs?: FileDiffSummary[];
      model?: string;
      // M2-3：分支/加载对话时回填溯源。语义为「undefined 不覆盖」——懒迁移回写、重命名回写等
      //   不带这两字段的 setConversation 不会把已有溯源清成 null（避免回写副作用抹掉分支来源）。
      //   切换/加载/分支这类「换对话身份」的入口必须显式传（含 null）以正确刷新。
      parentId?: string | null;
      branchedFromMessageId?: string | null;
      // M4-2-S4：工作区归属可选回填，沿用「undefined 不覆盖」语义——懒迁移回写等不带该字段的 setConversation
      //   不会把已有归属清成 null。切换/加载/恢复这类「换对话身份」的入口须显式传（含 null=Global）以正确刷新。
      workspacePath?: string | null;
      // ★ M4-6-S4：对话目标可选回填，沿用「'goal' in payload 才覆盖」语义——懒迁移回写等不带该字段的
      //   setConversation 不会把已设目标清掉。切换/加载/恢复这类「换对话身份」的入口须显式传（含 undefined）以正确刷新。
      goal?: string;
      // ★ M5-BPC：本对话阈值覆盖可选回填，沿用「'key' in payload 才覆盖」语义（含显式 undefined→清空）。
      //   不带则不动（懒迁移回写等不带这两字段的 setConversation 不抹掉已设覆盖）。number 口径。
      bpcThresholdOverride?: number;
      compactThresholdOverride?: number;
      taskBoundaries?: TaskBoundary[];
      taskHeadline?: TaskHeadline;
    }>) {
      // ★ #8 byId 真并发：setConversation = hydrate 该 id 的桶 + 设 activeId（既建/覆盖桶又切活跃）。
      //   桶 key = payload.id（草稿态由调用方传 AUTOSAVE_ID 口径，与 execContextId 一致）；缺桶 bucketOf 即建。
      //   原有「'key' in payload 才覆盖」语义对【桶字段】生效不变，只是把 state.xxx 换成 b.xxx。
      state.schemaVersion = CONVERSATION_SCHEMA_VERSION;
      if (state.activeId && state.activeId !== action.payload.id) {
        state.byId[state.activeId] = snapshotActiveBucket(state);
      }
      const b = state.activeId === action.payload.id
        ? state
        : (state.byId[action.payload.id] ?? emptyBucket(action.payload.id));
      b.id = action.payload.id;
      b.title = action.payload.title;
      b.messages = action.payload.messages.map((m) => normalizeMessage(m, true, action.payload.id)); // restoring：恢复对话时收尾残留未完成态（防工具卡片永久转圈）
      b.assistantRuns = normalizeAssistantRuns(action.payload.assistantRuns ?? {}, b.messages);
      b.fileSnapshots = action.payload.fileSnapshots ?? {};
      b.pendingDiffs = (action.payload.pendingDiffs ?? []).map(diff => normalizeDiff({ ...diff, conversationId: action.payload.id }));
      // ★ H4-2：换对话身份（切换/加载/分支） → 清空排队队列（运行态，绝不跨对话带过去）。
      b.queuedMessages = [];
      // ★ Plan_7 #6：换对话身份 → 一并清空插队队列（孪生 queuedMessages，防串台）。
      b.interruptMessages = [];
      b.model = action.payload.model ?? b.model;
      if ('parentId' in action.payload) b.parentId = action.payload.parentId ?? null;
      if ('branchedFromMessageId' in action.payload) {
        b.branchedFromMessageId = action.payload.branchedFromMessageId ?? null;
      }
      if ('workspacePath' in action.payload) b.workspacePath = action.payload.workspacePath ?? null;
      // ★ M4-6-S4：换对话身份时回填 goal（'goal' in payload 才覆盖，含显式 undefined→清空；不带则不动）。
      if ('goal' in action.payload) b.goal = action.payload.goal || undefined;
      // ★ task_boundary：换对话身份时回填（'key' in payload 才覆盖，含显式 undefined→清空；不带则不动）。
      if ('taskBoundaries' in action.payload) b.taskBoundaries = action.payload.taskBoundaries ?? undefined;
      if ('taskHeadline' in action.payload) b.taskHeadline = action.payload.taskHeadline ?? undefined;
      // ★ M5-BPC：换对话身份时回填阈值覆盖（'key' in payload 才覆盖；number 用 typeof 判定，绝不用 `||` 吞 0）。
      if ('bpcThresholdOverride' in action.payload) {
        const v = action.payload.bpcThresholdOverride;
        b.bpcThresholdOverride = normalizeThresholdOverride(v, 0.4, 0.9);
      }
      if ('compactThresholdOverride' in action.payload) {
        const v = action.payload.compactThresholdOverride;
        b.compactThresholdOverride = normalizeThresholdOverride(v, 0.5, 0.95);
      }
      reconcileThresholdOverrides(b, 'both');
      // ★ #8：hydrate 完桶后把它设为活跃（setConversation 既 hydrate 又切 active）。
      state.activeId = action.payload.id;
      loadActiveBucket(state, b);
      delete state.byId[action.payload.id];
    },
    // ★ #8 byId 真并发：只切 activeId、不动任何桶——「切对话不停后台 run」的关键。
    //   切走的 A 桶留内存继续被 A 的 run 写，切回 A 时直接看到后台已写好的完整内容。缺桶即建（兜底）。
    setActiveConversation(state, action: PayloadAction<string>) {
      const targetId = action.payload;
      if (!targetId) throw new Error('setActiveConversation requires a conversationId');
      if (targetId === state.activeId) return;
      if (state.activeId) state.byId[state.activeId] = snapshotActiveBucket(state);
      const target = state.byId[targetId] ?? emptyBucket(targetId);
      loadActiveBucket(state, target);
      delete state.byId[targetId];
      state.activeId = action.payload;
    },
    // ★ #8 选A（fork 重绑）：未保存对话 fork 成真 id 时【迁桶】——把 fromId 桶整体搬到 toId（含其 run 后台写入的实时内容），
    //   更新桶内 id、若 activeId 指向 fromId 则一并切到 toId。配合 agentLoop.rebindConversation(toId)（让在跑的 run 后续写入
    //   改路由 byId[toId]）+ worktreeSession.renameWorktreeContext（迁工作树），三者一起保证 fork 后不丢后台进度、不串台。
    renameConversationBucket(state, action: PayloadAction<{ fromId: string; toId: string }>) {
      const { fromId, toId } = action.payload;
      if (fromId === toId || !fromId || !toId) return;
      const src = state.activeId === fromId ? snapshotActiveBucket(state) : state.byId[fromId];
      if (!src) return;
      // 目标桶若已存在（罕见：toId 已被占用）——以源桶（含后台实时内容）为准覆盖，避免丢后台进度。
      src.id = toId;
      src.pendingDiffs = src.pendingDiffs.map(diff => ({ ...diff, conversationId: toId }));
      src.messages = src.messages.map(message => message.diffs
        ? { ...message, diffs: message.diffs.map(diff => ({ ...diff, conversationId: toId })) }
        : message);
      state.byId[toId] = src;
      delete state.byId[fromId];
      if (state.activeId === fromId) {
        state.activeId = toId;
        loadActiveBucket(state, src);
        delete state.byId[toId];
      }
    },
    // M4-2-S4：手动改当前对话工作区归属（S6/S7「移动到…」用）。null = 改归 Global。
    setConversationWorkspace(state, action: PayloadAction<string | null | { conversationId?: string; workspacePath: string | null }>) {
      // ★ #8：兼容旧调用（直接传 string|null = 当前活跃桶）与新调用（{ conversationId?, workspacePath }）。
      const p = action.payload;
      if (p === null || typeof p === 'string') {
        const b = bucketOf(state);
        b.workspacePath = p ?? null;
      } else {
        const b = bucketOf(state, p.conversationId);
        b.workspacePath = p.workspacePath ?? null;
      }
    },
    // ★ M4-6-S4：设定 / 清空当前对话目标（/goal 命令用）。空串/undefined → 清空（视为未设目标）。
    //   随对话持久化（autosave effect 依赖 conversation.goal 重落库；DB goal 列；切换/恢复回填）。
    setGoal(state, action: PayloadAction<string | undefined | { conversationId?: string; goal: string | undefined }>) {
      // ★ #8：兼容旧调用（直接传 string|undefined = 当前活跃桶）与新调用（{ conversationId?, goal }）。
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      const raw = isObj ? (p as any).goal : p;
      const next = (raw ?? '').trim();
      b.goal = next || undefined;
    },
    // ★ task_boundary（Plan_5 §10）：开新任务边界，前一个 active 自动收为 done。新边界初始 history 含一条初始项。
    beginTaskBoundary(state, action: PayloadAction<{ id: string; headline: string; summary?: string; anchorMessageId?: string; startRound?: number; at?: number; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const now = action.payload.at ?? Date.now();
      if (!b.taskBoundaries) b.taskBoundaries = [];
      for (const tb of b.taskBoundaries) {
        if (tb.status === 'active') { tb.status = 'done'; tb.endedAt = now; }
      }
      const headline = action.payload.headline;
      const summary = action.payload.summary ?? '';
      b.taskBoundaries.push({
        id: action.payload.id,
        headline, summary,
        status: 'active',
        startedAt: now,
        anchorMessageId: action.payload.anchorMessageId,
        startRound: action.payload.startRound,
        steps: [],
        history: [{ headline, summary, timestamp: now }],
      });
      b.taskHeadline = { headline, summary, updatedAt: now };
    },
    // ★ 设/更新顶部大标题+概述：刷镜像 + 给当前 active boundary.history push 一条（AI 每个小标题调一次）。
    //   无 active 时只刷镜像、不 push（history 无处挂，合理降级）。
    setTaskHeadline(state, action: PayloadAction<{ headline: string; summary?: string; at?: number; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const now = action.payload.at ?? Date.now();
      const headline = action.payload.headline;
      // ★ summary 缺省（undefined）= 不改、保留旧值；传空串 '' = 显式清空。配合 toolRegistry handler 缺省传 undefined
      //   （review MEDIUM：之前 handler 恒传 ''，把 reducer 「?? 旧值」兜底架空 → 只换标题会误清空概括 + 污染 history）。
      const summary = action.payload.summary !== undefined
        ? action.payload.summary
        : (b.taskHeadline?.summary ?? '');
      b.taskHeadline = { headline, summary, updatedAt: now };
      const active = b.taskBoundaries?.find(tb => tb.status === 'active');
      if (active) {
        active.headline = headline;
        active.summary = summary;
        // ★ 判重：与最后一条 history 完全相同则不重复 push（防重复/空变更调用撑大变迁时间线）。
        const last = active.history[active.history.length - 1];
        if (!last || last.headline !== headline || last.summary !== summary) {
          active.history.push({ headline, summary, timestamp: now });
        }
      }
    },
    // ★ 给当前 active 边界追加一条进度 step。无 active 则 no-op（AI 该先 begin）。
    appendTaskStep(state, action: PayloadAction<{ id: string; text: string; toolCallIds?: string[]; at?: number; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const active = b.taskBoundaries?.find(tb => tb.status === 'active');
      if (!active) return;
      active.steps.push({
        id: action.payload.id,
        text: action.payload.text,
        timestamp: action.payload.at ?? Date.now(),
        toolCallIds: action.payload.toolCallIds,
      });
    },
    // ★ 显式收口当前/指定边界（用户拍板：AI 显式调结束工具收口，不自动推断）。aborted=true 收为 'aborted'（红）。
    endTaskBoundary(state, action: PayloadAction<{ id?: string; aborted?: boolean; at?: number; conversationId?: string } | undefined>) {
      const p = action.payload ?? {};
      const b = bucketOf(state, p.conversationId);
      const now = p.at ?? Date.now();
      const target = p.id
        ? b.taskBoundaries?.find(tb => tb.id === p.id)
        : b.taskBoundaries?.find(tb => tb.status === 'active');
      if (!target) return;
      target.status = p.aborted ? 'aborted' : 'done';
      target.endedAt = now;
      // ★ 记录收口时刻最后一条消息 id 作为「吞消息」区间下界（卡片按 [anchor, endAnchor] 归组本边界期间的消息）。
      const lastMsg = b.messages[b.messages.length - 1];
      if (lastMsg) target.endAnchorMessageId = lastMsg.id;
    },
    // ★ M5-BPC：设定 / 清空本对话【预压触发水位】覆盖（SettingsPanel 本对话覆盖入口 / 命令用）。
    //   合法有限 number → 设；undefined/NaN/非数字 → 清空（视为未覆盖，回退全局默认）。
    //   ★ 绝不用 `x||undefined`——0 是合法 number 会被吞（虽阈值现实不为 0，留作正确口径）。随对话持久化。
    setBpcThresholdOverride(state, action: PayloadAction<number | undefined | { conversationId?: string; value: number | undefined }>) {
      // ★ #8：兼容旧调用（直接传 number|undefined = 当前活跃桶）与新调用（{ conversationId?, value }）。
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      const v = isObj ? (p as any).value : p;
      b.bpcThresholdOverride = normalizeThresholdOverride(v, 0.4, 0.9);
      reconcileThresholdOverrides(b, 'bpc');
    },
    // ★ M5-BPC：设定 / 清空本对话【硬阻塞压缩水位】覆盖。同 number 口径。
    setCompactThresholdOverride(state, action: PayloadAction<number | undefined | { conversationId?: string; value: number | undefined }>) {
      // ★ #8：兼容旧调用（直接传 number|undefined = 当前活跃桶）与新调用（{ conversationId?, value }）。
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      const v = isObj ? (p as any).value : p;
      b.compactThresholdOverride = normalizeThresholdOverride(v, 0.5, 0.95);
      reconcileThresholdOverrides(b, 'compact');
    },
    // ★ M5-1 压缩归一：原 applyManualCompact reducer 已删除。
    //   压缩有且仅有一套（手动 /compact ＝ 自动压缩，完全同一套逻辑，仅触发方式不同）：压缩【不删任何 store.messages】，
    //   只在压缩点画 batchDivider 分隔线（AgentPanel.batchDividerByIdx，读 record 各批 stepEnd → 消息下标）。
    //   原 reducer 把 state.messages 收敛为 [system 摘要, ...keep 尾] 删了 store 消息，违背核心原则「UI/本地永不删减」，
    //   故彻底删除。/compact 现只调 agentLoop.compactNow（生成 record 批次 + 落库），绝不截断 store。
    // ★ #8：addMessage 的桶路由特殊——Message 类型本身没有 conversationId，故 payload 包成
    //   { message: Message; conversationId?: string }；同时兼容旧调用（直接传 Message）。
    addMessage(state, action: PayloadAction<Message | { message: Message; conversationId?: string }>) {
      const p = action.payload as any;
      const isWrapped = p && typeof p === 'object' && 'message' in p && p.message && typeof p.message === 'object' && 'role' in p.message;
      const message: Message = isWrapped ? p.message : p;
      const b = bucketOf(state, isWrapped ? p.conversationId : undefined);
      b.messages.push(normalizeMessage(message));
      if (message.role === 'user') invalidateTokenProjection(b, true);
    },
    updateMessage(state, action: PayloadAction<{ id: string; content: string; contentParts?: MessageContentPart[]; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.content = action.payload.content;
        msg.contentParts = action.payload.contentParts ?? textToContentParts(action.payload.content);
      }
    },
    updateMessageMeta(state, action: PayloadAction<{ id: string; changes: Partial<Message>; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (msg) Object.assign(msg, action.payload.changes);
    },
    appendMessageContent(state, action: PayloadAction<{ id: string; content: string; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.content += action.payload.content;
        const parts = msg.contentParts ?? [];
        const last = parts[parts.length - 1];
        if (last?.type === 'text') {
          last.text += action.payload.content;
        } else {
          parts.push({ type: 'text', text: action.payload.content });
        }
        msg.contentParts = parts;
      }
    },
    setMessageAttachments(state, action: PayloadAction<{ id: string; attachments: AttachmentRef[]; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (msg) msg.attachments = action.payload.attachments;
    },
    appendMessageThinking(state, action: PayloadAction<{ id: string; content: string; status?: ThinkingBlock['status']; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.thinking = {
          content: `${msg.thinking?.content ?? ''}${action.payload.content}`,
          startedAt: msg.thinking?.startedAt ?? Date.now(),
          collapsed: msg.thinking?.collapsed ?? true,
          status: action.payload.status ?? 'streaming',
        };
      }
    },
    appendAssistantStreamFrame(state, action: PayloadAction<{
      id: string;
      content?: string;
      thinking?: string;
      streamMode?: StreamModeUsed;
      fallbackReason?: string;
      conversationId?: string;
    }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (!msg) return;
      if (action.payload.content) {
        msg.content += action.payload.content;
        const parts = msg.contentParts ?? [];
        const last = parts[parts.length - 1];
        if (last?.type === 'text') last.text += action.payload.content;
        else parts.push({ type: 'text', text: action.payload.content });
        msg.contentParts = parts;
      }
      if (action.payload.thinking) {
        msg.thinking = {
          content: `${msg.thinking?.content ?? ''}${action.payload.thinking}`,
          startedAt: msg.thinking?.startedAt ?? Date.now(),
          collapsed: msg.thinking?.collapsed ?? true,
          status: 'streaming',
        };
      }
      msg.streamState = 'streaming';
      msg.isStreaming = true;
      if (action.payload.streamMode !== undefined) msg.streamMode = action.payload.streamMode;
      if (action.payload.fallbackReason !== undefined) msg.fallbackReason = action.payload.fallbackReason;
    },
    setMessageStreamState(state, action: PayloadAction<{ id: string; streamState: StreamState; durationMs?: number; error?: string; streamMode?: StreamModeUsed; fallbackReason?: string; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.streamState = action.payload.streamState;
        msg.isStreaming = action.payload.streamState === 'streaming' || action.payload.streamState === 'pending';
        if (action.payload.durationMs !== undefined) msg.durationMs = action.payload.durationMs;
        if (action.payload.error !== undefined) msg.error = action.payload.error;
        if (action.payload.streamMode !== undefined) msg.streamMode = action.payload.streamMode;
        if (action.payload.fallbackReason !== undefined) msg.fallbackReason = action.payload.fallbackReason;
      }
    },
    /**
     * ★ M4-8-S3：设置/清除消息的【瞬态】重连进度。
     *   reconnect 有值 → 写入（退避重试中，气泡显示 reconnect i/N）；
     *   reconnect 为 null/undefined → 清除（收到实质数据 / 本轮收尾，提示消失）。
     *   该字段不持久化（sanitize + branch 双重剔除）。
     */
    setMessageReconnect(state, action: PayloadAction<{ id: string; reconnect: { attempt: number; max: number } | null; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.id);
      if (msg) {
        if (action.payload.reconnect) {
          msg.reconnect = action.payload.reconnect;
        } else {
          delete msg.reconnect;
        }
      }
    },
    addMessageDiff(state, action: PayloadAction<{ messageId: string; diff: FileDiffSummary; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const incoming = action.payload.diff;
      const ownerMessage = b.messages.find(message => message.id === action.payload.messageId);
      const ownerDiffIds = new Set(ownerMessage?.diffs?.map(diff => diff.id) ?? []);
      // afterContent 是合并重算所需的「本次最新落盘内容」，存储前剥除（不持久化全文件，避免落库膨胀）。
      const { afterContent, ...incomingRest } = incoming;

      // 同一条消息内的连续 write 可以合并成累积 diff；不同消息/对话轮必须保留独立 provenance，
      // 否则 Withdraw/Retry 裁掉后轮消息时找不到被错误合并回前轮的文件改动。
      //   合并条件：同 owner message、path、contextId、conversationId，且现存条为纯 pending。
      //   且需拿得到本次最新内容(afterContent)才能基于「最早基线→最新」重算；拿不到则退化为普通追加（向后兼容）。
      if (afterContent !== undefined) {
        const prevIdx = findMergeableMessageDiffIndex(b.pendingDiffs, ownerDiffIds, incoming);
        if (prevIdx >= 0) {
          const prev = b.pendingDiffs[prevIdx];
          // 原始基线：最早那次写之前的快照（沿 originalSnapshotId 链；首条用其 snapshotId 兜底）。
          const baselineSnapId = prev.originalSnapshotId ?? prev.snapshotId;
          const origBefore = (baselineSnapId ? b.fileSnapshots[baselineSnapId]?.content : undefined) ?? '';
          const { additions, deletions } = countLineChanges(origBefore, afterContent);
          const merged = normalizeDiff({
            ...incomingRest,
            id: prev.id,                                   // 复用 prev.id：React key 稳定 + msg.diffs 易定位
            changeType: origBefore === '' ? 'created' : 'edited',
            additions,
            deletions,
            hunks: buildDiffHunks(origBefore, afterContent),
            beforeHash: prev.originalBeforeHash ?? prev.beforeHash,
            afterHash: incoming.afterHash,
            snapshotId: baselineSnapId,                    // 指向最早快照 → reject 回退到【最初态】非中间态
            originalSnapshotId: baselineSnapId,
            originalBeforeHash: prev.originalBeforeHash ?? prev.beforeHash,
            contextId: prev.contextId ?? incoming.contextId,
            conversationId: prev.conversationId ?? incoming.conversationId,
          });
          b.pendingDiffs[prevIdx] = merged;
          // 同步替换挂着这条 diff 的消息里的副本（合并停留在最早那条消息上，待审浮层按 pendingDiffs 显示一条）。
          for (const m of b.messages) {
            if (!m.diffs) continue;
            const di = m.diffs.findIndex(d => d.id === prev.id);
            if (di >= 0) m.diffs[di] = merged;
          }
          return;
        }
      }

      // 无可合并 prev（或拿不到 afterContent）：正常追加，并落基线锚点（originalSnapshotId/originalBeforeHash）供后续合并。
      const seeded = normalizeDiff({
        ...incomingRest,
        originalSnapshotId: incomingRest.originalSnapshotId ?? incomingRest.snapshotId,
        originalBeforeHash: incomingRest.originalBeforeHash ?? incomingRest.beforeHash,
      });
      if (ownerMessage) {
        ownerMessage.diffs = [...(ownerMessage.diffs ?? []), seeded];
      }
      b.pendingDiffs.push(seeded);
    },
    /**
     * ★ show_artifact：把一张产物卡片挂到指定消息上（孪生 addMessageDiff，但更简单——
     *   artifact 无审阅态，故不入 pendingDiffs，只追加到该消息的 artifacts 列表）。
     */
    addMessageArtifact(state, action: PayloadAction<{ messageId: string; artifact: MessageArtifact; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.messageId);
      if (msg) {
        msg.artifacts = [...(msg.artifacts ?? []), action.payload.artifact];
      }
    },
    updateDiffStatus(state, action: PayloadAction<{ diffId: string; status: FileDiffSummary['status']; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const applyStatus = (diff: FileDiffSummary): FileDiffSummary => {
        if (diff.id !== action.payload.diffId) return diff;
        if (action.payload.status !== 'accepted' && action.payload.status !== 'rejected') {
          return { ...diff, status: action.payload.status };
        }
        const hunkStatus = action.payload.status;
        if (!diff.hunks || diff.hunks.length === 0) {
          return { ...diff, status: hunkStatus, reviewError: undefined };
        }
        const hunks = diff.hunks?.map((hunk, index) => {
          const normalized = normalizeHunk(diff.id, hunk, index);
          const blocks = normalized.blocks?.map(block => {
            const currentStatus = block.status ?? 'pending';
            return currentStatus === 'pending' ? { ...block, status: hunkStatus } : block;
          });
          const nextHunk = markPendingEmptyHunkStatus({ ...normalized, blocks }, hunkStatus);
          return { ...nextHunk, status: summarizeBlockStatus(nextHunk) };
        });
        const next = { ...diff, hunks };
        return {
          ...next,
          status: summarizeDiffStatus(next),
          reviewError: undefined,
        };
      };
      b.pendingDiffs = b.pendingDiffs.map(applyStatus);
      for (const msg of b.messages) {
        if (!msg.diffs) continue;
        msg.diffs = msg.diffs.map(applyStatus);
      }
    },
    setDiffReviewError(state, action: PayloadAction<{ diffId: string; error?: string; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const apply = (diff: FileDiffSummary): FileDiffSummary => diff.id === action.payload.diffId
        ? { ...diff, reviewError: action.payload.error }
        : diff;
      b.pendingDiffs = b.pendingDiffs.map(apply);
      for (const msg of b.messages) {
        if (msg.diffs) msg.diffs = msg.diffs.map(apply);
      }
    },
    updateHunkStatus(state, action: PayloadAction<{ diffId: string; hunkId: string; status: NonNullable<FileDiffBlock['status']>; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const apply = (diff: FileDiffSummary): FileDiffSummary => {
        if (diff.id !== action.payload.diffId || !diff.hunks) return diff;
        const next = {
          ...diff,
          hunks: diff.hunks.map((hunk, index) => {
            const id = hunk.id ?? `${diff.id}:hunk:${index}`;
            const normalized = normalizeHunk(diff.id, { ...hunk, id }, index);
            if (id !== action.payload.hunkId) return normalized;
            const blocks = normalized.blocks?.map((block, blockIndex) => ({
              ...block,
              id: block.id ?? `${id}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
              status: (block.status ?? 'pending') === 'pending' ? action.payload.status : block.status,
            }));
            return markPendingEmptyHunkStatus({ ...normalized, blocks }, action.payload.status);
          }),
        };
        const normalizedNext = {
          ...next,
          hunks: next.hunks?.map((hunk) => ({ ...hunk, status: summarizeBlockStatus(hunk) })),
        };
        return { ...normalizedNext, status: summarizeDiffStatus(normalizedNext), reviewError: undefined };
      };

      b.pendingDiffs = b.pendingDiffs.map(apply);
      for (const msg of b.messages) {
        if (!msg.diffs) continue;
        msg.diffs = msg.diffs.map(apply);
      }
    },
    updateDiffBlockStatus(state, action: PayloadAction<{ diffId: string; hunkId: string; blockId: string; status: NonNullable<FileDiffBlock['status']>; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const apply = (diff: FileDiffSummary): FileDiffSummary => {
        if (diff.id !== action.payload.diffId || !diff.hunks) return diff;
        const next = {
          ...diff,
          hunks: diff.hunks.map((rawHunk, hunkIndex) => {
            const hunk = normalizeHunk(diff.id, rawHunk, hunkIndex);
            if (hunk.id !== action.payload.hunkId) return hunk;
            const blocks = hunk.blocks?.map((block, blockIndex) => {
              const id = block.id ?? `${hunk.id}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`;
              return id === action.payload.blockId ? { ...block, id, status: action.payload.status } : { ...block, id };
            });
            const nextHunk = { ...hunk, blocks };
            return { ...nextHunk, status: summarizeBlockStatus(nextHunk) };
          }),
        };
        return { ...next, status: summarizeDiffStatus(next), reviewError: undefined };
      };

      b.pendingDiffs = b.pendingDiffs.map(apply);
      for (const msg of b.messages) {
        if (!msg.diffs) continue;
        msg.diffs = msg.diffs.map(apply);
      }
    },
    // ★ #8：addAssistantRun 的桶路由——AssistantRun 类型本身没有 conversationId，故 payload 包成
    //   { run: AssistantRun; conversationId?: string }；同时兼容旧调用（直接传 AssistantRun）。
    addAssistantRun(state, action: PayloadAction<AssistantRun | { run: AssistantRun; conversationId?: string }>) {
      const p = action.payload as any;
      const isWrapped = p && typeof p === 'object' && 'run' in p && p.run && typeof p.run === 'object' && 'events' in p.run;
      const run: AssistantRun = isWrapped ? p.run : p;
      const b = bucketOf(state, isWrapped ? p.conversationId : undefined);
      b.assistantRuns[run.id] = run;
    },
    // ★ #8：addRunEvent 的桶路由——AssistantRunEvent 类型本身没有 conversationId，故 payload 包成
    //   { event: AssistantRunEvent; conversationId?: string }；同时兼容旧调用（直接传 AssistantRunEvent）。
    addRunEvent(state, action: PayloadAction<AssistantRunEvent | { event: AssistantRunEvent; conversationId?: string }>) {
      const p = action.payload as any;
      const isWrapped = p && typeof p === 'object' && 'event' in p && p.event && typeof p.event === 'object' && 'runId' in p.event;
      const evt: AssistantRunEvent = isWrapped ? p.event : p;
      const b = bucketOf(state, isWrapped ? p.conversationId : undefined);
      const run = b.assistantRuns[evt.runId];
      if (run) {
        run.events.push(evt);
        if (evt.type === 'done') {
          run.status = 'complete';
          run.endedAt = evt.timestamp;
        }
        if (evt.type === 'stream_mode' && evt.streamMode) {
          run.streamMode = evt.streamMode;
          run.fallbackReason = evt.fallbackReason;
        }
        if (evt.type === 'error' || evt.type === 'aborted') {
          run.status = evt.type === 'error' ? 'error' : 'aborted';
          run.endedAt = evt.timestamp;
        }
      }
      if (evt.messageId) {
        const msg = b.messages.find(m => m.id === evt.messageId);
        if (msg) msg.runEvents = [...(msg.runEvents ?? []), evt];
      }
    },
    resetRunStreamEvents(state, action: PayloadAction<{ runId: string; messageId?: string; conversationId?: string }>) {
      const { runId, messageId, conversationId } = action.payload;
      const b = bucketOf(state, conversationId);
      const isStreamDelta = (event: AssistantRunEvent) => (
        event.runId === runId && (event.type === 'content_delta' || event.type === 'thinking_delta')
      );
      const run = b.assistantRuns[runId];
      if (run) run.events = run.events.filter(event => !isStreamDelta(event));
      const resolvedMessageId = messageId ?? run?.messageId;
      if (resolvedMessageId) {
        const msg = b.messages.find(message => message.id === resolvedMessageId);
        if (msg?.runEvents) msg.runEvents = msg.runEvents.filter(event => !isStreamDelta(event));
      }
    },
    // ★ #8：recordFileSnapshot 的桶路由——FileSnapshot 类型本身没有 conversationId，故 payload 包成
    //   { snapshot: FileSnapshot; conversationId?: string }；同时兼容旧调用（直接传 FileSnapshot）。
    recordFileSnapshot(state, action: PayloadAction<FileSnapshot | { snapshot: FileSnapshot; conversationId?: string }>) {
      const p = action.payload as any;
      const isWrapped = p && typeof p === 'object' && 'snapshot' in p && p.snapshot && typeof p.snapshot === 'object' && 'reason' in p.snapshot;
      const snapshot: FileSnapshot = isWrapped ? p.snapshot : p;
      const b = bucketOf(state, isWrapped ? p.conversationId : undefined);
      b.fileSnapshots[snapshot.id] = snapshot;
    },
    // ★ #8：setStreaming 的桶路由——payload 包成 { value: boolean; conversationId?: string }；
    //   同时兼容旧调用（直接传 boolean = 当前活跃桶）。
    setStreaming(state, action: PayloadAction<boolean | { value: boolean; conversationId?: string }>) {
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      b.isStreaming = isObj ? (p as any).value : p;
    },
    // ★ #13：标记前台压缩进行中（compactNow 开始置 true、finally 置 false），驱动阻塞 UI + 发送守卫。
    setCompacting(state, action: PayloadAction<boolean | { value: boolean; conversationId?: string }>) {
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? p.conversationId : undefined);
      b.isCompacting = isObj ? p.value : p;
    },
    // ★ H4-2：把一条消息加入排队队列（生成中插话）。上限护栏在调用方（AgentPanel）拦——满了不 dispatch、给提示。
    //   ★ #8：QueuedMessage 本身没有 conversationId，故 payload 包成 { message; conversationId? }；兼容旧调用（直接传 QueuedMessage）。
    enqueueMessage(state, action: PayloadAction<QueuedMessage | { message: QueuedMessage; conversationId?: string }>) {
      const p = action.payload as any;
      const isWrapped = p && typeof p === 'object' && 'message' in p && p.message && typeof p.message === 'object' && 'enqueuedAt' in p.message;
      const message: QueuedMessage = isWrapped ? p.message : p;
      const b = bucketOf(state, isWrapped ? p.conversationId : undefined);
      b.queuedMessages.push(message);
    },
    // ★ H4-2：从队列移除一条。不传 index → 删队首（本轮结束自动发后调）；传 index/id → 用户单独取消某条。
    //   ⚠️ Redux 单向流：reducer 不返回值。调用方需在 dispatch 前自行读 queuedMessages[0] 取内容，再 dequeue 移除。
    dequeueMessage(state, action: PayloadAction<{ index?: number; id?: string; conversationId?: string } | undefined>) {
      const p = action.payload ?? {};
      const b = bucketOf(state, p.conversationId);
      if (p.id !== undefined) {
        b.queuedMessages = b.queuedMessages.filter(m => m.id !== p.id);
        return;
      }
      const idx = typeof p.index === 'number' ? p.index : 0;
      if (idx >= 0 && idx < b.queuedMessages.length) {
        b.queuedMessages.splice(idx, 1);
      }
    },
    // ★ H4-2：清空整个排队队列。Stop / 切换对话 / 新建 / 分支 入口调用（防中止后乱发、防串台）。
    clearQueue(state, action: PayloadAction<{ conversationId?: string } | undefined>) {
      const b = bucketOf(state, action.payload?.conversationId);
      b.queuedMessages = [];
    },
    // ★ Plan_7 #6：把一条消息加入【插队】队列（生成中 Ctrl/Cmd+Enter 插话）。上限护栏在调用方（AgentPanel）拦。
    //   语义：run 进行中的下个空闲轮间由 agentLoop 取队首插入 messages，让 AI 当前 run 下一轮看到。
    enqueueInterrupt(state, action: PayloadAction<QueuedMessage | { message: QueuedMessage; conversationId?: string }>) {
      const p = action.payload as any;
      const isWrapped = p && typeof p === 'object' && 'message' in p && p.message && typeof p.message === 'object' && 'enqueuedAt' in p.message;
      const message: QueuedMessage = isWrapped ? p.message : p;
      const b = bucketOf(state, isWrapped ? p.conversationId : undefined);
      b.interruptMessages.push(message);
    },
    // ★ Plan_7 #6：从插队队列移除一条。不传 → 删队首（agentLoop 轮间消费后调）；传 id → 用户单独取消某条。
    //   ⚠️ Redux 单向流：reducer 不返回值。agentLoop 消费前需先读 interruptMessages[0] 取内容，再 dequeue 移除。
    dequeueInterrupt(state, action: PayloadAction<{ index?: number; id?: string; conversationId?: string } | undefined>) {
      const p = action.payload ?? {};
      const b = bucketOf(state, p.conversationId);
      if (p.id !== undefined) {
        b.interruptMessages = b.interruptMessages.filter(m => m.id !== p.id);
        return;
      }
      const idx = typeof p.index === 'number' ? p.index : 0;
      if (idx >= 0 && idx < b.interruptMessages.length) {
        b.interruptMessages.splice(idx, 1);
      }
    },
    // ★ Plan_7 #6：清空整个插队队列。Stop / 切换对话 / 新建 / 分支 入口调用（孪生 clearQueue）。
    clearInterruptQueue(state, action: PayloadAction<{ conversationId?: string } | undefined>) {
      const b = bucketOf(state, action.payload?.conversationId);
      b.interruptMessages = [];
    },
    // ★ Plan_7 #11：在两队列间移动一条消息（输入框上方三框：queue 项 ↔ interrupt 项互相切换）。
    //   原子搬移——同一项对象整体从源队列移到目标队列尾部，附件引用随项转移（不 release、refCount 守恒）。
    //   from/to 取 'queue'|'interrupt'；同名（from===to）或找不到该 id → no-op。
    moveQueueItem(state, action: PayloadAction<{ id: string; from: 'queue' | 'interrupt'; to: 'queue' | 'interrupt'; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const { id, from, to } = action.payload;
      if (from === to) return;
      const src = from === 'queue' ? b.queuedMessages : b.interruptMessages;
      const idx = src.findIndex(m => m.id === id);
      if (idx < 0) return;
      const [item] = src.splice(idx, 1);
      if (to === 'queue') b.queuedMessages.push(item);
      else b.interruptMessages.push(item);
    },
    appendStreamingContent(state, action: PayloadAction<string | { content: string; conversationId?: string }>) {
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      b.streamingContent += isObj ? (p as any).content : p;
    },
    clearStreamingContent(state, action: PayloadAction<{ conversationId?: string } | undefined>) {
      const b = bucketOf(state, action.payload?.conversationId);
      b.streamingContent = '';
    },
    setModel(state, action: PayloadAction<string | { model: string; conversationId?: string }>) {
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      const nextModel = isObj ? (p as any).model : p;
      if (b.model !== nextModel) invalidateTokenProjection(b);
      b.model = nextModel;
    },
    setTokenUsage(state, action: PayloadAction<Omit<TokenUsage, 'updatedAt'> | (Omit<TokenUsage, 'updatedAt'> & { conversationId?: string })>) {
      const p = action.payload as any;
      const promptTokens = Number(p.promptTokens);
      const completionTokens = Number(p.completionTokens);
      const totalTokens = Number(p.totalTokens);
      if (![promptTokens, completionTokens, totalTokens].every(value => Number.isFinite(value) && value >= 0)) return;
      const b = bucketOf(state, p.conversationId);
      b.tokenUsage = {
        promptTokens: Math.round(promptTokens),
        completionTokens: Math.round(completionTokens),
        totalTokens: Math.round(totalTokens),
        cacheReadTokens: p.cacheReadTokens ?? null,
        cacheWriteTokens: p.cacheWriteTokens ?? null,
        requestId: p.requestId,
        conversationId: p.conversationId,
        runId: p.runId,
        callId: p.callId,
        ownerId: p.ownerId,
        requestKind: p.requestKind,
        providerId: p.providerId,
        modelId: p.modelId,
        accountFingerprint: p.accountFingerprint,
        credentialGeneration: p.credentialGeneration,
        catalogGeneration: p.catalogGeneration,
        compressionGeneration: p.compressionGeneration,
        inputImages: p.inputImages,
        bodySha256: p.bodySha256,
        sentAt: p.sentAt,
        updatedAt: Date.now(),
      };
      b.tokenCount = Math.round(promptTokens);
      b.tokenCountSource = 'api';
    },
    setProjectedTokenCount(state, action: PayloadAction<{ count: number; conversationId?: string; allowApiOverride?: boolean }>) {
      const b = bucketOf(state, action.payload.conversationId);
      if (b.tokenCountSource === 'api' && action.payload.allowApiOverride !== true) return;
      b.tokenCount = Math.max(0, Math.round(action.payload.count));
      b.tokenCountSource = 'projected';
      b.tokenUsage = null;
    },
    // ★ #8：pendingMessage 是全局 UI 态（输入框草稿），保留顶层、不随桶路由。
    setPendingMessage(state, action: PayloadAction<string>) {
      state.pendingMessage = action.payload;
    },
    // ★ #8：清当前【活跃桶】（重置为全空桶，保留原 id 作 key）。原扁平语义「重置整个对话私有态」作用在 activeId 桶。
    //   注：activeId 本身不变（仍指向该 key），桶内容被替换为 emptyBucket——这等价于原来把顶层各字段逐一清零。
    clearConversation(state) {
      const key = state.activeId ?? AUTOSAVE_ID;
      // 重置该桶为全空（id 沿用 key；emptyBucket 已把 messages/runs/diffs/queue/workspace/goal/阈值/边界等全部归零，
      //   与原逐字段清空语义一致：title→'新对话'、parentId/branchedFromMessageId/workspacePath→null、goal/阈值/边界→undefined）。
      loadActiveBucket(state, emptyBucket(key));
    },
    setTitle(state, action: PayloadAction<string | { title: string; conversationId?: string }>) {
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      b.title = isObj ? (p as any).title : p;
    },
    // 编辑用户消息 → 修改内容 + 截断该消息之后的所有消息
    editMessage(state, action: PayloadAction<{ id: string; content: string; contentParts?: MessageContentPart[]; attachments?: AttachmentRef[]; richTokens?: ExtractedToken[]; conversationId?: string }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const idx = b.messages.findIndex(m => m.id === action.payload.id);
      if (idx >= 0) {
        b.messages[idx].content = action.payload.content;
        // ★ C6：带 contentParts/attachments 则写入（编辑保留/新增图，AgentPanel.handleEdit 已按 KEPT/REMOVED 守恒 release）；
        //   不带（旧调用）则退回纯文本（向后兼容）。
        b.messages[idx].contentParts = action.payload.contentParts ?? textToContentParts(action.payload.content);
        b.messages[idx].attachments = action.payload.attachments && action.payload.attachments.length > 0
          ? action.payload.attachments
          : undefined;
        // ★ D1：带 richTokens 则写入（编辑后用户增删的最新 token 集合）；不带（旧调用）则置 undefined。
        b.messages[idx].richTokens = action.payload.richTokens && action.payload.richTokens.length > 0
          ? action.payload.richTokens
          : undefined;
        // 截断后续消息
        const editTruncated = idx < b.messages.length - 1;
        b.messages = b.messages.slice(0, idx + 1);
        if (editTruncated) clampTaskBoundariesAfterTruncation(b);
        invalidateTokenProjection(b, true);
      }
    },
    // 回溯到某条消息（保留该消息及之前的所有消息）
    truncateAt(state, action: PayloadAction<string | { id: string; conversationId?: string }>) {
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      const targetId = isObj ? (p as any).id : p;
      const idx = b.messages.findIndex(m => m.id === targetId);
      if (idx >= 0) {
        const truncated = idx < b.messages.length - 1;
        b.messages = b.messages.slice(0, idx + 1);
        if (truncated) clampTaskBoundariesAfterTruncation(b);
        if (truncated) invalidateTokenProjection(b, true);
      }
    },
    // 删除单条消息
    deleteMessage(state, action: PayloadAction<string | { id: string; conversationId?: string }>) {
      const p = action.payload;
      const isObj = p !== null && typeof p === 'object';
      const b = bucketOf(state, isObj ? (p as any).conversationId : undefined);
      const targetId = isObj ? (p as any).id : p;
      const previousLength = b.messages.length;
      b.messages = b.messages.filter(m => m.id !== targetId);
      if (b.messages.length !== previousLength) invalidateTokenProjection(b, true);
      // ★ task_boundary：删消息可能删掉某边界的 anchor/endAnchor。清理引用被删消息的边界（anchor 没了整条丢弃，
      //   endAnchor 没了清下界）——但【不收口 active】：删单条不等于打断进行中任务（区别于回溯/编辑的整段截断）。
      if (b.taskBoundaries && b.taskBoundaries.length > 0) {
        const ids = new Set(b.messages.map(m => m.id));
        b.taskBoundaries = b.taskBoundaries.filter(tb => !tb.anchorMessageId || ids.has(tb.anchorMessageId));
        for (const tb of b.taskBoundaries) {
          if (tb.endAnchorMessageId && !ids.has(tb.endAnchorMessageId)) tb.endAnchorMessageId = undefined;
        }
      }
    },
    // ★ Plan_5 M5-3：清空所有消息（回溯到第 1 轮之前等「无任何消息保留」场景）。对话本体 id/title/goal
    //   保留，仅消息归零——区别于 clearConversation（重置整个对话）。
    clearMessages(state, action: PayloadAction<{ conversationId?: string } | undefined>) {
      const b = bucketOf(state, action.payload?.conversationId);
      b.messages = [];
      invalidateTokenProjection(b);
      // ★ task_boundary：消息归零 → 所有边界 anchor 都不在保留集 → clamp 自然全丢弃（防孤儿卡漂末尾）。
      clampTaskBoundariesAfterTruncation(b);
    },
    // ★ FIX-13：工具执行完成后回写 toolCall 的 status/result/耗时。此前 toolCall 创建为 'pending'，
    //   执行完从不回写 → ToolCallCard 永远显示 spinning（转圈不停）。按 messageId+toolCallId 定位回写。
    updateToolCallStatus(state, action: PayloadAction<{
      messageId: string;
      toolCallId: string;
      status: ToolCall['status'];
      result?: string;
      structured?: unknown;
      artifacts?: Array<{ path: string; bytes?: number; sha256?: string }>;
      executionTime?: number;
      taskId?: string;
      taskOwnerId?: string;
      taskRunId?: string;
      taskCallId?: string;
      errorCode?: string;
      unknownSideEffect?: boolean;
      conversationId?: string;
    }>) {
      const b = bucketOf(state, action.payload.conversationId);
      const msg = b.messages.find(m => m.id === action.payload.messageId);
      const tc = msg?.toolCalls?.find(t => t.id === action.payload.toolCallId);
      if (!tc) return;
      tc.status = action.payload.status;
      if (action.payload.result !== undefined) tc.result = action.payload.result;
      if (action.payload.structured !== undefined) tc.structured = action.payload.structured;
      if (action.payload.artifacts !== undefined) tc.artifacts = action.payload.artifacts;
      if (action.payload.executionTime !== undefined) tc.executionTime = action.payload.executionTime;
      if (action.payload.taskId !== undefined) tc.taskId = action.payload.taskId;
      if (action.payload.taskOwnerId !== undefined) tc.taskOwnerId = action.payload.taskOwnerId;
      if (action.payload.taskRunId !== undefined) tc.taskRunId = action.payload.taskRunId;
      if (action.payload.taskCallId !== undefined) tc.taskCallId = action.payload.taskCallId;
      tc.errorCode = action.payload.errorCode;
      tc.unknownSideEffect = action.payload.unknownSideEffect ?? false;
    },
    reconcileToolTaskStatus(state, action: PayloadAction<{
      taskId: string;
      status: ToolCall['status'];
      result?: string;
      structured?: unknown;
      artifacts?: Array<{ path: string; bytes?: number; sha256?: string }>;
      executionTime?: number;
      errorCode?: string;
      unknownSideEffect?: boolean;
      excludeToolCallId?: string;
      taskOwnerId?: string;
      taskRunId?: string;
      taskCallId?: string;
      conversationId?: string;
    }>) {
      const bucket = bucketOf(state, action.payload.conversationId);
      for (const message of bucket.messages) {
        for (const toolCall of message.toolCalls ?? []) {
          const matchesTask = toolCall.taskId === action.payload.taskId
            || (!toolCall.taskId && Boolean(action.payload.taskCallId) && toolCall.id === action.payload.taskCallId);
          if (toolCall.id === action.payload.excludeToolCallId || !matchesTask) continue;
          toolCall.taskId = action.payload.taskId;
          if (action.payload.taskOwnerId !== undefined) toolCall.taskOwnerId = action.payload.taskOwnerId;
          if (action.payload.taskRunId !== undefined) toolCall.taskRunId = action.payload.taskRunId;
          if (action.payload.taskCallId !== undefined) toolCall.taskCallId = action.payload.taskCallId;
          toolCall.status = action.payload.status;
          if (action.payload.result !== undefined) toolCall.result = action.payload.result;
          if (action.payload.structured !== undefined) toolCall.structured = action.payload.structured;
          if (action.payload.artifacts !== undefined) toolCall.artifacts = action.payload.artifacts;
          if (action.payload.executionTime !== undefined) toolCall.executionTime = action.payload.executionTime;
          toolCall.errorCode = action.payload.errorCode;
          toolCall.unknownSideEffect = action.payload.unknownSideEffect ?? false;
        }
      }
    },
    settleRecoveredToolTaskBoundaries(state, action: PayloadAction<{ conversationId?: string; at?: number } | undefined>) {
      const bucket = bucketOf(state, action.payload?.conversationId);
      const activeBoundaries = bucket.taskBoundaries?.filter(boundary => boundary.status === 'active') ?? [];
      if (activeBoundaries.length === 0) return;
      const now = action.payload?.at ?? Date.now();
      for (const boundary of activeBoundaries) {
        const anchoredStart = boundary.anchorMessageId
          ? bucket.messages.findIndex(message => message.id === boundary.anchorMessageId)
          : -1;
        const startIndex = anchoredStart >= 0
          ? anchoredStart
          : bucket.messages.findIndex(message => message.timestamp >= boundary.startedAt);
        if (startIndex < 0) continue;
        const anchoredEnd = boundary.endAnchorMessageId
          ? bucket.messages.findIndex(message => message.id === boundary.endAnchorMessageId)
          : -1;
        const endIndex = anchoredEnd >= startIndex ? anchoredEnd : bucket.messages.length - 1;
        const scopedTaskCalls = bucket.messages
          .slice(startIndex, endIndex + 1)
          .flatMap(message => message.toolCalls ?? [])
          .filter(toolCall => Boolean(toolCall.taskId));
        if (scopedTaskCalls.length === 0) continue;
        const hasUnfinished = scopedTaskCalls.some(toolCall => (
          toolCall.status === 'pending' || toolCall.status === 'running' || toolCall.status === 'cancelling'
        ));
        if (hasUnfinished) continue;
        const hasProblemTerminal = scopedTaskCalls.some(toolCall => toolCall.status !== 'success');
        boundary.status = hasProblemTerminal ? 'aborted' : 'done';
        boundary.endedAt = now;
        const lastScopedMessage = bucket.messages[endIndex];
        if (lastScopedMessage && !boundary.endAnchorMessageId) boundary.endAnchorMessageId = lastScopedMessage.id;
      }
    },
  },
});

export const {
  setConversation, setActiveConversation, renameConversationBucket, setConversationWorkspace, setGoal,
  beginTaskBoundary, setTaskHeadline, appendTaskStep, endTaskBoundary,
  setBpcThresholdOverride, setCompactThresholdOverride, addMessage, updateMessage,
  updateMessageMeta, appendMessageContent, setMessageAttachments,
  appendMessageThinking, appendAssistantStreamFrame, setMessageStreamState, setMessageReconnect,
  addMessageDiff, addMessageArtifact, updateDiffStatus, setDiffReviewError, updateHunkStatus, updateDiffBlockStatus, addAssistantRun, addRunEvent, resetRunStreamEvents, recordFileSnapshot,
  setStreaming, setCompacting, appendStreamingContent, clearStreamingContent,
  enqueueMessage, dequeueMessage, clearQueue,
  enqueueInterrupt, dequeueInterrupt, clearInterruptQueue, moveQueueItem,
  setModel, setTokenUsage, setProjectedTokenCount, setPendingMessage, clearConversation, setTitle,
  editMessage, truncateAt, deleteMessage, clearMessages, updateToolCallStatus, reconcileToolTaskStatus, settleRecoveredToolTaskBoundaries,
} = conversationSlice.actions;

// ★ #8 byId 真并发：稳定的全空桶常量——selectActiveConversation 兜底返回它（而非每次 new emptyBucket），
//   避免「activeId 桶不存在」时每次返回新引用破坏 React/reselect memo。Object.freeze 防误改这份共享空桶。
const EMPTY_BUCKET: Readonly<PerConversation> = Object.freeze(emptyBucket(AUTOSAVE_ID));

/**
 * ★ #8 byId 真并发：读取当前【活跃对话桶】的 selector（其它组件细粒度订阅活跃桶时用）。
 *   activeId 缺省回退 AUTOSAVE_ID 桶；桶不存在（尚未 hydrate）时返回稳定的 EMPTY_BUCKET 常量（引用稳定，不破 memo）。
 *   ⚠️ 返回值可能是 frozen 空桶 —— 调用方只读，不要原地改它（改要走 dispatch reducer）。
 */
export const selectActiveConversation = (state: { conversation: ConversationState }): PerConversation => {
  return state.conversation.activeId ? state.conversation : EMPTY_BUCKET;
};

export const selectConversationById = (
  state: { conversation: ConversationState },
  conversationId: string,
): PerConversation => {
  if (!conversationId) throw new Error('selectConversationById requires a conversationId');
  if (state.conversation.activeId === conversationId) return state.conversation;
  return state.conversation.byId[conversationId] ?? EMPTY_BUCKET;
};

// ★ #8：re-export AUTOSAVE_ID（本文件桶键口径），供其它模块统一从 slice 取同一口径桶键。
export { AUTOSAVE_ID };
