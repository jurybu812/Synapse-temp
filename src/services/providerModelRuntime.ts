import type { AIModelOption } from '@/types/aiModel';
import { providerIdForModel, requestModelIdForModel, splitQualifiedModelId } from './modelCapabilities';

interface CredentialState {
  configured?: boolean;
  accountFingerprint?: string | null;
  credentialGeneration?: number;
}

export interface ResolvedProviderModel {
  selectionId: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  credentialConfigured: boolean;
  selectionAvailable: boolean;
  ready: boolean;
  configured: boolean;
  option?: AIModelOption;
}

export interface CapabilityBoundClientOptions {
  temperature?: number;
  maxTokens?: number;
  maxTokenParameter?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  stream: boolean;
  streamOptions: boolean;
  tools: boolean;
}

export function resolveProviderModel(
  selectionId: string,
  availableModels: AIModelOption[] | undefined,
  providerCredentials: Record<string, CredentialState> | undefined,
  apiEndpoints: Record<string, string> | undefined,
): ResolvedProviderModel {
  const option = availableModels?.find(model => model.id === selectionId);
  const inferred = splitQualifiedModelId(selectionId);
  const providerId = option ? providerIdForModel(option) : inferred?.providerId ?? 'openai';
  const modelId = option ? requestModelIdForModel(option) : inferred?.modelId ?? selectionId;
  const baseUrl = providerId === 'openai-codex'
    ? 'https://chatgpt.com/backend-api'
    : apiEndpoints?.[providerId] || apiEndpoints?.openai || 'https://openrouter.ai/api/v1';
  const credentialConfigured = providerCredentials?.[providerId]?.configured ?? false;
  const selectionAvailable = Boolean(option);
  const credential = providerCredentials?.[providerId];
  const credentialGeneration = credential?.credentialGeneration ?? 0;
  const catalogIdentityMatches = !option?.catalog || (
    credentialGeneration === 0
      ? (option.catalog.credentialGeneration ?? 0) === 0
        && (option.catalog.accountFingerprint ?? null) === null
      : option.catalog.accountFingerprint === (credential?.accountFingerprint ?? null)
        && option.catalog.credentialGeneration === credentialGeneration
  );
  const ready = credentialConfigured && selectionAvailable && option?.catalog?.stale !== true && catalogIdentityMatches;
  return {
    selectionId,
    providerId,
    modelId,
    baseUrl,
    credentialConfigured,
    selectionAvailable,
    ready,
    configured: ready,
    option,
  };
}

export function capabilityBoundClientOptions(
  runtime: ResolvedProviderModel,
  requested: { temperature?: number; maxTokens?: number; stream?: boolean },
): CapabilityBoundClientOptions {
  const capabilities = runtime.option?.capabilities;
  const supportedParameters = new Set(capabilities?.supportedParameters ?? runtime.option?.supportedParameters ?? []);
  const supportsTemperature = supportedParameters.has('temperature');
  const maxTokenParameter = [...supportedParameters]
    .find((parameter): parameter is 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' => (
      ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].includes(parameter)
    ));
  const maxOutputTokens = capabilities?.maxOutputTokens;
  return {
    temperature: supportsTemperature ? requested.temperature : undefined,
    maxTokens: maxTokenParameter && requested.maxTokens !== undefined
      ? Math.min(requested.maxTokens, maxOutputTokens ?? Number.POSITIVE_INFINITY)
      : undefined,
    maxTokenParameter,
    stream: requested.stream === true && capabilities?.streaming === true,
    streamOptions: supportedParameters.has('stream_options') || supportedParameters.has('include_usage'),
    tools: capabilities?.tools === true,
  };
}
