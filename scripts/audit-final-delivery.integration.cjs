const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const auditScript = path.join(__dirname, 'audit-final-delivery.cjs');
const exportScript = path.join(__dirname, 'export-anonymous-submission.cjs');

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function readFile(root, relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')));
}

function writeManifest(root, options = {}) {
  const filePaths = options.filePaths || [
    'LICENSE',
    'README.txt',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'src/index.ts',
  ];
  const files = filePaths.map(relativePath => {
    const content = readFile(root, relativePath);
    return {
      path: relativePath,
      bytes: content.length,
      sha256: sha256Buffer(content),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    generatedAtUtc: '2026-09-02T00:00:00.000Z',
    sourceSnapshot: {
      gitHead: 'a'.repeat(40),
      trackedFileCount: files.length,
      trackedFileSetSha256: sha256Buffer(Buffer.from(JSON.stringify(files), 'utf8')),
      exportScriptSha256: 'b'.repeat(64),
    },
    exclusions: {},
    supplementalInputs: {
      readme: {
        deliveryPath: 'README.txt',
        bytes: readFile(root, 'README.txt').length,
        sha256: sha256Buffer(readFile(root, 'README.txt')),
      },
      videos: [],
    },
    files,
  };
  const finalManifest = options.transform ? options.transform(manifest) : manifest;
  writeFile(root, 'FINAL_DELIVERY_MANIFEST.json', `${JSON.stringify(finalManifest, null, 2)}\n`);
}

function createDeliveryFixture(root) {
  writeFile(root, 'LICENSE', 'MIT License\n');
  writeFile(root, 'README.txt', 'Repository: https://github.com/synapse-project/synapse-app\n');
  writeFile(root, 'THIRD_PARTY_NOTICES.md', '# Third Party Notices\n');
  writeFile(root, 'package.json', `${JSON.stringify({ name: 'synapse-app', private: true, license: 'MIT' }, null, 2)}\n`);
  writeFile(root, 'src/index.ts', 'export const appName = "Synapse";\n');
  writeManifest(root);
}

function runAudit(targetPath, extraArgs = []) {
  return spawnSync(process.execPath, [auditScript, targetPath, '--no-require-video', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runRequiredVideoAudit(targetPath) {
  return spawnSync(process.execPath, [auditScript, targetPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
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

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0;
}

function tryCreateTestVideo(tempRoot) {
  const candidates = [
    {
      path: path.join(tempRoot, 'private-original-name.mp4'),
      args: ['-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=1', '-an', '-map_metadata', '-1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
    },
    {
      path: path.join(tempRoot, 'private-original-name.avi'),
      args: ['-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=1', '-an', '-map_metadata', '-1', '-c:v', 'mpeg4'],
    },
  ];
  for (const candidate of candidates) {
    try {
      execFileSync('ffmpeg', ['-y', ...candidate.args, candidate.path], {
        cwd: tempRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      });
      return candidate.path;
    } catch {
      fs.rmSync(candidate.path, { force: true });
    }
  }
  return null;
}

function expectSuccess(name, targetPath, extraArgs = []) {
  const result = runAudit(targetPath, extraArgs);
  assert.equal(result.status, 0, `${name} should pass\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, `${name} should return ok=true`);
  console.log(`[pass] ${name}`);
  return parsed;
}

function expectFailure(name, targetPath, fragments, extraArgs = []) {
  const result = runAudit(targetPath, extraArgs);
  assert.notEqual(result.status, 0, `${name} should fail`);
  const output = `${result.stdout}\n${result.stderr}`;
  for (const fragment of fragments) {
    assert.match(output, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} should report "${fragment}"\n${output}`);
  }
  console.log(`[pass] ${name}`);
}

function runExporterClosureIfAvailable(tempRoot) {
  if (!commandExists('ffmpeg') || !commandExists('ffprobe')) {
    console.log('[skip] final exporter closure requires ffmpeg and ffprobe');
    return;
  }

  const sourceRoot = path.join(tempRoot, 'anonymous-source');
  const finalRoot = path.join(tempRoot, 'exported-final');
  const readmePath = path.join(tempRoot, 'external-readme.txt');
  fs.mkdirSync(sourceRoot);
  initGit(sourceRoot);
  writeFile(sourceRoot, 'LICENSE', 'MIT License\n');
  writeFile(sourceRoot, 'README.md', '# Synapse\n');
  writeFile(sourceRoot, 'THIRD_PARTY_NOTICES.md', '# Third Party Notices\n');
  writeFile(sourceRoot, 'package.json', `${JSON.stringify({ name: 'synapse-app', private: true, license: 'MIT' }, null, 2)}\n`);
  writeFile(sourceRoot, 'package-lock.json', `${JSON.stringify({ name: 'synapse-app', lockfileVersion: 3, requires: true, packages: {} }, null, 2)}\n`);
  writeFile(sourceRoot, 'src/index.ts', 'export const appName = "Synapse";\n');
  git(sourceRoot, ['add', '.']);
  git(sourceRoot, ['commit', '-m', 'Initial anonymous submission']);

  fs.writeFileSync(readmePath, 'Repository: https://github.com/synapse-project/synapse-app\n', 'utf8');
  const videoPath = tryCreateTestVideo(tempRoot);
  if (!videoPath) {
    console.log('[skip] final exporter closure could not create a tiny test video with the local ffmpeg build');
    return;
  }
  const expectedVideoName = `demo-video${path.extname(videoPath).toLowerCase()}`;

  const exportResult = spawnSync(process.execPath, [
    exportScript,
    '--final-staging',
    finalRoot,
    '--from',
    sourceRoot,
    '--readme',
    readmePath,
    '--video',
    videoPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(exportResult.status, 0, `final exporter should pass\nSTDOUT:\n${exportResult.stdout}\nSTDERR:\n${exportResult.stderr}`);
  assert.match(exportResult.stdout, /Final delivery ZIP SHA256: [a-f0-9]{64}/);
  assert.equal(fs.existsSync(`${finalRoot}.zip`), true, 'final exporter should write the ZIP beside the final directory');

  const manifestText = fs.readFileSync(path.join(finalRoot, 'FINAL_DELIVERY_MANIFEST.json'), 'utf8');
  assert.equal(manifestText.includes(tempRoot), false, 'final manifest must not contain temp absolute paths');
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.supplementalInputs.videos.map(video => video.deliveryPath), [expectedVideoName]);

  const requiredVideoAudit = runRequiredVideoAudit(`${finalRoot}.zip`);
  assert.equal(requiredVideoAudit.status, 0, `final ZIP audit with required video should pass\nSTDOUT:\n${requiredVideoAudit.stdout}\nSTDERR:\n${requiredVideoAudit.stderr}`);
  const parsedAudit = JSON.parse(requiredVideoAudit.stdout);
  assert.equal(parsedAudit.ok, true);
  assert.equal(parsedAudit.manifest.supplementalVideos.includes(expectedVideoName), true);
  console.log('[pass] final exporter writes manifest, deterministic ZIP, and required-video audit passes');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-final-delivery-'));
try {
  const validRoot = path.join(tempRoot, 'valid');
  fs.mkdirSync(validRoot);
  createDeliveryFixture(validRoot);
  const validAudit = expectSuccess('valid final delivery manifest', validRoot);
  assert.equal(validAudit.manifest.declaredFiles, 5);
  assert.equal(validAudit.manifest.verifiedFiles, 5);

  const zipA = path.join(tempRoot, 'final-a.zip');
  const zipB = path.join(tempRoot, 'final-b.zip');
  const zipAuditA = expectSuccess('deterministic zip closure A', validRoot, ['--write-zip', zipA]);
  const zipAuditB = expectSuccess('deterministic zip closure B', validRoot, ['--write-zip', zipB]);
  assert.equal(zipAuditA.zip.zipAuditOk, true);
  assert.equal(zipAuditA.zip.extractAuditOk, true);
  assert.equal(zipAuditA.zip.sha256, zipAuditB.zip.sha256, 'deterministic ZIP hashes should match for the same directory');

  const zipOnlyAudit = expectSuccess('zip target manifest audit', zipA);
  assert.equal(zipOnlyAudit.manifest.verifiedFiles, 5);

  const missingManifestRoot = path.join(tempRoot, 'missing-manifest');
  fs.mkdirSync(missingManifestRoot);
  createDeliveryFixture(missingManifestRoot);
  fs.rmSync(path.join(missingManifestRoot, 'FINAL_DELIVERY_MANIFEST.json'));
  expectFailure('missing final manifest', missingManifestRoot, ['MANIFEST_MISSING']);

  const extraFileRoot = path.join(tempRoot, 'extra-file');
  fs.mkdirSync(extraFileRoot);
  createDeliveryFixture(extraFileRoot);
  writeFile(extraFileRoot, 'extra.txt', 'not declared\n');
  expectFailure('manifest detects extra file', extraFileRoot, ['MANIFEST_FILE_EXTRA']);

  const changedFileRoot = path.join(tempRoot, 'changed-file');
  fs.mkdirSync(changedFileRoot);
  createDeliveryFixture(changedFileRoot);
  writeFile(changedFileRoot, 'src/index.ts', 'export const appName = "Changed";\n');
  expectFailure('manifest detects sha mismatch', changedFileRoot, ['MANIFEST_SHA256_MISMATCH']);

  const unsafeManifestRoot = path.join(tempRoot, 'unsafe-manifest');
  fs.mkdirSync(unsafeManifestRoot);
  createDeliveryFixture(unsafeManifestRoot);
  writeManifest(unsafeManifestRoot, {
    transform: manifest => ({
      ...manifest,
      files: [
        ...manifest.files,
        { path: '../secret.txt', bytes: 1, sha256: 'c'.repeat(64) },
      ],
    }),
  });
  expectFailure('manifest rejects unsafe relative path', unsafeManifestRoot, ['MANIFEST_PATH_INVALID']);

  const missingReadmeSupplementRoot = path.join(tempRoot, 'missing-readme-supplement');
  fs.mkdirSync(missingReadmeSupplementRoot);
  createDeliveryFixture(missingReadmeSupplementRoot);
  writeManifest(missingReadmeSupplementRoot, {
    transform: manifest => ({
      ...manifest,
      supplementalInputs: { ...manifest.supplementalInputs, readme: null },
    }),
  });
  expectFailure('manifest requires README supplement', missingReadmeSupplementRoot, ['MANIFEST_README_SUPPLEMENT_MISSING']);

  const installerRoot = path.join(tempRoot, 'installer');
  fs.mkdirSync(installerRoot);
  createDeliveryFixture(installerRoot);
  writeFile(installerRoot, 'Synapse Setup.exe', Buffer.from('MZ'));
  writeManifest(installerRoot, {
    filePaths: [
      'LICENSE',
      'README.txt',
      'THIRD_PARTY_NOTICES.md',
      'package.json',
      'src/index.ts',
      'Synapse Setup.exe',
    ],
  });
  expectFailure('final audit rejects installer payload', installerRoot, ['FORBIDDEN_EXTENSION']);

  runExporterClosureIfAvailable(tempRoot);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
