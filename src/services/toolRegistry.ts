/**
 * Tool Registry — 工具注册、查询、执行
 * 内置桌面 Agent 工具集
 * 支持审批机制 + 透明重试
 */

import { buildDiffHunks, countLineChanges, generateChangeId, hashContent, recordTrackedFileChange } from './fileChangeTracker';
import { recordTrackedArtifact } from './artifactTracker';
import { resolveEditorType } from './editorFileTypes';
import { executionRegistry } from './executionRegistry';
import { platform, type AgentFileAccessContext, type ToolTaskSnapshot } from '@/platform';
import type { FileDiffSummary } from '@/store/slices/conversation';
import { flattenMcpResult, isBrokeredMcpResultEnvelope } from './mcpResult';
import { planToolAccess } from './toolAccessPolicy';
import { managedTaskId } from './toolTaskId';
import {
  appendToolText,
  toolFailure,
  toolPending,
  toolSuccess,
  type ToolErrorCode,
  type ToolResult,
} from './toolResult';

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[]; items?: { type: string } }>;
      required?: string[];
    };
  };
}

/**
 * 工具执行上下文（M2-5 worktree 按需 / M3 并行子代理隔离）。
 * contextId = 「当前执行上下文 id」：现阶段 = conversationId（含 AUTOSAVE_ID），M3 阶段 = agentId/subagentId。
 * 由 agentLoop 执行工具时显式注入（见 execute 的 contextId 参数），沿调用链传到需要它的 handler
 * （worktree 根解析、cwd 解析、enter/exit_worktree），杜绝并行子代理共享全局态时互相串台。
 * 显式参数传递而非模块级变量——避免多 AgentLoop 实例并发交错执行工具时单一全局槽位被覆盖。
 */
export interface ToolExecContext {
  contextId?: string;
  conversationId?: string;
  runId?: string;
  callId?: string;
  ownerId?: string;
  signal?: AbortSignal;
  onTaskStarted?: (snapshot: ToolTaskSnapshot) => void | Promise<void>;
  fileAccess?: AgentFileAccessContext;
  /** ★ medium#4：本次工具调用是否来自子代理（后台自动派发，非主对话）。审批文案据此区分来源。 */
  isSubagent?: boolean;
  /** ★ medium#4：发起的子代理角色名（如「审查者」），审批框显示「子代理「角色」请求…」。 */
  subagentRole?: string;
}

/** execute 的可选元信息（来源标识等）——与 contextId 解耦，便于审批/审计区分主代理 vs 子代理。 */
export interface ToolExecMeta {
  isSubagent?: boolean;
  subagentRole?: string;
  conversationId?: string;
  runId?: string;
  callId?: string;
  ownerId?: string;
}

export type ToolHandler = (args: Record<string, any>, ctx?: ToolExecContext) => Promise<ToolResult>;

type ToolCategory = 'file' | 'search' | 'command' | 'web' | 'document' | 'custom';
type ApprovalLevel = 'auto' | 'read' | 'write' | 'dangerous';

/**
 * ★ high#4（M3-2c 审查）工具权限类别——与 SubagentConfig.toolPermissions 联合类型严格对齐
 *   （'read' | 'write' | 'command' | 'search' | 'generate'）。子代理工具闸门据此过滤：
 *   编辑器 SubagentForm 勾选的 toolPermissions 决定该子代理运行时能拿到哪些工具，使「编辑承诺」与
 *   「运行消费」契约对齐（不再呈现一个运行期被静默忽略的权限闸门）。
 *   注意：spawn_subagent 不归任何权限类别（permissionCategory 为 undefined），其可用性只由 maxDepth 控制，
 *   不被 toolPermissions 过滤（否则会与 M3-1a 派发深度语义冲突）。
 */
export type ToolPermissionCategory = 'read' | 'write' | 'command' | 'search' | 'generate';

interface RegisteredTool {
  schema: ToolSchema;
  handler: ToolHandler;
  category: ToolCategory;
  approvalLevel: ApprovalLevel;
  /**
   * ★ high#4 子代理工具权限闸门所属类别（与 SubagentConfig.toolPermissions 对齐）。
   *   undefined = 不归任何权限类别（如 spawn_subagent 由 maxDepth 控制，不参与 toolPermissions 过滤）。
   */
  permissionCategory?: ToolPermissionCategory;
  retryPolicy: 'never' | 'read-only';
}

async function notifyTaskStarted(ctx: ToolExecContext | undefined, snapshot: ToolTaskSnapshot): Promise<void> {
  await ctx?.onTaskStarted?.(snapshot);
}

// Approval callback — set by UI to show confirmation dialog.
// ★ medium#4：新增可选第 4 参 meta，传子代理来源标识，让 UI 文案区分主代理/子代理（向后兼容：旧 3 参回调照常工作）。
type ApprovalCallback = (
  toolName: string,
  args: Record<string, any>,
  level: ApprovalLevel,
  meta?: ToolExecMeta,
  message?: string,
) => Promise<boolean>;

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private approvalCallback: ApprovalCallback | null = null;
  private autoApproveSettings = {
    read: true,
    write: false,
    command: false,
    all: false,
    fullAccess: false,
  };
  private maxRetries = 3;

  register(
    schema: ToolSchema,
    handler: ToolHandler,
    category: ToolCategory = 'custom',
    approvalLevel: ApprovalLevel = 'auto',
    permissionCategory?: ToolPermissionCategory,
    retryPolicy: RegisteredTool['retryPolicy'] = 'never',
  ) {
    this.tools.set(schema.function.name, { schema, handler, category, approvalLevel, permissionCategory, retryPolicy });
  }

  /**
   * ★ M4-7-S3：注销一个已注册工具（按工具名）。供 mcpBridge 在 MCP server 停用/重启时清理旧 MCP 工具，
   *   避免「server 停了但工具仍挂在 registry 里、AI 调用必然路由失败」的悬空。返回是否确有删除。
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map(t => t.schema);
  }

  /**
   * ★ high#4 子代理工具闸门：按权限类别集合过滤工具 schema。
   *   - 仅返回 permissionCategory ∈ allowed 的工具（与 SubagentConfig.toolPermissions 对齐）；
   *   - permissionCategory 为 undefined 的工具（如 spawn_subagent）【不】由此过滤——其可用性由调用方
   *     （buildSubagentTools）按 maxDepth 单独决定，故这里一律剔除，交由调用方按需补回；
   *   - allowed 为空 → 不返回任何带权限类别的工具（子代理被收紧到无文件/搜索/命令权限）。
   */
  getSchemasForPermissions(allowed: ReadonlyArray<ToolPermissionCategory>): ToolSchema[] {
    const allowSet = new Set(allowed);
    return Array.from(this.tools.values())
      .filter(t => t.permissionCategory !== undefined && allowSet.has(t.permissionCategory))
      .map(t => t.schema);
  }

  /** ★ high#4：取无权限类别（不参与 toolPermissions 过滤）的工具 schema，如 spawn_subagent。 */
  getUncategorizedSchemas(): ToolSchema[] {
    return Array.from(this.tools.values())
      .filter(t => t.permissionCategory === undefined)
      .map(t => t.schema);
  }

  /**
   * Set the approval callback (called by UI component)
   */
  setApprovalCallback(cb: ApprovalCallback) {
    this.approvalCallback = cb;
  }

  /**
   * Update auto-approve settings from Redux settings
   */
  updateAutoApprove(settings: typeof this.autoApproveSettings) {
    this.autoApproveSettings = { ...settings };
  }

  /**
   * Check if tool execution needs user approval
   */
  private needsApproval(tool: RegisteredTool): boolean {
    if (tool.approvalLevel === 'auto') return false;
    if (tool.approvalLevel === 'read' && this.autoApproveSettings.read) return false;
    if (tool.approvalLevel === 'write' && this.autoApproveSettings.write) return false;
    if (tool.approvalLevel === 'dangerous' && this.autoApproveSettings.command) return false;
    return true;
  }

  private requiresCommandScopeApproval(name: string, tool: RegisteredTool): boolean {
    return tool.permissionCategory === 'command'
      && name !== 'tool_status'
      && name !== 'tool_cancel'
      && !this.autoApproveSettings.fullAccess;
  }

  private requiresExternalMcpBoundaryApproval(name: string, tool: RegisteredTool): boolean {
    return name.startsWith('mcp__')
      && (tool.permissionCategory === 'write' || tool.permissionCategory === 'command');
  }

  /**
   * Execute tool with approval check + transparent retry.
   * @param contextId 当前执行上下文 id（agentLoop 注入；现阶段=conversationId，M3=agentId/subagentId）。
   *        worktree 根/cwd 解析与 enter/exit_worktree 据此定位「本上下文」的活动 worktree，避免并行串台。
   */
  async execute(name: string, args: Record<string, any>, contextOrId?: string | ToolExecContext, meta?: ToolExecMeta): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return toolFailure('error', 'not_found', `Tool "${name}" not found`);

    const baseContext = typeof contextOrId === 'string' ? { contextId: contextOrId } : (contextOrId ?? {});
    const buildContext = (): ToolExecContext => {
      const originalConversationId = baseContext.conversationId ?? baseContext.contextId;
      const ownerId = baseContext.ownerId ?? originalConversationId;
      const conversationId = ownerId && originalConversationId
        ? executionRegistry.resolveConversationId({ ownerId, conversationId: originalConversationId })
        : originalConversationId;
      return {
        ...baseContext,
        contextId: baseContext.contextId ?? ownerId ?? conversationId,
        conversationId,
        callId: baseContext.callId ?? `call_${crypto.randomUUID()}`,
        ownerId,
        isSubagent: meta?.isSubagent ?? baseContext.isSubagent,
        subagentRole: meta?.subagentRole ?? baseContext.subagentRole,
      };
    };
    let ctx = buildContext();

    let accessPlan;
    try {
      accessPlan = await planToolAccess(name, args, ctx, this.autoApproveSettings.fullAccess);
    } catch (err: any) {
      return toolFailure('error', 'invalid_result', `无法验证工具 "${name}" 的访问范围: ${err?.message || String(err)}`);
    }
    const commandScopeApproval = this.requiresCommandScopeApproval(name, tool);
    const externalMcpBoundaryApproval = this.requiresExternalMcpBoundaryApproval(name, tool);
    const approvalMessages = [
      accessPlan.approvalMessage,
      commandScopeApproval
        ? [
            '此工具会执行系统命令。Windows 命令可以在命令文本中访问工作目录之外的任意路径，Synapse 无法只靠 cwd 保证范围隔离。',
            '当前未开启「完全访问」，因此本次命令必须由你明确批准；即使开启了「自动批准命令」或「全部自动批准」，也不会跳过这层范围确认。',
          ].join('\n')
        : undefined,
      externalMcpBoundaryApproval
        ? [
            '此工具来自外部 MCP 扩展，Synapse 无法验证它最终访问的文件、桌面、浏览器或远端资源范围。',
            '本次必须单独批准；「自动批准写入」「自动批准命令」「全部自动批准」和「完全访问」都不会替外部扩展扩大授权。',
          ].join('\n')
        : undefined,
    ].filter((message): message is string => Boolean(message));
    let accessChallengeId: string | undefined;
    let removeAccessAbortListener: (() => void) | undefined;
    if (accessPlan.fileAccess?.approvedPaths.length) {
      try {
        accessChallengeId = await platform.file.prepareAccessGrant(accessPlan.fileAccess);
        if (ctx.signal) {
          const challengeId = accessChallengeId;
          const abort = () => {
            void platform.file.cancelAccessGrant(challengeId).catch(() => undefined);
          };
          ctx.signal.addEventListener('abort', abort, { once: true });
          removeAccessAbortListener = () => ctx.signal?.removeEventListener('abort', abort);
        }
      } catch (err: any) {
        return toolFailure('cancelled', 'approval_denied', `无法准备本次文件访问授权: ${err?.message || String(err)}`);
      }
    }
    const cancelAccessChallenge = async () => {
      if (!accessChallengeId) return;
      const challengeId = accessChallengeId;
      accessChallengeId = undefined;
      removeAccessAbortListener?.();
      removeAccessAbortListener = undefined;
      await platform.file.cancelAccessGrant(challengeId).catch(() => undefined);
    };
    const mainProcessApproval = Boolean(accessChallengeId) || name === 'run_command' || name.startsWith('mcp__');
    const approvalRequired = (!mainProcessApproval && this.needsApproval(tool))
      || (!accessChallengeId && accessPlan.requiresScopeApproval)
      || (name !== 'run_command' && commandScopeApproval)
      || (!name.startsWith('mcp__') && externalMcpBoundaryApproval);

    // Check approval（★ medium#4：透传 meta，子代理调用时审批框可显示来源角色，避免用户误以为是主代理发起）
    if (approvalRequired) {
      if (!this.approvalCallback) {
        await cancelAccessChallenge();
        return toolFailure('cancelled', 'approval_denied', `工具 "${name}" 需要用户批准，但当前没有可用的审批界面`);
      }
      const approvedScopeKey = accessPlan.scopeKey;
      const approvedArgsFingerprint = JSON.stringify(args);
      let approved: boolean;
      try {
        approved = await this.approvalCallback(name, args, tool.approvalLevel, {
          ...meta,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          callId: ctx.callId,
          ownerId: ctx.ownerId,
        }, approvalMessages.length > 0 ? approvalMessages.join('\n\n') : undefined);
      } catch (err: any) {
        await cancelAccessChallenge();
        return toolFailure('cancelled', 'approval_denied', `工具 "${name}" 的批准流程失败: ${err?.message || String(err)}`);
      }
      if (!approved) {
        await cancelAccessChallenge();
        return toolFailure('cancelled', 'approval_denied', `用户取消了工具 "${name}" 的执行`);
      }
      // 审批等待期间 AUTOSAVE 可能提升为正式对话；执行前按 owner alias 再解析一次。
      ctx = buildContext();
      try {
        accessPlan = await planToolAccess(name, args, ctx, this.autoApproveSettings.fullAccess);
      } catch (err: any) {
        await cancelAccessChallenge();
        return toolFailure('error', 'invalid_result', `批准后无法重新验证工具 "${name}" 的访问范围: ${err?.message || String(err)}`);
      }
      if (approvedScopeKey !== accessPlan.scopeKey || approvedArgsFingerprint !== JSON.stringify(args)) {
        await cancelAccessChallenge();
        return toolFailure(
          'cancelled',
          'approval_denied',
          `工具 "${name}" 的目标或访问范围在等待批准期间发生变化，请重新发起并确认新的目标`,
        );
      }
    }
    if (accessChallengeId) {
      try {
        ctx.fileAccess = await platform.file.completeAccessGrant(accessChallengeId);
        accessChallengeId = undefined;
        removeAccessAbortListener?.();
        removeAccessAbortListener = undefined;
      } catch (err: any) {
        await cancelAccessChallenge();
        return toolFailure('cancelled', 'approval_denied', `无法建立本次文件访问授权: ${err?.message || String(err)}`);
      }
    } else {
      ctx.fileAccess = accessPlan.fileAccess;
    }

    if (ctx.signal?.aborted) return toolFailure('cancelled', 'aborted', `工具 "${name}" 已在执行前取消`);
    // Execute with retry
    let lastError = '';
    const maxAttempts = tool.retryPolicy === 'read-only' ? this.maxRetries : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (ctx.signal?.aborted) return toolFailure('cancelled', 'aborted', `工具 "${name}" 已取消`);
        const startTime = Date.now();
        const result = await tool.handler(args, ctx);
        const elapsed = Date.now() - startTime;
        if (result.status === 'error'
          && result.error.retryable
          && !result.unknownSideEffect
          && attempt < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        return attempt > 0
          ? appendToolText(result, `[重试 ${attempt} 次后完成, 耗时 ${elapsed}ms]`)
          : result;
      } catch (err: any) {
        lastError = err.message || '未知错误';
        if (ctx.signal?.aborted || err?.name === 'AbortError') {
          return toolFailure('cancelled', 'aborted', `工具 "${name}" 已取消`);
        }
        if (attempt < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    const retryText = maxAttempts > 1 ? `（最多尝试 ${maxAttempts} 次）` : '（未自动重试）';
    const unsafe = tool.permissionCategory === 'write'
      || tool.permissionCategory === 'command'
      || tool.approvalLevel === 'write'
      || tool.approvalLevel === 'dangerous';
    return toolFailure(
      unsafe ? 'unknown' : 'error',
      'transport',
      `工具 "${name}" 执行失败${retryText}: ${lastError}`,
      { retryable: !unsafe, unknownSideEffect: unsafe },
    );
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  listByCategory(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [name, tool] of this.tools) {
      if (!result[tool.category]) result[tool.category] = [];
      result[tool.category].push(name);
    }
    return result;
  }
}

