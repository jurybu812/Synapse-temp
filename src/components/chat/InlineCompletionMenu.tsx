/**
 * Synapse 输入区命令层 — 内联补全浮层（M4-6-S1）
 *
 * 受控内联浮层（非全屏 overlay，与 CommandPalette 区分）：渲染候选列表 + 分组标题，
 * 跟随输入框上方（挂 `.agent-input-container` 上方，`bottom:100%`）。
 *
 * 交互分工（按 Plan_5_M4-6 §4.2）：
 *   - 键盘交互（ArrowUp/Down/Enter/Tab/Esc）由【AgentPanel 的 onKeyDown 在浮层 open 时拦截】，
 *     本组件不监听键盘——它是纯受控展示组件，activeIndex 由父组件持有。
 *   - 鼠标 hover 改 activeIndex（onActiveIndexChange）、click 选中（onSelect）。
 *   - 样式复用既有 `.cmd-item` / `.cmd-list`（ui.css），叠加 `.inline-completion-menu` 定位类。
 *
 * 候选已是「扁平有序数组」（数据源已分组排序），本组件按相邻 item 的 group 变化插入分组标题，
 * 因此 activeIndex 始终是【扁平数组下标】，与父组件键盘移动口径一致（不被分组标题打断）。
 */
import { useEffect, useRef } from 'react';
import type { CompletionItem } from '@/services/inputCommands/types';

interface InlineCompletionMenuProps {
  open: boolean;
  items: CompletionItem[];
  /** 当前高亮项下标（扁平数组下标，由父组件持有）。 */
  activeIndex: number;
  /** 点击 / Enter 选中某项。 */
  onSelect: (item: CompletionItem) => void;
  /** hover 改高亮（供父组件同步 activeIndex）。 */
  onActiveIndexChange: (index: number) => void;
}

export function InlineCompletionMenu({
  open,
  items,
  activeIndex,
  onSelect,
  onActiveIndexChange,
}: InlineCompletionMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘移动高亮后，把高亮项滚进可视区（父组件改 activeIndex → 这里跟随滚动）。
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open || items.length === 0) return null;

  return (
    <div className="inline-completion-menu glass-panel" role="listbox" aria-label="输入补全">
      <div className="cmd-list" ref={listRef}>
        {items.map((item, idx) => {
          // 与上一条 group 不同 → 先插一个分组标题。
          const prevGroup = idx > 0 ? items[idx - 1].group : null;
          const showGroupHeader = item.group !== prevGroup;
          return (
            <div key={item.id}>
              {showGroupHeader && (
                <div className="inline-completion-group">{groupLabel(item.group)}</div>
              )}
              <div
                data-idx={idx}
                role="option"
                aria-selected={idx === activeIndex}
                className={`cmd-item ${idx === activeIndex ? 'selected' : ''}`}
                // onMouseDown 阻止默认，避免点击候选时 textarea 失焦导致 caret 丢失 / 浮层先被 blur 关闭。
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(item);
                }}
                onMouseEnter={() => onActiveIndexChange(idx)}
              >
                <span className="cmd-label">{item.label}</span>
                {item.description && (
                  <span className="cmd-category inline-completion-desc">{item.description}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function groupLabel(group: CompletionItem['group']): string {
  switch (group) {
    case '对话': return '💬 历史对话';
    case '工作流': return '🤝 固定工作流';
    case '设置': return '⚙️ 设置';
    case '命令': return '⌘ 命令';
    default: return group;
  }
}
