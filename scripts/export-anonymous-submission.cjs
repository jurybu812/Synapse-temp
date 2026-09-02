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
const rootDirectories = new Set(['electron', 'public', 'scripts', 'shared', 'skills', 'src', 'workflows']);
const finalStagingForbiddenDirectories = new Set([
  '.agents',
  '.codex',
  '.git',
  '.github',
  '.idea',
  '.vscode',
  'coverage',
  'credentials',
  'credential',
  'db',
  'dist',
  'dist-electron',
  'installer',
  'installers',
  'log',
  'logs',
  'node_modules',
  'plans',
  'profile',
  'profiles',
  'release',
  'tmp',
  'temp',
]);
const finalStagingRawMediaDirectories = new Set([
  'captures',
  'footage',
  'raw',
  'raw-media',
  'raw_media',
  'recording',
  'recordings',
  '原始录屏',
  '无字幕版',
]);
const finalStagingForbiddenFileNames = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.yarnrc',
  '.yarnrc.yml',
  'final_delivery_manifest.json',
]);
const finalStagingForbiddenExtensions = new Set([
  '.bak',
  '.db',
  '.deb',
  '.dmg',
  '.dpapi',
  '.exe',
  '.appx',
  '.appxbundle',
  '.key',
  '.log',
  '.msi',
  '.msix',
  '.msixbundle',
  '.p12',
  '.pem',
  '.pfx',
  '.pkg',
  '.rpm',
  '.sqlite',
  '.sqlite3',
]);
const finalStagingSourceMediaExtensions = new Set([
  '.aac',
  '.avi',
  '.flac',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.wav',
  '.webm',
]);
const finalVideoExtensions = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
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