export const toolRegistry = new ToolRegistry();

export function requireToolExecutionIdentity(ctx?: ToolExecContext): {
  conversationId: string;
  runId: string;
  callId: string;
  ownerId: string;
} {
  const missing = [
    ['conversationId', ctx?.conversationId],
    ['runId', ctx?.runId],
    ['callId', ctx?.callId],
    ['ownerId', ctx?.ownerId],
  ].filter(([, value]) => typeof value !== 'string' || !value).map(([name]) => name);
  if (missing.length) throw new Error(`工具调用缺少运行身份: ${missing.join(', ')}`);
  return {
    conversationId: ctx!.conversationId!,
    runId: ctx!.runId!,
    callId: ctx!.callId!,
    ownerId: ctx!.ownerId!,
  };
}

// =====================================================
// Built-in Tools Registration
// =====================================================

async function writeTrackedFileContent(filePath: string, content: string, ctx?: ToolExecContext): Promise<void> {
  const { fileSystem } = await import('./fileSystem');
  const { resolveDiffReviewPath } = await import('./diffReviewPath');
  let before = '';
  let existed = fileSystem.hasNode(filePath);
  try {
    const existingContent = await fileSystem.readFile(filePath, ctx?.contextId, ctx?.conversationId, ctx?.fileAccess);
    const isWebMissingPreview = !existed && existingContent.startsWith('// 文件内容预览:');
    if (!isWebMissingPreview) {
      before = existingContent;
      existed = true;
    }
  } catch {
    existed = false;
  }

  await fileSystem.writeFile(filePath, content, ctx?.contextId, ctx?.conversationId, ctx?.fileAccess);
  let trackedPath = filePath;
  let reviewPath: string | undefined;
  try {
    const resolved = await resolveDiffReviewPath(filePath, ctx?.contextId, ctx?.conversationId);
    trackedPath = resolved.resolvedPath;
    reviewPath = resolved.reviewPath;
  } catch {
    reviewPath = undefined;
  }
  const snapshotId = generateChangeId('snapshot');
  const diffId = generateChangeId('diff');
  const beforeContent = existed ? before : '';
  const { additions, deletions } = countLineChanges(beforeContent, content);
  const diff = {
    id: diffId,
    path: trackedPath,
    ...(reviewPath ? { reviewPath } : {}),
    changeType: existed ? 'edited' : 'created',
    additions,
    deletions,
    status: 'pending',
    snapshotId,
    beforeHash: hashContent(beforeContent),
    afterHash: hashContent(content),
    hunks: buildDiffHunks(beforeContent, content),
    contextId: ctx?.contextId,
    conversationId: ctx?.conversationId,
    afterContent: content,
  } as FileDiffSummary & { reviewPath?: string };
  recordTrackedFileChange({
    snapshot: {
      id: snapshotId,
      path: trackedPath,
      content: existed ? before : undefined,
      contentHash: hashContent(beforeContent),
      createdAt: Date.now(),
      reason: 'before_ai_edit',
    },
    diff,
  }, ctx?.callId ?? ctx?.contextId);
}

// --- File Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'view_file',
    description: '查看文件内容。返回文件的文本内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        startLine: { type: 'number', description: '起始行号（可选）' },
        endLine: { type: 'number', description: '结束行号（可选）' },
      },
      required: ['path'],
    },
  },
}, async (args, ctx) => {
  const { fileSystem, resolveWorkspacePath } = await import('./fileSystem');
  const { isExtractableDocument, extractDocumentText } = await import('./documentExtract');

  // office/pdf 等二进制文档：用 readFile（fs utf-8）读出来是乱码 → 改走文本提取（pdf.js/mammoth/jszip/xlsx）。
  //   提取需要可读的真实路径，故先按工具统一口径 resolveWorkspacePath 解析（与 list_dir/search 一致）。
  if (isExtractableDocument(args.path)) {
    try {
      const resolved = await resolveWorkspacePath(args.path, ctx?.contextId, ctx?.conversationId);
      const text = await extractDocumentText(resolved, ctx?.fileAccess);
      if (!text) return toolSuccess(`文件 ${args.path} 未提取到文本内容（可能是空文档 / 纯图片型 PDF）。`);
      // ★ review M2：office/pdf 提取文本无「自然行」（PDF 每页常是空格 join 的单行），startLine/endLine 行切片
      //   语义失效（传 1-50 行可能拿到整篇或只几页分隔符）。故文档型不按行切、整体返回（已 clamp 50k 上限），
      //   传了行号则提示改用 read_document 的 page 参数按页读。
      const docHint = (args.startLine || args.endLine)
        ? '（注：文档型按整体/页读，不支持行号；要分页请用 read_document 的 page 参数）'
        : '';
      return toolSuccess(`文档: ${args.path} (已解析文本)${docHint}\n\n${text}`);
    } catch (err: any) {
      return toolFailure('error', 'provider', `读取文档失败 ${args.path}: ${err?.message || String(err)}`);
    }
  }

  const content = await fileSystem.readFile(args.path, ctx?.contextId, ctx?.conversationId, ctx?.fileAccess);
  if (!content) return toolFailure('error', 'not_found', `文件不存在: ${args.path}`);

  const lines = content.split('\n');
  const start = (args.startLine || 1) - 1;
  const end = args.endLine || lines.length;
  const slice = lines.slice(start, end);

  return toolSuccess(`文件: ${args.path} (行 ${start + 1}-${end}/${lines.length})\n\n${slice.join('\n')}`);
}, 'file', 'read', 'read', 'read-only');

