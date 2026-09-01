const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  estimateMessageWindowHeight,
  isMessageWindowEdgeNearViewport,
  messageWindowRangeAfterUnitChange,
  messageWindowRangeForIndex,
  moveMessageWindowRange,
  nextTailPinnedState,
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

const unpinnedAppend = messageWindowRangeAfterUnitChange(5002, 5000, { start: 4920, end: 5000 }, {
  initialUnits: 80,
  maxUnits: limit,
  tailPinned: false,
});
assertRange(unpinnedAppend, 4920, 5000);

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

assert.equal(isMessageWindowEdgeNearViewport(-500, 160), false, 'an edge far above the viewport must not page repeatedly');
assert.equal(isMessageWindowEdgeNearViewport(-120, 160), true);
assert.equal(isMessageWindowEdgeNearViewport(120, 160), true);
assert.equal(isMessageWindowEdgeNearViewport(500, 160), false, 'an edge far below the viewport is not near yet');

const units = makeUnits(4);
const measuredHeights = new Map([
  ['u-0', 200],
  ['u-2', 75],
]);
assert.equal(estimateMessageWindowHeight(units, 0, 4, measuredHeights, 100), 475);

const agentPanelSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'layout', 'AgentPanel.tsx'),
  'utf8',
);
assert.match(agentPanelSource, /const INITIAL_MESSAGE_RENDER_UNITS = 32;/);
assert.match(agentPanelSource, /const MESSAGE_RENDER_UNIT_BATCH = 16;/);
assert.match(agentPanelSource, /const MAX_MESSAGE_RENDER_UNITS = 48;/);
assert.match(agentPanelSource, /const PLAN_STEP_BATCH = 80;/);
assert.match(agentPanelSource, /planMessages\.slice\(Math\.max\(0, planMessages\.length - planVisibleStepCount\)\)/);
assert.match(agentPanelSource, /加载更早工具记录 · 还剩/);
assert.match(agentPanelSource, /localStorage\.setItem\(\`synapse:chat-scroll:/);
assert.match(agentPanelSource, /localStorage\.getItem\(\`synapse:chat-scroll:/);
assert.match(agentPanelSource, /beforeunload/);
assert.doesNotMatch(agentPanelSource, /sessionStorage\.(?:setItem|getItem)\(\`synapse:chat-scroll:/);
assert.match(agentPanelSource, /candidateRect\.bottom > containerRect\.top \+ 1[\s\S]{0,120}candidateRect\.top < containerRect\.bottom - 1/);
assert.match(agentPanelSource, /visibleAnchorCandidates\.find\(candidate => candidate\.dataset\.messageId\)/);
assert.match(agentPanelSource, /if \(restoringScrollRef\.current\) \{[\s\S]{0,180}lastMessagesScrollTopRef\.current = el\.scrollTop;[\s\S]{0,120}return;/);
assert.match(agentPanelSource, /if \(!raw\) \{\s*restoreDefaultTail\(\);\s*return;\s*\}/);
assert.match(agentPanelSource, /if \(!restored\.anchor\?\.id \|\| !anchorUnit\) \{[\s\S]{0,180}container\.scrollTop = chatScrollTopRef\.current/);
assert.match(agentPanelSource, /catch \{\s*restoreDefaultTail\(\);\s*\}/);
assert.match(agentPanelSource, /let attempts = 0;[\s\S]{0,1500}stableAlignments >= 2/);
assert.match(agentPanelSource, /let anchorEverFound = false;[\s\S]{0,900}anchorEverFound = true/);
assert.match(agentPanelSource, /attempts >= 20[\s\S]{0,220}if \(anchorEverFound\)[\s\S]{0,120}restoringScrollRef\.current = false[\s\S]{0,180}else[\s\S]{0,180}currentContainer\.scrollTop = chatScrollTopRef\.current/);
assert.match(agentPanelSource, /confirmedMissing = !\(await platform\.conversation\.get\(selectedConversationId\)\)/);
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
