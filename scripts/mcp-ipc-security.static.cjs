const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceHandler(source, channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = source.indexOf(marker);
  assert(start >= 0, `missing handler for ${channel}`);
  const end = source.indexOf('\n    });', start);
  assert(end > start, `could not locate end of ${channel} handler`);
  return source.slice(start, end);
}

function assertOrder(block, before, after, label) {
  const beforeIndex = block.indexOf(before);
  const afterIndex = block.indexOf(after);
  assert(beforeIndex >= 0, `${label}: missing ${before}`);
  assert(afterIndex >= 0, `${label}: missing ${after}`);
  assert(beforeIndex < afterIndex, `${label}: ${before} must happen before ${after}`);
}

const mcp = read('electron/ipc/mcp.ts');
const preload = read('electron/preload.ts');
const platform = read('src/platform/index.ts');
const bridge = read('src/services/mcpBridge.ts');
const main = read('electron/main.ts');

assert(
  mcp.includes("import { confirmSensitiveOperationInMainWindow } from './file';"),
  'mcp IPC must use the main-process confirmation dialog',
);

assert(
  mcp.includes('export function registerMCPHandlers(options: { disabled?: boolean } = {})')
  && main.includes('registerMCPHandlers({ disabled: externalMcpDisabled })')
  && mcp.includes("if (externalMcpDisabled) return { servers: [], disabled: true }")
  && mcp.includes("throw new MCPServerUnavailableError('External MCP is disabled for this runtime')"),
  'isolated runtime must fail closed across MCP status, lifecycle, list, and tool-task calls',
);

assert(
  mcp.includes('function confirmMCPToolCall') &&
  mcp.includes("'操作：调用 MCP 工具'") &&
  mcp.includes('`服务器：${serverName}`') &&
  mcp.includes('`工具：${toolName}`'),
  'tool-call confirmation must show operation, server, and tool',
);

assert(
  mcp.includes('function confirmMCPLifecycleChange') &&
  mcp.includes('`操作：${actionLabel}`') &&
  mcp.includes('`服务器：${serverName}`'),
  'lifecycle confirmation must show operation and server',
);

for (const [label, source] of [['preload', preload], ['platform', platform]]) {
  assert(source.includes('mcp: {'), `${label} must expose the renderer MCP API object`);
  assert(source.includes('callTool: (server: string, tool: string, params: any)'), `${label} must expose renderer direct MCP tool calls`);
  assert(source.includes('restart: (server: string)'), `${label} must expose renderer MCP restart`);
  assert(source.includes('start: (server: string)'), `${label} must expose renderer MCP start`);
  assert(source.includes('stop: (server: string)'), `${label} must expose renderer MCP stop`);
}

assert(
  preload.includes("ipcRenderer.invoke('mcp:callTool', server, tool, params)") &&
  preload.includes("ipcRenderer.invoke('mcp:restart', server)") &&
  preload.includes("ipcRenderer.invoke('mcp:start', server)") &&
  preload.includes("ipcRenderer.invoke('mcp:stop', server)"),
  'preload must wire renderer MCP calls to the existing main-process IPC channels',
);

const startBlock = sliceHandler(mcp, 'mcp:start');
assertOrder(
  startBlock,
  'const generation = advanceLifecycleGeneration(name);',
  "await confirmMCPLifecycleChange(event.sender, 'start', name);",
  'mcp:start intent cancellation',
);
assertOrder(
  startBlock,
  "await confirmMCPLifecycleChange(event.sender, 'start', name);",
  'assertLifecycleGeneration(name, generation);',
  'mcp:start approval generation validation',
);
assertOrder(
  startBlock,
  "await confirmMCPLifecycleChange(event.sender, 'start', name);",
  'await proc.start();',
  'mcp:start',
);

assertOrder(
  sliceHandler(mcp, 'mcp:stop'),
  "await confirmMCPLifecycleChange(event.sender, 'stop', name);",
  'await proc.stop();',
  'mcp:stop',
);

assertOrder(
  sliceHandler(mcp, 'mcp:restart'),
  "await confirmMCPLifecycleChange(event.sender, 'restart', name);",
  'await proc.stop();',
  'mcp:restart stop',
);

assertOrder(
  sliceHandler(mcp, 'mcp:restart'),
  "await confirmMCPLifecycleChange(event.sender, 'restart', name);",
  'await newProc.start();',
  'mcp:restart start',
);