// show_artifact：把一个【已存在的文件】作为「产物卡片」推给用户——用户点卡片即在中部编辑器打开。
//   是 view_file 的展示型孪生：view_file 把文件内容回给 AI，show_artifact 则在 UI 给用户一张可点开的卡片。
//   只展示已存在文件、绝不写盘 → approval=auto（无需审批）、permissionCategory=read。
//   handler 校验文件存在（复用 view_file 的 fileSystem.readFile + worktree/相对路径口径，只确认存在不读全文用途）、
//   预解析 editorType（resolveEditorType 按扩展名），record 到 artifactTracker 当前桶，由 agentLoop 收口消费。
toolRegistry.register({
  type: 'function',
  function: {
    name: 'show_artifact',
    description:
      '把一个【已存在的文件】作为「产物卡片」展示给用户——用户点击卡片即可在中部编辑器中打开该文件。'
      + '适用于：你刚为用户准备好/生成好一个文件（文档、代码、图片、PDF、网页等），想让用户一键打开查看。'
      + '注意：这只是展示一个【已经存在】的文件的入口，不会创建或修改任何文件（创建/修改请用 write_to_file）。'
      + 'path 为文件路径；label 可选，是卡片上显示的名字（不填则取文件名）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要展示的【已存在文件】的路径' },
        label: { type: 'string', description: '卡片显示名（可选，缺省取文件名）' },
      },
      required: ['path'],
    },
  },
}, async (args, ctx) => {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) return toolFailure('error', 'invalid_result', 'show_artifact 需要有效的 path（要展示的已存在文件路径）。');

  const { fileSystem } = await import('./fileSystem');
  // 复用 view_file 的路径口径（worktree 重定向 / 相对路径锚工作区根），但只做存在性检查。
  // 不读取正文，避免空文件被误判，也避免 PDF / Office / 大型二进制文件为展示卡片而整份进入 renderer 内存。
  let exists = false;
  try {
    exists = await fileSystem.exists(path, ctx?.contextId, ctx?.conversationId, ctx?.fileAccess);
  } catch {
    return toolFailure('error', 'not_found', `文件不存在或无法读取: ${path}`);
  }
  if (!exists) {
    return toolFailure('error', 'not_found', `文件不存在或无法读取: ${path}`);
  }

  const fileName = path.split(/[\\/]/).pop() || path;
  const label = (typeof args.label === 'string' && args.label.trim()) ? args.label.trim() : fileName;
  // editorType 预解析：让用户点开时直接走对的查看器（office/pdf/image/markdown/html…），而非一律按 code 打开。
  const editorType = resolveEditorType(fileName);

  recordTrackedArtifact({
    id: generateChangeId('artifact'),
    path,
    label,
    editorType,
  }, ctx?.callId ?? ctx?.contextId);

  return toolSuccess(`✅ 已把产物卡片推送给用户: ${label}（${path}）。用户可点击卡片在编辑器中打开。`);
}, 'file', 'auto', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'list_dir',
    description: '列出目录下的文件和子目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
      },
      required: ['path'],
    },
  },
}, async (args, ctx) => {
  const { fileSystem, resolveWorkspacePath } = await import('./fileSystem');
  // ★ P0-1：把请求目录解析到「权威根」下的绝对路径——有活动 worktree 重定向到 worktree，
  //   无 worktree 时相对路径锚到已打开工作区根（与 view_file/write_to_file 口径一致）。
  //   旧版「仅 worktree 时传 rootOverride、否则 undefined」会在无 worktree 时忽略 args.path、
  //   永远铺主工作区整棵树（套娃根因之一）。
  const targetDir = await resolveWorkspacePath(args.path, ctx?.contextId, ctx?.conversationId);
  const tree = await fileSystem.getWorkspaceTree(targetDir || undefined, undefined, ctx?.fileAccess);
  if (!tree) return toolFailure('error', 'not_found', `目录不存在: ${args.path}`);

  // ★ P0-1 治套娃：只列【该目录下一层】（不递归整棵 maxDepth=3 子树），符合 ls 语义；
  //   深层结构让 AI 对子目录再 list_dir 下钻，避免一次性铺开导致刷屏 + 上下文浪费。
  const children = Array.isArray(tree.children) ? tree.children : [];
  const dirLabel = tree.path || args.path;
  if (children.length === 0) {
    return toolSuccess(`目录: ${dirLabel}\n\n（空目录）`);
  }
  // 目录在前、文件在后，各自按名排序，稳定可读。
  const sorted = [...children].sort((a: any, b: any) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  const lines = sorted.map((node: any) => {
    const icon = node.type === 'directory' ? '📁' : '📄';
    const slash = node.type === 'directory' ? '/' : '';
    const size = node.type === 'file' && node.size ? ` (${(node.size / 1024).toFixed(1)} KB)` : '';
    return `${icon} ${node.name}${slash}${size}`;
  });
  return toolSuccess(`目录: ${dirLabel}（${sorted.length} 项）\n\n${lines.join('\n')}`);
}, 'file', 'read', 'read', 'read-only');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'write_to_file',
    description: '写入文件内容',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
  },
}, async (args, ctx) => {
  await writeTrackedFileContent(args.path, args.content, ctx);
  return toolSuccess(`✅ 已写入文件: ${args.path} (${args.content.length} 字符)`);
}, 'file', 'write', 'write');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'apply_patch',
    description: '对现有文件做精确文本块替换；旧文本出现次数不符合预期时拒绝写入，适合局部安全修改。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要修改的文件路径' },
        oldText: { type: 'string', description: '必须与文件中现有内容完全一致的旧文本块' },
        newText: { type: 'string', description: '替换后的新文本块；传空字符串表示删除旧文本块' },
        expectedOccurrences: { type: 'number', description: '旧文本预期出现次数（可选，默认 1；实际不一致则不修改）' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
}, async (args, ctx) => {
  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  const oldText = typeof args.oldText === 'string' ? args.oldText : '';
  const newText = typeof args.newText === 'string' ? args.newText : '';
  const expectedOccurrences = Number.isInteger(Number(args.expectedOccurrences))
    ? Math.max(1, Math.min(100, Number(args.expectedOccurrences)))
    : 1;
  if (!filePath) return toolFailure('error', 'invalid_result', 'apply_patch 需要有效的 path。');
  if (!oldText) return toolFailure('error', 'invalid_result', 'apply_patch 的 oldText 不能为空。');

  const { fileSystem } = await import('./fileSystem');
  let before: string;
  try {
    before = await fileSystem.readFile(filePath, ctx?.contextId, ctx?.conversationId, ctx?.fileAccess);
  } catch (error) {
    return toolFailure('error', 'not_found', `无法读取要修改的文件: ${error instanceof Error ? error.message : String(error)}`);
  }
  const occurrences = before.split(oldText).length - 1;
  if (occurrences !== expectedOccurrences) {
    return toolFailure(
      'error',
      'invalid_result',
      `补丁未应用：oldText 实际出现 ${occurrences} 次，预期 ${expectedOccurrences} 次；文件保持不变。`,
    );
  }
  const after = before.split(oldText).join(newText);
  if (after === before) return toolSuccess(`文件 ${filePath} 无需修改。`);
  await writeTrackedFileContent(filePath, after, ctx);
  return toolSuccess(`✅ 已应用补丁: ${filePath}（替换 ${occurrences} 处）`);
}, 'file', 'write', 'write');

