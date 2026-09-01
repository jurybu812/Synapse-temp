import { safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { getDatabase } from '../database';

export interface ProviderCredentialStatus {
    providerId: string;
    configured: boolean;
    persisted: boolean;
    storage: 'safeStorage' | 'memory' | 'none';
    credentialType: string | null;
    updatedAt: number | null;
    accountFingerprint: string | null;
    credentialGeneration: number;
}

interface StoredCredential {
    version: 1;
    providerId: string;
    kind: string;
    ciphertext: string;
    updatedAt: number;
}

const memoryCredentials = new Map<string, { kind: string; value: unknown; updatedAt: number }>();

interface ApiKeyCredential {
    apiKey: string;
    baseUrl: string;
}

interface ProviderCredentialIdentity {
    version: 1;
    accountFingerprint: string | null;
    credentialGeneration: number;
    updatedAt: number;
}

export interface ProviderCredentialRejection {
    rejectedAt: number;
    message: string;
}

const DEFAULT_PROVIDER_ENDPOINTS: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
};

function normalizeProviderId(providerId: string): string {
    const normalized = String(providerId || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
        throw new Error('Invalid provider id');
    }
    return normalized;
}

function settingKey(providerId: string): string {
    return `providerCredential:${normalizeProviderId(providerId)}`;
}

function importDisabledKey(providerId: string): string {
    return `providerImportDisabled:${normalizeProviderId(providerId)}`;
}

function rejectionKey(providerId: string): string {
    return `providerCredentialRejected:${normalizeProviderId(providerId)}`;
}

function identityKey(providerId: string): string {
    return `providerCredentialIdentity:${normalizeProviderId(providerId)}`;
}

function readCredentialIdentity(providerId: string): ProviderCredentialIdentity {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(identityKey(providerId)) as
        | { value: string }
        | undefined;
    if (row) {
        try {
            const parsed = JSON.parse(row.value) as Partial<ProviderCredentialIdentity>;
            if (parsed.version === 1 && Number.isInteger(parsed.credentialGeneration) && Number(parsed.credentialGeneration) >= 0) {
                return {
                    version: 1,
                    accountFingerprint: typeof parsed.accountFingerprint === 'string' ? parsed.accountFingerprint : null,
                    credentialGeneration: Number(parsed.credentialGeneration),
                    updatedAt: Number(parsed.updatedAt) || 0,
                };
            }
        } catch {
            // Invalid identity metadata is replaced on the next credential mutation.
        }
    }
    return { version: 1, accountFingerprint: null, credentialGeneration: 0, updatedAt: 0 };
}

function credentialIdentityMaterial(kind: string, value: unknown): string {
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.accountId === 'string' && record.accountId) return record.accountId;
        if (typeof record.apiKey === 'string' && record.apiKey) return record.apiKey;
    }
    if (typeof value === 'string') return value;
    return JSON.stringify({ kind, value });
}

function nextCredentialIdentity(
    providerId: string,
    kind: string,
    value: unknown,
    accountIdentity?: string,
): ProviderCredentialIdentity {
    const current = readCredentialIdentity(providerId);
    const material = accountIdentity || credentialIdentityMaterial(kind, value);
    return {
        version: 1,
        accountFingerprint: createHash('sha256')
            .update(`${normalizeProviderId(providerId)}\0${kind}\0${material}`)
            .digest('hex'),
        credentialGeneration: current.credentialGeneration + 1,
        updatedAt: Date.now(),
    };
}

function persistCredentialIdentity(providerId: string, identity: ProviderCredentialIdentity): void {
    getDatabase().prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(identityKey(providerId), JSON.stringify(identity));
}

function supersedePreviousCredentialRequests(providerId: string, identity: ProviderCredentialIdentity): void {
    getDatabase().prepare(`
        UPDATE provider_request_ledger
        SET status = 'superseded'
        WHERE provider_id = ? AND status IN ('started', 'completed')
          AND (
            account_fingerprint IS NULL OR credential_generation IS NULL
            OR account_fingerprint <> ? OR credential_generation <> ?
          )
    `).run(providerId, identity.accountFingerprint, identity.credentialGeneration);
}

function statusWithIdentity(
    status: Omit<ProviderCredentialStatus, 'accountFingerprint' | 'credentialGeneration'>,
): ProviderCredentialStatus {
    const identity = readCredentialIdentity(status.providerId);
    return { ...status, accountFingerprint: identity.accountFingerprint, credentialGeneration: identity.credentialGeneration };
}

export function getProviderCredentialRejection(providerId: string): ProviderCredentialRejection | null {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(rejectionKey(providerId)) as
        | { value: string }
        | undefined;
    if (!row) return null;
    try {
        const value = JSON.parse(row.value) as Partial<ProviderCredentialRejection>;
        if (!Number.isFinite(value.rejectedAt) || typeof value.message !== 'string') return null;
        return { rejectedAt: Number(value.rejectedAt), message: value.message.slice(0, 512) };
    } catch {
        return null;
    }
}

