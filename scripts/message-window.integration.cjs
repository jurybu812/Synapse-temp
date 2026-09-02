const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'components', 'chat', 'useMessageWindow.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
});

const moduleContainer = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  require,
  module: moduleContainer,
  exports: moduleContainer.exports,
}, { filename: sourcePath });

const {
  clampMessageWindowRange,
  createMessageWindowHeightIndex,
  estimateMessageWindowHeight,
  isMessageWindowViewportBeforeRenderedWindow,
  isMessageWindowEdgeNearViewport,
  isIndexInTaskBoundaryBodyRange,
  messageWindowIndexForScrollOffset,
  messageWindowRangeAfterUnitChange,
  messageWindowRangeForIndex,
  messageWindowRangeForScrollOffset,
  messageWindowMeasurementScrollMode,
  moveMessageWindowRange,
  nextTailPinnedState,
  resolveTaskBoundaryBodyRange,
  tailMessageWindowRange,
} = moduleContainer.exports;

function makeUnits(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `u-${index}` }));
}

function assertRangeInvariants(range, total, limit) {
  assert.ok(range.start >= 0, `range.start below zero: ${range.start}`);
  assert.ok(range.end <= total, `range.end past total: ${range.end} > ${total}`);
  assert.ok(range.start <= range.end, `range is inverted: ${range.start}-${range.end}`);
  assert.ok(range.end - range.start <= limit, `range exceeds cap: ${range.end - range.start} > ${limit}`);
}

function assertRange(range, start, end) {
  assert.equal(range.start, start);
  assert.equal(range.end, end);
}

function assertBoundaryBodyRange(range, anchorIdx, startIdx, endIdx) {
  assert.ok(range, 'expected a boundary body range');
  assert.equal(range.anchorIdx, anchorIdx);
  assert.equal(range.startIdx, startIdx);
  assert.equal(range.endIdx, endIdx);
}

const total = 5000;
const limit = 160;
let range = tailMessageWindowRange(total, 80, limit);
assertRange(range, 4920, 5000);

let maxObservedWindow = 0;
for (let step = 0; step < 200; step += 1) {
  range = moveMessageWindowRange(total, range, 'older', 40, limit);
  assertRangeInvariants(range, total, limit);
  maxObservedWindow = Math.max(maxObservedWindow, range.end - range.start);
}
assertRange(range, 0, 160);
assert.equal(maxObservedWindow, limit);

for (let step = 0; step < 200; step += 1) {
  range = moveMessageWindowRange(total, range, 'newer', 40, limit);
  assertRangeInvariants(range, total, limit);
}
assertRange(range, 4840, 5000);

const targetRange = messageWindowRangeForIndex(total, 1234, limit, 8);
assertRangeInvariants(targetRange, total, limit);
assert.ok(targetRange.start <= 1234 && targetRange.end > 1234, 'jump target must be inside the window');

assertRange(clampMessageWindowRange(total, { start: 10, end: 999 }, limit), 10, 170);
assertRange(clampMessageWindowRange(0, { start: 10, end: 999 }, limit), 0, 0);

const continuationIndexById = new Map([
  ['interrupt-user-anchor', 0],
  ['assistant-body-start', 1],
  ['body-user', 2],
  ['assistant-end', 3],
]);
const continuationBodyRange = resolveTaskBoundaryBodyRange({
  anchorMessageId: 'interrupt-user-anchor',
  endAnchorMessageId: 'assistant-end',
  status: 'done',
}, continuationIndexById, 4);
assertBoundaryBodyRange(continuationBodyRange, 0, 1, 3);
assert.equal(
  isIndexInTaskBoundaryBodyRange(continuationBodyRange, 0),
  false,
  'a continuation user anchor rendered outside the task card must not be covered by the boundary body range',
);
assert.equal(isIndexInTaskBoundaryBodyRange(continuationBodyRange, 2), true);

const activeBodyRange = resolveTaskBoundaryBodyRange({
  anchorMessageId: 'body-user',
  status: 'active',
}, continuationIndexById, 4);
assertBoundaryBodyRange(activeBodyRange, 2, 3, 3);

