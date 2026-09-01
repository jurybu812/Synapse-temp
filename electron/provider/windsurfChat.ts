import { randomUUID } from 'node:crypto';
import { getProviderCredential } from './credentialStore';
import { importLegacyWindsurfCredential, validateWindsurfCredential, windsurfCredentialKind, windsurfProviderId } from './windsurf';
import { loadWindsurfUpstream } from './windsurfUpstream';
import { canonicalizeSplitProviderUsage } from './usage';

interface WindsurfChatOptions {
    body: Record<string, any>;
    conversationId?: string;
    signal: AbortSignal;
    stream: boolean;
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    onRequestPrepared(payload: Record<string, unknown>): void;
    onData: (data: string) => void;
    onDone: () => void;
    onError: (code: string, message: string) => void;
    onSettled: () => void;
}

export interface WindsurfChatStart {
    streaming: boolean;
    bodyText?: string;
}

class WindsurfChatError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'WindsurfChatError';
    }
}

const cascadeIds = new Map<string, string>();

function sse(data: unknown): string {
    return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function toContent(content: unknown): any {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: Array<Record<string, string>> = [];
    for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'text', text: part.text });
            continue;
        }
        const url = part?.type === 'image_url' ? part.image_url?.url : undefined;
        if (typeof url === 'string') {
            const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
            if (match) parts.push({ type: 'image', mimeType: match[1], base64Data: match[2] });
        }
    }
    return parts;
}

function toMessages(body: Record<string, any>): any[] {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.flatMap((message: any) => {
        const role = message?.role === 'developer' ? 'system' : message?.role;
        if (!['user', 'assistant', 'system', 'tool'].includes(role)) return [];
        return [{
            role,
            content: toContent(message.content),
            ...(role === 'tool' && typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
            ...(role === 'assistant' && Array.isArray(message.tool_calls) ? {
                tool_calls: message.tool_calls.flatMap((call: any) => call?.function?.name ? [{
                    id: String(call.id || randomUUID()),
                    name: call.function.name,
                    arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
                }] : []),
            } : {}),
        }];
    });
}

function toTools(body: Record<string, any>): any[] | undefined {
    if (!Array.isArray(body.tools)) return undefined;
    const tools = body.tools.flatMap((tool: any) => tool?.function?.name ? [{
        name: tool.function.name,
        description: typeof tool.function.description === 'string' ? tool.function.description : '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
    }] : []);
    return tools.length > 0 ? tools : undefined;
}

function completionOptions(body: Record<string, any>): Record<string, number> | undefined {
    const result: Record<string, number> = {};
    const maxOutput = Number(body.max_completion_tokens ?? body.max_tokens);
    if (Number.isSafeInteger(maxOutput) && maxOutput > 0) result.maxOutputTokens = maxOutput;
    if (Number.isFinite(body.temperature)) result.temperature = Number(body.temperature);
    if (Number.isFinite(body.top_p)) result.topP = Number(body.top_p);
    return Object.keys(result).length > 0 ? result : undefined;
}

function usagePayload(usage: Record<string, number | undefined>): Record<string, unknown> {
    const normalized = canonicalizeSplitProviderUsage({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheCreationInputTokens,
    });
    if (!normalized) return {};
    return {
        prompt_tokens: normalized.promptTokens,
        completion_tokens: normalized.completionTokens,
        total_tokens: normalized.totalTokens,
        prompt_tokens_details: { cached_tokens: normalized.cacheReadTokens },
        cache_creation_input_tokens: normalized.cacheWriteTokens,
        completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    };
}

function nextWithTimeout<T>(iterator: AsyncIterator<T>, timeoutMs: number, code: string, signal: AbortSignal): Promise<IteratorResult<T>> {
    if (signal.aborted) return Promise.reject(new WindsurfChatError('aborted', 'aborted'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new WindsurfChatError(code, `${code} after ${timeoutMs}ms`)), timeoutMs);
        const abort = () => reject(new WindsurfChatError('aborted', 'aborted'));
        signal.addEventListener('abort', abort, { once: true });
        iterator.next().then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        });
    });
}

