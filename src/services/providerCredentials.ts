import { platform, type ProviderCredentialStatus, type WindsurfLocalImportResult } from '@/platform';
import { store, type AppDispatch } from '@/store';
import { clearLegacyApiKeysAfterMigration, readLegacyApiKeysForMigration } from '@/store';
import { setProviderCredentialStatus } from '@/store/slices/settings';
import { setAvailableModels } from '@/store/slices/agentSettings';
import { AIClient } from './aiClient';
import { providerIdForModel } from './modelCapabilities';
import type { AIModelOption } from '@/types/aiModel';

const catalogRefreshEpochs = new Map<string, number>();

export function beginProviderCatalogRefresh(providerId: string): number {
  const next = (catalogRefreshEpochs.get(providerId) ?? 0) + 1;
  catalogRefreshEpochs.set(providerId, next);
  return next;
}

export function invalidateProviderCatalogRefresh(providerId: string): void {
  catalogRefreshEpochs.set(providerId, (catalogRefreshEpochs.get(providerId) ?? 0) + 1);
}

export function isProviderCatalogRefreshCurrent(providerId: string, epoch: number): boolean {
  return catalogRefreshEpochs.get(providerId) === epoch;
}

export function providerOfModel(model: { id?: string; providerId?: string; catalog?: { providerId?: string } }): string {
  return providerIdForModel(model);
}

function markCatalogStale(model: AIModelOption, providerId: string): AIModelOption {
  return {
    ...model,
    catalog: {
      providerId,
      generation: model.catalog?.generation ?? `persisted:${providerId}`,
      fetchedAt: model.catalog?.fetchedAt ?? 0,
      source: 'stale',
      stale: true,
      endpointSha256: model.catalog?.endpointSha256 ?? '',
      accountFingerprint: model.catalog?.accountFingerprint ?? null,
      credentialGeneration: model.catalog?.credentialGeneration ?? 0,
    },
  };
}

function replaceProviderModels(dispatch: AppDispatch, providerId: string, models: Awaited<ReturnType<typeof AIClient.fetchModels>>): void {
  const existing = store.getState().agentSettings.availableModels ?? [];
  const merged = [
    ...existing.filter(model => providerOfModel(model) !== providerId),
    ...models,
  ];
  dispatch(setAvailableModels([...new Map(merged.map(model => [model.id, model])).values()]));
}

export async function refreshProviderCredentialStatus(
  dispatch: AppDispatch,
  providerId = 'openai',
): Promise<ProviderCredentialStatus> {
  let status = platform.provider
    ? await platform.provider.credentialStatus(providerId)
    : { providerId, configured: false, persisted: false, storage: 'none' as const, credentialType: null, updatedAt: null };
  if (platform.provider && providerId === 'openai-codex') {
    const oauth = await platform.provider.openAICodexStatus();
    status = { ...status, configured: oauth.connected, persisted: oauth.persisted, storage: oauth.storage };
  } else if (platform.provider && providerId === 'windsurf') {
    const oauth = await platform.provider.windsurfStatus();
    status = { ...status, configured: oauth.connected, persisted: oauth.persisted, storage: oauth.storage };
  }
  dispatch(setProviderCredentialStatus(status));
  return status;
}

