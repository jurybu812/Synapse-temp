import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import {
    clearMemoryCredentials,
    clearProviderCredentialRejection,
    deleteProviderCredential,
    getProviderApiKey,
    getProviderBaseUrl,
    getProviderCredentialStatus,
    migrateLegacyProviderCredentials,
    markProviderCredentialRejected,
    setProviderApiKey,
} from '../provider/credentialStore';
import { fetchOpenAICodexCatalog, getOpenAICodexModels, openAICodexController } from '../provider/openAICodex';
import { startOpenAICodexChat } from '../provider/openAICodexChat';
import { fetchWindsurfCatalog, windsurfController } from '../provider/windsurf';
import { clearWindsurfConversationState, startWindsurfChat } from '../provider/windsurfChat';
import { getDatabase } from '../database';

interface ProviderChatRequest {
    requestId: string;
    cancelToken: string;
    conversationId?: string;
    runId?: string;
    callId?: string;
    ownerId?: string;
    requestKind?: ProviderRequestMeta['requestKind'];
    catalogGeneration?: string;
    compressionGeneration?: string;
    requestTimestamp?: number;
    providerId: string;
    body: Record<string, unknown>;
    stream: boolean;
}

interface ProviderRequestMeta {
    requestId: string;
    conversationId?: string;
    runId?: string;
    callId?: string;
    ownerId?: string;
    requestKind: 'agent' | 'record' | 'title' | 'subtitle' | 'subagent' | 'workflow' | 'system';
    providerId: string;
    modelId: string;
    accountFingerprint: string | null;
    credentialGeneration: number;
    catalogGeneration?: string;
    compressionGeneration?: string;
    bodySha256: string;
    inputImages: Array<{ sha256: string; mime: string; bytes: number }>;
    sentAt: number;
}

function inferRequestKind(ownerId?: string): ProviderRequestMeta['requestKind'] {
    if (!ownerId) return 'agent';
    if (ownerId.startsWith('record:')) return 'record';
    if (ownerId.startsWith('system-title:') || ownerId === 'system-title') return 'title';
    if (ownerId.startsWith('system-subtitle:') || ownerId === 'system-subtitle') return 'subtitle';
    if (ownerId.startsWith('sub-') || ownerId.startsWith('subagent:')) return 'subagent';
    if (ownerId.startsWith('workflow-')) return 'workflow';
    if (ownerId.startsWith('system-')) return 'system';
    return 'agent';
}

interface ProviderCatalogMeta {
    providerId: string;
    generation: string;
    fetchedAt: number;
    source: 'network' | 'cache' | 'cache-validated' | 'stale';
    stale: boolean;
    endpointSha256: string;
    accountFingerprint: string | null;
    credentialGeneration: number;
}

interface ProviderCatalogCacheEntry {
    bodyText: string;
    etag: string | null;
    generation: string;
    fetchedAt: number;
    endpointSha256: string;
    accountFingerprint: string | null;
    credentialGeneration: number;
}

interface ActiveProviderRequest {
    controller: AbortController;
    reason: 'user' | 'connect-timeout' | 'stream-idle' | 'body-idle' | 'empty-stream' | 'truncated-stream' | null;
    cancelToken: string;
    senderId: number;
}

const activeRequests = new Map<string, ActiveProviderRequest>();
const catalogCache = new Map<string, ProviderCatalogCacheEntry>();
const CONNECT_TIMEOUT_MS = Number(process.env.SYNAPSE_PROVIDER_CONNECT_TIMEOUT_MS) || 30_000;
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.SYNAPSE_PROVIDER_STREAM_IDLE_TIMEOUT_MS) || 45_000;
const parsedCatalogTtl = Number(process.env.SYNAPSE_PROVIDER_CATALOG_TTL_MS);
const CATALOG_TTL_MS = Number.isFinite(parsedCatalogTtl) && parsedCatalogTtl >= 0 ? parsedCatalogTtl : 300_000;
const MAX_CHAT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BODY_BYTES = 32 * 1024 * 1024;

