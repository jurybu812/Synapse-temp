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
import { initializeProviderCredentials } from '@/services/providerCredentials';
import { resolveProviderModel } from '@/services/providerModelRuntime';
import { confirmAction } from '@/services/confirmationCoordinator';

function App() {
  const dispatch = useAppDispatch();
  const providerCredentials = useAppSelector((s: RootState) => s.settings.providerCredentials);
  const apiEndpoints = useAppSelector((s: RootState) => s.settings.apiEndpoints);
  const currentModel = useAppSelector((s: RootState) => s.agentSettings.currentModel);
  const availableModels = useAppSelector((s: RootState) => s.agentSettings.availableModels);
  const connectionStatus = useAppSelector((s: RootState) => s.agentSettings.connectionStatus);
  const dirtyTabCount = useAppSelector((s: RootState) => s.editorTabs.tabs.filter(tab => tab.isDirty).length);
  useThemeEffect();
  const [onboarded, setOnboarded] = useState(() => {
    return localStorage.getItem('synapse_onboarded') === 'true';
  });
  const providerInitializedRef = useRef(false);
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
    </div>
  );
}

export default App;
