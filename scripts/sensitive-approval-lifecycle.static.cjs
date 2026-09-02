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

function assertNotIncludes(source, forbidden, message) {
  assert(!source.includes(forbidden), message);
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
const preload = readSource('electron/preload.ts');
const app = readSource('src/App.tsx');
const agentPanel = readSource('src/components/layout/AgentPanel.tsx');
const approvalCoordinator = readSource('src/services/approvalCoordinator.ts');
const approvalDialog = readSource('src/components/ui/ApprovalDialog.tsx');

assertNotIncludes(fileIpc, 'new BrowserWindow({', 'sensitive approval must not create a standalone BrowserWindow');
assertNotIncludes(fileIpc, 'synapse-file-approval://', 'sensitive approval must not use a private approval window protocol');
assertNotIncludes(fileIpc, 'data:text/html;charset=utf-8', 'sensitive approval must not load a standalone data-url renderer');
assertIncludes(fileIpc, 'interface ActiveSensitiveApproval', 'approval registry must keep typed active request records');
assertIncludes(fileIpc, 'requestId: string;', 'approval registry must retain renderer request identity');
assertIncludes(fileIpc, 'const activeSensitiveApprovals = new Map<string, ActiveSensitiveApproval>();', 'active approvals must share one registry');
assertIncludes(fileIpc, 'const activeSensitiveApprovalRequestKeys = new Map<string, string>();', 'renderer request ids must map back to active approval records');
assertIncludes(fileIpc, "ipcMain.on('sensitive-approval:response'", 'main process must accept renderer approval responses');
assertIncludes(fileIpc, 'active.finish(payload.approved === true);', 'only an explicit true response may approve');
assertIncludes(fileIpc, 'registerSensitiveApprovalResponseHandler();', 'approval requests must ensure response handler registration');
assertIncludes(fileIpc, "sender.send('sensitive-approval:request', rendererRequest);", 'main process must render approvals inside the existing main window');
assertIncludes(fileIpc, "sender.send('sensitive-approval:cancel', { requestId });", 'main process cancellation must remove stale renderer approvals');
assertIncludes(fileIpc, 'sender.once(\'destroyed\', onSenderGone);', 'window close must reject pending approval');
assertIncludes(fileIpc, 'sender.once(\'render-process-gone\', onSenderGone);', 'renderer crash must reject pending approval');
assertIncludes(fileIpc, 'sender.on(\'did-start-navigation\', onDidStartNavigation);', 'page reload/navigation must reject pending approval');
assertIncludes(fileIpc, 'if (!isMainFrame || isInPlace) return;', 'same-document navigation must not cancel approval');
assertIncludes(fileIpc, 'timeoutHandle = setTimeout(cancel, timeoutMs);', 'approval timeout must reject');
assertIncludes(fileIpc, 'if (options.approvalId) activeSensitiveApprovals.get(registryKey)?.cancel();', 'duplicate approvalId must cancel the old active approval');
assertIncludes(fileIpc, 'export function shutdownSensitiveOperationApprovals(): void', 'app shutdown needs an exported approval cleanup hook');
assertOrder(fileIpc, 'activeSensitiveApprovals.set(registryKey, activeRecord);', "sender.send('sensitive-approval:request', rendererRequest);", 'approval must be registered before renderer can answer');

assertIncludes(commandIpc, "toolName: 'run_command'", 'legacy command IPC must label command approvals as run_command');
assertIncludes(commandIpc, "level: 'command'", 'legacy command IPC must mark command approvals as command level');
assertIncludes(toolTaskIpc, "toolName: 'run_command'", 'tool-task command approval must label the tool as run_command');
assertIncludes(toolTaskIpc, "level: 'command'", 'tool-task command approval must mark command level');
assertIncludes(toolTaskIpc, 'const requestedCwd = typeof input.cwd === \'string\' ? input.cwd.trim() : \'\';', 'tool-task command approval must normalize requested cwd before display');
assertIncludes(toolTaskIpc, 'const effectiveCwd = requestedCwd ? resolveFilePath(requestedCwd) : process.cwd();', 'tool-task command approval must display the effective cwd');
assertIncludes(toolTaskIpc, 'conversationId: request.identity.conversationId,', 'tool-task approvals must preserve conversation identity');
assertIncludes(toolTaskIpc, 'ownerId: request.identity.ownerId,', 'tool-task approvals must preserve owner identity');
assertIncludes(fileIpc, 'conversationId: options.conversationId,', 'main-process approval payload must carry conversation identity');
assertIncludes(preload, 'conversationId?: string;', 'preload approval bridge must expose conversation identity');

assertIncludes(preload, 'approval: {', 'preload must expose the approval bridge');
assertIncludes(preload, "ipcRenderer.on('sensitive-approval:request', listener);", 'renderer must subscribe to approval requests');
assertIncludes(preload, "ipcRenderer.on('sensitive-approval:cancel', listener);", 'renderer must subscribe to approval cancellations');
assertIncludes(preload, "ipcRenderer.send('sensitive-approval:response', { requestId, approved });", 'renderer must send approval responses through IPC');

assertIncludes(app, '<ApprovalDialogHost />', 'global app root must host the approval dialog');
assertNotIncludes(agentPanel, '<ApprovalDialog request=', 'AgentPanel must not render a second approval host');
assertIncludes(approvalCoordinator, 'requestTicket(ticket: Omit<ApprovalTicket, \'queuedCount\'>): Promise<boolean>', 'approvalCoordinator must accept main-process tickets');
assertIncludes(approvalCoordinator, 'queuedCount: Math.max(0, this.queue.length - 1)', 'approvalCoordinator must expose queued approval count');
assertIncludes(approvalDialog, 'request.confirmLabel ?? approveLabel', 'ApprovalDialog must respect main-process confirm labels');
assertIncludes(approvalDialog, 'request.title ?? `${request.originLabel}请求执行工具`', 'ApprovalDialog must respect main-process titles');
assertIncludes(approvalDialog, '排队 {request.queuedCount} 个', 'ApprovalDialog must surface queued approval count');

console.log('sensitive-approval-lifecycle static: all assertions passed');