const closedMissingEndRange = resolveTaskBoundaryBodyRange({
  anchorMessageId: 'interrupt-user-anchor',
  status: 'done',
}, continuationIndexById, 4);
assertBoundaryBodyRange(closedMissingEndRange, 0, 1, 0);
assert.equal(isIndexInTaskBoundaryBodyRange(closedMissingEndRange, 1), false);
assert.equal(
  resolveTaskBoundaryBodyRange({ anchorMessageId: 'missing', status: 'active' }, continuationIndexById, 4),
  undefined,
);

const unpinnedAppend = messageWindowRangeAfterUnitChange(5002, 5000, { start: 4920, end: 5000 }, {
  initialUnits: 80,
  maxUnits: limit,
  tailPinned: false,
});
assertRange(unpinnedAppend, 4920, 5000);

const middleUnpinnedAppend = messageWindowRangeAfterUnitChange(5005, 5000, { start: 2400, end: 2560 }, {
  initialUnits: 80,
  maxUnits: limit,
  tailPinned: false,
});
assertRange(middleUnpinnedAppend, 2400, 2560);

const pinnedAppend = messageWindowRangeAfterUnitChange(5002, 5000, { start: 4920, end: 5000 }, {
  initialUnits: 80,
  maxUnits: limit,
  tailPinned: true,
});
assertRange(pinnedAppend, 4922, 5002);

const cappedPinnedAppend = messageWindowRangeAfterUnitChange(5200, 5000, { start: 4840, end: 5000 }, {
  initialUnits: 80,
  maxUnits: limit,
  tailPinned: true,
});
assertRange(cappedPinnedAppend, 5040, 5200);
assertRangeInvariants(cappedPinnedAppend, 5200, limit);

assert.equal(nextTailPinnedState({
  scrollTop: 980,
  previousScrollTop: 1000,
  bottomDistancePx: 20,
  currentTailPinned: true,
}), false, 'active upward scroll must unpin even while near the tail');
assert.equal(nextTailPinnedState({
  scrollTop: 996,
  previousScrollTop: 980,
  bottomDistancePx: 4,
  currentTailPinned: false,
}), true, 'scrolling back to the exact tail must pin again');
assert.equal(nextTailPinnedState({
  scrollTop: 1000,
  previousScrollTop: 1000,
  bottomDistancePx: 30,
  currentTailPinned: false,
}), false, 'near-tail viewport is not enough to auto-pin after an explicit unpin');
assert.equal(nextTailPinnedState({
  scrollTop: 1000,
  previousScrollTop: 1000,
  bottomDistancePx: 90,
  currentTailPinned: true,
}), false, 'large distance from tail must unpin');
assert.equal(messageWindowMeasurementScrollMode({
  currentTailPinned: true,
  wasNearTailBeforeMeasurement: true,
}), 'tail', 'async measurement must keep a previously near-tail pinned view at the tail');
assert.equal(messageWindowMeasurementScrollMode({
  currentTailPinned: false,
  wasNearTailBeforeMeasurement: true,
}), 'anchor', 'near-tail but explicitly unpinned view must preserve its current anchor');
assert.equal(messageWindowMeasurementScrollMode({
  currentTailPinned: true,
  wasNearTailBeforeMeasurement: false,
}), 'anchor', 'pinned state without a near-tail observation must not force a middle viewport to the tail');

assert.equal(isMessageWindowEdgeNearViewport(-500, 160), false, 'an edge far above the viewport must not page repeatedly');
assert.equal(isMessageWindowEdgeNearViewport(-120, 160), true);
assert.equal(isMessageWindowEdgeNearViewport(120, 160), true);
assert.equal(isMessageWindowEdgeNearViewport(500, 160), false, 'an edge far below the viewport is not near yet');

assert.equal(isMessageWindowViewportBeforeRenderedWindow(120_000, 900, 300_000, 160), true, 'a viewport fully inside the top spacer must request older units');
assert.equal(isMessageWindowViewportBeforeRenderedWindow(299_950, 900, 300_000, 160), false, 'a viewport that already reaches rendered content should use normal edge detection');
assert.equal(isMessageWindowViewportBeforeRenderedWindow(0, 900, 0, 160), false, 'no top spacer means no spacer dead zone');

