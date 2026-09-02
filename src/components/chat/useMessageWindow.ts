import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export type MessageWindowUnit = {
  id: string;
};

export type MessageWindowRange = {
  start: number;
  end: number;
};

export type TaskBoundaryBodyRangeInput = {
  anchorMessageId?: string | null;
  endAnchorMessageId?: string | null;
  status?: string | null;
};

export type TaskBoundaryBodyRange = {
  anchorIdx: number;
  startIdx: number;
  endIdx: number;
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
  isNearTailRef?: RefLike<boolean>;
  initialUnits: number;
  maxUnits: number;
  batchUnits: number;
  estimatedUnitHeight?: number;
  tailUnpinThresholdPx?: number;
};

const DEFAULT_ESTIMATED_UNIT_HEIGHT = 118;
const DEFAULT_TAIL_UNPIN_THRESHOLD_PX = 60;
const UNIT_SELECTOR = '[data-message-window-unit-id]';
const HEIGHT_CACHE_WIDTH_EPSILON_PX = 1;

export type MessageWindowMeasurementScrollMode = 'tail' | 'anchor';

export type MessageWindowMeasurementScrollModeInput = {
  currentTailPinned: boolean;
  wasNearTailBeforeMeasurement: boolean;
};

function safePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function safeMeasuredHeight(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

class MessageWindowFenwickTree {
  private readonly size: number;
  private tree: number[];

  private constructor(values: readonly number[]) {
    this.size = values.length;
    this.tree = new Array(this.size + 1).fill(0);
    for (let index = 0; index < this.size; index += 1) {
      this.tree[index + 1] = values[index] ?? 0;
    }
    for (let index = 1; index <= this.size; index += 1) {
      const next = index + (index & -index);
      if (next <= this.size) this.tree[next] += this.tree[index];
    }
  }

  static filled(size: number, value: number): MessageWindowFenwickTree {
    return new MessageWindowFenwickTree(new Array(Math.max(0, Math.floor(size))).fill(value));
  }

  static fromValues(values: readonly number[]): MessageWindowFenwickTree {
    return new MessageWindowFenwickTree(values);
  }

  add(index: number, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    const boundedIndex = Math.floor(index);
    if (boundedIndex < 0 || boundedIndex >= this.size) return;
    for (let treeIndex = boundedIndex + 1; treeIndex <= this.size; treeIndex += treeIndex & -treeIndex) {
      this.tree[treeIndex] += delta;
    }
  }

  prefixSum(endExclusive: number): number {
    let index = Math.min(Math.max(0, Math.floor(endExclusive)), this.size);
    let sum = 0;
    for (; index > 0; index -= index & -index) sum += this.tree[index];
    return sum;
  }

  rangeSum(start: number, end: number): number {
    const from = Math.min(Math.max(0, Math.floor(start)), this.size);
    const to = Math.min(Math.max(from, Math.floor(end)), this.size);
    return this.prefixSum(to) - this.prefixSum(from);
  }

  firstIndexAfterOffset(offsetPx: number): number {
    if (this.size === 0) return 0;
    const target = Number.isFinite(offsetPx) ? Math.max(0, offsetPx) : 0;
    let index = 0;
    let accumulated = 0;
    let bitMask = 1;
    while ((bitMask << 1) <= this.size) bitMask <<= 1;
    for (let bit = bitMask; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.size && accumulated + this.tree[next] <= target) {
        index = next;
        accumulated += this.tree[next];
      }
    }
    return Math.min(index, this.size - 1);
  }
}

export type MessageWindowHeightIndex = {
  readonly kind: 'message-window-height-index';
  readonly units: readonly MessageWindowUnit[];
  readonly totalUnits: number;
  readonly estimatedUnitHeight: number;
  readonly unitIndexById: ReadonlyMap<string, number>;
  estimateRangeHeight(start: number, end: number): number;
  indexForScrollOffset(scrollOffsetPx: number): number;
};

type MessageWindowHeightIndexInput = ReadonlyMap<string, number> | MessageWindowHeightIndex;

