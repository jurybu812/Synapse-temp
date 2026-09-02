const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { app } = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-tool-task-recovery-'));
const tempDataDir = path.join(tempRoot, 'data');
process.env.SYNAPSE_DATA_DIR = tempDataDir;
app.setPath('home', path.join(tempRoot, 'home'));
app.setPath('userData', path.join(tempRoot, 'user-data'));

const handlers = new Map();
const storage = new Map();

global.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

global.crypto = global.crypto ?? require('node:crypto').webcrypto;

function installTsRequireHook() {
  if (require.extensions['.synapse-ts-installed']) return;
  const originalResolveFilename = Module._resolveFilename;
  const stubs = new Map([
    ['@/services/fileChangeTracker', {
      countLineChanges: () => ({ additions: 0, deletions: 0 }),
      buildDiffHunks: () => [],
    }],
    ['@/services/diffReviewLedger', {
      findMergeableMessageDiffIndex: () => -1,
    }],
    ['@/services/conversationPersistence', {
      AUTOSAVE_ID: 'autosave-current',
    }],
    ['@platform/index', {
      isElectron: false,
    }],
  ]);
  Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
    if (stubs.has(request)) return request;
    if (request.startsWith('@/')) {
      const target = path.join(repoRoot, 'src', request.slice(2));
      for (const candidate of [target, `${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts')]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (stubs.has(request)) return stubs.get(request);
    return originalLoad.call(this, request, parent, isMain);
  };
  require.extensions['.ts'] = function transpileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    module._compile(output.outputText, filename);
  };
  require.extensions['.tsx'] = require.extensions['.ts'];
  require.extensions['.synapse-ts-installed'] = true;
}

function resetFrontendModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}services${path.sep}executionRegistry.ts`)
      || key.includes(`${path.sep}src${path.sep}services${path.sep}executionContext.ts`)
      || key.includes(`${path.sep}src${path.sep}store${path.sep}slices${path.sep}conversation.ts`)) {
      delete require.cache[key];
    }
  }
}

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  try {
    return Promise.resolve(handler({}, ...args));
  } catch (error) {
    return Promise.reject(error);
  }
}

function messageWithTool(status, overrides = {}) {
  return {
    id: overrides.messageId ?? 'assistant-tool-message',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    model: 'fixture-model',
    streamState: status === 'success' ? 'complete' : 'aborted',
    toolCalls: [{
      id: overrides.callId ?? 'call-fixture',
      name: 'fixture_tool',
      arguments: '{}',
      status,
      result: overrides.result,
      taskId: overrides.taskId,
      taskOwnerId: overrides.ownerId,
      taskRunId: overrides.runId,
      taskCallId: overrides.callId ?? 'call-fixture',
      errorCode: overrides.errorCode,
      unknownSideEffect: overrides.unknownSideEffect,
    }],
  };
}

function snapshotForSave(conversationId, messages, taskBoundaries) {
  return {
    id: conversationId,
    metadata: {
      title: conversationId,
      model: 'fixture-model',
      schemaVersion: 1,
      lastMessage: messages[messages.length - 1]?.content ?? '',
      assistantRuns: {},
      fileSnapshots: {},
      pendingDiffs: [],
      taskBoundaries,
      taskHeadline: taskBoundaries?.[0]
        ? { headline: taskBoundaries[0].headline, summary: taskBoundaries[0].summary, updatedAt: taskBoundaries[0].startedAt }
        : undefined,
    },
    messages: messages.map(message => ({ ...message, conversationId })),
  };
}

function activeBoundary(overrides = {}) {
  return {
    id: overrides.id ?? 'boundary-fixture',
    headline: overrides.headline ?? '后台任务恢复',
    summary: overrides.summary ?? '验证 reload 后工具任务与 UI 一致',
    status: 'active',
    startedAt: Date.now() - 1000,
    anchorMessageId: overrides.anchorMessageId ?? 'assistant-tool-message',
    steps: [],
    history: [{
      headline: overrides.headline ?? '后台任务恢复',
      summary: overrides.summary ?? '验证 reload 后工具任务与 UI 一致',
      timestamp: Date.now() - 1000,
    }],
  };
}

