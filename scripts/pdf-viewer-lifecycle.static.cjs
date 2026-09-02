const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const viewerPath = path.join(root, 'src', 'components', 'editor', 'PdfViewer.tsx');
const source = fs.readFileSync(viewerPath, 'utf8');

assert.match(source, /function\s+createPdfLoadData\(/, 'PDF loading must normalize ArrayBuffer inputs before pdf.js');
assert.match(source, /new Uint8Array\(source\.byteLength\)[\s\S]*bytes\.set\(source\)[\s\S]*return \{ data: bytes \}/, 'ArrayBuffer PDFs must be copied into an exact-length fresh Uint8Array for each load');
assert.doesNotMatch(source, /getDocument\(loadData\)\.promise/, 'loading task must be retained before awaiting promise');

assert.match(source, /const\s+loadingTaskRef\s*=\s*useRef<any>\(null\)/, 'loading task ref is required');
assert.match(source, /const\s+loadTokenRef\s*=\s*useRef\(0\)/, 'load token ref is required');
assert.match(source, /function\s+destroyPdfResource\(/, 'PDF lifecycle destroy helper is required');
assert.match(source, /function\s+isPdfLifecycleCancellation\(/, 'PDF cancellation detector is required');

assert.match(source, /const\s+loadData\s*=\s*createPdfLoadData\(data\)/, 'PDF data must be cloned before each pdf.js load');
assert.match(source, /loadingTask\s*=\s*pdfjsLib\.getDocument\(loadData\)/, 'getDocument result must be assigned to loadingTask');
assert.match(source, /loadingTaskRef\.current\s*=\s*loadingTask/, 'loading task must be published for cleanup');
assert.match(source, /destroyPdfResource\(pdf,\s*'late PDF document'\)/, 'late-loaded documents must be destroyed');
assert.match(source, /destroyPdfResource\(loadedPdf,\s*'PDF document'\)/, 'loaded document must be destroyed on cleanup');
assert.match(source, /destroyPdfResource\(loadingTask,\s*'PDF loading task'\)/, 'in-flight loading task must be destroyed on cleanup');

assert.match(source, /renderTokenRef\.current\s*\+=\s*1[\s\S]*cancelRenderTask\(renderTaskRef\.current\)/, 'document reload must invalidate and cancel paged render task');
assert.match(source, /const\s+pdfDocument\s*=\s*pdfRef\.current[\s\S]*pdfDocument\.getPage\(page\)/, 'paged render must capture the document for the current run');
assert.doesNotMatch(source, /pdfRef\.current\.getPage\(page\)/, 'paged render must not dereference pdfRef after async document switches');

assert.match(source, /tokenRefs\.current\s*=\s*tokenRefs\.current\.map\([\s\S]*cancelRenderTask\(task\)[\s\S]*renderedScaleRefs\.current\s*=\s*\[\]/, 'scroll view must cancel render tasks and invalidate page tokens on unmount/pdf change');
assert.match(source, /cancelRenderTask\(taskRefs\.current\[idx\]\)[\s\S]*taskRefs\.current\[idx\]\s*=\s*null/, 'scroll render must cancel a previous page task before starting a replacement');
assert.match(source, /isPdfLifecycleCancellation\(err\)/, 'render/load cancellation paths must ignore expected pdf.js lifecycle errors');

console.log('PDF viewer lifecycle static check: all assertions passed');
