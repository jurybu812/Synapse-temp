const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain } = require('electron');

process.env.SYNAPSE_PROVIDER_CONNECT_TIMEOUT_MS = '120';
process.env.SYNAPSE_PROVIDER_STREAM_IDLE_TIMEOUT_MS = '120';
process.env.SYNAPSE_PROVIDER_CATALOG_TTL_MS = '1000';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-provider-runtime-'));
process.env.SYNAPSE_DATA_DIR = path.join(tempRoot, 'data');
process.env.SYNAPSE_OPENAI_CODEX_IMPORT_PATH = path.join(tempRoot, 'missing-openai-codex.dpapi');
process.env.SYNAPSE_WINDSURF_IMPORT_DIR = path.join(tempRoot, 'missing-windsurf');
app.setPath('home', path.join(tempRoot, 'home'));
app.setPath('userData', path.join(tempRoot, 'user-data'));

const handlers = new Map();
const received = [];
let databaseModule;
let providerModule;
let server;
let modelRequestCount = 0;
let rejectModelCatalog = false;

ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler);
};

function invoke(channel, event, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return Promise.resolve(handler(event, ...args));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function waitForEvent(events, predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const match = events.find(predicate);
      if (match) return resolve(match);
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for provider event'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function createEvent(events) {
  return {
    sender: {
      id: 42,
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, ...payload }),
    },
  };
}

