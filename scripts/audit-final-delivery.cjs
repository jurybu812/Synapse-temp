const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const maxTotalBytes = 200 * 1024 * 1024;
const maxTextBytes = 4 * 1024 * 1024;
const maxZipEntryBytes = 64 * 1024 * 1024;
const maxNestedZipDepth = 3;

const input = parseArguments(process.argv.slice(2));
if (input.help) {
  printUsage();
  process.exit(0);
}
const maxVideoSeconds = input.maxVideoSeconds;
const result = {
  ok: false,
  target: null,
  limits: {
    maxTotalBytes,
    maxVideoSeconds,
    maxTextBytes,
    maxZipEntryBytes,
    maxNestedZipDepth,
  },
  totals: {
    packageBytes: 0,
    combinedBytes: 0,
    files: 0,
    zipEntries: 0,
    textFilesScanned: 0,
    mediaFilesScanned: 0,
    nestedArchivesScanned: 0,
  },
  readme: {
    present: false,
    gitLinks: [],
  },
  manifest: {
    present: false,
    path: null,
    schemaVersion: null,
    declaredFiles: 0,
    actualFiles: 0,
    verifiedFiles: 0,
    supplementalReadme: null,
    supplementalVideos: [],
  },
  requirements: { ...input.requirements },
  videos: {
    package: [],
    extra: [],
  },
  ffprobe: {
    available: false,
    checkedVideos: [],
  },
  zip: {
    path: null,
    bytes: null,
    sha256: null,
    entries: 0,
    zipAuditOk: null,
    extractAuditOk: null,
  },
  failures: [],
  warnings: [],
};

try {
  if (!input.targetPath) {
    fail('USAGE', '<argument>', 'Usage: node scripts/audit-final-delivery.cjs <staging-dir|zip-file|extracted-dir> [video-path|--video <path>]');
    finish();
  }

  const targetPath = path.resolve(input.targetPath);
  const targetStat = fs.statSync(targetPath, { throwIfNoEntry: false });
  if (!targetStat) {
    fail('TARGET_MISSING', targetPath, 'Delivery target does not exist');
    finish();
  }

  const targetKind = targetStat.isDirectory() ? 'directory' : targetStat.isFile() && path.extname(targetPath).toLowerCase() === '.zip' ? 'zip' : 'unsupported';
  result.target = { path: targetPath, kind: targetKind };
  if (targetKind === 'unsupported') {
    fail('TARGET_UNSUPPORTED', targetPath, 'Target must be a directory or a .zip file');
    finish();
  }

  result.ffprobe.available = commandExists('ffprobe');
  const packageContext = targetKind === 'directory'
    ? collectDirectoryPackage(targetPath)
    : collectZipPackage(targetPath);
  result.totals.packageBytes = packageContext.totalBytes;
  result.totals.combinedBytes = packageContext.totalBytes;
  result.target.logicalRoot = packageContext.logicalRoot;

  const extraVideos = resolveExtraVideos(input.videoPaths);
  const packageVideoEntries = packageContext.entries.filter(entry => !entry.isDirectory && isVideoPath(entry.relativePath));
  const packageVideoRealPaths = new Set(packageVideoEntries
    .filter(entry => entry.fullPath)
    .map(entry => fs.realpathSync.native(entry.fullPath).toLowerCase()));
  for (const video of extraVideos) {
    const isZipProof = packageContext.kind === 'zip' && packageVideoEntries.some(entry => matchesPackageVideo(entry, video));
    if ((!packageContext.realRoot || !isInsideRealRoot(video.realPath, packageContext.realRoot)) && !isZipProof) {
      result.totals.combinedBytes += video.bytes;
    }
    if (!packageVideoRealPaths.has(video.realPath.toLowerCase())) inspectDiskVideo(video.path, video.label);
  }

  checkManifest(packageContext);
  checkReadme(packageContext);
  checkRequiredFiles(packageContext);
  checkVideos(packageContext, extraVideos);
  if (result.totals.combinedBytes > maxTotalBytes) {
    fail('TOTAL_SIZE_LIMIT', '.', `Combined delivery size is ${result.totals.combinedBytes} bytes, above ${maxTotalBytes} bytes`);
  }
  if (result.failures.length === 0 && input.writeZipPath) {
    createDeterministicZipClosure(packageContext);
  }

  result.ok = result.failures.length === 0;
  finish();
} catch (error) {
  fail('UNHANDLED_ERROR', '.', error && error.stack ? error.stack : String(error));
  finish();
}