export async function saveProviderApiKey(
  dispatch: AppDispatch,
  providerId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ProviderCredentialStatus> {
  if (!platform.provider) throw new Error('安全凭据存储仅在 Synapse 桌面版可用');
  const status = await platform.provider.setApiKey(providerId, apiKey, baseUrl);
  dispatch(setProviderCredentialStatus(status));
  const epoch = beginProviderCatalogRefresh(providerId);
  replaceProviderModels(dispatch, providerId, []);
  try {
    const models = await AIClient.fetchModels(baseUrl, providerId, true, true);
    const configured = store.getState().settings.providerCredentials?.[providerId]?.configured === true;
    if (configured && isProviderCatalogRefreshCurrent(providerId, epoch)) replaceProviderModels(dispatch, providerId, models);
  } catch (error) {
    console.warn(`[ProviderCredentials] ${providerId} 新凭据目录刷新失败，旧目录已安全失效`, error);
  }
  return status;
}

export async function removeProviderCredential(
  dispatch: AppDispatch,
  providerId: string,
): Promise<ProviderCredentialStatus> {
  if (!platform.provider) throw new Error('安全凭据存储仅在 Synapse 桌面版可用');
  invalidateProviderCatalogRefresh(providerId);
  const status = await platform.provider.deleteCredential(providerId);
  dispatch(setProviderCredentialStatus(status));
  replaceProviderModels(dispatch, providerId, []);
  return status;
}

export async function importLocalWindsurfCredential(
  dispatch: AppDispatch,
  options?: { confirmationToken?: string; candidateFingerprint?: string },
): Promise<{ result: WindsurfLocalImportResult; models: AIModelOption[]; catalogError: string | null }> {
  if (!platform.provider) throw new Error('本机 Windsurf/Devin 导入仅在 Synapse 桌面版可用');
  const result = await platform.provider.windsurfImportLocal(options);
  await refreshProviderCredentialStatus(dispatch, 'windsurf');
  if (!result.ok) return { result, models: [], catalogError: null };
  const epoch = beginProviderCatalogRefresh('windsurf');
  replaceProviderModels(dispatch, 'windsurf', []);
  try {
    const models = await AIClient.fetchModels('', 'windsurf', true, true);
    const credentialStatus = await refreshProviderCredentialStatus(dispatch, 'windsurf');
    if (credentialStatus.configured && isProviderCatalogRefreshCurrent('windsurf', epoch)) {
      replaceProviderModels(dispatch, 'windsurf', models);
    }
    return { result, models, catalogError: null };
  } catch {
    await refreshProviderCredentialStatus(dispatch, 'windsurf');
    return { result, models: [], catalogError: 'Windsurf 模型目录刷新失败，请稍后手动刷新。' };
  }
}

export async function initializeProviderCredentials(
  dispatch: AppDispatch,
  apiEndpoints: Record<string, string>,
): Promise<ProviderCredentialStatus> {
  const legacy = readLegacyApiKeysForMigration();
  const entries = Object.entries(legacy).filter((entry): entry is [string, string] => Boolean(entry[1]));
  let migratedAll = entries.length === 0;
  if (platform.provider && entries.length > 0) {
    const results = await Promise.allSettled(entries.map(async ([providerId, apiKey]) => {
      const current = await platform.provider!.credentialStatus(providerId);
      if (current.configured && current.persisted) return current;
      return platform.provider!.setApiKey(providerId, apiKey, apiEndpoints[providerId] || '');
    }));
    migratedAll = results.every(result => result.status === 'fulfilled' && result.value.configured && result.value.persisted);
  }
  if (migratedAll) clearLegacyApiKeysAfterMigration();
  const [openAI, openAICodex, windsurf] = await Promise.all([
    refreshProviderCredentialStatus(dispatch, 'openai'),
    refreshProviderCredentialStatus(dispatch, 'openai-codex'),
    refreshProviderCredentialStatus(dispatch, 'windsurf'),
  ]);
  if (platform.provider) {
    const configuredProviders = [openAI, openAICodex, windsurf].filter(status => status.configured);
    const attempts = configuredProviders.map(status => ({
      providerId: status.providerId,
      epoch: beginProviderCatalogRefresh(status.providerId),
    }));
    const refreshResults = await Promise.allSettled(attempts.map(async attempt => ({
      epoch: attempt.epoch,
      providerId: attempt.providerId,
      models: await AIClient.fetchModels(apiEndpoints[attempt.providerId] || '', attempt.providerId, false, true),
    })));
    const refreshed = refreshResults.flatMap(result => result.status === 'fulfilled'
      && isProviderCatalogRefreshCurrent(result.value.providerId, result.value.epoch)
      ? [result.value]
      : []);
    for (let index = 0; index < refreshResults.length; index++) {
      const result = refreshResults[index];
      if (result.status === 'rejected') {
        console.warn(`[ProviderCredentials] ${attempts[index].providerId} 目录刷新失败，保留上次目录`, result.reason);
      }
    }
    const refreshedProviderIds = new Set(refreshed.map(entry => entry.providerId));
    const failedProviderIds = new Set(attempts
      .filter((attempt, index) => refreshResults[index].status === 'rejected'
        && isProviderCatalogRefreshCurrent(attempt.providerId, attempt.epoch))
      .map(attempt => attempt.providerId));
    const existing = store.getState().agentSettings.availableModels ?? [];
    const merged = [
      ...existing
        .filter(model => !refreshedProviderIds.has(providerOfModel(model)))
        .map(model => failedProviderIds.has(providerOfModel(model))
          ? markCatalogStale(model, providerOfModel(model))
          : model),
      ...refreshed.flatMap(entry => entry.models),
    ];
    dispatch(setAvailableModels([...new Map(merged.map(model => [model.id, model])).values()]));
    const finalStatuses = await Promise.all([
      refreshProviderCredentialStatus(dispatch, 'openai'),
      refreshProviderCredentialStatus(dispatch, 'openai-codex'),
      refreshProviderCredentialStatus(dispatch, 'windsurf'),
    ]);
    for (const status of finalStatuses) {
      if (status.configured) continue;
      invalidateProviderCatalogRefresh(status.providerId);
      replaceProviderModels(dispatch, status.providerId, []);
    }
  }
  return openAI;
}
