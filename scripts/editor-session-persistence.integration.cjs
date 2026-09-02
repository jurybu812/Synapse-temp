const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const editorTabsPath = path.join(root, 'src', 'store', 'slices', 'editorTabs.ts');
const storePath = path.join(root, 'src', 'store', 'index.ts');
const pdfViewerPath = path.join(root, 'src', 'components', 'editor', 'PdfViewer.tsx');

function compileTypeScript(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: sourcePath,
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const {
  editorTabsSlice,
  openTab,
  openWorkflowTab,
  setActiveTab,
  serializePersistedEditorTabsState,
  sanitizePersistedEditorTabsState,
  updatePdfViewState,
} = compileTypeScript(editorTabsPath);

let state = editorTabsSlice.reducer(undefined, { type: '@@init' });
state = editorTabsSlice.reducer(state, openTab({
  id: 'tab-pdf',
  filePath: 'C:\\Repo\\docs\\manual.pdf',
  fileName: 'manual.pdf',
  isDirty: true,
  isPreview: true,
  type: 'pdf',
  content: 'stale editor cache',
  savedContent: 'old disk cache',
}));
state = editorTabsSlice.reducer(state, updatePdfViewState({
  id: 'tab-pdf',
  page: 7,
  scale: 1.5,
  mode: 'scroll',
}));
state = editorTabsSlice.reducer(state, openTab({
  id: 'tab-code',
  filePath: 'C:\\Repo\\src\\main.ts',
  fileName: 'main.ts',
  isDirty: false,
  isPreview: false,
  type: 'code',
  content: 'console.log("old")',
  savedContent: 'console.log("old")',
}));
state = editorTabsSlice.reducer(state, openWorkflowTab({ runId: 'runtime-only', title: '运行中工作流' }));
state = editorTabsSlice.reducer(state, setActiveTab('tab-pdf'));

const session = serializePersistedEditorTabsState(state, 'C:\\Repo\\');
assert.equal(session.version, 1);
assert.equal(session.workspacePath, 'C:\\Repo\\');
assert.equal(session.state.activeTabId, 'tab-pdf');
assert.equal(session.state.tabs.some(tab => tab.type === 'workflow'), false, 'runtime workflow tabs must not be restored');
const persistedPdfTab = session.state.tabs.find(tab => tab.id === 'tab-pdf');
assert.deepEqual(persistedPdfTab.pdfViewState, { page: 7, scale: 1.5, mode: 'scroll' });
assert.equal(persistedPdfTab.isDirty, false, 'session restore must not invent unsaved edits');
assert.equal('content' in persistedPdfTab, false, 'stale file content must not be persisted');
assert.equal('savedContent' in persistedPdfTab, false, 'stale saved content must not be persisted');

const restored = sanitizePersistedEditorTabsState(session, 'c:/repo');
assert.equal(restored.activeTabId, 'tab-pdf');
assert.equal(restored.tabs.length, 3);
assert.deepEqual(
  restored.tabs.find(tab => tab.id === 'tab-pdf').pdfViewState,
  { page: 7, scale: 1.5, mode: 'scroll' },
);

assert.equal(sanitizePersistedEditorTabsState(session, null), undefined, 'no workspace path must disable editor session restore');
assert.equal(sanitizePersistedEditorTabsState(session, '/workspace'), undefined, 'demo workspace sentinel must disable editor session restore');
assert.equal(sanitizePersistedEditorTabsState(session, 'D:\\Other'), undefined, 'sessions are scoped to the same workspace path');
assert.equal(serializePersistedEditorTabsState(state, null), null, 'no workspace path must not write a restorable session');

const damaged = sanitizePersistedEditorTabsState({
  version: 1,
  workspacePath: 'C:\\Repo',
  state: {
    tabs: [
      null,
      { id: 123, type: 'pdf', filePath: '', fileName: 'bad.pdf', pdfViewState: { page: -8, scale: 99, mode: 'double' } },
      { id: 'safe-pdf', type: 'pdf', filePath: 'C:\\Repo\\safe.pdf', fileName: '', pdfViewState: { page: -8, scale: 99, mode: 'double' } },
      { id: 'safe-pdf-duplicate', type: 'pdf', filePath: 'c:\\repo\\SAFE.pdf', fileName: 'duplicate.pdf' },
      { id: 'outside', type: 'code', filePath: 'C:\\Other\\secret.ts', fileName: 'secret.ts' },
      { id: 'traversal', type: 'code', filePath: 'C:\\Repo\\..\\Other\\secret.ts', fileName: 'secret.ts' },
    ],
    activeTabId: 'missing',
    previewEnabled: 'yes',
    groupLocked: 1,
  },
}, 'C:\\Repo\\');
assert.equal(damaged.activeTabId, 'safe-pdf');
assert.equal(damaged.tabs.length, 1);
assert.deepEqual(damaged.tabs[0].pdfViewState, { page: 1, scale: 4, mode: 'paged' });
assert.equal(damaged.previewEnabled, false);
assert.equal(damaged.groupLocked, false);

let deduped = editorTabsSlice.reducer(undefined, openTab({
  id: 'slash-a', filePath: 'C:\\Repo\\src\\same.ts', fileName: 'same.ts', isDirty: false, isPreview: false, type: 'code',
}));
deduped = editorTabsSlice.reducer(deduped, openTab({
  id: 'slash-b', filePath: 'c:/repo/src/./SAME.ts', fileName: 'SAME.ts', isDirty: false, isPreview: false, type: 'code',
}));
assert.equal(deduped.tabs.filter(tab => tab.type === 'code').length, 1, 'equivalent file paths must share one editor tab');

const activeDuplicate = sanitizePersistedEditorTabsState({
  version: 1,
  workspacePath: 'C:\\Repo',
  state: {
    tabs: [
      { id: 'old-first', type: 'pdf', filePath: 'C:\\Repo\\manual.pdf', fileName: 'manual.pdf', pdfViewState: { page: 1, scale: 1, mode: 'paged' } },
      { id: 'new-active', type: 'pdf', filePath: 'c:/repo/MANUAL.pdf', fileName: 'manual.pdf', pdfViewState: { page: 9, scale: 2, mode: 'scroll' } },
      { id: 'new-active', type: 'code', filePath: 'C:\\Repo\\duplicate-id.ts', fileName: 'duplicate-id.ts' },
    ],
    activeTabId: 'new-active',
  },
}, 'C:\\Repo');
assert.equal(activeDuplicate.tabs.length, 1, 'equivalent paths and duplicate tab ids must collapse safely');
assert.equal(activeDuplicate.activeTabId, 'new-active', 'the active equivalent tab must win deduplication');
assert.deepEqual(activeDuplicate.tabs[0].pdfViewState, { page: 9, scale: 2, mode: 'scroll' });

const brokenShape = sanitizePersistedEditorTabsState({
  version: 1,
  workspacePath: 'C:\\Repo',
  state: { tabs: 'not-an-array', activeTabId: 'ghost' },
}, 'C:\\Repo');
assert.deepEqual(brokenShape, editorTabsSlice.getInitialState(), 'broken tab arrays must fall back to the welcome tab');

const storeSource = fs.readFileSync(storePath, 'utf8');
assert.match(storeSource, /const EDITOR_TABS_KEY = 'synapse_editor_tabs'/, 'store must use a dedicated editor tabs localStorage key');
assert.match(storeSource, /sanitizePersistedEditorTabsState\(editorTabsSeed, workspace\.currentPath\)/, 'store restore must be scoped by the restored workspace path');
assert.match(storeSource, /type\.startsWith\('editorTabs\/'\) \|\| type\.startsWith\('workspace\/'\)/, 'store must persist editor sessions after tab and workspace changes');
assert.match(storeSource, /serializePersistedEditorTabsState\(state\.editorTabs, state\.workspace\.currentPath\)/, 'store must serialize the active editor session');
assert.match(storeSource, /localStorage\.removeItem\(EDITOR_TABS_KEY\)/, 'store must clear editor sessions when no workspace is active');
assert.match(storeSource, /editorTabs: persisted\.editorTabs \?\? editorTabsSlice\.getInitialState\(\)/, 'store preloadedState must include restored editor tabs');

const pdfViewerSource = fs.readFileSync(pdfViewerPath, 'utf8');
assert.match(pdfViewerSource, /updatePdfViewState/, 'PdfViewer must dispatch PDF view state updates');
assert.match(pdfViewerSource, /tab\?\.type === 'pdf'/, 'PdfViewer must bind persistence to the active PDF tab only');
assert.match(pdfViewerSource, /setMode\(restoredView\?\.mode \?\? 'paged'\)/, 'PdfViewer must restore the saved PDF reading mode');
assert.match(pdfViewerSource, /dispatch\(updatePdfViewState\(\{ id: activePdfTabId, page, scale, mode \}\)\)/, 'PdfViewer must persist page, zoom, and mode together');

const editorAreaSource = fs.readFileSync(path.join(root, 'src', 'components', 'layout', 'EditorArea.tsx'), 'utf8');
assert.match(editorAreaSource, /<PdfFileViewer\s+key=\{activeTab\.id\}/, 'switching PDF tabs must remount the file loader');
assert.match(editorAreaSource, /let cancelled = false;\s+setData\(null\);/, 'loading another PDF must clear stale document data first');

console.log('Editor session persistence integration assertions passed');