const manyUnits = makeUnits(5000);
const scrollJumpRange = messageWindowRangeForScrollOffset(manyUnits, 250_000, new Map(), limit, 100, 8);
assertRange(scrollJumpRange, 2492, 2652);
assert.equal(messageWindowIndexForScrollOffset(manyUnits, 250_000, new Map(), 100), 2500);

const units = makeUnits(4);
const measuredHeights = new Map([
  ['u-0', 200],
  ['u-2', 75],
]);
assert.equal(estimateMessageWindowHeight(units, 0, 4, measuredHeights, 100), 475);
assert.equal(messageWindowIndexForScrollOffset(units, 250, measuredHeights, 100), 1);
assertRange(messageWindowRangeForScrollOffset(units, 250, measuredHeights, 3, 100, 0), 1, 4);

const hundredThousandUnits = makeUnits(100_000);
const hundredThousandHeights = new Map([
  ['u-0', 80],
  ['u-50000', 240],
  ['u-99999', 50],
]);
const hundredThousandHeightIndex = createMessageWindowHeightIndex(hundredThousandUnits, hundredThousandHeights, 100);
assert.equal(
  estimateMessageWindowHeight(
    hundredThousandUnits,
    0,
    hundredThousandUnits.length,
    hundredThousandHeights,
    100,
    hundredThousandHeightIndex,
  ),
  10_000_070,
);
assert.equal(
  messageWindowIndexForScrollOffset(
    hundredThousandUnits,
    5_000_050,
    hundredThousandHeights,
    100,
    hundredThousandHeightIndex,
  ),
  50_000,
);
assertRange(
  messageWindowRangeForScrollOffset(
    hundredThousandUnits,
    5_000_050,
    hundredThousandHeights,
    limit,
    100,
    8,
    hundredThousandHeightIndex,
  ),
  49_992,
  50_152,
);

let hotPathIdReads = 0;
const hotPathUnitCount = 100_000;
const hotPathUnits = Array.from({ length: hotPathUnitCount }, (_, index) => {
  const unit = {};
  Object.defineProperty(unit, 'id', {
    enumerable: true,
    get() {
      hotPathIdReads += 1;
      return `hot-${index}`;
    },
  });
  return unit;
});
const hotPathIndexById = new Map(Array.from({ length: hotPathUnitCount }, (_, index) => [`hot-${index}`, index]));
const sparseHotPathHeights = new Map([
  ['hot-10', 220],
  ['hot-50000', 80],
  ['hot-99999', 140],
]);
assert.equal(
  estimateMessageWindowHeight(hotPathUnits, 0, hotPathUnitCount, sparseHotPathHeights, 100, hotPathIndexById),
  10_000_140,
);
assert.equal(
  messageWindowIndexForScrollOffset(hotPathUnits, 5_000_000, sparseHotPathHeights, 100, hotPathIndexById),
  49_998,
);
assertRange(
  messageWindowRangeForScrollOffset(hotPathUnits, 5_000_000, sparseHotPathHeights, limit, 100, 8, hotPathIndexById),
  49_990,
  50_150,
);
assert.equal(hotPathIdReads, 0, 'preindexed spacer and scroll-jump hot paths must not rescan 100k unit ids');