// --- Search Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'search_files',
    description: '在工作区中搜索文件内容',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        path: { type: 'string', description: '搜索范围路径（可选）' },
      },
      required: ['query'],
    },
  },
}, async (args, ctx) => {
  const { fileSystem, resolveWorkspacePath } = await import('./fileSystem');
  // ★ search 根与 list_dir 同口径（治「search_files 搜不到任何内容」）：用 resolveWorkspacePath 解析 args.path（缺省 '.'），
  //   走主进程 file:search（磁盘递归 grep + 文件名匹配）。旧版用 getWorkspaceRootResolved——demo/未打开工作区时它把
  //   /workspace 假路径视为无根返回 null → searchInWorkspace 回退内部 mock '/workspace'（磁盘不存在）→ 搜空；
  //   而 list_dir 走 resolveWorkspacePath 能落到 process.cwd()（工程根）。统一为同口径，与 list_dir 落点一致。
  const rawPath = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : '.';
  const root = await resolveWorkspacePath(rawPath, ctx?.contextId, ctx?.conversationId);
  const { isElectron } = await import('@platform/index');
  if (!isElectron || !window.synapse) {
    const results = await fileSystem.searchInWorkspace(args.query, root, ctx?.fileAccess);
    if (!results.length) return toolSuccess(`未找到匹配 "${args.query}" 的文件或内容`);
    const lines = results.slice(0, 50).map((result: any) => result.kind === 'content'
      ? `- ${result.path}:${result.line ?? '?'}  ${String(result.content ?? '').trim()}`
      : `- ${result.path}（文件名匹配）`);
    return toolSuccess(`搜索 "${args.query}" 找到 ${results.length} 个结果:\n${lines.join('\n')}`);
  }

  try {
    const identity = requireToolExecutionIdentity(ctx);
    const taskId = await managedTaskId('file-search', identity);
    const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };
    const started = await window.synapse.toolTask.start({
      kind: 'file-search',
      taskId,
      identity,
      input: {
        query: args.query,
        root,
        access: ctx?.fileAccess,
        fileNameMatches: fileSystem.searchFileNamesInWorkspace(args.query, root),
      },
    });
    await notifyTaskStarted(ctx, started);
    if (started.status === 'running' || started.status === 'cancelling') {
      executionRegistry.registerCancelable(identity.ownerId, started.taskId, async () => {
        await window.synapse?.toolTask.cancel(started.taskId, access);
      }, identity.runId);
    }
    const result = await window.synapse.toolTask.wait(started.taskId, 10, access);
    if (result.status !== 'running' && result.status !== 'cancelling') {
      executionRegistry.releaseCancelable(identity.ownerId, result.taskId);
    }
    if (result.status === 'running' || result.status === 'cancelling') {
      return taskSnapshotToToolResult(result, [
        `⏳ 文件搜索仍在运行（taskId=${result.taskId}）`,
        '可调用 tool_status 等待 10—120 秒，或调用 tool_cancel 请求停止。',
        result.text,
      ].filter(Boolean).join('\n\n'));
    }
    return taskSnapshotToToolResult(result);
  } catch (error) {
    return toolFailure('error', 'transport', `文件搜索失败: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
  }
}, 'search', 'read', 'search');

// --- Document Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'read_document',
    description: '读取工作区文档指定页面的内容（PDF/PPTX/DOCX/XLSX）',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文档文件名或路径' },
        page: { type: 'number', description: '页码（可选）' },
      },
      required: ['file'],
    },
  },
}, async (args, ctx) => {
  const fileName = args.file;
  if (!fileName || typeof fileName !== 'string') return toolFailure('error', 'invalid_result', 'read_document 需要 file（文档文件名/路径）。');

  const { resolveWorkspacePath } = await import('./fileSystem');
  const { isExtractableDocument, extractDocumentText } = await import('./documentExtract');

  if (!isExtractableDocument(fileName)) {
    return toolFailure('error', 'unsupported', `${fileName} 不是受支持的文档类型（支持 .pdf/.docx/.pptx/.xlsx/.xls/.csv）。若是纯文本或代码文件请用 view_file。`);
  }

  try {
    const resolved = await resolveWorkspacePath(fileName, ctx?.contextId, ctx?.conversationId);
    const text = await extractDocumentText(resolved, ctx?.fileAccess);
    if (!text) return toolSuccess(`📄 文档 ${fileName}：未提取到文本内容（可能是空文档或纯图片型 PDF）。`);

    // 指定了页码时：尝试从带 `--- Page N ---` / `--- Slide N ---` 分隔的文本里抠出该页；抠不到则回全文。
    const page = typeof args.page === 'number' ? args.page : undefined;
    if (page && page > 0) {
      const re = new RegExp(`--- (?:Page|Slide) ${page} ---\\n([\\s\\S]*?)(?=\\n--- (?:Page|Slide) \\d+ ---|$)`);
      const m = text.match(re);
      if (m) return toolSuccess(`📄 文档: ${fileName}（第 ${page} 页）\n\n${m[1].trim()}`);
      // PDF/PPTX 无该页，或 docx/表格类无分页概念 → 返回全文并提示。
      return toolSuccess(`📄 文档: ${fileName}（未找到第 ${page} 页，返回全文；docx/表格类无分页）\n\n${text}`);
    }

    return toolSuccess(`📄 文档: ${fileName}\n\n${text}`);
  } catch (err: any) {
    return toolFailure('error', 'provider', `📄 文档 ${fileName} 解析失败: ${err?.message || String(err)}`);
  }
}, 'document', 'read', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'generate_summary',
    description: '为指定文档生成结构化概要',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文档文件名或路径' },
        mode: { type: 'string', description: '概要模式', enum: ['brief', 'detailed', 'outline'] },
      },
      required: ['file'],
    },
  },
}, async (args) => {
  return toolFailure('error', 'unsupported', '文档概要功能尚未接通 Synopsis 引擎', {
    text: `📋 文档概要 - ${args.file}\n模式: ${args.mode || 'brief'}\n\n[此功能需要 Synopsis 引擎支持]`,
  });
}, 'document', 'auto', 'generate');

// --- Memory Tools（M1 上下文 harness：Synapse 内置 AI 主动记忆）---
// ⚠️ 这是 Synapse 内置记忆，存本地 SQLite（Web 模式存 localStorage），独立于用户环境里
//    另一套外置 MCP `mcp__memory-store__*` 工具——两者数据互不相通，AI 应使用本工具沉淀
//    与本应用相关的长期记忆（技术方案、踩坑、用户偏好等）。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_write',
    description:
      '写入一条长期记忆到 Synapse 内置记忆库（存本地 SQLite，Web 模式存 localStorage；'
      + '独立于外置 MCP memory-store，数据不互通）。'
      + '用于跨对话沉淀有价值的信息：技术方案、踩坑经验、用户偏好、项目背景等。'
      + '记忆会在后续对话中可被 memory_query 检索召回。'
      + 'searchSummary 要写好关键词/近义词/技术栈名，它比正文更影响检索命中率。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '记忆标题（简短一句话概括，是检索主权重字段之一）' },
        content: { type: 'string', description: '记忆正文（完整内容，可用 markdown）' },
        tags: { type: 'string', description: '标签，多个用英文逗号分隔（可选），如 "react,vite,踩坑"' },
        category: {
          type: 'string',
          description: '分类（可选，默认 general）',
          enum: ['problem-solution', 'technical-note', 'conversation', 'general'],
        },
        searchSummary: { type: 'string', description: '检索摘要（可选）：罗列关键词、近义词、技术栈名，提升被检索到的概率' },
        pinned: { type: 'string', description: '是否置顶高优记忆（可选），传 "true" 置顶，默认否' },
      },
      required: ['title', 'content'],
    },
  },
}, async (args, ctx) => {
  const identity = requireToolExecutionIdentity(ctx);
  const { writeMemory } = await import('./memoryStore');
  const tags = typeof args.tags === 'string'
    ? args.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
    : (Array.isArray(args.tags) ? args.tags : []);
  const pinned = args.pinned === true || String(args.pinned).toLowerCase() === 'true';
  const saved = await writeMemory({
    title: args.title,
    content: args.content,
    tags,
    category: args.category,
    searchSummary: args.searchSummary,
    pinned,
    conversationId: identity.conversationId,
  });
  if (!saved) return toolFailure('error', 'provider', '记忆写入失败（记忆是辅助层，不影响当前对话继续进行）。');
  const tagStr = saved.tags.length ? ` [${saved.tags.join(', ')}]` : '';
  return toolSuccess(`✅ 已记入 Synapse 记忆库 (id=${saved.id}, 分类=${saved.category}${saved.pinned ? ', 置顶' : ''})${tagStr}\n标题: ${saved.title}`);
}, 'custom', 'write', 'write');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_query',
    description:
      '从 Synapse 内置记忆库检索长期记忆（存本地 SQLite，Web 模式存 localStorage；'
      + '独立于外置 MCP memory-store，数据不互通）。'
      + '按关键词命中标题/正文/检索摘要/标签返回最相关的若干条，置顶记忆优先、近更新优先。'
      + '开始新任务或需要回忆既往背景/方案/偏好时应主动调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（可空，留空则返回最近更新的记忆）' },
        category: {
          type: 'string',
          description: '按分类过滤（可选）',
          enum: ['problem-solution', 'technical-note', 'conversation', 'general'],
        },
        limit: { type: 'number', description: '返回条数上限（可选，默认 10）' },
      },
      required: [],
    },
  },
}, async (args, ctx) => {
  const identity = requireToolExecutionIdentity(ctx);
  const { queryMemory } = await import('./memoryStore');
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
  const results = await queryMemory(args.query, {
    conversationId: identity.conversationId,
    category: args.category,
    limit,
  });
  if (!results.length) {
    return toolSuccess(args.query
      ? `未在 Synapse 记忆库中找到与 "${args.query}" 相关的记忆。`
      : 'Synapse 记忆库暂无记忆。');
  }
  const lines = results.map((m, i) => {
    const tagStr = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    const pin = m.pinned ? '📌 ' : '';
    return `${i + 1}. ${pin}${m.title} (${m.category})${tagStr}\n   ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`;
  });
  return toolSuccess(`🧠 Synapse 记忆库命中 ${results.length} 条:\n\n${lines.join('\n\n')}`);
}, 'custom', 'auto', 'search');

// --- Memory 只读工具（M4-7-S5 完善内置记忆读路径）---
// memory_query 只能按关键词检索；这两个补「列举」与「按 id 精读」能力，让 AI 不仅能搜、还能
// 浏览全部记忆 + 拿单条完整正文（query 截断到 300 字预览，精读需 memory_read 取全文）。
// 复用 memoryStore 已有的 listMemories / getMemory（仅之前未注册为工具），approval auto / category read。
// ⚠️ 仍是 Synapse 内置记忆（本地 SQLite / localStorage），独立于外置 MCP mcp__memory-store__*。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_list',
    description:
      '列举 Synapse 内置记忆库中的记忆（按更新时间倒序，可过滤分类 / 仅置顶）。'
      + '与 memory_query 的区别：memory_query 按关键词检索命中相关条目；'
      + 'memory_list 不带关键词、用于【浏览全部】记忆概览（例如想看「我都记了些什么」）。'
      + '正文同样只给预览，需要某条完整内容时用 memory_read(id) 精读。'
      + '（Synapse 内置记忆，存本地 SQLite / localStorage，独立于外置 MCP memory-store，数据不互通。）',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: '按分类过滤（可选）',
          enum: ['problem-solution', 'technical-note', 'conversation', 'general'],
        },
        pinnedOnly: { type: 'string', description: '仅列出置顶记忆（可选），传 "true" 只看置顶' },
        limit: { type: 'number', description: '返回条数上限（可选，默认 20）' },
      },
      required: [],
    },
  },
}, async (args, ctx) => {
  const identity = requireToolExecutionIdentity(ctx);
  const { listMemories } = await import('./memoryStore');
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
  const pinnedOnly = args.pinnedOnly === true || String(args.pinnedOnly).toLowerCase() === 'true';
  const results = await listMemories({
    conversationId: identity.conversationId,
    category: args.category,
    pinnedOnly,
    limit,
  });
  if (!results.length) {
    return toolSuccess(pinnedOnly
      ? 'Synapse 记忆库暂无置顶记忆。'
      : 'Synapse 记忆库暂无记忆。');
  }
  const lines = results.map((m, i) => {
    const tagStr = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    const pin = m.pinned ? '📌 ' : '';
    return `${i + 1}. ${pin}${m.title} (id=${m.id}, ${m.category})${tagStr}\n   ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`;
  });
  return toolSuccess(`🧠 Synapse 记忆库共列出 ${results.length} 条（按更新时间倒序）:\n\n${lines.join('\n\n')}\n\n提示：用 memory_read(id) 取某条完整正文。`);
}, 'custom', 'auto', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_read',
    description:
      '按 id 精读 Synapse 内置记忆库中的【单条】记忆完整内容（含完整正文、标签、检索摘要、时间）。'
      + 'memory_query / memory_list 返回的是截断预览，需要某条记忆的全文时用本工具按其 id 取回。'
      + '（Synapse 内置记忆，存本地 SQLite / localStorage，独立于外置 MCP memory-store，数据不互通。）',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（取自 memory_query / memory_list 返回里的 id=...）' },
      },
      required: ['id'],
    },
  },
}, async (args, ctx) => {
  const identity = requireToolExecutionIdentity(ctx);
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return toolFailure('error', 'invalid_result', 'memory_read 需要有效的记忆 id（取自 memory_query / memory_list 返回里的 id=...）。');
  const { getMemory } = await import('./memoryStore');
  const m = await getMemory(id);
  if (!m || m.conversationId !== identity.conversationId) {
    return toolFailure('error', 'not_found', `未在当前对话的 Synapse 记忆库中找到 id=${id} 的记忆（可能已被删除、属于其它对话或 id 有误）。`);
  }
  const tagStr = m.tags.length ? m.tags.join(', ') : '（无）';
  const fmt = (sec: number) => (sec > 0 ? new Date(sec * 1000).toLocaleString() : '（未知）');
  return toolSuccess([
    `🧠 记忆全文 (id=${m.id})`,
    `标题: ${m.title}`,
    `分类: ${m.category}${m.pinned ? '（置顶）' : ''}`,
    `标签: ${tagStr}`,
    m.searchSummary ? `检索摘要: ${m.searchSummary}` : '',
    `创建: ${fmt(m.createdAt)}   更新: ${fmt(m.updatedAt)}`,
    '',
    '正文:',
    m.content,
  ].filter(Boolean).join('\n'));
}, 'custom', 'auto', 'read');

// --- Record Tools（M2-R3 渐进式读：按需展开骨架批次）---
// record 历史摘要注入时，中段较老的批次被降级为「骨架」（只有标题 + 首行要点）以控制注入膨胀。
// 当需要某个骨架批次的完整过程日志细节时，调本工具按 batchIndex 取回该批全文。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'record_read',
    description:
      '展开当前对话 record 中被折叠为「骨架」的某个批次的完整过程日志（contentMd 全文）。'
      + 'record 历史摘要里标注为「[批次N 骨架，可用 record_read 展开全文]」的批次只注入了标题/要点，'
      + '需要该批次的完整细节（具体决策、工具调用、文件改动等）时调用本工具。'
      + 'batchIndex 用骨架标注里给出的批次序号；本工具只能读取当前运行所属对话。',
    parameters: {
      type: 'object',
      properties: {
        batchIndex: { type: 'number', description: '要展开的批次序号（取自骨架标注里的「批次N」）' },
      },
      required: ['batchIndex'],
    },
  },
}, async (args, ctx) => {
  const batchIndex = Number(args.batchIndex);
  if (!Number.isFinite(batchIndex)) {
    return toolFailure('error', 'invalid_result', 'record_read 需要有效的 batchIndex（数字，取自骨架标注里的「批次N」）。');
  }
  const { getBatch } = await import('./recordStore');
  const conversationId = ctx?.conversationId?.trim();
  if (!conversationId) {
    return toolFailure('error', 'unauthorized', 'record_read 缺少当前运行的对话归属，已拒绝读取。');
  }
  const contentMd = await getBatch(conversationId, batchIndex);
  if (!contentMd) {
    return toolFailure('error', 'not_found', `未找到批次 ${batchIndex} 的全文（该批可能不存在、已被回溯裁剪，或当前对话无 record）。`);
  }
  return toolSuccess(`📜 批次 ${batchIndex} 完整过程日志:\n\n${contentMd}`);
}, 'custom', 'auto', 'read');

// ★ #14 动态分级（hit 反馈）：AI 读 record 摘要时，发现某批/某轮历史正是当前需要的上下文 → 调本工具标记它，
//   系统会在下次压缩点据此把该段保留更完整内容（升 full）。标记只记账、不立即改注入，故不影响 prompt cache。
toolRegistry.register({
  type: 'function',
  function: {
    name: 'mark_record_hit',
    description:
      '标记当前对话 record 历史摘要里的某个批次/某一轮【正是你当前需要的上下文】（hit 反馈）。'
      + '当你读 record 摘要（含被折叠为「骨架/标题」的批次）时，若发现某段历史正是解决当前问题需要的关键上下文，'
      + '调用本工具标记它——系统会在后续压缩时优先把这段历史保留更完整的内容（全文而非仅标题），方便你后续随时取用。'
      + 'batchIndex 用骨架标注里的「批次N」精确标记一个批；或用 roundHit 标记某一轮号所在的批（二者传其一，batchIndex 优先）。'
      + '本工具只能标记当前运行所属对话；标记只记账、不立即改变摘要内容。',
    parameters: {
      type: 'object',
      properties: {
        batchIndex: { type: 'number', description: '要标记的批次序号（取自骨架标注里的「批次N」）' },
        roundHit: { type: 'number', description: '要标记的轮号（命中该轮号所在的批；batchIndex 已传时忽略）' },
      },
      required: [],
    },
  },
}, async (args, ctx) => {
  const hasBatch = Number.isFinite(Number(args.batchIndex));
  const hasRound = Number.isFinite(Number(args.roundHit));
  if (!hasBatch && !hasRound) {
    return toolFailure('error', 'invalid_result', 'mark_record_hit 需要 batchIndex（骨架标注里的「批次N」）或 roundHit（轮号）至少其一。');
  }
  const { markRecordHit } = await import('./recordStore');
  const { identifyRounds } = await import('./roundBoundary');
  const { store } = await import('@/store');
  const state = store.getState() as any;
  const conversationId = ctx?.conversationId?.trim();
  if (!conversationId) {
    return toolFailure('error', 'unauthorized', 'mark_record_hit 缺少当前运行的对话归属，已拒绝写入。');
  }
  // 当前对话轮号（过滤 tool 后真轮识别）——传给 markRecordHit 作 lastHitRound 候选。
  // ⚠️ 口径注意：这是 live 真轮（含未压缩的最近几轮），与 record 水位轮（恒 ≤ live 真轮）只是「计数方法相同」、
  //    数值并不同轴。markRecordHit 内部会把它钳到 min(liveRound, record.totalRounds) 再写库，使 lastHitRound 与
  //    computeRenderLevels 的 freshness 消费轴（record 水位轮）对齐——否则 hitAge 恒被夹成 0、freshness 不衰减。
  const { selectConversationById } = await import('@/store/slices/conversation');
  const liveMessages = (selectConversationById(state, conversationId).messages ?? [])
    .filter((m: any) => m?.role !== 'tool');
  const currentRound = identifyRounds(liveMessages).totalRounds;
  const target = hasBatch
    ? { batchIndex: Math.floor(Number(args.batchIndex)) }
    : { roundHit: Math.floor(Number(args.roundHit)) };
  const updated = await markRecordHit(conversationId, target, currentRound);
  if (!updated) {
    const desc = hasBatch ? `批次 ${target.batchIndex}` : `第 ${target.roundHit} 轮`;
    return toolFailure('error', 'not_found', `未能标记 ${desc}（该批可能不存在、已被回溯裁剪/折叠归档，或当前对话无 record）。`);
  }
  const desc = hasBatch ? `批次 ${Math.floor(Number(args.batchIndex))}` : `第 ${Math.floor(Number(args.roundHit))} 轮所在批`;
  return toolSuccess(`✅ 已标记 ${desc} 为当前需要的上下文（hit 反馈已记账）。系统将在后续压缩时优先为这段历史保留更完整内容。`);
}, 'custom', 'auto', 'read');

// --- Web Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'search_web',
    description: '使用公开源尽力搜索网页并返回可追溯引用；结果不等同于 Exa，网页正文始终是不可信外部资料。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        language: { type: 'string', enum: ['auto', 'zh', 'en'], description: '结果语言，默认自动识别' },
        max_results: { type: 'number', description: '最多返回 1—10 条结果，默认 8' },
        fetch_top: { type: 'number', description: '抓取正文并生成可追溯引用的前 0—3 条结果，默认 2' },
        official_domains: { type: 'array', items: { type: 'string' }, description: '已知权威域名，可用于温和排序加权' },
      },
      required: ['query'],
    },
  },
}, async (args, ctx) => {
  const { isElectron } = await import('@platform/index');
  if (!isElectron || !window.synapse) {
    return toolFailure('error', 'unsupported', 'Web 模式下内置网页搜索不可用，请使用 Electron 模式');
  }
  try {
    const identity = requireToolExecutionIdentity(ctx);
    const taskId = await managedTaskId('web-search', identity);
    const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };
    const started = await window.synapse.toolTask.start({
      kind: 'web-search',
      taskId,
      identity,
      input: {
        query: args.query,
        language: args.language,
        maxResults: args.max_results,
        fetchTop: args.fetch_top,
        officialDomains: args.official_domains,
      },
    });
    await notifyTaskStarted(ctx, started);
    if (started.status === 'running' || started.status === 'cancelling') {
      executionRegistry.registerCancelable(identity.ownerId, started.taskId, async () => {
        await window.synapse?.toolTask.cancel(started.taskId, access);
      }, identity.runId);
    }
    const result = await window.synapse.toolTask.wait(started.taskId, 10, access);
    if (result.status !== 'running' && result.status !== 'cancelling') {
      executionRegistry.releaseCancelable(identity.ownerId, result.taskId);
    }
    if (result.status === 'running' || result.status === 'cancelling') {
      const text = [
        `⏳ 网页搜索仍在运行（taskId=${result.taskId}）`,
        '可调用 tool_status 等待 10—120 秒，或调用 tool_cancel 请求停止。',
        result.text,
      ].filter(Boolean).join('\n\n');
      return taskSnapshotToToolResult(result, text);
    }
    return taskSnapshotToToolResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const identityError = /(?:taskId|后台任务).*?(?:已被其它请求使用|不属于当前对话|已绑定其它 run\/call|格式无效)/i.test(message);
    return toolFailure(
      'error',
      identityError ? 'invalid_result' : 'transport',
      `网页搜索失败: ${message}`,
      { retryable: !identityError },
    );
  }
}, 'web', 'auto', 'search');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'read_url_content',
    description: '读取指定 URL 的网页内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取的网页 URL' },
      },
      required: ['url'],
    },
  },
}, async (args, ctx) => {
  const { isElectron } = await import('@platform/index');
  if (!isElectron || !window.synapse) {
    return toolFailure('error', 'unsupported', 'Web 模式下内置网页读取不可用，请使用 Electron 模式');
  }
  try {
    const identity = requireToolExecutionIdentity(ctx);
    const taskId = await managedTaskId('web', identity);
    const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };
    const started = await window.synapse.toolTask.start({
      kind: 'web',
      taskId,
      identity,
      input: { url: args.url },
    });
    await notifyTaskStarted(ctx, started);
    if (started.status === 'running' || started.status === 'cancelling') {
      executionRegistry.registerCancelable(identity.ownerId, started.taskId, async () => {
        await window.synapse?.toolTask.cancel(started.taskId, access);
      }, identity.runId);
    }
    const result = await window.synapse.toolTask.wait(started.taskId, 10, access);
    if (result.status !== 'running' && result.status !== 'cancelling') {
      executionRegistry.releaseCancelable(identity.ownerId, result.taskId);
    }
    if (result.status === 'running' || result.status === 'cancelling') {
      const text = [
        `⏳ 网页读取仍在运行（taskId=${result.taskId}）`,
        '可调用 tool_status 等待 10—120 秒，或调用 tool_cancel 请求停止。',
        result.text,
      ].filter(Boolean).join('\n\n');
      return taskSnapshotToToolResult(result, text);
    }
    return taskSnapshotToToolResult(result);
  } catch (err: any) {
    return toolFailure('error', 'transport', `读取 URL 失败: ${err.message}`, { retryable: true });
  }
}, 'web', 'auto', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'sandbox_javascript',
    description:
      '在主进程 Broker 管理的受限 JavaScript 计算隔离区中运行可信代码片段。'
      + '隔离区不提供文件、网络、process、require 或动态代码生成能力，适合计算、解析和小型算法验证；'
      + '需要读写文件或运行系统命令时分别使用文件工具或 run_command。'
      + '这不是用于执行恶意代码的操作系统安全边界。代码如需返回值，请显式使用 return。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要运行的 JavaScript 函数体，可使用 console.log，并用 return 返回结果' },
        timeoutSeconds: { type: 'number', description: '执行上限 0.1—30 秒（可选，默认 5 秒）' },
      },
      required: ['code'],
    },
  },
}, async (args, ctx) => {
  const { isElectron } = await import('@platform/index');
  if (!isElectron || !window.synapse) {
    return toolFailure('error', 'unsupported', 'JavaScript 沙盒仅在 Electron 模式下可用。');
  }
  try {
    const identity = requireToolExecutionIdentity(ctx);
    const taskId = await managedTaskId('sandbox-javascript', identity);
    const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };
    const timeoutSeconds = Number(args.timeoutSeconds);
    const timeoutMs = Number.isFinite(timeoutSeconds)
      ? Math.max(100, Math.min(30_000, Math.round(timeoutSeconds * 1000)))
      : 5_000;
    const started = await window.synapse.toolTask.start({
      kind: 'sandbox-javascript',
      taskId,
      identity,
      input: { code: args.code, timeoutMs },
    });
    await notifyTaskStarted(ctx, started);
    if (started.status === 'running' || started.status === 'cancelling') {
      executionRegistry.registerCancelable(identity.ownerId, started.taskId, async () => {
        await window.synapse?.toolTask.cancel(started.taskId, access);
      }, identity.runId);
    }
    const result = await window.synapse.toolTask.wait(started.taskId, 10, access);
    if (result.status !== 'running' && result.status !== 'cancelling') {
      executionRegistry.releaseCancelable(identity.ownerId, result.taskId);
    }
    if (result.status === 'running' || result.status === 'cancelling') {
      return taskSnapshotToToolResult(result, [
        `⏳ JavaScript 沙盒仍在运行（taskId=${result.taskId}）`,
        '可调用 tool_status 等待，或调用 tool_cancel 请求停止。',
      ].join('\n\n'));
    }
    return taskSnapshotToToolResult(result);
  } catch (error) {
    return toolFailure('error', 'transport', `JavaScript 沙盒启动失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 'custom', 'auto', 'generate');

// --- Command Tools ---

const TOOL_ERROR_CODES = new Set<ToolErrorCode>([
  'not_found',
  'approval_denied',
  'aborted',
  'timeout',
  'transport',
  'provider',
  'rate_limit',
  'server_error',
  'http_error',
  'unauthorized',
  'quota_exhausted',
  'invalid_result',
  'unsupported',
  'unknown',
]);

function taskErrorCode(snapshot: ToolTaskSnapshot, fallback: ToolErrorCode): ToolErrorCode {
  return snapshot.errorCode && TOOL_ERROR_CODES.has(snapshot.errorCode as ToolErrorCode)
    ? snapshot.errorCode as ToolErrorCode
    : fallback;
}

export function taskSnapshotToToolResult(snapshot: ToolTaskSnapshot, text = snapshot.text): ToolResult {
  const artifacts = snapshot.artifacts;
  if (snapshot.status === 'running' || snapshot.status === 'cancelling') {
    return toolPending(snapshot.status, snapshot.taskId, text);
  }
  if (snapshot.status === 'success') {
    if (snapshot.kind === 'mcp' && isBrokeredMcpResultEnvelope(snapshot.structured)) {
      const flattened = flattenMcpResult(snapshot.structured.result, snapshot.structured.approvalLevel);
      const artifacts = [...(flattened.data?.artifacts ?? []), ...(snapshot.artifacts ?? [])];
      return {
        ...flattened,
        taskId: flattened.taskId ?? snapshot.taskId,
        data: flattened.data ? { ...flattened.data, artifacts: artifacts.length ? artifacts : undefined } : null,
      } as ToolResult;
    }
    const artifactSummary = artifacts?.length
      ? `\n\n完整结果文件：\n${artifacts.map(item => {
        const displayName = item.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'artifact';
        return `- ${displayName}${item.bytes !== undefined ? ` (${item.bytes} bytes)` : ''}${item.sha256 ? ` · SHA-256 ${item.sha256}` : ''}`;
      }).join('\n')}`
      : '';
    return toolSuccess(`${text}${artifactSummary}`, { taskId: snapshot.taskId, structured: snapshot, artifacts });
  }
  if (snapshot.status === 'cancelled') {
    return toolFailure('cancelled', taskErrorCode(snapshot, 'aborted'), `任务 ${snapshot.taskId} 已取消`, {
      taskId: snapshot.taskId,
      text,
      structured: snapshot,
      artifacts,
      unknownSideEffect: snapshot.unknownSideEffect,
    });
  }
  if (snapshot.status === 'unknown') {
    return toolFailure('unknown', taskErrorCode(snapshot, 'unknown'), snapshot.error || `任务 ${snapshot.taskId} 状态无法确认`, {
      taskId: snapshot.taskId,
      text,
      unknownSideEffect: snapshot.unknownSideEffect,
      structured: snapshot,
      artifacts,
    });
  }
  return toolFailure('error', taskErrorCode(snapshot, 'provider'), snapshot.error || `工具任务 ${snapshot.taskId} 执行失败`, {
    taskId: snapshot.taskId,
    text,
    structured: snapshot,
    artifacts,
    unknownSideEffect: snapshot.unknownSideEffect,
  });
}

toolRegistry.register({
  type: 'function',
  function: {
    name: 'run_command',
    description: '执行系统命令（需要用户审批）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
      },
      required: ['command'],
    },
  },
}, async (args, ctx) => {
  const { isElectron } = await import('@platform/index');
  if (isElectron && window.synapse) {
    try {
      const identity = requireToolExecutionIdentity(ctx);
      // M2-5：cwd 优先级 = 显式 args.cwd > 本上下文活动 worktree > 主工作区 currentPath。
      // 都没有时传 undefined，主进程 command:start 兜底 process.cwd()。
      //
      // ★ medium#1 显式行为变更（已记录为有意改进，非回归）：
      //   旧链路 AI 几乎不传 cwd → undefined → 主进程落 process.cwd()（Electron 安装/启动目录，潜在 bug）。
      //   新链路无活动 worktree 时落【已打开工作区 currentPath】，命令跑在用户工作区根而非安装目录——
      //   方向正确（把「跑在安装目录」修成「跑在工作区」）。无 currentPath（未打开工作区）时仍回退 undefined
      //   → process.cwd()，与现状一致。本变更已在 Task_4 显式记录。
      let cwd: string | undefined;
      const requestedCwd = typeof args.cwd === 'string' ? args.cwd.trim() : '';
      if (requestedCwd) {
        const { resolveWorkspacePath } = await import('./fileSystem');
        cwd = await resolveWorkspacePath(requestedCwd, ctx?.contextId, ctx?.conversationId);
      } else {
        const { getActiveRoots } = await import('./fileSystem');
        const { activeWorktreePath, currentPath } = await getActiveRoots(ctx?.contextId, ctx?.conversationId);
        cwd = activeWorktreePath ?? currentPath ?? undefined;
      }
      const taskId = await managedTaskId('command', identity);
      const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };
      const pendingApprovalKey = `pending-approval:${taskId}`;
      executionRegistry.registerCancelable(identity.ownerId, pendingApprovalKey, async () => {
        await window.synapse?.toolTask.cancelPendingApproval?.(taskId);
      }, identity.runId);
      let started;
      try {
        started = await window.synapse.toolTask.start({
          kind: 'command',
          taskId,
          identity,
          input: { command: args.command, cwd },
        });
      } finally {
        executionRegistry.releaseCancelable(identity.ownerId, pendingApprovalKey);
      }
      await notifyTaskStarted(ctx, started);
      if (started.status === 'running' || started.status === 'cancelling') {
        executionRegistry.registerCancelable(identity.ownerId, started.taskId, async () => {
          const cancelled = await window.synapse?.toolTask.cancel(started.taskId, access);
          if (!cancelled || cancelled.status === 'running' || cancelled.status === 'cancelling') {
            executionRegistry.registerCancelable(identity.ownerId, started.taskId, async () => {
              await window.synapse?.toolTask.cancel(started.taskId, access);
            }, identity.runId);
          } else {
            executionRegistry.releaseCancelable(identity.ownerId, started.taskId);
          }
        }, identity.runId);
      }
      const result = await window.synapse.toolTask.wait(started.taskId, 10, access);
      if (result.status !== 'running' && result.status !== 'cancelling') {
        executionRegistry.releaseCancelable(identity.ownerId, result.taskId);
      }
      if (result.status === 'running' || result.status === 'cancelling') {
        const text = [
          `⏳ 命令仍在运行（taskId=${result.taskId}）`,
          '可调用 tool_status 并选择等待 10—120 秒，或调用 tool_cancel 请求终止。',
          '在任务结束前，后续工作中必须继续提醒模型该任务仍未完成。',
          result.text,
        ].filter(Boolean).join('\n\n');
        return taskSnapshotToToolResult(result, text);
      }
      return taskSnapshotToToolResult(result);
    } catch (err: any) {
      if (/用户取消|审批.*取消|approval.*cancel/i.test(String(err?.message ?? err))) {
        return toolFailure('cancelled', 'approval_denied', `命令未启动: ${err.message}`, {
          unknownSideEffect: false,
          structured: { executionTimeMs: 0 },
        });
      }
      return toolFailure('unknown', 'transport', `命令执行失败: ${err.message}`, { unknownSideEffect: true });
    }
  }
  return toolFailure('error', 'unsupported', 'Web 模式下命令执行不可用，请使用 Electron 模式', {
    text: `⚠️ 命令执行请求: \`${args.command}\`\n工作目录: ${args.cwd || '(当前)'}\n\n[Web 模式下命令执行不可用，请使用 Electron 模式]`,
  });
}, 'command', 'dangerous', 'command');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'tool_status',
    description: '查询后台工具任务；可等待 10—120 秒，任务提前结束时会立即返回。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '后台工具返回的 taskId' },
        waitSeconds: { type: 'number', description: '等待秒数，10—120；省略时只查询当前状态' },
      },
      required: ['taskId'],
    },
  },
}, async (args, ctx) => {
  const { isElectron } = await import('@platform/index');
  if (!isElectron || !window.synapse) return toolFailure('error', 'unsupported', 'Web 模式没有后台工具任务。');
  const identity = requireToolExecutionIdentity(ctx);
  const requestedWait = Number(args.waitSeconds) || 0;
  const waitSeconds = requestedWait > 0 ? Math.max(10, Math.min(120, requestedWait)) : 0;
  const result = waitSeconds > 0
    ? await window.synapse.toolTask.wait(String(args.taskId), waitSeconds, { conversationId: identity.conversationId, ownerId: identity.ownerId })
    : await window.synapse.toolTask.status(String(args.taskId), { conversationId: identity.conversationId, ownerId: identity.ownerId });
  if (result.ownerId && result.status !== 'running' && result.status !== 'cancelling') {
    executionRegistry.releaseCancelable(result.ownerId, result.taskId);
  }
  const text = [
    `任务 ${result.taskId}: ${result.status}`,
    result.text,
    (result.status === 'running' || result.status === 'cancelling')
      ? '该任务尚未结束，后续必须继续提醒模型，可再次等待或取消。'
      : '',
  ].filter(Boolean).join('\n\n');
  return taskSnapshotToToolResult(result, text);
}, 'command', 'auto', 'command');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'tool_cancel',
    description: '请求取消后台工具任务；只有执行器确认停止后才返回 cancelled。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要取消的后台任务 ID' },
      },
      required: ['taskId'],
    },
  },
}, async (args, ctx) => {
  const { isElectron } = await import('@platform/index');
  if (!isElectron || !window.synapse) return toolFailure('error', 'unsupported', 'Web 模式没有可取消的后台工具任务。');
  const identity = requireToolExecutionIdentity(ctx);
  const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };
  const result = await window.synapse.toolTask.cancel(String(args.taskId), access);
  if (result.ownerId && result.status !== 'running' && result.status !== 'cancelling') {
    executionRegistry.releaseCancelable(result.ownerId, result.taskId);
  }
  const text = result.status === 'cancelled'
    ? `✅ 任务 ${result.taskId} 的执行器已确认取消；任何迟到结果都会被丢弃。`
    : `⚠️ 任务 ${result.taskId} 当前状态为 ${result.status}，不能宣称已经取消。${result.error ? ` ${result.error}` : ''}`;
  return taskSnapshotToToolResult(result, text);
}, 'command', 'auto', 'command');

