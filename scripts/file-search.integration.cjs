const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-file-search-'));
const userData = path.join(tempRoot, 'user-data');
const workspace = path.join(tempRoot, 'workspace');
app.setPath('userData', userData);

async function main() {
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.config'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'alpha.ts'), 'const marker = "needle-value";\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'src', 'beta.ts'), 'export const beta = true;\n', 'utf8');
  fs.writeFileSync(path.join(workspace, '.config', 'settings.txt'), 'MixedCaseNeedle\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'node_modules', 'ignored', 'hidden.ts'), 'needle-value\n', 'utf8');

  await app.whenReady();
  const { searchFilesInDirectory } = require('../dist-electron/electron/fileSearch.js');
  const { registerAuthorizedWorkspaceRoot } = require('../dist-electron/electron/fileAccess.js');
  const { TaskBroker } = require('../dist-electron/electron/toolTasks/TaskBroker.js');
  const { FileSearchTaskExecutor } = require('../dist-electron/electron/toolTasks/executors/fileSearch.js');
  registerAuthorizedWorkspaceRoot(workspace);

  const direct = await searchFilesInDirectory(workspace, 'needle-value');
  assert.equal(direct.matches.length, 1);
  assert.equal(path.basename(direct.matches[0].path), 'alpha.ts');

  const caseInsensitive = await searchFilesInDirectory(workspace, 'mixedcaseneedle');
  assert.equal(caseInsensitive.matches.length, 1);
  assert.equal(path.basename(caseInsensitive.matches[0].path), 'settings.txt');

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => searchFilesInDirectory(workspace, 'needle-value', { signal: aborted.signal }),
    error => error && error.name === 'AbortError',
  );

  const broker = new TaskBroker();
  broker.register(new FileSearchTaskExecutor());
  const identity = {
    conversationId: 'conversation-A',
    runId: 'run-A',
    callId: 'call-A',
    ownerId: 'owner-A',
  };
  const started = await broker.start({
    kind: 'file-search',
    taskId: 'file-search_integration',
    identity,
    input: {
      query: 'needle-value',
      root: workspace,
      access: { workspaceRoot: workspace, fullAccess: false, approvedPaths: [] },
      fileNameMatches: [{ path: path.join(workspace, 'src', 'alpha.ts'), name: 'alpha.ts', kind: 'file' }],
    },
  });
  assert.equal(started.status, 'running');

  const finished = await broker.wait(started.taskId, 10, {
    conversationId: identity.conversationId,
    ownerId: identity.ownerId,
  });
  assert.equal(finished.status, 'success');
  assert.match(finished.text, /needle-value/);
  assert.equal(finished.structured.results.length, 2);

  await assert.rejects(
    () => broker.status(started.taskId, { conversationId: 'conversation-B', ownerId: identity.ownerId }),
    /不属于当前对话/,
  );
  await broker.shutdown();
  console.log('File search integration: all assertions passed');
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
