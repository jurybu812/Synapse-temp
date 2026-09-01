/**
 * MCP Bridge — 桥接层（M4-7-S3）
 *
 * 职责：把 MCP stdio server（electron 主进程经 platform.mcp → ipc/mcp.ts → MCPServerProcess 拉起的
 * 真实子进程）发现的工具，桥接进 toolRegistry，使主 AI 与子代理能真实调用三个本地 MCP server 的工具。
 *
 * ★ 架构（方案 B，register 进 toolRegistry）：
 *   - mcpBridge 管「发现 → 注册/注销」生命周期（refresh / startServer / stopServer）。
 *   - toolRegistry 管「执行 / 审批 / 重试 / getSchemasForPermissions 权限闸门」——MCP 工具注册时带了
 *     permissionCategory（read/write/command），故 AgentPanel 的 registerTools(getSchemas) 自动含 MCP 工具，
 *     agentOrchestrator 子代理经 getSchemasForPermissions(['read',...]) 自动纳入读类 MCP 工具，二者几乎零改动。
 *
 * ★ transport：走 stdio（spawn node <server>/dist/index.js），【不走】HTTP Broker(127.0.0.1:14588)——
 *   那是别的体系。所有 MCP 调用经 platform.mcp.*（Web 模式天然空集，无需额外降级判断）。
 *
 * ★ 命名空间：MCP 工具名统一加前缀 mcp__<server>__<tool>，与四源体系命名习惯一致，且天然区分
 *   内置 memory_query 与外置 mcp__memory-store__memory_query。
 *
 * ★ 审批分类（决策：读为主但不全放行）：默认 read；sandbox 执行类 → command/dangerous、
 *   web-fetcher 写类 → write，强制审批（不全放行）。分类只决定审批，不阻止注册。
 */

import { platform } from '@/platform';
import { executionRegistry } from './executionRegistry';
import { requireToolExecutionIdentity, taskSnapshotToToolResult, toolRegistry, type ToolExecContext, type ToolSchema, type ToolPermissionCategory } from './toolRegistry';
import { toolFailure, type ToolResult } from './toolResult';
import type { McpApprovalLevel } from './mcpResult';
import { managedTaskId } from './toolTaskId';

const MCP_PREFIX = 'mcp__';

type ApprovalLevel = McpApprovalLevel;

/** getStatus 返回的单条 server 状态（与 ipc/mcp.ts:status 结构对齐，字段宽松取用）。 */
interface McpServerStatus {
  name: string;
  status?: string;
  running?: boolean;
  configured?: boolean;
  enabled?: boolean;
  tools?: string[];
  toolDefinitions?: McpToolDef[];
}

/** MCP listTools 返回的单个工具描述。 */
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * 审批分类表（按 server + 工具名关键词识别「写/执行类」给更高审批等级，未命中默认 read）。
 *
 * 对应主人决策：sandbox 执行类（exec/session/launch/codex/batch）→ command/dangerous；
 * web-fetcher 写类（download/interact/login/desktop/record/convert/human_browser）→ write。
 * 读类（memory-store 全部读、web 抓取/截图/提取、sandbox 状态查询等）→ read。
 *
 * 返回 { approvalLevel, permissionCategory }——permissionCategory 决定子代理权限闸门归属，
 * approvalLevel 决定 needsApproval。read 工具在默认 autoApproveRead=true 下直放；write/command 需确认。
 */
