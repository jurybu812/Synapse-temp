export interface SplitProviderUsage {
    /** Provider 报告的未命中缓存、实际新读取的输入 token；pi-ai 的 input/promptTokens 采用这一拆分语义。 */
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

function optionalToken(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

export function canonicalizeSplitProviderUsage(usage: SplitProviderUsage): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
} | null {
    const cacheReadTokens = optionalToken(usage.cacheReadTokens);
    const cacheWriteTokens = optionalToken(usage.cacheWriteTokens);
    const rawPromptTokens = optionalToken(usage.promptTokens);
    const rawCompletionTokens = optionalToken(usage.completionTokens);
    const rawTotalTokens = optionalToken(usage.totalTokens);
    // pi-ai 的 Usage 把 input、cacheRead、cacheWrite 拆开；OpenAI 风格 prompt_tokens 则要求总输入量。
    // 因此这里只对两个原生拆分 Provider 使用相加合同，generic OpenAI-compatible 响应仍在 renderer
    // normalizeUsage 中把 prompt_tokens 视作已包含 cached_tokens，不能复用本函数以免双计。
    const promptTokens = rawPromptTokens === null
        ? (rawTotalTokens !== null && rawCompletionTokens !== null ? rawTotalTokens - rawCompletionTokens : null)
        : rawPromptTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
    if (promptTokens === null || promptTokens < 0) return null;
    const completionTokens = rawCompletionTokens
        ?? (rawTotalTokens !== null ? rawTotalTokens - promptTokens : null);
    if (completionTokens === null || completionTokens < 0) return null;
    const totalTokens = Math.max(rawTotalTokens ?? (promptTokens + completionTokens), promptTokens + completionTokens);
    return { promptTokens, completionTokens, totalTokens, cacheReadTokens, cacheWriteTokens };
}
