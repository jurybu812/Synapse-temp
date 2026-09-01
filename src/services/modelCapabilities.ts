import type {
  AIModelCapabilities,
  AIModelCapabilityAuthority,
  AIModelCapabilityAuthorityMap,
  AIModelOption,
} from '@/types/aiModel';

function cleanModelId(raw: string): string {
  return raw.replace(/^\[.*?\]/, '');
}

const QUALIFIED_PROVIDER_IDS = ['openai-codex', 'windsurf'] as const;

export function splitQualifiedModelId(id: string): { providerId: string; modelId: string } | null {
  const normalized = cleanModelId(id).trim();
  const providerId = QUALIFIED_PROVIDER_IDS.find(candidate => normalized.startsWith(`${candidate}:`));
  if (!providerId) return null;
  return { providerId, modelId: normalized.slice(providerId.length + 1) };
}

export function providerIdForModel(model: {
  id?: string;
  providerId?: string;
  catalog?: { providerId?: string };
}): string {
  const explicitProviderId = model.providerId ?? model.catalog?.providerId;
  const qualified = splitQualifiedModelId(model.id ?? '');
  if (qualified && (!explicitProviderId || explicitProviderId === 'openai')) return qualified.providerId;
  return explicitProviderId ?? qualified?.providerId ?? 'openai';
}

