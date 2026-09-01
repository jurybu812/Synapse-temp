const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-command-encoding-timing-'));
const userData = path.join(tempRoot, 'user-data');
const workspace = path.join(tempRoot, 'workspace');
app.setPath('userData', userData);

const identity = {
  conversationId: 'conversation-A',
  runId: 'run-A',
  callId: 'call-A',
  ownerId: 'owner-A',
};
const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };

function shellQuote(value) {
  if (process.platform === 'win32' && /^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeScript(name, source) {
  const scriptPath = path.join(tempRoot, name);
  fs.writeFileSync(scriptPath, source, 'utf8');
  return scriptPath;
}

function nodeCommand(scriptPath) {
  const nodeExecutable = 'node';
  return `${shellQuote(nodeExecutable)} ${shellQuote(scriptPath)}`;
}

function manifestFor(taskId) {
  const manifestPath = path.join(userData, 'tool-artifacts', 'commands', `${taskId}.json`);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

async function runCommandTask(taskId, scriptPath, timing = {}) {
  const { startCommandTask, waitForCommandTask } = require('../dist-electron/electron/ipc/command.js');
  const started = await startCommandTask({
    command: nodeCommand(scriptPath),
    cwd: workspace,
    taskId,
    ...identity,
    ...timing,
  });
  assert.equal(started.status, 'running');
  const finished = await waitForCommandTask(taskId, 10, access);
  assert.equal(finished.status, 'completed', JSON.stringify(finished, null, 2));
  assert.equal(finished.exitCode, 0, JSON.stringify(finished, null, 2));
  return finished;
}

async function main() {
  fs.mkdirSync(workspace, { recursive: true });
  await app.whenReady();

  const terminalSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'terminal', 'TerminalPanel.tsx'), 'utf8');
  const commandIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'command.ts'), 'utf8');
  const agentLoopSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentLoop.ts'), 'utf8');
  const toolRegistrySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'toolRegistry.ts'), 'utf8');
  assert.match(terminalSource, /command_terminal_\$\{commandTimestamp\}/, 'Terminal task ids must use the command_ namespace');
  assert.match(terminalSource, /cancelPendingApproval/, 'Terminal Stop must cancel a command that is still awaiting approval');
  assert.match(commandIpcSource, /approvalId:\s*`tool-task:\$\{taskId\}`/, 'legacy command approval must register a cancellable approval id');
  assert.match(agentLoopSource, /status === 'cancelled' && result\.error\?\.code === 'approval_denied'\) return 0/, 'approval cancellation must not be displayed as command execution time');
  assert.match(toolRegistrySource, /toolFailure\('cancelled', 'approval_denied',[\s\S]*?executionTimeMs: 0/, 'command approval cancellation must be a terminal non-side-effect result');

  const utf8Script = writeScript('utf8-output.cjs', "process.stdout.write('UTF8中文✓\\n');");
  const bomScript = writeScript('utf8-bom-output.cjs', "process.stdout.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM中文✓\\n', 'utf8')]));");
  const gbkScript = writeScript('gbk-output.cjs', 'process.stdout.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));');
  const timingScript = writeScript('timing-output.cjs', "setTimeout(() => process.stdout.write('timing-ok\\n'), 80);");

  const utf8 = await runCommandTask('command_utf8_preview', utf8Script);
  assert.equal(utf8.stdout, 'UTF8中文✓\n');
  assert.equal(utf8.stdoutArtifact.encoding, 'utf-8');
  assert.equal(manifestFor(utf8.taskId).stdoutArtifact.encoding, 'utf-8');

  const bom = await runCommandTask('command_utf8_bom_preview', bomScript);
  assert.match(bom.stdout, /BOM中文✓/);
  assert.equal(bom.stdoutArtifact.encoding, 'utf-8-bom');
  assert.equal(manifestFor(bom.taskId).stdoutArtifact.encoding, 'utf-8-bom');

  const gbk = await runCommandTask('command_gbk_preview', gbkScript);
  assert.equal(gbk.stdout, '中文\n');
  assert.equal(gbk.stdoutArtifact.encoding, 'gbk');
  assert.equal(manifestFor(gbk.taskId).stdoutArtifact.encoding, 'gbk');

  const approvalStartedAt = Date.now() - 1_500;
  const approvedAt = approvalStartedAt + 1_234;
  const timed = await runCommandTask('command_timing_segments', timingScript, { approvalStartedAt, approvedAt });
  assert.equal(timed.startedAt, approvalStartedAt);
  assert.equal(timed.approvedAt, approvedAt);
  assert.equal(timed.approvalWaitMs, 1_234);
  assert.equal(typeof timed.executionStartedAt, 'number');
  assert.equal(typeof timed.executionFinishedAt, 'number');
  assert.equal(typeof timed.executionTimeMs, 'number');
  assert.equal(typeof timed.wallTimeMs, 'number');
  assert.ok(timed.executionStartedAt >= approvedAt);
  assert.ok(timed.executionFinishedAt >= timed.executionStartedAt);
  assert.ok(timed.executionTimeMs >= 0);
  assert.ok(timed.wallTimeMs >= timed.approvalWaitMs + timed.executionTimeMs);

  const timingManifest = manifestFor(timed.taskId);
  assert.equal(timingManifest.approvalWaitMs, 1_234);
  assert.equal(timingManifest.executionTimeMs, timed.executionTimeMs);
  assert.equal(timingManifest.wallTimeMs, timed.wallTimeMs);

  const { CommandTaskExecutor } = require('../dist-electron/electron/toolTasks/executors/command.js');
  const toolSnapshot = await new CommandTaskExecutor().status(timed.taskId, access);
  assert.equal(toolSnapshot.startedAt, timed.executionStartedAt);
  assert.equal(toolSnapshot.wallStartedAt, timed.startedAt);
  assert.equal(toolSnapshot.approvalWaitMs, timed.approvalWaitMs);
  assert.equal(toolSnapshot.executionTimeMs, timed.executionTimeMs);
  assert.equal(toolSnapshot.wallTimeMs, timed.wallTimeMs);
  assert.equal(toolSnapshot.finishedAt - toolSnapshot.startedAt, toolSnapshot.executionTimeMs);
  assert.ok(toolSnapshot.wallTimeMs > toolSnapshot.executionTimeMs);
  assert.equal(toolSnapshot.artifacts[0].encoding, timed.stdoutArtifact.encoding);
  assert.match(toolSnapshot.text, /encoding=utf-8/);
  assert.match(toolSnapshot.text, /审批等待 1\.2s/);

  console.log('Command encoding/timing integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const { shutdownCommandTasks } = require('../dist-electron/electron/ipc/command.js');
      await shutdownCommandTasks();
    } catch { /* ignore */ }
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    app.quit();
  });
