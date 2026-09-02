import '@/styles/layout.css';
import '@/styles/fileTree.css';
import '@/styles/chat.css';
import '@/styles/settings.css';
import '@/styles/editor.css';
import '@/styles/ui.css';
import '@/styles/conversationList.css';
import '@/styles/components.css';
import '@/styles/wizard.css';
import '@/styles/richInput.css';
import { AppLayout } from '@components/layout/AppLayout';
import { useThemeEffect } from '@/hooks/useThemeEffect';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FirstUseWizard } from '@/components/settings/FirstUseWizard';
import { WindowTitleBar } from '@/components/layout/WindowTitleBar';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setConnectionStatus } from '@/store/slices/agentSettings';
import type { RootState } from '@/store';
import { ConfirmationDialogHost } from '@/components/ui/ConfirmationDialogHost';
import { ApprovalDialogHost } from '@/components/ui/ApprovalDialogHost';
import { initializeProviderCredentials } from '@/services/providerCredentials';
import { resolveProviderModel } from '@/services/providerModelRuntime';
import { confirmAction } from '@/services/confirmationCoordinator';
import { desktopBridgeState } from '@/platform';
import { WifiOff } from 'lucide-react';
import { fileSystem } from '@/services/fileSystem';
import { addNotification } from '@/store/slices/notifications';
import { clearWorkspace, openWorkspace, setRecentPaths } from '@/store/slices/workspace';
import { waitForWorkspacePickerIdle } from '@/services/workspacePickerCoordinator';

function isVirtualWorkspacePath(workspacePath: string): boolean {
  return /^\/workspace(?:\/|$)/i.test(workspacePath.replace(/\\/g, '/'));
}

