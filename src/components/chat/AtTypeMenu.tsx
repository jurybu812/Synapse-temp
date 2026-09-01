/**
 * Synapse 输入区命令层 — 两级 @ 类型菜单浮层（Plan_5_M6 富文本输入）
 *
 * 复刻 Antigravity 的两级 @ 体验：
 *   level="type" → 一级「类型图标列表」（file/directory/conversation/...，icon + label）
 *   level="item" → 二级「具体项列表」（顶部回退条 ← 当前类型名 + 候选 label/description）
 *
 * 交互分工（与 InlineCompletionMenu 完全同款，按 Plan_5_M4-6 §4.2）：
 *   - 键盘交互（ArrowUp/Down/Enter/Tab/Esc/Backspace 回退）由【父 AgentPanel 的 onKeyDown
 *     在浮层 open 时拦截】，本组件【不监听键盘】——纯受控展示组件，activeIndex/level 由父持有。
 *   - 鼠标 hover 改 activeIndex（onActiveIndexChange）、click 选中/回退。
 *   - 样式复用既有 `.glass-panel` / `.cmd-list` / `.cmd-item`（ui.css），叠加 `.at-type-menu` 系列类。
 *
 * 防失焦（对抗审查 P15）：onMouseDown preventDefault 绑在
 *   ① 每个可点项（类型项 / 候选项 / 回退条）
 *   ② 菜单最外层容器（兜底点 loading/空态/列表空白处时编辑器不失焦、浮层不被 blur 关掉）。
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import type { AtType } from '@/services/inputCommands/richInput/types';
import type { CompletionItem } from '@/services/inputCommands/types';

interface AtTypeMenuProps {
  open: boolean;
  /** 当前层级：一级类型选择 / 二级具体项选择。 */
  level: 'type' | 'item';
  /** 一级类型条目（type + 显示名 + 图标），顺序即渲染顺序。 */
  typeEntries: { type: AtType; label: string; icon: string }[];
  /** 二级候选项（已扁平有序，activeIndex 即此数组下标）。 */
  items: CompletionItem[];
  /** 当前高亮项下标（由父组件持有，键盘移动与 hover 共用同一口径）。 */
  activeIndex: number;
  /** 二级候选加载中（异步取数据源时）。 */
  loading: boolean;
  /** 二级当前所属类型（用于回退条标题；一级时为 null）。 */
  selectedType: AtType | null;
  /** 一级：点击/选中某类型 → 进入二级。 */
  onSelectType: (type: AtType) => void;
  /** 二级：点击/选中某候选 → 父组件据 type/meta 决定插 token。 */
  onSelectItem: (item: CompletionItem) => void;
  /** hover 改高亮（供父组件同步 activeIndex）。 */
  onActiveIndexChange: (index: number) => void;
  /** 二级 → 点回退条返回一级。 */
  onBack: () => void;
}

export function AtTypeMenu({
  open,
  level,
  typeEntries,
  items,
  activeIndex,
  loading,
  selectedType,
  onSelectType,
  onSelectItem,
  onActiveIndexChange,
  onBack,
}: AtTypeMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘移动高亮后，把高亮项滚进可视区（父改 activeIndex / 切 level → 这里跟随滚动）。
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, level]);

  if (!open) return null;

  // 最外层容器统一 onMouseDown preventDefault：兜底点空白/spinner/空态区域时编辑器不失焦（P15）。
  const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

  return (
    <div
      className="inline-completion-menu at-type-menu glass-panel"
      role="listbox"
      aria-label={level === 'type' ? '选择引用类型' : '选择引用项'}
      onMouseDown={keepFocus}
    >
      {level === 'type' ? (
        /* ===== 一级：类型图标列表 ===== */
        <div className="cmd-list at-type-list" ref={listRef}>
          {typeEntries.map((entry, idx) => (
            <div
              key={entry.type}
              data-idx={idx}
              role="option"
              aria-selected={idx === activeIndex}
              className={`cmd-item at-type-item ${idx === activeIndex ? 'selected' : ''}`}
              // onMouseDown 阻止默认：点击类型时 textarea/编辑器不失焦、浮层不先被 blur 关闭。
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectType(entry.type);
              }}
              onMouseEnter={() => onActiveIndexChange(idx)}
            >
              <span className={`at-type-icon rt-token-${entry.type}`}>{entry.icon}</span>
              <span className="cmd-label at-type-label">{entry.label}</span>
            </div>
          ))}
        </div>
      ) : (
        /* ===== 二级：回退条 + 具体项列表 ===== */
        <>
          {/* 回退条：← 当前类型名，点击回到一级。selectedType=null（/命令单层菜单）不显回退条。 */}
          {selectedType && (
          <div
            className="at-back-bar"
            role="button"
            aria-label="返回类型选择"
            onMouseDown={(e) => {
              e.preventDefault();
              onBack();
            }}
          >
            <span className="at-back-arrow" aria-hidden="true">←</span>
            <span className="at-back-label">{backBarLabel(selectedType, typeEntries)}</span>
          </div>
          )}

          {loading ? (
            <div className="at-menu-loading" aria-live="polite">
              <span className="at-spinner" aria-hidden="true" />
              <span>加载中…</span>
            </div>
          ) : items.length === 0 ? (
            <div className="cmd-empty at-menu-empty">无匹配</div>
          ) : (
            <div className="cmd-list at-item-list" ref={listRef}>
              {items.map((item, idx) => (
                <div
                  key={item.id}
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === activeIndex}
                  className={`cmd-item at-item ${idx === activeIndex ? 'selected' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectItem(item);
                  }}
                  onMouseEnter={() => onActiveIndexChange(idx)}
                >
                  <span className="cmd-label">{item.label}</span>
                  {item.description && (
                    <span className="cmd-category inline-completion-desc">{item.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 回退条标题：优先用 typeEntries 里该类型的 label，取不到时回退到 type 原文。 */
function backBarLabel(
  selectedType: AtType | null,
  typeEntries: { type: AtType; label: string; icon: string }[],
): string {
  if (!selectedType) return '返回';
  const hit = typeEntries.find((e) => e.type === selectedType);
  return hit ? hit.label : selectedType;
}