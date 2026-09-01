const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

if (process.env.SYNAPSE_ALLOW_LIVE_PROVIDER_TESTS !== '1') {
  console.log('OpenAI Codex live integration skipped: set SYNAPSE_ALLOW_LIVE_PROVIDER_TESTS=1 to allow a real Provider request');
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-openai-codex-live-'));
process.env.SYNAPSE_DATA_DIR = path.join(tempRoot, 'data');
app.setPath('home', path.join(tempRoot, 'home'));
app.setPath('userData', path.join(tempRoot, 'user-data'));

let databaseModule;
let codexModule;

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  codexModule = require('../dist-electron/electron/provider/openAICodex.js');
  const chatModule = require('../dist-electron/electron/provider/openAICodexChat.js');
  databaseModule.initDatabase();

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
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('synapse-openai-codex-live-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } catch {}
  app.exit(exitCode);
});