function extractInputImages(body: Record<string, unknown>): ProviderRequestMeta['inputImages'] {
    const images: ProviderRequestMeta['inputImages'] = [];
    const addImage = (mime: unknown, encoded: unknown): void => {
        if (typeof mime !== 'string' || typeof encoded !== 'string') return;
        try {
            const bytes = Buffer.from(encoded.replace(/\s/gu, ''), 'base64');
            if (bytes.byteLength === 0) return;
            images.push({
                sha256: createHash('sha256').update(bytes).digest('hex'),
                mime: mime.toLowerCase(),
                bytes: bytes.byteLength,
            });
        } catch {
            // Invalid image payloads are rejected by the provider adapter; omit them from telemetry.
        }
    };
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        if (record.type === 'image_url' && record.image_url && typeof record.image_url === 'object') {
            const url = (record.image_url as Record<string, unknown>).url;
            if (typeof url === 'string') {
                const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(url);
                if (match) addImage(match[1], match[2]);
            }
        }
        if (record.type === 'image') {
            addImage(record.mimeType, record.data ?? record.base64Data);
        }
        for (const child of Object.values(record)) visit(child);
    };
    visit(body);
    return images;
}

function persistRequestStart(meta: ProviderRequestMeta, rendererId: number): void {
    try {
        getDatabase().prepare(`
            INSERT INTO provider_request_ledger (
              request_id, renderer_id, conversation_id, run_id, call_id, owner_id,
              request_kind, provider_id, model_id, account_fingerprint, credential_generation,
              catalog_generation, compression_generation,
              body_sha256, input_images_json, sent_at, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started')
        `).run(
            meta.requestId,
            rendererId,
            meta.conversationId ?? null,
            meta.runId ?? null,
            meta.callId ?? null,
            meta.ownerId ?? null,
            meta.requestKind,
            meta.providerId,
            meta.modelId,
            meta.accountFingerprint,
            meta.credentialGeneration,
            meta.catalogGeneration ?? null,
            meta.compressionGeneration ?? null,
            meta.bodySha256,
            JSON.stringify(meta.inputImages),
            meta.sentAt,
        );
    } catch (error) {
        console.warn('[provider] Failed to persist request ledger start:', error);
    }
}

function persistRequestStatus(requestId: string, status: 'completed' | 'cancelled' | 'error'): void {
    if (!requestId) return;
    try {
        getDatabase().prepare(`
            UPDATE provider_request_ledger
            SET status = ?, completed_at = COALESCE(completed_at, ?)
            WHERE request_id = ? AND status <> 'superseded'
        `).run(status, Date.now(), requestId);
    } catch (error) {
        console.warn('[provider] Failed to persist request ledger status:', error);
    }
}

