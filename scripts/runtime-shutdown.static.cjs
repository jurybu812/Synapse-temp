const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'electron/mcp/MCPServerProcess.ts'), 'utf8');

assert.match(main, /QUIT_CLEANUP_TIMEOUT_MS\s*=\s*8_000/);
assert.match(main, /Promise\.race\(\[/);
assert.match(main, /Promise\.allSettled\(\[shutdownToolTasks\(\), shutdownCommandTasks\(\), shutdownAllMCP\(\)\]\)/);
assert.ok(main.indexOf('registerConfigHandlers();') < main.indexOf('createWindow();'), 'IPC handlers must exist before the first renderer loads');
assert.match(
  mcp,
  /signal:\s*AbortSignal\.any\(\[\s*lifecycleSignal,\s*AbortSignal\.timeout\(timeout\),?\s*\]\)/,
);
assert.match(mcp, /signal:\s*AbortSignal\.timeout\(3000\)/);
assert.match(mcp, /if \(!response\.ok\) throw new Error\(`MCP http \$\{response\.status\} \$\{method\}`\)/);

console.log('Runtime shutdown static integration: all assertions passed');
