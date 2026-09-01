import { lookup } from 'dns/promises';
import { createHash } from 'crypto';
import { isIP } from 'net';
import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { ManagedTaskError } from '../toolTasks/ManagedTaskExecutor';

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SYNTHETIC_DNS_VERIFY_TIMEOUT_MS = 5_000;

export interface PublicFetchOptions {
    accept?: string;
    maxBodyBytes?: number;
    maxRedirects?: number;
    timeoutMs?: number;
    userAgent?: string;
}

export interface PublicFetchResult {
    requestedUrl: string;
    finalUrl: string;
    status: number;
    headers: IncomingHttpHeaders;
    contentType: string;
    bytes: number;
    body: Buffer;
    decoded: string;
    sha256: string;
}

interface ResolvedPublicAddress {
    address: string;
    family: 4 | 6;
}

function isSyntheticProxyIPv4(address: string): boolean {
    const octets = address.split('.').map(Number);
    return octets.length === 4 && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

function isBlockedIPv4(address: string): boolean {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
    const [a, b] = octets;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0)
        || (a === 192 && b === 2)
        || (a === 192 && b === 168)
        || (a === 192 && b === 88)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51)
        || (a === 203 && b === 0)
        || a >= 224;
}

export function isBlockedAddress(address: string): boolean {
    const normalized = address.toLowerCase().split('%')[0];
    if (isIP(normalized) === 4) return isBlockedIPv4(normalized);
    if (normalized.startsWith('::ffff:')) return true;
    if (isIP(normalized) !== 6) return true;
    return normalized === '::'
        || normalized === '::1'
        || normalized.startsWith('64:ff9b:')
        || normalized.startsWith('100:')
        || normalized.startsWith('2001::')
        || normalized.startsWith('2001:2:')
        || normalized.startsWith('2001:10:')
        || normalized.startsWith('2001:20:')
        || normalized.startsWith('2001:db8:')
        || normalized.startsWith('2002:')
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || /^fe[89ab]/.test(normalized)
        || /^fe[c-f]/.test(normalized)
        || normalized.startsWith('ff');
}

interface DnsJsonAnswer {
    type?: number;
    data?: string;
}

interface DnsJsonResponse {
    Status?: number;
    Answer?: DnsJsonAnswer[];
}

async function fetchVerifiedDnsAddresses(
    endpoint: string,
    hostname: string,
    recordType: 'A' | 'AAAA',
    signal: AbortSignal,
): Promise<string[]> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abortFromParent, { once: true });
    if (signal.aborted) abortFromParent();
    const timer = setTimeout(() => controller.abort(new Error('dns-verification-timeout')), SYNTHETIC_DNS_VERIFY_TIMEOUT_MS);
    try {
        const url = new URL(endpoint);
        url.searchParams.set('name', hostname);
        url.searchParams.set('type', recordType);
        const response = await fetch(url, {
            headers: { Accept: 'application/dns-json' },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`DoH HTTP ${response.status}`);
        const payload = await response.json() as DnsJsonResponse;
        if (payload.Status !== 0) throw new Error(`DoH status ${payload.Status ?? 'unknown'}`);
        return (payload.Answer ?? [])
            .filter(answer => answer.type === 1 || answer.type === 28)
            .map(answer => String(answer.data || '').trim())
            .filter(address => isIP(address) !== 0);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abortFromParent);
    }
}

async function verifySyntheticDnsHostname(hostname: string, signal: AbortSignal): Promise<void> {
    const endpoints = [
        'https://cloudflare-dns.com/dns-query',
        'https://dns.google/resolve',
    ];
    let lastError: unknown;
    for (const endpoint of endpoints) {
        try {
            const addresses = (await Promise.all([
                fetchVerifiedDnsAddresses(endpoint, hostname, 'A', signal),
                fetchVerifiedDnsAddresses(endpoint, hostname, 'AAAA', signal),
            ])).flat();
            if (!addresses.length) throw new Error('DoH returned no public address');
            if (addresses.some(isBlockedAddress)) {
                throw new ManagedTaskError(`域名的公共 DNS 结果指向保留地址: ${hostname}`, 'approval_denied', false);
            }
            return;
        } catch (error) {
            if (signal.aborted) throw error;
            if (error instanceof ManagedTaskError) throw error;
            lastError = error;
        }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError || 'unknown');
    throw new ManagedTaskError(
        `无法独立验证代理 DNS 映射，已安全拒绝访问: ${hostname}`,
        'approval_denied',
        false,
        reason,
    );
}

async function lookupWithAbort(hostname: string, signal: AbortSignal): Promise<ResolvedPublicAddress[]> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        lookup(hostname, { all: true, verbatim: true }).then(
            result => {
                signal.removeEventListener('abort', onAbort);
                resolve(result.map(entry => ({ address: entry.address, family: entry.family as 4 | 6 })));
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

async function resolvePublicHttpUrl(url: URL, signal: AbortSignal): Promise<ResolvedPublicAddress> {
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new ManagedTaskError(`仅允许读取 HTTP(S) URL: ${url.protocol}`, 'approval_denied', false);
    }
    if (url.username || url.password) {
        throw new ManagedTaskError('URL 不允许包含用户名或密码', 'approval_denied', false);
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!hostname || hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) {
        throw new ManagedTaskError(`拒绝访问本机地址: ${url.hostname}`, 'approval_denied', false);
    }
    const addresses = await lookupWithAbort(hostname, signal);
    if (!addresses.length) {
        throw new ManagedTaskError(`拒绝访问本机、局域网或保留地址: ${url.hostname}`, 'approval_denied', false);
    }
    const syntheticAddresses = addresses.filter(entry => isSyntheticProxyIPv4(entry.address));
    if (syntheticAddresses.length) {
        if (isIP(hostname) !== 0 || addresses.some(entry => !isSyntheticProxyIPv4(entry.address) && isBlockedAddress(entry.address))) {
            throw new ManagedTaskError(`拒绝访问本机、局域网或保留地址: ${url.hostname}`, 'approval_denied', false);
        }
        await verifySyntheticDnsHostname(hostname, signal);
        return syntheticAddresses[0] as ResolvedPublicAddress;
    }
    if (addresses.some(entry => isBlockedAddress(entry.address))) {
        throw new ManagedTaskError(`拒绝访问本机、局域网或保留地址: ${url.hostname}`, 'approval_denied', false);
    }
    return addresses[0] as ResolvedPublicAddress;
}

export async function assertPublicHttpUrl(rawUrl: string, signal: AbortSignal): Promise<void> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new ManagedTaskError('URL 格式无效', 'approval_denied', false);
    }
    await resolvePublicHttpUrl(url, signal);
}

