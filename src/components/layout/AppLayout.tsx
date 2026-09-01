import { Panel, Group, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { ActivityBar } from './ActivityBar';
import { Sidebar } from './Sidebar';
import { EditorArea } from './EditorArea';
import { AgentPanel } from './AgentPanel';
import { BottomPanel } from './BottomPanel';
import { StatusBar } from './StatusBar';
import { ToastContainer } from '@/components/ui/Toast';
import { CommandPalette, useDefaultCommands } from '@/components/ui/CommandPalette';
import { QuickOpen } from '@/components/ui/QuickOpen';
import { PanelRightOpen } from 'lucide-react';
import { openTab } from '@/store/slices/editorTabs';
import { useShortcuts } from '@/hooks/useShortcuts';
import { useState, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { toggleAgentPanel, toggleSidebar, setSidebarVisible } from '@/store/slices/layout';
import { setActiveView } from '@/store/slices/sidebar';
import { setThemeMode } from '@/store/slices/theme';
import { addNotification } from '@/store/slices/notifications';
import { resolveEditorType } from '@/services/editorFileTypes';
import type { RootState } from '@/store';

export function AppLayout() {
  const dispatch = useAppDispatch();
  const sidebarVisible = useAppSelector((s: RootState) => s.layout.sidebarVisible);
  const agentPanelVisible = useAppSelector((s: RootState) => s.layout.agentPanelVisible);
  const activeView = useAppSelector((s: RootState) => s.sidebar.activeView);
  const themeMode = useAppSelector((s: RootState) => s.theme.mode);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const sidebarPanelRef = usePanelRef();
  const bottomPanelRef = usePanelRef();
  const agentPanelRef = usePanelRef();

  const mainLayout = useDefaultLayout({
    id: 'synapse-main-v3',
    storage: localStorage,
  });

  const verticalLayout = useDefaultLayout({
    id: 'synapse-vertical-v3',
    storage: localStorage,
  });

  const openSettings = useCallback(() => {
    dispatch(setActiveView('settings'));
    dispatch(setSidebarVisible(true));
  }, [dispatch]);

  const resizePanelFromKeyboard = useCallback((
    event: React.KeyboardEvent<HTMLDivElement>,
    panelRef: ReturnType<typeof usePanelRef>,
    increaseKey: string,
    decreaseKey: string,
  ) => {
    if (event.key !== increaseKey && event.key !== decreaseKey) return;
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 48 : 24;
    const current = panel.getSize().inPixels;
    panel.resize(`${Math.max(34, current + (event.key === increaseKey ? step : -step))}px`);
  }, []);

  const handleActivityClick = useCallback((view: string) => {
    if (activeView === view && sidebarVisible) {
      dispatch(toggleSidebar());
    } else {
      dispatch(setActiveView(view as 'explorer' | 'synopsis' | 'search' | 'settings'));
      dispatch(setSidebarVisible(true));
    }
  }, [activeView, sidebarVisible, dispatch]);

  // 命令面板预定义命令
  const commands = useDefaultCommands({
    toggleSidebar: () => dispatch(toggleSidebar()),
    toggleTheme: () => dispatch(setThemeMode(themeMode === 'dark' ? 'light' : 'dark')),
    openSettings,
    newFile: () => dispatch(addNotification({ type: 'info', title: '新建文件', message: '功能开发中' })),
    openWorkspace: () => dispatch(addNotification({ type: 'info', title: '打开工作区', message: '功能开发中' })),
  });

  // 全局快捷键
  useShortcuts([
    { key: 'b', ctrl: true, description: '切换侧边栏', action: () => dispatch(toggleSidebar()) },
    { key: 'p', ctrl: true, shift: true, description: '命令面板', action: () => setCmdPaletteOpen(true) },
    { key: 'p', ctrl: true, description: '快速打开文件', action: () => setQuickOpenOpen(true) },
    { key: ',', ctrl: true, description: '打开设置', action: openSettings },
  ]);

  return (
    <div className="app-shell">
      <div className="app-layout">
        <ActivityBar
          activeView={activeView}
          onViewClick={handleActivityClick}
        />
        <Group
          orientation="horizontal"
          className="main-panel-group"
          defaultLayout={mainLayout.defaultLayout}
          onLayoutChanged={mainLayout.onLayoutChanged}
        >
          {sidebarVisible && (
            <>
              <Panel
                panelRef={sidebarPanelRef}
                defaultSize="18%"
                minSize="150px"
                maxSize="30%"
                collapsible
                id="sidebar"
              >
                <Sidebar activeView={activeView} />
              </Panel>
              <Separator
                className="resize-handle resize-handle-horizontal"
                aria-label="调整文件侧栏宽度"
                onKeyDown={event => resizePanelFromKeyboard(event, sidebarPanelRef, 'ArrowRight', 'ArrowLeft')}
              />
            </>
          )}
          <Panel defaultSize="47%" minSize="25%" id="editor">
            <Group
              orientation="vertical"
              defaultLayout={verticalLayout.defaultLayout}
              onLayoutChanged={verticalLayout.onLayoutChanged}
            >
              <Panel defaultSize="80%" minSize="30%" id="editor-main">
                <EditorArea />
              </Panel>
              <Separator
                className="resize-handle resize-handle-vertical"
                aria-label="调整底部面板高度"
                onKeyDown={event => resizePanelFromKeyboard(event, bottomPanelRef, 'ArrowUp', 'ArrowDown')}
              />
              <Panel panelRef={bottomPanelRef} defaultSize="20%" minSize="50px" collapsible id="bottom-panel">
                <BottomPanel />
              </Panel>
            </Group>
          </Panel>
          {agentPanelVisible ? (
            <>
              <Separator
                className="resize-handle resize-handle-horizontal"
                aria-label="调整智能体面板宽度"
                onKeyDown={event => resizePanelFromKeyboard(event, agentPanelRef, 'ArrowLeft', 'ArrowRight')}
              />
              <Panel panelRef={agentPanelRef} defaultSize="35%" minSize="280px" maxSize="60%" collapsible id="agent">
                <AgentPanel />
              </Panel>
            </>
          ) : (
            <>
              <Separator className="resize-handle resize-handle-horizontal" disabled aria-label="智能体面板已折叠" />
              <Panel defaultSize="34px" minSize="34px" maxSize="34px" id="agent-rail">
                <button
                  className="agent-panel-restore"
                  type="button"
                  onClick={() => dispatch(toggleAgentPanel())}
                  title="展开 AI 面板"
                  aria-label="展开 AI 面板"
                >
                  <PanelRightOpen size={16} />
                </button>
              </Panel>
            </>
          )}
        </Group>
      </div>
      <StatusBar />
      <ToastContainer />
      <CommandPalette isOpen={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} commands={commands} />
      <QuickOpen isOpen={quickOpenOpen} onClose={() => setQuickOpenOpen(false)} onSelect={(path) => {
        const name = path.split('/').pop() || path;
        dispatch(openTab({ id: `tab-${Date.now()}`, filePath: path, fileName: name, isDirty: false, isPreview: true, type: resolveEditorType(name) }));
      }} />
    </div>
  );
}
