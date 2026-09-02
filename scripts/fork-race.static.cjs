const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const agentPanelPath = path.join(repoRoot, 'src', 'components', 'layout', 'AgentPanel.tsx');
const source = fs.readFileSync(agentPanelPath, 'utf8');

const handleStart = source.indexOf('const handleBranch = useCallback((msgId: string) => {');
assert.ok(handleStart >= 0, 'handleBranch must be locatable');
const handleEnd = source.indexOf('const openReviewChanges = useCallback', handleStart);
assert.ok(handleEnd > handleStart, 'handleBranch end must be locatable');
const handleBranch = source.slice(handleStart, handleEnd);

function assertOrdered(snippets, message) {
  let cursor = -1;
  for (const snippet of snippets) {
    const next = handleBranch.indexOf(snippet, cursor + 1);
    assert.ok(next > cursor, `${message}: missing or out of order: ${snippet}`);
    cursor = next;
  }
}

assert.ok(
  handleBranch.includes('const switchEpoch = beginConversationSwitch();'),
  'Fork must freeze the switch epoch returned by beginConversationSwitch',
);
assert.ok(
  handleBranch.includes('const sourceSnapshot = {'),
  'Fork must freeze a source conversation snapshot at entry',
);
assert.ok(
  handleBranch.includes('const isBranchSourceStillCurrent = () => {'),
  'Fork must have a source-current guard',
);
assert.ok(
  handleBranch.includes('const isBranchTargetStillCurrent = (targetId: string) => {'),
  'Fork must have a target-current guard for post-switch awaits',
);

assertOrdered([
  "await bpcScheduler.discardCurrent(recordSrcId, 'Fork 只继承分支点之前已发布的压缩历史');",
  'if (!isBranchSourceStillCurrent()) return;',
], 'discard await must be guarded before later UI/source reads');

assertOrdered([
  'recordSnapshot = await getRecord(recordSrcId).catch(() => null);',
  'if (!isBranchSourceStillCurrent()) return;',
], 'getRecord await must be guarded before clear/save');

assertOrdered([
  'const result = await branchConversation(srcId, msgId, snapshotMessages, {',
  'if (!isBranchSourceStillCurrent()) return;',
], 'branchConversation await must be guarded before dispatching result');

assert.ok(
  !/branchConversation\([^]*?title:\s*conversationRef\.current\.title/.test(handleBranch),
  'branchConversation meta must not read a later active conversation title',
);
assert.ok(
  !/saveConversationSnapshot\(\{[^]*?title:\s*conversationRef\.current\.title/.test(handleBranch),
  'autosave promotion must not read a later active conversation title',
);

function createRaceModel() {
  let epoch = 1;
  let activeId = 'A';
  let selectedId = 'A';
  const forkEpoch = epoch;
  const sourceIds = new Set(['A']);
  const writes = [];

  const isSourceCurrent = () => epoch === forkEpoch && sourceIds.has(activeId) && selectedId === activeId;
  const isTargetCurrent = targetId => epoch === forkEpoch && activeId === targetId && selectedId === targetId;
  const switchToB = () => {
    epoch += 1;
    activeId = 'B';
    selectedId = 'B';
  };
  const promoteSource = nextId => {
    sourceIds.add(nextId);
    activeId = nextId;
    selectedId = nextId;
  };
  const applyBranchResult = newId => {
    if (!isSourceCurrent()) return false;
    activeId = newId;
    selectedId = newId;
    writes.push(`switch:${newId}`);
    return true;
  };
  const refillPendingUser = targetId => {
    if (!isTargetCurrent(targetId)) return false;
    writes.push(`refill:${targetId}`);
    return true;
  };

  return { isSourceCurrent, isTargetCurrent, switchToB, promoteSource, applyBranchResult, refillPendingUser, writes };
}

for (const awaitPoint of ['discard', 'getRecord', 'branchConversation']) {
  const model = createRaceModel();
  if (awaitPoint !== 'discard') assert.equal(model.isSourceCurrent(), true, `${awaitPoint}: source starts current`);
  if (awaitPoint === 'branchConversation') model.promoteSource('A-real');
  model.switchToB();
  assert.equal(model.isSourceCurrent(), false, `${awaitPoint}: switching to B must stale the old Fork`);
  assert.equal(model.applyBranchResult('A-branch'), false, `${awaitPoint}: stale persisted Fork result must not switch UI`);
  assert.deepEqual(model.writes, [], `${awaitPoint}: stale Fork must not write B-facing UI`);
}

{
  const model = createRaceModel();
  assert.equal(model.applyBranchResult('A-branch'), true, 'fresh Fork may switch to its new branch');
  model.switchToB();
  assert.equal(model.refillPendingUser('A-branch'), false, 'late pending-user refill after target switch must not touch B');
  assert.deepEqual(model.writes, ['switch:A-branch'], 'late refill must be suppressed after switching away');
}

console.log('fork-race static/source guard checks passed');
