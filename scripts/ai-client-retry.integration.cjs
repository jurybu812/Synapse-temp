const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function transpile(filePath) {
  return ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
}

const modelPath = path.join(__dirname, '..', 'src', 'services', 'modelCapabilities.ts');
const modelModule = { exports: {} };
new Function('require', 'module', 'exports', transpile(modelPath))(require, modelModule, modelModule.exports);

const requests = [];
let attempt = 0;
let abortOnSubscribe = false;
let clientToAbort = null;
let unsubscribeCount = 0;
const chatEventHandlers = new Set();
let startChatImpl = async (_request, requestMeta) => {
  attempt += 1;
  if (attempt === 1) {
    return {
      ok: false,
      status: 503,
      headers: { 'content-type': 'application/json' },
      streaming: false,
      bodyText: JSON.stringify({ error: { message: 'temporary upstream failure' } }),
      request: requestMeta,
    };
  }
  return {
    ok: true,
    status: 200,
    headers: { 'content-type': 'application/json' },
    streaming: false,
    bodyText: JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
    }),
    request: requestMeta,
  };
};

function resetProviderState() {
  requests.length = 0;
  attempt = 0;
  abortOnSubscribe = false;
  clientToAbort = null;
  unsubscribeCount = 0;
  chatEventHandlers.clear();
}

function emitProviderEvent(event) {
  for (const handler of [...chatEventHandlers]) handler(event);
}