export function decodeHtmlEntities(text: string): string {
    const decodeCodePoint = (value: number, fallback: string) => {
        try {
            return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
        } catch {
            return fallback;
        }
    };
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (match, digits: string) => decodeCodePoint(Number(digits), match))
        .replace(/&#x([0-9a-f]+);/gi, (match, digits: string) => decodeCodePoint(Number.parseInt(digits, 16), match));
}

export function htmlToPlainText(html: string): string {
    return decodeHtmlEntities(html
        .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|header|footer|main|aside|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function responseHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

function requestPinned(
    url: URL,
    resolved: ResolvedPublicAddress,
    signal: AbortSignal,
    options: Required<Pick<PublicFetchOptions, 'accept' | 'userAgent'>>,
): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.request({
            protocol: url.protocol,
            hostname: url.hostname.replace(/^\[|\]$/g, ''),
            port: url.port ? Number(url.port) : undefined,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers: { Accept: options.accept, 'User-Agent': options.userAgent },
            signal,
            servername: url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/g, '') : undefined,
            lookup: (_hostname, lookupOptions, callback) => {
                if (typeof lookupOptions === 'object' && lookupOptions.all) {
                    callback(null, [resolved]);
                    return;
                }
                callback(null, resolved.address, resolved.family);
            },
        }, resolve);
        request.once('error', reject);
        request.end();
    });
}

async function readResponseBody(response: IncomingMessage, signal: AbortSignal, maxBodyBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maxBodyBytes) {
            response.destroy();
            throw new ManagedTaskError(`网页响应超过 ${maxBodyBytes} 字节上限`, 'provider', false);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
}

export async function fetchPublicResource(
    requestedUrl: string,
    parentSignal: AbortSignal,
    options: PublicFetchOptions = {},
): Promise<PublicFetchResult> {
    let current: URL;
    try {
        current = new URL(requestedUrl);
    } catch {
        throw new ManagedTaskError(`URL 格式无效: ${requestedUrl}`, 'invalid_result', false);
    }
    const maxRedirects = Math.max(0, Math.min(10, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
    const maxBodyBytes = Math.max(1024, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
    if (parentSignal.aborted) abortFromParent();
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('fetch-timeout'));
    }, timeoutMs);

    try {
        let response: IncomingMessage | null = null;
        for (let redirects = 0; redirects <= maxRedirects; redirects++) {
            const resolved = await resolvePublicHttpUrl(current, controller.signal);
            response = await requestPinned(current, resolved, controller.signal, {
                accept: options.accept ?? 'text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1',
                userAgent: options.userAgent ?? 'Synapse/1.0 (built-in web client)',
            });
            const status = response.statusCode ?? 0;
            if (![301, 302, 303, 307, 308].includes(status)) break;
            const location = responseHeader(response.headers, 'location');
            if (!location) throw new ManagedTaskError(`HTTP ${status} 缺少重定向地址`, 'provider', false);
            if (redirects === maxRedirects) throw new ManagedTaskError(`网页重定向超过 ${maxRedirects} 次`, 'provider', false);
            response.destroy();
            current = new URL(location, current);
        }

        if (!response) throw new ManagedTaskError('网页请求没有返回响应', 'transport', false);
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
            const retryAfter = responseHeader(response.headers, 'retry-after');
            const category = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'http_error';
            response.destroy();
            throw new ManagedTaskError(
                `HTTP 错误 ${status}: 无法访问 ${current.href}`,
                category,
                false,
                `HTTP ${status}: ${current.href}${retryAfter ? `（Retry-After: ${retryAfter}）` : ''}`,
                { httpStatus: status, finalUrl: current.href, retryAfter, category },
            );
        }
        const contentType = responseHeader(response.headers, 'content-type') || 'application/octet-stream';
        const body = await readResponseBody(response, controller.signal, maxBodyBytes);
        const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, '') || 'utf-8';
        let decoded: string;
        try {
            decoded = new TextDecoder(charset).decode(body);
        } catch {
            decoded = new TextDecoder('utf-8').decode(body);
        }
        return {
            requestedUrl,
            finalUrl: current.href,
            status,
            headers: response.headers,
            contentType,
            bytes: body.byteLength,
            body,
            decoded,
            sha256: createHash('sha256').update(body).digest('hex'),
        };
    } catch (error) {
        if (parentSignal.aborted) throw error;
        if (timedOut) throw new ManagedTaskError(`读取网页超过 ${timeoutMs / 1000} 秒`, 'timeout', false);
        if (error instanceof ManagedTaskError) throw error;
        throw new ManagedTaskError(`读取 URL 失败: ${error instanceof Error ? error.message : String(error)}`, 'transport', false);
    } finally {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', abortFromParent);
    }
}
