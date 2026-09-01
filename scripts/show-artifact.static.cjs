const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const registry = fs.readFileSync(path.join(root, 'src', 'services', 'toolRegistry.ts'), 'utf8');
const fileSystem = fs.readFileSync(path.join(root, 'src', 'services', 'fileSystem.ts'), 'utf8');
const start = registry.indexOf("name: 'show_artifact'");
const end = registry.indexOf("toolRegistry.register({", start + 1);
assert.ok(start >= 0 && end > start, 'show_artifact handler must exist');
const showArtifact = registry.slice(start, end);

assert.match(showArtifact, /fileSystem\.exists\(/, 'show_artifact must use a metadata-only existence check');
assert.doesNotMatch(showArtifact, /fileSystem\.readFile\(/, 'show_artifact must not read whole artifacts into renderer memory');
assert.match(fileSystem, /async exists\([\s\S]*window\.synapse\.file\.exists/, 'fileSystem.exists must preserve Electron access enforcement');
assert.match(registry, /memory_write[\s\S]*?\}, 'custom', 'write', 'write'\);/, 'memory_write must follow the write approval policy');

console.log('show_artifact static assertions passed');
