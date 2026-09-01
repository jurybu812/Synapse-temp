import { appendToolText, isToolResult, toolFailure, toolPending, toolSuccess, type ToolResult } from './toolResult';

export type McpApprovalLevel = 'auto' | 'read' | 'write' | 'dangerous';

export interface BrokeredMcpResultEnvelope {
  type: 'mcp-result';
  approvalLevel: McpApprovalLevel;
  result: unknown;
  truncated?: boolean;
}

export function isBrokeredMcpResultEnvelope(value: unknown): value is BrokeredMcpResultEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrokeredMcpResultEnvelope>;
  return candidate.type === 'mcp-result'
    && (candidate.approvalLevel === 'auto'
      || candidate.approvalLevel === 'read'
      || candidate.approvalLevel === 'write'
      || candidate.approvalLevel === 'dangerous');
}

export function flattenMcpResult(result: unknown, approvalLevel: McpApprovalLevel): ToolResult {
  if (result == null) return toolSuccess('[MCP 工具无返回内容]');
  if (typeof result === 'string') return toolSuccess(result || '[MCP 工具无返回内容]');
  const obj = result as Record<string, unknown>;
  const content = obj.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const block = item as Record<string, unknown>;
      const type = block?.type;
      if (type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (type === 'image') {
        const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image';
        parts.push(`[图片内容 ${mime}（已省略二进制，读为主场景以文本为主）]`);
      } else if (type === 'resource') {
        const uri = (block.resource as Record<string, unknown>)?.uri ?? block.uri;
        parts.push(`[资源: ${typeof uri === 'string' ? uri : '未知'}]`);
      } else if (typeof block?.text === 'string') {
        parts.push(block.text);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    const joined = parts.join('\n') || '[MCP 工具无返回内容]';
    const structured = obj.structuredContent && typeof obj.structuredContent === 'object'
      ? obj.structuredContent as Record<string, unknown>
      : null;
    const taskId = typeof structured?.taskId === 'string' && structured.taskId.trim()
      ? structured.taskId.trim()
      : null;

    if (obj.isError) {
      const unsafe = approvalLevel !== 'read';
      return toolFailure(unsafe ? 'unknown' : 'error', 'provider', 'MCP 工具返回错误', {
        taskId,
        text: `⚠️ MCP 工具返回错误:\n${joined}`,
        unknownSideEffect: unsafe,
        structured: obj.structuredContent,
      });
    }

    if (isToolResult(obj.structuredContent)) {
      return obj.structuredContent.data?.content.length
        ? obj.structuredContent
        : appendToolText(obj.structuredContent, joined);
    }

    const status = structured?.status;
    if (status === 'running' || status === 'cancelling') {
      return taskId
        ? toolPending(status, taskId, joined)
        : toolFailure('error', 'invalid_result', `MCP 工具返回 ${status}，但没有可查询的 taskId`, {
            text: joined,
            structured: obj.structuredContent,
          });
    }
    if (status === 'error' || status === 'cancelled' || status === 'unknown') {
      return toolFailure(
        status,
        status === 'cancelled' ? 'aborted' : status === 'unknown' ? 'unknown' : 'provider',
        `MCP 工具状态为 ${status}`,
        {
          taskId,
          text: joined,
          unknownSideEffect: status === 'unknown' || (status === 'error' && approvalLevel !== 'read'),
          structured: obj.structuredContent,
        },
      );
    }
    return toolSuccess(joined, { taskId, structured: obj.structuredContent });
  }
  return toolSuccess(JSON.stringify(result), { structured: result });
}
