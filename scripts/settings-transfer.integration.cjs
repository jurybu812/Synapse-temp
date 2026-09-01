const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'services', 'settingsTransfer.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
  fileName: sourcePath,
});
const runtimeModule = { exports: {} };
new Function('module', 'exports', compiled.outputText)(runtimeModule, runtimeModule.exports);
const { isSensitiveSettingsKey, sanitizeSettingsMap, sanitizeSettingsValue } = runtimeModule.exports;

const legacy = {
  synapse_settings: {
    language: 'zh-CN',
    apiKeys: { openai: 'legacy-secret' },
    nested: { apiKey: 'nested-secret', safe: true },
    providerCredentials: { openai: { configured: true, persisted: true } },
  },
  'synapse:config:providerCredential:openai': 'ciphertext-or-secret',
  synapse_theme: { wallpaper: 'data:image/png;base64,secret-image', accent: '#fff' },
};

const cleaned = sanitizeSettingsMap(legacy);
assert.equal(JSON.stringify(cleaned).includes('legacy-secret'), false);
assert.equal(JSON.stringify(cleaned).includes('nested-secret'), false);
assert.equal(JSON.stringify(cleaned).includes('ciphertext-or-secret'), false);
assert.equal(cleaned.synapse_settings.language, 'zh-CN');
assert.equal('providerCredentials' in cleaned.synapse_settings, false);
assert.equal(cleaned.synapse_theme.wallpaper, '[wallpaper-data-url-omitted]');

const imported = sanitizeSettingsValue({ apiKeys: { openai: 'secret' }, safe: 1 });
assert.deepEqual(imported, { safe: 1 });
assert.equal(isSensitiveSettingsKey('synapse:config:providerCredential:openai'), true);
assert.equal(isSensitiveSettingsKey('synapse_theme'), false);

console.log('Settings transfer integration: all assertions passed');