export function requestModelIdForModel(model: {
  id?: string;
  providerId?: string;
  requestModelId?: string;
  catalog?: { providerId?: string };
}): string {
  const qualified = splitQualifiedModelId(model.id ?? '');
  const providerId = providerIdForModel(model);
  if (qualified && qualified.providerId === providerId
    && (!model.requestModelId || model.requestModelId === model.id)) {
    return cleanModelId(qualified.modelId).trim();
  }
  return cleanModelId(model.requestModelId ?? model.id ?? '').trim();
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function collectSupportedParameters(raw: any): string[] {
  const candidates = [
    raw?.supported_parameters,
    raw?.supportedParameters,
    raw?.parameters,
    raw?.capabilities?.supported_parameters,
    raw?.capabilities?.parameters,
  ];
  const values = candidates.flatMap(value => Array.isArray(value) ? value : []);
  return [...new Set(values.map(String).map(v => v.toLowerCase()))];
}

function collectArrayEvidence(paths: unknown[]): { present: boolean; values: string[] } {
  const present = paths.some(Array.isArray);
  return {
    present,
    values: paths
      .flatMap(value => Array.isArray(value) ? value : [])
      .map(String)
      .map(value => value.toLowerCase()),
  };
}

function collectModalities(raw: any): { present: boolean; values: string[] } {
  const candidates = [
    raw?.modalities,
    raw?.input_modalities,
    raw?.supported_modalities,
    raw?.architecture?.input_modalities,
    raw?.capabilities?.modalities,
  ];
  return collectArrayEvidence(candidates);
}

function collectReasoningEfforts(raw: any): { present: boolean; values: string[] } {
  const candidates = [
    raw?.supported_reasoning_levels,
    raw?.reasoning_effort_options,
    raw?.reasoningEffortOptions,
  ];
  const efforts = candidates.flatMap(value => Array.isArray(value) ? value : [])
    .map(value => typeof value === 'string' ? value : value?.effort)
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .map(value => value.toLowerCase());
  return { present: candidates.some(Array.isArray), values: [...new Set(efforts)] };
}

function collectSpeedTiers(raw: any): { present: boolean; values: string[] } {
  const serviceTiersRaw = raw?.service_tiers;
  const additionalRaw = raw?.additional_speed_tiers;
  const serviceTiers = Array.isArray(serviceTiersRaw) ? serviceTiersRaw : [];
  const additional = Array.isArray(additionalRaw) ? additionalRaw : [];
  const values = [...serviceTiers, ...additional]
    .map(value => typeof value === 'string' ? value : value?.id ?? value?.name)
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .map(value => value.toLowerCase())
    .map(value => value === 'priority' ? 'fast' : value);
  return {
    present: Array.isArray(serviceTiersRaw) || Array.isArray(additionalRaw),
    values: [...new Set(values.filter(value => value !== 'default' && value !== 'standard'))],
  };
}

function findContextWindow(raw: any): number | undefined {
  return [
    raw?.context_window,
    raw?.contextWindow,
    raw?.context_length,
    raw?.contextLength,
    raw?.max_context_length,
    raw?.maxContextLength,
    raw?.input_token_limit,
    raw?.max_input_tokens,
    raw?.limits?.context,
    raw?.top_provider?.context_length,
  ].map(toNumber).find(Boolean);
}

function findMaxOutputTokens(raw: any): number | undefined {
  return [
    raw?.max_output_tokens,
    raw?.maxOutputTokens,
    raw?.output_token_limit,
    raw?.max_completion_tokens,
    raw?.top_provider?.max_completion_tokens,
  ].map(toNumber).find(Boolean);
}

function hasSupportedParameter(parameters: string[], ...names: string[]): boolean {
  return names.some(name => parameters.includes(name.toLowerCase()));
}

function explicitBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readDeclaredAuthority(raw: any, field: keyof AIModelCapabilityAuthorityMap): AIModelCapabilityAuthority | undefined {
  const declared = raw?.capability_authority;
  const value = typeof declared === 'object' && declared !== null ? declared[field] : declared;
  if (value === 'api' || value === 'realtime') return 'api';
  if (value === 'protocol') return 'protocol';
  if (value === 'unknown') return 'unknown';
  return undefined;
}

function authorityFor(raw: any, field: keyof AIModelCapabilityAuthorityMap, hasEvidence: boolean): AIModelCapabilityAuthority {
  return readDeclaredAuthority(raw, field) ?? (hasEvidence ? 'api' : 'unknown');
}

function summarizeAuthority(authority: AIModelCapabilityAuthorityMap): AIModelCapabilities['source'] {
  const values = new Set(Object.values(authority).filter(value => value !== 'unknown'));
  if (values.size === 0) return 'unknown';
  if (values.size > 1) return 'mixed';
  return values.has('protocol') ? 'protocol' : 'api';
}

function preservedCapabilities(value: unknown): AIModelCapabilities | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AIModelCapabilities>;
  if (
    typeof candidate.vision !== 'boolean'
    || typeof candidate.tools !== 'boolean'
    || typeof candidate.thinking !== 'boolean'
    || typeof candidate.streaming !== 'boolean'
    || !Array.isArray(candidate.reasoningEffortOptions)
    || !candidate.reasoningEffortOptions.every(option => typeof option === 'string')
    || !Array.isArray(candidate.speedTierOptions)
    || !candidate.speedTierOptions.every(option => typeof option === 'string')
    || !Array.isArray(candidate.supportedParameters)
    || !candidate.supportedParameters.every(parameter => typeof parameter === 'string')
    || !['api', 'protocol', 'mixed', 'unknown'].includes(String(candidate.source))
  ) return null;
  const authorityKeys: Array<keyof AIModelCapabilityAuthorityMap> = [
    'vision', 'tools', 'thinking', 'streaming', 'contextWindow', 'maxOutputTokens',
    'reasoningEffortOptions', 'speedTierOptions',
  ];
  const authority = candidate.authority;
  if (!authority || authorityKeys.some(key => !['api', 'protocol', 'unknown'].includes(authority[key]))) return null;
  const contextWindow = candidate.contextWindow === undefined ? undefined : toNumber(candidate.contextWindow);
  const maxOutputTokens = candidate.maxOutputTokens === undefined ? undefined : toNumber(candidate.maxOutputTokens);
  if ((candidate.contextWindow !== undefined && contextWindow === undefined)
    || (candidate.maxOutputTokens !== undefined && maxOutputTokens === undefined)) return null;
  return {
    vision: candidate.vision,
    tools: candidate.tools,
    thinking: candidate.thinking,
    reasoning: typeof candidate.reasoning === 'boolean' ? candidate.reasoning : candidate.thinking,
    streaming: candidate.streaming,
    contextWindow,
    maxOutputTokens,
    reasoningEffortOptions: [...candidate.reasoningEffortOptions],
    speedTierOptions: [...candidate.speedTierOptions],
    supportedParameters: [...candidate.supportedParameters],
    source: candidate.source as AIModelCapabilities['source'],
    authority: { ...authority },
  };
}

