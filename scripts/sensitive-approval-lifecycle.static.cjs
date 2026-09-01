const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(source, expected, message) {
  assert(source.includes(expected), message);
}

function assertOrder(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert(firstIndex >= 0, `${message}: missing first marker`);
  assert(secondIndex >= 0, `${message}: missing second marker`);
  assert(firstIndex < secondIndex, message);
}

const fileIpc = readSource('electron/ipc/file.ts');
const commandIpc = readSource('electron/ipc/command.ts');
const toolTaskIpc = readSource('electron/ipc/toolTask.ts');
const main = readSource('electron/main.ts');

assertIncludes(fileIpc, 'interface ActiveSensitiveApproval', 'approval registry must use a typed active-window record');
assertIncludes(fileIpc, 'window: BrowserWindow;', 'approval registry must retain the BrowserWindow handle');
assertIncludes(fileIpc, 'const activeSensitiveApprovals = new Map<string, ActiveSensitiveApproval>();', 'active approvals must share one registry');
assertIncludes(fileIpc, 'if (options.approvalId) activeSensitiveApprovals.get(registryKey)?.cancel();', 'duplicate approvalId must cancel the old active approval');
assertIncludes(fileIpc, 'export function shutdownSensitiveOperationApprovals(): void', 'app shutdown needs an exported approval cleanup hook');
assertIncludes(fileIpc, 'modal.removeListener(\'closed\', onClosed);', 'approval finish must remove modal closed listener');
assertIncludes(fileIpc, 'modal.webContents.removeListener(\'will-navigate\', onWillNavigate);', 'approval finish must remove navigation listener');
assertIncludes(fileIpc, 'modal.webContents.removeListener(\'before-input-event\', onBeforeInputEvent);', 'approval finish must remove keyboard listener');
assertIncludes(fileIpc, 'clearTimeout(timeoutHandle);', 'approval finish must clear timeout');
assertIncludes(fileIpc, 'activeSensitiveApprovals.delete(registryKey);', 'approval finish must remove registry entry');
assertIncludes(fileIpc, 'if (!modal.isDestroyed()) modal.destroy();', 'approval finish must destroy the modal window');
assertOrder(fileIpc, 'cleanup();', 'if (!modal.isDestroyed()) modal.destroy();', 'finish must clean listeners before destroying the window');
assertOrder(fileIpc, 'if (!modal.isDestroyed()) modal.destroy();', 'resolve(approved);', 'finish must destroy the window before resolving approval');
assertIncludes(fileIpc, 'cancelSensitiveOperationApprovalsForSender(sender.id);', 'sender destruction must cancel active approvals');

assertIncludes(commandIpc, 'function findReusableCommandTask(', 'legacy command IPC needs reusable-task preflight');
assertOrder(commandIpc, 'const reusableTask = findReusableCommandTask(taskId, requestHash(command, effectiveCwd)', 'const approvalStartedAt = Date.now();', 'legacy command preflight must run before approval starts');
assertIncludes(commandIpc, 'if (reusableTask) return reusableTask;', 'legacy command preflight must return existing active or persisted task');

assertIncludes(toolTaskIpc, 'async function findExistingToolTask(', 'tool-task IPC needs existing-task preflight');
assertOrder(toolTaskIpc, 'const existingTask = await findExistingToolTask(request);', 'confirmSensitiveOperationInMainWindow(event.sender, {', 'tool-task preflight must run before opening approval');
assertIncludes(toolTaskIpc, 'if (!existingTask && request.kind === \'command\')', 'command tool-task approval must be skipped for existing taskId');
assertIncludes(toolTaskIpc, 'else if (!existingTask && request.kind === \'mcp\')', 'MCP tool-task approval must be skipped for existing taskId');

assertIncludes(main, 'shutdownSensitiveOperationApprovals', 'main must import approval shutdown hook');
assertOrder(main, 'shutdownSensitiveOperationApprovals();', 'Promise.allSettled([shutdownToolTasks(), shutdownCommandTasks(), shutdownAllMCP()])', 'before-quit must close approval windows before task shutdown');

console.log('sensitive-approval-lifecycle static: all assertions passed');