// --- Worktree Tools（M2-5：按需进入隔离工作树）---
// 默认在主工作区改文件，行为与现状一致。仅当需要把改动隔离在独立分支/工作树里
// （例如试验性大改、与主工作区并行、用户明确要求「在 worktree 里改」）时，才调 enter_worktree。
// 进入后 view_file/write_to_file/run_command 的根路径自动重定向到该 worktree；exit_worktree 退回主工作区。

/** 默认分支/工作树名：worktree 仓侧 SAFE_NAME 只允许 [A-Za-z0-9._-]，不能含 `/`，故用连字符。 */
function defaultWorktreeBranch(): string {
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `synapse-wt-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
}

toolRegistry.register({
  type: 'function',
  function: {
    name: 'enter_worktree',
    description:
      '进入一个隔离的 git 工作树（worktree）在独立分支里改文件。'
      + '【默认不需要】——一般小修小改直接在主工作区操作即可，不要调用本工具。'
      + '仅在需要隔离改动时才用：例如做试验性/大范围改动想与主工作区分开、'
      + '需要在一个独立分支上工作、或用户明确要求「在 worktree 里改」。'
      + '进入后，view_file / write_to_file / run_command 的根路径会自动重定向到该 worktree 目录；'
      + '改完可继续留着给用户看 diff，或调 exit_worktree 退回主工作区。'
      + '相同 branch 已存在对应 worktree 时会直接复用而非重建。仅 Electron 桌面模式可用。',
    parameters: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: '分支名（可选，只允许字母/数字/点/连字符/下划线）。缺省自动生成 synapse-wt-<时间戳>。',
        },
      },
      required: [],
    },
  },
}, async (args, ctx) => {
  const { isElectron, platform } = await import('@platform/index');
  if (!isElectron || !platform.worktree) {
    return toolFailure('error', 'unsupported', 'git worktree 仅在 Electron 桌面模式下可用。当前为 Web 模式，已保持在主工作区（文件操作照常）。');
  }

  const { store } = await import('@/store');
  const { enterWorktree } = await import('@/store/slices/worktreeSession');
  const { addNotification } = await import('@/store/slices/notifications');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const state = store.getState() as any;
  const conversationWorkspace = ctx?.conversationId
    ? (await import('@/store/slices/conversation')).selectConversationById(state, ctx.conversationId).workspacePath
    : null;
  const repoRoot = conversationWorkspace ?? ((state?.workspace?.currentPath as string | null) ?? null);
  if (!repoRoot) {
    return toolFailure('error', 'not_found', '尚未打开工作区，无法进入 worktree。请先打开一个工作区（且该目录是 git 仓库），再重试。');
  }

  // contextId = 当前执行上下文（agentLoop 注入；现阶段=conversationId）。缺省时回退当前对话 id ?? AUTOSAVE_ID，
  // 保证至少把活动 worktree 绑到一个稳定的上下文键上（与 record/autosave 回退口径一致）。
  const contextId = ctx?.contextId
    || ((state?.conversation?.id as string | null) || AUTOSAVE_ID);

  const branch = (typeof args.branch === 'string' && args.branch.trim())
    ? args.branch.trim()
    : defaultWorktreeBranch();

  // 先看该分支是否已有对应 worktree（复用，避免「目标路径已存在」报错）。
  try {
    const listed = await platform.worktree.list({ repoRoot });
    if (!listed.error && Array.isArray(listed.worktrees)) {
      const existing = listed.worktrees.find(wt => wt.branch === branch && !wt.bare);
      if (existing) {
        store.dispatch(enterWorktree({ contextId, path: existing.path, branch, repoRoot }));
        // ★ medium#5：进入（复用）也给用户一条通知，让磁盘/git 状态变化可见（不止返回给 AI）。
        store.dispatch(addNotification({
          type: 'info',
          title: '已进入 worktree',
          message: `复用已有工作树（分支 ${branch}）：${existing.path}`,
          duration: 4000,
        }));
        return toolSuccess(`✅ 已复用并进入 worktree（分支 ${branch}）：\n${existing.path}\n\n后续 view_file/list_dir/write_to_file/run_command 将作用于此工作树。改完可调 exit_worktree 退回主工作区。`);
      }
    } else if (listed.error) {
      return toolFailure('error', 'provider', `无法进入 worktree：${listed.message || 'git worktree list 失败'}（已保持在主工作区）。`);
    }
  } catch (err: any) {
    return toolFailure('unknown', 'transport', `无法进入 worktree：${err?.message ?? err}（已保持在主工作区）。`, { unknownSideEffect: true });
  }

  // 未复用到 → 新建（git 写操作，approval=write 会触发用户确认）。
  const created = await platform.worktree.create({ repoRoot, branch });
  if (created.error || !created.path) {
    return toolFailure('error', 'provider', `创建 worktree 失败：${created.message || '未知错误'}（已保持在主工作区，文件操作照常）。`);
  }
  const createdBranch = created.branch ?? branch;
  store.dispatch(enterWorktree({ contextId, path: created.path, branch: createdBranch, repoRoot }));
  // ★ medium#5：创建成功后 dispatch 一条通知（与 M2-6 其它写操作的通知口径对齐），告知用户
  //   「已在磁盘 X 路径创建工作树目录 + git 里新建分支 Y」，避免用户对磁盘/git 状态变化无感知。
  store.dispatch(addNotification({
    type: 'info',
    title: '已创建并进入 worktree',
    message: `新分支 ${createdBranch}，工作树目录：${created.path}`,
    duration: 5000,
  }));
  return toolSuccess(`✅ 已创建并进入 worktree（新分支 ${createdBranch}）：\n${created.path}\n\n后续 view_file/list_dir/write_to_file/run_command 将作用于此工作树（与主工作区隔离）。改完可调 exit_worktree 退回主工作区。`);
}, 'command', 'write', 'command');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'exit_worktree',
    description:
      '退出当前 worktree，让后续文件/命令操作回到主工作区。'
      + '仅当之前调过 enter_worktree 进入了某 worktree 时才有意义；'
      + '未处于任何 worktree 时调用是安全的空操作。'
      + '注意：本工具只切换「当前作用目录」回主工作区，不会删除 worktree（worktree 及其分支仍在磁盘/git 里，'
      + '可在设置-工作树里查看/删除，或之后再 enter_worktree 复用同一分支）。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
}, async (_args, ctx) => {
  const { store } = await import('@/store');
  const { exitWorktree, selectWorktreeEntry } = await import('@/store/slices/worktreeSession');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const state = store.getState() as any;
  const contextId = ctx?.contextId
    || ((state?.conversation?.id as string | null) || AUTOSAVE_ID);
  const prev = selectWorktreeEntry(state, contextId)?.activeWorktreePath ?? null;
  if (!prev) {
    return toolSuccess('当前已在主工作区（未处于任何 worktree），无需退出。');
  }
  store.dispatch(exitWorktree({ contextId }));
  return toolSuccess(`✅ 已退出 worktree，回到主工作区。后续 view_file/list_dir/write_to_file/run_command 将作用于主工作区。\n（刚才的 worktree 仍保留在磁盘与 git 中：${prev}）`);
}, 'command', 'auto', 'command');

// --- Multi-AI Tools（M3-1a 真子代理：派发独立子代理执行任务）---
// spawn_subagent：主 AI / 上层子代理调用，派一个独立子代理（独立上下文 + 工具循环）执行任务，
// 完成后把子代理的结构化报告作为工具结果返回给调用方的对话循环（结果回插）。
//
// ★ 工具循环/落库/隔离实现见 agentOrchestrator.spawnSubagent（方案 A：不走主 agentLoop.run，不污染主对话）。
// ★ 循环依赖规避：agentOrchestrator 顶层 import toolRegistry（取 schemas + execute）；本 handler 反向用
//   动态 import('./agentOrchestrator') 在调用时才取实例，避免模块级互相 import 成环。
// ★ maxDepth 派发深度（递归层数控制，逐层递减防无限派发）：
//   - 调用方是【子代理】（ctx.contextId 在 orchestrator.depthByContext 里）→ 本次派出的子代理 maxDepth = 父 depth - 1。
//     （buildSubagentTools 已保证：父 depth>1 才把 spawn_subagent 给它，故 -1 后 >=1。）
//   - 调用方是【主 AI】（contextId 非活动子代理）→ 用工具入参 max_depth（不填默认 1=子代理不能再派）。
toolRegistry.register(
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: '创建一个独立的子代理来执行特定任务。子代理有独立的上下文窗口，可使用工具多步推进，完成后返回结构化报告。适用于：代码审查、文献分析、数据验证、深度研究等可并行的任务。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子代理需要执行的任务描述' },
          role: {
            type: 'string',
            description: '子代理的角色(如: 审查者、文献分析、数据验证)',
            enum: ['reviewer', 'literature', 'validator', 'researcher', 'custom'],
          },
          // ToolSchema.properties 值类型不含 items（运行时不校验），用 string 描述数组语义即可。
          context_files: { type: 'string', description: '需要读取的文件路径列表(可选，JSON 数组或逗号分隔)' },
          max_depth: {
            type: 'number',
            description: '派发深度(可选，正整数；不填=1=该子代理不能再派发孙代理)。填 2=子代理可派一层孙代理；逐层递减防无限派发。',
          },
        },
        required: ['task', 'role'],
      },
    },
  },
  async (args, ctx) => {
    const { agentOrchestrator } = await import('./agentOrchestrator');
    const { store } = await import('@/store');

    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return toolFailure('error', 'invalid_result', 'spawn_subagent 需要 task（子代理任务描述）。');
    const role = typeof args.role === 'string' && args.role.trim() ? args.role.trim() : 'custom';

    // 派发深度推导（见上注释）：父代理是子代理则继承 depth-1，否则用入参（默认 1）。
    const parentDepth = agentOrchestrator.getContextMaxDepth(ctx?.contextId);
    const childMaxDepth = typeof parentDepth === 'number'
      ? Math.max(1, parentDepth - 1)
      : Math.max(1, Math.floor(Number(args.max_depth) || 1));

    // 默认子代理模型 = 配置的 subagentDefaultModel（缺省回退当前模型，由 spawnSubagent 内部兜底）。
    const state = store.getState() as any;
    const model = state.multiAI?.subagentDefaultModel || '';
    const maxTokens = state.multiAI?.defaultSubagentMaxTokens || 32000;

    // 主对话 id 作子对话 parent_id（卡片归属）；缺省由 spawnSubagent 内部回退当前对话 id。
    const parentConversationId = ctx?.conversationId ?? ((state?.conversation?.id as string | null) ?? '');

    const result = await agentOrchestrator.spawnSubagent({
      taskDescription: task,
      contextFiles: parseContextFiles(args.context_files),
      parentConversationId,
      parentOwnerId: ctx?.ownerId,
      config: {
        id: role,
        name: role,
        role,
        model,
        systemPrompt: `你是一个「${role}」角色的子代理，独立完成主代理交给你的任务，完成后返回结构化报告。`,
        // ★ high#4：主 AI 经 spawn_subagent 工具直派的通用子代理给【全量】工具权限类别——与旧行为
        //   （全量工具集）一致，零回归；工具闸门精细约束只作用于工作流编辑器里逐项勾选的子代理。
        toolPermissions: ['read', 'search', 'write', 'command', 'generate'],
        maxTokens,
        maxDepth: childMaxDepth,
      },
    });

    // 把子代理报告作为工具结果返回主对话循环（结果回插主对话）。
    const header = result.status === 'complete'
      ? `✅ 子代理「${result.role}」完成（${(result.duration / 1000).toFixed(1)}s，${result.toolCallsUsed} 次工具调用）`
      : `❌ 子代理「${result.role}」失败`;
    return result.status === 'complete'
      ? toolSuccess(`${header}\n\n${result.report}`)
      : toolFailure('error', 'provider', `子代理「${result.role}」执行失败`, { text: `${header}\n\n${result.report}` });
  },
  'custom',
  'auto',
);

/** 解析 spawn_subagent 的 context_files 入参：兼容 string[]（旧/直传）、JSON 数组字符串、逗号分隔字符串。 */
function parseContextFiles(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const arr = raw.map(f => String(f).trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const arr = parsed.map(f => String(f).trim()).filter(Boolean);
        return arr.length ? arr : undefined;
      }
    } catch {
      // 非 JSON → 按逗号/换行分隔。
    }
    const arr = text.split(/[,\n]/).map(f => f.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

// --- Conversation 原文工具（M7-F2：读 Synapse 自己 SQLite 的历史对话完整原文）---
// 背景：@对话 引用只注入【摘要】；AI 之前误用外置 mcp__memory-store__conversation_read_original
//   （那是跨宿主记忆库，与 Synapse 本地对话是两套系统、conv-xxx ID 不互通）。这两个工具查 Synapse 自己的对话库。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'list_conversations',
    description:
      '列出 Synapse 自己的历史对话（本地 SQLite，独立于外置 MCP memory-store，与那边 conv-xxx 不互通）。'
      + '返回每条的 id / 标题 / 更新时间 / 末条消息预览。需要读某条历史对话的完整原文时，'
      + '先用本工具拿到 id，再调 read_conversation。query 非空按关键词搜标题/内容，否则列最近的。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（可选，搜标题/内容）；留空列最近对话' },
        limit: { type: 'number', description: '返回条数上限（默认 20，最大 50）' },
      },
      required: [],
    },
  },
}, async (args) => {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(50, Number(args.limit))) : 20;
  const { platform } = await import('@/platform');
  let rows: any[] = [];
  try {
    rows = query
      ? await platform.conversation.search(query, { limit })
      : await platform.conversation.list({ limit });
  } catch {
    return toolFailure('error', 'transport', '列出对话失败（平台接口异常）。', { retryable: true });
  }
  if (!rows || rows.length === 0) return toolSuccess(query ? `未找到匹配「${query}」的历史对话。` : '暂无历史对话。');
  const fmtTime = (v: any) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
  };
  const lines = rows.slice(0, limit).map((c, i) => {
    const id = String(c.id ?? '');
    const title = String(c.title ?? '未命名对话');
    const t = fmtTime(c.updatedAt ?? c.updated_at);
    const last = String(c.lastMessage ?? c.last_message ?? '').replace(/\s+/g, ' ').slice(0, 60);
    return `${i + 1}. ${title} (id=${id}${t ? `, ${t}` : ''})${last ? ` — ${last}` : ''}`;
  });
  return toolSuccess(`🗂 Synapse 历史对话（${lines.length} 条）:\n\n${lines.join('\n')}\n\n提示：用 read_conversation(conversationId) 读某条的完整原文。`);
}, 'custom', 'auto', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'read_conversation',
    description:
      '一字不差读取 Synapse 自己某条历史对话的完整原文（逐条 user/assistant/tool 消息）。'
      + '⚠️ 这是 Synapse 本地 SQLite 的对话，独立于外置 MCP memory-store（conversation_read_original）——'
      + '两者是不同系统、conv-xxx ID 不互通，读 Synapse 对话务必用本工具，不要用 memory-store 的。'
      + '@对话 引用只注入摘要，需要完整原文时用本工具。conversationId 缺省读当前对话；内容超长按 maxChars 截断。',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '对话 ID（取自 list_conversations / @对话候选；缺省读当前对话）' },
        maxChars: { type: 'number', description: '返回原文字符上限（默认 24000，最大 60000，防撑爆上下文）' },
      },
      required: [],
    },
  },
}, async (args, ctx) => {
  const { platform } = await import('@/platform');
  const { store } = await import('@/store');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const state = store.getState() as any;
  const conversationId =
    (typeof args.conversationId === 'string' && args.conversationId.trim())
      ? args.conversationId.trim()
      : (ctx?.conversationId || ((state?.conversation?.id as string | null) || AUTOSAVE_ID));
  const maxChars = Number.isFinite(Number(args.maxChars)) ? Math.max(2000, Math.min(60000, Number(args.maxChars))) : 24000;
  let msgs: any[] = [];
  try {
    msgs = await platform.conversation.listMessages(conversationId);
  } catch {
    return toolFailure('error', 'transport', `读取对话 ${conversationId} 失败（平台接口异常）。`, { retryable: true });
  }
  if (!msgs || msgs.length === 0) return toolFailure('error', 'not_found', `对话 ${conversationId} 无消息记录（id 可能有误，可先用 list_conversations 确认）。`);
  const roleLabel: Record<string, string> = { user: '用户', assistant: 'AI', tool: '工具结果', system: '系统' };
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const m of msgs) {
    const role = roleLabel[String(m.role)] ?? String(m.role);
    let text = typeof m.content === 'string' ? m.content : '';
    // 多模态：content 为空但有 contentParts 时取 text part 拼接
    if (!text && Array.isArray(m.contentParts)) {
      text = m.contentParts.filter((p: any) => p?.type === 'text').map((p: any) => p.text ?? '').join('\n');
    }
    const tools = Array.isArray(m.toolCalls) && m.toolCalls.length
      ? `\n  [工具调用: ${m.toolCalls.map((t: any) => t?.name ?? '?').join(', ')}]`
      : '';
    const block = `【${role}】${text}${tools}`;
    if (used + block.length > maxChars) { truncated = true; break; }
    parts.push(block);
    used += block.length;
  }
  const header = `📖 对话「${conversationId}」完整原文（${parts.length}/${msgs.length} 条消息）:`;
  const footer = truncated ? `\n\n…（已达 ${maxChars} 字上限截断，共 ${msgs.length} 条消息。需要更多请提高 maxChars。）` : '';
  return toolSuccess(`${header}\n\n${parts.join('\n\n')}${footer}`);
}, 'custom', 'auto', 'read');

// --- Task Boundary Tools（M7：反重力式任务边界流，Plan 模式 AI 自用，让用户在对话流看到「正在做什么」）---
//   工具 handler 直接 dispatch conversation slice 的 reducer（边界挂对话顶层，不挂消息，无需 tracker 中转）。
//   approvalLevel='auto'（无需审批）；不归 permissionCategory（不参与子代理过滤）。
toolRegistry.register({
  type: 'function',
  function: {
    name: 'begin_task_boundary',
    description: '开始一个新任务边界——在对话流里显示一张任务卡（大标题+概述+进度）。开始一个有多个步骤的任务时调用。会自动收口上一个未结束的任务边界。',
    parameters: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: '任务大标题（如「查看现有 rules 文件」）' },
        summary: { type: 'string', description: '一句话概述（可选）' },
      },
      required: ['headline'],
    },
  },
}, async (args, ctx) => {
  const headline = typeof args.headline === 'string' ? args.headline.trim() : '';
  if (!headline) return toolFailure('error', 'invalid_result', 'begin_task_boundary 需要 headline。');
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  let conversationId: string;
  try {
    conversationId = requireToolExecutionIdentity(ctx).conversationId;
  } catch (error) {
    return toolFailure('error', 'invalid_result', error instanceof Error ? error.message : String(error));
  }
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  const state = store.getState() as any;
  // ★ 锚定当前轮的 assistant 消息——卡片据此【内联渲染在该消息后】（反重力式穿插），而非堆在消息流末尾。
  const msgs = conv.selectConversationById(state, conversationId).messages ?? [];
  let anchorMessageId: string | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'assistant') { anchorMessageId = msgs[i].id; break; }
  }
  const boundaryId = generateChangeId('tb');
  store.dispatch(conv.beginTaskBoundary({ id: boundaryId, headline, summary, anchorMessageId, at: Date.now(), conversationId }));
  const created = conv.selectConversationById(store.getState(), conversationId).taskBoundaries?.find(boundary => boundary.id === boundaryId);
  if (!created || created.status !== 'active') {
    return toolFailure('error', 'invalid_result', `任务边界未写入目标对话 ${conversationId}`);
  }
  return toolSuccess(`✅ 已开始任务边界：${headline}`);
}, 'custom', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'set_task_headline',
    description: '更新当前任务边界的大标题与概述。每进入一个新的子阶段/小标题就调一次——系统会自动把变更记入该任务的「标题变迁历史」。',
    parameters: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: '新的当前大标题' },
        summary: { type: 'string', description: '新的概述（可选）' },
      },
      required: ['headline'],
    },
  },
}, async (args, ctx) => {
  const headline = typeof args.headline === 'string' ? args.headline.trim() : '';
  if (!headline) return toolFailure('error', 'invalid_result', 'set_task_headline 需要 headline。');
  // ★ 缺省传 undefined（不是 ''）：让 reducer「summary 未提供=保留旧概括」兜底生效（只换标题不误清空概括/污染 history）。
  const summary = typeof args.summary === 'string' ? args.summary.trim() : undefined;
  let conversationId: string;
  try {
    conversationId = requireToolExecutionIdentity(ctx).conversationId;
  } catch (error) {
    return toolFailure('error', 'invalid_result', error instanceof Error ? error.message : String(error));
  }
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  const activeId = conv.selectConversationById(store.getState(), conversationId).taskBoundaries?.find(boundary => boundary.status === 'active')?.id;
  if (!activeId) return toolFailure('error', 'not_found', `目标对话 ${conversationId} 没有进行中的任务边界`);
  store.dispatch(conv.setTaskHeadline({ headline, summary, at: Date.now(), conversationId }));
  const updated = conv.selectConversationById(store.getState(), conversationId).taskBoundaries?.find(boundary => boundary.id === activeId);
  if (!updated || updated.headline !== headline || (summary !== undefined && updated.summary !== summary)) {
    return toolFailure('error', 'invalid_result', `任务标题未写入目标对话 ${conversationId}`);
  }
  return toolSuccess(`✅ 已更新任务标题：${headline}`);
}, 'custom', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'update_task_progress',
    description: '给当前任务边界追加一条进度。每完成一个关键动作就调一次。',
    parameters: {
      type: 'object',
      properties: {
        step: { type: 'string', description: '本步进度描述（如「读取了 3 个配置文件」）' },
      },
      required: ['step'],
    },
  },
}, async (args, ctx) => {
  const text = typeof args.step === 'string' ? args.step.trim() : '';
  if (!text) return toolFailure('error', 'invalid_result', 'update_task_progress 需要 step。');
  let conversationId: string;
  try {
    conversationId = requireToolExecutionIdentity(ctx).conversationId;
  } catch (error) {
    return toolFailure('error', 'invalid_result', error instanceof Error ? error.message : String(error));
  }
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  const activeId = conv.selectConversationById(store.getState(), conversationId).taskBoundaries?.find(boundary => boundary.status === 'active')?.id;
  if (!activeId) return toolFailure('error', 'not_found', `目标对话 ${conversationId} 没有进行中的任务边界`);
  const stepId = generateChangeId('tbs');
  store.dispatch(conv.appendTaskStep({ id: stepId, text, at: Date.now(), conversationId }));
  const updated = conv.selectConversationById(store.getState(), conversationId).taskBoundaries?.find(boundary => boundary.id === activeId);
  if (!updated?.steps.some(step => step.id === stepId)) {
    return toolFailure('error', 'invalid_result', `任务进度未写入目标对话 ${conversationId}`);
  }
  return toolSuccess(`✅ 已追加进度：${text}`);
}, 'custom', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'end_task_boundary',
    description: '收口当前任务边界（整个任务完成时调用，标记为已完成）。',
    parameters: {
      type: 'object',
      properties: {
        aborted: { type: 'boolean', description: '是否异常中止（可选，true=标记为中止/红色）' },
      },
      required: [],
    },
  },
}, async (args, ctx) => {
  let conversationId: string;
  try {
    conversationId = requireToolExecutionIdentity(ctx).conversationId;
  } catch (error) {
    return toolFailure('error', 'invalid_result', error instanceof Error ? error.message : String(error));
  }
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  const activeId = conv.selectConversationById(store.getState(), conversationId).taskBoundaries?.find(boundary => boundary.status === 'active')?.id;
  if (!activeId) return toolSuccess('当前没有进行中的任务边界，无需重复收口。');
  const expectedStatus = args.aborted === true ? 'aborted' : 'done';
  store.dispatch(conv.endTaskBoundary({ id: activeId, aborted: args.aborted === true, at: Date.now(), conversationId }));
  const ended = conv.selectConversationById(store.getState(), conversationId).taskBoundaries?.find(boundary => boundary.id === activeId);
  if (!ended || ended.status !== expectedStatus) {
    return toolFailure('error', 'invalid_result', `任务边界未在目标对话 ${conversationId} 收口`);
  }
  return toolSuccess('✅ 已收口当前任务边界。');
}, 'custom', 'auto');