function workspacePathKey(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function workspacePathName(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? workspacePath;
}

type WorkspaceRestoreSwitchBridge = (workspace: {
  id: string;
  name: string;
  path: string;
  restore: true;
}) => Promise<{ id: string; name: string; path: string; last_opened?: number | null } | null>;

function ReadyApplication() {
  const dispatch = useAppDispatch();
  const providerCredentials = useAppSelector((s: RootState) => s.settings.providerCredentials);
  const apiEndpoints = useAppSelector((s: RootState) => s.settings.apiEndpoints);
  const currentModel = useAppSelector((s: RootState) => s.agentSettings.currentModel);
  const availableModels = useAppSelector((s: RootState) => s.agentSettings.availableModels);
  const connectionStatus = useAppSelector((s: RootState) => s.agentSettings.connectionStatus);
  const dirtyTabCount = useAppSelector((s: RootState) => s.editorTabs.tabs.filter(tab => tab.isDirty).length);
  const workspacePath = useAppSelector((s: RootState) => s.workspace.currentPath);
  const workspaceName = useAppSelector((s: RootState) => s.workspace.name);
  const workspaceRecentPaths = useAppSelector((s: RootState) => s.workspace.recentPaths);
  useThemeEffect();
  const [onboarded, setOnboarded] = useState(() => {
    return localStorage.getItem('synapse_onboarded') === 'true';
  });
  const providerInitializedRef = useRef(false);
  const workspaceHydrationKeyRef = useRef<string | null>(null);
  const workspacePathRef = useRef<string | null>(workspacePath);
  workspacePathRef.current = workspacePath;
  const [providerInitAttempt, setProviderInitAttempt] = useState(0);
  const providerConfigured = useMemo(() => {
    if (!currentModel) return Object.values(providerCredentials ?? {}).some(status => status.configured);
    return resolveProviderModel(currentModel, availableModels, providerCredentials, apiEndpoints).configured;
  }, [apiEndpoints, availableModels, currentModel, providerCredentials]);

  useEffect(() => {
    if (providerInitializedRef.current) return;
    providerInitializedRef.current = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    void initializeProviderCredentials(dispatch, apiEndpoints).catch((error) => {
      console.error('[App] Provider 初始化失败:', error);
      providerInitializedRef.current = false;
      dispatch(setConnectionStatus('failed'));
      if (providerInitAttempt < 2) {
        retryTimer = setTimeout(() => setProviderInitAttempt(attempt => attempt + 1), 1000 * (2 ** providerInitAttempt));
      }
    });
    return () => {
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [dispatch, apiEndpoints, providerInitAttempt]);

  useEffect(() => {
    if (!providerConfigured && connectionStatus !== 'missing') {
      dispatch(setConnectionStatus('missing'));
      return;
    }
    if (providerConfigured && (connectionStatus === 'unknown' || connectionStatus === 'missing')) {
      dispatch(setConnectionStatus('configured'));
    }
  }, [providerConfigured, connectionStatus, dispatch]);

  useEffect(() => {
    if (!workspacePath) return;
    const hydrationKey = `${workspacePath}\n${workspaceName}`;
    if (workspaceHydrationKeyRef.current === hydrationKey) return;
    workspaceHydrationKeyRef.current = hydrationKey;
    const workspaceGeneration = fileSystem.beginWorkspaceTransition();
    let cancelled = false;
    const isCurrentWorkspaceRestore = () => (
      !cancelled
      && fileSystem.isWorkspaceTransitionCurrent(workspaceGeneration)
      && workspacePathKey(workspacePathRef.current || '') === workspacePathKey(workspacePath)
    );

    const localWorkspace = fileSystem.getWorkspaces().find(
      workspace => workspacePathKey(workspace.path) === workspacePathKey(workspacePath),
    );
    const requestedWorkspace = {
      id: localWorkspace?.id ?? `restored:${workspacePath}`,
      name: workspaceName || localWorkspace?.name || workspacePath,
      path: workspacePath,
    };
    const hydrate = (
      workspace: { id: string; name: string; path: string; last_opened?: number | null },
      staleWorkspaceId?: string,
    ) => {
      if (!isCurrentWorkspaceRestore()) return;
      if (staleWorkspaceId && staleWorkspaceId !== workspace.id) {
        fileSystem.deleteWorkspace(staleWorkspaceId);
      }
      fileSystem.openExternalWorkspace({
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        lastOpened: typeof workspace.last_opened === 'number' ? workspace.last_opened * 1000 : Date.now(),
      });
      if (workspace.path !== workspacePath || workspace.name !== workspaceName) {
        const canonicalKey = `${workspace.path}\n${workspace.name}`;
        workspaceHydrationKeyRef.current = canonicalKey;
        dispatch(openWorkspace({ path: workspace.path, name: workspace.name }));
        dispatch(setRecentPaths([
          workspace.path,
          ...workspaceRecentPaths.filter(path => (
            path !== workspacePath && workspacePathKey(path) !== workspacePathKey(workspace.path)
          )),
        ].slice(0, 10)));
      }
    };

    if (desktopBridgeState === 'ready' && window.synapse?.workspace) {
      const workspaceBridge = window.synapse.workspace;
      const restoreWorkspace = async () => {
        let candidate = requestedWorkspace;
        let staleWorkspaceId: string | undefined;
        if (isVirtualWorkspacePath(workspacePath)) {
          const recent = await workspaceBridge.recent(50);
          const expectedName = workspaceName || workspacePathName(workspacePath);
          const persistedRealPathKeys = new Set(
            workspaceRecentPaths
              .filter(path => !isVirtualWorkspacePath(path))
              .map(workspacePathKey),
          );
          const recentWithName = recent.filter(workspace => (
            workspace?.path
            && !isVirtualWorkspacePath(workspace.path)
            && (workspace.name === expectedName || workspacePathName(workspace.path) === expectedName)
          ));
          const persistedMatches = recentWithName.filter(workspace => (
            persistedRealPathKeys.has(workspacePathKey(workspace.path))
          ));
          const recovered = persistedMatches.length === 1
            ? persistedMatches[0]
            : recentWithName.length === 1
              ? recentWithName[0]
              : null;
          if (!recovered) throw new Error('上次工作区是旧版虚拟路径，请重新选择真实文件夹');
          candidate = { id: recovered.id, name: recovered.name, path: recovered.path };
          staleWorkspaceId = localWorkspace?.id;
        }
        const switchWorkspace = workspaceBridge.switch as WorkspaceRestoreSwitchBridge;
        const workspace = await switchWorkspace({ ...candidate, restore: true });
        if (!workspace) throw new Error('工作区记录已不存在');
        if (!await waitForWorkspacePickerIdle(isCurrentWorkspaceRestore)) return;
        hydrate(workspace, staleWorkspaceId);
      };
      void restoreWorkspace().catch(async error => {
          if (!await waitForWorkspacePickerIdle(isCurrentWorkspaceRestore)) return;
          if (localWorkspace && isVirtualWorkspacePath(localWorkspace.path)) {
            fileSystem.deleteWorkspace(localWorkspace.id);
          }
          fileSystem.clearLoadedWorkspace();
          dispatch(clearWorkspace());
          dispatch(setRecentPaths(workspaceRecentPaths.filter(path => (
            workspacePathKey(path) !== workspacePathKey(workspacePath)
          ))));
          dispatch(addNotification({
            type: 'error',
            title: '恢复工作区失败',
            message: error instanceof Error ? error.message : '上次工作区当前不可访问，请重新选择目录',
          }));
        });
      return () => {
        cancelled = true;
      };
    }
    hydrate(requestedWorkspace);
    return () => {
      cancelled = true;
    };
  }, [dispatch, workspaceName, workspacePath, workspaceRecentPaths]);

  useEffect(() => {
    window.synapse?.window.setDirty?.(dirtyTabCount > 0);
    return () => window.synapse?.window.setDirty?.(false);
  }, [dirtyTabCount]);

  useEffect(() => window.synapse?.window.onCloseRequested?.(payload => {
    const verb = payload.action === 'close' ? '关闭 Synapse' : '刷新页面';
    void confirmAction({
      title: '存在未保存的修改',
      message: `${verb}会丢失尚未保存的编辑内容，确定要继续吗？`,
      confirmLabel: payload.action === 'close' ? '仍然关闭' : '仍然刷新',
      cancelLabel: '返回编辑',
      tone: 'danger',
    }).then(confirmed => {
      if (confirmed) window.synapse?.window.confirmClose?.(payload.requestId);
      else window.synapse?.window.cancelClose?.(payload.requestId);
    });
  }), []);

  return (
    <div className="app-frame">
      <div className="app-background" />
      <WindowTitleBar />
      {onboarded
        ? <AppLayout />
        : <FirstUseWizard onComplete={() => {
          localStorage.setItem('synapse_onboarded', 'true');
          setOnboarded(true);
        }} />}
      <ConfirmationDialogHost />
      <ApprovalDialogHost />
    </div>
  );
}

function App() {
  if (desktopBridgeState === 'degraded') {
    return (
      <div className="app-frame">
        <div className="app-background" />
        <WindowTitleBar />
        <main className="desktop-bridge-blocked" role="alert">
          <WifiOff size={30} />
          <h1>桌面组件版本不一致</h1>
          <p>Synapse 检测到主进程、桌面桥接和界面不是同一次构建，请完全退出后重新打开，避免工作区、凭据或窗口操作落入网页模拟状态。</p>
        </main>
      </div>
    );
  }

  return <ReadyApplication />;
}

export default App;