let denseHotPathIdReads = 0;
const denseHotPathUnitCount = 100_000;
const denseHotPathUnits = Array.from({ length: denseHotPathUnitCount }, (_, index) => {
  const unit = {};
  Object.defineProperty(unit, 'id', {
    enumerable: true,
    get() {
      denseHotPathIdReads += 1;
      return `dense-${index}`;
    },
  });
  return unit;
});
const denseHotPathIndexById = new Map(
  Array.from({ length: denseHotPathUnitCount }, (_, index) => [`dense-${index}`, index]),
);
const denseHotPathHeights = new Map();
const densePrefixHeights = new Array(denseHotPathUnitCount + 1).fill(0);
for (let index = 0; index < denseHotPathUnitCount; index += 1) {
  const height = 72 + (index % 57);
  denseHotPathHeights.set(`dense-${index}`, height);
  densePrefixHeights[index + 1] = densePrefixHeights[index] + height;
}
const denseHeightIndex = createMessageWindowHeightIndex(
  denseHotPathUnits,
  denseHotPathHeights,
  100,
  denseHotPathIndexById,
);
const denseTargetIndex = 73_456;
const denseTargetOffset = densePrefixHeights[denseTargetIndex] + 1;
for (let iteration = 0; iteration < 40; iteration += 1) {
  messageWindowIndexForScrollOffset(
    denseHotPathUnits,
    denseTargetOffset + iteration,
    denseHotPathHeights,
    100,
    denseHeightIndex,
  );
}
const denseEstimateStart = performance.now();
const denseEstimate = estimateMessageWindowHeight(
  denseHotPathUnits,
  12_345,
  98_765,
  denseHotPathHeights,
  100,
  denseHeightIndex,
);
const denseEstimateMs = performance.now() - denseEstimateStart;
const denseIndexStart = performance.now();
const denseLocatedIndex = messageWindowIndexForScrollOffset(
  denseHotPathUnits,
  denseTargetOffset,
  denseHotPathHeights,
  100,
  denseHeightIndex,
);
const denseIndexMs = performance.now() - denseIndexStart;
const denseRangeStart = performance.now();
const denseLocatedRange = messageWindowRangeForScrollOffset(
  denseHotPathUnits,
  denseTargetOffset,
  denseHotPathHeights,
  limit,
  100,
  8,
  denseHeightIndex,
);
const denseRangeMs = performance.now() - denseRangeStart;
assert.equal(denseEstimate, densePrefixHeights[98_765] - densePrefixHeights[12_345]);
assert.equal(denseLocatedIndex, denseTargetIndex);
assertRange(denseLocatedRange, 73_448, 73_608);
assert.equal(denseHotPathIdReads, 0, 'dense height index hot paths must not touch unit ids after preindexing');
assert.ok(denseEstimateMs < 16, `dense 100k estimate should stay below one frame, got ${denseEstimateMs.toFixed(3)}ms`);
assert.ok(denseIndexMs < 16, `dense 100k index lookup should stay below one frame, got ${denseIndexMs.toFixed(3)}ms`);
assert.ok(denseRangeMs < 16, `dense 100k range lookup should stay below one frame, got ${denseRangeMs.toFixed(3)}ms`);
console.log(
  `dense 100k height-index benchmark: estimate=${denseEstimateMs.toFixed(3)}ms index=${denseIndexMs.toFixed(3)}ms range=${denseRangeMs.toFixed(3)}ms`,
);

const agentPanelSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'layout', 'AgentPanel.tsx'),
  'utf8',
);
const conversationSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'store', 'slices', 'conversation.ts'),
  'utf8',
);
assert.match(source, /class MessageWindowFenwickTree/);
assert.match(source, /createMessageWindowHeightIndex/);
assert.match(source, /function resolveTaskBoundaryBodyRange/);
assert.match(source, /function isIndexInTaskBoundaryBodyRange/);
assert.match(source, /heightIndexRef/);
assert.doesNotMatch(source, /new Map\(heightByIdRef\.current\)/);
assert.match(source, /measuredContainerWidth/);
assert.match(source, /observer\.observe\(container\);/);
assert.match(source, /messageWindowMeasurementScrollMode/);
assert.match(source, /lastViewportAnchorRef/);
assert.match(source, /pendingMeasurementAnchorRef/);
assert.match(source, /pendingMeasurementAnchorRef\.current \?\? lastViewportAnchorRef\.current \?\? captureMessageWindowViewportAnchor\(container\)/);
assert.match(source, /layoutGenerationRef\.current !== expectedGeneration/);
assert.match(source, /lastViewportAnchorRef\.current = undefined/);
assert.match(source, /container\.addEventListener\('scroll', handleScroll, \{ passive: true \}\)/);
assert.match(source, /recoveryMode === 'tail'[\s\S]{0,160}currentContainer\.scrollTop = currentContainer\.scrollHeight/);
assert.match(source, /recoveryMode === 'anchor'[\s\S]{0,200}captureMessageWindowViewportAnchor\(container\)/);
assert.match(source, /restoreMessageWindowViewportAnchor\(currentContainer, pendingAnchor\);[\s\S]{0,120}rememberViewportAnchor\(currentContainer\)/);
assert.match(agentPanelSource, /const INITIAL_MESSAGE_RENDER_UNITS = 32;/);
assert.match(agentPanelSource, /const MESSAGE_RENDER_UNIT_BATCH = 16;/);
assert.match(agentPanelSource, /const MAX_MESSAGE_RENDER_UNITS = 48;/);
assert.match(agentPanelSource, /tailUnpinThresholdPx: TAIL_UNPIN_THRESHOLD_PX/);
assert.match(agentPanelSource, /const messageTopologyRevision = conversation\.messageTopologyRevision;/);
assert.match(agentPanelSource, /const messageRenderProjection = useMemo\([\s\S]{0,1800}\}, \[agentSettings\.hideSystemToolCalls, messageTopologyRevision, messages\.length, taskBoundaryRender\.startMap\]\);/);
assert.doesNotMatch(agentPanelSource, /const messageRenderProjection = useMemo\([\s\S]{0,1800}\}, \[[^\]]*\bmessages\b(?!\.length)[^\]]*\]\);/);
assert.match(agentPanelSource, /const taskBoundaryTopologyRevision = conversation\.taskBoundaryTopologyRevision \?\? 0;/);
assert.match(agentPanelSource, /const taskBoundaryById = useMemo\(\(\) => \{/);
const taskBoundaryRenderBlock = agentPanelSource.slice(
  agentPanelSource.indexOf('const taskBoundaryRender = useMemo'),
  agentPanelSource.indexOf('// 超长对话只挂载最近一段顶层消息单元'),
);
assert.match(taskBoundaryRenderBlock, /\}, \[agentSettings\.hideSystemToolCalls, messageTopologyRevision, messages\.length, taskBoundaryTopologyRevision\]\);/);
assert.doesNotMatch(taskBoundaryRenderBlock, /\}, \[[^\]]*conversation\.taskBoundaries[^\]]*\]\);/);
assert.match(taskBoundaryRenderBlock, /boundaryId: r\.boundaryId/);
assert.doesNotMatch(taskBoundaryRenderBlock, /boundary:\s*range\.b/);
assert.match(taskBoundaryRenderBlock, /resolveTaskBoundaryBodyRange\(b, msgIdToIdx, messages\.length\)/);
assert.match(taskBoundaryRenderBlock, /bodyRanges/);
assert.match(taskBoundaryRenderBlock, /bodyRangeForMessageId/);
assert.match(taskBoundaryRenderBlock, /countBoundaryBodyItems/);
assert.doesNotMatch(taskBoundaryRenderBlock, /itemIndices/);
assert.doesNotMatch(taskBoundaryRenderBlock, /itemIndexById/);
const messageRenderProjectionBlock = agentPanelSource.slice(
  agentPanelSource.indexOf('const messageRenderProjection = useMemo'),
  agentPanelSource.indexOf('const messageRenderUnits = messageRenderProjection.units'),
);
assert.match(messageRenderProjectionBlock, /boundaryId: range\.boundaryId/);
assert.match(messageRenderProjectionBlock, /unitIndexByBoundaryId/);
assert.doesNotMatch(messageRenderProjectionBlock, /for \(const itemIndex of range\./);
assert.match(agentPanelSource, /taskBoundaryById\.get\(unit\.boundaryId\)/);
assert.match(agentPanelSource, /const resolveMessageRenderUnit = useCallback/);
assert.match(agentPanelSource, /taskBoundaryRender\.bodyRangeForMessageId\(messageId\)/);
assert.match(agentPanelSource, /const coveredRanges = taskBoundaryRender\.bodyRanges;/);
assert.match(agentPanelSource, /resolveTaskBoundaryBodyRange\(boundary, messageIndexById, targetConversation\.messages\.length\)/);
assert.match(agentPanelSource, /const taskBoundaryTailFollowKey = useMemo/);
assert.match(agentPanelSource, /const contentGrowthWhilePinned = isAtBottomRef\.current && scrollTopUnchanged && bottomDistancePx > TAIL_PIN_THRESHOLD_PX;/);
assert.match(agentPanelSource, /if \(contentGrowthWhilePinned\) \{[\s\S]{0,180}isAtBottomRef\.current = true;[\s\S]{0,120}el\.scrollTop = el\.scrollHeight;/);
assert.match(agentPanelSource, /isStreaming=\{\(msg as any\)\.isStreaming\}/);
assert.doesNotMatch(agentPanelSource, /isStreaming=\{isAgentRunActive\}/);
assert.match(conversationSource, /messageTopologyRevision: number;/);
assert.match(conversationSource, /taskBoundaryTopologyRevision: number;/);
assert.match(conversationSource, /function bumpMessageTopologyRevision\(bucket: PerConversation\)/);
assert.match(conversationSource, /function bumpTaskBoundaryTopologyRevision\(bucket: PerConversation\)/);
const setTaskHeadlineBlock = conversationSource.slice(
  conversationSource.indexOf('setTaskHeadline(state'),
  conversationSource.indexOf('appendTaskStep(state'),
);
const appendTaskStepBlock = conversationSource.slice(
  conversationSource.indexOf('appendTaskStep(state'),
  conversationSource.indexOf('endTaskBoundary(state'),
);
assert.doesNotMatch(setTaskHeadlineBlock, /bumpTaskBoundaryTopologyRevision/);
assert.doesNotMatch(appendTaskStepBlock, /bumpTaskBoundaryTopologyRevision/);
const addMessageDiffBlock = conversationSource.slice(
  conversationSource.indexOf('addMessageDiff(state'),
  conversationSource.indexOf('addMessageArtifact(state'),
);
const addMessageArtifactBlock = conversationSource.slice(
  conversationSource.indexOf('addMessageArtifact(state'),
  conversationSource.indexOf('updateDiffStatus(state'),
);
assert.match(addMessageDiffBlock, /bumpMessageTopologyRevision\(b\);/);
assert.match(addMessageArtifactBlock, /bumpMessageTopologyRevision\(b\);/);
assert.match(agentPanelSource, /const PLAN_STEP_BATCH = 80;/);
assert.match(agentPanelSource, /planMessages\.slice\(Math\.max\(0, planMessages\.length - planVisibleStepCount\)\)/);
assert.match(agentPanelSource, /加载更早工具记录 · 还剩/);
assert.match(agentPanelSource, /localStorage\.setItem\(\`synapse:chat-scroll:/);
assert.match(agentPanelSource, /localStorage\.getItem\(\`synapse:chat-scroll:/);
assert.match(agentPanelSource, /beforeunload/);
assert.doesNotMatch(agentPanelSource, /sessionStorage\.(?:setItem|getItem)\(\`synapse:chat-scroll:/);
assert.match(agentPanelSource, /onClick=\{jumpToLatestMessageWindow\}[\s\S]{0,120}跳到最新/);
assert.match(agentPanelSource, /function selectChatScrollCheckpointAnchorElement\(container: HTMLElement, containerRect: DOMRect\)/);
assert.match(agentPanelSource, /topInsideViewport: rect\.top >= viewportTop && rect\.top < viewportBottom/);
assert.match(agentPanelSource, /!selected\.topInsideViewport && !isChatScrollAnchorOffsetWithinViewportBand\(selected\.offsetTop, container\.clientHeight\)/);
assert.match(agentPanelSource, /const anchorElement = selectChatScrollCheckpointAnchorElement\(current, containerRect\);/);
assert.match(agentPanelSource, /offset: clampChatScrollAnchorOffset\(anchorElement\.getBoundingClientRect\(\)\.top - containerRect\.top, current\.clientHeight\)/);
assert.match(agentPanelSource, /if \(restoringScrollRef\.current\) \{[\s\S]{0,180}lastMessagesScrollTopRef\.current = el\.scrollTop;[\s\S]{0,120}return;/);
assert.match(agentPanelSource, /if \(!raw\) \{\s*restoreDefaultTail\(\);\s*return;\s*\}/);
assert.match(agentPanelSource, /const canUseStoredAnchorOffset = restored\.anchor\?\.id[\s\S]{0,180}isChatScrollAnchorOffsetWithinViewportBand\(restored\.anchor\.offset, restoreViewportHeight\)/);
assert.match(agentPanelSource, /setMessageWindowRange\(\{ start: fallbackWindowStart, end: restoredEnd \}\)/);
assert.match(agentPanelSource, /const applyScrollTopFallback = \(\) => \{[\s\S]{0,220}clampChatScrollTopForRestore/);
assert.match(agentPanelSource, /if \(!restored\.anchor\?\.id \|\| !anchorUnit\) \{[\s\S]{0,100}applyScrollTopFallback\(\);/);
assert.match(agentPanelSource, /if \(!isChatScrollAnchorOffsetWithinViewportBand\(restored\.anchor\?\.offset, container\.clientHeight\)\) \{[\s\S]{0,100}applyScrollTopFallback\(\);/);
assert.match(agentPanelSource, /const desiredOffset = clampChatScrollAnchorOffset\(restored\.anchor\?\.offset, container\.clientHeight\);/);
assert.match(agentPanelSource, /catch \{\s*restoreDefaultTail\(\);\s*\}/);
assert.match(agentPanelSource, /let attempts = 0;[\s\S]{0,2200}stableAlignments >= 2/);
assert.match(agentPanelSource, /let anchorEverFound = false;[\s\S]{0,1600}anchorEverFound = true/);
assert.match(agentPanelSource, /attempts >= 20[\s\S]{0,260}if \(anchorEverFound\)[\s\S]{0,120}restoringScrollRef\.current = false[\s\S]{0,180}else[\s\S]{0,120}applyScrollTopFallback\(\);/);
assert.match(agentPanelSource, /confirmedMissing = !\(await platform\.conversation\.get\(selectedConversationId\)\)/);
assert.match(agentPanelSource, /for \(const retryDelayMs of \[250, 750, 1500\]\)/);
assert.match(agentPanelSource, /const shouldRestoreSnapshot = restoredPersistedConversation[\s\S]{0,160}Boolean\(data\?\.id\)[\s\S]{0,120}restoredMessages\.length > 0/);
assert.doesNotMatch(agentPanelSource, /const coveredRanges: Array<\{ start: number; end: number \}> = \[\]/);
assert.doesNotMatch(agentPanelSource, /const coveredIdx = new Set<number>\(\)/);
assert.match(agentPanelSource, /selectionStillCurrent/);
assert.match(agentPanelSource, /liveConversationIdRef\.current !== conversationId[\s\S]{0,120}restoringScrollRef\.current = false/);
assert.match(agentPanelSource, /const switchEpoch = beginConversationSwitch\(\)[\s\S]{0,2600}isConversationSwitchCurrent\(switchEpoch\)/);
const conversationListSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'chat', 'ConversationList.tsx'),
  'utf8',
);
const conversationPersistenceSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'conversationPersistence.ts'),
  'utf8',
);
assert.match(conversationListSource, /const switchEpoch = beginConversationSwitch\(\)[\s\S]{0,900}isConversationSwitchCurrent\(switchEpoch\)/);
assert.match(conversationPersistenceSource, /conversationSwitchEpoch[\s\S]{0,500}isConversationSwitchCurrent/);
const deleteCallIndex = conversationPersistenceSource.indexOf('const deleted = await platform.conversation.delete(id)');
const releaseCallIndex = conversationPersistenceSource.indexOf('await releaseSnapshotAttachments(snapshot)', deleteCallIndex);
assert.ok(deleteCallIndex >= 0 && releaseCallIndex > deleteCallIndex, 'attachments must release only after confirmed conversation deletion');
assert.match(conversationPersistenceSource, /if \(!deleted\) throw new Error\(`conversation delete rejected:/);

console.log('message-window integration assertions passed');