export async function startWindsurfChat(options: WindsurfChatOptions): Promise<WindsurfChatStart> {
    await importLegacyWindsurfCredential();
    const credential = validateWindsurfCredential(getProviderCredential(windsurfProviderId, windsurfCredentialKind));
    if (!credential) throw new WindsurfChatError('missing_credential', 'Windsurf is not connected');
    const upstream = await loadWindsurfUpstream();
    const modelUid = String(options.body.model || '').trim();
    if (!modelUid) throw new WindsurfChatError('model_not_found', 'Windsurf model is not selected');
    const requestController = new AbortController();
    const signal = AbortSignal.any([options.signal, requestController.signal]);
    const conversationKey = options.conversationId || randomUUID();
    const cascadeId = cascadeIds.get(conversationKey) ?? upstream.allocateCascadeId();
    cascadeIds.set(conversationKey, cascadeId);
    const messages = toMessages(options.body);
    const tools = toTools(options.body);
    const completionOpts = completionOptions(options.body);
    options.onRequestPrepared({ modelUid, messages, tools, cascadeId, completionOpts });
    const iterator = upstream.streamChatEvents({
        apiKey: credential.apiKey,
        apiServerUrl: credential.apiServerUrl,
        modelUid,
        messages,
        tools,
        cascadeId,
        completionOpts,
        signal,
    })[Symbol.asyncIterator]();

    const readNext = (receivedFirst: boolean) => nextWithTimeout(
        iterator,
        receivedFirst ? options.idleTimeoutMs : options.connectTimeoutMs,
        receivedFirst ? 'stream_idle_timeout' : 'connect_timeout',
        signal,
    ).catch(error => {
        if (error instanceof WindsurfChatError && ['connect_timeout', 'stream_idle_timeout'].includes(error.code)) {
            requestController.abort(error);
        }
        throw error;
    });

    if (!options.stream) {
        let receivedFirst = false;
        let content = '';
        let reasoning = '';
        let finishReason = 'stop';
        let usage: Record<string, number | undefined> = {};
        const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
        let lastToolId = '';
        try {
            while (true) {
                const result = await readNext(receivedFirst);
                if (result.done) break;
                receivedFirst = true;
                const event = result.value as any;
                if (event.kind === 'text') content += event.text;
                else if (event.kind === 'reasoning') reasoning += event.text;
                else if (event.kind === 'tool_call_start') {
                    lastToolId = event.id;
                    toolCalls.set(event.id, { id: event.id, name: event.name, arguments: '' });
                } else if (event.kind === 'tool_call_args') {
                    const id = event.id || lastToolId;
                    const call = toolCalls.get(id);
                    if (call) call.arguments += event.argsDelta;
                } else if (event.kind === 'finish') finishReason = event.reason;
                else if (event.kind === 'usage') usage = event;
            }
            return {
                streaming: false,
                bodyText: JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant',
                            content,
                            ...(reasoning ? { reasoning_content: reasoning } : {}),
                            ...(toolCalls.size > 0 ? { tool_calls: [...toolCalls.values()].map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
                        },
                        finish_reason: finishReason,
                    }],
                    usage: usagePayload(usage),
                }),
            };
        } finally {
            try {
                await iterator.return?.();
            } catch {
            }
            options.onSettled();
        }
    }

    let readyResolve: () => void;
    let readyReject: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    void (async () => {
        let receivedFirst = false;
        let sawFinish = false;
        let lastToolId = '';
        let nextToolIndex = 0;
        const toolIndexById = new Map<string, number>();
        const announcedToolIds = new Set<string>();
        const resolveToolIndex = (id: string): number => {
            const existing = toolIndexById.get(id);
            if (existing !== undefined) return existing;
            const allocated = nextToolIndex++;
            toolIndexById.set(id, allocated);
            return allocated;
        };
        try {
            while (true) {
                const result = await readNext(receivedFirst);
                if (result.done) break;
                const event = result.value as any;
                if (!receivedFirst) {
                    receivedFirst = true;
                    readyResolve!();
                }
                if (event.kind === 'text') options.onData(sse({ choices: [{ delta: { content: event.text }, finish_reason: null }] }));
                else if (event.kind === 'reasoning') options.onData(sse({ choices: [{ delta: { reasoning_content: event.text }, finish_reason: null }] }));
                else if (event.kind === 'tool_call_start') {
                    lastToolId = String(event.id || randomUUID());
                    const index = resolveToolIndex(lastToolId);
                    if (!announcedToolIds.has(lastToolId)) {
                        announcedToolIds.add(lastToolId);
                        options.onData(sse({ choices: [{ delta: { tool_calls: [{ index, id: lastToolId, type: 'function', function: { name: event.name, arguments: '' } }] }, finish_reason: null }] }));
                    }
                } else if (event.kind === 'tool_call_args') {
                    const id = String(event.id || lastToolId || '');
                    if (!id) throw new WindsurfChatError('malformed_tool_call', 'Windsurf emitted tool arguments before a tool call start');
                    lastToolId = id;
                    const index = resolveToolIndex(id);
                    options.onData(sse({ choices: [{ delta: { tool_calls: [{ index, id, function: { arguments: event.argsDelta } }] }, finish_reason: null }] }));
                } else if (event.kind === 'finish') {
                    sawFinish = true;
                    options.onData(sse({ choices: [{ delta: {}, finish_reason: event.reason }] }));
                } else if (event.kind === 'usage') {
                    options.onData(sse({ choices: [], usage: usagePayload(event) }));
                }
            }
            if (!sawFinish) throw new WindsurfChatError('missing_terminal_event', 'Windsurf stream ended without terminal event');
            options.onData(sse('[DONE]'));
            options.onDone();
        } catch (error) {
            const code = error instanceof WindsurfChatError ? error.code : (error as { code?: string })?.code ?? 'provider';
            const message = error instanceof Error ? error.message : String(error);
            if (!receivedFirst) readyReject!(error);
            else options.onError(code, message);
        } finally {
            try {
                await iterator.return?.();
            } catch {
            }
            options.onSettled();
        }
    })();
    await ready;
    return { streaming: true };
}

export function clearWindsurfConversationState(): void {
    cascadeIds.clear();
}
