/**
 * ★ task_boundary 展示卡片（Plan_5 §10 + M7 第四轮「卡片吞消息」返工）。
 *
 * 仿 Antigravity（反重力）任务卡范式——把【一个任务边界期间的过程】整齐收进一张可折叠卡片，
 * 而非「小卡片 + 消息散落在外」。卡片结构（自上而下）：
 *   ① 头部：状态色圆点（active 脉冲）+ headline 大标题 + 状态徽标 + 「历史」按钮。
 *   ② summary 概括。
 *   ③ 「已编辑文件」区：本边界期间编辑/创建的文件 chips（来自区间消息的 diffs/artifacts），点击直接打开。
 *   ④ 「进度更新」区：steps 进度列表（可折叠；active 默认展开，完成后默认收起）。
 *   ⑤ 「完整过程」区：本边界区间内的过程消息（children = MessageBubble 们），可折叠——
 *      active 默认展开（实时看 AI 在干嘛），done/aborted 默认收起（干净，点开看细节）。
 *   ⑥ 历史变迁浮层（比 Antigravity 多做）：点「历史」→ createPortal 列 headline/summary 变迁时间线。
 *
 * 纯展示组件：吃 props（boundary / files / children），不订阅 store；文件点击经 onOpenFile 回调上抛。
 */
import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { History, ChevronDown, ChevronRight, Clock, FileText, FilePlus, FileMinus, Check } from 'lucide-react';
import {
  messageWindowRangeAfterUnitChange,
  messageWindowRangeForIndex,
  moveMessageWindowRange,
  tailMessageWindowRange,
  type MessageWindowRange,
} from '@/components/chat/useMessageWindow';
import type { TaskBoundary } from '@/store/slices/conversation';

/** 卡片聚合展示的「已编辑文件」（由 AgentPanel 从区间消息的 diffs / artifacts 聚合后传入）。 */
export interface BoundaryFile {
  key: string;                                        // 去重键（diff:path / artifact:path）
  path: string;
  label: string;                                      // 显示名（basename）
  kind: 'diff' | 'artifact';
  changeType?: 'created' | 'edited' | 'deleted';
  additions?: number;
  deletions?: number;
  ref: unknown;                                       // 原始 diff/artifact 对象，点击回传给 onOpenFile
}

interface TaskBoundaryCardProps {
  boundary: TaskBoundary;
  files?: BoundaryFile[];
  onOpenFile?: (file: BoundaryFile) => void;
  children?: ReactNode;                               // 区间内的过程消息（MessageBubble 们）
  items?: unknown[];                                  // 大边界按需渲染的数据项；避免父层提前创建全部 MessageBubble 元素
  renderItem?: (item: unknown) => ReactNode;
  childCount?: number;                                // 过程消息条数（折叠态显示「展开完整过程 (N条)」）
  onEnd?: () => void;                                 // ★ H1：手动收口当前 active 边界（用户兜底，防卡住）
  followTail?: boolean;                               // 外层消息区贴底时才让 active 边界随新增过程滑到尾部
  revealItemId?: string;                              // 导航/重载锚点要求显式挂载的边界内消息
  revealNonce?: number;                               // 同一消息重复导航时仍可区分的一次性请求编号
  onRevealConsumed?: (nonce: number) => void;         // 挂载目标后清除请求，避免后续 append 反复回拉
}

/** 状态 → 强调色 + 文案（active 主色 / done 绿 / aborted 红）。 */
function statusMeta(status: TaskBoundary['status']): { color: string; label: string } {
  switch (status) {
    case 'active': return { color: 'var(--syn-primary)', label: '进行中' };
    case 'done': return { color: '#22c55e', label: '已完成' };
    case 'aborted': return { color: '#ef4444', label: '已中止' };
    default: return { color: 'var(--syn-text-muted)', label: status };
  }
}

