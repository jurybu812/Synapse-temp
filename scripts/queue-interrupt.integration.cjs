const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function compileTypeScript(sourcePath, dependencies = {}) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: sourcePath,
  });
  const runtimeModule = { exports: {} };
  const localRequire = request => {
    if (Object.prototype.hasOwnProperty.call(dependencies, request)) return dependencies[request];
    return require(request);
  };
  new Function('module', 'exports', 'require', compiled.outputText)(
    runtimeModule,
    runtimeModule.exports,
    localRequire,
  );
  return runtimeModule.exports;
}

const servicesDir = path.join(__dirname, '..', 'src', 'services');
const storeDir = path.join(__dirname, '..', 'src', 'store', 'slices');
const queueDrain = compileTypeScript(path.join(servicesDir, 'queueDrainCoordinator.ts'));

const {
  QueueDrainCoordinator,
  buildQueueDrainBatch,
  hasPendingToolTaskWork,
  isQueueDrainBatchCurrent,
  queueDrainBlockReason,
  queueDrainBoundaryMode,
} = queueDrain;

function queued(id, text = id) {
  return { id, text, enqueuedAt: 1788100000000 };
}

function bucket(queue = [], interrupt = []) {
  return { queuedMessages: queue, interruptMessages: interrupt, isStreaming: false };
}

function createHarness() {
  const coordinator = new QueueDrainCoordinator();
  const conversations = new Map([
    ['A', bucket()],
    ['B', bucket()],
  ]);
  const sent = [];
  const flags = {
    activeConversationId: 'A',
    running: new Set(),
    loopUnavailable: new Set(),
    hardPaused: new Set(),
    credentialUnavailable: new Set(),
    historyMutation: false,
  };
  coordinator.registerHandler(async conversationId => {
    const conversation = conversations.get(conversationId) ?? bucket();
    const batchToDrain = buildQueueDrainBatch(conversation);
    if (batchToDrain.length === 0) return { status: 'empty', reason: 'empty' };
    const block = queueDrainBlockReason({
      isStreaming: conversation.isStreaming,
      isRunning: flags.running.has(conversationId),
      hasHistoryMutation: flags.historyMutation,
      hasRunnableModel: !flags.credentialUnavailable.has(conversationId),
      hasLoop: !flags.loopUnavailable.has(conversationId),
    });
    if (block) return { status: 'blocked', reason: block };
    if (flags.hardPaused.has(conversationId)) return { status: 'blocked', reason: 'hard-paused' };
    if (!isQueueDrainBatchCurrent(conversation, batchToDrain)) return { status: 'blocked', reason: 'batch-changed' };

    const boundaryMode = queueDrainBoundaryMode(batchToDrain);
    if (boundaryMode !== 'none') sent.push({ type: 'boundary', conversationId, mode: boundaryMode });
    sent.push({
      type: 'run',
      conversationId,
      activeConversationId: flags.activeConversationId,
      texts: batchToDrain.map(item => item.message.text),
      sources: batchToDrain.map(item => item.source),
    });
    for (const item of batchToDrain) {
      const key = item.source === 'interrupt' ? 'interruptMessages' : 'queuedMessages';
      conversation[key] = conversation[key].filter(message => message.id !== item.message.id);
    }
    return { status: 'started' };
  });
  return { coordinator, conversations, flags, sent };
}

async function testForegroundDrain() {
  const h = createHarness();
  h.conversations.get('A').queuedMessages.push(queued('q1', 'foreground queued'));
  await h.coordinator.drainNow('A', 'foreground-idle');
  assert.deepEqual(h.sent.map(event => event.type), ['boundary', 'run']);
  assert.deepEqual(h.sent[1], {
    type: 'run',
    conversationId: 'A',
    activeConversationId: 'A',
    texts: ['foreground queued'],
    sources: ['queue'],
  });
  assert.equal(h.conversations.get('A').queuedMessages.length, 0);
}

async function testBackgroundSettleDrainDoesNotUseActiveConversation() {
  const h = createHarness();
  h.flags.activeConversationId = 'B';
  h.conversations.get('A').queuedMessages.push(queued('a1', 'A queued after switch'));
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.equal(h.sent[1].conversationId, 'A');
  assert.equal(h.sent[1].activeConversationId, 'B');
  assert.deepEqual(h.sent[1].texts, ['A queued after switch']);
  assert.equal(h.conversations.get('B').queuedMessages.length, 0);
}

async function testResidualInterruptRunsBeforeQueuedMessages() {
  const h = createHarness();
  h.conversations.get('A').queuedMessages.push(queued('q1', 'first'), queued('q2', 'second'));
  h.conversations.get('A').interruptMessages.push(queued('i1', 'late interrupt'));
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent[0], { type: 'boundary', conversationId: 'A', mode: 'aborted' });
  assert.deepEqual(h.sent[1].texts, ['late interrupt']);
  assert.deepEqual(h.sent[1].sources, ['interrupt']);
  assert.deepEqual(h.conversations.get('A').queuedMessages.map(message => message.text), ['first', 'second']);
  assert.equal(h.conversations.get('A').interruptMessages.length, 0);
}

function testNewInterruptInvalidatesPreparedQueueBatch() {
  const currentBucket = bucket([queued('q1', 'queued first')]);
  const preparedBatch = buildQueueDrainBatch(currentBucket);
  currentBucket.interruptMessages.push(queued('i1', 'arrived during async preparation'));
  assert.equal(isQueueDrainBatchCurrent(currentBucket, preparedBatch), false);
}

