/**
 * IPC MCP Handler
 * MCP 服务器管理：启动/停止/重启/工具调用
 */

import { app, ipcMain, BrowserWindow, type WebContents } from 'electron';
import { MCPServerProcess } from '../mcp/MCPServerProcess';
import * as path from 'path';
import * as fs from 'fs';
import { confirmSensitiveOperationInMainWindow } from './file';

const servers = new Map<string, MCPServerProcess>();
let externalMcpDisabled = false;

function assertExternalMCPEnabled(): void {
    if (externalMcpDisabled) throw new MCPServerUnavailableError('External MCP is disabled for this runtime');
}

/**
 * ★ MCP 竞态修复：统一在「新建 MCPServerProcess」处挂上 status-change 监听，
 *   server initialize 握手成功（置 running）时广播 'mcp:status-changed' 给所有渲染窗口。
 *   渲染端 mcpBridge 收到后自动 refresh() → listTools + registerOne 补注册 mcp__* 工具。
 *
 *   为何广播给所有窗口：与 main.ts 的多窗口模型一致（getAllWindows），不假设只有 mainWindow；
 *   webContents 已销毁的窗口跳过，避免向已关闭窗口 send 抛错。
 */
function bindStatusBroadcast(proc: MCPServerProcess): void {
    proc.on('status-change', (payload: { name: string; status: string }) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
            win.webContents.send('mcp:status-changed', payload);
        }
    });
}

interface MCPConfigEntry {
    // stdio transport：spawn 子进程用。HTTP transport 时 command 可缺省。
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    // ★ #16 HTTP transport：transport:'http' + url 指向远端 endpoint（如四源共享 Broker /exa/mcp）。
    //   也兼容「只给 url 不给 command」的隐式 http 判定（见 MCPServerProcess 构造函数）。
    transport?: 'stdio' | 'http';
    url?: string;
}

/**
 * ★ #16：从 config 条目构造 MCPServerProcess，统一处理 stdio / http 两种 transport。
 *   集中一处避免三个调用点（auto-start / start / restart）各自漏传 opts。
 */
function createServerProcess(name: string, entry: MCPConfigEntry): MCPServerProcess {
    return new MCPServerProcess(
        name,
        entry.command ?? '',
        entry.args,
        entry.env,
        { transport: entry.transport, url: entry.url },
    );
}

function loadMCPConfig(): Record<string, MCPConfigEntry> {
    const configPaths = [
        path.join(app.getPath('home'), '.synapse', 'mcp_config.json'),
        path.join(process.cwd(), '.synapse', 'mcp_config.json'),
    ];
    const merged: Record<string, MCPConfigEntry> = {};
    for (const p of configPaths) {
        try {
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf-8');
                const config = JSON.parse(raw);
                Object.assign(merged, config.servers || config);
            }
        } catch { /* skip */ }
    }
    return merged;
}

/**
 * 首次运行生成默认 ~/.synapse/mcp_config.json。
 *   - 文件【已存在则绝不覆盖】（保护用户编辑过的路径 / enabled / 自定义 server）。
 *   - 默认只写空 servers；外部 MCP 是用户显式配置的扩展，不能依赖开发机绝对路径或本机 Broker。
 *   - Synapse 内置 Memory、文件、命令与网页读取不从这里注册。
 *   - 写 {servers:{}} 包裹形态（loadMCPConfig 同时支持包裹与裸对象，包裹最规范）。
 *   在 main.ts 启动序列（registerMCPHandlers 之前）调用。
 */
export function ensureDefaultMCPConfig(): void {
    try {
        const dir = path.join(app.getPath('home'), '.synapse');
        const configPath = path.join(dir, 'mcp_config.json');
        if (fs.existsSync(configPath)) return; // 存在绝不覆盖。
        const defaultConfig = { servers: {} };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
        console.log(`[MCP] default mcp_config.json generated at ${configPath}`);
    } catch (err) {
        console.error('[MCP] ensureDefaultMCPConfig failed:', (err as Error)?.message);
    }
}

