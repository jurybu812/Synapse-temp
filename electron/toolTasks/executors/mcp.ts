import { callMCPTool, MCPServerUnavailableError } from '../../ipc/mcp';
import { ManagedTaskError, ManagedTaskExecutor, type ManagedTaskExecutionContext, type ManagedTaskOutput } from '../ManagedTaskExecutor';

type McpApprovalLevel = 'auto' | 'read' | 'write' | 'dangerous';

interface McpTaskInput {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    approvalLevel: McpApprovalLevel;
}

function parseInput(input: unknown): McpTaskInput {
    if (!input || typeof input !== 'object') throw new ManagedTaskError('MCP 任务输入无效', 'invalid_result', false);
    const candidate = input as Partial<McpTaskInput>;
    const approvalLevel = candidate.approvalLevel;
    if (typeof candidate.server !== 'string' || !candidate.server.trim()) throw new ManagedTaskError('MCP 任务缺少 server', 'invalid_result', false);
    if (typeof candidate.tool !== 'string' || !candidate.tool.trim()) throw new ManagedTaskError('MCP 任务缺少 tool', 'invalid_result', false);
    if (approvalLevel !== 'auto' && approvalLevel !== 'read' && approvalLevel !== 'write' && approvalLevel !== 'dangerous') {
        throw new ManagedTaskError('MCP 任务审批等级无效', 'invalid_result', false);
    }
    return {
        server: candidate.server.trim(),
        tool: candidate.tool.trim(),
        args: candidate.args && typeof candidate.args === 'object' ? candidate.args : {},
        approvalLevel,
    };
}

function extractText(result: unknown): string {
    if (result == null) return '[MCP 工具无返回内容]';
    if (typeof result === 'string') return result || '[MCP 工具无返回内容]';
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return JSON.stringify(result);
    const parts = content.map(item => {
        const block = item as Record<string, unknown>;
        if (typeof block.text === 'string') return block.text;
        if (block.type === 'image') return `[图片内容 ${typeof block.mimeType === 'string' ? block.mimeType : 'image'}]`;
        if (block.type === 'resource') {
            const uri = (block.resource as Record<string, unknown>)?.uri ?? block.uri;
            return `[资源: ${typeof uri === 'string' ? uri : '未知'}]`;
        }
        return JSON.stringify(block);
    });
    return parts.join('\n') || '[MCP 工具无返回内容]';
}

function compactResult(result: unknown, text: string): unknown {
    if (!result || typeof result !== 'object') return result;
    const source = result as Record<string, unknown>;
    const structured = source.structuredContent && typeof source.structuredContent === 'object'
        ? source.structuredContent as Record<string, unknown>
        : null;
    const compactStructured = structured
        ? {
            status: structured.status,
            taskId: structured.taskId,
            error: structured.error,
            unknownSideEffect: structured.unknownSideEffect,
        }
        : undefined;
    return {
        isError: Boolean(source.isError),
        content: [{ type: 'text', text: `${text.slice(0, 8000)}\n\n...[完整结构化结果已保存到任务附件]...` }],
        structuredContent: compactStructured,
    };
}

export class McpTaskExecutor extends ManagedTaskExecutor {
    readonly kind = 'mcp';
    protected readonly cancellationMode = 'unconfirmed' as const;

    protected hasUnknownSideEffect(input: unknown): boolean {
        try {
            return parseInput(input).approvalLevel !== 'read';
        } catch {
            return true;
        }
    }

    protected async execute(input: unknown, _context: ManagedTaskExecutionContext): Promise<ManagedTaskOutput> {
        const task = parseInput(input);
        try {
            const result = await callMCPTool(task.server, task.tool, task.args);
            const text = extractText(result);
            return {
                text,
                structured: {
                    type: 'mcp-result',
                    approvalLevel: task.approvalLevel,
                    result,
                },
                structuredFallback: {
                    type: 'mcp-result',
                    approvalLevel: task.approvalLevel,
                    result: compactResult(result, text),
                    truncated: true,
                },
            };
        } catch (error) {
            const unavailable = error instanceof MCPServerUnavailableError;
            throw new ManagedTaskError(
                `MCP 调用失败 (${task.server}/${task.tool}): ${error instanceof Error ? error.message : String(error)}`,
                unavailable ? 'provider' : 'transport',
                unavailable ? false : this.hasUnknownSideEffect(task),
            );
        }
    }
}
