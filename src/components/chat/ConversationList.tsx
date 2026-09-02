/**
 * ConversationList — 对话历史侧边栏组件
 * 显示历史对话、新建对话、切换/删除对话、搜索过滤和批量管理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { store } from '@/store';
import type { ConversationSummary } from '@/store/slices/conversationHistory';
import { removeConversation, setConversations, setSelectedId, updateConversation } from '@/store/slices/conversationHistory';
import { clearConversation, setConversation, setActiveConversation, setConversationWorkspace, setModel as setConversationModel, setTitle, selectActiveConversation } from '@/store/slices/conversation';
// ★ #8 选A（byId 真并发）：未保存对话 fork 成真实 id 时迁桶 + 迁 worktree + 重绑在跑的 run，保后台进度不丢、不串台。
import { migrateForkedConversation } from '@/services/conversationMigrate';
import { executionRegistry } from '@/services/executionRegistry';
import { setCurrentModel, setMode, setReasoningEffort } from '@/store/slices/agentSettings';
import { exitWorktree } from '@/store/slices/worktreeSession';
import { addNotification } from '@/store/slices/notifications';
import { buildWorkspaceMoveTargets, workspacePathKey } from '@/store/slices/workspace';
import {
  AUTOSAVE_ID,
  beginConversationSwitch,
  clearAutosaveSnapshot,
  endConversationSwitch,
  isConversationSwitchCurrent,
  deleteConversationSnapshot,
  deleteConversationSnapshots,
  exportConversationSnapshot,
  exportConversationSnapshots,
  listConversationSummaries,
  loadConversationSnapshot,
  migrateSnapshotAttachments,
  renameConversation,
  saveConversationSnapshot,
  updateConversationMetadata,
  updateConversationsMetadata,
  type ConversationListFilters,
} from '@/services/conversationPersistence';
import {
  useConversationManager,
  workspaceLabel,
  type WorkspaceTarget,
} from '@/hooks/useConversationManager';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckSquare,
  Download,
  Edit3,
  FolderInput,
  Globe,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
  Square,
  Tags,
  Trash2,
  X,
} from 'lucide-react';

const executionContextId = (conversationId: string): string => (
  executionRegistry.getOwnerId(conversationId) ?? conversationId
);
import { generateTitleFromText } from '@/services/agentLoop';
import { confirmAction, promptAction } from '@/services/confirmationCoordinator';

type ArchiveFilter = 'active' | 'archived' | 'all';

function splitTags(value: string): string[] {
  return [...new Set(value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function joinTags(tags?: string[]): string {
  return (tags ?? []).join(', ');
}

function stop(event: MouseEvent): void {
  event.stopPropagation();
}

function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  URL.revokeObjectURL(url);
}

export function ConversationList() {
  const dispatch = useAppDispatch();
  // ★ M4-2-S6：共享 hook 提供工作区范围三态 scope + scopeFilters 映射 + moveToWorkspace（改归属）
  //   + recentPaths（「移动到…」候选）。conversations/selectedId 仍由本组件直接读 slice（与 hook 同源），
  //   切换/新建/保存等带竞态闸门的敏感逻辑保留在组件内（保守路线，见 Plan_5 M4-2 第七节 #5）。
  const {
    scope,
    setScope,
    scopeFilters,
    moveToWorkspace,
    recentPaths,
    workspaceCurrentPath,
  } = useConversationManager();
  // 「移动到…」候选工作区：当前工作区（若有）置顶 + recentPaths 去重，全部以 path 为键。
  const moveTargets = useMemo<string[]>(() => {
    return buildWorkspaceMoveTargets(workspaceCurrentPath, recentPaths);
  }, [workspaceCurrentPath, recentPaths]);
  const conversations = useAppSelector((s) => s.conversationHistory.conversations);
  const selectedId = useAppSelector((s) => s.conversationHistory.selectedId);
  // ★ 性能（诊断#1 热点1）：不再 useAppSelector 订阅整个 s.conversation——流式每 200ms 换引用会让本组件
  //   每帧白重渲（渲染体只用 conversations 历史 + selectedId 高亮）。当前对话数据仅回调里需要，改为
  //   调用时 store.getState().conversation 取最新值（比 render 快照更准），彻底断开整对象订阅。
  // ★ M4-2-S5 对话工作区归属：新对话默认归当前工作区（state.workspace.currentPath，null=Global）。
  //   用 ref 持有最新值——既不把它塞进 handleNewConversation 的依赖数组（避免切工作区时重建回调），
  //   也防 useCallback 闭包读到旧 path。复用 useConversationManager 暴露的 workspaceCurrentPath（同源）。
  const workspaceCurrentPathRef = useRef(workspaceCurrentPath);
  workspaceCurrentPathRef.current = workspaceCurrentPath;
  // M2-6：保存当前对话时需把【当前全局 agentSettings 的 mode / reasoningEffort】随对话落库。
  //   用 ref 持有最新值，既避免把这两个高频可变项塞进 saveCurrentToHistory 的依赖数组，也防闭包旧值。
  const agentMode = useAppSelector((s) => s.agentSettings.mode);
  const agentReasoningEffort = useAppSelector((s) => s.agentSettings.reasoningEffort);
  const agentCurrentModel = useAppSelector((s) => s.agentSettings.currentModel);
  const agentSettingsRef = useRef({ mode: agentMode, reasoningEffort: agentReasoningEffort, model: agentCurrentModel });
  agentSettingsRef.current = { mode: agentMode, reasoningEffort: agentReasoningEffort, model: agentCurrentModel };
  const [searchQuery, setSearchQuery] = useState('');
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('active');
  const [tagFilter, setTagFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  // ★ M7-F1：正在「重新生成标题」的对话 id（按钮 loading 态 + 防重复点）。
  const [regenId, setRegenId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  // ★ M4-2-S6「移动到…」：当前展开归属菜单的对话 id（null = 未展开）。点条目 FolderInput 按钮切换。
  const [movingId, setMovingId] = useState<string | null>(null);
  const moveMenuRef = useRef<HTMLDivElement | null>(null);

  const activeFilters = useMemo<ConversationListFilters>(() => ({
    query: searchQuery,
    archived: archiveFilter,
    tags: splitTags(tagFilter),
    limit: 200,
    // ★ M4-2-S6：把工作区范围三态（scope→workspacePath/globalOnly）并入过滤。activeFilters 变化（含 scope 切换）
    //   会触发既有 useEffect 重新 listConversationSummaries，列表即时按范围刷新。
    ...scopeFilters,
  }), [archiveFilter, searchQuery, tagFilter, scopeFilters]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allVisibleSelected = conversations.length > 0 && conversations.every(conv => selectedSet.has(conv.id));
  const selectedConversations = conversations.filter(conv => selectedSet.has(conv.id));

  const refreshConversations = useCallback(async (filters = activeFilters) => {
    setIsLoading(true);
    try {
      const summaries = await listConversationSummaries(filters);
      dispatch(setConversations(summaries));
    } catch {
      dispatch(addNotification({ type: 'error', title: '加载失败', message: '无法读取对话历史' }));
    } finally {
      setIsLoading(false);
    }
  }, [activeFilters, dispatch]);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setIsLoading(true);
      void listConversationSummaries(activeFilters)
        .then(summaries => {
          if (!cancelled) dispatch(setConversations(summaries));
        })
        .catch(() => {
          if (!cancelled) {
            dispatch(addNotification({ type: 'error', title: '搜索失败', message: '无法搜索对话历史' }));
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeFilters, dispatch]);

  useEffect(() => {
    setSelectedIds(prev => prev.filter(id => conversations.some(conv => conv.id === id)));
  }, [conversations]);

  const saveCurrentToHistory = useCallback(async () => {
    try {
      // ★ Codex 高风险修复（fork 欠计 → 删一份另一份图失效）：附件 put 只在上传那一刻发生一次(refCount=1)，
      //   落库（persistPlatformSnapshot/replaceMessages）只存 sha JSON，从不 addRef。当当前对话是 autosave 时，
      //   saveConversationSnapshot 会把这批消息复制到一个【新对话 id】(fork)，此后 autosave 行与新对话行同时
      //   引用同一 sha，但 refCount 仍=1（欠计）→ 删任一份后 release 即归零 GC，另一份图变缺失。
      //   修法（与 AgentPanel 新建路径口径对齐）：fork 成新 id 后 clearAutosaveSnapshot()
      //   （只删 autosave 镜像行、不 release），消除「autosave + 新对话」双持有，使持有数回落到 1（仅新对话行）—— refCount 守恒。
      const cur = selectActiveConversation(store.getState());
      const wasAutosave = !cur.id || cur.id === AUTOSAVE_ID;
      const summary = await saveConversationSnapshot({
        id: cur.id,
        title: cur.title,
        messages: cur.messages,
        model: cur.model || agentSettingsRef.current.model,
        // M2-6：把当前对话的 mode / reasoningEffort（全局 agentSettings 镜像）随对话落库，
        //   使切走再切回能恢复该对话各自的设置（A=fast / B=planning 不串）。
        mode: agentSettingsRef.current.mode,
        reasoningEffort: agentSettingsRef.current.reasoningEffort,
        assistantRuns: cur.assistantRuns,
        fileSnapshots: cur.fileSnapshots,
        pendingDiffs: cur.pendingDiffs,
        // ★ M4-2-S5 首次保存落归属：把当前对话在 store 持有的工作区归属随对话落库（新建时由
        //   handleNewConversation 已置入 state.conversation.workspacePath，恢复/分支时已回填）。这是
        //   autosave→fork 成正式 id 那一刻把归属固化进 DB 的关键一环——否则 fork 出的新行 workspace_path 为 NULL。
        workspacePath: cur.workspacePath,
        // ★ M4-6 审查修复（medium/regression 问题4）：autosave→fork 那一刻把对话目标固化进新对话行（与 AgentPanel
        //   等价保存路径 line ~594/~662 口径一致）。普通 update 路径靠「undefined 不动」尚能保住 DB 既有 goal，
        //   但当前对话是 autosave 草稿（wasAutosave=true）且刚用 /goal 设了目标时，fork 出的新对话走 create/insert
        //   路径若不传 goal 会落 NULL → goal 丢失。故显式随快照带上。
        goal: cur.goal,
        bpcThresholdOverride: cur.bpcThresholdOverride,
        compactThresholdOverride: cur.compactThresholdOverride,
        // ★ task_boundary：把当前对话的任务边界 + 大标题随对话落库（与 goal 同源 store.getState().conversation），
        //   切回时能恢复边界卡片与历史；autosave→fork 那一刻一并固化进新对话行（同 goal 防 fork 丢失）。
        taskBoundaries: cur.taskBoundaries,
        taskHeadline: cur.taskHeadline,
        // ★ M4-2-S1（问题9 根治）：这是「切走对话的系统性自动保存」，不应改变其排序时间。
        //   改 systemTouch:true（落库不刷 updated_at）+ 去掉硬传 timestamp:Date.now()——
        //   否则切走对话被刷成当前时间，按时间降序时它跳第一、被点中的对话被挤到第二位。
        systemTouch: true,
      });
      if (summary) {
        dispatch(updateConversation(summary));
        // 确实发生了 autosave→新 id 的 fork（summary.id 不再是 autosave）才清 autosave，避免误删非 fork 场景的本体。
        if (wasAutosave && summary.id && summary.id !== AUTOSAVE_ID) {
          // ★ #8 选A：autosave 草稿 fork 成真实 id——迁桶 + 迁 worktree + 重绑在跑的 run，保后台进度不丢、不串台。
          //   ConversationList 无 agentLoopRef，重绑统一走 helper 内 runningAgentLoops 全局集合（按 runConvId 匹配）。
          await migrateForkedConversation(cur.id || AUTOSAVE_ID, summary.id);
          await clearAutosaveSnapshot();
        }
      }
      return summary?.id ?? null;
    } catch {
      dispatch(addNotification({ type: 'warning', title: '自动保存失败', message: '当前对话保存失败，但仍会继续打开历史' }));
      return null;
    }
  }, [dispatch]); // 性能：断 currentConversation 订阅后回调内 store.getState() 取最新，依赖仅 dispatch

  const handleNewConversation = useCallback(async () => {
    // ★ M2-6 切换竞态：同 handleSwitchConversation，置闸覆盖 saveCurrentToHistory(可能 fork+clearAutosave)
    //   到 clearConversation/重置 的整段窗口，挡住旧对话迟到 autosave debounce 复活 AUTOSAVE_ID 草稿。
    beginConversationSwitch();
    // ★ M2-5 worktree 止血：对话身份变化（新建）即回主工作区——清掉【离开的对话】的活动 worktree 条目。
    //   即便治本已按 contextId 索引，新对话与 autosave 草稿共用 AUTOSAVE_ID 这个 contextId，
    //   不清则新对话会继承上一条 autosave 对话的 worktree 重定向（串台），故必须显式 exit。
    const leavingContextId = (selectActiveConversation(store.getState()).id as string | null) || AUTOSAVE_ID;
    dispatch(exitWorktree({ contextId: executionContextId(leavingContextId) }));
    dispatch(exitWorktree({ contextId: executionContextId(AUTOSAVE_ID) }));
    try {
      await saveCurrentToHistory();
      // ★ #8 选A：byId 下不能 clearConversation()——它清的是【活跃桶】，若当前对话(A)正后台跑会被清掉内容。
      //   改为创建一个全空草稿桶（AUTOSAVE_ID）并设 active，不动 A 桶：A 已被上面 saveCurrentToHistory fork 成真实 id
      //   而空出 AUTOSAVE_ID；若 A 本就是真实 id，A 桶=真实 id、新草稿=AUTOSAVE_ID，互不影响。后台在跑的 A 桶内容得以保留。
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
      //   随即按当前打开的工作区 path 置归属（未打开工作区时 ref 为 null → 维持 Global）。须放在建桶之后，
      //   否则被覆盖回 null。首条消息触发的 saveCurrentToHistory 会把该归属落库。
      dispatch(setConversationWorkspace(workspaceCurrentPathRef.current));
      // M2-6：新对话回默认设置（mode=planning / reasoningEffort=auto）。先 saveCurrentToHistory 落定旧对话设置再重置。
      dispatch(setMode('planning'));
      dispatch(setReasoningEffort('auto'));
      dispatch(setSelectedId(null));
      setSelectedIds([]);
      setIsBulkMode(false);
      await refreshConversations({ ...activeFilters, query: '' });
      dispatch(addNotification({ type: 'info', title: '新对话', message: '已创建新对话' }));
    } finally {
      endConversationSwitch();
    }
  }, [activeFilters, saveCurrentToHistory, refreshConversations, dispatch]);

  const handleSwitchConversation = useCallback(async (id: string) => {
    // ★ M2-6 切换竞态：置闸覆盖「saveCurrentToHistory(可能 fork+clearAutosave) → loadConversationSnapshot
    //   → setConversation(新对话)」整段异步窗口。其间 AgentPanel 旧对话的 700ms autosave debounce 即便迟到触发，
    //   saveAutosaveSnapshot 也会因闸门跳过对 AUTOSAVE_ID 行的写入，杜绝复活已 fork 的草稿。finally 复位。
    const switchEpoch = beginConversationSwitch();
    // ★ M2-5 worktree 止血：切到另一对话即回主工作区——清掉【离开的对话】+ AUTOSAVE_ID 的活动 worktree 条目。
    //   防 autosave 草稿（共用 AUTOSAVE_ID）的 worktree 重定向被切入对话误继承。切入对话若自身有条目，
    //   按 contextId 索引天然各自独立、不受影响。
    const leavingContextId = (selectActiveConversation(store.getState()).id as string | null) || AUTOSAVE_ID;
    dispatch(exitWorktree({ contextId: executionContextId(leavingContextId) }));
    dispatch(exitWorktree({ contextId: executionContextId(AUTOSAVE_ID) }));
    try {
      await saveCurrentToHistory();
      if (!isConversationSwitchCurrent(switchEpoch)) return;
      const snapshot = await loadConversationSnapshot(id);
      if (!isConversationSwitchCurrent(switchEpoch)) return;
      if (!snapshot) throw new Error('missing conversation');
      // ★ byId 治本（step4，与 AgentPanel.handleSwitchConversationFromMenu 样板同口径）：目标对话桶若已在内存
      //   （可能后台 run 正在写它）——只切 activeId，【绝不重 hydrate】，否则 DB 旧快照会覆盖后台实时写入的内容
      //   （切回看不到后台进度）。仅首次加载（桶不存在/空）才从 DB hydrate。
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
          // M2-3：切换对话时把分支溯源回填进 store（此前未接 → 渲染显示 null，DB 一直是对的）。
          parentId: snapshot.parentId ?? null,
          branchedFromMessageId: snapshot.branchedFromMessageId ?? null,
          // ★ M4-2-S5 恢复回填归属：切到历史对话时把其 DB 归属回填进 store（旧对话/legacy 为 null=Global），
          //   使后续在该对话内的保存延续正确归属，且 S6/S7 UI 标记/范围过滤即时一致。
          workspacePath: snapshot.workspacePath ?? null,
          // ★ M4-6 审查修复（high/regression 问题3）：切对话时随对话身份刷新 goal（与 AgentPanel 右栏切换器 line ~685
          //   口径一致）。slice 用「'goal' in payload 才覆盖」语义，省略 goal 会让上一对话的 state.goal 残留并继续
          //   注入进新对话每轮 <current_goal>（跨对话泄漏），且新对话自身持久化的 goal 也加载不回来。必须显式传。
          goal: snapshot.goal || undefined,
          bpcThresholdOverride: snapshot.bpcThresholdOverride,
          compactThresholdOverride: snapshot.compactThresholdOverride,
          // ★ task_boundary：切对话时随对话身份回填任务边界 + 大标题（与 goal 同源 snapshot，从 DB JSON 列读回；未设则 undefined）。
          //   同 goal：省略会让上一对话的边界残留并跨对话泄漏，且新对话持久化的边界加载不回来。必须显式传。
          taskBoundaries: snapshot.taskBoundaries,
          taskHeadline: snapshot.taskHeadline,
        }));
      }
      // M2-6：把该对话各自的 mode / reasoningEffort 同步进全局 agentSettings（agentLoop 仍读 agentSettings，
      //   口径不变）。已在 saveCurrentToHistory 把切换前对话的设置落库，故此处切走旧设置不丢。
      dispatch(setMode(snapshot.mode === 'fast' ? 'fast' : 'planning'));
      dispatch(setReasoningEffort(snapshot.reasoningEffort || 'auto'));
      if (nextModel) {
        dispatch(setConversationModel({ model: nextModel, conversationId: id }));
        dispatch(setCurrentModel(nextModel));
      }
      dispatch(setSelectedId(id));
      // ★ M2-R6 懒迁移：打开历史对话时若含旧内联 base64，后台抽离成 sha256 引用并回写 DB（用到才迁、不阻塞）。
      // 迁移确有变更时把引用态写回 store（杜绝残留 base64 反复落库）；回写前校验仍是同一对话且消息未变。
      const switchedLen = snapshot.messages.length;
      void migrateSnapshotAttachments(snapshot, (migratedId, migratedMessages) => {
        const cur = selectActiveConversation(store.getState());
        if (!cur || cur.isStreaming) return;
        if ((cur.id as string | null) === migratedId && cur.messages.length === switchedLen) {
          dispatch(setConversation({
            id: migratedId,
            title: cur.title,
            messages: migratedMessages,
            model: cur.model,
            assistantRuns: cur.assistantRuns,
            fileSnapshots: cur.fileSnapshots,
            pendingDiffs: cur.pendingDiffs,
          }));
        }
      }).catch(() => undefined);
      await refreshConversations();
    } catch {
      dispatch(addNotification({ type: 'error', title: '加载失败', message: '无法加载对话历史' }));
    } finally {
      endConversationSwitch();
    }
  }, [saveCurrentToHistory, refreshConversations, dispatch]);

  const handleItemClick = useCallback((conv: ConversationSummary) => {
    if (isBulkMode) {
      setSelectedIds(prev => prev.includes(conv.id) ? prev.filter(id => id !== conv.id) : [...prev, conv.id]);
      return;
    }
    void handleSwitchConversation(conv.id);
  }, [handleSwitchConversation, isBulkMode]);

  const toggleBulkMode = useCallback(() => {
    setIsBulkMode(prev => {
      const next = !prev;
      if (!next) setSelectedIds([]);
      return next;
    });
  }, []);

  const toggleSelected = useCallback((id: string, event: MouseEvent) => {
    stop(event);
    setSelectedIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  }, []);

  const toggleSelectVisible = useCallback(() => {
    setSelectedIds(allVisibleSelected ? [] : conversations.map(conv => conv.id));
  }, [allVisibleSelected, conversations]);

  const handleDeleteConversation = useCallback(async (id: string, event: MouseEvent) => {
    stop(event);
    const conv = conversations.find((item) => item.id === id);
    if (!await confirmAction({
      title: '删除这条对话？',
      message: `即将删除「${conv?.title || '未命名对话'}」。工作区文件不会被删除。`,
      confirmLabel: '确认删除',
      tone: 'danger',
    })) return;

    try {
      await deleteConversationSnapshot(id);
      dispatch(removeConversation(id));
      // ★ 审查 LOW：删对话同步清其 worktree 运行态条目（与切换/新建/分支入口口径一致），防运行态泄漏。
      dispatch(exitWorktree({ contextId: executionContextId(id) }));
      if (selectedId === id) {
        dispatch(setSelectedId(null));
        dispatch(clearConversation());
        dispatch(exitWorktree({ contextId: executionContextId(AUTOSAVE_ID) }));
      }
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '已删除', message: '对话已删除，工作区文件未受影响' }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '删除失败', message: '对话仍保留，请稍后重试' }));
    }
  }, [conversations, selectedId, refreshConversations, dispatch]);

  const handleBulkDelete = useCallback(async () => {
    if (!selectedIds.length) return;
    if (!await confirmAction({
      title: `删除 ${selectedIds.length} 条对话？`,
      message: '选中的对话会从历史中删除，工作区文件不会被删除。',
      confirmLabel: '全部删除',
      tone: 'danger',
    })) return;
    setBulkBusy(true);
    try {
      await deleteConversationSnapshots(selectedIds);
      selectedIds.forEach(id => {
        dispatch(removeConversation(id));
        dispatch(exitWorktree({ contextId: executionContextId(id) })); // ★ 审查 LOW：删对话同步清 worktree 条目
      });
      if (selectedId && selectedIds.includes(selectedId)) {
        dispatch(setSelectedId(null));
        dispatch(clearConversation());
        dispatch(exitWorktree({ contextId: executionContextId(AUTOSAVE_ID) }));
      }
      setSelectedIds([]);
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '批量删除完成', message: '已删除所选对话，工作区文件未受影响' }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '批量删除失败', message: '部分对话未能删除' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations, selectedId, selectedIds]);

  const handleExportConversation = useCallback(async (id: string, event: MouseEvent) => {
    stop(event);
    try {
      const snapshot = await exportConversationSnapshot(id);
      if (!snapshot) throw new Error('missing conversation');
      const conv = conversations.find((item) => item.id === id);
      const exportData = {
        ...snapshot,
        title: snapshot.title || conv?.title || '对话',
        model: snapshot.model || conv?.model,
        exportedAt: new Date().toISOString(),
      };
      downloadJson(`synapse-${conv?.title || 'conversation'}-${Date.now()}.json`, exportData);
      dispatch(addNotification({ type: 'info', title: '导出成功', message: '对话已导出为 JSON' }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '导出失败', message: '无法导出对话' }));
    }
  }, [conversations, dispatch]);

  const handleBulkExport = useCallback(async () => {
    if (!selectedIds.length) return;
    setBulkBusy(true);
    try {
      const bundle = await exportConversationSnapshots(selectedIds, activeFilters);
      downloadJson(`synapse-conversations-${selectedIds.length}-${Date.now()}.json`, bundle);
      dispatch(addNotification({ type: 'info', title: '批量导出成功', message: `已导出 ${bundle.conversations.length} 条对话` }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '批量导出失败', message: '无法导出所选对话' }));
    } finally {
      setBulkBusy(false);
    }
  }, [activeFilters, dispatch, selectedIds]);

  const setArchivedForIds = useCallback(async (ids: string[], archived: boolean) => {
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      await updateConversationsMetadata(ids, { archived });
      ids.forEach(id => dispatch(updateConversation({ id, archived })));
      setSelectedIds([]);
      await refreshConversations();
      dispatch(addNotification({
        type: 'info',
        title: archived ? '已归档' : '已取消归档',
        message: `已更新 ${ids.length} 条对话`,
      }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '归档失败', message: '无法更新所选对话' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations]);

  const editSingleTags = useCallback(async (conv: ConversationSummary, event: MouseEvent) => {
    stop(event);
    const next = await promptAction({
      title: '编辑对话标签',
      message: '输入标签，多个标签使用英文逗号分隔。',
      defaultValue: joinTags(conv.tags),
      placeholder: '例如 bug, BPC, 验收',
    });
    if (next === null) return;
    const tags = splitTags(next);
    await updateConversationMetadata(conv.id, { tags });
    dispatch(updateConversation({ id: conv.id, tags }));
    await refreshConversations();
  }, [dispatch, refreshConversations]);

  const addTagToSelected = useCallback(async () => {
    const tagsToAdd = splitTags(tagDraft);
    if (!tagsToAdd.length || !selectedConversations.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(selectedConversations.map(async conv => {
        const tags = [...new Set([...(conv.tags ?? []), ...tagsToAdd])].slice(0, 12);
        await updateConversationMetadata(conv.id, { tags });
        dispatch(updateConversation({ id: conv.id, tags }));
      }));
      setTagDraft('');
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '标签已添加', message: `已更新 ${selectedConversations.length} 条对话` }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '标签更新失败', message: '无法添加标签' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations, selectedConversations, tagDraft]);

  const removeTagFromSelected = useCallback(async () => {
    const tagsToRemove = new Set(splitTags(tagDraft).map(tag => tag.toLowerCase()));
    if (!tagsToRemove.size || !selectedConversations.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(selectedConversations.map(async conv => {
        const tags = (conv.tags ?? []).filter(tag => !tagsToRemove.has(tag.toLowerCase()));
        await updateConversationMetadata(conv.id, { tags });
        dispatch(updateConversation({ id: conv.id, tags }));
      }));
      setTagDraft('');
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '标签已移除', message: `已更新 ${selectedConversations.length} 条对话` }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '标签更新失败', message: '无法移除标签' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations, selectedConversations, tagDraft]);

  const startRename = useCallback((id: string, title: string, event: MouseEvent) => {
    stop(event);
    setEditingId(id);
    setEditingTitle(title);
  }, []);

  const commitRename = useCallback(async (id: string, event?: MouseEvent) => {
    if (event) stop(event);
    const title = editingTitle.trim();
    if (!title) return;

    await renameConversation(id, title);
    dispatch(updateConversation({ id, title }));
    const cur = selectActiveConversation(store.getState());
    if (cur.id === id) {
      dispatch(setConversation({
        id,
        title,
        messages: cur.messages,
        model: cur.model,
        assistantRuns: cur.assistantRuns,
        fileSnapshots: cur.fileSnapshots,
        pendingDiffs: cur.pendingDiffs,
      }));
    }
    setEditingId(null);
    await refreshConversations();
  }, [editingTitle, refreshConversations, dispatch]);

  // ★ M7-F1：重新生成标题——对任意（尤其旧 fallback 标题的）对话手动重跑自动标题内核。
  //   loadConversationSnapshot 取首条 user 文本 → generateTitleFromText → renameConversation(systemTouch 不刷排序)
  //   + updateConversation 刷列表 + 当前对话则 setTitle 同步顶栏。各失败态 notification 反馈。
  const handleRegenerateTitle = useCallback(async (id: string, event: MouseEvent) => {
    stop(event);
    setRegenId(id);
    try {
      const snap = await loadConversationSnapshot(id);
      const firstUser = snap?.messages.find(m => m.role === 'user')?.content;
      const source = typeof firstUser === 'string' ? firstUser : '';
      if (!source.trim()) {
        dispatch(addNotification({ type: 'warning', title: '无法生成标题', message: '该对话首条没有可概括的文本' }));
        return;
      }
      const title = await generateTitleFromText(source, id);
      if (!title) {
        dispatch(addNotification({ type: 'error', title: '生成失败', message: '系统模型未返回标题，请检查模型配置' }));
        return;
      }
      await renameConversation(id, title, { systemTouch: true });
      dispatch(updateConversation({ id, title }));
      if (selectActiveConversation(store.getState()).id === id) dispatch(setTitle(title));
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '标题已更新', message: title }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '生成失败', message: '重新生成标题时出错' }));
    } finally {
      setRegenId(null);
    }
  }, [dispatch, refreshConversations]);

  // ★ M4-2-S6 改归属：经共享 hook 落库 + 回写 slice；若改的是当前打开对话，同步 store conversation.workspacePath
  //   使其内后续保存延续正确归属；随后 refresh 让当前范围视图即时剔除/纳入该条。
  const handleMoveConversation = useCallback(async (id: string, target: WorkspaceTarget) => {
    setMovingId(null);
    await moveToWorkspace(id, target);
    if (selectActiveConversation(store.getState()).id === id) {
      dispatch(setConversationWorkspace(target ?? null));
    }
    await refreshConversations();
  }, [moveToWorkspace, refreshConversations, dispatch]);

  const toggleMoveMenu = useCallback((id: string, event: MouseEvent) => {
    stop(event);
    setMovingId(prev => (prev === id ? null : id));
  }, []);

  // 点外关闭移动菜单（与 modelMenu 同口径的 mousedown 监听）。
  useEffect(() => {
    if (!movingId) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (moveMenuRef.current && !moveMenuRef.current.contains(e.target as Node)) {
        setMovingId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [movingId]);

  return (
    <div className="conversation-list">
      <div className="conversation-list-header">
        <h3><MessageSquare size={14} /> 对话历史</h3>
        <div className="conv-header-actions">
          <button className={`conv-icon-btn glass-panel ${isBulkMode ? 'active' : ''}`} onClick={toggleBulkMode} title="批量管理">
            {isBulkMode ? <CheckSquare size={16} /> : <Square size={16} />}
          </button>
          <button className="conv-icon-btn glass-panel" onClick={() => void handleNewConversation()} title="新建对话">
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="conv-search-bar">
        <Search size={14} className="conv-search-icon" />
        <input
          type="text"
          className="conv-search-input"
          placeholder="搜索对话..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {searchQuery && (
          <button className="conv-search-clear" onClick={() => setSearchQuery('')} title="清空搜索">
            <X size={12} />
          </button>
        )}
      </div>

      {/* ★ M4-2-S6 工作区范围切换器：显著可见，默认「当前工作区」，对冲老用户「对话不见了」恐慌。 */}
      <div className="conv-scope-row" title="按所属工作区过滤对话">
        <Globe size={12} className="conv-scope-icon" />
        <div className="conv-scope-tabs">
          <button
            className={`conv-scope-tab ${scope === 'current' ? 'active' : ''}`}
            onClick={() => setScope('current')}
            title="只显当前工作区的对话"
          >
            当前
          </button>
          <button
            className={`conv-scope-tab ${scope === 'global' ? 'active' : ''}`}
            onClick={() => setScope('global')}
            title="只显无归属（全局）的对话"
          >
            全局
          </button>
          <button
            className={`conv-scope-tab ${scope === 'all' ? 'active' : ''}`}
            onClick={() => setScope('all')}
            title="显示全部对话"
          >
            全部
          </button>
        </div>
      </div>

      <div className="conv-filter-row">
        <select className="conv-filter-select" value={archiveFilter} onChange={(event) => setArchiveFilter(event.target.value as ArchiveFilter)}>
          <option value="active">未归档</option>
          <option value="archived">已归档</option>
          <option value="all">全部</option>
        </select>
        <div className="conv-tag-filter">
          <Tags size={12} />
          <input
            value={tagFilter}
            onChange={(event) => setTagFilter(event.target.value)}
            placeholder="标签过滤"
          />
        </div>
      </div>

      {isBulkMode && (
        <div className="conv-bulk-toolbar glass-panel">
          <div className="conv-bulk-topline">
            <button className="conv-small-btn" onClick={toggleSelectVisible} disabled={conversations.length === 0}>
              {allVisibleSelected ? '取消全选' : '全选当前'}
            </button>
            <span>{selectedIds.length} 已选</span>
            <button className="conv-small-btn" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>清空</button>
          </div>
          <div className="conv-bulk-actions">
            <button className="conv-small-btn" onClick={() => void handleBulkExport()} disabled={!selectedIds.length || bulkBusy}>
              <Download size={12} /> 导出
            </button>
            <button className="conv-small-btn" onClick={() => void setArchivedForIds(selectedIds, true)} disabled={!selectedIds.length || bulkBusy}>
              <Archive size={12} /> 归档
            </button>
            <button className="conv-small-btn" onClick={() => void setArchivedForIds(selectedIds, false)} disabled={!selectedIds.length || bulkBusy}>
              <ArchiveRestore size={12} /> 还原
            </button>
            <button className="conv-small-btn danger" onClick={() => void handleBulkDelete()} disabled={!selectedIds.length || bulkBusy}>
              <Trash2 size={12} /> 删除
            </button>
          </div>
          <div className="conv-bulk-tags">
            <input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              placeholder="标签，逗号分隔"
            />
            <button className="conv-small-btn" onClick={() => void addTagToSelected()} disabled={!selectedIds.length || !tagDraft.trim() || bulkBusy}>添加</button>
            <button className="conv-small-btn" onClick={() => void removeTagFromSelected()} disabled={!selectedIds.length || !tagDraft.trim() || bulkBusy}>移除</button>
          </div>
        </div>
      )}

      <div className="conversation-list-items">
        {conversations.length === 0 ? (
          <div className="conv-empty">
            <MessageSquare size={32} style={{ opacity: 0.3 }} />
            <p>{isLoading ? '正在读取对话...' : searchQuery || tagFilter ? '未找到匹配的对话' : '暂无历史对话'}</p>
            {!searchQuery && !tagFilter && <p className="conv-hint">发送消息后，对话将自动保存</p>}
          </div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={`conv-item glass-panel ${selectedId === conv.id ? 'active' : ''} ${selectedSet.has(conv.id) ? 'selected' : ''}`}
              onClick={() => handleItemClick(conv)}
              onDoubleClick={() => !isBulkMode && void handleSwitchConversation(conv.id)}
            >
              {isBulkMode ? (
                <button
                  className="conv-select-btn"
                  onClick={(event) => toggleSelected(conv.id, event)}
                  title={selectedSet.has(conv.id) ? '取消选择' : '选择'}
                >
                  {selectedSet.has(conv.id) ? <CheckSquare size={15} /> : <Square size={15} />}
                </button>
              ) : (
                <div className="conv-item-icon">
                  <MessageSquare size={14} />
                </div>
              )}
              <div className="conv-item-info">
                {editingId === conv.id ? (
                  <input
                    className="conv-title-input"
                    value={editingTitle}
                    autoFocus
                    onClick={stop}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onBlur={() => void commitRename(conv.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitRename(conv.id);
                      if (event.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <div className="conv-item-title" title={conv.title}>{conv.title}</div>
                )}
                <div className="conv-item-preview">{conv.lastMessage}</div>
                {(conv.archived || Boolean(conv.tags?.length)) && (
                  <div className="conv-tags">
                    {conv.archived && <span className="conv-tag archived">已归档</span>}
                    {(conv.tags ?? []).slice(0, 3).map(tag => <span key={tag} className="conv-tag">{tag}</span>)}
                    {(conv.tags?.length ?? 0) > 3 && <span className="conv-tag muted">+{(conv.tags?.length ?? 0) - 3}</span>}
                  </div>
                )}
                <div className="conv-item-meta">
                  <span>{conv.messageCount} 条消息</span>
                  <span>{new Date(conv.timestamp).toLocaleDateString('zh-CN')}</span>
                  {/* ★ M4-2-S6 所属工作区小标记：有 path 显 basename，无归属显「全局」。 */}
                  <span
                    className={`conv-ws-badge ${conv.workspacePath ? '' : 'global'}`}
                    title={conv.workspacePath ? conv.workspacePath : '全局对话（无工作区归属）'}
                  >
                    {conv.workspacePath ? <FolderInput size={9} /> : <Globe size={9} />}
                    {workspaceLabel(conv.workspacePath)}
                  </span>
                </div>
              </div>
              <div className="conv-item-actions">
                <button
                  className="conv-item-action"
                  onClick={(event) => editingId === conv.id ? void commitRename(conv.id, event) : startRename(conv.id, conv.title, event)}
                  title={editingId === conv.id ? '保存标题' : '编辑标题'}
                >
                  {editingId === conv.id ? <Check size={12} /> : <Edit3 size={12} />}
                </button>
                {/* ★ M7-F1 重新生成标题：对旧 fallback 标题的对话用 AI 重拟语义标题（系统模型）。 */}
                <button
                  className="conv-item-action"
                  disabled={regenId === conv.id}
                  onClick={(event) => void handleRegenerateTitle(conv.id, event)}
                  title="重新生成标题（AI）"
                >
                  <Sparkles size={12} className={regenId === conv.id ? 'spin' : ''} />
                </button>
                {/* ★ M4-2-S6「移动到…」：改对话工作区归属。点开内联菜单选 全局 / 当前工作区 / 历史工作区。 */}
                <button
                  className={`conv-item-action ${movingId === conv.id ? 'active' : ''}`}
                  onClick={(event) => toggleMoveMenu(conv.id, event)}
                  title="移动到工作区…"
                >
                  <FolderInput size={12} />
                </button>
                <button
                  className="conv-item-action"
                  onClick={(event) => void editSingleTags(conv, event)}
                  title="编辑标签"
                >
                  <Tags size={12} />
                </button>
                <button
                  className="conv-item-action"
                  onClick={(event) => {
                    stop(event);
                    void setArchivedForIds([conv.id], !conv.archived);
                  }}
                  title={conv.archived ? '取消归档' : '归档'}
                >
                  {conv.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                </button>
                <button
                  className="conv-item-action"
                  onClick={(event) => void handleExportConversation(conv.id, event)}
                  title="导出"
                >
                  <Download size={12} />
                </button>
                <button
                  className="conv-item-action danger"
                  onClick={(event) => void handleDeleteConversation(conv.id, event)}
                  title="删除"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {movingId === conv.id && (
                <div className="conv-move-menu glass-panel" ref={moveMenuRef} onClick={stop}>
                  <div className="conv-move-menu-title">移动到工作区</div>
                  <button
                    className={`conv-move-option ${!conv.workspacePath ? 'active' : ''}`}
                    onClick={() => void handleMoveConversation(conv.id, null)}
                  >
                    <Globe size={12} /> 全局（无归属）
                  </button>
                  {moveTargets.map(path => {
                    const pathKey = workspacePathKey(path);
                    const activeKey = workspacePathKey(conv.workspacePath);
                    const currentKey = workspacePathKey(workspaceCurrentPath);
                    return (
                      <button
                        key={pathKey}
                        className={`conv-move-option ${activeKey === pathKey ? 'active' : ''}`}
                        onClick={() => void handleMoveConversation(conv.id, path)}
                        title={path}
                      >
                        <FolderInput size={12} />
                        <span className="conv-move-option-label">{workspaceLabel(path)}</span>
                        {currentKey === pathKey && <small>当前</small>}
                      </button>
                    );
                  })}
                  {moveTargets.length === 0 && (
                    <div className="conv-move-empty">暂无可选工作区，先打开一个工作区</div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
