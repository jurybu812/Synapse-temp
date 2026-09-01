import { isElectron, platform, type AgentFileAccessContext } from '@/platform';
import { getWorkspaceRootResolved, resolveWorkspacePath } from './fileSystem';

interface AccessPlanningContext {
  contextId?: string;
  conversationId?: string;
}

export interface ToolAccessPlan {
  fileAccess?: AgentFileAccessContext;
  requiresScopeApproval: boolean;
  approvalMessage?: string;
  scopeKey?: string;
}

const FILE_PATH_ARGUMENTS: Record<string, { key: string; fallback?: string }> = {
  view_file: { key: 'path' },
  show_artifact: { key: 'path' },
  list_dir: { key: 'path' },
  write_to_file: { key: 'path' },
  apply_patch: { key: 'path' },
  search_files: { key: 'path', fallback: '.' },
  read_document: { key: 'file' },
};

const FILE_OPERATIONS: Record<string, Array<'read' | 'write' | 'delete'>> = {
  view_file: ['read'],
  show_artifact: ['read'],
  list_dir: ['read'],
  search_files: ['read'],
  read_document: ['read'],
  write_to_file: ['read', 'write'],
  apply_patch: ['read', 'write'],
};

export async function planToolAccess(
  toolName: string,
  args: Record<string, unknown>,
  context: AccessPlanningContext,
  fullAccess: boolean,
): Promise<ToolAccessPlan> {
  const descriptor = FILE_PATH_ARGUMENTS[toolName];
  if (!descriptor || !isElectron) return { requiresScopeApproval: false };
  const rawValue = typeof args[descriptor.key] === 'string' && String(args[descriptor.key]).trim()
    ? String(args[descriptor.key]).trim()
    : descriptor.fallback;
  if (!rawValue) return { requiresScopeApproval: false };

  const workspaceRoot = await getWorkspaceRootResolved(context.contextId, context.conversationId);
  const resolvedPath = await resolveWorkspacePath(rawValue, context.contextId, context.conversationId);
  const classification = await platform.file.classifyAccess(resolvedPath, workspaceRoot);
  const outsidePaths = classification.withinWorkspace ? [] : [classification.resolvedPath];
  const operations = FILE_OPERATIONS[toolName] || ['read'];
  const requiresWriteGrant = operations.some(operation => operation !== 'read');
  const approvedPaths = outsidePaths.length > 0 || requiresWriteGrant ? [classification.resolvedPath] : [];
  const requiresScopeApproval = outsidePaths.length > 0;
  const scopeKey = JSON.stringify({
    workspaceRoot: classification.resolvedRoot,
    resolvedPath: classification.resolvedPath,
    fullAccess,
  });
  const fileAccess: AgentFileAccessContext = {
    workspaceRoot: classification.resolvedRoot,
    fullAccess,
    operations,
    approvedPaths,
  };
  if (!requiresScopeApproval) return { fileAccess, requiresScopeApproval: false, scopeKey };

  return {
    fileAccess,
    requiresScopeApproval: true,
    scopeKey,
    approvalMessage: [
      '访问范围：当前工作区之外',
      '本次授权：仅覆盖此次工具调用，不授权同目录或后续调用',
      `目标：${classification.resolvedPath}`,
      `当前工作区：${classification.resolvedRoot || '未打开真实工作区'}`,
      '为防止界面脚本伪造授权，工作区外路径始终逐次确认；完全访问不会替代这次明确确认，也不会自动批准写入或命令。',
    ].join('\n'),
  };
}
