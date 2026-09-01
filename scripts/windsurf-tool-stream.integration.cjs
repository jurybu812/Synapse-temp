const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function compileTypeScript(sourcePath, dependencies) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: sourcePath,
  });
  const runtimeModule = { exports: {} };
  const localRequire = request => Object.prototype.hasOwnProperty.call(dependencies, request)
    ? dependencies[request]
    : require(request);
  new Function('module', 'exports', 'require', compiled.outputText)(runtimeModule, runtimeModule.exports, localRequire);
  return runtimeModule.exports;
}

async function* events() {
  yield { kind: 'tool_call_start', id: 'call-search', name: 'search_files' };
  yield { kind: 'tool_call_start', id: 'call-search', name: 'search_files' };
  yield { kind: 'tool_call_args', argsDelta: '{"query":"maxToolRounds"}' };
  yield { kind: 'tool_call_start', id: 'call-read', name: 'view_file' };
  yield { kind: 'tool_call_args', argsDelta: '{"path":"src/services/agentLoop.ts"}' };
  yield { kind: 'finish', reason: 'tool_calls' };
}

let iteratorReturnCount = 0;

function trackedEvents() {
  const iterator = events();
  return {
    next: (...args) => iterator.next(...args),
    return: (...args) => {
      iteratorReturnCount += 1;
      return iterator.return(...args);
    },
    [Symbol.asyncIterator]() { return this; },
  };
}

async function main() {
  const sourcePath = path.join(__dirname, '..', 'electron', 'provider', 'windsurfChat.ts');
  const module = compileTypeScript(sourcePath, {
    './credentialStore': { getProviderCredential: () => ({ apiKey: 'test', apiServerUrl: 'https://example.invalid' }) },
    './windsurf': {
      importLegacyWindsurfCredential: async () => {},
      validateWindsurfCredential: value => value,
      windsurfCredentialKind: 'browser-oauth',
      windsurfProviderId: 'windsurf',
    },
    './windsurfUpstream': {
      loadWindsurfUpstream: async () => ({
        allocateCascadeId: () => 'cascade-test',
        streamChatEvents: () => trackedEvents(),
      }),
    },
    './usage': { canonicalizeSplitProviderUsage: () => null },
  });
  const chunks = [];
  let doneResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  const errors = [];
  await module.startWindsurfChat({
    body: { model: 'glm-5-2', messages: [{ role: 'user', content: 'inspect' }], tools: [] },
    conversationId: 'tool-stream-test',
    signal: new AbortController().signal,
    stream: true,
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    onRequestPrepared() {},
    onData(data) { chunks.push(data); },
    onDone() { doneResolve(); },
    onError(code, message) { errors.push(`${code}:${message}`); doneResolve(); },
    onSettled() {},
  });
  await done;
  assert.deepEqual(errors, []);
  const calls = chunks.flatMap(chunk => {
    const line = chunk.split('\n').find(value => value.startsWith('data: '));
    if (!line || line === 'data: [DONE]') return [];
    return JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls ?? [];
  });
  assert.deepEqual(calls.map(call => call.index), [0, 0, 1, 1]);
  assert.deepEqual(calls.filter(call => call.function?.name).map(call => call.function.name), ['search_files', 'view_file']);
  assert.deepEqual(calls.filter(call => call.function?.arguments).map(call => call.function.arguments), [
    '{"query":"maxToolRounds"}',
    '{"path":"src/services/agentLoop.ts"}',
  ]);
  assert.equal(iteratorReturnCount, 1, 'streaming Windsurf request must close its upstream iterator');
  const nonstream = await module.startWindsurfChat({
    body: { model: 'glm-5-2', messages: [{ role: 'user', content: 'inspect nonstream' }], tools: [] },
    conversationId: 'tool-nonstream-test',
    signal: new AbortController().signal,
    stream: false,
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    onRequestPrepared() {},
    onData() {},
    onDone() {},
    onError() {},
    onSettled() {},
  });
  assert.equal(nonstream.streaming, false);
  assert.equal(iteratorReturnCount, 2, 'nonstream Windsurf request must close its upstream iterator');
  console.log('Windsurf tool stream integration: distinct tool calls kept separate');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
