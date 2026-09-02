const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

if (process.env.SYNAPSE_ALLOW_LIVE_PROVIDER_TESTS !== '1') {
  console.log('Windsurf live integration skipped: set SYNAPSE_ALLOW_LIVE_PROVIDER_TESTS=1 to allow a real Provider request');
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-windsurf-live-'));
process.env.SYNAPSE_DATA_DIR = path.join(tempRoot, 'data');
app.setPath('home', path.join(tempRoot, 'home'));
app.setPath('userData', path.join(tempRoot, 'user-data'));

let databaseModule;
let windsurfModule;
let chatModule;

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  windsurfModule = require('../dist-electron/electron/provider/windsurf.js');
  chatModule = require('../dist-electron/electron/provider/windsurfChat.js');
  databaseModule.initDatabase();

  let imported = await windsurfModule.windsurfController.importLocal({ requesterId: process.pid });
  if (!imported.ok && imported.error?.code === 'multiple_accounts') {
    const requestedSource = process.env.SYNAPSE_WINDSURF_LIVE_SOURCE?.trim().toLocaleLowerCase();
    assert.ok(
      requestedSource,
      'Multiple local Windsurf accounts found; set SYNAPSE_WINDSURF_LIVE_SOURCE to one explicit candidate source',
    );
    const candidates = imported.candidates ?? imported.error.candidates ?? [];
    const matches = candidates.filter(candidate => (
      candidate.source
        .split(' / ')
        .some(source => source.trim().toLocaleLowerCase() === requestedSource)
    ));
    assert.equal(matches.length, 1, `Expected exactly one local Windsurf candidate for source: ${requestedSource}`);
    imported = await windsurfModule.windsurfController.importLocal({
      requesterId: process.pid,
      candidateFingerprint: matches[0].candidateFingerprint,
    });
  }
  assert.equal(imported.ok, true, `Windsurf local account import failed: ${imported.error?.code ?? 'unknown'}`);
  const status = imported.status;
  assert.equal(status.connected, true, 'Windsurf local account was not imported');
  assert.equal(status.persisted, true, 'Imported Windsurf credential was not persisted with safeStorage');

  const stored = databaseModule.getDatabase()
    .prepare("SELECT value FROM settings WHERE key = 'providerCredential:windsurf'")
    .get();
  assert.ok(stored?.value, 'Encrypted Windsurf credential row is missing');
  assert.equal(stored.value.includes('apiKey'), false);
  assert.equal(stored.value.includes('devin-session-token'), false);

  const catalog = await windsurfModule.fetchWindsurfCatalog(true);
  assert.equal(catalog.ok, true, `Catalog failed: ${catalog.error?.message ?? catalog.status}`);
  const models = JSON.parse(catalog.bodyText).data;
  assert.ok(Array.isArray(models) && models.length > 0, 'Windsurf catalog returned no models');
  const preferred = models.find(model => model.id === 'swe-1-7-lightning')
    ?? models.find(model => model.id === 'swe-1-7')
    ?? models.find(model => model.id === 'swe-1-6' || model.id === 'swe-1.6')
    ?? models[0];
  assert.ok(preferred?.id, 'Windsurf catalog model id is missing');

  let preparedPayload;
  const result = await chatModule.startWindsurfChat({
    body: {
      model: preferred.id,
      messages: [{ role: 'user', content: 'Reply with exactly: SYNAPSE_WINDSURF_OK' }],
      stream: false,
      max_tokens: 64,
    },
    conversationId: 'windsurf-live-probe',
    signal: new AbortController().signal,
    stream: false,
    connectTimeoutMs: 45_000,
    idleTimeoutMs: 45_000,
    onRequestPrepared(payload) { preparedPayload = payload; },
    onData() {},
    onDone() {},
    onError(code, message) { throw new Error(`${code}: ${message}`); },
    onSettled() {},
  });
  const response = JSON.parse(result.bodyText);
  const content = response?.choices?.[0]?.message?.content;
  assert.equal(typeof content, 'string');
  assert.ok(content.includes('SYNAPSE_WINDSURF_OK'), 'Real Windsurf response did not match the probe');
  assert.equal(preparedPayload?.modelUid, preferred.id);
  assert.equal(preparedPayload?.cascadeId.length > 0, true);
  assert.ok(Array.isArray(preparedPayload?.messages));
  assert.ok(response.usage.prompt_tokens >= (response.usage.prompt_tokens_details?.cached_tokens ?? 0));
  assert.equal(response.usage.total_tokens, response.usage.prompt_tokens + response.usage.completion_tokens);
  console.log(`Windsurf live integration: connected, ${models.length} models, request passed`);
}

let exitCode = 0;
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
}).finally(async () => {
  try { windsurfModule?.windsurfController.dispose(); } catch {}
  try { chatModule?.clearWindsurfConversationState(); } catch {}
  try { databaseModule?.closeDatabase(); } catch {}
  try {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('synapse-windsurf-live-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } catch {}
  app.exit(exitCode);
});
