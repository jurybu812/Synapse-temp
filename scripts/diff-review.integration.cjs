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

const sourcePath = path.join(__dirname, '..', 'src', 'services', 'diffReviewCore.ts');
const reviewCore = compileTypeScript(sourcePath);
const { applyReviewTransition, hasPendingReviewParts, validateReviewAcceptance } = reviewCore;

const workspaceRoot = 'C:/Repo/Project';
const canonicalWinPath = value => {
  const raw = String(value).replace(/\//g, '\\');
  const resolved = path.win32.isAbsolute(raw)
    ? path.win32.resolve(raw)
    : path.win32.resolve(workspaceRoot.replace(/\//g, '\\'), raw);
  return resolved.replace(/\\/g, '/');
};
const diffReviewPath = compileTypeScript(
  path.join(__dirname, '..', 'src', 'services', 'diffReviewPath.ts'),
  {
    './fileSystem': {
      async resolveCanonicalWorkspacePath(value) {
        return canonicalWinPath(value);
      },
      async getWorkspaceRootResolved() {
        return workspaceRoot;
      },
    },
  },
);

const ledgerPath = path.join(__dirname, '..', 'src', 'services', 'diffReviewLedger.ts');
const { findMergeableMessageDiffIndex } = compileTypeScript(ledgerPath, {
  './diffReviewPath': diffReviewPath,
});

const groupingPath = path.join(__dirname, '..', 'src', 'services', 'diffReviewGrouping.ts');
const groupingDependencies = {
  './diffReviewPath': diffReviewPath,
  './fileSystem': { resolveWorkspacePath: async value => canonicalWinPath(value) },
};
const groupingRequire = request => {
  if (Object.prototype.hasOwnProperty.call(groupingDependencies, request)) return groupingDependencies[request];
  if (request === './fileChangeTracker') return { countLineChanges: () => ({ additions: 0, deletions: 0 }) };
  if (request === './fileRollback') return { materializeReviewedContent: () => '', normalizeHunks: () => [] };
  if (request === './diffReviewCore') return { hasPendingReviewParts };
  return require(request);
};
const groupSource = fs.readFileSync(groupingPath, 'utf8');
const groupCompiled = ts.transpileModule(groupSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    strict: true,
  },
  fileName: groupingPath,
});
const groupModule = { exports: {} };
new Function('require', 'module', 'exports', groupCompiled.outputText)(groupingRequire, groupModule, groupModule.exports);
const { groupFileDiffs, normalizeDiffPath, reviewPathKeys } = groupModule.exports;

{
  const expected = ['alpha', 'agent-value', 'omega'].join('\n');
  const desired = ['alpha', 'base-value', 'omega'].join('\n');
  const current = ['alpha', 'agent-value', 'omega', 'user-tail'].join('\n');
  const result = applyReviewTransition(expected, desired, current);
  assert.equal(result.content, ['alpha', 'base-value', 'omega', 'user-tail'].join('\n'));
  assert.equal(result.merged, true);
}

{
  const expected = ['alpha', 'agent-value', 'omega'].join('\n');
  const desired = ['alpha', 'base-value', 'omega'].join('\n');
  const current = ['alpha', 'user-rewrote-agent-line', 'omega'].join('\n');
  assert.throws(
    () => applyReviewTransition(expected, desired, current),
    /同一区域发生冲突/,
  );
}

{
  const diffs = [
    { id: 'round-1', path: 'C:/Repo/Project/src/a.ts', reviewPath: 'src/a.ts', status: 'pending', conversationId: 'conv' },
    { id: 'round-2', path: 'C:/Repo/Project/src/a.ts', reviewPath: 'src/a.ts', status: 'pending', conversationId: 'conv' },
  ];
  assert.equal(
    findMergeableMessageDiffIndex(diffs, new Set(['round-2']), {
      path: 'C:/Repo/Project/SRC/A.TS',
      reviewPath: 'src/a.ts',
      conversationId: 'conv',
    }),
    1,
  );
  assert.equal(
    findMergeableMessageDiffIndex(diffs, new Set(), {
      path: 'C:/Repo/Project/src/a.ts',
      reviewPath: 'src/a.ts',
      conversationId: 'conv',
    }),
    -1,
  );
  assert.equal(
    findMergeableMessageDiffIndex(diffs, new Set(['round-2']), {
      path: 'C:/Repo/Project/src/a-other.ts',
      reviewPath: 'src/a-other.ts',
      conversationId: 'conv',
    }),
    -1,
  );
}

{
  const diffs = [
    { id: 'batch-1', path: 'C:/Repo/Project/test/planner.test.js', reviewPath: 'test/planner.test.js', status: 'pending', contextId: 'run-a', conversationId: 'autosave-current', additions: 48, deletions: 0 },
    { id: 'batch-2', path: 'C:\\Repo\\Project\\test\\planner.test.js', reviewPath: 'test/planner.test.js', status: 'pending', contextId: 'run-b', conversationId: 'conv-promoted', additions: 44, deletions: 1 },
    { id: 'batch-3', path: 'TEST/PLANNER.TEST.JS', reviewPath: 'test/planner.test.js', status: 'pending', contextId: 'subagent-c', conversationId: 'conv-promoted', additions: 159, deletions: 4 },
    { id: 'other-file', path: 'src/planner.js', status: 'pending', contextId: 'run-b', conversationId: 'conv-promoted', additions: 5, deletions: 2 },
  ];
  const groups = groupFileDiffs(diffs, {});
  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.key === 'test/planner.test.js').activeDiffs.length, 3);
  assert.equal(groups.find(group => group.key === 'src/planner.js').activeDiffs.length, 1);
}

