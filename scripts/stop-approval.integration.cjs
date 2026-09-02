const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function transpileService(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path.basename(relativePath),
  }).outputText;
}

function loadExecutionRegistryModule() {
  const compiled = transpileService('src/services/executionRegistry.ts');
  const loaded = { exports: {} };
  let ownerSeq = 0;
  let runSeq = 0;
  let callSeq = 0;
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier === './executionContext') {
      return {
        createOwnerId() {
          ownerSeq += 1;
          return `owner-stop-test-${ownerSeq}`;
        },
        createExecutionContext(conversationId, ownerId) {
          runSeq += 1;
          return Object.freeze({ conversationId, ownerId, runId: `run-stop-test-${runSeq}` });
        },
        createToolCallExecutionContext(context, callId) {
          callSeq += 1;
          return Object.freeze({ ...context, callId: callId || `call-stop-test-${callSeq}` });
        },
      };
    }
    throw new Error(`Unexpected import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

async function assertSettlesWithin(label, promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main() {
  const coordinatorSource = fs.readFileSync(
    path.join(root, 'src/services/approvalCoordinator.ts'),
    'utf8',
  );
  const compiled = ts.transpileModule(coordinatorSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: 'approvalCoordinator.ts',
  }).outputText;
  const sensitiveSource = fs.readFileSync(path.join(root, 'src/services/sensitiveRedaction.ts'), 'utf8');
  const sensitiveCompiled = ts.transpileModule(sensitiveSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'sensitiveRedaction.ts',
  }).outputText;
  const sensitiveModule = { exports: {} };
  new Function('require', 'module', 'exports', sensitiveCompiled)(require, sensitiveModule, sensitiveModule.exports);
  const loaded = { exports: {} };
  const stoppedConversations = [];
  const loadCompiled = new Function('require', 'module', 'exports', compiled);
  loadCompiled(specifier => {
    if (specifier === './executionRegistry') {
      return {
        executionRegistry: {
          registerCancelable() {},
          releaseCancelable() {},
          async stopConversation(conversationId) {
            stoppedConversations.push(conversationId);
            return conversationId === 'conversation-background';
          },
        },
      };
    }
    if (specifier === './sensitiveRedaction') return sensitiveModule.exports;
    throw new Error(`Unexpected import: ${specifier}`);
  }, loaded, loaded.exports);
  const { approvalCoordinator } = loaded.exports;
  let current = null;
  const unsubscribe = approvalCoordinator.subscribe(ticket => {
    current = ticket;
  });

  const first = approvalCoordinator.requestTicket({
    id: 'approval-a',
    toolName: 'run_command',
    level: 'command',
    argsText: '{"command":"a"}',
    originLabel: 'AI',
    conversationId: 'conversation-a',
  });
  const second = approvalCoordinator.requestTicket({
    id: 'approval-b',
    toolName: 'run_command',
    level: 'command',
    argsText: '{"command":"b"}',
    originLabel: 'AI',
    conversationId: 'conversation-b',
  });

  assert.equal(current.id, 'approval-a');
  assert.equal(current.queuedCount, 1);
  assert.equal(approvalCoordinator.cancelConversation('conversation-a'), 1);
  assert.equal(await first, false);
  assert.equal(current.id, 'approval-b');
  assert.equal(current.queuedCount, 0);
  assert.equal(approvalCoordinator.cancelConversation('missing'), 0);
  assert.equal(approvalCoordinator.resolve('approval-b', true), true);
  assert.equal(await second, true);
  assert.equal(current, null);
  const approvalFixtureValue = ['approval', 'fixture', 'value'].join('-');
  const approvalBearerHeader = ['Authorization:', ['Bearer', approvalFixtureValue].join(' ')].join(' ');
  const sensitiveApproval = approvalCoordinator.request(
    'run_command',
    {
      command: `curl -H "${approvalBearerHeader}"`,
      [['API', 'KEY'].join('_')]: approvalFixtureValue,
    },
    'command',
    { conversationId: 'conversation-sensitive', callId: 'call-sensitive' },
  );
  assert.doesNotMatch(current.argsText, /approval-fixture-value/);
  assert.match(current.argsText, /\[redacted\]/);
  approvalCoordinator.resolve(current.id, false);
  assert.equal(await sensitiveApproval, false);
  const bridgedApproval = approvalCoordinator.requestTicket({
    id: 'approval-bridged',
    toolName: 'run_command',
    level: 'command',
    argsText: 'Cookie: session=bridge-secret',
    originLabel: 'Synapse',
  });
  assert.doesNotMatch(current.argsText, /bridge-secret/);
  approvalCoordinator.resolve(current.id, false);
  assert.equal(await bridgedApproval, false);
  let stopCount = 0;
  const unregisterStop = approvalCoordinator.registerStopHandler('conversation-a', () => {
    stopCount += 1;
  });
  assert.equal(await approvalCoordinator.requestStop('conversation-a'), true);
  assert.equal(stopCount, 1);
  unregisterStop();
  assert.equal(await approvalCoordinator.requestStop('conversation-a'), false);
  assert.deepEqual(stoppedConversations, ['conversation-a']);
  const backgroundApproval = approvalCoordinator.requestTicket({
    id: 'approval-background',
    toolName: 'run_command',
    level: 'command',
    argsText: '{"command":"background"}',
    originLabel: 'AI',
    conversationId: 'conversation-background',
  });
  assert.equal(await approvalCoordinator.requestStop('conversation-background'), true);
  assert.equal(await backgroundApproval, false);
  assert.deepEqual(stoppedConversations, ['conversation-a', 'conversation-background']);
  unsubscribe();

  const { executionRegistry: realExecutionRegistry } = loadExecutionRegistryModule();
  let loopRunning = true;
  let loopStopCount = 0;
  realExecutionRegistry.getOrCreateLoop('conversation-never-settles', () => ({
    get isRunning() {
      return loopRunning;
    },
    stop() {
      loopStopCount += 1;
      loopRunning = false;
    },
  }));
  const ownerId = realExecutionRegistry.getOwnerId('conversation-never-settles');
  assert.ok(ownerId);
  await realExecutionRegistry.activateOwner(ownerId, 'run-never-settles');
  assert.equal(realExecutionRegistry.registerCancelable(
    ownerId,
    'never-settling-cancel',
    () => new Promise(() => {}),
    'run-never-settles',
  ), true);
  const capturedWarnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    capturedWarnings.push(args);
  };
  try {
    assert.equal(await assertSettlesWithin(
      'stopConversation with a never-settling cancel callback',
      realExecutionRegistry.stopConversation('conversation-never-settles'),
      2500,
    ), true);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(loopStopCount, 1);
  assert.equal(realExecutionRegistry.isConversationRunning('conversation-never-settles'), false);
  const timeoutAudit = realExecutionRegistry.getLastStopAudit(ownerId);
  assert.equal(timeoutAudit.timedOut, true);
  assert.equal(timeoutAudit.cancelledCount, 1);
  assert.equal(timeoutAudit.timedOutCancellations, 1);
  assert.equal(timeoutAudit.exhaustedPasses, false);
  assert.equal(capturedWarnings.length, 1);
  let lateCancelCount = 0;
  assert.equal(realExecutionRegistry.registerCancelable(
    ownerId,
    'late-old-run',
    () => {
      lateCancelCount += 1;
      return new Promise(() => {});
    },
    'run-never-settles',
  ), false);
  await Promise.resolve();
  assert.equal(lateCancelCount, 1);
  await assertSettlesWithin(
    'activateOwner after a timed-out stop',
    realExecutionRegistry.activateOwner(ownerId, 'run-next'),
    100,
  );
  assert.equal(realExecutionRegistry.isActiveRun({ ownerId, runId: 'run-next' }), true);
  assert.equal(realExecutionRegistry.registerCancelable(
    ownerId,
    'next-run-cancel',
    () => {},
    'run-next',
  ), true);
  realExecutionRegistry.releaseCancelable(ownerId, 'next-run-cancel');

  const panelSource = fs.readFileSync(path.join(root, 'src/components/layout/AgentPanel.tsx'), 'utf8');
  const captureIndex = panelSource.indexOf('const activeAgentLoop = agentLoopRef.current;');
  const stopIndex = panelSource.indexOf('activeAgentLoop?.stop();', captureIndex);
  const approvalIndex = panelSource.indexOf('approvalCoordinator.cancelConversation(conversationId);', stopIndex);
  const registryIndex = panelSource.indexOf('executionRegistry.stopConversation(conversationId)', approvalIndex);
  const clearIndex = panelSource.indexOf('agentLoopRef.current = null;', registryIndex);
  assert.ok(captureIndex >= 0 && captureIndex < stopIndex);
  assert.ok(stopIndex < approvalIndex && approvalIndex < registryIndex && registryIndex < clearIndex);
  assert.match(panelSource, /approvalCoordinator\.registerStopHandler\(conversationId, handleStop\)/);
  assert.match(panelSource, /hasRunningOrSettlingAgent\s*=\s*isAgentRunActiveRef\.current\s*\|\|\s*executionRegistry\.isConversationRunning\(targetConversationId\)/);
  assert.match(panelSource, /isHistoryMutationBlocked[\s\S]*executionRegistry\.isConversationRunning\(conversationId\)/);
  assert.match(panelSource, /canLaunchHistoricalReplay[\s\S]*activeConversationId === targetConversationId[\s\S]*agentLoopRef\.current === targetLoop[\s\S]*!executionRegistry\.isConversationRunning\(targetConversationId\)/);
  const historyBlockSource = panelSource.slice(
    panelSource.indexOf('const isHistoryMutationBlocked'),
    panelSource.indexOf('const canLaunchHistoricalReplay'),
  );
  assert.match(historyBlockSource, /toolTaskReferences\.pendingTasks\.length > 0/);
  assert.match(historyBlockSource, /toolTaskReferences\.orphanPendingCallIds\.size > 0/);
  const replayGuardSource = panelSource.slice(
    panelSource.indexOf('const canLaunchHistoricalReplay'),
    panelSource.indexOf('const beginHistoryMutation'),
  );
  assert.match(replayGuardSource, /toolTaskReferences\.pendingTasks\.length === 0/);
  assert.match(replayGuardSource, /toolTaskReferences\.orphanPendingCallIds\.size === 0/);
  assert.equal((panelSource.match(/if \(!canLaunchHistoricalReplay\(targetConversationId, targetLoop\)\) return;/g) ?? []).length, 2);

  const loopSource = fs.readFileSync(path.join(root, 'src/services/agentLoop.ts'), 'utf8');
  assert.match(loopSource, /const ownerMessageStillExists = Boolean\([\s\S]*message\.id === assistantMessageId/);
  assert.match(loopSource, /const attributableFileChanges = ownerMessageStillExists \? fileChanges : \[\]/);
  const conversationSource = fs.readFileSync(path.join(root, 'src/store/slices/conversation.ts'), 'utf8');
  const addDiffStart = conversationSource.indexOf('addMessageDiff(state');
  const missingOwnerGuard = conversationSource.indexOf('if (!ownerMessage) return;', addDiffStart);
  const pendingPush = conversationSource.indexOf('b.pendingDiffs.push(seeded);', addDiffStart);
  assert.ok(addDiffStart >= 0 && missingOwnerGuard > addDiffStart && missingOwnerGuard < pendingPush);

  const dialogSource = fs.readFileSync(path.join(root, 'src/components/ui/ApprovalDialog.tsx'), 'utf8');
  const hostSource = fs.readFileSync(path.join(root, 'src/components/ui/ApprovalDialogHost.tsx'), 'utf8');
  const toolTaskSource = fs.readFileSync(path.join(root, 'electron/ipc/toolTask.ts'), 'utf8');
  assert.match(dialogSource, />停止任务<\/button>/);
  assert.match(hostSource, /approvalCoordinator\.requestStop\(approvalReq\.conversationId\)/);
  assert.match(hostSource, /\.then\(stopped =>/);
  assert.match(hostSource, /conversationId: payload\.conversationId/);
  assert.match(toolTaskSource, /conversationId: request\.identity\.conversationId/);

  console.log('Stop/approval integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
