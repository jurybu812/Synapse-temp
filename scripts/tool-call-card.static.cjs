const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'chat', 'ToolCallCard.tsx'),
  'utf8',
);
const messageBubbleSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'chat', 'MessageBubble.tsx'),
  'utf8',
);
const sensitiveRedactionPath = path.join(__dirname, '..', 'src', 'services', 'sensitiveRedaction.ts');

function compileTypeScript(sourcePath) {
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: sourcePath,
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const { redactSensitiveText, redactSensitiveValue } = compileTypeScript(sensitiveRedactionPath);

assert.match(source, /function compactToolArgument\(value: unknown, limit = 160\)/);
assert.match(source, /text\.slice\(0, limit - tailLength - 1\).*text\.slice\(-tailLength\)/s);
assert.match(source, /title=\{searchResponse \? String\(displayArgs\.query \|\| ''\) : argumentsTitle\}/);
assert.match(source, /redactSensitiveValue\(parsedArgs\)/);
assert.match(source, /const resultText = redactSensitiveText\(toolCall\.result \|\| ''\)/);
assert.match(source, /JSON\.stringify\(displayArgs, null, 2\)/);
assert.match(source, /\{argumentsPreview\}/);
assert.match(source, /const INITIAL_TOOL_ARTIFACT_WINDOW = 12;/);
assert.match(source, /const TOOL_ARTIFACT_WINDOW_INCREMENT = 12;/);
assert.match(source, /const visibleArtifacts = \(toolCall\.artifacts \?\? \[\]\)\.slice\(0, artifactLimit\);/);
assert.match(messageBubbleSource, /const INITIAL_TOOL_CALL_WINDOW = 20;/);
assert.match(messageBubbleSource, /const TOOL_CALL_WINDOW_INCREMENT = 20;/);
assert.match(messageBubbleSource, /function shouldPinToolCall\(toolCall: ToolCallInfo\): boolean/);
assert.match(messageBubbleSource, /index >= earliestRevealedIndex \|\| shouldPinToolCall\(toolCall\)/);
assert.match(messageBubbleSource, /跳回最新/);
assert.doesNotMatch(source, /v\.slice\(0, 20\)/);
assert.doesNotMatch(source, /compactToolArgument\(value, 4000\)/);

function extractFunction(sourceText, name) {
  const marker = `function ${name}`;
  const start = sourceText.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);

  const bodyStart = sourceText.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return sourceText.slice(start, index + 1);
  }

  assert.fail(`unterminated function ${name}`);
}

function toRunnableJavaScript(text) {
  return text
    .replace(/: Record<string, any>/g, '')
    .replace(/: Array<\[string, any\]>/g, '')
    .replace(/: ToolCallInfo\[\] \| undefined/g, '')
    .replace(/: ToolCallInfo/g, '')
    .replace(/\): boolean/g, ')')
    .replace(/: unknown/g, '')
    .replace(/: number/g, '')
    .replace(/: string/g, '');
}

const helperSource = [
  'stringifyToolArgument',
  'compactToolArgument',
  'orderedToolArgumentEntries',
  'formatToolArgumentsPreview',
  'formatToolArgumentsTitle',
].map(entry => entry.startsWith('const ') ? entry : extractFunction(source, entry)).join('\n');

const helpers = new Function(`
${toRunnableJavaScript(helperSource)}
return {
  compactToolArgument,
  orderedToolArgumentEntries,
  formatToolArgumentsPreview,
  formatToolArgumentsTitle,
};
`)();

assert.deepEqual(
  helpers.orderedToolArgumentEntries({
    cwd: 'C:/repo',
    command: 'npm test',
    timeout: 30000,
  }, 'run_command').map(([key]) => key),
  ['command', 'cwd', 'timeout'],
  'run_command summary should show command before cwd regardless of JSON key order',
);

assert.deepEqual(
  helpers.orderedToolArgumentEntries({
    timeout: 30000,
    env: { CI: '1' },
    command: 'node scripts/tool-call-card.static.cjs',
    cwd: 'C:/repo',
  }, 'run_command').map(([key]) => key),
  ['command', 'cwd', 'timeout', 'env'],
  'run_command summary should find command even when it is not in the first two arguments',
);

assert.deepEqual(
  helpers.orderedToolArgumentEntries({
    first: 1,
    command: 'leave existing behavior alone',
    cwd: 'C:/repo',
  }, 'search_web').map(([key]) => key),
  ['first', 'command'],
  'other tools should keep the existing first-two preview behavior',
);

