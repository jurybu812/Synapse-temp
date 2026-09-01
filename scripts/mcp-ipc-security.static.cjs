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

assertOrder(
  sliceHandler(mcp, 'mcp:start'),
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
  (mcp.match(/new Map\(listedTools\.map\(tool => \[tool\.name, tool\]\)\)/g) || []).length === 2,
  'mcp status must deduplicate configured and runtime-only tool definitions by name',
);

for (const [label, source] of [['preload', preload], ['platform', platform]]) {
  assert(!source.includes('confirmToken'), `${label} must not expose renderer-minted MCP confirmation tokens`);
  assert(!source.includes('mcp:confirm'), `${label} must not expose a renderer MCP confirmation channel`);
}

console.log('mcp IPC security assertions passed');
