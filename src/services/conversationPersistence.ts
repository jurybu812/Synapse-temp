import { platform } from '@/platform';
import type { AssistantRun, FileDiffSummary, FileSnapshot, Message, TaskBoundary, TaskHeadline } from '@/store/slices/conversation';
import {
  sanitizeMessagesForPersistence,
  releaseMessageAttachments,
  migrateMessagesAttachments,
  rollbackMigratedShas,
  collectMessageShas,
} from './attachmentRefs';
import { copyRecord, copyRecordFrom } from './recordStore';
import type { SynapseRecord } from './recordStore';
import { identifyRounds } from './roundBoundary';
// ★ Plan_5 M5-5 分支：cutIdx 向轮边界取整（与回溯/重试同一套共享 helper 口径），分支点是 user 时
//   该 user 整轮不进子集、改回填新对话输入框待发（规范 §4「新对话=老对话回溯到分支点后的状态」）。
import { computeRoundTruncation } from './roundTruncation';

export const CONVERSATION_SCHEMA_VERSION = 1;
export const AUTOSAVE_ID = 'autosave-current';
const AUTOSAVE_KEY = 'synapse_autosave';
const pendingAutosaveWrites = new Set<Promise<void>>();

export interface AutosaveWriteOptions {
  /** AgentLoop 的归属写入：正式对话可跨页面切换持久化，但不覆盖全局恢复镜像。 */
  runtimeOwned?: boolean;
}

export interface ClearAutosaveOptions {
  /** promotion 释放 SQLite message 主键前保留 localStorage 恢复镜像，真实源落库成功后再清。 */
  preserveLocalMirror?: boolean;
}

// ★ M2-6 切换闸门：切换/新建对话流程是异步多 await（saveCurrentToHistory→loadConversationSnapshot→
//   setConversation），其间若已 fork autosave 成真实 id 并 clearAutosaveSnapshot()，AgentPanel 的 700ms
//   autosave debounce 仍可能以「切走前对话的 id=null/AUTOSAVE_ID」迟到触发，把 AUTOSAVE_ID 行重新写回
//   （复活已 fork 的草稿）→ 下次启动 loadAutosaveSnapshot 误把它当上次对话恢复、mode 归属错乱。
//   切换/新建期间置闸，saveAutosaveSnapshot 落 AUTOSAVE_ID 行时若闸门开启则直接跳过——把这条竞态的封堵
//   收进持久化层，调用方只需 begin/endConversationSwitch 包住切换流程，避免散落的跨组件 ref。
//   用计数器（非布尔）记重入：并发/嵌套的切换+分支各自 begin/end 配对，只有全部结束才真正落闸解除，
//   避免后完成者的 end 提前给前者解闸而漏掉竞态窗口。
let conversationSwitchDepth = 0;
let conversationSwitchEpoch = 0;
export function beginConversationSwitch(): number {
  conversationSwitchDepth += 1;
  conversationSwitchEpoch += 1;
  return conversationSwitchEpoch;
}
export function endConversationSwitch(): void {
  conversationSwitchDepth = Math.max(0, conversationSwitchDepth - 1);
}
export function isConversationSwitching(): boolean {
  return conversationSwitchDepth > 0;
}
export function isConversationSwitchCurrent(epoch: number): boolean {
  return epoch === conversationSwitchEpoch;
}
const LEGACY_CONVERSATIONS_KEY = 'synapse_conversations';
const LEGACY_CONVERSATION_METADATA_KEY = 'synapse:conversation:metadata';

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: number;
  messageCount: number;
  model: string;
  archived?: boolean;
  tags?: string[];
  // M3-1a：子代理对话标记。普通历史列表默认过滤掉（listConversationSummaries），仅 M3-3 卡片专门读取。
  isSubAgent?: boolean;
  // M4-2-S4 工作区归属：path 作键（null = Global 无归属）。S6 左侧栏据此显示工作区小标记并按归属过滤。
  workspacePath?: string | null;
  parentId?: string | null;
  branchedFromMessageId?: string | null;
}

export interface ConversationSnapshot {
  id?: string | null;
  title?: string;
  model?: string;
  // M2-6 对话级元数据：每个对话记自己的 agent 模式 / 思考层级（真相在 agentSettings 镜像，落库随对话存）。
  //   保存时由调用方填入当前 agentSettings.mode / reasoningEffort；undefined 时持久化层不覆盖已有行的旧值。
  mode?: string;
  reasoningEffort?: string;
  archived?: boolean;
  tags?: string[];
  messages: Message[];
  assistantRuns?: Record<string, AssistantRun>;
  fileSnapshots?: Record<string, FileSnapshot>;
  pendingDiffs?: FileDiffSummary[];
  timestamp?: number;
  // M2-3 对话分支溯源：仅 fork 出的新对话携带；普通保存为 undefined（落 NULL）。
  parentId?: string | null;
  branchedFromMessageId?: string | null;
  // M3-1a 真子代理：子代理跑完落库的独立 conversation 带 true（+ parentId=主对话 id），供卡片点进查看。
  //   普通对话保存为 undefined（落默认 false），不进 Redux 当前对话 slice、不污染主对话 UI。
  isSubAgent?: boolean;
  // M4-2-S3 工作区归属：以工作区 path 为稳定身份键（null=Global 无归属）。
  //   undefined 时 update 路径不覆盖既有归属（沿用 mode/reasoningEffort 的「undefined 不动」语义）。
  workspacePath?: string | null;
  // ★ M4-6-S4 对话目标（/goal）：随对话落 DB goal 列（缺列降级跳过）。
  //   undefined 时 update 路径不覆盖既有 goal（沿用 mode/workspacePath 的「undefined 不动」语义）；
  //   显式空串 '' 表示清空目标。
  goal?: string;
  // ★ M5-BPC 本对话阈值覆盖（DB bpc_threshold_override / compact_threshold_override REAL 列；缺列降级跳过）。
  //   undefined 时 update 路径不覆盖既有值（沿用 goal 的「undefined 不动」语义）。number 口径——
  //   ★ 落库/回填严禁 `x||null` 吞 0：用 typeof==='number'&&isFinite 判定（虽阈值现实不为 0，留作正确口径）。
  bpcThresholdOverride?: number;
  compactThresholdOverride?: number;
  // ★ task_boundary（Plan_5 §10）：对话级任务边界数组 + 大标题镜像，随对话落 DB JSON 列（缺列降级跳过）。
  //   undefined 时 update 路径不覆盖既有值（沿用 goal/workspacePath 的「undefined 不动」语义）。
  taskBoundaries?: TaskBoundary[];
  taskHeadline?: TaskHeadline;
  // ★ M4-2-S1 systemTouch（控制位，不落库为数据列）：true 时本次保存不刷 updated_at。
  //   用于「切走对话的自动保存」——系统性保存不应改变用户感知的排序时间（治问题9）。
  systemTouch?: boolean;
}

interface PlatformSnapshotMetadata {
  title: string;
  model?: string;
  mode?: string;
  reasoningEffort?: string;
  schemaVersion: number;
  lastMessage: string;
  assistantRuns: Record<string, AssistantRun>;
  fileSnapshots: Record<string, FileSnapshot>;
  pendingDiffs: FileDiffSummary[];
  archived?: boolean;
  tags?: string[];
  parentId?: string | null;
  branchedFromMessageId?: string | null;
  isSubAgent?: boolean;
  workspacePath?: string | null;
  goal?: string;
  bpcThresholdOverride?: number | null;
  compactThresholdOverride?: number | null;
  taskBoundaries?: TaskBoundary[];
  taskHeadline?: TaskHeadline;
}

type PlatformPersistedMessage = Message & { conversationId: string };

type AtomicConversationApi = typeof platform.conversation & {
  saveSnapshot?: (data: {
    id: string;
    metadata: PlatformSnapshotMetadata;
    messages: PlatformPersistedMessage[];
    systemTouch?: boolean;
  }) => Promise<unknown>;
};

export interface ConversationListFilters {
  query?: string;
  archived?: 'all' | 'active' | 'archived';
  tags?: string[];
  limit?: number;
  // M4-2-S3 工作区归属三态过滤：
  //   - workspacePath 为具体 path → 只显该工作区对话；
  //   - globalOnly=true → 只显无归属（workspace_path IS NULL）的「全局对话」；
  //   - 两者都不传 → 不加 workspace 条件，显示全部。
  workspacePath?: string | null;
  globalOnly?: boolean;
}

export interface ConversationExportBundle {
  version: number;
  exportedAt: string;
  filters?: ConversationListFilters;
  conversations: Array<{
    summary: ConversationSummary;
    snapshot: ConversationSnapshot | null;
  }>;
}

