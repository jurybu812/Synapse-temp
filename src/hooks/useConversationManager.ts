/**
 * useConversationManager — 对话管理共享 hook（M4-2-S6 / S7）
 *
 * 左侧栏 ConversationList（S6）与右侧栏 AgentPanel 顶部对话浮层（S7）共用此 hook，
 * 保证两栏【同一数据源】（conversationHistory slice 的 conversations + selectedId）与
 * 【同一套工作区范围过滤口径】（三态：当前工作区 / Global / 全部）。
 *
 * ★ 保守抽取路线（Plan_5 M4-2 第七节决议 #5）：本 hook 只承载
 *   - 数据：读 conversations / selectedId / 当前工作区 path+name；
 *   - 过滤：工作区范围 scope 三态 ↔ ConversationListFilters(workspacePath/globalOnly) 映射；
 *   - 基础动作：refresh（按合并 filters 拉取并写回 slice）、moveToWorkspace（改单条归属并落库）。
 *
 *   【刻意不抽】敏感的「切换竞态闸门」（beginConversationSwitch/endConversationSwitch）与
 *   「worktree exit」——它们与各组件已稳定的 save/clear/load 逻辑强耦合（M2-6 竞态修复），
 *   抽走有破坏风险。switch / new 仍由左右栏各自持有自己那份带闸门的实现，
 *   但都读本 hook 的 conversations/selectedId，切换后两栏选中态天然同步。
 */
import { useCallback, useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  setConversations,
  updateConversation,
  type ConversationSummary,
} from '@/store/slices/conversationHistory';
import { addNotification } from '@/store/slices/notifications';
import {
  listConversationSummaries,
  updateConversationMetadata,
  type ConversationListFilters,
} from '@/services/conversationPersistence';

/**
 * 工作区范围三态：
 *   - 'current'：只显当前打开工作区的对话（无工作区打开时退化为 Global 视图，见 scopeFilters）。
 *   - 'global' ：只显无归属（workspace_path IS NULL）的「全局对话」。
 *   - 'all'    ：不加 workspace 条件，显示全部对话。
 */
export type WorkspaceScope = 'current' | 'global' | 'all';

/** 工作区目标：null = Global（无归属）；具体 path = 归属该工作区。 */
export type WorkspaceTarget = string | null;

/** path → 末段 basename（显示用）。兼容 Windows `\` 与 POSIX `/` 分隔符。 */
export function workspaceBasename(path: string | null | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  const seg = trimmed.split(/[\\/]/).pop();
  return seg || trimmed;
}

/** 对话归属的人类可读标签：有 path 显 basename，否则显「全局」。 */
export function workspaceLabel(path: string | null | undefined): string {
  return path ? workspaceBasename(path) : '全局';
}

export interface UseConversationManagerResult {
  // 数据源（左右栏共享）
  conversations: ConversationSummary[];
  selectedId: string | null;
  // 当前工作区
  workspaceCurrentPath: string | null;
  workspaceName: string;
  recentPaths: string[];
  // 工作区范围过滤
  scope: WorkspaceScope;
  setScope: (scope: WorkspaceScope) => void;
  /** 把 scope 翻译成 ConversationListFilters 的 workspace 维度（供调用方与自身过滤合并）。 */
  scopeFilters: Pick<ConversationListFilters, 'workspacePath' | 'globalOnly'>;
  // 动作
  /** 按传入 filters 拉取摘要并写回 conversationHistory slice（失败弹 toast）。 */
  refresh: (filters: ConversationListFilters) => Promise<void>;
  /** 改单条对话归属并落库 + 即时回写 slice（target=null → 改归 Global）。 */
  moveToWorkspace: (id: string, target: WorkspaceTarget) => Promise<void>;
}

export function useConversationManager(): UseConversationManagerResult {
  const dispatch = useAppDispatch();
  const conversations = useAppSelector((s) => s.conversationHistory.conversations);
  const selectedId = useAppSelector((s) => s.conversationHistory.selectedId);
  const workspaceCurrentPath = useAppSelector((s) => s.workspace.currentPath);
  const workspaceName = useAppSelector((s) => s.workspace.name);
  const recentPaths = useAppSelector((s) => s.workspace.recentPaths);

  // ★ S6 决议 #3：默认「当前工作区」凸显归属感。未打开工作区时（current 退化为 global）也是合理初值。
  const [scope, setScope] = useState<WorkspaceScope>('current');

  // scope → workspace 过滤维度。'current' 且确有打开工作区 → 具体 path；
  //   'current' 但未打开工作区 → 退化为 globalOnly（只显无归属，等价 Global 视图，避免传空 path 变成「全部」）；
  //   'global' → globalOnly；'all' → 都不传（不限）。
  const scopeFilters = useMemo<Pick<ConversationListFilters, 'workspacePath' | 'globalOnly'>>(() => {
    if (scope === 'all') return {};
    if (scope === 'global') return { globalOnly: true };
    // scope === 'current'
    if (workspaceCurrentPath) return { workspacePath: workspaceCurrentPath };
    return { globalOnly: true };
  }, [scope, workspaceCurrentPath]);

  const refresh = useCallback(async (filters: ConversationListFilters) => {
    try {
      const summaries = await listConversationSummaries(filters);
      dispatch(setConversations(summaries));
    } catch {
      dispatch(addNotification({ type: 'error', title: '加载失败', message: '无法读取对话历史' }));
    }
  }, [dispatch]);

  const moveToWorkspace = useCallback(async (id: string, target: WorkspaceTarget) => {
    try {
      await updateConversationMetadata(id, { workspacePath: target ?? null });
      // 即时回写 slice，使当前过滤视图（如 current/global）即时反映归属变化（不属于当前过滤范围的条目会被下次 refresh 移除）。
      dispatch(updateConversation({ id, workspacePath: target ?? null }));
      dispatch(addNotification({
        type: 'info',
        title: '已移动',
        message: `对话已移动到「${workspaceLabel(target)}」`,
      }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '移动失败', message: '无法更改对话归属' }));
    }
  }, [dispatch]);

  return {
    conversations,
    selectedId,
    workspaceCurrentPath,
    workspaceName,
    recentPaths,
    scope,
    setScope,
    scopeFilters,
    refresh,
    moveToWorkspace,
  };
}
