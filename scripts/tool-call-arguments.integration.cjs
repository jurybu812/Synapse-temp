const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'services', 'toolCallArguments.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
  fileName: sourcePath,
});
const runtimeModule = { exports: {} };
new Function('module', 'exports', compiled.outputText)(runtimeModule, runtimeModule.exports);
const { normalizeToolCallArguments, parseToolCallArguments } = runtimeModule.exports;

assert.equal(normalizeToolCallArguments(undefined), '{}');
assert.equal(normalizeToolCallArguments(''), '{}');
assert.equal(normalizeToolCallArguments('   '), '{}');
assert.equal(normalizeToolCallArguments('{"query":"planner"}'), '{"query":"planner"}');
assert.deepEqual(parseToolCallArguments(undefined), {});
assert.deepEqual(parseToolCallArguments(null), {});
assert.deepEqual(parseToolCallArguments(''), {});
assert.deepEqual(parseToolCallArguments('   '), {});
assert.deepEqual(parseToolCallArguments('{}'), {});
assert.deepEqual(parseToolCallArguments('{"query":"planner"}'), { query: 'planner' });
assert.throws(() => parseToolCallArguments('{'), SyntaxError);
assert.throws(() => parseToolCallArguments('null'), SyntaxError);
assert.throws(() => parseToolCallArguments('[]'), SyntaxError);

console.log('Tool call arguments integration: empty arguments normalize to an object');
