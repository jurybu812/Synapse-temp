const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const auditScript = path.join(__dirname, 'audit-anonymous-submission.cjs');
const exportScript = path.join(__dirname, 'export-anonymous-submission.cjs');

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

function createSubmission(root, extraFiles = []) {
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
  for (const [relativePath, content] of extraFiles) files.set(relativePath, content);
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

function expectExporterWhitelist() {
  const source = fs.readFileSync(exportScript, 'utf8');
  assert.match(source, /const rootDirectories = new Set\(\[[^\]]*'shared'[^\]]*\]\);/);
  assert.match(source, /Submission export requires a clean source worktree/);
  console.log('[pass] exporter whitelist includes shared and keeps dirty guard');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-audit-anonymous-'));
try {
  expectExporterWhitelist();

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

  const missingSharedTarget = path.join(tempRoot, 'missing-shared-target');
  fs.mkdirSync(missingSharedTarget);
  initGit(missingSharedTarget);
  createSubmission(missingSharedTarget, [
    ['electron/main.ts', "import { DESKTOP_BRIDGE_PROTOCOL_VERSION } from '../shared/desktopBridge';\nconsole.log(DESKTOP_BRIDGE_PROTOCOL_VERSION);\n"],
  ]);
  commit(missingSharedTarget);
  expectFailure('missing shared reference target', missingSharedTarget, [
    'Unresolved exported module reference: electron/main.ts -> ../shared/desktopBridge',
  ]);

  const forbiddenPathTarget = path.join(tempRoot, 'forbidden-path-target');
  fs.mkdirSync(forbiddenPathTarget);
  initGit(forbiddenPathTarget);
  createSubmission(forbiddenPathTarget, [
    ['.codex/config.toml', 'private = true\n'],
    ['credentials/token.txt', 'placeholder\n'],
    ['dist/app.js', 'console.log("generated");\n'],
    ['node_modules/example/index.js', 'module.exports = {};\n'],
    ['plans/Task.md', '# Private task notes\n'],
    ['profile/state.json', '{}\n'],
    ['release/build.txt', 'generated\n'],
  ]);
  commit(forbiddenPathTarget);
  expectFailure('forbidden private or generated paths', forbiddenPathTarget, [
    '.codex is forbidden',
    'credentials is forbidden',
    'dist is forbidden',
    'node_modules is forbidden',
    'plans is forbidden',
    'profile is forbidden',
    'release is forbidden',
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
  createSubmission(qualifiedTarget, [
    ['electron/main.ts', "import { DESKTOP_BRIDGE_PROTOCOL_VERSION } from '../shared/desktopBridge';\nconsole.log(DESKTOP_BRIDGE_PROTOCOL_VERSION);\n"],
    ['shared/desktopBridge.ts', 'export const DESKTOP_BRIDGE_PROTOCOL_VERSION = 2;\n'],
    ['src/platform/index.ts', "import { DESKTOP_BRIDGE_PROTOCOL_VERSION } from '../../shared/desktopBridge';\nexport const bridgeVersion = DESKTOP_BRIDGE_PROTOCOL_VERSION;\n"],
  ]);
  commit(qualifiedTarget);
  expectSuccess('qualified target', qualifiedTarget);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
