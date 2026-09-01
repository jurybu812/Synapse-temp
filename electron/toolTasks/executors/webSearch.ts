import { formatSearchResponse, normalizeSearchRequest, type SearchRequest, type SearchResponse } from '../../search/contracts';
import { SearchEngine } from '../../search/searchEngine';
import { ManagedTaskError, ManagedTaskExecutor, type ManagedTaskExecutionContext, type ManagedTaskOutput } from '../ManagedTaskExecutor';

function compactSearchResponse(response: SearchResponse): unknown {
    return {
        ...response,
        documents: response.documents.map(({ text: _text, ...document }) => document),
    };
}

function aggregateProviderErrorCode(providers: SearchResponse['providers']): string {
    const statuses = new Set(providers.map(provider => provider.status));
    if (statuses.has('unauthorized')) return 'unauthorized';
    if (statuses.has('quota_exhausted')) return 'quota_exhausted';
    if (statuses.has('rate_limited')) return 'rate_limit';
    if (statuses.size === 1 && statuses.has('timeout')) return 'timeout';
    if (statuses.has('timeout') || statuses.has('unavailable')) return 'server_error';
    return 'provider';
}

async function waitForFaultInjectionDelay(signal: AbortSignal): Promise<void> {
    const delayMs = Number(process.env.SYNAPSE_FAULT_WEB_SEARCH_DELAY_MS || 0);
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error('aborted'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, Math.min(delayMs, 120_000));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}

export class WebSearchTaskExecutor extends ManagedTaskExecutor {
    readonly kind = 'web-search';

    constructor(private readonly engine: Pick<SearchEngine, 'search'> = new SearchEngine()) {
        super();
    }

    protected hasUnknownSideEffect(): boolean {
        return false;
    }

    protected async execute(input: unknown, context: ManagedTaskExecutionContext): Promise<ManagedTaskOutput> {
        let request: Required<SearchRequest>;
        try {
            request = normalizeSearchRequest(input);
        } catch (error) {
            throw new ManagedTaskError(error instanceof Error ? error.message : String(error), 'invalid_result', false);
        }
        await waitForFaultInjectionDelay(context.signal);
        const response = await this.engine.search(request, context.signal) as SearchResponse;
        const attemptedProviders = response.providers.filter(provider => provider.status !== 'skipped');
        if (!response.hits.length && attemptedProviders.length > 0 && attemptedProviders.every(provider => !['success', 'empty'].includes(provider.status))) {
            throw new ManagedTaskError(
                '所有公开搜索 Provider 均失败',
                aggregateProviderErrorCode(attemptedProviders),
                false,
                formatSearchResponse(response),
                response,
            );
        }
        return {
            text: formatSearchResponse(response),
            structured: response,
            structuredFallback: compactSearchResponse(response),
        };
    }
}
