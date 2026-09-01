const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app, shell } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-provider-auth-state-'));
process.env.SYNAPSE_DATA_DIR = path.join(tempRoot, 'data');
process.env.SYNAPSE_OPENAI_CODEX_IMPORT_PATH = path.join(tempRoot, 'missing-openai.dpapi');
process.env.SYNAPSE_WINDSURF_IMPORT_DIR = path.join(tempRoot, 'missing-windsurf');
process.env.SYNAPSE_OPENAI_CODEX_LOGIN_TIMEOUT_MS = '300';
process.env.SYNAPSE_WINDSURF_LOGIN_TIMEOUT_MS = '300';
app.setPath('home', path.join(tempRoot, 'home'));
app.setPath('userData', path.join(tempRoot, 'user-data'));

let databaseModule;
let openAIModule;
let windsurfModule;
let windsurfUpstreamModule;
let originalOpenExternal;
let originalLoadWindsurfUpstream;

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function listen1455() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(1455, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function waitForState(controller, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await controller.status();
    if (expected.includes(status.state)) return status;
    await wait(25);
  }
  const status = await controller.status();
  assert.fail(`Expected state ${expected.join('/')} but received ${status.state}`);
}

async function assertPortReleased() {
  const server = await listen1455();
  await closeServer(server);
}

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  databaseModule.initDatabase();
  openAIModule = require('../dist-electron/electron/provider/openAICodex.js');
  windsurfUpstreamModule = require('../dist-electron/electron/provider/windsurfUpstream.js');
  originalLoadWindsurfUpstream = windsurfUpstreamModule.loadWindsurfUpstream;
  const exchangeResolvers = [];
  windsurfUpstreamModule.loadWindsurfUpstream = async () => ({
    registerUser: () => new Promise(resolve => exchangeResolvers.push(resolve)),
    clearCachedUserJwt() {},
    clearSessionIds() {},
  });
  windsurfModule = require('../dist-electron/electron/provider/windsurf.js');

  const openedUrls = [];
  originalOpenExternal = shell.openExternal;
  shell.openExternal = async url => {
    openedUrls.push(url);
  };

  const occupied = await listen1455();
  await assert.rejects(
    () => openAIModule.openAICodexController.start(),
    /OAuth callback port 1455 is unavailable/,
  );
  await closeServer(occupied);

  const waiting = await openAIModule.openAICodexController.start();
  assert.ok(['starting', 'waiting'].includes(waiting.state));
  const hasExpectedRedirect = () => openedUrls.some(url => {
    try {
      return new URL(url).searchParams.get('redirect_uri') === 'http://localhost:1455/auth/callback';
    } catch {
      return false;
    }
  });
  const redirectDeadline = Date.now() + 1_000;
  while (!hasExpectedRedirect() && Date.now() < redirectDeadline) await wait(10);
  assert.equal(hasExpectedRedirect(), true);
  const timedOut = await waitForState(openAIModule.openAICodexController, ['error']);
  assert.match(timedOut.error ?? '', /取消或超时/);
  assert.equal(timedOut.authorizationUrl, null);
  await assertPortReleased();

  const openedBeforeRestart = openedUrls.length;
  const [restarted, duplicateStart] = await Promise.all([
    openAIModule.openAICodexController.start(),
    openAIModule.openAICodexController.start(),
  ]);
  assert.ok(['starting', 'waiting'].includes(restarted.state));
  assert.ok(['starting', 'waiting'].includes(duplicateStart.state));
  assert.equal(openedUrls.length, openedBeforeRestart + 1);
  const cancelled = await openAIModule.openAICodexController.cancel();
  assert.equal(cancelled.state, 'idle');
  assert.equal(cancelled.authorizationUrl, null);
  await assertPortReleased();

  const windsurfWaiting = await windsurfModule.windsurfController.start();
  assert.equal(windsurfWaiting.state, 'waiting');
  assert.ok(windsurfWaiting.transactionId);
  assert.ok(windsurfWaiting.authorizationUrl?.includes(windsurfWaiting.transactionId));
  const windsurfCancelled = await windsurfModule.windsurfController.cancel();
  assert.equal(windsurfCancelled.state, 'idle');
  assert.equal(windsurfCancelled.transactionId, null);
  assert.equal(windsurfCancelled.authorizationUrl, null);

  const windsurfRestarted = await windsurfModule.windsurfController.start();
  assert.equal(windsurfRestarted.state, 'waiting');
  const windsurfTimedOut = await waitForState(windsurfModule.windsurfController, ['error']);
  assert.match(windsurfTimedOut.error ?? '', /登录已超时/);
  assert.equal(windsurfTimedOut.transactionId, null);
  assert.equal(windsurfTimedOut.authorizationUrl, null);

  const windsurfExchange = await windsurfModule.windsurfController.start();
  const firstExchange = windsurfModule.windsurfController.complete(windsurfExchange.transactionId, 'a'.repeat(32));
  await assert.rejects(
    () => windsurfModule.windsurfController.complete(windsurfExchange.transactionId, 'b'.repeat(32)),
    /already in progress/,
  );
  const resolveExchange = exchangeResolvers.shift();
  assert.equal(typeof resolveExchange, 'function');
  resolveExchange({ apiKey: 'test-api-key', apiServerUrl: 'https://server.codeium.com', name: 'test-account' });
  assert.equal((await firstExchange).connected, true);
  assert.equal(openedUrls.length >= 5, true);

  console.log('Provider auth state integration: port, timeout, cancel, and cleanup passed');
}

let exitCode = 0;
main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  exitCode = 1;
}).finally(async () => {
  try { shell.openExternal = originalOpenExternal; } catch {}
  try { windsurfUpstreamModule.loadWindsurfUpstream = originalLoadWindsurfUpstream; } catch {}
  try { openAIModule?.openAICodexController.dispose(); } catch {}
  try { windsurfModule?.windsurfController.dispose(); } catch {}
  try { databaseModule?.closeDatabase(); } catch {}
  try {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('synapse-provider-auth-state-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } catch {}
  app.exit(exitCode);
});