export function createConversationId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生成一条新消息 id。
 * ★ M2-3 分支主键修复：messages.id 是全局 UNIQUE 主键。分支把消息复制成【独立新对话】时，
 *   若复用源 message.id，INSERT 会撞 `UNIQUE constraint failed: messages.id`。
 *   故复制时每条消息必须换新 id（branchedFromMessageId 仍指向源原 id，见 branchConversation）。
 *
 * ★ 审查 issue①②根治：原实现 `msg_<ts>_<6位base36随机>` 的唯一性在【同批紧循环 map】里只剩随机后缀一个维度
 *   （所有 Date.now() 落同毫秒），36^6 ≈ 21.7 亿空间——既可能同批自撞（生日悖论，长对话非零概率），
 *   也可能撞库里任意历史 message.id（全库越满概率越高），而 replaceMessages 是纯 INSERT（撞则整批事务回滚→分支失败）。
 *   改用 crypto.randomUUID()（122 位随机，全库碰撞概率趋于 0），同时治同批自撞与跨行撞，且与 attachment sha 体系风格自洽。
 *   非安全上下文 / 旧环境无 randomUUID 时回退到「时间戳 + 双段随机」高熵后缀（仍由 branchConversation 内 Set 兜底去重）。
 */
function createMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `msg_${uuid}`;
  // Fallback（无 crypto.randomUUID 的环境）：双段随机扩大熵，降低同毫秒同后缀概率。
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ★ M5-1 压缩归一 · 遗留 system 摘要清理（入口兜底，治本）。
 *
 * 旧版 applyManualCompact 会把手动 /compact 的压缩摘要【物化成一条 role='system' 消息】（id 形如 `compact_*`）
 * push 进 store.messages，并经 sanitizeMessagesForPersistence 持久化进本地 DB（该函数不按 role 过滤）。
 * M5-1 归一后：
 *   - MessageBubble 删除了 role==='system' 渲染分支 → 遗留 system 摘要会掉到通用气泡分支，被当成 AI 正文铺出（视觉突兀、误导）。
 *   - agentLoop 的 step 口径（requestHistory / compactNow coveredEligible）已去掉 `role!=='system'` 特判 →
 *     存量遗留 system 消息会被多计一个 step，使 record stepEnd/priorSteps 与 batchSlice / batchDivider 下标错位。
 *
 * 两处问题【同根源】：store 里仍残留旧 compact_* system 消息。最干净的修法是在【所有对话加载入口】一次性过滤掉它，
 * 归一后 store 即恒无 system 消息——MessageBubble 删除分支无回归、agentLoop 单一 step 口径自洽、batchDivider 下标正确，
 * 无需在任何 filter 里再特判 system。原文不丢（摘要本就是历史的冗余物化，删掉后压缩点改由 batchDivider「已压缩」分隔线呈现）。
 *
 * 精确匹配（role==='system' 且 id 以 `compact` 开头）：只清旧压缩摘要，不误伤任何其它潜在 system 消息。
 */
function stripLegacyCompactMessages(messages: Message[]): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const filtered = messages.filter(
    m => !(m.role === 'system' && typeof m.id === 'string' && m.id.startsWith('compact')),
  );
  // 无遗留则返回原引用（不制造无谓新数组）。
  return filtered.length === messages.length ? messages : filtered;
}

export async function saveAutosaveSnapshot(
  snapshot: ConversationSnapshot,
  options: AutosaveWriteOptions = {},
): Promise<void> {
  const id = snapshot.id || AUTOSAVE_ID;
  // ★ M2-6 切换竞态封堵（本轮收紧，把 mode/reasoningEffort 一并纳入保护）：
  //   切换/新建/分支流程进行中（begin~endConversationSwitch 窗口），丢弃【任何 id】的被动 autosave 写入，
  //   而非仅挡 AUTOSAVE_ID 镜像。原因：切走对话时 AgentPanel 的 700ms autosave debounce 可能在
  //   「setConversation(刚加载对话) 已生效、但 setReasoningEffort(该对话 DB 值) 尚未在同批 render 落定」的
  //   窗口到点，用【全局旧 reasoningEffort】update 回刚加载对话的真实 id 行 → 把 DB 里该对话存的 high 冲成 auto
  //   （真机 A2：high→auto）。saveAutosaveSnapshot 是唯一的被动 autosave 入口；切换前 saveCurrentToHistory
  //   已主动把切走对话落库、切换后依赖变化会重新触发 debounce，故切换窗口内丢弃这一拍 autosave 不丢数据，
  //   却能堵死「加载瞬间用全局旧值回写覆盖刚加载对话」的覆盖点（mode 同享此保护，不破坏 mode 既有行为）。
  //   主动落库（saveConversationSnapshot / handleNewConversation / branch promotion）走 persistPlatformSnapshot，
  //   不经此函数，不受闸门影响——它们本就该落库。
  if (isConversationSwitching() && !(options.runtimeOwned && id !== AUTOSAVE_ID)) return;
  const timestamp = snapshot.timestamp ?? Date.now();
  // M2-R6：落库前剥掉任何残留 base64（持 sha256 引用即清内联 data:），localStorage / 平台两条路都净化。
  const sanitizedMessages = sanitizeMessagesForPersistence(snapshot.messages);
  const normalized = {
    ...snapshot,
    id,
    messages: sanitizedMessages,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    timestamp,
  };

  if (!options.runtimeOwned) {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(normalized));
    } catch {
      // localStorage may be unavailable or full; Electron persistence below is still attempted.
    }
  }

  const metadata = {
    title: snapshot.title || '自动保存',
    model: snapshot.model,
    // M2-6：autosave 也带上当前对话 mode / reasoningEffort，使刷新/重启后恢复对话能拿回设置。
    mode: snapshot.mode,
    reasoningEffort: snapshot.reasoningEffort,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    lastMessage: getLastMessageText(snapshot.messages),
    assistantRuns: snapshot.assistantRuns ?? {},
    fileSnapshots: snapshot.fileSnapshots ?? {},
    pendingDiffs: snapshot.pendingDiffs ?? [],
    archived: snapshot.archived,
    tags: snapshot.tags === undefined ? undefined : normalizeTags(snapshot.tags),
    // M4-2-S3/S4：autosave 行也带工作区归属，使刷新/重启从 autosave 恢复对话能拿回归属（S5 接线）。
    workspacePath: snapshot.workspacePath,
    // ★ M4-6-S4：autosave 行也带对话目标，使刷新/重启从 autosave 恢复对话能拿回 goal 继续注入。
    goal: snapshot.goal,
    // ★ M5-BPC：autosave 行也带本对话阈值覆盖，使刷新/重启从 autosave 恢复对话能拿回 BPC/压缩覆盖。
    bpcThresholdOverride: snapshot.bpcThresholdOverride ?? null,
    compactThresholdOverride: snapshot.compactThresholdOverride ?? null,
    // ★ task_boundary：autosave 行也带任务边界 + 大标题，使刷新/重启从 autosave 恢复对话能拿回边界卡片与历史。
    taskBoundaries: snapshot.taskBoundaries,
    taskHeadline: snapshot.taskHeadline,
  };

  // M4-2-S1：autosave 也支持透传 systemTouch（默认 false——用户正在该对话活动，刷新排序时间合理）。
  const write = persistPlatformSnapshot(id, metadata, sanitizedMessages, Boolean(snapshot.systemTouch));
  if (id === AUTOSAVE_ID) pendingAutosaveWrites.add(write);
  try {
    await write;
  } finally {
    pendingAutosaveWrites.delete(write);
  }
}

export async function clearAutosaveSnapshot(options: ClearAutosaveOptions = {}): Promise<void> {
  // 提升 AUTOSAVE 前先等已经开始的旧草稿写入结束，再删除，避免晚完成的写入在 delete 后复活旧草稿。
  if (pendingAutosaveWrites.size > 0) {
    await Promise.allSettled([...pendingAutosaveWrites]);
  }
  if (!options.preserveLocalMirror) {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      // Ignore unavailable localStorage.
    }
  }
  await platform.conversation.delete(AUTOSAVE_ID).catch(() => false);
}

export async function loadAutosaveSnapshot(): Promise<ConversationSnapshot | null> {
  const fromPlatform = await loadPlatformSnapshot(AUTOSAVE_ID);
  if (fromPlatform?.messages.length) return fromPlatform;

  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed.messages)) {
      // ★ M5-1 归一入口兜底：localStorage autosave 镜像同样剥掉遗留 compact_* system 摘要消息。
      return { ...parsed, messages: stripLegacyCompactMessages(parsed.messages) };
    }
  } catch {
    return null;
  }
  return null;
}