function parseArguments(args) {
  const parsed = {
    targetPath: null,
    videoPaths: [],
    writeZipPath: null,
    replaceZip: false,
    maxVideoSeconds: 120,
    requirements: {
      manifest: true,
      readme: true,
      gitLink: true,
      license: true,
      thirdPartyNotices: true,
      video: true,
    },
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--video') {
      const videoPath = args[index + 1];
      if (!videoPath || videoPath.startsWith('--')) throw new Error('--video requires a file path');
      parsed.videoPaths.push(videoPath);
      index += 1;
    } else if (value === '--write-zip') {
      const zipPath = args[index + 1];
      if (!zipPath || zipPath.startsWith('--')) throw new Error('--write-zip requires a file path');
      parsed.writeZipPath = zipPath;
      index += 1;
    } else if (value === '--replace-zip') {
      parsed.replaceZip = true;
    } else if (value === '--help' || value === '-h') {
      parsed.help = true;
    } else if (value === '--max-video-seconds') {
      const seconds = Number(args[index + 1]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--max-video-seconds must be a positive number');
      parsed.maxVideoSeconds = seconds;
      index += 1;
    } else if (value === '--no-require-manifest') {
      parsed.requirements.manifest = false;
    } else if (value === '--no-require-readme') {
      parsed.requirements.readme = false;
    } else if (value === '--no-require-git-link') {
      parsed.requirements.gitLink = false;
    } else if (value === '--no-require-license') {
      parsed.requirements.license = false;
    } else if (value === '--no-require-third-party') {
      parsed.requirements.thirdPartyNotices = false;
    } else if (value === '--no-require-video') {
      parsed.requirements.video = false;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else if (!parsed.targetPath) {
      parsed.targetPath = value;
    } else {
      parsed.videoPaths.push(value);
    }
  }
  return parsed;
}

function collectDirectoryPackage(root) {
  const rootReal = fs.realpathSync.native(root);
  const entries = [];
  walkDirectory(root, root, rootReal, entries);
  const logicalRoot = chooseLogicalRoot(entries.map(entry => entry.relativePath));
  for (const entry of entries) {
    inspectPath(entry.relativePath, entry.label, entry.isDirectory);
    if (!entry.isDirectory) inspectDiskFile(entry.fullPath, entry.label);
  }
  return {
    kind: 'directory',
    entries,
    logicalRoot,
    realRoot: rootReal,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
  };
}

function collectZipPackage(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const archiveLabel = path.basename(zipPath);
  const entries = inspectZipBuffer(buffer, archiveLabel, 0);
  const logicalRoot = chooseLogicalRoot(entries.map(entry => entry.relativePath));
  return {
    kind: 'zip',
    entries,
    logicalRoot,
    realRoot: null,
    totalBytes: fs.statSync(zipPath).size,
  };
}

function walkDirectory(root, directory, rootReal, entries) {
  const directoryEntries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of directoryEntries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = toPosix(path.relative(root, fullPath));
    const label = relativePath || entry.name;
    const stat = fs.lstatSync(fullPath);
    if (entry.isSymbolicLink()) {
      fail('SYMLINK_FORBIDDEN', label, 'Symbolic links and junctions are not allowed in the final delivery package');
      entries.push({ relativePath, label, fullPath, isDirectory: false, bytes: 0 });
      continue;
    }
    const realPath = fs.realpathSync.native(fullPath);
    if (!isInsideRealRoot(realPath, rootReal)) {
      fail('PATH_ESCAPES_ROOT', label, 'Entry resolves outside the audited root');
      continue;
    }
    if (entry.isDirectory()) {
      entries.push({ relativePath, label, fullPath, isDirectory: true, bytes: 0 });
      walkDirectory(root, fullPath, rootReal, entries);
    } else if (entry.isFile()) {
      entries.push({ relativePath, label, fullPath, isDirectory: false, bytes: stat.size, sha256: sha256File(fullPath) });
      result.totals.files += 1;
    }
  }
}

function inspectDiskFile(filePath, label) {
  const stat = fs.statSync(filePath);
  const extension = path.extname(label).toLowerCase();
  if (stat.size > maxZipEntryBytes && (isTextPath(label) || isMediaPath(label) || extension === '.zip')) {
    fail('FILE_TOO_LARGE_TO_AUDIT', label, `File is ${stat.size} bytes, above the per-file audit limit ${maxZipEntryBytes}`);
    return;
  }
  if (isTextPath(label)) inspectText(label, fs.readFileSync(filePath));
  if (isMediaPath(label)) inspectMedia(label, fs.readFileSync(filePath));
  if (isVideoPath(label)) inspectDiskVideo(filePath, label);
  if (extension === '.zip') {
    try {
      inspectZipBuffer(fs.readFileSync(filePath), label, 1);
    } catch (error) {
      fail('ZIP_NESTED_UNREADABLE', label, `Nested zip could not be inspected: ${error.message}`);
    }
  }
}

function inspectZipBuffer(buffer, archiveLabel, depth) {
  if (depth > maxNestedZipDepth) {
    fail('ZIP_DEPTH_LIMIT', archiveLabel, `Nested zip depth is above ${maxNestedZipDepth}`);
    return [];
  }
  result.totals.nestedArchivesScanned += depth > 0 ? 1 : 0;
  const entries = readZipEntries(buffer, archiveLabel);
  for (const entry of entries) {
    const label = `${archiveLabel}!${entry.relativePath}`;
    entry.label = label;
    result.totals.zipEntries += 1;
    inspectPath(entry.relativePath, label, entry.isDirectory);
    if (entry.isDirectory) continue;
    result.totals.files += depth === 0 ? 1 : 0;
    if (entry.uncompressedSize > maxZipEntryBytes && (isTextPath(entry.relativePath) || isMediaPath(entry.relativePath) || isVideoPath(entry.relativePath) || path.extname(entry.relativePath).toLowerCase() === '.zip')) {
      fail('ZIP_ENTRY_TOO_LARGE_TO_AUDIT', label, `Zip entry is ${entry.uncompressedSize} bytes, above the per-entry audit limit ${maxZipEntryBytes}`);
      continue;
    }
    const content = readZipEntryContent(buffer, entry, archiveLabel);
    if (!content) continue;
    entry.content = content;
    entry.bytes = content.length;
    entry.sha256 = sha256Buffer(content);
    if (content.length !== entry.uncompressedSize) {
      fail('ZIP_SIZE_MISMATCH', label, `Zip entry declared ${entry.uncompressedSize} bytes but decompressed to ${content.length} bytes`);
    }
    if (isTextPath(entry.relativePath)) inspectText(label, content);
    if (isMediaPath(entry.relativePath) || isVideoPath(entry.relativePath)) inspectMedia(label, content);
    if (isVideoPath(entry.relativePath)) {
      inspectBufferedVideo(label, content, path.posix.basename(entry.relativePath));
    }
    if (path.extname(entry.relativePath).toLowerCase() === '.zip') {
      inspectZipBuffer(content, label, depth + 1);
    }
  }
  return entries;
}

