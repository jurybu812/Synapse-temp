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
  const localRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, request)) return dependencies[request];
    return require(request);
  };
  new Function('module', 'exports', 'require', compiled.outputText)(
    runtimeModule,
    runtimeModule.exports,
    localRequire,
  );
  return runtimeModule.exports;
}

const servicesDir = path.join(__dirname, '..', 'src', 'services');
const roundBoundary = compileTypeScript(path.join(servicesDir, 'roundBoundary.ts'));
const roundTruncation = compileTypeScript(
  path.join(servicesDir, 'roundTruncation.ts'),
  {
    './roundBoundary': roundBoundary,
    './recordStore': {
      clampToBatch() {
        throw new Error('clampToBatch is outside this pure truncation test');
      },
    },
  },
);

const { computeRoundTruncation } = roundTruncation;
const messages = [
  { id: 'u1', role: 'user' },
  { id: 'a1-call', role: 'assistant' },
  { id: 't1', role: 'tool' },
  { id: 'a1-final', role: 'assistant' },
  { id: 'u2', role: 'user' },
  { id: 'a2-call', role: 'assistant' },
  { id: 't2', role: 'tool' },
  { id: 'a2-final', role: 'assistant' },
  { id: 'u3', role: 'user' },
  { id: 'a3-call', role: 'assistant' },
  { id: 't3', role: 'tool' },
  { id: 'a3-final', role: 'assistant' },
];

function ids(items) {
  return items.map(item => item.id);
}

{
  const result = computeRoundTruncation(messages, 'u3', 'undo');
  assert.equal(result.ok, true);
  assert.equal(result.anchorRound, 3);
  assert.equal(result.lastKeptMessageId, 'a2-final');
  assert.equal(result.keptRounds, 2);
  assert.equal(result.keptSteps, 6);
  assert.equal(result.pendingUserMessage.id, 'u3');
  assert.deepEqual(ids(result.removedMessages), ['u3', 'a3-call', 't3', 'a3-final']);
}

for (const anchorId of ['a2-call', 't2', 'a2-final']) {
  const result = computeRoundTruncation(messages, anchorId, 'branch');
  assert.equal(result.ok, true);
  assert.equal(result.anchorRound, 2);
  assert.equal(result.lastKeptMessageId, 'a2-final');
  assert.equal(result.keptRounds, 2);
  assert.equal(result.keptSteps, 6);
  assert.equal(result.pendingUserMessage, null);
  assert.deepEqual(ids(result.removedMessages), ['u3', 'a3-call', 't3', 'a3-final']);
}

{
  const result = computeRoundTruncation(messages, 'u3', 'branch');
  assert.equal(result.ok, true);
  assert.equal(result.lastKeptMessageId, 'a2-final');
  assert.equal(result.pendingUserMessage.id, 'u3');
  assert.deepEqual(ids(result.removedMessages), ['u3', 'a3-call', 't3', 'a3-final']);
}

{
  const result = computeRoundTruncation(messages, 'u2', 'before-user');
  assert.equal(result.ok, true);
  assert.equal(result.lastKeptMessageId, 'u2');
  assert.equal(result.keptRounds, 1);
  assert.equal(result.keptSteps, 4);
  assert.deepEqual(ids(result.removedMessages), [
    'a2-call', 't2', 'a2-final', 'u3', 'a3-call', 't3', 'a3-final',
  ]);
}