export function inferModelCapabilities(_id: string, raw: any = {}): AIModelCapabilities {
  const supportedParameters = collectSupportedParameters(raw);
  const modalities = collectModalities(raw);
  const reasoningEfforts = collectReasoningEfforts(raw);
  const speedTiers = collectSpeedTiers(raw);

  const apiVision = explicitBoolean(raw?.capabilities?.vision ?? raw?.vision);
  const apiTools = explicitBoolean(raw?.capabilities?.tools ?? raw?.tools);
  const apiThinking = explicitBoolean(raw?.capabilities?.thinking ?? raw?.capabilities?.reasoning ?? raw?.reasoning);
  const apiStreaming = explicitBoolean(raw?.capabilities?.streaming ?? raw?.streaming);

  const vision = apiVision ?? (modalities.present ? modalities.values.some(m => m.includes('image') || m.includes('vision')) : false);
  const tools = apiTools ?? hasSupportedParameter(supportedParameters, 'tools', 'tool_choice', 'functions', 'function_call');
  const thinking = apiThinking ?? (
    reasoningEfforts.values.length > 0 ||
    hasSupportedParameter(supportedParameters, 'reasoning_effort', 'reasoning', 'thinking')
  );
  const streaming = apiStreaming ?? hasSupportedParameter(supportedParameters, 'stream');
  const contextWindow = findContextWindow(raw);
  const maxOutputTokens = findMaxOutputTokens(raw);
  const authority: AIModelCapabilityAuthorityMap = {
    vision: authorityFor(raw, 'vision', apiVision !== undefined || modalities.present),
    tools: authorityFor(raw, 'tools', apiTools !== undefined || hasSupportedParameter(supportedParameters, 'tools', 'tool_choice', 'functions', 'function_call')),
    thinking: authorityFor(raw, 'thinking', apiThinking !== undefined || reasoningEfforts.present || hasSupportedParameter(supportedParameters, 'reasoning_effort', 'reasoning', 'thinking')),
    streaming: authorityFor(raw, 'streaming', apiStreaming !== undefined || hasSupportedParameter(supportedParameters, 'stream')),
    contextWindow: authorityFor(raw, 'contextWindow', contextWindow !== undefined),
    maxOutputTokens: authorityFor(raw, 'maxOutputTokens', maxOutputTokens !== undefined),
    reasoningEffortOptions: authorityFor(raw, 'reasoningEffortOptions', reasoningEfforts.present),
    speedTierOptions: authorityFor(raw, 'speedTierOptions', speedTiers.present),
  };

  return {
    vision,
    tools,
    thinking,
    reasoning: thinking,
    streaming,
    contextWindow,
    maxOutputTokens,
    reasoningEffortOptions: thinking
      ? ['auto', ...reasoningEfforts.values.filter(value => value !== 'auto')]
      : ['auto'],
    speedTierOptions: ['auto', ...speedTiers.values.filter(value => value !== 'auto')],
    supportedParameters,
    source: summarizeAuthority(authority),
    authority,
  };
}

export function normalizeModelOption(raw: any): AIModelOption | null {
  const normalizedRaw = typeof raw === 'string' ? { id: raw } : raw;
  const rawId = String(normalizedRaw?.id ?? normalizedRaw?.model ?? normalizedRaw?.name ?? '').trim();
  if (!rawId) return null;
  const identityInput = {
    id: rawId,
    providerId: normalizedRaw?.provider_id
      ?? normalizedRaw?.providerId
      ?? normalizedRaw?.__synapseProviderId,
    requestModelId: normalizedRaw?.request_model_id ?? normalizedRaw?.requestModelId,
    catalog: normalizedRaw?.__synapseCatalog,
  };
  const providerId = providerIdForModel(identityInput);
  const requestModelId = requestModelIdForModel(identityInput);
  const id = providerId === 'openai' ? requestModelId : `${providerId}:${requestModelId}`;
  const capabilities = preservedCapabilities(normalizedRaw?.capabilities)
    ?? inferModelCapabilities(requestModelId, normalizedRaw);
  return {
    id,
    providerId,
    requestModelId,
    name: String(normalizedRaw?.display_name ?? normalizedRaw?.displayName ?? rawId),
    description: normalizedRaw?.description,
    capabilities,
    contextWindow: capabilities.contextWindow,
    supportedParameters: capabilities.supportedParameters,
    catalog: normalizedRaw?.__synapseCatalog,
    raw: normalizedRaw,
  };
}

export function describeCapabilities(capabilities?: AIModelCapabilities): string[] {
  if (!capabilities) return [];
  const labels: string[] = [];
  if (capabilities.source === 'unknown') return ['Capabilities unknown'];
  labels.push((capabilities.authority?.streaming ?? 'unknown') === 'unknown' ? 'Stream unknown' : capabilities.streaming ? 'Streaming' : 'No stream');
  if (capabilities.thinking) labels.push('Thinking');
  if (capabilities.tools) labels.push('Tools');
  if (capabilities.vision) labels.push('Vision');
  if (capabilities.contextWindow) labels.push(`${Math.round(capabilities.contextWindow / 1000)}k ctx`);
  return labels;
}
