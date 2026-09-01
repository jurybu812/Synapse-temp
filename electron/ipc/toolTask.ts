import { ipcMain } from 'electron';
import { TaskBroker } from '../toolTasks/TaskBroker';
import { CommandTaskExecutor } from '../toolTasks/executors/command';
import { McpTaskExecutor } from '../toolTasks/executors/mcp';
import { WebFetchTaskExecutor } from '../toolTasks/executors/webFetch';
import { WebSearchTaskExecutor } from '../toolTasks/executors/webSearch';
import { FileSearchTaskExecutor } from '../toolTasks/executors/fileSearch';
import { SandboxJavascriptTaskExecutor } from '../toolTasks/executors/sandboxJavascript';
import type { ToolTaskAccessContext, ToolTaskListRequest, ToolTaskRebindRequest, ToolTaskSnapshot, ToolTaskStartRequest } from '../toolTasks/types';
import { cancelSensitiveOperationApproval, confirmSensitiveOperationInMainWindow } from './file';

const taskBroker = new TaskBroker();
let initialized = false;

async function findExistingToolTask(request: ToolTaskStartRequest): Promise<ToolTaskSnapshot | null> {
    const taskId = typeof request?.taskId === 'string' ? request.taskId.trim() : '';
    const identity = request?.identity;
    if (!taskId || !identity?.conversationId || !identity.ownerId) return null;
    try {
        const snapshot = await taskBroker.status(taskId, {
            conversationId: identity.conversationId,
            ownerId: identity.ownerId,
        });
        return snapshot.kind === request.kind ? snapshot : null;
    } catch {
        return null;
    }
}

export function registerToolTaskHandlers(): void {
    if (initialized) return;
    initialized = true;
    taskBroker.register(new CommandTaskExecutor());
    taskBroker.register(new McpTaskExecutor());
    taskBroker.register(new WebFetchTaskExecutor());
    taskBroker.register(new WebSearchTaskExecutor());
    taskBroker.register(new FileSearchTaskExecutor());
    taskBroker.register(new SandboxJavascriptTaskExecutor());
    ipcMain.handle('tool-task:start', async (event, request: ToolTaskStartRequest) => {
        const existingTask = await findExistingToolTask(request);
        if (!existingTask && request.kind === 'command') {
            const input = request.input && typeof request.input === 'object' ? request.input as Record<string, unknown> : {};
            const command = typeof input.command === 'string' ? input.command.trim() : '';
            if (!command) throw new Error('command 不能为空');
            const approved = await confirmSensitiveOperationInMainWindow(event.sender, {
                title: '确认运行系统命令',
                message: '系统命令可能读取、修改或删除工作区外的数据。确认后只会启动下列这一条命令。',
                details: [
                    `命令：${command}`,
                    `工作目录：${typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : process.cwd()}`,
                ],
                confirmLabel: '运行命令',
                approvalId: request.taskId ? `tool-task:${request.taskId}` : undefined,
            });
            if (!approved) throw new Error('用户取消了系统命令');
        } else if (!existingTask && request.kind === 'mcp') {
            const input = request.input && typeof request.input === 'object' ? request.input as Record<string, unknown> : {};
            const server = typeof input.server === 'string' ? input.server : '未知服务器';
            const tool = typeof input.tool === 'string' ? input.tool : '未知工具';
            const approved = await confirmSensitiveOperationInMainWindow(event.sender, {
                title: '确认调用外部 MCP 工具',
                message: '外部 MCP 由独立进程或服务执行，Synapse 无法替它验证最终文件、网页或远端副作用。',
                details: [
                    `服务器：${server}`,
                    `工具：${tool}`,
                    `声明级别：${typeof input.approvalLevel === 'string' ? input.approvalLevel : '未知'}`,
                ],
                confirmLabel: '允许本次调用',
                approvalId: request.taskId ? `tool-task:${request.taskId}` : undefined,
            });
            if (!approved) throw new Error('用户取消了外部 MCP 工具');
        }
        return taskBroker.start(request);
    });
    ipcMain.handle('tool-task:list', (_event, request: ToolTaskListRequest) => taskBroker.list(request));
    ipcMain.handle('tool-task:status', (_event, taskId: string, access: ToolTaskAccessContext) => taskBroker.status(taskId, access));
    ipcMain.handle('tool-task:wait', (_event, taskId: string, waitSeconds: number, access: ToolTaskAccessContext) => taskBroker.wait(taskId, waitSeconds, access));
    ipcMain.handle('tool-task:cancel', (_event, taskId: string, access: ToolTaskAccessContext) => taskBroker.cancel(taskId, access));
    ipcMain.handle('tool-task:cancelPendingApproval', (event, taskId: string) => {
        if (!taskId || typeof taskId !== 'string') return false;
        return cancelSensitiveOperationApproval(event.sender.id, `tool-task:${taskId}`);
    });
    ipcMain.handle('tool-task:rebindConversation', (_event, request: ToolTaskRebindRequest) => taskBroker.rebindConversation(request));
}

export async function shutdownToolTasks(): Promise<void> {
    await taskBroker.shutdown();
}