function readZipEntries(buffer, archiveLabel) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    fail('ZIP_INVALID', archiveLabel, 'Zip end-of-central-directory record was not found');
    return [];
  }
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    fail('ZIP64_UNSUPPORTED', archiveLabel, 'Zip64 archives are not supported by this lightweight readonly auditor');
    return [];
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    fail('ZIP_INVALID', archiveLabel, 'Zip central directory points outside the archive');
    return [];
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail('ZIP_INVALID', archiveLabel, `Central directory entry ${index} is invalid`);
      return entries;
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      fail('ZIP_INVALID', archiveLabel, `Central directory entry ${index} has an invalid name length`);
      return entries;
    }
    const rawName = buffer.subarray(nameStart, nameEnd).toString(flags & 0x0800 ? 'utf8' : 'utf8');
    const safeName = normalizeZipPath(rawName);
    if (!safeName) {
      fail('ZIP_UNSAFE_PATH', `${archiveLabel}!${rawName}`, 'Zip entry path is absolute, normalized outside root, empty, or contains unsupported separators');
    }
    if (flags & 0x0001) {
      fail('ZIP_ENCRYPTED_UNSUPPORTED', `${archiveLabel}!${rawName}`, 'Encrypted zip entries cannot be audited');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      fail('ZIP64_UNSUPPORTED', `${archiveLabel}!${rawName}`, 'Zip64 entry metadata is not supported');
    }
    entries.push({
      relativePath: safeName || rawName,
      isDirectory: rawName.endsWith('/'),
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryContent(buffer, entry, archiveLabel) {
  if (entry.flags & 0x0001) return null;
  if (![0, 8].includes(entry.method)) {
    fail('ZIP_METHOD_UNSUPPORTED', `${archiveLabel}!${entry.relativePath}`, `Compression method ${entry.method} is not supported`);
    return null;
  }
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    fail('ZIP_INVALID', `${archiveLabel}!${entry.relativePath}`, 'Local file header is invalid');
    return null;
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    fail('ZIP_INVALID', `${archiveLabel}!${entry.relativePath}`, 'Compressed entry data points outside the archive');
    return null;
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  try {
    return entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch (error) {
    fail('ZIP_DECOMPRESS_FAILED', `${archiveLabel}!${entry.relativePath}`, error.message);
    return null;
  }
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function normalizeZipPath(rawName) {
  if (!rawName || rawName.includes('\0')) return null;
  if (path.posix.isAbsolute(rawName) || path.win32.isAbsolute(rawName)) return null;
  const slashName = rawName.replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashName);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  if (normalized !== slashName.replace(/\/+$/, '') && !/[\\/]$/.test(rawName)) return null;
  const candidate = /[\\/]$/.test(rawName) ? `${normalized.replace(/\/+$/, '')}/` : normalized;
  const segments = candidate.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes(':'))) return null;
  return candidate;
}

function inspectPath(relativePath, label, isDirectory) {
  const normalized = toPosix(relativePath).replace(/\/+$/, '');
  const lower = normalized.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  const forbiddenDirectoryNames = new Set([
    '.agents',
    '.codex',
    '.git',
    '.github',
    '.idea',
    '.vscode',
    '__macosx',
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
  const forbiddenFileNames = new Set([
    '.ds_store',
    '.env',
    '.env.local',
    '.env.production',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.yarnrc',
    '.yarnrc.yml',
    'thumbs.db',
  ]);
  const forbiddenExtensions = new Set([
    '.bak',
    '.db',
    '.dpapi',
    '.dmg',
    '.exe',
    '.msi',
    '.msix',
    '.msixbundle',
    '.key',
    '.log',
    '.p12',
    '.pem',
    '.pfx',
    '.pkg',
    '.appx',
    '.appxbundle',
    '.deb',
    '.rpm',
    '.sqlite',
    '.sqlite3',
  ]);

  for (const segment of segments) {
    if (forbiddenDirectoryNames.has(segment)) {
      fail('FORBIDDEN_PATH', label, `Forbidden directory name detected: ${segment}`);
    }
  }
  const basename = path.posix.basename(lower);
  if (!isDirectory && forbiddenFileNames.has(basename)) {
    fail('FORBIDDEN_FILE', label, `Forbidden file name detected: ${basename}`);
  }
  if (!isDirectory && forbiddenExtensions.has(path.posix.extname(lower))) {
    fail('FORBIDDEN_EXTENSION', label, `Forbidden file extension detected: ${path.posix.extname(lower)}`);
  }
  if (!isDirectory && /(?:setup|installer|install)[^/]*\.(?:exe|msi|msix|appx)$/i.test(basename)) {
    fail('INSTALLER_FORBIDDEN', label, 'Windows installer binaries must not be included in the final ZIP');
  }
  if (/(^|\/)(plan_\d|task\.md|stage_\d|codex[_-]?review|review[_-]?notes)(\/|$)/i.test(normalized)) {
    fail('WORKFLOW_ARTIFACT_PATH', label, 'Workflow, review, or task-planning artifact path detected');
  }
  scanSensitiveText(label, normalized, 'path');
}

function inspectText(label, buffer) {
  if (buffer.length > maxTextBytes) {
    fail('TEXT_TOO_LARGE_TO_AUDIT', label, `Text-like file is ${buffer.length} bytes, above ${maxTextBytes}`);
    return;
  }
  result.totals.textFilesScanned += 1;
  const text = stripBinaryNoise(buffer.toString('utf8'));
  scanSensitiveText(label, text, 'content');
}

function scanSensitiveText(label, text, area) {
  const patterns = sensitivePatterns();
  for (const pattern of patterns) {
    if (pattern.areas && !pattern.areas.has(area)) continue;
    pattern.regex.lastIndex = 0;
    const match = pattern.regex.exec(text);
    if (match) {
      fail(pattern.code, label, `${area} contains ${pattern.label}`, sampleEvidence(match[0]));
    }
  }
}

function sensitivePatterns() {
  const home = os.homedir();
  const username = os.userInfo().username;
  const collaborationTraces = [
    ['固定辅助', '任务'].join(''),
    ['Codex辅助', '实现对话'].join(''),
    ['开发', '机任务'].join(''),
    ['训练', '机任务'].join(''),
    ['双', '机任务'].join(''),
    ['Nap', 'Cat任务'].join(''),
  ];
  const patterns = [
    {
      code: 'IDENTITY_PATH',
      label: 'absolute user path',
      regex: /(?:[A-Za-z]:[\\/](?:Users|用户)[\\/][^\\/\s"'<>]+|\/(?:mnt\/[a-z]\/)?Users\/[^\/\s"'<>]+)/gi,
    },
    {
      code: 'IDENTITY_PATH',
      label: 'local profile or app data path',
      areas: new Set(['path']),
      regex: /^(?:AppData[\\/](?:Local|Roaming)(?:[\\/]|$)|Desktop[\\/][^\\/\r\n"'<>]+|Downloads[\\/][^\\/\r\n"'<>]+)/g,
    },
    {
      code: 'CODEX_TRAILER',
      label: 'Codex provenance trailer',
      regex: new RegExp(`${['Codex'].join('')}-(?:Thread|Machine|Task):`, 'g'),
    },
    {
      code: 'SECRET_TEXT',
      label: 'private key block',
      regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    },
    {
      code: 'SECRET_TEXT',
      label: 'OpenAI-style secret',
      regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
      code: 'SECRET_TEXT',
      label: 'bearer token',
      regex: /\bBearer\s+[A-Za-z0-9._~-]{30,}\b/g,
    },
    {
      code: 'OWNER_COLLAB_WORDING',
      label: 'private owner or development-process wording',
      regex: new RegExp(collaborationTraces.map(escapeRegExp).join('|'), 'g'),
    },
  ];
  if (home) {
    patterns.push({
      code: 'IDENTITY_PATH',
      label: 'current home path',
      regex: new RegExp(escapeRegExp(home), 'gi'),
    });
  }
  if (username && username.length >= 3) {
    patterns.push({
      code: 'IDENTITY_NAME',
      label: 'current OS username',
      regex: new RegExp(`\\b${escapeRegExp(username)}\\b`, 'gi'),
    });
  }
  return patterns;
}

function inspectMedia(label, buffer) {
  result.totals.mediaFilesScanned += 1;
  inspectPng(label, buffer);
  inspectJpeg(label, buffer);
  inspectWebp(label, buffer);
  inspectVideoMetadataStrings(label, buffer);
}

function inspectPng(label, buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (['eXIf', 'iTXt', 'tEXt', 'zTXt'].includes(type)) {
      fail('MEDIA_METADATA_RISK', label, `PNG metadata chunk detected: ${type}`);
    }
    offset += 12 + length;
  }
}

function inspectJpeg(label, buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return;
  if (buffer.includes(Buffer.from('Exif\0\0')) || buffer.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))) {
    fail('MEDIA_METADATA_RISK', label, 'JPEG EXIF or XMP metadata detected');
  }
}

function inspectWebp(label, buffer) {
  if (buffer.length < 16 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return;
  if (buffer.includes(Buffer.from('EXIF')) || buffer.includes(Buffer.from('XMP '))) {
    fail('MEDIA_METADATA_RISK', label, 'WEBP EXIF or XMP metadata detected');
  }
}

function inspectVideoMetadataStrings(label, buffer) {
  if (!isVideoPath(label)) return;
  const latin = buffer.subarray(0, Math.min(buffer.length, 4 * 1024 * 1024)).toString('latin1');
  const riskyMarkers = [
    'com.apple.quicktime.location.ISO6709',
    'com.apple.quicktime.author',
    'com.apple.quicktime.displayname',
    'com.apple.quicktime.make',
    'com.apple.quicktime.model',
    'creation_time',
    '©ART',
    '©cmt',
    '©day',
    '©nam',
  ];
  for (const marker of riskyMarkers) {
    if (latin.includes(marker)) {
      fail('MEDIA_METADATA_RISK', label, `Video metadata marker detected: ${marker}`);
    }
  }
}

function inspectDiskVideo(videoPath, label) {
  if (!result.ffprobe.available) {
    fail('FFPROBE_REQUIRED', label, 'ffprobe is required to prove video duration and inspect container tags');
    return;
  }
  try {
    const output = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags',
      '-of',
      'json',
      videoPath,
    ], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output);
    const duration = Number(parsed.format?.duration);
    const tags = parsed.format?.tags && typeof parsed.format.tags === 'object' ? parsed.format.tags : {};
    result.ffprobe.checkedVideos.push({ path: label, durationSeconds: Number.isFinite(duration) ? duration : null, tagKeys: Object.keys(tags).sort() });
    if (!Number.isFinite(duration)) {
      fail('VIDEO_DURATION_UNKNOWN', label, 'ffprobe did not return a finite video duration');
    } else if (duration > maxVideoSeconds) {
      fail('VIDEO_DURATION_LIMIT', label, `Video duration is ${duration.toFixed(3)} seconds, above ${maxVideoSeconds} seconds`);
    }
    const riskyTagKeys = Object.keys(tags).filter(key => /(?:author|artist|comment|copyright|creation_time|date|description|encoded_by|location|make|model|title)/i.test(key));
    if (riskyTagKeys.length > 0) {
      fail('MEDIA_METADATA_RISK', label, `Video container metadata tags detected: ${riskyTagKeys.sort().join(', ')}`);
    }
    const genericTagKeys = Object.keys(tags).filter(key => /(?:encoder|software)/i.test(key));
    if (genericTagKeys.length > 0) {
      warn('VIDEO_GENERIC_METADATA', label, `Generic video metadata tags detected: ${genericTagKeys.sort().join(', ')}`);
    }
    const tagText = Object.entries(tags).map(([key, value]) => `${key}=${String(value)}`).join('\n');
    if (tagText) scanSensitiveText(label, tagText, 'video metadata');
  } catch (error) {
    fail('FFPROBE_FAILED', label, `ffprobe failed: ${error.message}`);
  }
}

function resolveExtraVideos(videoPaths) {
  const videos = [];
  for (const videoPath of videoPaths) {
    const resolved = path.resolve(videoPath);
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      fail('VIDEO_MISSING', resolved, 'Optional video path does not point to a file');
      continue;
    }
    videos.push({
      path: resolved,
      realPath: fs.realpathSync.native(resolved),
      label: resolved,
      bytes: stat.size,
    });
  }
  return videos;
}

function checkManifest(packageContext) {
  const manifestEntry = findRootFile(packageContext, 'FINAL_DELIVERY_MANIFEST.json');
  if (!manifestEntry) {
    if (input.requirements.manifest) {
      fail('MANIFEST_MISSING', 'FINAL_DELIVERY_MANIFEST.json', 'FINAL_DELIVERY_MANIFEST.json must exist at the final delivery root');
    }
    return;
  }

  result.manifest.present = true;
  result.manifest.path = stripLogicalRoot(manifestEntry.relativePath, packageContext.logicalRoot);
  const manifestBuffer = readEntryBuffer(manifestEntry);
  if (!manifestBuffer) {
    fail('MANIFEST_UNREADABLE', result.manifest.path, 'FINAL_DELIVERY_MANIFEST.json was found but could not be read from the package');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch (error) {
    fail('MANIFEST_INVALID_JSON', result.manifest.path, `FINAL_DELIVERY_MANIFEST.json is not valid JSON: ${error.message}`);
    return;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('MANIFEST_INVALID_SHAPE', result.manifest.path, 'FINAL_DELIVERY_MANIFEST.json must contain a JSON object');
    return;
  }
  result.manifest.schemaVersion = manifest.schemaVersion ?? null;
  if (manifest.schemaVersion !== 1) {
    fail('MANIFEST_SCHEMA_UNSUPPORTED', result.manifest.path, 'FINAL_DELIVERY_MANIFEST.json schemaVersion must be 1');
  }
  if (!Array.isArray(manifest.files)) {
    fail('MANIFEST_FILES_INVALID', result.manifest.path, 'FINAL_DELIVERY_MANIFEST.json files must be an array');
    return;
  }

  const actualFiles = collectActualFiles(packageContext);
  const declaredFiles = new Map();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const descriptor = manifest.files[index];
    const label = `FINAL_DELIVERY_MANIFEST.json files[${index}]`;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      fail('MANIFEST_FILE_INVALID', label, 'Manifest file entry must be an object');
      continue;
    }
    const normalizedPath = normalizeManifestPath(descriptor.path);
    if (!normalizedPath) {
      fail('MANIFEST_PATH_INVALID', label, `Manifest path is not a safe normalized relative path: ${String(descriptor.path)}`);
      continue;
    }
    if (normalizedPath === 'FINAL_DELIVERY_MANIFEST.json') {
      fail('MANIFEST_SELF_REFERENCE', normalizedPath, 'FINAL_DELIVERY_MANIFEST.json must not list itself in files');
      continue;
    }
    if (declaredFiles.has(normalizedPath)) {
      fail('MANIFEST_PATH_DUPLICATE', normalizedPath, 'Manifest lists the same file path more than once');
      continue;
    }
    if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) {
      fail('MANIFEST_BYTES_INVALID', normalizedPath, 'Manifest bytes must be a non-negative safe integer');
    }
    if (typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(descriptor.sha256)) {
      fail('MANIFEST_SHA256_INVALID', normalizedPath, 'Manifest sha256 must be a 64-character hexadecimal string');
    }
    declaredFiles.set(normalizedPath, {
      path: normalizedPath,
      bytes: descriptor.bytes,
      sha256: typeof descriptor.sha256 === 'string' ? descriptor.sha256.toLowerCase() : descriptor.sha256,
    });
  }

  result.manifest.declaredFiles = declaredFiles.size;
  result.manifest.actualFiles = actualFiles.size;
  for (const [relativePath, declared] of declaredFiles) {
    const actual = actualFiles.get(relativePath);
    if (!actual) {
      fail('MANIFEST_FILE_MISSING', relativePath, 'Manifest lists a file that is missing from the package');
      continue;
    }
    if (Number.isSafeInteger(declared.bytes) && declared.bytes !== actual.bytes) {
      fail('MANIFEST_BYTES_MISMATCH', relativePath, `Manifest declares ${declared.bytes} bytes but package has ${actual.bytes} bytes`);
      continue;
    }
    if (typeof declared.sha256 === 'string' && declared.sha256 !== actual.sha256) {
      fail('MANIFEST_SHA256_MISMATCH', relativePath, 'Manifest sha256 does not match package content');
      continue;
    }
    result.manifest.verifiedFiles += 1;
  }
  for (const relativePath of actualFiles.keys()) {
    if (!declaredFiles.has(relativePath)) {
      fail('MANIFEST_FILE_EXTRA', relativePath, 'Package contains a file that is not listed in FINAL_DELIVERY_MANIFEST.json');
    }
  }

  checkManifestSupplements(manifest, actualFiles);
}

