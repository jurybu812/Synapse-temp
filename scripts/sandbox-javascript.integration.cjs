const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-sandbox-javascript-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));

const identity = {
  conversationId: 'conversation-A',
  runId: 'run-A',
  callId: 'call-A',
  ownerId: 'owner-A',
};
const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };

async function main() {
  await app.whenReady();
  const { TaskBroker } = require('../dist-electron/electron/toolTasks/TaskBroker.js');
  const { SandboxJavascriptTaskExecutor } = require('../dist-electron/electron/toolTasks/executors/sandboxJavascript.js');
  const broker = new TaskBroker();
  broker.register(new SandboxJavascriptTaskExecutor());

  const started = await broker.start({
    kind: 'sandbox-javascript',
    taskId: 'sandbox-javascript_success',
    identity,
    input: {
      code: 'console.log("hello", 2 + 3); return { sum: 2 + 3, processType: typeof process, requireType: typeof require };',
      timeoutMs: 2_000,
    },
  });
  assert.equal(started.status, 'running');
  const finished = await broker.wait(started.taskId, 5, access);
  assert.equal(finished.status, 'success');
  assert.deepEqual(finished.structured.result, {
    sum: 5,
    processType: 'undefined',
    requireType: 'undefined',
  });
  assert.deepEqual(finished.structured.logs, ['hello 5']);

  const bounded = await broker.start({
    kind: 'sandbox-javascript',
    taskId: 'sandbox-javascript_bounded-output',
    identity: { ...identity, callId: 'call-bounded-output' },
    input: {
      code: 'console.log("x".repeat(20_000)); return "y".repeat(300_000);',
      timeoutMs: 2_000,
    },
  });
  const boundedResult = await broker.wait(bounded.taskId, 5, access);
  assert.equal(boundedResult.status, 'success');
  assert.match(boundedResult.structured.logs[0], /\[truncated\]$/);
  assert.equal(boundedResult.structured.logs[0].length < 9_000, true);
  assert.equal(boundedResult.structured.result.truncated, true);
  assert.equal(boundedResult.structured.result.originalChars > 64_000, true);
  assert.equal(boundedResult.structured.result.preview.length, 64_000);

  const timedOut = await broker.start({
    kind: 'sandbox-javascript',
    taskId: 'sandbox-javascript_timeout',
    identity: { ...identity, callId: 'call-timeout' },
    input: { code: 'while (true) {}', timeoutMs: 100 },
  });
  const timedOutResult = await broker.wait(timedOut.taskId, 5, access);
  assert.equal(timedOutResult.status, 'error');
  assert.equal(timedOutResult.errorCode, 'timeout');

  const cancellable = await broker.start({
    kind: 'sandbox-javascript',
    taskId: 'sandbox-javascript_cancel',
    identity: { ...identity, callId: 'call-cancel' },
    input: { code: 'await new Promise(() => {});', timeoutMs: 5_000 },
  });
  const cancelled = await broker.cancel(cancellable.taskId, access);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.unknownSideEffect, false);

  await assert.rejects(
    () => broker.status(finished.taskId, { conversationId: 'conversation-B', ownerId: identity.ownerId }),
    /不属于当前对话/,
  );
  await broker.shutdown();
  console.log('Sandbox JavaScript integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    app.quit();
  });
