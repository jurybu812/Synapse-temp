import { configureStore, type Middleware } from '@reduxjs/toolkit';
import { layoutSlice } from './slices/layout';
import { sidebarSlice } from './slices/sidebar';
import { conversationSlice } from './slices/conversation';
import { ACTIVE_CONVERSATION_KEY, conversationHistorySlice } from './slices/conversationHistory';
import { agentSettingsSlice, normalizeWallpaperImages, normalizeBpcConfig } from './slices/agentSettings';
import { bpcSlice } from './slices/bpc';
import { settingsSlice } from './slices/settings';
import { themeSlice } from './slices/theme';
import { notificationsSlice } from './slices/notifications';
import { sanitizePersistedWorkspaceState, workspaceSlice } from './slices/workspace';
import { worktreeSessionSlice } from './slices/worktreeSession';
import { editorTabsSlice, sanitizePersistedEditorTabsState, serializePersistedEditorTabsState } from './slices/editorTabs';
import multiAIReducer, { BUILT_IN_MODES } from './slices/multiAI';
import { normalizeModelOption, providerIdForModel } from '@/services/modelCapabilities';
import { writeCheckpointActiveConversationId } from '@/services/agentSessionCheckpoint';

// ---- P0-3: Settings 持久化 ----
const SETTINGS_KEY = 'synapse_settings';
const THEME_KEY = 'synapse_theme';
const AGENT_SETTINGS_KEY = 'synapse_agent_settings';
const MULTI_AI_KEY = 'synapse_multi_ai';
const LAYOUT_KEY = 'synapse_layout';
const BACKGROUND_SETTINGS_KEY = 'synapse:background';
const SYNOPSIS_SETTINGS_KEY = 'synapse:synopsis';
const MULTI_AI_SETTINGS_KEY = 'synapse:multi-ai';
// ★ 工作区持久化（治「重启后打开的工作区丢失、回退 demo」）：只存 currentPath/name/recentPaths（配置类），
//   synopsisReady/indexingProgress 是运行态不存。
const WORKSPACE_KEY = 'synapse_workspace';
const EDITOR_TABS_KEY = 'synapse_editor_tabs';

const DEFAULT_BACKGROUND_SETTINGS = {
  enabled: false,
  images: [],
  selectedIndex: 0,
  displayMode: 'static',
  carouselInterval: 300,
  transitionEffect: 'fade',
  blur: 0,
  opacity: 0.7,
  panelOpacity: 0.75,
};

const DEFAULT_SYNOPSIS_SETTINGS = {
  textModeEnabled: false,
  chunkMaxTokens: 2000,
  mapConcurrency: 3,
  autoIndexEnabled: true,
  autoIndexMethod: 'contentHash',
};

/**
 * ★ M5-BPC：把持久化里的 bpc 配置规范成完整、合法的 BpcConfig。
 *   逐字段 Number.isFinite 校验：合法有限数（含 0）原样取；缺省/NaN/非数字回退 DEFAULT_BPC_CONFIG 对应默认值。
 *   ★ 严禁 `persisted.x || default`——0 是 falsy 会被吞，虽阈值现实不为 0，但留作正确口径防未来 0.0 边界。
 */
function sanitizeBpcConfig(raw: any) {
  return normalizeBpcConfig(raw);
}