function encodeSse(value) {
  return Buffer.from(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`, 'utf8').toString('base64');
}

const provider = {
  onChatEvent(handler) {
    chatEventHandlers.add(handler);
    if (abortOnSubscribe) clientToAbort?.abort();
    return () => {
      unsubscribeCount += 1;
      chatEventHandlers.delete(handler);
    };
  },
  cancelChat: async () => true,
  recordUsage: async () => true,
  async startChat(request) {
    requests.push(structuredClone(request));
    const requestMeta = {
      requestId: request.requestId,
      conversationId: request.conversationId,
      runId: request.runId,
      callId: request.callId,
      ownerId: request.ownerId,
      requestKind: request.requestKind ?? 'agent',
      providerId: request.providerId,
      modelId: request.body.model,
      catalogGeneration: request.catalogGeneration,
      compressionGeneration: request.compressionGeneration,
      bodySha256: crypto.createHash('sha256').update(JSON.stringify(request.body)).digest('hex'),
      inputImages: [],
      sentAt: Date.now(),
    };
    return startChatImpl(request, requestMeta);
  },
};

const aiClientPath = path.join(__dirname, '..', 'src', 'services', 'aiClient.ts');
const aiClientModule = { exports: {} };
const aiClientRequire = request => {
  if (request === './modelCapabilities') return modelModule.exports;
  if (request === '@/platform') return { platform: { provider } };
  return require(request);
};
new Function('require', 'module', 'exports', transpile(aiClientPath))(aiClientRequire, aiClientModule, aiClientModule.exports);

const codexChatPath = path.join(__dirname, '..', 'electron', 'provider', 'openAICodexChat.ts');
const codexChatModule = { exports: {} };
const codexChatRequire = request => {
  if (request === './openAICodex') {
    return { openAICodexProviderId: 'openai-codex', getOpenAICodexModels: async () => ({}) };
  }
  if (request === './usage') {
    return { canonicalizeSplitProviderUsage: usage => usage };
  }
  return require(request);
};
new Function('require', 'module', 'exports', transpile(codexChatPath))(codexChatRequire, codexChatModule, codexChatModule.exports);

async function main() {
  const { AIClient, classifyError } = aiClientModule.exports;
  const { normalizeOpenAICodexChatError } = codexChatModule.exports;

  const usageLimitText = 'Codex error: The usage limit has been reached';
  const providerUsage = classifyError(undefined, usageLimitText, 'provider', false);
  assert.equal(providerUsage.retryable, false);
  assert.equal(providerUsage.category, 'usage_quota');
  assert.match(providerUsage.userMessage, /usage limit has been reached/);
  const quota429 = classifyError(429, JSON.stringify({ error: { message: 'You exceeded your current quota, please check billing.' } }), undefined, false);
  assert.equal(quota429.retryable, false);
  assert.equal(quota429.category, 'usage_quota');
  assert.match(quota429.userMessage, /current quota/);
  const transient429 = classifyError(429, JSON.stringify({ error: { message: 'Rate limit reached, try again later.' } }), undefined, false);
  assert.equal(transient429.retryable, true);
  assert.equal(transient429.category, 'rate_limit');
  assert.match(transient429.userMessage, /Rate limit reached/);
  const authAccount = classifyError(undefined, 'Codex error: account suspended', 'provider', false);
  assert.equal(authAccount.retryable, false);
  assert.equal(authAccount.category, 'auth');
  const windsurfUnauthenticated = classifyError(undefined, 'Windsurf trailer error', 'unauthenticated', false);
  assert.equal(windsurfUnauthenticated.retryable, false);
  assert.equal(windsurfUnauthenticated.category, 'auth');
  const windsurfPermissionDenied = classifyError(undefined, 'Windsurf trailer error', 'permission_denied', false);
  assert.equal(windsurfPermissionDenied.retryable, false);
  assert.equal(windsurfPermissionDenied.category, 'auth');
  const windsurfResourceExhausted = classifyError(undefined, 'Windsurf trailer error', 'resource_exhausted', false);
  assert.equal(windsurfResourceExhausted.retryable, false);
  assert.equal(windsurfResourceExhausted.category, 'usage_quota');
  const normalizedUsage = normalizeOpenAICodexChatError(new Error(usageLimitText));
  assert.equal(normalizedUsage.code, 'usage_quota');
  assert.match(normalizedUsage.message, /usage limit has been reached/);
  const normalizedAuth = normalizeOpenAICodexChatError(new Error('Codex error: account suspended'));
  assert.equal(normalizedAuth.code, 'authentication_failed');

  resetProviderState();
  const client = new AIClient({
    providerId: 'openai-codex',
    conversationId: 'retry-conversation',
    runId: 'retry-run',
    ownerId: 'retry-owner',
    requestKind: 'agent',
    vision: false,
    contextWindow: 272000,
    catalogGeneration: 'retry-catalog',
    compressionGeneration: '3',
    baseUrl: 'https://example.invalid',
    model: 'gpt-test',
    outputStrategy: 'off',
    stream: false,
  });
  const chunks = [];
  const requestTimestamp = 1788100000123;
  for await (const chunk of client.streamChat(
    [{ role: 'user', content: 'stable retry body' }],
    undefined,
    requestTimestamp,
  )) chunks.push(chunk);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestTimestamp, requests[1].requestTimestamp);
  assert.equal(requests[0].requestTimestamp, requestTimestamp);
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(Number.isFinite(requests[0].requestTimestamp), true);
  assert.ok(chunks.some(chunk => chunk.type === 'retry' && chunk.retry?.attempt === 1));
  assert.ok(chunks.some(chunk => chunk.type === 'content' && chunk.content === 'ok'));
  assert.ok(chunks.some(chunk => chunk.type === 'done'));

  const abortedClient = new AIClient({
    providerId: 'openai-codex',
    conversationId: 'abort-before-start-conversation',
    runId: 'abort-before-start-run',
    ownerId: 'abort-before-start-owner',
    requestKind: 'agent',
    vision: false,
    contextWindow: 272000,
    catalogGeneration: 'abort-before-start-catalog',
    compressionGeneration: '4',
    baseUrl: 'https://example.invalid',
    model: 'gpt-test',
    outputStrategy: 'off',
    stream: false,
  });
  clientToAbort = abortedClient;
  abortOnSubscribe = true;
  const abortedChunks = [];
  for await (const chunk of abortedClient.streamChat(
    [{ role: 'user', content: 'must not reach provider start' }],
    undefined,
    requestTimestamp + 1,
  )) abortedChunks.push(chunk);
  abortOnSubscribe = false;
  clientToAbort = null;

  assert.equal(requests.length, 2, 'abort before provider start must not send a request');
  assert.ok(abortedChunks.some(chunk => chunk.type === 'error' && chunk.error === 'aborted'));
  assert.equal(unsubscribeCount, 3, 'each provider subscription must be released exactly once');

  resetProviderState();
  startChatImpl = async (_request, requestMeta) => ({
    ok: false,
    status: 0,
    headers: { 'content-type': 'application/json' },
    streaming: false,
    error: { code: 'provider', message: usageLimitText },
    request: requestMeta,
  });
  const usageClient = new AIClient({
    providerId: 'openai-codex',
    conversationId: 'usage-terminal-conversation',
    runId: 'usage-terminal-run',
    ownerId: 'usage-terminal-owner',
    requestKind: 'agent',
    vision: false,
    contextWindow: 272000,
    catalogGeneration: 'usage-terminal-catalog',
    compressionGeneration: '5',
    baseUrl: 'https://example.invalid',
    model: 'gpt-test',
    outputStrategy: 'off',
    stream: false,
  });
  const usageChunks = [];
  for await (const chunk of usageClient.streamChat(
    [{ role: 'user', content: 'terminal usage limit must not retry' }],
    undefined,
    requestTimestamp + 2,
  )) usageChunks.push(chunk);
  assert.equal(requests.length, 1, 'usage/quota provider error must stop after one request');
  assert.equal(usageChunks.some(chunk => chunk.type === 'retry'), false);
  assert.ok(usageChunks.some(chunk => chunk.type === 'error' && /usage limit has been reached/.test(chunk.error)));

  resetProviderState();
  startChatImpl = async (request, requestMeta) => {
    queueMicrotask(() => {
      emitProviderEvent({
        requestId: request.requestId,
        type: 'error',
        code: 'usage_quota',
        message: 'usage_quota',
      });
    });
    return {
      ok: true,
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      streaming: true,
      request: requestMeta,
    };
  };
  const streamQuotaClient = new AIClient({
    providerId: 'openai-codex',
    conversationId: 'stream-quota-terminal-conversation',
    runId: 'stream-quota-terminal-run',
    ownerId: 'stream-quota-terminal-owner',
    requestKind: 'agent',
    vision: false,
    contextWindow: 272000,
    catalogGeneration: 'stream-quota-terminal-catalog',
    compressionGeneration: '5',
    baseUrl: 'https://example.invalid',
    model: 'gpt-test',
    outputStrategy: 'real',
    stream: true,
  });
  const streamQuotaChunks = [];
  for await (const chunk of streamQuotaClient.streamChat(
    [{ role: 'user', content: 'stream quota error must not retry' }],
    undefined,
    requestTimestamp + 21,
  )) streamQuotaChunks.push(chunk);
  assert.equal(requests.length, 1, 'stream usage_quota error code must stop after one request');
  assert.equal(streamQuotaChunks.some(chunk => chunk.type === 'retry'), false);
  assert.ok(streamQuotaChunks.some(chunk => chunk.type === 'error' && /usage_quota/.test(chunk.error)));

  resetProviderState();
  startChatImpl = async (_request, requestMeta) => {
    attempt += 1;
    if (attempt === 1) {
      return {
        ok: false,
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
        streaming: false,
        bodyText: JSON.stringify({ error: { message: 'Rate limit reached, try again later.' } }),
        request: requestMeta,
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      streaming: false,
      bodyText: JSON.stringify({
        choices: [{ message: { content: 'ok-after-429' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
      request: requestMeta,
    };
  };
  const rateLimitClient = new AIClient({
    providerId: 'openai-codex',
    conversationId: 'rate-limit-conversation',
    runId: 'rate-limit-run',
    ownerId: 'rate-limit-owner',
    requestKind: 'agent',
    vision: false,
    contextWindow: 272000,
    catalogGeneration: 'rate-limit-catalog',
    compressionGeneration: '6',
    baseUrl: 'https://example.invalid',
    model: 'gpt-test',
    outputStrategy: 'off',
    stream: false,
  });
  const rateLimitChunks = [];
  for await (const chunk of rateLimitClient.streamChat(
    [{ role: 'user', content: 'transient 429 should retry' }],
    undefined,
    requestTimestamp + 3,
  )) rateLimitChunks.push(chunk);
  assert.equal(requests.length, 2, 'transient 429 must retry once then succeed');
  assert.ok(rateLimitChunks.some(chunk => chunk.type === 'retry' && /Rate limit reached/.test(chunk.retry?.reason)));
  assert.ok(rateLimitChunks.some(chunk => chunk.type === 'content' && chunk.content === 'ok-after-429'));

  resetProviderState();
  startChatImpl = async (request, requestMeta) => {
    attempt += 1;
    if (attempt === 1) {
      queueMicrotask(() => {
        emitProviderEvent({ requestId: request.requestId, type: 'data', data: encodeSse({ choices: [{ delta: { content: 'half' }, finish_reason: null }] }) });
        setTimeout(() => emitProviderEvent({ requestId: request.requestId, type: 'error', message: 'socket hang up' }), 0);
      });
      return {
        ok: true,
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        streaming: true,
        request: requestMeta,
      };
    }
    queueMicrotask(() => {
      emitProviderEvent({ requestId: request.requestId, type: 'data', data: encodeSse({ choices: [{ delta: { content: 'full' }, finish_reason: null }] }) });
      emitProviderEvent({ requestId: request.requestId, type: 'data', data: encodeSse('[DONE]') });
    });
    return {
      ok: true,
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      streaming: true,
      request: requestMeta,
    };
  };
  const realStreamClient = new AIClient({
    providerId: 'openai-codex',
    conversationId: 'stream-reset-conversation',
    runId: 'stream-reset-run',
    ownerId: 'stream-reset-owner',
    requestKind: 'agent',
    vision: false,
    contextWindow: 272000,
    catalogGeneration: 'stream-reset-catalog',
    compressionGeneration: '7',
    baseUrl: 'https://example.invalid',
    model: 'gpt-test',
    outputStrategy: 'real',
    stream: true,
  });
  const streamChunks = [];
  for await (const chunk of realStreamClient.streamChat(
    [{ role: 'user', content: 'stream interruption resets partial output' }],
    undefined,
    requestTimestamp + 4,
  )) streamChunks.push(chunk);
  assert.equal(requests.length, 2, 'stream disconnect must retry once then succeed');
  assert.ok(streamChunks.some(chunk => chunk.type === 'content' && chunk.content === 'half'));
  assert.ok(streamChunks.some(chunk => chunk.type === 'retry' && chunk.resetContent === true));
  assert.ok(streamChunks.some(chunk => chunk.type === 'content' && chunk.content === 'full'));
  assert.ok(streamChunks.some(chunk => chunk.type === 'done'));
  const aiClientSource = fs.readFileSync(aiClientPath, 'utf8');
  const agentLoopSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentLoop.ts'), 'utf8');
  const conversationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'store', 'slices', 'conversation.ts'), 'utf8');
  assert.match(aiClientSource, /attempt:\s*maxRetries[\s\S]{0,160}已达重连上限/);
  assert.doesNotMatch(aiClientSource, /attempt:\s*retries[\s\S]{0,160}连接中断，重置后改用伪流式重发/);
  assert.match(agentLoopSource, /if \(chunk\.resetContent\)[\s\S]{0,700}resetRunStreamEvents\(\{/);
  assert.match(conversationSource, /resetRunStreamEvents[\s\S]{0,700}content_delta[\s\S]{0,120}thinking_delta/);
  console.log('AI client retry integration: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
