const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rendererRoots = [path.join(root, 'src')];
const rendererExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const forbidden = [
  { label: 'Redux plaintext apiKeys', pattern: /\b(?:state\.settings|settings)\.apiKeys\b/ },
  { label: 'renderer Authorization header', pattern: /['"]Authorization['"]\s*:\s*`?Bearer/i },
  { label: 'legacy getAPIKey bridge', pattern: /\bgetAPIKey\b/ },
  { label: 'legacy setAPIKey bridge', pattern: /\bsetAPIKey\b/ },
];

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-electron') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (rendererExtensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

const violations = [];
for (const filePath of rendererRoots.flatMap(listFiles)) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) {
      violations.push(`${rule.label}: ${path.relative(root, filePath)}`);
    }
  }
}

assert.deepEqual(violations, [], `Renderer secret boundary violations:\n${violations.join('\n')}`);

const preload = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
assert.doesNotMatch(preload, /\bgetAPIKey\b|\bsetAPIKey\b/);
assert.match(preload, /credentialStatus/);
assert.match(preload, /setApiKey/);
assert.doesNotMatch(preload, /fetchModels:\s*\(providerId:\s*string,\s*baseUrl/);

const providerIpc = fs.readFileSync(path.join(root, 'electron', 'ipc', 'provider.ts'), 'utf8');
assert.doesNotMatch(providerIpc, /request\.baseUrl/);
assert.match(providerIpc, /getProviderBaseUrl/);

const configIpc = fs.readFileSync(path.join(root, 'electron', 'ipc', 'config.ts'), 'utf8');
assert.match(configIpc, /apiKeys/);
assert.match(configIpc, /key\.startsWith\('providerCredential'\)/);

const store = fs.readFileSync(path.join(root, 'src', 'store', 'index.ts'), 'utf8');
assert.match(store, /legacyApiKeySourceForMigration/);
assert.match(store, /apiKeys:\s*legacyApiKeySourceForMigration/);
assert.match(store, /clearLegacyApiKeysAfterMigration/);
assert.doesNotMatch(store, /state\.settings\.apiKeys|settings\.apiKeys/);

const providerCredentials = fs.readFileSync(path.join(root, 'src', 'services', 'providerCredentials.ts'), 'utf8');
assert.match(providerCredentials, /result\.value\.configured\s*&&\s*result\.value\.persisted/);

const fileIpc = fs.readFileSync(path.join(root, 'electron', 'ipc', 'file.ts'), 'utf8');
const approvalPolicyStart = fileIpc.indexOf("ipcMain.handle('file:setApprovalPolicy'");
const approvalPolicyEnd = fileIpc.indexOf("ipcMain.handle('file:prepareAccessGrant'", approvalPolicyStart);
const approvalPolicy = fileIpc.slice(approvalPolicyStart, approvalPolicyEnd);
assert.match(approvalPolicy, /confirmSensitiveOperationInMainWindow/);
assert.match(approvalPolicy, /approvalId: 'file-policy:auto-write'/);
assert.ok(
  approvalPolicy.indexOf('confirmSensitiveOperationInMainWindow') < approvalPolicy.indexOf('fileApprovalPolicies.set'),
  'renderer-requested auto-approve policy must require main-process confirmation before activation',
);

console.log('Secret boundary static check: all assertions passed');
