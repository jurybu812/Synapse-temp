const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function compileTypeScript(sourcePath, dependencies = {}) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: sourcePath,
  });
  const runtimeModule = { exports: {} };
  const localRequire = request => {
    if (Object.prototype.hasOwnProperty.call(dependencies, request)) return dependencies[request];
    return require(request);
  };
  new Function('require', 'module', 'exports', compiled.outputText)(localRequire, runtimeModule, runtimeModule.exports);
  return runtimeModule.exports;
}

const root = path.join(__dirname, '..');
const reviewCore = compileTypeScript(path.join(root, 'src', 'services', 'diffReviewCore.ts'));
const fileIpcSource = fs.readFileSync(path.join(root, 'electron', 'ipc', 'file.ts'), 'utf8');
const richInputSource = fs.readFileSync(path.join(root, 'src', 'components', 'chat', 'RichTextInput.tsx'), 'utf8');
const unsavedChangesSource = fs.readFileSync(path.join(root, 'src', 'services', 'unsavedChanges.ts'), 'utf8');

class FileWriteConflictError extends Error {}

async function run() {
  let diskContent = '';
  let forceRaceContent = null;
  const notices = [];
  const fileSystem = {
    async readFile() {
      return diskContent;
    },
    async writeFile(_filePath, content, _contextId, _conversationId, _access, options) {
      if (forceRaceContent !== null) {
        diskContent = forceRaceContent;
        forceRaceContent = null;
        throw new FileWriteConflictError('race');
      }
      if (options?.expectedContent !== diskContent) throw new FileWriteConflictError('changed');
      diskContent = content;
    },
  };
  const { saveEditorFileWithConflictProtection } = compileTypeScript(
    path.join(root, 'src', 'services', 'editorFileSave.ts'),
    {
      './diffReviewCore': reviewCore,
      './fileSystem': { fileSystem, FileWriteConflictError },
      './confirmationCoordinator': { showNotice: async options => { notices.push(options); } },
    },
  );

  diskContent = ['alpha', 'base', 'omega'].join('\n');
  let result = await saveEditorFileWithConflictProtection(
    'file.txt',
    'file.txt',
    ['alpha', 'user-value', 'omega'].join('\n'),
    ['alpha', 'base', 'omega'].join('\n'),
  );
  assert.equal(result.merged, false);
  assert.equal(diskContent, ['alpha', 'user-value', 'omega'].join('\n'));

  diskContent = ['alpha', 'base', 'omega', 'agent-tail'].join('\n');
  result = await saveEditorFileWithConflictProtection(
    'file.txt',
    'file.txt',
    ['alpha', 'user-value', 'omega'].join('\n'),
    ['alpha', 'base', 'omega'].join('\n'),
  );
  assert.equal(result.merged, true);
  assert.equal(diskContent, ['alpha', 'user-value', 'omega', 'agent-tail'].join('\n'));

  diskContent = ['alpha', 'agent-value', 'omega'].join('\n');
  await assert.rejects(
    saveEditorFileWithConflictProtection(
      'file.txt',
      'file.txt',
      ['alpha', 'user-value', 'omega'].join('\n'),
      ['alpha', 'base', 'omega'].join('\n'),
    ),
    /同一区域发生冲突/,
  );
  assert.equal(diskContent, ['alpha', 'agent-value', 'omega'].join('\n'));
  assert.equal(notices.at(-1).title, '保存冲突');

  diskContent = ['alpha', 'base', 'omega', 'agent-one'].join('\n');
  forceRaceContent = ['alpha', 'base', 'omega', 'agent-two'].join('\n');
  result = await saveEditorFileWithConflictProtection(
    'file.txt',
    'file.txt',
    ['alpha', 'user-value', 'omega'].join('\n'),
    ['alpha', 'base', 'omega'].join('\n'),
  );
  assert.equal(result.merged, true);
  assert.equal(diskContent, ['alpha', 'user-value', 'omega', 'agent-two'].join('\n'));

  assert.match(fileIpcSource, /options\?: \{ expectedContent\?: string \}/);
  assert.match(fileIpcSource, /currentContent !== options\.expectedContent/);
  assert.match(fileIpcSource, /conflict: true/);
  assert.match(richInputSource, /tabIndex=\{disabled \? -1 : 0\}/);
  assert.match(richInputSource, /aria-label=\{ariaLabel\}/);
  assert.match(unsavedChangesSource, /saveEditorFileWithConflictProtection\(/);
  assert.doesNotMatch(unsavedChangesSource, /fileSystem\.writeFile\(/);

  console.log('Editor save conflict integration assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
