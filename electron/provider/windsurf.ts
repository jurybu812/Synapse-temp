import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { safeStorage, shell } from 'electron';
import {
    deleteProviderCredential,
    clearProviderCredentialRejection,
    getProviderCredential,
    getProviderCredentialRejection,
    getProviderCredentialStatus,
    setProviderCredential,
    setProviderImportDisabled,
    markProviderCredentialRejected,
} from './credentialStore';
import { loadWindsurfUpstream } from './windsurfUpstream';

const PROVIDER_ID = 'windsurf';
const CREDENTIAL_KIND = 'browser-oauth';
const LOGIN_TIMEOUT_MS = positiveEnvMilliseconds('SYNAPSE_WINDSURF_LOGIN_TIMEOUT_MS', 5 * 60_000);
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 15_000;
const LOCAL_IMPORT_CONFIRMATION_TTL_MS = 2 * 60_000;
const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_API_SERVER_URL = 'https://server.codeium.com';
const DEFAULT_REGION = {
    website: 'https://windsurf.com',
    registerApiServerUrl: 'https://register.windsurf.com',
    oauthClientId: '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u',
};

function positiveEnvMilliseconds(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export interface WindsurfCredential {
    kind: 'browser_oauth' | 'manual_api_key' | 'local_client_import';
    apiKey: string;
    createdAt: string;
    expiresAt?: string;
    apiServerUrl?: string;
    accountName?: string;
}

export interface WindsurfStatus {
    providerId: typeof PROVIDER_ID;
    state: 'idle' | 'waiting' | 'exchanging' | 'connected' | 'error';
    connected: boolean;
    persisted: boolean;
    storage: 'safeStorage' | 'memory' | 'none';
    accountLabel: string | null;
    authorizationUrl: string | null;
    transactionId: string | null;
    expiresAt: string | null;
    credentialSource: 'browser-token' | 'local-client-import' | 'manual-api-key' | null;
    error: string | null;
}

interface CatalogEntry {
    models: Array<Record<string, unknown>>;
    generation: string;
    fetchedAt: number;
    endpointSha256: string;
    accountFingerprint: string | null;
    credentialGeneration: number;
}

export interface WindsurfLocalImportCandidate {
    source: string;
    accountLabel: string | null;
    apiServerUrl: string | null;
}

export interface WindsurfLocalImportError {
    code:
        | 'not_found'
        | 'multiple_accounts'
        | 'database_locked'
        | 'database_corrupt'
        | 'invalid_credential'
        | 'safe_storage_unavailable'
        | 'replace_required'
        | 'replace_confirmation_invalid'
        | 'read_failed';
    message: string;
    confirmationToken?: string;
    confirmationExpiresAt?: number;
    candidates?: WindsurfLocalImportCandidate[];
    existingAccountLabel?: string | null;
    candidateAccountLabel?: string | null;
}

export interface WindsurfLocalImportResult {
    ok: boolean;
    status: WindsurfStatus;
    source: string | null;
    accountLabel: string | null;
    imported: boolean;
    unchanged: boolean;
    replaced: boolean;
    error?: WindsurfLocalImportError;
    candidates?: WindsurfLocalImportCandidate[];
}

interface LocalImportRoot {
    source: string;
    root: string;
}

interface LocalCredentialMatch {
    source: string;
    credential: WindsurfCredential;
    fingerprint: string;
}

interface LocalReadIssue {
    source: string;
    code: WindsurfLocalImportError['code'];
}

interface LocalImportConfirmation {
    token: string;
    requesterId: number;
    candidateFingerprint: string;
    currentAccountFingerprint: string | null;
    currentCredentialGeneration: number;
    expiresAt: number;
}

const catalogByAccount = new Map<string, CatalogEntry>();

function normalizeApiServerUrl(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
        throw new Error('Invalid Windsurf API server URL');
    }
    return parsed.toString().replace(/\/$/, '');
}

