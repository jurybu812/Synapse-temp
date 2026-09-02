import { useState, useCallback, useEffect, useRef } from 'react';
import { FileCode, FolderOpen, FolderPlus, Sparkles, Clock, Trash2 } from 'lucide-react';
import { fileSystem, type Workspace } from '@/services/fileSystem';
import { useAppDispatch } from '@/store/hooks';
import { useAppSelector } from '@/store/hooks';
import { addNotification } from '@/store/slices/notifications';
import { clearWorkspace, openWorkspace, setRecentPaths } from '@/store/slices/workspace';
import { resetTabsToWelcome } from '@/store/slices/editorTabs';
import { setActiveView } from '@/store/slices/sidebar';
import { setSidebarVisible } from '@/store/slices/layout';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';
import type { RootState } from '@/store';
import { isElectron } from '@platform/index';
import { confirmAction, promptAction } from '@/services/confirmationCoordinator';
import { selectActiveConversation } from '@/store/slices/conversation';
import {
  getWorkspaceChangeBlockState,
  tryBeginWorkspacePickerPending,
  workspaceChangeBlockMessage,
} from '@/services/workspacePickerCoordinator';

type LegacyProductNarrative =
  | '\u4ea4\u4e92\u5f0f\u5b66\u4e60\u5e73\u53f0'
  | '\u8bfe\u7a0b'
  | '\u8bfe\u4ef6'
  | '\u6559\u5b66\u52a9\u624b';
type ProductCopyWithoutLegacy<T extends string> = T extends `${string}${LegacyProductNarrative}${string}` ? never : T;
type ProductCopy<T extends Record<string, string>> = { [K in keyof T]: ProductCopyWithoutLegacy<T[K]> };

function defineProductCopy<const T extends Record<string, string>>(copy: T & ProductCopy<T>): T {
  return copy;
}

const welcomeCopy = defineProductCopy({
  tagline: '可扩展的桌面编程智能体',
  newWorkspaceMessage: '输入一个便于识别的工程工作区名称。',
  newWorkspacePlaceholder: '例如：任务规划 CLI',
  deleteWorkspaceMessage: '这会移除 Synapse 中保存的工作区记录和内部缓存；外部文件夹里的原文件不会被删除。',
  openWorkspaceDesc: '选择代码库或任务文件夹',
  newWorkspaceDesc: '创建独立的工程任务空间',
  importFilesDesc: 'PDF / PPTX / DOCX / Markdown',
  agentTitle: '编程 Agent',
  agentDesc: '让 Agent 读取、修改并验证代码',
});

function workspacePathKey(workspacePath: string | null | undefined): string {
  return (workspacePath ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase();
}

function describeWorkspaceParent(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  const parent = segments.slice(0, -1).slice(-2).join('/');
  return parent ? `…/${parent}` : normalized;
}

type WorkspaceBridgeResult = {
  id: string;
  name: string;
  path: string;
  lastOpened?: number;
  last_opened?: number | null;
};

type WorkspaceSwitchBridge = (workspace: { id: string; name: string; path: string }) => Promise<WorkspaceBridgeResult | null>;

const recentWorkspaceButtonStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  padding: 0,
  textAlign: 'left',
  font: 'inherit',
  cursor: 'pointer',
};

function describeWorkspaceError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function toLocalWorkspace(workspace: WorkspaceBridgeResult, fallback?: Workspace): Workspace {
  return {
    id: workspace.id || fallback?.id || `ws_${Date.now()}`,
    name: workspace.name || fallback?.name || workspace.path,
    path: workspace.path,
    lastOpened: typeof workspace.lastOpened === 'number'
      ? workspace.lastOpened
      : typeof workspace.last_opened === 'number'
        ? workspace.last_opened * 1000
        : Date.now(),
  };
}