function sanitizePersistedAgentSettings(agentSettings: any) {
  if (!agentSettings) return agentSettings;
  const normalizedModels = Array.isArray(agentSettings.availableModels)
    ? agentSettings.availableModels
      .map((model: any) => {
        const normalized = normalizeModelOption(model?.raw ? {
          ...model.raw,
          providerId: model.providerId,
          requestModelId: model.requestModelId,
          __synapseCatalog: model.catalog,
        } : model);
        if (!normalized) return null;
        const providerId = providerIdForModel(normalized);
        return {
          ...normalized,
          catalog: {
            providerId,
            generation: normalized.catalog?.generation ?? `persisted:${providerId}`,
            fetchedAt: normalized.catalog?.fetchedAt ?? 0,
            source: 'stale' as const,
            stale: true,
            endpointSha256: normalized.catalog?.endpointSha256 ?? '',
          },
        };
      })
      .filter(Boolean)
    : [];
  const availableModels = [...new Map(
    normalizedModels.map((model: any) => [model.id, model]),
  ).values()];
  const normalized = {
    ...agentSettings,
    availableModels,
    enableStreaming: agentSettings.enableStreaming ?? true,
    outputStrategy: agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off'),
    pseudoStreamSpeed: agentSettings.pseudoStreamSpeed ?? 'medium',
    showStreamCursor: agentSettings.showStreamCursor ?? true,
    showGeneratingPlaceholder: agentSettings.showGeneratingPlaceholder ?? true,
    streamThinking: agentSettings.streamThinking ?? true,
    showThinking: agentSettings.showThinking ?? true,
    temperature: Number.isFinite(Number(agentSettings.temperature)) ? Number(agentSettings.temperature) : 0.7,
    topP: Number.isFinite(Number(agentSettings.topP)) ? Number(agentSettings.topP) : 1,
    maxTokens: Number.isFinite(Number(agentSettings.maxTokens)) ? Number(agentSettings.maxTokens) : 4096,
    reasoningEffort: agentSettings.reasoningEffort ?? 'auto',
    speedTier: agentSettings.speedTier ?? 'auto',
    backgroundSettings: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      ...(agentSettings.backgroundSettings ?? {}),
      images: normalizeWallpaperImages(agentSettings.backgroundSettings?.images),
    },
    synopsisSettings: {
      ...DEFAULT_SYNOPSIS_SETTINGS,
      ...(agentSettings.synopsisSettings ?? {}),
    },
    // ★ M5-RL：record 分层默认兜底——旧持久化无此字段时补全完整字段（默认值与 agentSettings.recordLayering
    //   initialState / agentLoop.DEFAULT_LAYERING 同步；改默认值需三处一起改）。buildStableRecordPrefix 另有
    //   运行时字段级兜底，此处保证 store.recordLayering 永远完整，供 SettingsPanel UI 与 setRecordLayering 用。
    recordLayering: {
      headFull: 2, tailFull: 1, titleThreshold: 20, maxRatio: 0.4, foldThreshold: 30, foldBatchK: 10,
      // ★ #14 动态分级默认（默认开）：与 agentSettings.initialState / agentLoop.DEFAULT_LAYERING 三处同步。
      dynamicLevelEnabled: true, hitWeight: 0.6, distWeight: 0.2, hitBase: 0.4, fullThreshold: 0.6, summaryThreshold: 0.3,
      ...(agentSettings.recordLayering ?? {}),
    },
    // ★ M5-BPC：后台预压缩配置兜底——旧持久化无此字段时补全（默认值收敛在 DEFAULT_BPC_CONFIG 单一真相源）。
    //   数值字段逐项用 Number.isFinite 校验（持久化里若存了 NaN/字符串则回退默认），绝不用 `x||默认` 吞合法 0 值。
    //   保证 store.agentSettings.bpc 永远是完整、合法的 BpcConfig，供 scheduler.evaluateWater 与 SettingsPanel 用。
    bpc: sanitizeBpcConfig(agentSettings.bpc),
  };
  // ★ M4-5-S1：系统模型（systemModel）加载期失效回退，与 currentModel 同款——
  // 持久化里若存了已从端点下线的模型，启动即回退空（跟随 currentModel），防后台任务静默报错。
  // systemModel 校验独立于 currentModel（即便 currentModel 为空也要校验 systemModel）。
  if (normalized.systemModel && !availableModels.some((model: any) => model?.id === normalized.systemModel)) {
    normalized.systemModel = '';
  }
  if (!normalized.currentModel) return normalized;
  const hasCurrentModel = availableModels.some((model: any) => model?.id === agentSettings.currentModel);
  if (!hasCurrentModel) {
    return {
      ...normalized,
      currentModel: '',
    };
  }
  return normalized;
}

