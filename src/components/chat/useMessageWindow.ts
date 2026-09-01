import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export type MessageWindowUnit = {
  id: string;
};

export type MessageWindowRange = {
  start: number;
  end: number;
};

export type MessageWindowVisibleUnit<T extends MessageWindowUnit> = {
  unit: T;
  index: number;
};

export type MessageWindowUnitProps = {
  className: string;
  'data-message-window-unit-id': string;
  'data-message-window-unit-index': number;
};

type RefLike<T> = {
  readonly current: T;
};

type MessageWindowAnchor = {
  unitId: string;
  offsetTop: number;
};

export type TailPinnedStateInput = {
  scrollTop: number;
  previousScrollTop: number;
  bottomDistancePx: number;
  currentTailPinned: boolean;
  pinThresholdPx?: number;
  unpinThresholdPx?: number;
};

type UseMessageWindowOptions<T extends MessageWindowUnit> = {
  units: readonly T[];
  containerRef: RefLike<HTMLElement | null>;
  conversationId: string;
  active: boolean;
  isAtBottomRef: RefLike<boolean>;
  initialUnits: number;
  maxUnits: number;
  batchUnits: number;
  estimatedUnitHeight?: number;
};

const DEFAULT_ESTIMATED_UNIT_HEIGHT = 118;
const UNIT_SELECTOR = '[data-message-window-unit-id]';

function safePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sameMessageWindowRange(left: MessageWindowRange, right: MessageWindowRange): boolean {
  return left.start === right.start && left.end === right.end;
}

export function clampMessageWindowRange(
  totalUnits: number,
  range: MessageWindowRange,
  maxUnits: number,
): MessageWindowRange {
  const total = Math.max(0, Math.floor(totalUnits));
  const limit = safePositiveInteger(maxUnits, 1);
  const requestedStart = Number.isFinite(range.start) ? Math.floor(range.start) : 0;
  const requestedEnd = Number.isFinite(range.end) ? Math.floor(range.end) : requestedStart;
  let start = Math.min(Math.max(0, requestedStart), total);
  let end = Math.min(Math.max(start, requestedEnd), total);
  if (end - start > limit) end = start + limit;
  if (end > total) {
    end = total;
    start = Math.max(0, end - limit);
  }
  if (total > 0 && start === end) {
    start = Math.min(start, total - 1);
    end = start + 1;
  }
  return { start, end };
}

export function tailMessageWindowRange(
  totalUnits: number,
  preferredUnits: number,
  maxUnits: number,
): MessageWindowRange {
  const total = Math.max(0, Math.floor(totalUnits));
  const limit = safePositiveInteger(maxUnits, 1);
  const preferred = Math.min(limit, safePositiveInteger(preferredUnits, limit));
  const size = Math.min(total, preferred);
  return { start: Math.max(0, total - size), end: total };
}

export function messageWindowRangeAfterUnitChange(
  totalUnits: number,
  previousTotalUnits: number,
  range: MessageWindowRange,
  options: {
    initialUnits: number;
    maxUnits: number;
    tailPinned: boolean;
  },
): MessageWindowRange {
  const total = Math.max(0, Math.floor(totalUnits));
  const previousTotal = Math.max(0, Math.floor(previousTotalUnits));
  const current = clampMessageWindowRange(total, range, options.maxUnits);
  if (previousTotal === 0) {
    return tailMessageWindowRange(total, options.initialUnits, options.maxUnits);
  }
  if (total > previousTotal && current.end >= previousTotal) {
    if (options.tailPinned) {
      const retainedUnits = Math.max(options.initialUnits, current.end - current.start);
      return tailMessageWindowRange(total, retainedUnits, options.maxUnits);
    }
    return clampMessageWindowRange(total, { start: current.start, end: previousTotal }, options.maxUnits);
  }
  return current;
}