function collectActualFiles(packageContext) {
  const actualFiles = new Map();
  for (const entry of packageContext.entries) {
    if (entry.isDirectory) continue;
    const rootRelativePath = stripLogicalRoot(entry.relativePath, packageContext.logicalRoot);
    if (rootRelativePath === 'FINAL_DELIVERY_MANIFEST.json') continue;
    const normalizedPath = normalizeManifestPath(rootRelativePath);
    if (!normalizedPath) {
      fail('PACKAGE_PATH_INVALID', entry.label, 'Package file path is not a safe normalized relative path after applying the logical root');
      continue;
    }
    if (actualFiles.has(normalizedPath)) {
      fail('PACKAGE_PATH_DUPLICATE', normalizedPath, 'Package contains the same normalized file path more than once');
      continue;
    }
    const bytes = entry.bytes ?? entry.uncompressedSize;
    const sha256 = entry.sha256 || (entry.fullPath ? sha256File(entry.fullPath) : entry.content ? sha256Buffer(entry.content) : null);
    if (!Number.isSafeInteger(bytes) || typeof sha256 !== 'string') {
      fail('PACKAGE_FILE_UNHASHED', normalizedPath, 'Package file could not be measured for manifest verification');
      continue;
    }
    actualFiles.set(normalizedPath, { path: normalizedPath, bytes, sha256, entry });
  }
  return actualFiles;
}