class FixtureTaskExecutor {
  constructor(delegate) {
    this.delegate = delegate;
    this.kind = 'fixture';
  }
  canHandle(taskId) { return this.delegate.canHandle(taskId); }
  start(request) { return this.delegate.start(request); }
  status(taskId, access) { return this.delegate.status(taskId, access); }
  wait(taskId, waitSeconds, access) { return this.delegate.wait(taskId, waitSeconds, access); }
  cancel(taskId, access) { return this.delegate.cancel(taskId, access); }
  list(request) { return this.delegate.list(request); }
  rebindConversation(request) { return this.delegate.rebindConversation(request); }
  restoreInterruptedTasks() { return this.delegate.restoreInterruptedTasks(); }
  shutdown() { return this.delegate.shutdown(); }
}

async function loadBrokerClasses() {
  const { ManagedTaskExecutor, ManagedTaskError } = require('../dist-electron/electron/toolTasks/ManagedTaskExecutor.js');
  const { TaskBroker } = require('../dist-electron/electron/toolTasks/TaskBroker.js');
  class Delegate extends ManagedTaskExecutor {
    constructor() {
      super();
      this.kind = 'fixture';
    }
    async execute(input, context) {
      if (input.mode === 'unknown') {
        throw new ManagedTaskError('fixture status cannot be confirmed', 'unknown', true, 'fixture unknown');
      }
      const delayMs = Number(input.delayMs ?? 0);
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          context.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      if (input.mode === 'hang') {
        await new Promise((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return {
        text: `fixture completed: ${input.label ?? context.taskId}`,
        structured: { mode: input.mode, label: input.label ?? null },
      };
    }
    hasUnknownSideEffect(input) {
      return input.mode === 'unknown' || input.sideEffectPossible === true;
    }
  }
  return { TaskBroker, FixtureExecutor: class extends FixtureTaskExecutor { constructor() { super(new Delegate()); } } };
}

async function saveAndLoadConversation(conversationId, messages, taskBoundaries) {
  await invoke('conversation:saveSnapshot', snapshotForSave(conversationId, messages, taskBoundaries));
  return await invoke('message:list', conversationId);
}

function projectSnapshotWithReducer(conversationId, initialMessage, taskBoundaries, snapshot, at = Date.now()) {
  installTsRequireHook();
  resetFrontendModules();
  const conversation = require(path.join(repoRoot, 'src/store/slices/conversation.ts'));
  let state = conversation.conversationSlice.reducer(undefined, conversation.setConversation({
    id: conversationId,
    title: 'fixture',
    messages: Array.isArray(initialMessage) ? initialMessage : [initialMessage],
    taskBoundaries,
    taskHeadline: taskBoundaries?.[0]
      ? { headline: taskBoundaries[0].headline, summary: taskBoundaries[0].summary, updatedAt: taskBoundaries[0].startedAt }
      : undefined,
  }));
  state = conversation.conversationSlice.reducer(state, conversation.reconcileToolTaskStatus({
    taskId: snapshot.taskId,
    taskOwnerId: snapshot.ownerId,
    taskRunId: snapshot.runId,
    taskCallId: snapshot.callId,
    status: snapshot.status,
    result: snapshot.status === 'running' || snapshot.status === 'cancelling' ? undefined : (snapshot.text || snapshot.error),
    structured: snapshot.status === 'running' || snapshot.status === 'cancelling' ? undefined : snapshot.structured,
    errorCode: snapshot.errorCode,
    unknownSideEffect: snapshot.unknownSideEffect,
    executionTime: snapshot.executionTimeMs ?? (snapshot.finishedAt ? Math.max(0, snapshot.finishedAt - snapshot.startedAt) : undefined),
    conversationId,
  }));
  state = conversation.conversationSlice.reducer(state, conversation.settleRecoveredToolTaskBoundaries({ conversationId, at }));
  return state;
}

function assertOwnerRecovery(conversationId, ownerId) {
  installTsRequireHook();
  storage.clear();
  resetFrontendModules();
  const { executionRegistry } = require(path.join(repoRoot, 'src/services/executionRegistry.ts'));
  assert.equal(executionRegistry.getOwnerId(conversationId), null);
  assert.equal(executionRegistry.restoreOwnerForConversation(conversationId, ownerId), true);
  assert.equal(executionRegistry.getOwnerId(conversationId), ownerId);
  resetFrontendModules();
  const reloaded = require(path.join(repoRoot, 'src/services/executionRegistry.ts')).executionRegistry;
  assert.equal(reloaded.getOwnerId(conversationId), ownerId);
  assert.equal(reloaded.restoreOwnerForConversation('conversation-other', ownerId), false);
}

function assertUnknownDoesNotRetry(sourceText) {
  const effectStart = sourceText.indexOf('const shouldReconcile = toolTaskReferences.pendingTasks.length > 0');
  const refreshStart = sourceText.indexOf('const handleRefreshToolTask');
  assert.ok(effectStart > -1 && refreshStart > effectStart, 'AgentPanel recovery effect should be locatable');
  const effectBody = sourceText.slice(effectStart, refreshStart);
  assert.match(effectBody, /toolTask\.list\(\{ conversationId, ownerId \}\)/);
  assert.match(effectBody, /toolTask\.status\(taskId,/);
  assert.match(effectBody, /settleRecoveredToolTaskBoundaries/);
  assert.doesNotMatch(effectBody, /toolTask\.start\(/);
}

function assertAgentLoopPersistsStartedTask(sourceText) {
  const start = sourceText.indexOf('onTaskStarted: async snapshot =>');
  const end = sourceText.indexOf('const resultText = renderToolResultForModel(result);', start);
  assert.ok(start > -1 && end > start, 'AgentLoop onTaskStarted block should be locatable');
  const block = sourceText.slice(start, end);
  assert.match(block, /taskId:\s*snapshot\.taskId/);
  assert.match(block, /taskOwnerId:\s*snapshot\.ownerId/);
  assert.match(block, /await persistRuntimeConversationSnapshot\(this\.runConvId!\)/);
}

async function main() {
  await app.whenReady();
  const { ipcMain } = require('electron');
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler);
  };
  const databaseModule = require('../dist-electron/electron/database.js');
  databaseModule.initDatabase();
  require('../dist-electron/electron/ipc/conversation.js').registerConversationHandlers();

  const { TaskBroker, FixtureExecutor } = await loadBrokerClasses();
  const broker = new TaskBroker();
  broker.register(new FixtureExecutor());

  const identity = {
    conversationId: 'conversation-recovery',
    runId: 'run-recovery',
    callId: 'call-recovery',
    ownerId: 'owner-recovery',
  };
  const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };

  const started = await broker.start({
    kind: 'fixture',
    taskId: 'fixture_same_renderer',
    identity,
    input: { mode: 'success', label: 'same renderer', delayMs: 20 },
  });
  assert.equal(started.status, 'running');
  const runningMessage = messageWithTool('running', {
    taskId: started.taskId,
    ownerId: started.ownerId,
    runId: started.runId,
    callId: started.callId,
    result: started.text || 'running',
  });
  let stored = await saveAndLoadConversation(identity.conversationId, [runningMessage], [activeBoundary()]);
  assert.equal(stored[0].toolCalls[0].taskId, started.taskId);
  assert.equal(stored[0].toolCalls[0].taskOwnerId, identity.ownerId);

  const completed = await broker.wait(started.taskId, 10, access);
  assert.equal(completed.status, 'success');
  const completedState = projectSnapshotWithReducer(identity.conversationId, runningMessage, [activeBoundary()], completed, Date.now());
  const completedToolCall = completedState.messages[0].toolCalls[0];
  assert.equal(completedToolCall.status, 'success');
  assert.equal(completedToolCall.taskOwnerId, identity.ownerId);
  assert.equal(completedState.taskBoundaries[0].status, 'done');
  stored = await saveAndLoadConversation(identity.conversationId, [messageWithTool('success', {
    taskId: completed.taskId,
    ownerId: completed.ownerId,
    runId: completed.runId,
    callId: completed.callId,
    result: completed.text,
  })], completedState.taskBoundaries);
  assert.equal(stored[0].toolCalls[0].status, 'success');

  assertOwnerRecovery(identity.conversationId, identity.ownerId);

  const reloadIdentity = {
    conversationId: 'conversation-reload',
    runId: 'run-reload',
    callId: 'call-reload',
    ownerId: 'owner-reload',
  };
  const reloadStarted = await broker.start({
    kind: 'fixture',
    taskId: 'fixture_reload_pending',
    identity: reloadIdentity,
    input: { mode: 'success', label: 'reload pending', delayMs: 40 },
  });
  await saveAndLoadConversation(reloadIdentity.conversationId, [messageWithTool('running', {
    taskId: reloadStarted.taskId,
    ownerId: reloadStarted.ownerId,
    runId: reloadStarted.runId,
    callId: reloadStarted.callId,
  })], [activeBoundary()]);
  const listedWhileRunning = await broker.list({ conversationId: reloadIdentity.conversationId, ownerId: reloadIdentity.ownerId });
  assert.ok(listedWhileRunning.some(snapshot => snapshot.taskId === reloadStarted.taskId && snapshot.status === 'running'));
  const reloadCompleted = await broker.wait(reloadStarted.taskId, 10, { conversationId: reloadIdentity.conversationId, ownerId: reloadIdentity.ownerId });
  const reloadedState = projectSnapshotWithReducer(reloadIdentity.conversationId, messageWithTool('running', {
    taskId: reloadStarted.taskId,
    ownerId: reloadStarted.ownerId,
    runId: reloadStarted.runId,
    callId: reloadStarted.callId,
  }), [activeBoundary()], reloadCompleted, Date.now());
  assert.equal(reloadedState.messages[0].toolCalls[0].status, 'success');
  assert.equal(reloadedState.taskBoundaries[0].status, 'done');

  const historicalFailure = messageWithTool('error', {
    messageId: 'historical-failed-message',
    taskId: 'fixture_historical_failed',
    callId: 'call-historical-failed',
    ownerId: reloadIdentity.ownerId,
  });
  const scopedRunning = messageWithTool('running', {
    messageId: 'scoped-running-message',
    taskId: reloadStarted.taskId,
    ownerId: reloadStarted.ownerId,
    runId: reloadStarted.runId,
    callId: reloadStarted.callId,
  });
  const scopedState = projectSnapshotWithReducer(
    reloadIdentity.conversationId,
    [historicalFailure, scopedRunning],
    [activeBoundary({ anchorMessageId: scopedRunning.id })],
    reloadCompleted,
    Date.now(),
  );
  assert.equal(
    scopedState.taskBoundaries[0].status,
    'done',
    'historical failed tasks before the active boundary must not abort recovered success',
  );

  const cancelIdentity = {
    conversationId: 'conversation-cancel',
    runId: 'run-cancel',
    callId: 'call-cancel',
    ownerId: 'owner-cancel',
  };
  const cancelStarted = await broker.start({
    kind: 'fixture',
    taskId: 'fixture_cancel',
    identity: cancelIdentity,
    input: { mode: 'hang', sideEffectPossible: false },
  });
  const cancelled = await broker.cancel(cancelStarted.taskId, { conversationId: cancelIdentity.conversationId, ownerId: cancelIdentity.ownerId });
  assert.equal(cancelled.status, 'cancelled');
  const cancelledState = projectSnapshotWithReducer(cancelIdentity.conversationId, messageWithTool('running', {
    taskId: cancelStarted.taskId,
    ownerId: cancelStarted.ownerId,
    runId: cancelStarted.runId,
    callId: cancelStarted.callId,
  }), [activeBoundary()], cancelled, Date.now());
  assert.equal(cancelledState.messages[0].toolCalls[0].status, 'cancelled');
  assert.equal(cancelledState.taskBoundaries[0].status, 'aborted');

  await assert.rejects(
    () => broker.status(completed.taskId, { conversationId: 'conversation-other', ownerId: identity.ownerId }),
    /不属于当前对话，拒绝访问/,
  );
  assert.deepEqual(await broker.list({ conversationId: 'conversation-other', ownerId: identity.ownerId }), []);

  const unknownIdentity = {
    conversationId: 'conversation-unknown',
    runId: 'run-unknown',
    callId: 'call-unknown',
    ownerId: 'owner-unknown',
  };
  const unknownStarted = await broker.start({
    kind: 'fixture',
    taskId: 'fixture_unknown',
    identity: unknownIdentity,
    input: { mode: 'unknown', sideEffectPossible: true },
  });
  const unknown = await broker.wait(unknownStarted.taskId, 10, { conversationId: unknownIdentity.conversationId, ownerId: unknownIdentity.ownerId });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.unknownSideEffect, true);
  const unknownState = projectSnapshotWithReducer(unknownIdentity.conversationId, messageWithTool('running', {
    taskId: unknownStarted.taskId,
    ownerId: unknownStarted.ownerId,
    runId: unknownStarted.runId,
    callId: unknownStarted.callId,
  }), [activeBoundary()], unknown, Date.now());
  assert.equal(unknownState.messages[0].toolCalls[0].status, 'unknown');
  assert.equal(unknownState.messages[0].toolCalls[0].unknownSideEffect, true);
  assert.equal(unknownState.taskBoundaries[0].status, 'aborted');
  assertUnknownDoesNotRetry(fs.readFileSync(path.join(repoRoot, 'src/components/layout/AgentPanel.tsx'), 'utf8'));
  assertAgentLoopPersistsStartedTask(fs.readFileSync(path.join(repoRoot, 'src/services/agentLoop.ts'), 'utf8'));

  await broker.shutdown();
  databaseModule.closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('tool-task-recovery integration: all assertions passed');
  app.exit(0);
}

main().catch(error => {
  console.error(error);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