export async function saveConversationSnapshot(snapshot: ConversationSnapshot): Promise<ConversationSummary | null> {
  if (!snapshot.messages.length) return null;
  const id = !snapshot.id || snapshot.id === AUTOSAVE_ID ? createConversationId() : snapshot.id;
  const title = snapshot.title || getFallbackTitle(snapshot.messages);
  // ★ M4-2-S1 systemTouch（问题9）：DB 已不刷 updated_at，返回的 summary.timestamp 也必须反映「未刷新」，
  //   否则调用方 dispatch(updateConversation(summary)) 会把 store 列表项时间刷成当前 → 排序照样跳第一。
  //   故 systemTouch 时优先读 existing 行的 updatedAt 当返回 timestamp（保持旧排序时间）；
  //   读不到（fork/新行）才回退 snapshot.timestamp ?? Date.now()。非 systemTouch 维持原行为。
  let timestamp = snapshot.timestamp ?? Date.now();
  if (snapshot.systemTouch) {
    const existing = await platform.conversation.get(id).catch(() => null);
    const existingTs = existing ? normalizeTimestamp(existing.updatedAt ?? existing.timestamp) : null;
    if (existingTs) timestamp = existingTs;
  }
  const metadata = {
    title,
    model: snapshot.model,
    // M2-6：随对话保存当前 mode / reasoningEffort（undefined 时持久化层不覆盖旧值，见 persistPlatformSnapshot）。
    mode: snapshot.mode,
    reasoningEffort: snapshot.reasoningEffort,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    lastMessage: getLastMessageText(snapshot.messages),
    assistantRuns: snapshot.assistantRuns ?? {},
    fileSnapshots: snapshot.fileSnapshots ?? {},
    pendingDiffs: snapshot.pendingDiffs ?? [],
    archived: snapshot.archived,
    tags: snapshot.tags === undefined ? undefined : normalizeTags(snapshot.tags),
    // M2-3：fork 时携带溯源，普通保存为 undefined（不覆盖已有行的 parent 字段）。
    parentId: snapshot.parentId,
    branchedFromMessageId: snapshot.branchedFromMessageId,
    // M3-1a：子代理对话落库带 true（create 时写定）；普通保存为 undefined → 落默认 false。
    isSubAgent: snapshot.isSubAgent,
    // M4-2-S3/S4：工作区归属随对话落库（path 作键；undefined 时 update 不覆盖既有归属）。
    workspacePath: snapshot.workspacePath,
    // ★ M4-6-S4：对话目标随对话落库（DB goal 列；undefined 时 update 不覆盖既有 goal，显式 '' 清空）。
    goal: snapshot.goal,
    // ★ M5-BPC：当前快照没有覆盖值时显式写 null，确保用户恢复全局默认后不会被 DB 旧值复活。
    bpcThresholdOverride: snapshot.bpcThresholdOverride ?? null,
    compactThresholdOverride: snapshot.compactThresholdOverride ?? null,
    // ★ task_boundary：任务边界 + 大标题随对话落库（DB JSON 列；undefined 时 update 不覆盖既有值，空数组→落 NULL=清空）。
    taskBoundaries: snapshot.taskBoundaries,
    taskHeadline: snapshot.taskHeadline,
  };

  // M2-R6：正式保存同样落库去 base64。
  const sanitizedMessages = sanitizeMessagesForPersistence(snapshot.messages);
  await persistPlatformSnapshot(id, metadata, sanitizedMessages, Boolean(snapshot.systemTouch));
  // ★ Codex P2-2 修复：子代理对话【不写 legacy map】——legacy metadata 不带 isSubAgent，
  //   写了就会被 listLegacyConversationSummaries 列进普通历史且无法过滤。子对话只走 platform 层（带 is_subagent 列），
  //   主路径按 isSubAgent 过滤即可彻底排除出普通列表。
  if (!snapshot.isSubAgent) writeLegacyConversation(id, sanitizedMessages);

  return {
    id,
    title,
    lastMessage: metadata.lastMessage,
    timestamp,
    messageCount: snapshot.messages.length,
    model: snapshot.model || 'unknown',
    archived: Boolean(snapshot.archived),
    tags: normalizeTags(snapshot.tags),
    // M4-2-S4：返回 summary 带工作区归属（snapshot.workspacePath，缺省 null=Global），
    //   使调用方 dispatch(updateConversation(summary)) 后 store 列表项归属与 DB 一致（S6 标记/过滤即时正确）。
    workspacePath: snapshot.workspacePath ?? null,
  };
}

/** branchConversation 的返回：新对话 summary + 新对话身份信息（供调用方切换/落库）。 */
export interface BranchResult {
  summary: ConversationSummary;
  newId: string;
  parentId: string;
  branchedFromMessageId: string;
  /** 分支携带到新对话的消息子集（含分支点该条），供调用方 setConversation 切入。 */
  messages: Message[];
  title: string;
  model?: string;
  /**
   * 附件 addRef 最终仍失败的 sha256 列表（已含 1 次重试后仍未 +1 的）。空数组=全部成功。
   * 这些 sha 在新分支里【未对齐 refCount】：源对话删除后归零会被误删实体 → 新分支该图永久缺失。
   * 上层据此提示用户「分支附件可能未完整保留」，便于其重新分支或保留源对话。
   */
  addRefFailedShas: string[];
  /**
   * ★ Plan_5 M5-5：分支点是 user 消息时，该 user【整轮不进子集】，改由调用方切到新对话后回填输入框待发
   *   （与回溯对齐）。此处回带那条 user 的内容/附件供 AgentPanel.refillInputFromUserMessage 使用；
   *   分支点非 user（落在 model 段）或退化为空子集时为 null（不回填，行为同普通分支）。
   */
  // ★ M6 收尾 D1：richTokens 透传给调用方供 refillInputFromUserMessage → buildRichParts 无损还原 @ 块。
  pendingUserMessage: { content: string; attachments?: Message['attachments']; richTokens?: Message['richTokens'] } | null;
  // ★ task_boundary：分支复制出的任务边界（已深拷贝、按分支点裁剪 + active 收口）+ 大标题镜像，
  //   供调用方切到新分支后 setConversation 回填进 store（无则 undefined）。用户拍板：分支复制 task_boundary + 历史。
  taskBoundaries?: TaskBoundary[];
  taskHeadline?: TaskHeadline;
}

/**
 * 对单个 sha 做 addRef，统一识别两类失败：
 *   - Promise reject（Electron IPC 抖动 / DB 锁）→ catch 捕获；
 *   - 返回 { error:true }（Web 端 meta 不存在等）→ 不 reject，需显式判定。
 * 成功返回 true；任一类失败返回 false（不抛）。
 */
