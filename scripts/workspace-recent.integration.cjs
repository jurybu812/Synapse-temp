const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const sourcePath = path.join(__dirname, '..', 'src', 'store', 'slices', 'workspace.ts');
const storePath = path.join(__dirname, '..', 'src', 'store', 'index.ts');
const conversationListPath = path.join(__dirname, '..', 'src', 'components', 'chat', 'ConversationList.tsx');
const welcomePagePath = path.join(__dirname, '..', 'src', 'components', 'editor', 'WelcomePage.tsx');
const fileSystemPath = path.join(__dirname, '..', 'src', 'services', 'fileSystem.ts');
const mainWorkspaceSourcePath = path.join(__dirname, '..', 'electron', 'ipc', 'workspace.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(output, sourcePath);

const {
  workspaceSlice,
  openWorkspace,
  setRecentPaths,
  sanitizePersistedWorkspaceState,
  buildWorkspaceMoveTargets,
  workspacePathKey,
} = loaded.exports;

assert.equal(workspacePathKey('C:\\Repo\\'), 'c:/repo');
assert.equal(workspacePathKey('c:/repo'), 'c:/repo');

let state = workspaceSlice.reducer(undefined, { type: '@@init' });
state = workspaceSlice.reducer(state, openWorkspace({ path: 'C:\\Repo', name: 'Repo' }));
state = workspaceSlice.reducer(state, openWorkspace({ path: 'c:\\repo\\', name: 'Repo again' }));
assert.deepEqual(state.recentPaths, ['c:\\repo\\']);
state = workspaceSlice.reducer(state, setRecentPaths([
  'C:\\One',
  'c:/one/',
  'C:\\Two\\',
  'c:/two',
]));
assert.deepEqual(state.recentPaths, ['C:\\One', 'C:\\Two\\']);

const persistedReload = sanitizePersistedWorkspaceState({
  currentPath: 'C:\\Repo\\',
  name: 'Repo',
  recentPaths: [
    'C:\\One',
    'c:/one/',
    'D:\\Two\\',
    'd:/two',
    'E:/Three',
    'F:/Four',
    'G:/Five',
    'H:/Six',
    'I:/Seven',
    'J:/Eight',
    'K:/Nine',
    'L:/Ten',
    'M:/Eleven',
  ],
});
assert.deepEqual(persistedReload, {
  currentPath: 'C:\\Repo\\',
  name: 'Repo',
  recentPaths: [
    'C:\\One',
    'D:\\Two\\',
    'E:/Three',
    'F:/Four',
    'G:/Five',
    'H:/Six',
    'I:/Seven',
    'J:/Eight',
    'K:/Nine',
    'L:/Ten',
  ],
});

const persistedDemo = sanitizePersistedWorkspaceState({
  currentPath: '/workspace/',
  name: 'Demo',
  recentPaths: ['/workspace', '/workspace/', 'C:/Real', 'c:\\real\\', null],
});
assert.deepEqual(persistedDemo, {
  currentPath: null,
  name: '',
  recentPaths: ['C:/Real'],
});

const persistedWrite = sanitizePersistedWorkspaceState({
  currentPath: 'D:/Beta',
  name: 'Beta',
  recentPaths: ['D:/Alpha', 'd:\\alpha\\', 'D:/Beta/', 'd:\\beta', 'E:/Gamma'],
});
assert.deepEqual(persistedWrite, {
  currentPath: 'D:/Beta',
  name: 'Beta',
  recentPaths: ['D:/Alpha', 'D:/Beta/', 'E:/Gamma'],
});

assert.deepEqual(
  buildWorkspaceMoveTargets('C:\\Repo', ['c:/repo/', 'D:\\One\\', 'd:/one', 'E:/Two']),
  ['C:\\Repo', 'D:\\One\\', 'E:/Two'],
);
const cappedMoveTargets = buildWorkspaceMoveTargets('C:/Current', [
  'D:/One',
  'E:/Two',
  'F:/Three',
  'G:/Four',
  'H:/Five',
  'I:/Six',
  'J:/Seven',
  'K:/Eight',
  'L:/Nine',
  'M:/Ten',
  'N:/Eleven',
]);
assert.equal(cappedMoveTargets.length, 10);
assert.deepEqual(cappedMoveTargets.slice(0, 3), ['C:/Current', 'D:/One', 'E:/Two']);

const storeSource = fs.readFileSync(storePath, 'utf8');
assert.match(
  storeSource,
  /const workspace = sanitizePersistedWorkspaceState\([\s\S]*workspaceSlice\.getInitialState\(\)/,
  'persisted reload must sanitize workspace state',
);
assert.match(
  storeSource,
  /localStorage\.setItem\(WORKSPACE_KEY,\s*JSON\.stringify\(sanitizePersistedWorkspaceState\(\{[\s\S]*currentPath,[\s\S]*name,[\s\S]*recentPaths,[\s\S]*\}\)\)\)/,
  'workspace writes must sanitize before persistence',
);

const conversationListSource = fs.readFileSync(conversationListPath, 'utf8');
assert.ok(conversationListSource.includes('buildWorkspaceMoveTargets(workspaceCurrentPath, recentPaths)'), 'move menu must dedupe equivalent workspace targets');
assert.ok(conversationListSource.includes('workspacePathKey(conv.workspacePath)'), 'move menu active state must compare equivalent workspace paths');

const welcomePageSource = fs.readFileSync(welcomePagePath, 'utf8');
assert.match(
  welcomePageSource,
  /window\.synapse\.workspace\.recent\(50\)[\s\S]*fileSystem\.registerRecentWorkspaces\(hydrated\)[\s\S]*dispatch\(setRecentPaths\(/,
  'welcome page must hydrate main-process recent workspaces without requiring an active Redux workspace',
);
const fileSystemSource = fs.readFileSync(fileSystemPath, 'utf8');
assert.match(
  fileSystemSource,
  /registerRecentWorkspaces\(recentWorkspaces: Workspace\[\]\): void[\s\S]*this\.saveWorkspaces\(\);[\s\S]*this\.notify\(\);/,
  'recent workspace hydration must update the renderer workspace registry',
);
const recentRegistrationBody = fileSystemSource.match(/registerRecentWorkspaces\(recentWorkspaces: Workspace\[\]\): void \{([\s\S]*?)\n  \}\n\n  getCurrentWorkspace/);
assert.ok(recentRegistrationBody, 'recent workspace registration implementation must be discoverable');
assert.doesNotMatch(
  recentRegistrationBody[1],
  /beginWorkspaceTransition\(|this\.fileTree\s*=/,
  'recent workspace hydration must not switch or replace the current workspace tree',
);

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function cloneRow(row) {
  return row ? { ...row } : undefined;
}

function createFakeWorkspaceDatabase(workspaceRows, nextUnix) {
  const recentRows = limit => workspaceRows
    .slice()
    .sort((left, right) => (right.last_opened ?? right.updated_at) - (left.last_opened ?? left.updated_at))
    .slice(0, typeof limit === 'number' ? limit : workspaceRows.length)
    .map(cloneRow);

  return {
    prepare(sql) {
      const normalizedSql = normalizeSql(sql);
      return {
        all(limit) {
          if (normalizedSql === "SELECT path FROM workspaces WHERE path IS NOT NULL AND path <> ''") {
            return workspaceRows.filter(row => row.path).map(row => ({ path: row.path }));
          }
          if (normalizedSql === 'SELECT * FROM workspaces') {
            return workspaceRows.map(cloneRow);
          }
          if (normalizedSql === 'SELECT * FROM workspaces ORDER BY COALESCE(last_opened, updated_at) DESC') {
            return recentRows();
          }
          if (normalizedSql === 'SELECT * FROM workspaces ORDER BY COALESCE(last_opened, updated_at) DESC LIMIT ?') {
            return recentRows(limit);
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

function loadMainWorkspaceModule({ database, handlers, dialogRef, userDataPath }) {
  const source = fs.readFileSync(mainWorkspaceSourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: mainWorkspaceSourcePath,
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
      showOpenDialog: async () => dialogRef.current,
    },
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
  };
  const fileAccessMock = {
    enforceAgentFileAccess: filePath => filePath,
    registerAuthorizedWorkspaceRoot: () => {},
    replaceAuthorizedWorkspaceRoots: () => {},
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
    path.dirname(mainWorkspaceSourcePath),
    mainWorkspaceSourcePath,
  );
  return runtimeModule.exports;
}

function invoke(handlers, channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  try {
    return Promise.resolve(handler({ sender: { id: 42 } }, ...args));
  } catch (error) {
    return Promise.reject(error);
  }
}

function flipAsciiCase(value) {
  return value.replace(/[A-Za-z]/g, char => (
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()
  ));
}

async function assertMainProcessWindowsRecentDedupes() {
  if (process.platform !== 'win32') {
    console.log('Workspace recent main-process Windows path fixture skipped on non-Windows platform');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-workspace-recent-'));
  const userDataPath = path.join(tempRoot, 'user-data');
  const workspaceDir = path.join(tempRoot, 'CaseSlashWorkspace');
  const otherDir = path.join(tempRoot, 'OtherWorkspace');
  const workspaceRows = [];
  let currentUnix = 1_700_000_000;
  const nextUnix = () => {
    currentUnix += 1;
    return currentUnix;
  };
  const insertWorkspace = (id, name, workspacePath, lastOpened) => {
    workspaceRows.push({
      id,
      name,
      path: workspacePath,
      created_at: lastOpened,
      updated_at: lastOpened,
      last_opened: lastOpened,
    });
  };

  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    fs.mkdirSync(userDataPath, { recursive: true });

    const canonicalPath = fs.realpathSync.native(workspaceDir);
    const otherPath = fs.realpathSync.native(otherDir);
    const legacyForwardSlashPath = `${flipAsciiCase(canonicalPath).replace(/\\/g, '/')}/`;
    const legacyBackslashPath = `${flipAsciiCase(canonicalPath).replace(/\//g, '\\')}\\`;
    insertWorkspace('legacy-forward', 'Legacy Forward', legacyForwardSlashPath, 100);
    insertWorkspace('other', 'Other', otherPath, 95);
    insertWorkspace('legacy-backslash', 'Legacy Backslash', legacyBackslashPath, 90);

    const handlers = new Map();
    const dialogRef = { current: { canceled: false, filePaths: [canonicalPath] } };
    const database = createFakeWorkspaceDatabase(workspaceRows, nextUnix);
    const { registerWorkspaceHandlers } = loadMainWorkspaceModule({
      database,
      handlers,
      dialogRef,
      userDataPath,
    });
    registerWorkspaceHandlers();

    const opened = await invoke(handlers, 'workspace:open');
    assert.equal(opened.id, 'legacy-forward');
    assert.equal(opened.name, 'Legacy Forward');
    assert.equal(opened.path, canonicalPath);
    assert.equal(workspaceRows.length, 3, 'opening an equivalent realpath must update an old row instead of inserting');
    assert.equal(workspaceRows.filter(row => row.path === canonicalPath).length, 1);
    assert.equal(workspaceRows.some(row => row.id.startsWith('ws_')), false);

    const switched = await invoke(handlers, 'workspace:switch', {
      id: 'fresh-client-id',
      name: 'Canonical Switch',
      path: legacyBackslashPath,
    });
    assert.equal(switched.id, 'legacy-forward');
    assert.equal(switched.name, 'Canonical Switch');
    assert.equal(switched.path, canonicalPath);
    assert.equal(workspaceRows.length, 3, 'switching an equivalent realpath must update an old row instead of inserting');

    const recent = await invoke(handlers, 'workspace:recent', 10);
    assert.deepEqual(
      recent.map(row => row.id),
      ['legacy-forward', 'other'],
      'recent workspaces must dedupe equivalent Windows case, slash, and trailing-slash variants while keeping newest order',
    );
    assert.deepEqual(await invoke(handlers, 'workspace:recent', 0), []);

    assert.equal(await invoke(handlers, 'workspace:delete', { id: 'legacy-forward', path: canonicalPath }), true);
    assert.deepEqual(
      workspaceRows.map(row => row.id),
      ['other'],
      'deleting a recent workspace must remove all realpath-equivalent duplicate rows',
    );
    assert.equal(await invoke(handlers, 'workspace:delete', { id: 'legacy-forward', path: canonicalPath }), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

assertMainProcessWindowsRecentDedupes()
  .then(() => {
    console.log('Workspace recent integration: all assertions passed');
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