class IndexedMessageWindowHeights implements MessageWindowHeightIndex {
  readonly kind = 'message-window-height-index' as const;
  readonly units: readonly MessageWindowUnit[];
  readonly totalUnits: number;
  readonly estimatedUnitHeight: number;
  readonly unitIndexById: ReadonlyMap<string, number>;
  private heightTree: MessageWindowFenwickTree;

  constructor(
    units: readonly MessageWindowUnit[],
    measuredHeights: ReadonlyMap<string, number>,
    estimatedUnitHeight: number,
    unitIndexById?: ReadonlyMap<string, number>,
  ) {
    this.units = units;
    this.totalUnits = units.length;
    this.estimatedUnitHeight = safePositiveInteger(estimatedUnitHeight, DEFAULT_ESTIMATED_UNIT_HEIGHT);
    this.unitIndexById = unitIndexById ?? new Map(units.map((unit, index) => [unit.id, index]));
    const heights = new Array(this.totalUnits).fill(this.estimatedUnitHeight);
    for (const [unitId, measured] of measuredHeights) {
      const index = this.unitIndexById.get(unitId);
      const height = safeMeasuredHeight(measured);
      if (index === undefined || index < 0 || index >= this.totalUnits || height === undefined) continue;
      heights[index] = height;
    }
    this.heightTree = MessageWindowFenwickTree.fromValues(heights);
  }

  estimateRangeHeight(start: number, end: number): number {
    return this.heightTree.rangeSum(start, end);
  }

  indexForScrollOffset(scrollOffsetPx: number): number {
    return this.heightTree.firstIndexAfterOffset(scrollOffsetPx);
  }

  updateMeasurement(unitId: string, previousHeight: number | undefined, nextHeight: number | undefined): void {
    const index = this.unitIndexById.get(unitId);
    if (index === undefined) return;
    const previous = safeMeasuredHeight(previousHeight) ?? this.estimatedUnitHeight;
    const next = safeMeasuredHeight(nextHeight) ?? this.estimatedUnitHeight;
    this.heightTree.add(index, next - previous);
  }

  clearMeasurements(): void {
    this.heightTree = MessageWindowFenwickTree.filled(this.totalUnits, this.estimatedUnitHeight);
  }
}

function isMessageWindowHeightIndex(value: MessageWindowHeightIndexInput | undefined): value is MessageWindowHeightIndex {
  return Boolean(value && 'kind' in value && value.kind === 'message-window-height-index');
}

function isCurrentMessageWindowHeightIndex<T extends MessageWindowUnit>(
  index: MessageWindowHeightIndex,
  units: readonly T[],
  estimatedUnitHeight: number,
): boolean {
  return index.units === units
    && index.totalUnits === units.length
    && index.estimatedUnitHeight === safePositiveInteger(estimatedUnitHeight, DEFAULT_ESTIMATED_UNIT_HEIGHT);
}

function mutableMessageWindowHeightIndex(
  index: MessageWindowHeightIndex | undefined,
): IndexedMessageWindowHeights | undefined {
  return index instanceof IndexedMessageWindowHeights ? index : undefined;
}

export function createMessageWindowHeightIndex<T extends MessageWindowUnit>(
  units: readonly T[],
  measuredHeights: ReadonlyMap<string, number>,
  estimatedUnitHeight = DEFAULT_ESTIMATED_UNIT_HEIGHT,
  unitIndexById?: ReadonlyMap<string, number>,
): MessageWindowHeightIndex {
  return new IndexedMessageWindowHeights(units, measuredHeights, estimatedUnitHeight, unitIndexById);
}

export function resolveTaskBoundaryBodyRange(
  boundary: TaskBoundaryBodyRangeInput,
  messageIndexById: ReadonlyMap<string, number>,
  totalMessages: number,
): TaskBoundaryBodyRange | undefined {
  const total = Math.max(0, Math.floor(totalMessages));
  const anchorId = boundary.anchorMessageId;
  if (typeof anchorId !== 'string' || anchorId.length === 0) return undefined;
  const anchorIdx = messageIndexById.get(anchorId);
  if (anchorIdx === undefined || anchorIdx < 0 || anchorIdx >= total) return undefined;

  const startIdx = anchorIdx + 1;
  const endAnchorId = boundary.endAnchorMessageId;
  let endIdx = typeof endAnchorId === 'string' ? messageIndexById.get(endAnchorId) : undefined;
  if (boundary.status === 'active') {
    if (endAnchorId == null || endIdx === undefined) endIdx = total - 1;
  } else if (endIdx === undefined) {
    endIdx = startIdx - 1;
  }
  return {
    anchorIdx,
    startIdx,
    endIdx: Math.min(Math.max(-1, endIdx), total - 1),
  };
}