function collectCommittedSourceFiles() {
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
    const buffer = runGit(['show', `HEAD:${relativePath}`], sourceRoot, null);
    return {
      path: relativePath,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
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

function refreshSourceManifest() {
  const initialGitState = readSourceGitState();
  if (initialGitState.sourceDirty) {
    throw new Error('Manifest refresh requires a clean source worktree; commit verified source changes first');
  }
  const sourceFiles = collectCommittedSourceFiles();
  const sourceFileSetSha256 = hashJson(sourceFiles);
  const manifest = {
    schemaVersion: 3,
    generatedAtUtc: new Date().toISOString(),
    sourceSnapshot: {
      ...initialGitState,
      sourceTrackedFileCount: sourceFiles.length,
      sourceFileSetSha256,
      targetFileSetSha256: sourceFileSetSha256,
      exportScriptSha256: crypto.createHash('sha256')
        .update(runGit(['show', 'HEAD:scripts/export-anonymous-submission.cjs'], sourceRoot, null))
        .digest('hex'),
    },
    files: sourceFiles,
  };
  fs.writeFileSync(path.join(sourceRoot, 'SUBMISSION_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Anonymous submission manifest refreshed: ${manifest.files.length} tracked files`);
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
  runGit(['config', 'core.autocrlf', 'false'], stagingRoot);
  runGit(['config', 'user.name', 'Synapse Project'], stagingRoot);
  runGit(['config', 'user.email', 'synapse-project@users.noreply.github.com'], stagingRoot);
  runGit(['add', '--all'], stagingRoot);
  runGit(['commit', '-m', 'Initial anonymous submission'], stagingRoot);
}

function runGitAt(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function assertSafeFinalSource(sourceValue, targetValue) {
  if (!sourceValue) throw new Error('Missing --from <anonymous-source-repository>');
  const resolved = path.resolve(sourceValue);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Anonymous source must be a regular directory: ${resolved}`);
  }
  const gitPath = path.join(resolved, '.git');
  const gitStat = fs.lstatSync(gitPath, { throwIfNoEntry: false });
  if (!gitStat || gitStat.isSymbolicLink()) {
    throw new Error('Anonymous source must contain its own non-symbolic .git metadata');
  }
  const sourceReal = fs.realpathSync.native(resolved);
  const targetResolved = path.resolve(targetValue);
  const targetParentReal = fs.realpathSync.native(path.dirname(targetResolved));
  const targetRealCandidate = path.join(targetParentReal, path.basename(targetResolved));
  const sourceLower = sourceReal.toLowerCase();
  const targetLower = targetRealCandidate.toLowerCase();
  if (sourceLower === targetLower || targetLower.startsWith(`${sourceLower}${path.sep}`) || sourceLower.startsWith(`${targetLower}${path.sep}`)) {
    throw new Error('Final staging target must be separate from the anonymous source repository');
  }
  const hostLower = sourceRootReal.toLowerCase();
  if (hostLower === targetLower || targetLower.startsWith(`${hostLower}${path.sep}`) || hostLower.startsWith(`${targetLower}${path.sep}`)) {
    throw new Error('Final staging target must be separate from the exporter host repository');
  }
  return { root: resolved, realRoot: sourceReal };
}

function assertSafeFinalTarget(targetValue) {
  if (!targetValue) throw new Error('Missing --final-staging <output-directory>');
  const resolved = path.resolve(targetValue);
  if (resolved === path.parse(resolved).root) throw new Error('Final staging target cannot be a filesystem root');
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Final staging target must be a regular directory or not yet exist: ${resolved}`);
  }
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Final staging parent must be an existing regular directory: ${parent}`);
  }
  return resolved;
}

function readAnonymousGitState(root) {
  const sourceHead = runGitAt(['rev-parse', 'HEAD'], root).trim();
  const status = runGitAt(['status', '--porcelain=v1', '--untracked-files=all'], root);
  return {
    sourceHead,
    sourceDirty: status.trim().length > 0,
    sourceStatusSha256: crypto.createHash('sha256').update(status).digest('hex'),
  };
}

function finalStagingExclusion(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const segments = normalized.toLowerCase().split('/').filter(Boolean);
  if (segments.some(segment => finalStagingForbiddenDirectories.has(segment))) return 'development-directory';
  if (segments.some(segment => finalStagingRawMediaDirectories.has(segment))) return 'raw-media-directory';
  const basename = path.posix.basename(normalized).toLowerCase();
  if (basename === '.env' || basename.startsWith('.env.')) return 'credential-file';
  if (finalStagingForbiddenFileNames.has(basename)) return 'credential-or-generated-file';
  if (/^(?:agents\.md|task(?:_[a-z0-9-]+)?\.md|plan_\d+.*\.md|codex[_-]?review.*|review[_-]?notes.*)$/i.test(basename)) {
    return 'workflow-artifact';
  }
  const extension = path.posix.extname(basename);
  if (finalStagingForbiddenExtensions.has(extension)) return 'credential-or-runtime-extension';
  if (finalStagingSourceMediaExtensions.has(extension)) return 'source-media';
  return null;
}

function collectFinalSourceFiles(source) {
  const output = runGitAt(['ls-files', '-z'], source.root, null);
  const trackedPaths = output.toString('utf8').split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right));
  const files = [];
  const exclusions = {};
  for (const relativePath of trackedPaths) {
    const exclusion = finalStagingExclusion(relativePath);
    if (exclusion) {
      exclusions[exclusion] = (exclusions[exclusion] || 0) + 1;
      continue;
    }
    const sourcePath = path.join(source.root, ...relativePath.split('/'));
    const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Tracked anonymous source path is not a regular file: ${relativePath}`);
    }
    const realPath = fs.realpathSync.native(sourcePath);
    if (!realPath.toLowerCase().startsWith(`${source.realRoot.toLowerCase()}${path.sep}`)) {
      throw new Error(`Tracked anonymous source path resolves outside the repository: ${relativePath}`);
    }
    files.push({ path: relativePath, bytes: stat.size, sha256: sha256(sourcePath) });
  }
  return { files, exclusions };
}

