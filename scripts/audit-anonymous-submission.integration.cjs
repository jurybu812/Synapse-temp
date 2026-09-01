const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const auditScript = path.join(__dirname, 'audit-anonymous-submission.cjs');

function sha256Content(content) {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGit(root) {
  try {
    git(root, ['init', '--initial-branch=main']);
  } catch {
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
  }
  git(root, ['config', '--local', 'user.name', 'Synapse Project']);
  git(root, ['config', '--local', 'user.email', 'synapse-project@users.noreply.github.com']);
}

function writeText(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createManifest(root, entries) {
  const fileSetSha256 = hashJson(entries);
  const manifest = {
    schemaVersion: 3,
    generatedAtUtc: '2026-09-01T00:00:00.000Z',
    sourceSnapshot: {
      sourceHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceDirty: false,
      sourceStatusSha256: 'b'.repeat(64),
      sourceTrackedFileCount: entries.length,
      sourceFileSetSha256: fileSetSha256,
      targetFileSetSha256: fileSetSha256,
      exportScriptSha256: 'c'.repeat(64),
    },
    files: entries,
  };
  writeText(root, 'SUBMISSION_MANIFEST.json', `${JSON.stringify(manifest, null, 2)}\n`);
}

function createSubmission(root) {
  const files = new Map([
    ['LICENSE', 'MIT License\n\nPermission is hereby granted to use this project.\n'],
    ['README.md', '# Synapse\n\nAnonymous submission fixture.\n'],
    ['THIRD_PARTY_NOTICES.md', '# Third Party Notices\n\nNo bundled third-party notices in this fixture.\n'],
    ['package.json', `${JSON.stringify({
      name: 'synapse-app',
      private: true,
      version: '0.1.0',
      description: 'Synapse desktop coding agent',
      author: 'Synapse Contributors',
      license: 'MIT',
    }, null, 2)}\n`],
    ['package-lock.json', `${JSON.stringify({
      name: 'synapse-app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'synapse-app',
          version: '0.1.0',
          license: 'MIT',
        },
      },
    }, null, 2)}\n`],
  ]);
  for (const [relativePath, content] of files) writeText(root, relativePath, content);
  const entries = [...files.entries()].map(([relativePath, content]) => ({
    path: relativePath,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: sha256Content(content),
  })).sort((left, right) => left.path.localeCompare(right.path));
  createManifest(root, entries);
}

function commit(root, paths = ['.']) {
  git(root, ['add', ...paths]);
  git(root, ['commit', '-m', 'Initial anonymous submission']);
}

function runAudit(root) {
  return spawnSync(process.execPath, [auditScript, root], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function expectFailure(name, root, fragments) {
  const result = runAudit(root);
  assert.notEqual(result.status, 0, `${name} should fail`);
  const output = `${result.stdout}\n${result.stderr}`;
  for (const fragment of fragments) {
    assert.match(output, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} should report "${fragment}"\n${output}`);
  }
  console.log(`[pass] ${name}`);
}

function expectSuccess(name, root) {
  const result = runAudit(root);
  assert.equal(result.status, 0, `${name} should pass\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stdout, /Anonymous submission audit passed:/);
  console.log(`[pass] ${name}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-audit-anonymous-'));
try {
  const emptyRepository = path.join(tempRoot, 'empty-repository');
  fs.mkdirSync(emptyRepository);
  initGit(emptyRepository);
  expectFailure('empty repository without HEAD history', emptyRepository, [
    'Git HEAD commit is required for anonymous audit',
    'Anonymous Git refs must contain exactly refs/heads/main; found: none',
    'SUBMISSION_MANIFEST.json must be tracked by Git',
    'SUBMISSION_MANIFEST.json must be present in HEAD',
  ]);

  const uncommittedManifest = path.join(tempRoot, 'uncommitted-manifest');
  fs.mkdirSync(uncommittedManifest);
  initGit(uncommittedManifest);
  createSubmission(uncommittedManifest);
  commit(uncommittedManifest, ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json']);
  expectFailure('uncommitted manifest', uncommittedManifest, [
    'Git worktree must be clean before anonymous audit',
    'SUBMISSION_MANIFEST.json must be tracked by Git',
    'SUBMISSION_MANIFEST.json must be present in HEAD',
  ]);

  const dirtyTarget = path.join(tempRoot, 'dirty-target');
  fs.mkdirSync(dirtyTarget);
  initGit(dirtyTarget);
  createSubmission(dirtyTarget);
  commit(dirtyTarget);
  writeText(dirtyTarget, 'README.md', '# Synapse\n\nDirty fixture change.\n');
  expectFailure('dirty target', dirtyTarget, [
    'Git worktree must be clean before anonymous audit',
  ]);

  const extraRefTarget = path.join(tempRoot, 'extra-ref-target');
  fs.mkdirSync(extraRefTarget);
  initGit(extraRefTarget);
  createSubmission(extraRefTarget);
  commit(extraRefTarget);
  git(extraRefTarget, ['branch', 'review']);
  expectFailure('extra branch target', extraRefTarget, [
    'Anonymous Git refs must contain exactly refs/heads/main',
  ]);

  const qualifiedTarget = path.join(tempRoot, 'qualified-target');
  fs.mkdirSync(qualifiedTarget);
  initGit(qualifiedTarget);
  createSubmission(qualifiedTarget);
  commit(qualifiedTarget);
  expectSuccess('qualified target', qualifiedTarget);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
