import { SendHorizontal, Sparkles, Zap, StopCircle, Plus, Download, PanelRightClose, MessageSquare, ChevronDown, Search, Globe, FolderInput, Paperclip, AtSign, Workflow, List, Check, X, Pencil } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  setCurrentModel,
  setMaxTokens,
  setMode,
  setOutputStrategy,
  setPseudoStreamSpeed,
  setReasoningEffort,
  setShowGeneratingPlaceholder,
  setShowStreamCursor,
  setShowThinking,
  setSpeedTier,
  setStreamThinking,
  setTemperature,
  setTopP,
} from '@/store/slices/agentSettings';
import { toggleAgentPanel, setSidebarVisible } from '@/store/slices/layout';
import { setSafety } from '@/store/slices/settings';
// ★ M4-6-S2：@设置选中后跳转——切到设置分区（sidebar）+ 展开侧栏（layout）。
import { setActiveView } from '@/store/slices/sidebar';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { nextTailPinnedState, useMessageWindow } from '@/components/chat/useMessageWindow';
import { ApprovalDialog, type ApprovalRequest } from '@/components/ui/ApprovalDialog';
import { approvalCoordinator } from '@/services/approvalCoordinator';
import { TaskBoundaryCard, type BoundaryFile } from '@/components/chat/TaskBoundaryCard';
import { resolveEditorType } from '@/services/editorFileTypes';
import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, Fragment, type ReactNode } from 'react';
import { AIClient } from '@/services/aiClient';
import { AgentLoop, buildStableRecordPrefix } from '@/services/agentLoop';
import { executionRegistry } from '@/services/executionRegistry';
import { CompressionRing } from './CompressionRing';
import { BpcOverridePopover } from './BpcOverridePopover';
import { selectBpcUiState } from '@/store/slices/bpc';
import { CompactDivider, extractBatchMarks, type BatchMark, type BatchSource } from './CompactDivider';
import { toolRegistry } from '@/services/toolRegistry';
// ★ M4-7-S4：构建 AgentLoop 时把 MCP server 工具桥接进 toolRegistry（MCP 工具进工具循环）。
import { mcpBridge } from '@/services/mcpBridge';
import { addNotification } from '@/store/slices/notifications';
import { addMessage, clearConversation, clearMessages, editMessage, truncateAt, deleteMessage, endTaskBoundary, enqueueMessage, dequeueMessage, clearQueue, enqueueInterrupt, dequeueInterrupt, clearInterruptQueue, moveQueueItem, reconcileToolTaskStatus, settleRecoveredToolTaskBoundaries, setConversation, setActiveConversation, setConversationWorkspace, setGoal, setModel as setConversationModel, setPendingMessage, setProjectedTokenCount, setStreaming, setTokenUsage, updateDiffStatus, setDiffReviewError, updateMessage, updateMessageMeta, selectActiveConversation, selectConversationById, type AttachmentRef, type MessageContentPart, type QueuedMessage, type FileDiffSummary, type ToolCall } from '@/store/slices/conversation';
// ★ M3-2b：@MultiAI:模式名 触发固定工作流（解析 + 跑 runWorkflow + 汇总文本），见 services/multiAITrigger.ts。
// ★ M3-3a：generateWorkflowRunId 预生成稳定 runId，跑前先建占位 assistant 消息 + 关联卡片实时显示。
import { parseMultiAITrigger, runMultiAITrigger, generateWorkflowRunId } from '@/services/multiAITrigger';
// ★ M3-2b 修复：工作流走 agentOrchestrator（非 agentLoop），handleStop 需直接调 abortAll() 才能真正中止工作流。
import { agentOrchestrator } from '@/services/agentOrchestrator';
import { exitWorktree, renameWorktreeContext } from '@/store/slices/worktreeSession';
import { migrateTrackedChanges } from '@/services/fileChangeTracker';
import { countConversationTokensExact } from '@/services/tokenizer';
import { estimateTokens, renderOpenFilesSection, renderRuntimeContextSection } from '@/services/systemPrompt';
import { getModelContextWindowForOption } from '@/store/selectors/modelSelectors';
import { conversationExporter } from '@/services/conversationExporter';
import { clearAutosaveSnapshot, loadAutosaveSnapshot, saveAutosaveSnapshot, saveConversationSnapshot, loadConversationSnapshot, migrateSnapshotAttachments, branchConversation, beginConversationSwitch, endConversationSwitch, isConversationSwitchCurrent, listConversationSummaries, AUTOSAVE_ID, CONVERSATION_SCHEMA_VERSION } from '@/services/conversationPersistence';
// ★ M4-2-S7：右侧栏对话浮层复用共享 hook（同 conversationHistory 数据源 + 同套工作区范围过滤口径，
//   与左侧栏 ConversationList 一致）。workspaceLabel 用于显示对话归属标记。
import { useConversationManager, workspaceLabel } from '@/hooks/useConversationManager';
import { platform, type ToolTaskSnapshot } from '@/platform';
import { releaseMessageAttachments, resolveAttachmentDataUrl, sanitizeMessagesForPersistence, collectMessageShas } from '@/services/attachmentRefs';
// ★ M4-2-S2：运行态消息 id 收敛到共享 crypto.randomUUID 生成器（治问题 2b(1) 弱熵同毫秒碰撞），
//   保留 prefix 习惯（user_/assistant_/msg_）。本地 generateMessageId 别名指向它，调用点零改动。
import { generateId as generateMessageId } from '@/services/ids';
import { setSelectedId, updateConversation, type ConversationSummary } from '@/store/slices/conversationHistory';
import { closeTab, openTab, reconcileTabFile, setActiveTab as setActiveEditorTab } from '@/store/slices/editorTabs';
import { store, type RootState } from '@/store';
// ★ #8 选A（byId 真并发）：未保存对话 fork 成真实 id 时迁桶 + 迁 worktree + 重绑在跑的 run，保后台进度不丢、不串台。
import { migrateForkedConversation } from '@/services/conversationMigrate';
import { rollbackFileDiffsAtomically, applyDiffGroupReview, type FileRollbackTransaction } from '@/services/fileRollback';
import { groupFileDiffs, normalizeDiffPath, reviewPathKeys, type DiffReviewGroup } from '@/services/diffReviewGrouping';
import { describeCapabilities, providerIdForModel } from '@/services/modelCapabilities';
import { resolveProviderModel } from '@/services/providerModelRuntime';
import { getContextGenerationState, getRecord, upsertRecord, clampToBatch, getRecordSkeleton } from '@/services/recordStore';
import { bpcScheduler } from '@/services/bpcScheduler';
import { confirmAction } from '@/services/confirmationCoordinator';
import { floorStepToRoundStart, identifyRounds } from '@/services/roundBoundary';
import {
  buildQueueDrainBatch,
  hasPendingToolTaskWork,
  isQueueDrainBatchCurrent,
  queueDrainBlockReason,
  queueDrainBoundaryMode,
  queueDrainCoordinator,
  type QueueDrainResult,
} from '@/services/queueDrainCoordinator';
// ★ Plan_5 梯队二 M5-3/4/5：回溯 / 重试 / 分支共用「按轮截断 + record 砍批到轮边界」helper（复用 roundBoundary）。
import { computeRoundTruncation, clampRecordToRoundTruncation, type RoundTruncationResult } from '@/services/roundTruncation';
// ★ M4-6 输入区命令层：触发检测（@艾特 / 斜杠命令）+ 内联补全浮层 + @数据源 + /命令注册表/执行器。
// ★ M6 富文本：textarea 弃用，改 contenteditable(RichTextInput)。
//   ★ C6/去重：两级 @ 菜单整套逻辑封装在 useAtMention hook，与编辑框(MessageBubble)共用。
import { RichTextInput } from '@/components/chat/RichTextInput';
import { useAtMention } from '@/components/chat/useAtMention';
import type { RichTextInputHandle, ExtractedToken } from '@/services/inputCommands/richInput/types';
import { buildRichParts } from '@/services/inputCommands/richInput/rebuild';
import { parseAndDispatch } from '@/services/inputCommands/commandExecutor';
// ★ M4-6-S4：/loop 最小循环驱动器（串行重发 N 次，可 handleStop 中断）。
import { loopRunner } from '@/services/inputCommands/loopRunner';
import {
  readCheckpointAgentTab,
  readCheckpointChatScroll,
  readCheckpointTabScroll,
  writeAgentSessionViewport,
  type AgentPanelTab,
  type ChatScrollCheckpoint,
} from '@/services/agentSessionCheckpoint';

// ★ M7 第四轮：系统/元工具清单——这些工具已有专门卡片可视化（artifact 卡片 / task_boundary 卡片 / worktree 通知），
//   工具调用卡片是冗余噪音。hideSystemToolCalls 开启时从消息流过滤掉它们（默认开启，设置可关，调试时关掉看全部）。
const SYSTEM_TOOL_NAMES = new Set([
  'begin_task_boundary', 'set_task_headline', 'update_task_progress', 'end_task_boundary',
  'show_artifact', 'enter_worktree', 'exit_worktree',
]);
const NON_FILE_EDITOR_TAB_TYPES = new Set([
  'welcome', 'settings', 'workflow', 'review', 'showcase', 'unsupported', 'attachment',
]);
const PROJECTED_OPEN_FILES_LIMIT = 20;
/** 按开关过滤掉系统/元工具调用；全被过滤则返回 undefined（不渲染空的工具调用容器）。 */
function filterSystemToolCalls<T extends { name?: string }>(tcs: T[] | undefined, hide: boolean): T[] | undefined {
  if (!hide || !tcs || tcs.length === 0) return tcs;
  const visible = tcs.filter(tc => !SYSTEM_TOOL_NAMES.has(tc.name ?? ''));
  return visible.length > 0 ? visible : undefined;
}

// ★ 五轮：判断一条 assistant 消息是否「完全无内容」——流式已结束 + content 空 + 无 thinking 正文 + 无可见工具
//   (系统工具隐藏后) + 无 diffs/artifacts/attachments。这种此前显示「无内容」占位(噪音)，应整条略过不渲染。
//   注意：isStreaming 中保留(可能还在生成「思考中」)；有任何可见内容的都不略过。
function isEmptyAssistantMessage(msg: any, hideSystemTools: boolean): boolean {
  if (!msg || msg.role !== 'assistant') return false;
  if (msg.isStreaming) return false;
  if (msg.content && String(msg.content).trim()) return false;
  if (msg.thinking?.content && String(msg.thinking.content).trim()) return false;
  const tools = filterSystemToolCalls(msg.toolCalls, hideSystemTools);
  if (tools && tools.length > 0) return false;
  if (msg.diffs?.length) return false;
  if (msg.artifacts?.length) return false;
  if (msg.attachments?.length) return false;
  return true;
}

// ★ B3（反馈#5）：AI 消息底部也挂重试/回溯按钮，但这俩按「轮」对齐、语义锚定在 user 消息上。
//   传入 AI/tool 消息 id 时向前回看找最近的 user 消息 id 作为锚；user id 原样返回；找不到返回原 id（兜底）。
function resolveRoundUserAnchor(msgs: any[], msgId: string): string {
  const idx = msgs.findIndex((m) => m.id === msgId);
  if (idx < 0) return msgId;
  if (msgs[idx]?.role === 'user') return msgId;
  for (let i = idx; i >= 0; i--) {
    if (msgs[i]?.role === 'user') return msgs[i].id;
  }
  return msgId;
}

const MAX_IMAGE_PAYLOAD_BYTES = 8 * 1024 * 1024;
// M4-3-S3：非图片（文档/文本/压缩包等）附件也走 sha256 内容寻址落地，与图片同一契约，
// 否则 sha256/payloadUrl 全空 → MessageBubble openable 恒 false、handleOpenAttachment 必然降级。
// 内容会读成 dataUrl 进 IndexedDB/文件实体，过大文件内存/存储成本高，设上限兜底（与图片对称）。
const MAX_FILE_PAYLOAD_BYTES = 25 * 1024 * 1024;
const INITIAL_MESSAGE_RENDER_UNITS = 32;
const MESSAGE_RENDER_UNIT_BATCH = 16;
const MAX_MESSAGE_RENDER_UNITS = 48;
const PLAN_STEP_BATCH = 80;
const ESTIMATED_MESSAGE_RENDER_UNIT_HEIGHT = 118;
const TAIL_PIN_THRESHOLD_PX = 4;
const TAIL_UNPIN_THRESHOLD_PX = 60;

type MessageRenderUnit = {
  id: string;
  startIdx: number;
  endIdx: number;
  boundary?: any;
};

function generateAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatContextCapability(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}m`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}k`;
  return String(tokens);
}

// ★ M6 富文本：autoResizeTextarea 移除——RichTextInput 自管高度（组件内部 autoResize + CSS max-height）。

function getAttachmentKind(file: File): AttachmentRef['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || /\.(md|txt|json|csv|ts|tsx|js|jsx|py|java|cpp|c|h)$/i.test(file.name)) return 'text';
  if (/\.(pdf|docx?|pptx?|xlsx?)$/i.test(file.name)) return 'document';
  if (/\.(zip|rar|7z|tar|gz)$/i.test(file.name)) return 'archive';
  return 'other';
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
    reader.readAsDataURL(file);
  });
}