function copyFinalSourceFiles(files, sourceRoot, targetRoot) {
  for (const item of files) {
    const sourcePath = path.join(sourceRoot, ...item.path.split('/'));
    const targetPath = path.join(targetRoot, ...item.path.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function assertRegularSupplementalFile(fileValue, label) {
  if (!fileValue) return null;
  const resolved = path.resolve(fileValue);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${resolved}`);
  return { path: resolved, bytes: stat.size, sha256: sha256(resolved) };
}

function copyFinalSupplements(stagingRoot, sourceFiles) {
  const sourcePathSet = new Set(sourceFiles.map(item => item.path.toLowerCase()));
  const readmeInput = assertRegularSupplementalFile(argumentValue('--readme'), '--readme');
  if (readmeInput) {
    fs.copyFileSync(readmeInput.path, path.join(stagingRoot, 'README.txt'));
  } else if (!sourcePathSet.has('readme.txt')) {
    throw new Error('Final staging requires --readme <README.txt> when the anonymous source has no tracked README.txt');
  }

  const videos = [];
  const targetNames = new Set();
  for (const videoValue of argumentValues('--video')) {
    const video = assertRegularSupplementalFile(videoValue, '--video');
    const extension = path.extname(video.path).toLowerCase();
    if (!finalVideoExtensions.has(extension)) throw new Error(`Unsupported final video extension: ${extension || '<none>'}`);
    const targetName = videos.length === 0 ? `demo-video${extension}` : `demo-video-${videos.length + 1}${extension}`;
    const collisionKey = targetName.toLowerCase();
    if (targetNames.has(collisionKey) || sourcePathSet.has(collisionKey)) {
      throw new Error(`Duplicate final video target name: ${targetName}`);
    }
    targetNames.add(collisionKey);
    fs.copyFileSync(video.path, path.join(stagingRoot, targetName));
    videos.push({ deliveryPath: targetName, bytes: video.bytes, sha256: video.sha256 });
  }
  return {
    readme: readmeInput ? { deliveryPath: 'README.txt', bytes: readmeInput.bytes, sha256: readmeInput.sha256 } : null,
    videos,
  };
}

function collectFinalDeliveryFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in final staging: ${fullPath}`);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name !== 'FINAL_DELIVERY_MANIFEST.json') {
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

function runFinalDeliveryAudit(stagingRoot, extraArgs = []) {
  try {
    return execFileSync(process.execPath, [path.join(sourceRoot, 'scripts', 'audit-final-delivery.cjs'), stagingRoot, ...extraArgs], {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const details = String(error.stdout || error.stderr || error.message).trim();
    throw new Error(`Final delivery audit failed before publication${details ? `:\n${details}` : ''}`);
  }
}

function parseFinalAuditOutput(output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Final delivery audit returned non-JSON output: ${error.message}`);
  }
}

function assertSafeFinalZipTarget(zipValue, targetRoot, source) {
  const resolved = path.resolve(zipValue || `${targetRoot}.zip`);
  if (path.extname(resolved).toLowerCase() !== '.zip') {
    throw new Error('Final delivery ZIP path must end with .zip');
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Final delivery ZIP target must be a regular file or not yet exist: ${resolved}`);
  }
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Final delivery ZIP parent must be an existing regular directory: ${parent}`);
  }
  const parentReal = fs.realpathSync.native(parent);
  const zipRealCandidate = path.join(parentReal, path.basename(resolved));
  const zipLower = zipRealCandidate.toLowerCase();
  const targetResolved = path.resolve(targetRoot);
  const targetParentReal = fs.realpathSync.native(path.dirname(targetResolved));
  const targetRealCandidate = path.join(targetParentReal, path.basename(targetResolved)).toLowerCase();
  const sourceLower = source.realRoot.toLowerCase();
  const hostLower = sourceRootReal.toLowerCase();
  if (zipLower === targetRealCandidate || zipLower.startsWith(`${targetRealCandidate}${path.sep}`)) {
    throw new Error('Final delivery ZIP target must be outside the final staging directory');
  }
  if (zipLower === sourceLower || zipLower.startsWith(`${sourceLower}${path.sep}`)) {
    throw new Error('Final delivery ZIP target must be outside the anonymous source repository');
  }
  if (zipLower === hostLower || zipLower.startsWith(`${hostLower}${path.sep}`)) {
    throw new Error('Final delivery ZIP target must be outside the exporter host repository');
  }
  return resolved;
}

function reserveFinalZipTarget(zipPath, replace) {
  const existing = fs.statSync(zipPath, { throwIfNoEntry: false });
  if (existing && !replace) {
    throw new Error(`Final delivery ZIP already exists; rerun with --replace after reviewing: ${zipPath}`);
  }
}

function publishFinalZip(zipPath, tempZipPath, replace) {
  const backupPath = `${zipPath}.backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let backupCreated = false;
  try {
    if (fs.statSync(zipPath, { throwIfNoEntry: false })) {
      if (!replace) throw new Error(`Final delivery ZIP already exists; rerun with --replace after reviewing: ${zipPath}`);
      fs.renameSync(zipPath, backupPath);
      backupCreated = true;
    }
    fs.renameSync(tempZipPath, zipPath);
    if (backupCreated) fs.rmSync(backupPath, { force: true });
  } catch (error) {
    if (backupCreated && !fs.statSync(zipPath, { throwIfNoEntry: false })) {
      fs.renameSync(backupPath, zipPath);
    }
    throw error;
  }
}

function publishFinalStaging(targetRoot, stagingRoot, backupRoot, replace) {
  const targetStat = fs.statSync(targetRoot, { throwIfNoEntry: false });
  if (!targetStat) {
    fs.renameSync(stagingRoot, targetRoot);
    return;
  }
  const existing = fs.readdirSync(targetRoot);
  if (existing.length > 0 && !replace) {
    throw new Error(`Final staging target is not empty; rerun with --replace after reviewing: ${existing.join(', ')}`);
  }
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
    console.warn(`Final staging export succeeded, but the previous target backup could not be removed: ${backupRoot}`);
  }
}

function exportFinalStaging(targetValue) {
  const targetRoot = assertSafeFinalTarget(targetValue);
  const source = assertSafeFinalSource(argumentValue('--from'), targetRoot);
  const replace = process.argv.includes('--replace');
  const zipPath = assertSafeFinalZipTarget(argumentValue('--zip'), targetRoot, source);
  reserveFinalZipTarget(zipPath, replace);
  const initialGitState = readAnonymousGitState(source.root);
  if (initialGitState.sourceDirty) {
    throw new Error('Final staging export requires a clean anonymous source worktree');
  }
  const sourceCollection = collectFinalSourceFiles(source);
  const sourceFileSetSha256 = hashJson(sourceCollection.files);
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const stagingRoot = `${targetRoot}.final-staging-${suffix}`;
  const backupRoot = `${targetRoot}.final-backup-${suffix}`;
  const tempZipPath = path.join(path.dirname(zipPath), `.${path.basename(zipPath)}.final-staging-${suffix}.zip`);
  if (fs.statSync(stagingRoot, { throwIfNoEntry: false }) || fs.statSync(backupRoot, { throwIfNoEntry: false })) {
    throw new Error('Final staging or backup path already exists');
  }
  if (fs.statSync(tempZipPath, { throwIfNoEntry: false })) {
    throw new Error('Final staging ZIP temp path already exists');
  }

  try {
    fs.mkdirSync(stagingRoot, { recursive: false });
    copyFinalSourceFiles(sourceCollection.files, source.root, stagingRoot);
    const inputs = copyFinalSupplements(stagingRoot, sourceCollection.files);
    const deliveryFiles = collectFinalDeliveryFiles(stagingRoot);
    const manifest = {
      schemaVersion: 1,
      generatedAtUtc: new Date().toISOString(),
      sourceSnapshot: {
        gitHead: initialGitState.sourceHead,
        trackedFileCount: sourceCollection.files.length,
        trackedFileSetSha256: sourceFileSetSha256,
        exportScriptSha256: sha256(__filename),
      },
      exclusions: sourceCollection.exclusions,
      supplementalInputs: inputs,
      files: deliveryFiles,
    };
    fs.writeFileSync(path.join(stagingRoot, 'FINAL_DELIVERY_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const finalGitState = readAnonymousGitState(source.root);
    if (finalGitState.sourceDirty || finalGitState.sourceHead !== initialGitState.sourceHead
      || finalGitState.sourceStatusSha256 !== initialGitState.sourceStatusSha256
      || hashJson(collectFinalSourceFiles(source).files) !== sourceFileSetSha256) {
      throw new Error('Anonymous source worktree changed while final staging was being exported');
    }
    runFinalDeliveryAudit(stagingRoot);
    const zipAudit = parseFinalAuditOutput(runFinalDeliveryAudit(stagingRoot, ['--write-zip', tempZipPath]));
    if (!zipAudit.ok || !zipAudit.zip?.sha256 || zipAudit.zip.zipAuditOk !== true || zipAudit.zip.extractAuditOk !== true) {
      throw new Error('Final delivery ZIP audit did not complete the zip and extracted-directory verification chain');
    }
    publishFinalStaging(targetRoot, stagingRoot, backupRoot, replace);
    publishFinalZip(zipPath, tempZipPath, replace);
    const publishedZipSha256 = sha256(zipPath);
    if (publishedZipSha256 !== zipAudit.zip.sha256) {
      throw new Error('Published final delivery ZIP SHA256 differs from the audited temporary ZIP');
    }
    console.log(`Final staging export complete: ${manifest.files.length} files plus manifest`);
    console.log(`Final delivery ZIP complete: ${zipPath}`);
    console.log(`Final delivery ZIP SHA256: ${publishedZipSha256}`);
  } catch (error) {
    removeIfPresent(stagingRoot);
    removeIfPresent(tempZipPath);
    if (fs.statSync(backupRoot, { throwIfNoEntry: false }) && !fs.statSync(targetRoot, { throwIfNoEntry: false })) {
      fs.renameSync(backupRoot, targetRoot);
    }
    throw error;
  }
}

function printUsage() {
  process.stdout.write([
    'Anonymous repository export:',
    '  node scripts/export-anonymous-submission.cjs --target <empty-git-repository> [--replace]',
    '  node scripts/export-anonymous-submission.cjs --refresh-manifest',
    '',
    'Final staging export:',
    '  node scripts/export-anonymous-submission.cjs --final-staging <output-directory> --from <anonymous-repository> --readme <README.txt> --video <final-video> [--video <path> ...] [--zip <final.zip>] [--replace]',
    '  Without --zip, the final ZIP is written beside the directory as <output-directory>.zip.',
    '',
  ].join('\n'));
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

if (process.argv.includes('--refresh-manifest')) {
  refreshSourceManifest();
  process.exit(0);
}

const finalStagingTarget = argumentValue('--final-staging');
if (finalStagingTarget) {
  exportFinalStaging(finalStagingTarget);
  process.exit(0);
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