export function validateWindsurfCredential(value: unknown): WindsurfCredential | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<WindsurfCredential>;
    if (!['browser_oauth', 'manual_api_key', 'local_client_import'].includes(candidate.kind ?? '')) return null;
    if (typeof candidate.apiKey !== 'string' || !candidate.apiKey.trim()) return null;
    if (typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) return null;
    if (candidate.expiresAt && (Number.isNaN(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= Date.now())) return null;
    try {
        return {
            kind: candidate.kind as WindsurfCredential['kind'],
            apiKey: candidate.apiKey,
            createdAt: new Date(candidate.createdAt).toISOString(),
            ...(candidate.expiresAt ? { expiresAt: new Date(candidate.expiresAt).toISOString() } : {}),
            ...(normalizeApiServerUrl(candidate.apiServerUrl) ? { apiServerUrl: normalizeApiServerUrl(candidate.apiServerUrl) } : {}),
            ...(typeof candidate.accountName === 'string' && candidate.accountName ? { accountName: candidate.accountName.slice(0, 256) } : {}),
        };
    } catch {
        return null;
    }
}

function credentialSourceFor(credential: WindsurfCredential | null): WindsurfStatus['credentialSource'] {
    if (!credential) return null;
    if (credential.kind === 'manual_api_key') return 'manual-api-key';
    if (credential.kind === 'local_client_import') return 'local-client-import';
    return 'browser-token';
}

export function importLegacyWindsurfCredential(): Promise<boolean> {
    return Promise.resolve(false);
}

function localImportRoots(): LocalImportRoot[] {
    const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? process.cwd(), 'AppData', 'Roaming');
    return [
        { source: 'Devin Desktop', root: join(appData, 'devin') },
        { source: 'Windsurf Desktop', root: join(appData, 'Windsurf') },
        { source: 'Codeium Windsurf Desktop', root: join(appData, 'Codeium', 'Windsurf') },
    ];
}

function credentialFingerprint(apiKey: string): string {
    return createHash('sha256').update(`${PROVIDER_ID}\0${CREDENTIAL_KIND}\0${apiKey}`).digest('hex');
}

function candidateSummary(candidate: LocalCredentialMatch): WindsurfLocalImportCandidate {
    return {
        source: candidate.source,
        accountLabel: candidate.credential.accountName ?? null,
        apiServerUrl: candidate.credential.apiServerUrl ?? null,
    };
}

function labelFromValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        if (trimmed.length <= 256) return trimmed;
        return trimmed.slice(0, 253) + '...';
    }
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return labelFromValue(record.email)
        ?? labelFromValue(record.name)
        ?? labelFromValue(record.username)
        ?? labelFromValue(record.login)
        ?? labelFromValue(record.account)
        ?? labelFromValue(record.user);
}

function parseOptionalJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function sqliteIssueCode(error: unknown): WindsurfLocalImportError['code'] {
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
    const message = error instanceof Error ? error.message : String(error);
    const text = `${code} ${message}`.toLowerCase();
    if (text.includes('busy') || text.includes('locked')) return 'database_locked';
    if (text.includes('corrupt') || text.includes('notadb') || text.includes('malformed')) return 'database_corrupt';
    if (text.includes('no such table')) return 'not_found';
    return 'read_failed';
}

function readLocalCredential(root: LocalImportRoot): LocalCredentialMatch | LocalReadIssue | null {
    const dbPath = join(root.root, 'User', 'globalStorage', 'state.vscdb');
    if (!existsSync(dbPath)) return null;
    let database: Database.Database | null = null;
    try {
        database = new Database(dbPath, { readonly: true, fileMustExist: true });
        database.pragma('query_only = ON');
        database.pragma('busy_timeout = 250');
        const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get('windsurfAuthStatus') as { value?: unknown } | undefined;
        if (!row?.value || typeof row.value !== 'string') return null;
        const authStatus = parseOptionalJson(row.value);
        if (!authStatus || typeof authStatus !== 'object') return { source: root.source, code: 'invalid_credential' };
        const record = authStatus as Record<string, unknown>;
        const apiKey = record.apiKey ?? record.api_key ?? record.sessionToken ?? record.session_token;
        if (typeof apiKey !== 'string' || !apiKey.trim()) return { source: root.source, code: 'invalid_credential' };
        const accountName = labelFromValue(record.email)
            ?? labelFromValue(record.name)
            ?? labelFromValue(record.user)
            ?? root.source;
        const credential = validateWindsurfCredential({
            kind: 'local_client_import',
            apiKey: apiKey.trim(),
            createdAt: new Date().toISOString(),
            apiServerUrl: record.apiServerUrl ?? record.api_server_url,
            accountName,
        });
        if (!credential) return { source: root.source, code: 'invalid_credential' };
        return { source: root.source, credential, fingerprint: credentialFingerprint(credential.apiKey) };
    } catch (error) {
        return { source: root.source, code: sqliteIssueCode(error) };
    } finally {
        database?.close();
    }
}