/**
 * ★ FIX-5：应用启动序列里自动拉起所有 enabled!==false 的 MCP server。
 *   旧实现：whenReady 只做 ensureDefaultMCPConfig + registerMCPHandlers，
 *   enabled=true 仅被 SettingsPanel 用来出文案，从未被启动序列消费 →
 *   默认 memory-store 显示「已配置，未启动」，需手动逐个点启动。
 *
 *   本函数遍历 config，对 enabled!==false 的 server 逐个 new MCPServerProcess + start，
 *   单个失败 catch 吞掉不阻塞其余（fire-and-forget，不阻塞创窗）。已在运行的不重复启动。
 *   启动后前端 mcpBridge.refresh（AgentPanel 构建 AgentLoop 时已调）会自然发现并桥接工具，
 *   SettingsPanel mcp:status 也会显示「运行中」。
 */
export async function startEnabledMCPServers(): Promise<void> {
    const config = loadMCPConfig();
    const tasks: Promise<void>[] = [];
    for (const [name, entry] of Object.entries(config)) {
        if (entry.enabled === false) continue; // 仅显式 disabled 跳过；未填默认启动。
        if (servers.has(name)) continue; // 已存在（被动 start 过）则不重复。
        const proc = createServerProcess(name, entry);
        bindStatusBroadcast(proc);
        servers.set(name, proc);
        tasks.push(
            proc.start()
                .then(() => { console.log(`[MCP] auto-started "${name}"`); })
                .catch(err => {
                    console.error(`[MCP] auto-start "${name}" failed:`, (err as Error)?.message);
                    // 启动失败的从 map 移除，避免后续 status 误报为存在但实际未运行。
                    servers.delete(name);
                }),
        );
    }
    await Promise.allSettled(tasks);
}

export class MCPServerUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MCPServerUnavailableError';
    }
}