/** 文件 chip 图标：artifact / created / deleted / edited 各异。 */
function fileIcon(f: BoundaryFile) {
  if (f.kind === 'artifact') return <FileText size={12} />;
  if (f.changeType === 'created') return <FilePlus size={12} />;
  if (f.changeType === 'deleted') return <FileMinus size={12} />;
  return <FileText size={12} />;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 超 24h 退化绝对时间「M月D日 HH:mm」。
 */
function relativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

const INITIAL_BODY_RENDER_ITEMS = 80;
const BODY_RENDER_BATCH = 40;
const MAX_BODY_RENDER_ITEMS = 160;
const INITIAL_STEP_RENDER_ITEMS = 80;
const STEP_RENDER_BATCH = 40;
const MAX_STEP_RENDER_ITEMS = 160;

function disclosureStorageKey(boundaryId: string, section: 'steps' | 'body'): string {
  return `synapse:task-boundary:${boundaryId}:${section}:open`;
}

function readDisclosureState(boundaryId: string, section: 'steps' | 'body', fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(disclosureStorageKey(boundaryId, section));
    return stored === null ? fallback : stored === 'true';
  } catch {
    return fallback;
  }
}

function usePersistedDisclosure(boundaryId: string, section: 'steps' | 'body', fallback: boolean) {
  const [open, setOpenState] = useState(() => readDisclosureState(boundaryId, section, fallback));
  const setOpen = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setOpenState(current => {
      const value = typeof next === 'function' ? next(current) : next;
      try {
        localStorage.setItem(disclosureStorageKey(boundaryId, section), String(value));
      } catch {
        // localStorage 不可用时仍保留当前会话内的展开状态。
      }
      return value;
    });
  }, [boundaryId, section]);
  return [open, setOpen] as const;
}

function itemIdOf(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || !('id' in item)) return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function overlapAnchorIndex(current: MessageWindowRange, next: MessageWindowRange): number | undefined {
  const start = Math.max(current.start, next.start);
  const end = Math.min(current.end, next.end);
  return start < end ? start : undefined;
}