function discoverLocalCredentials(): { matches: LocalCredentialMatch[]; issues: LocalReadIssue[] } {
    const matches: LocalCredentialMatch[] = [];
    const issues: LocalReadIssue[] = [];
    for (const root of localImportRoots()) {
        const result = readLocalCredential(root);
        if (!result) continue;
        if ('credential' in result) matches.push(result);
        else issues.push(result);
    }
    return { matches, issues };
}

function localCandidateFingerprint(candidate: LocalCredentialMatch): string {
    return createHash('sha256').update(JSON.stringify({
        fingerprint: candidate.fingerprint,
        source: candidate.source,
        apiServerUrl: candidate.credential.apiServerUrl ?? null,
        accountName: candidate.credential.accountName ?? null,
    })).digest('hex');
}

function importErrorMessage(code: WindsurfLocalImportError['code']): string {
    if (code === 'multiple_accounts') return '发现多个本机 Devin/Windsurf 账号。为避免导错账号，请先在源客户端保留一个已登录账号后再导入。';
    if (code === 'database_locked') return 'Devin/Windsurf 的本机登录数据库正被占用，请关闭源客户端或稍后再试。';
    if (code === 'database_corrupt') return 'Devin/Windsurf 的本机登录数据库无法读取，可能已损坏或格式不是 SQLite。';
    if (code === 'invalid_credential') return '找到了 Devin/Windsurf 登录记录，但格式里没有可用的账号凭据。';
    if (code === 'safe_storage_unavailable') return '系统安全存储当前不可用，Synapse 不会把导入凭据降级保存到明文或普通内存。';
    if (code === 'replace_required') return 'Synapse 已连接另一个 Windsurf 账号。若要覆盖，请再次确认后执行替换导入。';
    if (code === 'replace_confirmation_invalid') return '本机账号替换确认已过期，或候选账号已经变化。请重新检查并确认。';
    if (code === 'read_failed') return '读取 Devin/Windsurf 本机登录状态失败，请确认客户端数据目录可访问。';
    return '未在 Devin/Windsurf 本机客户端中找到可导入的登录状态。';
}

function dominantIssue(issues: LocalReadIssue[]): WindsurfLocalImportError['code'] {
    for (const code of ['database_locked', 'database_corrupt', 'invalid_credential', 'read_failed'] as const) {
        if (issues.some(issue => issue.code === code)) return code;
    }
    return 'not_found';
}

function buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams([
        ['response_type', 'token'],
        ['client_id', DEFAULT_REGION.oauthClientId],
        ['redirect_uri', 'show-auth-token'],
        ['state', state],
        ['prompt', 'login'],
        ['redirect_parameters_type', 'query'],
        ['workflow', ''],
    ]);
    return `${DEFAULT_REGION.website}/windsurf/signin?${params}`;
}

function fieldsOf(value: Buffer, iterFields: (value: Buffer) => Iterable<any>): any[] {
    try {
        return [...iterFields(value)];
    } catch {
        return [];
    }
}

function containsLocalOnlyMetadata(value: Buffer, iterFields: (value: Buffer) => Iterable<any>, depth = 0): boolean {
    if (depth >= 3) return false;
    for (const field of fieldsOf(value, iterFields)) {
        if (field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
        const text = field.value.toString('utf8');
        if (/\bdevin\s+local\b/iu.test(text)) return true;
        if (containsLocalOnlyMetadata(field.value, iterFields, depth + 1)) return true;
    }
    return false;
}

function parseCatalogModel(value: Buffer, iterFields: (value: Buffer) => Iterable<any>): Record<string, unknown> | null {
    let id = '';
    let name = '';
    let disabled = false;
    let contextWindow: number | undefined;
    let supportsVision = false;
    for (const field of fieldsOf(value, iterFields)) {
        if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) name = field.value.toString('utf8');
        else if (field.num === 4 && field.wire === 0) disabled = field.value === 1n;
        else if (field.num === 18 && field.wire === 0) {
            const parsed = Number(field.value);
            if (Number.isSafeInteger(parsed) && parsed > 0) contextWindow = parsed;
        } else if (field.num === 22 && field.wire === 2 && Buffer.isBuffer(field.value)) id = field.value.toString('utf8');
        else if (field.num === 23 && field.wire === 2 && Buffer.isBuffer(field.value)) {
            for (const group of fieldsOf(field.value, iterFields)) {
                if (group.num !== 6 || group.wire !== 2 || !Buffer.isBuffer(group.value)) continue;
                for (const flag of fieldsOf(group.value, iterFields)) {
                    if (flag.num === 11 && flag.wire === 0 && flag.value === 1n) supportsVision = true;
                }
            }
        }
    }
    if (!id || disabled || containsLocalOnlyMetadata(value, iterFields)) return null;
    return {
        id,
        display_name: name || id,
        ...(contextWindow ? { context_window: contextWindow } : {}),
        input_modalities: supportsVision ? ['text', 'image'] : ['text'],
        supported_parameters: ['tools', 'tool_choice', 'stream', 'max_tokens'],
        capabilities: {
            vision: supportsVision,
            tools: true,
            thinking: false,
            streaming: true,
        },
        capability_authority: {
            vision: 'api',
            tools: 'protocol',
            thinking: 'protocol',
            streaming: 'protocol',
            contextWindow: contextWindow ? 'api' : 'unknown',
            maxOutputTokens: 'unknown',
            reasoningEffortOptions: 'unknown',
            speedTierOptions: 'unknown',
        },
    };
}