function normalizeMCPIdentifier(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} 不能为空`);
    }
    return value.trim();
}

async function confirmMCPToolCall(sender: WebContents, serverName: string, toolName: string): Promise<void> {
    const approved = await confirmSensitiveOperationInMainWindow(sender, {
        title: '确认调用外部 MCP 工具',
        message: '外部 MCP 工具由独立进程或远端服务执行，确认后只会发起下列这一次工具调用。',
        details: [
            '操作：调用 MCP 工具',
            `服务器：${serverName}`,
            `工具：${toolName}`,
        ],
        confirmLabel: '允许本次调用',
    });
    if (!approved) throw new Error('用户取消了外部 MCP 工具');
}

async function confirmMCPLifecycleChange(sender: WebContents, action: 'start' | 'stop' | 'restart', serverName: string): Promise<void> {
    const actionLabel = action === 'start'
        ? '启动 MCP 服务器'
        : action === 'stop'
            ? '停止 MCP 服务器'
            : '重启 MCP 服务器';
    const approved = await confirmSensitiveOperationInMainWindow(sender, {
        title: `确认${actionLabel}`,
        message: 'MCP 服务器可能对应本地子进程或远端服务连接，确认后只会执行下列这一项生命周期操作。',
        details: [
            `操作：${actionLabel}`,
            `服务器：${serverName}`,
        ],
        confirmLabel: actionLabel,
    });
    if (!approved) throw new Error(`用户取消了${actionLabel}`);
}

export async function callMCPTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    assertExternalMCPEnabled();
    const proc = servers.get(serverName);
    if (!proc || proc.status !== 'running') {
        throw new MCPServerUnavailableError(`MCP server "${serverName}" not running`);
    }
    return proc.callTool(toolName, args);
}

export function registerMCPHandlers(options: { disabled?: boolean } = {}): void {
    externalMcpDisabled = options.disabled === true;
    // 获取 MCP 状态
    // ★ M4-7-S2：handler 改 async——对 running server 调 listTools() 填【真实 tools 名列表】
    //   （旧实现恒返回 []）。listTools 内部已 catch 成空集，单 server 失败不影响整条状态。
    ipcMain.handle('mcp:status', async () => {
        if (externalMcpDisabled) return { servers: [], disabled: true };
        const config = loadMCPConfig();
        const result: Array<{ name: string; status: string; running: boolean; configured: boolean; enabled: boolean; tools: string[]; toolDefinitions: unknown[] }> = [];
        for (const [name, entry] of Object.entries(config)) {
            const proc = servers.get(name);
            const running = proc?.status === 'running';
            const listedTools = running ? await proc!.listTools() : [];
            const toolDefinitions = [...new Map(listedTools.map(tool => [tool.name, tool])).values()];
            const tools = toolDefinitions.map(t => t.name);
            result.push({
                name,
                status: proc?.status ?? (entry.enabled === false ? 'disabled' : 'stopped'),
                running,
                configured: true,
                enabled: entry.enabled !== false,
                tools,
                toolDefinitions,
            });
        }
        for (const [name, proc] of servers) {
            if (config[name]) continue;
            const running = proc.status === 'running';
            const listedTools = running ? await proc.listTools() : [];
            const toolDefinitions = [...new Map(listedTools.map(tool => [tool.name, tool])).values()];
            const tools = toolDefinitions.map(t => t.name);
            result.push({ name, status: proc.status, running, configured: false, enabled: true, tools, toolDefinitions });
        }
        return { servers: result };
    });

    // 启动 MCP 服务器
    ipcMain.handle('mcp:start', async (event, rawName: unknown) => {
        assertExternalMCPEnabled();
        const name = normalizeMCPIdentifier(rawName, 'MCP server');
        const config = loadMCPConfig();
        const entry = config[name];
        if (!entry) throw new Error(`MCP server "${name}" not found in config`);

        await confirmMCPLifecycleChange(event.sender, 'start', name);
        const proc = createServerProcess(name, entry);
        bindStatusBroadcast(proc);
        servers.set(name, proc);
        await proc.start();
        return { status: 'running' };
    });

    // 停止 MCP
    ipcMain.handle('mcp:stop', async (event, rawName: unknown) => {
        if (externalMcpDisabled) return { status: 'disabled' };
        const name = normalizeMCPIdentifier(rawName, 'MCP server');
        const proc = servers.get(name);
        if (proc) {
            await confirmMCPLifecycleChange(event.sender, 'stop', name);
            await proc.stop();
            servers.delete(name);
        }
        return { status: 'stopped' };
    });

    // 重启 MCP
    ipcMain.handle('mcp:restart', async (event, rawName: unknown) => {
        assertExternalMCPEnabled();
        const name = normalizeMCPIdentifier(rawName, 'MCP server');
        const config = loadMCPConfig();
        const entry = config[name];
        if (!entry) throw new Error(`MCP server "${name}" not found`);

        await confirmMCPLifecycleChange(event.sender, 'restart', name);
        const proc = servers.get(name);
        if (proc) {
            await proc.stop();
            servers.delete(name);
        }
        const newProc = createServerProcess(name, entry);
        bindStatusBroadcast(newProc);
        servers.set(name, newProc);
        await newProc.start();
        return { status: 'running' };
    });

    // 列出工具
    ipcMain.handle('mcp:listTools', async (_e, rawName: unknown) => {
        assertExternalMCPEnabled();
        const name = normalizeMCPIdentifier(rawName, 'MCP server');
        const proc = servers.get(name);
        if (!proc || proc.status !== 'running') return [];
        return proc.listTools();
    });

    // 调用工具
    ipcMain.handle('mcp:callTool', async (event, rawServerName: unknown, rawToolName: unknown, args: unknown) => {
        assertExternalMCPEnabled();
        const serverName = normalizeMCPIdentifier(rawServerName, 'MCP server');
        const toolName = normalizeMCPIdentifier(rawToolName, 'MCP tool');
        await confirmMCPToolCall(event.sender, serverName, toolName);
        return callMCPTool(serverName, toolName, args as Record<string, unknown>);
    });
}

// 应用退出时关闭所有 MCP
export async function shutdownAllMCP(): Promise<void> {
    for (const [, proc] of servers) {
        try { await proc.stop(); } catch { /* ignore */ }
    }
    servers.clear();
}
