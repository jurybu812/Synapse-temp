const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '..');
const sourceRootReal = fs.realpathSync.native(sourceRoot);
const rootFiles = new Set([
  '.gitignore',
  'eslint.config.js',
  'index.html',
  'LICENSE',
  'package-lock.json',
  'package.json',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'tsconfig.app.json',
  'tsconfig.electron.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
]);
const rootDirectories = new Set(['electron', 'public', 'scripts', 'skills', 'src', 'workflows']);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function runGit(args, cwd = sourceRoot, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function assertSafeTarget(targetRoot) {
  if (!targetRoot) throw new Error('Missing --target <empty-git-repository>');
  const resolved = path.resolve(targetRoot);
  if (resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`) || sourceRoot.startsWith(`${resolved}${path.sep}`)) {
    throw new Error('Submission target must be separate from the source repository');
  }
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Submission target does not exist: ${resolved}`);
  }
  if (!fs.statSync(path.join(resolved, '.git'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Submission target must already contain its own .git directory');
  }
  if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Submission target cannot be a symbolic link or junction');
  const resolvedReal = fs.realpathSync.native(resolved);
  if (resolvedReal === sourceRootReal || resolvedReal.startsWith(`${sourceRootReal}${path.sep}`) || sourceRootReal.startsWith(`${resolvedReal}${path.sep}`)) {
    throw new Error('Submission target real path must be separate from the source repository');
  }
  return resolved;
}

function assertSafeTree(root) {
  const rootReal = fs.realpathSync.native(root);
  const prefix = `${rootReal}${path.sep}`;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links or junctions are not allowed: ${fullPath}`);
      const realPath = fs.realpathSync.native(fullPath);
      if (!realPath.startsWith(prefix)) throw new Error(`Submission entry resolves outside target root: ${fullPath}`);
      if (entry.isDirectory()) visit(fullPath);
    }
  };
  visit(root);
}

function isAllowedTrackedPath(relativePath) {
  if (rootFiles.has(relativePath)) return true;
  const [topLevel] = relativePath.split('/');
  return rootDirectories.has(topLevel) && relativePath.startsWith(`${topLevel}/`);
}

function readSourceGitState() {
  const sourceHead = runGit(['rev-parse', 'HEAD']).trim();
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    sourceHead,
    sourceDirty: status.trim().length > 0,
    sourceStatusSha256: crypto.createHash('sha256').update(status).digest('hex'),
  };
}

function collectTrackedSourceFiles() {
  const output = runGit(['ls-files', '-z', '--', ...rootFiles, ...rootDirectories], sourceRoot, null);
  const trackedPaths = output.toString('utf8').split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right));
  const trackedSet = new Set(trackedPaths);
  for (const fileName of rootFiles) {
    if (!trackedSet.has(fileName)) throw new Error(`Required source file is not tracked by Git: ${fileName}`);
  }
  for (const directoryName of rootDirectories) {
    if (!trackedPaths.some(fileName => fileName.startsWith(`${directoryName}/`))) {
      throw new Error(`Required source directory has no tracked files: ${directoryName}`);
    }
  }
  return trackedPaths.map(relativePath => {
    if (!isAllowedTrackedPath(relativePath)) throw new Error(`Tracked path is outside the submission allowlist: ${relativePath}`);
    const sourcePath = path.join(sourceRoot, ...relativePath.split('/'));
    const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Tracked source path is not a regular file: ${relativePath}`);
    const realPath = fs.realpathSync.native(sourcePath);
    if (!realPath.startsWith(`${sourceRootReal}${path.sep}`)) throw new Error(`Tracked source path resolves outside the source root: ${relativePath}`);
    return { path: relativePath, bytes: stat.size, sha256: sha256(sourcePath) };
  });
}