function catalogResult(entry: CatalogEntry, source: 'network' | 'cache' | 'stale', warning?: string): Record<string, unknown> {
    return {
        ok: true,
        status: 200,
        bodyText: JSON.stringify({ data: entry.models }),
        catalog: {
            providerId: PROVIDER_ID,
            generation: entry.generation,
            fetchedAt: entry.fetchedAt,
            source,
            stale: source === 'stale',
            endpointSha256: entry.endpointSha256,
            accountFingerprint: entry.accountFingerprint,
            credentialGeneration: entry.credentialGeneration,
        },
        ...(warning ? { warning } : {}),
    };
}

export async function fetchWindsurfCatalog(force = false): Promise<Record<string, unknown>> {
    const credential = validateWindsurfCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND));
    if (!credential) return { ok: false, status: 0, bodyText: '', error: { code: 'missing_credential', message: 'Windsurf is not connected' } };
    const credentialIdentity = getProviderCredentialStatus(PROVIDER_ID);
    const accountHash = credentialIdentity.accountFingerprint ?? createHash('sha256').update(credential.apiKey).digest('hex');
    const cached = catalogByAccount.get(accountHash);
    if (!force && cached && Date.now() - cached.fetchedAt <= CATALOG_TTL_MS) return catalogResult(cached, 'cache');
    const host = credential.apiServerUrl ?? DEFAULT_API_SERVER_URL;
    const upstream = await loadWindsurfUpstream();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
        const userJwt = await upstream.getCachedUserJwt(credential.apiKey, host, controller.signal);
        const metadata = upstream.buildMetadata({
            apiKey: credential.apiKey,
            userJwt,
            sessionId: randomUUID(),
            requestId: BigInt(Date.now()),
            triggerId: randomUUID(),
        });
        const response = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
            method: 'POST',
            headers: { 'content-type': 'application/proto', 'connect-protocol-version': '1' },
            body: upstream.encodeMessage(1, metadata),
            signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
            catalogByAccount.delete(accountHash);
            upstream.clearCachedUserJwt();
            windsurfController.markCredentialRejected(`Windsurf catalog authentication failed with HTTP ${response.status}`);
            return { ok: false, status: response.status, bodyText: '', error: { code: 'authentication_failed', message: `Windsurf catalog authentication failed with HTTP ${response.status}` } };
        }
        if (!response.ok) throw new Error(`Windsurf catalog failed with HTTP ${response.status}`);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_CATALOG_BODY_BYTES) throw new Error('Windsurf catalog response is too large');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_CATALOG_BODY_BYTES) throw new Error('Windsurf catalog response is too large');
        const models = fieldsOf(buffer, upstream.iterFields)
            .filter(field => field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value))
            .map(field => parseCatalogModel(field.value, upstream.iterFields))
            .filter((model): model is Record<string, unknown> => Boolean(model));
        if (models.length === 0) throw new Error('Windsurf catalog returned no callable models');
        const bodyText = JSON.stringify({ data: models });
        const currentIdentity = getProviderCredentialStatus(PROVIDER_ID);
        if (currentIdentity.accountFingerprint !== credentialIdentity.accountFingerprint
            || currentIdentity.credentialGeneration !== credentialIdentity.credentialGeneration) {
            return { ok: false, status: 0, bodyText: '', error: { code: 'stale_credential', message: 'Windsurf credential changed while loading the model catalog' } };
        }
        const entry: CatalogEntry = {
            models,
            generation: createHash('sha256').update(bodyText).digest('hex'),
            fetchedAt: Date.now(),
            endpointSha256: createHash('sha256').update(host).digest('hex'),
            accountFingerprint: credentialIdentity.accountFingerprint,
            credentialGeneration: credentialIdentity.credentialGeneration,
        };
        catalogByAccount.set(accountHash, entry);
        windsurfController.markCredentialAccepted();
        return catalogResult(entry, 'network');
    } catch (error) {
        const currentIdentity = getProviderCredentialStatus(PROVIDER_ID);
        if (cached && currentIdentity.accountFingerprint === credentialIdentity.accountFingerprint
            && currentIdentity.credentialGeneration === credentialIdentity.credentialGeneration) {
            return catalogResult(cached, 'stale', error instanceof Error ? error.message : String(error));
        }
        return { ok: false, status: 0, bodyText: '', error: { code: 'network', message: error instanceof Error ? error.message : String(error) } };
    } finally {
        clearTimeout(timer);
    }
}