export function nextTailPinnedState({
  scrollTop,
  previousScrollTop,
  bottomDistancePx,
  currentTailPinned,
  pinThresholdPx = 4,
  unpinThresholdPx = 60,
}: TailPinnedStateInput): boolean {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(bottomDistancePx)) return currentTailPinned;
  const pinThreshold = Math.max(0, pinThresholdPx);
  const unpinThreshold = Math.max(pinThreshold, unpinThresholdPx);
  if (Number.isFinite(previousScrollTop) && scrollTop < previousScrollTop - 1) return false;
  if (bottomDistancePx <= pinThreshold) return true;
  if (bottomDistancePx >= unpinThreshold) return false;
  return currentTailPinned;
}

export function isMessageWindowEdgeNearViewport(offsetPx: number, thresholdPx: number): boolean {
  if (!Number.isFinite(offsetPx) || !Number.isFinite(thresholdPx) || thresholdPx < 0) return false;
  return offsetPx >= -thresholdPx && offsetPx <= thresholdPx;
}

export function messageWindowRangeForIndex(
  totalUnits: number,
  targetIndex: number,
  maxUnits: number,
  preferredBefore = 8,
): MessageWindowRange {
  const total = Math.max(0, Math.floor(totalUnits));
  if (total === 0) return { start: 0, end: 0 };
  const limit = safePositiveInteger(maxUnits, 1);
  const target = Math.min(Math.max(0, Math.floor(targetIndex)), total - 1);
  const before = Math.min(Math.max(0, Math.floor(preferredBefore)), Math.max(0, limit - 1));
  let start = Math.max(0, target - before);
  const end = Math.min(total, start + limit);
  start = Math.max(0, end - limit);
  return { start, end };
}

export function moveMessageWindowRange(
  totalUnits: number,
  range: MessageWindowRange,
  direction: 'older' | 'newer',
  batchUnits: number,
  maxUnits: number,
): MessageWindowRange {
  const total = Math.max(0, Math.floor(totalUnits));
  if (total === 0) return { start: 0, end: 0 };
  const limit = safePositiveInteger(maxUnits, 1);
  const batch = safePositiveInteger(batchUnits, 1);
  const current = clampMessageWindowRange(total, range, limit);
  const currentSize = Math.max(1, current.end - current.start);
  const expandableBy = Math.max(0, limit - currentSize);

  if (direction === 'older') {
    const growBy = Math.min(batch, expandableBy, current.start);
    if (growBy > 0) return { start: current.start - growBy, end: current.end };
    const shiftBy = Math.min(batch, current.start);
    const start = current.start - shiftBy;
    return clampMessageWindowRange(total, { start, end: start + currentSize }, limit);
  }

  const growBy = Math.min(batch, expandableBy, total - current.end);
  if (growBy > 0) return { start: current.start, end: current.end + growBy };
  const shiftBy = Math.min(batch, total - current.end);
  const end = current.end + shiftBy;
  return clampMessageWindowRange(total, { start: end - currentSize, end }, limit);
}

export function estimateMessageWindowHeight<T extends MessageWindowUnit>(
  units: readonly T[],
  start: number,
  end: number,
  measuredHeights: ReadonlyMap<string, number>,
  estimatedUnitHeight = DEFAULT_ESTIMATED_UNIT_HEIGHT,
): number {
  const total = units.length;
  const from = Math.min(Math.max(0, Math.floor(start)), total);
  const to = Math.min(Math.max(from, Math.floor(end)), total);
  const fallback = safePositiveInteger(estimatedUnitHeight, DEFAULT_ESTIMATED_UNIT_HEIGHT);
  let height = 0;
  for (let index = from; index < to; index += 1) {
    const measured = measuredHeights.get(units[index]?.id ?? '');
    height += measured && measured > 0 ? measured : fallback;
  }
  return height;
}

function renderedUnitElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(UNIT_SELECTOR));
}