export function AgentPanel() {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s: RootState) => (s as any).agentSettings.mode);
  const model = useAppSelector((s: RootState) => (s as any).agentSettings.currentModel);
  // ★ byId 治本：读活跃对话桶（原全量订阅整 slice；byId 后整 slice 顶层已无 messages 等对话私有字段 → 改读活跃桶，
  //   否则 conversation.messages 读到 undefined→崩。#9 细粒度优化可后续再拆；读活跃桶已比订阅全 byId 好——
  //   其它后台桶变化不触发本组件重渲）。
  const conversation = useAppSelector(selectActiveConversation);
  const messages = conversation.messages;
  const runtimeConversationId = conversation.id || AUTOSAVE_ID;
  const activeBpcUi = useAppSelector((s: RootState) => selectBpcUiState(s, runtimeConversationId));
  // 持有最新 conversation 供异步回调（如懒迁移 onMigrated）安全校验当前对话身份/消息数，不被 effect 闭包旧值误导。
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  // ★ M4-2-S5 对话工作区归属：新对话默认归当前打开的工作区（state.workspace.currentPath，null=Global）。
  //   用 ref 持有最新值——handleNewConversation 依赖数组只含 dispatch，不想因切工作区重建回调，故经 ref 读最新 path。
  const workspaceCurrentPath = useAppSelector((s: RootState) => s.workspace.currentPath);
  const workspaceCurrentPathRef = useRef(workspaceCurrentPath);
  workspaceCurrentPathRef.current = workspaceCurrentPath;
  // ★ M3-2b 修复（high）：标记当前是否在跑 @MultiAI 工作流（走 agentOrchestrator 而非 agentLoop）。
  //   runWorkflowFromInput 进入置 true / finally 置 false；handleStop 据此分流到 agentOrchestrator.abortAll()。
  const isWorkflowRunningRef = useRef(false);
  const isStreaming = useAppSelector((s: RootState) => selectActiveConversation(s).isStreaming);
  const [isLoopRunning, setIsLoopRunning] = useState(false);
  const [agentLoopResetGeneration, setAgentLoopResetGeneration] = useState(0);
  // ★ Plan_7 #6：keydown 当刻读最新流式态供 useAtMention runtimeMode getter（避免 hook 依赖频繁重建）。
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  // ★ #13：前台压缩进行中（驱动「压缩中」banner + 发送守卫）。
  const isCompacting = useAppSelector((s: RootState) => selectActiveConversation(s).isCompacting);
  const storeCompactingRef = useRef(isCompacting);
  storeCompactingRef.current = isCompacting;
  const historyMutationInFlightRef = useRef<string | null>(null);
  const [historyMutationLabel, setHistoryMutationLabel] = useState<string | null>(null);
  const projectedTokenRefreshSequenceRef = useRef(new Map<string, number>());
  // ★ H4-2：排队消息（生成中插话入队，本轮结束自动发）。运行态、不落库。
  const queuedMessages = useAppSelector((s: RootState) => selectActiveConversation(s).queuedMessages as QueuedMessage[]);
  // ★ Plan_7 #6：插队消息（生成中 Ctrl/Cmd+Enter 插话，下个空闲轮间插入）。运行态、不落库。
  const interruptMessages = useAppSelector((s: RootState) => selectActiveConversation(s).interruptMessages as QueuedMessage[]);
  // ★ Plan_7 #11：待审阅的文件改动（review changes 框列出 + 全部接受/拒绝）。
  const pendingDiffs = useAppSelector((s: RootState) => selectActiveConversation(s).pendingDiffs as FileDiffSummary[]);
  const fileSnapshots = useAppSelector((s: RootState) => selectActiveConversation(s).fileSnapshots);
  const editorTabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const settings = useAppSelector((s: RootState) => (s as any).settings);
  const agentSettings = useAppSelector((s: RootState) => (s as any).agentSettings);
  // M2-6：handleBranch 等异步回调（useCallback 依赖窄）需读当前 mode / reasoningEffort 落库，
  //   用 ref 持有最新值避免闭包旧值，且无需把这两项塞进回调依赖数组。
  const agentMetaRef = useRef({ mode, reasoningEffort: agentSettings.reasoningEffort as string, model });
  agentMetaRef.current = { mode, reasoningEffort: agentSettings.reasoningEffort, model };
  const trackedTokenCount = useAppSelector((s: RootState) => selectActiveConversation(s).tokenCount);
  const tokenCountSource = useAppSelector((s: RootState) => selectActiveConversation(s).tokenCountSource);
  // ★ M6 富文本：DOM 唯一真值，不再有受控 input 字符串态。richRef 命令式句柄 + canSend 派生发送可用性（P10）。
  const richRef = useRef<RichTextInputHandle>(null);
  const [canSend, setCanSend] = useState(false);
  // ★ C6/去重：@ 两级菜单整套逻辑抽到 useAtMention hook（与编辑框 MessageBubble 共用）。
  //   handleSend 在 hook 之后定义且用到 hook 的 closeMenu，故 onSubmit 经 ref 破环
  //   （hook 在前，提供 menuElement/handleEditorKeyDown/refreshMenu/closeMenu；handleSend 在后赋值给 ref）。
  // ★ Plan_7 #6：onSubmit 透传 { withModifier }（Ctrl/Cmd+Enter 与否），供生成中分流 queue/interrupt。
  const handleSendRef = useRef<(opts?: { withModifier?: boolean }) => void | Promise<void>>(() => {});
  // ★ C1（M7 第七轮反馈#6）：底部输入框发送键模式（设置可切换，默认 'enter'=Enter 发送/Shift+Enter 换行）。
  const sendKeyMode = (settings.sendKeyMode === 'ctrlEnter' ? 'ctrlEnter' : 'enter') as 'enter' | 'ctrlEnter';
  // ★ Plan_7 #6：生成中发送键主键动作（设置可切换，默认 'queue'=主键排队 / Ctrl·Cmd+Enter 插队）。
  const runtimeEnterAction = (settings.runtimeEnterAction === 'interrupt' ? 'interrupt' : 'queue') as 'queue' | 'interrupt';
  const { menuElement, handleEditorKeyDown, refreshMenu, closeMenu, openAtMenu } = useAtMention({
    richRef,
    onSubmit: (opts) => { void handleSendRef.current(opts); },
    submitOnPlainEnter: false,
    sendKeyMode, // ★ C1：底部输入框按设置切换发送键
    runtimeMode: () => isStreamingRef.current || isLoopRunning, // 工具轮间 streaming 会短暂归零，真实 loop 仍运行时也必须保留排队/插队键义。
    onAfterMutate: () => setCanSend(!richRef.current?.isEmpty()),
  });
  const [activeAgentTab, setActiveAgentTab] = useState<AgentPanelTab>(readCheckpointAgentTab);
  const [planVisibleStepCount, setPlanVisibleStepCount] = useState(PLAN_STEP_BATCH);
  const planMessages = useMemo(() => messages.filter((message: any) => message.toolCalls?.length > 0), [messages]);
  const visiblePlanMessages = useMemo(
    () => planMessages.slice(Math.max(0, planMessages.length - planVisibleStepCount)),
    [planMessages, planVisibleStepCount],
  );
  useEffect(() => setPlanVisibleStepCount(PLAN_STEP_BATCH), [runtimeConversationId]);
  const selectAgentTab = useCallback((nextTab: AgentPanelTab) => {
    const currentScrollTop = messagesContainerRef.current?.scrollTop;
    setActiveAgentTab(nextTab);
    const targetConversationId = conversationRef.current.id || AUTOSAVE_ID;
    writeAgentSessionViewport({
      conversationId: targetConversationId,
      activeAgentTab: nextTab,
      tabScrollTop: typeof currentScrollTop === 'number' ? { [activeAgentTab]: currentScrollTop } : undefined,
    });
  }, [activeAgentTab]);

  useEffect(() => {
    if (runtimeConversationId === AUTOSAVE_ID) return;
    void bpcScheduler.ensureConversationReady(runtimeConversationId).catch((error) => {
      console.warn('[AgentPanel] 恢复对话压缩状态失败:', error);
    });
  }, [runtimeConversationId]);

  // ★ C6/去重：menu 两级状态机已移入 useAtMention hook（上方）。
  // ★ C6/去重：atConvCache / atConvLoadingRef / 竞态守卫已移入 useAtMention hook。
  // ★ 验收补：footer 压缩环点击打开的本对话 BPC/硬压缩 override 浮层开关。
  const [bpcPopOpen, setBpcPopOpen] = useState(false);
  // ★ C3（M7 第七轮反馈#13）：输入区「加号小窗」开合 + 点外/Esc 关闭。原「上传文件 📎 + 上传图片 🖼」两按钮收敛成一个加号，
  //   点开弹小菜单：上传附件 / 提及@ / 选择工作流（参考 Codex 加号小窗）。
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuWrapRef.current && !addMenuWrapRef.current.contains(e.target as Node)) setAddMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [addMenuOpen]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    const handleDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setModelMenuOpen(false);
      requestAnimationFrame(() => modelTriggerRef.current?.focus());
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    document.addEventListener('keydown', handleDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      document.removeEventListener('keydown', handleDocKeyDown);
    };
  }, [modelMenuOpen]);
  const [modelSearch, setModelSearch] = useState('');
  const [modelActiveIndex, setModelActiveIndex] = useState(0);
  const modelOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // ★ M4-2-S7 右侧栏顶部对话管理浮层：复用共享 hook 取【scope 三态 + scopeFilters 映射 + 当前工作区 path +
  //   改归属动作】，并与左侧栏共享 conversationHistory.selectedId（切换后两栏选中天然同步）。
  //   ★ M4-2 审查修复（左右栏 slice 污染）：浮层列表【不再写共享 conversations slice】。原实现用
  //   refreshConvList({ archived:'all', ... }) → dispatch(setConversations) 覆盖共享 slice，而左侧栏
  //   ConversationList 直接渲染同一 slice 且默认 archived:'active'——打开一次右栏浮层就会把已归档对话灌进左栏
  //   且左栏不自愈重拉，单向污染左栏视图。改为浮层用【组件本地 state】(convList) 承载自己的查询结果，
  //   仅 selectedId 仍走共享 slice，彻底解耦两栏过滤口径，兑现注释里「浮层不污染左侧栏视图」的原意。
  //   convMenuOpen 控制浮层开合；convSearch 为浮层内【本地内存过滤】关键词（不触发重拉）。
  const {
    selectedId: convSelectedId,
    workspaceCurrentPath: agentWorkspacePath,
    scope: convScope,
    setScope: setConvScope,
    scopeFilters: convScopeFilters,
    moveToWorkspace: moveConvToWorkspace,
  } = useConversationManager();
  const [convMenuOpen, setConvMenuOpen] = useState(false);
  const [convSearch, setConvSearch] = useState('');
  // 浮层列表本地数据源（独立于共享 slice，不污染左侧栏）。
  const [convList, setConvList] = useState<ConversationSummary[]>([]);
  const convAnchorRef = useRef<HTMLButtonElement>(null);
  const convPanelRef = useRef<HTMLDivElement>(null);
  const [convMenuPos, setConvMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  // ★ H6（M8 第七轮反馈）：消息导航浮层——列出有 subtitle 的用户消息（排除 task_boundary 区间内），点击跳转。
  //   navMenuOpen 控制开合；anchor/panel ref 仿 conv 浮层做点外/Esc 关闭；navMenuPos 为 portal fixed 坐标。
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const navAnchorRef = useRef<HTMLButtonElement>(null);
  const navPanelRef = useRef<HTMLDivElement>(null);
  const [navMenuPos, setNavMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  // 当前正在编辑标题的导航项消息 id（null = 无）；编辑草稿文本。
  const [navEditingId, setNavEditingId] = useState<string | null>(null);
  const [navEditDraft, setNavEditDraft] = useState('');
  // 浮层本地列表刷新：按当前范围拉全量（含归档，浮层语义是「全量切换器」），结果只写本地 state、不碰共享 slice。
  const reloadConvMenu = useCallback(async () => {
    try {
      const summaries = await listConversationSummaries({ archived: 'all', limit: 200, ...convScopeFilters });
      setConvList(summaries);
    } catch {
      dispatch(addNotification({ type: 'error', title: '加载失败', message: '无法读取对话历史' }));
    }
  }, [convScopeFilters, dispatch]);
  // 浮层打开 / 范围切换时刷新本地列表。搜索为本地过滤，不在此触发。
  useEffect(() => {
    if (!convMenuOpen) return;
    void reloadConvMenu();
  }, [convMenuOpen, reloadConvMenu]);
  // 点外关闭（同 modelMenu 口径，但 portal 浮层不在 anchor 子树内，故需同时排除 anchor 与 panel）。
  useEffect(() => {
    if (!convMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (convAnchorRef.current?.contains(t)) return;
      if (convPanelRef.current?.contains(t)) return;
      setConvMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setConvMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [convMenuOpen]);
  // 打开浮层时按 anchor 位置算 portal 浮层坐标（fixed 定位，挂 body，避开 header overflow 裁剪）。
  const openConvMenu = useCallback(() => {
    const rect = convAnchorRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(360, Math.max(260, rect.width));
      // 右对齐 anchor 右边缘，避免超出右侧栏；夹在视口内。
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      setConvMenuPos({ top: rect.bottom + 6, left, width });
    }
    setConvSearch('');
    setConvMenuOpen(true);
  }, []);

  // ★ H6：消息导航浮层 —— 点外/Esc 关闭（同 conv 浮层口径，排除 anchor 与 panel）。
  useEffect(() => {
    if (!navMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (navAnchorRef.current?.contains(t)) return;
      if (navPanelRef.current?.contains(t)) return;
      setNavMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [navMenuOpen]);
  // ★ H6：打开导航浮层时按 anchor 算 portal fixed 坐标（同 conv 浮层）。
  const openNavMenu = useCallback(() => {
    const rect = navAnchorRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(340, Math.max(240, rect.width * 2));
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      setNavMenuPos({ top: rect.bottom + 6, left, width });
    }
    setNavEditingId(null);
    setNavMenuOpen(true);
  }, []);
  // ★ H6：保存手动改写的消息小标题（空串=保留原标题不动；非空回写 updateMessageMeta，随消息落库）。
  const saveNavSubtitle = useCallback((messageId: string, draft: string) => {
    const next = draft.trim().slice(0, 14); // 与生成上限 SUBTITLE_HARD_CHARS 对齐
    setNavEditingId(null);
    if (!next) return; // 空 → 不覆盖（避免误清；想清空可后续扩展）
    dispatch(updateMessageMeta({ id: messageId, changes: { subtitle: next, subtitleGeneratedAt: Date.now() } }));
  }, [dispatch]);

  // 浮层内本地搜索过滤（不重拉 slice）：按标题 / 最近消息匹配。
  const convFilteredList = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    if (!q) return convList;
    return convList.filter(c =>
      (c.title || '').toLowerCase().includes(q) ||
      (c.lastMessage || '').toLowerCase().includes(q));
  }, [convList, convSearch]);
  // M2-R1: 读取当前对话 record 各批次的 stepEnd（不含 tool 口径），用于在消息流按批次标出
  // 多条「压缩点」分隔线（展示仍完整原文）。空 record 时为空数组。
  // 问题1：新对话 id 为 null 时回退 AUTOSAVE_ID（autosave 落盘用同一 id），让 record 分隔线/回溯也对新对话生效。
  const conversationId = (conversation.id as string | null) || AUTOSAVE_ID;
  const [reviewBoxCollapsed, setReviewBoxCollapsed] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`synapse_review_box_collapsed:${conversationId}`);
      setReviewBoxCollapsed(stored === null ? true : stored === '1');
    } catch {
      setReviewBoxCollapsed(true);
    }
  }, [conversationId]);
  const toggleReviewBox = useCallback(() => {
    setReviewBoxCollapsed(current => {
      const next = !current;
      try { localStorage.setItem(`synapse_review_box_collapsed:${conversationId}`, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, [conversationId]);
  const applyToolTaskSnapshot = useCallback((snapshot: ToolTaskSnapshot) => {
    const terminal = !['running', 'cancelling'].includes(snapshot.status);
    dispatch(reconcileToolTaskStatus({
      taskId: snapshot.taskId,
      status: snapshot.status,
      result: terminal ? (snapshot.text || snapshot.error) : undefined,
      structured: terminal ? snapshot.structured : undefined,
      artifacts: terminal ? snapshot.artifacts : undefined,
      executionTime: terminal
        ? snapshot.executionTimeMs ?? (snapshot.finishedAt ? Math.max(0, snapshot.finishedAt - snapshot.startedAt) : undefined)
        : undefined,
      errorCode: snapshot.errorCode,
      unknownSideEffect: snapshot.unknownSideEffect,
      taskOwnerId: snapshot.ownerId,
      taskRunId: snapshot.runId,
      taskCallId: snapshot.callId,
      conversationId,
    }));
  }, [conversationId, dispatch]);
  const toolTaskReferences = useMemo(() => {
    const tasks = new Map<string, { status: ToolCall['status']; ownerId?: string; callId?: string }>();
    const ownerIds = new Set<string>();
    const orphanPendingCallIds = new Set<string>();
    for (const message of messages) {
      for (const toolCall of message.toolCalls ?? []) {
        if (toolCall.taskOwnerId) ownerIds.add(toolCall.taskOwnerId);
        if (toolCall.taskId) {
          tasks.set(toolCall.taskId, {
            status: toolCall.status,
            ownerId: toolCall.taskOwnerId,
            callId: toolCall.taskCallId || toolCall.id,
          });
        }
        if (!toolCall.taskId && (toolCall.status === 'pending' || toolCall.status === 'running' || toolCall.status === 'cancelling')) {
          orphanPendingCallIds.add(toolCall.id);
        }
      }
    }
    const knownTasks = [...tasks.entries()];
    return {
      knownTasks,
      pendingTasks: knownTasks.filter(([, task]) => task.status === 'pending' || task.status === 'running' || task.status === 'cancelling'),
      orphanPendingCallIds,
      ownerIds: [...ownerIds],
    };
  }, [messages]);
  const activeTaskBoundaryPresent = useMemo(
    () => conversation.taskBoundaries?.some(boundary => boundary.status === 'active') ?? false,
    [conversation.taskBoundaries],
  );
  useEffect(() => {
    const toolTask = window.synapse?.toolTask;
    const shouldReconcile = toolTaskReferences.pendingTasks.length > 0
      || toolTaskReferences.orphanPendingCallIds.size > 0
      || activeTaskBoundaryPresent;
    if (!toolTask || !shouldReconcile || (toolTaskReferences.knownTasks.length === 0 && toolTaskReferences.orphanPendingCallIds.size === 0)) return;
    if (!executionRegistry.getOwnerId(conversationId) && toolTaskReferences.ownerIds.length === 1) {
      executionRegistry.restoreOwnerForConversation(conversationId, toolTaskReferences.ownerIds[0]);
    }
    const fallbackOwnerId = executionRegistry.getOwnerId(conversationId)
      ?? toolTaskReferences.ownerIds[0]
      ?? conversationId;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconcile = async () => {
      let stillPending = false;
      let reconcileFailed = false;
      const listedTaskIds = new Set<string>();
      const knownTaskIds = new Set(toolTaskReferences.knownTasks.map(([taskId]) => taskId));
      const ownerIds = new Set([fallbackOwnerId, ...toolTaskReferences.ownerIds].filter(Boolean));
      for (const ownerId of ownerIds) {
        try {
          const snapshots = await toolTask.list({ conversationId, ownerId });
          if (disposed) return;
          for (const snapshot of snapshots) {
            listedTaskIds.add(snapshot.taskId);
            const shouldProject = snapshot.status === 'running'
              || snapshot.status === 'cancelling'
              || knownTaskIds.has(snapshot.taskId)
              || Boolean(snapshot.callId && toolTaskReferences.orphanPendingCallIds.has(snapshot.callId));
            if (!shouldProject) continue;
            if (snapshot.status === 'running' || snapshot.status === 'cancelling') stillPending = true;
            applyToolTaskSnapshot(snapshot);
          }
        } catch {
          reconcileFailed = true;
          if (toolTaskReferences.pendingTasks.length > 0 || toolTaskReferences.orphanPendingCallIds.size > 0) stillPending = true;
        }
      }
      for (const [taskId, task] of toolTaskReferences.pendingTasks) {
        if (listedTaskIds.has(taskId)) continue;
        try {
          const snapshot = await toolTask.status(taskId, {
            conversationId,
            ownerId: task.ownerId ?? fallbackOwnerId,
          });
          if (disposed) return;
          if (snapshot.status === 'running' || snapshot.status === 'cancelling') stillPending = true;
          applyToolTaskSnapshot(snapshot);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/(?:taskId|后台任务).*?(?:不属于当前对话|已绑定其它 run\/call|已被其它请求使用)/i.test(message)) {
            dispatch(reconcileToolTaskStatus({
              taskId,
              status: 'unknown',
              result: `后台任务身份无法恢复：${message}`,
              errorCode: 'task_access_denied',
              unknownSideEffect: false,
              conversationId,
            }));
          } else {
            reconcileFailed = true;
            stillPending = true;
          }
        }
      }
      if (!stillPending && !reconcileFailed && !executionRegistry.getLoop(conversationId)?.isRunning) {
        dispatch(settleRecoveredToolTaskBoundaries({ conversationId }));
      }
      if (stillPending && !disposed) timer = setTimeout(reconcile, 3_000);
    };
    void reconcile();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeTaskBoundaryPresent, applyToolTaskSnapshot, conversationId, dispatch, toolTaskReferences]);
  const handleRefreshToolTask = useCallback(async (taskId: string) => {
    const toolTask = window.synapse?.toolTask;
    if (!toolTask) return;
    const ownerId = toolTaskReferences.knownTasks.find(([candidate]) => candidate === taskId)?.[1].ownerId
      ?? executionRegistry.getOwnerId(conversationId)
      ?? conversationId;
    const snapshot = await toolTask.status(taskId, { conversationId, ownerId });
    applyToolTaskSnapshot(snapshot);
  }, [applyToolTaskSnapshot, conversationId, toolTaskReferences]);
  const handleCancelToolTask = useCallback(async (taskId: string) => {
    const toolTask = window.synapse?.toolTask;
    if (!toolTask) return;
    const ownerId = toolTaskReferences.knownTasks.find(([candidate]) => candidate === taskId)?.[1].ownerId
      ?? executionRegistry.getOwnerId(conversationId)
      ?? conversationId;
    const snapshot = await toolTask.cancel(taskId, { conversationId, ownerId });
    applyToolTaskSnapshot(snapshot);
  }, [applyToolTaskSnapshot, conversationId, toolTaskReferences]);
  const [recordBatchMarks, setRecordBatchMarks] = useState<BatchMark[]>([]);
  const refreshProjectedTokenCount = useCallback(async (
    targetConversationId: string,
    options?: { allowApiOverride?: boolean },
  ) => {
    const sequence = (projectedTokenRefreshSequenceRef.current.get(targetConversationId) ?? 0) + 1;
    projectedTokenRefreshSequenceRef.current.set(targetConversationId, sequence);
    const rec = await getRecord(targetConversationId);
    if (projectedTokenRefreshSequenceRef.current.get(targetConversationId) !== sequence) return;
    const rootState = store.getState() as RootState;
    const active = selectConversationById(rootState, targetConversationId);
    if (!active || active.messages.length === 0) {
      if (projectedTokenRefreshSequenceRef.current.get(targetConversationId) === sequence) {
        dispatch(setProjectedTokenCount({
          count: 0,
          conversationId: targetConversationId,
          allowApiOverride: options?.allowApiOverride,
        }));
      }
      return;
    }
    const history = active.messages.filter(message => message.role !== 'tool');
    const rounds = identifyRounds(history);
    const keepFrom = rec && rec.totalSteps > 0
      ? Math.max(0, Math.min(floorStepToRoundStart(rounds, rec.totalSteps), history.length - 1))
      : 0;
    const recordMd = rec ? buildStableRecordPrefix(rec, rootState.agentSettings.recordLayering) : '';
    const projectedMessages = recordMd
      ? [{ role: 'system', content: `[对话历史摘要]\n\n${recordMd}` }, ...history.slice(keepFrom)]
      : history;
    const selectionId = active.model || rootState.agentSettings.currentModel;
    const runtime = resolveProviderModel(
      selectionId,
      rootState.agentSettings.availableModels,
      rootState.settings.providerCredentials,
      rootState.settings.apiEndpoints,
    );
    const capabilities = runtime.option?.capabilities;
    const projectedMode = rootState.agentSettings.mode || 'planning';
    const contextWindow = getModelContextWindowForOption(
      runtime.option,
      rootState.agentSettings.contextWindowOverrides?.[selectionId],
    );
    const schemas = projectedMode === 'fast' || capabilities?.tools !== true ? [] : toolRegistry.getSchemas();
    const runtimeContextTokens = estimateTokens(renderRuntimeContextSection({
      systemTimeUtc: new Date().toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
      providerId: runtime.providerId,
      modelId: runtime.modelId,
      contextWindow,
      mode: projectedMode,
      reasoningEffort: capabilities?.reasoningEffortOptions?.includes(rootState.agentSettings.reasoningEffort)
        ? rootState.agentSettings.reasoningEffort
        : 'auto',
      speedTier: capabilities?.speedTierOptions?.includes(rootState.agentSettings.speedTier)
        ? rootState.agentSettings.speedTier
        : 'auto',
      supportsVision: capabilities?.vision === true,
      supportsTools: schemas.length > 0,
    })) + 4;
    const editorTabs = rootState.editorTabs as any;
    const fileTabs = (Array.isArray(editorTabs?.tabs) ? editorTabs.tabs : []).filter((tab: any) => (
      typeof tab.filePath === 'string'
      && tab.filePath.trim().length > 0
      && !NON_FILE_EDITOR_TAB_TYPES.has(tab.type ?? '')
    ));
    const activeTab = fileTabs.find((tab: any) => tab.id === editorTabs?.activeTabId);
    const openFiles = fileTabs.slice(0, PROJECTED_OPEN_FILES_LIMIT).map((tab: any) => ({
      path: tab.filePath,
      name: tab.fileName || tab.filePath,
      type: tab.type || 'file',
    }));
    if (fileTabs.length > PROJECTED_OPEN_FILES_LIMIT) {
      openFiles.push({ path: '', name: `…等 ${fileTabs.length - PROJECTED_OPEN_FILES_LIMIT} 个文件未列出`, type: '' });
    }
    const openFilesTokens = rootState.settings.promptInjection?.injectContext === false
      ? 0
      : estimateTokens(renderOpenFilesSection(openFiles.length > 0 ? openFiles : undefined, activeTab?.filePath));
    const projected = countConversationTokensExact(
      projectedMessages.map(message => ({ role: message.role, content: message.content })),
      selectionId,
    );
    const toolTokens = schemas.length > 0 ? estimateTokens(JSON.stringify(schemas)) : 0;
    const latestState = store.getState() as RootState;
    if (
      projectedTokenRefreshSequenceRef.current.get(targetConversationId) !== sequence
      || selectConversationById(latestState, targetConversationId) !== active
      || latestState.agentSettings !== rootState.agentSettings
      || latestState.settings !== rootState.settings
      || latestState.editorTabs !== rootState.editorTabs
    ) return;
    dispatch(setProjectedTokenCount({
      count: projected.count + toolTokens + runtimeContextTokens + openFilesTokens,
      conversationId: targetConversationId,
      allowApiOverride: options?.allowApiOverride,
    }));
  }, [dispatch]);

  const invalidateRequestLedgerForHistoryMutation = useCallback(async (targetConversationId: string) => {
    if (!platform.provider) return;
    const invalidated = await platform.provider.invalidateUsage(targetConversationId);
    if (!invalidated) throw new Error('无法使旧请求用量失效，历史记录尚未修改');
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!platform.provider) return;
    if (tokenCountSource === 'stale') {
      void refreshProjectedTokenCount(conversationId, { allowApiOverride: true })
        .catch(error => console.warn('[AgentPanel] 刷新新请求 Token 投影失败:', error));
      return;
    }
    const requestSequence = projectedTokenRefreshSequenceRef.current.get(conversationId) ?? 0;
    const isStale = () => cancelled
      || projectedTokenRefreshSequenceRef.current.get(conversationId) !== requestSequence;
    void platform.provider.latestUsage(conversationId).then(async usage => {
      if (isStale()) return;
      const state = store.getState() as RootState;
      const activeId = selectActiveConversation(state).id || AUTOSAVE_ID;
      if (activeId !== conversationId) return;
      const active = selectConversationById(state, conversationId);
      if (!active || active.messages.length === 0) return;
      const selectedModel = active?.model || (state as any).agentSettings.currentModel;
      const runtime = resolveProviderModel(
        selectedModel,
        (state as any).agentSettings.availableModels,
        (state as any).settings.providerCredentials,
        (state as any).settings.apiEndpoints,
      );
      if (!usage) {
        await refreshProjectedTokenCount(conversationId, { allowApiOverride: true });
        return;
      }
      const record = await getRecord(conversationId).catch(() => null);
      if (isStale()) return;
      const catalogGeneration = runtime.option?.catalog?.generation;
      const compressionGeneration = String(record?.revision ?? 0);
      const credential = state.settings.providerCredentials[runtime.providerId];
      const usageMatchesSelection = usage.providerId === runtime.providerId
        && usage.modelId === runtime.modelId
        && usage.conversationId === conversationId
        && (usage.accountFingerprint ?? null) === (credential?.accountFingerprint ?? null)
        && (usage.credentialGeneration ?? 0) === (credential?.credentialGeneration ?? 0)
        && (!catalogGeneration || usage.catalogGeneration === catalogGeneration)
        && usage.compressionGeneration === compressionGeneration;
      if (!usageMatchesSelection) {
        await refreshProjectedTokenCount(conversationId, { allowApiOverride: true });
        return;
      }
      projectedTokenRefreshSequenceRef.current.set(
        conversationId,
        (projectedTokenRefreshSequenceRef.current.get(conversationId) ?? 0) + 1,
      );
      dispatch(setTokenUsage({ ...usage, conversationId }));
    }).catch(error => console.warn('[AgentPanel] 恢复请求用量账本失败:', error));
    return () => { cancelled = true; };
  }, [
    activeBpcUi.state,
    agentSettings.availableModels,
    conversationId,
    dispatch,
    messages.length,
    model,
    refreshProjectedTokenCount,
    tokenCountSource,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) { setRecordBatchMarks([]); return; }
    void getRecord(conversationId).then(async rec => {
      if (cancelled) return;
      setRecordBatchMarks(extractBatchMarks(rec)); // ★ M5-BPC-7：带 source 的批标记（extractBatchMarks 内部过滤元批 + 编号）
      const active = conversationRef.current;
      if (
        !rec
        || rec.totalSteps <= 0
        || (active.tokenCountSource !== 'none' && active.tokenCountSource !== 'stale')
        || active.messages.length === 0
      ) return;
      await refreshProjectedTokenCount(conversationId);
    });
    return () => { cancelled = true; };
  }, [agentSettings.recordLayering, conversationId, messages.length, refreshProjectedTokenCount]);

  // 把各批 stepEnd（不含 tool 计数）映射到含-tool 的真实 messages 下标：
  // 分隔线画在「该批最后一条非-tool 消息」之后。返回 Map<messageIdx, [批序号...]>。
  const batchDividerByIdx = useMemo(() => {
    const map = new Map<number, { index: number; source: BatchSource }[]>();
    if (recordBatchMarks.length === 0) return map;
    const endMap = new Map<number, { index: number; source: BatchSource }[]>(); // stepEnd -> 批标记列表
    recordBatchMarks.forEach(m => {
      const arr = endMap.get(m.stepEnd) ?? [];
      arr.push({ index: m.index, source: m.source });
      endMap.set(m.stepEnd, arr);
    });
    let eligibleCount = 0;
    for (let idx = 0; idx < messages.length; idx++) {
      if ((messages[idx] as any).role === 'tool') continue;
      eligibleCount += 1;
      const hit = endMap.get(eligibleCount);
      if (hit) {
        // 分隔线挂在「下一条消息之前」，即该批最后一条非-tool 消息的下一个下标。
        // ★ M6 验收 bug5：渲染列表已过滤 role==='tool'（工具结果只在 assistant 的 ToolCallCard 折叠显示），
        //   若 idx+1 落在被过滤的 tool 消息上 divider 会随之丢失——故进位到下一条【非-tool】消息下标，保证 divider 仍挂可见消息前。
        let dividerIdx = idx + 1;
        while (dividerIdx < messages.length && (messages[dividerIdx] as any).role === 'tool') dividerIdx++;
        const existing = map.get(dividerIdx) ?? [];
        map.set(dividerIdx, [...existing, ...hit]);
      }
    }
    return map;
    // ★ 性能 3-A2：依赖 messages.length 而非整个 messages——分隔线位置只随消息【条数】+ record 批次变，
    //   不随流式追加的 content 变。流式每 flush messages 引用变但 length 不变 → 不再每 token 重算 O(n) 双层遍历。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordBatchMarks, messages.length]);

  // ★ task_boundary「卡片吞消息」（M7 第四轮返工）：把消息按边界 [anchorMessageId, endAnchorMessageId] 区间归组——
  //   区间内的消息收进 TaskBoundaryCard（反重力式：一个折叠卡片包住整个任务过程），区间外的消息正常平铺。
  //   并聚合每个边界区间内的文件变更（diffs/artifacts，同 path 取最新）作卡片「已编辑文件」。
  //   anchor 已不在消息里的边界归 orphan（末尾兜底，不吞消息）。返回 startIdx→区间 的 Map 供渲染按下标命中。
  const taskBoundaryRender = useMemo(() => {
    const boundaries = (conversation.taskBoundaries ?? []) as any[];
    const startMap = new Map<number, { b: any; startIdx: number; endIdx: number }>();
    const filesByBoundaryId = new Map<string, BoundaryFile[]>();
    const orphans: any[] = [];
    if (boundaries.length === 0) return { startMap, filesByBoundaryId, orphans };

    const basename = (p: string) => (p || '').split(/[/\\]/).pop() || p;
    const msgIdToIdx = new Map<string, number>();
    messages.forEach((m: any, i: number) => msgIdToIdx.set(m.id, i));

    const ranges: { b: any; startIdx: number; endIdx: number }[] = [];
    for (const b of boundaries) {
      const anchorIdx = b.anchorMessageId != null ? msgIdToIdx.get(b.anchorMessageId) : undefined;
      if (anchorIdx === undefined) { orphans.push(b); continue; }
      // ★ 反馈#1：卡片区间从 anchor（begin 那刻最后 assistant 消息＝开场白「我按流程来…」）的【下一条】开始，
      //   开场白留卡片外/前，卡片只含 begin 之后的过程消息。渲染 IIFE 不变：i=anchorIdx 正常渲染开场白，i=startIdx 才触发卡片。
      const startIdx = anchorIdx + 1;
      // active（无 endAnchor）或 endAnchor 被截断不在 → 延伸到当前末尾；done 边界用 endAnchor 本身——
      //   若 endAnchor < startIdx 表示 begin→end 间无过程的空任务，交由下方 startIdx>endIdx 跳过，不误延伸吞后文。
      let endIdx = b.endAnchorMessageId != null ? msgIdToIdx.get(b.endAnchorMessageId) : undefined;
      // ★ 主人反馈#3：只有【active】(进行中、本就该随新消息延伸) 才延伸到当前末尾；done/aborted 已收口的边界，
      //   即便 endAnchor 缺失（旧数据未记 / 被截断清空 / 异常收口未设）也【绝不延伸吞后文】——否则收口后用户
      //   新发的消息被并进已完成卡片（CDP 实测：done 边界 endAnchor=null → 卡片从 startIdx 吞到 messages 末尾）。
      //   缺失时退化为空区间（endIdx<startIdx），下方 startIdx>endIdx 跳过该卡片、消息照常单独渲染（不折叠胜过误吞）。
      if (b.status === 'active') {
        if (b.endAnchorMessageId == null || endIdx === undefined) endIdx = messages.length - 1;
      } else if (endIdx === undefined) {
        endIdx = startIdx - 1;
      }
      ranges.push({ b, startIdx, endIdx });
    }
    // 防区间重叠（理论不重叠：begin 会收口前一个 active；保险按 startIdx 升序裁剪）。
    ranges.sort((a, c) => a.startIdx - c.startIdx);
    let lastEnd = -1;
    for (const r of ranges) {
      if (r.startIdx <= lastEnd) r.startIdx = lastEnd + 1;
      if (r.startIdx > r.endIdx || r.startIdx >= messages.length) continue;
      startMap.set(r.startIdx, r);
      lastEnd = r.endIdx;
      // 聚合区间内文件变更：diff 同 path 取最新状态，artifact 同 path 去重。
      const files: BoundaryFile[] = [];
      const fileByKey = new Map<string, BoundaryFile>();
      for (let i = r.startIdx; i <= r.endIdx && i < messages.length; i++) {
        const m: any = messages[i];
        for (const d of (m.diffs ?? [])) {
          const key = `diff:${d.path}`;
          const existing = fileByKey.get(key);
          if (existing) {
            existing.ref = d; existing.changeType = d.changeType;
            existing.additions = d.additions; existing.deletions = d.deletions;
          } else {
            const f: BoundaryFile = { key, path: d.path, label: basename(d.path), kind: 'diff', changeType: d.changeType, additions: d.additions, deletions: d.deletions, ref: d };
            fileByKey.set(key, f); files.push(f);
          }
        }
        for (const a of (m.artifacts ?? [])) {
          const key = `artifact:${a.path}`;
          if (!fileByKey.has(key)) {
            const f: BoundaryFile = { key, path: a.path, label: a.label || basename(a.path), kind: 'artifact', ref: a };
            fileByKey.set(key, f); files.push(f);
          }
        }
      }
      filesByBoundaryId.set(r.b.id, files);
    }
    return { startMap, filesByBoundaryId, orphans };
  }, [conversation.taskBoundaries, messages]);

  // 超长对话只挂载最近一段顶层消息单元；向上滚动时再按批补入更早内容。
  // Redux 仍保留完整历史作为真实数据源，窗口化只影响 React/DOM 投影，不改变消息、边界和压缩语义。
  const messageRenderUnits = useMemo(() => {
    const hideSysTools = agentSettings.hideSystemToolCalls ?? true;
    const units: MessageRenderUnit[] = [];
    let idx = 0;
    while (idx < messages.length) {
      const range = taskBoundaryRender.startMap.get(idx);
      if (range) {
        units.push({ id: `tb-${range.b.id}`, startIdx: range.startIdx, endIdx: range.endIdx, boundary: range.b });
        idx = range.endIdx + 1;
        continue;
      }
      const message: any = messages[idx];
      if (message.role !== 'tool' && !isEmptyAssistantMessage(message, hideSysTools)) {
        units.push({ id: message.id, startIdx: idx, endIdx: idx });
      }
      idx += 1;
    }
    return units;
  }, [agentSettings.hideSystemToolCalls, messages, taskBoundaryRender.startMap]);

  const messageUnitIndexById = useMemo(() => {
    const map = new Map<string, number>();
    messageRenderUnits.forEach((unit, unitIndex) => {
      for (let idx = unit.startIdx; idx <= unit.endIdx && idx < messages.length; idx++) {
        const messageId = (messages[idx] as any)?.id;
        if (messageId) map.set(messageId, unitIndex);
      }
    });
    return map;
  }, [messageRenderUnits, messages]);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const lastMessagesScrollTopRef = useRef(0);
  const scrollPersistTimerRef = useRef<number | null>(null);
  const liveConversationIdRef = useRef(conversationId);
  const [boundaryRevealRequest, setBoundaryRevealRequest] = useState<{ boundaryId: string; messageId: string; nonce: number } | null>(null);
  const messageWindow = useMessageWindow({
    units: messageRenderUnits,
    containerRef: messagesContainerRef,
    conversationId,
    active: activeAgentTab === 'chat',
    isAtBottomRef,
    initialUnits: INITIAL_MESSAGE_RENDER_UNITS,
    maxUnits: MAX_MESSAGE_RENDER_UNITS,
    batchUnits: MESSAGE_RENDER_UNIT_BATCH,
    estimatedUnitHeight: ESTIMATED_MESSAGE_RENDER_UNIT_HEIGHT,
  });
  const {
    range: messageWindowRange,
    visibleUnits: visibleMessageRenderUnits,
    topSpacerHeight: messageWindowTopSpacerHeight,
    bottomSpacerHeight: messageWindowBottomSpacerHeight,
    canLoadOlder: canLoadOlderMessageUnits,
    canLoadNewer: canLoadNewerMessageUnits,
    loadOlder: loadOlderMessageUnits,
    loadNewer: loadNewerMessageUnits,
    jumpToTail: jumpToLatestMessageWindow,
    setWindowForIndex: setMessageWindowForIndex,
    setWindowRange: setMessageWindowRange,
    getUnitProps: getMessageWindowUnitProps,
    isWindowStartNearViewport: isMessageWindowStartNearViewport,
    isWindowEndNearViewport: isMessageWindowEndNearViewport,
  } = messageWindow;
  const effectiveVisibleMessageUnitStart = messageWindowRange.start;
  const effectiveVisibleMessageUnitEnd = messageWindowRange.end;
  const effectiveVisibleMessageUnitStartRef = useRef(effectiveVisibleMessageUnitStart);
  const effectiveVisibleMessageUnitEndRef = useRef(effectiveVisibleMessageUnitEnd);
  liveConversationIdRef.current = conversationId;
  effectiveVisibleMessageUnitStartRef.current = effectiveVisibleMessageUnitStart;
  effectiveVisibleMessageUnitEndRef.current = effectiveVisibleMessageUnitEnd;

  // 导航目标可能尚未挂载：先扩展渲染窗口，再按消息锚点定位和闪烁。
  const scrollToMessage = useCallback((messageId: string) => {
    const reveal = () => {
      const container = messagesContainerRef.current;
      if (!container) return;
      const element = container.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) as HTMLElement | null;
      if (!element) return;
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      container.scrollTop = Math.max(0, container.scrollTop + (elementRect.top - containerRect.top) - 12);
      element.classList.remove('message-nav-flash');
      void element.offsetWidth;
      element.classList.add('message-nav-flash');
      window.setTimeout(() => element.classList.remove('message-nav-flash'), 1200);
    };
    const targetUnitIndex = messageUnitIndexById.get(messageId);
    const targetUnit = targetUnitIndex === undefined ? undefined : messageRenderUnits[targetUnitIndex];
    if (targetUnit?.boundary) {
      setBoundaryRevealRequest({ boundaryId: targetUnit.boundary.id, messageId, nonce: Date.now() });
    }
    if (
      targetUnitIndex !== undefined
      && (targetUnitIndex < effectiveVisibleMessageUnitStart || targetUnitIndex >= effectiveVisibleMessageUnitEnd)
    ) {
      setMessageWindowForIndex(targetUnitIndex, { before: 8 });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        reveal();
        window.setTimeout(reveal, 80);
      }));
      return;
    }
    reveal();
    if (targetUnit?.boundary) window.setTimeout(reveal, 80);
  }, [
    effectiveVisibleMessageUnitEnd,
    effectiveVisibleMessageUnitStart,
    messageRenderUnits,
    messageUnitIndexById,
    setMessageWindowForIndex,
  ]);

  const handleBoundaryRevealConsumed = useCallback((nonce: number) => {
    setBoundaryRevealRequest(current => current?.nonce === nonce ? null : current);
  }, []);

  // ★ H6（M8 第七轮反馈）：消息导航项 —— 取所有带 subtitle 的【用户消息】，排除落在 task_boundary
  //   区间（anchorMessageId..endAnchorMessageId）内的消息（边界内消息已被 TaskBoundaryCard 折叠，不单列导航）。
  //   active 边界（无 endAnchor）视为延伸到当前末尾。返回 { id, subtitle, seq } 列表，供浮层渲染与跳转。
  const navItems = useMemo(() => {
    const boundaries = (conversation.taskBoundaries ?? []) as any[];
    const msgIdToIdx = new Map<string, number>();
    messages.forEach((m: any, i: number) => msgIdToIdx.set(m.id, i));
    // 计算被 boundary 覆盖的消息下标集合（含区间端点；anchor 本身＝边界开场白也算覆盖内，不单列）。
    const coveredIdx = new Set<number>();
    for (const b of boundaries) {
      const startIdx = b.anchorMessageId != null ? msgIdToIdx.get(b.anchorMessageId) : undefined;
      if (startIdx === undefined) continue; // anchor 已不在消息里（被截断）→ 该边界不参与覆盖判断
      let endIdx = b.endAnchorMessageId != null ? msgIdToIdx.get(b.endAnchorMessageId) : undefined;
      // ★ 主人反馈#3 一致性：done/aborted 已收口边界即便 endAnchor 缺失也不延伸到末尾（否则收口后 user 消息被
      //   误判落在覆盖区间、从导航里漏掉）。仅 active 才延伸。
      if (b.status === 'active') {
        if (b.endAnchorMessageId == null || endIdx === undefined) endIdx = messages.length - 1;
      } else if (endIdx === undefined) {
        endIdx = startIdx - 1;
      }
      for (let i = startIdx; i <= endIdx && i < messages.length; i++) coveredIdx.add(i);
    }
    // ★ #12b：item 带原始消息下标 idx，供导航浮层在压缩点边界处插入「— 压缩点 —」分隔行。
    const items: Array<{ id: string; subtitle: string; seq: number; timestamp?: number; idx: number }> = [];
    let seq = 0;
    // ★ 主人反馈#1：导航按【轮】生成, 不再每条 user 各一项——
    //   ① 一轮（连续多条 user 消息 + 随后 AI 回复）只出一项, 定位到该轮【第一条】user;
    //   ② 「模型开始回复才生成本轮导航」: 仅当该轮已出现【非空 / 流式中的 assistant】(AI 真的开始回复) 才收录,
    //      杜绝「连发一堆 user 还没回复就冒一堆导航项」与「发不出的孤立 user 也生成导航」。
    //   轮首判定: 一条 user, 其前一条【非 tool】消息不是 user(是 assistant 或序列开头)→ 本条是轮首。
    const prevNonToolIsUser = (idx: number) => {
      for (let j = idx - 1; j >= 0; j--) {
        const r = (messages[j] as any).role;
        if (r !== 'tool') return r === 'user';
      }
      return false; // 序列开头 → 本条是轮首
    };
    let roundFirstUserIdx = -1;
    let roundCollected = false;
    messages.forEach((m: any, i: number) => {
      if (m.role === 'user') {
        if (!prevNonToolIsUser(i)) { roundFirstUserIdx = i; roundCollected = false; } // 轮首 user（连发的后续 user 不更新）
        return;
      }
      // 本轮首条【非空 / 流式中】assistant 出现 = AI 已开始回复本轮 → 收录该轮首 user（仅一次）。
      if (m.role === 'assistant' && !roundCollected && roundFirstUserIdx >= 0
          && ((((m.content as string) || '').trim().length > 0) || m.isStreaming)) {
        roundCollected = true;
        const fu: any = messages[roundFirstUserIdx];
        const subtitle = fu.subtitle as string | undefined;
        if (!subtitle) return;                          // 轮首无小标题（纯附件/未生成）→ 不收录
        if (coveredIdx.has(roundFirstUserIdx)) return;  // 轮首落在 task_boundary 区间内（已折叠）→ 不收录
        seq += 1;
        items.push({ id: fu.id, subtitle, seq, timestamp: fu.timestamp, idx: roundFirstUserIdx });
      }
    });
    return items;
  }, [conversation.taskBoundaries, messages]);

  // ★ #12b：导航浮层压缩点行 —— 把 batchDividerByIdx（压缩点挂在哪个消息下标前）的下标
  //   收成升序数组，渲染时在「上一项 idx < 压缩点下标 <= 当前项 idx」的位置前插一行「— 压缩点 —」，
  //   让用户从导航就能看到哪些消息之后发生过压缩。返回 [{ atIdx, marks }] 升序列表。
  const navCompactPoints = useMemo(() => {
    const pts: Array<{ atIdx: number; marks: { index: number; source: BatchSource }[] }> = [];
    batchDividerByIdx.forEach((marks, atIdx) => pts.push({ atIdx, marks }));
    pts.sort((a, b) => a.atIdx - b.atIdx);
    return pts;
  }, [batchDividerByIdx]);

  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentRef | null>(null);
  // M2-R6 渲染还原：历史消息的 image 附件落库后只有 sha256（无 previewUrl base64），
  // 按 sha256 懒加载还原成 dataUrl 供 MessageBubble 渲染。Map<sha256, dataUrl>。
  const [resolvedPreviews, setResolvedPreviews] = useState<Map<string, string>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // ★ B2（反馈#10）：记录 chat tab 的滚动位置——切到 Plan/Context 再切回 chat 时恢复，避免回到顶部。
  const chatScrollTopRef = useRef(0);
  const restoredScrollConversationRef = useRef('');
  const restoringScrollRef = useRef(false);
  // ★ M6：inputRef 移除（textarea→RichTextInput，命令式句柄用 richRef）。
  const agentLoopRef = useRef<AgentLoop | null>(null);
  // ★ 权限弹窗前端化（诊断#4）：审批浮层状态 + pending Promise resolve（替代原生 window.confirm）。
  const [approvalReq, setApprovalReq] = useState<ApprovalRequest | null>(null);
  const handleApprovalApprove = useCallback(() => {
    if (approvalReq) approvalCoordinator.resolve(approvalReq.id, true);
  }, [approvalReq]);
  const handleApprovalReject = useCallback(() => {
    if (approvalReq) approvalCoordinator.resolve(approvalReq.id, false);
  }, [approvalReq]);

  useEffect(() => approvalCoordinator.subscribe(ticket => {
    const sourceConversation = ticket?.conversationId
      ? selectConversationById(store.getState() as RootState, ticket.conversationId)
      : null;
    const conversationLabel = ticket?.conversationId
      ? `${sourceConversation?.title || '未命名对话'} · ${ticket.conversationId.slice(-8)}`
      : '未命名对话';
    setApprovalReq(ticket ? {
      id: ticket.id,
      toolName: ticket.toolName,
      level: ticket.level,
      argsText: ticket.argsText,
      originLabel: ticket.originLabel,
      conversationLabel,
      message: ticket.message,
    } : null);
  }), []);

  // ★ M6：autoResize useLayoutEffect 移除——RichTextInput 内部自管高度（onInput/rAF + CSS max-height）。
  const availableModels = useMemo(() => agentSettings.availableModels ?? [], [agentSettings.availableModels]);
  const currentProviderModel = useMemo(
    () => resolveProviderModel(model, availableModels, settings.providerCredentials, settings.apiEndpoints),
    [availableModels, model, settings.apiEndpoints, settings.providerCredentials],
  );
  const hasApiKey = currentProviderModel.credentialConfigured;
  const hasModel = currentProviderModel.selectionAvailable;
  const currentModelOption = currentProviderModel.option;
  const currentCapabilities = currentModelOption?.capabilities;
  const configuredContextOverride = agentSettings.contextWindowOverrides?.[model];
  const declaredContextWindow = currentCapabilities?.contextWindow ?? currentModelOption?.contextWindow;
  const currentCatalogStale = currentModelOption?.catalog?.stale === true;
  const hasContextOverride = typeof configuredContextOverride === 'number'
    && Number.isFinite(configuredContextOverride)
    && configuredContextOverride > 0
    && configuredContextOverride !== declaredContextWindow;
  const capabilityLabels = useMemo(() => {
    const labels = [
      ...(currentCatalogStale ? ['Cached catalog'] : []),
      ...describeCapabilities(currentCapabilities),
    ];
    if (!declaredContextWindow) {
      return [
        ...labels,
        hasContextOverride
          ? `${formatContextCapability(configuredContextOverride)} override`
          : `${formatContextCapability(getModelContextWindowForOption(currentModelOption))} safe fallback`,
      ];
    }
    if (!hasContextOverride) return labels;
    return [
      ...labels.map(label => label.endsWith(' ctx')
        ? `${formatContextCapability(declaredContextWindow)} model`
        : label),
      `${formatContextCapability(configuredContextOverride)} override`,
    ];
  }, [configuredContextOverride, currentCapabilities, currentCatalogStale, currentModelOption, declaredContextWindow, hasContextOverride]);
  const reasoningOptions = currentCapabilities?.reasoning
    ? (currentCapabilities.reasoningEffortOptions?.length
      ? currentCapabilities.reasoningEffortOptions
      : ['auto'])
    : ['auto'];
  const speedOptions = currentCapabilities?.speedTierOptions?.length
    ? currentCapabilities.speedTierOptions
    : ['auto'];
  const supportedParameters = currentCapabilities?.supportedParameters ?? [];
  const supportsStreamOptions = supportedParameters.includes('stream_options') || supportedParameters.includes('include_usage');
  const supportsTemperature = supportedParameters.includes('temperature');
  const supportsTopP = supportedParameters.includes('top_p');
  const maxTokenParameter = supportedParameters.find((parameter): parameter is 'max_tokens' | 'max_output_tokens' | 'max_completion_tokens' => (
    ['max_tokens', 'max_output_tokens', 'max_completion_tokens'].includes(parameter)
  ));
  const supportsMaxTokens = Boolean(maxTokenParameter);

  const aiClientConfig = useMemo(() => {
    if (!currentProviderModel.ready || !currentProviderModel.modelId) return null;
    return {
      providerId: currentProviderModel.providerId,
      requestKind: 'agent' as const,
      vision: currentCapabilities?.vision === true,
      contextWindow: getModelContextWindowForOption(currentModelOption, configuredContextOverride),
      baseUrl: currentProviderModel.baseUrl,
      model: currentProviderModel.modelId,
      catalogGeneration: currentModelOption?.catalog?.generation,
      // ★ 模型参数门控（诊断#3）：模型不支持的参数传 undefined（而非旧值），与 buildBody「undefined 不写 body」配合，
      //   真正不发送不支持的参数；UI 滑块本就 disable，这里同步切断发送链，不再打脸面板提示。
      temperature: supportsTemperature ? (agentSettings.temperature ?? 0.7) : undefined,
      topP: supportsTopP ? (agentSettings.topP ?? 1) : undefined,
      maxTokens: supportsMaxTokens
        ? Math.min(agentSettings.maxTokens ?? 4096, currentCapabilities?.maxOutputTokens ?? Number.POSITIVE_INFINITY)
        : undefined,
      maxTokenParameter,
      stream: currentCapabilities?.streaming === true,
      streamOptions: supportsStreamOptions,
      outputStrategy: agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off'),
      pseudoStreamSpeed: agentSettings.pseudoStreamSpeed ?? 'medium',
      showStreamCursor: agentSettings.showStreamCursor ?? true,
      showGeneratingPlaceholder: agentSettings.showGeneratingPlaceholder ?? true,
      streamThinking: agentSettings.streamThinking ?? true,
      reasoningEffort: currentCapabilities?.reasoningEffortOptions?.includes(agentSettings.reasoningEffort)
        ? agentSettings.reasoningEffort
        : 'auto',
      speedTier: currentCapabilities?.speedTierOptions?.includes(agentSettings.speedTier) ? agentSettings.speedTier : 'auto',
    };
  }, [
    currentProviderModel.ready,
    currentProviderModel.baseUrl,
    currentProviderModel.modelId,
    currentProviderModel.providerId,
    configuredContextOverride,
    currentModelOption,
    agentSettings.temperature,
    agentSettings.topP,
    agentSettings.maxTokens,
    agentSettings.enableStreaming,
    agentSettings.outputStrategy,
    agentSettings.pseudoStreamSpeed,
    agentSettings.showStreamCursor,
    agentSettings.showGeneratingPlaceholder,
    agentSettings.streamThinking,
    agentSettings.reasoningEffort,
    agentSettings.speedTier,
    currentCapabilities,
    supportsTemperature,
    supportsTopP,
    supportsMaxTokens,
    supportsStreamOptions,
    maxTokenParameter,
  ]);

  // 每个对话拥有独立 AgentLoop 与独立 AIClient；切换页面只切当前引用，不停止其它对话。
  useEffect(() => {
    if (!aiClientConfig) {
      agentLoopRef.current = null;
      setIsLoopRunning(false);
      return;
    }
    const nextClient = new AIClient(aiClientConfig);
    const supportsTools = currentCapabilities?.tools === true;
    executionRegistry.removeIdleLoop(conversationId);
    const loop = executionRegistry.getOrCreateLoop<AgentLoop>(conversationId, ownerId => {
      dispatch(renameWorktreeContext({ fromId: conversationId, toId: ownerId }));
      migrateTrackedChanges(conversationId, ownerId);
      return new AgentLoop(nextClient, { conversationId, ownerId, supportsTools });
    });
    loop.updateClient(nextClient, supportsTools);
    // ★ M4-7-S4：把 MCP 工具桥接进 toolRegistry，使本 AgentLoop 的工具集含 MCP 工具。
    //   refresh 异步（拉 getStatus → 对 running server listTools → register 进 toolRegistry），故 refresh
    //   完成后再 registerTools 一次——保证 getSchemas() 此刻已含 MCP 工具。先同步注册一次让内置工具立即可用、
    //   不被 MCP 异步发现阻塞；Web 模式 / 拉取失败时 refresh 天然空集，照常用内置工具集。
    const wireTools = () => {
      loop.registerTools(
        toolRegistry.getSchemas() as any[],
        // 完整透传本轮工具身份；ownerId 作为稳定 contextId，AUTOSAVE 提升后也不会把 worktree/改动账本换桶。
        (name, args, context) => toolRegistry.execute(name, args, { ...context, contextId: context.ownerId }),
        // ★ M4-7 审查修复：传入动态取数函数，让 AgentLoop 每轮发请求前实时取最新 schema。
        //   这样 SettingsPanel 启停 MCP server（改了 toolRegistry）后无需重建本 AgentLoop——启动的工具立即
        //   进入下一轮请求的 schema 让 AI 主动调用，停止的工具同步移出快照（AI 不再调用已注销工具拿 'Tool not found'）。
        () => toolRegistry.getSchemas() as any[],
      );
    };
    wireTools();
    void mcpBridge.refresh().then(wireTools).catch(() => { /* MCP 发现失败：保持内置工具集，不阻塞主对话 */ });
    // P1-3: 设置审批回调（弹出确认对话框）
    // ★ M3-1a medium#4：meta 携带子代理来源标识——后台子代理调用 write/command 级工具弹审批时，
    //   文案前缀「子代理「角色」请求…」，让用户分清是主代理还是哪个子代理发起（旧文案只说「AI 请求」无法区分）。
    toolRegistry.setApprovalCallback((toolName, args, level, meta, policyMessage) => {
      // ★ 权限弹窗前端化（诊断#4）：用 ApprovalDialog 玻璃浮层替代原生 window.confirm（样式一致 + 动画 + Esc/Enter）。
      //   enter_worktree 保留定制说明（真实 git 写盘 + 建分支，降低误批）；参数不再截断 200 字（浮层可滚动看全）。
      let message = policyMessage;
      if (toolName === 'enter_worktree') {
        const branch = typeof args?.branch === 'string' && args.branch.trim() ? args.branch.trim() : '（自动生成时间戳分支）';
        const worktreeMessage = `进入 git worktree（隔离工作树）。\n\n这会在磁盘 userData/worktrees 下创建一个工作树目录，并在当前仓库新建（或复用已有）分支：\n  分支：${branch}\n\n进入后 AI 的文件读写/命令将作用于该工作树（与主工作区隔离），而非直接改主工作区。`;
        message = [policyMessage, worktreeMessage].filter(Boolean).join('\n\n');
      }
      return approvalCoordinator.request(toolName, args, level, meta, message);
    });
    // ★ #5/#12 修复：安全设置同步已抽到下方独立 useEffect([settings.safety])，本工厂不再依赖 settings.safety，
    //   杜绝「run 进行中改安全设置 → 工厂重建 loop → 旧 running loop 失联成幽灵 run」（#5 双流 / #12 中止卡）。
    agentLoopRef.current = loop;
    const unsubscribeRunning = loop.subscribeRunning(setIsLoopRunning);
    // 页面载入时就恢复这条对话的持久压缩状态。否则重启前遗留的 retry/backoff
    // 只有等用户下一次发送时才会归一，界面与数据库会在空闲期间长期不一致。
    if (conversationId !== AUTOSAVE_ID) {
      void bpcScheduler.ensureConversationReady(conversationId).catch(error => {
        console.warn('[AgentPanel] 恢复对话压缩状态失败:', error);
      });
    }
    return () => {
      unsubscribeRunning();
      if (agentLoopRef.current === loop) agentLoopRef.current = null;
      setIsLoopRunning(false);
    };
  }, [agentLoopResetGeneration, aiClientConfig, conversationId, currentCapabilities?.tools, dispatch]);

  // ★ #5/#12 修复：安全设置同步【独立 effect】，不再触发 AgentLoop 工厂重建。
  //   AgentLoop 通过 toolRegistry 动态读 autoApprove（execute 时实时取），改安全设置只需热更新 toolRegistry，
  //   无需重建 loop；这样 run 进行中改安全设置不会再产生失联的幽灵 run（#5 双流 / #12 中止卡的根因之一）。
  useEffect(() => {
    const safety = settings.safety;
    if (safety) {
      toolRegistry.updateAutoApprove({
        read: safety.autoApproveRead ?? true,
        write: safety.autoApproveWrite ?? false,
        command: safety.autoApproveCommand ?? false,
        all: safety.autoApproveAll ?? false,
        fullAccess: safety.fullAccess ?? false,
      });
      const requestedAutoApproveWrite = safety.autoApproveWrite ?? false;
      void platform.file.setApprovalPolicy({ autoApproveWrite: requestedAutoApproveWrite })
        .then(result => {
          if (result.autoApproveWrite !== requestedAutoApproveWrite) {
            dispatch(setSafety({ autoApproveWrite: result.autoApproveWrite }));
          }
        })
        .catch(() => undefined);
    }
  }, [dispatch, settings.safety]);

  const persistChatScrollState = useCallback((targetConversationId: string, sync = false) => {
    const current = messagesContainerRef.current;
    if (!current || restoringScrollRef.current) return;
    let checkpoint: ChatScrollCheckpoint;
    try {
      const containerRect = current.getBoundingClientRect();
      const visibleAnchorCandidates = [...current.querySelectorAll<HTMLElement>('[data-message-id], [data-task-boundary-id]')]
        .filter(candidate => {
          const candidateRect = candidate.getBoundingClientRect();
          return candidateRect.bottom > containerRect.top + 1
            && candidateRect.top < containerRect.bottom - 1;
        });
      const anchorElement = visibleAnchorCandidates.find(candidate => candidate.dataset.messageId)
        ?? visibleAnchorCandidates[0];
      const anchor: ChatScrollCheckpoint['anchor'] = anchorElement ? {
        kind: anchorElement.dataset.messageId ? 'message' : 'boundary',
        id: anchorElement.dataset.messageId ?? anchorElement.dataset.taskBoundaryId,
        offset: anchorElement.getBoundingClientRect().top - containerRect.top,
      } : undefined;
      checkpoint = {
        scrollTop: current.scrollTop,
        atBottom: isAtBottomRef.current,
        visibleUnitStart: effectiveVisibleMessageUnitStartRef.current,
        visibleUnitEnd: effectiveVisibleMessageUnitEndRef.current,
        anchor,
        updatedAt: Date.now(),
      };
    } catch {
      return;
    }
    try {
      localStorage.setItem(`synapse:chat-scroll:${targetConversationId}`, JSON.stringify(checkpoint));
    } catch { /* SQLite checkpoint remains available when localStorage is unavailable. */ }
    writeAgentSessionViewport({
      conversationId: targetConversationId,
      activeAgentTab,
      chatScroll: checkpoint,
      sync,
    });
  }, [activeAgentTab]);

  // ★ M6 验收 bug3：滚动容器监听——记录用户是否贴底（距底 < 60px 视为贴底）。用户主动上滚 → isAtBottom=false。
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (restoringScrollRef.current) {
      lastMessagesScrollTopRef.current = el.scrollTop;
      if (activeAgentTab === 'chat') chatScrollTopRef.current = el.scrollTop;
      return;
    }
    const bottomDistancePx = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = nextTailPinnedState({
      scrollTop: el.scrollTop,
      previousScrollTop: lastMessagesScrollTopRef.current,
      bottomDistancePx,
      currentTailPinned: isAtBottomRef.current,
      pinThresholdPx: TAIL_PIN_THRESHOLD_PX,
      unpinThresholdPx: TAIL_UNPIN_THRESHOLD_PX,
    });
    lastMessagesScrollTopRef.current = el.scrollTop;
    if (isAtBottomRef.current && canLoadNewerMessageUnits) jumpToLatestMessageWindow();
    // ★ B2（反馈#10）：chat tab 滚动时持续记录位置，切走再切回时据此恢复。
    if (activeAgentTab === 'chat') chatScrollTopRef.current = el.scrollTop;
    if (activeAgentTab === 'chat' && !restoringScrollRef.current && scrollPersistTimerRef.current === null) {
      const scheduledConversationId = conversationId;
      scrollPersistTimerRef.current = window.setTimeout(() => {
        scrollPersistTimerRef.current = null;
        if (liveConversationIdRef.current !== scheduledConversationId) return;
        persistChatScrollState(scheduledConversationId);
      }, 120);
    }
    if (activeAgentTab !== 'chat' && scrollPersistTimerRef.current === null) {
      const scheduledConversationId = conversationId;
      const scheduledTab = activeAgentTab;
      scrollPersistTimerRef.current = window.setTimeout(() => {
        scrollPersistTimerRef.current = null;
        if (liveConversationIdRef.current !== scheduledConversationId) return;
        writeAgentSessionViewport({
          conversationId: scheduledConversationId,
          activeAgentTab: scheduledTab,
          tabScrollTop: { [scheduledTab]: messagesContainerRef.current?.scrollTop ?? 0 },
        });
      }, 120);
    }
    if (activeAgentTab !== 'chat' || restoringScrollRef.current) return;
    if (canLoadOlderMessageUnits && isMessageWindowStartNearViewport(160)) {
      loadOlderMessageUnits();
    } else if (!isAtBottomRef.current && canLoadNewerMessageUnits && isMessageWindowEndNearViewport(240)) {
      loadNewerMessageUnits();
    }
  }, [
    activeAgentTab,
    canLoadNewerMessageUnits,
    canLoadOlderMessageUnits,
    conversationId,
    isMessageWindowEndNearViewport,
    isMessageWindowStartNearViewport,
    jumpToLatestMessageWindow,
    loadNewerMessageUnits,
    loadOlderMessageUnits,
    persistChatScrollState,
  ]);

  useEffect(() => {
    const flushBeforeClose = () => {
      const targetConversationId = liveConversationIdRef.current;
      if (activeAgentTab === 'chat') persistChatScrollState(targetConversationId, true);
      else writeAgentSessionViewport({
        conversationId: targetConversationId,
        activeAgentTab,
        tabScrollTop: { [activeAgentTab]: messagesContainerRef.current?.scrollTop ?? 0 },
        sync: true,
      });
    };
    window.addEventListener('beforeunload', flushBeforeClose);
    window.addEventListener('pagehide', flushBeforeClose);
    return () => {
      flushBeforeClose();
      window.removeEventListener('beforeunload', flushBeforeClose);
      window.removeEventListener('pagehide', flushBeforeClose);
    };
  }, [activeAgentTab, persistChatScrollState]);

  useEffect(() => () => {
    if (scrollPersistTimerRef.current !== null) {
      window.clearTimeout(scrollPersistTimerRef.current);
      scrollPersistTimerRef.current = null;
    }
    if (activeAgentTab === 'chat') persistChatScrollState(conversationId, true);
    else writeAgentSessionViewport({
      conversationId,
      activeAgentTab,
      tabScrollTop: { [activeAgentTab]: messagesContainerRef.current?.scrollTop ?? 0 },
      sync: true,
    });
  }, [activeAgentTab, conversationId, persistChatScrollState]);

  // Auto-scroll to bottom：仅当用户已贴底才自动滚（不抢用户上滚）。
  // ★ M6 验收：直接设 scrollTop（而非 scrollIntoView）——后者会滚动所有可滚动祖先 + 触发 smooth 动画，
  //   生成期高频调用时和用户拖动滚动条打架（表现为「拖动条锁死底部、拖不动」）。直接设目标容器 scrollTop 更精确可控。
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const el = messagesContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastMessagesScrollTopRef.current = el.scrollTop;
      if (activeAgentTab === 'chat') chatScrollTopRef.current = el.scrollTop;
    }
  }, [
    activeAgentTab,
    messageWindowBottomSpacerHeight,
    messageWindowRange.end,
    messageWindowRange.start,
    messageWindowTopSpacerHeight,
    messages,
    isStreaming,
  ]);

  // ★ B2（反馈#10）：切回 chat tab 时恢复上次滚动位置（从 Plan/Context 切回不再跳顶）。
  //   贴底时优先滚到底（与自动滚底口径一致），否则恢复记录的 scrollTop。useLayoutEffect 同步设置避免闪一帧顶部。
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (activeAgentTab !== 'chat') {
      el.scrollTop = readCheckpointTabScroll(conversationId, activeAgentTab);
      lastMessagesScrollTopRef.current = el.scrollTop;
      return;
    }
    if (isAtBottomRef.current) el.scrollTop = el.scrollHeight;
    else el.scrollTop = chatScrollTopRef.current;
    lastMessagesScrollTopRef.current = el.scrollTop;
  }, [activeAgentTab, conversationId]);

  // Ctrl+R/HMR 与 Electron 冷启动后按「渲染窗口起点 + DOM 锚点」恢复长对话位置。
  useLayoutEffect(() => {
    if (activeAgentTab !== 'chat' || messageRenderUnits.length === 0) return;
    if (restoredScrollConversationRef.current === conversationId) return;
    restoredScrollConversationRef.current = conversationId;
    const restoreDefaultTail = () => {
      isAtBottomRef.current = true;
      chatScrollTopRef.current = 0;
      restoringScrollRef.current = true;
      jumpToLatestMessageWindow();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (liveConversationIdRef.current !== conversationId) {
          restoringScrollRef.current = false;
          return;
        }
        const container = messagesContainerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
          lastMessagesScrollTopRef.current = container.scrollTop;
          chatScrollTopRef.current = container.scrollTop;
        }
        restoringScrollRef.current = false;
      }));
    };
    try {
      const checkpoint = readCheckpointChatScroll(conversationId);
      const raw = checkpoint ? JSON.stringify(checkpoint) : localStorage.getItem(`synapse:chat-scroll:${conversationId}`);
      if (!raw) {
        restoreDefaultTail();
        return;
      }
      const restored = JSON.parse(raw) as {
        scrollTop?: number;
        atBottom?: boolean;
        visibleUnitStart?: number;
        visibleUnitEnd?: number;
        anchor?: { kind?: 'message' | 'boundary'; id?: string; offset?: number };
      };
      const restoredStart = Math.max(0, Math.min(Number(restored.visibleUnitStart) || 0, messageRenderUnits.length - 1));
      const restoredEnd = Math.max(
        restoredStart + 1,
        Math.min(
          Number(restored.visibleUnitEnd) || restoredStart + INITIAL_MESSAGE_RENDER_UNITS,
          messageRenderUnits.length,
        ),
      );
      const anchorUnitIndex = restored.anchor?.id
        ? restored.anchor.kind === 'message'
          ? messageUnitIndexById.get(restored.anchor.id)
          : messageRenderUnits.findIndex(unit => unit.boundary?.id === restored.anchor?.id)
        : undefined;
      const anchorUnit = anchorUnitIndex !== undefined && anchorUnitIndex >= 0
        ? messageRenderUnits[anchorUnitIndex]
        : undefined;
      if (restored.anchor?.kind === 'message' && restored.anchor.id && anchorUnit?.boundary) {
        setBoundaryRevealRequest({
          boundaryId: anchorUnit.boundary.id,
          messageId: restored.anchor.id,
          nonce: Date.now(),
        });
      }
      const nextStart = anchorUnitIndex !== undefined && anchorUnitIndex >= 0
        ? Math.max(0, anchorUnitIndex - 8)
        : restoredStart;
      isAtBottomRef.current = restored.atBottom === true;
      chatScrollTopRef.current = Math.max(0, Number(restored.scrollTop) || 0);
      restoringScrollRef.current = true;
      if (restored.atBottom) {
        jumpToLatestMessageWindow();
      } else if (anchorUnitIndex !== undefined && anchorUnitIndex >= 0) {
        setMessageWindowForIndex(anchorUnitIndex, { before: 8 });
      } else {
        setMessageWindowRange({ start: nextStart, end: restoredEnd });
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (liveConversationIdRef.current !== conversationId) {
          restoringScrollRef.current = false;
          return;
        }
        const container = messagesContainerRef.current;
        if (!container) {
          restoringScrollRef.current = false;
          return;
        }
        if (isAtBottomRef.current) {
          container.scrollTop = container.scrollHeight;
          lastMessagesScrollTopRef.current = container.scrollTop;
          chatScrollTopRef.current = container.scrollTop;
          restoringScrollRef.current = false;
          return;
        }

        if (!restored.anchor?.id || !anchorUnit) {
          container.scrollTop = chatScrollTopRef.current;
          lastMessagesScrollTopRef.current = container.scrollTop;
          restoringScrollRef.current = false;
          return;
        }

        const desiredOffset = Number(restored.anchor?.offset) || 0;
        let attempts = 0;
        let stableAlignments = 0;
        let anchorEverFound = false;
        const alignAnchor = () => {
          if (liveConversationIdRef.current !== conversationId) {
            restoringScrollRef.current = false;
            return;
          }
          const currentContainer = messagesContainerRef.current;
          if (!currentContainer) {
            restoringScrollRef.current = false;
            return;
          }
          const anchorElement = [...currentContainer.querySelectorAll<HTMLElement>('[data-message-id], [data-task-boundary-id]')]
            .find(candidate => (
              restored.anchor?.kind === 'message'
                ? candidate.dataset.messageId === restored.anchor?.id
                : candidate.dataset.taskBoundaryId === restored.anchor?.id
            ));
          attempts += 1;
          if (anchorElement) {
            anchorEverFound = true;
            const delta = anchorElement.getBoundingClientRect().top
              - currentContainer.getBoundingClientRect().top
              - desiredOffset;
            if (Math.abs(delta) > 0.5) currentContainer.scrollTop += delta;
            lastMessagesScrollTopRef.current = currentContainer.scrollTop;
            chatScrollTopRef.current = currentContainer.scrollTop;
            stableAlignments = Math.abs(delta) <= 1 ? stableAlignments + 1 : 0;
            if (stableAlignments >= 2) {
              restoringScrollRef.current = false;
              return;
            }
          }
          if (attempts >= 20) {
            if (anchorEverFound) {
              restoringScrollRef.current = false;
            } else {
              currentContainer.scrollTop = chatScrollTopRef.current;
              lastMessagesScrollTopRef.current = currentContainer.scrollTop;
              restoringScrollRef.current = false;
            }
            return;
          }
          window.setTimeout(alignAnchor, 50);
        };
        alignAnchor();
      }));
    } catch {
      restoreDefaultTail();
    }
  }, [
    activeAgentTab,
    conversationId,
    jumpToLatestMessageWindow,
    messageRenderUnits,
    messageUnitIndexById,
    setMessageWindowForIndex,
    setMessageWindowRange,
  ]);

  useEffect(() => {
    const focusInput = (event: Event) => {
      const detail = (event as CustomEvent<string | undefined>).detail;
      if (detail) { richRef.current?.setContent([detail]); setCanSend(!richRef.current?.isEmpty()); }
      richRef.current?.focus();
      selectAgentTab('chat');
    };
    window.addEventListener('synapse:focus-agent-input', focusInput);
    return () => window.removeEventListener('synapse:focus-agent-input', focusInput);
  }, [selectAgentTab]);

  // Auto-save conversation to the active persistence backend.
  // ★ M2-6：本 effect 同时承担「对话级 mode / reasoningEffort 持久化」职责——
  //   id 为真实对话 id 时 saveAutosaveSnapshot 直接 update 该对话行，id 为空/autosave 时落 AUTOSAVE_ID 行。
  //   故 mode/reasoningEffort 切换 UI 处只需 dispatch 改全局 agentSettings，本 effect（依赖含这两项）会去重落库，
  //   无需在每个切换按钮里手写持久化。切走前 ConversationList.saveCurrentToHistory 再兜一道（debounce 未触发也不丢）。
  useEffect(() => {
    if (messages.length === 0 || isStreaming || isLoopRunning) return;
    // effect 闭包捕获触发时刻的对话身份（A 的 id），供 700ms 后到点时与 store 最新身份比对。
    const scopedId = conversation.id;
    const timeout = window.setTimeout(() => {
      // ★ M2-6 切换竞态守卫：切走对话期间（ConversationList.handleSwitchConversation 异步多 await），
      //   本 effect 的旧定时器可能在 cleanup 之前到点。若此刻 store 已切到别的对话（conversationRef.current.id
      //   ≠ 本次闭包的 scopedId），这就是一条「属于已切走对话的迟到写入」——直接跳过，避免：
      //   ① saveCurrentToHistory 已把 autosave fork 成真实 id 并 clearAutosaveSnapshot 后，
      //      这条迟到 debounce 又用 id=null/AUTOSAVE_ID 重建一条 autosave 草稿（复活已 fork 的对话），
      //      导致下次启动 loadAutosaveSnapshot 把复活草稿连同其 mode 当成上次对话恢复、mode 归属错乱。
      const liveId = (conversationRef.current.id as string | null);
      if (liveId !== (scopedId as string | null)) return;
      const autosaveTimestamp = Date.now();
      const autosaveSnapshot = {
        id: conversation.id,
        title: conversation.title,
        messages,
        model,
        // M2-6：autosave 也带当前 mode / reasoningEffort，刷新/重启从 autosave 恢复时能拿回设置。
        mode,
        reasoningEffort: agentSettings.reasoningEffort,
        assistantRuns: conversation.assistantRuns,
        fileSnapshots: conversation.fileSnapshots,
        pendingDiffs: conversation.pendingDiffs,
        // ★ M4-2-S5 首次保存落归属（关键落库路径）：新对话发首条消息后，归属第一次落库就是经这条 autosave
        //   （写到 AUTOSAVE_ID 行）。带上 store 当前归属，使刷新/重启从 autosave 恢复、及后续 fork 成正式 id 时
        //   都拿到正确 workspacePath；不带则 autosave 行 workspace_path 为 NULL → 重启丢归属。
        workspacePath: conversation.workspacePath,
        // ★ M4-6-S4：autosave 行带对话目标，使刷新/重启从 autosave 恢复对话能拿回 goal 继续注入。
        goal: conversation.goal,
        bpcThresholdOverride: conversation.bpcThresholdOverride,
        compactThresholdOverride: conversation.compactThresholdOverride,
        // ★ task_boundary：autosave 行带任务边界 + 大标题（与 goal 同源 store conversation），刷新/重启恢复能拿回边界卡片与历史。
        taskBoundaries: conversation.taskBoundaries,
        taskHeadline: conversation.taskHeadline,
        timestamp: autosaveTimestamp,
      };
      void saveAutosaveSnapshot(autosaveSnapshot).catch(() => {
        try {
          // M2-R6：兜底 localStorage 写入同样过 sanitize，杜绝 base64 经退化路径漏进存储。
          localStorage.setItem('synapse_autosave', JSON.stringify({
            ...autosaveSnapshot,
            id: autosaveSnapshot.id || AUTOSAVE_ID,
            messages: sanitizeMessagesForPersistence(autosaveSnapshot.messages),
            schemaVersion: CONVERSATION_SCHEMA_VERSION,
            timestamp: autosaveTimestamp,
          }));
        } catch { /* quota exceeded — silently skip */ }
      });
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [
    messages,
    model,
    // M2-6：mode / reasoningEffort 变化也要重新落 autosave 行，保证刷新恢复拿到最新设置。
    mode,
    agentSettings.reasoningEffort,
    isStreaming,
    isLoopRunning,
    conversation.id,
    conversation.title,
    conversation.assistantRuns,
    conversation.fileSnapshots,
    conversation.pendingDiffs,
    // ★ M4-2-S5：归属变化（新建置当前工作区 / 改归属）也要重落 autosave 行，使其 workspace_path 跟手。
    conversation.workspacePath,
    // ★ M4-6-S4：goal 变化（/goal 设/清）也要重落 autosave 行，使其 goal 跟手持久化。
    conversation.goal,
    conversation.bpcThresholdOverride,
    conversation.compactThresholdOverride,
    // ★ task_boundary：边界/大标题变化也要重落 autosave 行，使其任务边界跟手持久化（与 goal 同源 store conversation）。
    conversation.taskBoundaries,
    conversation.taskHeadline,
  ]);

  // Restore the last active persisted conversation first; autosave is only the fallback for a new/unsaved draft.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const selectedConversationId = store.getState().conversationHistory.selectedId;
        let restoredPersistedConversation = false;
        let data = selectedConversationId
          ? await loadConversationSnapshot(selectedConversationId)
          : null;
        if (selectedConversationId && !data) {
          let confirmedMissing = false;
          try {
            confirmedMissing = !(await platform.conversation.get(selectedConversationId));
          } catch {
            // 主进程或数据库短暂未就绪时保留上次对话指针，不能把瞬时失败误判成已删除。
          }
          if (!confirmedMissing) {
            await new Promise(resolve => window.setTimeout(resolve, 250));
            data = await loadConversationSnapshot(selectedConversationId);
          }
          if (!data && confirmedMissing) {
            dispatch(setSelectedId(null));
          } else if (!data) {
            if (!cancelled && store.getState().conversationHistory.selectedId === selectedConversationId) {
              dispatch(addNotification({
                type: 'warning',
                title: '对话恢复稍后重试',
                message: '上次对话暂时读取失败，已保留恢复位置，没有切到其它对话。',
                duration: 4000,
              }));
            }
            return;
          } else {
            restoredPersistedConversation = true;
          }
        } else if (data) {
          restoredPersistedConversation = true;
        }
        if (!data) data = await loadAutosaveSnapshot();
        const restoredMessages = data?.messages ?? [];
        const selectionStillCurrent = store.getState().conversationHistory.selectedId
          === (restoredPersistedConversation ? selectedConversationId : null);
        const liveConversation = conversationRef.current;
        if (!cancelled && selectionStillCurrent && restoredMessages.length > 0 && (liveConversation?.messages.length ?? 0) === 0) {
          const restoredModel = data?.model || model;
          dispatch(setConversation({
            id: data?.id || 'autosave-current',
            title: data?.title || '自动保存',
            messages: restoredMessages,
            model: restoredModel,
            assistantRuns: data?.assistantRuns,
            fileSnapshots: data?.fileSnapshots,
            pendingDiffs: data?.pendingDiffs,
            // M2-3：恢复对话也回填分支溯源（autosave 行的 parent 字段，普通对话为 null）。
            parentId: data?.parentId ?? null,
            branchedFromMessageId: data?.branchedFromMessageId ?? null,
            // ★ M4-2-S5 恢复回填归属：从 autosave 快照回带工作区归属（S4 已让 autosave 行落库带 workspacePath；
            //   旧 autosave / legacy 无此字段则为 null=Global），使重启后延续正确归属。
            workspacePath: data?.workspacePath ?? null,
            // ★ M4-6-S4 恢复回填目标：从 autosave 快照回带 goal（旧 autosave 无此字段则 undefined=未设），
            //   使重启后延续目标注入。
            goal: data?.goal || undefined,
            bpcThresholdOverride: data?.bpcThresholdOverride,
            compactThresholdOverride: data?.compactThresholdOverride,
            // ★ task_boundary 恢复回填：从 autosave 快照回带任务边界 + 大标题（与 goal 同源 data；旧 autosave 无此字段则 undefined）。
            taskBoundaries: data?.taskBoundaries,
            taskHeadline: data?.taskHeadline,
          }));
          // M2-6：恢复对话时同步其 mode / reasoningEffort 到全局 agentSettings（旧 autosave 无此字段则回退默认）。
          dispatch(setMode(data?.mode === 'fast' ? 'fast' : 'planning'));
          dispatch(setReasoningEffort(data?.reasoningEffort || 'auto'));
          if (restoredModel) dispatch(setCurrentModel(restoredModel));
          if (restoredPersistedConversation && data?.id) dispatch(setSelectedId(data.id));
          dispatch(addNotification({
            type: 'info',
            title: '已恢复',
            message: restoredPersistedConversation ? '已恢复上次打开的对话' : '已恢复上次对话',
            duration: 2000,
          }));
          // ★ M2-R6 懒迁移：后台把旧内联 base64 抽离成 sha256 引用并回写 DB（用到才迁、不阻塞渲染）。
          // 首屏仍用内联 base64 渲染（能显示）；迁移确有变更时通过 onMigrated 把引用态写回 store，
          // 杜绝 store 残留 base64 被后续 autosave 反复落库。回写前严格校验对话身份未变且消息未追加，避免覆盖新消息。
          if (data) {
            const restoredId = data.id || 'autosave-current';
            const restoredLen = restoredMessages.length;
            void migrateSnapshotAttachments(data, (migratedId, migratedMessages) => {
              if (cancelled) return;
              const cur = conversationRef.current;
              if (!cur || cur.isStreaming) return;
              const curId = (cur.id as string | null) || 'autosave-current';
              // 仅当仍是同一对话、且消息数量未变（未追加/未截断新消息）时安全替换为引用态。
              if (curId === (migratedId === AUTOSAVE_ID ? restoredId : migratedId) && curId === restoredId
                  && cur.messages.length === restoredLen) {
                dispatch(setConversation({
                  id: restoredId,
                  title: cur.title,
                  messages: migratedMessages,
                  assistantRuns: cur.assistantRuns,
                  fileSnapshots: cur.fileSnapshots,
                  pendingDiffs: cur.pendingDiffs,
                  model: cur.model,
                }));
              }
            }).catch(() => undefined);
          }
        }
      } catch { /* corrupted — skip */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // M2-6：顶栏「新建对话」入口。与 ConversationList.handleNewConversation 口径单一：
  //   先把当前对话的 mode / reasoningEffort 随对话落库（saveConversationSnapshot），
  //   再【条件清】autosave——仅当确实发生 autosave→真实 id 的 fork（summary.id 非 AUTOSAVE_ID）才
  //   clearAutosaveSnapshot()，避免「当前对话是真实 id」场景下无条件 delete(AUTOSAVE_ID) 误删并存草稿镜像。
  //   读 conversationRef / agentMetaRef 的 current 取最新值，杜绝 700ms debounce 未触发时按钮拿到旧 mode。
  const handleNewConversation = useCallback(async () => {
    // ★ M2-6 切换竞态：置闸覆盖 save(可能 fork+clearAutosave) → clearConversation/重置 整段窗口，
    //   挡住旧对话迟到 autosave debounce 复活 AUTOSAVE_ID 草稿（与 ConversationList 两入口口径一致）。finally 复位。
    beginConversationSwitch();
    // ★ M4-6-S5：新建对话前中断在跑的 /loop 循环，避免循环继续往新对话发指令（串台）。
    loopRunner.stop();
    // ★ M2-5 worktree 止血：新建对话即回主工作区——清掉【离开的对话】+ AUTOSAVE_ID 的活动 worktree 条目，
    //   防新对话（共用 AUTOSAVE_ID contextId）继承上一条 autosave 对话的 worktree 重定向（串台）。
    {
      const leavingConversationId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
      const leavingContextId = executionRegistry.getOwnerId(leavingConversationId) ?? leavingConversationId;
      dispatch(exitWorktree({ contextId: leavingContextId }));
      dispatch(exitWorktree({ contextId: executionRegistry.getOwnerId(AUTOSAVE_ID) ?? AUTOSAVE_ID }));
    }
    try {
      const cur = conversationRef.current;
      if ((cur.messages?.length ?? 0) > 0) {
        // fork 判据与 ConversationList.saveCurrentToHistory 一致：当前是 autosave / 无 id 时 save 会 fork 成新 id。
        const wasAutosave = !cur.id || cur.id === AUTOSAVE_ID;
        try {
          const summary = await saveConversationSnapshot({
            id: cur.id,
            title: cur.title,
            messages: cur.messages,
            model: cur.model || agentMetaRef.current.model,
            // M2-6：新建前把当前对话的 mode / reasoningEffort 随对话落库，切回时能恢复。
            mode: agentMetaRef.current.mode,
            reasoningEffort: agentMetaRef.current.reasoningEffort,
            assistantRuns: cur.assistantRuns,
            fileSnapshots: cur.fileSnapshots,
            pendingDiffs: cur.pendingDiffs,
            // ★ M4-2-S5 首次保存落归属：把【切走对话】在 store 持有的工作区归属随对话落库（与
            //   ConversationList.saveCurrentToHistory 口径一致）——autosave→fork 成正式 id 那一刻把归属固化进 DB。
            workspacePath: cur.workspacePath,
            // ★ M4-6-S4：新建对话时把【切走对话】的目标随对话落库，切回时能恢复 goal 继续注入。
            goal: cur.goal,
            bpcThresholdOverride: cur.bpcThresholdOverride,
            compactThresholdOverride: cur.compactThresholdOverride,
            // ★ task_boundary：新建对话时把【切走对话】的任务边界 + 大标题随对话落库（与 goal 同源 cur），切回时能恢复。
            taskBoundaries: cur.taskBoundaries,
            taskHeadline: cur.taskHeadline,
            // ★ M4-2-S1（问题9 根治）：新建对话时对【切走对话】的系统性保存，不刷其 updated_at。
            //   改 systemTouch:true + 去掉硬传 timestamp:Date.now()，与 ConversationList.saveCurrentToHistory 口径一致，
            //   避免切走对话被刷成当前时间跳到列表第一。
            systemTouch: true,
          });
          if (summary) {
            dispatch(updateConversation(summary));
            // M2-R6：此处【不】GC 附件——save 已把这批消息（含 sha256 引用）落到新对话 id，实体仍被新对话引用
            //   （refCount 不变、归属转移）；clearAutosaveSnapshot 走 conversation.delete(AUTOSAVE_ID)（不 release）。
            //   故 refCount 守恒。仅在确实 fork 出真实 id 时清 autosave 镜像（条件清，与 ConversationList 对齐），
            //   真实对话场景不再无条件 delete(AUTOSAVE_ID)，避免误删并存的真草稿镜像。
            if (wasAutosave && summary.id && summary.id !== AUTOSAVE_ID) {
              // ★ #8 选A：autosave 草稿 fork 成真实 id——迁桶 + 迁 worktree + 重绑在跑的 run，保后台进度不丢、不串台。
              await migrateForkedConversation(cur.id || AUTOSAVE_ID, summary.id);
              await clearAutosaveSnapshot();
            }
          }
        } catch {
          dispatch(addNotification({ type: 'warning', title: '自动保存失败', message: '当前对话保存失败，但仍会创建新对话' }));
        }
      }
      // ★ #8 选A：byId 下不能 clearConversation()——它清的是【活跃桶】，若当前对话(A)正后台跑会被清掉内容。
      //   改为创建一个全空草稿桶（AUTOSAVE_ID）并设 active，不动 A 桶：A 已被上面 fork 成真实 id 而空出 AUTOSAVE_ID；
      //   若 A 本就是真实 id，A 桶=真实 id、新草稿=AUTOSAVE_ID，互不影响。后台在跑的 A 桶内容得以保留。
      dispatch(setConversation({
        id: AUTOSAVE_ID,
        title: '新对话',
        messages: [],
        assistantRuns: {},
        fileSnapshots: {},
        pendingDiffs: [],
        parentId: null,
        branchedFromMessageId: null,
        goal: undefined,
        bpcThresholdOverride: undefined,
        compactThresholdOverride: undefined,
        taskBoundaries: undefined,
        taskHeadline: undefined,
        workspacePath: null,
      }));
      // ★ M4-2-S5 新对话默认归当前工作区：上面新草稿桶 workspacePath 设为 null（Global），
      //   随即按当前打开的工作区 path 置归属（未打开工作区时 ref 为 null → 维持 Global）。须在建桶之后，
      //   否则被覆盖回 null。首条消息触发的 autosave / 切走保存会把该归属落库（与 ConversationList 两入口一致）。
      dispatch(setConversationWorkspace(workspaceCurrentPathRef.current));
      // M2-6：新对话回默认设置（mode=planning / reasoningEffort=auto）。先落定旧对话设置再重置。
      dispatch(setMode('planning'));
      dispatch(setReasoningEffort('auto'));
      dispatch(setSelectedId(null));
      dispatch(addNotification({ type: 'info', title: '新对话', message: '已创建新对话' }));
    } finally {
      endConversationSwitch();
    }
  }, [dispatch]);

  // ★ M4-2-S7 右侧栏浮层「切换对话」：口径完全对齐 ConversationList.handleSwitchConversation——
  //   置切换竞态闸门（beginConversationSwitch）+ worktree exit（离开对话 + AUTOSAVE_ID）覆盖整段异步窗口，
  //   先把切走对话系统性保存（systemTouch:true 不刷排序时间 + 带 workspacePath / mode / reasoningEffort，
  //   autosave 时 fork 成正式 id 后条件清 autosave 镜像），再 load 目标 → setConversation（回填归属/溯源）
  //   → 同步 mode/reasoningEffort → setSelectedId。与左侧栏共用 conversationHistory.selectedId，切后两栏同步。
  const handleSwitchConversationFromMenu = useCallback(async (id: string) => {
    setConvMenuOpen(false);
    if (id === (conversationRef.current.id as string | null)) return; // 已是当前对话，无需切换。
    const switchEpoch = beginConversationSwitch();
    // ★ M4-6-S5：切换对话前中断在跑的 /loop 循环，避免循环继续往切走的对话发指令（串台）。
    loopRunner.stop();
    {
      const leavingConversationId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
      const leavingContextId = executionRegistry.getOwnerId(leavingConversationId) ?? leavingConversationId;
      dispatch(exitWorktree({ contextId: leavingContextId }));
      dispatch(exitWorktree({ contextId: executionRegistry.getOwnerId(AUTOSAVE_ID) ?? AUTOSAVE_ID }));
    }
    try {
      const cur = conversationRef.current;
      if ((cur.messages?.length ?? 0) > 0) {
        const wasAutosave = !cur.id || cur.id === AUTOSAVE_ID;
        try {
          const summary = await saveConversationSnapshot({
            id: cur.id,
            title: cur.title,
            messages: cur.messages,
            model: cur.model || agentMetaRef.current.model,
            mode: agentMetaRef.current.mode,
            reasoningEffort: agentMetaRef.current.reasoningEffort,
            assistantRuns: cur.assistantRuns,
            fileSnapshots: cur.fileSnapshots,
            pendingDiffs: cur.pendingDiffs,
            workspacePath: cur.workspacePath,
            // ★ M4-6-S4：切走对话时把其目标随对话落库，切回时能恢复 goal 继续注入。
            goal: cur.goal,
            bpcThresholdOverride: cur.bpcThresholdOverride,
            compactThresholdOverride: cur.compactThresholdOverride,
            // ★ task_boundary：切走对话时把其任务边界 + 大标题随对话落库（与 goal 同源 cur），切回时能恢复。
            taskBoundaries: cur.taskBoundaries,
            taskHeadline: cur.taskHeadline,
            systemTouch: true,
          });
          if (summary) {
            dispatch(updateConversation(summary));
            if (wasAutosave && summary.id && summary.id !== AUTOSAVE_ID) {
              // ★ #8 选A：autosave 草稿 fork 成真实 id——迁桶 + 迁 worktree + 重绑在跑的 run，保后台进度不丢、不串台。
              await migrateForkedConversation(cur.id || AUTOSAVE_ID, summary.id);
              await clearAutosaveSnapshot();
            }
          }
        } catch {
          dispatch(addNotification({ type: 'warning', title: '自动保存失败', message: '当前对话保存失败，但仍会打开所选对话' }));
        }
      }
      if (!isConversationSwitchCurrent(switchEpoch)) return;
      const snapshot = await loadConversationSnapshot(id);
      if (!isConversationSwitchCurrent(switchEpoch)) return;
      if (!snapshot) throw new Error('missing conversation');
      // ★ byId 治本（step4）：目标对话桶若已在内存（可能后台 run 正在写它）——只切 activeId，【绝不重 hydrate】，
      //   否则 DB 旧快照会覆盖后台实时写入的内容（切回看不到后台进度）。仅首次加载（桶不存在/空）才从 DB hydrate。
      const existingBucket = store.getState().conversation.byId[id];
      const nextModel = existingBucket?.messages.length
        ? (existingBucket.model || snapshot.model)
        : snapshot.model;
      if (existingBucket && existingBucket.messages.length > 0) {
        dispatch(setActiveConversation(id));
      } else {
        dispatch(setConversation({
          id,
          title: snapshot.title || '对话',
          messages: snapshot.messages,
          model: snapshot.model,
          assistantRuns: snapshot.assistantRuns,
          fileSnapshots: snapshot.fileSnapshots,
          pendingDiffs: snapshot.pendingDiffs,
          parentId: snapshot.parentId ?? null,
          branchedFromMessageId: snapshot.branchedFromMessageId ?? null,
          // ★ M4-6-S4：切到目标对话时回填其 goal（snapshot 从 DB goal 列读回；未设则 undefined）。
          goal: snapshot.goal || undefined,
          bpcThresholdOverride: snapshot.bpcThresholdOverride,
          compactThresholdOverride: snapshot.compactThresholdOverride,
          // ★ task_boundary：切到目标对话时回填其任务边界 + 大标题（与 goal 同源 snapshot，从 DB JSON 列读回；未设则 undefined）。
          taskBoundaries: snapshot.taskBoundaries,
          taskHeadline: snapshot.taskHeadline,
          workspacePath: snapshot.workspacePath ?? null,
        }));
      }
      dispatch(setMode(snapshot.mode === 'fast' ? 'fast' : 'planning'));
      dispatch(setReasoningEffort(snapshot.reasoningEffort || 'auto'));
      if (nextModel) {
        dispatch(setConversationModel({ model: nextModel, conversationId: id }));
        dispatch(setCurrentModel(nextModel));
      }
      dispatch(setSelectedId(id));
    } catch {
      dispatch(addNotification({ type: 'error', title: '加载失败', message: '无法加载所选对话' }));
    } finally {
      endConversationSwitch();
    }
  }, [dispatch]);

  // ★ M4-2-S7 浮层内「当前对话改归属」：经共享 hook 落库（moveToWorkspace 内回写共享 slice 供左侧栏即时反映），
  //   并同步 store conversation.workspacePath 使当前对话内后续保存延续正确归属。target=null → 改归 Global。
  //   ★ M4-2 审查修复：浮层列表已改为本地 state（不读共享 slice），故改归属后另刷一次本地列表，
  //   让浮层里当前对话那条的归属徽标即时更新（仅浮层开着时有意义）。
  const handleMoveCurrentConversation = useCallback(async (target: string | null) => {
    const id = conversationRef.current.id as string | null;
    if (!id || id === AUTOSAVE_ID) {
      // 未落正式 id 的新对话：仅改 store 归属（下次保存自然落库），不调 update（无行可改）。
      dispatch(setConversationWorkspace(target ?? null));
      dispatch(addNotification({ type: 'info', title: '已设置归属', message: `当前对话归属「${workspaceLabel(target)}」（发消息后保存生效）` }));
      if (convMenuOpen) void reloadConvMenu();
      return;
    }
    await moveConvToWorkspace(id, target);
    dispatch(setConversationWorkspace(target ?? null));
    if (convMenuOpen) void reloadConvMenu();
  }, [dispatch, moveConvToWorkspace, convMenuOpen, reloadConvMenu]);

  const buildUserContentParts = useCallback((text: string, attachments: AttachmentRef[]): MessageContentPart[] => {
    const parts: MessageContentPart[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const attachment of attachments) {
      if (attachment.status !== 'ready') continue;
      // M2-R6：image part 以 sha256 引用 + 元数据(size/mime/name) 落库/发送；
      // url 仅填内存态预览(previewUrl)，发送前 agentLoop 按 sha256 还原成真 base64，落库前被 sanitize 清掉。
      if (attachment.kind === 'image' && attachment.sha256) {
        parts.push({
          type: 'image_url',
          image_url: { url: attachment.previewUrl || '', detail: 'auto' },
          attachmentId: attachment.id,
          sha256: attachment.sha256,
          size: attachment.size,
          mime: attachment.mimeType,
          name: attachment.name,
        });
      }
    }
    return parts;
  }, []);

  // ★ M3-2b：@MultiAI:模式名 触发固定工作流。
  //   - 用户那条输入【照常】作为 user 消息插入对话（用户能看到自己发了什么），随后走 runWorkflow 而非普通 agentLoop.run。
  //   - 跑期间用 setStreaming(true) 占位（复用既有「流式中」语义防止重复发送 / 禁用输入），完成后插一条 assistant 汇总消息。
  //   - 工作流自身的进度/错误已由 agentOrchestrator 内部 addNotification 反馈；这里只负责对话消息的 user/assistant 落位。
  //   TODO(M3-3)：assistant 汇总目前是结构化文本；M3-3 会替换/增强为工作流卡片（节点四色 + 子代理树 + 点进子对话）。
  // ★ M6 收尾 D1 修补（review HIGH#1）：签名加 richTokens 参数，让 @MultiAI 工作流路径的 user 消息也带上
  //   富文本 atomic token 锚点，编辑历史时能无损还原 @MultiAI: pill（之前漏传导致降级为纯文本，与 D1 承诺打脸）。
  const runWorkflowFromInput = useCallback(async (rawText: string, richTokens?: ExtractedToken[]) => {
    // ★ M3-2b 修复（medium 串台）：捕获触发时刻的对话身份。runWorkflow 可能耗时数十分钟，
    //   期间用户可能切走对话（ConversationList 双击不设防）。await 解析后回填 assistant/error 消息前
    //   比对 conversationRef.current.id === scopedId，不一致则改走 notification、不污染当前（已切走的别的）对话 slice。
    //   与 autosave 既有迟到守卫（见上方 effect scopedId/liveId 比对）同款思路。
    const scopedId = (conversationRef.current.id as string | null);
    const isStillScoped = () => (conversationRef.current.id as string | null) === scopedId;

    // 1. 用户输入照常入对话流（与普通发送一致，让用户看到自己发了什么）。同步 dispatch，必在当前对话。
    dispatch(addMessage({
      id: generateMessageId('user'),
      role: 'user',
      content: rawText,
      // ★ D1 修补：与普通路径口径对齐——长度 0 时传 undefined 省 DB 空间。
      richTokens: richTokens && richTokens.length > 0 ? richTokens : undefined,
      timestamp: Date.now(),
    }));

    // ★ M3-3a：跑前先预生成 runId + 占位 assistant 消息（带 workflowRunId），让【工作流卡片在启动瞬间即出现】
    //   并随子代理状态实时四色刷新，而非等整个工作流跑完才显示。triggerMessageId = 该 assistant 消息 id，
    //   使 runWorkflow 建立的运行实例关联到这条消息（WorkflowCard 渲染锚点）。
    const runId = generateWorkflowRunId();
    const assistantMsgId = generateMessageId('assistant');
    dispatch(addMessage({
      id: assistantMsgId,
      role: 'assistant',
      content: '', // 跑完回填文本汇总（作为卡片下方可折叠 fallback）
      model: 'Multi-AI 工作流',
      timestamp: Date.now(),
      workflowRunId: runId,
    }));

    // 2. 置流式占位，期间禁用再次发送（runWorkflow 可能耗时较长）。
    //    isWorkflowRunningRef 让 handleStop 知道现在该 abort 工作流而非 agentLoop。
    isWorkflowRunningRef.current = true;
    dispatch(setStreaming(true));
    try {
      const outcome = await runMultiAITrigger(rawText, { runId, triggerMessageId: assistantMsgId });
      if (outcome.kind === 'error') {
        // 匹配失败（无此模式 / 该模式无 workflow）→ 友好提示，不静默吞。
        //   此时 runWorkflow 未被调用、卡片运行实例不存在（WorkflowCard 自然返回 null），
        //   把占位消息回填为错误说明文本即可（去掉 workflowRunId，纯文本展示）。
        dispatch(addNotification({
          type: 'warning',
          title: '无法触发工作流',
          message: outcome.message,
        }));
        if (isStillScoped()) {
          dispatch(updateMessage({ id: assistantMsgId, content: `⚠️ ${outcome.message}` }));
          dispatch(updateMessageMeta({ id: assistantMsgId, changes: { workflowRunId: undefined } }));
        }
        return;
      }
      if (outcome.kind === 'ran') {
        // 3. 工作流跑完——把占位 assistant 消息回填为文本汇总（卡片仍由 workflowRunId 实时渲染）。
        //    迟到结果（已切走对话）→ updateMessage 在当前 slice 找不到该 id 自然 no-op，额外 notification 告知。
        if (isStillScoped()) {
          dispatch(updateMessage({ id: assistantMsgId, content: outcome.assistantText }));
        } else {
          dispatch(addNotification({
            type: 'info',
            title: '工作流已完成',
            message: '工作流已执行完成，但你已切换到其它对话，汇总未回填当前对话。',
          }));
        }
      }
    } catch (err: any) {
      dispatch(addNotification({
        type: 'error',
        title: '工作流执行失败',
        message: err?.message || '未知错误',
      }));
      // 同样守护：异常汇总只回填触发它的那条对话的占位消息。
      if (isStillScoped()) {
        dispatch(updateMessage({ id: assistantMsgId, content: `❌ 工作流执行失败：${err?.message || '未知错误'}` }));
      }
    } finally {
      isWorkflowRunningRef.current = false;
      dispatch(setStreaming(false));
    }
  }, [dispatch]);

  // ★ C6/去重：closeMenu / fetchSecondLevel / refreshMenu / 二级 effect / applyTypeSelect / applyTokenCompletion
  //   全部移入 useAtMention hook（见组件顶部 hook 调用），与编辑框 MessageBubble 共用，消除两套分叉。

  // ★ M4-6-S4 @对话引用注入组装：把本轮引用表 refs 的每条历史对话，按【record 摘要优先、无 record 回退最近 N 条原文】
  //   组装成一段 <referenced_conversation> 注入文本（经 agentLoop.run 的 opts.injectedContext 透传，不污染可见流）。
  //   - record 摘要：getRecordSkeleton(id)（token 友好的批次骨架概览）。
  //   - 回退：loadConversationSnapshot(id) 取最近 REF_FALLBACK_RECENT 条非-tool 消息原文，每条截断到预算内。
  //   - 总预算 REF_TOTAL_CHAR_BUDGET 字符硬上限（防引用大对话撑爆上下文，Plan_5 风险2）。
  //   引用对话已不存在 / 读取失败 → 跳过该条（不阻塞发送）。返回空串表示无可注入内容。
  const buildInjectedContext = useCallback(async (
    references: { kind: 'conversation'; id: string; title: string }[],
  ): Promise<string> => {
    if (references.length === 0) return '';
    const REF_FALLBACK_RECENT = 8;     // 无 record 时回退取最近 N 条原文
    const REF_PER_MSG_CHARS = 600;     // 单条原文截断上限
    const REF_PER_REF_BUDGET = 4000;   // 单条引用对话注入字符预算
    const REF_TOTAL_CHAR_BUDGET = 12000; // 本轮所有引用合计字符硬上限

    const blocks: string[] = [];
    let used = 0;
    for (const ref of references) {
      if (used >= REF_TOTAL_CHAR_BUDGET) break;
      let body = '';
      try {
        // ① record 摘要优先（token 友好）。
        const skeleton = await getRecordSkeleton(ref.id).catch(() => '');
        if (skeleton && skeleton.trim()) {
          body = skeleton.trim().slice(0, REF_PER_REF_BUDGET);
        } else {
          // ② 无 record → 回退取最近 N 条原文（截断）。
          const snapshot = await loadConversationSnapshot(ref.id).catch(() => null);
          const msgs = (snapshot?.messages ?? []).filter((m: any) => m.role !== 'tool');
          const recent = msgs.slice(-REF_FALLBACK_RECENT);
          const lines = recent.map((m: any) => {
            const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : String(m.role);
            const text = (typeof m.content === 'string' ? m.content : '').trim();
            const clipped = text.length > REF_PER_MSG_CHARS ? `${text.slice(0, REF_PER_MSG_CHARS)}…` : text;
            return clipped ? `[${role}] ${clipped}` : '';
          }).filter(Boolean);
          body = lines.join('\n').slice(0, REF_PER_REF_BUDGET);
        }
      } catch {
        body = '';
      }
      if (!body) continue;
      const remaining = REF_TOTAL_CHAR_BUDGET - used;
      const clippedBody = body.length > remaining ? `${body.slice(0, remaining)}…` : body;
      blocks.push(`# 引用对话：${ref.title}（ID: ${ref.id}）\n${clippedBody}`);
      used += clippedBody.length;
    }
    return blocks.join('\n\n');
  }, []);

  // / 命令执行所需的 helpers（注入 commandExecutor）。命令体不直接 import store，经此拿能力。
  const buildSlashHelpers = useCallback(() => ({
    runAgent: (text: string) => {
      agentLoopRef.current?.run(text).catch((err: any) => {
        dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err?.message || '未知错误' }));
      });
    },
    notify: (payload: { type: 'info' | 'success' | 'warning' | 'error'; title: string; message: string }) =>
      dispatch(addNotification(payload)),
    openSettings: (sectionId?: string) => {
      dispatch(setActiveView('settings'));
      dispatch(setSidebarVisible(true));
      // ★ M4-6-S5：rAF 推迟事件到下一帧，让 SettingsPanel 监听先就绪（同 applyCompletion @设置分支口径）。
      //   未挂载时事件无监听者 → 天然 no-op，安全。
      if (sectionId) {
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('synapse:settings-focus-section', { detail: sectionId }));
        });
      }
    },
    clearConversation: () => { dispatch(clearConversation()); },
    // ★ M4-6-S4 /goal：设/清当前对话目标（写 conversation.goal，随对话持久化 + 每轮注入 <current_goal>）。
    setGoal: (text: string) => { dispatch(setGoal(text)); },
    getGoal: () => (conversationRef.current.goal as string | undefined),
    // ★ M5-1 压缩归一 /compact：压缩有且仅有一套，手动 ＝ 自动，完全同一套逻辑（仅触发方式不同）。
    //   /compact 只调 loop.compactNow（生成 record 批次 + 落库 + 同步 autosave），【绝不截断 store.messages】——
    //   UI 与本地完整对话照常全量保留，压缩点由 batchDividerByIdx 分隔线呈现（读 record 各批 stepEnd → 消息下标，
    //   store 全量时天然画对位置）。原来的 dispatch(applyManualCompact)（把历史收敛为「system 摘要 + keep 尾」、
    //   删了 store 消息）违背核心原则，已彻底删除。
    compactNow: async () => {
      const loop = agentLoopRef.current;
      if (!loop) {
        dispatch(addNotification({ type: 'warning', title: '无法压缩', message: 'AI 未就绪' }));
        return;
      }
      const convId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
      if (selectConversationById(store.getState() as RootState, convId).isCompacting) {
        dispatch(addNotification({ type: 'info', title: '压缩进行中', message: '上一次手动压缩还在进行，请稍候' }));
        return;
      }
      if (historyMutationInFlightRef.current) {
        dispatch(addNotification({
          type: 'info',
          title: '历史操作进行中',
          message: `请等待「${historyMutationInFlightRef.current}」完成后再手动压缩`,
        }));
        return;
      }
      const KEEP_RECENT = 4; // 与 agentLoop.compactNow 内部 KEEP_RECENT 同口径
      // 可压段太短（消息数 <= keep）→ 无需压缩，直接提示。store 全量、不含 system 压缩摘要（归一后不再物化）。
      const msgCount = (conversationRef.current.messages ?? []).filter((m: any) => m.role !== 'tool').length;
      if (msgCount <= KEEP_RECENT) {
        dispatch(addNotification({ type: 'info', title: '无需压缩', message: '当前对话历史较短，暂无可压缩内容' }));
        return;
      }
      historyMutationInFlightRef.current = '手动压缩';
      setHistoryMutationLabel('手动压缩');
      try {
        // ★ M5-1：归一后 store 不再被压缩截断，重复 /compact 不会因 store 变短而 no-op，故 compactNow 在「无新增段」
        //   时会返回旧 recordMd（非空）。仅凭 recordMd 非空判定会误报「已压缩」。改用「压缩前后 record 批数比对」
        //   判断是否真有新批落库：批数增加才算真压缩，否则提示「已是最新」。
        const priorBatchCount = (await getRecord(convId).catch(() => null))?.batches?.length ?? 0;
        // 生成 record 批次 + 落库（compactNow 内部自算 compressedSegment = 全历史去最近 KEEP_RECENT 条，与自动同源）。
        // 不截断 store：下一轮 run 的注入前缀由 record 组装，store.messages 全量保留。
        const recordMd = await loop.compactNow(convId, { source: 'manual' }); // ★ M5-BPC-2：手动 /compact 标注来源 'manual'
        const after = await getRecord(convId).catch(() => null);
        const afterBatchCount = after?.batches?.length ?? 0;
        // 压缩点 UI 交还 batchDividerByIdx 分隔线：归一后 store.messages 长度不变，stepEnds effect 不会自动重算，
        // 这里主动用重读到的 record 刷新各批 stepEnd，让新批的「已压缩」分隔线立即画出。
        setRecordBatchMarks(extractBatchMarks(after)); // ★ M5-BPC-7：带 source 的批标记（extractBatchMarks 内部过滤元批 + 编号）
        if (!recordMd || afterBatchCount <= priorBatchCount) {
          dispatch(addNotification({ type: 'info', title: '手动压缩', message: '本次没有可压缩为摘要的历史（已是最新）' }));
          return;
        }
        await bpcScheduler.clearHardPauseAfterRecovery(convId);
        try {
          await invalidateRequestLedgerForHistoryMutation(convId);
        } catch (ledgerError: any) {
          dispatch(addNotification({
            type: 'error',
            title: '压缩已完成，Token 账本刷新失败',
            message: ledgerError?.message || '旧请求用量未能失效，请在继续对话前重试或重载',
            duration: 0,
          }));
        }
        await refreshProjectedTokenCount(convId, { allowApiOverride: true });
        dispatch(addNotification({ type: 'success', title: '已手动压缩', message: '历史已生成 record 摘要批次（对话原文照常完整保留，仅在压缩点标注）' }));
      } catch (err: any) {
        dispatch(addNotification({ type: 'error', title: '手动压缩失败', message: err?.message || '未知错误' }));
      } finally {
        if (historyMutationInFlightRef.current === '手动压缩') {
          historyMutationInFlightRef.current = null;
          setHistoryMutationLabel(null);
        }
      }
    },
    // ★ M4-6-S4 /loop：最小循环驱动器（串行重发 N 次同指令，硬上限，可 handleStop 中断）。
    startLoop: (times: number, instruction: string) => {
      loopRunner.start(times, instruction, {
        runAgent: (text: string) => {
          agentLoopRef.current?.run(text).catch((err: any) => {
            dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err?.message || '未知错误' }));
          });
        },
        // conversationRef 持有最新 conversation（每 render 同步），异步轮询读 .current 总拿最新流式态。
        isStreaming: () => Boolean(conversationRef.current.isStreaming),
        notify: (payload) => dispatch(addNotification(payload)),
      });
    },
  }), [dispatch, invalidateRequestLedgerForHistoryMutation, refreshProjectedTokenCount]);

  // ★ M6：把发送时 extract 的有序 token 按类型分派组装注入上下文（经 opts.injectedContext 透传，不污染可见流）。
  //   conversation 复用 buildInjectedContext；file/dir 给清单提示（AI 按需 view_file/list_dir）；mcp/terminal 预留。
  const buildContextFromTokens = useCallback(async (tokens: ExtractedToken[]): Promise<string> => {
    if (tokens.length === 0) return '';
    const blocks: string[] = [];
    const convRefs = tokens
      .filter(t => t.type === 'conversation' && t.id)
      .map(t => ({ kind: 'conversation' as const, id: t.id, title: t.value }))
      .filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i);
    if (convRefs.length > 0) {
      const conv = await buildInjectedContext(convRefs).catch(() => '');
      if (conv) blocks.push(conv);
    }
    const fileTokens = tokens.filter(t => t.type === 'file' || t.type === 'directory');
    if (fileTokens.length > 0) {
      // ★ M6 收尾 D1 修补（review HIGH#2 隐私泄漏）：注入文本给 AI 看的是【相对路径】（displayLabel），
      //   而非绝对路径（t.value 是绝对路径，落到外部 LLM 日志会泄漏 Windows 用户名/家目录/盘符）。
      //   AI 调 view_file/list_dir 时拿相对路径，fileSystem.resolveWorkspacePath 会按当前 worktree 解析；
      //   绝对路径仅作【dataset.value】用于内部 token 锚点，从不出现在 LLM payload。
      //   顺手做最小转义：剔除换行 / 控制字符（POSIX 文件名可能含 \n，防 prompt injection），并截断 4096 字。
      const sanitizePath = (s: string) => Array.from(
        s,
        character => character.charCodeAt(0) <= 0x1f ? ' ' : character,
      ).join('').slice(0, 4096);
      const lines = fileTokens.map(t => `- ${sanitizePath(t.displayLabel ?? t.value)}`).join('\n');
      blocks.push(`# 用户引用的文件 / 目录（按需用 view_file / list_dir 查看）\n${lines}`);
    }
    // mcp / terminal：Phase 2 预留（buildMcpContext / buildTerminalContext）。
    return blocks.join('\n\n');
  }, [buildInjectedContext]);

  // ★ H4-2：释放一批排队消息持有的附件 sha256（refCount 守恒）。排队项的 attachments 结构与 message 兼容，
  //   直接复用 releaseMessageAttachments。仅在「排队项被丢弃且其引用不再被任何消息持有」时调（取消单条 / 清队列）。
  const releaseQueuedAttachments = useCallback((items: QueuedMessage[]) => {
    const withAtts = items.filter(it => (it.attachments?.length ?? 0) > 0);
    if (withAtts.length === 0) return;
    void releaseMessageAttachments(withAtts as any).catch(() => undefined);
  }, []);

  // ★ H4-2：带附件释放的「清空队列」——护栏①②用：Stop / 新建 / 切换 / 分支 调用，先 release 草稿附件再清队列，
  //   避免被丢弃的排队消息泄漏 sha256（reducer 内 setConversation/clearConversation 也清 queue，但无法做 release 副作用，
  //   故走身份切换 handler 时优先用本 helper；reducer 那层仅作防串台兜底，漏 release 只多占盘不致命）。
  const clearQueueWithRelease = useCallback(() => {
    const cur = (conversationRef.current.queuedMessages as QueuedMessage[]) ?? [];
    if (cur.length > 0) releaseQueuedAttachments(cur);
    dispatch(clearQueue());
    // ★ Plan_7 #6：插队队列同口径清空 + release（中止/切换/新建/分支共用，防中止后乱插、防串台）。
    const curInt = (conversationRef.current.interruptMessages as QueuedMessage[]) ?? [];
    if (curInt.length > 0) releaseQueuedAttachments(curInt);
    dispatch(clearInterruptQueue());
  }, [dispatch, releaseQueuedAttachments]);

  // ★ Plan_7 #11：仅清空【排队】框（三框各自的「清空」按钮用，互不影响另一队列）。先 release 再清。
  const clearQueueOnly = useCallback(() => {
    const cur = (conversationRef.current.queuedMessages as QueuedMessage[]) ?? [];
    if (cur.length > 0) releaseQueuedAttachments(cur);
    dispatch(clearQueue());
  }, [dispatch, releaseQueuedAttachments]);

  // ★ Plan_7 #11：仅清空【插队】框。先 release 再清。
  const clearInterruptOnly = useCallback(() => {
    const cur = (conversationRef.current.interruptMessages as QueuedMessage[]) ?? [];
    if (cur.length > 0) releaseQueuedAttachments(cur);
    dispatch(clearInterruptQueue());
  }, [dispatch, releaseQueuedAttachments]);

  // ★ H4-2：取消单条排队消息（× 按钮）。先 release 该项附件再从队列移除（refCount 守恒）。
  const handleCancelQueued = useCallback((id: string) => {
    const cur = (conversationRef.current.queuedMessages as QueuedMessage[]) ?? [];
    const target = cur.find(it => it.id === id);
    if (target) releaseQueuedAttachments([target]);
    dispatch(dequeueMessage({ id }));
  }, [dispatch, releaseQueuedAttachments]);

  // ★ Plan_7 #6：取消单条插队消息（× 按钮）。孪生 handleCancelQueued——先 release 再 dequeueInterrupt。
  const handleCancelInterrupt = useCallback((id: string) => {
    const cur = (conversationRef.current.interruptMessages as QueuedMessage[]) ?? [];
    const target = cur.find(it => it.id === id);
    if (target) releaseQueuedAttachments([target]);
    dispatch(dequeueInterrupt({ id }));
  }, [dispatch, releaseQueuedAttachments]);

  // ★ Plan_7 #11：在两队列间切换某项（queue 项 ↔ interrupt 项）。原子搬移，附件引用随项转移（不 release）。
  const handleToggleQueueItem = useCallback((id: string, from: 'queue' | 'interrupt') => {
    dispatch(moveQueueItem({ id, from, to: from === 'queue' ? 'interrupt' : 'queue' }));
  }, [dispatch]);

  const reviewGroups = useMemo(
    () => groupFileDiffs(pendingDiffs, fileSnapshots).filter(group => group.activeDiffs.length > 0),
    [fileSnapshots, pendingDiffs],
  );

  const handleReviewGroup = useCallback(async (group: DiffReviewGroup, action: 'accept' | 'reject') => {
    if (group.activeDiffs.length === 0) return;
    const conv = conversationRef.current;
    const latest = group.activeDiffs[group.activeDiffs.length - 1];
    const pathKeys = await reviewPathKeys(latest.path, latest.contextId, runtimeConversationId);
    const editorTab = editorTabs.find(tab =>
      tab.filePath &&
      tab.content !== undefined &&
      pathKeys.has(normalizeDiffPath(tab.filePath)),
    );
    try {
      const status = action === 'accept' ? 'accepted' : 'rejected';
      const result = await applyDiffGroupReview(group.activeDiffs, conv.fileSnapshots, status, editorTab ? {
        content: editorTab.content ?? '',
        savedContent: editorTab.savedContent ?? '',
      } : undefined);
      if (editorTab && result.removeEditor) {
        dispatch(closeTab(editorTab.id));
      } else if (editorTab && result.editorContent !== undefined && result.editorSavedContent !== undefined) {
        dispatch(reconcileTabFile({ id: editorTab.id, content: result.editorContent, savedContent: result.editorSavedContent }));
      }
      for (const diff of group.activeDiffs) {
        dispatch(updateDiffStatus({ diffId: diff.id, status, conversationId: runtimeConversationId }));
      }
      if (result.merged) {
        dispatch(addNotification({
          type: 'success',
          title: action === 'accept' ? '已接受并保留后续编辑' : '已回退 Agent 改动并保留后续编辑',
          message: latest.path,
          duration: 2500,
        }));
      }
    } catch (err: any) {
      const message = err?.message || latest.path;
      dispatch(setDiffReviewError({ diffId: latest.id, error: message, conversationId: runtimeConversationId }));
      dispatch(addNotification({ type: 'error', title: action === 'accept' ? '接受失败' : '回退失败', message }));
    }
  }, [dispatch, editorTabs, runtimeConversationId]);

  const handleReviewBatch = useCallback((action: 'accept' | 'reject') => {
    void (async () => {
      const orderedGroups = action === 'reject' ? [...reviewGroups].reverse() : reviewGroups;
      for (const group of orderedGroups) {
        await handleReviewGroup(group, action);
      }
    })();
  }, [handleReviewGroup, reviewGroups]);

  // ★ H4-2：发送核心——从「文本 + tokens + 就绪附件」执行一次用户发送（斜杠/@MultiAI 分流 + H4-1 收口 +
  //   组装 contentParts + 调 agentLoop.run）。被两条路共用：① handleSend（从输入框 DOM extract 后调）；
  //   ② 队列下降沿自动发（从 queuedMessages 队首取内容后调）。故所有「与 DOM 输入框耦合」的副作用（clear/
  //   setCanSend/setPendingAttachments/setPreviewAttachment）由【调用方】各自处理，本函数只负责发送语义本身。
  //   返回值：'sent'（真发了消息/工作流，下游会进 streaming）| 'handled'（斜杠命令就地处理，未发消息）。
  const validateAttachmentAdmission = useCallback((
    text: string,
    attachments: AttachmentRef[],
    messagesBeingResent: any[] = [],
  ): boolean => {
    if (attachments.length > 0 && parseMultiAITrigger(text)) {
      dispatch(addNotification({
        type: 'warning',
        title: 'Multi-AI 暂不接收附件',
        message: '输入内容和附件仍保留，请移除附件后发送，或改用普通对话处理图片',
      }));
      return false;
    }
    const requestContainsImage = attachments.some(attachment => attachment.kind === 'image')
      || messagesBeingResent.some(message => (
        message?.attachments?.some((attachment: AttachmentRef) => attachment.kind === 'image')
        || message?.contentParts?.some((part: any) => part?.type === 'image_url')
      ));
    if (requestContainsImage && currentCapabilities?.vision !== true) {
      dispatch(addNotification({
        type: 'warning',
        title: '当前模型未确认支持图片',
        message: '本轮正在重新提交图片，内容会保留；请切换到明确支持 Vision 的模型，或移除本轮图片',
      }));
      return false;
    }
    return true;
  }, [currentCapabilities?.vision, dispatch]);

  const dispatchUserSend = useCallback((args: { text: string; tokens: ExtractedToken[]; readyAttachments: AttachmentRef[] }): 'sent' | 'handled' | 'blocked' => {
    const { text, tokens, readyAttachments } = args;

    if (!validateAttachmentAdmission(text, readyAttachments)) return 'blocked';

    // 斜杠命令分流（/命令场景无 token，plainText 即 /cmd args，命中正确；未知命令不误吞，照常发）。
    {
      const dispatchResult = parseAndDispatch(text, buildSlashHelpers());
      if (dispatchResult.handled) {
        closeMenu();
        return 'handled'; // 斜杠命令就地处理，不发消息 → 不收口任务边界（H4-1 只对真消息生效）。
      }
      if (dispatchResult.suggestion) {
        dispatch(addNotification({ type: 'info', title: '未知命令', message: `${dispatchResult.suggestion}，已作为普通消息发送` }));
      }
    }

    // ★ H4-1：用户消息归入当前任务边界开关。关闭（=== false）且存在 active 边界时，发送【前】先收口它
    //   （endTaskBoundary 不传 aborted = 标记 done 收口），新消息就落在卡片外。默认 true（!== false）维持现状。
    //   工作流路径同样适用（工作流的 user 消息也是「用户消息」）。endTaskBoundary 无 active 时内部 no-op，安全。
    if (settings.attachUserMsgToBoundary === false) {
      dispatch(endTaskBoundary({}));
    }

    // @MultiAI 工作流分流（workflow token 在最前时 plainText 形如 @MultiAI:modeName ...，命中，P10）。
    if (parseMultiAITrigger(text)) {
      closeMenu();
      // ★ HIGH#1 修：把 tokens 透传给工作流路径，让 @MultiAI 消息编辑时能无损还原 atomic 块。
      void runWorkflowFromInput(text, tokens);
      return 'sent';
    }

    closeMenu();

    const contentParts = buildUserContentParts(text, readyAttachments);
    const attachmentsForRun = readyAttachments.map(att => ({ ...att, status: 'sent' as const }));
    // ★ M6 D1：tokens 长度 > 0 时随消息持久化，作为编辑历史无损还原的锚点（不进 LLM 上下文、不计 token）。
    const richTokensForRun = tokens.length > 0 ? tokens : undefined;
    // ★ M6：有 token → 先 buildContextFromTokens 组装注入（conversation 复用 buildInjectedContext，其余按需）。
    if (tokens.length > 0) {
      void (async () => {
        const injectedContext = await buildContextFromTokens(tokens).catch(() => '');
        try {
          await agentLoopRef.current!.run(text, { contentParts, attachments: attachmentsForRun, richTokens: richTokensForRun, injectedContext: injectedContext || undefined });
        } catch (err: any) {
          dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err?.message || '未知错误' }));
        }
      })();
      return 'sent';
    }
    agentLoopRef.current!.run(text, { contentParts, attachments: attachmentsForRun, richTokens: richTokensForRun }).catch((err: any) => {
      dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err.message || '未知错误' }));
    });
    return 'sent';
  }, [settings.attachUserMsgToBoundary, buildUserContentParts, buildContextFromTokens, runWorkflowFromInput, buildSlashHelpers, closeMenu, dispatch, validateAttachmentAdmission]);

  const handleSend = useCallback(async (opts?: { withModifier?: boolean }) => {
    // ★ M6：数据源从受控 input → richRef.extract()（DOM 唯一真值）。plainText 已内建 token 占位语义（P10），
    //   下游 parseAndDispatch/parseMultiAITrigger 直接吃 plainText 即命中；tokens 供 buildContextFromTokens 注入。
    const extracted = richRef.current?.extract() ?? { plainText: '', tokens: [] };
    const text = extracted.plainText.trim();
    const tokens = extracted.tokens;
    const readyAttachments = pendingAttachments.filter(att => att.status === 'ready');
    if (!text && readyAttachments.length === 0) return;

    // ★ #13：前台压缩进行中禁止发送（压缩是阻塞操作，不进 queue；压缩完用户自行再发）。
    if (storeCompactingRef.current) {
      dispatch(addNotification({ type: 'info', title: '压缩中', message: '上下文正在压缩，请稍候片刻再发送' }));
      return;
    }
    if (historyMutationInFlightRef.current) {
      dispatch(addNotification({
        type: 'info',
        title: '历史操作进行中',
        message: `请等待「${historyMutationInFlightRef.current}」完成后再发送，输入内容已保留`,
      }));
      return;
    }

    if (!hasApiKey) {
      dispatch(addNotification({ type: 'warning', title: '未配置 API', message: '请先在设置 → AI 中配置 API Key 和端点' }));
      return;
    }
    if (!hasModel) {
      dispatch(addNotification({ type: 'warning', title: '未选择模型', message: '请先在设置 → AI 中获取并选择模型' }));
      return;
    }
    if (!agentLoopRef.current) {
      dispatch(addNotification({ type: 'warning', title: 'AI 未就绪', message: '请确认 API Key、端点和模型均已配置' }));
      return;
    }
    if (!validateAttachmentAdmission(text, readyAttachments)) return;

    const targetConversationId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
    const isCompactRecoveryCommand = /^\/compact(?:\s|$)/i.test(text);
    if (!isCompactRecoveryCommand) {
      let conversationReady = false;
      try {
        conversationReady = await bpcScheduler.ensureConversationReady(targetConversationId);
      } catch (error) {
        console.warn('[AgentPanel] 发送前恢复压缩状态失败:', error);
        dispatch(addNotification({
          type: 'error',
          title: '暂时无法确认压缩状态',
          message: '输入内容已保留，请稍后重试',
        }));
        return;
      }
      if (!conversationReady) {
        dispatch(addNotification({
          type: 'warning',
          title: '这条对话仍处于保护性暂停',
          message: '输入内容已保留，请点击压缩状态环右侧的「恢复」按钮，或执行 /compact 完成恢复',
          duration: 0,
        }));
        return;
      }
    }
    const liveConversationId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
    if (liveConversationId !== targetConversationId) {
      dispatch(addNotification({
        type: 'info',
        title: '对话已切换',
        message: '输入内容仍保留，请在当前对话确认后再发送',
      }));
      return;
    }
    if (historyMutationInFlightRef.current) {
      dispatch(addNotification({
        type: 'info',
        title: '历史操作进行中',
        message: `请等待「${historyMutationInFlightRef.current}」完成后再发送，输入内容已保留`,
      }));
      return;
    }

    // ★ Plan_7 #6：生成中插话 → 不再静默丢弃，入【双队列】之一（不打断生成）：
    //   - queue（排队）：本轮 agent loop 彻底结束后由空闲 effect 自动发。
    //   - interrupt（插队）：下个空闲轮间由 agentLoop 插入 messages，AI 当前 run 下一轮就看到。
    //   分流：主键（plain Enter / 点发送钮，withModifier=false）→ runtimeEnterAction；修饰键（Ctrl·Cmd+Enter）→ 相反。
    //   每队列各自上限 5。入队成功后清输入框 + 草稿附件，但【不 release sha256】（引用随队列项留到发送时复用）。
    // ★ P0 同源修复（review HIGH：轮间窗口丢消息）：闸门用「真实运行态」而非仅 isStreaming——
    //   agentLoop 工具轮间会 setStreaming(false) 让 isStreaming【假性归零】，此时若按 isStreaming 走下方「立即发送」
    //   分支，会先清空输入再 run()，而 run() 命中重入闸（this.running 仍 true）只弹通知就 return → 用户输入静默丢失。
    //   改用 isStreaming||isRunning：run 全程（含工具轮间）都走双队列，绝不静默丢消息。
    if (isStreaming || isLoopRunning) {
      const withModifier = opts?.withModifier === true;
      const target: 'queue' | 'interrupt' = withModifier
        ? (runtimeEnterAction === 'queue' ? 'interrupt' : 'queue')
        : runtimeEnterAction;
      const targetLen = target === 'interrupt' ? interruptMessages.length : queuedMessages.length;
      if (targetLen >= 5) {
        dispatch(addNotification({
          type: 'warning',
          title: target === 'interrupt' ? '插队已满' : '排队已满',
          message: `最多${target === 'interrupt' ? '插队' : '排队'} 5 条消息，请等当前回复结束后再发`,
        }));
        return;
      }
      const contentPartsForQueue = buildUserContentParts(text, readyAttachments);
      const item: QueuedMessage = {
        id: generateMessageId(target === 'interrupt' ? 'interrupt' : 'queued'),
        text,
        contentParts: contentPartsForQueue.length > 0 ? contentPartsForQueue : undefined,
        attachments: readyAttachments.length > 0 ? readyAttachments : undefined,
        richTokens: tokens.length > 0 ? tokens : undefined,
        enqueuedAt: Date.now(),
      };
      dispatch(target === 'interrupt' ? enqueueInterrupt(item) : enqueueMessage(item));
      richRef.current?.clear(); setCanSend(false);
      setPendingAttachments([]); // ★ 注意：不 release sha256（引用转移给队列项，发送时复用）
      setPreviewAttachment(null);
      closeMenu();
      dispatch(addNotification({
        type: 'info',
        title: target === 'interrupt' ? '已插队' : '已排队',
        message: target === 'interrupt' ? '将在 AI 下一步操作前插入这条消息' : '当前回复结束后将自动发送这条消息',
      }));
      return;
    }

    // 非生成中 → 正常立即发送。只有准入成功后才清空草稿；被能力门禁阻止时原文和附件保持原样。
    const result = dispatchUserSend({ text, tokens, readyAttachments });
    if (result === 'blocked') return;
    richRef.current?.clear(); setCanSend(false);
    setPendingAttachments([]);
    setPreviewAttachment(null);
  }, [pendingAttachments, isStreaming, isLoopRunning, runtimeEnterAction, queuedMessages.length, interruptMessages.length, hasApiKey, hasModel, buildUserContentParts, dispatchUserSend, closeMenu, dispatch, validateAttachmentAdmission]);

  const validateQueuedDrainAdmission = useCallback((
    targetConversationId: string,
    targetCapabilities: any,
    batch: Array<{ message: QueuedMessage; readyAttachments: AttachmentRef[] }>,
  ): boolean => {
    const notifyIfActive = (title: string, message: string) => {
      const activeConversationId = selectActiveConversation(store.getState() as RootState).id || AUTOSAVE_ID;
      if (activeConversationId !== targetConversationId) return;
      dispatch(addNotification({ type: 'warning', title, message, duration: 0 }));
    };
    for (const item of batch) {
      if (item.readyAttachments.length > 0 && parseMultiAITrigger(item.message.text)) {
        notifyIfActive('Multi-AI 暂不接收附件', '排队内容和附件仍保留，请移除附件后发送，或改用普通对话处理图片');
        return false;
      }
      const requestContainsImage = item.readyAttachments.some(attachment => attachment.kind === 'image')
        || item.message.contentParts?.some((part: any) => part?.type === 'image_url');
      if (requestContainsImage && targetCapabilities?.vision !== true) {
        notifyIfActive('当前模型未确认支持图片', '这条排队消息仍保留；请切换到明确支持 Vision 的模型，或移除本轮图片');
        return false;
      }
    }
    return true;
  }, [dispatch]);

  const drainConversationQueue = useCallback(async (targetConversationId: string): Promise<QueueDrainResult> => {
    const rootState = store.getState() as RootState;
    const targetBucket = selectConversationById(rootState, targetConversationId);
    const pendingBatch = buildQueueDrainBatch(targetBucket);
    if (pendingBatch.length === 0) return { status: 'empty', reason: 'empty' };

    const selectedModel = targetBucket.model || (rootState as any).agentSettings?.currentModel || '';
    const targetRuntime = resolveProviderModel(
      selectedModel,
      (rootState as any).agentSettings?.availableModels,
      (rootState as any).settings?.providerCredentials,
      (rootState as any).settings?.apiEndpoints,
    );
    const activeConversationId = selectActiveConversation(rootState).id || AUTOSAVE_ID;
    const targetLoop = (activeConversationId === targetConversationId ? agentLoopRef.current : null)
      ?? executionRegistry.getLoop<AgentLoop>(targetConversationId);
    const earlyBlock = queueDrainBlockReason({
      isStreaming: targetBucket.isStreaming,
      isRunning: targetLoop?.isRunning ?? false,
      hasPendingToolTasks: hasPendingToolTaskWork(targetBucket),
      hasHistoryMutation: Boolean(historyMutationInFlightRef.current),
      hasRunnableModel: targetRuntime.ready && Boolean(targetRuntime.modelId),
      hasLoop: Boolean(targetLoop),
    });
    if (earlyBlock) return { status: 'blocked', reason: earlyBlock };

    const hasCompactRecoveryCommand = pendingBatch.some(({ message }) => /^\/compact(?:\s|$)/i.test(message.text));
    try {
      if (!hasCompactRecoveryCommand && !(await bpcScheduler.ensureConversationReady(targetConversationId))) {
        return { status: 'blocked', reason: 'hard-paused' };
      }
    } catch (error) {
      console.warn('[AgentPanel] 恢复排队消息前确认压缩状态失败，保留队列等待下次重试:', error);
      return { status: 'blocked', reason: 'hard-paused' };
    }

    const latestState = store.getState() as RootState;
    const latestBucket = selectConversationById(latestState, targetConversationId);
    const latestActiveConversationId = selectActiveConversation(latestState).id || AUTOSAVE_ID;
    const latestLoop = (latestActiveConversationId === targetConversationId ? agentLoopRef.current : null)
      ?? executionRegistry.getLoop<AgentLoop>(targetConversationId)
      ?? targetLoop;
    const lateBlock = queueDrainBlockReason({
      isStreaming: latestBucket.isStreaming,
      isRunning: latestLoop?.isRunning ?? false,
      hasPendingToolTasks: hasPendingToolTaskWork(latestBucket),
      hasHistoryMutation: Boolean(historyMutationInFlightRef.current),
      hasRunnableModel: targetRuntime.ready && Boolean(targetRuntime.modelId),
      hasLoop: Boolean(latestLoop),
    });
    if (lateBlock) return { status: 'blocked', reason: lateBlock };
    if (!isQueueDrainBatchCurrent(latestBucket, pendingBatch)) {
      return { status: 'blocked', reason: 'batch-changed' };
    }

    const normalizedBatch = pendingBatch.map(({ source, message }) => ({
      source,
      message,
      readyAttachments: (message.attachments ?? []).map(att => ({
        ...att,
        previewUrl: undefined,
        payloadUrl: undefined,
        status: 'ready' as const,
        error: undefined,
      })),
    }));
    const specialIndex = normalizedBatch.findIndex(({ message }) => (
      /^\//.test(message.text.trim()) || !!parseMultiAITrigger(message.text)
    ));

    if (specialIndex === 0) {
      if (latestActiveConversationId !== targetConversationId) {
        return { status: 'blocked', reason: 'special-background-blocked' };
      }
      const item = normalizedBatch[0];
      const result = dispatchUserSend({
        text: item.message.text,
        tokens: item.message.richTokens ?? [],
        readyAttachments: item.readyAttachments,
      });
      if (result === 'blocked') return { status: 'blocked', reason: 'attachment-blocked' };
      dispatch(item.source === 'interrupt'
        ? dequeueInterrupt({ id: item.message.id, conversationId: targetConversationId })
        : dequeueMessage({ id: item.message.id, conversationId: targetConversationId }));
      return { status: result === 'handled' ? 'handled' : 'started', continueImmediately: result === 'handled' };
    }

    const sendBatch = specialIndex > 0 ? normalizedBatch.slice(0, specialIndex) : normalizedBatch;
    if (!validateQueuedDrainAdmission(targetConversationId, targetRuntime.option?.capabilities, sendBatch)) {
      return { status: 'blocked', reason: 'attachment-blocked' };
    }

    const injectedContexts = await Promise.all(sendBatch.map(async ({ message }, index) => {
      if (!message.richTokens?.length) return '';
      const context = await buildContextFromTokens(message.richTokens).catch(() => '');
      return context ? `【排队消息 ${index + 1} 的引用上下文】\n${context}` : '';
    }));

    const beforeRunState = store.getState() as RootState;
    const beforeRunBucket = selectConversationById(beforeRunState, targetConversationId);
    const beforeRunLoop = executionRegistry.getLoop<AgentLoop>(targetConversationId) ?? latestLoop;
    const beforeRunBlock = queueDrainBlockReason({
      isStreaming: beforeRunBucket.isStreaming,
      isRunning: beforeRunLoop?.isRunning ?? false,
      hasPendingToolTasks: hasPendingToolTaskWork(beforeRunBucket),
      hasHistoryMutation: Boolean(historyMutationInFlightRef.current),
      hasRunnableModel: targetRuntime.ready && Boolean(targetRuntime.modelId),
      hasLoop: Boolean(beforeRunLoop),
    });
    if (beforeRunBlock) return { status: 'blocked', reason: beforeRunBlock };
    if (!isQueueDrainBatchCurrent(beforeRunBucket, pendingBatch)) {
      return { status: 'blocked', reason: 'batch-changed' };
    }

    const [first, ...rest] = sendBatch;
    const removeAcceptedItems = () => {
      for (const item of sendBatch) {
        dispatch(item.source === 'interrupt'
          ? dequeueInterrupt({ id: item.message.id, conversationId: targetConversationId })
          : dequeueMessage({ id: item.message.id, conversationId: targetConversationId }));
      }
    };
    const boundaryMode = queueDrainBoundaryMode(sendBatch);
    if (boundaryMode === 'aborted') {
      dispatch(endTaskBoundary({ aborted: true, conversationId: targetConversationId }));
    } else if (boundaryMode === 'done') {
      dispatch(endTaskBoundary({ conversationId: targetConversationId }));
    }

    try {
      await beforeRunLoop!.run(first.message.text, {
        contentParts: first.message.contentParts,
        attachments: first.readyAttachments.map(attachment => ({ ...attachment, status: 'sent' as const })),
        richTokens: first.message.richTokens,
        additionalUserMessages: rest.map(item => ({
          content: item.message.text,
          contentParts: item.message.contentParts,
          attachments: item.readyAttachments.map(attachment => ({ ...attachment, status: 'sent' as const })),
          richTokens: item.message.richTokens,
        })),
        injectedContext: injectedContexts.filter(Boolean).join('\n\n') || undefined,
        onUserMessagesAccepted: removeAcceptedItems,
      });
      return { status: 'started' };
    } catch (error: any) {
      console.warn('[AgentPanel] 恢复排队消息失败，保留队列等待下次重试:', error);
      const activeId = selectActiveConversation(store.getState() as RootState).id || AUTOSAVE_ID;
      if (activeId === targetConversationId) {
        dispatch(addNotification({ type: 'error', title: '恢复排队消息失败', message: error?.message || '队列已保留，稍后会重试' }));
      }
      return { status: 'blocked', reason: 'loop-unavailable' };
    }
  }, [buildContextFromTokens, dispatch, dispatchUserSend, validateQueuedDrainAdmission]);

  useEffect(() => queueDrainCoordinator.registerHandler(drainConversationQueue), [drainConversationQueue]);

  useEffect(() => {
    queueDrainCoordinator.requestDrain(runtimeConversationId, 'foreground-idle');
  }, [runtimeConversationId, isStreaming, isLoopRunning, historyMutationLabel, queuedMessages, interruptMessages, hasApiKey, hasModel, activeBpcUi.state, toolTaskReferences.pendingTasks.length, toolTaskReferences.orphanPendingCallIds.size]);

  const handleStop = useCallback(async () => {
    // ★ M3-2b 修复（high）：Stop 按钮要同时管「普通对话」与「@MultiAI 工作流」两条路。
    //   两条路共用同一个 isStreaming 闸门和同一个 Stop 控件，但工作流不由 agentLoop 驱动——
    //   它在 agentOrchestrator.runWorkflow 这条独立链路上跑（可长达 30 分钟、派发 60 个子代理）。
    //   - agentLoopRef.current?.stop()：停普通 agentLoop（工作流期间 agentLoop 未运行，是 no-op）。
    //   - agentOrchestrator.abortAll()：abort workflowAbortController（让 runWorkflow 在下个节点前 return aborted）
    //       + 杀在途子代理；无运行工作流时 abortAll 内部全是 optional-chain/空集合遍历，安全 no-op。
    //   abortAll 后 runWorkflow 返回 aborted 结果，照常走 outcome.kind==='ran' 插「无法推进」汇总，闭环正常。
    queueDrainCoordinator.cancelDrain(conversationId);
    const stopConversation = executionRegistry.stopConversation(conversationId);
    agentLoopRef.current = null;
    setAgentLoopResetGeneration(current => current + 1);
    const stopBpc = bpcScheduler.discardCurrent(conversationId, '用户停止当前对话');
    const stopWorkflow = isWorkflowRunningRef.current
      ? agentOrchestrator.abortAll()
      : Promise.resolve();
    // ★ #12 修复：先立即中止模型与循环，再等待后台执行器确认取消，最后复位流式态。
    // ★ M4-6-S5 /loop 中途 Stop：循环驱动器请求中断——置 aborted 后循环在下个检查点退出，
    //   正在跑的那一轮由上面 agentLoopRef.current.stop() 中止。无运行循环时 stop() 内部 no-op，安全。
    loopRunner.stop();
    // ★ H1（tb 卡住）：收口未结束的 active task_boundary（标记 aborted/红），覆盖 workflow/loop 这类
    //   非 agentLoop 驱动的中止路径（agentLoop 自身的 abort/error 已在 agentLoop 收尾兜底收口）。
    //   endTaskBoundary 无 active 时内部 no-op，安全。
    // ★ H4-2 护栏①：用户中止 → 清空排队队列（绝不自动发排队消息）。先 release 草稿附件再清（refCount 守恒）。
    //   这是「不是被用户中止的才自动发」的闭环实现：Stop 后队列空 → 下降沿 effect 自然 length===0 不发。
    clearQueueWithRelease();
    // UI 必须先立即回到可发送态；执行器取消确认在后台收尾，不能让 5s 等待继续占住输入框。
    dispatch(setStreaming({ value: false, conversationId }));
    dispatch(endTaskBoundary({ aborted: true, conversationId }));
    // ★ 六轮 #154：中止后把焦点拉回输入框——Stop 按钮点击后会变回 Send 按钮(焦点随之丢失)，
    //   用户直接打字无反应、误以为"输入框无法输入"。rAF 等按钮切换+isStreaming 复位后再聚焦。
    requestAnimationFrame(() => richRef.current?.focus());
    await Promise.allSettled([stopConversation, stopWorkflow, stopBpc]);
  }, [dispatch, clearQueueWithRelease, conversationId]);

  // Plan_4 M2-1：编辑/重试/回溯会截断后续消息。把 record 水位线 clamp 到保留范围（替代此前的整条删）：
  // 覆盖区在保留范围内则不动；否则 clamp totalRounds/totalSteps/lastUpdatedRound，保住 M 之前已生成的摘要、
  // 且保证后续增量压缩批次起点正确；clamp 后归零才删。record 是加速层，失败吞异常不阻塞主对话。
  const invalidateRecordForTruncation = useCallback(async (conversationId: string, remainingMessages: any[]) => {
    // step 口径对齐 agentLoop：record.totalSteps 来自不含 tool 的 requestHistory
    const keptSteps = remainingMessages.filter((m: any) => m.role !== 'tool').length;
    // ★ M5-2 批次二修复（medium）：keptRounds 必须是 identifyRounds 收敛后的【真轮数】（连发 user
    //   合并为 1 轮），不能再用「user 角色条数」近似。批 roundEnd 在 M5-2 后已是真轮号，若这里仍传
    //   user 条数（恒 ≥ 真轮数）→ safeRounds 偏大 → clampToBatch 里 `roundEnd > safeRounds` 几乎永不成立
    //   → 按轮裁剪分支退化为死代码（只剩 step 口径）。在已过滤 tool 的 remainingMessages 上调
    //   identifyRounds 取 totalRounds，与批 roundEnd 同口径，规范 §1/§3「向轮边界取整」在回溯/编辑/重试侧才闭环。
    const keptRounds = identifyRounds(
      remainingMessages.filter((m: any) => m.role !== 'tool'),
    ).totalRounds;
    // M2-R1：批次整体保留语义（穿过截断点的批及之后整批回退原文），替代旧数字 clamp。
    const clampedRecord = await clampToBatch(conversationId, keptRounds, keptSteps);
    await bpcScheduler.reconcileAfterHistoryMutation(conversationId, clampedRecord);
  }, []);

  // M2-R6 refCount GC：对被移除/被丢弃引用的消息，fire-and-forget release 其附件 sha256（归零删实体）。
  // 漏 release 只多占盘（不致命）；多 release 才危险，故只在「明确移除」处调用。
  const gcMessages = useCallback((removed: any[]) => {
    if (removed.length === 0) return;
    void releaseMessageAttachments(removed).catch(() => undefined);
  }, []);

  // ★ Plan_5 M5-3/M5-5：把一条 user 消息「回填进输入框待发」（回溯 / user 分支点共用）。
  //   - 文本进 input（本地受控态，与 suggestion-chip 等程序化填值同款）+ 同步 setPendingMessage（store 字段）。
  //   - 附件还原成【草稿态 pending 附件】：剥掉运行/已发标记，status 置 ready，清掉内存预览（落库后只有 sha256）。
  //   ★ refCount 守恒（关键）：调用方必须把这条 user 从 GC 列表中【排除】（不 release 它的 sha256）——
  //     源消息被移除后，它原本持有的那 1 份引用「转移」给 pending 草稿；故这里【不再 addRef】（否则双计）。
  //     之后用户发送时 pending 转成新消息引用（守恒），或点 × removePendingAttachment 时 release（守恒）。
  //   - 图片预览：pending tray 用 previewUrl 显示缩略图，历史消息附件落库后无 previewUrl → 异步按 sha256
  //     还原 dataUrl 回填（与 resolveAttachmentsForRender 同源 resolveAttachmentDataUrl）。
  const refillInputFromUserMessage = useCallback((userMsg: { content?: string; attachments?: AttachmentRef[]; richTokens?: ExtractedToken[] } | null | undefined) => {
    const text = userMsg?.content ?? '';
    // ★ M6 D1：有 richTokens 则用 buildRichParts 重组 + setContent 无损还原 atomic 块；旧消息无 richTokens 自动降级纯文本。
    richRef.current?.setContent(buildRichParts(text, userMsg?.richTokens));
    setCanSend(!richRef.current?.isEmpty());
    dispatch(setPendingMessage(text));
    const atts = userMsg?.attachments ?? [];
    if (atts.length === 0) {
      setPendingAttachments([]);
      return;
    }
    const restored: AttachmentRef[] = atts
      .filter(att => !!att.sha256) // 无 sha256 引用的（理论不应出现在已发消息里）无法作为草稿持有，跳过
      .map(att => ({
        ...att,
        previewUrl: undefined,
        payloadUrl: undefined,
        status: 'ready' as const,
        error: undefined,
      }));
    setPendingAttachments(restored);
    // 异步还原图片缩略图（不阻塞回填；失败则 tray 显图标占位）。
    for (const att of restored) {
      if (att.kind === 'image' && att.sha256) {
        void resolveAttachmentDataUrl(att.sha256).then(dataUrl => {
          if (!dataUrl) return;
          setPendingAttachments(prev => prev.map(p => (p.id === att.id ? { ...p, previewUrl: dataUrl } : p)));
        });
      }
    }
  }, [dispatch]);

  // ★ Plan_7 #11：编辑某条队列/插队消息（✎ 按钮）——把内容回填输入框（含富文本 token + 附件草稿，复用 refillInputFromUserMessage），
  //   再从原队列移除。⚠️ 不 release 附件：引用从队列项转移回输入框草稿（refCount 守恒，与 refillInputFromUserMessage 同口径）。
  const handleEditQueueItem = useCallback((item: QueuedMessage, from: 'queue' | 'interrupt') => {
    refillInputFromUserMessage({ content: item.text, attachments: item.attachments, richTokens: item.richTokens });
    dispatch(from === 'interrupt' ? dequeueInterrupt({ id: item.id }) : dequeueMessage({ id: item.id }));
    richRef.current?.focus();
  }, [dispatch, refillInputFromUserMessage]);

  const isHistoryMutationBlocked = useCallback(() => Boolean(
    conversationRef.current.isStreaming
    || agentLoopRef.current?.isRunning
    || isWorkflowRunningRef.current
    || storeCompactingRef.current
    || historyMutationInFlightRef.current
  ), []);

  const beginHistoryMutation = useCallback((label: string): boolean => {
    if (isHistoryMutationBlocked()) {
      dispatch(addNotification({
        type: 'info',
        title: '暂时不能修改历史',
        message: historyMutationInFlightRef.current
          ? `请等待「${historyMutationInFlightRef.current}」完成`
          : '请等待当前生成、工作流或压缩完成',
      }));
      return false;
    }
    historyMutationInFlightRef.current = label;
    setHistoryMutationLabel(label);
    return true;
  }, [dispatch, isHistoryMutationBlocked]);

  const endHistoryMutation = useCallback((label: string) => {
    if (historyMutationInFlightRef.current === label) {
      historyMutationInFlightRef.current = null;
      setHistoryMutationLabel(null);
    }
  }, []);

  const ensureHistoryMutationReady = useCallback(async (targetConversationId: string, actionLabel: string): Promise<boolean> => {
    try {
      const ready = await bpcScheduler.ensureConversationReady(targetConversationId);
      if (!ready) {
        dispatch(addNotification({
          type: 'warning',
          title: `保护性暂停期间不能${actionLabel}`,
          message: '历史记录保持不变，请先恢复压缩状态或执行 /compact',
          duration: 0,
        }));
      }
      return ready;
    } catch (error: any) {
      dispatch(addNotification({
        type: 'error',
        title: '暂时无法确认压缩状态',
        message: error?.message || '历史记录保持不变，请稍后重试',
      }));
      return false;
    }
  }, [dispatch]);

  // Edit user message → truncate after it → re-send（★ C6：带附件编辑——保留/新增图、删图，refCount 精确守恒）
  // ★ D1：onEdit 签名扩 richTokens?——MessageBubble.handleSubmitEdit 透传编辑后【新 extract】的 tokens，落库覆盖旧值。
  const handleEdit = useCallback((msgId: string, newContent: string, attachments?: AttachmentRef[], richTokens?: ExtractedToken[]) => {
    if (isHistoryMutationBlocked()) return;
    // ★ 性能 3-A1：读 conversationRef 而非订阅 messages，回调引用稳定 → MessageBubble memo 流式期不被全列表陪渲。
    const targetConversation = conversationRef.current;
    const targetConversationId = targetConversation.id || AUTOSAVE_ID;
    const targetLoop = agentLoopRef.current;
    const targetFileSnapshots = targetConversation.fileSnapshots;
    const msgs = targetConversation.messages;
    const editIdx = msgs.findIndex((m: any) => m.id === msgId);
    if (editIdx < 0) return;
    const oldMsg = msgs[editIdx];
    const removedMessages = msgs.slice(editIdx + 1);
    const diffsToRollback = removedMessages
      .flatMap((message: any) => message.diffs ?? [])
      .filter((diff: any) => diff.status !== 'rejected')
      .reverse();
    const newAtts = (attachments ?? []).filter(a => a.status === 'ready');
    if (!validateAttachmentAdmission(newContent, newAtts)) return;
    const keptShas = new Set(newAtts.map(a => a.sha256).filter(Boolean) as string[]);
    if (!beginHistoryMutation('编辑消息')) return;

    void (async () => {
      let conversationReady = false;
      try {
        conversationReady = await bpcScheduler.ensureConversationReady(targetConversationId);
      } catch (error: any) {
        dispatch(addNotification({
          type: 'error',
          title: '暂时无法确认压缩状态',
          message: error?.message || '历史记录保持不变，请稍后重试',
        }));
        return;
      }
      if (!conversationReady) {
        dispatch(addNotification({
          type: 'warning',
          title: '保护性暂停期间不能编辑重发',
          message: '历史记录保持不变，请先恢复压缩状态或执行 /compact',
          duration: 0,
        }));
        return;
      }
      await bpcScheduler.discardCurrent(targetConversationId, '编辑历史消息前使未发布 BPC 候选失效');
      if (!await bpcScheduler.ensureConversationReady(targetConversationId)) {
        dispatch(addNotification({
          type: 'warning',
          title: '压缩状态已进入保护性暂停',
          message: '历史记录保持不变，请先恢复压缩状态或执行 /compact',
          duration: 0,
        }));
        return;
      }
      let rollbackTransaction: FileRollbackTransaction;
      try {
        rollbackTransaction = await rollbackFileDiffsAtomically(diffsToRollback.map((diff: any) => ({
          diff,
          snapshot: diff.snapshotId ? targetFileSnapshots[diff.snapshotId] : undefined,
        })));
      } catch (error: any) {
        dispatch(addNotification({
          type: 'error',
          title: '编辑前文件恢复失败',
          message: `${error?.message || '文件恢复失败'}。历史消息未截断；若文件在 Agent 修改后又被手动改过，系统不会冒险覆盖。`,
          duration: 0,
        }));
        return;
      }
      try {
        await invalidateRecordForTruncation(targetConversationId, msgs.slice(0, editIdx + 1));
        await invalidateRequestLedgerForHistoryMutation(targetConversationId);
      } catch (error: any) {
        let compensationMessage = '';
        try {
          await rollbackTransaction.compensate();
        } catch (compensationError: any) {
          compensationMessage = `；${compensationError?.message || '文件补偿失败，请手动核对'}`;
        }
        dispatch(addNotification({
          type: 'error',
          title: '编辑前压缩状态协调失败',
          message: `${error?.message || 'Record 裁剪失败'}，历史消息未截断，文件已恢复到操作前状态${compensationMessage}`,
          duration: 0,
        }));
        return;
      }
      for (const diff of diffsToRollback) {
        dispatch(updateDiffStatus({ diffId: diff.id, status: 'rejected', conversationId: targetConversationId }));
      }
    // ★ C6 refCount 守恒（修正旧实现把 messages[editIdx] 整体 GC 导致「编辑丢图」）：
    //   ① 后续消息整体 GC；② 被编辑消息只 release「被移除的原附件」(oldShas − keptShas)，
    //   KEPT（保留的原图）/ADDED（新上传图）不动——引用归属平移给编辑后消息（同一条 id 原地改写）。
    gcMessages(removedMessages);
    const oldShas = collectMessageShas([oldMsg]);
    for (const sha of oldShas) {
      if (!keptShas.has(sha)) void platform.attachment.delete(sha).catch(() => undefined);
    }

    // 图片进 contentParts（agentLoop 发 API 按 sha256 还原 base64）+ 全量进 attachments（store 持久 + 渲染）。
    const contentParts = buildUserContentParts(newContent, newAtts);
    const attachmentsForRun = newAtts.map(att => ({ ...att, status: 'sent' as const }));
    // ★ D1：richTokens 是编辑后输入框 extract 的最新集合（用户可能增删了 token），落库覆盖旧值。
      dispatch(editMessage({
        id: msgId,
        content: newContent,
        contentParts,
        attachments: attachmentsForRun,
        richTokens,
        conversationId: targetConversationId,
      }));
      await refreshProjectedTokenCount(targetConversationId, { allowApiOverride: true });

    // skipUserMessage 重发：agentLoop 从 store 编辑后消息的 contentParts/attachments 还原图发 API（M2-R6 R6-2c）。
      if (targetLoop) {
        setTimeout(() => {
          targetLoop.run(newContent, { skipUserMessage: true }).catch((err: any) => {
            dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err.message }));
          });
        }, 100);
      }
    })().catch((err: any) => {
          dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err.message }));
    }).finally(() => {
      endHistoryMutation('编辑消息');
    });
  }, [dispatch, invalidateRecordForTruncation, invalidateRequestLedgerForHistoryMutation, refreshProjectedTokenCount, gcMessages, buildUserContentParts, isHistoryMutationBlocked, validateAttachmentAdmission, beginHistoryMutation, endHistoryMutation]);

  // ★ Plan_5 M5-4 重试（规范 §5）：入口改挂【user 消息】（不再挂 AI 消息）。
  //   点某条 user 的「重新生成」= 回溯到该 user 所在轮（截断该 user 段之后全部，含本轮 model 段所有
  //   assistant/tool 中间 step）+ record 砍批 + 用 skipUserMessage 自动重发该 user（不填输入框）。
  //   统一以「user 消息=轮起点」为锚：重试=自动发出（与回溯「填输入框待发」区分）。复用共享 helper。
  const handleRetry = useCallback((msgId: string) => {
    if (isHistoryMutationBlocked()) return;
    const targetConversation = conversationRef.current;
    const targetConversationId = targetConversation.id || AUTOSAVE_ID;
    const targetLoop = agentLoopRef.current;
    const targetFileSnapshots = targetConversation.fileSnapshots;
    const msgs = targetConversation.messages;  // ★ 性能 3-A1：读 ref 稳定回调引用
    // ★ B3（反馈#5）：底部按钮可挂 AI/tool 消息——把锚映射到所在轮的 user 消息，重试=重新生成该轮回复。
    const anchorId = resolveRoundUserAnchor(msgs, msgId);
    // ① 共享 helper 按轮截断（before-user 模式：保留到该 user 段为止、丢弃本轮 model 段）。
    const cut: RoundTruncationResult = computeRoundTruncation(msgs, anchorId, 'before-user');
    if (!cut.ok || cut.lastKeptIndex < 0) return;
    const retryUserMsg = msgs.find((message: any) => message.id === anchorId);
    if (!retryUserMsg || !validateAttachmentAdmission('', [], [retryUserMsg])) return;
    if (!beginHistoryMutation('重新生成')) return;

    // ② 被丢弃的本轮 model 段里的文件变更按快照回退（与回溯一致；removedMessages 即本轮 model 段全部）。
    const diffsToRollback = cut.removedMessages
      .flatMap((m: any) => m.diffs ?? [])
      .filter((diff: any) => diff.status !== 'rejected')
      .reverse();

    void (async () => {
      let conversationReady = false;
      try {
        conversationReady = await bpcScheduler.ensureConversationReady(targetConversationId);
      } catch (error: any) {
        dispatch(addNotification({
          type: 'error',
          title: '暂时无法确认压缩状态',
          message: error?.message || '历史记录保持不变，请稍后重试',
        }));
        return;
      }
      if (!conversationReady) {
        dispatch(addNotification({
          type: 'warning',
          title: '保护性暂停期间不能重新生成',
          message: '历史记录保持不变，请先恢复压缩状态或执行 /compact',
          duration: 0,
        }));
        return;
      }

      await bpcScheduler.discardCurrent(targetConversationId, '重试历史轮次前使未发布 BPC 候选失效');
      if (!await bpcScheduler.ensureConversationReady(targetConversationId)) {
        dispatch(addNotification({
          type: 'warning',
          title: '压缩状态已进入保护性暂停',
          message: '历史记录保持不变，请先恢复压缩状态或执行 /compact',
          duration: 0,
        }));
        return;
      }
      let rollbackTransaction: FileRollbackTransaction;
      try {
        rollbackTransaction = await rollbackFileDiffsAtomically(diffsToRollback.map((diff: any) => ({
          diff,
          snapshot: diff.snapshotId ? targetFileSnapshots[diff.snapshotId] : undefined,
        })));
      } catch (err: any) {
        dispatch(addNotification({ type: 'error', title: '重试回退失败', message: err?.message || '文件恢复失败' }));
        return;
      }

      // ③ record 砍批到轮边界（keptRounds = 该 user 所在轮 − 1，本轮 model 段未完成不算已压；与 clampToBatch 同口径）。
      try {
        const clampedRecord = await clampRecordToRoundTruncation(targetConversationId, cut);
        await bpcScheduler.reconcileAfterHistoryMutation(targetConversationId, clampedRecord);
        await invalidateRequestLedgerForHistoryMutation(targetConversationId);
      } catch (error: any) {
        let compensationMessage = '';
        try {
          await rollbackTransaction.compensate();
        } catch (compensationError: any) {
          compensationMessage = `；${compensationError?.message || '文件补偿失败，请手动核对'}`;
        }
        dispatch(addNotification({
          type: 'error',
          title: '重试压缩状态协调失败',
          message: `${error?.message || 'Record 裁剪失败'}，历史消息未截断，文件已恢复到操作前状态${compensationMessage}`,
          duration: 0,
        }));
        return;
      }
      for (const diff of diffsToRollback) {
        dispatch(updateDiffStatus({ diffId: diff.id, status: 'rejected', conversationId: targetConversationId }));
      }

      // ④ GC 被移除的本轮 model 段附件（被保留的那条 user 不在 removedMessages 里，附件不动）。
      gcMessages(cut.removedMessages);

      // ⑤ 截到该 user 段为止（含该 user）；该 user 留在 store 里，下面用 skipUserMessage 直接对它重发。
      if (cut.lastKeptMessageId) dispatch(truncateAt({ id: cut.lastKeptMessageId, conversationId: targetConversationId }));
      await refreshProjectedTokenCount(targetConversationId, { allowApiOverride: true });

      // ⑥ 自动重发该 user（不填输入框）：skipUserMessage=true → 不新增 user 消息，直接用 store 现有历史发起请求。
      if (targetLoop) {
        setTimeout(() => {
          targetLoop.run((retryUserMsg as any)?.content ?? '', { skipUserMessage: true }).catch((err: any) => {
            dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err.message }));
          });
        }, 100);
      }
    })().catch((err: any) => {
      dispatch(addNotification({ type: 'error', title: '重新生成失败', message: err?.message || String(err) }));
    }).finally(() => {
      endHistoryMutation('重新生成');
    });
  }, [dispatch, gcMessages, invalidateRequestLedgerForHistoryMutation, refreshProjectedTokenCount, isHistoryMutationBlocked, validateAttachmentAdmission, beginHistoryMutation, endHistoryMutation]);

  // Delete single message
  const handleDelete = useCallback((msgId: string) => {
    if (isHistoryMutationBlocked()) return;
    const targetConversation = conversationRef.current;
    const targetConversationId = targetConversation.id || AUTOSAVE_ID;
    // M2-R6 GC：删单条消息前 release 其附件 sha256。★ 性能 3-A1：读 ref 稳定回调。
    const targetIndex = targetConversation.messages.findIndex((m: any) => m.id === msgId);
    const target = targetConversation.messages[targetIndex];
    if (!target || targetIndex < 0) return;
    const belongsToBoundary = (targetConversation.taskBoundaries ?? []).some((boundary: any) => {
      const startIndex = targetConversation.messages.findIndex((message: any) => message.id === boundary.anchorMessageId);
      if (startIndex < 0 || targetIndex < startIndex) return false;
      const endIndex = boundary.endAnchorMessageId
        ? targetConversation.messages.findIndex((message: any) => message.id === boundary.endAnchorMessageId)
        : (boundary.status === 'active' ? targetConversation.messages.length - 1 : startIndex - 1);
      return endIndex >= startIndex && targetIndex <= endIndex;
    });
    const hasStatefulPayload = (target.diffs?.length ?? 0) > 0
      || (target.toolCalls?.length ?? 0) > 0
      || Boolean(target.runId)
      || (target.runEvents?.length ?? 0) > 0
      || (target.artifacts?.length ?? 0) > 0
      || Boolean(target.rollbackSnapshotId)
      || Boolean(target.workflowRunId)
      || target.role === 'tool'
      || belongsToBoundary;
    if (targetIndex !== targetConversation.messages.length - 1 || hasStatefulPayload) {
      dispatch(addNotification({
        type: 'warning',
        title: '不能安全地单独删除这条消息',
        message: '这条消息位于历史中段，或关联了工具、文件变更、任务边界。请使用「回溯」按完整对话轮恢复，避免 Record 与文件状态脱节。',
        duration: 0,
      }));
      return;
    }
    const remaining = targetConversation.messages.filter((message: any) => message.id !== msgId);
    if (!beginHistoryMutation('删除消息')) return;
    void (async () => {
      if (!await ensureHistoryMutationReady(targetConversationId, '删除消息')) return;
      await bpcScheduler.discardCurrent(targetConversationId, '删除历史消息前使未发布 BPC 候选失效');
      if (!await ensureHistoryMutationReady(targetConversationId, '删除消息')) return;
      await invalidateRecordForTruncation(targetConversationId, remaining);
      await invalidateRequestLedgerForHistoryMutation(targetConversationId);
      gcMessages([target]);
      dispatch(deleteMessage({ id: msgId, conversationId: targetConversationId }));
      await refreshProjectedTokenCount(targetConversationId, { allowApiOverride: true });
    })().catch((err: any) => {
      dispatch(addNotification({ type: 'error', title: '删除消息失败', message: err?.message || String(err) }));
    }).finally(() => {
      endHistoryMutation('删除消息');
    });
  }, [dispatch, ensureHistoryMutationReady, gcMessages, invalidateRecordForTruncation, invalidateRequestLedgerForHistoryMutation, refreshProjectedTokenCount, isHistoryMutationBlocked, beginHistoryMutation, endHistoryMutation]);

  // ★ Plan_5 M5-3 回溯（规范 §3，2026-06-17 修订口径）：点哪条 user 消息，那条 user 本身回填输入框待发，
  //   它【及之后】全部回溯掉（= 回到该 user 所在轮之前 / 上一整轮结束）。record 砍掉该轮起所有批，
  //   GC 时排除这条 user（其附件随草稿转移、不删）。与重试的区别：回溯把该 user 移入输入框（可改后再发），
  //   重试保留该 user 并自动重发。用 'undo' 截断模式（= branch-user 的截断口径，但原地裁剪当前对话）。
  const handleUndoToMessage = useCallback((msgId: string) => {
    if (isHistoryMutationBlocked()) return;
    const targetConversation = conversationRef.current;
    const targetConversationId = targetConversation.id || AUTOSAVE_ID;
    const targetFileSnapshots = targetConversation.fileSnapshots;
    const msgs = targetConversation.messages;  // ★ 性能 3-A1：读 ref 稳定回调引用
    // ★ B3（反馈#5）：底部按钮可挂 AI/tool 消息——映射到所在轮的 user 消息，回溯=回到这条所在轮之前。
    const anchorId = resolveRoundUserAnchor(msgs, msgId);
    if (!beginHistoryMutation('回溯')) return;
    void (async () => {
      // ① 共享 helper 按轮截断（undo 模式：点 user → 保留到该 user 所在轮之前、该轮起全部丢弃，绝不轮中间切）。
      const cut: RoundTruncationResult = computeRoundTruncation(msgs, anchorId, 'undo');
      if (!cut.ok) return;

      // ② 被截掉范围内的文件变更按快照回退（与旧逻辑一致，但范围改为「轮取整后的 removedMessages」）。
      const diffsToRollback = cut.removedMessages
        .flatMap((msg: any) => msg.diffs ?? [])
        .filter((diff: any) => diff.status !== 'rejected')
        .reverse();

      const hasPending = !!cut.pendingUserMessage;
      const tail = hasPending ? '这条消息会回填到输入框（可改后再发）。' : '这条及之后的内容会被移除。';
      const prompt = diffsToRollback.length > 0
        ? `回溯到这条消息之前？它及之后的内容会移除，${diffsToRollback.length} 个关联文件变更会按快照回退；${tail}`
        : `回溯到这条消息之前？${tail}`;
      if (!await confirmAction({
        title: '回溯到这条消息之前？',
        message: prompt,
        confirmLabel: '确认回溯',
        tone: 'danger',
      })) return;

      if (!await ensureHistoryMutationReady(targetConversationId, '回溯')) return;
      await bpcScheduler.discardCurrent(targetConversationId, '回溯历史轮次前使未发布 BPC 候选失效');
      if (!await ensureHistoryMutationReady(targetConversationId, '回溯')) return;
      let rollbackTransaction: FileRollbackTransaction;
      try {
        rollbackTransaction = await rollbackFileDiffsAtomically(diffsToRollback.map((diff: any) => ({
          diff,
          snapshot: diff.snapshotId ? targetFileSnapshots[diff.snapshotId] : undefined,
        })));
      } catch (err: any) {
        dispatch(addNotification({ type: 'error', title: '回溯失败', message: err?.message || '文件恢复失败' }));
        return;
      }

      // ③ record 砍批到轮边界（keptRounds = 真轮数 N，keptSteps 不含 tool；共享 helper 与 clampToBatch 同口径）。
      try {
        const clampedRecord = await clampRecordToRoundTruncation(targetConversationId, cut);
        await bpcScheduler.reconcileAfterHistoryMutation(targetConversationId, clampedRecord);
        await invalidateRequestLedgerForHistoryMutation(targetConversationId);
      } catch (error: any) {
        let compensationMessage = '';
        try {
          await rollbackTransaction.compensate();
        } catch (compensationError: any) {
          compensationMessage = `；${compensationError?.message || '文件补偿失败，请手动核对'}`;
        }
        dispatch(addNotification({
          type: 'error',
          title: '回溯压缩状态协调失败',
          message: `${error?.message || 'Record 裁剪失败'}，历史消息未截断，文件已恢复到操作前状态${compensationMessage}`,
          duration: 0,
        }));
        return;
      }
      for (const diff of diffsToRollback) {
        dispatch(updateDiffStatus({ diffId: diff.id, status: 'rejected', conversationId: targetConversationId }));
      }

      // ④ GC 被移除消息的附件——但【排除第 N+1 轮那条 user】（它的内容/附件要回填输入框待发，
      //   其持有的那 1 份附件引用「转移」给 pending 草稿，故绝不在这里 release，见 refillInputFromUserMessage）。
      const pendingId = cut.pendingUserMessage?.id;
      const removedForGc = pendingId
        ? cut.removedMessages.filter((m: any) => m.id !== pendingId)
        : cut.removedMessages;
      gcMessages(removedForGc);

      // ⑤ UI+本地回到「该 user 所在轮之前」：截到保留范围最后一条消息（含）。
      //   回溯第 1 轮 user（lastKeptIndex<0、无任何消息保留）→ 清空全部消息，该 user 随后移入输入框。
      if (cut.lastKeptMessageId) dispatch(truncateAt({ id: cut.lastKeptMessageId, conversationId: targetConversationId }));
      else dispatch(clearMessages({ conversationId: targetConversationId }));
      await refreshProjectedTokenCount(targetConversationId, { allowApiOverride: true });

      // ⑥ 把点击的那条 user 回填输入框待发（含其 pending 附件）。
      //   anchor 非 user（回溯入口只挂 user，此为兜底）时无 pendingUserMessage → 不动输入框，避免误清草稿。
      const activeConversationId = selectActiveConversation(store.getState()).id || AUTOSAVE_ID;
      if (cut.pendingUserMessage && activeConversationId === targetConversationId) {
        refillInputFromUserMessage(cut.pendingUserMessage as any);
      }
    })().catch((err: any) => {
      dispatch(addNotification({ type: 'error', title: '回溯失败', message: err?.message || String(err) }));
    }).finally(() => {
      endHistoryMutation('回溯');
    });
  }, [dispatch, ensureHistoryMutationReady, gcMessages, refillInputFromUserMessage, invalidateRequestLedgerForHistoryMutation, refreshProjectedTokenCount, isHistoryMutationBlocked, beginHistoryMutation, endHistoryMutation]);

  // M2-3 对话分支：在某条消息处「从此分支」→ 把该消息及之前另存为【新对话】，源对话原样保留。
  // 源若仍是 autosave（未落真实 id），先 save 一次 fork 成真实 id 作为稳定 parent，并把当前 store 切到该真实 id，
  // 再从真实 id 分支——避免 parentId 指向易被清理/复用的 AUTOSAVE_ID。源对话内容/消息不被修改（分支是复制）。
  const handleBranch = useCallback((msgId: string) => {
    if (!beginHistoryMutation('从此分支')) return;
    // ★ M2-6 切换竞态：autosave 源分支会 clearAutosaveSnapshot()+promotion(fork 真实 id)+setConversation，
    //   与切换/新建同构，置闸覆盖整段，挡住旧对话迟到 autosave debounce 复活 AUTOSAVE_ID 草稿。finally 复位。
    beginConversationSwitch();
    void (async () => {
      try {
        const snapshotMessages = conversationRef.current.messages;
        if (!snapshotMessages.length) return;
        // ★ M4-2-S5 分支继承归属：抓一份稳定的源对话工作区归属（null=Global），供 promotion 落库 / 新分支
        //   create / 两处 setConversation 回填复用——新分支与源对话同归属（path 作键）。
        const srcWorkspacePath = conversationRef.current.workspacePath ?? null;
        // ★ task_boundary 分支继承：抓一份稳定的源对话任务边界 + 大标题（与 srcWorkspacePath 同源 conversationRef.current），
        //   边界是对话顶层字段、不在 messages 里，故必须经 branchConversation 的 meta 透传（不能从子集 messages 推）。
        //   branchConversation 内部会按分支点裁剪 + active 收口 + 深拷贝，回带 result.taskBoundaries/taskHeadline 供切入回填。
        const srcTaskBoundaries = conversationRef.current.taskBoundaries;
        const srcTaskHeadline = conversationRef.current.taskHeadline;
        const srcBpcThresholdOverride = conversationRef.current.bpcThresholdOverride;
        const srcCompactThresholdOverride = conversationRef.current.compactThresholdOverride;

        // 1. 确定稳定的源 id：autosave 源先 fork 成真实 id（与「新对话」fork 同款，clearAutosave 不 release，refCount 守恒）。
        //    recordSrcId 记住 record 当前实际所在的 id（promotion 前的 id）——fork 不迁移 record，故 copyRecord 须从这里读。
        const recordSrcId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
        await bpcScheduler.discardCurrent(recordSrcId, 'Fork 只继承分支点之前已发布的压缩历史');
        let srcId = recordSrcId;
        // ★ issue④⑤修复：autosave 源分支时，下面的 clearAutosaveSnapshot() 在 Electron 会经 SQLite FK CASCADE
        //   级联删掉 `records WHERE conversation_id='autosave-current'`。之后 branchConversation 再去现读 record
        //   就读到 null（新分支零 record 继承），而 Web 模式 record 存独立分键不级联 → 继承正常 → 双模式分叉。
        //   故在级联删除【之前】先把源 record 抓成内存快照，传给 branchConversation 从内存继承，两端一致。
        //   （真实对话分支不走 clearAutosaveSnapshot，无此问题，故仅 autosave 分支需要快照；undefined 时
        //    branchConversation 回退按 recordSrcId 现读。）
        let recordSnapshot: Awaited<ReturnType<typeof getRecord>> | undefined;
        let generationSnapshot: Awaited<ReturnType<typeof getContextGenerationState>> | undefined;
        const wasAutosave = !conversationRef.current.id || conversationRef.current.id === AUTOSAVE_ID;
        if (wasAutosave) {
          // 在 clearAutosaveSnapshot 触发 FK CASCADE 之前抓取源 record 与 generation 内存快照。
          // generation 是压缩水位、冷却、熔断和 hard-pause 的正式状态，不能因释放 message.id 主键而丢失。
          recordSnapshot = await getRecord(recordSrcId).catch(() => null);
          generationSnapshot = await getContextGenerationState(recordSrcId).catch(() => null);
          // ★ M2-3 主键修复（核心）：messages.id 是全局 UNIQUE 主键。promotion 把当前 autosave 草稿
          //   提升为真实源对话——saveConversationSnapshot(id=AUTOSAVE_ID) 会 createConversationId() 落到【新真实 id】，
          //   并 replaceMessages(新id, 带原 message.id 的消息)。此时若 `autosave-current` 行仍占着同一批 message.id，
          //   INSERT 会撞 `UNIQUE constraint failed: messages.id`、promotion 当场炸（走不到 branchConversation）。
          //   修法：先 clearAutosaveSnapshot 删掉 autosave 行（释放这批 message.id）再 save——与「新建对话 fork
          //   先清后写」严格同构。这样 promotion 全程【保持原 message.id 不变】，落库的 assistantRuns / runEvents
          //   里按 message.id 的反向指针（AssistantRun.messageId / AssistantRunEvent.messageId）零破坏，源对话运行态完整。
          //   安全：消息体已抓进局部 snapshotMessages（不依赖 DB autosave 行），先删 autosave 行不影响 save。
          await clearAutosaveSnapshot({ preserveLocalMirror: true });
          const saved = await saveConversationSnapshot({
            id: conversationRef.current.id,
            title: conversationRef.current.title,
            messages: snapshotMessages,
            model: conversationRef.current.model || agentMetaRef.current.model,
            // M2-6：promotion（autosave 源提升为真实对话）随对话落当前 mode / reasoningEffort。
            mode: agentMetaRef.current.mode,
            reasoningEffort: agentMetaRef.current.reasoningEffort,
            assistantRuns: conversationRef.current.assistantRuns,
            fileSnapshots: conversationRef.current.fileSnapshots,
            pendingDiffs: conversationRef.current.pendingDiffs,
            // ★ M4-2-S5：promotion（autosave 源提升为真实对话）随对话落工作区归属，使源对话保留其归属，
            //   下方 branchConversation 也据此继承。
            workspacePath: srcWorkspacePath,
            // ★ review HIGH 修复：promotion 此前漏传 goal/taskBoundaries/taskHeadline → 提升出的源对话落库这些列为 NULL，
            //   日后从历史切回源对话时目标与任务边界永久丢失。与其它三个 save 入口口径对齐补全。
            goal: conversationRef.current.goal,
            bpcThresholdOverride: srcBpcThresholdOverride,
            compactThresholdOverride: srcCompactThresholdOverride,
            taskBoundaries: srcTaskBoundaries,
            taskHeadline: srcTaskHeadline,
            timestamp: Date.now(),
          });
          // 前置条件：autosave 源必须先 promotion 成稳定真实 id 才能作为 parent。
          // 若落库失败（saved 为 null）或仍是 AUTOSAVE_ID（理论不会，防御），则【中止分支】——
          // 绝不带着 AUTOSAVE_ID/null 作 parentId 继续 branchConversation（那会让溯源指针悬空/指向会被复用的 id）。
          if (!saved?.id || saved.id === AUTOSAVE_ID) {
            dispatch(addNotification({
              type: 'warning',
              title: '暂时无法分支',
              message: '请先发送至少一条消息（让对话落库）再从此分支',
            }));
            return;
          }
          let restoredRecordRevision: number | null = null;
          if (recordSnapshot) {
            const restoredRecord = await upsertRecord({
              conversationId: saved.id,
              batches: recordSnapshot.batches,
              schemaVersion: recordSnapshot.schemaVersion,
            });
            if (!restoredRecord) throw new Error('Record restoration failed during autosave promotion');
            restoredRecordRevision = restoredRecord.revision;
          }
          await migrateForkedConversation(recordSrcId, saved.id, generationSnapshot, restoredRecordRevision);
          // 真实源、Record 与 generation 均已落库后才移除 localStorage 恢复镜像。
          // 若进程在此前退出，下一次启动仍可从镜像恢复 autosave，不会出现 clear-before-save 数据丢失。
          await clearAutosaveSnapshot();
          srcId = saved.id;
          dispatch(updateConversation(saved));
          // 把当前 store 身份切到真实源 id（消息不变）。autosave 镜像已在 save 前 clearAutosaveSnapshot
          // 清掉（为释放 message.id 主键占用，见上），此处无需再清。
          dispatch(setConversation({
            id: srcId,
            title: conversationRef.current.title,
            messages: snapshotMessages,
            model: conversationRef.current.model || agentMetaRef.current.model,
            assistantRuns: conversationRef.current.assistantRuns,
            fileSnapshots: conversationRef.current.fileSnapshots,
            pendingDiffs: conversationRef.current.pendingDiffs,
            // ★ M4-2-S5：promotion 切到真实源 id 时保持源对话工作区归属（身份变化的 setConversation 须显式带）。
            workspacePath: srcWorkspacePath,
            // ★ review HIGH 修复：身份变化的 setConversation 须显式带 goal/taskBoundaries/taskHeadline，否则切到真实 id 时 store 丢边界。
            goal: conversationRef.current.goal,
            bpcThresholdOverride: srcBpcThresholdOverride,
            compactThresholdOverride: srcCompactThresholdOverride,
            taskBoundaries: srcTaskBoundaries,
            taskHeadline: srcTaskHeadline,
          }));
          dispatch(setSelectedId(srcId));
        }

        // 2. 分支：复制子集到新对话 + copyRecord 继承 + 附件 addRef（源对话不动）。
        //    parent = 稳定 srcId；record 优先用 autosave 级联删除前抓的内存快照（issue④⑤），
        //    否则（真实对话分支，未抓快照）回退按 recordSrcId 现读。
        const result = await branchConversation(srcId, msgId, snapshotMessages, {
          title: conversationRef.current.title,
          model: conversationRef.current.model || agentMetaRef.current.model,
          // M2-6：把当前 mode / reasoningEffort 传入，新分支 DB 行一开始即继承源设置（切回不退回默认）。
          mode: agentMetaRef.current.mode,
          reasoningEffort: agentMetaRef.current.reasoningEffort,
          // ★ M4-2-S5：新分支 DB 行一开始即继承源对话工作区归属（path 作键，缺省 null=Global）。
          workspacePath: srcWorkspacePath,
          bpcThresholdOverride: srcBpcThresholdOverride,
          compactThresholdOverride: srcCompactThresholdOverride,
          // ★ task_boundary：把源对话边界 + 大标题经 meta 透传（与 workspacePath 同源 srcXxx），
          //   branchConversation 内据此裁剪 + 收口 + 深拷贝后落新分支 DB 行并回带。
          taskBoundaries: srcTaskBoundaries,
          taskHeadline: srcTaskHeadline,
          recordSrcId,
          ...(wasAutosave ? { recordSnapshot } : {}),
        });
        if (!result) {
          dispatch(addNotification({ type: 'error', title: '分支失败', message: '无法从此消息分支为新对话' }));
          return;
        }

        // 3. 历史列表加入新对话条目 + 切换到新对话。
        dispatch(updateConversation(result.summary));
        dispatch(setConversation({
          id: result.newId,
          title: result.title,
          messages: result.messages,
          model: result.model,
          // M2-3：切到新分支时回填溯源（DB 已由 branchConversation 写入 parentId/branchedFromMessageId）。
          parentId: result.parentId,
          branchedFromMessageId: result.branchedFromMessageId,
          // ★ M4-2-S5：切到新分支时回填工作区归属（继承源对话，DB 已由 branchConversation 写入 workspace_path）。
          workspacePath: srcWorkspacePath,
          bpcThresholdOverride: srcBpcThresholdOverride,
          compactThresholdOverride: srcCompactThresholdOverride,
          // ★ task_boundary：切到新分支时回填任务边界 + 大标题（用 branchConversation 回带的裁剪 + 收口后值，
          //   与 parentId 从 result 回填同口径，DB 已由 branchConversation 一并写入 JSON 列）。
          taskBoundaries: result.taskBoundaries,
          taskHeadline: result.taskHeadline,
        }));
        // M2-6：分支继承源对话当前的 mode / reasoningEffort（全局 agentSettings 此刻即源设置，无需改动）。
        //   新分支落库时 branchConversation 未带 mode/reasoningEffort → DB 取默认；下次该分支被保存
        //   （saveCurrentToHistory / autosave）即写入其当时设置，与切换恢复闭环一致。
        dispatch(setSelectedId(result.newId));

        // ★ Plan_5 M5-5：分支点是 user 时，那条 user【不进新对话子集】，改回填新对话输入框待发（与回溯对齐）。
        //   refCount 守恒（与回溯不同！）：分支是【复制】、源对话原 user 消息仍在并持有其 sha → 新对话这份草稿
        //   是【新增引用】，必须 addRef（不像回溯是源消息被移除、引用转移给 pending 故不 addRef）。
        //   先对该 user 的 sha addRef（+1）再回填草稿，与发送转消息引用 / removePending 时 release 守恒。
        const pendingAddRefFailedShas: string[] = [];
        if (result.pendingUserMessage) {
          const pu = result.pendingUserMessage;
          const shasToHold = (pu.attachments ?? [])
            .map(a => a.sha256)
            .filter((s): s is string => !!s);
          for (const sha of shasToHold) {
            try {
              const added = await platform.attachment.addRef(sha);
              if ('error' in added && added.error) pendingAddRefFailedShas.push(sha);
            } catch {
              pendingAddRefFailedShas.push(sha);
            }
          }
          const failed = new Set(pendingAddRefFailedShas);
          refillInputFromUserMessage({
            ...pu,
            attachments: (pu.attachments ?? []).filter(attachment => !attachment.sha256 || !failed.has(attachment.sha256)),
          } as any);
        }

        // 附件 addRef 守恒检查：若有 sha 重试后仍未 +1，新分支这些图在源对话删除后可能被误删，提示用户。
        const attachmentRefFailures = new Set([...result.addRefFailedShas, ...pendingAddRefFailedShas]);
        if (attachmentRefFailures.size > 0) {
          dispatch(addNotification({
            type: 'warning',
            title: '已分支（附件未完整保留）',
            message: `${attachmentRefFailures.size} 个图片附件引用未对齐，失败附件没有进入新分支草稿；建议保留源对话或重新分支`,
          }));
        } else {
          dispatch(addNotification({ type: 'success', title: '已分支', message: '已分支为新对话（源对话保留不变）' }));
        }
      } catch (err: any) {
        dispatch(addNotification({ type: 'error', title: '分支失败', message: err?.message || '从此分支时出错' }));
      } finally {
        endConversationSwitch();
        endHistoryMutation('从此分支');
      }
    })();
  }, [dispatch, refillInputFromUserMessage, beginHistoryMutation, endHistoryMutation]);

  const openReviewChanges = useCallback(() => {
    dispatch(openTab({
      id: 'review-changes',
      filePath: 'review://changes',
      fileName: 'Review Changes',
      isDirty: false,
      isPreview: false,
      type: 'review',
    }));
  }, [dispatch]);

  const openDiffTarget = useCallback((diff: { path: string; id?: string }) => {
    const fileName = diff.path.split(/[\\/]/).pop() || diff.path;
    // ★ 反馈#2：点 review 文件——若该文件仍有【未处理（pending/mixed）】的 diff，打开行内红绿 diff 视图
    //   （SingleDiffView，按 diffId 定位），让用户看到红绿改动 + 文件/块/段级 accept/reject；
    //   否则（已全部 accept/reject、或本就无 diff 记录）按扩展名打开普通文件查看器，正常显示最终内容。
    //   优先用传入的 diff.id 精确匹配（review 框/消息 chip 都带 id）；缺省时退化为按 path 找该文件未处理的 diff。
    const pending = (conversationRef.current.pendingDiffs as FileDiffSummary[]) ?? [];
    const target = diff.id
      ? pending.find(d => d.id === diff.id)
      : pending.find(d => d.path === diff.path && (d.status === 'pending' || d.status === 'mixed'));
    if (target && (target.status === 'pending' || target.status === 'mixed')) {
      dispatch(openTab({
        id: `diff:${target.id}`,
        // ★ 用 diff:// 协议路径做稳定去重键，既不与普通文件 tab 撞 filePath（同文件可同时有普通 tab 与 diff tab），
        //   又能在重复点同一文件时复用同一个 diffview tab。
        filePath: `diff://${target.id}`,
        fileName,
        isDirty: false,
        isPreview: false,
        type: 'diffview',
        diffId: target.id,
      }));
      return;
    }
    dispatch(openTab({
      id: `tab-${Date.now()}`,
      filePath: diff.path,
      fileName,
      isDirty: false,
      isPreview: true,
      // ★ 五轮修复：按扩展名选 viewer（md→markdown 预览/源码/分屏, html→html 等），不再硬编码 'code' 丢失预览/对比模式。
      type: resolveEditorType(fileName),
    }));
  }, [dispatch]);

  // ★ show_artifact：点产物卡片 → 在中部编辑器打开该文件，按扩展名选 viewer（md/html 等带预览/对比/分屏）。
  const openArtifactTarget = useCallback((artifact: { path: string }) => {
    const fileName = artifact.path.split(/[\\/]/).pop() || artifact.path;
    dispatch(openTab({
      id: `tab-${Date.now()}`,
      filePath: artifact.path,
      fileName,
      isDirty: false,
      isPreview: true,
      type: resolveEditorType(fileName),
    }));
  }, [dispatch]);

  // ★ task_boundary 卡片「已编辑文件」chip 点击 → 在编辑器打开（artifact/diff 同 path 口径，复用上面两个 opener）。
  const handleOpenBoundaryFile = useCallback((f: BoundaryFile) => {
    if (f.kind === 'artifact') openArtifactTarget({ path: f.path });
    else openDiffTarget({ path: f.path });
  }, [openArtifactTarget, openDiffTarget]);

  // ★ C6/去重：handleEditorKeyDown 移入 useAtMention hook（onSubmit=handleSend 经 handleSendRef 破环）。
  //   handleSend 已定义，回填 handleSendRef 供 hook 的提交回调调用最新实现。
  handleSendRef.current = handleSend;

  const hasMessages = messages.length > 0;

  // Token counter
  // ★ M6 验收 bug7：本地计数 gpt 系用分词器精确、其它字符估算（exact 标志）。
  // ★ M7 性能 B：流式期不重算——messages 引用每帧变会对整段对话全量 encode（与 StatusBar 各一遍，单次几十毫秒阻塞）。
  //   isStreaming 时返回上次缓存值（有 API 实测 apiTokenCount 时本就优先用实测），停流后重算一次。
  const lastLocalTokenRef = useRef<{ count: number; exact: boolean }>({ count: 0, exact: true });
  const localToken = useMemo(() => {
    if (isStreaming) return lastLocalTokenRef.current;
    if (!messages.length) { lastLocalTokenRef.current = { count: 0, exact: true }; return lastLocalTokenRef.current; }
    const v = countConversationTokensExact(messages.map((m: any) => ({ role: m.role, content: m.content })), model);
    lastLocalTokenRef.current = v;
    return v;
  }, [messages, model, isStreaming]);
  const hasTrackedToken = tokenCountSource !== 'none';
  const tokenCount = hasTrackedToken ? trackedTokenCount : localToken.count;
  const tokenExact = tokenCountSource === 'api' || (tokenCountSource === 'none' && localToken.exact);
  // M4-1-S3：统一走 selector 纯函数版（fallback 链 capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS）
  const effectiveContextWindow = getModelContextWindowForOption(currentModelOption, agentSettings.contextWindowOverrides?.[model]);
  const tokenRatio = effectiveContextWindow > 0 ? tokenCount / effectiveContextWindow : 0;
  const capabilitySummaryLabel = `${currentCatalogStale
    ? '当前模型目录来自缓存，上游刷新失败；能力可能已经变化'
    : hasContextOverride && declaredContextWindow
      ? `模型声明 ${formatContextCapability(declaredContextWindow)}，当前手动覆盖 ${formatContextCapability(configuredContextOverride)}`
      : '当前模型能力与参数'}：${capabilityLabels.join(' · ')}`;
  // ★ M5-BPC-6：token 显示统一收敛进 CompressionRing（footer/context/StatusBar），原 formatTokens 局部函数随之移除。

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter((m: any) =>
      m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q),
    );
  }, [availableModels, modelSearch]);
  const filteredModelGroups = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const option of filteredModels) {
      const providerId = providerIdForModel(option);
      const providerModels = groups.get(providerId) ?? [];
      providerModels.push(option);
      groups.set(providerId, providerModels);
    }
    const labels: Record<string, string> = {
      'openai-codex': 'ChatGPT OAuth',
      windsurf: 'Windsurf / Devin',
      openai: 'OpenAI-compatible API',
    };
    const order = [currentProviderModel.providerId, 'openai-codex', 'windsurf', 'openai'];
    return Array.from(groups.entries())
      .sort(([left], [right]) => {
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        if (leftIndex !== rightIndex) return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
        return left.localeCompare(right);
      })
      .map(([providerId, models]) => ({
        providerId,
        label: labels[providerId] || providerId,
        models,
        unknownOnly: models.every(option => option.capabilities?.source === 'unknown'),
      }));
  }, [currentProviderModel.providerId, filteredModels]);
  const filteredModelOptions = useMemo(
    () => filteredModelGroups.flatMap(group => group.models),
    [filteredModelGroups],
  );
  const filteredModelIndexById = useMemo(
    () => new Map(filteredModelOptions.map((option, index) => [option.id, index])),
    [filteredModelOptions],
  );

  useEffect(() => {
    if (!modelMenuOpen) return;
    const currentIndex = filteredModelOptions.findIndex(option => option.id === model);
    setModelActiveIndex(currentIndex >= 0 ? currentIndex : 0);
    modelOptionRefs.current.length = filteredModelOptions.length;
  }, [filteredModelOptions, model, modelMenuOpen]);

  const handleSelectModel = useCallback((nextModel: string) => {
    if (isStreaming || agentLoopRef.current?.isRunning) {
      setModelMenuOpen(false);
      dispatch(addNotification({
        type: 'info',
        title: '当前轮仍在运行',
        message: '请先停止或等待当前轮完成，再切换模型，避免界面与真实请求不一致。',
        duration: 3000,
      }));
      return;
    }
    if (nextModel === model) {
      setModelMenuOpen(false);
      setModelSearch('');
      return;
    }
    const targetConversationId = conversationRef.current.id || AUTOSAVE_ID;
    dispatch(setCurrentModel(nextModel));
    dispatch(setConversationModel({ model: nextModel, conversationId: targetConversationId }));
    void refreshProjectedTokenCount(targetConversationId).catch(error => {
      console.warn('[AgentPanel] 切换模型后重算请求投影失败:', error);
    });
    setModelMenuOpen(false);
    setModelSearch('');
    dispatch(addNotification({
      type: 'success',
      title: '模型已切换',
      message: nextModel,
      duration: 2000,
    }));
  }, [dispatch, isStreaming, model, refreshProjectedTokenCount]);

  const focusModelOption = useCallback((nextIndex: number) => {
    if (filteredModelOptions.length === 0) return;
    const normalizedIndex = Math.max(0, Math.min(nextIndex, filteredModelOptions.length - 1));
    setModelActiveIndex(normalizedIndex);
    requestAnimationFrame(() => modelOptionRefs.current[normalizedIndex]?.focus());
  }, [filteredModelOptions.length]);

  const handleModelNavigationKey = useCallback((event: React.KeyboardEvent, currentIndex: number) => {
    if (filteredModelOptions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusModelOption(currentIndex >= filteredModelOptions.length - 1 ? 0 : currentIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusModelOption(currentIndex <= 0 ? filteredModelOptions.length - 1 : currentIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusModelOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusModelOption(filteredModelOptions.length - 1);
    }
  }, [filteredModelOptions.length, focusModelOption]);

  const handleModelSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (filteredModelOptions.length === 0) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const option = filteredModelOptions[modelActiveIndex] ?? filteredModelOptions[0];
      if (option) handleSelectModel(option.id);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusModelOption(modelActiveIndex);
      return;
    }
    handleModelNavigationKey(event, modelActiveIndex);
  }, [filteredModelOptions, focusModelOption, handleModelNavigationKey, handleSelectModel, modelActiveIndex]);

  const addPendingFiles = useCallback(async (files: File[], kind: 'file' | 'image') => {
    const nextAttachments: AttachmentRef[] = [];
    for (const file of files) {
      const id = generateAttachmentId();
      const fileKind = kind === 'image' ? 'image' : getAttachmentKind(file);
      const path = (file as any).path || (file as any).webkitRelativePath || file.name;
      const base: AttachmentRef = {
        id,
        name: file.name,
        path,
        mimeType: file.type || undefined,
        size: file.size,
        kind: fileKind,
        status: 'ready',
      };
      if (fileKind === 'image') {
        if (file.size > MAX_IMAGE_PAYLOAD_BYTES) {
          nextAttachments.push({
            ...base,
            status: 'error',
            error: `图片超过 ${formatBytes(MAX_IMAGE_PAYLOAD_BYTES)}，暂不发送`,
          });
          continue;
        }
        try {
          // M2-R6 上传分离：读出 dataUrl 后立即 platform.attachment.put 抽离成 sha256 内容寻址实体。
          // dataUrl 仅留作内存态即时预览(previewUrl)，落库/发送只认 sha256（payloadUrl 不再内联 base64）。
          const dataUrl = await readAsDataUrl(file);
          const ref = await platform.attachment.put({
            data: dataUrl,
            mime: file.type || undefined,
            name: file.name,
            kind: 'image',
          });
          if ('error' in ref) {
            nextAttachments.push({ ...base, status: 'error', error: ref.message || '附件存储失败' });
          } else {
            nextAttachments.push({
              ...base,
              sha256: ref.sha256,
              size: ref.size || file.size,
              mimeType: ref.mime || base.mimeType,
              previewUrl: dataUrl, // 内存态即时预览；落库前 sanitize 清掉
            });
          }
        } catch (err: any) {
          nextAttachments.push({
            ...base,
            status: 'error',
            error: err?.message || '图片读取失败',
          });
        }
      } else {
        // M4-3-S3：非图片附件（文档/文本/压缩包/其它）也走 sha256 内容寻址落地，
        // 与图片同一契约——回填 sha256 后 MessageBubble openable 判定为真、handleOpenAttachment
        // 能 platform.attachment.get → objectUrl → 在编辑器 attachment tab 打开，不再恒走降级提示。
        if (file.size > MAX_FILE_PAYLOAD_BYTES) {
          nextAttachments.push({
            ...base,
            status: 'error',
            error: `文件超过 ${formatBytes(MAX_FILE_PAYLOAD_BYTES)}，暂不发送`,
          });
          continue;
        }
        try {
          const dataUrl = await readAsDataUrl(file);
          const ref = await platform.attachment.put({
            data: dataUrl,
            mime: file.type || undefined,
            name: file.name,
            kind: base.kind, // 沿用 getAttachmentKind 推断的 document/text/archive/other 标签
          });
          if ('error' in ref) {
            nextAttachments.push({ ...base, status: 'error', error: ref.message || '附件存储失败' });
          } else {
            nextAttachments.push({
              ...base,
              sha256: ref.sha256,
              size: ref.size || file.size,
              mimeType: ref.mime || base.mimeType,
            });
          }
        } catch (err: any) {
          nextAttachments.push({
            ...base,
            status: 'error',
            error: err?.message || '文件读取失败',
          });
        }
      }
    }

    setPendingAttachments(prev => [...prev, ...nextAttachments]);
    const failed = nextAttachments.filter(att => att.status === 'error').length;
    dispatch(addNotification({
      type: failed ? 'warning' : 'info',
      title: kind === 'image' ? '已加入图片附件' : '已加入文件附件',
      message: failed ? `${nextAttachments.length - failed} 个成功，${failed} 个失败` : nextAttachments.map(att => att.name).join(', '),
      duration: 2500,
    }));
  }, [dispatch]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      // M2-R6 GC（Codex 中风险③修复）：草稿图选中时已 platform.attachment.put（refCount=1），
      // 移除草稿/放弃发送时必须 release，否则留孤儿实体 + 账本行。已发送的图不走这里（发送转为消息引用）。
      const removed = prev.find(att => att.id === id);
      if (removed?.sha256) void platform.attachment.delete(removed.sha256).catch(() => undefined);
      return prev.filter(att => att.id !== id);
    });
    setPreviewAttachment(prev => prev?.id === id ? null : prev);
  }, []);

  // M2-R6 渲染还原：扫描历史消息里「有 sha256 但无内联预览(previewUrl/payloadUrl)」的 image 附件，
  // 按 sha256 懒加载 dataUrl 填进 resolvedPreviews，触发重渲染显示历史图。仅在确有缺口时拉取（带模块级缓存）。
  useEffect(() => {
    let cancelled = false;
    const wanted = new Set<string>();
    for (const msg of messages as any[]) {
      for (const att of (msg.attachments ?? [])) {
        if (att.kind === 'image' && att.sha256 && !att.previewUrl && !att.payloadUrl && !resolvedPreviews.has(att.sha256)) {
          wanted.add(att.sha256);
        }
      }
    }
    if (wanted.size === 0) return;
    void Promise.all([...wanted].map(async sha => {
      const dataUrl = await resolveAttachmentDataUrl(sha);
      return [sha, dataUrl] as const;
    })).then(pairs => {
      if (cancelled) return;
      const hits = pairs.filter((p): p is readonly [string, string] => !!p[1]);
      if (hits.length === 0) return;
      setResolvedPreviews(prev => {
        const next = new Map(prev);
        for (const [sha, url] of hits) next.set(sha, url);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [messages, resolvedPreviews]);

  // 把一条消息的 attachments 注入还原后的 previewUrl（内存预览优先；缺失则用 resolvedPreviews 里 sha256 还原的 dataUrl）。
  const resolveAttachmentsForRender = useCallback((atts: AttachmentRef[] | undefined): AttachmentRef[] | undefined => {
    if (!atts || atts.length === 0) return atts;
    let touched = false;
    const next = atts.map(att => {
      if (att.previewUrl || att.payloadUrl) return att;
      if (att.kind === 'image' && att.sha256) {
        const restored = resolvedPreviews.get(att.sha256);
        if (restored) { touched = true; return { ...att, previewUrl: restored }; }
      }
      return att;
    });
    return touched ? next : atts;
  }, [resolvedPreviews]);

  // ★ M6 验收 bug4 性能：按 msg.attachments 引用缓存还原结果。流式时历史消息的 attachments 引用不变 →
  //   复用缓存（返回稳定引用），让 MessageBubble 的 React.memo 对【有图】历史消息也命中、不陪流式重渲。
  //   resolvedPreviews 变（新图还原完成）时整张 WeakMap 失效重建一次。无图消息 resolveAttachmentsForRender 本就返回原引用。
  const renderAttCache = useMemo(() => new WeakMap<object, AttachmentRef[] | undefined>(), [resolvedPreviews]);
  const getRenderAttachments = useCallback((atts: AttachmentRef[] | undefined): AttachmentRef[] | undefined => {
    if (!atts) return atts;
    if (renderAttCache.has(atts)) return renderAttCache.get(atts);
    const resolved = resolveAttachmentsForRender(atts);
    renderAttCache.set(atts, resolved);
    return resolved;
  }, [renderAttCache, resolveAttachmentsForRender]);
  const renderToolCallCache = useMemo(
    () => new WeakMap<object, any[] | undefined>(),
    [agentSettings.hideSystemToolCalls],
  );
  const getRenderToolCalls = useCallback((toolCalls: any[] | undefined): any[] | undefined => {
    if (!toolCalls) return toolCalls;
    if (renderToolCallCache.has(toolCalls)) return renderToolCallCache.get(toolCalls);
    const visible = filterSystemToolCalls(toolCalls, agentSettings.hideSystemToolCalls ?? true);
    renderToolCallCache.set(toolCalls, visible);
    return visible;
  }, [agentSettings.hideSystemToolCalls, renderToolCallCache]);

  // ★ M4-3-S3：已发附件 → 编辑器 attachment tab 的 objectUrl 生命周期管理。
  //   tabId → objectUrl。tab 关闭后该 objectUrl 不再被任何 tab 引用，需 revoke 防内存泄漏。
  const attachmentObjectUrls = useRef<Map<string, string>>(new Map());
  // tab 列表变化时，revoke 已不存在 tab 对应的 objectUrl（参考 fileSystem.memoryFileUrls revoke 模式）。
  useEffect(() => {
    const liveIds = new Set(editorTabs.map((t: { id: string }) => t.id));
    for (const [tabId, url] of attachmentObjectUrls.current) {
      if (!liveIds.has(tabId)) {
        URL.revokeObjectURL(url);
        attachmentObjectUrls.current.delete(tabId);
      }
    }
  }, [editorTabs]);

  // 组件卸载时兜底 revoke 全部 objectUrl。
  useEffect(() => {
    const map = attachmentObjectUrls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  // ★ M4-3-S3：点击已发附件——图片走预览模态、文档/其它走编辑器 attachment tab。
  const handleOpenAttachment = useCallback((att: {
    id: string; name: string; kind: string; mimeType?: string; size?: number;
    previewUrl?: string; payloadUrl?: string; sha256?: string;
  }) => {
    // 图片：复用 previewAttachment 轻量预览模态（主人决策）。
    if (att.kind === 'image' && att.previewUrl) {
      setPreviewAttachment({
        id: att.id,
        name: att.name,
        kind: 'image',
        mimeType: att.mimeType,
        size: att.size,
        previewUrl: att.previewUrl,
        status: 'sent',
      });
      return;
    }

    // 文档/其它：解析为 objectUrl 后开 attachment tab。
    void (async () => {
      try {
        const tabId = `att:${att.sha256 || att.id}`;
        // 已开同一附件 tab → 直接激活（openTab 按 filePath 去重，但 objectUrl 每次不同，故先查已存在的 tab id）。
        const existing = editorTabs.find((t: { id: string }) => t.id === tabId);
        if (existing) {
          dispatch(setActiveEditorTab(tabId));
          return;
        }

        let objectUrl: string | null = null;
        // 内存态可用 URL（http/blob/object，非 data:）直接用，不进 Map（非本组件创建，不负责 revoke）。
        const memUrl = att.payloadUrl;
        const isUsableMemUrl = !!memUrl && !memUrl.startsWith('data:');
        if (isUsableMemUrl) {
          objectUrl = memUrl!;
        } else if (att.sha256) {
          // sha256 内容寻址 → dataUrl → blob → objectUrl（创建者负责 revoke）。
          const got = await platform.attachment.get(att.sha256).catch(() => null);
          if (got?.dataUrl) {
            const resp = await fetch(got.dataUrl);
            const blob = await resp.blob();
            objectUrl = URL.createObjectURL(blob);
            attachmentObjectUrls.current.set(tabId, objectUrl);
          }
        }

        if (!objectUrl) {
          dispatch(addNotification({
            type: 'warning',
            title: '附件无法打开',
            message: `${att.name} 缺少可解析的内容，无法在编辑器打开`,
          }));
          return;
        }

        dispatch(openTab({
          id: tabId,
          filePath: objectUrl,
          fileName: att.name,
          isDirty: false,
          isPreview: true,
          type: 'attachment',
          mimeType: att.mimeType,
        }));
      } catch (err: any) {
        dispatch(addNotification({
          type: 'error',
          title: '附件打开失败',
          message: err?.message || att.name,
        }));
      }
    })();
  }, [dispatch, editorTabs]);

  const isAgentRunActive = isStreaming || isLoopRunning;
  const toggleModelMenu = () => {
    if (isAgentRunActive) {
      dispatch(addNotification({
        type: 'info',
        title: '当前轮仍在运行',
        message: '模型切换会在当前轮结束后开放。',
        duration: 2500,
      }));
      return;
    }
    setModelMenuOpen(open => !open);
  };

  return (
    <div className="agent-panel glass-panel">
      <ApprovalDialog request={approvalReq} onApprove={handleApprovalApprove} onReject={handleApprovalReject} />
      <div className="agent-header">
        <div className="agent-tabs">
          <button className={`agent-tab ${activeAgentTab === 'chat' ? 'active' : ''}`} onClick={() => selectAgentTab('chat')}>💬 Chat</button>
          <button className={`agent-tab ${activeAgentTab === 'plan' ? 'active' : ''}`} onClick={() => selectAgentTab('plan')}>📋 Plan</button>
          <button className={`agent-tab ${activeAgentTab === 'context' ? 'active' : ''}`} onClick={() => selectAgentTab('context')}>📖 Context</button>
          <button
            className="mode-btn"
            onClick={() => { void handleNewConversation(); }}
            title="新建对话"
            style={{ marginLeft: 'auto' }}
            disabled={isAgentRunActive}
          >
            <Plus size={14} />
          </button>
          {messages.length > 0 && (
            <button
              className="mode-btn"
              onClick={() => {
                conversationExporter.export(
                  messages.map((m: any) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
                  'markdown'
                );
                dispatch(addNotification({ type: 'success', title: '导出成功', message: '对话已导出为 Markdown' }));
              }}
              title="导出对话"
            >
              <Download size={14} />
            </button>
          )}
          <button
            className="mode-btn agent-collapse-btn"
            type="button"
            onClick={() => dispatch(toggleAgentPanel())}
            title="收起 AI 面板"
            aria-label="收起 AI 面板"
          >
            <PanelRightClose size={14} />
          </button>
        </div>
        <div className="agent-mode-switch">
          <button
            className={`mode-btn ${mode === 'fast' ? 'active' : ''}`}
            onClick={() => dispatch(setMode('fast'))}
            disabled={isAgentRunActive}
          >
            <Zap size={14} /><span>Fast</span>
          </button>
          <button
            className={`mode-btn ${mode === 'planning' ? 'active' : ''}`}
            onClick={() => dispatch(setMode('planning'))}
            disabled={isAgentRunActive}
          >
            <Sparkles size={14} /><span>Plan</span>
          </button>
        </div>
      </div>

      {/* ★ M4-2-S7 紧凑对话切换器（独立窄行，不挤压顶栏三按钮）：当前对话标题 + 下拉 → 打开 portal 管理浮层。 */}
      <div className="agent-conv-switch">
        <button
          ref={convAnchorRef}
          className={`agent-conv-trigger ${convMenuOpen ? 'active' : ''}`}
          onClick={() => (convMenuOpen ? setConvMenuOpen(false) : openConvMenu())}
          title="切换 / 管理对话"
        >
          <MessageSquare size={13} className="agent-conv-trigger-icon" />
          <span className="agent-conv-trigger-title">{conversation.title || '新对话'}</span>
          {conversation.workspacePath && (
            <span className="agent-conv-ws" title={conversation.workspacePath}>
              {workspaceLabel(conversation.workspacePath)}
            </span>
          )}
          <ChevronDown size={13} className="agent-conv-chevron" />
        </button>
        {/* ★ H6：消息导航入口——有带小标题的用户消息时才显示；点击打开导航浮层快速跳转。 */}
        {navItems.length > 0 && (
          <button
            ref={navAnchorRef}
            className={`agent-nav-trigger ${navMenuOpen ? 'active' : ''}`}
            onClick={() => (navMenuOpen ? setNavMenuOpen(false) : openNavMenu())}
            title="消息导航 · 快速跳转"
          >
            <List size={13} />
            <span className="agent-nav-trigger-count">{navItems.length}</span>
          </button>
        )}
      </div>

      {/* ★ H6 消息导航浮层（portal 到 body；点外/Esc 关闭；点项跳转 + 高亮；标题可双击改写）。 */}
      {navMenuOpen && navMenuPos && createPortal(
        <div
          ref={navPanelRef}
          className="agent-nav-panel glass-panel"
          style={{ position: 'fixed', top: navMenuPos.top, left: navMenuPos.left, width: navMenuPos.width }}
        >
          <div className="agent-nav-head">
            <List size={13} />
            <span>消息导航</span>
            <span className="agent-nav-head-count">{navItems.length}</span>
          </div>
          <div className="agent-nav-list">
            {navItems.length === 0 ? (
              <div className="agent-nav-empty">暂无带标题的消息</div>
            ) : (
              // ★ #12b：穿插压缩点分隔行——在跨越某压缩点下标的导航项前插「— 压缩点 —」，
              //   让用户从导航就能看到哪段历史被压缩。压缩点下标的「消费」用游标 cp 顺序推进。
              (() => {
                const rows: ReactNode[] = [];
                let cp = 0; // navCompactPoints 游标
                let prevIdx = -1; // 上一导航项的消息下标
                const renderCompactRow = (key: string, marks: { index: number; source: BatchSource }[]) => {
                  const batchLabel = marks.map(m => `#${m.index + 1}`).join('、');
                  return (
                    <div key={key} className="agent-nav-compact" title="此处历史已压缩为 record 摘要批次（对话仍完整保留原文）">
                      <span className="agent-nav-compact-line" />
                      <Sparkles size={11} className="agent-nav-compact-icon" />
                      <span className="agent-nav-compact-text">压缩点 · record 批次 {batchLabel}</span>
                      <span className="agent-nav-compact-line" />
                    </div>
                  );
                };
                navItems.forEach(item => {
                  // 当前项前可能跨越多个压缩点（落在 (prevIdx, item.idx] 区间内）。
                  while (cp < navCompactPoints.length && navCompactPoints[cp].atIdx <= item.idx) {
                    if (navCompactPoints[cp].atIdx > prevIdx) {
                      rows.push(renderCompactRow(`cp-${navCompactPoints[cp].atIdx}`, navCompactPoints[cp].marks));
                    }
                    cp += 1;
                  }
                  prevIdx = item.idx;
                  rows.push(
                <div key={item.id} className="agent-nav-row">
                  {navEditingId === item.id ? (
                    // 编辑态：输入框 + 确认/取消（Enter 保存、Esc 取消）。
                    <div className="agent-nav-edit">
                      <input
                        autoFocus
                        value={navEditDraft}
                        maxLength={14}
                        onChange={e => setNavEditDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); saveNavSubtitle(item.id, navEditDraft); }
                          else if (e.key === 'Escape') { e.preventDefault(); setNavEditingId(null); }
                        }}
                      />
                      <button className="agent-nav-edit-ok" title="保存" onClick={() => saveNavSubtitle(item.id, navEditDraft)}>
                        <Check size={12} />
                      </button>
                      <button className="agent-nav-edit-cancel" title="取消" onClick={() => setNavEditingId(null)}>
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        className="agent-nav-jump"
                        title={item.subtitle}
                        onClick={() => { scrollToMessage(item.id); setNavMenuOpen(false); }}
                      >
                        <span className="agent-nav-seq">{item.seq}</span>
                        <span className="agent-nav-label">{item.subtitle}</span>
                      </button>
                      <button
                        className="agent-nav-edit-btn"
                        title="改写标题"
                        onClick={() => { setNavEditingId(item.id); setNavEditDraft(item.subtitle); }}
                      >
                        <Pencil size={11} />
                      </button>
                    </>
                  )}
                </div>
                  );
                });
                // 落在最后一个导航项之后的压缩点（压缩发生在末尾消息处）也补一行。
                while (cp < navCompactPoints.length) {
                  if (navCompactPoints[cp].atIdx > prevIdx) {
                    rows.push(renderCompactRow(`cp-${navCompactPoints[cp].atIdx}`, navCompactPoints[cp].marks));
                  }
                  cp += 1;
                }
                return rows;
              })()
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* ★ M4-2-S7 对话管理浮层（portal 到 body，避开 header overflow 裁剪；点外/Esc 关闭）。 */}
      {convMenuOpen && convMenuPos && createPortal(
        <div
          ref={convPanelRef}
          className="agent-conv-panel glass-panel"
          style={{ position: 'fixed', top: convMenuPos.top, left: convMenuPos.left, width: convMenuPos.width }}
        >
          {/* 搜索（本地内存过滤，不污染左侧栏视图） */}
          <div className="agent-conv-search">
            <Search size={13} />
            <input
              autoFocus
              value={convSearch}
              onChange={e => setConvSearch(e.target.value)}
              placeholder="搜索对话..."
            />
          </div>
          {/* 工作区范围三态（与左侧栏同口径） */}
          <div className="agent-conv-scope">
            <button className={convScope === 'current' ? 'active' : ''} onClick={() => setConvScope('current')}>当前</button>
            <button className={convScope === 'global' ? 'active' : ''} onClick={() => setConvScope('global')}>全局</button>
            <button className={convScope === 'all' ? 'active' : ''} onClick={() => setConvScope('all')}>全部</button>
          </div>
          {/* 列表（点选切换，共用 selectedId 高亮） */}
          <div className="agent-conv-list">
            {convFilteredList.length === 0 ? (
              <div className="agent-conv-empty">{convSearch ? '未找到匹配的对话' : '该范围暂无对话'}</div>
            ) : (
              convFilteredList.map(c => (
                <button
                  key={c.id}
                  className={`agent-conv-row ${convSelectedId === c.id ? 'active' : ''}`}
                  onClick={() => void handleSwitchConversationFromMenu(c.id)}
                  title={c.title}
                >
                  <MessageSquare size={12} className="agent-conv-row-icon" />
                  <span className="agent-conv-row-title">{c.title}</span>
                  <span className={`agent-conv-row-ws ${c.workspacePath ? '' : 'global'}`}>
                    {c.workspacePath ? <FolderInput size={9} /> : <Globe size={9} />}
                    {workspaceLabel(c.workspacePath)}
                  </span>
                </button>
              ))
            )}
          </div>
          {/* 底部：新建 + 当前对话改归属 */}
          <div className="agent-conv-footer">
            <button
              className="agent-conv-action"
              onClick={() => { setConvMenuOpen(false); void handleNewConversation(); }}
              disabled={isAgentRunActive}
            >
              <Plus size={13} /> 新建对话
            </button>
            <div className="agent-conv-move">
              <span className="agent-conv-move-label">当前归属</span>
              <button
                className={`agent-conv-move-btn ${!conversation.workspacePath ? 'active' : ''}`}
                onClick={() => void handleMoveCurrentConversation(null)}
                title="改归全局（无归属）"
              >
                <Globe size={11} /> 全局
              </button>
              {agentWorkspacePath && (
                <button
                  className={`agent-conv-move-btn ${conversation.workspacePath === agentWorkspacePath ? 'active' : ''}`}
                  onClick={() => void handleMoveCurrentConversation(agentWorkspacePath)}
                  title={agentWorkspacePath}
                >
                  <FolderInput size={11} /> {workspaceLabel(agentWorkspacePath)}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      <div className="agent-messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {activeAgentTab === 'chat' && (
          <>
            {!hasMessages ? (
              <div className="agent-welcome">
                <div className="agent-welcome-icon">🧠</div>
                <h3>你好，准备从哪里开始？</h3>
                {!hasApiKey && (
                  <p style={{ color: 'var(--syn-accent)', fontSize: 12 }}>
                    ⚠️ 请先在设置 → AI 中配置 API Key
                  </p>
                )}
                {hasApiKey && !hasModel && (
                  <p style={{ color: 'var(--syn-accent)', fontSize: 12 }}>
                    ⚠️ 请先在设置 → AI 中选择模型
                  </p>
                )}
                <p>打开工作区、添加文件，或直接描述任务</p>
                <div className="agent-suggestions">
                  <button className="suggestion-chip" onClick={() => { richRef.current?.setContent(['总结当前工作区的关键内容']); richRef.current?.focus(); setCanSend(true); }}>
                    📖 总结当前工作区
                  </button>
                  <button className="suggestion-chip" onClick={() => { richRef.current?.setContent(['分析这个问题并给出解决步骤']); richRef.current?.focus(); setCanSend(true); }}>
                    🧭 分析问题并规划步骤
                  </button>
                  <button className="suggestion-chip" onClick={() => { richRef.current?.setContent(['检查当前改动并指出潜在风险']); richRef.current?.focus(); setCanSend(true); }}>
                    🔍 检查改动与风险
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* ★ task_boundary「卡片吞消息」渲染（M7 第四轮返工）：按 taskBoundaryRender.startMap 把边界区间内的
                    消息收进 TaskBoundaryCard（一个折叠卡片包住整个任务过程，反重力式），区间外的消息正常平铺。
                    工具结果(role==='tool')只在 assistant 的 ToolCallCard 折叠显示，这里统一过滤、不单独渲染。 */}
                {messageWindowTopSpacerHeight > 0 && (
                  <div
                    className="message-window-spacer message-window-spacer-top"
                    style={{ height: messageWindowTopSpacerHeight }}
                    aria-hidden="true"
                  />
                )}
                {canLoadOlderMessageUnits && (
                  <button type="button" className="message-history-loader" onClick={loadOlderMessageUnits}>
                    加载更早内容 · 还剩 {effectiveVisibleMessageUnitStart} 个任务或消息块
                  </button>
                )}
                {(() => {
                  const { filesByBoundaryId } = taskBoundaryRender;
                  const renderBubble = (msg: any) => (
                    <MessageBubble
                      key={msg.id}
                      id={msg.id}
                      role={msg.role}
                      content={msg.content}
                      timestamp={msg.timestamp}
                      model={(msg as any).model}
                      isStreaming={(msg as any).isStreaming}
                      historyActionsDisabled={Boolean(isStreaming || isLoopRunning || isWorkflowRunningRef.current)}
                      streamState={(msg as any).streamState}
                      streamMode={(msg as any).streamMode}
                      fallbackReason={(msg as any).fallbackReason}
                      showStreamCursor={(msg as any).showStreamCursor}
                      showGeneratingPlaceholder={(msg as any).showGeneratingPlaceholder}
                      durationMs={(msg as any).durationMs}
                      reconnect={(msg as any).reconnect}
                      endToEndMs={(msg as any).endToEndMs}
                      thinking={(msg as any).thinking}
                      attachments={getRenderAttachments((msg as any).attachments)}
                      richTokens={(msg as any).richTokens}
                      toolCalls={getRenderToolCalls((msg as any).toolCalls)}
                      diffs={(msg as any).diffs}
                      artifacts={(msg as any).artifacts}
                      workflowRunId={(msg as any).workflowRunId}
                      onReviewChanges={openReviewChanges}
                      onOpenDiff={openDiffTarget}
                      onOpenArtifact={openArtifactTarget}
                      onOpenAttachment={handleOpenAttachment}
                      onUndoToMessage={handleUndoToMessage}
                      onEdit={handleEdit}
                      onRetry={handleRetry}
                      onDelete={handleDelete}
                      onBranch={handleBranch}
                      onRefreshToolTask={handleRefreshToolTask}
                      onCancelToolTask={handleCancelToolTask}
                    />
                  );
                  const hideSysTools = agentSettings.hideSystemToolCalls ?? true;
                  const out: any[] = [];
                  for (const { unit, index: unitIndex } of visibleMessageRenderUnits) {
                    const r = unit.boundary
                      ? { b: unit.boundary, startIdx: unit.startIdx, endIdx: unit.endIdx }
                      : null;
                    let content: ReactNode = null;
                    if (r) {
                      // 边界区间 → 收进卡片（过滤 tool + 完全无内容的空 assistant 消息后作 children 过程消息）。
                      const rangeMsgs: any[] = [];
                      for (let j = r.startIdx; j <= r.endIdx && j < messages.length; j++) {
                        const m: any = messages[j];
                        if (m.role !== 'tool' && !isEmptyAssistantMessage(m, hideSysTools)) rangeMsgs.push(m);
                      }
                      const startDivider = batchDividerByIdx.get(r.startIdx);
                      content = (
                        <Fragment>
                          {startDivider && <CompactDivider marks={startDivider} />}
                          <TaskBoundaryCard
                            boundary={r.b}
                            files={filesByBoundaryId.get(r.b.id) ?? []}
                             onOpenFile={handleOpenBoundaryFile}
                             childCount={rangeMsgs.length}
                             items={rangeMsgs}
                             renderItem={(item) => renderBubble(item)}
                             followTail={isAtBottomRef.current}
                             revealItemId={boundaryRevealRequest && boundaryRevealRequest.boundaryId === r.b.id
                               ? boundaryRevealRequest.messageId
                               : undefined}
                             revealNonce={boundaryRevealRequest && boundaryRevealRequest.boundaryId === r.b.id
                               ? boundaryRevealRequest.nonce
                               : undefined}
                             onRevealConsumed={handleBoundaryRevealConsumed}
                              onEnd={() => dispatch(endTaskBoundary({ id: r.b.id }))}
                            />
                        </Fragment>
                      );
                    } else {
                      const msg: any = messages[unit.startIdx];
                      if (msg.role !== 'tool' && !isEmptyAssistantMessage(msg, hideSysTools)) {
                        const divider = batchDividerByIdx.get(unit.startIdx);
                        content = (
                          <Fragment>
                            {divider && <CompactDivider marks={divider} />}
                            {renderBubble(msg)}
                          </Fragment>
                        );
                      }
                    }
                    if (content) {
                      out.push(
                        <div key={unit.id} {...getMessageWindowUnitProps(unit, unitIndex)}>
                          {content}
                        </div>,
                      );
                    }
                  }
                  return out;
                })()}
                {canLoadNewerMessageUnits && (
                  <button type="button" className="message-history-loader" onClick={loadNewerMessageUnits}>
                    加载更新内容 · 距最新还剩 {messageRenderUnits.length - effectiveVisibleMessageUnitEnd} 个任务或消息块
                  </button>
                )}
                {messageWindowBottomSpacerHeight > 0 && (
                  <div
                    className="message-window-spacer message-window-spacer-bottom"
                    style={{ height: messageWindowBottomSpacerHeight }}
                    aria-hidden="true"
                  />
                )}
              </>
            )}
            {/* ★ task_boundary 兜底：anchor 已不在消息列表的孤儿边界（回溯截断残留等）渲染为无消息体卡片，不丢信息。 */}
            {taskBoundaryRender.orphans.map((b: any) => (
              <TaskBoundaryCard key={b.id} boundary={b} childCount={0} />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}

        {activeAgentTab === 'plan' && (
          <div className="agent-plan-view">
            <h3 style={{ fontSize: 14, color: 'var(--syn-text-primary)', margin: '8px 12px' }}>🛠️ 工具调用计划</h3>
            {planMessages.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--syn-text-muted)', fontSize: 13 }}>
                暂无工具调用记录
              </div>
            ) : (
              <>
                {visiblePlanMessages.length < planMessages.length && (
                  <button
                    type="button"
                    className="message-history-loader"
                    onClick={() => setPlanVisibleStepCount((count) => Math.min(planMessages.length, count + PLAN_STEP_BATCH))}
                  >
                    加载更早工具记录 · 还剩 {planMessages.length - visiblePlanMessages.length} 步
                  </button>
                )}
                {visiblePlanMessages.map((msg: any, index: number) => {
                  const absoluteIndex = planMessages.length - visiblePlanMessages.length + index;
                  return (
                    <div key={msg.id ?? absoluteIndex} className="plan-step">
                      <div className="plan-step-header">
                        <span className="plan-step-num">Step {absoluteIndex + 1}</span>
                        <span className="plan-step-time">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                      </div>
                      {msg.toolCalls.map((tc: any, toolIndex: number) => (
                        <div key={tc.id ?? toolIndex} className="plan-tool-item">
                          <span className="plan-tool-icon">🔧</span>
                          <span className="plan-tool-name">{tc.name}</span>
                          <span className="plan-tool-status">✅</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {activeAgentTab === 'context' && (
          <div className="agent-context-view">
            <h3 style={{ fontSize: 14, color: 'var(--syn-text-primary)', margin: '8px 12px' }}>📖 上下文信息</h3>
            {/* ★ M4-6-S4：当前对话目标（/goal 设定）。设了则展示，让用户看到每轮注入给 AI 的目标；未设引导。 */}
            <div className="context-section">
              <div className="context-label">🎯 对话目标</div>
              <div className="context-value">
                {conversation.goal
                  ? conversation.goal
                  : <span style={{ color: 'var(--syn-text-muted)' }}>未设定（用 /goal &lt;目标&gt; 设定，每轮自动注入）</span>}
              </div>
            </div>
            <div className="context-section">
              <div className="context-label">模式</div>
              <div className="context-value">{mode === 'fast' ? '⚡ 快速模式' : '✨ 规划模式'}</div>
            </div>
            <div className="context-section">
              <div className="context-label">模型</div>
              <div className="context-value">{model || '未选择模型'}</div>
            </div>
            <div className="context-section">
              <div className="context-label">Token 使用</div>
              <div className="context-value">
                {/* ★ M5-BPC-6：context tab token 区同步 CompressionRing（inline 变体，无操作按钮）。 */}
                <CompressionRing
                  variant="inline"
                  tokenCount={tokenCount}
                  effectiveContextWindow={effectiveContextWindow}
                  tokenRatio={tokenRatio}
                  exact={tokenExact}
                />
              </div>
            </div>
            <div className="context-section">
              <div className="context-label">已注册工具</div>
              <div className="context-value">{toolRegistry.list().join(', ')}</div>
            </div>
            <div className="context-section">
              <div className="context-label">对话消息</div>
              <div className="context-value">{messages.length} 条</div>
            </div>
            <div className="context-section">
              <div className="context-label">API 端点</div>
              <div className="context-value" style={{ fontSize: 11 }}>{settings.apiEndpoints?.openai || '未配置'}</div>
            </div>
          </div>
        )}
      </div>

      <div className="agent-input-area">
        {/* ★ review MEDIUM 修复：输入框上方的 banner + 三框（排队/插队/审查）统一包进一个限高滚动容器。
            根因：原先 banner + 三框各自独立渲染在 .agent-input-area 内、无总高约束，三框各自最多 132px
            叠加可达 ~500px，面板较矮（分屏/小窗）时把消息区压到 0、输入控件被顶出视口够不到。
            修复：外层 .agent-input-extras 限 max-height:40vh + 溢出滚动，让这堆「附加内容」整体封顶、
            内部滚动，配合 .agent-input-area flex-shrink:0（输入区永不被压缩）保证输入框恒可见。 */}
        <div className="agent-input-extras">
        {/* ★ #13：前台压缩阻塞态 banner——压缩期禁止发送，给用户明确反馈（区别于普通生成中）。 */}
        {isCompacting && (
          <div className="compacting-banner">⏳ 上下文压缩中，请稍候…</div>
        )}
        {/* ★ Plan_7 #11：输入框正上方三框（从上到下：排队 / 插队 / 审查更改）。每框最多显示 4 项，超出滚动。 */}
        {/* ── 框1：排队（queue）。生成中发的消息进此队列、本轮回复结束自动发。每项可编辑 ✎ / 删除 ✕ / 切到插队 ⇅。 ── */}
        {queuedMessages.length > 0 && (
          <div className="queued-messages box-queue">
            <div className="queued-messages-header">
              <span className="queued-messages-count">{queuedMessages.length} 条排队中 · 当前回复结束后自动发送</span>
              <button className="queued-clear-btn" onClick={clearQueueOnly} title="清空全部排队">清空</button>
            </div>
            <div className="queued-list">
              {queuedMessages.map((q) => (
                <div key={q.id} className="queued-item" title={q.text || '(附件)'}>
                  <span className="queued-item-text">{q.text || (q.attachments?.length ? `📎 ${q.attachments.length} 个附件` : '(空)')}</span>
                  <button className="queued-item-btn" onClick={() => handleEditQueueItem(q, 'queue')} title="编辑这条（回填到输入框）"><Pencil size={13} /></button>
                  <button className="queued-item-btn" onClick={() => handleToggleQueueItem(q.id, 'queue')} title="改为插队（AI 下一步前插入）">⇄</button>
                  <button className="queued-item-cancel" onClick={() => handleCancelQueued(q.id)} title="删除这条">×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* ── 框2：插队（interrupt）。生成中 Ctrl·Cmd+Enter 发的消息进此队列、AI 下个空闲轮间插入。每项可编辑 / 删除 / 切到排队。 ── */}
        {interruptMessages.length > 0 && (
          <div className="queued-messages box-interrupt">
            <div className="queued-messages-header">
              <span className="queued-messages-count">{interruptMessages.length} 条插队中 · AI 下一步操作前插入</span>
              <button className="queued-clear-btn" onClick={clearInterruptOnly} title="清空全部插队">清空</button>
            </div>
            <div className="queued-list">
              {interruptMessages.map((q) => (
                <div key={q.id} className="queued-item" title={q.text || '(附件)'}>
                  <span className="queued-item-text">{q.text || (q.attachments?.length ? `📎 ${q.attachments.length} 个附件` : '(空)')}</span>
                  <button className="queued-item-btn" onClick={() => handleEditQueueItem(q, 'interrupt')} title="编辑这条（回填到输入框）"><Pencil size={13} /></button>
                  <button className="queued-item-btn" onClick={() => handleToggleQueueItem(q.id, 'interrupt')} title="改为排队（本轮结束后发）">⇄</button>
                  <button className="queued-item-cancel" onClick={() => handleCancelInterrupt(q.id)} title="删除这条">×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* ── 框3：审查更改（review changes）。列待审阅的文件改动，点击打开文件；可单个或「全部接受 / 全部拒绝」。 ── */}
        {(() => {
          if (reviewGroups.length === 0) return null;
          const batchCount = reviewGroups.reduce((total, group) => total + group.activeDiffs.length, 0);
          return (
            <div className="queued-messages box-review">
              <div className="queued-messages-header">
                <button
                  type="button"
                  className="review-box-toggle"
                  aria-expanded={!reviewBoxCollapsed}
                  onClick={toggleReviewBox}
                  title={reviewBoxCollapsed ? '展开待审查文件' : '收起待审查文件'}
                >
                  <ChevronDown size={13} className={reviewBoxCollapsed ? 'is-collapsed' : ''} />
                  <span className="queued-messages-count">
                  {reviewGroups.length} 个文件待审查{batchCount > reviewGroups.length ? ` · ${batchCount} 批改动` : ''}
                  </span>
                </button>
                {!reviewBoxCollapsed && (
                  <span className="review-box-actions">
                    <button className="queued-clear-btn" onClick={() => handleReviewBatch('reject')} title="全部拒绝（回退改动）">全部拒绝</button>
                    <button className="queued-clear-btn primary" onClick={() => handleReviewBatch('accept')} title="全部接受">全部接受</button>
                  </span>
                )}
              </div>
              {!reviewBoxCollapsed && <div className="queued-list">
                {reviewGroups.map((group) => (
                  <div
                    key={group.key}
                    className={`queued-item review-item${group.activeDiffs.some(diff => diff.reviewError) ? ' has-conflict' : ''}`}
                    title={group.activeDiffs.find(diff => diff.reviewError)?.reviewError ?? group.path}
                  >
                    <button className="review-item-open" onClick={() => openDiffTarget({ path: group.path, id: group.latest.id })} title="打开此文件（显示行内红绿 diff）">
                      <span className="review-item-name">{group.path.split(/[\\/]/).pop()}</span>
                      {group.activeDiffs.length > 1 && <span className="review-item-batches">{group.activeDiffs.length} 批</span>}
                      {group.activeDiffs.some(diff => diff.reviewError) && <span className="review-item-conflict">冲突</span>}
                      <span className="review-item-stat"><span className="review-add">+{group.additions}</span> <span className="review-del">-{group.deletions}</span></span>
                    </button>
                    <button className="queued-item-btn" onClick={() => void handleReviewGroup(group, 'reject')} title="拒绝此文件的全部待审改动"><X size={13} /></button>
                    <button className="queued-item-btn ok" onClick={() => void handleReviewGroup(group, 'accept')} title="接受此文件的全部待审改动"><Check size={13} /></button>
                  </div>
                ))}
              </div>}
            </div>
          );
        })()}
        </div>
        <div className="agent-input-toolbar">
          {/* ★ C3（M7 第七轮反馈#13）：原「附加文件 📎 + 附加图片 🖼」两按钮收敛成一个「加号小窗」（参考 Codex）。
              点开弹小菜单：上传附件（合并文件+图片，accept 放宽）/ 提及@（打开 @ 引用面板）/ 选择工作流（直进工作流二级）。
              所有原上传/附件链路（addPendingFiles）保留，只收敛入口 UI。 */}
          <div className="add-menu-wrap" ref={addMenuWrapRef}>
            <button
              className={`input-tool-btn add-menu-trigger${addMenuOpen ? ' active' : ''}`}
              title="添加内容"
              onClick={() => setAddMenuOpen(o => !o)}
            >
              <Plus size={16} />
            </button>
            {addMenuOpen && (
              <div className="add-menu" role="menu">
                <button className="add-menu-item" role="menuitem" onClick={() => {
                  setAddMenuOpen(false);
                  // 上传附件：合并原「文件 + 图片」入口，accept 放宽到全部；kind='file' 让 getAttachmentKind 自动识别图片/文档。
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.multiple = true;
                  input.onchange = (ev: any) => {
                    const files = Array.from(ev.target?.files || []) as File[];
                    if (files.length > 0) void addPendingFiles(files, 'file');
                  };
                  input.click();
                }}>
                  <Paperclip size={14} /> <span>上传附件</span>
                </button>
                <button className="add-menu-item" role="menuitem" onClick={() => {
                  setAddMenuOpen(false);
                  openAtMenu(); // 打开一级 @ 引用面板（文件/对话/工作流/设置/MCP/终端）
                }}>
                  <AtSign size={14} /> <span>提及 @</span>
                </button>
                <button className="add-menu-item" role="menuitem" onClick={() => {
                  setAddMenuOpen(false);
                  openAtMenu('workflow'); // 直接进入工作流选择二级
                }}>
                  <Workflow size={14} /> <span>选择工作流</span>
                </button>
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <button
            className={`mode-switch-btn ${mode === 'fast' ? 'fast' : 'planning'}`}
            onClick={() => dispatch(setMode(mode === 'fast' ? 'planning' : 'fast'))}
            title={`切换到${mode === 'fast' ? '规划' : '快速'}模式`}
          >
            {mode === 'fast' ? '⚡ Fast' : '✨ Planning'}
          </button>
        </div>
        {/* ★ M6：上方独立引用卡片移除——引用改内联 atomic token（在 RichTextInput 编辑器里，发送时 extract）。 */}
        {pendingAttachments.length > 0 && (
          <div className="attachment-tray">
            {pendingAttachments.map(att => (
              <button
                key={att.id}
                className={`attachment-chip status-${att.status} kind-${att.kind}`}
                onClick={() => att.kind === 'image' && att.previewUrl ? setPreviewAttachment(att) : undefined}
                title={att.error || `${att.name} · ${formatBytes(att.size)}`}
              >
                {att.kind === 'image' && att.previewUrl ? (
                  <img src={att.previewUrl} alt={att.name} />
                ) : (
                  <span className="attachment-icon">{att.kind === 'document' ? '📄' : att.kind === 'archive' ? '🗜' : '📎'}</span>
                )}
                <span className="attachment-meta">
                  <strong>{att.name}</strong>
                  <small>{att.error || `${att.mimeType || att.kind} · ${formatBytes(att.size)}`}</small>
                </span>
                <span
                  className="attachment-remove"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    removePendingAttachment(att.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      removePendingAttachment(att.id);
                    }
                  }}
                  aria-label="移除附件"
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="agent-input-container">
          {/* ★ M6：两级 @ 菜单 + 单层 / 命令菜单（受控；键盘交互由 handleEditorKeyDown 拦截，鼠标交互见回调）。 */}
          {menuElement}
          <RichTextInput
            ref={richRef}
            className="agent-input"
            placeholder={!hasApiKey
              ? '请先配置 API Key...'
              : !hasModel
                ? '请先选择模型...'
                : isAgentRunActive
                  ? `当前任务仍在运行：${runtimeEnterAction === 'interrupt' ? 'Enter 插队 / Ctrl+Enter 排队' : 'Enter 排队 / Ctrl+Enter 插队'}`
                  : `输入消息... (${sendKeyMode === 'enter' ? 'Enter 发送 / Shift+Enter 换行' : 'Ctrl+Enter 发送 / Enter 换行'}；@ 引用文件/对话/工作流/设置/MCP/终端，/ 命令)`}
            onContentChange={() => { setCanSend(!richRef.current?.isEmpty()); refreshMenu(); }}
            onEditorKeyDown={handleEditorKeyDown}
            onPasteFiles={(files) => { void addPendingFiles(files, 'image'); }}
          />
          {isStreaming ? (
            <button className="agent-send-btn" onClick={handleStop} title="停止">
              <StopCircle size={18} />
            </button>
          ) : (
            <button
              className={`agent-send-btn${activeBpcUi.state === 'hard-paused' ? ' agent-send-btn-paused' : ''}${isAgentRunActive ? ' agent-send-btn-running' : ''}`}
              onClick={() => handleSend()}
              disabled={(!canSend && pendingAttachments.filter(att => att.status === 'ready').length === 0) || !hasApiKey || !hasModel}
              title={activeBpcUi.state === 'hard-paused'
                ? '对话处于保护性暂停；点击后会保留输入并提示恢复，/compact 仍可发送'
                : isAgentRunActive
                  ? (!canSend && pendingAttachments.every(att => att.status !== 'ready')
                    ? `输入内容后可${runtimeEnterAction === 'interrupt' ? '插队' : '排队'}发送`
                    : `当前任务仍在运行；点击后${runtimeEnterAction === 'interrupt' ? '插队' : '排队'}发送`)
                  : '发送'}
            >
              <SendHorizontal size={18} />
            </button>
          )}
          {!isStreaming && isAgentRunActive && (
            <button className="agent-send-btn agent-stop-btn" onClick={handleStop} title="停止当前任务">
              <StopCircle size={18} />
            </button>
          )}
        </div>
        <div className="agent-input-footer">
          {bpcPopOpen && (
            <BpcOverridePopover
              tokenCount={tokenCount}
              effectiveContextWindow={effectiveContextWindow}
              tokenRatio={tokenRatio}
              exact={tokenExact}
              onClose={() => setBpcPopOpen(false)}
            />
          )}
          {/* ★ M5-BPC-6：footer 主入口换成 CompressionRing——idle 显常规 token%，BPC 后台活跃时显状态环 + 中止/重启按钮。
              ★ 验收补：点击打开本对话 BPC/硬压缩 override 浮层（CC 式每对话可调，留空=跟随全局）。 */}
          <CompressionRing
            variant="full"
            tokenCount={tokenCount}
            effectiveContextWindow={effectiveContextWindow}
            tokenRatio={tokenRatio}
            onConfigClick={() => setBpcPopOpen(o => !o)}
            exact={tokenExact}
          />
          {capabilityLabels.length > 0 && (
            <button
              className="model-capability-row"
              type="button"
              title={capabilitySummaryLabel}
              aria-label={capabilitySummaryLabel}
              onClick={() => setModelMenuOpen(true)}
            >
              <span className="model-capability-compact">{capabilityLabels.length} 项</span>
              {capabilityLabels.slice(0, 5).map(label => (
                <span key={label} className="model-capability-chip">{label}</span>
              ))}
            </button>
          )}
          <div className="agent-model-picker" ref={modelPickerRef}>
            <span
              ref={modelTriggerRef}
              className="model-label clickable"
              style={{
                color: mode === 'fast' ? 'var(--syn-info)' : 'var(--syn-accent)',
                fontWeight: 600,
                cursor: isAgentRunActive ? 'not-allowed' : 'pointer',
                opacity: isAgentRunActive ? 0.65 : 1,
              }}
              title={isAgentRunActive ? '当前轮结束后可切换模型' : '切换模型'}
              tabIndex={0}
              role="button"
              aria-haspopup="dialog"
              aria-expanded={modelMenuOpen}
              aria-disabled={isAgentRunActive}
              aria-controls="agent-model-dropdown"
              onClick={toggleModelMenu}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleModelMenu();
                }
                if (e.key === 'Escape') setModelMenuOpen(false);
              }}
            >
              {mode === 'fast' ? '⚡' : '✨'} {model || '未选择模型'}
            </span>
            {modelMenuOpen && (
              <div id="agent-model-dropdown" className="model-dropdown" role="dialog" aria-label="选择模型与参数">
                {availableModels.length > 0 && (
                  <input
                    className="model-search-input"
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    placeholder="搜索模型..."
                    aria-label="搜索模型"
                    aria-controls="agent-model-list"
                    aria-activedescendant={filteredModelOptions.length > 0 ? `agent-model-option-${modelActiveIndex}` : undefined}
                    role="combobox"
                    aria-expanded="true"
                    onKeyDown={handleModelSearchKeyDown}
                    autoFocus
                  />
                )}
                {availableModels.length === 0 ? (
                  <div className="model-empty">请在设置中获取模型列表</div>
                ) : filteredModels.length === 0 ? (
                  <div className="model-empty">没有匹配的模型</div>
                ) : (
                  <div id="agent-model-list" className="model-list" role="listbox" aria-label="可用模型">
                    {filteredModelGroups.map(group => (
                      <div key={group.providerId} className="model-provider-group" role="group" aria-label={group.label}>
                        <div className="model-provider-heading" aria-hidden="true">
                          <span>{group.label}</span>
                          <small>{group.models.length}{group.unknownOnly ? ' · 能力未确认' : ''}</small>
                        </div>
                        {group.models.map((m: any) => {
                          const optionIndex = filteredModelIndexById.get(m.id) ?? 0;
                          return (
                            <button
                              key={m.id}
                              id={`agent-model-option-${optionIndex}`}
                              ref={element => { modelOptionRefs.current[optionIndex] = element; }}
                              className={`model-option ${m.id === model ? 'active' : ''}`}
                              onClick={() => handleSelectModel(m.id)}
                              onFocus={() => setModelActiveIndex(optionIndex)}
                              onKeyDown={event => handleModelNavigationKey(event, optionIndex)}
                              title={m.id}
                              role="option"
                              aria-selected={m.id === model}
                              tabIndex={optionIndex === modelActiveIndex ? 0 : -1}
                            >
                              <span>{m.name || m.id}</span>
                              {m.name && m.name !== m.id && <small>{m.id}</small>}
                              {m.capabilities && (
                                <small>{describeCapabilities(m.capabilities).slice(0, 4).join(' · ')}</small>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
                {currentModelOption && (
                  <div className="model-parameter-panel">
                    <div className="model-parameter-header">
                      <span>模型参数</span>
                      <small>{{ api: '模型目录', protocol: '协议适配', mixed: '目录 + 协议', unknown: '能力未知' }[currentCapabilities?.source ?? 'unknown']}</small>
                    </div>
                    <p className="model-param-hint">不支持的参数会保持禁用，不会写入请求。</p>
                    <label className="model-param-row">
                      <span>输出策略</span>
                      <select
                        value={agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off')}
                        onChange={e => dispatch(setOutputStrategy(e.target.value as any))}
                      >
                        <option value="auto">自动</option>
                        <option value="real" disabled={currentCapabilities?.streaming === false}>真流式</option>
                        <option value="pseudo">伪流式</option>
                        <option value="off">关闭流式</option>
                      </select>
                    </label>
                    <label className="model-param-row">
                      <span>伪流式速度</span>
                      <select
                        value={agentSettings.pseudoStreamSpeed ?? 'medium'}
                        disabled={(agentSettings.outputStrategy ?? 'auto') === 'real' && currentCapabilities?.streaming !== false}
                        onChange={e => dispatch(setPseudoStreamSpeed(e.target.value as any))}
                      >
                        <option value="slow">慢</option>
                        <option value="medium">中</option>
                        <option value="fast">快</option>
                      </select>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.showStreamCursor ?? true}
                        onChange={e => dispatch(setShowStreamCursor(e.target.checked))}
                      />
                      <span>流式光标</span>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.showGeneratingPlaceholder ?? true}
                        onChange={e => dispatch(setShowGeneratingPlaceholder(e.target.checked))}
                      />
                      <span>生成占位</span>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.showThinking ?? true}
                        disabled={currentCapabilities?.thinking === false}
                        onChange={e => dispatch(setShowThinking(e.target.checked))}
                      />
                      <span>Thinking 展示</span>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.streamThinking ?? true}
                        disabled={currentCapabilities?.thinking === false}
                        onChange={e => dispatch(setStreamThinking(e.target.checked))}
                      />
                      <span>Thinking 伪流式</span>
                    </label>
                    <label className="model-param-row">
                      <span>Reasoning</span>
                      <select
                        value={currentCapabilities?.reasoning ? (agentSettings.reasoningEffort ?? 'auto') : 'auto'}
                        disabled={!currentCapabilities?.reasoning}
                        onChange={e => dispatch(setReasoningEffort(e.target.value))}
                      >
                        {reasoningOptions.map((option: string) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </label>
                    <label className="model-param-row">
                      <span>Speed</span>
                      <select
                        value={speedOptions.includes(agentSettings.speedTier) ? agentSettings.speedTier : 'auto'}
                        disabled={speedOptions.length <= 1 && speedOptions[0] === 'auto'}
                        onChange={e => dispatch(setSpeedTier(e.target.value))}
                      >
                        {speedOptions.map((option: string) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </label>
                    <label className={`model-slider-row ${supportsTemperature ? '' : 'disabled'}`}>
                      <span>Temperature <strong>{(agentSettings.temperature ?? 0.7).toFixed(2)}</strong></span>
                      <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.05"
                        value={agentSettings.temperature ?? 0.7}
                        disabled={!supportsTemperature}
                        onChange={e => dispatch(setTemperature(Number(e.target.value)))}
                      />
                    </label>
                    <label className={`model-slider-row ${supportsTopP ? '' : 'disabled'}`}>
                      <span>Top P <strong>{(agentSettings.topP ?? 1).toFixed(2)}</strong></span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={agentSettings.topP ?? 1}
                        disabled={!supportsTopP}
                        onChange={e => dispatch(setTopP(Number(e.target.value)))}
                      />
                    </label>
                    <label className="model-param-row">
                      <span>Max Tokens</span>
                      <input
                        type="number"
                        min="256"
                        max={currentCapabilities?.maxOutputTokens ?? 128000}
                        step="256"
                        value={agentSettings.maxTokens ?? 4096}
                        disabled={!supportsMaxTokens}
                        onChange={e => dispatch(setMaxTokens(Math.max(256, Number(e.target.value) || 4096)))}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
          {!hasApiKey && <span style={{ color: '#f59e0b', fontSize: 11 }}>未配置</span>}
          {hasApiKey && !hasModel && <span style={{ color: '#f59e0b', fontSize: 11 }}>未选择模型</span>}
        </div>
        {previewAttachment && (
          <div className="attachment-preview-backdrop" onClick={() => setPreviewAttachment(null)}>
            <div className="attachment-preview-modal" onClick={event => event.stopPropagation()}>
              <div className="attachment-preview-header">
                <span>{previewAttachment.name}</span>
                <button onClick={() => setPreviewAttachment(null)} title="关闭">×</button>
              </div>
              {previewAttachment.previewUrl && (
                <img className="attachment-preview-image" src={previewAttachment.previewUrl} alt={previewAttachment.name} />
              )}
              <div className="attachment-preview-actions">
                <span>{formatBytes(previewAttachment.size)} · {previewAttachment.mimeType || 'image'}</span>
                {/* M4-3-S3 修复：「移除」只对【草稿态】附件有意义（removePendingAttachment 在 pendingAttachments
                    草稿区 filter 并 release 实体）。已发送(sent)图片走只读查看，不渲染移除按钮——否则语义错位
                    （误导可从消息移除，实为 no-op），且边缘情况下可能误删草稿区同 id 的 pending 附件。 */}
                {previewAttachment.status !== 'sent' && (
                  <button className="settings-btn danger" onClick={() => removePendingAttachment(previewAttachment.id)}>移除</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
