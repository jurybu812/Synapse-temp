/**
 * MCP Server Process — JSON-RPC 2.0 通信
 * 管理单个 MCP 服务器的生命周期。支持两种 transport：
 *   ① stdio（默认）：spawn node 子进程，走 stdin/stdout 行分隔 JSON-RPC。三个本地 server 用这条。
 *   ② Streamable HTTP（★ #16 新增）：不 spawn 子进程，对远端 endpoint 发 HTTP POST（body 是
 *      JSON-RPC，响应为 SSE event-stream），用于复用四源共享 HTTP Broker（如 Exa @ /exa/mcp）。
 *      握手返回 `mcp-session-id` 响应头，后续请求/通知都回带该 session id。
 *
 * 两条 transport 共用同一套对外接口（start/stop/request/notify/listTools/callTool/close），
 * 上层（ipc/mcp.ts、桥接层）无需区分；差异全部封装在本类内部的 isHttp 分支里。
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * ★ #16：MCPServerProcess 构造可选项。
 *   - transport：'stdio'（默认）| 'http'。也可通过「有 url 且无 command」隐式判定为 http。
 *   - url：HTTP transport 的 endpoint（如 http://127.0.0.1:14588/exa/mcp）。
 */
export interface MCPProcessOptions {
    transport?: 'stdio' | 'http';
    url?: string;
}

interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JSONRPCResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class MCPServerProcess extends EventEmitter {
    private process: ChildProcess | null = null;
    private buffer = '';
    private requestId = 0;
    private pending = new Map<number, PendingRequest>();
    private _status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
    /**
     * ★ M4-7-S1：start() 期间监听 spawn error（ENOENT / 路径错）的快速失败回调。
     *   spawn 是异步的——'error' 事件在 start() 的 await initialize 之后才到达。把进行中 start 的
     *   reject 暂存在这里，process.on('error') 触发时立刻调用它，让 start() 秒级失败而非苦等 30s timeout。
     */
    private startErrorReject: ((err: Error) => void) | null = null;

    /**
     * ★ #16 HTTP transport 状态。
     *   - isHttp：true 时 start/request/notify/stop 走 HTTP 分支（不 spawn 子进程）。
     *   - httpUrl：endpoint。
     *   - sessionId：initialize 握手后 server 返回的 `mcp-session-id`，后续请求/通知回带。
     */
    private readonly isHttp: boolean;
    private readonly httpUrl: string;
    private sessionId: string | null = null;

    constructor(
        public readonly name: string,
        private command: string,
        private args: string[] = [],
        private env: Record<string, string> = {},
        opts?: MCPProcessOptions,
    ) {
        super();
        // HTTP 判定：显式 transport:'http'，或「给了 url 且没给 command」（隐式）。
        this.httpUrl = opts?.url ?? '';
        this.isHttp = opts?.transport === 'http' || (!!this.httpUrl && !command);
    }

    get status() { return this._status; }

    async start(): Promise<void> {
        // ★ #16 HTTP 分支：不 spawn 子进程，走 Streamable HTTP 握手。
        if (this.isHttp) {
            return this.startHttp();
        }

        if (this.process) return;
        this._status = 'starting';

        this.process = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.env },
            // ★ M4-7-S1：去黑框——Windows 下 spawn node 子进程默认会闪一个控制台窗口。
            windowsHide: true,
        });

        this.process.stdout?.on('data', (data: Buffer) => {
            this.buffer += data.toString();
            this.processBuffer();
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            console.error(`[MCP:${this.name}] stderr:`, data.toString().trim());
        });

        this.process.on('close', (code) => {
            console.log(`[MCP:${this.name}] exited with code ${code}`);
            this._status = 'stopped';
            this.process = null;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                req.reject(new Error('MCP process exited'));
                clearTimeout(req.timer);
                this.pending.delete(id);
            }
            this.emit('close', code);
        });

        this.process.on('error', (err) => {
            console.error(`[MCP:${this.name}] error:`, err.message);
            this._status = 'error';
            // ★ M4-7-S1 快速失败：spawn error（ENOENT / command 不存在 / 路径错）在 start() 的
            //   await initialize 期间到达时，立刻 reject 进行中的 start，而不是让它干等 30s request timeout。
            if (this.startErrorReject) {
                this.startErrorReject(err);
            }
            this.emit('error', err);
        });

        // Initialize：把 initialize 请求与「spawn error 事件」竞速（Promise.race）。
        //   - 正常 server：initialize 先 resolve → running。
        //   - spawn 失败：'error' 事件触发 startErrorReject 先 reject → 秒级失败，不等 timeout。
        try {
            const errorRace = new Promise<never>((_resolve, reject) => {
                this.startErrorReject = reject;
            });
            const initPromise = this.request('initialize', {
                protocolVersion: '2024-11-05',
                // ★ M4-7-S1：声明客户端支持 tools（更规范；个别 server 会据此决定是否暴露 tools/list）。
                capabilities: { tools: {} },
                clientInfo: { name: 'synapse', version: '0.1.0' },
            });
            await Promise.race([initPromise, errorRace]);
            await this.notify('notifications/initialized');
            this._status = 'running';
            console.log(`[MCP:${this.name}] initialized`);
            // ★ MCP 竞态修复：握手成功置 running 时主动广播事件。旧链路 mcpBridge.refresh() 只在
            //   AgentPanel 首次 aiClient 就绪时 pull 一次，那一刻 server 还在 starting → 被
            //   mcpBridge `!server.running` 跳过 → 零个 mcp__* 工具注册。emit 后由 ipc/mcp.ts
            //   监听并 webContents.send → 渲染端 mcpBridge 自动 refresh()，事件驱动补注册。
            //   带 server name，便于上层区分是哪个 server 就绪。
            this.emit('status-change', { name: this.name, status: 'running' });
            this.emit('ready', { name: this.name });
        } catch (err) {
            this._status = 'error';
            throw err;
        } finally {
            // 竞速结束后解除引用，避免后续 error 事件误调用旧 reject。
            this.startErrorReject = null;
        }
    }

    async stop(): Promise<void> {
        // ★ #16 HTTP 分支：尽力对 endpoint 发 DELETE 终止 session（失败忽略），再置 stopped。
        if (this.isHttp) {
            const sid = this.sessionId;
            this.sessionId = null;
            this._status = 'stopped';
            if (sid) {
                try {
                    await fetch(this.httpUrl, {
                        method: 'DELETE',
                        headers: { 'mcp-session-id': sid },
                        signal: AbortSignal.timeout(3000),
                    });
                } catch { /* server 可能不支持 DELETE，忽略 */ }
            }
            this.emit('close', 0);
            return;
        }

        if (!this.process) return;
        this.process.kill('SIGTERM');
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                this.process?.kill('SIGKILL');
                resolve();
            }, 5000);
            this.process?.on('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.process = null;
        this._status = 'stopped';
    }

    async request(method: string, params?: unknown, timeout = 30000): Promise<unknown> {
        // ★ #16 HTTP 分支：走 fetch POST + SSE 解析，不经 stdin/stdout。
        if (this.isHttp) {
            return this.httpRequest(method, params, timeout);
        }

        if (!this.process?.stdin) throw new Error('MCP not running');
        const id = ++this.requestId;
        const msg: JSONRPCRequest = { jsonrpc: '2.0', id, method, params };
        const payload = JSON.stringify(msg);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP timeout: ${method} (${timeout}ms)`));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.process!.stdin!.write(payload + '\n');
        });
    }

    async notify(method: string, params?: unknown): Promise<void> {
        // ★ #16 HTTP 分支：通知（无 id）也走 POST，server 回 202 无 body。
        if (this.isHttp) {
            await this.httpNotify(method, params);
            return;
        }

        if (!this.process?.stdin) return;
        const msg = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
    }

    async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
        // ★ M4-7-S1：server 不支持 tools/list（未声明 capability / 协议差异）时 request 会 reject。
        //   这里 catch 成空集——桥接层 / status 据此跳过该 server，而非让整条状态/桥接链路崩。
        try {
            const result = await this.request('tools/list') as { tools?: unknown[] };
            return (result?.tools || []) as Array<{ name: string; description: string; inputSchema: unknown }>;
        } catch (err) {
            console.error(`[MCP:${this.name}] listTools failed:`, (err as Error)?.message);
            return [];
        }
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        return this.request('tools/call', { name, arguments: args });
    }

    private processBuffer(): void {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line) as JSONRPCResponse;
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const req = this.pending.get(msg.id)!;
                    clearTimeout(req.timer);
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        req.reject(new Error(msg.error.message));
                    } else {
                        req.resolve(msg.result);
                    }
                }
                // Notification from server (no id)
                if (msg.id === undefined) {
                    this.emit('notification', msg);
                }
            } catch {
                // Non-JSON line, ignore
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ★ #16 Streamable HTTP transport 实现
    //   协议（已对 Broker /exa/mcp 真机验证）：
    //     · 对 endpoint 发 HTTP POST，body = JSON-RPC；Accept 头需含 text/event-stream。
    //     · initialize 响应头返回 mcp-session-id；后续请求/通知都回带该 session id。
    //     · 响应 Content-Type 为 text/event-stream（SSE，`data: {json}`），通知则回 202 空 body。
    //   与 stdio 分支共用 request/notify/listTools/callTool 对外接口，差异封装在此。
    // ─────────────────────────────────────────────────────────────────────

    /** initialize 握手（HTTP）：取并保存 session id，发 initialized 通知，置 running 并广播。 */
    private async startHttp(): Promise<void> {
        if (this._status === 'running' || this._status === 'starting') return;
        this._status = 'starting';
        this.sessionId = null;
        try {
            await this.handshakeHttp();
            this._status = 'running';
            console.log(`[MCP:${this.name}] initialized (http @ ${this.httpUrl}, session=${this.sessionId ?? 'none'})`);
            // 与 stdio 分支一致：握手成功广播，触发渲染端 mcpBridge.refresh() 补注册 mcp__* 工具。
            this.emit('status-change', { name: this.name, status: 'running' });
            this.emit('ready', { name: this.name });
        } catch (err) {
            this._status = 'error';
            console.error(`[MCP:${this.name}] http start failed:`, (err as Error)?.message);
            throw err;
        }
    }

    /** 纯握手序列（initialize + initialized 通知）——startHttp 与「session 失效后重握手」共用，不碰 _status/running guard。 */
    private async handshakeHttp(): Promise<void> {
        await this.httpRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'synapse', version: '0.1.0' },
        });
        await this.httpNotify('notifications/initialized');
    }

    /**
     * ★ session 失效自愈：Broker（默认 127.0.0.1:14588，exa 等连它）重启后，旧 mcp-session-id 必失效（404 / 含 "session"
     *   的 4xx）。原实现只 throw、不清 sessionId、不改 _status，且 startHttp 有 running guard 无法自愈 → exa 全部工具
     *   调用永久失败而 status 仍报 running。此处绕过 running guard 重新握手一次，拿到新 session id。
     *   只在 httpRequest 的失效分支调用、且只重试一轮（reHandshaking 防重入），重握手仍失败则上层置 error。
     */
    private reHandshaking = false;
    private async reinitHttp(): Promise<void> {
        if (this.reHandshaking) return;
        this.reHandshaking = true;
        this.sessionId = null;
        try {
            await this.handshakeHttp();
            console.log(`[MCP:${this.name}] http session re-initialized (session=${this.sessionId ?? 'none'})`);
        } finally {
            this.reHandshaking = false;
        }
    }

    /** 公共请求头：Accept（JSON + SSE）、Content-Type，已有 session id 时回带。 */
    private httpHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        };
        if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
        return headers;
    }

    /**
     * 发一条带 id 的 JSON-RPC 请求并等结果（HTTP POST + SSE 解析 + AbortController 超时）。
     * ★ session 自愈：命中「session 失效」类 4xx（404，或 400/401 且响应含 "session"）时，清掉旧 session、
     *   重握手一次再重试本请求（仅一轮，由 _retried 控制）。重握手仍失败 → 置 _status='error' 并广播。
     */
    private async httpRequest(method: string, params?: unknown, timeout = 30000): Promise<unknown> {
        return this.httpRequestOnce(method, params, timeout, false);
    }

    private async httpRequestOnce(method: string, params: unknown, timeout: number, _retried: boolean): Promise<unknown> {
        const id = ++this.requestId;
        const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        let res: Response;
        try {
            res = await fetch(this.httpUrl, {
                method: 'POST',
                headers: this.httpHeaders(),
                body,
                signal: AbortSignal.timeout(timeout),
            });
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
                throw new Error(`MCP timeout: ${method} (${timeout}ms)`);
            }
            throw err;
        }
        // session id 续约：initialize 响应总是覆盖写入（重握手后拿新 id）；其它响应仅在当前无 session 时补写。
        const sid = res.headers.get('mcp-session-id');
        if (sid && (method === 'initialize' || !this.sessionId)) this.sessionId = sid;

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            // ★ session 失效自愈：Broker 重启后旧 session 必返 404（或 400/401 含 "session"）。
            //   非 initialize 调用 + 尚未重试 + 未在重握手中 → 清旧 session、重握手、重试本请求一轮。
            const sessionDead =
                res.status === 404 ||
                ((res.status === 400 || res.status === 401) && /session/i.test(errText));
            const safeToReplay = method === 'tools/list'
                || method === 'resources/list'
                || method === 'prompts/list'
                || method === 'ping';
            if (sessionDead && safeToReplay && !_retried && !this.reHandshaking) {
                try {
                    await this.reinitHttp();
                } catch (reErr) {
                    // 重握手都失败 → Broker 真挂了：如实置 error 并广播，别再谎报 running。
                    this._status = 'error';
                    this.emit('status-change', { name: this.name, status: 'error' });
                    throw new Error(`MCP http ${res.status} ${method}: re-handshake failed: ${(reErr as Error)?.message ?? reErr}`);
                }
                // 重握手成功 → 用新 session 重试本请求一轮（_retried=true 防无限重试）。
                return this.httpRequestOnce(method, params, timeout, true);
            }
            throw new Error(`MCP http ${res.status} ${method}: ${errText.slice(0, 200)}`);
        }

        const ct = res.headers.get('content-type') || '';
        const text = await res.text();
        const messages = ct.includes('text/event-stream')
            ? this.parseSSE(text)
            : (text.trim() ? this.parseJSONLines(text) : []);

        // 找到与本次 id 匹配的响应（SSE 流里可能夹带 server 通知）。
        const matched = messages.find(
            m => (m as JSONRPCResponse).id === id,
        ) as JSONRPCResponse | undefined;
        if (!matched) {
            throw new Error(`MCP http ${method}: no matching response for id ${id}`);
        }
        if (matched.error) {
            throw new Error(matched.error.message);
        }
        return matched.result;
    }

    /** 发一条无 id 的通知（HTTP POST，server 通常回 202 空 body）。 */
    private async httpNotify(method: string, params?: unknown): Promise<void> {
        const body = JSON.stringify({ jsonrpc: '2.0', method, params });
        let response: Response;
        try {
            response = await fetch(this.httpUrl, {
                method: 'POST',
                headers: this.httpHeaders(),
                body,
                signal: AbortSignal.timeout(5000),
            });
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
                throw new Error(`MCP timeout: ${method} (5000ms)`);
            }
            throw err;
        }
        if (!response.ok) throw new Error(`MCP http ${response.status} ${method}`);
    }

    /** 解析 SSE 文本：抽出每个事件块的 `data:` 行拼成 JSON。 */
    private parseSSE(text: string): unknown[] {
        const out: unknown[] = [];
        for (const block of text.split(/\r?\n\r?\n/)) {
            const dataLines = block.split(/\r?\n/).filter(l => l.startsWith('data:'));
            if (!dataLines.length) continue;
            const json = dataLines.map(l => l.slice(5).trim()).join('');
            try { out.push(JSON.parse(json)); } catch { /* 非 JSON data 行忽略 */ }
        }
        return out;
    }

    /** 解析直接返回的 JSON（单对象/数组，或多行 JSON）。 */
    private parseJSONLines(text: string): unknown[] {
        const trimmed = text.trim();
        // 先尝试整体 parse（最常见：单个 JSON 对象/数组）。
        try {
            const v = JSON.parse(trimmed);
            return Array.isArray(v) ? v : [v];
        } catch { /* 落到逐行 */ }
        const out: unknown[] = [];
        for (const line of trimmed.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch { /* ignore */ }
        }
        return out;
    }
}
