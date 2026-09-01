/**
 * useAtMention —— Plan_5_M6 C6：把 AgentPanel 底部输入框的整套两级 @ 菜单逻辑抽成可复用 hook，
 * 让「底部主输入框」与「编辑历史消息的输入框」共用同一套 @ 体验（富文本 + 两级类型菜单 + 内联 atomic token），
 * 消除两套输入框分叉。
 *
 * 封装：menu 两级状态机 + 候选取数(竞态守卫) + 键盘交互(导航/回退/提交) + AtTypeMenu 受控渲染 + atConvCache 预热。
 * 调用方各自配一个 RichTextInput（richRef）+ 提交回调；提交键可配（底部 Ctrl+Enter / 编辑框 Enter）。
 *
 * 对抗审查修正全部沿用（HIGH-1/2 重锚定 / P13 竞态 / MEDIUM-2 cache 抖动 / LOW-1 closeMenu 收口）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { setSidebarVisible } from '@/store/slices/layout';
import { setActiveView } from '@/store/slices/sidebar';
import type { CompletionItem } from '@/services/inputCommands/types';
import type { SendKeyMode } from '@/store/slices/settings';
import type { RichTextInputHandle, AtType, AtTrigger } from '@/services/inputCommands/richInput/types';
import { AT_TYPE_ENTRIES, fetchTypeItems } from '@/services/inputCommands/atProviders';
import { detectSlashTrigger } from '@/services/inputCommands/richInput/atTrigger';
import { commandRegistry } from '@/services/inputCommands/commandRegistry';
import { listConversationSummaries } from '@/services/conversationPersistence';
import type { ConversationSummary } from '@/store/slices/conversationHistory';
import { AtTypeMenu } from '@/components/chat/AtTypeMenu';

interface MenuState {
  open: boolean;
  mode: 'at' | 'slash';
  level: 'type' | 'item';
  selectedType: AtType | null;
  query: string;
  trigger: AtTrigger | null;
  items: CompletionItem[];
  activeIndex: number;
  loading: boolean;
}

const INITIAL_MENU: MenuState = { open: false, mode: 'at', level: 'type', selectedType: null, query: '', trigger: null, items: [], activeIndex: 0, loading: false };

interface UseAtMentionOptions {
  richRef: RefObject<RichTextInputHandle | null>;
  /**
   * Ctrl+Enter（底部）或 Enter（编辑框）触发的提交回调（发送 / 保存）。
   * ★ Plan_7 #6：opts.withModifier = 触发时是否按下 Ctrl/Cmd（供生成中区分主键 / 修饰键 → queue / interrupt）。
   *   非生成中调用方可忽略此参数（行为不变）。
   */
  onSubmit: (opts?: { withModifier?: boolean }) => void;
  /** true=单 Enter 提交（编辑框，恒 Enter 保存）；false（默认）=由 sendKeyMode 决定底部输入框提交键。 */
  submitOnPlainEnter?: boolean;
  /**
   * ★ Plan_7 #6：生成中（isStreaming）运行时键位模式。true 时无视 sendKeyMode 强制启用「双提交键」——
   *   plain Enter 与 Ctrl/Cmd+Enter 都触发 onSubmit（分别带 withModifier=false/true，由调用方映射 queue/interrupt），
   *   Shift+Enter 永远换行。false（默认）维持原 sendKeyMode 逻辑（非生成中正常发送）。
   *   传 getter 而非布尔值：handleEditorKeyDown 在 keydown 当刻读最新流式态，避免 hook 依赖频繁重建。
   */
  runtimeMode?: () => boolean;
  /**
   * ★ C1（M7 第七轮反馈#6）：底部主输入框的发送键模式（仅当 submitOnPlainEnter 为 false 时生效）。
   *   'enter'     = plain Enter 发送 / Shift+Enter 换行。
   *   'ctrlEnter' = Ctrl 或 Cmd+Enter 发送 / Enter 换行（旧默认行为）。
   *   不传时回退 'ctrlEnter'，与历史行为一致（向后兼容编辑框外的其它调用方）。
   */
  sendKeyMode?: SendKeyMode;
  /** 插/删 token 等程序化改动后回调（父组件据此更新 canSend 等派生态；onContentChange 不会被程序化改动触发）。 */
  onAfterMutate?: () => void;
}

interface UseAtMentionResult {
  /** 受控菜单元素（放到输入框容器内、RichTextInput 之前）。 */
  menuElement: ReactNode;
  /** 传给 RichTextInput 的 onEditorKeyDown（返回 true=已消费）。 */
  handleEditorKeyDown: (e: KeyboardEvent) => boolean;
  /** 传给 RichTextInput 的 onContentChange（探测 @ / 命令触发刷新菜单）。 */
  refreshMenu: () => void;
  /** 关闭菜单（统一收口）。 */
  closeMenu: () => void;
  /** ★ C3：程序化打开 @ 菜单（加号小窗用）。省略 type=一级类型菜单；给 type=直接进该类型二级（如 'workflow'）。 */
  openAtMenu: (type?: AtType) => void;
}

