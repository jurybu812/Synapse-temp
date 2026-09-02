const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

if (process.env.SYNAPSE_ALLOW_LIVE_PROVIDER_TESTS !== '1') {
  console.log('OpenAI Codex live integration skipped: set SYNAPSE_ALLOW_LIVE_PROVIDER_TESTS=1 to allow a real Provider request');
  process.exit(0);
}

const seededStorageRoot = process.env.SYNAPSE_LIVE_STORAGE_ROOT?.trim();
const tempRoot = seededStorageRoot
  ? path.resolve(seededStorageRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-openai-codex-live-'));
const ownsTempRoot = !seededStorageRoot;
if (seededStorageRoot) {
  assert.equal(fs.statSync(tempRoot).isDirectory(), true, 'Seeded live storage root must be a directory');
  const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.equal(
    tempRoot.startsWith(resolvedTempRoot),
    true,
    'Seeded live storage root must be an isolated directory under the system temp root',
  );
  const markerPath = path.join(tempRoot, '.synapse-live-test.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.purpose, 'synapse-provider-live-test', 'Seeded live storage root marker is invalid');
}
const disabledLegacyImportPath = path.join(tempRoot, '.disabled-legacy-openai-codex-import');
assert.equal(fs.existsSync(disabledLegacyImportPath), false, 'Disabled legacy import sentinel path must not exist');
process.env.SYNAPSE_OPENAI_CODEX_IMPORT_PATH = disabledLegacyImportPath;
process.env.SYNAPSE_DATA_DIR = seededStorageRoot ? path.join(tempRoot, '.synapse') : path.join(tempRoot, 'data');
app.setPath('home', seededStorageRoot ? tempRoot : path.join(tempRoot, 'home'));
app.setPath('userData', path.join(tempRoot, 'user-data'));

let databaseModule;
let codexModule;

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  codexModule = require('../dist-electron/electron/provider/openAICodex.js');
  const chatModule = require('../dist-electron/electron/provider/openAICodexChat.js');
  databaseModule.initDatabase();

  const seededCredential = databaseModule.getDatabase()
    .prepare("SELECT length(value) AS bytes FROM settings WHERE key = 'providerCredential:openai-codex'")
    .get();
  assert.ok(seededCredential?.bytes > 0, 'Seeded OpenAI Codex credential row is missing before Provider initialization');

  const status = await codexModule.openAICodexController.status();
  assert.equal(status.connected, true, 'OpenAI Codex encrypted credential was not imported');
  assert.equal(status.persisted, true, 'Imported credential was not persisted with safeStorage');

  const stored = databaseModule.getDatabase()
    .prepare("SELECT value FROM settings WHERE key = 'providerCredential:openai-codex'")
    .get();
  assert.ok(stored?.value, 'Encrypted credential row is missing');
  assert.equal(stored.value.includes('access'), false);
  assert.equal(stored.value.includes('refresh'), false);

  const catalog = await codexModule.fetchOpenAICodexCatalog(true);
  assert.equal(catalog.ok, true, `Catalog failed: ${catalog.error?.message ?? catalog.status}`);
  const models = JSON.parse(catalog.bodyText).data;
  assert.ok(Array.isArray(models) && models.length > 0, 'Catalog returned no models');
  const preferred = models.find(model => model.id === 'gpt-5.5') ?? models[0];
  assert.ok(preferred?.id, 'Catalog model id is missing');

  const controller = new AbortController();
  let preparedPayload;
  const result = await chatModule.startOpenAICodexChat({
    body: {
      model: preferred.id,
      messages: [{ role: 'user', content: 'Reply with exactly: SYNAPSE_PROVIDER_OK' }],
      stream: false,
      max_tokens: 32,
      reasoning_effort: 'low',
    },
    signal: controller.signal,
    stream: false,
    requestTimestamp: Date.now(),
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
  assert.ok(content.includes('SYNAPSE_PROVIDER_OK'), 'Real provider response did not match the probe');
  assert.equal(preparedPayload?.provider, 'openai-codex');
  assert.equal(preparedPayload?.model, preferred.id);
  assert.ok(Array.isArray(preparedPayload?.context?.messages));
  assert.ok(response.usage.prompt_tokens >= (response.usage.prompt_tokens_details?.cached_tokens ?? 0));
  assert.equal(response.usage.total_tokens, response.usage.prompt_tokens + response.usage.completion_tokens);
  console.log(`OpenAI Codex live integration: connected, ${models.length} models, request passed`);
}

let exitCode = 0;
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
}).finally(async () => {
  try { await codexModule?.openAICodexController.dispose(); } catch {}
  try { databaseModule?.closeDatabase(); } catch {}
  try {
    const resolved = path.resolve(tempRoot);
    if (ownsTempRoot && resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('synapse-openai-codex-live-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } catch {}
  app.exit(exitCode);
});
