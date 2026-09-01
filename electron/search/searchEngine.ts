import { ManagedTaskError } from '../toolTasks/ManagedTaskExecutor';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { assertPublicHttpUrl, fetchPublicResource, htmlToPlainText, isBlockedAddress, type PublicFetchOptions, type PublicFetchResult } from '../web/publicFetch';
import {
    buildSearchCitations,
    canonicalizeSearchUrl,
    dedupeAndRankSearchHits,
    extractSearchSiteTargets,
    normalizeSearchRequest,
    tokenizeSearch,
    type SearchDocument,
    type SearchHit,
    type SearchProviderState,
    type SearchRequest,
    type SearchResponse,
} from './contracts';

export type SearchResourceFetcher = (
    url: string,
    signal: AbortSignal,
    options?: PublicFetchOptions,
) => Promise<PublicFetchResult>;

interface ProviderRun {
    provider: string;
    hits: SearchHit[];
    state: SearchProviderState;
}

interface ProviderCooldown {
    until: number;
    status: SearchProviderState['status'];
    error: string;
}

const PROVIDER_NAMES = ['searxng', 'wikipedia', 'openalex', 'crossref', 'npm'] as const;

const OFFICIAL_PATH_HINTS = [
    { pattern: /\belectron\b[\s\S]*\bsafe\s*storage\b|\bsafestorage\b[\s\S]*\belectron\b/i, domain: 'electronjs.org', url: 'https://www.electronjs.org/docs/latest/api/safe-storage', title: 'Electron safeStorage API' },
    { pattern: /\breact\b[\s\S]*\buseeffect\b|\buseeffect\b[\s\S]*\breact\b/i, domain: 'react.dev', url: 'https://react.dev/reference/react/useEffect', title: 'React useEffect reference' },
    { pattern: /\bpython\b[\s\S]*\basyncio\b[\s\S]*\btaskgroup\b|\btaskgroup\b[\s\S]*\basyncio\b/i, domain: 'docs.python.org', url: 'https://docs.python.org/3/library/asyncio-task.html#task-groups', title: 'Python asyncio TaskGroup' },
] as const;

function inferOfficialHints(query: string): { domains: string[]; hits: SearchHit[] } {
    const domains = new Set<string>();
    const hasExplicitProductVersion = /\b(?:electron|react|python)\s+v?\d+(?:\.\d+)*/i.test(query);
    const candidates = hasExplicitProductVersion
        ? []
        : OFFICIAL_PATH_HINTS.filter(candidate => candidate.pattern.test(query));
    if (/\bopenai\b|chatgpt|gpt-[\w.-]+/i.test(query)) {
        domains.add('openai.com');
        domains.add('platform.openai.com');
    }
    if (/国家网信办|网信办|生成式人工智能服务.*备案/u.test(query)) domains.add('cac.gov.cn');
    if (/工业和信息化部|工信部/u.test(query)) domains.add('miit.gov.cn');
    if (/国家卫生健康委|国家卫健委/u.test(query)) domains.add('nhc.gov.cn');
    for (const candidate of candidates) domains.add(candidate.domain);
    return {
        domains: [...domains],
        hits: candidates.map((candidate, index) => hit({
            id: `official-path:${candidate.url}`,
            provider: 'official-path',
            providerRank: index + 1,
            providerScore: 1.25,
            url: candidate.url,
            title: candidate.title,
            snippet: '根据高置信产品文档路径生成的正文校验候选；只有抓取成功并匹配查询后才可引用。',
            publishedAt: null,
            license: null,
            attribution: candidate.domain,
            metadata: { source: 'verified-path-hint' },
        })),
    };
}

function stripMarkup(value: unknown): string {
    return htmlToPlainText(String(value ?? '')).slice(0, 1200);
}

function inferredLanguage(query: string, declared: 'auto' | 'zh' | 'en'): 'zh' | 'en' {
    if (declared !== 'auto') return declared;
    return /[\u3400-\u9fff]/u.test(query) ? 'zh' : 'en';
}