function checkManifestSupplements(manifest, actualFiles) {
  const supplementalInputs = manifest.supplementalInputs;
  if (!supplementalInputs || typeof supplementalInputs !== 'object' || Array.isArray(supplementalInputs)) {
    if (input.requirements.readme || input.requirements.video) {
      fail('MANIFEST_SUPPLEMENTS_MISSING', 'FINAL_DELIVERY_MANIFEST.json', 'Manifest must declare README/video supplementalInputs for the final delivery package');
    }
    return;
  }

  if (input.requirements.readme) {
    if (!supplementalInputs.readme) {
      fail('MANIFEST_README_SUPPLEMENT_MISSING', 'README.txt', 'Manifest must declare the external README.txt supplement');
    } else {
      verifySupplementalDescriptor('README.txt', supplementalInputs.readme, 'README.txt', actualFiles);
    }
  } else if (supplementalInputs.readme) {
    verifySupplementalDescriptor('README.txt', supplementalInputs.readme, 'README.txt', actualFiles);
  }

  const supplementalVideos = supplementalInputs.videos;
  if (!Array.isArray(supplementalVideos)) {
    if (input.requirements.video) {
      fail('MANIFEST_VIDEO_SUPPLEMENTS_INVALID', 'FINAL_DELIVERY_MANIFEST.json', 'Manifest supplementalInputs.videos must be an array');
    }
    return;
  }

  const coveredVideoPaths = new Set();
  for (let index = 0; index < supplementalVideos.length; index += 1) {
    const videoPath = verifySupplementalDescriptor(`supplementalInputs.videos[${index}]`, supplementalVideos[index], null, actualFiles);
    if (videoPath) {
      if (!isVideoPath(videoPath)) {
        fail('MANIFEST_VIDEO_SUPPLEMENT_INVALID', videoPath, 'Supplemental video path must use a supported video extension');
      }
      coveredVideoPaths.add(videoPath);
    }
  }

  const actualVideoPaths = Array.from(actualFiles.keys()).filter(filePath => isVideoPath(filePath));
  result.manifest.supplementalVideos = Array.from(coveredVideoPaths).sort();
  if (input.requirements.video && supplementalVideos.length === 0) {
    fail('MANIFEST_VIDEO_SUPPLEMENT_MISSING', 'FINAL_DELIVERY_MANIFEST.json', 'Manifest must declare at least one external demonstration video supplement');
  }
  if (input.requirements.video) {
    for (const videoPath of actualVideoPaths) {
      if (!coveredVideoPaths.has(videoPath)) {
        fail('MANIFEST_VIDEO_SUPPLEMENT_MISSING', videoPath, 'Every packaged video must be declared in supplementalInputs.videos');
      }
    }
  }
}

