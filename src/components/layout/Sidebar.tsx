import { FolderTree, Brain, Search, Settings, FolderOpen, MessageSquare } from 'lucide-react';
import { FileTree } from '@/components/sidebar/FileTree';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { ConversationList } from '@/components/chat/ConversationList';
import { SynopsisPanel } from '@/components/sidebar/SynopsisPanel';
import { SearchPanel } from '@/components/sidebar/SearchPanel';
import { fileSystem, type FileNode } from '@/services/fileSystem';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { clearWorkspace, openWorkspace } from '@/store/slices/workspace';
import { openTab, resetTabsToWelcome } from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';
import { resolveEditorType } from '@/services/editorFileTypes';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { RootState } from '@/store';
import { isElectron } from '@platform/index';
import { selectActiveConversation } from '@/store/slices/conversation';
import {
  getWorkspaceChangeBlockState,
  tryBeginWorkspacePickerPending,
  workspaceChangeBlockMessage,
} from '@/services/workspacePickerCoordinator';

function workspacePathKey(workspacePath: string | null | undefined): string {
  return (workspacePath ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase();
}

function isVirtualWorkspacePath(workspacePath: string | null | undefined): boolean {
  return /^\/workspace(?:\/|$)/i.test((workspacePath ?? '').replace(/\\/g, '/'));
}

interface SidebarProps {
  activeView: string;
}

export function Sidebar({ activeView }: SidebarProps) {
  const dispatch = useAppDispatch();
  const workspace = useAppSelector((s: RootState) => s.workspace) as any;
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const activeConversation = useAppSelector(selectActiveConversation);
  const notifyWorkspaceChangeBlocked = useCallback(() => {
    const blockState = getWorkspaceChangeBlockState(activeConversation);
    if (!blockState.blocked) return false;
    dispatch(addNotification({
      type: 'warning',
      title: '当前任务仍在运行',
      message: workspaceChangeBlockMessage(blockState),
    }));
    return true;
  }, [activeConversation, dispatch]);
  // ★ 文件树最大展开深度（可调；改了会重新取树，深层目录立即生效——修 maxDepth=3 硬编码致深层空的 bug）。
  const fileTreeMaxDepth = useAppSelector((s: RootState) => ((s as any).settings?.fileTreeMaxDepth ?? 8) as number);
  const [fileTree, setFileTree] = useState<FileNode | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const demoWorkspaceLoadedRef = useRef(false);
  const workspaceClearedRef = useRef(false);
  const workspaceTreeRequestRef = useRef(0);
  const workspacePathRef = useRef<string | null>(workspace.currentPath);
  workspacePathRef.current = workspace.currentPath;

  const loadWorkspaceTree = useCallback(() => {
    const requestId = ++workspaceTreeRequestRef.current;
    const requestedWorkspacePath = workspace.currentPath;
    return fileSystem.getWorkspaceTree(undefined, fileTreeMaxDepth).then(tree => {
      if (
        requestId !== workspaceTreeRequestRef.current
        || workspacePathRef.current !== requestedWorkspacePath
      ) {
        return null;
      }
      setFileTree(tree);
      setWorkspaceError(null);
      return tree;
    }).catch((error: unknown) => {
      if (
        requestId !== workspaceTreeRequestRef.current
        || workspacePathRef.current !== requestedWorkspacePath
      ) {
        return null;
      }
      setFileTree(null);
      setWorkspaceError(error instanceof Error && error.message
        ? error.message
        : '当前工作区未获得读取授权');
      return null;
    });
  }, [fileTreeMaxDepth, workspace.currentPath]);

  const refreshTree = useCallback(() => {
    if (workspaceClearedRef.current) {
      setFileTree(null);
      setWorkspaceError(null);
      return;
    }
    void loadWorkspaceTree();
  }, [loadWorkspaceTree]);

  const handleOpenWorkspace = useCallback(async () => {
    if (notifyWorkspaceChangeBlocked()) return;
    try {
      const ok = await resolveUnsavedTabs(tabs, '打开工作区');
      if (!ok) return;
      if (isElectron && window.synapse?.workspace) {
        const finishWorkspacePickerPending = tryBeginWorkspacePickerPending();
        if (!finishWorkspacePickerPending) return;
        try {
          const workspaceIntent = fileSystem.beginWorkspaceIntent();
          const startedWorkspacePath = workspacePathRef.current;
          const ws = await window.synapse.workspace.open();
          if (!ws) return;
          if (
            !fileSystem.isWorkspaceIntentCurrent(workspaceIntent)
            || workspacePathKey(workspacePathRef.current) !== workspacePathKey(startedWorkspacePath)
          ) return;
          workspaceClearedRef.current = false;
          setWorkspaceError(null);
          fileSystem.openExternalWorkspace({ ...ws, lastOpened: Date.now() });
          dispatch(resetTabsToWelcome());
          dispatch(openWorkspace({ path: ws.path, name: ws.name }));
          dispatch(addNotification({ type: 'success', title: '打开工作区', message: ws.name }));
        } finally {
          finishWorkspacePickerPending();
        }
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      (input as any).webkitdirectory = true;
      input.onchange = async (e: Event) => {
        try {
          const target = e.target as HTMLInputElement | null;
          const files = Array.from(target?.files || []) as File[];
          if (files.length === 0) return;
          const firstRelative = (files[0] as any).webkitRelativePath as string | undefined;
          const name = firstRelative?.split('/')[0] || '导入工作区';
          workspaceClearedRef.current = false;
          setWorkspaceError(null);
          const ws = fileSystem.createWorkspaceFromFiles(name, files);
          dispatch(resetTabsToWelcome());
          dispatch(openWorkspace({ path: ws.path, name: ws.name }));
          dispatch(addNotification({ type: 'success', title: '打开工作区', message: `已导入 ${files.length} 个文件` }));
        } catch (err: any) {
          dispatch(addNotification({ type: 'error', title: '打开工作区失败', message: err?.message || '无法导入目录' }));
        }
      };
      input.click();
    } catch (err: any) {
      dispatch(addNotification({ type: 'error', title: '打开工作区失败', message: err?.message || '无法打开工作区' }));
    }
  }, [dispatch, notifyWorkspaceChangeBlocked, tabs]);

  const handleClearWorkspace = useCallback(async () => {
    if (notifyWorkspaceChangeBlocked()) return;
    const ok = await resolveUnsavedTabs(tabs, '清空工作区');
    if (!ok) return;
    workspaceClearedRef.current = true;
    fileSystem.clearLoadedWorkspace();
    demoWorkspaceLoadedRef.current = true;
    dispatch(clearWorkspace());
    dispatch(resetTabsToWelcome());
    setFileTree(null);
    setWorkspaceError(null);
    dispatch(addNotification({
      type: 'info',
      title: '已清空工作区',
      message: '仅卸载当前加载内容，未删除磁盘文件',
    }));
  }, [dispatch, notifyWorkspaceChangeBlocked, tabs]);

  // Load workspace on mount（★ 持久化恢复 / demo 兜底）
  useEffect(() => {
    if (activeView !== 'explorer' || demoWorkspaceLoadedRef.current) return;
    // ★ 工作区重启持久化恢复：重启后 Redux currentPath 已从 localStorage 恢复（非 null 且非 demo 假路径），
    //   但 fileSystem 内部根/文件树尚未同步——把真实工作区重新加载进 fileSystem，让左侧文件树 + 工具内部根对齐恢复值，
    //   而非空树或退回 demo。
    if (workspace.currentPath && !isVirtualWorkspacePath(workspace.currentPath)) {
      demoWorkspaceLoadedRef.current = true;
      if (isElectron) {
        fileSystem.openExternalWorkspace({ id: workspace.currentPath, name: workspace.name || '工作区', path: workspace.currentPath, lastOpened: Date.now() });
      }
      void loadWorkspaceTree();
      return;
    }
    // demo 兜底（从未打开过任何真实工作区）。
    // ★ 兜住历史已写坏的用户：旧版本会把 '/workspace' 占位 sentinel 落盘，重启恢复时它既非真实路径
    //   （第一分支不进）又非空（旧条件 !currentPath 也不进），示例文件树永久消失。把它一并视同未打开。
    if (!workspace.currentPath || isVirtualWorkspacePath(workspace.currentPath)) {
      demoWorkspaceLoadedRef.current = true;
      void loadWorkspaceTree().then(tree => {
        if (tree) dispatch(openWorkspace({ path: '/workspace', name: '示例工作区' }));
      });
    }
  }, [activeView, workspace.currentPath, workspace.name, dispatch, loadWorkspaceTree]);

  // Also load tree when workspace changes
  useEffect(() => {
    if (workspace.currentPath) {
      workspaceClearedRef.current = false;
      refreshTree();
    }
  }, [workspace.currentPath, refreshTree]);

  useEffect(() => {
    const unsub = fileSystem.subscribe(refreshTree);
    return () => { unsub(); };
  }, [refreshTree]);

  const handleFileClick = useCallback((node: FileNode) => {
    // Dispatch openTab to open the file in the editor
    const ext = (node.extension || '').replace(/^\./, ''); // 统一去掉点号
    dispatch(openTab({
      id: `tab-${Date.now()}`,
      filePath: node.path,
      fileName: node.name,
      isDirty: false,
      isPreview: true,
      type: resolveEditorType(ext),
    }));
  }, [dispatch]);

  const titles: Record<string, { icon: any; label: string }> = {
    explorer: { icon: FolderTree, label: '工作区文件' },
    synopsis: { icon: Brain, label: '工程概要' },
    search: { icon: Search, label: '代码与资料搜索' },
    history: { icon: MessageSquare, label: '对话历史' },
    settings: { icon: Settings, label: '设置' },
  };

  const current = titles[activeView] || titles.explorer;
  const Icon = current.icon;

  return (
    <div className="sidebar glass-panel">
      <div className="sidebar-header">
        <Icon size={16} />
        <span className="sidebar-title">{current.label}</span>
      </div>

      <div className="sidebar-content">
        {activeView === 'explorer' && fileTree ? (
          <FileTree
            root={fileTree}
            onFileClick={handleFileClick}
            onRefresh={refreshTree}
            onOpenWorkspace={handleOpenWorkspace}
            onClearWorkspace={handleClearWorkspace}
          />
        ) : activeView === 'explorer' && workspaceError ? (
          <div className="sidebar-placeholder workspace-recovery">
            <FolderOpen size={32} strokeWidth={1} aria-hidden="true" />
            <p>当前工作区需要重新授权</p>
            <small title={workspaceError}>
              安全策略已阻止未登记的历史路径，请重新选择同一文件夹继续使用
            </small>
            <button type="button" className="workspace-recovery-action" onClick={() => void handleOpenWorkspace()}>
              重新选择工作区
            </button>
          </div>
        ) : activeView === 'explorer' ? (
          <div className="sidebar-placeholder">
            <FolderOpen size={32} strokeWidth={1} style={{ opacity: 0.3 }} />
            <p>打开工作区以查看文件</p>
          </div>
        ) : activeView === 'synopsis' ? (
          <SynopsisPanel />
        ) : activeView === 'search' ? (
          <SearchPanel />
        ) : activeView === 'settings' ? (
          <SettingsPanel />
        ) : activeView === 'history' ? (
          <ConversationList />
        ) : null}
      </div>
    </div>
  );
}
