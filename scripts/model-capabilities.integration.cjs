const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'services', 'modelCapabilities.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('require', 'module', 'exports', output)(require, moduleUnderTest, moduleUnderTest.exports);
const { inferModelCapabilities, normalizeModelOption } = moduleUnderTest.exports;

const runtimePath = path.join(__dirname, '..', 'src', 'services', 'providerModelRuntime.ts');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
const runtimeOutput = ts.transpileModule(runtimeSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: runtimePath,
}).outputText;
const runtimeModule = { exports: {} };
const runtimeRequire = request => request === './modelCapabilities' ? moduleUnderTest.exports : require(request);
new Function('require', 'module', 'exports', runtimeOutput)(runtimeRequire, runtimeModule, runtimeModule.exports);
const { capabilityBoundClientOptions, resolveProviderModel } = runtimeModule.exports;

const unknown = inferModelCapabilities('gpt-99-vision-ultra', { id: 'gpt-99-vision-ultra' });
assert.equal(unknown.source, 'unknown');
assert.equal(unknown.vision, false);
assert.equal(unknown.tools, false);
assert.equal(unknown.thinking, false);
assert.equal(unknown.streaming, false);
assert.equal(unknown.contextWindow, undefined);
assert.deepEqual(unknown.reasoningEffortOptions, ['auto']);
assert.deepEqual(unknown.speedTierOptions, ['auto']);

const api = inferModelCapabilities('anything', {
  input_modalities: ['text'],
  supported_parameters: ['stream', 'max_completion_tokens'],
  context_window: 32768,
});
assert.equal(api.vision, false);
assert.equal(api.streaming, true);
assert.equal(api.tools, false);
assert.equal(api.contextWindow, 32768);
assert.equal(api.authority.vision, 'api');
assert.equal(api.authority.tools, 'unknown');

const mixed = normalizeModelOption({
  id: 'codex-real',
  provider_id: 'openai-codex',
  input_modalities: ['text', 'image'],
  context_window: 272000,
  supported_reasoning_levels: [{ effort: 'minimal' }, { effort: 'xhigh' }],
  additional_speed_tiers: ['priority'],
  capabilities: { vision: true, tools: true, thinking: true, streaming: true },
  capability_authority: {
    vision: 'api', tools: 'protocol', thinking: 'api', streaming: 'protocol',
    contextWindow: 'api', maxOutputTokens: 'unknown', reasoningEffortOptions: 'api', speedTierOptions: 'api',
  },
});
assert.ok(mixed);
assert.equal(mixed.id, 'openai-codex:codex-real');
assert.equal(mixed.capabilities.source, 'mixed');
assert.equal(mixed.capabilities.vision, true);
assert.deepEqual(mixed.capabilities.reasoningEffortOptions, ['auto', 'minimal', 'xhigh']);
assert.deepEqual(mixed.capabilities.speedTierOptions, ['auto', 'fast']);

const persisted = normalizeModelOption({
  id: 'openai-codex:persisted-model',
  providerId: 'openai-codex',
  requestModelId: 'persisted-model',
  name: 'Persisted Model',
  capabilities: {
    vision: true,
    tools: true,
    thinking: true,
    reasoning: true,
    streaming: true,
    contextWindow: 196000,
    maxOutputTokens: 32000,
    reasoningEffortOptions: ['auto', 'xhigh'],
    speedTierOptions: ['auto', 'fast'],
    supportedParameters: ['stream', 'tools'],
    source: 'mixed',
    authority: {
      vision: 'api', tools: 'protocol', thinking: 'api', streaming: 'protocol',
      contextWindow: 'api', maxOutputTokens: 'protocol', reasoningEffortOptions: 'api', speedTierOptions: 'api',
    },
  },
});
assert.ok(persisted);
assert.equal(persisted.capabilities.vision, true);
assert.equal(persisted.capabilities.streaming, true);
assert.equal(persisted.capabilities.contextWindow, 196000);
assert.equal(persisted.capabilities.authority.tools, 'protocol');