function publishedDate(value: unknown): string | null {
    if (!value) return null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function datePartsToIso(value: any): string | null {
    const parts = value?.['date-parts']?.[0];
    if (!Array.isArray(parts) || !parts.length) return null;
    const [year, month = 1, day = 1] = parts;
    return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function openAlexAbstract(inverted: unknown): string {
    if (!inverted || typeof inverted !== 'object') return '';
    const words: string[] = [];
    for (const [word, positions] of Object.entries(inverted as Record<string, unknown>)) {
        if (!Array.isArray(positions)) continue;
        for (const position of positions) if (Number.isInteger(position)) words[Number(position)] = word;
    }
    return words.filter(Boolean).join(' ');
}

function licenseFor(provider: string, title?: string): { license: string | null; attribution: string | null } {
    if (provider === 'wikipedia') return { license: 'CC BY-SA 4.0', attribution: title ? `Wikipedia contributors: ${title}` : 'Wikipedia contributors' };
    if (provider === 'openalex') return { license: 'CC0 metadata', attribution: 'OpenAlex' };
    return { license: null, attribution: provider };
}

function hit(input: Omit<SearchHit, 'canonicalUrl' | 'retrievedAt' | 'verified' | 'contentStatus' | 'contentError' | 'evidenceStatus'>): SearchHit {
    return {
        ...input,
        canonicalUrl: canonicalizeSearchUrl(input.url),
        retrievedAt: new Date().toISOString(),
        verified: false,
        contentStatus: 'not_requested',
        evidenceStatus: 'not_requested',
    };
}

function hasStrongOfficialHit(query: string, hits: SearchHit[], officialDomains: string[]): boolean {
    if (!officialDomains.length) return true;
    const terms = tokenizeSearch(query.replace(/(?:^|\s)site:[^\s]+/gi, ' '));
    if (!terms.length) return true;
    const acronymTerms = new Set((query.match(/\b[A-Z][A-Z0-9-]{2,}\b/g) ?? []).map(term => term.toLowerCase()));
    return hits.some(item => {
        let hostname = '';
        try {
            hostname = new URL(item.canonicalUrl).hostname.toLowerCase();
        } catch {
            return false;
        }
        if (!officialDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return false;
        const haystack = `${item.title} ${item.snippet} ${item.canonicalUrl}`.toLowerCase();
        const matched = terms.filter(term => haystack.includes(term));
        return matched.some(term => acronymTerms.has(term)) || matched.length / terms.length >= 0.5;
    });
}

function isAllowedSearchResultUrl(value: string): boolean {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
        const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
        return isIP(hostname) === 0 || !isBlockedAddress(hostname);
    } catch {
        return false;
    }
}

function classifyProviderError(provider: string, error: unknown, latencyMs: number): SearchProviderState {
    const managed = error instanceof ManagedTaskError ? error : null;
    const structured = managed?.structured as { httpStatus?: number; retryAfter?: string | null } | undefined;
    const status = structured?.httpStatus;
    const providerStatus = status === 401 || status === 403
        ? 'unauthorized'
        : status === 402
            ? 'quota_exhausted'
            : status === 429 || managed?.code === 'rate_limit'
                ? 'rate_limited'
                : managed?.code === 'timeout'
                    ? 'timeout'
                    : managed?.code === 'server_error' || managed?.code === 'transport'
                        ? 'unavailable'
                        : 'error';
    return {
        provider,
        status: providerStatus,
        scope: 'process-provider',
        latencyMs,
        hitCount: 0,
        error: managed?.message ?? (error instanceof Error ? error.message : String(error)),
        retryAfter: structured?.retryAfter ?? null,
    };
}

export class SearchEngine {
    private readonly providerCooldowns = new Map<string, ProviderCooldown>();
    private readonly endpointCooldowns = new Map<string, ProviderCooldown>();
    private readonly endpointFailures = new Map<string, number>();
    private readonly consecutiveFailures = new Map<string, number>();

    private readonly validateResultUrl: (url: string, signal: AbortSignal) => Promise<void>;

    constructor(
        private readonly fetcher: SearchResourceFetcher = fetchPublicResource,
        private readonly searxngUrls: string[] = (process.env.SYNAPSE_SEARCH_SEARXNG_URL || 'https://search.mectov.my.id/')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean),
        validateResultUrl?: (url: string, signal: AbortSignal) => Promise<void>,
    ) {
        this.validateResultUrl = validateResultUrl
            ?? (fetcher === fetchPublicResource ? assertPublicHttpUrl : async () => undefined);
    }

    private async filterPublicResultUrls(hits: SearchHit[], signal: AbortSignal): Promise<SearchHit[]> {
        const allowedBySyntax = hits.filter(item => isAllowedSearchResultUrl(item.canonicalUrl || item.url));
        const hosts = [...new Set(allowedBySyntax.map(item => new URL(item.canonicalUrl || item.url).hostname.toLowerCase()))];
        const allowedHosts = new Map<string, boolean>();
        let cursor = 0;
        const worker = async () => {
            while (cursor < hosts.length) {
                const host = hosts[cursor++];
                try {
                    await this.validateResultUrl(`https://${host}/`, signal);
                    allowedHosts.set(host, true);
                } catch {
                    allowedHosts.set(host, false);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, hosts.length) }, () => worker()));
        return allowedBySyntax.filter(item => {
            const host = new URL(item.canonicalUrl || item.url).hostname.toLowerCase();
            return allowedHosts.get(host) === true;
        });
    }

    async search(input: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
        const normalizedRequest = normalizeSearchRequest(input);
        const officialHints = inferOfficialHints(normalizedRequest.query);
        const request = {
            ...normalizedRequest,
            officialDomains: [...new Set([...normalizedRequest.officialDomains, ...officialHints.domains])],
        };
        const language = inferredLanguage(request.query, request.language);
        const academic = /(paper|doi|arxiv|journal|论文|文献|研究|学术)/i.test(request.query);
        const packageQuery = /(npm|node\.?js|package|javascript|typescript|依赖|包)/i.test(request.query);
        const selected = new Set<string>(['searxng', 'wikipedia']);
        if (academic) {
            selected.add('openalex');
            selected.add('crossref');
        }
        if (packageQuery) selected.add('npm');

        const directTargets = extractSearchSiteTargets(request.query).filter(target => Boolean(target.path));
        const directHits = directTargets.map((target, index) => hit({
            id: `query-direct:https://${target.domain}${target.path}`,
            provider: 'query-direct',
            providerRank: index + 1,
            providerScore: 1,
            url: `https://${target.domain}${target.path}`,
            title: `${target.domain}${target.path.replace(/[-_/]+/g, ' ')}`,
            snippet: '查询中的 site: 精确路径，作为直接正文校验候选。',
            publishedAt: null,
            license: null,
            attribution: '用户查询中的 site: 目标',
            metadata: { source: 'site-operator' },
        }));

        const runs = await Promise.all(PROVIDER_NAMES.map(provider => {
            if (!selected.has(provider)) return Promise.resolve<ProviderRun>({
                provider,
                hits: [],
                state: { provider, status: 'skipped', scope: 'process-provider', latencyMs: 0, hitCount: 0 },
            });
            if (provider === 'searxng') return this.searxng(request.query, language, request.maxResults, signal, request.officialDomains);
            if (provider === 'wikipedia') return this.wikipedia(request.query, language, request.maxResults, signal);
            if (provider === 'openalex') return this.openAlex(request.query, request.maxResults, signal);
            if (provider === 'crossref') return this.crossref(request.query, request.maxResults, signal);
            return this.npm(request.query, request.maxResults, signal);
        }));
        const discoveredHits = [...directHits, ...officialHints.hits, ...runs.flatMap(run => run.hits)];
        const rawHits = await this.filterPublicResultUrls(discoveredHits, signal);
        const unsafeFilteredCount = discoveredHits.length - rawHits.length;
        const ranking = dedupeAndRankSearchHits(request, rawHits);
        const ranked = ranking.hits;
        const requestedDocuments = ranked.slice(0, request.fetchTop);
        const { documents, failures } = await this.fetchDocuments(requestedDocuments, signal);
        const verifiedIds = new Set(documents.map(document => document.sourceId));
        const requestedIds = new Set(requestedDocuments.map(item => item.id));
        const citations = buildSearchCitations(request.query, documents, 3);
        const citedIds = new Set(citations.map(citation => citation.sourceId));
        const hits = ranked.map(item => ({
            ...item,
            verified: verifiedIds.has(item.id),
            contentStatus: verifiedIds.has(item.id)
                ? 'verified' as const
                : requestedIds.has(item.id)
                    ? 'failed' as const
                    : 'not_requested' as const,
            ...(failures.get(item.id) ? { contentError: failures.get(item.id) } : {}),
            evidenceStatus: citedIds.has(item.id)
                ? 'cited' as const
                : verifiedIds.has(item.id)
                    ? 'read_no_citation' as const
                    : requestedIds.has(item.id)
                        ? 'failed' as const
                        : 'not_requested' as const,
        }));
        return {
            schemaVersion: 1,
            query: request.query,
            mode: 'public-best-effort',
            retrievedAt: new Date().toISOString(),
            hits,
            documents,
            citations,
            providers: [
                {
                    provider: 'query-direct',
                    status: directHits.length ? 'success' : 'skipped',
                    scope: 'request',
                    latencyMs: 0,
                    hitCount: directHits.length,
                },
                ...runs.map(run => run.state),
            ],
            diagnostics: {
                rawHitCount: rawHits.length,
                deduplicatedHitCount: hits.length,
                duplicateCount: ranking.duplicateCount,
                filteredCount: ranking.filteredCount + unsafeFilteredCount,
                documentCount: documents.length,
                citationCount: citations.length,
            },
        };
    }

    private async fetchJson(provider: string, url: string, signal: AbortSignal): Promise<{ json: any; latencyMs: number }> {
        const startedAt = Date.now();
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const resource = await this.fetcher(url, signal, {
                    accept: 'application/json',
                    maxBodyBytes: 2 * 1024 * 1024,
                    timeoutMs: 10_000,
                    userAgent: 'Synapse/1.0 (search; best-effort public sources)',
                });
                return { json: JSON.parse(resource.decoded), latencyMs: Date.now() - startedAt };
            } catch (error) {
                lastError = error;
                if (signal.aborted) throw error;
                const managed = error instanceof ManagedTaskError ? error : null;
                if (attempt > 0 || !['timeout', 'transport', 'server_error'].includes(managed?.code ?? '')) break;
                await this.waitForRetry(signal, 250);
            }
        }
        throw lastError ?? new Error(`${provider} failed`);
    }

    private waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
        if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => signal.removeEventListener('abort', onAbort);
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, delayMs);
            const onAbort = () => {
                clearTimeout(timer);
                cleanup();
                reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    private async providerRun(provider: string, signal: AbortSignal, operation: () => Promise<SearchHit[]>): Promise<ProviderRun> {
        const cooldown = this.providerCooldowns.get(provider);
        if (cooldown && cooldown.until > Date.now()) {
            return {
                provider,
                hits: [],
                state: {
                    provider,
                    status: cooldown.status,
                    scope: 'process-provider',
                    latencyMs: 0,
                    hitCount: 0,
                    error: cooldown.error,
                    retryAfter: String(Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000))),
                },
            };
        }
        if (cooldown) this.providerCooldowns.delete(provider);
        const startedAt = Date.now();
        try {
            const hits = await operation();
            this.consecutiveFailures.delete(provider);
            return {
                provider,
                hits,
                state: { provider, status: hits.length ? 'success' : 'empty', scope: 'process-provider', latencyMs: Date.now() - startedAt, hitCount: hits.length },
            };
        } catch (error) {
            if (signal.aborted) throw error;
            const state = classifyProviderError(provider, error, Date.now() - startedAt);
            if (state.status === 'unauthorized' || state.status === 'quota_exhausted') {
                this.providerCooldowns.set(provider, {
                    until: Date.now() + (state.status === 'quota_exhausted' ? 5 * 60_000 : 60_000),
                    status: state.status,
                    error: state.error || `${provider} 暂时不可用`,
                });
            } else if (state.status === 'rate_limited') {
                this.providerCooldowns.set(provider, {
                    until: Date.now() + this.retryAfterMs(state.retryAfter),
                    status: state.status,
                    error: state.error || `${provider} 正在限流冷却`,
                });
            } else if (state.status === 'timeout' || state.status === 'unavailable') {
                const failures = (this.consecutiveFailures.get(provider) ?? 0) + 1;
                this.consecutiveFailures.set(provider, failures);
                if (failures >= 2) {
                    this.providerCooldowns.set(provider, {
                        until: Date.now() + 30_000,
                        status: 'unavailable',
                        error: `${provider} 连续失败 ${failures} 次，已短暂熔断`,
                    });
                }
            }
            return { provider, hits: [], state };
        }
    }

    private retryAfterMs(value?: string | null): number {
        if (!value) return 60_000;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(1_000, Math.min(15 * 60_000, seconds * 1000));
        const retryAt = Date.parse(value);
        return Number.isFinite(retryAt)
            ? Math.max(1_000, Math.min(15 * 60_000, retryAt - Date.now()))
            : 60_000;
    }

    private noteEndpointFailure(baseUrl: string, state: SearchProviderState): void {
        if (state.status === 'rate_limited' || state.status === 'unauthorized' || state.status === 'quota_exhausted') {
            const duration = state.status === 'rate_limited'
                ? this.retryAfterMs(state.retryAfter)
                : state.status === 'quota_exhausted' ? 5 * 60_000 : 60_000;
            this.endpointCooldowns.set(baseUrl, {
                until: Date.now() + duration,
                status: state.status,
                error: state.error || `${baseUrl} 暂时不可用`,
            });
            return;
        }
        if (state.status === 'timeout' || state.status === 'unavailable') {
            const failures = (this.endpointFailures.get(baseUrl) ?? 0) + 1;
            this.endpointFailures.set(baseUrl, failures);
            this.endpointCooldowns.set(baseUrl, {
                until: Date.now() + 30_000,
                status: 'unavailable',
                error: `${baseUrl} ${state.status === 'timeout' ? '请求超时' : '暂时不可用'}，已冷却 30 秒`,
            });
        }
    }

    private searxng(
        query: string,
        language: 'zh' | 'en',
        limit: number,
        signal: AbortSignal,
        officialDomains: string[],
    ): Promise<ProviderRun> {
        return this.providerRun('searxng', signal, async () => {
            let lastError: unknown;
            for (const baseUrl of this.searxngUrls) {
                const cooldown = this.endpointCooldowns.get(baseUrl);
                if (cooldown && cooldown.until > Date.now()) {
                    lastError = new ManagedTaskError(
                        cooldown.error,
                        cooldown.status === 'rate_limited' ? 'rate_limit' : 'provider',
                        false,
                        cooldown.error,
                        { retryAfter: String(Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000))) },
                    );
                    continue;
                }
                if (cooldown) this.endpointCooldowns.delete(baseUrl);
                try {
                    const runQuery = async (searchQuery: string, queryVariant: string) => {
                        const endpoint = new URL('search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
                        endpoint.searchParams.set('q', searchQuery);
                        endpoint.searchParams.set('format', 'json');
                        endpoint.searchParams.set('language', language === 'zh' ? 'zh-CN' : 'en');
                        endpoint.searchParams.set('safesearch', '1');
                        const { json } = await this.fetchJson('searxng', endpoint.toString(), signal);
                        return (Array.isArray(json?.results) ? json.results : []).slice(0, limit).map((item: any, index: number) => hit({
                            id: `searxng:${item.url}`,
                            provider: 'searxng',
                            providerRank: index + 1,
                            providerScore: Number(item.score) || 1 / (index + 1),
                            url: String(item.url),
                            title: String(item.title || item.url),
                            snippet: stripMarkup(item.content),
                            publishedAt: publishedDate(item.publishedDate),
                            license: null,
                            attribution: String(item.engine || 'SearXNG'),
                            metadata: { engine: item.engine ?? null, engines: item.engines ?? [], queryVariant },
                        }));
                    };
                    const primaryHits = await runQuery(query, 'primary');
                    this.endpointFailures.delete(baseUrl);
                    if (hasStrongOfficialHit(query, primaryHits, officialDomains)) return primaryHits;

                    const officialHits: SearchHit[] = [];
                    for (const domain of officialDomains.slice(0, 2)) {
                        try {
                            officialHits.push(...await runQuery(`site:${domain} ${query}`, `official:${domain}`));
                        } catch (error) {
                            if (signal.aborted) throw error;
                            const state = classifyProviderError('searxng', error, 0);
                            this.noteEndpointFailure(baseUrl, state);
                            lastError = error;
                            break;
                        }
                    }
                    if (primaryHits.length || officialHits.length) return [...primaryHits, ...officialHits];
                    if (lastError) throw lastError;
                    return [];
                } catch (error) {
                    if (signal.aborted) throw error;
                    const state = classifyProviderError('searxng', error, 0);
                    this.noteEndpointFailure(baseUrl, state);
                    lastError = error;
                }
            }
            throw lastError ?? new ManagedTaskError('没有可用的 SearXNG endpoint', 'unavailable', false);
        });
    }

    private wikipedia(query: string, language: 'zh' | 'en', limit: number, signal: AbortSignal): Promise<ProviderRun> {
        return this.providerRun('wikipedia', signal, async () => {
            const endpoint = new URL(`https://${language}.wikipedia.org/w/api.php`);
            endpoint.searchParams.set('action', 'query');
            endpoint.searchParams.set('list', 'search');
            endpoint.searchParams.set('srsearch', query);
            endpoint.searchParams.set('srlimit', String(limit));
            endpoint.searchParams.set('format', 'json');
            endpoint.searchParams.set('formatversion', '2');
            const { json } = await this.fetchJson('wikipedia', endpoint.toString(), signal);
            return (Array.isArray(json?.query?.search) ? json.query.search : []).map((item: any, index: number) => {
                const licensing = licenseFor('wikipedia', item.title);
                return hit({
                    id: `wikipedia:${language}:${item.pageid}`,
                    provider: 'wikipedia',
                    providerRank: index + 1,
                    providerScore: 1 / (index + 1),
                    url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/ /g, '_'))}`,
                    title: String(item.title),
                    snippet: stripMarkup(item.snippet),
                    publishedAt: null,
                    ...licensing,
                    metadata: { wordCount: item.wordcount ?? null },
                });
            });
        });
    }

    private openAlex(query: string, limit: number, signal: AbortSignal): Promise<ProviderRun> {
        return this.providerRun('openalex', signal, async () => {
            const endpoint = new URL('https://api.openalex.org/works');
            endpoint.searchParams.set('search', query);
            endpoint.searchParams.set('per-page', String(limit));
            const { json } = await this.fetchJson('openalex', endpoint.toString(), signal);
            return (Array.isArray(json?.results) ? json.results : []).map((item: any, index: number) => hit({
                id: `openalex:${item.id}`,
                provider: 'openalex',
                providerRank: index + 1,
                providerScore: Number(item.relevance_score) || 1 / (index + 1),
                url: String(item.doi || item.primary_location?.landing_page_url || item.id),
                title: String(item.display_name || item.title || item.id),
                snippet: openAlexAbstract(item.abstract_inverted_index).slice(0, 1200),
                publishedAt: publishedDate(item.publication_date),
                ...licenseFor('openalex'),
                metadata: { openAlexId: item.id, publicationYear: item.publication_year ?? null },
            }));
        });
    }

    private crossref(query: string, limit: number, signal: AbortSignal): Promise<ProviderRun> {
        return this.providerRun('crossref', signal, async () => {
            const endpoint = new URL('https://api.crossref.org/works');
            endpoint.searchParams.set('query.bibliographic', query);
            endpoint.searchParams.set('rows', String(limit));
            const { json } = await this.fetchJson('crossref', endpoint.toString(), signal);
            return (Array.isArray(json?.message?.items) ? json.message.items : []).map((item: any, index: number) => hit({
                id: `crossref:${item.DOI || item.URL}`,
                provider: 'crossref',
                providerRank: index + 1,
                providerScore: Number(item.score) || 1 / (index + 1),
                url: String(item.URL || `https://doi.org/${item.DOI}`),
                title: String(item.title?.[0] || item['container-title']?.[0] || item.DOI),
                snippet: stripMarkup(item.abstract || (item.subject || []).join('; ')),
                publishedAt: datePartsToIso(item.published || item.created),
                license: null,
                attribution: 'Crossref metadata',
                metadata: { doi: item.DOI ?? null, type: item.type ?? null },
            }));
        });
    }

    private npm(query: string, limit: number, signal: AbortSignal): Promise<ProviderRun> {
        return this.providerRun('npm', signal, async () => {
            const endpoint = new URL('https://registry.npmjs.org/-/v1/search');
            endpoint.searchParams.set('text', query.slice(0, 200));
            endpoint.searchParams.set('size', String(limit));
            const { json } = await this.fetchJson('npm', endpoint.toString(), signal);
            return (Array.isArray(json?.objects) ? json.objects : []).map((item: any, index: number) => hit({
                id: `npm:${item.package?.name}`,
                provider: 'npm',
                providerRank: index + 1,
                providerScore: Number(item.score?.final) || 1 / (index + 1),
                url: String(item.package?.links?.repository || item.package?.links?.npm || `https://www.npmjs.com/package/${item.package?.name}`),
                title: String(item.package?.name),
                snippet: String(item.package?.description || ''),
                publishedAt: publishedDate(item.package?.date),
                license: null,
                attribution: 'npm registry metadata',
                metadata: { version: item.package?.version ?? null },
            }));
        });
    }

    private async fetchDocuments(hits: SearchHit[], signal: AbortSignal): Promise<{
        documents: SearchDocument[];
        failures: Map<string, string>;
    }> {
        const settled = await Promise.allSettled(hits.map(async item => {
            const resource = await this.fetcher(item.canonicalUrl, signal, {
                timeoutMs: 12_000,
                maxBodyBytes: 2 * 1024 * 1024,
                userAgent: 'Synapse/1.0 (search document verifier)',
            });
            if (!/^text\//i.test(resource.contentType) && !/(json|xml|xhtml|javascript)/i.test(resource.contentType)) {
                throw new ManagedTaskError(`正文类型不可读: ${resource.contentType}`, 'unsupported', false);
            }
            const extracted = /html|xhtml/i.test(resource.contentType)
                ? htmlToPlainText(resource.decoded)
                : resource.decoded.trim();
            const warnings = ['untrusted_web_content'];
            if (extracted.length > 20_000) warnings.push('content_truncated');
            if (/(ignore (all )?(previous|prior) instructions|system prompt|忽略.{0,8}(之前|以上).{0,8}(指令|提示)|系统提示词)/i.test(extracted)) {
                warnings.push('possible_prompt_injection');
            }
            if (extracted.length < 200 && /<script\b/i.test(resource.decoded)) warnings.push('javascript_required');
            return {
                sourceId: item.id,
                provider: item.provider,
                url: item.url,
                canonicalUrl: canonicalizeSearchUrl(resource.finalUrl),
                title: item.title,
                retrievedAt: new Date().toISOString(),
                contentType: resource.contentType,
                contentHash: createHash('sha256').update(extracted.slice(0, 20_000), 'utf8').digest('hex'),
                rawContentHash: resource.sha256,
                extractorVersion: 'synapse-plain-text-v1',
                text: extracted.slice(0, 20_000),
                warnings,
                license: item.license ?? null,
                attribution: item.attribution ?? null,
            } satisfies SearchDocument;
        }));
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        const documents: SearchDocument[] = [];
        const failures = new Map<string, string>();
        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') documents.push(result.value);
            else failures.set(hits[index].id, result.reason instanceof Error ? result.reason.message : String(result.reason));
        });
        return { documents, failures };
    }
}
