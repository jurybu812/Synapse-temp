const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-file-access-'));
const workspace = path.join(tempRoot, 'workspace');
const outside = path.join(tempRoot, 'outside');
const generated = path.join(tempRoot, 'synapse-office-generated');
app.setPath('home', path.join(tempRoot, 'home'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
const access = require('../dist-electron/electron/fileAccess.js');
const fileProtocol = require('../dist-electron/electron/ipc/fileProtocol.js');

async function main() {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(generated, { recursive: true });
  const workspaceFile = path.join(workspace, 'inside.txt');
  const outsideFile = path.join(outside, 'outside.txt');
  const outsideImage = path.join(outside, 'outside.png');
  const generatedImage = path.join(generated, 'preview.png');
  fs.writeFileSync(workspaceFile, 'inside', 'utf8');
  fs.writeFileSync(outsideFile, 'outside', 'utf8');
  fs.writeFileSync(outsideImage, Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(generatedImage, Buffer.from([137, 80, 78, 71]));
  const workspaceHandlerSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'workspace.ts'), 'utf8');
  assert.doesNotMatch(
    workspaceHandlerSource,
    /FROM\s+conversations/i,
    'trusted workspace roots must not be expanded from conversation.workspace_path',
  );

  await app.whenReady();

  access.replaceAuthorizedWorkspaceRoots([workspace]);
  assert.equal(access.enforceAgentFileAccess(workspaceFile), fs.realpathSync.native(workspaceFile));
  assert.throws(() => access.enforceAgentFileAccess(outsideFile), /无权访问/);
  assert.equal(access.classifyAgentFileAccess(outsideFile, outside).withinWorkspace, false);
  assert.throws(
    () => access.prepareAgentFileAccessGrant(42, {
      workspaceRoot: outside,
      fullAccess: false,
      approvedPaths: [outsideFile],
      operations: ['read'],
    }),
    /工作区根未经/,
  );
  assert.throws(
    () => access.enforceAgentFileAccess(outsideFile, {
      workspaceRoot: workspace,
      fullAccess: true,
      approvedPaths: [outsideFile],
    }, 42),
    /无权访问/,
  );

  const workspaceWriteChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [workspaceFile],
    operations: ['read', 'write'],
  });
  const workspaceWriteDetails = access.getPendingFileAccessGrantDetails(42, workspaceWriteChallenge);
  assert.equal(workspaceWriteDetails.scope, 'workspace');
  assert.equal(workspaceWriteDetails.workspaceRoot, fs.realpathSync.native(workspace));
  assert.deepEqual(new Set(workspaceWriteDetails.operations), new Set(['read', 'write']));
  access.cancelPendingFileAccessGrant(42, workspaceWriteChallenge);

  const rejectedChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [outsideFile],
    operations: ['read'],
  });
  assert.equal(access.getPendingFileAccessGrantDetails(42, rejectedChallenge).scope, 'external');
  assert.throws(
    () => access.completeAgentFileAccessGrant(42, rejectedChallenge, false),
    /真实点击|键盘操作/,
  );

  const challenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: true,
    approvedPaths: [outsideFile],
    operations: ['read'],
  });
  const grant = access.completeAgentFileAccessGrant(42, challenge, true);
  assert.equal(grant.senderId, 42);
  assert.equal(access.enforceAgentFileAccess(outsideFile, grant, 42, 'read'), fs.realpathSync.native(outsideFile));
  assert.throws(() => access.enforceAgentFileAccess(outsideFile, grant, 42, 'read'), /无权访问/);

  const operationChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [outsideFile],
    operations: ['read'],
  });
  const operationGrant = access.completeAgentFileAccessGrant(42, operationChallenge, true);
  assert.throws(() => access.enforceAgentFileAccess(outsideFile, operationGrant, 42, 'write'), /无权访问/);
  assert.equal(access.enforceAgentFileAccess(outsideFile, operationGrant, 42, 'read'), fs.realpathSync.native(outsideFile));

  const senderChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [outsideFile],
    operations: ['read'],
  });
  const senderGrant = access.completeAgentFileAccessGrant(42, senderChallenge, true);
  assert.throws(() => access.enforceAgentFileAccess(outsideFile, senderGrant, 7, 'read'), /无权访问/);
  assert.equal(access.enforceAgentFileAccess(outsideFile, senderGrant, 42, 'read'), fs.realpathSync.native(outsideFile));

  const pathChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [outsideFile],
    operations: ['read'],
  });
  const pathGrant = access.completeAgentFileAccessGrant(42, pathChallenge, true);
  assert.throws(() => access.enforceAgentFileAccess(outsideImage, pathGrant, 42, 'read'), /无权访问/);
  assert.equal(access.enforceAgentFileAccess(outsideFile, pathGrant, 42, 'read'), fs.realpathSync.native(outsideFile));

  const writeChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [outsideFile],
    operations: ['write'],
  });
  const writeGrant = access.completeAgentFileAccessGrant(42, writeChallenge, true);
  assert.equal(access.enforceAgentFileAccess(outsideFile, writeGrant, 42, 'write'), fs.realpathSync.native(outsideFile));
  assert.throws(() => access.enforceAgentFileAccess(outsideFile, writeGrant, 42, 'write'), /无权访问/);

  const renamedOutside = path.join(outside, 'renamed.txt');
  const oldOnlyChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [outsideFile],
    operations: ['delete'],
  });
  const oldOnlyGrant = access.completeAgentFileAccessGrant(42, oldOnlyChallenge, true);
  assert.throws(
    () => access.enforceAgentFileAccessRequests([
      { filePath: outsideFile, operation: 'delete' },
      { filePath: renamedOutside, operation: 'write' },
    ], oldOnlyGrant, 42),
    /无权访问/,
  );
  assert.equal(access.enforceAgentFileAccess(outsideFile, oldOnlyGrant, 42, 'delete'), fs.realpathSync.native(outsideFile));

  const renameSource = path.join(outside, 'rename-source.txt');
  const renameTarget = path.join(outside, 'rename-target.txt');
  fs.writeFileSync(renameSource, 'rename', 'utf8');
  const renameChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [renameSource, renameTarget],
    operations: ['delete', 'write'],
  });
  const renameGrant = access.completeAgentFileAccessGrant(42, renameChallenge, true);
  assert.deepEqual(
    access.enforceAgentFileAccessRequests([
      { filePath: renameSource, operation: 'delete' },
      { filePath: renameTarget, operation: 'write' },
    ], renameGrant, 42),
    [fs.realpathSync.native(renameSource), path.join(fs.realpathSync.native(outside), 'rename-target.txt')],
  );
  assert.throws(() => access.enforceAgentFileAccess(renameSource, renameGrant, 42, 'delete'), /无权访问/);
  assert.throws(() => access.enforceAgentFileAccess(renameTarget, renameGrant, 42, 'write'), /无权访问/);

  assert.throws(() => access.resolveFilePath('\\\\server\\share\\probe.txt'), /UNC|本机盘符/);
  assert.equal(fileProtocol.resolveProtocolPath(`synapse-file://local/${encodeURIComponent(outsideImage)}`), null);
  assert.equal(
    fileProtocol.resolveProtocolPath(`synapse-file://local/${encodeURIComponent(workspaceFile)}`),
    null,
    'non-visual workspace files must remain blocked by the display protocol',
  );

  access.registerTemporaryFileRoot(generated, 42);
  assert.equal(access.isRegisteredTemporaryFileRoot(generated, 42), true);
  assert.equal(access.isRegisteredTemporaryFileRoot(generated, 7), false);
  assert.equal(access.isRegisteredTemporaryFileRoot(generated), true);
  assert.equal(
    fileProtocol.resolveProtocolPath(`synapse-file://local/${encodeURIComponent(generatedImage)}`),
    fs.realpathSync.native(generatedImage),
  );
  access.unregisterTemporaryFileRoot(generated, 7);
  assert.equal(access.isRegisteredTemporaryFileRoot(generated, 42), true);
  access.unregisterTemporaryFileRoot(generated, 42);
  assert.equal(access.isRegisteredTemporaryFileRoot(generated), false);
  assert.equal(fileProtocol.resolveProtocolPath(`synapse-file://local/${encodeURIComponent(generatedImage)}`), null);

  access.registerTemporaryFileRoot(generated, 42);
  const revokeChallenge = access.prepareAgentFileAccessGrant(42, {
    workspaceRoot: workspace,
    fullAccess: false,
    approvedPaths: [outsideFile],
    operations: ['read'],
  });
  const revokeGrant = access.completeAgentFileAccessGrant(42, revokeChallenge, true);
  access.revokeFileAccessGrantsForSender(42);
  assert.equal(access.isRegisteredTemporaryFileRoot(generated, 42), false);
  assert.throws(() => access.enforceAgentFileAccess(outsideFile, revokeGrant, 42, 'read'), /无权访问/);

  console.log('File access integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    app.quit();
  });