function verifySupplementalDescriptor(label, descriptor, requiredDeliveryPath, actualFiles) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    fail('MANIFEST_SUPPLEMENT_INVALID', label, 'Supplement descriptor must be an object');
    return null;
  }
  const rawPath = descriptor.deliveryPath ?? descriptor.path ?? descriptor.name ?? requiredDeliveryPath;
  const deliveryPath = normalizeManifestPath(rawPath);
  if (!deliveryPath) {
    fail('MANIFEST_SUPPLEMENT_PATH_INVALID', label, `Supplement deliveryPath is not a safe normalized relative path: ${String(rawPath)}`);
    return null;
  }
  if (requiredDeliveryPath && deliveryPath !== requiredDeliveryPath) {
    fail('MANIFEST_SUPPLEMENT_PATH_MISMATCH', deliveryPath, `Supplement must be delivered as ${requiredDeliveryPath}`);
    return deliveryPath;
  }
  const actual = actualFiles.get(deliveryPath);
  if (!actual) {
    fail('MANIFEST_SUPPLEMENT_MISSING', deliveryPath, 'Supplement descriptor points to a file that is missing from the package');
    return deliveryPath;
  }
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes !== actual.bytes) {
    fail('MANIFEST_SUPPLEMENT_BYTES_MISMATCH', deliveryPath, `Supplement declares ${descriptor.bytes} bytes but package has ${actual.bytes} bytes`);
    return deliveryPath;
  }
  const declaredSha256 = typeof descriptor.sha256 === 'string' ? descriptor.sha256.toLowerCase() : null;
  if (!declaredSha256 || !/^[a-f0-9]{64}$/i.test(declaredSha256)) {
    fail('MANIFEST_SUPPLEMENT_SHA256_INVALID', deliveryPath, 'Supplement sha256 must be a 64-character hexadecimal string');
    return deliveryPath;
  }
  if (declaredSha256 !== actual.sha256) {
    fail('MANIFEST_SUPPLEMENT_SHA256_MISMATCH', deliveryPath, 'Supplement sha256 does not match package content');
    return deliveryPath;
  }
  if (requiredDeliveryPath === 'README.txt') {
    result.manifest.supplementalReadme = deliveryPath;
  }
  return deliveryPath;
}

function findRootFile(packageContext, fileName) {
  return packageContext.entries.find(entry => !entry.isDirectory && stripLogicalRoot(entry.relativePath, packageContext.logicalRoot) === fileName);
}

function readEntryBuffer(entry) {
  if (entry.fullPath) return fs.readFileSync(entry.fullPath);
  return entry.content || null;
}

function checkReadme(packageContext) {
  const readmeCandidates = packageContext.entries.filter(entry => !entry.isDirectory && stripLogicalRoot(entry.relativePath, packageContext.logicalRoot) === 'README.txt');
  const exactReadme = readmeCandidates[0];
  if (!exactReadme) {
    if (input.requirements.readme || input.requirements.gitLink) {
      fail('README_MISSING', 'README.txt', 'README.txt must exist at the final delivery root to satisfy the configured README and Git-link requirements');
    }
    return;
  }
  result.readme.present = true;
  const readmeBuffer = exactReadme.fullPath
    ? fs.readFileSync(exactReadme.fullPath)
    : exactReadme.content;
  if (!readmeBuffer) {
    fail('README_UNREADABLE', 'README.txt', 'README.txt was found but could not be read from the package');
    return;
  }
  const text = readmeBuffer.toString('utf8');
  const links = Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi)).map(match => match[0].replace(/[.,;，。；]+$/, ''));
  const gitLinks = links.filter(link => /(?:github\.com|gitlab\.com|gitee\.com|bitbucket\.org)\/[^/\s]+\/[^/\s]+/i.test(link));
  result.readme.gitLinks = gitLinks;
  if (input.requirements.gitLink && gitLinks.length === 0) {
    fail('README_GIT_LINK_MISSING', 'README.txt', 'README.txt must contain a Git repository URL');
  }
  if (input.requirements.gitLink) {
    for (const link of gitLinks) {
      if (isPlaceholderGitLink(link)) {
        fail('README_GIT_LINK_PLACEHOLDER', 'README.txt', `Git repository URL looks like a placeholder: ${link}`);
      }
    }
  }
}

