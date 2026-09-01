const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-web-fetch-'));
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
  const { WebFetchTaskExecutor } = require('../dist-electron/electron/toolTasks/executors/webFetch.js');
  const broker = new TaskBroker();
  broker.register(new WebFetchTaskExecutor());

  const started = await broker.start({
    kind: 'web',
    taskId: 'web_example',
    identity,
    input: { url: 'https://example.com' },
  });
  const finished = await broker.wait(started.taskId, 10, access);
  assert.equal(finished.status, 'success');
  assert.match(finished.text, /HTTP 200/);
  assert.equal(finished.structured.status, 200);
  assert.equal(finished.structured.finalUrl, 'https://example.com/');

  const blocked = await broker.start({
    kind: 'web',
    taskId: 'web_private',
    identity: { ...identity, callId: 'call-private' },
    input: { url: 'http://127.0.0.1:65535/private' },
  });
  const blockedResult = await broker.wait(blocked.taskId, 10, access);
  assert.equal(blockedResult.status, 'error');
  assert.equal(blockedResult.errorCode, 'approval_denied');

  const syntheticRange = await broker.start({
    kind: 'web',
    taskId: 'web_synthetic-range',
    identity: { ...identity, callId: 'call-synthetic-range' },
    input: { url: 'http://198.18.0.1/private' },
  });
  const syntheticRangeResult = await broker.wait(syntheticRange.taskId, 10, access);
  assert.equal(syntheticRangeResult.status, 'error');
  assert.equal(syntheticRangeResult.errorCode, 'approval_denied');

  await assert.rejects(
    () => broker.status(finished.taskId, { conversationId: 'conversation-B', ownerId: identity.ownerId }),
    /不属于当前对话/,
  );

  await broker.shutdown();
  console.log('Web fetch integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(process.exitCode || 0);
  });