export function markProviderCredentialRejected(providerId: string, message: string): ProviderCredentialRejection {
    const value = { rejectedAt: Date.now(), message: String(message || 'Provider credential was rejected').slice(0, 512) };
    getDatabase().prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(rejectionKey(providerId), JSON.stringify(value));
    return value;
}

export function clearProviderCredentialRejection(providerId: string): void {
    getDatabase().prepare('DELETE FROM settings WHERE key = ?').run(rejectionKey(providerId));
}

export function isProviderImportDisabled(providerId: string): boolean {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(importDisabledKey(providerId)) as
        | { value: string }
        | undefined;
    return row?.value === '1';
}

export function setProviderImportDisabled(providerId: string, disabled: boolean): void {
    const key = importDisabledKey(providerId);
    if (!disabled) {
        getDatabase().prepare('DELETE FROM settings WHERE key = ?').run(key);
        return;
    }
    getDatabase().prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, '1');
}

export function normalizeProviderBaseUrl(value: string): string {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Provider endpoint must use HTTP(S)');
    if (parsed.username || parsed.password) throw new Error('Provider endpoint must not contain credentials');
    if (parsed.hash) throw new Error('Provider endpoint must not contain a URL fragment');
    const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase());
    if (parsed.protocol === 'http:' && !isLoopback) throw new Error('Provider endpoint must use HTTPS unless it is local');
    return parsed.toString().replace(/\/$/, '');
}

function readStored(providerId: string): StoredCredential | null {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(settingKey(providerId)) as
        | { value: string }
        | undefined;
    if (!row) return null;
    try {
        const parsed = JSON.parse(row.value) as StoredCredential;
        if (parsed?.version !== 1 || typeof parsed.kind !== 'string' || !parsed.kind || !parsed.ciphertext) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function setProviderCredential(
    providerId: string,
    kind: string,
    value: unknown,
    accountIdentity?: string,
): ProviderCredentialStatus {
    const normalized = normalizeProviderId(providerId);
    const credentialKind = String(kind || '').trim();
    if (!credentialKind) throw new Error('Invalid credential type');

    const updatedAt = Date.now();
    const identity = nextCredentialIdentity(normalized, credentialKind, value, accountIdentity);
    if (!safeStorage.isEncryptionAvailable()) {
        const database = getDatabase();
        database.transaction(() => {
            database.prepare('DELETE FROM settings WHERE key = ?').run(rejectionKey(normalized));
            persistCredentialIdentity(normalized, identity);
            supersedePreviousCredentialRequests(normalized, identity);
        })();
        memoryCredentials.set(normalized, { kind: credentialKind, value: structuredClone(value), updatedAt });
        return statusWithIdentity({ providerId: normalized, configured: true, persisted: false, storage: 'memory', credentialType: credentialKind, updatedAt });
    }

    const stored: StoredCredential = {
        version: 1,
        providerId: normalized,
        kind: credentialKind,
        ciphertext: safeStorage.encryptString(JSON.stringify({ kind: credentialKind, value })).toString('base64'),
        updatedAt,
    };
    const database = getDatabase();
    database.transaction(() => {
        database.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        ).run(settingKey(normalized), JSON.stringify(stored));
        database.prepare('DELETE FROM settings WHERE key = ?').run(rejectionKey(normalized));
        persistCredentialIdentity(normalized, identity);
        supersedePreviousCredentialRequests(normalized, identity);
    })();
    memoryCredentials.delete(normalized);
    return statusWithIdentity({ providerId: normalized, configured: true, persisted: true, storage: 'safeStorage', credentialType: credentialKind, updatedAt });
}

export function getProviderCredential<T = unknown>(providerId: string, expectedKind?: string): T | null {
    const normalized = normalizeProviderId(providerId);
    const memory = memoryCredentials.get(normalized);
    if (memory) {
        if (expectedKind && memory.kind !== expectedKind) return null;
        return structuredClone(memory.value) as T;
    }

    const stored = readStored(normalized);
    if (expectedKind && stored?.kind !== expectedKind) return null;
    if (!stored || !safeStorage.isEncryptionAvailable()) return null;
    try {
        const plaintext = safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'));
        try {
            const envelope = JSON.parse(plaintext) as { kind?: string; value?: T };
            if (envelope?.kind === stored.kind && 'value' in envelope) return structuredClone(envelope.value) as T;
        } catch {
            if (stored.kind === 'api-key') return plaintext as T;
        }
        return null;
    } catch {
        return null;
    }
}

export function setProviderApiKey(providerId: string, apiKey: string, baseUrl?: string): ProviderCredentialStatus {
    const normalizedProviderId = normalizeProviderId(providerId);
    const value = String(apiKey || '').trim();
    if (!value) return deleteProviderCredential(normalizedProviderId);
    const endpoint = normalizeProviderBaseUrl(baseUrl || DEFAULT_PROVIDER_ENDPOINTS[normalizedProviderId] || '');
    return setProviderCredential(normalizedProviderId, 'api-key', { apiKey: value, baseUrl: endpoint } satisfies ApiKeyCredential, value);
}

export function getProviderApiKey(providerId: string): string | null {
    const credential = getProviderCredential<ApiKeyCredential | string>(providerId, 'api-key');
    if (typeof credential === 'string') return credential.trim() || null;
    return typeof credential?.apiKey === 'string' ? credential.apiKey.trim() || null : null;
}

export function getProviderBaseUrl(providerId: string): string | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    const credential = getProviderCredential<ApiKeyCredential | string>(normalizedProviderId, 'api-key');
    if (credential && typeof credential === 'object' && typeof credential.baseUrl === 'string') {
        try {
            return normalizeProviderBaseUrl(credential.baseUrl);
        } catch {
            return null;
        }
    }
    return DEFAULT_PROVIDER_ENDPOINTS[normalizedProviderId] ?? null;
}