async function startMockServer() {
  server = http.createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readJson(request) : {};
    received.push({ url: request.url, authorization: request.headers.authorization, body });

    if (request.url === '/v1/models') {
      modelRequestCount += 1;
      if (rejectModelCatalog) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid credential' } }));
        return;
      }
      if (request.headers['if-none-match'] === '"catalog-v1"') {
        response.writeHead(304);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', etag: '"catalog-v1"' });
      response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }

    if (body.model === 'connect-timeout') {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        }
      }, 300);
      return;
    }

    if (body.model === 'rate-limited') {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      response.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }

    if (body.model === 'idle-body') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      request.on('close', () => {
        if (!response.destroyed) response.destroy();
      });
      return;
    }

    if (body.model === 'idle-stream' || body.model === 'cancel-stream' || body.model === 'shutdown-stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      request.on('close', () => {
        if (!response.destroyed) response.destroy();
      });
      return;
    }

    if (body.model === 'empty-stream' || body.model === 'blank-stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(body.model === 'blank-stream' ? ': keepalive\n\n' : '');
      return;
    }

    if (body.model === 'truncated-stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      return;
    }

    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'mock-stream' });
      response.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}/v1`;
}

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  providerModule = require('../dist-electron/electron/ipc/provider.js');
  const { canonicalizeSplitProviderUsage } = require('../dist-electron/electron/provider/usage.js');
  const { buildOpenAICodexContext } = require('../dist-electron/electron/provider/openAICodexChat.js');
  const stableBody = {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'stable user' },
      { role: 'assistant', content: 'stable answer' },
    ],
  };
  const firstPreparedContext = buildOpenAICodexContext(stableBody, 1_700_000_000_000);
  const retriedPreparedContext = buildOpenAICodexContext(stableBody, 1_700_000_000_000);
  assert.deepEqual(retriedPreparedContext, firstPreparedContext);
  assert.equal(firstPreparedContext.messages[0].timestamp, 1_700_000_000_001);
  assert.equal(firstPreparedContext.messages[1].timestamp, 1_700_000_000_002);
  assert.deepEqual(canonicalizeSplitProviderUsage({
    promptTokens: 135,
    completionTokens: 5,
    totalTokens: 34444,
    cacheReadTokens: 34304,
    cacheWriteTokens: 0,
  }), {
    promptTokens: 34439,
    completionTokens: 5,
    totalTokens: 34444,
    cacheReadTokens: 34304,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(canonicalizeSplitProviderUsage({ promptTokens: 7, completionTokens: 2, totalTokens: 9 }), {
    promptTokens: 7,
    completionTokens: 2,
    totalTokens: 9,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  assert.equal(canonicalizeSplitProviderUsage({ promptTokens: 7 }), null);
  const agentLoopSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentLoop.ts'), 'utf8');
  assert.match(agentLoopSource, /chunk\.usage\.compressionGeneration[\s\S]{0,120}requestCompressionGeneration/);
  databaseModule.initDatabase();
  providerModule.registerProviderHandlers();

  const credentialStore = require('../dist-electron/electron/provider/credentialStore.js');
  const { openAICodexController } = require('../dist-electron/electron/provider/openAICodex.js');
  const { windsurfController } = require('../dist-electron/electron/provider/windsurf.js');
  credentialStore.setProviderCredential('openai-codex', 'oauth', {
    type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 60_000, accountId: 'test-account',
  });
  const codexIdentity = credentialStore.getProviderCredentialStatus('openai-codex');
  assert.match(codexIdentity.accountFingerprint, /^[a-f0-9]{64}$/);
  credentialStore.setProviderCredential('openai-codex', 'oauth', {
    type: 'oauth', access: 'rotated-access', refresh: 'test-refresh', expires: Date.now() + 120_000, accountId: 'test-account',
  });
  const rotatedCodexIdentity = credentialStore.getProviderCredentialStatus('openai-codex');
  assert.equal(rotatedCodexIdentity.accountFingerprint, codexIdentity.accountFingerprint);
  assert.ok(rotatedCodexIdentity.credentialGeneration > codexIdentity.credentialGeneration);
  assert.equal((await openAICodexController.status()).connected, true);
  openAICodexController.markCredentialRejected('HTTP 401');
  assert.equal((await openAICodexController.status()).connected, false);
  assert.equal((await openAICodexController.status()).persisted, true);
  assert.ok(credentialStore.getProviderCredentialRejection('openai-codex'));
  databaseModule.closeDatabase();
  databaseModule.initDatabase();
  assert.equal((await openAICodexController.status()).connected, false);
  assert.ok(credentialStore.getProviderCredentialRejection('openai-codex'));
  openAICodexController.markCredentialAccepted();
  assert.equal((await openAICodexController.status()).connected, true);
  assert.equal(credentialStore.getProviderCredentialRejection('openai-codex'), null);

  credentialStore.setProviderCredential('windsurf', 'browser-oauth', {
    kind: 'browser_oauth', apiKey: 'test-api-key', createdAt: new Date().toISOString(), accountName: 'test-account',
  });
  const windsurfIdentity = credentialStore.getProviderCredentialStatus('windsurf');
  assert.match(windsurfIdentity.accountFingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await windsurfController.status()).connected, true);
  windsurfController.markCredentialRejected('HTTP 403');
  assert.equal((await windsurfController.status()).connected, false);
  assert.equal((await windsurfController.status()).persisted, true);
  assert.ok(credentialStore.getProviderCredentialRejection('windsurf'));
  databaseModule.closeDatabase();
  databaseModule.initDatabase();
  assert.equal((await windsurfController.status()).connected, false);
  assert.ok(credentialStore.getProviderCredentialRejection('windsurf'));
  windsurfController.markCredentialAccepted();
  assert.equal((await windsurfController.status()).connected, true);
  assert.equal(credentialStore.getProviderCredentialRejection('windsurf'), null);
  credentialStore.setProviderCredential('windsurf', 'browser-oauth', {
    kind: 'browser_oauth', apiKey: 'expired-api-key', createdAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal((await windsurfController.status()).connected, false);
  credentialStore.setProviderCredential('windsurf', 'browser-oauth', {
    kind: 'browser_oauth', apiKey: 'test-api-key', createdAt: new Date().toISOString(), accountName: 'test-account',
  });
  const rotatedWindsurfIdentity = credentialStore.getProviderCredentialStatus('windsurf');
  assert.equal(rotatedWindsurfIdentity.accountFingerprint, windsurfIdentity.accountFingerprint);
  assert.ok(rotatedWindsurfIdentity.credentialGeneration > windsurfIdentity.credentialGeneration);
  assert.equal((await windsurfController.status()).connected, true);

  const baseUrl = await startMockServer();
  const apiKey = 'provider-runtime-secret-value';
  const events = [];
  const event = createEvent(events);

  const saved = await invoke('provider:setApiKey', event, 'openai', apiKey, baseUrl);
  assert.equal(saved.configured, true);
  assert.equal(saved.persisted, true);
  assert.equal(Object.values(saved).includes(apiKey), false);
  assert.match(saved.accountFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(saved.credentialGeneration > 0);

  const status = await invoke('provider:credentialStatus', event, 'openai');
  assert.deepEqual(status, saved);
  assert.equal(JSON.stringify(status).includes(apiKey), false);

  const credentialRow = databaseModule.getDatabase()
    .prepare("SELECT value FROM settings WHERE key = 'providerCredential:openai'")
    .get();
  assert.ok(credentialRow);
  assert.equal(String(credentialRow.value).includes(apiKey), false);

  const models = await invoke('provider:fetchModels', event, 'openai', true);
  assert.equal(models.ok, true);
  assert.equal(JSON.parse(models.bodyText).data[0].id, 'mock-model');
  assert.equal(models.catalog.source, 'network');
  assert.match(models.catalog.generation, /^[a-f0-9]{64}$/);
  assert.equal(models.catalog.accountFingerprint, saved.accountFingerprint);
  assert.equal(models.catalog.credentialGeneration, saved.credentialGeneration);
  const cachedModels = await invoke('provider:fetchModels', event, 'openai', false);
  assert.equal(cachedModels.catalog.source, 'cache');
  assert.equal(modelRequestCount, 1);
  const validatedModels = await invoke('provider:fetchModels', event, 'openai', true);
  assert.equal(validatedModels.catalog.source, 'cache-validated');
  assert.equal(validatedModels.catalog.generation, models.catalog.generation);
  assert.equal(modelRequestCount, 2);
  rejectModelCatalog = true;
  const rejectedModels = await invoke('provider:fetchModels', event, 'openai', true);
  assert.equal(rejectedModels.ok, false);
  assert.equal(rejectedModels.status, 401);
  assert.equal((await invoke('provider:credentialStatus', event, 'openai')).configured, false);
  rejectModelCatalog = false;
  const recoveredModels = await invoke('provider:fetchModels', event, 'openai', false);
  assert.equal(recoveredModels.ok, true);
  assert.equal(recoveredModels.catalog.source, 'network');
  assert.equal(modelRequestCount, 4);
  assert.equal((await invoke('provider:credentialStatus', event, 'openai')).configured, true);

  const nonStream = await invoke('provider:chatStart', event, {
    requestId: 'non-stream', cancelToken: 'non-stream-cancel-token', providerId: 'openai', baseUrl: 'http://127.0.0.1:1/v1',
    conversationId: 'conversation-ledger', runId: 'run-ledger', ownerId: 'owner-ledger',
    catalogGeneration: models.catalog.generation, compressionGeneration: '7',
    body: { model: 'mock-model', messages: [{ role: 'user', content: [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ] }] }, stream: false,
  });
  assert.equal(nonStream.ok, true);
  assert.equal(JSON.parse(nonStream.bodyText).choices[0].message.content, 'hello');
  assert.match(nonStream.request.bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(nonStream.request.modelId, 'mock-model');
  assert.equal(nonStream.request.accountFingerprint, saved.accountFingerprint);
  assert.equal(nonStream.request.credentialGeneration, saved.credentialGeneration);
  assert.equal(nonStream.request.catalogGeneration, models.catalog.generation);
  assert.equal(nonStream.request.compressionGeneration, '7');
  assert.equal(nonStream.request.inputImages.length, 1);
  assert.equal(nonStream.request.inputImages[0].mime, 'image/png');
  assert.equal(await invoke('provider:recordUsage', event, {
    requestId: 'non-stream', promptTokens: 120, completionTokens: 30, totalTokens: 150,
    cacheReadTokens: 80, cacheWriteTokens: null,
  }), true);
  const ledgerRow = databaseModule.getDatabase().prepare('SELECT * FROM provider_request_ledger WHERE request_id = ?').get('non-stream');
  assert.equal(ledgerRow.conversation_id, 'conversation-ledger');
  assert.equal(ledgerRow.request_kind, 'agent');
  assert.equal(ledgerRow.catalog_generation, models.catalog.generation);
  assert.equal(ledgerRow.compression_generation, '7');
  assert.equal(ledgerRow.prompt_tokens, 120);
  assert.equal(ledgerRow.cache_read_tokens, 80);
  assert.equal(ledgerRow.cache_write_tokens, null);
  assert.equal(ledgerRow.status, 'completed');
  assert.equal(JSON.parse(ledgerRow.input_images_json).length, 1);
  const latestUsage = await invoke('provider:latestUsage', event, 'conversation-ledger');
  assert.equal(latestUsage.requestId, 'non-stream');
  assert.equal(latestUsage.requestKind, 'agent');
  assert.equal(latestUsage.promptTokens, 120);
  assert.equal(latestUsage.accountFingerprint, saved.accountFingerprint);
  assert.equal(latestUsage.credentialGeneration, saved.credentialGeneration);
  const newerStarted = await invoke('provider:chatStart', event, {
    requestId: 'newer-started', cancelToken: 'newer-started-cancel-token', providerId: 'openai', baseUrl,
    conversationId: 'conversation-ledger', runId: 'run-newer-started', ownerId: 'owner-ledger',
    catalogGeneration: models.catalog.generation, compressionGeneration: '7',
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'next request' }] }, stream: false,
  });
  assert.equal(newerStarted.ok, true);
  assert.equal(await invoke('provider:latestUsage', event, 'conversation-ledger'), null);
  assert.equal(await invoke('provider:recordUsage', event, {
    requestId: 'newer-started', promptTokens: 18, completionTokens: 2, totalTokens: 20,
    cacheReadTokens: 12, cacheWriteTokens: 0,
  }), true);
  assert.equal((await invoke('provider:latestUsage', event, 'conversation-ledger')).requestId, 'newer-started');
  databaseModule.getDatabase().prepare("UPDATE provider_request_ledger SET status = 'superseded' WHERE request_id = 'newer-started'").run();
  databaseModule.getDatabase().prepare(`
    INSERT INTO provider_request_ledger (
      request_id, renderer_id, conversation_id, run_id, call_id, owner_id, request_kind, provider_id, model_id,
      account_fingerprint, credential_generation, catalog_generation, compression_generation, body_sha256, input_images_json, prompt_tokens, completion_tokens,
      total_tokens, cache_read_tokens, cache_write_tokens, sent_at, completed_at, status
    )
    SELECT 'same-time-new', renderer_id, conversation_id, run_id, 'same-time-new', owner_id, request_kind, provider_id, model_id,
           account_fingerprint, credential_generation, catalog_generation, compression_generation, body_sha256, input_images_json, prompt_tokens, completion_tokens,
           total_tokens, cache_read_tokens, cache_write_tokens, sent_at, completed_at, status
    FROM provider_request_ledger WHERE request_id = 'non-stream'
  `).run();
  assert.equal((await invoke('provider:latestUsage', event, 'conversation-ledger')).requestId, 'same-time-new');
  databaseModule.getDatabase().prepare("DELETE FROM provider_request_ledger WHERE request_id = 'same-time-new'").run();
  databaseModule.getDatabase().prepare(`
    UPDATE provider_request_ledger
    SET prompt_tokens = 135, completion_tokens = 5, total_tokens = 34444,
        cache_read_tokens = 34304, cache_write_tokens = NULL
    WHERE request_id = 'non-stream'
  `).run();
  const legacySplitUsage = await invoke('provider:latestUsage', event, 'conversation-ledger');
  assert.equal(legacySplitUsage.promptTokens, 34439);
  assert.equal(legacySplitUsage.totalTokens, 34444);
  assert.equal(legacySplitUsage.cacheReadTokens, 34304);
  assert.equal(legacySplitUsage.cacheWriteTokens, null);
  assert.equal(await invoke('provider:promoteUsage', event, 'conversation-ledger', 'conversation-promoted'), true);
  assert.equal(await invoke('provider:latestUsage', event, 'conversation-ledger'), null);
  assert.equal((await invoke('provider:latestUsage', event, 'conversation-promoted')).requestId, 'non-stream');
  assert.equal(await invoke('provider:invalidateUsage', event, 'conversation-promoted'), true);
  assert.equal(await invoke('provider:recordUsage', event, {
    requestId: 'non-stream', promptTokens: 999, completionTokens: 1, totalTokens: 1000,
    cacheReadTokens: 999, cacheWriteTokens: null,
  }), false);
  const supersededRow = databaseModule.getDatabase().prepare('SELECT status FROM provider_request_ledger WHERE request_id = ?').get('non-stream');
  assert.equal(supersededRow.status, 'superseded');

  const noUsage = await invoke('provider:chatStart', event, {
    requestId: 'no-usage', cancelToken: 'no-usage-cancel-token', providerId: 'openai',
    conversationId: 'conversation-no-usage', requestKind: 'agent',
    body: { model: 'mock-model', messages: [] }, stream: false,
  });
  assert.equal(noUsage.ok, true);
  assert.equal(await invoke('provider:recordUsage', event, { requestId: 'no-usage', promptTokens: 7 }), false);
  const noUsageRow = databaseModule.getDatabase().prepare('SELECT prompt_tokens, completion_tokens, total_tokens FROM provider_request_ledger WHERE request_id = ?').get('no-usage');
  assert.equal(noUsageRow.prompt_tokens, null);
  assert.equal(noUsageRow.completion_tokens, null);
  assert.equal(noUsageRow.total_tokens, null);
  assert.equal(await invoke('provider:latestUsage', event, 'conversation-no-usage'), null);

  const streamStart = await invoke('provider:chatStart', event, {
    requestId: 'stream-success', cancelToken: 'stream-success-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'mock-model', messages: [], stream: true }, stream: true,
  });
  assert.equal(streamStart.streaming, true);
  assert.match(streamStart.request.bodySha256, /^[a-f0-9]{64}$/);
  const streamDone = await waitForEvent(events, item => item.requestId === 'stream-success' && item.type === 'done');
  assert.equal(streamDone.channel, 'provider:chat:event');
  const streamBytes = events
    .filter(item => item.requestId === 'stream-success' && item.type === 'data')
    .map(item => Buffer.from(item.data, 'base64').toString('utf8'))
    .join('');
  assert.match(streamBytes, /hello/);
  assert.match(streamBytes, /\[DONE\]/);

  for (const model of ['empty-stream', 'blank-stream']) {
    const requestId = `${model}-request`;
    const start = await invoke('provider:chatStart', event, {
      requestId, cancelToken: `${model}-cancel-token`, providerId: 'openai', baseUrl,
      body: { model, messages: [], stream: true }, stream: true,
    });
    assert.equal(start.streaming, true);
    const error = await waitForEvent(events, item => item.requestId === requestId && item.type === 'error');
    assert.equal(error.code, 'empty_stream');
    const row = databaseModule.getDatabase().prepare('SELECT status FROM provider_request_ledger WHERE request_id = ?').get(requestId);
    assert.equal(row.status, 'error');
  }

  const truncatedStart = await invoke('provider:chatStart', event, {
    requestId: 'truncated-stream-request', cancelToken: 'truncated-stream-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'truncated-stream', messages: [], stream: true }, stream: true,
  });
  assert.equal(truncatedStart.streaming, true);
  const truncatedError = await waitForEvent(events, item => item.requestId === 'truncated-stream-request' && item.type === 'error');
  assert.equal(truncatedError.code, 'truncated_stream');
  const truncatedRow = databaseModule.getDatabase().prepare('SELECT status FROM provider_request_ledger WHERE request_id = ?').get('truncated-stream-request');
  assert.equal(truncatedRow.status, 'error');

  const limited = await invoke('provider:chatStart', event, {
    requestId: 'rate-limit', cancelToken: 'rate-limit-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'rate-limited', messages: [] }, stream: false,
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '7');

  const connectTimedOut = await invoke('provider:chatStart', event, {
    requestId: 'connect-timeout', cancelToken: 'connect-timeout-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'connect-timeout', messages: [] }, stream: false,
  });
  assert.equal(connectTimedOut.error.code, 'connect_timeout');

  const bodyIdle = await invoke('provider:chatStart', event, {
    requestId: 'idle-body', cancelToken: 'idle-body-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'idle-body', messages: [] }, stream: false,
  });
  assert.equal(bodyIdle.error.code, 'body_idle_timeout');

  const idleStart = await invoke('provider:chatStart', event, {
    requestId: 'idle-stream', cancelToken: 'idle-stream-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'idle-stream', messages: [], stream: true }, stream: true,
  });
  assert.equal(idleStart.streaming, true);
  const idleError = await waitForEvent(events, item => item.requestId === 'idle-stream' && item.type === 'error');
  assert.equal(idleError.code, 'stream_idle_timeout');

  const cancelStart = await invoke('provider:chatStart', event, {
    requestId: 'cancel-stream', cancelToken: 'cancel-stream-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'cancel-stream', messages: [], stream: true }, stream: true,
  });
  assert.equal(cancelStart.streaming, true);
  assert.equal(await invoke('provider:chatCancel', event, { requestId: 'cancel-stream', cancelToken: 'wrong-cancel-token' }), false);
  assert.equal(await invoke('provider:chatCancel', event, { requestId: 'cancel-stream', cancelToken: 'cancel-stream-cancel-token' }), true);
  const cancelError = await waitForEvent(events, item => item.requestId === 'cancel-stream' && item.type === 'error');
  assert.equal(cancelError.code, 'aborted');

  const shutdownStart = await invoke('provider:chatStart', event, {
    requestId: 'shutdown-stream', cancelToken: 'shutdown-stream-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'shutdown-stream', messages: [], stream: true }, stream: true,
  });
  assert.equal(shutdownStart.streaming, true);
  providerModule.shutdownProviderRuntime();
  const shutdownRow = databaseModule.getDatabase().prepare('SELECT status FROM provider_request_ledger WHERE request_id = ?').get('shutdown-stream');
  assert.equal(shutdownRow.status, 'cancelled');

  assert.ok(received.length >= 7);
  assert.ok(received.every(item => item.authorization === `Bearer ${apiKey}`));
  assert.equal(JSON.stringify({ models, nonStream, streamStart, limited, connectTimedOut, idleStart, cancelStart }).includes(apiKey), false);

  const lateRequest = await invoke('provider:chatStart', event, {
    requestId: 'late-old-account', cancelToken: 'late-old-account-token', providerId: 'openai',
    conversationId: 'conversation-account-switch',
    body: { model: 'mock-model', messages: [] }, stream: false,
  });
  assert.equal(lateRequest.ok, true);
  const switched = await invoke('provider:setApiKey', event, 'openai', 'provider-runtime-second-secret', baseUrl);
  assert.notEqual(switched.accountFingerprint, saved.accountFingerprint);
  assert.ok(switched.credentialGeneration > saved.credentialGeneration);
  assert.equal(await invoke('provider:recordUsage', event, {
    requestId: 'late-old-account', promptTokens: 4, completionTokens: 1, totalTokens: 5,
  }), false);
  assert.equal(databaseModule.getDatabase().prepare('SELECT status FROM provider_request_ledger WHERE request_id = ?').get('late-old-account').status, 'superseded');
  assert.equal(await invoke('provider:latestUsage', event, 'conversation-account-switch'), null);
  databaseModule.getDatabase().prepare(`
    INSERT INTO provider_request_ledger (
      request_id, renderer_id, conversation_id, request_kind, provider_id, model_id,
      body_sha256, input_images_json, prompt_tokens, completion_tokens, total_tokens,
      sent_at, completed_at, status
    ) VALUES ('legacy-null-identity', 42, 'conversation-account-switch', 'agent', 'openai', 'mock-model',
      'legacy-body', '[]', 8, 2, 10, ?, ?, 'completed')
  `).run(Date.now() + 1, Date.now() + 1);
  assert.equal(await invoke('provider:latestUsage', event, 'conversation-account-switch'), null);
  const switchedModels = await invoke('provider:fetchModels', event, 'openai', true);
  assert.equal(switchedModels.catalog.accountFingerprint, switched.accountFingerprint);
  assert.equal(switchedModels.catalog.credentialGeneration, switched.credentialGeneration);
  assert.equal(JSON.stringify(switchedModels.catalog).includes('provider-runtime-second-secret'), false);

  const deleted = await invoke('provider:deleteCredential', event, 'openai');
  assert.equal(deleted.configured, false);
  assert.equal(deleted.accountFingerprint, null);
  assert.ok(deleted.credentialGeneration > switched.credentialGeneration);
  const missing = await invoke('provider:chatStart', event, {
    requestId: 'missing', cancelToken: 'missing-cancel-token', providerId: 'openai', baseUrl,
    body: { model: 'mock-model', messages: [] }, stream: false,
  });
  assert.equal(missing.error.code, 'missing_credential');

  console.log('Provider runtime integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { providerModule?.shutdownProviderRuntime(); } catch {}
    try { databaseModule?.closeDatabase(); } catch {}
    try { await new Promise(resolve => server?.close(resolve)); } catch {}
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    app.quit();
  });