export function useAtMention({ richRef, onSubmit, submitOnPlainEnter = false, sendKeyMode = 'ctrlEnter', runtimeMode, onAfterMutate }: UseAtMentionOptions): UseAtMentionResult {
  const dispatch = useAppDispatch();
  const [menu, setMenu] = useState<MenuState>(INITIAL_MENU);
  const atRequestSeqRef = useRef(0);
  const [atConvCache, setAtConvCache] = useState<ConversationSummary[] | null>(null);
  const atConvLoadingRef = useRef(false);
  // MEDIUM-2：稳定读取最新 cache 供 fetchSecondLevel（避免其 useCallback 随 cache 变化重建 → 二级 effect 重复 fetch 抖动）。
  const atConvCacheRef = useRef(atConvCache);
  atConvCacheRef.current = atConvCache;

  const closeMenu = useCallback(() => {
    atRequestSeqRef.current++; // LOW-1：关菜单统一丢弃在途二级 fetch。
    setMenu(m => (m.open ? { ...m, open: false, level: 'type', selectedType: null, items: [], activeIndex: 0, loading: false } : m));
  }, []);

  // ★ 二级 fetch（竞态守卫 P13）：每次 ++requestSeq，回调比对丢弃 stale。
  const fetchSecondLevel = useCallback((type: AtType, query: string) => {
    const seq = ++atRequestSeqRef.current;
    setMenu(m => ({ ...m, loading: true }));
    void fetchTypeItems(type, query, { convCache: atConvCacheRef.current })
      .then(items => {
        if (seq !== atRequestSeqRef.current) return;
        setMenu(m => (m.open && m.mode === 'at' && m.selectedType === type) ? { ...m, items, activeIndex: 0, loading: false } : m);
      })
      .catch(() => {
        if (seq !== atRequestSeqRef.current) return;
        setMenu(m => (m.open && m.selectedType === type) ? { ...m, items: [], loading: false } : m);
      });
  }, []);

  // onContentChange 后：① @ 触发 → 两级类型菜单；② / 命令 → 单层命令菜单；都不命中关闭。IME 守卫在 RichTextInput。
  const refreshMenu = useCallback(() => {
    const root = richRef.current?.getElement();
    if (!root) { closeMenu(); return; }
    const at = richRef.current!.getAtTrigger();
    if (at) {
      if (atConvCacheRef.current === null && !atConvLoadingRef.current) {
        atConvLoadingRef.current = true;
        void listConversationSummaries({})
          .then(list => setAtConvCache(list))
          .catch(() => setAtConvCache([]))
          .finally(() => { atConvLoadingRef.current = false; });
      }
      setMenu(m => ({
        ...m,
        open: true,
        mode: 'at',
        level: m.open && m.mode === 'at' && m.selectedType ? 'item' : 'type',
        query: at.query,
        trigger: at,
        items: m.open && m.mode === 'at' && m.selectedType ? m.items : [],
        activeIndex: 0,
      }));
      return;
    }
    const slash = detectSlashTrigger(root);
    if (slash) {
      const items = commandRegistry.filter(slash.query);
      if (items.length === 0) { closeMenu(); return; }
      // #12a：slash 现在仿 @ 走 atomic token——把 `/` 锚点（startNode/startOffset）存进 menu.trigger，
      //   选命令时 applyTokenCompletion 据此删 `/query` 段、原位插 slash chip（AtTrigger 与 SlashTrigger 三字段结构兼容）。
      const slashTrigger: AtTrigger = { query: slash.query, startNode: slash.startNode, startOffset: slash.startOffset };
      setMenu(m => ({ ...m, open: true, mode: 'slash', level: 'item', selectedType: null, query: slash.query, trigger: slashTrigger, items, activeIndex: 0, loading: false }));
      return;
    }
    closeMenu();
  }, [closeMenu, richRef]);

  // 二级：query / 类型变化 → 重取候选。
  useEffect(() => {
    if (!menu.open || menu.mode !== 'at' || menu.level !== 'item' || !menu.selectedType) return;
    fetchSecondLevel(menu.selectedType, menu.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.open, menu.mode, menu.level, menu.selectedType, menu.query, fetchSecondLevel]);

  // MEDIUM-2：@对话二级打开期间 atConvCache 异步 load 完成 → 仅此时重取一次。
  useEffect(() => {
    if (menu.open && menu.mode === 'at' && menu.level === 'item' && menu.selectedType === 'conversation') {
      fetchSecondLevel('conversation', menu.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atConvCache]);

  const applyTypeSelect = useCallback((type: AtType) => {
    setMenu(m => ({ ...m, mode: 'at', level: 'item', selectedType: type, query: '', items: [], activeIndex: 0, loading: true }));
  }, []);

  /**
   * ★ C3（M7 第七轮反馈#13）：程序化打开 @ 菜单——供「加号小窗」的「提及@ / 选择工作流」菜单项调用。
   *   做法：在输入框光标处插入一个真实 '@' 字符（execCommand insertText，与 RichTextInput 既有键入口径一致），
   *   focus 后用 getAtTrigger() 探测该触发，直接把 menu.trigger 锚到这个 @，再按需进二级。
   *   插真实 '@' 是关键——applyTokenCompletion 选候选时 getAtTrigger()/menu.trigger 才有锚点，能正确删 '@' 段并插 atomic token。
   *   ① type 省略 → 停在一级类型菜单（等价手敲 @）；② type='workflow' 等 → 直接跳该类型二级（一步进工作流选择）。
   */
  const openAtMenu = useCallback((type?: AtType) => {
    const el = richRef.current?.getElement();
    if (!el) return;
    el.focus();
    // 与 RichTextInput.handlePaste 同口径：用 execCommand 在光标处插字符（保持 contenteditable 一致行为）。
    document.execCommand('insertText', false, '@');
    onAfterMutate?.();
    // 探测刚插入的 @ 触发；探测不到（极端情况）就回退 refreshMenu 走常规路径。
    const trigger = richRef.current?.getAtTrigger() ?? null;
    if (!trigger) { refreshMenu(); return; }
    if (atConvCacheRef.current === null && !atConvLoadingRef.current) {
      atConvLoadingRef.current = true;
      void listConversationSummaries({})
        .then(list => setAtConvCache(list))
        .catch(() => setAtConvCache([]))
        .finally(() => { atConvLoadingRef.current = false; });
    }
    if (type) {
      // 直接进指定类型二级（二级候选由「query/类型变化」effect 触发 fetchSecondLevel 加载）。
      setMenu(m => ({ ...m, open: true, mode: 'at', level: 'item', selectedType: type, query: '', trigger, items: [], activeIndex: 0, loading: true }));
    } else {
      // 停在一级类型菜单。
      setMenu(m => ({ ...m, open: true, mode: 'at', level: 'type', selectedType: null, query: '', trigger, items: [], activeIndex: 0, loading: false }));
    }
  }, [richRef, onAfterMutate, refreshMenu]);

  const applyTokenCompletion = useCallback((item: CompletionItem) => {
    const meta = (item.meta ?? {}) as Record<string, unknown>;
    if (menu.mode === 'slash') {
      const name = String(meta.name ?? item.label.replace(/^\//, '').split(/\s/)[0]);
      // #12a：/ 命令也插内联 atomic chip（仿 @）。重新 detect `/` 锚点（HIGH-1/2 重锚定，避 IME normalize 后游离），
      //   删掉 `/query` 段、原位插 slash token；发送时 TOKEN_INLINE.slash 还原为 `/name `，parseAndDispatch 照常命中执行。
      const root = richRef.current?.getElement();
      const slash = root ? detectSlashTrigger(root) : null;
      const trigger = (slash
        ? { query: slash.query, startNode: slash.startNode, startOffset: slash.startOffset }
        : menu.trigger);
      if (trigger) {
        richRef.current?.insertTokenAt(trigger, { type: 'slash', id: name, value: name });
        onAfterMutate?.();
      } else {
        // 兜底：锚点丢失（极端情况）→ 退回纯文本，至少命令仍可发送执行。
        richRef.current?.setContent([`/${name} `]);
        richRef.current?.focus();
        onAfterMutate?.();
      }
      closeMenu();
      return;
    }
    const type = (meta.type as AtType) ?? menu.selectedType;
    if (type === 'settings') {
      const sectionId = String(meta.sectionId ?? meta.id ?? '');
      dispatch(setActiveView('settings'));
      dispatch(setSidebarVisible(true));
      if (sectionId) {
        requestAnimationFrame(() => { window.dispatchEvent(new CustomEvent('synapse:settings-focus-section', { detail: sectionId })); });
      }
      closeMenu();
      return;
    }
    // 其余六类：插内联 atomic token。HIGH-1/2：插前重新 detect 锚点（避 IME normalize 后 startNode 游离）。
    const trigger = richRef.current?.getAtTrigger() ?? menu.trigger;
    const id = String(meta.id ?? '');
    const value = String(meta.value ?? item.label);
    // M6 收尾 C2：透传 displayLabel（workflow=mode.name 含空格 / file=相对路径），让 pill 保人类可读；缺省回落 value。
    const displayLabel = meta.displayLabel != null ? String(meta.displayLabel) : undefined;
    if (type && trigger && id) {
      richRef.current?.insertTokenAt(trigger, { type, id, value, ...(displayLabel != null ? { displayLabel } : {}) });
      onAfterMutate?.();
    }
    closeMenu();
  }, [menu.mode, menu.selectedType, menu.trigger, dispatch, closeMenu, richRef, onAfterMutate]);

  const handleEditorKeyDown = useCallback((e: KeyboardEvent): boolean => {
    // ★ Plan_7 #6：生成中【运行时双提交键】优先（runtimeMode 当刻为 true）——无视 sendKeyMode，
    //   plain Enter（withModifier=false）与 Ctrl/Cmd+Enter（withModifier=true）都触发提交（onSubmit 据此分 queue/interrupt），
    //   Shift+Enter 永远换行。plain Enter 仍让位菜单（菜单开时选候选）；Ctrl/Cmd+Enter 即便菜单开也直接提交。
    if (e.key === 'Enter' && !e.shiftKey && runtimeMode?.()) {
      const withModifier = e.ctrlKey || e.metaKey;
      if (withModifier || !menu.open) {
        e.preventDefault();
        onSubmit({ withModifier });
        return true;
      }
      // plain Enter 且菜单开 → 不在此提交，继续往下走菜单导航分支（选候选）。
    } else {
    // ★ C1（M7 第七轮反馈#6）：非生成中提交键判定分两类——
    //   ① plain-Enter 提交：编辑框（submitOnPlainEnter）或底部 'enter' 模式。plain Enter（无修饰键）触发，
    //      受菜单守卫——菜单开时让位给「选候选」，仅菜单关才提交。Shift+Enter 永远换行（不进此分支）。
    //   ② ctrl/cmd-Enter 提交：底部 'ctrlEnter' 模式（默认）。Ctrl 或 Cmd+Enter 触发，即便菜单开也直接提交。
    const plainEnterSends = submitOnPlainEnter || sendKeyMode === 'enter';
    const ctrlEnterSends = !submitOnPlainEnter && sendKeyMode === 'ctrlEnter';
    const isPlainEnterSubmit = plainEnterSends && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    const isCtrlEnterSubmit = ctrlEnterSends && e.key === 'Enter' && (e.ctrlKey || e.metaKey);
    // plain-Enter 提交让位菜单（菜单开不提交）；ctrl/cmd-Enter 提交不受菜单影响。
    if (isCtrlEnterSubmit || (isPlainEnterSubmit && !menu.open)) {
      e.preventDefault();
      onSubmit();
      return true;
    }
    }
    if (!menu.open) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const len = menu.mode === 'at' && menu.level === 'type' ? AT_TYPE_ENTRIES.length : menu.items.length;
      setMenu(m => ({ ...m, activeIndex: Math.min(m.activeIndex + 1, Math.max(0, len - 1)) }));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMenu(m => ({ ...m, activeIndex: Math.max(m.activeIndex - 1, 0) }));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (menu.mode === 'at' && menu.level === 'type') {
        const entry = AT_TYPE_ENTRIES[menu.activeIndex];
        if (entry) applyTypeSelect(entry.type);
      } else {
        const item = menu.items[menu.activeIndex];
        if (item) applyTokenCompletion(item);
      }
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (menu.mode === 'at' && menu.level === 'item') {
        atRequestSeqRef.current++;
        setMenu(m => ({ ...m, level: 'type', selectedType: null, items: [], activeIndex: 0, loading: false }));
      } else {
        closeMenu();
      }
      return true;
    }
    return false;
  }, [submitOnPlainEnter, sendKeyMode, runtimeMode, menu.open, menu.mode, menu.level, menu.items, menu.activeIndex, applyTypeSelect, applyTokenCompletion, closeMenu, onSubmit]);

  const menuElement = (
    <AtTypeMenu
      open={menu.open}
      level={menu.level}
      typeEntries={AT_TYPE_ENTRIES}
      items={menu.items}
      activeIndex={menu.activeIndex}
      loading={menu.loading}
      selectedType={menu.selectedType}
      onSelectType={applyTypeSelect}
      onSelectItem={applyTokenCompletion}
      onActiveIndexChange={(idx) => setMenu(m => ({ ...m, activeIndex: idx }))}
      onBack={() => { atRequestSeqRef.current++; setMenu(m => ({ ...m, level: 'type', selectedType: null, items: [], activeIndex: 0, loading: false })); }}
    />
  );

  return { menuElement, handleEditorKeyDown, refreshMenu, closeMenu, openAtMenu };
}