function classifyMcpTool(server: string, tool: string): { approvalLevel: ApprovalLevel; permissionCategory: ToolPermissionCategory } {
  const t = tool.toLowerCase();

  if (server === 'sandbox') {
    // 执行类 / 代码执行 / 长任务托管 → 强制 command 审批（不全放行）。
    if (/(exec|session|launch|codex|council|batch|run)/.test(t)) {
      return { approvalLevel: 'dangerous', permissionCategory: 'command' };
    }
    // smart_search / status 等只读 → read。
    return { approvalLevel: 'read', permissionCategory: 'read' };
  }

  if (server === 'web-fetcher') {
    // 写类 / 有副作用类（下载到磁盘、交互点击输入、登录态、桌面控制、录屏、格式转换、人控浏览器、会话清理）→ write 审批。
    if (/(download|interact|login|desktop|record|convert|human_browser|close_sessions|pipeline)/.test(t)) {
      return { approvalLevel: 'write', permissionCategory: 'write' };
    }
    // fetch_page / screenshot / extract_* / rich / html / inspect / list_* 等只读抓取 → read。
    return { approvalLevel: 'read', permissionCategory: 'read' };
  }

  if (server === 'memory-store') {
    // 写类用【白名单写动作】精确匹配（写入 / 更新 / 删除 / 批量 / record 生成）→ write 审批（读为主、避免污染外置库）。
    // ★ M4-7 审查修复：原宽泛正则含 `extract` 关键词，会把读类 conversation_golden_extract（提取金句、不写库）
    //   误判为 write，每次调用多弹一次审批。改为白名单后纯读取/提取类（含 golden_extract）归 read 直放。
    if (/(memory_write|memory_update|memory_delete|memory_batch|record_manage)/.test(t)) {
      return { approvalLevel: 'write', permissionCategory: 'write' };
    }
    // query / read / stats / conversation_read_original / conversation_golden_extract 等 → read。
    return { approvalLevel: 'read', permissionCategory: 'read' };
  }

  if (server === 'exa') {
    // ★ #16：Exa 是【纯只读语义搜索/抓取】MCP——web_search_exa（联网搜索）、web_fetch_exa（取页内容）
    //   及其余 *_exa 工具均无副作用、不写本地。全部归 read（approvalLevel:'read'、autoApproveRead 下直放，
    //   子代理经 read 权限闸门自动纳入）。无写/执行类工具，故无需写/危险分支。
    return { approvalLevel: 'read', permissionCategory: 'read' };
  }

  // 未知 server：保守按通用关键词识别，命中写/执行给更高等级，否则默认 read。
  if (/(exec|run|launch|command|shell|kill)/.test(t)) {
    return { approvalLevel: 'dangerous', permissionCategory: 'command' };
  }
  if (/(write|create|update|delete|download|upload|interact|login)/.test(t)) {
    return { approvalLevel: 'write', permissionCategory: 'write' };
  }
  return { approvalLevel: 'read', permissionCategory: 'read' };
}

/** 组装命名空间工具名：mcp__<server>__<tool>。 */
function makeToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

/** 从命名空间工具名解析回 (server, tool)。非 MCP 名返回 null。 */
function parseToolName(fullName: string): { server: string; tool: string } | null {
  if (!fullName.startsWith(MCP_PREFIX)) return null;
  const rest = fullName.slice(MCP_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * 调用 MCP 工具前清理参数：剥掉值严格等于空字符串 '' 的顶层键，浅拷贝返回（不 mutate 原 args）。
 *
 * 缓解 server 端「空串被当已提供」的互斥误判：部分 server 对互斥参数（如 sandbox_exec 的 code/command）
 * 做「已提供则冲突」校验，而模型生成 tool_call 常把另一边填成空串，被误判为冲突。剥空串后 server 看见
 * 的就是「未提供」。与 server 侧修复正交：若 server 也改成「空串=未提供」，两边叠加不冲突。
 *
 * ⚠️ 只剥严格 === '' 的值。undefined / null 本就无影响不必处理；0 / false / 空数组 [] / 空对象 {}
 * 都是有效值，绝不能剥。args 非对象（null/undefined）时返回空对象。
 */
function stripEmptyStringArgs(args: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === '') continue;
    cleaned[k] = v;
  }
  return cleaned;
}

class MCPBridge {
  /** 当前已注册进 toolRegistry 的 MCP 工具全名集合（用于 refresh 时增量注销已消失的工具）。 */
  private registered = new Set<string>();

