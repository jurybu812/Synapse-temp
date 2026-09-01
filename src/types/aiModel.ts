export type AIModelCapabilityAuthority = 'api' | 'protocol' | 'unknown';

export interface AIModelCapabilityAuthorityMap {
  vision: AIModelCapabilityAuthority;
  tools: AIModelCapabilityAuthority;
  thinking: AIModelCapabilityAuthority;
  streaming: AIModelCapabilityAuthority;
  contextWindow: AIModelCapabilityAuthority;
  maxOutputTokens: AIModelCapabilityAuthority;
  reasoningEffortOptions: AIModelCapabilityAuthority;
  speedTierOptions: AIModelCapabilityAuthority;
}

export interface AIModelCapabilities {
  vision: boolean;
  tools: boolean;
  thinking: boolean;
  reasoning: boolean;
  streaming: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEffortOptions: string[];
  speedTierOptions: string[];
  supportedParameters: string[];
  source: 'api' | 'protocol' | 'mixed' | 'unknown';
  authority: AIModelCapabilityAuthorityMap;
}

export interface AIModelCatalogIdentity {
  providerId: string;
  generation: string;
  fetchedAt: number;
  source: 'network' | 'cache' | 'cache-validated' | 'stale';
  stale: boolean;
  endpointSha256: string;
  accountFingerprint: string | null;
  credentialGeneration: number;
}

export interface AIModelOption {
  id: string;
  providerId?: string;
  requestModelId?: string;
  name: string;
  description?: string;
  capabilities: AIModelCapabilities;
  contextWindow?: number;
  supportedParameters: string[];
  catalog?: AIModelCatalogIdentity;
  raw?: Record<string, any>;
}