const crypto = require('node:crypto');
class FileWriteConflictError extends Error {
  constructor(message, currentContent) {
    super(message);
    this.name = 'FileWriteConflictError';
    this.currentContent = currentContent;
  }
}
const disk = new Map();
let throwAfterNextWrite = false;
let readError = null;
let mutateAfterNextRead = null;
const normalizePath = value => path.posix.normalize(value.replace(/\\/g, '/')).toLowerCase();
const mockFileSystem = {
  hasNode(filePath) {
    return disk.has(normalizePath(filePath));
  },
  async readFile(filePath) {
    if (readError) {
      const error = readError;
      readError = null;
      throw error;
    }
    const key = normalizePath(filePath);
    if (!disk.has(key)) {
      const error = new Error(`missing: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    }
    const content = disk.get(key);
    if (mutateAfterNextRead) {
      const mutate = mutateAfterNextRead;
      mutateAfterNextRead = null;
      mutate(key);
    }
    return content;
  },
  async writeFile(filePath, content, _contextId, _conversationId, _access, options) {
    const key = normalizePath(filePath);
    if (options && Object.prototype.hasOwnProperty.call(options, 'expectedContent')) {
      const currentContent = disk.has(key) ? disk.get(key) : null;
      if (currentContent !== options.expectedContent) {
        throw new FileWriteConflictError('文件已在保存前被其它操作修改', currentContent);
      }
    }
    disk.set(key, content);
    if (throwAfterNextWrite) {
      throwAfterNextWrite = false;
      throw new Error('injected write failure after mutation');
    }
  },
  async deleteFile(filePath) {
    disk.delete(normalizePath(filePath));
  },
};
const hashContent = content => crypto.createHash('sha256').update(content, 'utf8').digest('hex');
const fileRollback = compileTypeScript(
  path.join(servicesDir, 'fileRollback.ts'),
  {
    './diffReviewCore': {
      applyReviewTransition() {
        throw new Error('review transition is outside this atomic rollback test');
      },
      validateReviewAcceptance() {
        throw new Error('review acceptance is outside this atomic rollback test');
      },
    },
    './fileChangeTracker': {
      buildDiffHunks() {
        throw new Error('diff hunk building is outside this atomic rollback test');
      },
      hashContent,
    },
    './fileSystem': {
      fileSystem: mockFileSystem,
      FileWriteConflictError,
      async resolveCanonicalWorkspacePath(filePath) {
        return normalizePath(filePath);
      },
    },
  },
);

function rollbackDiff(id, filePath, afterContent) {
  return {
    id,
    path: filePath,
    changeType: 'edited',
    afterHash: hashContent(afterContent),
  };
}

function lifecycleDiff(id, filePath, changeType, afterContent = '') {
  return {
    id,
    path: filePath,
    changeType,
    afterHash: changeType === 'deleted' ? undefined : hashContent(afterContent),
  };
}

async function testAtomicRollback() {
  const sameFile = normalizePath('src/Same.txt');
  disk.set(sameFile, 'C');
  const transaction = await fileRollback.rollbackFileDiffsAtomically([
    { diff: rollbackDiff('new', 'src\\Same.txt', 'C'), snapshot: { content: 'B' } },
    { diff: rollbackDiff('old', 'src/same.txt', 'B'), snapshot: { content: 'A' } },
  ]);
  assert.equal(disk.get(sameFile), 'A', 'same-file batches must rollback C -> B -> A');
  await transaction.compensate();
  assert.equal(disk.get(sameFile), 'C', 'compensation must restore the complete same-file chain');
  await transaction.compensate();
  assert.equal(disk.get(sameFile), 'C', 'compensation must be idempotent');

  disk.set(sameFile, 'ai-new');
  const concurrentTransaction = await fileRollback.rollbackFileDiffsAtomically([
    { diff: rollbackDiff('concurrent', 'src/same.txt', 'ai-new'), snapshot: { content: 'before-ai' } },
  ]);
  disk.set(sameFile, 'user-edit');
  await assert.rejects(
    concurrentTransaction.compensate(),
    /文件回退补偿失败.*回退事务后又被修改/,
  );
  assert.equal(disk.get(sameFile), 'user-edit', 'compensation must not overwrite a concurrent user edit');
  await assert.rejects(
    concurrentTransaction.compensate(),
    /文件回退补偿失败.*回退事务后又被修改/,
    'a failed compensation must remain failed on repeated calls',
  );

  disk.set(sameFile, 'created-content');
  const permissionError = new Error('permission denied');
  permissionError.code = 'EACCES';
  readError = permissionError;
  await assert.rejects(
    fileRollback.rollbackFileDiffsAtomically([
      { diff: lifecycleDiff('created-read-error', 'src/same.txt', 'created', 'created-content') },
    ]),
    /permission denied/,
    'read errors other than ENOENT must abort rollback',
  );
  assert.equal(disk.get(sameFile), 'created-content');

  disk.set(sameFile, 'created-content');
  readError = permissionError;
  await assert.rejects(
    fileRollback.applyDiffReview(
      lifecycleDiff('review-read-error', 'src/same.txt', 'created', 'created-content'),
      undefined,
      'accepted',
    ),
    /permission denied/,
    'review reads must fail closed on EACCES instead of treating the file as missing',
  );
  assert.equal(disk.get(sameFile), 'created-content');

  disk.set(sameFile, 'C');
  mutateAfterNextRead = key => disk.set(key, 'B');
  await assert.rejects(
    fileRollback.rollbackFileDiffsAtomically([
      { diff: rollbackDiff('changed-before-mutation', 'src/same.txt', 'C'), snapshot: { content: 'B' } },
    ]),
    /文件在回退前又被修改/,
    'a state check failure must not register an unexecuted item for compensation',
  );
  assert.equal(disk.get(sameFile), 'B', 'failed precondition must preserve the concurrent user state');

  disk.set(sameFile, 'C');
  throwAfterNextWrite = true;
  await assert.rejects(
    fileRollback.rollbackFileDiffsAtomically([
      { diff: rollbackDiff('mutate-then-throw', 'src/same.txt', 'C'), snapshot: { content: 'B' } },
    ]),
    /injected write failure after mutation/,
  );
  assert.equal(disk.get(sameFile), 'C', 'a mutate-then-throw write must be compensated');

  disk.delete(sameFile);
  const deletedTransaction = await fileRollback.rollbackFileDiffsAtomically([
    { diff: lifecycleDiff('deleted', 'src/same.txt', 'deleted'), snapshot: { content: 'before-delete' } },
  ]);
  assert.equal(disk.get(sameFile), 'before-delete', 'a deleted file must be restored from its snapshot');
  await deletedTransaction.compensate();
  assert.equal(disk.has(sameFile), false, 'deleted-file compensation must restore the absent post-AI state');

  disk.set(sameFile, 'created-content');
  const createdTransaction = await fileRollback.rollbackFileDiffsAtomically([
    { diff: lifecycleDiff('created', 'src/same.txt', 'created', 'created-content') },
  ]);
  assert.equal(disk.has(sameFile), false, 'a created file must be removed during rollback');
  await createdTransaction.compensate();
  assert.equal(disk.get(sameFile), 'created-content', 'created-file compensation must restore its content');

  disk.set(sameFile, 'edited-created-content');
  const createdChainTransaction = await fileRollback.rollbackFileDiffsAtomically([
    { diff: rollbackDiff('edited-created', 'src/same.txt', 'edited-created-content'), snapshot: { content: 'created-content' } },
    { diff: lifecycleDiff('created-base', 'src/same.txt', 'created', 'created-content') },
  ]);
  assert.equal(disk.has(sameFile), false, 'an edited created file must rollback through content to absence');
  await createdChainTransaction.compensate();
  assert.equal(disk.get(sameFile), 'edited-created-content', 'created-file chains must compensate back to the newest content');
}

testAtomicRollback()
  .then(() => console.log('Diff history integration: round and atomic rollback assertions passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
