const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (!process.argv[2]) throw new Error('Usage: node scripts/audit-anonymous-submission.cjs <submission-root>');
const root = path.resolve(process.argv[2]);
const rootRealPath = fs.realpathSync.native(root);
const rootPrefix = `${root}${path.sep}`;
const rootRealPrefix = `${rootRealPath}${path.sep}`;
const failures = [];
const allowedTopLevel = new Set([
  '.git', '.gitignore', 'SUBMISSION_MANIFEST.json', 'electron', 'eslint.config.js', 'index.html', 'LICENSE',
  'package-lock.json', 'package.json', 'public', 'README.md', 'scripts', 'skills', 'src',
  'THIRD_PARTY_NOTICES.md', 'tsconfig.app.json', 'tsconfig.electron.json', 'tsconfig.json',
  'tsconfig.node.json', 'vite.config.ts', 'workflows',
]);
const forbiddenNames = new Set([
  '.agents', '.codex', '.env', 'coverage', 'dist', 'dist-electron', 'logs', 'node_modules', 'plans', 'release',
]);
const forbiddenFileNames = new Set(['.npmrc', '.netrc', '.pypirc', '.yarnrc', '.yarnrc.yml']);
const forbiddenExtensions = new Set(['.db', '.dpapi', '.key', '.log', '.p12', '.pem', '.pfx', '.sqlite', '.sqlite3']);
const textExtensions = new Set([
  '.cjs', '.css', '.gitignore', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.ts', '.tsx', '.txt', '.yml', '.yaml',
]);
const home = os.homedir();
const username = os.userInfo().username;
const privateWorkspaceMarker = '\u0056\u0043\u5de5\u5177\u5305';
const fetcherArtifactMarker = ['mcp', 'web', 'fetcher'].join('-');
const forbiddenContent = [
  { label: 'absolute user path', regex: /C:[\\/]Users[\\/][^\\/\s"']+/gi },
  { label: 'local AppData path', regex: /AppData[\\/]Local/gi },
  { label: 'workspace private path', regex: new RegExp(`${privateWorkspaceMarker}|${fetcherArtifactMarker}`, 'gi') },
  { label: 'Codex provenance trailer', regex: /Codex-(?:Thread|Machine|Task):/gi },
  { label: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { label: 'OpenAI-style secret', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~-]{30,}\b/g },
];
if (home) forbiddenContent.push({ label: 'current home path', regex: new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') });
if (username && username.length >= 4) forbiddenContent.push({ label: 'current username', regex: new RegExp(`\\b${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi') });

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runGit(args, options = {}) {
  const { allowFailure = false, encoding = 'utf8' } = options;
  try {
    const output = execFileSync('git', args, {
      cwd: root,
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: typeof output === 'string' ? output.trim() : output };
  } catch (error) {
    if (!allowFailure) throw error;
    const rawOutput = error.stdout;
    const output = encoding === null
      ? (Buffer.isBuffer(rawOutput) ? rawOutput : Buffer.alloc(0))
      : (typeof rawOutput === 'string' ? rawOutput.trim() : Buffer.isBuffer(rawOutput) ? rawOutput.toString('utf8').trim() : '');
    return { ok: false, output };
  }
}

function readGitLines(args) {
  const result = runGit(args);
  return result.output.split(/\r?\n/).filter(Boolean);
}

function resolveManifestFile(itemPath) {
  if (typeof itemPath !== 'string' || itemPath.length === 0 || itemPath.includes('\0') || itemPath.includes('\\')) {
    return null;
  }
  if (path.posix.isAbsolute(itemPath) || path.win32.isAbsolute(itemPath) || path.posix.normalize(itemPath) !== itemPath) {
    return null;
  }
  const segments = itemPath.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..') || segments[0] === '.git') {
    return null;
  }
  const filePath = path.resolve(root, ...segments);
  if (!filePath.startsWith(rootPrefix)) return null;
  const fileStat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) return null;
  const realPath = fs.realpathSync.native(filePath);
  if (!realPath.startsWith(rootRealPrefix)) return null;
  return filePath;
}

function inspectPng(label, buffer) {
  if (buffer.length < 8 || buffer.subarray(1, 4).toString('ascii') !== 'PNG') return;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (['eXIf', 'iTXt', 'tEXt', 'zTXt'].includes(type)) failures.push(`${label} contains PNG metadata chunk ${type}`);
    offset += 12 + length;
  }
}

function inspectJpeg(label, buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return;
  if (buffer.includes(Buffer.from('Exif\0\0')) || buffer.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))) {
    failures.push(`${label} contains JPEG EXIF/XMP metadata`);
  }
}

function pathLooksSensitive(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const segments = normalized.split('/');
  return segments.some(segment => forbiddenNames.has(segment) || forbiddenFileNames.has(segment.toLowerCase()))
    || forbiddenExtensions.has(path.posix.extname(normalized).toLowerCase())
    || /Codex_Review|报告_|Stage_\d|Plan_\d|Task\.md/i.test(normalized);
}

function inspectText(label, buffer) {
  const text = buffer.toString('utf8');
  for (const pattern of forbiddenContent) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) failures.push(`${label} contains ${pattern.label}`);
  }
}

function walk(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const fullPath = path.join(directory, entry.name);
    if (forbiddenNames.has(entry.name)) failures.push(`${relative(fullPath)} is forbidden`);
    if (pathLooksSensitive(relative(fullPath))) failures.push(`${relative(fullPath)} has a forbidden private or generated path`);
    if (entry.isSymbolicLink()) failures.push(`${relative(fullPath)} is a symbolic link`);
    else if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile()) files.push(fullPath);
  }
}

if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Submission root does not exist: ${root}`);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!allowedTopLevel.has(entry.name)) failures.push(`Unexpected top-level entry: ${entry.name}`);
}

const files = [];
walk(root, files);
for (const filePath of files) {
  const buffer = fs.readFileSync(filePath);
  const label = relative(filePath);
  inspectPng(label, buffer);
  inspectJpeg(label, buffer);
  const extension = path.extname(filePath).toLowerCase();
  if (textExtensions.has(extension) || textExtensions.has(path.basename(filePath).toLowerCase()) || path.basename(filePath) === 'LICENSE') {
    inspectText(label, buffer);
  }
}

const requiredFiles = ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'SUBMISSION_MANIFEST.json'];
for (const fileName of requiredFiles) {
  if (!fs.statSync(path.join(root, fileName), { throwIfNoEntry: false })?.isFile()) failures.push(`Missing required file: ${fileName}`);
}

const manifestPath = path.join(root, 'SUBMISSION_MANIFEST.json');
if (fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifest.schemaVersion !== 3) failures.push(`Unsupported manifest schema: ${manifest.schemaVersion}`);
  if (!Array.isArray(manifest.files)) failures.push('Manifest files must be an array');
  if (typeof manifest.generatedAtUtc !== 'string' || Number.isNaN(Date.parse(manifest.generatedAtUtc))) failures.push('Manifest generation time is invalid');
  const snapshot = manifest.sourceSnapshot;
  if (!snapshot || typeof snapshot !== 'object'
    || !/^[a-f0-9]{40}$/.test(snapshot.sourceHead || '')
    || typeof snapshot.sourceDirty !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(snapshot.sourceStatusSha256 || '')
    || !Number.isSafeInteger(snapshot.sourceTrackedFileCount)
    || snapshot.sourceTrackedFileCount < 1
    || !/^[a-f0-9]{64}$/.test(snapshot.sourceFileSetSha256 || '')
    || !/^[a-f0-9]{64}$/.test(snapshot.targetFileSetSha256 || '')
    || !/^[a-f0-9]{64}$/.test(snapshot.exportScriptSha256 || '')) {
    failures.push('Manifest source snapshot is invalid');
  }
  if (snapshot?.sourceDirty !== false) failures.push('Manifest source snapshot must come from a clean worktree');
  const manifestPaths = new Set();
  const auditedPaths = new Set(files.map(filePath => relative(filePath)).filter(fileName => fileName !== 'SUBMISSION_MANIFEST.json'));
  for (const item of manifestFiles) {
    const itemPath = item?.path;
    if (manifestPaths.has(itemPath)) failures.push(`Duplicate manifest path: ${itemPath}`);
    manifestPaths.add(itemPath);
    const filePath = resolveManifestFile(itemPath);
    if (!filePath || !auditedPaths.has(itemPath)) {
      failures.push(`Unsafe or untracked manifest path: ${itemPath}`);
      continue;
    }
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) {
      failures.push(`Invalid manifest metadata: ${itemPath}`);
      continue;
    }
    if (fs.statSync(filePath).size !== item.bytes || sha256(filePath) !== item.sha256) failures.push(`Manifest mismatch: ${itemPath}`);
  }
  const computedFileSetSha256 = crypto.createHash('sha256').update(JSON.stringify(manifestFiles)).digest('hex');
  if (snapshot?.sourceFileSetSha256 !== computedFileSetSha256) failures.push('Manifest source file-set hash does not match files');
  if (snapshot?.targetFileSetSha256 !== computedFileSetSha256) failures.push('Manifest target file-set hash does not match files');
  if (snapshot?.sourceTrackedFileCount !== manifestFiles.length) failures.push('Manifest tracked file count does not match files');
  const exportedScriptPath = path.join(root, 'scripts', 'export-anonymous-submission.cjs');
  if (fs.statSync(exportedScriptPath, { throwIfNoEntry: false })?.isFile()
    && snapshot?.exportScriptSha256 !== sha256(exportedScriptPath)) failures.push('Manifest export-script hash does not match exporter');
  for (const filePath of files) {
    const fileName = relative(filePath);
    if (fileName !== 'SUBMISSION_MANIFEST.json' && !manifestPaths.has(fileName)) failures.push(`File missing from manifest: ${fileName}`);
  }
}

const gitDirectory = path.join(root, '.git');
if (!fs.statSync(gitDirectory, { throwIfNoEntry: false })?.isDirectory()) {
  failures.push('Anonymous submission must be an independent Git repository');
} else {
  const remotes = runGit(['remote', '-v']).output;
  if (remotes) failures.push('Git remote is configured; remove it before anonymous handoff');
  const configuredName = runGit(['config', '--local', '--get', 'user.name'], { allowFailure: true }).output;
  const configuredEmail = runGit(['config', '--local', '--get', 'user.email'], { allowFailure: true }).output;
  if (configuredName !== 'Synapse Project') failures.push('Git local author name must be the neutral identity "Synapse Project"');
  if (!/^[^@\s]+@users\.noreply\.github\.com$/i.test(configuredEmail)) failures.push('Git local author email must use a GitHub noreply address');

  const headCommit = runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
  if (!headCommit.ok) failures.push('Git HEAD commit is required for anonymous audit');

  const refsResult = runGit(['for-each-ref', '--format=%(refname)'], { allowFailure: true });
  const refs = refsResult.ok ? refsResult.output.split(/\r?\n/).filter(Boolean) : [];
  const hasOnlyMainRef = refs.length === 1 && refs[0] === 'refs/heads/main';
  if (!refsResult.ok) failures.push('Git refs could not be inspected');
  if (!hasOnlyMainRef) failures.push(`Anonymous Git refs must contain exactly refs/heads/main; found: ${refs.length > 0 ? refs.join(', ') : 'none'}`);

  const mainCommit = runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { allowFailure: true });
  const headMatchesMain = headCommit.ok && mainCommit.ok && headCommit.output === mainCommit.output;
  if (headCommit.ok && hasOnlyMainRef && !headMatchesMain) failures.push('Git HEAD must resolve to refs/heads/main');

  const status = runGit(['status', '--porcelain=v1', '--untracked-files=normal'], { allowFailure: true });
  if (!status.ok) failures.push('Git worktree status could not be inspected');
  if (status.ok && status.output) failures.push('Git worktree must be clean before anonymous audit');

  const manifestTracked = runGit(['ls-files', '--error-unmatch', '--', 'SUBMISSION_MANIFEST.json'], { allowFailure: true }).ok;
  const manifestInHead = runGit(['cat-file', '-e', 'HEAD:SUBMISSION_MANIFEST.json'], { allowFailure: true }).ok;
  if (!manifestTracked) failures.push('SUBMISSION_MANIFEST.json must be tracked by Git');
  if (!manifestInHead) failures.push('SUBMISSION_MANIFEST.json must be present in HEAD');

  const canInspectHistory = headCommit.ok && hasOnlyMainRef && headMatchesMain
    && status.ok && !status.output && manifestTracked && manifestInHead;
  if (!canInspectHistory) {
    failures.push('Git history scan requires committed main HEAD, clean worktree, and committed manifest');
  } else {
    const identities = runGit(['log', '--format=%an%x09%ae%x09%cn%x09%ce', '--all']).output;
    for (const identity of identities.split(/\r?\n/).filter(Boolean)) {
      const [authorName, authorEmail, committerName, committerEmail] = identity.split('\t');
      if (authorName !== 'Synapse Project' || committerName !== 'Synapse Project'
        || !/^[^@\s]+@users\.noreply\.github\.com$/i.test(authorEmail || '')
        || !/^[^@\s]+@users\.noreply\.github\.com$/i.test(committerEmail || '')) {
        failures.push(`Git history contains a non-neutral identity: ${identity}`);
      }
    }

    const log = runGit(['log', '--format=%an%x09%ae%x09%B', '--all']).output;
    const privateAuthorMarker = ['Ju', 'ry'].join('');
    if (new RegExp(`Codex-(?:Thread|Machine|Task):|${username}|${privateAuthorMarker}`, 'i').test(log)) {
      failures.push('Git history contains private provenance');
    }

    const objectLines = readGitLines(['rev-list', '--objects', '--all']);
    const inspectedBlobs = new Set();
    for (const line of objectLines) {
      const separator = line.indexOf(' ');
      const objectId = separator >= 0 ? line.slice(0, separator) : line;
      const objectPath = separator >= 0 ? line.slice(separator + 1) : '';
      if (objectPath && pathLooksSensitive(objectPath)) failures.push(`Git history contains a forbidden path: ${objectPath}`);
      if (!objectPath || inspectedBlobs.has(objectId)) continue;
      const objectType = execFileSync('git', ['cat-file', '-t', objectId], { cwd: root, encoding: 'utf8' }).trim();
      if (objectType !== 'blob') continue;
      inspectedBlobs.add(objectId);
      const extension = path.posix.extname(objectPath).toLowerCase();
      const baseName = path.posix.basename(objectPath);
      if (!textExtensions.has(extension) && !textExtensions.has(baseName.toLowerCase()) && baseName !== 'LICENSE'
        && !['.png', '.jpg', '.jpeg'].includes(extension)) continue;
      const buffer = execFileSync('git', ['cat-file', '-p', objectId], {
        cwd: root,
        encoding: null,
        maxBuffer: 64 * 1024 * 1024,
      });
      const label = `Git history blob ${objectPath}`;
      inspectPng(label, buffer);
      inspectJpeg(label, buffer);
      if (textExtensions.has(extension) || textExtensions.has(baseName.toLowerCase()) || baseName === 'LICENSE') {
        inspectText(label, buffer);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Anonymous submission audit failed (${failures.length}):`);
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Anonymous submission audit passed: ${files.length} files`);