const longCommand = `powershell -NoProfile -Command "${'Write-Output alpha; '.repeat(12)}Write-Output omega"`;
const runCommandEntries = helpers.orderedToolArgumentEntries({
  timeout: 30000,
  env: 'test',
  command: longCommand,
  cwd: 'C:/repo',
}, 'run_command');
const preview = helpers.formatToolArgumentsPreview(runCommandEntries);
const title = helpers.formatToolArgumentsTitle(runCommandEntries);

assert.match(preview, /^command=powershell -NoProfile -Command/);
assert.match(preview, /…/);
assert.ok(preview.includes('Write-Output omega"'), 'collapsed long command should keep a recognizable non-sensitive tail');
assert.ok(preview.indexOf('cwd=') > preview.indexOf('command='), 'cwd should follow command');
assert.ok(preview.indexOf('timeout=') > preview.indexOf('cwd='), 'other arguments should follow cwd');
assert.match(title, /^command=powershell -NoProfile -Command/);
assert.ok(title.length <= 420, 'title should remain bounded');

const sensitiveFixtureValue = ['redaction', 'fixture', 'value'].join('-');
const bearerHeader = ['Authorization:', ['Bearer', sensitiveFixtureValue].join(' ')].join(' ');
const accessTokenQuery = `${['access', 'token'].join('_')}=${sensitiveFixtureValue}`;
const apiKeyAssignment = `${['OPENAI', 'API', 'KEY'].join('_')}=${['sk', 'proj', 'fixture', 'value'].join('-')}`;
const secretCommand = `curl -H "${bearerHeader}" https://example.test?${accessTokenQuery} ${apiKeyAssignment}`;
const redactedArgs = redactSensitiveValue({
  command: secretCommand,
  cwd: 'C:/repo',
  env: {
    [['API', 'KEY'].join('_')]: sensitiveFixtureValue,
    nested: { [['refresh', 'token'].join('_')]: sensitiveFixtureValue },
  },
});
const redactedEntries = helpers.orderedToolArgumentEntries(redactedArgs, 'run_command');
const redactedPreview = helpers.formatToolArgumentsPreview(redactedEntries);
const redactedTitle = helpers.formatToolArgumentsTitle(redactedEntries);
const redactedExpanded = JSON.stringify(redactedArgs);
for (const visibleText of [redactedPreview, redactedTitle, redactedExpanded]) {
  assert.doesNotMatch(visibleText, /redaction-fixture-value|sk-proj-fixture-value/);
  assert.match(visibleText, /\[redacted\]/);
}

const redactedResult = redactSensitiveText(`${bearerHeader} ${apiKeyAssignment}`);
assert.doesNotMatch(redactedResult, /redaction-fixture-value|sk-proj-fixture-value/);
assert.match(redactedResult, /\[redacted\]/);

const messageHelpers = new Function(`
const INITIAL_TOOL_CALL_WINDOW = 20;
${toRunnableJavaScript(extractFunction(messageBubbleSource, 'shouldPinToolCall'))}
${toRunnableJavaScript(extractFunction(messageBubbleSource, 'buildToolCallWindow'))}
return { shouldPinToolCall, buildToolCallWindow };
`)();

const manyToolCalls = Array.from({ length: 35 }, (_, index) => ({
  id: `tool-${index}`,
  status: 'success',
}));
manyToolCalls[2] = { id: 'old-running', status: 'running' };
manyToolCalls[5] = { id: 'old-error', status: 'error' };
manyToolCalls[7] = { id: 'old-cancelled', status: 'cancelled' };

const defaultWindow = messageHelpers.buildToolCallWindow(manyToolCalls, 0);
assert.equal(defaultWindow.total, 35);
assert.equal(defaultWindow.hiddenCount, 13);
assert.deepEqual(
  defaultWindow.entries.map(entry => entry.toolCall.id),
  ['old-running', 'old-error', ...manyToolCalls.slice(15).map(toolCall => toolCall.id)],
  'default tool window should keep the latest 20 and pin only active, failed, or uncertain older calls',
);

const expandedWindow = messageHelpers.buildToolCallWindow(manyToolCalls, 20);
assert.equal(expandedWindow.hiddenCount, 0);
assert.equal(expandedWindow.entries.length, 35);
assert.equal(messageHelpers.shouldPinToolCall({ id: 'ok', status: 'success' }), false);
assert.equal(messageHelpers.shouldPinToolCall({ id: 'cancelled', status: 'cancelled' }), false);
assert.equal(messageHelpers.shouldPinToolCall({ id: 'cancelled-uncertain', status: 'cancelled', unknownSideEffect: true }), true);
assert.equal(messageHelpers.shouldPinToolCall({ id: 'unknown', status: 'unknown' }), true);

console.log('Tool call card static: all assertions passed');