export function isIndexInTaskBoundaryBodyRange(range: TaskBoundaryBodyRange, index: number): boolean {
  return Number.isFinite(index) && index >= range.startIdx && index <= range.endIdx;
}

function resolveMessageWindowHeightIndex<T extends MessageWindowUnit>(
  units: readonly T[],
  measuredHeights: ReadonlyMap<string, number>,
  estimatedUnitHeight: number,
  indexInput?: MessageWindowHeightIndexInput,
): MessageWindowHeightIndex {
  if (
    isMessageWindowHeightIndex(indexInput)
    && isCurrentMessageWindowHeightIndex(indexInput, units, estimatedUnitHeight)
  ) return indexInput;
  return createMessageWindowHeightIndex(
    units,
    measuredHeights,
    estimatedUnitHeight,
    isMessageWindowHeightIndex(indexInput) ? undefined : indexInput,
  );
}

function measuredContainerWidth(container: HTMLElement): number | undefined {
  const width = container.getBoundingClientRect().width;
  return Number.isFinite(width) && width > 0 ? Math.ceil(width) : undefined;
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

export function messageWindowMeasurementScrollMode({
  currentTailPinned,
  wasNearTailBeforeMeasurement,
}: MessageWindowMeasurementScrollModeInput): MessageWindowMeasurementScrollMode {
  return currentTailPinned && wasNearTailBeforeMeasurement ? 'tail' : 'anchor';
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

export function messageWindowIndexForScrollOffset<T extends MessageWindowUnit>(
  units: readonly T[],
  scrollOffsetPx: number,
  measuredHeights: ReadonlyMap<string, number>,
  estimatedUnitHeight = DEFAULT_ESTIMATED_UNIT_HEIGHT,
  heightIndexInput?: MessageWindowHeightIndexInput,
): number {
  const total = units.length;
  if (total === 0) return 0;
  const targetOffset = Number.isFinite(scrollOffsetPx) ? Math.max(0, scrollOffsetPx) : 0;
  const fallback = safePositiveInteger(estimatedUnitHeight, DEFAULT_ESTIMATED_UNIT_HEIGHT);
  if (!isMessageWindowHeightIndex(heightIndexInput) && measuredHeights.size === 0) {
    return Math.min(total - 1, Math.floor(targetOffset / fallback));
  }
  return resolveMessageWindowHeightIndex(
    units,
    measuredHeights,
    fallback,
    heightIndexInput,
  ).indexForScrollOffset(targetOffset);
}

export function messageWindowRangeForScrollOffset<T extends MessageWindowUnit>(
  units: readonly T[],
  scrollOffsetPx: number,
  measuredHeights: ReadonlyMap<string, number>,
  maxUnits: number,
  estimatedUnitHeight = DEFAULT_ESTIMATED_UNIT_HEIGHT,
  preferredBefore = 8,
  heightIndexInput?: MessageWindowHeightIndexInput,
): MessageWindowRange {
  const targetIndex = messageWindowIndexForScrollOffset(
    units,
    scrollOffsetPx,
    measuredHeights,
    estimatedUnitHeight,
    heightIndexInput,
  );
  return messageWindowRangeForIndex(units.length, targetIndex, maxUnits, preferredBefore);
}

export function isMessageWindowViewportBeforeRenderedWindow(
  scrollTop: number,
  clientHeight: number,
  topSpacerHeight: number,
  thresholdPx: number,
): boolean {
  if (
    !Number.isFinite(scrollTop)
    || !Number.isFinite(clientHeight)
    || !Number.isFinite(topSpacerHeight)
    || !Number.isFinite(thresholdPx)
  ) return false;
  const spacerHeight = Math.max(0, topSpacerHeight);
  if (spacerHeight <= 0) return false;
  const viewportBottom = Math.max(0, scrollTop) + Math.max(0, clientHeight);
  return viewportBottom <= spacerHeight + Math.max(0, thresholdPx);
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
  heightIndexInput?: MessageWindowHeightIndexInput,
): number {
  const total = units.length;
  const from = Math.min(Math.max(0, Math.floor(start)), total);
  const to = Math.min(Math.max(from, Math.floor(end)), total);
  const fallback = safePositiveInteger(estimatedUnitHeight, DEFAULT_ESTIMATED_UNIT_HEIGHT);
  if (!isMessageWindowHeightIndex(heightIndexInput) && measuredHeights.size === 0) return (to - from) * fallback;
  return resolveMessageWindowHeightIndex(
    units,
    measuredHeights,
    fallback,
    heightIndexInput,
  ).estimateRangeHeight(from, to);
}

function renderedUnitElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(UNIT_SELECTOR));
}