function copyTrackedFiles(files, targetRoot) {
  for (const item of files) {
    const sourcePath = path.join(sourceRoot, ...item.path.split('/'));
    const targetPath = path.join(targetRoot, ...item.path.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function collectManifest(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'SUBMISSION_MANIFEST.json') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in submission export: ${fullPath}`);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(root, fullPath).split(path.sep).join('/'),
          bytes: fs.statSync(fullPath).size,
          sha256: sha256(fullPath),
        });
      }
    }
  };
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function removeIfPresent(targetPath) {
  if (fs.statSync(targetPath, { throwIfNoEntry: false })) fs.rmSync(targetPath, { recursive: true, force: true });
}

function replaceDirectoryTransactional(targetRoot, stagingRoot, backupRoot) {
  fs.renameSync(targetRoot, backupRoot);
  try {
    fs.renameSync(stagingRoot, targetRoot);
  } catch (error) {
    fs.renameSync(backupRoot, targetRoot);
    throw error;
  }
  try {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch {
    console.warn(`Submission export succeeded, but the previous target backup could not be removed: ${backupRoot}`);
  }
}

function initializeAnonymousRepository(stagingRoot) {
  runGit(['init', '--initial-branch=main'], stagingRoot);
  runGit(['config', 'user.name', 'Synapse Project'], stagingRoot);
  runGit(['config', 'user.email', 'synapse-project@users.noreply.github.com'], stagingRoot);
  runGit(['add', '--all'], stagingRoot);
  runGit(['commit', '-m', 'Initial anonymous submission'], stagingRoot);
}

const targetRoot = assertSafeTarget(argumentValue('--target'));
assertSafeTree(targetRoot);
const replace = process.argv.includes('--replace');
const existing = fs.readdirSync(targetRoot).filter(name => name !== '.git');
if (existing.length > 0 && !replace) {
  throw new Error(`Submission target is not empty; rerun with --replace after reviewing: ${existing.join(', ')}`);
}

const initialGitState = readSourceGitState();
if (initialGitState.sourceDirty) {
  throw new Error('Submission export requires a clean source worktree; commit the verified candidate before replacing the anonymous target');
}
const sourceFiles = collectTrackedSourceFiles();
const sourceFileSetSha256 = hashJson(sourceFiles);

const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
const stagingRoot = `${targetRoot}.submission-staging-${suffix}`;
const backupRoot = `${targetRoot}.submission-backup-${suffix}`;
if (fs.statSync(stagingRoot, { throwIfNoEntry: false }) || fs.statSync(backupRoot, { throwIfNoEntry: false })) {
  throw new Error('Submission staging or backup path already exists');
}

try {
  fs.mkdirSync(stagingRoot, { recursive: false });
  copyTrackedFiles(sourceFiles, stagingRoot);
  const targetFiles = collectManifest(stagingRoot);
  if (JSON.stringify(targetFiles) !== JSON.stringify(sourceFiles)) {
    throw new Error('Submission staging file set does not exactly match the tracked source file set');
  }

  const manifest = {
    schemaVersion: 3,
    generatedAtUtc: new Date().toISOString(),
    sourceSnapshot: {
      ...initialGitState,
      sourceTrackedFileCount: sourceFiles.length,
      sourceFileSetSha256,
      targetFileSetSha256: hashJson(targetFiles),
      exportScriptSha256: sha256(__filename),
    },
    files: targetFiles,
  };
  fs.writeFileSync(path.join(stagingRoot, 'SUBMISSION_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const finalGitState = readSourceGitState();
  if (finalGitState.sourceDirty || finalGitState.sourceHead !== initialGitState.sourceHead
    || finalGitState.sourceStatusSha256 !== initialGitState.sourceStatusSha256
    || hashJson(collectTrackedSourceFiles()) !== sourceFileSetSha256) {
    throw new Error('Source worktree changed while the anonymous submission was being staged');
  }

  initializeAnonymousRepository(stagingRoot);
  execFileSync(process.execPath, [path.join(sourceRoot, 'scripts', 'audit-anonymous-submission.cjs'), stagingRoot], {
    cwd: sourceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });
  replaceDirectoryTransactional(targetRoot, stagingRoot, backupRoot);
  console.log(`Anonymous submission export complete: ${manifest.files.length} tracked files`);
} catch (error) {
  removeIfPresent(stagingRoot);
  if (fs.statSync(backupRoot, { throwIfNoEntry: false }) && !fs.statSync(targetRoot, { throwIfNoEntry: false })) {
    fs.renameSync(backupRoot, targetRoot);
  }
  throw error;
}