function sanitizePersistedMultiAI(multiAI: any) {
  if (!multiAI) return multiAI;
  const persistedModes = Array.isArray(multiAI.modes) ? multiAI.modes : [];
  const customModes = persistedModes.filter((mode: any) => {
    const isBuiltIn = mode?.isBuiltIn || mode?.isBuiltin || BUILT_IN_MODES.some(builtIn => builtIn.id === mode?.id);
    return mode?.id && !isBuiltIn;
  });
  const subagentModel = multiAI.defaultSubagentModel ?? multiAI.subagentDefaultModel ?? '';
  const activeMode = multiAI.activeMode === 'adversarial-coding'
    ? 'adversarial-vibe-coding'
    : (multiAI.activeMode || 'solo');
  return {
    ...multiAI,
    activeMode,
    modes: [...BUILT_IN_MODES, ...customModes],
    runningSubagents: Array.isArray(multiAI.runningSubagents) ? multiAI.runningSubagents : [],
    // ★ M3-3a：工作流运行实例是【运行态】，重启/刷新一律重置为空（不复用上次未完成的卡片状态）。
    workflowRuns: [],
    maxConcurrentSubagents: Number.isFinite(Number(multiAI.maxConcurrentSubagents)) ? Number(multiAI.maxConcurrentSubagents) : 3,
    defaultSubagentModel: subagentModel,
    subagentDefaultModel: subagentModel,
    defaultSubagentMaxTokens: Number.isFinite(Number(multiAI.defaultSubagentMaxTokens)) ? Number(multiAI.defaultSubagentMaxTokens) : 32000,
  };
}

let legacyApiKeysForMigration: Record<string, string> = {};
let legacyApiKeySourceForMigration: Record<string, unknown> = {};
function decodeLegacyApiKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const decoded: Record<string, string> = {};
  for (const [providerId, encoded] of Object.entries(value as Record<string, unknown>)) {
    if (typeof encoded !== 'string' || !encoded) continue;
    try {
      decoded[providerId] = atob(encoded);
    } catch {
      decoded[providerId] = encoded;
    }
  }
  return decoded;
}

function loadPersistedState() {
  try {
    const settingsRaw = localStorage.getItem(SETTINGS_KEY);
    const themeRaw = localStorage.getItem(THEME_KEY);
    const agentSettingsRaw = localStorage.getItem(AGENT_SETTINGS_KEY);
    const backgroundRaw = localStorage.getItem(BACKGROUND_SETTINGS_KEY);
    const synopsisRaw = localStorage.getItem(SYNOPSIS_SETTINGS_KEY);
    const multiAIRaw = localStorage.getItem(MULTI_AI_SETTINGS_KEY) ?? localStorage.getItem(MULTI_AI_KEY);
    const workspaceRaw = localStorage.getItem(WORKSPACE_KEY);
    const editorTabsRaw = localStorage.getItem(EDITOR_TABS_KEY);
    const parsedAgentSettings = agentSettingsRaw ? JSON.parse(agentSettingsRaw) : undefined;
    const backgroundSettings = backgroundRaw ? JSON.parse(backgroundRaw) : undefined;
    const synopsisSettings = synopsisRaw ? JSON.parse(synopsisRaw) : undefined;
    const agentSettingsSeed = parsedAgentSettings || backgroundSettings || synopsisSettings ? {
      ...(parsedAgentSettings ?? {}),
      ...(backgroundSettings ? { backgroundSettings } : {}),
      ...(synopsisSettings ? { synopsisSettings } : {}),
    } : undefined;
    const parsedSettings = settingsRaw ? JSON.parse(settingsRaw) : undefined;
    let settingsWithoutLegacyApiKeys = parsedSettings;
    if (parsedSettings?.apiKeys) {
      legacyApiKeysForMigration = decodeLegacyApiKeys(parsedSettings.apiKeys);
      legacyApiKeySourceForMigration = { ...parsedSettings.apiKeys };
      const { apiKeys: _legacyApiKeys, ...safeSettings } = parsedSettings;
      settingsWithoutLegacyApiKeys = safeSettings;
    }
    let editorTabsSeed: unknown;
    try {
      editorTabsSeed = editorTabsRaw ? JSON.parse(editorTabsRaw) : undefined;
    } catch {
      editorTabsSeed = undefined;
    }
    const workspace = sanitizePersistedWorkspaceState(workspaceRaw ? JSON.parse(workspaceRaw) : undefined) ?? workspaceSlice.getInitialState();
    return {
      settings: settingsWithoutLegacyApiKeys,
      theme: themeRaw ? JSON.parse(themeRaw) : undefined,
      agentSettings: sanitizePersistedAgentSettings(agentSettingsSeed),
      multiAI: sanitizePersistedMultiAI(multiAIRaw ? JSON.parse(multiAIRaw) : undefined),
      workspace,
      editorTabs: sanitizePersistedEditorTabsState(editorTabsSeed, workspace.currentPath),
    };
  } catch {
    return {};
  }
}