const legacyQualified = normalizeModelOption({
  id: 'openai-codex:legacy-gpt',
  name: 'Legacy GPT',
});
assert.equal(legacyQualified.providerId, 'openai-codex');
assert.equal(legacyQualified.requestModelId, 'legacy-gpt');
assert.equal(legacyQualified.id, 'openai-codex:legacy-gpt');
const pollutedLegacy = normalizeModelOption({
  id: 'windsurf:legacy-glm',
  providerId: 'openai',
  requestModelId: 'windsurf:legacy-glm',
});
assert.equal(pollutedLegacy.providerId, 'windsurf');
assert.equal(pollutedLegacy.requestModelId, 'legacy-glm');
const legacyRuntime = resolveProviderModel(
  legacyQualified.id,
  [legacyQualified],
  { 'openai-codex': { configured: true }, openai: { configured: true } },
  { openai: 'https://api.example.test/v1' },
);
assert.equal(legacyRuntime.providerId, 'openai-codex');
assert.equal(legacyRuntime.modelId, 'legacy-gpt');
assert.equal(legacyRuntime.ready, true);

const staleCatalogRuntime = resolveProviderModel(
  legacyQualified.id,
  [{ ...legacyQualified, catalog: {
    providerId: 'openai-codex', generation: 'persisted:openai-codex', fetchedAt: 0,
    source: 'stale', stale: true, endpointSha256: '',
  } }],
  { 'openai-codex': { configured: true } },
  { openai: 'https://api.example.test/v1' },
);
assert.equal(staleCatalogRuntime.selectionAvailable, true);
assert.equal(staleCatalogRuntime.credentialConfigured, true);
assert.equal(staleCatalogRuntime.ready, false);

const accountBoundRuntime = resolveProviderModel(
  legacyQualified.id,
  [{ ...legacyQualified, catalog: {
    providerId: 'openai-codex', generation: 'catalog-current', fetchedAt: Date.now(),
    source: 'network', stale: false, endpointSha256: 'endpoint',
    accountFingerprint: 'account-a', credentialGeneration: 3,
  } }],
  { 'openai-codex': { configured: true, accountFingerprint: 'account-a', credentialGeneration: 3 } },
  { openai: 'https://api.example.test/v1' },
);
assert.equal(accountBoundRuntime.ready, true);
assert.equal(resolveProviderModel(
  legacyQualified.id,
  [accountBoundRuntime.option],
  { 'openai-codex': { configured: true, accountFingerprint: 'account-b', credentialGeneration: 4 } },
  { openai: 'https://api.example.test/v1' },
).ready, false);

const staleWindsurf = resolveProviderModel(
  'windsurf:removed-model',
  [],
  { windsurf: { configured: true }, openai: { configured: true } },
  { openai: 'https://api.example.test/v1' },
);
assert.equal(staleWindsurf.providerId, 'windsurf');
assert.equal(staleWindsurf.credentialConfigured, true);
assert.equal(staleWindsurf.selectionAvailable, false);
assert.equal(staleWindsurf.ready, false);
assert.equal(staleWindsurf.configured, false);

const completionOnly = normalizeModelOption({
  id: 'completion-only',
  supported_parameters: ['max_completion_tokens'],
  max_output_tokens: 2048,
});
const completionRuntime = resolveProviderModel(
  completionOnly.id,
  [completionOnly],
  { openai: { configured: true } },
  { openai: 'https://api.example.test/v1' },
);
const completionOptions = capabilityBoundClientOptions(completionRuntime, { maxTokens: 4096, stream: true });
assert.equal(completionOptions.maxTokenParameter, 'max_completion_tokens');
assert.equal(completionOptions.maxTokens, 2048);
assert.equal(completionOptions.stream, false);
assert.equal(completionOptions.tools, false);

console.log('Model capability integration: all assertions passed');