class WindsurfController {
    private state: WindsurfStatus['state'] = 'idle';
    private error: string | null = null;
    private authorizationUrl: string | null = null;
    private transactionId: string | null = null;
    private expiresAt: string | null = null;
    private generation = 0;
    private abortController: AbortController | null = null;
    private exchangeTask: Promise<WindsurfStatus> | null = null;
    private localImportConfirmation: LocalImportConfirmation | null = null;
    private timeout: ReturnType<typeof setTimeout> | null = null;

    async status(): Promise<WindsurfStatus> {
        const credential = validateWindsurfCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND));
        const storage = getProviderCredentialStatus(PROVIDER_ID);
        const rejection = getProviderCredentialRejection(PROVIDER_ID);
        return {
            providerId: PROVIDER_ID,
            state: credential && !rejection ? 'connected' : rejection ? 'error' : this.state,
            connected: Boolean(credential) && !rejection,
            persisted: storage.persisted,
            storage: storage.storage,
            accountLabel: credential?.accountName ?? null,
            authorizationUrl: this.authorizationUrl,
            transactionId: this.transactionId,
            expiresAt: this.expiresAt,
            credentialSource: credentialSourceFor(credential),
            error: rejection?.message ?? this.error,
        };
    }

    async start(): Promise<WindsurfStatus> {
        if (validateWindsurfCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND)) && !getProviderCredentialRejection(PROVIDER_ID)) return this.status();
        const exchange = this.exchangeTask;
        this.cancelPending();
        if (exchange) {
            try {
                await exchange;
            } catch {
                this.exchangeTask = null;
            }
        }
        setProviderImportDisabled(PROVIDER_ID, false);
        this.generation += 1;
        this.transactionId = randomBytes(32).toString('base64url');
        this.authorizationUrl = buildAuthorizationUrl(this.transactionId);
        this.expiresAt = new Date(Date.now() + LOGIN_TIMEOUT_MS).toISOString();
        this.state = 'waiting';
        this.error = null;
        const generation = this.generation;
        this.timeout = setTimeout(() => {
            if (this.generation !== generation) return;
            this.abortController?.abort();
            this.state = 'error';
            this.error = 'Windsurf 登录已超时';
            this.clearTransaction();
        }, LOGIN_TIMEOUT_MS);
        void shell.openExternal(this.authorizationUrl);
        return this.status();
    }

    complete(transactionId: string, token: string): Promise<WindsurfStatus> {
        if (this.exchangeTask) return Promise.reject(new Error('Windsurf login exchange is already in progress'));
        const task = this.completeInternal(transactionId, token);
        this.exchangeTask = task;
        const clearExchangeTask = () => {
            if (this.exchangeTask === task) this.exchangeTask = null;
        };
        void task.then(clearExchangeTask, clearExchangeTask);
        return task;
    }

    async importLocal(options: { confirmationToken?: string; requesterId: number }): Promise<WindsurfLocalImportResult> {
        const statusBefore = await this.status();
        if (!safeStorage.isEncryptionAvailable()) {
            this.localImportConfirmation = null;
            return this.localImportError('safe_storage_unavailable', statusBefore);
        }
        const { matches, issues } = discoverLocalCredentials();
        const blockingIssue = dominantIssue(issues.filter(issue => issue.code !== 'invalid_credential'));
        if (blockingIssue !== 'not_found') {
            this.localImportConfirmation = null;
            return this.localImportError(blockingIssue, statusBefore, { candidates: matches.map(candidateSummary) });
        }
        const byFingerprint = new Map<string, LocalCredentialMatch>();
        for (const match of matches) {
            const existing = byFingerprint.get(match.fingerprint);
            byFingerprint.set(match.fingerprint, existing
                ? { ...existing, source: `${existing.source} / ${match.source}` }
                : match);
        }
        const candidates = [...byFingerprint.values()];
        if (candidates.length === 0) {
            this.localImportConfirmation = null;
            const code = dominantIssue(issues);
            return this.localImportError(code, statusBefore);
        }
        if (candidates.length > 1) {
            this.localImportConfirmation = null;
            return this.localImportError('multiple_accounts', statusBefore, { candidates: candidates.map(candidateSummary) });
        }
        const candidate = candidates[0];
        const current = validateWindsurfCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND));
        const currentStatus = getProviderCredentialStatus(PROVIDER_ID);
        const currentRejection = getProviderCredentialRejection(PROVIDER_ID);
        const sameAccount = Boolean(current && currentStatus.accountFingerprint === candidate.fingerprint);
        if (current && !sameAccount) {
            const candidateFingerprint = localCandidateFingerprint(candidate);
            if (!options.confirmationToken) {
                const confirmationToken = randomBytes(32).toString('base64url');
                const confirmationExpiresAt = Date.now() + LOCAL_IMPORT_CONFIRMATION_TTL_MS;
                this.localImportConfirmation = {
                    token: confirmationToken,
                    requesterId: options.requesterId,
                    candidateFingerprint,
                    currentAccountFingerprint: currentStatus.accountFingerprint,
                    currentCredentialGeneration: currentStatus.credentialGeneration,
                    expiresAt: confirmationExpiresAt,
                };
                return this.localImportError('replace_required', statusBefore, {
                    confirmationToken,
                    confirmationExpiresAt,
                    existingAccountLabel: current.accountName ?? null,
                    candidateAccountLabel: candidate.credential.accountName ?? null,
                    candidates: [candidateSummary(candidate)],
                });
            }
            const confirmation = this.localImportConfirmation;
            this.localImportConfirmation = null;
            const confirmationValid = Boolean(confirmation
                && confirmation.token === options.confirmationToken
                && confirmation.requesterId === options.requesterId
                && confirmation.candidateFingerprint === candidateFingerprint
                && confirmation.currentAccountFingerprint === currentStatus.accountFingerprint
                && confirmation.currentCredentialGeneration === currentStatus.credentialGeneration
                && confirmation.expiresAt >= Date.now());
            if (!confirmationValid) {
                return this.localImportError('replace_confirmation_invalid', statusBefore, {
                    existingAccountLabel: current.accountName ?? null,
                    candidateAccountLabel: candidate.credential.accountName ?? null,
                    candidates: [candidateSummary(candidate)],
                });
            }
        }
        if (current && sameAccount && !currentRejection) {
            this.localImportConfirmation = null;
            this.state = 'connected';
            this.error = null;
            this.clearTransaction();
            const status = await this.status();
            return {
                ok: true,
                status,
                source: candidate.source,
                accountLabel: candidate.credential.accountName ?? null,
                imported: false,
                unchanged: true,
                replaced: false,
            };
        }
        const replaced = Boolean(current && !sameAccount);
        this.localImportConfirmation = null;
        this.cancelPending();
        setProviderCredential(PROVIDER_ID, CREDENTIAL_KIND, candidate.credential, candidate.credential.apiKey);
        setProviderImportDisabled(PROVIDER_ID, false);
        clearProviderCredentialRejection(PROVIDER_ID);
        catalogByAccount.clear();
        try {
            const upstream = await loadWindsurfUpstream();
            upstream.clearCachedUserJwt();
            upstream.clearSessionIds();
        } catch {
        }
        this.state = 'connected';
        this.error = null;
        const status = await this.status();
        return {
            ok: true,
            status,
            source: candidate.source,
            accountLabel: candidate.credential.accountName ?? null,
            imported: true,
            unchanged: false,
            replaced,
        };
    }

    private async completeInternal(transactionId: string, token: string): Promise<WindsurfStatus> {
        if (!this.transactionId || transactionId !== this.transactionId) throw new Error('Windsurf login transaction is stale');
        if (!this.expiresAt || Date.parse(this.expiresAt) <= Date.now()) throw new Error('Windsurf login transaction expired');
        const normalizedToken = String(token || '').trim();
        if (normalizedToken.length < 32 || normalizedToken.length > 24 * 1024) throw new Error('Invalid Windsurf login token');
        const generation = this.generation;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.state = 'exchanging';
        try {
            const upstream = await loadWindsurfUpstream();
            const registered = await upstream.registerUser(normalizedToken, DEFAULT_REGION, abortController.signal);
            if (generation !== this.generation || abortController.signal.aborted) throw new Error('Windsurf login transaction was cancelled');
            const credential = validateWindsurfCredential({
                kind: 'browser_oauth',
                apiKey: registered.apiKey,
                createdAt: new Date().toISOString(),
                apiServerUrl: registered.apiServerUrl,
                accountName: registered.name,
            });
            if (!credential) throw new Error('Windsurf returned an invalid credential');
            setProviderCredential(PROVIDER_ID, CREDENTIAL_KIND, credential, credential.apiKey);
            setProviderImportDisabled(PROVIDER_ID, false);
            this.state = 'connected';
            this.error = null;
            clearProviderCredentialRejection(PROVIDER_ID);
            return this.status();
        } catch (error) {
            if (generation === this.generation) {
                this.state = 'error';
                this.error = error instanceof Error ? error.message : String(error);
            }
            throw error;
        } finally {
            if (this.abortController === abortController) this.abortController = null;
            if (generation === this.generation) this.clearTransaction();
        }
    }

    async cancel(): Promise<WindsurfStatus> {
        const exchange = this.exchangeTask;
        this.cancelPending();
        if (exchange) {
            try {
                await exchange;
            } catch {
                this.exchangeTask = null;
            }
        }
        if (!validateWindsurfCredential(getProviderCredential(PROVIDER_ID, CREDENTIAL_KIND))) this.state = 'idle';
        this.error = null;
        return this.status();
    }

    async logout(): Promise<WindsurfStatus> {
        const exchange = this.exchangeTask;
        this.cancelPending();
        if (exchange) {
            try {
                await exchange;
            } catch {
                this.exchangeTask = null;
            }
        }
        deleteProviderCredential(PROVIDER_ID);
        setProviderImportDisabled(PROVIDER_ID, true);
        const upstream = await loadWindsurfUpstream();
        upstream.clearCachedUserJwt();
        upstream.clearSessionIds();
        catalogByAccount.clear();
        this.state = 'idle';
        this.error = null;
        clearProviderCredentialRejection(PROVIDER_ID);
        return this.status();
    }

    markCredentialRejected(message: string): void {
        markProviderCredentialRejected(PROVIDER_ID, message);
        this.state = 'error';
        this.error = message;
        this.clearTransaction();
    }

    markCredentialAccepted(): void {
        if (!getProviderCredentialRejection(PROVIDER_ID)) return;
        clearProviderCredentialRejection(PROVIDER_ID);
        this.state = 'connected';
        this.error = null;
    }

    dispose(): void {
        this.cancelPending();
        this.exchangeTask = null;
        catalogByAccount.clear();
    }

    private clearTransaction(): void {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = null;
        this.authorizationUrl = null;
        this.transactionId = null;
        this.expiresAt = null;
    }

    private cancelPending(): void {
        this.generation += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.localImportConfirmation = null;
        this.clearTransaction();
    }

    private async localImportError(
        code: WindsurfLocalImportError['code'],
        status: WindsurfStatus,
        details: Partial<WindsurfLocalImportError> = {},
    ): Promise<WindsurfLocalImportResult> {
        const message = importErrorMessage(code);
        this.state = code === 'not_found' ? 'idle' : 'error';
        this.error = message;
        return {
            ok: false,
            status: { ...status, state: this.state, error: message },
            source: null,
            accountLabel: null,
            imported: false,
            unchanged: false,
            replaced: false,
            error: { code, message, ...details },
            ...(details.candidates ? { candidates: details.candidates } : {}),
        };
    }
}

export const windsurfController = new WindsurfController();
export const windsurfProviderId = PROVIDER_ID;
export const windsurfCredentialKind = CREDENTIAL_KIND;
