import { X, FileCode, FileText, Image, Film, Presentation, BookOpen, Globe, Home, Settings, ListChecks, Network, ChevronLeft, ChevronRight, MoreHorizontal, Check, ListOrdered, XSquare, Save, Eye, Lock, SlidersHorizontal } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  closeTab, markTabSaved, setActiveTab, pinTab,
  togglePreviewEnabled, lockGroup, closeSavedTabs, closeAllTabs,
} from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';
import { setActiveView } from '@/store/slices/sidebar';
import { setSidebarVisible } from '@/store/slices/layout';
import type { RootState } from '@/store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';
import { ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';

const tabIcons: Record<string, React.ElementType> = {
  code: FileCode,
  pdf: FileText,
  pptx: Presentation,
  docx: BookOpen,
  office: BookOpen,
  markdown: FileText,
  html: Globe,
  image: Image,
  video: Film,
  showcase: Globe,
  welcome: Home,
  settings: Settings,
  review: ListChecks,
  workflow: Network, // ★ M3-3b 子代理中间视图 tab
  attachment: FileText, // ★ M4-3-S3 已发消息附件 tab
  unsupported: FileText,
};

export function TabBar() {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const activeTabId = useAppSelector((s: RootState) => s.editorTabs.activeTabId);
  const previewEnabled = useAppSelector((s: RootState) => s.editorTabs.previewEnabled);
  const groupLocked = useAppSelector((s: RootState) => s.editorTabs.groupLocked);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const handleClose = useCallback(async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const tab = tabs.find(item => item.id === tabId);
    if (tab?.isDirty) {
      const ok = await resolveUnsavedTabs([tab], '关闭标签');
      if (!ok) return;
      dispatch(markTabSaved({ id: tab.id, content: tab.content }));
    }
    dispatch(closeTab(tabId));
  }, [dispatch, tabs]);

  const handleMiddleClick = useCallback(async (e: React.MouseEvent, tabId: string) => {
    if (e.button === 1) {
      e.preventDefault();
      const tab = tabs.find(item => item.id === tabId);
      if (tab?.isDirty) {
        const ok = await resolveUnsavedTabs([tab], '关闭标签');
        if (!ok) return;
        dispatch(markTabSaved({ id: tab.id, content: tab.content }));
      }
      dispatch(closeTab(tabId));
    }
  }, [dispatch, tabs]);

  // ★ M4-3-S8：双击 tab → 固定（去斜体临时态），符合 VS Code 双击固定预览 tab。
  const handleDoubleClick = useCallback((tabId: string) => {
    dispatch(pinTab(tabId));
  }, [dispatch]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY;
    }
  }, []);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    scrollRef.current?.scrollBy({
      left: direction === 'left' ? -220 : 220,
      behavior: 'smooth',
    });
  }, []);

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dispatch(setActiveTab(tabs[index].id));
      return;
    } else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    dispatch(setActiveTab(next.id));
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-tab-index="${nextIndex}"]`)?.focus();
    });
  }, [dispatch, tabs]);

  // ★ M4-3-S8：Close All——逐 tab 走 dirty 确认链，确认后清空（非 welcome）。
  //   Lock Group 锁定时阻断并提示（轻量版语义：锁组不被 Close All 误关）。
  const closeAllWithConfirm = useCallback(async () => {
    if (groupLocked) {
      dispatch(addNotification({ type: 'info', title: '编辑器组已锁定', message: '请先解锁分组再关闭全部标签' }));
      return;
    }
    const dirtyTabs = tabs.filter(t => t.isDirty);
    if (dirtyTabs.length > 0) {
      const ok = await resolveUnsavedTabs(dirtyTabs, '关闭全部标签');
      if (!ok) return;
      dirtyTabs.forEach(t => dispatch(markTabSaved({ id: t.id, content: t.content })));
    }
    dispatch(closeAllTabs());
  }, [dispatch, groupLocked, tabs]);

  // ★ M4-3-S8：Close Saved——关闭所有非脏 tab（已保存的本就无须确认）。welcome 保留。
  const closeSavedWithConfirm = useCallback(() => {
    if (groupLocked) {
      dispatch(addNotification({ type: 'info', title: '编辑器组已锁定', message: '请先解锁分组再关闭已保存标签' }));
      return;
    }
    dispatch(closeSavedTabs());
  }, [dispatch, groupLocked]);

  const openMoreMenu = useCallback(() => {
    const rect = moreBtnRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({ x: rect.right - 8, y: rect.bottom + 4 });
    }
  }, []);

  const buildMenuItems = useCallback((): MenuItem[] => {
    // Show Opened Editors：轻量版——首行作不可点的分组标题，其下逐 tab 列出，点击跳转激活
    //   （不做 VS Code 侧栏式 OPEN EDITORS 面板，主人决议取轻量版）。
    const openedItems: MenuItem[] = tabs.map(tab => ({
      label: `${tab.fileName}${tab.isDirty ? ' ●' : ''}`,
      onClick: () => dispatch(setActiveTab(tab.id)),
    }));

    return [
      { label: '已打开的编辑器', icon: <ListOrdered size={14} />, onClick: () => { }, disabled: true },
      ...openedItems,
      { label: '', onClick: () => { }, separator: true },
      { label: '全部关闭', icon: <XSquare size={14} />, shortcut: 'Ctrl+K W', onClick: () => { void closeAllWithConfirm(); } },
      { label: '关闭已保存', icon: <Save size={14} />, shortcut: 'Ctrl+K U', onClick: () => closeSavedWithConfirm() },
      { label: '', onClick: () => { }, separator: true },
      {
        label: previewEnabled ? '预览编辑器：开' : '预览编辑器：关',
        icon: previewEnabled ? <Check size={14} /> : <Eye size={14} />,
        onClick: () => dispatch(togglePreviewEnabled(undefined)),
      },
      {
        label: groupLocked ? '锁定分组：开' : '锁定分组：关',
        icon: groupLocked ? <Check size={14} /> : <Lock size={14} />,
        onClick: () => dispatch(lockGroup(undefined)),
      },
      { label: '', onClick: () => { }, separator: true },
      {
        label: '设置',
        icon: <SlidersHorizontal size={14} />,
        onClick: () => {
          dispatch(setSidebarVisible(true));
          dispatch(setActiveView('settings'));
        },
      },
    ];
  }, [closeAllWithConfirm, closeSavedWithConfirm, dispatch, groupLocked, previewEnabled, tabs]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeTabId, tabs.length]);

  return (
    <div className="tab-strip">
      <button className="tab-scroll-btn" type="button" onClick={() => scrollTabs('left')} title="向左滚动标签" aria-label="向左滚动标签">
        <ChevronLeft size={14} />
      </button>
      <div className="tab-bar" ref={scrollRef} onWheel={handleWheel} role="tablist" aria-label="已打开的编辑器">
        {tabs.map((tab, index) => {
          const Icon = tabIcons[tab.type] || FileCode;
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              ref={isActive ? activeTabRef : undefined}
              className={`tab-item ${isActive ? 'active' : ''} ${tab.isPreview ? 'preview' : ''}`}
              onClick={() => dispatch(setActiveTab(tab.id))}
              onDoubleClick={() => handleDoubleClick(tab.id)}
              onMouseDown={(e) => handleMiddleClick(e, tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              title={tab.filePath || tab.fileName}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              aria-label={`${tab.fileName}${tab.isDirty ? '，有未保存更改' : ''}`}
              data-tab-index={index}
            >
              <Icon size={14} className={`tab-icon tab-icon-${tab.type}`} />
              <span className="tab-label">
                {tab.fileName}
                {tab.isDirty && <span className="tab-dirty">●</span>}
              </span>
              {tab.type !== 'welcome' && (
                <button
                  className="tab-close"
                  type="button"
                  onClick={(e) => handleClose(e, tab.id)}
                  title="关闭"
                  aria-label={`关闭 ${tab.fileName}`}
                  tabIndex={-1}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className="tab-scroll-btn" type="button" onClick={() => scrollTabs('right')} title="向右滚动标签" aria-label="向右滚动标签">
        <ChevronRight size={14} />
      </button>
      <button
        ref={moreBtnRef}
        className="tab-more-btn"
        type="button"
        onClick={openMoreMenu}
        title="更多操作"
        aria-label="更多操作"
      >
        <MoreHorizontal size={16} />
      </button>
      {menuPos && (
        <ContextMenu
          items={buildMenuItems()}
          position={menuPos}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}
