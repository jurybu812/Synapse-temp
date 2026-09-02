const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const pdfViewer = fs.readFileSync(path.join(root, 'src/components/editor/PdfViewer.tsx'), 'utf8');
const fileIpc = fs.readFileSync(path.join(root, 'electron/ipc/file.ts'), 'utf8');
const officeViewer = fs.readFileSync(path.join(root, 'src/components/editor/OfficeViewer.tsx'), 'utf8');

function declarationSource(source, fileName, names) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)) {
      declarations.set(statement.name.text, statement.getText(sourceFile));
    }
  }
  for (const name of names) assert.ok(declarations.has(name), `could not isolate ${name}`);
  return names.map(name => declarations.get(name)).join('\n');
}

function loadOfficeCacheHarness({ appDataPath, convertOfficeToPdf, fsImpl = fs }) {
  const functionNames = [
    'isReadablePdf',
    'getOfficeConverterIdentity',
    'readOfficeSourceIdentity',
    'sameOfficeSourceIdentity',
    'removeOfficePathBestEffort',
    'getOfficeCacheEntry',
    'convertOfficeToPdfCached',
  ];
  const harnessSource = `
    const OFFICE_PREVIEW_CACHE_VERSION = 'v1';
    const officeConversionFlights = new Map();
    ${declarationSource(fileIpc, 'file.ts', functionNames)}
    module.exports = { readOfficeSourceIdentity, getOfficeCacheEntry, convertOfficeToPdfCached };
  `;
  const transpiled = ts.transpileModule(harnessSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const harnessModule = { exports: {} };
  vm.runInNewContext(transpiled, {
    module: harnessModule,
    exports: harnessModule.exports,
    fs: fsImpl,
    path,
    process,
    Buffer,
    app: { getPath: () => appDataPath },
    createHash: crypto.createHash,
    randomUUID: crypto.randomUUID,
    findLibreOffice: () => 'soffice-test',
    convertOfficeToPdf,
  });
  return harnessModule.exports;
}

function loadSenderCleanupHarness() {
  const harnessSource = `
    const cleanupRegisteredSenders = new Set([7]);
    const fileApprovalPolicies = new Map([[7, true], [8, true]]);
    const cancelled = [];
    const revoked = [];
    const cancelSensitiveOperationApprovalsForSender = senderId => cancelled.push(senderId);
    const revokeFileAccessGrantsForSender = senderId => revoked.push(senderId);
    ${declarationSource(fileIpc, 'file.ts', ['ensureSenderCleanup'])}
    module.exports = { ensureSenderCleanup, cleanupRegisteredSenders, fileApprovalPolicies, cancelled, revoked };
  `;
  const transpiled = ts.transpileModule(harnessSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const harnessModule = { exports: {} };
  vm.runInNewContext(transpiled, { module: harnessModule, exports: harnessModule.exports });
  return harnessModule.exports;
}

function createConvertedPdf(parentDir, label) {
  const tempDir = fs.mkdtempSync(path.join(parentDir, 'conversion-'));
  const outputPath = path.join(tempDir, 'preview.pdf');
  fs.writeFileSync(outputPath, `%PDF-1.4\n${label}\n%%EOF`);
  return { success: true, outputPath, format: 'pdf', tempDir };
}

const fitStart = pdfViewer.indexOf('const ZOOM_MIN');
const fitEnd = pdfViewer.indexOf('\nexport function PdfViewer');
assert.ok(fitStart >= 0 && fitEnd > fitStart, 'could not isolate PDF fit calculation');
const fitSource = ts.transpileModule(
  `${pdfViewer.slice(fitStart, fitEnd)}\nmodule.exports = { calculatePdfFitScale, createPdfLoadData };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const fitModule = { exports: {} };
vm.runInNewContext(fitSource, { module: fitModule, exports: fitModule.exports, Math, Uint8Array, ArrayBuffer });
const { calculatePdfFitScale, createPdfLoadData } = fitModule.exports;

const originalPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer;
const firstPdfLoad = createPdfLoadData(originalPdfBytes);
assert.ok(firstPdfLoad.data instanceof Uint8Array, 'ArrayBuffer PDFs must load through a Uint8Array copy');
assert.equal(firstPdfLoad.data.byteLength, 5, 'PDF load copy must preserve exact byte length');
firstPdfLoad.data[0] = 0;
const secondPdfLoad = createPdfLoadData(originalPdfBytes);
assert.equal(secondPdfLoad.data[0], 0x25, 'PDF loads must not reuse a buffer that pdf.js may detach or mutate');
assert.notEqual(firstPdfLoad.data.buffer, originalPdfBytes, 'PDF.js must receive a fresh transferable buffer');
assert.notEqual(secondPdfLoad.data.buffer, originalPdfBytes, 'StrictMode reloads need a second fresh transferable buffer');
assert.equal(createPdfLoadData('synapse-file://local/test.pdf').url, 'synapse-file://local/test.pdf', 'URL-based PDF loads must keep using url');

assert.equal(calculatePdfFitScale(622, 507, 960, 540), 0.61, 'landscape slides should initially fit the available page area');
assert.equal(calculatePdfFitScale(622, 507, 612, 792), 0.59, 'portrait PDFs should initially fit the available page area');
assert.equal(calculatePdfFitScale(220, 180, 1200, 800), 0.25, 'very narrow panes should respect the lower zoom bound');
assert.match(pdfViewer, /new ResizeObserver\(scheduleFit\)/, 'PDF fit should track container resizes before manual zoom');
assert.match(pdfViewer, /userAdjustedScaleRef\.current = true/, 'manual zoom must disable automatic refitting');

assert.doesNotMatch(
  fileIpc,
  /Office 转换失败（疑似 LibreOffice 实例冲突/,
  'Office failures must not unconditionally blame a LibreOffice instance conflict',
);
assert.match(fileIpc, /looksLikeProfileConflict/, 'profile-conflict guidance must require matching evidence');
assert.match(fileIpc, /本次等待 \$\{elapsedSeconds\} 秒/, 'timeout errors must report measured wait time');

const cachedConvertStart = fileIpc.indexOf('async function convertOfficeToPdfCached');
const cachedConvertEnd = fileIpc.indexOf('\nexport function registerFileHandlers', cachedConvertStart);
assert.ok(cachedConvertStart >= 0 && cachedConvertEnd > cachedConvertStart, 'could not isolate Office cache conversion');
const cachedConvertSource = fileIpc.slice(cachedConvertStart, cachedConvertEnd);
assert.ok(
  cachedConvertSource.indexOf('officeConversionFlights.get(cache.key)')
    < cachedConvertSource.indexOf('removeOfficePathBestEffort(cache.cacheDir'),
  'concurrent callers must join the in-flight conversion before invalid cache cleanup',
);
assert.match(fileIpc, /converter: getOfficeConverterIdentity\(\)/, 'Office cache key must include the converter identity');
assert.match(fileIpc, /includes\('%%EOF'\)/, 'cached PDF validation must require an EOF marker');
assert.match(fileIpc, /app\.getPath\('userData'\).*office-previews/s, 'Office cache must survive app restarts under userData');
assert.match(officeViewer, /cacheHit \? '使用缓存预览'/, 'Office viewer must distinguish cached previews');
assert.match(officeViewer, /if \(cancelled\) return;[\s\S]*readBinary\(converted\.outputPath\)/, 'closed Office viewers must not read converted bytes');

async function runOfficeCacheRuntimeAssertions() {
  const sourceChangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-office-source-change-'));
  try {
    const sourcePath = path.join(sourceChangeRoot, 'source.docx');
    const appDataPath = path.join(sourceChangeRoot, 'user-data');
    fs.writeFileSync(sourcePath, 'source-v1');
    let conversionCount = 0;
    let firstTempDir = '';
    const harness = loadOfficeCacheHarness({
      appDataPath,
      convertOfficeToPdf: async () => {
        conversionCount += 1;
        const converted = createConvertedPdf(sourceChangeRoot, `conversion-${conversionCount}`);
        if (conversionCount === 1) {
          firstTempDir = converted.tempDir;
          fs.writeFileSync(sourcePath, 'source-v2-with-different-size');
          const changedAt = new Date(Date.now() + 2000);
          fs.utimesSync(sourcePath, changedAt, changedAt);
        }
        return converted;
      },
    });
    const initialIdentity = harness.readOfficeSourceIdentity(sourcePath);
    const initialCache = harness.getOfficeCacheEntry(initialIdentity);
    const result = await harness.convertOfficeToPdfCached(sourcePath, initialIdentity);
    assert.equal(result.success, true, `source changes should retry and still produce a preview: ${JSON.stringify(result)}`);
    assert.equal(conversionCount, 2, 'source changes should trigger exactly one bounded retry');
    assert.equal(fs.existsSync(initialCache.outputPath), false, 'changed-source output must not publish under the old key');
    assert.equal(fs.existsSync(firstTempDir), false, 'discarded conversion temp output must be cleaned');
    assert.match(fs.readFileSync(result.outputPath, 'utf8'), /conversion-2/, 'the published cache must come from the retry');
  } finally {
    fs.rmSync(sourceChangeRoot, { recursive: true, force: true });
  }

  const continuousChangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-office-continuous-change-'));
  try {
    const sourcePath = path.join(continuousChangeRoot, 'source.pptx');
    fs.writeFileSync(sourcePath, 'initial');
    let conversionCount = 0;
    const conversionTempDirs = [];
    const harness = loadOfficeCacheHarness({
      appDataPath: path.join(continuousChangeRoot, 'user-data'),
      convertOfficeToPdf: async () => {
        conversionCount += 1;
        const converted = createConvertedPdf(continuousChangeRoot, `continuous-${conversionCount}`);
        conversionTempDirs.push(converted.tempDir);
        fs.writeFileSync(sourcePath, `source-${conversionCount}-${'x'.repeat(conversionCount)}`);
        const changedAt = new Date(Date.now() + conversionCount * 2000);
        fs.utimesSync(sourcePath, changedAt, changedAt);
        return converted;
      },
    });
    const identity = harness.readOfficeSourceIdentity(sourcePath);
    const result = await harness.convertOfficeToPdfCached(sourcePath, identity);
    assert.equal(result.error, true, 'continuously changing sources must stop after the bounded retry');
    assert.equal(conversionCount, 2, 'source-change retry must be bounded to one additional conversion');
    for (const tempDir of conversionTempDirs) {
      assert.equal(fs.existsSync(tempDir), false, 'discarded continuously-changing conversions must be cleaned');
    }
  } finally {
    fs.rmSync(continuousChangeRoot, { recursive: true, force: true });
  }

  const cacheFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-office-cache-failure-'));
  try {
    const sourcePath = path.join(cacheFailureRoot, 'source.xlsx');
    const appDataPath = path.join(cacheFailureRoot, 'user-data');
    fs.writeFileSync(sourcePath, 'stable-source');
    const fsWithRenameFailure = Object.create(fs);
    fsWithRenameFailure.renameSync = () => { throw new Error('simulated cache rename failure'); };
    let convertedTempDir = '';
    const harness = loadOfficeCacheHarness({
      appDataPath,
      fsImpl: fsWithRenameFailure,
      convertOfficeToPdf: async () => {
        const converted = createConvertedPdf(cacheFailureRoot, 'fallback-preview');
        convertedTempDir = converted.tempDir;
        return converted;
      },
    });
    const identity = harness.readOfficeSourceIdentity(sourcePath);
    const result = await harness.convertOfficeToPdfCached(sourcePath, identity);
    assert.equal(result.success, true, 'cache write failure must not fail a successful conversion');
    assert.equal(result.cacheHit, false);
    assert.equal(result.outputPath, path.join(convertedTempDir, 'preview.pdf'));
    assert.equal(fs.existsSync(result.outputPath), true, 'fallback temp PDF must remain readable for the renderer');
  } finally {
    fs.rmSync(cacheFailureRoot, { recursive: true, force: true });
  }

  const senderHarness = loadSenderCleanupHarness();
  let destroyedOnceCalls = 0;
  senderHarness.ensureSenderCleanup({ id: 7, isDestroyed: () => true, once: () => { destroyedOnceCalls += 1; } });
  assert.equal(destroyedOnceCalls, 0, 'already-destroyed senders must not install a late destroyed listener');
  assert.equal(senderHarness.cleanupRegisteredSenders.has(7), false);
  assert.equal(senderHarness.fileApprovalPolicies.has(7), false);
  assert.deepEqual([...senderHarness.cancelled], [7]);
  assert.deepEqual([...senderHarness.revoked], [7]);

  let liveDestroyedListener;
  let liveOnceCalls = 0;
  const liveSender = {
    id: 8,
    isDestroyed: () => false,
    once: (eventName, listener) => {
      assert.equal(eventName, 'destroyed');
      liveOnceCalls += 1;
      liveDestroyedListener = listener;
    },
  };
  senderHarness.ensureSenderCleanup(liveSender);
  senderHarness.ensureSenderCleanup(liveSender);
  assert.equal(liveOnceCalls, 1, 'live senders must install exactly one destroyed listener');
  assert.equal(typeof liveDestroyedListener, 'function');
  liveDestroyedListener();
  assert.equal(senderHarness.cleanupRegisteredSenders.has(8), false);
  assert.equal(senderHarness.fileApprovalPolicies.has(8), false);
  assert.deepEqual([...senderHarness.cancelled], [7, 8]);
  assert.deepEqual([...senderHarness.revoked], [7, 8]);
}

runOfficeCacheRuntimeAssertions()
  .then(() => console.log('File viewer integration: all assertions passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
