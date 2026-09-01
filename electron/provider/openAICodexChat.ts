import type { Context, Model, Usage } from '@earendil-works/pi-ai';
import { getOpenAICodexModels, openAICodexProviderId } from './openAICodex';
import { canonicalizeSplitProviderUsage } from './usage';

interface OpenAICodexChatOptions {
    body: Record<string, any>;
    signal: AbortSignal;
    stream: boolean;
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    requestTimestamp: number;
    onRequestPrepared(payload: Record<string, unknown>): void;
    onData(data: Uint8Array): void;
    onDone(): void;
    onError(code: string, message: string): void;
    onSettled(): void;
}

interface OpenAICodexChatStart {
    streaming: boolean;
    bodyText?: string;
}

class OpenAICodexChatError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

const TERMINAL_USAGE_QUOTA_PATTERNS = [
    /\busage[_ -]?limit\b.{0,80}\b(?:reached|exceeded|hit)\b/i,
    /\b(?:quota|billing|credit|credits|balance|spend limit|hard limit)\b.{0,120}\b(?:exceed|exceeded|reached|depleted|insufficient|required|past due|limit)\b/i,
    /\b(?:exceeded|reached|hit)\b.{0,120}\b(?:quota|usage limit|spend limit|hard limit)\b/i,
    /\binsufficient[_ -]?quota\b/i,
    /\bout of (?:credits|quota)\b/i,
    /(?:额度|配额|用量|余额|点数|账单|欠费).{0,40}(?:不足|耗尽|用完|达到|超过|上限|限制|失效)/i,
];

const TERMINAL_AUTH_ACCOUNT_PATTERNS = [
    /\b(?:authentication_failed|invalid_api_key|unauthorized|forbidden|permission denied|access denied)\b/i,
    /\b(?:incorrect|invalid|expired|revoked)\b.{0,80}\b(?:api key|token|credential|oauth)\b/i,
    /\b(?:api key|token|credential|oauth)\b.{0,80}\b(?:incorrect|invalid|expired|revoked)\b/i,
    /\blogin required\b/i,
    /\baccount\b.{0,100}\b(?:disabled|suspended|deactivated|locked|inactive|not active|not found)\b/i,
    /\borganization\b.{0,100}\b(?:disabled|suspended|deactivated|not active)\b/i,
    /(?:账号|账户|密钥|令牌|凭据|权限|登录).{0,40}(?:无效|过期|撤销|禁用|停用|冻结|未授权|不存在|需要)/i,
];

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
    if (error instanceof OpenAICodexChatError) return error.code;
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code ? code : '';
}

export function normalizeOpenAICodexChatError(error: unknown, signalAborted = false): OpenAICodexChatError {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (signalAborted || code === 'aborted') return new OpenAICodexChatError('aborted', message || 'aborted');
    const haystack = `${code}\n${message}`;
    if (TERMINAL_USAGE_QUOTA_PATTERNS.some(pattern => pattern.test(haystack))) {
        return new OpenAICodexChatError('usage_quota', message);
    }
    if (TERMINAL_AUTH_ACCOUNT_PATTERNS.some(pattern => pattern.test(haystack))) {
        return new OpenAICodexChatError('authentication_failed', message);
    }
    return error instanceof OpenAICodexChatError
        ? error
        : new OpenAICodexChatError(code || 'provider', message);
}

const ZERO_USAGE: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textFromContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n');
}

