const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-workspace-open-'));
const userDataPath = path.join(tempRoot, 'user-data');
const workspaceA = path.join(tempRoot, 'workspace-a');
const workspaceB = path.join(tempRoot, 'workspace-b');
const workspaceC = path.join(tempRoot, 'workspace-c');
const workspaceD = path.join(tempRoot, 'workspace-d');
const missingWorkspace = path.join(tempRoot, 'missing-workspace');
const selectedFile = path.join(tempRoot, 'not-a-directory.txt');

let dialogResult = { canceled: true, filePaths: [] };
let dialogDelay = null;
let dialogOpenCount = 0;
const handlers = new Map();
let authorizedRoots = [];

let currentUnix = 1_700_000_000;
const workspaceRows = [];

function nextUnix() {
  currentUnix += 1;
  return currentUnix;
}

function cloneRow(row) {
  return row ? { ...row } : undefined;
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function createFakeDatabase() {
  return {
    prepare(sql) {
      const normalizedSql = normalizeSql(sql);
      return {
        all(limit) {
          if (normalizedSql === "SELECT path FROM workspaces WHERE path IS NOT NULL AND path <> ''") {
            return workspaceRows.filter(row => row.path).map(row => ({ path: row.path }));
          }
          if (normalizedSql === 'SELECT * FROM workspaces ORDER BY COALESCE(last_opened, updated_at) DESC LIMIT ?') {
            return workspaceRows
              .slice()
              .sort((left, right) => (right.last_opened ?? right.updated_at) - (left.last_opened ?? left.updated_at))
              .slice(0, limit)
              .map(cloneRow);
          }
          if (normalizedSql === 'SELECT * FROM workspaces') {
            return workspaceRows.map(cloneRow);
          }
          throw new Error(`Unexpected SQL all: ${normalizedSql}`);
        },
        get(value) {
          if (normalizedSql === 'SELECT * FROM workspaces WHERE id = ?') {
            return cloneRow(workspaceRows.find(row => row.id === value));
          }
          if (normalizedSql === 'SELECT * FROM workspaces WHERE path = ?') {
            return cloneRow(workspaceRows.find(row => row.path === value));
          }
          throw new Error(`Unexpected SQL get: ${normalizedSql}`);
        },
        run(...values) {
          if (normalizedSql === 'INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)') {
            const [id, name, workspacePath] = values;
            if (workspaceRows.some(row => row.id === id || row.path === workspacePath)) {
              throw new Error('UNIQUE constraint failed: workspaces');
            }
            const timestamp = nextUnix();
            workspaceRows.push({ id, name, path: workspacePath, created_at: timestamp, updated_at: timestamp, last_opened: null });
            return { changes: 1 };
          }
          if (normalizedSql === 'INSERT INTO workspaces (id, name, path, last_opened) VALUES (?, ?, ?, unixepoch())') {
            const [id, name, workspacePath] = values;
            if (workspaceRows.some(row => row.id === id || row.path === workspacePath)) {
              throw new Error('UNIQUE constraint failed: workspaces');
            }
            const timestamp = nextUnix();
            workspaceRows.push({ id, name, path: workspacePath, created_at: timestamp, updated_at: timestamp, last_opened: timestamp });
            return { changes: 1 };
          }
          if (normalizedSql === 'UPDATE workspaces SET name = ?, path = ?, updated_at = unixepoch(), last_opened = unixepoch() WHERE id = ?') {
            const [name, workspacePath, id] = values;
            const row = workspaceRows.find(item => item.id === id);
            if (!row) return { changes: 0 };
            const conflicting = workspaceRows.find(item => item.id !== id && item.path === workspacePath);
            if (conflicting) throw new Error('UNIQUE constraint failed: workspaces.path');
            const timestamp = nextUnix();
            row.name = name;
            row.path = workspacePath;
            row.updated_at = timestamp;
            row.last_opened = timestamp;
            return { changes: 1 };
          }
          if (normalizedSql === 'DELETE FROM workspaces WHERE id = ?') {
            const [id] = values;
            const before = workspaceRows.length;
            for (let index = workspaceRows.length - 1; index >= 0; index -= 1) {
              if (workspaceRows[index].id === id) workspaceRows.splice(index, 1);
            }
            return { changes: before - workspaceRows.length };
          }
          throw new Error(`Unexpected SQL run: ${normalizedSql}`);
        },
      };
    },
  };
}

const database = createFakeDatabase();

function loadWorkspaceModule() {
  const sourcePath = path.join(root, 'electron', 'ipc', 'workspace.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });
  const runtimeModule = { exports: {} };
  const electronMock = {
    app: {
      getPath: name => {
        assert.equal(name, 'userData');
        return userDataPath;
      },
    },
    BrowserWindow: {
      fromWebContents: () => ({}),
    },
    dialog: {
      showOpenDialog: async () => {
        dialogOpenCount += 1;
        if (dialogDelay) await dialogDelay;
        return dialogResult;
      },
    },
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
  };
  const fileAccessMock = {
    enforceAgentFileAccess: filePath => filePath,
    registerAuthorizedWorkspaceRoot: filePath => {
      authorizedRoots.push(filePath);
    },
    replaceAuthorizedWorkspaceRoots: roots => {
      authorizedRoots = [...roots];
    },
  };
  const requireMock = specifier => {
    if (specifier === 'electron') return electronMock;
    if (specifier === '../database') return { getDatabase: () => database };
    if (specifier === '../fileAccess') return fileAccessMock;
    return require(specifier);
  };
  new Function('require', 'module', 'exports', '__dirname', '__filename', compiled.outputText)(
    requireMock,
    runtimeModule,
    runtimeModule.exports,
    path.dirname(sourcePath),
    sourcePath,
  );
  return runtimeModule.exports;
}

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  try {
    return Promise.resolve(handler({ sender: { id: 42 } }, ...args));
  } catch (error) {
    return Promise.reject(error);
  }
}

function rows() {
  return workspaceRows
    .map(row => ({ id: row.id, name: row.name, path: row.path, last_opened: row.last_opened }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function rowById(id) {
  return rows().find(row => row.id === id);
}

function insertWorkspace(id, name, workspacePath, lastOpened = 100) {
  workspaceRows.push({
    id,
    name,
    path: workspacePath,
    created_at: nextUnix(),
    updated_at: nextUnix(),
    last_opened: lastOpened,
  });
}

async function assertRejectsWithoutRowChange(action, pattern) {
  const before = JSON.stringify(rows());
  await assert.rejects(action, pattern);
  assert.equal(JSON.stringify(rows()), before);
}

function flushAsyncTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function sliceBlock(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start === -1 ? 0 : start);
  assert.notEqual(start, -1, `${label} start marker must exist`);
  assert.notEqual(end, -1, `${label} end marker must exist`);
  return source.slice(start, end);
}

function assertNoCommittedTransitionBeforeNullableWorkspaceResult(block, label) {
  const nullableOpenIndex = block.indexOf('await window.synapse.workspace.open()');
  assert.notEqual(nullableOpenIndex, -1, `${label} must await the nullable native workspace picker`);
  assert.doesNotMatch(
    block.slice(0, nullableOpenIndex),
    /fileSystem\.beginWorkspaceTransition\(\)/,
    `${label} must not invalidate the active workspace/restore before a nullable picker result exists`,
  );
}

function assertWorkspaceIntentGuard(block, label) {
  assert.match(
    block,
    /const workspaceIntent = fileSystem\.beginWorkspaceIntent\(\)/,
    `${label} must create a non-committing workspace intent before awaiting bridge work`,
  );
  assert.match(
    block,
    /const startedWorkspacePath = workspacePathRef\.current/,
    `${label} must remember the workspace visible when the async operation started`,
  );
  assert.match(
    block,
    /!fileSystem\.isWorkspaceIntentCurrent\(workspaceIntent\)[\s\S]*workspacePathKey\(workspacePathRef\.current\) !== workspacePathKey\(startedWorkspacePath\)/,
    `${label} must ignore stale async results after the user has moved to another workspace`,
  );
}

function loadWorkspacePickerCoordinatorModule() {
  const sourcePath = path.join(root, 'src', 'services', 'workspacePickerCoordinator.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });
  const runtimeModule = { exports: {} };
  const requireMock = specifier => {
    if (specifier === '@/store/slices/conversation') return { AUTOSAVE_ID: 'autosave-current' };
    if (specifier === './executionRegistry') return {
      executionRegistry: {
        isConversationRunning: conversationId => conversationId === 'registry-running',
      },
    };
    return require(specifier);
  };
  new Function('require', 'module', 'exports', '__dirname', '__filename', compiled.outputText)(
    requireMock,
    runtimeModule,
    runtimeModule.exports,
    path.dirname(sourcePath),
    sourcePath,
  );
  return runtimeModule.exports;
}

async function assertWorkspacePickerCoordinatorBehavior() {
  const {
    beginWorkspacePickerPending,
    getWorkspacePickerPendingCount,
    hasWorkspacePickerPending,
    tryBeginWorkspacePickerPending,
    waitForWorkspacePickerIdle,
    summarizeWorkspaceToolTaskReferences,
    getWorkspaceChangeBlockState,
    workspaceChangeBlockMessage,
  } = loadWorkspacePickerCoordinatorModule();
  const host = {
    __synapseWorkspacePickerPendingCount: 0,
    setTimeout: (callback, delay) => setTimeout(callback, Math.min(delay ?? 0, 1)),
  };

  const finishA = beginWorkspacePickerPending(host);
  const finishB = beginWorkspacePickerPending(host);
  assert.equal(getWorkspacePickerPendingCount(host), 2);
  assert.equal(hasWorkspacePickerPending(host), true);
  finishA();
  finishA();
  assert.equal(getWorkspacePickerPendingCount(host), 1, 'picker finish must be idempotent');
  const idle = waitForWorkspacePickerIdle(() => true, { host, intervalMs: 1 });
  setTimeout(finishB, 1);
  assert.equal(await idle, true);
  assert.equal(getWorkspacePickerPendingCount(host), 0, 'cancelled or failed picker must release the shared count');

  const finishExclusivePicker = tryBeginWorkspacePickerPending(host);
  assert.equal(typeof finishExclusivePicker, 'function');
  assert.equal(tryBeginWorkspacePickerPending(host), null, 'a second workspace picker must not start while one is pending');
  assert.equal(getWorkspacePickerPendingCount(host), 1, 'exclusive picker acquisition must register exactly once');
  finishExclusivePicker();
  assert.equal(getWorkspacePickerPendingCount(host), 0, 'exclusive picker cancellation or failure must release the shared count');

  const activeToolConversation = {
    id: 'conversation-with-tool',
    isStreaming: false,
    assistantRuns: {},
    messages: [{
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [
        { id: 'call-known', name: 'sandbox', arguments: '{}', status: 'running', taskId: 'task-known', taskOwnerId: 'owner-known' },
        { id: 'call-orphan', name: 'sandbox', arguments: '{}', status: 'pending' },
      ],
    }],
  };
  const references = summarizeWorkspaceToolTaskReferences(activeToolConversation);
  assert.equal(references.pendingTaskCount, 1);
  assert.equal(references.orphanPendingCallCount, 1);
  assert.deepEqual(references.ownerIds, ['owner-known']);
  const toolBlock = getWorkspaceChangeBlockState(activeToolConversation, { isConversationRunning: () => false });
  assert.equal(toolBlock.blocked, true, 'workspace changes must block before recovered tool tasks reconcile into executionRegistry');
  assert.match(workspaceChangeBlockMessage(toolBlock), /后台工具任务完成恢复对账/);

  const registryBlock = getWorkspaceChangeBlockState({
    id: 'registry-running',
    isStreaming: false,
    assistantRuns: {},
    messages: [],
  });
  assert.equal(registryBlock.blocked, true, 'workspace changes must still block active in-memory executionRegistry runs');
}

function assertRendererRacePolicyModel() {
  let committedGeneration = 0;
  let intentGeneration = 0;
  let currentPath = 'A';
  const key = value => String(value ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const beginWorkspaceTransition = () => {
    committedGeneration += 1;
    intentGeneration += 1;
    return committedGeneration;
  };
  const beginWorkspaceIntent = () => {
    intentGeneration += 1;
    return intentGeneration;
  };
  let pickerPending = 0;
  const beginWorkspacePickerPending = () => {
    pickerPending += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      pickerPending = Math.max(0, pickerPending - 1);
    };
  };
  const isWorkspaceTransitionCurrent = generation => generation === committedGeneration;
  const isWorkspaceIntentCurrent = generation => generation === intentGeneration;
  const canRestoreCommit = generation => (
    isWorkspaceTransitionCurrent(generation) && pickerPending === 0
  );
  const applyWorkspaceResult = (intent, startedPath, targetPath) => {
    if (!targetPath) return false;
    if (!isWorkspaceIntentCurrent(intent) || key(currentPath) !== key(startedPath)) return false;
    beginWorkspaceTransition();
    currentPath = targetPath;
    return true;
  };

  const restoreA = beginWorkspaceTransition();
  const pickerA = beginWorkspaceIntent();
  assert.equal(isWorkspaceTransitionCurrent(restoreA), true, 'cancelable picker intent must not cancel a pending restore');
  const finishPickerA = beginWorkspacePickerPending();
  assert.equal(canRestoreCommit(restoreA), false, 'pending picker must delay cold restore commit while user is choosing');
  assert.equal(applyWorkspaceResult(pickerA, 'A', null), false, 'cancel picker must not commit a workspace change');
  assert.equal(currentPath, 'A', 'cancel picker must preserve the current workspace path');
  finishPickerA();
  assert.equal(canRestoreCommit(restoreA), true, 'cancel picker must allow the still-current valid restore to continue');

  const restoreBeforeB = beginWorkspaceTransition();
  currentPath = 'A';
  const pickerB = beginWorkspaceIntent();
  const finishPickerB = beginWorkspacePickerPending();
  assert.equal(canRestoreCommit(restoreBeforeB), false, 'old restore A must not commit before picker B settles');
  assert.equal(applyWorkspaceResult(pickerB, 'A', 'B'), true, 'picker B should commit after choosing a real workspace');
  finishPickerB();
  assert.equal(canRestoreCommit(restoreBeforeB), false, 'old restore A must stay stale after picker B commits');

  const staleTreeA = committedGeneration;
  beginWorkspaceTransition();
  currentPath = 'B';
  assert.equal(isWorkspaceTransitionCurrent(staleTreeA), false, 'deferred tree A must not commit after B transitions');

  const restoreAfterB = staleTreeA;
  assert.equal(isWorkspaceTransitionCurrent(restoreAfterB), false, 'deferred restore A success/failure must not commit after user B');

  currentPath = 'B';
  const pickerOld = beginWorkspaceIntent();
  const startedB = currentPath;
  const switchNew = beginWorkspaceIntent();
  assert.equal(applyWorkspaceResult(switchNew, startedB, 'C'), true, 'newer workspace intent should commit');
  assert.equal(applyWorkspaceResult(pickerOld, startedB, 'A'), false, 'older deferred picker result must not overwrite newer workspace');
  assert.equal(currentPath, 'C', 'older deferred picker result must leave newer workspace intact');

  currentPath = 'C';
  const firstPicker = beginWorkspaceIntent();
  const duplicatePicker = beginWorkspaceIntent();
  const sharedSelection = 'D';
  assert.equal(applyWorkspaceResult(firstPicker, 'C', sharedSelection), false, 'older caller sharing one native picker result must stay stale');
  assert.equal(applyWorkspaceResult(duplicatePicker, 'C', sharedSelection), true, 'newest duplicate caller must commit the shared picker result');
  assert.equal(currentPath, 'D', 'a duplicate picker click must not discard the valid native selection');
}

async function main() {
  fs.mkdirSync(path.join(workspaceA, 'src'), { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  fs.mkdirSync(workspaceC, { recursive: true });
  fs.mkdirSync(workspaceD, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(workspaceA, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
  fs.writeFileSync(selectedFile, 'not a directory\n', 'utf8');

  const workspaceSource = fs.readFileSync(path.join(root, 'electron', 'ipc', 'workspace.ts'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
  const welcomeSource = fs.readFileSync(path.join(root, 'src', 'components', 'editor', 'WelcomePage.tsx'), 'utf8');
  const sidebarSource = fs.readFileSync(path.join(root, 'src', 'components', 'layout', 'Sidebar.tsx'), 'utf8');
  const fileSystemSource = fs.readFileSync(path.join(root, 'src', 'services', 'fileSystem.ts'), 'utf8');
  const appLayoutSource = fs.readFileSync(path.join(root, 'src', 'components', 'layout', 'AppLayout.tsx'), 'utf8');
  const commandPaletteSource = fs.readFileSync(path.join(root, 'src', 'components', 'ui', 'CommandPalette.tsx'), 'utf8');
  const pickerCoordinatorSource = fs.readFileSync(path.join(root, 'src', 'services', 'workspacePickerCoordinator.ts'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
  const platformSource = fs.readFileSync(path.join(root, 'src', 'platform', 'index.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(root, 'src', 'components', 'settings', 'SettingsPanel.tsx'), 'utf8');
  const appLayoutOpenWorkspaceStart = appLayoutSource.indexOf('const handleOpenWorkspace = useCallback(async () => {');
  const appLayoutOpenWorkspaceEnd = appLayoutSource.indexOf('  // 命令面板预定义命令');
  assert.notEqual(appLayoutOpenWorkspaceStart, -1, 'AppLayout must expose a real command-palette workspace opener');
  assert.notEqual(appLayoutOpenWorkspaceEnd, -1, 'AppLayout workspace opener must stay before command registration');
  const appLayoutOpenWorkspaceBlock = appLayoutSource.slice(appLayoutOpenWorkspaceStart, appLayoutOpenWorkspaceEnd);
  const welcomeNewWorkspaceBlock = sliceBlock(welcomeSource, 'const handleNewWorkspace = useCallback(async () => {', '  const handleSwitchWorkspace = useCallback(async (id: string) => {', 'WelcomePage new workspace handler');
  const welcomeSwitchWorkspaceBlock = sliceBlock(welcomeSource, 'const handleSwitchWorkspace = useCallback(async (id: string) => {', '  const handleOpenWorkspace = useCallback(async () => {', 'WelcomePage switch workspace handler');
  const welcomeOpenWorkspaceBlock = sliceBlock(welcomeSource, 'const handleOpenWorkspace = useCallback(async () => {', '  const handleDeleteWorkspace = useCallback(async', 'WelcomePage open workspace handler');
  const welcomeDeleteWorkspaceBlock = sliceBlock(welcomeSource, 'const handleDeleteWorkspace = useCallback(async', '  const handleImport = useCallback(', 'WelcomePage delete workspace handler');
  const sidebarOpenWorkspaceBlock = sliceBlock(sidebarSource, 'const handleOpenWorkspace = useCallback(async () => {', '  const handleClearWorkspace = useCallback(async () => {', 'Sidebar open workspace handler');
  const sidebarClearWorkspaceBlock = sliceBlock(sidebarSource, 'const handleClearWorkspace = useCallback(async () => {', '  // Load workspace on mount', 'Sidebar clear workspace handler');
  const settingsWorktreePickerBlock = sliceBlock(settingsSource, 'const pickWorktreeRepo = useCallback(async () => {', '  const refreshWorktrees = useCallback(async () => {', 'SettingsPanel worktree repo picker');

  for (const [label, block] of [
    ['AppLayout open workspace', appLayoutOpenWorkspaceBlock],
    ['Sidebar open workspace', sidebarOpenWorkspaceBlock],
    ['WelcomePage new workspace', welcomeNewWorkspaceBlock],
    ['WelcomePage open workspace', welcomeOpenWorkspaceBlock],
  ]) {
    const pickerAcquireIndex = block.indexOf('tryBeginWorkspacePickerPending()');
    const workspaceIntentIndex = block.indexOf('fileSystem.beginWorkspaceIntent()');
    assert.notEqual(pickerAcquireIndex, -1, `${label} must acquire the shared picker coordinator`);
    assert.notEqual(workspaceIntentIndex, -1, `${label} must create a workspace intent`);
    assert.ok(pickerAcquireIndex < workspaceIntentIndex, `${label} must acquire the picker before invalidating prior workspace intents`);
  }

  assert.match(workspaceSource, /fs\.accessSync\(realPath,\s*fs\.constants\.R_OK\)/);
  assert.doesNotMatch(workspaceSource, /INSERT OR REPLACE INTO workspaces/);
  assert.match(workspaceSource, /type WorkspaceDirectoryPickerPurpose = 'workspace-open' \| 'directory-select'/);
  assert.match(workspaceSource, /ipcMain\.handle\('workspace:selectDirectory'[\s\S]*purpose: 'directory-select'/);
  assert.match(workspaceSource, /const dirPath = await pickValidatedDirectory\(e,[\s\S]*purpose: 'workspace-open'/);
  assert.match(workspaceSource, /workspaceDirectoryPickerPending\.purpose === purpose[\s\S]*workspaceDirectoryPickerPending\.request[\s\S]*: null/);
  assert.match(workspaceSource, /workspaceDirectoryPickerPending = \{ purpose, request: pickRequest \}[\s\S]*workspaceDirectoryPickerPending\?\.request === pickRequest[\s\S]*workspaceDirectoryPickerPending = null/);
  assert.match(workspaceSource, /if \(workspaceOpenPending\) return workspaceOpenPending;[\s\S]*workspaceOpenPending = openRequest;[\s\S]*finally \{[\s\S]*workspaceOpenPending === openRequest[\s\S]*workspaceOpenPending = null/);
  assert.match(workspaceSource, /ipcMain\.handle\('workspace:create'[\s\S]*validateWorkspaceDirectory\(data\.path, '创建工作区'\)[\s\S]*upsertWorkspace\(dirPath, \{ id: data\.id, name: data\.name \}\)/);
  assert.match(preloadSource, /selectDirectory: \(\) => ipcRenderer\.invoke\('workspace:selectDirectory'\)/);
  assert.match(platformSource, /selectDirectory: \(\) => Promise<string \| null>/);
  assert.match(platformSource, /selectDirectory: async \(\) => null/);
  assert.match(settingsWorktreePickerBlock, /platform\.workspace\.selectDirectory\(\)/);
  assert.doesNotMatch(settingsWorktreePickerBlock, /platform\.workspace\.open\(\)/);
  assert.match(settingsWorktreePickerBlock, /const finishWorkspacePickerPending = tryBeginWorkspacePickerPending\(\);[\s\S]*if \(!finishWorkspacePickerPending\) return;[\s\S]*finally \{[\s\S]*finishWorkspacePickerPending\(\)/);
  assert.match(workspaceSource, /input\.restore === true && workspaceOpenPending[\s\S]*const openedWorkspace = await workspaceOpenPending[\s\S]*if \(openedWorkspace\) return openedWorkspace/);
  assert.match(workspaceSource, /ipcMain\.handle\('workspace:switch'[\s\S]*validateWorkspaceDirectory\(candidate\.path, '切换工作区'\)/);
  assert.match(workspaceSource, /if \(depth === 1\) throw directoryAccessError\('读取工作区目录', error\)/);
  assert.match(welcomeSource, /const handleSwitchWorkspace = useCallback\(async \(id: string\) => \{[\s\S]*if \(!allowWorkspaceChange\(\)\) return;[\s\S]*try \{/);
  assert.match(welcomeSource, /const handleOpenWorkspace = useCallback\(async \(\) => \{[\s\S]*workspacePickerPendingRef\.current = true;[\s\S]*try \{/);
  assert.match(welcomeSource, /window\.synapse\.workspace\.switch as unknown as WorkspaceSwitchBridge/);
  assert.match(welcomeSource, /if \(isElectron && window\.synapse\?\.workspace\) \{[\s\S]*window\.synapse\.workspace\.open\(\)/);
  assert.match(welcomeSource, /window\.synapse\.workspace\.delete\(\{ id, path: deletedWorkspace\.path \}\)[\s\S]*fileSystem\.deleteWorkspace\(id\)/);
  assert.match(welcomeSource, /workspacePathKey\(currentWorkspacePath\) === deletedWorkspacePathKey/);
  assert.match(welcomeSource, /workspacePathKey\(path\) !== deletedWorkspacePathKey/);
  assert.match(welcomeSource, /const deletingCurrentWorkspace =[\s\S]*if \(deletingCurrentWorkspace\) \{[\s\S]*resolveUnsavedTabs\(tabs, '删除当前工作区记录'\)/);
  assert.match(welcomeDeleteWorkspaceBlock, /if \(deletingCurrentWorkspace && !allowWorkspaceChange\(\)\) return;[\s\S]*resolveUnsavedTabs\(tabs, '删除当前工作区记录'\)/);
  assert.match(welcomeSource, /dispatch\(setRecentPaths\(recentWorkspacePaths\.filter/);
  assert.match(welcomeSource, /if \(deletingCurrentWorkspace\) \{[\s\S]*dispatch\(resetTabsToWelcome\(\)\)/);
  assert.match(welcomeSource, /workspacePickerPendingRef\.current[\s\S]*正在等待系统目录选择器/);
  assert.match(pickerCoordinatorSource, /export function beginWorkspacePickerPending/);
  assert.match(pickerCoordinatorSource, /host\.__synapseWorkspacePickerPendingCount = getWorkspacePickerPendingCount\(host\) \+ 1/);
  assert.match(pickerCoordinatorSource, /finished = true[\s\S]*Math\.max\(0, \(host\.__synapseWorkspacePickerPendingCount \?\? 0\) - 1\)/);
  assert.match(pickerCoordinatorSource, /export function tryBeginWorkspacePickerPending[\s\S]*if \(hasWorkspacePickerPending\(host\)\) return null;[\s\S]*beginWorkspacePickerPending\(host\)/);
  assert.match(pickerCoordinatorSource, /export function waitForWorkspacePickerIdle/);
  assert.match(pickerCoordinatorSource, /export function summarizeWorkspaceToolTaskReferences/);
  assert.match(pickerCoordinatorSource, /PENDING_TOOL_STATUSES\.has\(toolCall\.status\)/);
  assert.match(pickerCoordinatorSource, /export function getWorkspaceChangeBlockState/);
  assert.match(pickerCoordinatorSource, /toolTaskReferences\.pendingTaskCount > 0[\s\S]*toolTaskReferences\.orphanPendingCallCount > 0/);
  assert.match(pickerCoordinatorSource, /后台工具任务完成恢复对账/);
  assert.match(appSource, /const workspaceBridge = window\.synapse\.workspace[\s\S]*isVirtualWorkspacePath\(workspacePath\)[\s\S]*workspaceBridge\.recent\(50\)/);
  assert.match(appSource, /const switchWorkspace = workspaceBridge\.switch as WorkspaceRestoreSwitchBridge[\s\S]*switchWorkspace\(\{ \.\.\.candidate, restore: true \}\)/);
  assert.match(appSource, /import \{ waitForWorkspacePickerIdle \} from '@\/services\/workspacePickerCoordinator'/);
  assert.match(appSource, /await waitForWorkspacePickerIdle\(isCurrentWorkspaceRestore\)[\s\S]*hydrate\(workspace, staleWorkspaceId\)/);
  assert.match(appSource, /catch\(async error => \{[\s\S]*await waitForWorkspacePickerIdle\(isCurrentWorkspaceRestore\)/);
  assert.match(appSource, /workspaceHydrationKeyRef\.current = canonicalKey[\s\S]*dispatch\(openWorkspace\(\{ path: workspace\.path, name: workspace\.name \}\)\)/);
  assert.match(appSource, /void restoreWorkspace\(\)\.catch\(async error => \{[\s\S]*isVirtualWorkspacePath\(localWorkspace\.path\)[\s\S]*fileSystem\.deleteWorkspace\(localWorkspace\.id\)[\s\S]*fileSystem\.clearLoadedWorkspace\(\);[\s\S]*dispatch\(clearWorkspace\(\)\)/);
  assert.match(fileSystemSource, /workspacePathKey\(w\.path\) === incomingPathKey/);
  assert.match(fileSystemSource, /if \(this\.workspaces\.length === 0 && !isElectron\)/);
  assert.match(fileSystemSource, /this\.currentWorkspace = '';[\s\S]*name: '未加载工作区'/);
  assert.match(fileSystemSource, /return currentPath \|\| \(isElectron \? '' : DEMO_WORKSPACE_PATH\)/);
  assert.match(fileSystemSource, /if \(!workspacePath\) return this\.fileTree/);
  assert.match(fileSystemSource, /existing\.path = ws\.path/);
  assert.doesNotMatch(welcomeSource, /className="welcome-recent-item"\s+role="button"/);
  assert.match(commandPaletteSource, /action: \(\) => void \| Promise<void>/);
  assert.doesNotMatch(appLayoutSource, /openWorkspace:\s*\(\)\s*=>\s*dispatch\(addNotification\(\{ type: 'info', title: '打开工作区', message: '功能开发中' \}\)\)/);
  assert.match(appLayoutSource, /openWorkspace:\s*\(\)\s*=>\s*\{\s*void handleOpenWorkspace\(\);\s*\}/);
  assert.match(appLayoutOpenWorkspaceBlock, /resolveUnsavedTabs\(tabs, '打开工作区'\)[\s\S]*if \(!ok\) return/);
  assert.match(appLayoutOpenWorkspaceBlock, /workspacePickerPendingRef\.current[\s\S]*finally[\s\S]*workspacePickerPendingRef\.current = false/);
  assert.match(appLayoutOpenWorkspaceBlock, /const finishWorkspacePickerPending = tryBeginWorkspacePickerPending\(\);\s*if \(!finishWorkspacePickerPending\) return;[\s\S]*await window\.synapse\.workspace\.open\(\)[\s\S]*finally \{[\s\S]*finishWorkspacePickerPending\(\)/);
  assert.match(appLayoutOpenWorkspaceBlock, /window\.synapse\.workspace\.open\(\)[\s\S]*if \(!workspace\) return/);
  assert.match(appLayoutOpenWorkspaceBlock, /fileSystem\.openExternalWorkspace\(localWorkspace\)[\s\S]*dispatch\(openWorkspace\(\{ path: localWorkspace\.path, name: localWorkspace\.name \}\)\)/);
  assert.doesNotMatch(appLayoutOpenWorkspaceBlock, /setConversationWorkspace/);
  assert.match(appLayoutOpenWorkspaceBlock, /notifyWorkspaceChangeBlocked\(\)/);
  assert.match(appLayoutSource, /getWorkspaceChangeBlockState\(activeConversation\)[\s\S]*workspaceChangeBlockMessage\(blockState\)/);
  assert.match(appLayoutOpenWorkspaceBlock, /setActiveView\('explorer'\)[\s\S]*setSidebarVisible\(true\)/);
  assert.doesNotMatch(appLayoutOpenWorkspaceBlock, /document\.createElement\('input'\)|webkitdirectory/);
  assert.match(welcomeSource, /dispatch\(openWorkspace\(\{ path: nextWorkspace\.path, name: nextWorkspace\.name \}\)\)/);
  assert.doesNotMatch(welcomeSource, /setConversationWorkspace/);
  assert.match(welcomeSource, /const allowWorkspaceChange = useCallback\([\s\S]*getWorkspaceChangeBlockState\(activeConversation\)[\s\S]*workspaceChangeBlockMessage\(blockState\)/);
  assert.match(sidebarSource, /dispatch\(openWorkspace\(\{ path: ws\.path, name: ws\.name \}\)\)/);
  assert.doesNotMatch(sidebarSource, /setConversationWorkspace/);
  assert.match(fileSystemSource, /private workspaceGeneration = 0/);
  assert.match(fileSystemSource, /private workspaceIntentGeneration = 0/);
  assert.match(fileSystemSource, /beginWorkspaceIntent\(\): number/);
  assert.match(fileSystemSource, /isWorkspaceIntentCurrent\(generation: number\): boolean/);
  assert.match(fileSystemSource, /beginWorkspaceTransition\(\): number \{[\s\S]*this\.workspaceIntentGeneration \+= 1/);
  assert.match(fileSystemSource, /workspaceGeneration = this\.workspaceGeneration/);
  assert.match(fileSystemSource, /!this\.isWorkspaceTransitionCurrent\(workspaceGeneration\)/);
  assert.match(sidebarSource, /workspaceTreeRequestRef[\s\S]*workspacePathRef/);
  assert.match(appSource, /const isCurrentWorkspaceRestore = \(\) =>/);
  assert.match(sidebarSource, /function isVirtualWorkspacePath\(workspacePath: string \| null \| undefined\): boolean/);
  assert.match(sidebarOpenWorkspaceBlock, /const finishWorkspacePickerPending = tryBeginWorkspacePickerPending\(\);\s*if \(!finishWorkspacePickerPending\) return;[\s\S]*await window\.synapse\.workspace\.open\(\)[\s\S]*finally \{[\s\S]*finishWorkspacePickerPending\(\)/);
  assert.match(welcomeNewWorkspaceBlock, /const finishWorkspacePickerPending = tryBeginWorkspacePickerPending\(\);\s*if \(!finishWorkspacePickerPending\) return;[\s\S]*await window\.synapse\.workspace\.open\(\)[\s\S]*finally \{[\s\S]*finishWorkspacePickerPending\(\)/);
  assert.match(welcomeOpenWorkspaceBlock, /const finishWorkspacePickerPending = tryBeginWorkspacePickerPending\(\);\s*if \(!finishWorkspacePickerPending\) return;[\s\S]*await window\.synapse\.workspace\.open\(\)[\s\S]*finally \{[\s\S]*finishWorkspacePickerPending\(\)/);
  assert.match(sidebarSource, /workspace\.currentPath && !isVirtualWorkspacePath\(workspace\.currentPath\)/);
  assert.match(sidebarSource, /!workspace\.currentPath \|\| isVirtualWorkspacePath\(workspace\.currentPath\)/);
  assert.match(sidebarSource, /notifyWorkspaceChangeBlocked\(\)/);
  assert.match(sidebarClearWorkspaceBlock, /if \(notifyWorkspaceChangeBlocked\(\)\) return;[\s\S]*resolveUnsavedTabs\(tabs, '清空工作区'\)/);
  for (const source of [appLayoutSource, sidebarSource, welcomeSource]) {
    assert.match(source, /getWorkspaceChangeBlockState\(activeConversation\)[\s\S]*workspaceChangeBlockMessage\(blockState\)/);
    assert.doesNotMatch(source, /executionRegistry\.isConversationRunning\(activeConversation\.id \|\| 'autosave-current'\)/);
  }
  await assertWorkspacePickerCoordinatorBehavior();
  assertNoCommittedTransitionBeforeNullableWorkspaceResult(appLayoutOpenWorkspaceBlock, 'AppLayout open workspace');
  assertNoCommittedTransitionBeforeNullableWorkspaceResult(welcomeNewWorkspaceBlock, 'WelcomePage new workspace');
  assertNoCommittedTransitionBeforeNullableWorkspaceResult(welcomeOpenWorkspaceBlock, 'WelcomePage open workspace');
  assertNoCommittedTransitionBeforeNullableWorkspaceResult(sidebarOpenWorkspaceBlock, 'Sidebar open workspace');
  assertWorkspaceIntentGuard(appLayoutOpenWorkspaceBlock, 'AppLayout open workspace');
  assertWorkspaceIntentGuard(welcomeNewWorkspaceBlock, 'WelcomePage new workspace');
  assertWorkspaceIntentGuard(welcomeSwitchWorkspaceBlock, 'WelcomePage switch workspace');
  assertWorkspaceIntentGuard(welcomeOpenWorkspaceBlock, 'WelcomePage open workspace');
  assertWorkspaceIntentGuard(sidebarOpenWorkspaceBlock, 'Sidebar open workspace');
  assertRendererRacePolicyModel();

  const { registerWorkspaceHandlers } = loadWorkspaceModule();
  insertWorkspace('existing', 'Existing', workspaceA);
  registerWorkspaceHandlers();

  const beforeCancel = JSON.stringify(rows());
  dialogResult = { canceled: true, filePaths: [] };
  assert.equal(await invoke('workspace:open'), null);
  assert.equal(JSON.stringify(rows()), beforeCancel);

  const beforePurePicker = JSON.stringify(rows());
  const beforePurePickerRoots = JSON.stringify(authorizedRoots);
  dialogResult = { canceled: false, filePaths: [workspaceD] };
  let releaseDialog;
  dialogDelay = new Promise(resolve => { releaseDialog = resolve; });
  const pickerA = invoke('workspace:selectDirectory');
  const pickerB = invoke('workspace:selectDirectory');
  await flushAsyncTurn();
  assert.equal(dialogOpenCount, 2, 'selectDirectory duplicate calls must share one main-process directory dialog after the earlier open cancellation');
  releaseDialog();
  assert.equal(await pickerA, fs.realpathSync.native(workspaceD));
  assert.equal(await pickerB, fs.realpathSync.native(workspaceD));
  dialogDelay = null;
  assert.equal(JSON.stringify(rows()), beforePurePicker, 'pure directory picker must not upsert workspaces');
  assert.equal(JSON.stringify(authorizedRoots), beforePurePickerRoots, 'pure directory picker must not refresh authorized roots');

  const beforeCrossPurposePicker = JSON.stringify(rows());
  dialogResult = { canceled: false, filePaths: [workspaceD] };
  dialogDelay = new Promise(resolve => { releaseDialog = resolve; });
  const directoryPicker = invoke('workspace:selectDirectory');
  await flushAsyncTurn();
  assert.equal(await invoke('workspace:open'), null, 'workspace open must fail closed while a pure directory picker owns the native dialog');
  releaseDialog();
  assert.equal(await directoryPicker, fs.realpathSync.native(workspaceD));
  dialogDelay = null;
  assert.equal(JSON.stringify(rows()), beforeCrossPurposePicker, 'cross-purpose picker reuse must not register the selected directory as a workspace');

  const created = await invoke('workspace:create', { id: 'created-d', name: 'Created D', path: workspaceD });
  assert.equal(created.id, 'created-d');
  assert.equal(created.name, 'Created D');
  assert.equal(created.path, fs.realpathSync.native(workspaceD));
  assert.equal(rowById('created-d').path, fs.realpathSync.native(workspaceD));
  const createdAgain = await invoke('workspace:create', { id: 'ignored-duplicate-d', name: 'Renamed D', path: workspaceD });
  assert.equal(createdAgain.id, 'created-d');
  assert.equal(createdAgain.name, 'Renamed D');
  assert.equal(rows().filter(row => row.path === fs.realpathSync.native(workspaceD)).length, 1);

  await assertRejectsWithoutRowChange(() => invoke('workspace:create', { id: 'bad-create', name: 'Bad', path: missingWorkspace }), /目录不存在/);

  dialogResult = { canceled: false, filePaths: [workspaceA] };
  const opened = await invoke('workspace:open');
  assert.equal(opened.id, 'existing');
  assert.equal(opened.name, 'Existing');
  assert.equal(opened.path, fs.realpathSync.native(workspaceA));
  assert.ok(authorizedRoots.includes(fs.realpathSync.native(workspaceA)));

  dialogResult = { canceled: false, filePaths: [workspaceA] };
  const reopened = await invoke('workspace:open');
  assert.equal(reopened.id, opened.id);
  assert.equal(rows().filter(row => row.path === fs.realpathSync.native(workspaceA)).length, 1);

  dialogResult = { canceled: false, filePaths: [missingWorkspace] };
  await assertRejectsWithoutRowChange(() => invoke('workspace:open'), /目录不存在/);

  dialogResult = { canceled: false, filePaths: [selectedFile] };
  await assertRejectsWithoutRowChange(() => invoke('workspace:open'), /路径不是文件夹/);

  const switched = await invoke('workspace:switch', opened.id);
  assert.equal(switched.id, opened.id);
  assert.equal(switched.path, fs.realpathSync.native(workspaceA));

  insertWorkspace('stale', 'Stale', missingWorkspace, 123);
  await assert.rejects(() => invoke('workspace:switch', 'stale'), /目录不存在/);
  assert.equal(rowById('stale').last_opened, 123);

  const switchedFromPath = await invoke('workspace:switch', {
    id: 'client-recent',
    name: 'Client Recent',
    path: workspaceB,
  });
  assert.equal(switchedFromPath.id, 'client-recent');
  assert.equal(switchedFromPath.name, 'Client Recent');
  assert.equal(switchedFromPath.path, fs.realpathSync.native(workspaceB));
  assert.ok(rowById('client-recent'));

  const switchedWithCollidingId = await invoke('workspace:switch', {
    id: 'client-recent',
    name: 'Collision Avoided',
    path: workspaceC,
  });
  assert.notEqual(switchedWithCollidingId.id, 'client-recent');
  assert.equal(switchedWithCollidingId.path, fs.realpathSync.native(workspaceC));
  assert.equal(rowById('client-recent').path, fs.realpathSync.native(workspaceB));

  const tree = await invoke('workspace:tree', workspaceA, 3);
  assert.equal(tree.name, path.basename(fs.realpathSync.native(workspaceA)));
  assert.equal(tree.type, 'directory');
  assert.ok(tree.children.some(child => child.name === 'src' && child.type === 'directory'));

  await assert.rejects(() => invoke('workspace:tree', missingWorkspace, 3), /目录不存在/);

  assert.equal(await invoke('workspace:delete', { id: 'stale-local-id', path: workspaceA }), true);
  assert.equal(rowById('existing'), undefined);
  assert.equal(authorizedRoots.includes(fs.realpathSync.native(workspaceA)), false);
  assert.equal(await invoke('workspace:delete', { id: 'missing', path: missingWorkspace }), true);
  assert.equal(rowById('stale'), undefined);
  assert.equal(await invoke('workspace:delete', { id: 'missing', path: missingWorkspace }), false);

  console.log('Workspace open integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to remove workspace-open temp directory:', error);
      process.exitCode = 1;
    }
  });