export function getProviderCredentialStatus(providerId: string): ProviderCredentialStatus {
    const normalized = normalizeProviderId(providerId);
    const rejected = Boolean(getProviderCredentialRejection(normalized));
    const memory = memoryCredentials.get(normalized);
    if (memory) {
        return statusWithIdentity({
            providerId: normalized,
            configured: !rejected,
            persisted: false,
            storage: 'memory',
            credentialType: memory.kind,
            updatedAt: memory.updatedAt,
        });
    }

    const stored = readStored(normalized);
    const available = Boolean(stored && safeStorage.isEncryptionAvailable() && getProviderCredential(normalized, stored.kind));
    if (available && readCredentialIdentity(normalized).credentialGeneration === 0) {
        const value = getProviderCredential(normalized, stored?.kind);
        const identity = nextCredentialIdentity(normalized, stored?.kind ?? 'unknown', value);
        persistCredentialIdentity(normalized, identity);
        supersedePreviousCredentialRequests(normalized, identity);
    }
    return statusWithIdentity({
        providerId: normalized,
        configured: available && !rejected,
        persisted: available,
        storage: available ? 'safeStorage' : 'none',
        credentialType: available ? stored?.kind ?? null : null,
        updatedAt: stored?.updatedAt ?? null,
    });
}

export function deleteProviderCredential(providerId: string): ProviderCredentialStatus {
    const normalized = normalizeProviderId(providerId);
    const current = readCredentialIdentity(normalized);
    const identity: ProviderCredentialIdentity = {
        version: 1,
        accountFingerprint: null,
        credentialGeneration: current.credentialGeneration + 1,
        updatedAt: Date.now(),
    };
    const database = getDatabase();
    database.transaction(() => {
        database.prepare('DELETE FROM settings WHERE key = ?').run(settingKey(normalized));
        database.prepare('DELETE FROM settings WHERE key = ?').run(rejectionKey(normalized));
        persistCredentialIdentity(normalized, identity);
        supersedePreviousCredentialRequests(normalized, identity);
    })();
    memoryCredentials.delete(normalized);
    return statusWithIdentity({ providerId: normalized, configured: false, persisted: false, storage: 'none', credentialType: null, updatedAt: null });
}

export function migrateLegacyProviderCredentials(): ProviderCredentialStatus[] {
    const row = getDatabase().prepare("SELECT value FROM settings WHERE key = 'apiKeys'").get() as
        | { value: string }
        | undefined;
    if (!row || !safeStorage.isEncryptionAvailable()) return [];

    let legacy: Record<string, unknown> | null = null;
    try {
        const decrypted = safeStorage.decryptString(Buffer.from(row.value, 'base64'));
        legacy = JSON.parse(decrypted) as Record<string, unknown>;
    } catch {
        try {
            legacy = JSON.parse(row.value) as Record<string, unknown>;
        } catch {
            legacy = null;
        }
    }
    if (!legacy || typeof legacy !== 'object') return [];

    const migrated: ProviderCredentialStatus[] = [];
    for (const [providerId, value] of Object.entries(legacy)) {
        if (typeof value !== 'string' || !value.trim()) continue;
        if (getProviderCredentialStatus(providerId).configured) continue;
        migrated.push(setProviderApiKey(providerId, value, DEFAULT_PROVIDER_ENDPOINTS[providerId]));
    }
    if (migrated.length > 0 && migrated.every(status => status.persisted)) {
        getDatabase().prepare("DELETE FROM settings WHERE key = 'apiKeys'").run();
    }
    return migrated;
}

export function clearMemoryCredentials(): void {
    memoryCredentials.clear();
}