function userContent(content: unknown): any {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: any[] = [];
    for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'text', text: part.text });
            continue;
        }
        const url = part?.type === 'image_url' ? part.image_url?.url : null;
        const match = typeof url === 'string' ? /^data:([^;,]+);base64,(.+)$/s.exec(url) : null;
        if (match) parts.push({ type: 'image', mimeType: match[1], data: match[2] });
        else if (url) parts.push({ type: 'text', text: `[未内联图片：${url}]` });
    }
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function parseArguments(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    try {
        const parsed = JSON.parse(String(value || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function buildOpenAICodexContext(body: Record<string, any>, requestTimestamp: number): Context {
    const system: string[] = [];
    const messages: any[] = [];
    const inputMessages = Array.isArray(body.messages) ? body.messages : [];
    for (let messageIndex = 0; messageIndex < inputMessages.length; messageIndex++) {
        const message = inputMessages[messageIndex];
        const timestamp = requestTimestamp + messageIndex;
        if (message?.role === 'system' || message?.role === 'developer') {
            const text = textFromContent(message.content);
            if (text) system.push(text);
            continue;
        }
        if (message?.role === 'user') {
            messages.push({ role: 'user', content: userContent(message.content), timestamp });
            continue;
        }
        if (message?.role === 'tool') {
            messages.push({
                role: 'toolResult',
                toolCallId: String(message.tool_call_id || ''),
                toolName: String(message.name || 'tool'),
                content: [{ type: 'text', text: textFromContent(message.content) }],
                isError: false,
                timestamp,
            });
            continue;
        }
        if (message?.role === 'assistant') {
            const content: any[] = [];
            const text = textFromContent(message.content);
            if (text) content.push({ type: 'text', text });
            for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
                content.push({
                    type: 'toolCall',
                    id: String(toolCall?.id || ''),
                    name: String(toolCall?.function?.name || ''),
                    arguments: parseArguments(toolCall?.function?.arguments),
                });
            }
            messages.push({
                role: 'assistant',
                content,
                api: 'openai-codex-responses',
                provider: openAICodexProviderId,
                model: String(body.model || ''),
                usage: ZERO_USAGE,
                stopReason: 'stop',
                timestamp,
            });
        }
    }
    const tools = Array.isArray(body.tools)
        ? body.tools
            .filter(tool => tool?.type === 'function' && tool.function?.name)
            .map(tool => ({
                name: String(tool.function.name),
                description: String(tool.function.description || ''),
                parameters: tool.function.parameters ?? { type: 'object', properties: {} },
            }))
        : undefined;
    return { systemPrompt: system.join('\n\n') || undefined, messages, tools };
}

function toSimpleOptions(body: Record<string, any>, signal: AbortSignal): Record<string, unknown> {
    const reasoning = typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'auto'
        ? body.reasoning_effort
        : undefined;
    return {
        signal,
        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        reasoning,
        serviceTier: body.service_tier === 'priority' || body.speed_tier === 'fast' ? 'priority' : undefined,
        cacheRetention: 'short',
        maxRetries: 0,
    };
}

function usagePayload(usage: Usage): Record<string, unknown> {
    const normalized = canonicalizeSplitProviderUsage({
        promptTokens: usage.input,
        completionTokens: usage.output,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
    });
    if (!normalized) return {};
    return {
        prompt_tokens: normalized.promptTokens,
        completion_tokens: normalized.completionTokens,
        total_tokens: normalized.totalTokens,
        prompt_tokens_details: {
            cached_tokens: normalized.cacheReadTokens,
            cache_creation_tokens: normalized.cacheWriteTokens,
        },
    };
}

function sse(value: unknown): Uint8Array {
    return Buffer.from(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`, 'utf8');
}

function openAIResponse(message: any): Record<string, unknown> {
    const text = message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
    const toolCalls = message.content
        .filter((part: any) => part.type === 'toolCall')
        .map((part: any) => ({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
        }));
    return {
        choices: [{
            message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: message.stopReason === 'toolUse' ? 'tool_calls' : message.stopReason === 'length' ? 'length' : 'stop',
        }],
        usage: usagePayload(message.usage),
    };
}

function nextWithTimeout<T>(
    iterator: AsyncIterator<T>,
    timeoutMs: number,
    code: string,
    signal: AbortSignal,
): Promise<IteratorResult<T>> {
    if (signal.aborted) return Promise.reject(new OpenAICodexChatError('aborted', 'aborted'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new OpenAICodexChatError(code, `${code} after ${timeoutMs}ms`)), timeoutMs);
        const abort = () => reject(new OpenAICodexChatError('aborted', 'aborted'));
        signal.addEventListener('abort', abort, { once: true });
        iterator.next().then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        });
    });
}

async function resolveModel(modelId: string): Promise<{ models: any; model: Model<any> }> {
    const models = await getOpenAICodexModels();
    const model = models.getModel(openAICodexProviderId, modelId);
    if (!model) throw new OpenAICodexChatError('model_not_found', `OpenAI Codex model not found: ${modelId}`);
    return { models, model };
}

export async function startOpenAICodexChat(options: OpenAICodexChatOptions): Promise<OpenAICodexChatStart> {
    const { models, model } = await resolveModel(String(options.body.model || ''));
    const context = buildOpenAICodexContext(options.body, options.requestTimestamp);
    const requestController = new AbortController();
    const requestSignal = AbortSignal.any([options.signal, requestController.signal]);
    const streamOptions = toSimpleOptions(options.body, requestSignal);
    const { signal: _signal, ...serializableOptions } = streamOptions;
    options.onRequestPrepared({
        provider: openAICodexProviderId,
        model: model.id,
        context,
        options: serializableOptions,
    });
    if (!options.stream) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const message = await Promise.race([
                models.completeSimple(model, context, streamOptions),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        requestController.abort();
                        reject(new OpenAICodexChatError('connect_timeout', `connect_timeout after ${options.connectTimeoutMs}ms`));
                    }, options.connectTimeoutMs);
                }),
            ]);
            return { streaming: false, bodyText: JSON.stringify(openAIResponse(message)) };
        } catch (error) {
            throw normalizeOpenAICodexChatError(error, options.signal.aborted);
        } finally {
            if (timer) clearTimeout(timer);
            options.onSettled();
        }
    }

    const eventStream = models.streamSimple(model, context, streamOptions);
    const iterator = eventStream[Symbol.asyncIterator]();
    let readyResolve: () => void;
    let readyReject: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    void (async () => {
        let receivedFirst = false;
        try {
            while (true) {
                const result = await nextWithTimeout(
                    iterator,
                    receivedFirst ? options.idleTimeoutMs : options.connectTimeoutMs,
                    receivedFirst ? 'stream_idle_timeout' : 'connect_timeout',
                    options.signal,
                ).catch(error => {
                    if (error instanceof OpenAICodexChatError && ['connect_timeout', 'stream_idle_timeout'].includes(error.code)) {
                        requestController.abort(error);
                    }
                    throw error;
                });
                if (result.done) throw new OpenAICodexChatError('missing_terminal_event', 'OpenAI Codex stream ended without terminal event');
                const event = result.value as any;
                if (!receivedFirst) {
                    receivedFirst = true;
                    readyResolve!();
                }
                if (event.type === 'text_delta') {
                    options.onData(sse({ choices: [{ delta: { content: event.delta }, finish_reason: null }] }));
                } else if (event.type === 'thinking_delta') {
                    options.onData(sse({ choices: [{ delta: { reasoning_content: event.delta }, finish_reason: null }] }));
                } else if (event.type === 'toolcall_end') {
                    options.onData(sse({ choices: [{
                        delta: {
                            tool_calls: [{
                                index: event.contentIndex ?? 0,
                                id: event.toolCall.id,
                                type: 'function',
                                function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments ?? {}) },
                            }],
                        },
                        finish_reason: null,
                    }] }));
                } else if (event.type === 'done') {
                    options.onData(sse({
                        choices: [{ delta: {}, finish_reason: event.reason === 'toolUse' ? 'tool_calls' : event.reason }],
                        usage: usagePayload(event.message.usage),
                    }));
                    options.onData(sse('[DONE]'));
                    options.onDone();
                    return;
                } else if (event.type === 'error') {
                    throw normalizeOpenAICodexChatError(
                        new OpenAICodexChatError(
                            event.reason === 'aborted' ? 'aborted' : String(event.reason || 'provider'),
                            event.error?.errorMessage || event.error?.message || String(event.reason || 'provider'),
                        ),
                        options.signal.aborted,
                    );
                }
            }
        } catch (error) {
            const normalized = normalizeOpenAICodexChatError(error, options.signal.aborted);
            if (!receivedFirst) readyReject!(normalized);
            options.onError(normalized.code, normalized.message);
        } finally {
            try { await iterator.return?.(); } catch {}
            options.onSettled();
        }
    })();
    await ready;
    return { streaming: true };
}