async function testStopClearsQueueAndCancelsPendingDrain() {
  const h = createHarness();
  h.conversations.get('A').queuedMessages.push(queued('q1', 'must not send'));
  h.coordinator.cancelDrain('A');
  h.conversations.get('A').queuedMessages = [];
  h.conversations.get('A').interruptMessages = [];
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent, []);
}

async function testPendingRequestRunsAfterHandlerRegistration() {
  const coordinator = new QueueDrainCoordinator();
  const calls = [];
  coordinator.requestDrain('A', 'agent-settled');
  coordinator.registerHandler(conversationId => {
    calls.push(conversationId);
    return { status: 'empty', reason: 'empty' };
  });
  await coordinator.drainNow('A', 'manual');
  assert.deepEqual(calls, ['A']);
}

async function testSafetyBlocksPreserveQueue() {
  const h = createHarness();
  h.conversations.get('A').queuedMessages.push(queued('q1', 'preserve me'));

  h.flags.historyMutation = true;
  await h.coordinator.drainNow('A', 'foreground-idle');
  assert.deepEqual(h.sent, []);
  assert.equal(h.conversations.get('A').queuedMessages.length, 1);

  h.flags.historyMutation = false;
  h.flags.hardPaused.add('A');
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent, []);
  assert.equal(h.conversations.get('A').queuedMessages.length, 1);

  h.flags.hardPaused.clear();
  h.flags.credentialUnavailable.add('A');
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent, []);
  assert.equal(h.conversations.get('A').queuedMessages.length, 1);
}

function testPendingToolTasksBlockDrain() {
  const pendingBucket = bucket([queued('q1', 'wait for background task')]);
  pendingBucket.messages = [{ toolCalls: [{ status: 'running' }] }];
  assert.equal(hasPendingToolTaskWork(pendingBucket), true);
  assert.equal(queueDrainBlockReason({ hasPendingToolTasks: true }), 'tool-task-running');

  pendingBucket.messages = [{ toolCalls: [{ status: 'success' }, { status: 'cancelled' }] }];
  assert.equal(hasPendingToolTaskWork(pendingBucket), false);
  assert.equal(queueDrainBlockReason({ hasPendingToolTasks: false }), null);
}

async function testInterruptResidualClosesOldBoundaryBeforeNewUserMessage() {
  const h = createHarness();
  h.conversations.get('A').interruptMessages.push(queued('i1', 'interrupt as next user message'));
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent, [
    { type: 'boundary', conversationId: 'A', mode: 'aborted' },
    {
      type: 'run',
      conversationId: 'A',
      activeConversationId: 'A',
      texts: ['interrupt as next user message'],
      sources: ['interrupt'],
    },
  ]);
}

function testSourceContracts() {
  const agentLoopSource = fs.readFileSync(path.join(servicesDir, 'agentLoop.ts'), 'utf8');
  const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'layout', 'AgentPanel.tsx'), 'utf8');
  const conversationSource = fs.readFileSync(path.join(storeDir, 'conversation.ts'), 'utf8');

  assert.match(agentLoopSource, /queueDrainCoordinator\.requestDrain\(completedConversationId, 'agent-settled'\)/);
  assert.match(agentLoopSource, /await drainInterruptMessages\(\);[\s\S]*?【任务边界收口提醒】/);
  assert.match(agentLoopSource, /await drainInterruptMessages\(\);\s*if \(!this\.running\) break;/);
  assert.match(agentLoopSource, /await restoreApiMessagesAttachments[\s\S]{0,260}if \(!this\.running\) return;[\s\S]{0,120}apiMessages\.push/);
  assert.match(agentLoopSource, /if \(this\.activeRunSettled && !this\.running\) await this\.activeRunSettled/);
  assert.match(agentLoopSource, /await bpcScheduler\.ensureConversationReady[\s\S]{0,120}if \(!this\.running\) return;/);
  assert.match(agentLoopSource, /await readRecordAfterReadyPublication[\s\S]{0,240}if \(!this\.running\) return;/);
  assert.match(agentLoopSource, /await this\.runHardCompaction[\s\S]{0,420}if \(!this\.running\) return;/);
  assert.match(agentLoopSource, /await restoreApiMessagesAttachments[\s\S]{0,320}if \(!this\.running\) return;/);
  assert.match(agentLoopSource, /const ownsStreamingRun = this\.executionContext[\s\S]{0,180}executionRegistry\.isActiveRun\(this\.executionContext\)[\s\S]{0,180}if \(ownsStreamingRun\)[\s\S]{0,120}setStreaming\(\{ value: false/);
  assert.match(agentLoopSource, /onTaskStarted: async snapshot => \{[\s\S]{0,160}!this\.running[\s\S]{0,160}!executionRegistry\.isActiveRun\(callContext\)[\s\S]{0,160}return/);
  assert.match(panelSource, /executionRegistry\.getLoop<AgentLoop>\(targetConversationId\)/);
  assert.match(panelSource, /special-background-blocked/);
  assert.match(conversationSource, /重载恢复暂不启用/);
}

async function main() {
  await testForegroundDrain();
  await testBackgroundSettleDrainDoesNotUseActiveConversation();
  await testResidualInterruptRunsBeforeQueuedMessages();
  testNewInterruptInvalidatesPreparedQueueBatch();
  await testStopClearsQueueAndCancelsPendingDrain();
  await testPendingRequestRunsAfterHandlerRegistration();
  await testSafetyBlocksPreserveQueue();
  testPendingToolTasksBlockDrain();
  await testInterruptResidualClosesOldBoundaryBeforeNewUserMessage();
  testSourceContracts();
  console.log('Queue/interrupt drain integration: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