function checkRequiredFiles(packageContext) {
  const rootFiles = new Set(packageContext.entries
    .filter(entry => !entry.isDirectory)
    .map(entry => stripLogicalRoot(entry.relativePath, packageContext.logicalRoot))
    .filter(relativePath => !relativePath.includes('/')));
  if (input.requirements.license && !rootFiles.has('LICENSE')) {
    fail('LICENSE_MISSING', 'LICENSE', 'LICENSE must exist at the final delivery root');
  }
  if (input.requirements.thirdPartyNotices && !rootFiles.has('THIRD_PARTY_NOTICES.md')) {
    fail('THIRD_PARTY_NOTICES_MISSING', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md must exist at the final delivery root');
  }
}

function checkVideos(packageContext, extraVideos) {
  const packageVideos = packageContext.entries.filter(entry => !entry.isDirectory && isVideoPath(entry.relativePath));
  result.videos.package = packageVideos.map(entry => ({
    path: stripLogicalRoot(entry.relativePath, packageContext.logicalRoot),
    bytes: entry.bytes ?? entry.uncompressedSize ?? null,
  }));
  result.videos.extra = extraVideos.map(video => ({ path: video.label, bytes: video.bytes }));
  if (input.requirements.video && packageVideos.length === 0 && extraVideos.length === 0) {
    fail('VIDEO_REQUIRED', '.', 'At least one final demonstration video is required');
    return;
  }

  if (!input.requirements.video && packageVideos.length === 0 && extraVideos.length === 0) return;
  let hasSpecificVerificationFailure = false;
  const candidateLabels = new Set([
    ...packageVideos.map(entry => entry.label),
    ...extraVideos.map(video => video.label),
  ]);
  const verifiedLabels = new Set(result.ffprobe.checkedVideos
    .filter(video => Number.isFinite(video.durationSeconds))
    .map(video => video.path));
  if (packageContext.kind === 'zip' && packageVideos.length > 0) {
    const verifiedPackageVideo = packageVideos.some(entry => verifiedLabels.has(entry.label));
    const verifiedExtra = extraVideos.some(video => packageVideos.some(entry => matchesPackageVideo(entry, video)));
    if (!verifiedPackageVideo && !verifiedExtra) {
      fail('VIDEO_DURATION_UNVERIFIED', '.', 'A video inside the zip must have a verified duration from zip extraction or a matching external --video file');
      hasSpecificVerificationFailure = true;
    }
  }

  hasSpecificVerificationFailure ||= result.failures.some(item => [
    'FFPROBE_FAILED',
    'FFPROBE_REQUIRED',
    'VIDEO_DURATION_UNKNOWN',
  ].includes(item.code));
  if (input.requirements.video && !hasSpecificVerificationFailure && !Array.from(candidateLabels).some(label => verifiedLabels.has(label))) {
    fail('VIDEO_DURATION_UNVERIFIED', '.', `No delivery video has a verified duration at or below ${maxVideoSeconds} seconds`);
  }
}

function matchesPackageVideo(entry, video) {
  const entryBytes = entry.uncompressedSize ?? entry.bytes;
  return path.posix.basename(entry.relativePath).toLowerCase() === path.basename(video.path).toLowerCase()
    && (!Number.isFinite(entryBytes) || entryBytes === video.bytes);
}

function chooseLogicalRoot(paths) {
  const rootSentinels = ['FINAL_DELIVERY_MANIFEST.json', 'README.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
  if (rootSentinels.some(fileName => paths.includes(fileName))) return '';
  const filePaths = paths.filter(item => item && !item.endsWith('/'));
  const topLevels = new Set(filePaths.map(item => item.split('/')[0]).filter(Boolean));
  if (topLevels.size === 1) {
    const [singleRoot] = Array.from(topLevels);
    if (rootSentinels.some(fileName => paths.includes(`${singleRoot}/${fileName}`))) return `${singleRoot}/`;
  }
  return '';
}

function stripLogicalRoot(relativePath, logicalRoot) {
  if (!logicalRoot) return relativePath;
  return relativePath.startsWith(logicalRoot) ? relativePath.slice(logicalRoot.length) : relativePath;
}

function isPlaceholderGitLink(link) {
  const lower = link.toLowerCase();
  return /(?:example\.com|your[-_]?|username|repo(?:sitory)?[-_]?name|project[-_]?name|placeholder|todo|tbd|xxx|<|>|\{|\}|待填|占位)/i.test(lower)
    || /github\.com\/(?:[^/\s]+\/)?(?:repo|project|test)(?:\.git)?$/i.test(lower);
}

function isTextPath(relativePath) {
  const lower = relativePath.toLowerCase();
  const extension = path.posix.extname(lower);
  return new Set([
    '.cjs',
    '.css',
    '.csv',
    '.html',
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.svg',
    '.toml',
    '.ts',
    '.tsx',
    '.txt',
    '.xml',
    '.yaml',
    '.yml',
  ]).has(extension) || ['license', 'readme', 'readme.txt'].includes(path.posix.basename(lower));
}

function isMediaPath(relativePath) {
  return new Set(['.gif', '.jpeg', '.jpg', '.mov', '.mp4', '.png', '.webm', '.webp']).has(path.posix.extname(relativePath.toLowerCase()));
}

function isVideoPath(relativePath) {
  return new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']).has(path.posix.extname(relativePath.toLowerCase()));
}

function createDeterministicZipClosure(packageContext) {
  if (packageContext.kind !== 'directory') {
    fail('ZIP_WRITE_TARGET_UNSUPPORTED', input.writeZipPath, '--write-zip can only package an audited directory target');
    return;
  }
  let zipPath;
  try {
    zipPath = assertSafeZipOutput(input.writeZipPath, packageContext.realRoot);
    const zipSummary = writeDeterministicZip(packageContext.realRoot, zipPath, input.replaceZip);
    result.zip.path = zipPath;
    result.zip.bytes = zipSummary.bytes;
    result.zip.sha256 = zipSummary.sha256;
    result.zip.entries = zipSummary.entries;
    result.zip.zipAuditOk = runNestedAudit(zipPath).ok;
    result.zip.extractAuditOk = verifyExtractedZip(zipPath).ok;
  } catch (error) {
    fail('ZIP_CLOSURE_FAILED', zipPath || input.writeZipPath, error.message);
  }
}

function assertSafeZipOutput(zipValue, packageRootReal) {
  if (!zipValue) throw new Error('--write-zip requires a file path');
  const resolved = path.resolve(zipValue);
  if (path.extname(resolved).toLowerCase() !== '.zip') throw new Error('Final delivery ZIP path must end with .zip');
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Final delivery ZIP parent must be an existing regular directory: ${parent}`);
  }
  const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (existing && (existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`Final delivery ZIP target must be a regular file or absent: ${resolved}`);
  }
  const parentReal = fs.realpathSync.native(parent);
  const zipRealCandidate = path.join(parentReal, path.basename(resolved));
  if (isInsideRealRoot(zipRealCandidate, packageRootReal)) {
    throw new Error('Final delivery ZIP target must be outside the directory being packaged');
  }
  return resolved;
}

function writeDeterministicZip(root, zipPath, replaceZip) {
  const entries = collectZipInputFiles(root);
  const zipBuffer = buildStoredZip(entries);
  const parent = path.dirname(zipPath);
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tempPath = path.join(parent, `.${path.basename(zipPath)}.tmp-${suffix}`);
  const backupPath = path.join(parent, `.${path.basename(zipPath)}.backup-${suffix}`);
  let backupCreated = false;
  try {
    if (fs.statSync(zipPath, { throwIfNoEntry: false })) {
      if (!replaceZip) throw new Error(`Final delivery ZIP already exists; rerun with --replace-zip after reviewing: ${zipPath}`);
      fs.renameSync(zipPath, backupPath);
      backupCreated = true;
    }
    fs.writeFileSync(tempPath, zipBuffer, { flag: 'wx' });
    fs.renameSync(tempPath, zipPath);
    if (backupCreated) fs.rmSync(backupPath, { force: true });
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (backupCreated && !fs.statSync(zipPath, { throwIfNoEntry: false })) {
      fs.renameSync(backupPath, zipPath);
    }
    throw error;
  }
  return {
    entries: entries.length,
    bytes: fs.statSync(zipPath).size,
    sha256: sha256File(zipPath),
  };
}

function collectZipInputFiles(root) {
  const rootReal = fs.realpathSync.native(root);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in deterministic ZIP input: ${fullPath}`);
      const realPath = fs.realpathSync.native(fullPath);
      if (!isInsideRealRoot(realPath, rootReal)) throw new Error(`ZIP input resolves outside root: ${fullPath}`);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const relativePath = toPosix(path.relative(root, fullPath));
        const normalizedPath = normalizeManifestPath(relativePath);
        if (!normalizedPath || normalizedPath !== relativePath) {
          throw new Error(`ZIP input path is not normalized: ${relativePath}`);
        }
        files.push({ path: normalizedPath, fullPath });
      }
    }
  };
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function buildStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBuffer = Buffer.from(file.path, 'utf8');
    const content = fs.readFileSync(file.fullPath);
    if (content.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error('Final delivery ZIP is too large for the non-Zip64 deterministic writer');
    }
    const crc = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + content.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralDirectoryOffset, 16);
  endRecord.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function verifyExtractedZip(zipPath) {
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-final-delivery-extract-'));
  try {
    extractZipArchive(zipPath, extractRoot);
    return runNestedAudit(extractRoot);
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
}

function extractZipArchive(zipPath, targetRoot) {
  const archiveLabel = path.basename(zipPath);
  const zipBuffer = fs.readFileSync(zipPath);
  const entries = readZipEntries(zipBuffer, archiveLabel);
  const targetReal = fs.realpathSync.native(targetRoot);
  for (const entry of entries) {
    const relativePath = normalizeManifestPath(entry.relativePath.replace(/\/+$/, ''));
    if (!relativePath || entry.isDirectory) continue;
    const targetPath = path.join(targetRoot, ...relativePath.split('/'));
    const parentPath = path.dirname(targetPath);
    fs.mkdirSync(parentPath, { recursive: true });
    const parentReal = fs.realpathSync.native(parentPath);
    if (!isInsideRealRoot(parentReal, targetReal)) {
      throw new Error(`Extracted ZIP entry would escape target root: ${entry.relativePath}`);
    }
    const content = readZipEntryContent(zipBuffer, entry, archiveLabel);
    if (!content) throw new Error(`Could not read ZIP entry for extraction: ${entry.relativePath}`);
    fs.writeFileSync(targetPath, content, { flag: 'wx' });
  }
}

function runNestedAudit(targetPath) {
  const nestedArgs = [__filename, targetPath, '--max-video-seconds', String(input.maxVideoSeconds)];
  if (!input.requirements.manifest) nestedArgs.push('--no-require-manifest');
  if (!input.requirements.readme) nestedArgs.push('--no-require-readme');
  if (!input.requirements.gitLink) nestedArgs.push('--no-require-git-link');
  if (!input.requirements.license) nestedArgs.push('--no-require-license');
  if (!input.requirements.thirdPartyNotices) nestedArgs.push('--no-require-third-party');
  if (!input.requirements.video) nestedArgs.push('--no-require-video');
  try {
    const output = execFileSync(process.execPath, nestedArgs, {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const nested = JSON.parse(output);
    if (!nested.ok) throw new Error(`${targetPath} nested audit returned ok=false`);
    return nested;
  } catch (error) {
    const details = String(error.stdout || error.stderr || error.message).trim();
    throw new Error(`Nested final delivery audit failed for ${targetPath}${details ? `:\n${details}` : ''}`);
  }
}

function inspectBufferedVideo(label, buffer, originalName) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-video-audit-'));
  try {
    const extension = path.extname(originalName).toLowerCase() || '.mp4';
    const tempVideoPath = path.join(tempRoot, `video${extension}`);
    fs.writeFileSync(tempVideoPath, buffer, { flag: 'wx' });
    inspectDiskVideo(tempVideoPath, label);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function normalizeManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const trimmed = value.replace(/\/+$/, '');
  if (!trimmed) return null;
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  if (normalized !== trimmed) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) return null;
  return normalized;
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function crc32(buffer) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crc32.table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function commandExists(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function isInsideRealRoot(realPath, rootReal) {
  const normalizedPath = realPath.toLowerCase();
  const normalizedRoot = rootReal.toLowerCase();
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${path.sep}`);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function stripBinaryNoise(value) {
  return value.replace(/\u0000/g, '');
}

function sampleEvidence(value) {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(code, filePath, message, evidence = undefined) {
  const item = { code, path: filePath, message };
  if (evidence !== undefined) item.evidence = evidence;
  result.failures.push(item);
}

function warn(code, filePath, message) {
  result.warnings.push({ code, path: filePath, message });
}

function printUsage() {
  process.stdout.write([
    'Usage: node scripts/audit-final-delivery.cjs <staging-dir|zip-file> [options]',
    '',
    'Options:',
    '  --video <path>                 Add an extracted or separately delivered video (repeatable)',
    '  --write-zip <path>             Write a deterministic final ZIP from an audited directory',
    '  --replace-zip                  Replace an existing --write-zip target after reviewing it',
    '  --max-video-seconds <number>   Maximum allowed duration (default: 120)',
    '  --no-require-manifest          Do not require FINAL_DELIVERY_MANIFEST.json',
    '  --no-require-readme            Do not require README.txt',
    '  --no-require-git-link          Do not require a non-placeholder Git URL in README.txt',
    '  --no-require-license           Do not require LICENSE',
    '  --no-require-third-party       Do not require THIRD_PARTY_NOTICES.md',
    '  --no-require-video             Do not require a video',
    '  -h, --help                     Show this help and exit successfully',
    '',
  ].join('\n'));
}

function finish() {
  result.ok = result.failures.length === 0;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}