  /** 是否已订阅主进程的 server 就绪广播（只订一次，避免重复监听）。 */
  private subscribed = false;
  /** pending 退避重查的剩余次数 + 定时器（防并发重复排程）。 */
  private pendingRetriesLeft = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * ★ MCP 竞态修复（事件驱动主路）：首次 refresh 时订阅主进程广播的「server 就绪」事件。
   *   server initialize 握手成功置 running 后，主进程 webContents.send('mcp:status-changed')，
   *   这里收到即自动 refresh() → listTools + registerOne 补注册 mcp__* 工具。
   *   Web 模式 / 旧 preload 无 onStatusChanged → 存在性检查降级跳过，仅靠退避重查兜底。
   */
  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    const sub = (platform.mcp as { onStatusChanged?: (cb: (p: { name: string; status: string }) => void) => () => void }).onStatusChanged;
    if (typeof sub !== 'function') return; // Web 模式 / 不支持：降级，靠退避重查兜底。
    try {
      // 模块级单例，生命周期与渲染进程同寿，订阅常驻无需保留取消句柄。
      sub((payload) => {
        console.log(`[mcpBridge] mcp:status-changed received (${payload?.name} → ${payload?.status}), refreshing…`);
        void this.refresh();
      });
    } catch (err) {
      console.error('[mcpBridge] subscribe onStatusChanged failed:', (err as Error)?.message);
    }
  }

  /**
   * ★ MCP 竞态修复（退避重查兜底，不依赖事件的第二保险）：
   *   首次 refresh 后若仍有 server 处于 starting（握手未完成、还没 running），
   *   排程 2-3 次退避重查（递增延迟），不依赖广播事件，与事件驱动构成双保险。
   *   running 数已覆盖全部 enabled server（无 pending）时不排程；事件先到也会自然把工具补齐。
   */
  private schedulePendingRetry(): void {
    if (this.pendingTimer) return; // 已有排程，避免叠加。
    if (this.pendingRetriesLeft <= 0) this.pendingRetriesLeft = 3; // 初始化重试预算。
    const attempt = 4 - this.pendingRetriesLeft; // 1,2,3
    const delay = 800 * attempt; // 800ms / 1600ms / 2400ms 退避。
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.pendingRetriesLeft -= 1;
      console.log(`[mcpBridge] pending server 退避重查（剩余 ${this.pendingRetriesLeft} 次）…`);
      void this.refresh();
    }, delay);
  }

  /**
   * 刷新：拉 getStatus → 对每个 running server listTools → 注册/更新工具进 toolRegistry，
   * 并注销「本轮不再出现」的旧 MCP 工具（server 停用 / 重启 / 工具列表变化）。
   *
   * Web 模式 getStatus 返回 { servers: [] } → 注销所有旧 MCP 工具、注册集为空（天然降级，不崩）。
   * 失败（IPC 异常等）catch 后保持现有注册集不变，不影响内置工具。
   *
   * ★ MCP 竞态修复：首次调用时订阅 server 就绪广播（事件驱动主路）；本轮若有 starting 的
   *   pending server，排程退避重查（兜底第二保险）。两路都最终触发 register，互不冲突。
   */
  async refresh(): Promise<void> {
    this.ensureSubscribed();

    let servers: McpServerStatus[] = [];
    try {
      const status = await platform.mcp.getStatus();
      servers = Array.isArray(status?.servers) ? status.servers : [];
    } catch (err) {
      console.error('[mcpBridge] getStatus failed:', (err as Error)?.message);
      return; // 拉状态失败：保持现有注册集，不动 toolRegistry。
    }

    const nextNames = new Set<string>();
    let hasPending = false; // 本轮是否有 enabled 但仍在 starting（握手未完成）的 server。

    for (const server of servers) {
      if (!server?.name) continue;
      if (!server.running) {
        // ★ 竞态根因点：旧实现这里直接 continue 丢弃所有非 running server。
        //   现对「正在启动（starting）」的 server 记 pending 标志，触发退避重查（而非永久丢弃）。
        //   只有 starting 算 pending——stopped/disabled/error 不会自行变 running，重查无意义。
        if (server.status === 'starting') hasPending = true;
        continue;
      }
      let tools: McpToolDef[] = [];
      try {
        tools = Array.isArray(server.toolDefinitions)
          ? server.toolDefinitions
          : (await platform.mcp.listTools(server.name)) as McpToolDef[];
      } catch (err) {
        // listTools 失败（主进程已 catch 成空集，这里再兜一层）→ 跳过该 server，不崩。
        console.error(`[mcpBridge] listTools(${server.name}) failed:`, (err as Error)?.message);
        continue;
      }
      if (!Array.isArray(tools)) continue;

      for (const tool of tools) {
        if (!tool?.name) continue;
        const fullName = makeToolName(server.name, tool.name);
        nextNames.add(fullName);
        this.registerOne(server.name, tool, fullName);
      }
    }

    // 注销本轮不再出现的旧 MCP 工具（server 停了 / 工具消失），避免悬空。
    for (const old of this.registered) {
      if (!nextNames.has(old)) {
        toolRegistry.unregister(old);
      }
    }
    this.registered = nextNames;

    // 本轮仍有 starting 的 server → 退避重查兜底（事件驱动是主路，这是不依赖事件的第二保险）。
    if (hasPending && this.pendingRetriesLeft !== 0) {
      this.schedulePendingRetry();
    } else if (!hasPending) {
      // 全部就绪（或无 pending）→ 清空重试预算与待定定时器，停止兜底重查。
      this.pendingRetriesLeft = 0;
      if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    }
  }

  /** 把单个 MCP 工具注册（或覆盖更新）进 toolRegistry。 */
  private registerOne(server: string, tool: McpToolDef, fullName: string): void {
    const { approvalLevel, permissionCategory } = classifyMcpTool(server, tool.name);

    // MCP inputSchema 是完整 JSON Schema；ToolSchema.parameters 类型较窄，as any 透传给 OpenAI 兼容端
    // （流式请求体直接带 schema，网关接受完整 JSON Schema）。缺省给最小 object schema。
    const parameters = (tool.inputSchema && typeof tool.inputSchema === 'object')
      ? (tool.inputSchema as ToolSchema['function']['parameters'])
      : ({ type: 'object', properties: {} } as ToolSchema['function']['parameters']);

    const schema: ToolSchema = {
      type: 'function',
      function: {
        name: fullName,
        description: tool.description || `MCP 工具（来自 ${server}）：${tool.name}`,
        parameters,
      },
    };

    const handler = async (args: Record<string, unknown>, ctx?: ToolExecContext): Promise<ToolResult> => {
      const parsed = parseToolName(fullName);
      if (!parsed) return toolFailure('error', 'invalid_result', `非法 MCP 工具名 ${fullName}`);
      try {
        // 缓解：剥掉值严格等于空字符串 '' 的顶层参数键。
        // 背景：部分 MCP server 对互斥参数（如 sandbox_exec 的 code / command）做「已提供则冲突」
        // 校验，而模型生成 tool_call 时常把另一边填成空串 ''，被 server 误判为「已提供」从而报互斥错。
        // 这里在调用前剥空串，让 server 看见的就是「未提供」。
        // 注意只剥严格 '' —— undefined/null 本就无影响；0 / false / [] / {} 都是有效值，绝不可剥。
        // 与 server 侧修复正交：若 server 也改成「空串=未提供」，两边叠加不冲突。
        const cleanedArgs = stripEmptyStringArgs(args);
        const identity = requireToolExecutionIdentity(ctx);
        const access = { conversationId: identity.conversationId, ownerId: identity.ownerId };
        const taskId = await managedTaskId('mcp', identity);
        const pendingApprovalKey = `pending-approval:${taskId}`;
        executionRegistry.registerCancelable(identity.ownerId, pendingApprovalKey, async () => {
          await platform.toolTask.cancelPendingApproval?.(taskId);
        }, identity.runId);
        let started;
        try {
          started = await platform.toolTask.start({
            kind: 'mcp',
            taskId,
            identity,
            input: {
              server: parsed.server,
              tool: parsed.tool,
              args: cleanedArgs,
              approvalLevel,
            },
          });
        } finally {
          executionRegistry.releaseCancelable(identity.ownerId, pendingApprovalKey);
        }
        await ctx?.onTaskStarted?.(started);
        if (started.status === 'running' || started.status === 'cancelling') {
          executionRegistry.registerCancelable(identity.ownerId, started.taskId, async () => {
            await platform.toolTask.cancel(started.taskId, access);
          }, identity.runId);
        }
        const result = await platform.toolTask.wait(started.taskId, 10, access);
        if (result.status !== 'running' && result.status !== 'cancelling') {
          executionRegistry.releaseCancelable(identity.ownerId, result.taskId);
        }
        if (result.status === 'running' || result.status === 'cancelling') {
          const text = [
            `⏳ MCP 工具仍在运行（taskId=${result.taskId}）`,
            '可调用 tool_status 等待 10—120 秒，或调用 tool_cancel 停止本地等待。',
            '如果远端已经开始写入，停止本地等待不代表远端副作用一定停止。',
            result.text,
          ].filter(Boolean).join('\n\n');
          return taskSnapshotToToolResult(result, text);
        }
        return taskSnapshotToToolResult(result);
      } catch (err) {
        const errorMessage = String((err as Error)?.message ?? err);
        if (/用户取消|审批.*取消|approval.*cancel/i.test(errorMessage)) {
          return toolFailure('cancelled', 'approval_denied', `MCP 工具未启动 (${parsed.server}/${parsed.tool}): ${errorMessage}`, {
            retryable: false,
            unknownSideEffect: false,
            structured: { executionTimeMs: 0 },
          });
        }
        return toolFailure(
          approvalLevel === 'read' ? 'error' : 'unknown',
          'transport',
          `MCP 调用失败 (${parsed.server}/${parsed.tool}): ${errorMessage}`,
          {
            retryable: approvalLevel === 'read',
            unknownSideEffect: approvalLevel !== 'read',
          },
        );
      }
    };

    // category 用 'custom'（MCP 工具不属内置 file/search/command/web/document 分类）；
    // permissionCategory 决定子代理闸门与审批 read/write/command 分桶。
    toolRegistry.register(schema, handler, 'custom', approvalLevel, permissionCategory);
  }

  /** 启动一个 MCP server 后刷新注册集（供 UI / 设置变化调用）。 */
  async startServer(name: string): Promise<void> {
    await platform.mcp.start(name);
    await this.refresh();
  }

  /** 停止一个 MCP server 后刷新注册集（清理该 server 的工具）。 */
  async stopServer(name: string): Promise<void> {
    await platform.mcp.stop(name);
    await this.refresh();
  }

  /** 当前已桥接进 toolRegistry 的 MCP 工具全名（调试 / 诊断用）。 */
  listRegistered(): string[] {
    return Array.from(this.registered);
  }
}

export const mcpBridge = new MCPBridge();