/** 历史变迁浮层：createPortal 到 body 的 glass-panel，倒序时间线，点外 / Esc 关闭。 */
function HistoryOverlay({ history, now, onClose }: {
  history: TaskBoundary['history'];
  now: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) onClose();
  }, [onClose]);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [handleClickOutside, handleKey]);

  const ordered = [...history].reverse();

  return createPortal(
    <div className="task-boundary-history-backdrop">
      <div ref={ref} className="task-boundary-history-overlay glass-panel" role="dialog" aria-label="标题变迁历史">
        <div className="tb-history-header">
          <History size={14} />
          <span className="tb-history-title">标题变迁历史</span>
          <span className="tb-history-count">{history.length} 次</span>
        </div>
        {ordered.length === 0 ? (
          <div className="tb-history-empty">暂无历史记录</div>
        ) : (
          <div className="tb-history-list">
            {ordered.map((entry, i) => (
              <div key={`${entry.timestamp}-${i}`} className="tb-history-entry">
                <span className="tb-history-dot" />
                <div className="tb-history-entry-main">
                  <div className="tb-history-entry-headline">{entry.headline}</div>
                  {entry.summary && <div className="tb-history-entry-summary">{entry.summary}</div>}
                  <div className="tb-history-entry-time">{relativeTime(entry.timestamp, now)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function TaskBoundaryCard({ boundary, files = [], onOpenFile, children, items, renderItem, childCount = 0, onEnd, followTail = true, revealItemId, revealNonce, onRevealConsumed }: TaskBoundaryCardProps) {
  const isActive = boundary.status === 'active';
  // ★ 进度与过程：active 默认展开；done/aborted 默认收起。用户手动开合会按 boundary 持久，重载不反复撑开长页。
  const [bodyOpen, setBodyOpen] = usePersistedDisclosure(boundary.id, 'body', isActive);
  const [stepsOpen, setStepsOpen] = usePersistedDisclosure(boundary.id, 'steps', isActive);
  const [historyOpen, setHistoryOpen] = useState(false);
  const bodyContainerRef = useRef<HTMLDivElement>(null);
  const stepsContainerRef = useRef<HTMLOListElement>(null);
  const bodyItems = useMemo(() => items ?? Children.toArray(children), [items, children]);
  const [visibleBodyRange, setVisibleBodyRange] = useState<MessageWindowRange>(() => (
    tailMessageWindowRange(bodyItems.length, INITIAL_BODY_RENDER_ITEMS, MAX_BODY_RENDER_ITEMS)
  ));
  const previousBodyItemCountRef = useRef(bodyItems.length);
  const [visibleStepRange, setVisibleStepRange] = useState<MessageWindowRange>(() => (
    tailMessageWindowRange(boundary.steps.length, INITIAL_STEP_RENDER_ITEMS, MAX_STEP_RENDER_ITEMS)
  ));
  const previousStepCountRef = useRef(boundary.steps.length);
  const consumedRevealNonceRef = useRef<number | null>(null);

  useEffect(() => {
    const previousCount = previousBodyItemCountRef.current;
    setVisibleBodyRange(current => messageWindowRangeAfterUnitChange(bodyItems.length, previousCount, current, {
      initialUnits: INITIAL_BODY_RENDER_ITEMS,
      maxUnits: MAX_BODY_RENDER_ITEMS,
      tailPinned: followTail,
    }));
    previousBodyItemCountRef.current = bodyItems.length;
  }, [bodyItems.length, followTail]);

  useEffect(() => {
    const previousCount = previousStepCountRef.current;
    setVisibleStepRange(current => messageWindowRangeAfterUnitChange(boundary.steps.length, previousCount, current, {
      initialUnits: INITIAL_STEP_RENDER_ITEMS,
      maxUnits: MAX_STEP_RENDER_ITEMS,
      tailPinned: followTail,
    }));
    previousStepCountRef.current = boundary.steps.length;
  }, [boundary.steps.length, followTail]);

  useEffect(() => {
    if (!revealItemId || revealNonce === undefined || consumedRevealNonceRef.current === revealNonce) return;
    const targetIndex = bodyItems.findIndex(item => (
      typeof item === 'object' && item !== null && 'id' in item && (item as { id?: unknown }).id === revealItemId
    ));
    if (targetIndex < 0) return;
    consumedRevealNonceRef.current = revealNonce;
    setBodyOpen(true);
    setVisibleBodyRange(messageWindowRangeForIndex(bodyItems.length, targetIndex, MAX_BODY_RENDER_ITEMS, 8));
    onRevealConsumed?.(revealNonce);
  }, [bodyItems, onRevealConsumed, revealItemId, revealNonce, setBodyOpen]);

  const moveBodyItems = useCallback((direction: 'older' | 'newer') => {
    const nextRange = moveMessageWindowRange(
      bodyItems.length,
      visibleBodyRange,
      direction,
      BODY_RENDER_BATCH,
      MAX_BODY_RENDER_ITEMS,
    );
    const anchorIndex = overlapAnchorIndex(visibleBodyRange, nextRange);
    const overlapAnchorId = anchorIndex === undefined ? undefined : itemIdOf(bodyItems[anchorIndex]);
    const scrollContainer = bodyContainerRef.current?.closest('.agent-messages') as HTMLElement | null;
    const anchorElement = overlapAnchorId
      ? bodyContainerRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(overlapAnchorId)}"]`)
      : bodyContainerRef.current?.querySelector<HTMLElement>('[data-message-id]');
    const anchorId = anchorElement?.dataset.messageId;
    const anchorOffset = anchorElement && scrollContainer
      ? anchorElement.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top
      : undefined;
    setVisibleBodyRange(nextRange);
    if (scrollContainer) {
      requestAnimationFrame(() => {
        if (!anchorId || anchorOffset === undefined) return;
        const nextAnchor = bodyContainerRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchorId)}"]`);
        if (!nextAnchor) return;
        scrollContainer.scrollTop += nextAnchor.getBoundingClientRect().top
          - scrollContainer.getBoundingClientRect().top
          - anchorOffset;
      });
    }
  }, [bodyItems, visibleBodyRange]);

  const loadOlderBodyItems = useCallback(() => moveBodyItems('older'), [moveBodyItems]);
  const loadNewerBodyItems = useCallback(() => moveBodyItems('newer'), [moveBodyItems]);

  const moveSteps = useCallback((direction: 'older' | 'newer') => {
    const nextRange = moveMessageWindowRange(
      boundary.steps.length,
      visibleStepRange,
      direction,
      STEP_RENDER_BATCH,
      MAX_STEP_RENDER_ITEMS,
    );
    const anchorIndex = overlapAnchorIndex(visibleStepRange, nextRange);
    const overlapAnchorId = anchorIndex === undefined ? undefined : boundary.steps[anchorIndex]?.id;
    const scrollContainer = stepsContainerRef.current?.closest('.agent-messages') as HTMLElement | null;
    const anchorElement = overlapAnchorId
      ? stepsContainerRef.current?.querySelector<HTMLElement>(`[data-task-step-id="${CSS.escape(overlapAnchorId)}"]`)
      : stepsContainerRef.current?.querySelector<HTMLElement>('[data-task-step-id]');
    const anchorId = anchorElement?.dataset.taskStepId;
    const anchorOffset = anchorElement && scrollContainer
      ? anchorElement.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top
      : undefined;
    setVisibleStepRange(nextRange);
    if (!scrollContainer) return;
    requestAnimationFrame(() => {
      if (!anchorId || anchorOffset === undefined) return;
      const nextAnchor = stepsContainerRef.current?.querySelector<HTMLElement>(`[data-task-step-id="${CSS.escape(anchorId)}"]`);
      if (!nextAnchor) return;
      scrollContainer.scrollTop += nextAnchor.getBoundingClientRect().top
        - scrollContainer.getBoundingClientRect().top
        - anchorOffset;
    });
  }, [boundary.steps, visibleStepRange]);

  const loadOlderSteps = useCallback(() => moveSteps('older'), [moveSteps]);
  const loadNewerSteps = useCallback(() => moveSteps('newer'), [moveSteps]);

  // ★ active 边界 / 历史浮层开启时按秒滴答刷新相对时间（非 active 不开 timer 省开销）。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive && !historyOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, historyOpen]);

  // ★ active → done/aborted 翻转时自动收起进度与过程（收口即归整，呼应反重力「完成后折叠成一卡」）。
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    if (prevActiveRef.current && !isActive) {
      setBodyOpen(false);
      setStepsOpen(false);
    }
    prevActiveRef.current = isActive;
  }, [isActive, setBodyOpen, setStepsOpen]);

  const meta = statusMeta(boundary.status);
  const stepCount = boundary.steps.length;
  const historyDisabled = boundary.history.length === 0;
  const effectiveChildCount = childCount || bodyItems.length;
  const hasBody = effectiveChildCount > 0;
  const visibleBodyItems = bodyItems.slice(visibleBodyRange.start, visibleBodyRange.end);
  const visibleSteps = boundary.steps.slice(visibleStepRange.start, visibleStepRange.end);

  return (
    <div className="task-boundary-card" data-task-boundary-id={boundary.id} style={{ borderLeftColor: meta.color }}>
      <div className="tb-card-header">
        <span className={`tb-card-dot${isActive ? ' pulsing' : ''}`} style={{ background: meta.color }} />
        <span className="tb-card-headline" title={boundary.headline}>{boundary.headline}</span>
        <span className="tb-card-status" style={{ color: meta.color, borderColor: meta.color }}>
          {meta.label}
        </span>
        <button
          type="button"
          className="tb-card-history-btn"
          onClick={() => setHistoryOpen(true)}
          disabled={historyDisabled}
          title={historyDisabled ? '暂无历史记录' : '查看标题变迁历史'}
        >
          <History size={14} />
          <span>历史</span>
        </button>
        {/* ★ H1（tb 卡住）：active 边界给用户一个手动收口入口——万一 AI 漏调 end_task_boundary 卡住，
            点此即标记完成收口，不必干等自动兜底。仅 active 显示。 */}
        {isActive && onEnd && (
          <button
            type="button"
            className="tb-card-history-btn"
            onClick={onEnd}
            title="手动结束当前任务（标记完成）"
          >
            <Check size={14} />
            <span>结束</span>
          </button>
        )}
      </div>

      {boundary.summary && (
        <div className="tb-card-summary" title={boundary.summary}>{boundary.summary}</div>
      )}

      {files.length > 0 && (
        <div className="tb-card-files">
          <div className="tb-card-section-label">
            <FileText size={12} />
            <span>已编辑文件</span>
            <span className="tb-card-count">{files.length}</span>
          </div>
          <div className="tb-card-file-chips">
            {files.map(f => (
              <button
                key={f.key}
                type="button"
                className="tb-card-file-chip"
                onClick={() => onOpenFile?.(f)}
                title={f.path}
              >
                {fileIcon(f)}
                <span className="tb-card-file-name">{f.label}</span>
                {f.kind === 'diff' && (!!f.additions || !!f.deletions) && (
                  <span className="tb-card-file-stat">
                    {f.additions ? <span className="tb-add">+{f.additions}</span> : null}
                    {f.deletions ? <span className="tb-del">-{f.deletions}</span> : null}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {stepCount > 0 && (
        <div className="tb-card-steps">
          <button
            type="button"
            className="tb-card-section-label tb-card-steps-toggle"
            onClick={() => setStepsOpen(o => !o)}
            aria-expanded={stepsOpen}
          >
            {stepsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>进度更新</span>
            <span className="tb-card-count">{stepCount}</span>
          </button>
          {stepsOpen && (
            <ol className="tb-card-steps-list" ref={stepsContainerRef}>
              {visibleStepRange.start > 0 && (
                <li className="tb-card-step-loader-row">
                  <button type="button" className="tb-card-body-loader" onClick={loadOlderSteps}>
                    加载更早进度 · 还剩 {visibleStepRange.start} 条
                  </button>
                </li>
              )}
              {visibleSteps.map((step, i) => (
                <li key={step.id} className="tb-card-step" data-task-step-id={step.id}>
                  <span className="tb-card-step-num">{visibleStepRange.start + i + 1}</span>
                  <span className="tb-card-step-text">{step.text}</span>
                  <span className="tb-card-step-time">
                    <Clock size={10} />
                    {relativeTime(step.timestamp, now)}
                  </span>
                </li>
              ))}
              {visibleStepRange.end < boundary.steps.length && (
                <li className="tb-card-step-loader-row">
                  <button type="button" className="tb-card-body-loader" onClick={loadNewerSteps}>
                    加载更新进度 · 距最新还剩 {boundary.steps.length - visibleStepRange.end} 条
                  </button>
                </li>
              )}
            </ol>
          )}
        </div>
      )}

      {hasBody && (
        <div className="tb-card-body">
          <button
            type="button"
            className="tb-card-body-toggle"
            onClick={() => setBodyOpen(o => !o)}
            aria-expanded={bodyOpen}
          >
            {bodyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{bodyOpen ? '收起过程' : '展开完整过程'}</span>
            <span className="tb-card-count">{effectiveChildCount} 条</span>
          </button>
          {bodyOpen && (
            <div className="tb-card-body-messages" ref={bodyContainerRef}>
              {visibleBodyRange.start > 0 && (
                <button type="button" className="tb-card-body-loader" onClick={loadOlderBodyItems}>
                  加载更早过程 · 还剩 {visibleBodyRange.start} 条
                </button>
              )}
              {visibleBodyItems.map(item => renderItem ? renderItem(item) : item as ReactNode)}
              {visibleBodyRange.end < bodyItems.length && (
                <button type="button" className="tb-card-body-loader" onClick={loadNewerBodyItems}>
                  加载更新过程 · 距最新还剩 {bodyItems.length - visibleBodyRange.end} 条
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {historyOpen && (
        <HistoryOverlay
          history={boundary.history}
          now={now}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