export function WelcomePage() {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const currentWorkspacePath = useAppSelector((s: RootState) => s.workspace.currentPath);
  const recentWorkspacePaths = useAppSelector((s: RootState) => s.workspace.recentPaths);
  const activeConversation = useAppSelector(selectActiveConversation);
  const allowWorkspaceChange = useCallback(() => {
    const blockState = getWorkspaceChangeBlockState(activeConversation);
    if (!blockState.blocked) return true;
    dispatch(addNotification({
      type: 'warning',
      title: '当前任务仍在运行',
      message: workspaceChangeBlockMessage(blockState),
    }));
    return false;
  }, [activeConversation, dispatch]);
  const [workspaces, setWorkspaces] = useState(fileSystem.getWorkspaces());
  const [dragging, setDragging] = useState(false);
  const [workspacePickerPending, setWorkspacePickerPending] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const workspacePickerPendingRef = useRef(false);
  const workspacePathRef = useRef<string | null>(currentWorkspacePath);
  workspacePathRef.current = currentWorkspacePath;

  useEffect(() => {
    const unsub = fileSystem.subscribe(() => {
      setWorkspaces([...fileSystem.getWorkspaces()]);
    });
    return () => { unsub(); };
  }, []);

  useEffect(() => {
    if (!isElectron || !window.synapse?.workspace) return;
    let cancelled = false;
    void window.synapse.workspace.recent(50).then(recent => {
      if (cancelled) return;
      const hydrated = recent.map(workspace => toLocalWorkspace(workspace));
      fileSystem.registerRecentWorkspaces(hydrated);
      dispatch(setRecentPaths(hydrated.map(workspace => workspace.path)));
    }).catch(error => {
      console.error('[WelcomePage] 恢复最近工作区失败:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const handleNewWorkspace = useCallback(async () => {
    if (workspacePickerPendingRef.current) return;
    if (!allowWorkspaceChange()) return;
    workspacePickerPendingRef.current = true;
    setWorkspacePickerPending(true);
    try {
    const ok = await resolveUnsavedTabs(tabs, '新建工作区');
    if (!ok) return;
    if (isElectron && window.synapse?.workspace) {
      try {
        const finishWorkspacePickerPending = tryBeginWorkspacePickerPending();
        if (!finishWorkspacePickerPending) return;
        try {
          const workspaceIntent = fileSystem.beginWorkspaceIntent();
          const startedWorkspacePath = workspacePathRef.current;
          const workspace: WorkspaceBridgeResult | null = await window.synapse.workspace.open();
          if (!workspace) return;
          if (
            !fileSystem.isWorkspaceIntentCurrent(workspaceIntent)
            || workspacePathKey(workspacePathRef.current) !== workspacePathKey(startedWorkspacePath)
          ) return;
          const localWorkspace = toLocalWorkspace(workspace);
          fileSystem.openExternalWorkspace(localWorkspace);
          dispatch(resetTabsToWelcome());
          dispatch(openWorkspace({ path: localWorkspace.path, name: localWorkspace.name }));
          dispatch(setActiveView('explorer'));
          dispatch(setSidebarVisible(true));
          dispatch(addNotification({ type: 'success', title: '工作区已就绪', message: localWorkspace.name }));
        } finally {
          finishWorkspacePickerPending();
        }
      } catch (error) {
        dispatch(addNotification({
          type: 'error',
          title: '新建工作区失败',
          message: describeWorkspaceError(error, '无法访问这个工作区目录'),
        }));
      }
      return;
    }
    const name = await promptAction({
      title: '新建工作区',
      message: welcomeCopy.newWorkspaceMessage,
      placeholder: welcomeCopy.newWorkspacePlaceholder,
    });
    const normalizedName = name?.trim();
    if (normalizedName) {
      const ws = fileSystem.createWorkspace(normalizedName);
      dispatch(resetTabsToWelcome());
      dispatch(openWorkspace({ path: ws.path, name: ws.name }));
      dispatch(setActiveView('explorer'));
      dispatch(setSidebarVisible(true));
      dispatch(addNotification({ type: 'success', title: '创建成功', message: `工作区「${normalizedName}」已创建` }));
    }
    } finally {
      workspacePickerPendingRef.current = false;
      setWorkspacePickerPending(false);
    }
  }, [allowWorkspaceChange, dispatch, tabs]);

  const handleSwitchWorkspace = useCallback(async (id: string) => {
    if (!allowWorkspaceChange()) return;
    try {
      const ok = await resolveUnsavedTabs(tabs, '切换工作区');
      if (!ok) return;
      const workspaceIntent = fileSystem.beginWorkspaceIntent();
      const startedWorkspacePath = workspacePathRef.current;
      const workspace = fileSystem.getWorkspaces().find(item => item.id === id);
      if (!workspace) {
        dispatch(addNotification({ type: 'warning', title: '切换工作区', message: '这个工作区记录已不存在' }));
        return;
      }

      let nextWorkspace = workspace;
      if (isElectron && window.synapse?.workspace) {
        const switchWorkspace = window.synapse.workspace.switch as unknown as WorkspaceSwitchBridge;
        const validatedWorkspace = await switchWorkspace({
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
        });
        if (!validatedWorkspace) {
          dispatch(addNotification({ type: 'warning', title: '切换工作区', message: '这个工作区记录已不存在' }));
          return;
        }
        if (
          !fileSystem.isWorkspaceIntentCurrent(workspaceIntent)
          || workspacePathKey(workspacePathRef.current) !== workspacePathKey(startedWorkspacePath)
        ) return;
        nextWorkspace = toLocalWorkspace(validatedWorkspace, workspace);
        fileSystem.openExternalWorkspace(nextWorkspace);
      } else {
        if (!fileSystem.isWorkspaceIntentCurrent(workspaceIntent)) return;
        fileSystem.switchWorkspace(id);
        nextWorkspace = fileSystem.getWorkspaces().find(item => item.id === id) ?? workspace;
      }

      dispatch(resetTabsToWelcome());
      dispatch(openWorkspace({ path: nextWorkspace.path, name: nextWorkspace.name }));
      dispatch(setActiveView('explorer'));
      dispatch(setSidebarVisible(true));
      dispatch(addNotification({ type: 'info', title: '切换工作区', message: nextWorkspace.name }));
    } catch (error) {
      dispatch(addNotification({
        type: 'error',
        title: '切换工作区失败',
        message: describeWorkspaceError(error, '无法访问这个工作区目录'),
      }));
    }
  }, [allowWorkspaceChange, dispatch, tabs]);

  const handleOpenWorkspace = useCallback(async () => {
    if (workspacePickerPendingRef.current) return;
    if (!allowWorkspaceChange()) return;
    workspacePickerPendingRef.current = true;
    setWorkspacePickerPending(true);
    try {
      const ok = await resolveUnsavedTabs(tabs, '打开工作区');
      if (!ok) return;
      if (isElectron && window.synapse?.workspace) {
        const finishWorkspacePickerPending = tryBeginWorkspacePickerPending();
        if (!finishWorkspacePickerPending) return;
        try {
          const workspaceIntent = fileSystem.beginWorkspaceIntent();
          const startedWorkspacePath = workspacePathRef.current;
          const workspace: WorkspaceBridgeResult | null = await window.synapse.workspace.open();
          if (workspace) {
            if (
              !fileSystem.isWorkspaceIntentCurrent(workspaceIntent)
              || workspacePathKey(workspacePathRef.current) !== workspacePathKey(startedWorkspacePath)
            ) return;
            const localWorkspace = toLocalWorkspace(workspace);
            fileSystem.openExternalWorkspace(localWorkspace);
            dispatch(resetTabsToWelcome());
            dispatch(openWorkspace({ path: localWorkspace.path, name: localWorkspace.name }));
            dispatch(setActiveView('explorer'));
            dispatch(setSidebarVisible(true));
            dispatch(addNotification({ type: 'success', title: '打开工作区', message: localWorkspace.name }));
          }
        } finally {
          finishWorkspacePickerPending();
        }
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      (input as any).webkitdirectory = true;
      input.onchange = async (event: any) => {
        try {
          const files = Array.from(event.target?.files || []) as File[];
          if (files.length === 0) return;
          const firstRelative = (files[0] as any).webkitRelativePath as string | undefined;
          const name = firstRelative?.split('/')[0] || '导入工作区';
          const workspace = fileSystem.createWorkspaceFromFiles(name, files);
          dispatch(resetTabsToWelcome());
          dispatch(openWorkspace({ path: workspace.path, name: workspace.name }));
          dispatch(setActiveView('explorer'));
          dispatch(setSidebarVisible(true));
          dispatch(addNotification({ type: 'success', title: '打开工作区', message: `已导入 ${files.length} 个文件` }));
        } catch (error) {
          dispatch(addNotification({
            type: 'error',
            title: '打开工作区失败',
            message: describeWorkspaceError(error, '无法导入这个工作区'),
          }));
        }
      };
      input.click();
    } catch (error) {
      dispatch(addNotification({
        type: 'error',
        title: '打开工作区失败',
        message: describeWorkspaceError(error, '无法访问这个工作区目录'),
      }));
    } finally {
      workspacePickerPendingRef.current = false;
      setWorkspacePickerPending(false);
    }
  }, [allowWorkspaceChange, dispatch, tabs]);

  const handleDeleteWorkspace = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const deletedWorkspace = fileSystem.getWorkspaces().find(workspace => workspace.id === id);
    if (!deletedWorkspace) return;
    const deletedWorkspacePathKey = workspacePathKey(deletedWorkspace.path);
    const deletingCurrentWorkspace = currentWorkspacePath
      ? workspacePathKey(currentWorkspacePath) === deletedWorkspacePathKey
      : false;
    if (deletingCurrentWorkspace && !allowWorkspaceChange()) return;
    if (deletingCurrentWorkspace) {
      const ok = await resolveUnsavedTabs(tabs, '删除当前工作区记录');
      if (!ok) return;
    }
    const confirmed = await confirmAction({
      title: '移除这个工作区？',
      message: welcomeCopy.deleteWorkspaceMessage,
      confirmLabel: '确认移除',
      tone: 'danger',
    });
    if (confirmed) {
      if (isElectron && window.synapse?.workspace) {
        const deleted = await window.synapse.workspace.delete({ id, path: deletedWorkspace.path });
        if (!deleted) {
          dispatch(addNotification({
            type: 'warning',
            title: '已移除本地旧记录',
            message: '主进程未找到对应的工作区记录；本地列表仍会清理，外部文件未受影响。',
          }));
        }
      }
      fileSystem.deleteWorkspace(id);
      dispatch(setRecentPaths(recentWorkspacePaths.filter(path => (
        workspacePathKey(path) !== deletedWorkspacePathKey
      ))));
      if (deletingCurrentWorkspace) {
        dispatch(resetTabsToWelcome());
        const current = fileSystem.getWorkspaces().find(w => w.id === fileSystem.getCurrentWorkspace());
        if (current) {
          dispatch(openWorkspace({ path: current.path, name: current.name }));
        } else {
          dispatch(clearWorkspace());
        }
      }
    }
  }, [allowWorkspaceChange, currentWorkspacePath, dispatch, recentWorkspacePaths, tabs]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.pptx,.docx,.md,.txt,.html,.htm';
    input.multiple = true;
    input.onchange = async (e: any) => {
      const files = Array.from(e.target?.files || []) as File[];
      if (files.length > 0) {
        await fileSystem.uploadFiles(files);
        dispatch(addNotification({ type: 'success', title: '导入成功', message: `已导入 ${files.length} 个文件` }));
      }
    };
    input.click();
  }, [dispatch]);

  // Drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await fileSystem.uploadFiles(files);
      dispatch(addNotification({ type: 'success', title: '上传成功', message: `已上传 ${files.length} 个文件` }));
    }
  }, [dispatch]);

  const recentWorkspaces = workspaces
    .slice()
    .sort((left, right) => right.lastOpened - left.lastOpened)
    .slice(0, 5);
  const duplicateWorkspaceNames = new Set(
    recentWorkspaces
      .filter((workspace, index, entries) => entries.some((entry, entryIndex) => (
        entryIndex !== index && entry.name === workspace.name
      )))
      .map(workspace => workspace.name),
  );

  return (
    <div
      ref={dropRef}
      className={`welcome-page ${dragging ? 'dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="welcome-hero">
        <div className="welcome-logo">
          <span className="welcome-emoji">🧠</span>
          <h1 className="welcome-brand">
            <span className="gradient-text">Synapse</span>
          </h1>
          <p className="welcome-tagline">{welcomeCopy.tagline}</p>
        </div>

        <div className="welcome-actions-grid">
          <WelcomeAction icon={FolderOpen} title="打开工作区" desc={workspacePickerPending ? '正在等待系统目录选择器…' : welcomeCopy.openWorkspaceDesc} accent="var(--syn-accent)" onClick={handleOpenWorkspace} disabled={workspacePickerPending} />
          <WelcomeAction icon={FolderPlus} title="新建工作区" desc={workspacePickerPending ? '正在等待系统目录选择器…' : welcomeCopy.newWorkspaceDesc} accent="var(--syn-primary-light)" onClick={handleNewWorkspace} disabled={workspacePickerPending} />
          <WelcomeAction icon={FileCode} title="导入文件" desc={welcomeCopy.importFilesDesc} accent="#10b981" onClick={handleImport} />
          <WelcomeAction icon={Sparkles} title={welcomeCopy.agentTitle} desc={welcomeCopy.agentDesc} accent="#f59e0b" onClick={() => {
            window.dispatchEvent(new CustomEvent('synapse:focus-agent-input'));
          }} />
        </div>

        <div className="welcome-recent">
          <h3 className="welcome-section-title">
            <Clock size={14} />
            <span>最近工作区</span>
          </h3>
          <div className="welcome-recent-list">
            {workspaces.length === 0 ? (
              <div className="welcome-recent-empty">
                <p>暂无最近打开的工作区</p>
              </div>
            ) : (
              recentWorkspaces.map(ws => (
                  <div
                    key={ws.id}
                    className="welcome-recent-item"
                  >
                    <button
                      type="button"
                      style={recentWorkspaceButtonStyle}
                      onClick={() => handleSwitchWorkspace(ws.id)}
                      aria-label={`打开工作区 ${ws.name}，路径 ${ws.path}`}
                      title={ws.path}
                    >
                      <FolderOpen size={16} />
                      <div className="recent-item-info">
                        <span className="recent-item-name">{ws.name}</span>
                        {duplicateWorkspaceNames.has(ws.name) && (
                          <span className="recent-item-path">{describeWorkspaceParent(ws.path)}</span>
                        )}
                        <span className="recent-item-time">{new Date(ws.lastOpened).toLocaleDateString()}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="recent-item-delete"
                      onClick={(event) => handleDeleteWorkspace(event, ws.id)}
                      title={`删除 ${ws.name}`}
                      aria-label={`删除工作区记录 ${ws.name}，路径 ${ws.path}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
            )}
          </div>
        </div>

        <div className="welcome-tips">
          <p>💡 将文件拖入窗口即可加入当前工作区</p>
          <p>🔑 前往<strong>设置 → AI</strong>连接 Provider 或配置 API Key</p>
          <p>⌨️ <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> 打开命令面板</p>
        </div>
      </div>

      {dragging && (
        <div className="welcome-drop-overlay">
          <div className="welcome-drop-icon">📂</div>
          <p>释放文件以导入</p>
        </div>
      )}
    </div>
  );
}

function WelcomeAction({ icon: Icon, title, desc, accent, onClick, disabled = false }: {
  icon: React.ElementType; title: string; desc: string; accent: string; onClick?: () => void; disabled?: boolean;
}) {
  return (
    <button className="welcome-action-card" style={{ '--action-accent': accent } as React.CSSProperties} onClick={onClick} disabled={disabled}>
      <Icon size={24} strokeWidth={1.5} />
      <span className="action-title">{title}</span>
      <span className="action-desc">{desc}</span>
    </button>
  );
}