const pathReviewChecks = Promise.all([
  diffReviewPath.resolveDiffReviewPath('src\\CaseSensitive.ts'),
  diffReviewPath.resolveDiffReviewPath('C:\\Repo\\Project\\SRC\\casesensitive.ts'),
  diffReviewPath.resolveDiffReviewPath('..\\Project\\src\\CaseSensitive.ts'),
  diffReviewPath.resolveDiffReviewPath('..\\outside\\CaseSensitive.ts'),
  reviewPathKeys('C:\\Repo\\Project\\SRC\\casesensitive.ts'),
]).then(([relativePath, absolutePath, dotDotInsidePath, outsidePath, keys]) => {
  assert.equal(relativePath.reviewPath, 'src/casesensitive.ts');
  assert.equal(absolutePath.reviewPath, 'src/casesensitive.ts');
  assert.equal(dotDotInsidePath.reviewPath, 'src/casesensitive.ts');
  assert.equal(outsidePath.isWorkspaceRelative, false);
  assert.equal(outsidePath.reviewPath, 'c:/repo/outside/casesensitive.ts');
  assert.equal(keys.has(normalizeDiffPath('src/casesensitive.ts')), true);
});

const fileChangeTracker = compileTypeScript(path.join(__dirname, '..', 'src', 'services', 'fileChangeTracker.ts'));
const conversation = compileTypeScript(
  path.join(__dirname, '..', 'src', 'store', 'slices', 'conversation.ts'),
  {
    '@reduxjs/toolkit': require('@reduxjs/toolkit'),
    '@/services/fileChangeTracker': fileChangeTracker,
    '@/services/diffReviewLedger': { findMergeableMessageDiffIndex },
    '@/services/conversationPersistence': { AUTOSAVE_ID: 'autosave-current' },
  },
);
const {
  conversationSlice,
  setConversation,
  updateDiffStatus,
  updateHunkStatus,
} = conversation;
class FileWriteConflictError extends Error {
  constructor(message, currentContent) {
    super(message);
    this.name = 'FileWriteConflictError';
    this.currentContent = currentContent;
  }
}
const reviewDisk = new Map();
let mutateBeforeNextReviewWrite = null;
const normalizeReviewDiskPath = value => normalizeDiffPath(canonicalWinPath(value));
const reviewFileSystem = {
  hasNode(filePath) {
    return reviewDisk.has(normalizeReviewDiskPath(filePath));
  },
  async readFile(filePath) {
    const key = normalizeReviewDiskPath(filePath);
    if (!reviewDisk.has(key)) {
      const error = new Error(`missing: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    }
    return reviewDisk.get(key);
  },
  async writeFile(filePath, content, _contextId, _conversationId, _access, options) {
    const key = normalizeReviewDiskPath(filePath);
    if (mutateBeforeNextReviewWrite) {
      const mutate = mutateBeforeNextReviewWrite;
      mutateBeforeNextReviewWrite = null;
      mutate(key);
    }
    if (options && Object.prototype.hasOwnProperty.call(options, 'expectedContent')) {
      const currentContent = reviewDisk.has(key) ? reviewDisk.get(key) : null;
      if (currentContent !== options.expectedContent) {
        throw new FileWriteConflictError('文件已在保存前被其它操作修改', currentContent);
      }
    }
    reviewDisk.set(key, content);
  },
  async deleteFile(filePath) {
    reviewDisk.delete(normalizeReviewDiskPath(filePath));
  },
};
const fileRollback = compileTypeScript(
  path.join(__dirname, '..', 'src', 'services', 'fileRollback.ts'),
  {
    './diffReviewCore': reviewCore,
    './fileChangeTracker': fileChangeTracker,
    './fileSystem': {
      fileSystem: reviewFileSystem,
      FileWriteConflictError,
      async resolveCanonicalWorkspacePath(value) {
        return canonicalWinPath(value);
      },
    },
  },
);

function lifecycleDiff(id, filePath, changeType, beforeContent, afterContent) {
  return {
    id,
    path: filePath,
    changeType,
    additions: 0,
    deletions: 0,
    status: 'pending',
    snapshotId: changeType === 'created' ? undefined : `${id}-snapshot`,
    beforeHash: fileChangeTracker.hashContent(beforeContent),
    afterHash: fileChangeTracker.hashContent(afterContent),
    hunks: fileChangeTracker.buildDiffHunks(beforeContent, afterContent),
  };
}

function lifecycleSnapshot(id, filePath, content) {
  return {
    id: `${id}-snapshot`,
    path: filePath,
    content,
    contentHash: fileChangeTracker.hashContent(content),
    createdAt: 1,
    reason: 'before_ai_edit',
  };
}

const emptyLifecycleChecks = (async () => {
  const editedPath = 'C:/Repo/Project/src/empty-target.txt';
  const editedKey = normalizeReviewDiskPath(editedPath);
  const edited = lifecycleDiff('edited-to-empty', editedPath, 'edited', 'before-content', '');
  const editedSnapshot = lifecycleSnapshot('edited-to-empty', editedPath, 'before-content');
  reviewDisk.delete(editedKey);
  await assert.rejects(
    fileRollback.applyDiffReview(edited, editedSnapshot, 'rejected'),
    /文件已在审阅前被删除，已停止回退/,
  );
  assert.equal(reviewDisk.has(editedKey), false, 'rejecting an externally deleted edited-to-empty file must not recreate old content');
  await assert.rejects(
    fileRollback.applyDiffReview(edited, editedSnapshot, 'accepted'),
    /文件已在审阅前被删除，已停止接受/,
  );
  assert.equal(reviewDisk.has(editedKey), false, 'accepting an externally deleted edited-to-empty file must preserve deletion');

  const createdPath = 'C:/Repo/Project/src/new-empty.txt';
  const createdKey = normalizeReviewDiskPath(createdPath);
  const created = lifecycleDiff('created-empty', createdPath, 'created', '', '');
  reviewDisk.delete(createdKey);
  await fileRollback.applyDiffReview(created, undefined, 'rejected');
  assert.equal(reviewDisk.has(createdKey), false, 'rejecting an already deleted created-empty file must stay absent');
  reviewDisk.set(createdKey, '');
  await fileRollback.applyDiffReview(created, undefined, 'rejected');
  assert.equal(reviewDisk.has(createdKey), false, 'rejecting a created-empty file that still exists must remove it');
})();

const rejectConflictChecks = (async () => {
  const beforeContent = ['head', 'base', 'tail'].join('\n');
  const afterContent = ['head', 'agent', 'tail'].join('\n');

  async function assertRejectWriteConflict(label, reject) {
    const filePath = `C:/Repo/Project/src/${label}.txt`;
    const key = normalizeReviewDiskPath(filePath);
    const diff = lifecycleDiff(label, filePath, 'edited', beforeContent, afterContent);
    const snapshot = lifecycleSnapshot(label, filePath, beforeContent);
    reviewDisk.set(key, afterContent);
    mutateBeforeNextReviewWrite = currentKey => reviewDisk.set(currentKey, `${label}:external-change`);
    await assert.rejects(
      () => reject(diff, snapshot),
      /文件已在保存前被其它操作修改|文件在写入前又被修改/,
      `${label} must fail closed when the file changes between review read and final write`,
    );
    assert.equal(reviewDisk.get(key), `${label}:external-change`, `${label} must preserve the external change`);
  }

  await assertRejectWriteConflict('whole-reject-conflict', (diff, snapshot) =>
    fileRollback.applyDiffReview(diff, snapshot, 'rejected'));

  await assertRejectWriteConflict('hunk-reject-conflict', (diff, snapshot) => {
    const hunkId = fileRollback.normalizeHunks(diff)[0].id;
    return fileRollback.applyHunkReview(diff, snapshot, hunkId, 'rejected');
  });

  await assertRejectWriteConflict('block-reject-conflict', (diff, snapshot) => {
    const hunk = fileRollback.normalizeHunks(diff)[0];
    return fileRollback.applyBlockReview(diff, snapshot, hunk.id, hunk.blocks[0].id, 'rejected');
  });

  const createdPath = 'C:/Repo/Project/src/created-delete-conflict.txt';
  const createdKey = normalizeReviewDiskPath(createdPath);
  const createdContent = 'agent-created-content';
  const created = lifecycleDiff('created-delete-conflict', createdPath, 'created', '', createdContent);
  reviewDisk.set(createdKey, createdContent);
  mutateBeforeNextReviewWrite = key => reviewDisk.set(key, 'external-created-change');
  await assert.rejects(
    () => fileRollback.applyDiffReview(created, undefined, 'rejected'),
    /文件已在保存前被其它操作修改|文件在删除前又被修改/,
    'created-file reject must fail closed before final delete when the file changes',
  );
  assert.equal(reviewDisk.get(createdKey), 'external-created-change', 'created-file reject must not delete an external change');
})();

{
  const expected = ['alpha', 'agent-value', 'omega'].join('\n');
  const desired = ['alpha', 'base-value', 'omega'].join('\n');
  const result = applyReviewTransition(expected, desired, desired);
  assert.equal(result.content, desired);
  assert.equal(result.merged, true);
}

{
  const expected = 'same-content';
  const desired = 'same-content';
  const result = applyReviewTransition(expected, desired, desired);
  assert.equal(result.content, desired);
  assert.equal(result.merged, true);
}

{
  const expected = ['head', 'agent-added', 'tail'].join('\n');
  const desired = ['head', 'tail'].join('\n');
  const current = ['user-prefix', 'head', 'agent-added', 'tail'].join('\n');
  const result = applyReviewTransition(expected, desired, current);
  assert.equal(result.content, ['user-prefix', 'head', 'tail'].join('\n'));
}

{
  const expected = 'alpha\r\nbeta\r\n';
  const desired = 'alpha\r\nBETA\r\n';
  const current = 'prefix\r\nalpha\r\nbeta\r\n';
  const result = applyReviewTransition(expected, desired, current);
  assert.equal(result.content, 'prefix\r\nalpha\r\nBETA\r\n');
}

{
  const expected = 'alpha\nbeta\n';
  const desired = 'alpha\nBETA';
  const current = 'prefix\nalpha\nbeta\n';
  const result = applyReviewTransition(expected, desired, current);
  assert.equal(result.content, 'prefix\nalpha\nBETA');
}

{
  const expected = ['alpha', 'agent-value', 'omega'].join('\n');
  const baseline = ['alpha', 'base-value', 'omega'].join('\n');
  const current = ['alpha', 'agent-value', 'omega', 'user-tail'].join('\n');
  assert.doesNotThrow(() => validateReviewAcceptance(expected, baseline, current));
}

{
  const expected = ['alpha', 'agent-value', 'omega'].join('\n');
  const baseline = ['alpha', 'base-value', 'omega'].join('\n');
  const current = ['alpha', 'user-rewrote-agent-line', 'omega'].join('\n');
  assert.throws(
    () => validateReviewAcceptance(expected, baseline, current),
    /同一区域发生冲突/,
  );
}

{
  const expected = ['alpha', 'agent-value', 'omega'].join('\n');
  const baseline = ['alpha', 'base-value', 'omega'].join('\n');
  assert.throws(
    () => validateReviewAcceptance(expected, baseline, baseline),
    /Agent 改动已不在当前内容/,
  );
}

{
  const baseline = ['alpha', 'base-value', 'omega'].join('\n');
  const intermediate = ['alpha', 'agent-value-1', 'omega'].join('\n');
  const final = ['alpha', 'agent-value-2', 'omega'].join('\n');
  assert.throws(
    () => validateReviewAcceptance(intermediate, baseline, final),
    /同一区域发生冲突/,
  );
  assert.doesNotThrow(() => validateReviewAcceptance(final, baseline, final));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateWithDiffs(diffs) {
  const messageDiffs = clone(diffs);
  return conversationSlice.reducer(undefined, setConversation({
    id: 'conv-empty-review',
    title: 'Diff review',
    messages: [{
      id: 'assistant-empty-review',
      role: 'assistant',
      content: 'done',
      timestamp: 1,
      diffs: messageDiffs,
    }],
    pendingDiffs: clone(diffs),
  }));
}

function stateDiff(state, diffId) {
  return state.pendingDiffs.find(diff => diff.id === diffId);
}

function messageDiff(state, diffId) {
  return state.messages[0].diffs.find(diff => diff.id === diffId);
}

{
  const diff = {
    id: 'empty-diff-reject',
    path: 'src/empty-diff.ts',
    reviewPath: 'src/empty-diff.ts',
    changeType: 'edited',
    additions: 0,
    deletions: 0,
    status: 'pending',
    hunks: [],
  };
  const state = conversationSlice.reducer(
    stateWithDiffs([diff]),
    updateDiffStatus({ diffId: diff.id, status: 'rejected', conversationId: 'conv-empty-review' }),
  );
  assert.equal(stateDiff(state, diff.id).status, 'rejected');
  assert.equal(messageDiff(state, diff.id).status, 'rejected');
  assert.equal(hasPendingReviewParts(stateDiff(state, diff.id)), false);
  assert.equal(groupFileDiffs(state.pendingDiffs, {}).find(group => group.key === 'src/empty-diff.ts').activeDiffs.length, 0);
}

{
  const diff = {
    id: 'empty-hunk-accept',
    path: 'src/empty-hunk.ts',
    reviewPath: 'src/empty-hunk.ts',
    changeType: 'edited',
    additions: 0,
    deletions: 0,
    status: 'pending',
    hunks: [{
      id: 'empty-hunk-accept:hunk:0',
      status: 'pending',
      oldStart: 1,
      newStart: 1,
      oldLines: 0,
      newLines: 0,
      lines: [],
    }],
  };
  const state = conversationSlice.reducer(
    stateWithDiffs([diff]),
    updateDiffStatus({ diffId: diff.id, status: 'accepted', conversationId: 'conv-empty-review' }),
  );
  assert.equal(stateDiff(state, diff.id).status, 'accepted');
  assert.equal(stateDiff(state, diff.id).hunks[0].status, 'accepted');
  assert.equal(messageDiff(state, diff.id).status, 'accepted');
  assert.equal(messageDiff(state, diff.id).hunks[0].status, 'accepted');
  assert.equal(hasPendingReviewParts(stateDiff(state, diff.id)), false);
  assert.equal(groupFileDiffs(state.pendingDiffs, {}).find(group => group.key === 'src/empty-hunk.ts').activeDiffs.length, 0);
}

{
  const diff = {
    id: 'empty-hunk-single',
    path: 'src/empty-hunk-single.ts',
    reviewPath: 'src/empty-hunk-single.ts',
    changeType: 'edited',
    additions: 0,
    deletions: 0,
    status: 'pending',
    hunks: [{
      id: 'empty-hunk-single:hunk:0',
      status: 'pending',
      oldStart: 1,
      newStart: 1,
      oldLines: 0,
      newLines: 0,
      lines: [],
    }],
  };
  const state = conversationSlice.reducer(
    stateWithDiffs([diff]),
    updateHunkStatus({
      diffId: diff.id,
      hunkId: 'empty-hunk-single:hunk:0',
      status: 'rejected',
      conversationId: 'conv-empty-review',
    }),
  );
  assert.equal(stateDiff(state, diff.id).status, 'rejected');
  assert.equal(stateDiff(state, diff.id).hunks[0].status, 'rejected');
  assert.equal(messageDiff(state, diff.id).status, 'rejected');
  assert.equal(messageDiff(state, diff.id).hunks[0].status, 'rejected');
  assert.equal(hasPendingReviewParts(stateDiff(state, diff.id)), false);
}

{
  assert.equal(hasPendingReviewParts({
    status: 'mixed',
    hunks: [{ status: 'mixed', blocks: [{ status: 'accepted' }, { status: 'rejected' }] }],
  }), false);
  assert.equal(hasPendingReviewParts({
    status: 'mixed',
    hunks: [{ status: 'mixed', blocks: [{ status: 'accepted' }, { status: 'pending' }] }],
  }), true);
}

Promise.all([pathReviewChecks, emptyLifecycleChecks, rejectConflictChecks])
  .then(() => console.log('Diff review integration: all assertions passed'));
