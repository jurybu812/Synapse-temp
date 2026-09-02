const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const snapshotPath = path.join(root, 'src', 'services', 'executionWorkspaceSnapshot.ts');
const fileSystemPath = path.join(root, 'src', 'services', 'fileSystem.ts');
const agentLoopPath = path.join(root, 'src', 'services', 'agentLoop.ts');
const agentPanelPath = path.join(root, 'src', 'components', 'layout', 'AgentPanel.tsx');
const executionRegistryPath = path.join(root, 'src', 'services', 'executionRegistry.ts');
const appLayoutPath = path.join(root, 'src', 'components', 'layout', 'AppLayout.tsx');
const sidebarPath = path.join(root, 'src', 'components', 'layout', 'Sidebar.tsx');
const welcomePath = path.join(root, 'src', 'components', 'editor', 'WelcomePage.tsx');

const snapshotSource = fs.readFileSync(snapshotPath, 'utf8');
const transpiled = ts.transpileModule(snapshotSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: snapshotPath,
}).outputText;
const snapshotModule = new Module(snapshotPath, module);
snapshotModule.filename = snapshotPath;
snapshotModule.paths = Module._nodeModulePaths(path.dirname(snapshotPath));
snapshotModule._compile(transpiled, snapshotPath);

const {
  setExecutionWorkspaceSnapshot,
  getExecutionWorkspaceSnapshot,
  clearExecutionWorkspaceSnapshot,
} = snapshotModule.exports;

setExecutionWorkspaceSnapshot('conversation-a', {
  runId: 'run-a',
  activeWorktreePath: null,
  repoRoot: null,
  currentPath: 'C:\\workspace-a',
});
assert.equal(getExecutionWorkspaceSnapshot('conversation-a').currentPath, 'C:\\workspace-a');

setExecutionWorkspaceSnapshot('conversation-a', {
  runId: 'run-b',
  activeWorktreePath: 'C:\\workspace-a-worktree',
  repoRoot: 'C:\\workspace-a',
  currentPath: 'C:\\workspace-a',
});
clearExecutionWorkspaceSnapshot('conversation-a', 'run-a');
assert.equal(getExecutionWorkspaceSnapshot('conversation-a').runId, 'run-b');
clearExecutionWorkspaceSnapshot('conversation-a', 'run-b');
assert.equal(getExecutionWorkspaceSnapshot('conversation-a'), null);

const fileSystemSource = fs.readFileSync(fileSystemPath, 'utf8');
assert.match(fileSystemSource, /captureExecutionWorkspaceSnapshot/);
assert.match(fileSystemSource, /const snapshot = getExecutionWorkspaceSnapshot\(contextId\)/);
assert.match(fileSystemSource, /if \(snapshot\)/);

const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf8');
const agentPanelSource = fs.readFileSync(agentPanelPath, 'utf8');
assert.match(agentLoopSource, /const executionWorkspaceContextId = this\.executionContext\.ownerId/);
assert.match(agentLoopSource, /await captureExecutionWorkspaceSnapshot\(executionWorkspaceContextId, this\.executionContext\.runId, this\.runConvId!\)/);
assert.match(agentLoopSource, /releaseExecutionWorkspaceSnapshot\(executionWorkspaceContextId, completedContext\.runId\)/);
assert.match(agentPanelSource, /contextId: context\.ownerId/);

const executionRegistrySource = fs.readFileSync(executionRegistryPath, 'utf8');
assert.match(executionRegistrySource, /isConversationRunning\(conversationId: string\): boolean/);
assert.match(executionRegistrySource, /this\.activeRunByOwner\.has\(ownerId\)/);
assert.match(executionRegistrySource, /this\.getLoop\(conversationId\)\?\.isRunning === true/);
for (const sourcePath of [appLayoutPath, sidebarPath, welcomePath]) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /getWorkspaceChangeBlockState\(activeConversation\)/);
  assert.match(source, /workspaceChangeBlockMessage\(blockState\)/);
}

console.log('Workspace run snapshot integration: all assertions passed');