function finiteUsageToken(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function persistRequestUsage(rendererId: number, usage: Record<string, unknown>): boolean {
    const requestId = typeof usage.requestId === 'string' ? usage.requestId : '';
    if (!requestId) return false;
    const promptTokens = finiteUsageToken(usage.promptTokens);
    const completionTokens = finiteUsageToken(usage.completionTokens);
    const totalTokens = finiteUsageToken(usage.totalTokens);
    if (promptTokens === null || completionTokens === null || totalTokens === null) return false;
    try {
        const database = getDatabase();
        const row = database.prepare(`
            SELECT renderer_id, provider_id, account_fingerprint, credential_generation
            FROM provider_request_ledger WHERE request_id = ?
        `).get(requestId) as {
            renderer_id?: number;
            provider_id?: string;
            account_fingerprint?: string | null;
            credential_generation?: number | null;
        } | undefined;
        if (!row || row.renderer_id !== rendererId || !row.provider_id) return false;
        const current = getProviderCredentialStatus(row.provider_id);
        if (row.account_fingerprint !== current.accountFingerprint || row.credential_generation !== current.credentialGeneration) {
            database.prepare("UPDATE provider_request_ledger SET status = 'superseded' WHERE request_id = ?").run(requestId);
            return false;
        }
        const result = database.prepare(`
            UPDATE provider_request_ledger SET
              prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
              cache_read_tokens = ?, cache_write_tokens = ?,
              completed_at = ?, status = 'completed'
            WHERE request_id = ? AND status <> 'superseded'
        `).run(
            promptTokens,
            completionTokens,
            Math.max(totalTokens, promptTokens + completionTokens),
            finiteUsageToken(usage.cacheReadTokens),
            finiteUsageToken(usage.cacheWriteTokens),
            Date.now(),
            requestId,
        );
        return result.changes > 0;
    } catch (error) {
        console.warn('[provider] Failed to persist request ledger usage:', error);
        return false;
    }
}

function persistPreparedRequest(
    requestId: string,
    payload: Record<string, unknown>,
): Pick<ProviderRequestMeta, 'bodySha256' | 'inputImages'> {
    const bodySha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const inputImages = extractInputImages(payload);
    getDatabase().prepare(`
        UPDATE provider_request_ledger
        SET body_sha256 = ?, input_images_json = ?
        WHERE request_id = ?
    `).run(bodySha256, JSON.stringify(inputImages), requestId);
    return { bodySha256, inputImages };
}

function latestRequestUsage(conversationId: string): Record<string, unknown> | null {
    if (!conversationId) return null;
    try {
        const rows = getDatabase().prepare(`
            SELECT request_id, conversation_id, run_id, call_id, owner_id, request_kind, provider_id, model_id, status,
                   account_fingerprint, credential_generation, catalog_generation, compression_generation, body_sha256, input_images_json,
                   prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens, sent_at
            FROM provider_request_ledger
            WHERE conversation_id = ? AND request_kind = 'agent' AND status <> 'superseded'
            ORDER BY sent_at DESC, completed_at DESC, rowid DESC
            LIMIT 50
        `).all(conversationId) as Array<Record<string, unknown>>;
        const row = rows.find(candidate => {
            const current = getProviderCredentialStatus(String(candidate.provider_id ?? ''));
            return candidate.account_fingerprint === current.accountFingerprint
                && candidate.credential_generation === current.credentialGeneration;
        });
        if (!row || row.status !== 'completed'
            || row.prompt_tokens === null || row.completion_tokens === null || row.total_tokens === null) return null;
        const completionTokens = Number(row.completion_tokens);
        const cacheReadTokens = Number(row.cache_read_tokens ?? 0);
        const cacheWriteTokens = Number(row.cache_write_tokens ?? 0);
        const storedPromptTokens = Number(row.prompt_tokens ?? 0);
        const storedTotalTokens = Number(row.total_tokens ?? 0);
        const legacySplitUsage = cacheReadTokens + cacheWriteTokens > 0
            && storedTotalTokens === storedPromptTokens + completionTokens + cacheReadTokens + cacheWriteTokens;
        const promptTokens = legacySplitUsage
            ? storedPromptTokens + cacheReadTokens + cacheWriteTokens
            : storedPromptTokens;
        const totalTokens = Math.max(storedTotalTokens, promptTokens + completionTokens);
        return {
            requestId: row.request_id,
            conversationId: row.conversation_id,
            runId: row.run_id,
            callId: row.call_id,
            ownerId: row.owner_id,
            requestKind: row.request_kind,
            providerId: row.provider_id,
            modelId: row.model_id,
            accountFingerprint: row.account_fingerprint,
            credentialGeneration: row.credential_generation,
            catalogGeneration: row.catalog_generation,
            compressionGeneration: row.compression_generation,
            bodySha256: row.body_sha256,
            inputImages: JSON.parse(String(row.input_images_json ?? '[]')),
            promptTokens,
            completionTokens,
            totalTokens,
            cacheReadTokens: row.cache_read_tokens === null ? null : cacheReadTokens,
            cacheWriteTokens: row.cache_write_tokens === null ? null : cacheWriteTokens,
            sentAt: row.sent_at,
        };
    } catch (error) {
        console.warn('[provider] Failed to read latest request ledger usage:', error);
        return null;
    }
}

function invalidateConversationUsage(conversationId: string): boolean {
    if (!conversationId) return false;
    try {
        getDatabase().prepare(`
            UPDATE provider_request_ledger
            SET status = 'superseded'
            WHERE conversation_id = ? AND status IN ('started', 'completed')
        `).run(conversationId);
        return true;
    } catch (error) {
        console.warn('[provider] Failed to invalidate request ledger usage:', error);
        return false;
    }
}

function promoteConversationUsage(fromId: string, toId: string): boolean {
    if (!fromId || !toId || fromId === toId) return false;
    try {
        getDatabase().prepare(`
            UPDATE provider_request_ledger
            SET conversation_id = ?
            WHERE conversation_id = ?
        `).run(toId, fromId);
        return true;
    } catch (error) {
        console.warn('[provider] Failed to promote request ledger usage:', error);
        return false;
    }
}

function responseHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'retry-after', 'x-request-id']) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
    }
    return headers;
}

function catalogMeta(
    providerId: string,
    entry: ProviderCatalogCacheEntry,
    source: ProviderCatalogMeta['source'],
): ProviderCatalogMeta {
    return {
        providerId,
        generation: entry.generation,
        fetchedAt: entry.fetchedAt,
        source,
        stale: source === 'stale',
        endpointSha256: entry.endpointSha256,
        accountFingerprint: entry.accountFingerprint,
        credentialGeneration: entry.credentialGeneration,
    };
}