assertOrder(
  sliceHandler(mcp, 'mcp:callTool'),
  'await confirmMCPToolCall(event.sender, serverName, toolName);',
  'return callMCPTool(serverName, toolName, args as Record<string, unknown>);',
  'mcp:callTool',
);

const callMCPToolStart = mcp.indexOf('export async function callMCPTool');
const callMCPToolEnd = mcp.indexOf('\nexport function registerMCPHandlers', callMCPToolStart);
assert(callMCPToolStart >= 0 && callMCPToolEnd > callMCPToolStart, 'could not locate callMCPTool body');
const callMCPToolBody = mcp.slice(callMCPToolStart, callMCPToolEnd);
assert(!callMCPToolBody.includes('confirmMCP'), 'internal callMCPTool must stay unconfirmed to avoid double confirmation through tool-task');

assert(
  bridge.includes('platform.toolTask.start({') && !bridge.includes('platform.mcp.callTool('),
  'mcpBridge must keep using brokered tool-task execution instead of direct mcp:callTool IPC',
);
assert(
  mcp.includes('const listedTools = running ? await proc')
  && bridge.includes('Array.isArray(server.toolDefinitions)'),
  'mcp status must return reusable tool definitions so renderer refresh does not list every server twice',
);
assert(
  (mcp.match(/new Map\(listedTools\.map\(tool => \[tool\.name, tool\]\)\)/g) || []).length === 1,
  'shared MCP status projection must deduplicate tool definitions by name',
);
assert(
  mcp.includes('const lifecycleOperations = new Map<string, Promise<unknown>>()')
  && (mcp.match(/return withServerLifecycle\(name, async \(\) => \{/g) || []).length === 2,
  'MCP start and restart must serialize per server name',
);
const stopBlock = sliceHandler(mcp, 'mcp:stop');
assert(!stopBlock.includes('withServerLifecycle'), 'MCP stop must cancel immediately instead of queueing behind start');
assertOrder(stopBlock, 'advanceLifecycleGeneration(name);', 'await proc.stop();', 'mcp:stop generation cancellation');
assert(
  mcp.includes('function removeServerIfCurrent(name: string, proc: MCPServerProcess)')
  && (mcp.match(/removeServerIfCurrent\(name, /g) || []).length >= 6,
  'late cleanup must only remove the process instance that is still current',
);
assert(
  mcp.includes('const configuredServers = await Promise.all(')
  && mcp.includes('const unconfiguredServers = await Promise.all('),
  'MCP status must query independent servers concurrently',
);

const processSource = read('electron/mcp/MCPServerProcess.ts');
assert(
  processSource.includes('private httpLifecycleGeneration = 0')
  && processSource.includes('generation !== this.httpLifecycleGeneration')
  && processSource.includes('this.httpLifecycleGeneration += 1;'),
  'HTTP MCP start must not revive after a later stop',
);
assert(
  processSource.includes('private stdioStartPromise: Promise<void> | null = null')
  && processSource.includes('private stdioLifecycleGeneration = 0')
  && processSource.includes('MCP stdio start cancelled:'),
  'stdio MCP concurrent starts must join one lifecycle generation and Stop must cancel it',
);
assert(
  processSource.includes('private httpReinitPromise: Promise<void> | null = null')
  && !processSource.includes('private reHandshaking = false'),
  'HTTP session re-initialization must use a joinable single-flight promise',
);
assert(
  processSource.includes("if (this._status === 'running') this.transitionToError();")
  && processSource.includes("this.emit('status-change', { name: this.name, status: 'error' })"),
  'listTools transport failure must transition the visible server status to error',
);
assert(
  processSource.includes("if (this._status !== 'running') throw new Error(`MCP http server is not running: ${this.name}`)")
  && processSource.includes('MCP http request cancelled:'),
  'HTTP MCP re-handshake and late request results must stop at the current lifecycle generation',
);
assert(
  processSource.includes("}, this.initializeTimeoutMs);")
  && processSource.includes("this.httpNotify('notifications/initialized', undefined, this.initializeTimeoutMs)"),
  'HTTP MCP initialize and initialized notification must share the configured startup timeout',
);

for (const [label, source] of [['preload', preload], ['platform', platform]]) {
  assert(!source.includes('confirmToken'), `${label} must not expose renderer-minted MCP confirmation tokens`);
  assert(!source.includes('mcp:confirm'), `${label} must not expose a renderer MCP confirmation channel`);
}

console.log('mcp IPC security assertions passed');
