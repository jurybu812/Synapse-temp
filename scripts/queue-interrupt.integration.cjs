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
  interruptContinuationFromBoundary,
  isQueueDrainBatchCurrent,
  queueDrainBlockReason,
  queueDrainBoundaryMode,
} = queueDrain;

function queued(id, text = id, extra = {}) {
  return { id, text, enqueuedAt: 1788100000000, ...extra };
}

function activeBoundary(id = 'tb-old', headline = '旧任务', summary = '旧概述', continuationIndex = 0) {
  return { id, headline, summary, status: 'active', continuationIndex, steps: [], history: [] };
}

function bucket(queue = [], interrupt = [], taskBoundaries = []) {
  return { queuedMessages: queue, interruptMessages: interrupt, taskBoundaries, messages: [], isStreaming: false };
}

function createHarness() {
  const coordinator = new QueueDrainCoordinator();
  const conversations = new Map([
    ['A', bucket()],
    ['B', bucket()],
  ]);
  const sent = [];
  const requests = [];
  const handlerCalls = [];
  const flags = {
    activeConversationId: 'A',
    running: new Set(),
    loopUnavailable: new Set(),
    hardPaused: new Set(),
    credentialUnavailable: new Set(),
    historyMutation: false,
  };
  coordinator.registerHandler(async conversationId => {
    handlerCalls.push(conversationId);
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
    let continuation = null;
    if (boundaryMode === 'interrupted') {
      const active = conversation.taskBoundaries?.find(boundary => boundary.status === 'active');
      const inherited = active
        ? interruptContinuationFromBoundary(active)
        : coordinator.peekInterruptContinuation(conversationId);
      if (active) {
        active.status = 'interrupted';
        sent.push({ type: 'boundary', conversationId, mode: 'interrupted', id: active.id });
      }
      if (inherited) {
        continuation = {
          type: 'continuation',
          conversationId,
          previousBoundaryId: inherited.previousBoundaryId,
          anchorAfterSource: 'last-interrupt-user',
          headline: `插队后继续：${inherited.previousHeadline ?? inherited.previousBoundaryId}`,
          continuationIndex: inherited.continuationIndex,
        };
      }
    } else if (boundaryMode !== 'none') {
      sent.push({ type: 'boundary', conversationId, mode: boundaryMode });
    }
    requests.push({
      conversationId,
      texts: batchToDrain.map(item => item.message.text),
      sources: batchToDrain.map(item => item.source),
      attachments: batchToDrain.map(item => (item.message.attachments ?? []).map(attachment => attachment.id)),
      contentParts: batchToDrain.map(item => item.message.contentParts ?? []),
      beforeRunMessages: conversation.messages.map(message => ({ role: message.role, content: message.content })),
    });
    sent.push({
      type: 'run',
      conversationId,
      activeConversationId: flags.activeConversationId,
      texts: batchToDrain.map(item => item.message.text),
      sources: batchToDrain.map(item => item.source),
    });
    for (const item of batchToDrain) {
      conversation.messages.push({
        id: `user-${item.message.id}`,
        role: 'user',
        content: item.message.text,
        contentParts: item.message.contentParts,
        attachments: item.message.attachments,
        richTokens: item.message.richTokens,
        timestamp: item.message.enqueuedAt,
      });
    }
    for (const item of batchToDrain) {
      const key = item.source === 'interrupt' ? 'interruptMessages' : 'queuedMessages';
      conversation[key] = conversation[key].filter(message => message.id !== item.message.id);
    }
    if (continuation) {
      sent.push(continuation);
      coordinator.clearInterruptContinuation(conversationId);
    }
    return { status: 'started' };
  });
  const completeAssistant = (conversationId, content) => {
    const conversation = conversations.get(conversationId);
    conversation.messages.push({
      id: `assistant-${conversation.messages.length + 1}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  };
  return { coordinator, conversations, flags, sent, requests, handlerCalls, completeAssistant };
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

async function testQueuedMessagesDrainAsOneHumanTurnWithOrderAndAttachments() {
  const h = createHarness();
  const firstAttachment = { id: 'att-q1', kind: 'image', name: 'first.png' };
  const secondAttachment = { id: 'att-q2', kind: 'file', name: 'second.txt' };
  h.conversations.get('A').queuedMessages.push(
    queued('q1', 'first queued turn', {
      attachments: [firstAttachment],
      contentParts: [{ type: 'text', text: 'first queued turn' }],
    }),
    queued('q2', 'second queued turn', {
      attachments: [secondAttachment],
      contentParts: [{ type: 'text', text: 'second queued turn' }],
      richTokens: [{ type: 'literal', text: 'second queued turn' }],
    }),
  );

  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent.map(event => event.type), ['boundary', 'run']);
  assert.deepEqual(h.sent[1].texts, ['first queued turn', 'second queued turn']);
  assert.deepEqual(h.sent[1].sources, ['queue', 'queue']);
  assert.deepEqual(h.conversations.get('A').queuedMessages, []);
  assert.deepEqual(h.requests.map(request => request.texts), [['first queued turn', 'second queued turn']]);
  assert.deepEqual(h.requests[0].attachments, [['att-q1'], ['att-q2']]);
  assert.deepEqual(h.requests[0].contentParts.map(parts => parts[0]?.text), ['first queued turn', 'second queued turn']);
  assert.equal(h.requests[0].beforeRunMessages.some(message => message.role === 'assistant'), false);
  assert.deepEqual(
    h.conversations.get('A').messages.map(message => ({
      role: message.role,
      content: message.content,
      attachmentIds: (message.attachments ?? []).map(attachment => attachment.id),
    })),
    [
      { role: 'user', content: 'first queued turn', attachmentIds: ['att-q1'] },
      { role: 'user', content: 'second queued turn', attachmentIds: ['att-q2'] },
    ],
  );
}

async function testResidualInterruptRunsBeforeQueuedMessages() {
  const h = createHarness();
  h.conversations.get('A').queuedMessages.push(queued('q1', 'first'), queued('q2', 'second'));
  h.conversations.get('A').taskBoundaries.push(activeBoundary('tb-queue-old', '队列前任务'));
  h.conversations.get('A').interruptMessages.push(queued('i1', 'late interrupt'));
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent[0], { type: 'boundary', conversationId: 'A', mode: 'interrupted', id: 'tb-queue-old' });
  assert.deepEqual(h.sent[1].texts, ['late interrupt']);
  assert.deepEqual(h.sent[1].sources, ['interrupt']);
  assert.deepEqual(h.sent[2], {
    type: 'continuation',
    conversationId: 'A',
    previousBoundaryId: 'tb-queue-old',
    anchorAfterSource: 'last-interrupt-user',
    headline: '插队后继续：队列前任务',
    continuationIndex: 1,
  });
  assert.deepEqual(h.conversations.get('A').queuedMessages.map(message => message.text), ['first', 'second']);
  assert.equal(h.conversations.get('A').interruptMessages.length, 0);
}

async function testBlockedDrainKeepsPerConversationWakeWithoutSpinning() {
  const h = createHarness();
  h.flags.activeConversationId = 'B';
  h.flags.historyMutation = true;
  h.conversations.get('A').queuedMessages.push(queued('q1', 'blocked background queue'));

  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent, []);
  assert.equal(h.handlerCalls.length, 1);
  assert.deepEqual(h.coordinator.debugSnapshot(), [{
    conversationId: 'A',
    inFlight: false,
    pendingReasons: ['agent-settled'],
    hasPendingInterruptContinuation: false,
  }]);

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.handlerCalls.length, 1);

  h.flags.historyMutation = false;
  await h.coordinator.drainNow('A', 'manual');
  assert.equal(h.handlerCalls.length, 2);
  assert.equal(h.sent[1].conversationId, 'A');
  assert.equal(h.sent[1].activeConversationId, 'B');
  assert.deepEqual(h.conversations.get('A').queuedMessages, []);
  assert.deepEqual(h.coordinator.debugSnapshot(), []);
}

function testNewInterruptInvalidatesPreparedQueueBatch() {
  const currentBucket = bucket([queued('q1', 'queued first')]);
  const preparedBatch = buildQueueDrainBatch(currentBucket);
  currentBucket.interruptMessages.push(queued('i1', 'arrived during async preparation'));
  assert.equal(isQueueDrainBatchCurrent(currentBucket, preparedBatch), false);
}

async function testChangedQueueBatchRebuildsBeforeSending() {
  const coordinator = new QueueDrainCoordinator();
  const conversation = bucket([queued('q1', 'first queued')]);
  const preparedTexts = [];
  const sentTexts = [];
  let injectedMutation = false;

  coordinator.registerHandler(async conversationId => {
    assert.equal(conversationId, 'A');
    const batchToDrain = buildQueueDrainBatch(conversation);
    preparedTexts.push(batchToDrain.map(item => item.message.text));
    if (!injectedMutation) {
      injectedMutation = true;
      conversation.queuedMessages.push(queued('q2', 'queued during async preparation'));
      if (!isQueueDrainBatchCurrent(conversation, batchToDrain)) {
        return { status: 'blocked', reason: 'batch-changed' };
      }
    }
    sentTexts.push(batchToDrain.map(item => item.message.text));
    for (const item of batchToDrain) {
      conversation.queuedMessages = conversation.queuedMessages.filter(message => message.id !== item.message.id);
    }
    return { status: 'started' };
  });

  await coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(preparedTexts, [['first queued'], ['first queued', 'queued during async preparation']]);
  assert.deepEqual(sentTexts, [['first queued', 'queued during async preparation']]);
  assert.deepEqual(conversation.queuedMessages, []);
  assert.deepEqual(coordinator.debugSnapshot(), []);
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
  await new Promise(resolve => setTimeout(resolve, 0));
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

function testInterruptContinuationLineageHelper() {
  assert.deepEqual(interruptContinuationFromBoundary({
    id: 'tb-parent',
    headline: '读取文件',
    summary: '检查实现',
    continuationIndex: 4,
  }), {
    previousBoundaryId: 'tb-parent',
    previousHeadline: '读取文件',
    previousSummary: '检查实现',
    continuationIndex: 5,
  });
  assert.equal(interruptContinuationFromBoundary(null), undefined);
  assert.equal(interruptContinuationFromBoundary({ headline: 'no id' }), undefined);
}

async function testInterruptResidualClosesOldBoundaryBeforeNewUserMessage() {
  const h = createHarness();
  h.conversations.get('A').taskBoundaries.push(activeBoundary('tb-active', '实现文件编辑', '正在编辑文件', 2));
  h.conversations.get('A').interruptMessages.push(queued('i1', 'interrupt as next user message'));
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent, [
    { type: 'boundary', conversationId: 'A', mode: 'interrupted', id: 'tb-active' },
    {
      type: 'run',
      conversationId: 'A',
      activeConversationId: 'A',
      texts: ['interrupt as next user message'],
      sources: ['interrupt'],
    },
    {
      type: 'continuation',
      conversationId: 'A',
      previousBoundaryId: 'tb-active',
      anchorAfterSource: 'last-interrupt-user',
      headline: '插队后继续：实现文件编辑',
      continuationIndex: 3,
    },
  ]);
}

async function testMultipleInterruptsShareOneContinuationAfterAllUserMessages() {
  const h = createHarness();
  h.conversations.get('A').taskBoundaries.push(activeBoundary('tb-multi', '批量工具任务'));
  h.conversations.get('A').interruptMessages.push(
    queued('i1', 'first interrupt'),
    queued('i2', 'second interrupt'),
  );
  await h.coordinator.drainNow('A', 'agent-settled');
  assert.deepEqual(h.sent.map(event => event.type), ['boundary', 'run', 'continuation']);
  assert.deepEqual(h.sent[1].texts, ['first interrupt', 'second interrupt']);
  assert.deepEqual(h.sent[1].sources, ['interrupt', 'interrupt']);
  assert.deepEqual(h.sent[2], {
    type: 'continuation',
    conversationId: 'A',
    previousBoundaryId: 'tb-multi',
    anchorAfterSource: 'last-interrupt-user',
    headline: '插队后继续：批量工具任务',
    continuationIndex: 1,
  });
}

async function testTailInterruptContinuationSurvivesClosedOldBoundary() {
  const h = createHarness();
  const oldBoundary = activeBoundary('tb-tail', '最终流尾任务', '最终答复即将结束', 6);
  h.conversations.get('A').taskBoundaries.push(oldBoundary);
  h.conversations.get('A').messages.push({ id: 'assistant-tail', role: 'assistant', content: 'assistant final tail', timestamp: Date.now() });
  h.conversations.get('A').interruptMessages.push(queued('i-tail', 'interrupt during final tail'));

  h.coordinator.rememberInterruptContinuation('A', interruptContinuationFromBoundary(oldBoundary));
  oldBoundary.status = 'interrupted';
  await h.coordinator.drainNow('A', 'agent-settled');

  assert.deepEqual(h.sent, [
    {
      type: 'run',
      conversationId: 'A',
      activeConversationId: 'A',
      texts: ['interrupt during final tail'],
      sources: ['interrupt'],
    },
    {
      type: 'continuation',
      conversationId: 'A',
      previousBoundaryId: 'tb-tail',
      anchorAfterSource: 'last-interrupt-user',
      headline: '插队后继续：最终流尾任务',
      continuationIndex: 7,
    },
  ]);
  assert.deepEqual(h.coordinator.debugSnapshot(), []);
}

function testSourceContracts() {
  const agentLoopSource = fs.readFileSync(path.join(servicesDir, 'agentLoop.ts'), 'utf8');
  const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'layout', 'AgentPanel.tsx'), 'utf8');
  const queueDrainSource = fs.readFileSync(path.join(servicesDir, 'queueDrainCoordinator.ts'), 'utf8');
  const conversationSource = fs.readFileSync(path.join(storeDir, 'conversation.ts'), 'utf8');

  assert.match(queueDrainSource, /return \(bucket\.queuedMessages \?\? \[\]\)\.map\(message => \(\{ source: 'queue' as const, message \}\)\)/);
  assert.match(queueDrainSource, /result\.status === 'blocked'[\s\S]{0,120}restorePendingReasons/);
  assert.match(queueDrainSource, /result\.reason === 'batch-changed'[\s\S]{0,120}continue/);
  assert.match(queueDrainSource, /retryPending\(reason: QueueDrainRequestReason = 'manual'\)/);
  assert.match(queueDrainSource, /pendingInterruptContinuations/);
  assert.match(agentLoopSource, /queueDrainCoordinator\.requestDrain\(completedConversationId, 'agent-settled'\)/);
  assert.match(agentLoopSource, /await drainInterruptMessages\(\);[\s\S]*?【任务边界收口提醒】/);
  assert.match(agentLoopSource, /endOwnedTaskBoundary\('interrupted'\)/);
  assert.match(agentLoopSource, /beginInterruptContinuationTaskBoundary[\s\S]{0,900}continuationOfId: continuation\.previousBoundaryId/);
  assert.match(agentLoopSource, /anchorMessageId,[\s\S]{0,260}continuationReason: 'interrupt'/);
  assert.match(agentLoopSource, /不要为同一段续接重复 begin_task_boundary/);
  assert.match(agentLoopSource, /interruptContinuationFromBoundary\(activeBoundary\)/);
  assert.match(agentLoopSource, /pendingCompletionContinuation[\s\S]{0,260}rememberInterruptContinuation/);
  assert.match(agentLoopSource, /hasPendingCompletionInterrupt[\s\S]{0,360}endOwnedTaskBoundary\(hasPendingCompletionInterrupt \? 'interrupted' : 'done'\)/);
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
  assert.match(panelSource, /resolveInterruptContinuation[\s\S]{0,600}peekInterruptContinuation/);
  assert.match(panelSource, /queueDrainCoordinator\.retryPending\('foreground-idle'\)/);
  assert.match(panelSource, /continuationTaskBoundary[\s\S]{0,500}beforeRunLoop!\.run/);
  assert.match(conversationSource, /continuationOfId\?: string/);
  assert.match(conversationSource, /continuationReason\?: 'interrupt' \| string/);
  assert.match(conversationSource, /重载恢复暂不启用/);
  assert.match(conversationSource, /previousBoundaryEndId[\s\S]{0,320}tb\.endAnchorMessageId = previousBoundaryEndId/);
  assert.match(conversationSource, /if \(lastMessageId\) b\.endAnchorMessageId = lastMessageId/);
}

async function main() {
  await testForegroundDrain();
  await testBackgroundSettleDrainDoesNotUseActiveConversation();
  await testQueuedMessagesDrainAsOneHumanTurnWithOrderAndAttachments();
  await testResidualInterruptRunsBeforeQueuedMessages();
  testNewInterruptInvalidatesPreparedQueueBatch();
  await testChangedQueueBatchRebuildsBeforeSending();
  await testStopClearsQueueAndCancelsPendingDrain();
  await testPendingRequestRunsAfterHandlerRegistration();
  await testSafetyBlocksPreserveQueue();
  await testBlockedDrainKeepsPerConversationWakeWithoutSpinning();
  testPendingToolTasksBlockDrain();
  testInterruptContinuationLineageHelper();
  await testInterruptResidualClosesOldBoundaryBeforeNewUserMessage();
  await testMultipleInterruptsShareOneContinuationAfterAllUserMessages();
  await testTailInterruptContinuationSurvivesClosedOldBoundary();
  testSourceContracts();
  console.log('Queue/interrupt drain integration: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