function clearProviderCatalog(providerId: string): void {
    const prefix = `${providerId}:`;
    for (const key of catalogCache.keys()) {
        if (key.startsWith(prefix)) catalogCache.delete(key);
    }
}

function sendEvent(event: IpcMainInvokeEvent, payload: Record<string, unknown>): void {
    if (!event.sender.isDestroyed()) event.sender.send('provider:chat:event', payload);
}

async function readResponseTextLimited(response: Response, maxBytes: number, active?: ActiveProviderRequest): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Provider response exceeds ${maxBytes} bytes`);
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const next = active
            ? Promise.race([
                reader.read(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        active.reason = 'body-idle';
                        active.controller.abort(new Error('provider response body idle timeout'));
                        reject(new Error(`Provider response body produced no data for ${STREAM_IDLE_TIMEOUT_MS}ms`));
                    }, STREAM_IDLE_TIMEOUT_MS);
                }),
            ])
            : reader.read();
        const { done, value } = await next.finally(() => { if (timer) clearTimeout(timer); });
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel('response too large');
            throw new Error(`Provider response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

async function pumpStream(
    event: IpcMainInvokeEvent,
    requestId: string,
    response: Response,
    active: ActiveProviderRequest,
): Promise<void> {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            active.reason = 'stream-idle';
            active.controller.abort(new Error('provider stream idle timeout'));
        }, STREAM_IDLE_TIMEOUT_MS);
    };

    try {
        const reader = response.body?.getReader();
        if (!reader) {
            active.reason = 'empty-stream';
            throw new Error('EMPTY_STREAM: Provider stream body is unavailable');
        }
        resetIdleTimer();
        let totalBytes = 0;
        let eventBuffer = '';
        let sawDataEvent = false;
        let sawTerminalEvent = false;
        const inspectEventLines = (flush = false) => {
            const lines = eventBuffer.split(/\r?\n/);
            eventBuffer = flush ? '' : (lines.pop() ?? '');
            for (const line of lines) {
                const match = /^\s*data\s*:\s*(.*)$/.exec(line);
                const payload = match?.[1]?.trim();
                if (!payload) continue;
                sawDataEvent = true;
                if (payload === '[DONE]') {
                    sawTerminalEvent = true;
                    continue;
                }
                try {
                    const parsed = JSON.parse(payload);
                    if (Array.isArray(parsed?.choices)
                        && parsed.choices.some((choice: any) => choice?.finish_reason != null)) {
                        sawTerminalEvent = true;
                    }
                } catch {
                    continue;
                }
            }
        };
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_STREAM_BODY_BYTES) {
                active.controller.abort(new Error('provider stream response too large'));
                throw new Error(`Provider stream exceeds ${MAX_STREAM_BODY_BYTES} bytes`);
            }
            resetIdleTimer();
            eventBuffer = `${eventBuffer}${Buffer.from(value).toString('utf8')}`.slice(-65_536);
            inspectEventLines();
            sendEvent(event, { requestId, type: 'data', data: Buffer.from(value).toString('base64') });
        }
        inspectEventLines(true);
        if (!sawDataEvent) {
            active.reason = 'empty-stream';
            throw new Error('EMPTY_STREAM: Provider stream closed without a data event');
        }
        if (!sawTerminalEvent) {
            active.reason = 'truncated-stream';
            throw new Error('TRUNCATED_STREAM: Provider stream closed before a terminal event');
        }
        persistRequestStatus(requestId, 'completed');
        sendEvent(event, { requestId, type: 'done' });
    } catch (error) {
        const message = active.reason === 'user'
            ? 'aborted'
            : active.reason === 'stream-idle'
                ? `Provider stream produced no data for ${STREAM_IDLE_TIMEOUT_MS}ms`
                : active.reason === 'empty-stream'
                    ? 'Provider stream closed without a data event'
                    : active.reason === 'truncated-stream'
                        ? 'Provider stream closed before a terminal event'
                : error instanceof Error ? error.message : String(error);
        persistRequestStatus(requestId, active.reason === 'user' ? 'cancelled' : 'error');
        sendEvent(event, {
            requestId,
            type: 'error',
            code: active.reason === 'user'
                ? 'aborted'
                : active.reason === 'stream-idle'
                    ? 'stream_idle_timeout'
                    : active.reason === 'empty-stream'
                        ? 'empty_stream'
                        : active.reason === 'truncated-stream'
                            ? 'truncated_stream'
                        : 'network',
            message,
        });
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        activeRequests.delete(requestId);
    }
}

