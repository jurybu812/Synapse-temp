const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const pdfViewer = fs.readFileSync(path.join(root, 'src/components/editor/PdfViewer.tsx'), 'utf8');
const fileIpc = fs.readFileSync(path.join(root, 'electron/ipc/file.ts'), 'utf8');

const fitStart = pdfViewer.indexOf('const ZOOM_MIN');
const fitEnd = pdfViewer.indexOf('\nexport function PdfViewer');
assert.ok(fitStart >= 0 && fitEnd > fitStart, 'could not isolate PDF fit calculation');
const fitSource = ts.transpileModule(
  `${pdfViewer.slice(fitStart, fitEnd)}\nmodule.exports = { calculatePdfFitScale };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const fitModule = { exports: {} };
vm.runInNewContext(fitSource, { module: fitModule, exports: fitModule.exports, Math });
const { calculatePdfFitScale } = fitModule.exports;

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

console.log('File viewer integration: all assertions passed');