export function useMessageWindow<T extends MessageWindowUnit>({
  units,
  containerRef,
  conversationId,
  active,
  isAtBottomRef,
  initialUnits,
  maxUnits,
  batchUnits,
  estimatedUnitHeight = DEFAULT_ESTIMATED_UNIT_HEIGHT,
}: UseMessageWindowOptions<T>) {
  const totalUnits = units.length;
  const heightByIdRef = useRef(new Map<string, number>());
  const [heightVersion, setHeightVersion] = useState(0);
  const [range, setRangeState] = useState<MessageWindowRange>(() => (
    tailMessageWindowRange(totalUnits, initialUnits, maxUnits)
  ));
  const rangeRef = useRef(range);
  const conversationIdRef = useRef(conversationId);
  const totalUnitsRef = useRef(totalUnits);
  rangeRef.current = range;

  const measureVisibleUnits = useCallback(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    let changed = false;
    const nextHeights = new Map(heightByIdRef.current);
    for (const element of renderedUnitElements(container)) {
      const unitId = element.dataset.messageWindowUnitId;
      if (!unitId) continue;
      const measuredHeight = Math.max(1, Math.ceil(element.getBoundingClientRect().height));
      const previousHeight = nextHeights.get(unitId);
      if (previousHeight === undefined || Math.abs(previousHeight - measuredHeight) > 1) {
        nextHeights.set(unitId, measuredHeight);
        changed = true;
      }
    }
    if (changed) {
      heightByIdRef.current = nextHeights;
      setHeightVersion(version => version + 1);
    }
  }, [active, containerRef]);

  const captureViewportAnchor = useCallback((nextRange?: MessageWindowRange): MessageWindowAnchor | undefined => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const containerRect = container.getBoundingClientRect();
    const visibleElements = renderedUnitElements(container).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > containerRect.top + 1 && rect.top < containerRect.bottom - 1;
    });
    const candidates = nextRange
      ? visibleElements.filter(element => {
        const index = Number(element.dataset.messageWindowUnitIndex);
        return Number.isFinite(index) && index >= nextRange.start && index < nextRange.end;
      })
      : visibleElements;
    const anchorElement = candidates[0] ?? visibleElements[0];
    const unitId = anchorElement?.dataset.messageWindowUnitId;
    if (!anchorElement || !unitId) return undefined;
    return {
      unitId,
      offsetTop: anchorElement.getBoundingClientRect().top - containerRect.top,
    };
  }, [active, containerRef]);

  const restoreViewportAnchor = useCallback((anchor?: MessageWindowAnchor) => {
    if (!anchor || typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;
        const anchorElement = renderedUnitElements(container)
          .find(element => element.dataset.messageWindowUnitId === anchor.unitId);
        if (!anchorElement) return;
        const delta = anchorElement.getBoundingClientRect().top
          - container.getBoundingClientRect().top
          - anchor.offsetTop;
        if (Math.abs(delta) > 0.5) container.scrollTop += delta;
        measureVisibleUnits();
      });
    });
  }, [containerRef, measureVisibleUnits]);

  const setWindowRange = useCallback((nextRange: MessageWindowRange, options?: { preserveAnchor?: boolean }) => {
    const next = clampMessageWindowRange(totalUnits, nextRange, maxUnits);
    const anchor = options?.preserveAnchor ? captureViewportAnchor(next) : undefined;
    rangeRef.current = next;
    setRangeState(current => sameMessageWindowRange(current, next) ? current : next);
    restoreViewportAnchor(anchor);
  }, [captureViewportAnchor, maxUnits, restoreViewportAnchor, totalUnits]);

  const loadOlder = useCallback(() => {
    const next = moveMessageWindowRange(totalUnits, rangeRef.current, 'older', batchUnits, maxUnits);
    setWindowRange(next, { preserveAnchor: true });
  }, [batchUnits, maxUnits, setWindowRange, totalUnits]);

  const loadNewer = useCallback(() => {
    const next = moveMessageWindowRange(totalUnits, rangeRef.current, 'newer', batchUnits, maxUnits);
    setWindowRange(next, { preserveAnchor: true });
  }, [batchUnits, maxUnits, setWindowRange, totalUnits]);

  const jumpToTail = useCallback(() => {
    const currentSize = Math.max(initialUnits, rangeRef.current.end - rangeRef.current.start);
    const next = tailMessageWindowRange(totalUnits, currentSize, maxUnits);
    setWindowRange(next);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
  }, [containerRef, initialUnits, maxUnits, setWindowRange, totalUnits]);

  const setWindowForIndex = useCallback((targetIndex: number, options?: { before?: number; preserveAnchor?: boolean }) => {
    const next = messageWindowRangeForIndex(totalUnits, targetIndex, maxUnits, options?.before ?? 8);
    setWindowRange(next, { preserveAnchor: options?.preserveAnchor });
  }, [maxUnits, setWindowRange, totalUnits]);

  const isWindowStartNearViewport = useCallback((thresholdPx = 160) => {
    const container = containerRef.current;
    if (!container) return false;
    const firstElement = renderedUnitElements(container)[0];
    if (!firstElement) return false;
    return isMessageWindowEdgeNearViewport(
      firstElement.getBoundingClientRect().top - container.getBoundingClientRect().top,
      thresholdPx,
    );
  }, [containerRef]);

  const isWindowEndNearViewport = useCallback((thresholdPx = 240) => {
    const container = containerRef.current;
    if (!container) return false;
    const elements = renderedUnitElements(container);
    const lastElement = elements[elements.length - 1];
    if (!lastElement) return false;
    return isMessageWindowEdgeNearViewport(
      lastElement.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom,
      thresholdPx,
    );
  }, [containerRef]);

  useLayoutEffect(() => {
    const previousConversationId = conversationIdRef.current;
    const previousTotal = totalUnitsRef.current;
    const conversationChanged = previousConversationId !== conversationId;
    conversationIdRef.current = conversationId;
    totalUnitsRef.current = totalUnits;

    if (conversationChanged) {
      heightByIdRef.current = new Map();
      setHeightVersion(version => version + 1);
    }

    const current = rangeRef.current;
    let next = messageWindowRangeAfterUnitChange(totalUnits, previousTotal, current, {
      initialUnits,
      maxUnits,
      tailPinned: isAtBottomRef.current,
    });
    if (conversationChanged || previousTotal === 0) {
      next = tailMessageWindowRange(totalUnits, initialUnits, maxUnits);
    }

    rangeRef.current = next;
    setRangeState(previous => sameMessageWindowRange(previous, next) ? previous : next);
  }, [conversationId, initialUnits, isAtBottomRef, maxUnits, totalUnits]);

  useLayoutEffect(() => {
    measureVisibleUnits();
  });

  useEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new ResizeObserver(() => measureVisibleUnits());
    for (const element of renderedUnitElements(container)) observer.observe(element);
    return () => observer.disconnect();
  }, [active, containerRef, measureVisibleUnits, range.start, range.end, units]);

  const topSpacerHeight = useMemo(() => (
    (void heightVersion, estimateMessageWindowHeight(units, 0, range.start, heightByIdRef.current, estimatedUnitHeight))
  ), [estimatedUnitHeight, heightVersion, range.start, units]);

  const bottomSpacerHeight = useMemo(() => (
    (void heightVersion, estimateMessageWindowHeight(units, range.end, totalUnits, heightByIdRef.current, estimatedUnitHeight))
  ), [estimatedUnitHeight, heightVersion, range.end, totalUnits, units]);

  const visibleUnits = useMemo<MessageWindowVisibleUnit<T>[]>(() => (
    units.slice(range.start, range.end).map((unit, offset) => ({ unit, index: range.start + offset }))
  ), [range.end, range.start, units]);

  const getUnitProps = useCallback((unit: T, index: number): MessageWindowUnitProps => ({
    className: 'message-window-unit',
    'data-message-window-unit-id': unit.id,
    'data-message-window-unit-index': index,
  }), []);

  return {
    range,
    visibleUnits,
    topSpacerHeight,
    bottomSpacerHeight,
    canLoadOlder: range.start > 0,
    canLoadNewer: range.end < totalUnits,
    loadOlder,
    loadNewer,
    jumpToTail,
    setWindowForIndex,
    setWindowRange,
    getUnitProps,
    isWindowStartNearViewport,
    isWindowEndNearViewport,
  };
}