async function startChat(event: IpcMainInvokeEvent, request: ProviderChatRequest): Promise<Record<string, unknown>> {
    if (!request?.requestId || activeRequests.has(request.requestId)) throw new Error('Duplicate provider request id');
    if (typeof request.cancelToken !== 'string' || request.cancelToken.length < 16) throw new Error('Invalid provider cancellation token');
    if (!request.body || typeof request.body !== 'object') throw new Error('Invalid provider request body');

    if (request.providerId === 'openai-codex') {
        try {
            const models = await getOpenAICodexModels();
            await models.getAuth('openai-codex');
        } catch {
            // The adapter returns the authoritative authentication error below. This preflight only
            // lets an internal refresh persist before the request ledger freezes credential identity.
        }
    }
    const controller = new AbortController();
    const active: ActiveProviderRequest = { controller, reason: null, cancelToken: request.cancelToken, senderId: event.sender.id };
    const bodyText = JSON.stringify(request.body);
    const credentialIdentity = getProviderCredentialStatus(request.providerId);
    const requestMeta: ProviderRequestMeta = {
        requestId: request.requestId,
        conversationId: request.conversationId,
        runId: request.runId,
        callId: request.callId ?? request.requestId,
        ownerId: request.ownerId,
        requestKind: request.requestKind ?? inferRequestKind(request.ownerId),
        providerId: request.providerId,
        modelId: typeof request.body.model === 'string' ? request.body.model : '',
        accountFingerprint: credentialIdentity.accountFingerprint,
        credentialGeneration: credentialIdentity.credentialGeneration,
        catalogGeneration: request.catalogGeneration,
        compressionGeneration: request.compressionGeneration,
        bodySha256: createHash('sha256').update(bodyText).digest('hex'),
        inputImages: extractInputImages(request.body),
        sentAt: Date.now(),
    };
    persistRequestStart(requestMeta, event.sender.id);
    activeRequests.set(request.requestId, active);
    const markRejectedCredential = (providerId: string, code: string, message: string) => {
        const rejected = ['authentication_failed', 'unauthenticated', 'unauthorized', 'forbidden', 'permission_denied'].includes(code)
            || /(?:\b401\b|\b403\b|unauthenticated|unauthori[sz]ed|forbidden|permission[_ ]denied|credential[^.]{0,40}(?:invalid|expired))/i.test(message);
        if (!rejected) return;
        if (providerId === 'openai-codex') openAICodexController.markCredentialRejected(message);
        else if (providerId === 'windsurf') windsurfController.markCredentialRejected(message);
        else markProviderCredentialRejected(providerId, message);
    };
    if (request.providerId === 'openai-codex') {
        try {
            const result = await startOpenAICodexChat({
                body: request.body,
                signal: controller.signal,
                stream: request.stream,
                connectTimeoutMs: CONNECT_TIMEOUT_MS,
                idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
                requestTimestamp: Number.isFinite(request.requestTimestamp) ? request.requestTimestamp! : requestMeta.sentAt,
                onRequestPrepared: payload => {
                    Object.assign(requestMeta, persistPreparedRequest(request.requestId, payload));
                },
                onData: data => sendEvent(event, { requestId: request.requestId, type: 'data', data: Buffer.from(data).toString('base64') }),
                onDone: () => {
                    persistRequestStatus(request.requestId, 'completed');
                    sendEvent(event, { requestId: request.requestId, type: 'done' });
                },
                onError: (code, message) => {
                    markRejectedCredential(request.providerId, code, message);
                    persistRequestStatus(request.requestId, code === 'aborted' ? 'cancelled' : 'error');
                    sendEvent(event, { requestId: request.requestId, type: 'error', code, message });
                },
                onSettled: () => activeRequests.delete(request.requestId),
            });
            if (!result.streaming) persistRequestStatus(request.requestId, 'completed');
            return {
                ok: true,
                status: 200,
                headers: { 'content-type': request.stream ? 'text/event-stream' : 'application/json' },
                streaming: result.streaming,
                bodyText: result.bodyText,
                request: requestMeta,
            };
        } catch (error) {
            const code = controller.signal.aborted ? 'aborted' : (error as { code?: string })?.code ?? 'provider';
            const message = error instanceof Error ? error.message : String(error);
            markRejectedCredential(request.providerId, code, message);
            persistRequestStatus(request.requestId, controller.signal.aborted ? 'cancelled' : 'error');
            activeRequests.delete(request.requestId);
            return {
                ok: false,
                status: 0,
                error: {
                    code,
                    message,
                },
                request: requestMeta,
            };
        }
    }
    if (request.providerId === 'windsurf') {
        try {
            const result = await startWindsurfChat({
                body: request.body,
                conversationId: request.conversationId,
                signal: controller.signal,
                stream: request.stream,
                connectTimeoutMs: CONNECT_TIMEOUT_MS,
                idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
                onRequestPrepared: payload => {
                    Object.assign(requestMeta, persistPreparedRequest(request.requestId, payload));
                },
                onData: data => sendEvent(event, { requestId: request.requestId, type: 'data', data: Buffer.from(data).toString('base64') }),
                onDone: () => {
                    persistRequestStatus(request.requestId, 'completed');
                    sendEvent(event, { requestId: request.requestId, type: 'done' });
                },
                onError: (code, message) => {
                    markRejectedCredential(request.providerId, code, message);
                    persistRequestStatus(request.requestId, code === 'aborted' ? 'cancelled' : 'error');
                    sendEvent(event, { requestId: request.requestId, type: 'error', code, message });
                },
                onSettled: () => activeRequests.delete(request.requestId),
            });
            if (!result.streaming) persistRequestStatus(request.requestId, 'completed');
            return {
                ok: true,
                status: 200,
                headers: { 'content-type': request.stream ? 'text/event-stream' : 'application/json' },
                streaming: result.streaming,
                bodyText: result.bodyText,
                request: requestMeta,
            };
        } catch (error) {
            const code = controller.signal.aborted ? 'aborted' : (error as { code?: string })?.code ?? 'provider';
            const message = error instanceof Error ? error.message : String(error);
            markRejectedCredential(request.providerId, code, message);
            persistRequestStatus(request.requestId, controller.signal.aborted ? 'cancelled' : 'error');
            activeRequests.delete(request.requestId);
            return {
                ok: false,
                status: 0,
                error: {
                    code,
                    message,
                },
                request: requestMeta,
            };
        }
    }

    const apiKey = getProviderApiKey(request.providerId);
    const baseUrl = getProviderBaseUrl(request.providerId);
    if (!apiKey || !baseUrl) {
        persistRequestStatus(request.requestId, 'error');
        activeRequests.delete(request.requestId);
        return { ok: false, status: 0, error: { code: !apiKey ? 'missing_credential' : 'missing_endpoint', message: !apiKey ? 'Provider credential is not configured' : 'Provider endpoint is not configured' } };
    }
    const connectTimer = setTimeout(() => {
        active.reason = 'connect-timeout';
        controller.abort(new Error('provider connect timeout'));
    }, CONNECT_TIMEOUT_MS);

    try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: bodyText,
            signal: controller.signal,
        });
        clearTimeout(connectTimer);
        const headers = responseHeaders(response);
        if (response.status === 401 || response.status === 403) {
            markProviderCredentialRejected(request.providerId, `Provider authentication failed with HTTP ${response.status}`);
        } else if (response.ok) {
            clearProviderCredentialRejection(request.providerId);
        }
        if (!request.stream || !response.ok) {
            const bodyText = await readResponseTextLimited(response, MAX_CHAT_BODY_BYTES, active);
            persistRequestStatus(request.requestId, response.ok ? 'completed' : 'error');
            activeRequests.delete(request.requestId);
            return { ok: response.ok, status: response.status, headers, bodyText, request: requestMeta };
        }
        void pumpStream(event, request.requestId, response, active);
        return { ok: true, status: response.status, headers, streaming: true, request: requestMeta };
    } catch (error) {
        persistRequestStatus(request.requestId, active.reason === 'user' ? 'cancelled' : 'error');
        clearTimeout(connectTimer);
        activeRequests.delete(request.requestId);
        const message = active.reason === 'user'
            ? 'aborted'
            : active.reason === 'connect-timeout'
                ? `Provider did not return response headers within ${CONNECT_TIMEOUT_MS}ms`
                : active.reason === 'body-idle'
                    ? `Provider response body produced no data for ${STREAM_IDLE_TIMEOUT_MS}ms`
                : error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            status: 0,
            error: {
                code: active.reason === 'user' ? 'aborted' : active.reason === 'connect-timeout' ? 'connect_timeout' : active.reason === 'body-idle' ? 'body_idle_timeout' : 'network',
                message,
            },
            request: requestMeta,
        };
    }
}