function captureMessageWindowViewportAnchor(container: HTMLElement, nextRange?: MessageWindowRange): MessageWindowAnchor | undefined {
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
}

function restoreMessageWindowViewportAnchor(container: HTMLElement, anchor?: MessageWindowAnchor): void {
  if (!anchor) return;
  const anchorElement = renderedUnitElements(container)
    .find(element => element.dataset.messageWindowUnitId === anchor.unitId);
  if (!anchorElement) return;
  const delta = anchorElement.getBoundingClientRect().top
    - container.getBoundingClientRect().top
    - anchor.offsetTop;
  if (Math.abs(delta) > 0.5) container.scrollTop += delta;
}

export function useMessageWindow<T extends MessageWindowUnit>({
  units,
  containerRef,
  conversationId,
  active,
  isAtBottomRef,
  isNearTailRef,
  initialUnits,
  maxUnits,
  batchUnits,
  estimatedUnitHeight = DEFAULT_ESTIMATED_UNIT_HEIGHT,
  tailUnpinThresholdPx = DEFAULT_TAIL_UNPIN_THRESHOLD_PX,
}: UseMessageWindowOptions<T>) {
  const totalUnits = units.length;
  const unitIndexById = useMemo(() => new Map(units.map((unit, index) => [unit.id, index])), [units]);
  const heightByIdRef = useRef(new Map<string, number>());
  const heightIndexRef = useRef<MessageWindowHeightIndex | undefined>(undefined);
  const measuredContainerWidthRef = useRef<number | undefined>(undefined);
  const lastViewportAnchorRef = useRef<MessageWindowAnchor | undefined>(undefined);
  const pendingMeasurementAnchorRef = useRef<MessageWindowAnchor | undefined>(undefined);
  const layoutGenerationRef = useRef(0);
  const [heightVersion, setHeightVersion] = useState(0);
  const heightIndex = useMemo(() => {
    const next = createMessageWindowHeightIndex(
      units,
      heightByIdRef.current,
      estimatedUnitHeight,
      unitIndexById,
    );
    heightIndexRef.current = next;
    return next;
  }, [estimatedUnitHeight, unitIndexById, units]);
  const [range, setRangeState] = useState<MessageWindowRange>(() => (
    tailMessageWindowRange(totalUnits, initialUnits, maxUnits)
  ));
  const rangeRef = useRef(range);
  const conversationIdRef = useRef(conversationId);
  const totalUnitsRef = useRef(totalUnits);
  rangeRef.current = range;

  const rememberViewportAnchor = useCallback((container = containerRef.current) => {
    if (!container) return undefined;
    const anchor = captureMessageWindowViewportAnchor(container);
    if (anchor) lastViewportAnchorRef.current = anchor;
    return anchor;
  }, [containerRef]);

  const measureVisibleUnits = useCallback(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    let changed = false;
    const bottomDistancePx = container.scrollHeight - container.scrollTop - container.clientHeight;
    const wasNearTailBeforeMeasurement = isNearTailRef?.current
      ?? (Number.isFinite(bottomDistancePx) && bottomDistancePx <= Math.max(0, tailUnpinThresholdPx));
    const recoveryMode = messageWindowMeasurementScrollMode({
      currentTailPinned: isAtBottomRef.current,
      wasNearTailBeforeMeasurement,
    });
    const recoveryAnchor = recoveryMode === 'anchor'
      ? pendingMeasurementAnchorRef.current ?? lastViewportAnchorRef.current ?? captureMessageWindowViewportAnchor(container)
      : undefined;
    const containerWidth = measuredContainerWidth(container);
    if (containerWidth !== undefined) {
      const previousWidth = measuredContainerWidthRef.current;
      if (
        previousWidth !== undefined
        && Math.abs(previousWidth - containerWidth) > HEIGHT_CACHE_WIDTH_EPSILON_PX
      ) {
        changed = heightByIdRef.current.size > 0;
        heightByIdRef.current.clear();
        mutableMessageWindowHeightIndex(heightIndexRef.current)?.clearMeasurements();
      }
      measuredContainerWidthRef.current = containerWidth;
    }
    const heights = heightByIdRef.current;
    const currentHeightIndex = mutableMessageWindowHeightIndex(heightIndexRef.current);
    for (const element of renderedUnitElements(container)) {
      const unitId = element.dataset.messageWindowUnitId;
      if (!unitId) continue;
      const measuredHeight = Math.max(1, Math.ceil(element.getBoundingClientRect().height));
      const previousHeight = heights.get(unitId);
      if (previousHeight === undefined || Math.abs(previousHeight - measuredHeight) > 1) {
        heights.set(unitId, measuredHeight);
        currentHeightIndex?.updateMeasurement(unitId, previousHeight, measuredHeight);
        changed = true;
      }
    }
    if (changed) {
      if (recoveryMode === 'anchor') pendingMeasurementAnchorRef.current = recoveryAnchor;
      else pendingMeasurementAnchorRef.current = undefined;
      setHeightVersion(version => version + 1);
      if (typeof window !== 'undefined') {
        const expectedGeneration = layoutGenerationRef.current;
        const expectedConversationId = conversationIdRef.current;
        const expectedContainer = container;
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const currentContainer = containerRef.current;
            if (
              !currentContainer
              || currentContainer !== expectedContainer
              || layoutGenerationRef.current !== expectedGeneration
              || conversationIdRef.current !== expectedConversationId
            ) return;
            if (recoveryMode === 'tail') {
              currentContainer.scrollTop = currentContainer.scrollHeight;
              rememberViewportAnchor(currentContainer);
              return;
            }
            const pendingAnchor = pendingMeasurementAnchorRef.current ?? recoveryAnchor;
            pendingMeasurementAnchorRef.current = undefined;
            restoreMessageWindowViewportAnchor(currentContainer, pendingAnchor);
            rememberViewportAnchor(currentContainer);
          });
        });
      }
    } else if (recoveryMode === 'anchor' && !pendingMeasurementAnchorRef.current) {
      rememberViewportAnchor(container);
    }
  }, [active, containerRef, isAtBottomRef, isNearTailRef, rememberViewportAnchor, tailUnpinThresholdPx]);

  const captureViewportAnchor = useCallback((nextRange?: MessageWindowRange): MessageWindowAnchor | undefined => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    return captureMessageWindowViewportAnchor(container, nextRange);
  }, [active, containerRef]);

  const restoreViewportAnchor = useCallback((anchor?: MessageWindowAnchor) => {
    if (!anchor || typeof window === 'undefined') return;
    const expectedGeneration = layoutGenerationRef.current;
    const expectedConversationId = conversationIdRef.current;
    const expectedContainer = containerRef.current;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const container = containerRef.current;
        if (
          !container
          || container !== expectedContainer
          || layoutGenerationRef.current !== expectedGeneration
          || conversationIdRef.current !== expectedConversationId
        ) return;
        restoreMessageWindowViewportAnchor(container, anchor);
        measureVisibleUnits();
      });
    });
  }, [containerRef, measureVisibleUnits]);

  const setWindowRange = useCallback((nextRange: MessageWindowRange, options?: { preserveAnchor?: boolean }) => {
    const next = clampMessageWindowRange(totalUnits, nextRange, maxUnits);
    const anchor = options?.preserveAnchor ? captureViewportAnchor(next) : undefined;
    if (!sameMessageWindowRange(rangeRef.current, next)) {
      layoutGenerationRef.current += 1;
      pendingMeasurementAnchorRef.current = undefined;
    }
    rangeRef.current = next;
    setRangeState(current => sameMessageWindowRange(current, next) ? current : next);
    restoreViewportAnchor(anchor);
  }, [captureViewportAnchor, maxUnits, restoreViewportAnchor, totalUnits]);

  const topSpacerHeight = useMemo(() => (
    (void heightVersion, estimateMessageWindowHeight(
      units,
      0,
      range.start,
      heightByIdRef.current,
      estimatedUnitHeight,
      heightIndex,
    ))
  ), [estimatedUnitHeight, heightIndex, heightVersion, range.start, units]);

  const bottomSpacerHeight = useMemo(() => (
    (void heightVersion, estimateMessageWindowHeight(
      units,
      range.end,
      totalUnits,
      heightByIdRef.current,
      estimatedUnitHeight,
      heightIndex,
    ))
  ), [estimatedUnitHeight, heightIndex, heightVersion, range.end, totalUnits, units]);

  const topSpacerViewportRange = useCallback(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    if (!isMessageWindowViewportBeforeRenderedWindow(
      container.scrollTop,
      container.clientHeight,
      topSpacerHeight,
      160,
    )) return undefined;
    const preferredBefore = Math.min(
      Math.max(0, maxUnits - 1),
      Math.max(8, Math.ceil(container.clientHeight / safePositiveInteger(estimatedUnitHeight, DEFAULT_ESTIMATED_UNIT_HEIGHT))),
    );
    return messageWindowRangeForScrollOffset(
      units,
      container.scrollTop,
      heightByIdRef.current,
      maxUnits,
      estimatedUnitHeight,
      preferredBefore,
      heightIndex,
    );
  }, [containerRef, estimatedUnitHeight, heightIndex, maxUnits, topSpacerHeight, units]);

  const loadOlder = useCallback(() => {
    const viewportRange = topSpacerViewportRange();
    if (viewportRange) {
      setWindowRange(viewportRange);
      return;
    }
    const next = moveMessageWindowRange(totalUnits, rangeRef.current, 'older', batchUnits, maxUnits);
    setWindowRange(next, { preserveAnchor: true });
  }, [batchUnits, maxUnits, setWindowRange, topSpacerViewportRange, totalUnits]);

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
    if (isMessageWindowViewportBeforeRenderedWindow(
      container.scrollTop,
      container.clientHeight,
      topSpacerHeight,
      thresholdPx,
    )) return true;
    const firstElement = renderedUnitElements(container)[0];
    if (!firstElement) return false;
    return isMessageWindowEdgeNearViewport(
      firstElement.getBoundingClientRect().top - container.getBoundingClientRect().top,
      thresholdPx,
    );
  }, [containerRef, topSpacerHeight]);

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
      layoutGenerationRef.current += 1;
      heightByIdRef.current.clear();
      mutableMessageWindowHeightIndex(heightIndexRef.current)?.clearMeasurements();
      measuredContainerWidthRef.current = undefined;
      lastViewportAnchorRef.current = undefined;
      pendingMeasurementAnchorRef.current = undefined;
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

    if (!conversationChanged && !sameMessageWindowRange(current, next)) {
      layoutGenerationRef.current += 1;
      pendingMeasurementAnchorRef.current = undefined;
    }

    rangeRef.current = next;
    setRangeState(previous => sameMessageWindowRange(previous, next) ? previous : next);
  }, [conversationId, initialUnits, isAtBottomRef, maxUnits, totalUnits]);

  useLayoutEffect(() => {
    measureVisibleUnits();
  }, [measureVisibleUnits, range.end, range.start, units]);

  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const handleScroll = () => {
      if (pendingMeasurementAnchorRef.current) return;
      rememberViewportAnchor(container);
    };
    handleScroll();
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [active, containerRef, rememberViewportAnchor, range.start, range.end, units]);

  useEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new ResizeObserver(() => measureVisibleUnits());
    observer.observe(container);
    for (const element of renderedUnitElements(container)) observer.observe(element);
    return () => observer.disconnect();
  }, [active, containerRef, measureVisibleUnits, range.start, range.end, units]);

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