async function tryAddRefOnce(sha: string): Promise<boolean> {
  try {
    const res = await platform.attachment.addRef(sha);
    // Web 端 addRef 对不存在 meta 返回 { error:true }（非 reject），必须显式识别为失败。
    if (res && typeof res === 'object' && 'error' in res && (res as { error?: unknown }).error) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 对话分支（M2-3）：在源对话 fromMessageId 处「从此分支」，把【该消息及之前的消息子集】另存为一个新对话。
 *
 * 语义（复制而非移动，源对话绝不改动）：
 *   1. 取源 messages 里 fromMessageId 及之前的连续前缀子集（含该条）。
 *   2. createConversationId 生成新 id；saveConversationSnapshot 落新对话
 *      （messages=子集，parentId=源 id，branchedFromMessageId=fromMessageId）。
 *   3. copyRecord(源, 新, keptSteps, keptRounds) 继承到该点的 record 多批次。
 *      - keptRounds = identifyRounds(过滤 tool 的子集).totalRounds（★ 真轮数，连发 user 合并为 1 轮，
 *        与批 roundEnd 同口径；不再用 user 角色条数近似——否则按轮裁剪分支永远兜不住、退化为死代码）。
 *      - keptSteps  = 子集里 role!=='tool' 的条数（★ 与 clampToBatch / agentLoop requestHistory「不含 tool」step 口径严格一致）。
 *   4. 附件 refCount：对子集 collectMessageShas 得到的每个 sha256 调 platform.attachment.addRef（+1）。
 *      新对话与源对话复用同一附件实体，必须 +1，否则源对话删除/GC 后新分支的图失效（与 R6 fork refCount 欠计同类坑）。
 *      —— 顺序：先 save（落库即引用态，与源行同时引用同一 sha）再 addRef，使「持有数」对齐「refCount」。
 *      —— 失败补偿：addRef 失败（reject 或 Web 端 {error:true}）会做 1 次有限重试；仍失败的 sha 收进
 *         BranchResult.addRefFailedShas 并 console.warn，上层据此提示「分支附件可能未完整保留」。每个 sha 至多 +1，守恒。
 *
 * @param srcId 源对话 id（写入新对话 parentId 溯源；分支不修改源）。
 * @param fromMessageId 分支点消息 id。
 * @param messages 源对话当前完整消息列表（运行态 store 的 messages）。
 * @param meta 新对话标题/模型（缺省由消息派生）；recordSrcId 指定 record 实际所在的 id——
 *   autosave 源刚 fork 成真实 id 时，record 仍在 AUTOSAVE_ID 键下尚未迁移，此时 recordSrcId 应传旧 id，
 *   否则 copyRecord 从新真实 id 读不到任何 record（缺省回退 srcId）。
 *   recordSnapshot：可选的【内存 record 快照】——autosave 源分支时，调用方在 clearAutosaveSnapshot
 *   （会经 SQLite FK CASCADE 级联删掉 records 行）之前先抓好的源 record。传入则优先从内存继承（copyRecordFrom），
 *   不再依赖可能已被级联删除的库行（修 issue④⑤：Electron autosave 分支 record 继承落空 + 双模式不对等）。
 * @returns BranchResult；分支点不存在 / 源消息为空 / 落库失败 → null。
 */
export async function branchConversation(
  srcId: string,
  fromMessageId: string,
  messages: Message[],
  // M2-6：mode / reasoningEffort 可选——分支继承源对话当前设置并落到新分支 DB 行，
  //   使新分支「切走再切回」恢复出的设置与分支那一刻一致（缺省则 create 落默认 planning/auto）。
  // M4-2-S4：meta.workspacePath 让新分支继承源对话工作区归属（S5 调用方传入源对话当前 workspacePath；
  //   缺省则 create 落 NULL=Global）。其余字段语义不变。
  // ★ task_boundary：meta 透传源对话的 taskBoundaries + taskHeadline（边界是对话顶层字段、不在 messages 里，
  //   故必须经 meta 传入，不能从 messages 推）。调用方传源对话当前 store 的 taskBoundaries/taskHeadline。
  meta?: {
    title?: string;
    model?: string;
    mode?: string;
    reasoningEffort?: string;
    workspacePath?: string | null;
    bpcThresholdOverride?: number;
    compactThresholdOverride?: number;
    recordSrcId?: string;
    recordSnapshot?: SynapseRecord | null;
    taskBoundaries?: TaskBoundary[];
    taskHeadline?: TaskHeadline;
  },
): Promise<BranchResult | null> {
  if (!srcId || !fromMessageId || !Array.isArray(messages) || messages.length === 0) return null;
  const rawCutIdx = messages.findIndex(m => m.id === fromMessageId);
  if (rawCutIdx < 0) return null;

  // ★ Plan_5 M5-5：cutIdx【向轮边界取整】（复用回溯/重试同款共享 helper，绝不轮中间切）。
  //   - 分支点是 user：该 user 整轮不进子集（cutIdx 退到上一整轮结束），该 user 回填【新对话】输入框待发。
  //   - 分支点非 user（落在 model 段）：保留该轮整轮（round-end 同款），不回填。
  //   退化兜底：分支点是【第 1 轮的 user】→ 排除后子集为空（lastKeptIndex=-1），无法落成有效非空对话
  //   （历史列表按 messageCount>0 过滤会隐藏它）。此种极端退化回退为「含该 user 的最小子集」（旧 inclusive
  //   语义、不回填），保证新分支非空可见。其余情形按轮取整 + 回填。
  const cut = computeRoundTruncation(messages, fromMessageId, 'branch');
  let cutIdx: number;
  let pendingUserForRefill: BranchResult['pendingUserMessage'] = null;
  if (cut.ok && cut.lastKeptIndex >= 0) {
    cutIdx = cut.lastKeptIndex;
    if (cut.pendingUserMessage) {
      const pu = cut.pendingUserMessage as unknown as Message;
      // ★ D1：richTokens 一并透传（分支点是 user 时，新对话输入框回填要无损还原 @ 块）。
      pendingUserForRefill = { content: pu.content ?? '', attachments: pu.attachments, richTokens: pu.richTokens };
    }
  } else if (cut.ok && cut.lastKeptIndex < 0 && cut.pendingUserMessage) {
    // 退化：分支点是第 1 轮 user，排除后子集空 → 回退含该 user 的最小子集（rawCutIdx，inclusive），不回填。
    cutIdx = rawCutIdx;
  } else {
    // helper 兜不住（理论不应发生，anchor 已校验存在）→ 回退旧 inclusive 口径。
    cutIdx = rawCutIdx;
  }

  // 1. 子集 = 截断点及之前（含截断点对应消息）。深拷贝隔离，绝不触碰源 store 引用。
  //    ★ M2-3 主键修复：messages.id 是全局 UNIQUE 主键。分支是【复制成独立新对话】，源对话原行仍占着原 message.id，
  //      若新对话复用同一批 message.id，replaceMessages → INSERT 会撞 `UNIQUE constraint failed: messages.id`。
  //      故每条复制出的消息重新生成 message.id。安全性：
  //        - record 继承只用 convId + step/round 计数（copyRecord），不依赖 message.id；
  //        - 附件 refCount 只看 contentParts/attachments 的 sha256（collectMessageShas），不依赖 message.id；
  //        - 按「清洁分支语义」新对话不复制 assistantRuns/fileSnapshots/pendingDiffs，
  //          故 AssistantRun.messageId / runEvents 等按 message.id 的反向关联无需重映射（本就不带过去）。
  //      branchedFromMessageId 必须指向【源对话的原 message.id】（fromMessageId），不是这里换出来的新 id。
  //
  //    ★ 审查 issue①（同批去重兜底）：createMessageId 已升级为 crypto.randomUUID（碰撞趋于 0），
  //      但这里再加一道 Set 去重做【确定性】保证——同批内绝不出现两条相同 id（不靠概率），
  //      杜绝纯 INSERT 撞 UNIQUE 致整批事务回滚、分支静默失败。
  //
  //    ★ 审查 issue③（high）修复：原 `{...m}` 全量展开会把每条消息内联的【运行/差异态】
  //      （runId / runEvents / diffs / rollbackSnapshotId / 流式态）一并带进新分支并落库（IPC 会写
  //      run_id/run_events/diffs/rollback_snapshot_id 列）。这与「清洁分支语义」自相矛盾：顶层
  //      assistantRuns/fileSnapshots/pendingDiffs 被置空，但消息级内联态没清 → 新分支渲染出源对话遗留的
  //      diff 卡片，而新分支 fileSnapshots={}，对这些遗留 diff 接受/拒绝/回溯时 snapshotId 落空 →
  //      rollbackFileDiff 抛「缺少回退快照」或误改活动工作区；runId 在新分支 assistantRuns 里悬空。
  //      故这里显式剥离运行/差异/流式态，只保留纯内容态（role/content/contentParts/attachments/thinking/
  //      timestamp/model/toolCalls 等），与顶层「不带 assistantRuns/fileSnapshots/pendingDiffs」一致；
  //      且不影响 collectMessageShas（只看 contentParts/attachments）和 copyRecord（只看 step/round 计数）。
  const usedIds = new Set<string>();
  // ★ task_boundary 修复（review MEDIUM）：记 源message.id → 新message.id 映射，供下方 branchedBoundaries 的
  //   anchorMessageId/endAnchorMessageId 重映射——消息 id 全换新，不重映射边界锚点会匹配不上 → 新分支卡片全错位堆末尾。
  const idMap = new Map<string, string>();
  const subset = messages.slice(0, cutIdx + 1).map(m => {
    const {
      runId: _runId,
      runEvents: _runEvents,
      diffs: _diffs,
      rollbackSnapshotId: _rollbackSnapshotId,
      isStreaming: _isStreaming,
      streamState: _streamState,
      streamMode: _streamMode,
      fallbackReason: _fallbackReason,
      durationMs: _durationMs,
      endToEndMs: _endToEndMs,
      showStreamCursor: _showStreamCursor,
      showGeneratingPlaceholder: _showGeneratingPlaceholder,
      // ★ M4-8-S3：reconnect 是 UI 瞬态（重连进度），分支复制时一并剥离，绝不带进新对话/落库。
      reconnect: _reconnect,
      ...keep
    } = m;
    // 确定性去重：极小概率两次 randomUUID 撞了也再生成，绝不让同批出现重复 id。
    let id = createMessageId();
    while (usedIds.has(id)) id = createMessageId();
    usedIds.add(id);
    idMap.set(m.id, id);
    return { ...keep, id };
  });
  if (subset.length === 0) return null;

  // 2. step/round 口径（★ 必须与 clampToBatch / copyRecord / 批 roundEnd 严格一致）：
  //    keptSteps 不含 tool 角色。
  //    ★ M5-2 批次二修复（medium）：keptRounds 必须是 identifyRounds 收敛后的【真轮数】，
  //      不能再用「user 角色条数」近似。批 roundEnd 在 M5-2 后已是真轮号（连发 user 合并为 1 轮），
  //      若这里仍传 user 条数（恒 ≥ 真轮数）会让两口径系统性错配 → copyRecordFrom 里按轮裁剪分支
  //      （roundEnd > safeRounds 判定）永远兜不住而退化为死代码。故在已过滤 tool 的 subset 上调
  //      identifyRounds 取 totalRounds，与批 roundEnd 同口径，规范 §1/§3「向轮边界取整」才真正生效。
  const keptSteps = subset.filter(m => m.role !== 'tool').length;
  const keptRounds = identifyRounds(subset.filter(m => m.role !== 'tool')).totalRounds;

  const newId = createConversationId();

  // ★ task_boundary 分支复制（规范 §4 + §10.7「分支点之后砍、跨越收口」；用户拍板：分支复制 task_boundary + 历史）：
  //   - 深拷贝 meta.taskBoundaries（steps/history 逐项展开），绝不与源 store 共享引用——分支是独立冻结快照。
  //   - 按 keptRounds 裁剪：startRound > keptRounds 的边界整个丢弃（分支点之后才开始的边界）；
  //     startRound 缺失（首版未填轮号）时退化为全部保留（保守，不丢数据）。
  //   - 仍 active 的边界 → 收口为 'done'（endedAt=now）：分支是冻结快照，新对话不延续源对话的进行中边界。
  //   - taskHeadline 镜像浅拷贝带过去（其值真相在各 boundary.history，镜像只是当前值）。
  const tbNow = Date.now();
  const branchedHeadline: TaskHeadline | undefined = meta?.taskHeadline ? { ...meta.taskHeadline } : undefined;
  let branchedBoundaries: TaskBoundary[] | undefined;
  if (Array.isArray(meta?.taskBoundaries) && meta!.taskBoundaries.length) {
    branchedBoundaries = meta!.taskBoundaries
      .filter(b => b.startRound === undefined || b.startRound <= keptRounds)
      .map(b => ({
        ...b,
        // ★ message.id 已全部换新（见上 idMap），anchor/endAnchor 必须重映射，否则新分支卡片匹配不上消息 → 全错位堆末尾。
        //   落在被裁区（映射不到）置 undefined → 渲染走孤儿兜底（合理：锚消息不在子集内）。
        anchorMessageId: b.anchorMessageId ? idMap.get(b.anchorMessageId) : undefined,
        endAnchorMessageId: b.endAnchorMessageId ? idMap.get(b.endAnchorMessageId) : undefined,
        steps: b.steps.map(s => ({ ...s, toolCallIds: s.toolCallIds ? [...s.toolCallIds] : undefined })),  // 深拷贝隔离（含嵌套数组）
        history: b.history.map(h => ({ ...h })),       // 深拷贝隔离（历史时间线随分支复制）
        status: b.status === 'active' ? ('done' as const) : b.status,
        endedAt: b.status === 'active' ? tbNow : b.endedAt,
      }));
    if (branchedBoundaries.length === 0) branchedBoundaries = undefined;
  }

  // ★ 验收修复：fork 标题用「⑂-N」编号区分同源多个分支（N=源对话现有分支数+1）；baseTitle 去掉已有 ⑂-X 前缀防叠（fork-of-fork）。
  const rawBase = meta?.title || getFallbackTitle(subset);
  const baseTitle = rawBase.replace(/^⑂[-\d]*\s+/, '');
  let branchSeq = 1;
  try {
    const allForSeq = await listConversationSummaries({});
    branchSeq = allForSeq.filter((c) => (c as any).parentId === srcId).length + 1;
  } catch { branchSeq = 1; }
  const title = `⑂-${branchSeq} ${baseTitle}`;

  // 3. 落新对话（带 parent 溯源）。源对话完全不动。
  const summary = await saveConversationSnapshot({
    id: newId,
    title,
    model: meta?.model,
    // M2-6：分支继承源对话 mode / reasoningEffort（调用方传入当前设置）。
    mode: meta?.mode,
    reasoningEffort: meta?.reasoningEffort,
    // M4-2-S4：分支继承源对话工作区归属（调用方传入；缺省 undefined → create 落 NULL=Global）。
    workspacePath: meta?.workspacePath,
    bpcThresholdOverride: meta?.bpcThresholdOverride,
    compactThresholdOverride: meta?.compactThresholdOverride,
    messages: subset,
    parentId: srcId,
    branchedFromMessageId: fromMessageId,
    // ★ task_boundary：分支落库带上裁剪 + 深拷贝后的边界与大标题（随对话 JSON 列持久化）。
    taskBoundaries: branchedBoundaries,
    taskHeadline: branchedHeadline,
    timestamp: Date.now(),
  });
  if (!summary) return null;

  // 4. 继承 record 到分支点（截连续前缀批次）。record 是加速层，失败不阻塞分支。
  //    record 实际所在 id 可能 != parent srcId（autosave 刚 fork 时 record 还在旧 AUTOSAVE_ID 键下）。
  //    ★ issue④⑤：autosave 源分支时调用方会先 clearAutosaveSnapshot（Electron 经 FK CASCADE 级联删掉
  //      `records WHERE conversation_id='autosave-current'`），此时按 recordSrcId 现读已是 null。
  //      故调用方在级联删除前抓好的内存 record 快照（meta.recordSnapshot）优先 —— 从内存继承，两端一致；
  //      未传快照（普通真实对话分支，record 仍在库）则回退按 id 现读。
  const recordSrcId = meta?.recordSrcId || srcId;
  if (meta && 'recordSnapshot' in meta && meta.recordSnapshot !== undefined) {
    await copyRecordFrom(meta.recordSnapshot ?? null, newId, keptSteps, keptRounds).catch(() => null);
  } else {
    await copyRecord(recordSrcId, newId, keptSteps, keptRounds).catch(() => null);
  }

  // 5. 附件 refCount +1：新对话复用源对话同一附件实体，每个 sha256 加一次引用（与 collectMessageShas 口径守恒：
  //    每条消息内同一 sha 只计一次、跨消息累加）。
  //    ★ 补偿（本轮修复）：addRef 是引用计数关键写，失败后果是数据级（源删后归零误删实体 → 新分支图永久缺失），
  //    比纯读降级更严重，故不再静默吞错：
  //      - 区分 reject 与 Web 端返回的 { error:true }（tryAddRefOnce 内统一识别）；
  //      - 首次失败做 1 次有限重试（吸收 IPC 抖动 / DB 短暂锁）；
  //      - 仍失败的 sha 收集进 addRefFailedShas，console.warn 一条可观测日志，并随 BranchResult 回传上层提示。
  //    注意守恒：每个 sha 至多 +1（成功即不再重试），失败则 0 次，与 collectMessageShas 持有口径严格对齐，绝不重复 addRef。
  const shas = collectMessageShas(subset);
  const addRefFailedShas: string[] = [];
  if (shas.length > 0) {
    await Promise.all(shas.map(async sha => {
      if (await tryAddRefOnce(sha)) return;
      // 1 次有限重试。
      if (await tryAddRefOnce(sha)) return;
      addRefFailedShas.push(sha);
    }));
  }
  if (addRefFailedShas.length > 0) {
    // 可观测日志：用户无感知的数据级风险，至少落一条 warn 便于排查。
    console.warn(
      `[branchConversation] ${addRefFailedShas.length} 个附件 addRef 失败（重试后仍未 +1），`
      + `源对话删除后这些图可能被误删：`,
      addRefFailedShas,
    );
  }

  return {
    summary,
    newId,
    parentId: srcId,
    branchedFromMessageId: fromMessageId,
    messages: subset,
    title,
    model: meta?.model,
    addRefFailedShas,
    // ★ Plan_5 M5-5：分支点是 user 时，把那条被排除的 user 回带，供调用方切到新对话后回填输入框待发。
    pendingUserMessage: pendingUserForRefill,
    // ★ task_boundary：把裁剪 + 深拷贝后的边界与大标题回带给调用方，供切到新分支后 setConversation 回填进 store。
    taskBoundaries: branchedBoundaries,
    taskHeadline: branchedHeadline,
  };
}

export async function listConversationSummaries(filters: string | ConversationListFilters = ''): Promise<ConversationSummary[]> {
  const normalizedFilters = normalizeFilters(filters);
  const trimmed = normalizedFilters.query.trim();
  const platformRows = await (trimmed
    ? platform.conversation.search(trimmed, {
      archived: normalizedFilters.archived,
      tags: normalizedFilters.tags,
      limit: normalizedFilters.limit,
      // M4-2-S4：工作区归属三态透传到 platform（Electron buildConversationFilters / Web filter 两端对等）。
      workspacePath: normalizedFilters.workspacePath,
      globalOnly: normalizedFilters.globalOnly,
    })
    : platform.conversation.list({
      archived: normalizedFilters.archived,
      tags: normalizedFilters.tags,
      limit: normalizedFilters.limit,
      workspacePath: normalizedFilters.workspacePath,
      globalOnly: normalizedFilters.globalOnly,
    })).catch(() => []);
  const summaries = platformRows
    .map(mapConversationSummary)
    .filter((summary): summary is ConversationSummary => Boolean(summary))
    .filter(summary => summary.id !== AUTOSAVE_ID)
    .filter(summary => summary.messageCount > 0)
    // ★ Codex P2-2 修复：子代理对话是内部 transcript，仅 M3-3 卡片点进查看，不进普通历史列表/侧边栏/批量操作。
    .filter(summary => !summary.isSubAgent);

  // ★ M4-2-S4：legacy 对话（localStorage map，建归属机制前的旧数据）无 workspace_path 概念，统一视为 Global。
  //   故仅在「不限（全部）」或「Global」视图下合入；请求【具体工作区】时不混入 legacy（它们不属于任何工作区）。
  //   合入后给它们补 workspacePath:null，使下游 UI 一致地把它们标为「全局」。
  const includeLegacy = !normalizedFilters.workspacePath; // 具体 path 时为 false（globalOnly / 不限时为 true）
  if (includeLegacy) {
    const legacy = listLegacyConversationSummaries(normalizedFilters);
    // ★ Bug 修复（「全局」分组显示消息截断而非对话标题）：去重必须基于【platform 全量 id】，而非当前
    //   过滤后的 platformRows id。根因——新建/保存对话会同时写 platform（带 title + 归属）与 legacy 副本
    //   （localStorage map，无归属、无 metadata.title → getFallbackTitle 退化为首条 user 消息截断）。
    //   在「全局」(globalOnly) 视图下，一条【有工作区归属】的对话被 platform 的 `workspace_path IS NULL`
    //   过滤掉 → 不在 platformRows、其 id 不在过滤后的 seen 里 → 它的 legacy 副本被误当成「纯 legacy 全局
    //   对话」push 进列表，既显示截断标题，又错误地以全局身份泄漏进本不该出现的「全局」分组。
    //   （「全部」视图无 workspace 过滤、platformRows 含全部对话，故 legacy 副本恒被去重、不暴露此 bug。）
    //   修法：用一次不带 workspace 条件的轻量 list 取 platform 全量 id 作去重基准——凡 platform 里已存在
    //   的对话，其 legacy 副本一律不再合入；只有 platform 完全不存在的【真·纯 legacy 旧数据】才补入。
    const platformIds = await collectPlatformConversationIds();
    const seen = new Set<string>([...summaries.map(summary => summary.id), ...platformIds]);
    for (const summary of legacy) {
      if (!seen.has(summary.id)) summaries.push({ ...summary, workspacePath: null });
    }
  }

  return summaries
    .filter(summary => matchesFilters(summary, normalizedFilters))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * ★ Bug 修复辅助（「全局」分组 legacy 去重）：取 platform 侧【全量】对话 id 集合，用于判断某条对话在
 *   platform 是否已存在，从而避免其 legacy 副本被重复合入。
 *
 * 关键：故意【不传】workspacePath / globalOnly——只沿用 archived/tags/limit 贴合当前视图范围。
 *   否则在「全局」(globalOnly) 视图下，有归属对话会被 platform 过滤掉、其 id 取不到，legacy 副本又会泄漏。
 *   非 streaming 关键路径，失败静默返回空集（退化为旧行为，至少不报错）。
 */
async function collectPlatformConversationIds(): Promise<string[]> {
  try {
    const rows = await platform.conversation.list({
      // archived 用 'all'：legacy 副本无论本体归档与否都应被 platform 已存在判定去重，
      //   不能因 archived 过滤漏掉 platform 行而让其 legacy 副本以截断标题泄漏。
      archived: 'all',
      // 不传 tags：去重只认 id 是否存在，tags 过滤会缩小 platform 集合 → 漏去重。
      // limit 放大到安全上限（只取 id、成本低），避免大库下当前视图 limit(100/200) 截断导致漏去重。
      limit: 10000,
      // 刻意不传 workspacePath / globalOnly：要的是 platform 全量 id（含有归属对话）作去重基准。
    });
    return (Array.isArray(rows) ? rows : [])
      .map((row: any) => row?.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export async function loadConversationSnapshot(id: string): Promise<ConversationSnapshot | null> {
  return await loadPlatformSnapshot(id) ?? loadLegacyConversationSnapshot(id);
}

export async function renameConversation(id: string, title: string, opts?: { systemTouch?: boolean }): Promise<void> {
  // ★ M6 验收 bug9：自动标题回写走 systemTouch=true 落库——只改标题列、不刷 updated_at，
  //   避免自动标题把对话错误顶到列表最前（用户手动重命名仍走默认刷时间置顶）。
  await platform.conversation.update(id, { title, ...(opts?.systemTouch ? { systemTouch: true } : {}) }).catch(() => false);
  updateLegacyConversationMetadata(id, { title });
}

export async function deleteConversationSnapshot(id: string): Promise<void> {
  // M2-R6 refCount GC：删除前先读取引用，但只有数据库确认删除成功后才 release。
  // 否则 SQLite 暂时锁住时会出现「对话仍在、附件引用却已减一」以及 UI 假删除。
  const snapshot = await loadPlatformSnapshot(id) ?? loadLegacyConversationSnapshot(id);
  const deleted = await platform.conversation.delete(id);
  if (!deleted) throw new Error(`conversation delete rejected: ${id}`);
  deleteLegacyConversation(id);
  await releaseSnapshotAttachments(snapshot);
}

export async function deleteConversationSnapshots(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;

  const snapshots = await Promise.all(uniqueIds.map(async id => (
    await loadPlatformSnapshot(id) ?? loadLegacyConversationSnapshot(id)
  )));

  let deleted = false;
  if (platform.conversation.batchDelete) {
    try {
      deleted = await platform.conversation.batchDelete(uniqueIds);
    } catch {
      const results = await Promise.all(uniqueIds.map(id => platform.conversation.delete(id)));
      deleted = results.every(Boolean);
    }
  } else {
    const results = await Promise.all(uniqueIds.map(id => platform.conversation.delete(id)));
    deleted = results.every(Boolean);
  }
  if (!deleted) throw new Error('conversation batch delete rejected');

  uniqueIds.forEach(deleteLegacyConversation);
  await Promise.all(snapshots.map(releaseSnapshotAttachments));
}

/** 数据库确认删除后 release 该快照的附件引用；GC 失败不反向伪造删除失败。 */
async function releaseSnapshotAttachments(snapshot: ConversationSnapshot | null): Promise<void> {
  try {
    if (snapshot?.messages?.length) {
      await releaseMessageAttachments(snapshot.messages);
    }
  } catch {
    // GC 是加速/清理层，绝不阻塞删除主流程。
  }
}

/**
 * M2-R6 懒迁移入口：把一个 snapshot 里旧内联 base64 抽离成 sha256 引用，若有变更则回写 DB（按 id 持久化）。
 * 「用到才迁、不阻塞渲染」——调用方（AgentPanel / ConversationList）在 load 之后 fire-and-forget 调用，
 * 迁移成功后下次加载即引用态。
 *
 * onMigrated 回调（可选）：迁移确有变更时，把【迁移后的引用态 messages + 对话 id】交回调用方，
 * 由调用方决定是否安全地用其更新 store（需自行校验 store 当前对话未被切换/未追加新消息，再 dispatch）。
 * 不提供回调则仅回写 DB（store 保持旧 base64 态，下次加载即引用态）。
 *
 * 返回迁移后的 messages（changed=false 时即原 messages）。
 */
/**
 * 按 conversationId 的在途迁移锁（模块级 Map<id, Promise>）。
 * ★ Codex 中风险修复（并发迁移竞态）：AgentPanel 挂载迁 AUTOSAVE、ConversationList 切换迁目标对话，
 *   多入口/多窗口/重载下若对同一 DB 行（仍内联 base64）在首个迁移回写完成前重入，两路各 put 一遍 →
 *   refCount 翻倍，writeback 幂等只在【完成后】生效，竞态窗口内防不住。
 *   同 id 复用同一 in-flight 迁移 Promise，串行化首个迁移；后到的复用结果，不再重复 put。
 */
const inflightMigrations = new Map<string, Promise<Message[]>>();

export function migrateSnapshotAttachments(
  snapshot: ConversationSnapshot,
  onMigrated?: (id: string, messages: Message[]) => void,
): Promise<Message[]> {
  if (!snapshot?.messages?.length) return Promise.resolve(snapshot?.messages ?? []);
  const id = snapshot.id || AUTOSAVE_ID;
  const existing = inflightMigrations.get(id);
  if (existing) return existing;
  const task = runSnapshotMigration(id, snapshot, onMigrated)
    .finally(() => { inflightMigrations.delete(id); });
  inflightMigrations.set(id, task);
  return task;
}

async function runSnapshotMigration(
  id: string,
  snapshot: ConversationSnapshot,
  onMigrated?: (id: string, messages: Message[]) => void,
): Promise<Message[]> {
  const { messages, changed, newShas } = await migrateMessagesAttachments(snapshot.messages);
  if (!changed) return snapshot.messages;
  const refMessages = sanitizeMessagesForPersistence(messages);
  // 回写：仅替换消息体（已是引用态，sanitize 再兜一道），保持元数据不变。
  // ★ Codex 中风险②修复：必须把【所有读取来源】都回写成引用态，否则下次 load 仍读到旧 base64 →
  //   重复 put 抬高 ref_count 且永不清。来源含：平台 DB（loadPlatformSnapshot）、legacy map（loadLegacyConversationSnapshot）、
  //   AUTOSAVE_KEY localStorage 镜像。三者全覆盖才真正闭环（迁移幂等）。
  // ★ Codex 中风险修复（回写失败 → 重复 put）：迁移在回写前已 put 成功(refCount+1)。若回写抛错，
  //   DB 仍是旧内联态，下次 load 再次 hasInlineBase64 → 再 put → refCount 单调上涨、GC 永远追不平。
  //   故回写抛错时把本轮新增引用 newShas 逐个 release 回滚，并【不通知 onMigrated】（store 保持旧 base64 态，
  //   下次重迁会重新 put），使「put 与持有关系」严格守恒。
  try {
    const existing = await platform.conversation.get(id).catch(() => null);
    if (existing) {
      // 平台 DB 有行：replaceMessages 覆盖即闭环（下次 loadPlatformSnapshot 优先返回引用态）。
      await platform.conversation.replaceMessages(id, refMessages.map(message => ({
        ...message,
        conversationId: id,
      })));
      // 顺带清理同 id 的 legacy 残留（若存在），避免它日后又被当旧数据读出。
      if (id in readLegacyConversationMap()) writeLegacyConversation(id, refMessages);
    } else if (id in readLegacyConversationMap()) {
      // 纯 legacy 对话（平台 DB 无行、仅 synapse_conversations map 有）：必须回写 legacy map，
      // 否则每次打开都重新 put、ref_count 暴涨且 base64 永留。覆盖为引用态后下次不再迁移。
      writeLegacyConversation(id, refMessages);
    } else {
      // 平台 DB 与 legacy 均无该 id 的行：无处可回写，下次 load 仍会读到旧 base64 重迁 →
      // 与「回写失败」同源，回滚本轮引用避免 refCount 漂移。
      await rollbackMigratedShas(newShas);
      return snapshot.messages;
    }
    // 同步 localStorage 自动保存镜像（若当前就是 autosave）。
    if (id === AUTOSAVE_ID) {
      try {
        const saved = localStorage.getItem(AUTOSAVE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          parsed.messages = refMessages;
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(parsed));
        }
      } catch { /* localStorage 不可用则跳过 */ }
    }
  } catch {
    // 回写失败：回滚本轮新增引用，保持 DB 旧内联态（下次再迁），不通知 onMigrated。
    await rollbackMigratedShas(newShas);
    return snapshot.messages;
  }
  // 回写成功后通知调用方（让其把 store 也修正成引用态，杜绝 store 残留 base64 反复被 autosave 写回）。
  try {
    onMigrated?.(id, messages);
  } catch {
    // 回调异常不影响迁移结果。
  }
  return messages;
}

export async function updateConversationMetadata(
  id: string,
  // ★ M4-2-S6 改归属：metadata 增加 workspacePath（具体 path = 改归该工作区；null = 改归 Global）。
  //   IPC conversation:update 已支持 data.workspacePath !== undefined 时写 workspace_path（缺列降级），
  //   Web mock conversation.update 亦对等（patch.workspacePath === undefined 时不覆盖）。这是 S6/S7
  //   「移动到…」唯一落库口径——传 undefined 维持原样，传 string|null 才改归属。
  metadata: { title?: string; archived?: boolean; tags?: string[]; workspacePath?: string | null },
): Promise<void> {
  const normalized = normalizeMetadataPatch(metadata);
  await platform.conversation.update(id, normalized).catch(() => false);
  updateLegacyConversationMetadata(id, normalized);
}

export async function updateConversationsMetadata(
  ids: string[],
  metadata: { archived?: boolean; tags?: string[] },
): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;
  const normalized = normalizeMetadataPatch(metadata);

  if (platform.conversation.batchUpdate) {
    await platform.conversation.batchUpdate(uniqueIds, normalized).catch(async () => {
      await Promise.all(uniqueIds.map(id => platform.conversation.update(id, normalized).catch(() => false)));
    });
  } else {
    await Promise.all(uniqueIds.map(id => platform.conversation.update(id, normalized).catch(() => false)));
  }

  uniqueIds.forEach(id => updateLegacyConversationMetadata(id, normalized));
}

export async function exportConversationSnapshot(id: string): Promise<ConversationSnapshot | null> {
  return loadConversationSnapshot(id);
}

export async function exportConversationSnapshots(
  ids: string[],
  filters?: ConversationListFilters,
): Promise<ConversationExportBundle> {
  const wanted = new Set(ids);
  const summaries = (await listConversationSummaries({ ...(filters ?? {}), archived: filters?.archived ?? 'all' }))
    .filter(summary => wanted.has(summary.id));
  const conversations = await Promise.all(summaries.map(async summary => ({
    summary,
    snapshot: await exportConversationSnapshot(summary.id),
  })));

  return {
    version: CONVERSATION_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    filters,
    conversations,
  };
}

async function loadPlatformSnapshot(id: string): Promise<ConversationSnapshot | null> {
  try {
    const conversation = await platform.conversation.get(id);
    if (!conversation) return null;
    // ★ M5-1 归一入口兜底：从 DB 读回即剥掉遗留 compact_* system 摘要消息（见 stripLegacyCompactMessages）。
    //   所有真实对话恢复（ConversationList 切换 / AgentPanel 切换 / autosave / WorkflowView）都经此函数，统一收口。
    const messages = stripLegacyCompactMessages(await platform.conversation.listMessages(id) as Message[]);
    return {
      id,
      title: conversation.title,
      model: conversation.model,
      // M2-6：随快照回带对话级 mode / reasoningEffort（两端 mapConversation/Web get 都带这两字段）。
      //   旧对话该列为 null/缺省 → 回退默认（mode='planning'、reasoningEffort='auto'），切换时同步进全局 agentSettings。
      //   ★ 健壮性：用「空串/NULL/undefined 都回退」（fallbackMeta，非纯 ??）——DB reasoning_effort 列无 DEFAULT，
      //     旧行或异常写入可能落空串 ''，?? 不拦空串会让下拉框落空（子代理 low 提到）。mode 一并兜空串保持对称。
      mode: fallbackMeta(conversation.mode, 'planning'),
      reasoningEffort: fallbackMeta(conversation.reasoningEffort ?? conversation.reasoning_effort, 'auto'),
      archived: Boolean(conversation.archived),
      tags: normalizeTags(conversation.tags),
      messages,
      assistantRuns: conversation.assistantRuns ?? {},
      fileSnapshots: conversation.fileSnapshots ?? {},
      pendingDiffs: conversation.pendingDiffs ?? [],
      timestamp: normalizeTimestamp(conversation.updatedAt ?? conversation.timestamp),
      // M2-3：分支溯源随快照回带（两端 mapConversation/Web get 都已带上这两字段，普通对话为 null）。
      parentId: conversation.parentId ?? conversation.parent_id ?? null,
      branchedFromMessageId: conversation.branchedFromMessageId ?? conversation.branched_from_message_id ?? null,
      // M3-1a：子代理标记随快照回带（两端 mapConversation/Web get 都映射成 isSubAgent，普通对话 false）。
      isSubAgent: Boolean(conversation.isSubAgent ?? conversation.is_subagent),
      // M4-2-S4：工作区归属随快照回带（两端 workspacePath 驼峰 / workspace_path 下划线，旧对话为 null=Global）。
      //   S5 恢复链路据此把归属回填进 store conversation.workspacePath。
      workspacePath: conversation.workspacePath ?? conversation.workspace_path ?? null,
      // ★ M4-6-S4：对话目标随快照回带（两端 goal 驼峰 / 下划线同名；旧对话/缺列为 null/'' → undefined=未设目标）。
      //   恢复链路据此把 goal 回填进 store conversation.goal，使重启后继续每轮注入。
      goal: (conversation.goal ?? '') || undefined,
      // ★ M5-BPC：本对话阈值覆盖随快照回带（两端驼峰 / 下划线；旧对话/缺列为 null → undefined=未覆盖）。
      //   ★ 用 typeof==='number'&&isFinite 判定，绝不用 `x||undefined` 吞 0（虽阈值现实不为 0，留作正确口径）。
      bpcThresholdOverride: toFiniteNumberOrUndefined(
        conversation.bpcThresholdOverride ?? conversation.bpc_threshold_override,
      ),
      compactThresholdOverride: toFiniteNumberOrUndefined(
        conversation.compactThresholdOverride ?? conversation.compact_threshold_override,
      ),
      // ★ task_boundary：随快照回带（Electron mapConversation 已 fromJson 解析成对象返回 taskBoundaries 驼峰；
      //   Web get 也返回对象）。task_*_json 下划线兜底分支几乎用不到（已转驼峰），保留只为防御。
      //   旧对话/缺列为 null → 空数组也规整为 undefined（视为未设边界），恢复链路据此回填 store conversation.taskBoundaries。
      taskBoundaries: normalizeTaskBoundaries(
        conversation.taskBoundaries ?? conversation.task_boundaries_json,
      ),
      taskHeadline: normalizeTaskHeadline(
        conversation.taskHeadline ?? conversation.task_headline_json,
      ),
    };
  } catch {
    return null;
  }
}

async function persistPlatformSnapshot(
  id: string,
  metadata: PlatformSnapshotMetadata,
  messages: Message[],
  // ★ M4-2-S1 systemTouch：true 时本次落库不刷 updated_at（仅 update 既有行 + replaceMessages 路径生效；
  //   新建对话本就该有当前 updated_at，create 路径无视此参）。用于「切走对话的自动保存」不改用户感知排序。
  systemTouch = false,
): Promise<void> {
  const existing = await platform.conversation.get(id).catch(() => null);
  let createdNew = false;
  // M2-R6 终极防线：所有平台落库都从这里走，内部再 sanitize 一道（幂等），
  // 即便上游漏调 sanitizeMessagesForPersistence 也保证 DB 绝不含 base64。
  const safeMessages = sanitizeMessagesForPersistence(messages);
  const persistedMessages = safeMessages.map(message => ({
    ...message,
    conversationId: id,
  }));
  const conversationApi = platform.conversation as AtomicConversationApi;

  if (conversationApi.saveSnapshot) {
    await conversationApi.saveSnapshot({
      id,
      metadata,
      messages: persistedMessages,
      systemTouch,
    });
    return;
  }

  try {
    if (platform.platform.isElectron) {
      // 当前 preload 尚未暴露 conversation:saveSnapshot 时，复用既有 create/update 桥接传入 messages；
      // 主进程会识别 messages 并在一次 IPC 的 SQLite transaction 内写 metadata + 完整消息。
      if (existing) {
        await conversationApi.update(id, { ...metadata, systemTouch, messages: persistedMessages });
      } else {
        await conversationApi.create({ id, ...metadata, systemTouch, messages: persistedMessages });
      }
      return;
    }

    if (existing) {
      // 更新既有行：systemTouch 随 metadata 透传给 IPC / Web update（true 时不刷 updated_at）。
      await platform.conversation.update(id, { ...metadata, systemTouch });
    } else {
      await platform.conversation.create({ id, ...metadata });
      createdNew = true;
    }

    // replaceMessages 末尾也会刷一次 conversation.updated_at，systemTouch 时一并跳过（治问题9关键）。
    await platform.conversation.replaceMessages(id, persistedMessages, { systemTouch });
  } catch (error) {
    if (createdNew) await platform.conversation.delete(id).catch(() => false);
    throw error;
  }
}

function mapConversationSummary(row: any): ConversationSummary | null {
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.title || '新对话',
    lastMessage: row.lastMessage || row.last_message || '',
    timestamp: normalizeTimestamp(row.updatedAt ?? row.timestamp ?? row.createdAt),
    messageCount: Number(row.messageCount ?? row.message_count ?? 0),
    model: row.model || 'unknown',
    archived: Boolean(row.archived),
    tags: normalizeTags(row.tags),
    // M3-1a：两端 mapConversation/Web summary 都带 isSubAgent（驼峰）/ is_subagent（下划线），普通对话 false。
    isSubAgent: Boolean(row.isSubAgent ?? row.is_subagent),
    // M4-2-S4：两端 mapConversation/Web summary 都带 workspacePath（驼峰）/ workspace_path（下划线）；
    //   缺省/旧对话为 null（Global）。
    workspacePath: row.workspacePath ?? row.workspace_path ?? null,
    parentId: row.parentId ?? row.parent_id ?? null,
    branchedFromMessageId: row.branchedFromMessageId ?? row.branched_from_message_id ?? null,
  };
}

/**
 * 对话级元数据（mode / reasoningEffort）回退：null / undefined / 空串都回退到默认。
 * ★ M2-6 健壮性：reasoning_effort 列无 DEFAULT，旧行/异常可能落空串 ''；纯 `?? 'auto'` 不拦空串，
 *   会让恢复出的下拉值落空。统一走此函数，把空串也视作「未设置」回退默认（与 dispatch 侧 `x || 'auto'` 同口径）。
 */
function fallbackMeta(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/**
 * ★ M5-BPC：把 DB 读回的阈值覆盖值规范成 number | undefined。
 *   null/缺列/NaN/非数字 → undefined（未覆盖）；合法有限数（含 0）原样取。
 *   ★ 关键：DB REAL 列读回 0 是合法值，绝不用 `Number(v) || undefined` 吞掉 0（虽阈值现实不为 0，留作正确口径）。
 *   注意：SQLite 也可能把数字以字符串回带，故用 Number() 转换后再 isFinite 校验（但显式拦 null/''/undefined）。
 */
function toFiniteNumberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * ★ task_boundary：把 DB/平台读回的 taskBoundaries 规整成 TaskBoundary[] | undefined。
 *   正常情况已是对象（Electron mapConversation fromJson / Web 存对象）；防御性兼容仍是 JSON 串的极端情况。
 *   null/缺列/空数组/非数组/解析失败 → undefined（视为未设边界），非空数组才返回。绝不抛错拖垮整条恢复。
 */
function normalizeTaskBoundaries(value: unknown): TaskBoundary[] | undefined {
  let v = value;
  if (typeof v === 'string') {
    if (!v) return undefined;
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  return Array.isArray(v) && v.length ? (v as TaskBoundary[]) : undefined;
}

/**
 * ★ task_boundary：把 DB/平台读回的 taskHeadline 规整成 TaskHeadline | undefined。
 *   正常已是对象；防御性兼容 JSON 串。null/缺列/非对象/解析失败 → undefined。
 */
function normalizeTaskHeadline(value: unknown): TaskHeadline | undefined {
  let v = value;
  if (typeof v === 'string') {
    if (!v) return undefined;
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  return v && typeof v === 'object' ? (v as TaskHeadline) : undefined;
}

function normalizeTimestamp(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now();
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function getLastMessageText(messages: Message[]): string {
  const last = messages[messages.length - 1];
  return last?.content?.slice(0, 200) ?? '';
}

function getFallbackTitle(messages: Message[]): string {
  const firstUser = messages.find(message => message.role === 'user')?.content?.trim();
  if (!firstUser) return '新对话';
  return firstUser.slice(0, 30) + (firstUser.length > 30 ? '...' : '');
}

function readLegacyConversationMap(): Record<string, Message[]> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_CONVERSATIONS_KEY) || '{}');
  } catch {
    return {};
  }
}

function readLegacyConversationMetadata(): Record<string, Partial<ConversationSummary>> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_CONVERSATION_METADATA_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLegacyConversationMetadata(metadata: Record<string, Partial<ConversationSummary>>): void {
  try {
    localStorage.setItem(LEGACY_CONVERSATION_METADATA_KEY, JSON.stringify(metadata));
  } catch {
    // Ignore unavailable localStorage.
  }
}

function writeLegacyConversation(id: string, messages: Message[]): void {
  try {
    const stored = readLegacyConversationMap();
    stored[id] = messages;
    localStorage.setItem(LEGACY_CONVERSATIONS_KEY, JSON.stringify(stored));
  } catch {
    // Legacy compatibility is best-effort; platform persistence is primary.
  }
}

function deleteLegacyConversation(id: string): void {
  try {
    const stored = readLegacyConversationMap();
    delete stored[id];
    localStorage.setItem(LEGACY_CONVERSATIONS_KEY, JSON.stringify(stored));
    const metadata = readLegacyConversationMetadata();
    delete metadata[id];
    writeLegacyConversationMetadata(metadata);
  } catch {
    // Ignore unavailable localStorage.
  }
}

function updateLegacyConversationMetadata(id: string, patch: Partial<ConversationSummary>): void {
  const metadata = readLegacyConversationMetadata();
  const current = metadata[id] ?? {};
  metadata[id] = {
    ...current,
    ...patch,
    tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
  };
  writeLegacyConversationMetadata(metadata);
}

function loadLegacyConversationSnapshot(id: string): ConversationSnapshot | null {
  const rawMessages = readLegacyConversationMap()[id];
  if (!Array.isArray(rawMessages)) return null;
  // ★ M5-1 归一入口兜底：legacy（localStorage map）对话同样剥掉遗留 compact_* system 摘要消息。
  const messages = stripLegacyCompactMessages(rawMessages);
  const metadata = readLegacyConversationMetadata()[id] ?? {};
  return {
    id,
    title: metadata.title || getFallbackTitle(messages),
    archived: Boolean(metadata.archived),
    tags: normalizeTags(metadata.tags),
    messages,
    timestamp: Date.now(),
  };
}

function listLegacyConversationSummaries(filters: ConversationListFilters): ConversationSummary[] {
  const lowerQuery = filters.query?.toLowerCase() ?? '';
  const metadata = readLegacyConversationMetadata();
  return Object.entries(readLegacyConversationMap())
    .filter(([, messages]) => Array.isArray(messages))
    .map(([id, messages]) => {
      const meta = metadata[id] ?? {};
      const title = meta.title || getFallbackTitle(messages);
      const lastMessage = getLastMessageText(messages);
      return {
        id,
        title,
        lastMessage,
        timestamp: Math.max(...messages.map(message => Number(message.timestamp) || 0), 0) || Date.now(),
        messageCount: messages.length,
        model: messages.find(message => message.model)?.model || 'unknown',
        archived: Boolean(meta.archived),
        tags: normalizeTags(meta.tags),
      };
    })
    .filter(summary => {
      if (!lowerQuery) return true;
      const messages = readLegacyConversationMap()[summary.id] ?? [];
      return [summary.title, summary.lastMessage, summary.model, ...(summary.tags ?? []), ...messages.map(message => message.content)]
        .join('\n')
        .toLowerCase()
        .includes(lowerQuery);
    })
    .filter(summary => matchesFilters(summary, filters));
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map(tag => String(tag).trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function normalizeFilters(filters: string | ConversationListFilters): ConversationListFilters & {
  query: string;
  archived: 'all' | 'active' | 'archived';
  tags: string[];
  limit: number;
  // M4-2-S4 工作区归属三态（透传到 platform.list/search）：
  //   workspacePath 为具体 path → 只显该工作区；globalOnly=true → 只显无归属；都不传 → 全部。
  workspacePath: string | null;
  globalOnly: boolean;
} {
  if (typeof filters === 'string') {
    return { query: filters, archived: 'active', tags: [], limit: 100, workspacePath: null, globalOnly: false };
  }
  return {
    query: filters.query ?? '',
    archived: filters.archived ?? 'active',
    tags: normalizeTags(filters.tags),
    limit: filters.limit ?? 100,
    workspacePath: filters.workspacePath ?? null,
    globalOnly: Boolean(filters.globalOnly),
  };
}

function normalizeMetadataPatch<T extends { tags?: string[] }>(patch: T): T {
  if (patch.tags === undefined) return patch;
  return { ...patch, tags: normalizeTags(patch.tags) };
}

function matchesFilters(summary: ConversationSummary, filters: ConversationListFilters): boolean {
  const archivedFilter = filters.archived ?? 'active';
  if (archivedFilter === 'active' && summary.archived) return false;
  if (archivedFilter === 'archived' && !summary.archived) return false;
  const requiredTags = normalizeTags(filters.tags);
  if (requiredTags.length) {
    const summaryTags = new Set(normalizeTags(summary.tags).map(tag => tag.toLowerCase()));
    if (!requiredTags.every(tag => summaryTags.has(tag.toLowerCase()))) return false;
  }
  return true;
}