export function registerProviderHandlers(): void {
    migrateLegacyProviderCredentials();
    ipcMain.handle('provider:credentialStatus', async (_event, providerId: string) => {
        if (providerId === 'openai-codex') {
            const status = await openAICodexController.status();
            const credential = getProviderCredentialStatus(providerId);
            return {
                providerId,
                configured: status.connected,
                persisted: status.persisted,
                storage: status.storage,
                credentialType: status.connected ? 'oauth' : null,
                updatedAt: credential.updatedAt,
                accountFingerprint: credential.accountFingerprint,
                credentialGeneration: credential.credentialGeneration,
            };
        }
        if (providerId === 'windsurf') {
            const status = await windsurfController.status();
            const credential = getProviderCredentialStatus(providerId);
            return {
                providerId,
                configured: status.connected,
                persisted: status.persisted,
                storage: status.storage,
                credentialType: status.connected ? status.credentialSource ?? 'browser-token' : null,
                updatedAt: credential.updatedAt,
                accountFingerprint: credential.accountFingerprint,
                credentialGeneration: credential.credentialGeneration,
            };
        }
        return getProviderCredentialStatus(providerId);
    });
    ipcMain.handle('provider:setApiKey', (_event, providerId: string, apiKey: string, baseUrl?: string) => {
        clearProviderCatalog(providerId);
        return setProviderApiKey(providerId, apiKey, baseUrl);
    });
    ipcMain.handle('provider:deleteCredential', (_event, providerId: string) => {
        clearProviderCatalog(providerId);
        return deleteProviderCredential(providerId);
    });
    ipcMain.handle('provider:fetchModels', async (_event, providerId: string, force?: boolean) => {
        if (providerId === 'windsurf') return fetchWindsurfCatalog(Boolean(force));
        const apiKey = getProviderApiKey(providerId);
        const normalizedBaseUrl = getProviderBaseUrl(providerId);
        if (!apiKey || !normalizedBaseUrl) return { ok: false, status: 0, bodyText: '', error: { code: !apiKey ? 'missing_credential' : 'missing_endpoint', message: !apiKey ? 'Provider credential is not configured' : 'Provider endpoint is not configured' } };
        const credentialIdentity = getProviderCredentialStatus(providerId);
        const endpointSha256 = createHash('sha256').update(normalizedBaseUrl).digest('hex');
        const cacheKey = `${providerId}:${credentialIdentity.accountFingerprint}:${credentialIdentity.credentialGeneration}:${endpointSha256}`;
        const cached = catalogCache.get(cacheKey);
        if (!force && cached && Date.now() - cached.fetchedAt <= CATALOG_TTL_MS) {
            return { ok: true, status: 200, bodyText: cached.bodyText, catalog: catalogMeta(providerId, cached, 'cache') };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
            const headers: Record<string, string> = { 'Authorization': `Bearer ${apiKey}` };
            if (cached?.etag) headers['If-None-Match'] = cached.etag;
            const response = await fetch(`${normalizedBaseUrl}/models`, {
                headers,
                signal: controller.signal,
            });
        if (response.status === 304 && cached) {
            const currentIdentity = getProviderCredentialStatus(providerId);
            if (currentIdentity.accountFingerprint !== credentialIdentity.accountFingerprint
                || currentIdentity.credentialGeneration !== credentialIdentity.credentialGeneration) {
                return { ok: false, status: 0, bodyText: '', error: { code: 'stale_credential', message: 'Provider credential changed while loading the model catalog' } };
            }
            clearProviderCredentialRejection(providerId);
                const refreshed = { ...cached, fetchedAt: Date.now() };
                catalogCache.set(cacheKey, refreshed);
                return { ok: true, status: 200, bodyText: refreshed.bodyText, catalog: catalogMeta(providerId, refreshed, 'cache-validated') };
            }
            const bodyText = await readResponseTextLimited(response, MAX_CATALOG_BODY_BYTES);
            if (response.ok) {
                clearProviderCredentialRejection(providerId);
                const fetchedAt = Date.now();
                const currentIdentity = getProviderCredentialStatus(providerId);
                if (currentIdentity.accountFingerprint !== credentialIdentity.accountFingerprint
                    || currentIdentity.credentialGeneration !== credentialIdentity.credentialGeneration) {
                    return { ok: false, status: 0, bodyText: '', error: { code: 'stale_credential', message: 'Provider credential changed while loading the model catalog' } };
                }
                const entry: ProviderCatalogCacheEntry = {
                    bodyText,
                    etag: response.headers.get('etag'),
                    generation: createHash('sha256').update(bodyText).digest('hex'),
                    fetchedAt,
                    endpointSha256,
                    accountFingerprint: credentialIdentity.accountFingerprint,
                    credentialGeneration: credentialIdentity.credentialGeneration,
                };
                catalogCache.set(cacheKey, entry);
                return { ok: true, status: response.status, bodyText, catalog: catalogMeta(providerId, entry, 'network') };
            }
            if (response.status === 401 || response.status === 403) {
                catalogCache.delete(cacheKey);
                markProviderCredentialRejected(providerId, `Provider catalog authentication failed with HTTP ${response.status}`);
            }
            const currentIdentity = getProviderCredentialStatus(providerId);
            const identityCurrent = currentIdentity.accountFingerprint === credentialIdentity.accountFingerprint
                && currentIdentity.credentialGeneration === credentialIdentity.credentialGeneration;
            if (cached && response.status >= 500 && identityCurrent) {
                return { ok: true, status: 200, bodyText: cached.bodyText, catalog: catalogMeta(providerId, cached, 'stale') };
            }
            return { ok: false, status: response.status, bodyText };
        } catch (error) {
            const currentIdentity = getProviderCredentialStatus(providerId);
            if (cached && currentIdentity.accountFingerprint === credentialIdentity.accountFingerprint
                && currentIdentity.credentialGeneration === credentialIdentity.credentialGeneration) {
                return { ok: true, status: 200, bodyText: cached.bodyText, catalog: catalogMeta(providerId, cached, 'stale') };
            }
            return { ok: false, status: 0, bodyText: '', error: { code: 'network', message: error instanceof Error ? error.message : String(error) } };
        } finally {
            clearTimeout(timer);
        }
    });
    ipcMain.handle('provider:chatStart', startChat);
    ipcMain.handle('provider:recordUsage', (event, usage: Record<string, unknown>) => persistRequestUsage(event.sender.id, usage));
    ipcMain.handle('provider:latestUsage', (_event, conversationId: string) => latestRequestUsage(conversationId));
    ipcMain.handle('provider:invalidateUsage', (_event, conversationId: string) => invalidateConversationUsage(conversationId));
    ipcMain.handle('provider:promoteUsage', (_event, fromId: string, toId: string) => promoteConversationUsage(fromId, toId));
    ipcMain.handle('provider:chatCancel', (event, request: { requestId?: string; cancelToken?: string }) => {
        const active = request?.requestId ? activeRequests.get(request.requestId) : undefined;
        if (!active || active.senderId !== event.sender.id || active.cancelToken !== request.cancelToken) return false;
        active.reason = 'user';
        active.controller.abort(new Error('aborted'));
        return true;
    });
    ipcMain.handle('provider:openAICodexStatus', () => openAICodexController.status());
    ipcMain.handle('provider:openAICodexLogin', () => openAICodexController.start());
    ipcMain.handle('provider:openAICodexCancel', () => openAICodexController.cancel());
    ipcMain.handle('provider:openAICodexLogout', () => openAICodexController.logout());
    ipcMain.handle('provider:openAICodexModels', (_event, force?: boolean) => fetchOpenAICodexCatalog(Boolean(force)));
    ipcMain.handle('provider:windsurfStatus', () => windsurfController.status());
    ipcMain.handle('provider:windsurfLogin', () => windsurfController.start());
    ipcMain.handle('provider:windsurfComplete', (_event, transactionId: string, token: string) => windsurfController.complete(transactionId, token));
    ipcMain.handle('provider:windsurfImportLocal', (event, options?: { confirmationToken?: string }) => windsurfController.importLocal({
        confirmationToken: typeof options?.confirmationToken === 'string' ? options.confirmationToken : undefined,
        requesterId: event.sender.id,
    }));
    ipcMain.handle('provider:windsurfCancel', () => windsurfController.cancel());
    ipcMain.handle('provider:windsurfLogout', () => windsurfController.logout());
    ipcMain.handle('provider:windsurfModels', (_event, force?: boolean) => fetchWindsurfCatalog(Boolean(force)));
}

export function shutdownProviderRuntime(): void {
    for (const [requestId, active] of activeRequests.entries()) {
        persistRequestStatus(requestId, 'cancelled');
        active.reason = 'user';
        active.controller.abort(new Error('shutdown'));
    }
    activeRequests.clear();
    catalogCache.clear();
    openAICodexController.dispose();
    windsurfController.dispose();
    clearWindsurfConversationState();
    clearMemoryCredentials();
}