const persistMiddleware: Middleware = (storeApi) => (next) => (action) => {
  const result = next(action);
  const state = storeApi.getState() as RootState;
  // 仅在 settings 或 theme 相关 action 时持久化
  if (typeof action === 'object' && action !== null && 'type' in action) {
    const type = (action as { type: string }).type;
    if (type.startsWith('settings/')) {
      try {
        const { providerCredentials: _providerCredentials, ...settingsToSave } = state.settings;
        const persistedSettings = Object.keys(legacyApiKeySourceForMigration).length > 0
          ? { ...settingsToSave, apiKeys: legacyApiKeySourceForMigration }
          : settingsToSave;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistedSettings));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('theme/')) {
      try {
        localStorage.setItem(THEME_KEY, JSON.stringify(state.theme));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('agentSettings/')) {
      try {
        localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(state.agentSettings));
        localStorage.setItem(BACKGROUND_SETTINGS_KEY, JSON.stringify(state.agentSettings.backgroundSettings));
        localStorage.setItem(SYNOPSIS_SETTINGS_KEY, JSON.stringify(state.agentSettings.synopsisSettings));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('multiAI/')) {
      try {
        // ★ medium#1（M3-3a 审查）治本：剔除【运行态】字段再落盘。workflowRuns / runningSubagents 是运行实例
        //   （loadPersistedState 时本就重置为空，不复用上次未完成状态），不该进 localStorage——否则单次工作流的
        //   ~(1+N+状态翻转) 次 multiAI/* dispatch 每次都把全会话累积的运行态整体序列化写盘（性能/quota 风险）。
        //   与 worktreeSession 前缀不入 persistMiddleware 同思路：只持久化配置类字段，运行态留在内存。
        const { workflowRuns: _wfRuns, runningSubagents: _running, ...persistable } = state.multiAI;
        const serialized = JSON.stringify(persistable);
        localStorage.setItem(MULTI_AI_KEY, serialized);
        localStorage.setItem(MULTI_AI_SETTINGS_KEY, serialized);
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('layout/')) {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('workspace/')) {
      try {
        // 只持久化配置类字段（运行态 synopsisReady/indexingProgress 不存，重启回默认）。
        // ★ demo 兜底治本：'/workspace' 是示例工作区的占位 sentinel（Sidebar 首次启动 dispatch openWorkspace
        //   写入），不是真实打开的文件夹。若把它落盘，重启恢复时 Sidebar 的两个分支都不进（既非真实路径、又非空），
        //   示例文件树永久消失。这里把它视同未打开：currentPath 存 null、name 存空串、recentPaths 过滤掉它。
        const { currentPath, name, recentPaths } = state.workspace;
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(sanitizePersistedWorkspaceState({
          currentPath,
          name,
          recentPaths,
        })));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('editorTabs/') || type.startsWith('workspace/')) {
      try {
        const editorTabsSession = serializePersistedEditorTabsState(state.editorTabs, state.workspace.currentPath);
        if (editorTabsSession) {
          localStorage.setItem(EDITOR_TABS_KEY, JSON.stringify(editorTabsSession));
        } else {
          localStorage.removeItem(EDITOR_TABS_KEY);
        }
      } catch { /* localStorage 不可用 */ }
    }
    if (type === 'conversationHistory/setSelectedId') {
      try {
        if (state.conversationHistory.selectedId) {
          localStorage.setItem(ACTIVE_CONVERSATION_KEY, state.conversationHistory.selectedId);
        } else {
          localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
        }
      } catch { /* localStorage 不可用 */ }
      writeCheckpointActiveConversationId(state.conversationHistory.selectedId);
    }
  }
  return result;
};

// 加载持久化状态
const persisted = loadPersistedState();
const defaultSettings = settingsSlice.getInitialState();

export const store = configureStore({
  reducer: {
    layout: layoutSlice.reducer,
    sidebar: sidebarSlice.reducer,
    conversation: conversationSlice.reducer,
    conversationHistory: conversationHistorySlice.reducer,
    agentSettings: agentSettingsSlice.reducer,
    settings: settingsSlice.reducer,
    theme: themeSlice.reducer,
    notifications: notificationsSlice.reducer,
    workspace: workspaceSlice.reducer,
    // M2-5：会话级活动 worktree 运行态（不持久化；前缀 worktreeSession/ 不入 persistMiddleware）。
    worktreeSession: worktreeSessionSlice.reducer,
    editorTabs: editorTabsSlice.reducer,
    multiAI: multiAIReducer,
    // ★ M5-BPC：后台预压缩 UI 投影态（极薄、纯运行态）。前缀 bpc/ 不入 persistMiddleware → 绝不持久化，
    //   store 重启回 idle（同 worktreeSession 不持久化运行态思路）。真正的 BpcSnapshot 数据在 bpcScheduler 内存，
    //   此 slice 仅承载 CompressionRing/StatusBar 可订阅的枚举态 + 进度，不存快照本体。
    bpc: bpcSlice.reducer,
  },
  preloadedState: {
    ...(persisted.settings ? {
      settings: {
        ...defaultSettings,
        ...persisted.settings,
        providerCredentials: {},
        apiEndpoints: {
          ...defaultSettings.apiEndpoints,
          ...(persisted.settings.apiEndpoints ?? {}),
        },
        safety: {
          ...defaultSettings.safety,
          ...(persisted.settings.safety ?? {}),
        },
        promptInjection: {
          ...defaultSettings.promptInjection,
          ...(persisted.settings.promptInjection ?? {}),
        },
      },
    } : {}),
    ...(persisted.theme ? { theme: persisted.theme } : {}),
    ...(persisted.agentSettings ? { agentSettings: persisted.agentSettings } : {}),
    ...(persisted.multiAI ? { multiAI: persisted.multiAI } : {}),
    // ★ 工作区持久化恢复：补全运行态默认 + 持久化的 currentPath/name/recentPaths（重启后工作区不丢、工具根延续）。
    workspace: persisted.workspace
      ? { ...persisted.workspace, synopsisReady: false, indexingProgress: 0 }
      : workspaceSlice.getInitialState(),
    editorTabs: persisted.editorTabs ?? editorTabsSlice.getInitialState(),
  },
  // ★ 性能（M7 第四轮）：关闭 dev 专属的 serializableCheck / immutableCheck。
  //   这俩中间件在每个 action 后深度遍历整棵 state 树，而 conversation.messages 是巨大富对象数组
  //   （contentParts/diffs/hunks/runEvents/thinking 全量嵌套）——发一条消息 = addMessage dispatch =
  //   立刻全树遍历一遍，长对话单次可达 200ms+，是"发消息卡到未响应"的最大单点（dev 日志已实锤
  //   "SerializableStateInvariantMiddleware took 60ms" 警告）。production 本就自动关闭这俩，dev 关掉后
  //   体验与 prod 一致；不可变性由 TypeScript 类型 + reducer 纪律（Immer）保障。
  middleware: (getDefault) =>
    getDefault({ serializableCheck: false, immutableCheck: false }).concat(persistMiddleware),
  devTools: import.meta.env.DEV,
});

declare global {
  interface Window {
    __SYNAPSE_STORE__?: typeof store;
  }
}

if (import.meta.env.DEV) {
  window.__SYNAPSE_STORE__ = store;
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export function readLegacyApiKeysForMigration(): Record<string, string> {
  return { ...legacyApiKeysForMigration };
}

export function clearLegacyApiKeysAfterMigration(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'apiKeys' in parsed) {
        delete parsed.apiKeys;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
      }
    }
    legacyApiKeysForMigration = {};
    legacyApiKeySourceForMigration = {};
  } catch {
    return;
  }
}
