import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { shell } from 'electron';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import {
    deleteProviderCredential,
    clearProviderCredentialRejection,
    getProviderCredential,
    getProviderCredentialRejection,
    getProviderCredentialStatus,
    isProviderImportDisabled,
    setProviderImportDisabled,
    setProviderCredential,
    markProviderCredentialRejected,
} from './credentialStore';
import { unprotectCurrentUserDpapi } from './windowsDpapi';

const PROVIDER_ID = 'openai-codex';
const CREDENTIAL_KIND = 'oauth';
const LEGACY_HEADER = 'DSH-OAUTH-DPAPI-V1\n';
const LOGIN_TIMEOUT_MS = positiveEnvMilliseconds('SYNAPSE_OPENAI_CODEX_LOGIN_TIMEOUT_MS', 5 * 60_000);
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;
const CODEX_CLIENT_VERSION = '0.146.0';
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

function positiveEnvMilliseconds(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

type OpenAICodexCredential = Extract<Credential, { type: 'oauth' }> & {
    accountId?: string;
};

export interface OpenAICodexStatus {
    providerId: typeof PROVIDER_ID;
    state: 'idle' | 'starting' | 'waiting' | 'connected' | 'error';
    connected: boolean;
    persisted: boolean;
    storage: 'safeStorage' | 'memory' | 'none';
    expiresAt: number | null;
    accountLabel: string | null;
    authorizationUrl: string | null;
    error: string | null;
}

interface OpenAICodexCatalogEntry {
    accountHash: string;
    accountFingerprint: string | null;
    credentialGeneration: number;
    models: Array<Record<string, unknown>>;
    etag: string | null;
    fetchedAt: number;
    generation: string;
}

const catalogByAccount = new Map<string, OpenAICodexCatalogEntry>();

function validateCredential(value: unknown): OpenAICodexCredential | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<OpenAICodexCredential>;
    if (candidate.type !== 'oauth') return null;
    if (!candidate.access || !candidate.refresh || !Number.isFinite(candidate.expires)) return null;
    return structuredClone(candidate as OpenAICodexCredential);
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`OpenAI Codex catalog exceeds ${maxBytes} bytes`);
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel('catalog response too large');
            throw new Error(`OpenAI Codex catalog exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}

const mutationChains = new Map<string, Promise<unknown>>();

function enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = mutationChains.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    mutationChains.set(providerId, next.catch(() => undefined));
    return next;
}

const credentialStore: CredentialStore = {
    async read(providerId) {
        if (providerId !== PROVIDER_ID) return undefined;
        return validateCredential(getProviderCredential(providerId, CREDENTIAL_KIND)) ?? undefined;
    },
    async list() {
        const credential = validateCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND));
        return credential ? [{ providerId: PROVIDER_ID, type: credential.type }] : [];
    },
    async modify(providerId, fn) {
        if (providerId !== PROVIDER_ID) throw new Error(`Unsupported OAuth provider: ${providerId}`);
        return enqueue(providerId, async () => {
            const current = validateCredential(getProviderCredential(providerId, CREDENTIAL_KIND)) ?? undefined;
            const next = await fn(current);
            if (next === undefined) return current;
            const validated = validateCredential(next);
            if (!validated) throw new Error('OpenAI Codex OAuth credential is invalid');
            setProviderCredential(providerId, CREDENTIAL_KIND, validated, validated.accountId || validated.refresh);
            return validated;
        });
    },
    async delete(providerId) {
        if (providerId !== PROVIDER_ID) return;
        await enqueue(providerId, async () => {
            deleteProviderCredential(providerId);
        });
    },
};

let modelsPromise: Promise<any> | null = null;

export async function getOpenAICodexModels(): Promise<any> {
    if (!modelsPromise) {
        modelsPromise = Promise.all([
            dynamicImport('@earendil-works/pi-ai'),
            dynamicImport('@earendil-works/pi-ai/providers/openai-codex'),
        ]).then(([core, provider]) => {
            const models = core.createModels({ credentials: credentialStore });
            models.setProvider(provider.openaiCodexProvider());
            return models;
        });
    }
    return modelsPromise;
}

function legacyStorePath(): string {
    const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? process.cwd(), 'AppData', 'Local');
    return process.env.SYNAPSE_OPENAI_CODEX_IMPORT_PATH
        ?? join(localAppData, 'DeepSeekHarness', 'state', 'openai-codex-oauth.dpapi');
}

let legacyImportPromise: Promise<boolean> | null = null;

export function importLegacyOpenAICodexCredential(): Promise<boolean> {
    if (legacyImportPromise) return legacyImportPromise;
    legacyImportPromise = (async () => {
        if (isProviderImportDisabled(PROVIDER_ID)) return false;
        if (validateCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND))) return false;
        const filename = legacyStorePath();
        try {
            await access(filename);
            const encoded = await readFile(filename, 'utf8');
            if (!encoded.startsWith(LEGACY_HEADER)) return false;
            const plain = await unprotectCurrentUserDpapi(encoded.slice(LEGACY_HEADER.length));
            const document = JSON.parse(plain) as { version?: number; credentials?: Record<string, unknown> };
            if (document.version !== 1) return false;
            const credential = validateCredential(document.credentials?.[PROVIDER_ID]);
            if (!credential) return false;
            setProviderCredential(PROVIDER_ID, CREDENTIAL_KIND, credential, credential.accountId || credential.refresh);
            return true;
        } catch {
            return false;
        }
    })();
    return legacyImportPromise;
}

function normalizeCatalogModels(value: unknown): Array<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { models?: unknown }).models)) {
        throw new Error('OpenAI Codex catalog response is missing models');
    }
    const models = (value as { models: unknown[] }).models.flatMap(candidate => {
        if (!candidate || typeof candidate !== 'object') return [];
        const raw = candidate as Record<string, any>;
        if (typeof raw.slug !== 'string' || !raw.slug) return [];
        const visibility = typeof raw.visibility === 'string' ? raw.visibility.toLowerCase() : 'list';
        if (
            raw.supported_in_api === false
            || raw.disabled === true
            || ['hidden', 'hide', 'internal', 'none'].includes(visibility)
        ) return [];
        const reasoning = Array.isArray(raw.supported_reasoning_levels)
            ? raw.supported_reasoning_levels
                .map((entry: any) => typeof entry === 'string' ? entry : entry?.effort)
                .filter((entry: unknown): entry is string => typeof entry === 'string' && Boolean(entry))
            : [];
        const modalities = Array.isArray(raw.input_modalities)
            ? raw.input_modalities.filter((entry: unknown) => entry === 'text' || entry === 'image')
            : ['text'];
        const serviceTiers = Array.isArray(raw.service_tiers) ? raw.service_tiers : [];
        const speedTiers = Array.isArray(raw.additional_speed_tiers) ? raw.additional_speed_tiers : [];
        return [{
            id: raw.slug,
            display_name: typeof raw.display_name === 'string' ? raw.display_name : raw.slug,
            description: typeof raw.description === 'string' ? raw.description : undefined,
            context_window: Number.isFinite(raw.context_window) ? raw.context_window : undefined,
            input_modalities: modalities,
            supported_reasoning_levels: reasoning.map(effort => ({ effort })),
            service_tiers: serviceTiers,
            additional_speed_tiers: speedTiers,
            supported_parameters: [
                'tools', 'tool_choice', 'stream', 'max_tokens',
                ...(reasoning.length ? ['reasoning_effort'] : []),
                ...(serviceTiers.length || speedTiers.length ? ['service_tier'] : []),
            ],
            capabilities: {
                vision: modalities.includes('image'),
                tools: true,
                thinking: reasoning.length > 0,
                streaming: true,
            },
            capability_authority: {
                vision: 'api',
                tools: 'protocol',
                thinking: 'api',
                streaming: 'protocol',
                contextWindow: 'api',
                maxOutputTokens: 'unknown',
                reasoningEffortOptions: 'api',
                speedTierOptions: 'api',
            },
            visibility,
            supported_in_api: true,
        }];
    });
    if (models.length === 0) throw new Error('OpenAI Codex catalog contains no usable models');
    return models;
}

export async function fetchOpenAICodexCatalog(force = false): Promise<Record<string, unknown>> {
    await importLegacyOpenAICodexCredential();
    const credential = validateCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND));
    if (!credential?.accountId) {
        return { ok: false, status: 0, bodyText: '', error: { code: 'missing_credential', message: 'OpenAI Codex OAuth is not connected' } };
    }
    const models = await getOpenAICodexModels();
    const auth = await models.getAuth(PROVIDER_ID);
    const accessToken = auth?.auth?.apiKey;
    if (typeof accessToken !== 'string' || !accessToken) {
        return { ok: false, status: 0, bodyText: '', error: { code: 'missing_credential', message: 'OpenAI Codex access token is unavailable' } };
    }
    const credentialIdentity = getProviderCredentialStatus(PROVIDER_ID);
    const accountHash = credentialIdentity.accountFingerprint ?? createHash('sha256').update(credential.accountId).digest('hex');
    const cached = catalogByAccount.get(accountHash);
    if (!force && cached && Date.now() - cached.fetchedAt <= CATALOG_TTL_MS) {
        return {
            ok: true,
            status: 200,
            bodyText: JSON.stringify({ data: cached.models }),
            catalog: {
                providerId: PROVIDER_ID,
                generation: cached.generation,
                fetchedAt: cached.fetchedAt,
                source: 'cache',
                stale: false,
                endpointSha256: createHash('sha256').update('https://chatgpt.com/backend-api/codex/models').digest('hex'),
                accountFingerprint: cached.accountFingerprint,
                credentialGeneration: cached.credentialGeneration,
            },
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            'chatgpt-account-id': credential.accountId,
            originator: 'synapse',
            'user-agent': `Synapse/${CODEX_CLIENT_VERSION}`,
        };
        if (cached?.etag) headers['if-none-match'] = cached.etag;
        const response = await fetch(
            `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`,
            { headers, signal: controller.signal },
        );
        if (response.status === 304 && cached) {
            const currentIdentity = getProviderCredentialStatus(PROVIDER_ID);
            if (currentIdentity.accountFingerprint !== credentialIdentity.accountFingerprint
                || currentIdentity.credentialGeneration !== credentialIdentity.credentialGeneration) {
                return { ok: false, status: 0, bodyText: '', error: { code: 'stale_credential', message: 'OpenAI Codex credential changed while loading the model catalog' } };
            }
            const refreshed = { ...cached, fetchedAt: Date.now() };
            catalogByAccount.set(accountHash, refreshed);
            return {
                ok: true,
                status: 200,
                bodyText: JSON.stringify({ data: refreshed.models }),
                catalog: {
                    providerId: PROVIDER_ID,
                    generation: refreshed.generation,
                    fetchedAt: refreshed.fetchedAt,
                    source: 'cache-validated',
                    stale: false,
                    endpointSha256: createHash('sha256').update('https://chatgpt.com/backend-api/codex/models').digest('hex'),
                    accountFingerprint: refreshed.accountFingerprint,
                    credentialGeneration: refreshed.credentialGeneration,
                },
            };
        }
        if (response.status === 401 || response.status === 403) {
            catalogByAccount.delete(accountHash);
            openAICodexController.markCredentialRejected(`OpenAI Codex catalog authentication failed with HTTP ${response.status}`);
            return {
                ok: false,
                status: response.status,
                bodyText: '',
                error: { code: 'authentication_failed', message: `OpenAI Codex catalog authentication failed with HTTP ${response.status}` },
            };
        }
        if (!response.ok) throw new Error(`OpenAI Codex catalog failed with HTTP ${response.status}`);
        const body = await readResponseTextLimited(response, MAX_CATALOG_BODY_BYTES);
        const normalized = normalizeCatalogModels(JSON.parse(body));
        const bodyText = JSON.stringify({ data: normalized });
        const currentIdentity = getProviderCredentialStatus(PROVIDER_ID);
        if (currentIdentity.accountFingerprint !== credentialIdentity.accountFingerprint
            || currentIdentity.credentialGeneration !== credentialIdentity.credentialGeneration) {
            return { ok: false, status: 0, bodyText: '', error: { code: 'stale_credential', message: 'OpenAI Codex credential changed while loading the model catalog' } };
        }
        const entry: OpenAICodexCatalogEntry = {
            accountHash,
            accountFingerprint: credentialIdentity.accountFingerprint,
            credentialGeneration: credentialIdentity.credentialGeneration,
            models: normalized,
            etag: response.headers.get('etag'),
            fetchedAt: Date.now(),
            generation: createHash('sha256').update(bodyText).digest('hex'),
        };
        catalogByAccount.set(accountHash, entry);
        openAICodexController.markCredentialAccepted();
        return {
            ok: true,
            status: 200,
            bodyText,
            catalog: {
                providerId: PROVIDER_ID,
                generation: entry.generation,
                fetchedAt: entry.fetchedAt,
                source: 'network',
                stale: false,
                endpointSha256: createHash('sha256').update('https://chatgpt.com/backend-api/codex/models').digest('hex'),
                accountFingerprint: entry.accountFingerprint,
                credentialGeneration: entry.credentialGeneration,
            },
        };
    } catch (error) {
        const currentIdentity = getProviderCredentialStatus(PROVIDER_ID);
        if (cached && currentIdentity.accountFingerprint === credentialIdentity.accountFingerprint
            && currentIdentity.credentialGeneration === credentialIdentity.credentialGeneration) {
            return {
                ok: true,
                status: 200,
                bodyText: JSON.stringify({ data: cached.models }),
                catalog: {
                    providerId: PROVIDER_ID,
                    generation: cached.generation,
                    fetchedAt: cached.fetchedAt,
                    source: 'stale',
                    stale: true,
                    endpointSha256: createHash('sha256').update('https://chatgpt.com/backend-api/codex/models').digest('hex'),
                },
                warning: error instanceof Error ? error.message : String(error),
            };
        }
        return { ok: false, status: 0, bodyText: '', error: { code: 'network', message: error instanceof Error ? error.message : String(error) } };
    } finally {
        clearTimeout(timer);
    }
}

function assertCallbackPortAvailable(): Promise<void> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.once('error', error => reject(new Error(`OAuth callback port 1455 is unavailable: ${error.message}`)));
        probe.listen(1455, '127.0.0.1', () => probe.close(closeError => closeError ? reject(closeError) : resolve()));
    });
}

class OpenAICodexController {
    private state: OpenAICodexStatus['state'] = 'idle';
    private error: string | null = null;
    private authorizationUrl: string | null = null;
    private lifecycleGeneration = 0;
    private startTask: Promise<OpenAICodexStatus> | null = null;
    private loginTask: Promise<void> | null = null;
    private abortController: AbortController | null = null;
    private timeout: ReturnType<typeof setTimeout> | null = null;

    async status(): Promise<OpenAICodexStatus> {
        await importLegacyOpenAICodexCredential();
        const credential = validateCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND));
        const storage = getProviderCredentialStatus(PROVIDER_ID);
        const rejection = getProviderCredentialRejection(PROVIDER_ID);
        return {
            providerId: PROVIDER_ID,
            state: credential && !rejection ? 'connected' : rejection ? 'error' : this.state,
            connected: Boolean(credential) && !rejection,
            persisted: storage.persisted,
            storage: storage.storage,
            expiresAt: credential?.expires ?? null,
            accountLabel: credential?.accountId ?? null,
            authorizationUrl: this.authorizationUrl,
            error: rejection?.message ?? this.error,
        };
    }

    start(): Promise<OpenAICodexStatus> {
        if (this.startTask) return this.startTask;
        const generation = ++this.lifecycleGeneration;
        const task = this.startInternal(generation);
        this.startTask = task;
        const clearStartTask = () => {
            if (this.startTask === task) this.startTask = null;
        };
        void task.then(clearStartTask, clearStartTask);
        return task;
    }

    private async startInternal(generation: number): Promise<OpenAICodexStatus> {
        await importLegacyOpenAICodexCredential();
        if (generation !== this.lifecycleGeneration) return this.status();
        if (validateCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND)) && !getProviderCredentialRejection(PROVIDER_ID)) return this.status();
        if (this.loginTask) return this.status();
        setProviderImportDisabled(PROVIDER_ID, false);
        await assertCallbackPortAvailable();
        if (generation !== this.lifecycleGeneration) return this.status();
        const models = await getOpenAICodexModels();
        if (generation !== this.lifecycleGeneration) return this.status();
        this.state = 'starting';
        this.error = null;
        this.authorizationUrl = null;
        const abortController = new AbortController();
        this.abortController = abortController;
        const timeout = setTimeout(() => abortController.abort(), LOGIN_TIMEOUT_MS);
        this.timeout = timeout;
        const interaction = {
            signal: abortController.signal,
            prompt: async (request: any) => {
                if (request.type === 'select') return 'browser';
                if (request.type !== 'manual_code') throw new Error('Unsupported OAuth prompt');
                return new Promise<string>((_resolve, reject) => {
                    const abort = () => reject(new Error('Login cancelled'));
                    if (request.signal?.aborted || abortController.signal.aborted) abort();
                    request.signal?.addEventListener('abort', abort, { once: true });
                    abortController.signal.addEventListener('abort', abort, { once: true });
                });
            },
            notify: (event: any) => {
                if (event.type !== 'auth_url' || generation !== this.lifecycleGeneration) return;
                this.authorizationUrl = event.url;
                this.state = 'waiting';
                void shell.openExternal(event.url);
            },
        };
        const loginTask = models.login(PROVIDER_ID, 'oauth', interaction)
            .then(() => {
                if (generation !== this.lifecycleGeneration) return;
                this.state = 'connected';
                this.error = null;
                clearProviderCredentialRejection(PROVIDER_ID);
            })
            .catch((error: unknown) => {
                if (generation !== this.lifecycleGeneration) return;
                this.state = 'error';
                this.error = abortController.signal.aborted
                    ? 'OAuth 登录已取消或超时'
                    : error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
                clearTimeout(timeout);
                if (this.timeout === timeout) this.timeout = null;
                if (this.abortController === abortController) this.abortController = null;
                if (this.loginTask === loginTask) this.loginTask = null;
                if (generation === this.lifecycleGeneration) this.authorizationUrl = null;
            });
        this.loginTask = loginTask;
        await Promise.race([loginTask, new Promise(resolve => setTimeout(resolve, 100))]);
        return this.status();
    }

    async cancel(): Promise<OpenAICodexStatus> {
        this.lifecycleGeneration += 1;
        const task = this.loginTask;
        this.abortController?.abort();
        const starting = this.startTask;
        if (starting) {
            try {
                await starting;
            } catch {
                this.startTask = null;
            }
        }
        if (task) await task;
        if (!validateCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND))) this.state = 'idle';
        this.authorizationUrl = null;
        return this.status();
    }

    async logout(): Promise<OpenAICodexStatus> {
        await this.cancel();
        const models = await getOpenAICodexModels();
        await models.logout(PROVIDER_ID);
        setProviderImportDisabled(PROVIDER_ID, true);
        this.state = 'idle';
        this.error = null;
        clearProviderCredentialRejection(PROVIDER_ID);
        this.authorizationUrl = null;
        catalogByAccount.clear();
        return this.status();
    }

    markCredentialRejected(message: string): void {
        markProviderCredentialRejected(PROVIDER_ID, message);
        this.state = 'error';
        this.error = message;
        this.authorizationUrl = null;
    }

    markCredentialAccepted(): void {
        if (!getProviderCredentialRejection(PROVIDER_ID)) return;
        clearProviderCredentialRejection(PROVIDER_ID);
        this.state = 'connected';
        this.error = null;
    }

    dispose(): void {
        this.lifecycleGeneration += 1;
        this.startTask = null;
        if (this.timeout) clearTimeout(this.timeout);
        this.abortController?.abort();
        this.timeout = null;
        this.abortController = null;
        catalogByAccount.clear();
    }
}

export const openAICodexController = new OpenAICodexController();
export const openAICodexProviderId = PROVIDER_ID;
