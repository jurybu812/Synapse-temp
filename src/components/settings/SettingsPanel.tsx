import { useState, useCallback, useEffect, useId, useMemo, useRef, type KeyboardEvent, type Ref } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { store, type RootState } from '@/store';
import { setLanguage, setFontSize, setApiEndpoint, setSafety, setPromptInjection, setMaxConversationHistory, setAutoArchiveAfter, setSendKeyMode, setRuntimeEnterAction, setAttachUserMsgToBoundary, setUserAvatar, setUserName, setAiAvatar, setAiName, setFileTreeMaxDepth } from '@/store/slices/settings';
import { clearConversation } from '@/store/slices/conversation';
import { setConversations, setSelectedId } from '@/store/slices/conversationHistory';
import { deleteConversationSnapshots, exportConversationSnapshot, listConversationSummaries } from '@/services/conversationPersistence';
import { extensionManager } from '@/services/extensionManager';
import { setThemeMode, setAccentColor } from '@/store/slices/theme';
import {
  addBackgroundImages,
  clearBackgroundImages,
  getWallpaperName,
  getWallpaperUrl,
  removeBackgroundImage,
  selectBackgroundImage,
  setAvailableModels,
  setBackgroundSettings,
  setConnectionStatus,
  setCurrentModel,
  setSystemModel,
  setOutputStrategy,
  setPseudoStreamSpeed,
  setShowGeneratingPlaceholder,
  setShowStreamCursor,
  setShowThinking,
  setSynopsisSettings,
  setStreamThinking,
  setTemperature,
  setTopP,
  setMaxTokens,
  setReasoningEffort,
  setSpeedTier,
  setRecordLayering,
  setBpc,
  setContextWindowOverride,
  setTaskBoundaryEnabled,
  setHideSystemToolCalls,
  setMaxToolRounds,
  setAutoContinueToolRounds,
  DEFAULT_BPC_CONFIG,
} from '@/store/slices/agentSettings';
import type { WallpaperImage } from '@/store/slices/agentSettings';
import { getModelContextWindowForOption } from '@/store/selectors/modelSelectors';
import {
  addMode,
  removeMode,
  setActiveMode,
  setDefaultSubagentMaxTokens,
  setMaxConcurrentSubagents,
  setMultiAIEnabled,
  setSubagentDefaultModel,
  updateMode,
} from '@/store/slices/multiAI';
import type { MultiAIMode, WorkflowNode } from '@/store/slices/multiAI';
import { MULTI_AI_TRIGGER_PREFIX } from '@/services/multiAITrigger';
import { WorkflowEditor } from './WorkflowEditor';
import { AvatarUpload } from './AvatarUpload';
import { AIClient } from '@/services/aiClient';
import { describeCapabilities, providerIdForModel } from '@/services/modelCapabilities';
import type { AIModelOption } from '@/types/aiModel';
import { addNotification } from '@/store/slices/notifications';
import { exitWorktreeByPath } from '@/store/slices/worktreeSession';
import { isElectron, platform } from '@/platform';
import type { OpenAICodexStatus, PlatformInfo, WindsurfLocalImportCandidate, WindsurfStatus, WorktreeEntry } from '@/platform';
import {
  beginProviderCatalogRefresh,
  invalidateProviderCatalogRefresh,
  isProviderCatalogRefreshCurrent,
  importLocalWindsurfCredential,
  refreshProviderCredentialStatus,
  removeProviderCredential,
  saveProviderApiKey,
} from '@/services/providerCredentials';
// ★ M4-7-S4：启停 MCP server 后刷新桥接，使工具进/出 toolRegistry。
import { mcpBridge } from '@/services/mcpBridge';
import '@/styles/settings.css';
import { confirmAction } from '@/services/confirmationCoordinator';
import { isSensitiveSettingsKey, sanitizeSettingsMap, sanitizeSettingsValue } from '@/services/settingsTransfer';

/**
 * ★ M3-2c#fix 唯一 id 生成（时间戳 + 模块级自增 + 随机后缀）。
 *   旧实现用 `wf-${Date.now()}` / `agent-${Date.now()}` / `sub-${Date.now()}`：同一毫秒内两次点击
 *   「新建模板」或「新建」紧接「复制为模板」会产出完全相同的 mode id，导致 updateMode(find by id) /
 *   removeMode(filter by id) 命中两条、列表 React key 重复、reload 后无法区分。加自增序号 + 随机后缀
 *   保证同毫秒多次创建仍唯一（与 WorkflowEditor.genId 同款思路）。
 */
let multiAiIdSeq = 0;
function genUniqueId(prefix: string): string {
  multiAiIdSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${multiAiIdSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function modelDisplayName(model: AIModelOption): string {
  const provider = providerIdForModel(model);
  const prefix = provider === 'openai-codex' ? 'ChatGPT · ' : provider === 'windsurf' ? 'Windsurf · ' : provider === 'openai' ? 'API · ' : `${provider} · `;
  return `${prefix}${model.name || model.requestModelId || model.id}`;
}

function selectionBelongsToProvider(selectionId: string | undefined, providerId: string, models: AIModelOption[]): boolean {
  if (!selectionId) return false;
  const option = models.find(model => model.id === selectionId);
  return providerIdForModel(option ?? { id: selectionId }) === providerId;
}

function windsurfCredentialSourceLabel(source: WindsurfStatus['credentialSource'] | undefined | null): string {
  if (source === 'local-client-import') return '本机 Devin/Windsurf 导入';
  if (source === 'manual-api-key') return '手动 API Key';
  if (source === 'browser-token') return '浏览器 token';
  return '未知来源';
}

function describeWindsurfCandidates(candidates?: WindsurfLocalImportCandidate[]): string {
  if (!candidates?.length) return '';
  return candidates
    .slice(0, 3)
    .map(candidate => `${candidate.accountLabel || '未命名账号'}（${candidate.source}）`)
    .join('、');
}

const SETTINGS_PANEL_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isKeyboardReachableSettingElement(element: HTMLElement): boolean {
  if (element.tabIndex < 0) return false;
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  if (element instanceof HTMLInputElement && (element.disabled || element.type === 'hidden')) return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  if (element instanceof HTMLSelectElement && element.disabled) return false;
  if (element instanceof HTMLTextAreaElement && element.disabled) return false;

  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

type PluginEntry = {
  name: string;
  description: string;
  status: string;
  source: string;
  icon: string;
  sourceType?: string;
};

type McpServerInfo = {
  name: string;
  status?: string;
  running?: boolean;
  configured?: boolean;
  enabled?: boolean;
  // ★ M4-7-S4：running server 的真实工具名列表（来自 ipc/mcp.ts:status 对 running server 调 listTools）。
  tools?: string[];
};

// ★ M4-7-S4：三个本地 MCP server 的友好描述（动态列表只有 server 名时补展示文案；其它 server 用通用描述）。
const MCP_SERVER_DESCRIPTIONS: Record<string, { description: string; icon: string }> = {
  'sandbox': { description: '执行隔离命令、持久会话与长任务托管的 MCP 服务（执行类工具需审批）。', icon: '📦' },
  'web-fetcher': { description: '网页抓取、截图、结构化提取与带登录态访问（写类工具需审批）。', icon: '🌐' },
  'memory-store': { description: '跨源读取项目记忆、决策记录与对话原文（写类工具需审批）。', icon: '🧠' },
};

type StorageUsageSnapshot = {
  localStorageBytes: number;
  browserUsageBytes?: number;
  browserQuotaBytes?: number;
  source: string;
  measuredAt: number;
};

export function SettingsPanel() {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s: RootState) => (s as any).settings);
  const theme = useAppSelector((s: RootState) => (s as any).theme);
  const agentSettings = useAppSelector((s: RootState) => (s as any).agentSettings);
  const multiAI = useAppSelector((s: RootState) => (s as any).multiAI);
  const [activeTab, setActiveTab] = useState('general');
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);
  const fullAccessToggleRef = useRef<HTMLInputElement>(null);

  const closeFullAccessConfirm = useCallback(() => {
    setFullAccessConfirmOpen(false);
    requestAnimationFrame(() => fullAccessToggleRef.current?.focus());
  }, []);
  const autoApproveRead = settings.safety?.autoApproveRead ?? true;
  const autoApproveWrite = settings.safety?.autoApproveWrite ?? false;
  const autoApproveCommand = settings.safety?.autoApproveCommand ?? false;
  const allAllowedOperationsAutoApproved = autoApproveRead && autoApproveWrite && autoApproveCommand;
  // ★ M3-2c：当前正在编辑的工作流模板 id（null=显示模式列表，否则显示 WorkflowEditor）。
  const [editingModeId, setEditingModeId] = useState<string | null>(null);
  /**
   * ★ M3-2c#fix「新建未保存」草稿：新建/复制为模板时【不立即 addMode】（避免「新建→取消」在
   *   列表/localStorage 留下永久空壳）。草稿仅存本地 state，进编辑器编辑；onSave 才 addMode 落库，
   *   onCancel 直接丢弃。draftMode 非空时编辑器以它为数据源（其 id 不在 modes 里）。
   */
  const [draftMode, setDraftMode] = useState<MultiAIMode | null>(null);
  const [availableModels, setLocalAvailableModels] = useState<AIModelOption[]>(agentSettings.availableModels ?? []);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [openAICodexStatus, setOpenAICodexStatus] = useState<OpenAICodexStatus | null>(null);
  const [openAICodexBusy, setOpenAICodexBusy] = useState(false);
  const [windsurfStatus, setWindsurfStatus] = useState<WindsurfStatus | null>(null);
  const [windsurfBusy, setWindsurfBusy] = useState(false);
  const [windsurfTokenDraft, setWindsurfTokenDraft] = useState('');
  const [windsurfLocalImportMessage, setWindsurfLocalImportMessage] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerInfo>>({});
  const [loadingMcpStatus, setLoadingMcpStatus] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  // ── git worktree (M2-4) ──
  const [worktreeRepoRoot, setWorktreeRepoRoot] = useState('');
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [worktreeNewBranch, setWorktreeNewBranch] = useState('');
  const [worktreeForce, setWorktreeForce] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [worktreeLoaded, setWorktreeLoaded] = useState(false);
  const pluginSkills = useMemo<PluginEntry[]>(() => extensionManager.getSkills().map(skill => ({
    name: skill.name,
    description: skill.description,
    status: skill.enabled ? '启用' : '禁用',
    source: skill.contentPath,
    sourceType: skill.sourceType,
    icon: '📄',
  })), []);
  const pluginWorkflows = useMemo<PluginEntry[]>(() => extensionManager.getWorkflows().map(workflow => ({
    name: workflow.slashCommand,
    description: workflow.description,
    status: workflow.enabled ? '启用' : '禁用',
    source: workflow.contentPath,
    sourceType: workflow.sourceType,
    icon: '🚀',
  })), []);
  const [pluginRules, setPluginRules] = useState<PluginEntry[]>(() => extensionManager.getRulesSources().map(rule => ({
    name: rule.name,
    description: rule.description,
    status: rule.status === 'loaded' ? `已加载 ${rule.contentLength} 字符` : '未配置',
    source: rule.path,
    sourceType: rule.sourceType,
    icon: rule.status === 'loaded' ? '📘' : '📄',
  })));
  // ★ M4-7-S4：MCP 列表全部走 getStatus 动态结果（删静态三条 entry）。每条带真实工具数（running server 的
  //   tools 名列表来自 ipc/mcp.ts:status 调 listTools），description 补来源 server 友好说明。
  const pluginMcpEntries = useMemo<PluginEntry[]>(() => {
    return Object.values(mcpServers).map(server => {
      const meta = MCP_SERVER_DESCRIPTIONS[server.name];
      const toolCount = server.tools?.length ?? 0;
      const baseDesc = meta?.description ?? '来自 MCP 配置文件的服务器。';
      const toolSuffix = server.running
        ? `（已发现 ${toolCount} 个工具${toolCount > 0 ? `：${server.tools!.slice(0, 6).join(', ')}${toolCount > 6 ? ' …' : ''}` : ''}）`
        : '';
      return {
        name: server.name,
        description: baseDesc + toolSuffix,
        status: '已配置',
        source: '~/.synapse/mcp_config.json',
        sourceType: 'mcp',
        icon: meta?.icon ?? '🔌',
      };
    });
  }, [mcpServers]);
  const [storageUsage, setStorageUsage] = useState<StorageUsageSnapshot>(() => calculateStorageUsageSync());
  const [loadingStorageUsage, setLoadingStorageUsage] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const settingsContentRef = useRef<HTMLDivElement>(null);
  const settingsImportRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalAvailableModels(agentSettings.availableModels ?? []);
  }, [agentSettings.availableModels]);

  useEffect(() => {
    void platform.platform.info().then(setPlatformInfo).catch(() => setPlatformInfo(null));
  }, []);

  const refreshOpenAICodexStatus = useCallback(async () => {
    if (!platform.provider) return null;
    const status = await platform.provider.openAICodexStatus();
    setOpenAICodexStatus(status);
    await refreshProviderCredentialStatus(dispatch, 'openai-codex');
    return status;
  }, [dispatch]);

  useEffect(() => {
    void refreshOpenAICodexStatus().catch(() => setOpenAICodexStatus(null));
  }, [refreshOpenAICodexStatus]);

  useEffect(() => {
    if (!openAICodexStatus || !['starting', 'waiting'].includes(openAICodexStatus.state)) return;
    const timer = window.setTimeout(() => {
      void refreshOpenAICodexStatus().catch(() => undefined);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [openAICodexStatus, refreshOpenAICodexStatus]);

  const refreshWindsurfStatus = useCallback(async () => {
    if (!platform.provider) return null;
    const status = await platform.provider.windsurfStatus();
    setWindsurfStatus(status);
    await refreshProviderCredentialStatus(dispatch, 'windsurf');
    return status;
  }, [dispatch]);

  useEffect(() => {
    void refreshWindsurfStatus().catch(() => setWindsurfStatus(null));
  }, [refreshWindsurfStatus]);

  useEffect(() => {
    if (!windsurfStatus || !['waiting', 'exchanging'].includes(windsurfStatus.state)) return;
    const timer = window.setTimeout(() => {
      void refreshWindsurfStatus().catch(() => undefined);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [refreshWindsurfStatus, windsurfStatus]);
  const openAICodexConnected = openAICodexStatus?.connected
    ?? settings.providerCredentials?.['openai-codex']?.configured
    ?? false;
  const windsurfConnected = windsurfStatus?.connected
    ?? settings.providerCredentials?.windsurf?.configured
    ?? false;

  const selectedModel = useMemo(() => {
    return availableModels.some(m => m.id === agentSettings.currentModel)
      ? agentSettings.currentModel
      : '';
  }, [availableModels, agentSettings.currentModel]);
  const selectedModelOption = useMemo(
    () => availableModels.find(m => m.id === selectedModel),
    [availableModels, selectedModel],
  );
  const selectedCapabilities = selectedModelOption?.capabilities;
  const backgroundSettings = agentSettings.backgroundSettings ?? {
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
  const synopsisSettings = agentSettings.synopsisSettings ?? {
    textModeEnabled: false,
    chunkMaxTokens: 2000,
    mapConcurrency: 3,
    autoIndexEnabled: true,
    autoIndexMethod: 'contentHash',
  };

  const tabs = [
    { id: 'general', label: '⚙️ 通用' },
    { id: 'ai', label: '🤖 AI' },
    { id: 'conversation', label: '💬 对话' },
    { id: 'safety', label: '🛡 安全' },
    { id: 'synopsis', label: '📊 Synopsis' },
    { id: 'multiAI', label: '🤝 Multi-AI' },
    { id: 'plugins', label: '🧩 插件' },
    { id: 'worktree', label: '🌿 工作树' },
    { id: 'data', label: '📤 数据' },
    { id: 'about', label: 'ℹ️ 关于' },
  ];

  const fetchModels = useCallback(async () => {
    const configured = settings.providerCredentials?.openai?.configured ?? false;
    const endpoint = settings.apiEndpoints?.openai;
    if (!configured || !endpoint) {
      dispatch(setConnectionStatus('missing'));
      dispatch(addNotification({ type: 'warning', title: '未配置 API', message: '请先填写 API Key 和端点' }));
      return [];
    }
    const refreshEpoch = beginProviderCatalogRefresh('openai');
    setLoadingModels(true);
    dispatch(setConnectionStatus('checking'));
    try {
      const models = await AIClient.fetchModels(endpoint, 'openai');
      const credentialStatus = await refreshProviderCredentialStatus(dispatch, 'openai');
      if (!credentialStatus.configured || !isProviderCatalogRefreshCurrent('openai', refreshEpoch)) return [];
      const staleCatalog = models.some(model => model.catalog?.stale || model.catalog?.source === 'stale');
      const currentModels = store.getState().agentSettings.availableModels ?? [];
      const mergedModels = [
        ...currentModels.filter(model => providerIdForModel(model) !== 'openai'),
        ...models,
      ];
      const dedupedModels = [...new Map(mergedModels.map(model => [model.id, model])).values()];
      setLocalAvailableModels(dedupedModels);
      dispatch(setAvailableModels(dedupedModels));
      if (models.length > 0) {
        dispatch(setConnectionStatus('configured'));
        dispatch(addNotification({
          type: staleCatalog ? 'warning' : 'success',
          title: staleCatalog ? '模型缓存目录' : '模型列表',
          message: staleCatalog ? `上游刷新失败，继续使用 ${models.length} 个缓存模型` : `获取到 ${models.length} 个可用模型`,
        }));
        if (!staleCatalog && selectionBelongsToProvider(agentSettings.currentModel, 'openai', currentModels)
          && !models.some(m => m.id === agentSettings.currentModel)) {
          dispatch(setCurrentModel(''));
        }
        // ★ M4-5-S1：系统模型同款失效回退——已存系统模型不在新列表（端点下线）则回退空（跟随默认模型），
        // 防止后台任务（历史压缩、自动标题）静默用下线模型报错。
        if (agentSettings.systemModel
          && !staleCatalog
          && selectionBelongsToProvider(agentSettings.systemModel, 'openai', currentModels)
          && !models.some(m => m.id === agentSettings.systemModel)) {
          dispatch(setSystemModel(''));
        }
        dispatch(addNotification({ type: 'info', title: '请选择默认模型', message: '模型列表已刷新，请显式选择需要使用的模型。' }));
      } else {
        dispatch(setConnectionStatus('failed'));
      }
      return models;
    } catch {
      dispatch(setConnectionStatus('failed'));
      dispatch(addNotification({ type: 'error', title: '获取模型失败', message: '请检查 API Key 和端点' }));
      return [];
    } finally {
      setLoadingModels(false);
    }
  }, [availableModels, settings.providerCredentials?.openai?.configured, settings.apiEndpoints?.openai, agentSettings.currentModel, agentSettings.systemModel, dispatch]);

  const fetchOpenAICodexModels = useCallback(async () => {
    if (!settings.providerCredentials?.['openai-codex']?.configured) {
      dispatch(addNotification({ type: 'warning', title: 'ChatGPT 订阅未连接', message: '请先完成 OpenAI Codex 登录' }));
      return [];
    }
    const refreshEpoch = beginProviderCatalogRefresh('openai-codex');
    setLoadingModels(true);
    try {
      const models = await AIClient.fetchModels('https://chatgpt.com/backend-api', 'openai-codex');
      const credentialStatus = await refreshProviderCredentialStatus(dispatch, 'openai-codex');
      if (!credentialStatus.configured || !isProviderCatalogRefreshCurrent('openai-codex', refreshEpoch)) return [];
      const staleCatalog = models.some(model => model.catalog?.stale || model.catalog?.source === 'stale');
      const currentModels = store.getState().agentSettings.availableModels ?? [];
      const mergedModels = [
        ...currentModels.filter(model => providerIdForModel(model) !== 'openai-codex'),
        ...models,
      ];
      const dedupedModels = [...new Map(mergedModels.map(model => [model.id, model])).values()];
      setLocalAvailableModels(dedupedModels);
      dispatch(setAvailableModels(dedupedModels));
      if (!staleCatalog && selectionBelongsToProvider(agentSettings.currentModel, 'openai-codex', currentModels)
        && !models.some(model => model.id === agentSettings.currentModel)) {
        dispatch(setCurrentModel(''));
      }
      if (!staleCatalog && selectionBelongsToProvider(agentSettings.systemModel, 'openai-codex', currentModels)
        && !models.some(model => model.id === agentSettings.systemModel)) {
        dispatch(setSystemModel(''));
      }
      dispatch(addNotification({
        type: !credentialStatus.configured || staleCatalog || models.length === 0 ? 'warning' : 'success',
        title: !credentialStatus.configured ? 'ChatGPT 登录已失效' : staleCatalog ? 'ChatGPT 缓存目录' : 'ChatGPT 模型目录',
        message: !credentialStatus.configured
          ? '远端已拒绝当前凭据，请重新连接 ChatGPT'
          : staleCatalog
            ? `上游刷新失败，继续使用 ${models.length} 个缓存订阅模型`
            : models.length > 0 ? `获取到 ${models.length} 个订阅模型` : '目录未返回可用模型',
      }));
      return models;
    } finally {
      setLoadingModels(false);
    }
  }, [agentSettings.currentModel, agentSettings.systemModel, availableModels, dispatch, settings.providerCredentials]);

  const fetchWindsurfModels = useCallback(async () => {
    if (!settings.providerCredentials?.windsurf?.configured) {
      dispatch(addNotification({ type: 'warning', title: 'Windsurf 未连接', message: '请先连接 Windsurf，或从本机 Devin/Windsurf 导入账号' }));
      return [];
    }
    const refreshEpoch = beginProviderCatalogRefresh('windsurf');
    setLoadingModels(true);
    try {
      const models = await AIClient.fetchModels('', 'windsurf');
      const credentialStatus = await refreshProviderCredentialStatus(dispatch, 'windsurf');
      if (!credentialStatus.configured || !isProviderCatalogRefreshCurrent('windsurf', refreshEpoch)) return [];
      const staleCatalog = models.some(model => model.catalog?.stale || model.catalog?.source === 'stale');
      const currentModels = store.getState().agentSettings.availableModels ?? [];
      const mergedModels = [
        ...currentModels.filter(model => providerIdForModel(model) !== 'windsurf'),
        ...models,
      ];
      const dedupedModels = [...new Map(mergedModels.map(model => [model.id, model])).values()];
      setLocalAvailableModels(dedupedModels);
      dispatch(setAvailableModels(dedupedModels));
      if (!staleCatalog && selectionBelongsToProvider(agentSettings.currentModel, 'windsurf', currentModels)
        && !models.some(model => model.id === agentSettings.currentModel)) {
        dispatch(setCurrentModel(''));
      }
      if (!staleCatalog && selectionBelongsToProvider(agentSettings.systemModel, 'windsurf', currentModels)
        && !models.some(model => model.id === agentSettings.systemModel)) {
        dispatch(setSystemModel(''));
      }
      dispatch(addNotification({
        type: !credentialStatus.configured || staleCatalog || models.length === 0 ? 'warning' : 'success',
        title: !credentialStatus.configured ? 'Windsurf 登录已失效' : staleCatalog ? 'Windsurf 缓存目录' : 'Windsurf 模型目录',
        message: !credentialStatus.configured
          ? '远端已拒绝当前凭据，请重新连接 Windsurf'
          : staleCatalog
            ? `上游刷新失败，继续使用 ${models.length} 个缓存账号模型`
            : models.length > 0 ? `获取到 ${models.length} 个账号可用模型` : '目录未返回可调用模型',
      }));
      return models;
    } finally {
      setLoadingModels(false);
    }
  }, [agentSettings.currentModel, agentSettings.systemModel, availableModels, dispatch, settings.providerCredentials]);

  const handleWindsurfLocalImport = useCallback(async () => {
    if (!platform.provider) return;
    setWindsurfBusy(true);
    setWindsurfLocalImportMessage('正在只读检查本机 Devin/Windsurf 登录状态，成功后只会写入 Synapse 的安全存储副本。');
    try {
      let outcome = await importLocalWindsurfCredential(dispatch);
      if (!outcome.result.ok && outcome.result.error?.code === 'replace_required') {
        const error = outcome.result.error;
        const confirmed = await confirmAction({
          title: '替换 Windsurf 账号？',
          message: `当前 Synapse 账号：${error.existingAccountLabel || '未命名账号'}；本机候选账号：${error.candidateAccountLabel || describeWindsurfCandidates(error.candidates) || '未命名账号'}。确认后只替换 Synapse 的加密副本，不修改 Devin/Windsurf 原始登录状态。`,
          confirmLabel: '替换为本机账号',
          tone: 'danger',
        });
        if (!confirmed) {
          setWindsurfStatus(outcome.result.status);
          setWindsurfLocalImportMessage('已取消本机导入，Synapse 未改动现有 Windsurf 账号。');
          dispatch(addNotification({ type: 'info', title: '已取消导入', message: '没有替换 Synapse 中已有的 Windsurf 账号' }));
          return;
        }
        setWindsurfLocalImportMessage('正在替换 Synapse 中的 Windsurf 凭据副本，不会修改源客户端。');
        outcome = await importLocalWindsurfCredential(dispatch, error.confirmationToken);
      }
      setWindsurfStatus(outcome.result.status);
      setLocalAvailableModels(store.getState().agentSettings.availableModels ?? []);
      if (!outcome.result.ok) {
        const candidates = describeWindsurfCandidates(outcome.result.error?.candidates ?? outcome.result.candidates);
        const message = `${outcome.result.error?.message ?? '本机导入失败'}${candidates ? ` 候选：${candidates}` : ''}`;
        setWindsurfLocalImportMessage(message);
        dispatch(addNotification({ type: 'error', title: '本机导入失败', message }));
        return;
      }
      const accountLabel = outcome.result.accountLabel ? `「${outcome.result.accountLabel}」` : '本机账号';
      const action = outcome.result.unchanged
        ? '已连接同一个本机账号，无需重复导入'
        : outcome.result.replaced
          ? `已替换为 ${accountLabel}`
          : `已导入 ${accountLabel}`;
      if (outcome.catalogError) {
        setWindsurfLocalImportMessage(`${action}；账号状态已刷新，但模型目录刷新失败，请稍后手动刷新。`);
        dispatch(addNotification({ type: 'warning', title: '账号已导入', message: outcome.catalogError }));
      } else {
        setWindsurfLocalImportMessage(`${action}；已刷新账号状态和 ${outcome.models.length} 个 Windsurf 模型。`);
        dispatch(addNotification({ type: 'success', title: 'Windsurf 已导入', message: `${action}，模型目录已刷新` }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法导入本机 Windsurf/Devin 账号';
      setWindsurfLocalImportMessage(message);
      dispatch(addNotification({ type: 'error', title: '本机导入失败', message }));
    } finally {
      setWindsurfBusy(false);
    }
  }, [dispatch]);

  const refreshMcpStatus = useCallback(async () => {
    if (!isElectron) return;
    setLoadingMcpStatus(true);
    try {
      const result = await platform.mcp.getStatus();
      const servers = Array.isArray(result?.servers) ? result.servers : [];
      const next: Record<string, McpServerInfo> = {};
      for (const server of servers) {
        if (server?.name) {
          next[server.name] = server;
        }
      }
      setMcpServers(next);
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: 'MCP 状态读取失败', message: error?.message ?? '请检查 Electron IPC 状态' }));
    } finally {
      setLoadingMcpStatus(false);
    }
  }, [dispatch]);

  useEffect(() => {
    if (activeTab === 'plugins') {
      void refreshMcpStatus();
      void extensionManager.loadRulesFromFS().then(() => {
        setPluginRules(extensionManager.getRulesSources().map(rule => ({
          name: rule.name,
          description: rule.description,
          status: rule.status === 'loaded' ? `已加载 ${rule.contentLength} 字符` : '未配置',
          source: rule.path,
          sourceType: rule.sourceType,
          icon: rule.status === 'loaded' ? '📘' : '📄',
        })));
      });
    }
  }, [activeTab, refreshMcpStatus]);

  const handleRestartMcp = useCallback(async (name: string) => {
    try {
      await platform.mcp.restart(name);
      // ★ M4-7-S4：重启后刷新桥接，使该 server 的工具（可能列表变化）重新进/出 toolRegistry。
      await mcpBridge.refresh();
      dispatch(addNotification({ type: 'success', title: 'MCP 已重启', message: `${name} 已重新启动` }));
      await refreshMcpStatus();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: 'MCP 重启失败', message: error?.message ?? name }));
    }
  }, [dispatch, refreshMcpStatus]);

  const handleStartMcp = useCallback(async (name: string) => {
    try {
      // ★ M4-7-S4：经 mcpBridge.startServer 启动——启动成功后内部 refresh 把该 server 的工具桥接进 toolRegistry。
      //   ★ M4-7 审查修复：AgentLoop 已改为发请求前实时从 toolRegistry 动态取 schema（registerTools 传入
      //   getSchemas 取数函数），故启动后【当前会话下一轮 send 即可调用】新工具——无需重建 AgentLoop / 切模型 / 重开会话。
      await mcpBridge.startServer(name);
      dispatch(addNotification({ type: 'success', title: 'MCP 已启动', message: `${name} 已启动` }));
      await refreshMcpStatus();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: 'MCP 启动失败', message: error?.message ?? name }));
    }
  }, [dispatch, refreshMcpStatus]);

  const handleOpenExtensionPath = useCallback(async (source: string) => {
    if (!isElectron) return;
    try {
      const result = await platform.file.showInFolder(source);
      if (result.error) throw new Error(result.message || '路径不存在或无法打开');
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '打开来源失败', message: error?.message ?? source }));
    }
  }, [dispatch]);

  const updateSynopsisSettings = useCallback((updates: Partial<typeof synopsisSettings>) => {
    dispatch(setSynopsisSettings(updates));
    dispatch(addNotification({ type: 'success', title: 'Synopsis 设置已保存', message: '参数已写入本地设置' }));
  }, [dispatch]);

  // ★ M3-2c：新建一个空白固定工作流模板（带一个默认 agent 节点起步），创建后直接进入编辑器。
  // ★ M3-2c#fix：不再立即 addMode——构造为本地草稿（draftMode），onSave 才落库、onCancel 直接丢弃，
  //   彻底消除「新建 → 取消」在列表/localStorage 残留空壳模板的问题。id 用唯一生成防同毫秒碰撞。
  const createWorkflowTemplate = useCallback(() => {
    const nextIndex = (multiAI?.modes || []).filter((mode: any) => !mode.isBuiltIn && !mode.isBuiltin).length + 1;
    const id = genUniqueId('wf');
    const mode: MultiAIMode = {
      id,
      name: `自定义工作流 ${nextIndex}`,
      description: '自定义固定工作流模板，可通过 @MultiAI 触发。',
      agentCount: 2,
      isBuiltin: false,
      isBuiltIn: false,
      mainAgentRole: '你是固定工作流的协调者，按节点编排推进任务。',
      subagents: [],
      triggerConditions: ['userRequest'],
      workflow: [
        {
          id: genUniqueId('agent'),
          type: 'agent',
          subagent: {
            id: genUniqueId('sub'),
            name: '执行者',
            role: '理解并完成任务',
            model: '',
            systemPrompt: '',
            toolPermissions: ['read', 'search'],
            maxTokens: 4096,
          },
          taskTemplate: '{{userInput}}',
        },
      ],
    };
    setDraftMode(mode);
    setEditingModeId(id);
  }, [multiAI?.modes]);

  // ★ M3-2c：把内建模式复制为一个新的可编辑自定义模板（内建只读，复制后才可改）。
  // ★ M3-2c#fix：同样走草稿（复制也是「新建未保存」语义，取消应丢弃，不留空壳）。id 唯一生成防碰撞。
  const duplicateModeAsTemplate = useCallback((source: MultiAIMode) => {
    const id = genUniqueId('wf');
    const cloned: MultiAIMode = {
      ...JSON.parse(JSON.stringify(source)) as MultiAIMode,
      id,
      name: `${source.name} (副本)`,
      isBuiltin: false,
      isBuiltIn: false,
    };
    setDraftMode(cloned);
    setEditingModeId(id);
  }, []);

  // ★ M3-2c：保存编辑器产出（落库走 persistMiddleware；workflow 是配置类字段，仍持久化）。
  // ★ M3-2c#fix：区分「新建未保存草稿」与「编辑已存在」——草稿（id 不在 modes 里）首次保存走 addMode，
  //   已存在走 updateMode。updates 含 subagents:[]（编辑器已归一，消除复制内建后的 subagents 僵尸数据）。
  const saveWorkflowTemplate = useCallback((id: string, updates: { name: string; description: string; workflow: WorkflowNode[]; agentCount: number; subagents: [] }) => {
    const exists = (multiAI?.modes || []).some((m: any) => m.id === id);
    if (!exists && draftMode && draftMode.id === id) {
      // 草稿首次保存：以草稿为基底，覆盖编辑器产出的字段后整条 addMode（保留 mainAgentRole/triggerConditions）。
      dispatch(addMode({ ...draftMode, ...updates }));
    } else {
      dispatch(updateMode({ id, updates }));
    }
    setDraftMode(null);
    setEditingModeId(null);
    dispatch(addNotification({ type: 'success', title: '模板已保存', message: `${updates.name} 已保存到本地设置` }));
  }, [dispatch, multiAI?.modes, draftMode]);

  // ★ M3-2c#fix：取消编辑——丢弃草稿（若有）并返回列表。草稿从未落库，无需 removeMode。
  const cancelWorkflowEdit = useCallback(() => {
    setDraftMode(null);
    setEditingModeId(null);
  }, []);

  // ★ M3-2c：删除自定义模板（内建不可删，removeMode reducer 已对 isBuiltIn 做保护）。
  // ★ M3-2c#fix：草稿（未落库）删除时只丢草稿、不 dispatch removeMode（store 里本就没有它）。
  const deleteWorkflowTemplate = useCallback(async (mode: MultiAIMode) => {
    const isDraft = Boolean(draftMode && draftMode.id === mode.id && !(multiAI?.modes || []).some((m: any) => m.id === mode.id));
    if (!await confirmAction({
      title: '删除工作流模板？',
      message: `即将删除「${mode.name}」，此操作不可恢复。`,
      confirmLabel: '确认删除',
      tone: 'danger',
    })) return;
    if (!isDraft) {
      dispatch(removeMode(mode.id));
      dispatch(addNotification({ type: 'warning', title: '模板已删除', message: `${mode.name} 已删除` }));
    }
    setDraftMode(null);
    setEditingModeId(null);
  }, [dispatch, draftMode, multiAI?.modes]);

  const refreshStorageUsage = useCallback(async () => {
    setLoadingStorageUsage(true);
    try {
      setStorageUsage(await calculateStorageUsage());
    } finally {
      setLoadingStorageUsage(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'data') {
      void refreshStorageUsage();
    }
  }, [activeTab, refreshStorageUsage]);

  const exportConversations = useCallback(async () => {
    const conversations = collectLocalStorage(isConversationStorageKey);
    const summaries = await listConversationSummaries().catch(() => []);
    const snapshots = await Promise.all(
      summaries.map(async (summary) => ({
        summary,
        snapshot: await exportConversationSnapshot(summary.id).catch(() => null),
      })),
    );
    downloadJson('conversations.json', {
      type: 'synapse-conversations',
      exportedAt: new Date().toISOString(),
      environment: isElectron ? 'electron' : 'web',
      conversations,
      platformConversations: snapshots.filter(item => item.snapshot),
    });
    dispatch(addNotification({
      type: 'success',
      title: '导出成功',
      message: `已导出 ${snapshots.filter(item => item.snapshot).length} 个持久化对话和 ${Object.keys(conversations).length} 个旧存储条目`,
    }));
  }, [dispatch]);

  const clearConversationHistory = useCallback(async () => {
    if (!await confirmAction({
      title: '清除所有对话历史？',
      message: '所有持久化对话与旧存储记录都会删除，此操作不可恢复。工作区文件不会被删除。',
      confirmLabel: '全部清除',
      tone: 'danger',
    })) return;
    const summaries = await listConversationSummaries().catch(() => []);
    try {
      await deleteConversationSnapshots(summaries.map(summary => summary.id));
    } catch {
      dispatch(addNotification({
        type: 'error',
        title: '清除失败',
        message: '持久化对话没有全部删除，当前历史仍保留，请稍后重试',
      }));
      return;
    }
    const removed = removeLocalStorage(isConversationStorageKey);
    dispatch(clearConversation());
    dispatch(setConversations([]));
    dispatch(setSelectedId(null));
    void refreshStorageUsage();
    dispatch(addNotification({
      type: 'warning',
      title: '对话历史已清除',
      message: `已删除 ${summaries.length} 个持久化对话并移除 ${removed} 个旧存储条目`,
    }));
  }, [dispatch, refreshStorageUsage]);

  const clearCache = useCallback(() => {
    const removed = removeLocalStorage(isCacheStorageKey);
    void refreshStorageUsage();
    dispatch(addNotification({ type: 'success', title: '缓存已清理', message: `已移除 ${removed} 个缓存条目` }));
  }, [dispatch, refreshStorageUsage]);

  // ── git worktree (M2-4) 操作 ──
  const pickWorktreeRepo = useCallback(async () => {
    if (!isElectron) return;
    try {
      const ws = await platform.workspace.open();
      if (ws?.path) {
        setWorktreeRepoRoot(ws.path);
        setWorktrees([]);
        setWorktreeLoaded(false);
      }
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '选择仓库失败', message: error?.message ?? '无法打开文件夹选择器' }));
    }
  }, [dispatch]);

  const refreshWorktrees = useCallback(async () => {
    if (!isElectron || !platform.worktree) return;
    const repoRoot = worktreeRepoRoot.trim();
    if (!repoRoot) {
      dispatch(addNotification({ type: 'warning', title: '未选择仓库', message: '请先选择一个 git 仓库目录' }));
      return;
    }
    setWorktreeBusy(true);
    try {
      const result = await platform.worktree.list({ repoRoot });
      if (result?.error) {
        setWorktrees([]);
        setWorktreeLoaded(true);
        dispatch(addNotification({ type: 'error', title: '列出工作树失败', message: result.message ?? '请确认目录是 git 仓库' }));
        return;
      }
      setWorktrees(result.worktrees ?? []);
      setWorktreeLoaded(true);
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '列出工作树失败', message: error?.message ?? '未知错误' }));
    } finally {
      setWorktreeBusy(false);
    }
  }, [dispatch, worktreeRepoRoot]);

  const createWorktree = useCallback(async () => {
    if (!isElectron || !platform.worktree) return;
    const repoRoot = worktreeRepoRoot.trim();
    const branch = worktreeNewBranch.trim();
    if (!repoRoot) {
      dispatch(addNotification({ type: 'warning', title: '未选择仓库', message: '请先选择一个 git 仓库目录' }));
      return;
    }
    if (!branch) {
      dispatch(addNotification({ type: 'warning', title: '缺少分支名', message: '请输入新建工作树的分支名' }));
      return;
    }
    setWorktreeBusy(true);
    try {
      const result = await platform.worktree.create({ repoRoot, branch });
      if (result?.error) {
        dispatch(addNotification({ type: 'error', title: '新建工作树失败', message: result.message ?? '请检查分支名是否合法或已存在' }));
        return;
      }
      dispatch(addNotification({ type: 'success', title: '工作树已创建', message: `${branch} → ${result.path ?? ''}` }));
      setWorktreeNewBranch('');
      await refreshWorktrees();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '新建工作树失败', message: error?.message ?? '未知错误' }));
    } finally {
      setWorktreeBusy(false);
    }
  }, [dispatch, worktreeRepoRoot, worktreeNewBranch, refreshWorktrees]);

  const removeWorktree = useCallback(async (targetPath: string) => {
    if (!isElectron || !platform.worktree) return;
    const repoRoot = worktreeRepoRoot.trim();
    if (!repoRoot) return;
    // 二次确认：worktree remove 会操作 .git，force 模式可能丢弃未提交改动。
    const warnForce = worktreeForce
      ? '\n\n⚠️ 已勾选「强制删除」：该工作树内未提交的改动将被永久丢弃，且不可恢复！'
      : '';
    const confirmed = await confirmAction({
      title: '删除工作树？',
      message: `${targetPath}\n\n此操作会移除该工作树目录并更新仓库的 .git 记录。${warnForce}`,
      confirmLabel: worktreeForce ? '强制删除' : '确认删除',
      tone: 'danger',
    });
    if (!confirmed) return;
    setWorktreeBusy(true);
    try {
      const result = await platform.worktree.remove({ repoRoot, path: targetPath, force: worktreeForce });
      if (result?.error) {
        dispatch(addNotification({
          type: 'error',
          title: '删除工作树失败',
          message: result.message ?? '若有未提交改动，可勾选「强制删除」后重试（会丢弃改动）',
        }));
        return;
      }
      dispatch(addNotification({ type: 'warning', title: '工作树已删除', message: targetPath }));
      // ★ 审查 MEDIUM：清掉所有仍指向该已删 worktree 的运行态条目，防后续 fs/命令重定向到已不存在的目录。
      dispatch(exitWorktreeByPath({ path: targetPath }));
      await refreshWorktrees();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '删除工作树失败', message: error?.message ?? '未知错误' }));
    } finally {
      setWorktreeBusy(false);
    }
  }, [dispatch, worktreeRepoRoot, worktreeForce, refreshWorktrees]);

  const exportSettings = useCallback(() => {
    const settingsDump = sanitizeSettingsMap(collectLocalStorage(isSettingsStorageKey));
    downloadJson('synapse-settings.json', {
      type: 'synapse-settings',
      exportedAt: new Date().toISOString(),
      environment: isElectron ? 'electron' : 'web',
      settings: settingsDump,
    });
    dispatch(addNotification({ type: 'success', title: '设置已导出', message: `已导出 ${Object.keys(settingsDump).length} 个设置条目` }));
  }, [dispatch]);

  const importSettings = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const settingsDump = parsed?.settings ?? parsed;
      if (!settingsDump || typeof settingsDump !== 'object' || Array.isArray(settingsDump)) {
        throw new Error('导入文件缺少 settings 对象');
      }
      let imported = 0;
      for (const [key, value] of Object.entries(settingsDump)) {
        if (!isSettingsStorageKey(key) || isSensitiveSettingsKey(key)) continue;
        const sanitized = sanitizeSettingsValue(value);
        localStorage.setItem(key, serializeStorageValue(sanitized));
        imported += 1;
      }
      if (imported === 0) {
        throw new Error('导入文件没有可识别的 Synapse 设置键');
      }
      dispatch(addNotification({ type: 'success', title: '设置已导入', message: `已导入 ${imported} 个设置条目，页面将刷新` }));
      window.setTimeout(() => window.location.reload(), 300);
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '导入失败', message: error?.message ?? 'JSON 解析失败' }));
    }
  }, [dispatch]);

  // 壁纸选择
  const handleWallpaperSelect = useCallback(async () => {
    if (isElectron && platform.wallpaper?.importFromDialog) {
      try {
        const assets = await platform.wallpaper.importFromDialog();
        if (assets.length === 0) return;
        dispatch(addBackgroundImages(assets as WallpaperImage[]));
        dispatch(addNotification({ type: 'success', title: '壁纸', message: `已导入 ${assets.length} 张壁纸到受管目录` }));
      } catch (error: any) {
        dispatch(addNotification({ type: 'error', title: '壁纸导入失败', message: error?.message ?? '请选择有效的图片文件' }));
      }
      return;
    }
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.onchange = async (ev: any) => {
      const files = Array.from(ev.target?.files || []) as File[];
      if (files.length === 0) return;
      try {
        const images = await Promise.all(files.map((file, index) => readImageAsDataUrl(file, index)));
        dispatch(addBackgroundImages(images));
        dispatch(addNotification({ type: 'success', title: '壁纸', message: `已添加 ${files.length} 张壁纸` }));
      } catch {
        dispatch(addNotification({ type: 'error', title: '壁纸读取失败', message: '请选择有效的图片文件' }));
      }
    };
    fileInput.click();
  }, [dispatch]);

  const handleRemoveWallpaper = useCallback(async (index: number) => {
    const item = backgroundSettings.images[index] as WallpaperImage | undefined;
    if (isManagedWallpaper(item) && platform.wallpaper?.remove) {
      const result = await platform.wallpaper.remove(item);
      if (result?.error) {
        dispatch(addNotification({ type: 'error', title: '壁纸删除失败', message: result.message ?? '受管壁纸文件删除失败' }));
        return;
      }
    }
    dispatch(removeBackgroundImage(index));
  }, [backgroundSettings.images, dispatch]);

  // 清除壁纸
  const handleClearWallpaper = useCallback(async () => {
    const managed = backgroundSettings.images.filter(isManagedWallpaper);
    if (managed.length > 0 && platform.wallpaper?.clear) {
      const result = await platform.wallpaper.clear(managed);
      if (result?.error) {
        dispatch(addNotification({ type: 'error', title: '壁纸清除失败', message: result.message ?? '受管壁纸文件清除失败' }));
        return;
      }
    }
    dispatch(clearBackgroundImages());
  }, [backgroundSettings.images, dispatch]);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    tabsRef.current?.scrollBy({
      left: direction === 'left' ? -160 : 160,
      behavior: 'smooth',
    });
  }, []);

  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>(`[data-settings-tab="${activeTab}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  // ★ M4-6-S2：@设置 跳转定位——监听 `synapse:settings-focus-section`，按 sectionId 切到对应分区 tab。
  //   sectionId 来自 atSources/settingsIndex（已与本组件 tabs[].id 对齐：general/ai/conversation/...）。
  //   未知 sectionId 安全忽略（no-op），未挂载时本 effect 不存在天然不触发（事件无监听者 → no-op）。
  useEffect(() => {
    const onFocusSection = (event: Event) => {
      const sectionId = (event as CustomEvent<string | undefined>).detail;
      if (!sectionId) return;
      if (tabs.some(t => t.id === sectionId)) {
        setActiveTab(sectionId);
      }
    };
    window.addEventListener('synapse:settings-focus-section', onFocusSection);
    return () => window.removeEventListener('synapse:settings-focus-section', onFocusSection);
    // tabs 是组件内每次渲染重建的常量数组，但内容稳定；依赖留空只在挂载/卸载时绑定监听。
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSettingsTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Tab' && !event.shiftKey) {
      const focusTarget = Array.from(
        settingsContentRef.current?.querySelectorAll<HTMLElement>(SETTINGS_PANEL_FOCUSABLE_SELECTOR) ?? [],
      ).find(isKeyboardReachableSettingElement);
      if (focusTarget) {
        event.preventDefault();
        focusTarget.focus();
      }
      return;
    }

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    setActiveTab(next.id);
    requestAnimationFrame(() => {
      tabsRef.current?.querySelector<HTMLElement>(`[data-settings-tab="${next.id}"]`)?.focus();
    });
  };

  return (
    <div className="settings-panel">
      <div className="settings-tabs-shell">
        <button className="settings-tabs-nav" type="button" tabIndex={-1} aria-label="向左滚动设置标签" onClick={() => scrollTabs('left')}>
          ‹
        </button>
        <div className="settings-tabs" ref={tabsRef} role="tablist" aria-label="设置分类">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={event => handleSettingsTabKeyDown(event, index)}
              title={tab.label}
              data-settings-tab={tab.id}
              id={`settings-tab-${tab.id}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="settings-active-panel"
              tabIndex={activeTab === tab.id ? 0 : -1}
            >
              <span className="settings-tab-label">{tab.label}</span>
            </button>
          ))}
        </div>
        <button className="settings-tabs-nav" type="button" tabIndex={-1} aria-label="向右滚动设置标签" onClick={() => scrollTabs('right')}>
          ›
        </button>
      </div>

      <div
        className="settings-content"
        id="settings-active-panel"
        ref={settingsContentRef}
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        tabIndex={-1}
      >
        {activeTab === 'general' && (
          <div className="settings-section">
            <h3>通用设置</h3>
            <div className="setting-item">
              <label>语言</label>
              <select value={settings.language} onChange={e => {
                dispatch(setLanguage(e.target.value as 'zh-CN' | 'en'));
                dispatch(addNotification({ type: 'info', title: '语言设置', message: '多语言界面即将支持，当前仅保存偏好。' }));
              }}>
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="setting-item">
              <label>字号</label>
              <input type="range" min="12" max="20" step="1" value={settings.fontSize}
                onChange={e => dispatch(setFontSize(Number(e.target.value)))} />
              <span>{settings.fontSize}px</span>
            </div>
            <div className="setting-item">
              <label>主题</label>
              <select value={theme.mode} onChange={e => dispatch(setThemeMode(e.target.value as 'dark' | 'light' | 'system'))}>
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
              </select>
            </div>
            <div className="setting-item">
              <label>强调色</label>
              <input type="color" value={theme.accentColor} onChange={e => dispatch(setAccentColor(e.target.value))} />
            </div>
            <div className="setting-item">
              <label>文件树最大深度</label>
              <input type="range" min="3" max="20" step="1" value={settings.fileTreeMaxDepth ?? 8}
                onChange={e => dispatch(setFileTreeMaxDepth(Number(e.target.value)))} />
              <span>{settings.fileTreeMaxDepth ?? 8} 层</span>
            </div>

            <h3 style={{ marginTop: 24 }}>🖼️ 壁纸与磨砂</h3>
            <ToggleItem label="启用壁纸" checked={backgroundSettings.enabled}
              onChange={v => dispatch(setBackgroundSettings({ enabled: v }))} />
            <div className="setting-item">
              <label>背景图</label>
              <div className="setting-control-row">
                <button className="settings-btn" onClick={handleWallpaperSelect}>
                  📁 选择图片
                </button>
                {backgroundSettings.images.length > 0 && (
                  <button className="settings-btn danger" onClick={handleClearWallpaper}>
                    ✕ 清除
                  </button>
                )}
              </div>
            </div>
            {backgroundSettings.images.length > 0 && (
              <div className="setting-item">
                <label>已添加 ({backgroundSettings.images.length})</label>
                <div className="wallpaper-grid">
                  {backgroundSettings.images.map((bg: WallpaperImage, i: number) => (
                    <button
                      key={`${bg.id ?? getWallpaperUrl(bg).slice(0, 24)}-${i}`}
                      type="button"
                      className={`wallpaper-thumb ${i === backgroundSettings.selectedIndex ? 'active' : ''}`}
                      style={{ backgroundImage: `url(${getWallpaperUrl(bg)})` }}
                      aria-label={`选择 ${getWallpaperName(bg, i)}`}
                      title={`${getWallpaperName(bg, i)}${bg.kind === 'managed' ? ' · 受管文件' : ' · Web 本地数据'}`}
                      onClick={() => dispatch(selectBackgroundImage(i))}
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        className="wallpaper-remove"
                        aria-label={`删除第 ${i + 1} 张壁纸`}
                        onClick={event => {
                          event.stopPropagation();
                          void handleRemoveWallpaper(i);
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleRemoveWallpaper(i);
                          }
                        }}
                      >
                        ×
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="setting-item">
              <label>轮播模式</label>
              <select value={backgroundSettings.displayMode} onChange={e => dispatch(setBackgroundSettings({ displayMode: e.target.value as any }))}>
                <option value="static">静态</option>
                <option value="carousel">顺序轮播</option>
                <option value="random">随机切换</option>
              </select>
            </div>
            {backgroundSettings.displayMode !== 'static' && (
              <div className="setting-item">
                <label>切换间隔</label>
                <input type="range" min="10" max="600" step="10" value={backgroundSettings.carouselInterval}
                  onChange={e => dispatch(setBackgroundSettings({ carouselInterval: Number(e.target.value) }))} />
                <span>{backgroundSettings.carouselInterval}s</span>
              </div>
            )}
            <div className="setting-item">
              <label>切换效果</label>
              <select value={backgroundSettings.transitionEffect} onChange={e => dispatch(setBackgroundSettings({ transitionEffect: e.target.value as any }))}>
                <option value="fade">淡入淡出</option>
                <option value="slide">滑动</option>
              </select>
            </div>
            <div className="setting-item">
              <label>磨砂度</label>
              <input type="range" min="0" max="30" step="1" value={backgroundSettings.blur}
                onChange={e => dispatch(setBackgroundSettings({ blur: Number(e.target.value) }))} />
              <span>{backgroundSettings.blur}px</span>
            </div>
            <div className="setting-item">
              <label>壁纸透明度</label>
              <input type="range" min="10" max="100" step="5"
                value={Math.round(backgroundSettings.opacity * 100)}
                onChange={e => dispatch(setBackgroundSettings({ opacity: Number(e.target.value) / 100 }))} />
              <span>{Math.round(backgroundSettings.opacity * 100)}%</span>
            </div>
            <div className="setting-item">
              <label>面板透明度</label>
              <input type="range" min="50" max="95" step="5"
                value={Math.round(backgroundSettings.panelOpacity * 100)}
                onChange={e => dispatch(setBackgroundSettings({ panelOpacity: Number(e.target.value) / 100 }))} />
              <span>{Math.round(backgroundSettings.panelOpacity * 100)}%</span>
            </div>

            {/* ★ #19 个性化：用户/AI 头像 + 昵称。头像走 AvatarUpload（压缩裁剪输出 dataURL），
                昵称留空时聊天界面回退默认「你」/「Synapse AI」。 */}
            <h3 style={{ marginTop: 24 }}>🎭 个性化</h3>
            <div className="setting-item">
              <label>用户头像</label>
              <AvatarUpload
                variant="user"
                label="用户头像"
                value={settings.userAvatar}
                onChange={(dataUrl) => dispatch(setUserAvatar(dataUrl))}
              />
            </div>
            <div className="setting-item">
              <label>用户昵称</label>
              <input
                type="text"
                placeholder="你"
                maxLength={24}
                value={settings.userName ?? ''}
                onChange={e => dispatch(setUserName(e.target.value))}
              />
              <span className="setting-hint">聊天界面里你的消息显示的名字，留空则显示「你」。</span>
            </div>
            <div className="setting-item">
              <label>AI 头像</label>
              <AvatarUpload
                variant="ai"
                label="AI 头像"
                value={settings.aiAvatar}
                onChange={(dataUrl) => dispatch(setAiAvatar(dataUrl))}
              />
            </div>
            <div className="setting-item">
              <label>AI 昵称</label>
              <input
                type="text"
                placeholder="Synapse AI"
                maxLength={24}
                value={settings.aiName ?? ''}
                onChange={e => dispatch(setAiName(e.target.value))}
              />
              <span className="setting-hint">聊天界面里 AI 消息显示的名字，留空则显示「Synapse AI」。</span>
            </div>
          </div>
        )}

        {activeTab === 'ai' && (
          <div className="settings-section">
            <h3>AI 设置</h3>
            <div className="setting-item">
              <label>API Key</label>
              <input type="password" placeholder="sk-..."
                autoComplete="new-password"
                value={apiKeyDraft}
                onChange={e => setApiKeyDraft(e.target.value)} />
              <div className="setting-control-row">
                <button className="settings-btn" disabled={!apiKeyDraft.trim()}
                  onClick={async () => {
                    try {
                      const status = await saveProviderApiKey(dispatch, 'openai', apiKeyDraft, settings.apiEndpoints?.openai ?? '');
                      setApiKeyDraft('');
                      dispatch(addNotification({
                        type: 'success',
                        title: '凭据已保存',
                        message: status.persisted ? '已写入系统安全存储' : '系统加密不可用，仅在本次运行中保存',
                      }));
                    } catch (error) {
                      dispatch(addNotification({ type: 'error', title: '凭据保存失败', message: error instanceof Error ? error.message : '无法保存凭据' }));
                    }
                  }}>保存或替换</button>
                <button className="settings-btn" disabled={!settings.providerCredentials?.openai?.configured}
                  onClick={async () => {
                    await removeProviderCredential(dispatch, 'openai');
                    setApiKeyDraft('');
                    dispatch(setConnectionStatus('missing'));
                  }}>删除凭据</button>
              </div>
              <span className="setting-hint">
                {settings.providerCredentials?.openai?.configured
                  ? `已配置 · ${settings.providerCredentials.openai.persisted ? '系统安全存储' : '仅本次运行'}`
                  : '未配置。保存后不会再次回显完整 Key。'}
              </span>
              <span className="setting-hint">凭据会与保存当时的 API 端点绑定；修改端点后请再次点击「保存或替换」。</span>
            </div>
            <div className="setting-item">
              <label>API 端点</label>
              <input type="text" placeholder="https://api.openai.com/v1"
                value={settings.apiEndpoints?.openai ?? ''}
                onChange={e => dispatch(setApiEndpoint({ provider: 'openai', url: e.target.value }))} />
            </div>
            <div className="setting-item">
              <label>ChatGPT / Codex 订阅</label>
              <div className="setting-control-row">
                {!openAICodexConnected && !['starting', 'waiting'].includes(openAICodexStatus?.state ?? '') && (
                  <button className="settings-btn" disabled={openAICodexBusy || !platform.provider}
                    onClick={async () => {
                      if (!platform.provider) return;
                      setOpenAICodexBusy(true);
                      try {
                        const status = await platform.provider.openAICodexLogin();
                        setOpenAICodexStatus(status);
                        await refreshProviderCredentialStatus(dispatch, 'openai-codex');
                      } catch (error) {
                        dispatch(addNotification({
                          type: 'error',
                          title: '订阅登录失败',
                          message: error instanceof Error ? error.message : '无法启动登录',
                        }));
                      } finally {
                        setOpenAICodexBusy(false);
                      }
                    }}>连接 ChatGPT</button>
                )}
                {['starting', 'waiting'].includes(openAICodexStatus?.state ?? '') && (
                  <button className="settings-btn" disabled={openAICodexBusy}
                    onClick={async () => {
                      if (!platform.provider) return;
                      setOpenAICodexBusy(true);
                      try {
                        setOpenAICodexStatus(await platform.provider.openAICodexCancel());
                        await refreshProviderCredentialStatus(dispatch, 'openai-codex');
                      } finally {
                        setOpenAICodexBusy(false);
                      }
                    }}>取消登录</button>
                )}
                {openAICodexConnected && (
                  <>
                    <button className="settings-btn" disabled={loadingModels} onClick={() => void fetchOpenAICodexModels()}>
                      {loadingModels ? '刷新中...' : '刷新订阅模型'}
                    </button>
                    <button className="settings-btn" disabled={openAICodexBusy}
                      onClick={async () => {
                        if (!platform.provider) return;
                        const confirmed = await confirmAction({
                          title: '退出 ChatGPT 订阅？',
                          message: '这会删除 Synapse 安全存储中的订阅登录状态，不影响其它应用。',
                          confirmLabel: '退出登录',
                          tone: 'danger',
                        });
                        if (!confirmed) return;
                        invalidateProviderCatalogRefresh('openai-codex');
                        setOpenAICodexBusy(true);
                        try {
                          setOpenAICodexStatus(await platform.provider.openAICodexLogout());
                          await refreshProviderCredentialStatus(dispatch, 'openai-codex');
                           const remaining = availableModels.filter(model => providerIdForModel(model) !== 'openai-codex');
                          setLocalAvailableModels(remaining);
                          dispatch(setAvailableModels(remaining));
                          if (agentSettings.currentModel.startsWith('openai-codex:')) dispatch(setCurrentModel(''));
                          if (agentSettings.systemModel?.startsWith('openai-codex:')) dispatch(setSystemModel(''));
                        } finally {
                          setOpenAICodexBusy(false);
                        }
                      }}>退出登录</button>
                  </>
                )}
              </div>
              <span className="setting-hint">
                {openAICodexConnected
                  ? `已连接 · ${(openAICodexStatus?.persisted ?? settings.providerCredentials?.['openai-codex']?.persisted) ? '系统安全存储' : '仅本次运行'}`
                  : openAICodexStatus?.state === 'waiting'
                    ? '等待浏览器授权回调，Synapse 不会把令牌交给页面。'
                    : openAICodexStatus?.error || '可复用已授权的本机加密登录状态，完整令牌不会进入 Redux 或 localStorage。'}
              </span>
            </div>
            <div className="setting-item">
              <label>Windsurf / Devin 订阅</label>
              <div className="setting-control-row">
                {!windsurfConnected && !['waiting', 'exchanging'].includes(windsurfStatus?.state ?? '') && (
                  <button className="settings-btn" disabled={windsurfBusy || !platform.provider}
                    onClick={async () => {
                      if (!platform.provider) return;
                      setWindsurfLocalImportMessage(null);
                      setWindsurfBusy(true);
                      try {
                        setWindsurfStatus(await platform.provider.windsurfLogin());
                      } catch (error) {
                        dispatch(addNotification({ type: 'error', title: 'Windsurf 登录失败', message: error instanceof Error ? error.message : '无法启动登录' }));
                      } finally {
                        setWindsurfBusy(false);
                      }
                    }}>连接 Windsurf</button>
                )}
                {!['waiting', 'exchanging'].includes(windsurfStatus?.state ?? '') && (
                  <button className="settings-btn" disabled={windsurfBusy || loadingModels || !platform.provider}
                    onClick={() => void handleWindsurfLocalImport()}>
                    {windsurfBusy ? '处理中...' : windsurfConnected ? '从本机重新导入' : '从本机 Devin/Windsurf 导入'}
                  </button>
                )}
                {['waiting', 'exchanging'].includes(windsurfStatus?.state ?? '') && (
                  <button className="settings-btn" disabled={windsurfBusy}
                    onClick={async () => {
                      if (!platform.provider) return;
                      setWindsurfBusy(true);
                      try {
                        setWindsurfStatus(await platform.provider.windsurfCancel());
                        setWindsurfTokenDraft('');
                        await refreshProviderCredentialStatus(dispatch, 'windsurf');
                      } finally {
                        setWindsurfBusy(false);
                      }
                    }}>取消登录</button>
                )}
                {windsurfConnected && (
                  <>
                    <button className="settings-btn" disabled={loadingModels} onClick={() => void fetchWindsurfModels()}>
                      {loadingModels ? '刷新中...' : '刷新 Windsurf 模型'}
                    </button>
                    <button className="settings-btn" disabled={windsurfBusy}
                      onClick={async () => {
                        if (!platform.provider) return;
                        const confirmed = await confirmAction({
                          title: '退出 Windsurf 订阅？',
                          message: '这会删除 Synapse 安全存储中的 Windsurf 登录状态，不影响其它应用。',
                          confirmLabel: '退出登录',
                          tone: 'danger',
                        });
                        if (!confirmed) return;
                        invalidateProviderCatalogRefresh('windsurf');
                        setWindsurfBusy(true);
                        try {
                          setWindsurfStatus(await platform.provider.windsurfLogout());
                          await refreshProviderCredentialStatus(dispatch, 'windsurf');
                           const remaining = availableModels.filter(model => providerIdForModel(model) !== 'windsurf');
                          setLocalAvailableModels(remaining);
                          dispatch(setAvailableModels(remaining));
                          if (agentSettings.currentModel.startsWith('windsurf:')) dispatch(setCurrentModel(''));
                          if (agentSettings.systemModel?.startsWith('windsurf:')) dispatch(setSystemModel(''));
                        } finally {
                          setWindsurfBusy(false);
                        }
                      }}>退出登录</button>
                  </>
                )}
              </div>
              {windsurfStatus?.state === 'waiting' && (
                <div className="setting-control-row">
                  <input type="password" autoComplete="off" spellCheck={false}
                    aria-label="Windsurf 一次性登录 token"
                    placeholder="粘贴 Windsurf 页面显示的一次性 token"
                    value={windsurfTokenDraft}
                    onChange={event => setWindsurfTokenDraft(event.target.value)} />
                  <button className="settings-btn" disabled={windsurfBusy || windsurfTokenDraft.trim().length < 32 || !windsurfStatus.transactionId}
                    onClick={async () => {
                      if (!platform.provider || !windsurfStatus.transactionId) return;
                      const token = windsurfTokenDraft;
                      setWindsurfTokenDraft('');
                      setWindsurfBusy(true);
                      try {
                        const status = await platform.provider.windsurfComplete(windsurfStatus.transactionId, token);
                        setWindsurfStatus(status);
                        await refreshProviderCredentialStatus(dispatch, 'windsurf');
                      } catch (error) {
                        dispatch(addNotification({ type: 'error', title: 'Windsurf 导入失败', message: error instanceof Error ? error.message : '无法换取长期凭据' }));
                        await refreshWindsurfStatus();
                      } finally {
                        setWindsurfBusy(false);
                      }
                    }}>安全导入</button>
                </div>
              )}
              <span className="setting-hint">
                {windsurfStatus?.connected
                  ? `已连接${windsurfStatus.accountLabel ? ` · ${windsurfStatus.accountLabel}` : ''} · ${windsurfCredentialSourceLabel(windsurfStatus.credentialSource)} · ${windsurfStatus.persisted ? '系统安全存储' : '仅本次运行'}`
                  : windsurfStatus?.state === 'waiting'
                    ? '浏览器会显示一次性 token；它只发送给本机主进程换取长期凭据，不写入 Redux、localStorage 或日志。'
                    : windsurfStatus?.error || '浏览器 token 登录和本机 Devin/Windsurf 导入是两条独立入口；只有点击按钮才会读取本机客户端状态。'}
              </span>
              {windsurfLocalImportMessage && (
                <span className="setting-hint">{windsurfLocalImportMessage}</span>
              )}
            </div>
            <div className="setting-item">
              <label>测试连接</label>
              <button className="settings-btn" disabled={testingConnection}
                onClick={async () => {
                  setTestingConnection(true);
                  try {
                    const models = await fetchModels();
                    if (models && models.length > 0) {
                      dispatch(addNotification({ type: 'success', title: '✅ 连接成功', message: `发现 ${models.length} 个模型` }));
                    } else {
                      dispatch(addNotification({ type: 'warning', title: '⚠️ 连接异常', message: '端点可达但未返回模型列表' }));
                    }
                  } catch {
                    dispatch(addNotification({ type: 'error', title: '❌ 连接失败', message: '请检查 API Key 和端点' }));
                  }
                  setTestingConnection(false);
                }}>
                {testingConnection ? '⏳ 测试中...' : '🔌 测试连接'}
              </button>
            </div>
            <div className="setting-item">
              <label>默认模型</label>
              <div className="setting-control-row">
                <select value={selectedModel}
                  onChange={e => dispatch(setCurrentModel(e.target.value))}>
                  <option value="">{availableModels.length > 0 ? '未选择模型' : '请先获取模型列表'}</option>
                  {availableModels.map(m => (
                    <option key={m.id} value={m.id}>{modelDisplayName(m)}</option>
                  ))}
                </select>
                <button className="settings-btn" onClick={fetchModels} disabled={loadingModels}
                  style={{ flexShrink: 0 }}>
                  {loadingModels ? '⏳ 获取中...' : '🔄 获取模型'}
                </button>
              </div>
            </div>
            {/* ★ M4-5-S1：系统模型（后台任务用）——历史压缩摘要、自动标题等后台 LLM 任务走它，留空跟随默认模型。 */}
            <div className="setting-item">
              <label>系统模型（后台任务用）</label>
              <select
                value={availableModels.some(m => m.id === agentSettings.systemModel) ? agentSettings.systemModel : ''}
                onChange={e => dispatch(setSystemModel(e.target.value))}>
                <option value="">跟随默认模型</option>
                {availableModels.map(m => (
                  <option key={m.id} value={m.id}>{modelDisplayName(m)}</option>
                ))}
              </select>
            </div>
            <div className="setting-item" style={{ fontSize: 12, color: 'var(--syn-text-muted)' }}>
              <span className="setting-hint">用于历史压缩、自动标题等后台任务，留空则跟随默认模型。</span>
            </div>
            {availableModels.length > 0 && (
              <div className="setting-item" style={{ fontSize: 12, color: 'var(--syn-text-muted)' }}>
                已获取 {availableModels.length} 个模型
              </div>
            )}
            {selectedModelOption && (
              <div className="setting-item model-capability-summary">
                <label>模型能力</label>
                <div className="settings-chip-row">
                  {describeCapabilities(selectedCapabilities).map(label => (
                    <span key={label} className="settings-chip">{label}</span>
                  ))}
                  {selectedCapabilities?.source && (
                    <span className="setting-hint">来源: {{ api: '模型目录', protocol: '协议适配', mixed: '目录 + 协议', unknown: '未知（保守禁用）' }[selectedCapabilities.source]}</span>
                  )}
                </div>
                {/* ★ 模型参数可单独改（图4）：上下文窗口手动覆盖——推断不准时用户改，覆盖所有用 contextWindow 处。 */}
                <div className="setting-item" style={{ marginTop: 8 }}>
                  <label>上下文窗口（token）</label>
                  <input
                    // ★ 性能/正确性（review MEDIUM）：非受控 + key 按模型重挂载 + onBlur/Enter 才提交——避免逐字
                    //   dispatch 把半截值（2→20→200）即时写进全局 store 误触发压缩判断。切模型时 key 变 → 取新模型 override。
                    key={selectedModelOption.id}
                    type="number"
                    min={1}
                    defaultValue={agentSettings.contextWindowOverrides?.[selectedModelOption.id] ?? ''}
                    placeholder={selectedCapabilities?.contextWindow
                      ? `模型目录 ${getModelContextWindowForOption(selectedModelOption)}（留空=使用目录值）`
                      : `能力未知，留空时安全按 ${getModelContextWindowForOption(selectedModelOption)} 处理`}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      dispatch(setContextWindowOverride({ modelId: selectedModelOption.id, value: raw ? Number(raw) : null }));
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                  <span className="setting-hint">推断不准时手动改。覆盖后状态栏上下文占用、压缩阈值等所有用到上下文窗口的地方都按此值。</span>
                </div>
              </div>
            )}
            <div className="setting-item">
              <label>输出策略</label>
              <select
                value={agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off')}
                onChange={e => dispatch(setOutputStrategy(e.target.value as any))}
              >
                <option value="auto">自动：真流式优先，失败后伪流式</option>
                <option value="real" disabled={selectedCapabilities?.streaming === false}>真流式：强制 SSE</option>
                <option value="pseudo">伪流式：完整响应后前端播放</option>
                <option value="off">关闭流式：一次性显示</option>
              </select>
              <span className="setting-hint">
                {selectedCapabilities?.streaming === false ? '当前模型未声明支持 SSE，自动模式会使用伪流式' : '支持时优先使用 SSE 实时输出'}
              </span>
            </div>
            <div className="setting-item">
              <label>伪流式速度</label>
              <select
                value={agentSettings.pseudoStreamSpeed ?? 'medium'}
                onChange={e => dispatch(setPseudoStreamSpeed(e.target.value as any))}
              >
                <option value="slow">慢</option>
                <option value="medium">中</option>
                <option value="fast">快</option>
              </select>
              <span className="setting-hint">自动降级和伪流式模式使用</span>
            </div>
            <div className="setting-item">
              <label>流式光标</label>
              <input type="checkbox"
                checked={agentSettings.showStreamCursor ?? true}
                onChange={e => dispatch(setShowStreamCursor(e.target.checked))} />
              <span className="setting-hint">生成中显示闪烁光标</span>
            </div>
            <div className="setting-item">
              <label>生成占位</label>
              <input type="checkbox"
                checked={agentSettings.showGeneratingPlaceholder ?? true}
                onChange={e => dispatch(setShowGeneratingPlaceholder(e.target.checked))} />
              <span className="setting-hint">尚未收到文本时显示思考中</span>
            </div>
            <div className="setting-item">
              <label>显示 Thinking</label>
              <input type="checkbox"
                checked={(agentSettings.showThinking ?? true) && (selectedCapabilities?.thinking ?? true)}
                disabled={selectedCapabilities?.thinking === false}
                onChange={e => dispatch(setShowThinking(e.target.checked))} />
              <span className="setting-hint">
                {selectedCapabilities?.thinking === false ? '当前模型未声明支持 thinking' : '默认折叠显示思考内容'}
              </span>
            </div>
            <div className="setting-item">
              <label>Thinking 伪流式</label>
              <input type="checkbox"
                checked={(agentSettings.streamThinking ?? true) && (selectedCapabilities?.thinking ?? true)}
                disabled={selectedCapabilities?.thinking === false}
                onChange={e => dispatch(setStreamThinking(e.target.checked))} />
              <span className="setting-hint">
                {selectedCapabilities?.thinking === false ? '当前模型未声明支持 thinking' : '非流式返回 thinking 时按伪流式展开'}
              </span>
            </div>
            <div className="setting-item">
              <label>任务边界卡片</label>
              <input type="checkbox"
                checked={agentSettings.taskBoundaryEnabled ?? true}
                onChange={e => dispatch(setTaskBoundaryEnabled(e.target.checked))} />
              <span className="setting-hint">Plan 模式下引导 AI 用任务卡（大标题+进度+已编辑文件）组织多步任务；关闭则不再生成新任务卡。</span>
            </div>
            <div className="setting-item">
              <label>自动续跑</label>
              <input type="checkbox"
                checked={agentSettings.autoContinueToolRounds ?? false}
                onChange={e => dispatch(setAutoContinueToolRounds(e.target.checked))} />
              <span className="setting-hint">默认关闭。开启后达到单段轮数仍会延续同一任务，最多自动续两段；完全相同且无进展的动作会提前停止。</span>
            </div>
            <div className="setting-item">
              <label>单段轮数</label>
              <input type="number" min={3} max={100} step={1}
                value={agentSettings.maxToolRounds ?? 25}
                onChange={e => dispatch(setMaxToolRounds(Number(e.target.value)))} />
              <span className="setting-hint">每段最多模型与工具交互轮数，默认 25；自动续跑开启时最多连续三段。</span>
            </div>
            <div className="setting-item">
              <label>隐藏系统工具调用</label>
              <input type="checkbox"
                checked={agentSettings.hideSystemToolCalls ?? true}
                onChange={e => dispatch(setHideSystemToolCalls(e.target.checked))} />
              <span className="setting-hint">默认隐藏 show_artifact / 任务边界 / 工作区切换等元工具的调用卡片（它们已有专门卡片）。关掉看全部调用（调试用）。</span>
            </div>
            {/* ★ C1（M7 第七轮反馈#6）：输入框发送键模式可切换。 */}
            <div className="setting-item">
              <label>发送键模式</label>
              <select
                value={settings.sendKeyMode === 'ctrlEnter' ? 'ctrlEnter' : 'enter'}
                onChange={e => dispatch(setSendKeyMode(e.target.value === 'ctrlEnter' ? 'ctrlEnter' : 'enter'))}
              >
                <option value="enter">Enter 发送 / Shift+Enter 换行</option>
                <option value="ctrlEnter">Ctrl+Enter 发送 / Enter 换行</option>
              </select>
              <span className="setting-hint">输入框回车行为：默认 Enter 直接发送（Shift+Enter 换行）；切到 Ctrl+Enter 模式后 Enter 改为换行、Ctrl 或 Cmd+Enter 才发送。</span>
            </div>
            {/* ★ Plan_7 #6：生成中发送键主键动作（排队 / 插队）。 */}
            <div className="setting-item">
              <label>生成中发送键</label>
              <select
                value={settings.runtimeEnterAction === 'interrupt' ? 'interrupt' : 'queue'}
                onChange={e => dispatch(setRuntimeEnterAction(e.target.value === 'interrupt' ? 'interrupt' : 'queue'))}
              >
                <option value="queue">主键→排队 / Ctrl·Cmd+Enter→插队（默认）</option>
                <option value="interrupt">主键→插队 / Ctrl·Cmd+Enter→排队</option>
              </select>
              <span className="setting-hint">AI 生成中你再发消息时：「排队」= 等本轮回复结束后自动发；「插队」= 在 AI 下一步操作前就插入这条消息让它看到。此项决定主发送键（Enter 或 Ctrl+Enter，依上面的发送键模式）走哪种，另一组合键自动取相反；Shift+Enter 始终换行。</span>
            </div>
            {/* ★ H4-1（M7 第七轮反馈）：用户消息是否归入当前任务边界卡片。 */}
            <div className="setting-item">
              <label>用户消息归入任务边界</label>
              <select
                value={settings.attachUserMsgToBoundary === false ? 'no' : 'yes'}
                onChange={e => dispatch(setAttachUserMsgToBoundary(e.target.value === 'yes'))}
              >
                <option value="yes">归入（消息收进当前任务卡片）</option>
                <option value="no">不归入（发送前先收口当前任务）</option>
              </select>
              <span className="setting-hint">默认「归入」：AI 干活期间你发的消息会被收进当前任务边界卡片。切「不归入」后，发消息前会自动收口当前任务边界，新消息显示在卡片外。</span>
            </div>
            <div className="setting-item">
              <label>Top P</label>
              <input type="range" min="0" max="100" step="5" value={Math.round((agentSettings.topP ?? 1) * 100)}
                onChange={e => dispatch(setTopP(Number(e.target.value) / 100))} />
              <span>{(agentSettings.topP ?? 1).toFixed(2)}</span>
            </div>
            <div className="setting-item">
              <label>Reasoning Effort</label>
              <select
                value={selectedCapabilities?.reasoning ? (agentSettings.reasoningEffort ?? 'auto') : 'auto'}
                disabled={!selectedCapabilities?.reasoning}
                onChange={e => dispatch(setReasoningEffort(e.target.value))}
              >
                {(selectedCapabilities?.reasoningEffortOptions ?? ['auto']).map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              {!selectedCapabilities?.reasoning && <span className="setting-hint">当前模型不支持</span>}
            </div>
            <div className="setting-item">
              <label>Speed Tier</label>
              <select
                value={(selectedCapabilities?.speedTierOptions ?? ['auto']).includes(agentSettings.speedTier) ? agentSettings.speedTier : 'auto'}
                disabled={(selectedCapabilities?.speedTierOptions ?? ['auto']).length <= 1}
                onChange={e => dispatch(setSpeedTier(e.target.value))}
              >
                {(selectedCapabilities?.speedTierOptions ?? ['auto']).map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              {(selectedCapabilities?.speedTierOptions ?? ['auto']).length <= 1 && <span className="setting-hint">当前模型不支持</span>}
            </div>

            <h3 style={{ marginTop: 24 }}>🧩 AI 注入配置</h3>
            <ToggleItem label="身份提示词" checked={settings.promptInjection?.injectIdentity ?? true}
              onChange={v => dispatch(setPromptInjection({ injectIdentity: v }))} />
            <ToggleItem label="工具定义" checked={settings.promptInjection?.injectTools ?? true}
              onChange={v => dispatch(setPromptInjection({ injectTools: v }))} />
            <ToggleItem label="SKILL 注入" checked={settings.promptInjection?.injectSkills ?? true}
              onChange={v => dispatch(setPromptInjection({ injectSkills: v }))} />
            <ToggleItem label="上下文注入" checked={settings.promptInjection?.injectContext ?? true}
              onChange={v => dispatch(setPromptInjection({ injectContext: v }))} />
            <ToggleItem label="用户规则" checked={settings.promptInjection?.injectRules ?? true}
              onChange={v => dispatch(setPromptInjection({ injectRules: v }))} />
            <ToggleItem label="Workflow 注入" checked={settings.promptInjection?.injectWorkflows ?? true}
              onChange={v => dispatch(setPromptInjection({ injectWorkflows: v }))} />
          </div>
        )}

        {activeTab === 'conversation' && (
          <div className="settings-section">
            <h3>💬 对话管理</h3>
            <div className="setting-item">
              <label>最大对话历史</label>
              <input type="range" min="10" max="500" step="10" value={settings.maxConversationHistory}
                onChange={e => dispatch(setMaxConversationHistory(Number(e.target.value)))} />
              <span>{settings.maxConversationHistory} 条</span>
            </div>
            <div className="setting-item">
              <label>自动归档天数</label>
              <input type="range" min="0" max="90" step="5" value={settings.autoArchiveAfter}
                onChange={e => dispatch(setAutoArchiveAfter(Number(e.target.value)))} />
              <span>{settings.autoArchiveAfter === 0 ? '关闭' : `${settings.autoArchiveAfter} 天`}</span>
            </div>
            <div className="setting-item">
              <label>Temperature</label>
              <input type="range" min="0" max="200" step="5" value={Math.round((agentSettings.temperature ?? 0.7) * 100)}
                onChange={e => dispatch(setTemperature(Number(e.target.value) / 100))} />
              <span>{(agentSettings.temperature ?? 0.7).toFixed(2)}</span>
            </div>
            <div className="setting-item">
              <label>Max Tokens</label>
              <input type="number" min="256" max="128000" step="256" value={agentSettings.maxTokens ?? 4096}
                style={{ width: 100 }} onChange={e => dispatch(setMaxTokens(Number(e.target.value)))} />
              <span className="setting-hint">最大输出 Token 数</span>
            </div>

            {/* ★ M5-BPC-7：后台预压缩 (BPC) 设置区（替换原写死占位）。scheduler 读 agentSettings.bpc。 */}
            <h3 style={{ marginTop: 24 }}>🔄 后台预压缩 (BPC)</h3>
            <div className="setting-item">
              <label>预压触发水位</label>
              <input type="range" min="40" max="90" step="1"
                value={Math.round((agentSettings.bpc?.bpcThreshold ?? DEFAULT_BPC_CONFIG.bpcThreshold) * 100)}
                onChange={e => dispatch(setBpc({ bpcThreshold: Number(e.target.value) / 100 }))} />
              <span>{Math.round((agentSettings.bpc?.bpcThreshold ?? DEFAULT_BPC_CONFIG.bpcThreshold) * 100)}%</span>
            </div>
            <div className="setting-item">
              <label>硬压缩水位</label>
              <input type="range" min="50" max="95" step="1"
                value={Math.round((agentSettings.bpc?.compactThreshold ?? DEFAULT_BPC_CONFIG.compactThreshold) * 100)}
                onChange={e => dispatch(setBpc({ compactThreshold: Number(e.target.value) / 100 }))} />
              <span>{Math.round((agentSettings.bpc?.compactThreshold ?? DEFAULT_BPC_CONFIG.compactThreshold) * 100)}%</span>
            </div>
            {(() => {
              // ★ M5-BPC-7 风险校验（§8.2④，纯前端提示、不阻止保存）：阈值距离过近 / 预压过低易频繁压缩。
              const b = agentSettings.bpc?.bpcThreshold ?? DEFAULT_BPC_CONFIG.bpcThreshold;
              const c = agentSettings.bpc?.compactThreshold ?? DEFAULT_BPC_CONFIG.compactThreshold;
              return ((c - b) < 0.2 || b < 0.4) ? (
                <div className="setting-item">
                  <span className="setting-hint" style={{ color: 'var(--syn-warning)' }}>
                    ⚠️ 预压与硬压阈值距离过近（&lt;20%）或预压阈值过低（&lt;40%），可能频繁触发后台压缩
                  </span>
                </div>
              ) : null;
            })()}
            <div className="setting-item">
              <label>δ 替换窗口</label>
              <input type="number" min="1" max="10" step="1" style={{ width: 100 }}
                value={agentSettings.bpc?.deltaSteps ?? DEFAULT_BPC_CONFIG.deltaSteps}
                onChange={e => dispatch(setBpc({ deltaSteps: Number(e.target.value) }))} />
              <span className="setting-hint">后台压缩最晚在 N step 内替换，超时退硬压缩</span>
            </div>
            <div className="setting-item">
              <label>中止冷却</label>
              <input type="number" min="0" max="30" step="1" style={{ width: 100 }}
                value={agentSettings.bpc?.abortCooldownMin ?? DEFAULT_BPC_CONFIG.abortCooldownMin}
                onChange={e => dispatch(setBpc({ abortCooldownMin: Number(e.target.value) }))} />
              <span className="setting-hint">手动中止后多少分钟内不再触发后台压缩</span>
            </div>
            <div className="setting-item">
              <label>熔断间距</label>
              <input type="number" min="0" max="5" step="1" style={{ width: 100 }}
                value={agentSettings.bpc?.circuitBreakGapSteps ?? DEFAULT_BPC_CONFIG.circuitBreakGapSteps}
                onChange={e => dispatch(setBpc({ circuitBreakGapSteps: Number(e.target.value) }))} />
              <span className="setting-hint">压缩后 N step 内又触发即算循环，连续 2 次停止 BPC</span>
            </div>

            {/* ★ M5-BPC-7：Record 分层设置区（顺手补 R-L2 欠的 UI）。agentLoop 注入前缀读 agentSettings.recordLayering。 */}
            <h3 style={{ marginTop: 24 }}>📚 Record 分层</h3>
            <div className="setting-item">
              <label>头部全文批数</label>
              <input type="number" min="0" max="10" step="1" style={{ width: 100 }}
                value={agentSettings.recordLayering?.headFull ?? 2}
                onChange={e => dispatch(setRecordLayering({ headFull: Number(e.target.value) }))} />
              <span className="setting-hint">最老 N 批渲染全文（背景 / 关键决策）</span>
            </div>
            <div className="setting-item">
              <label>尾部全文批数</label>
              <input type="number" min="0" max="10" step="1" style={{ width: 100 }}
                value={agentSettings.recordLayering?.tailFull ?? 1}
                onChange={e => dispatch(setRecordLayering({ tailFull: Number(e.target.value) }))} />
              <span className="setting-hint">最近 N 批渲染全文（当前上下文）</span>
            </div>
            <div className="setting-item">
              <label>骨架降级阈值</label>
              <input type="number" min="1" max="100" step="1" style={{ width: 100 }}
                value={agentSettings.recordLayering?.titleThreshold ?? 20}
                onChange={e => dispatch(setRecordLayering({ titleThreshold: Number(e.target.value) }))} />
              <span className="setting-hint">中间批数超此值时，最老中间批降为仅标题</span>
            </div>
            <div className="setting-item">
              <label>注入上限比例</label>
              <input type="number" min="0.1" max="0.9" step="0.05" style={{ width: 100 }}
                value={agentSettings.recordLayering?.maxRatio ?? 0.4}
                onChange={e => dispatch(setRecordLayering({ maxRatio: Number(e.target.value) }))} />
              <span className="setting-hint">record 前缀最多占模型窗口比例（危险态硬闸兜底）</span>
            </div>
            <div className="setting-item">
              <label>折叠触发批数</label>
              <input type="number" min="2" max="200" step="1" style={{ width: 100 }}
                value={agentSettings.recordLayering?.foldThreshold ?? 30}
                onChange={e => dispatch(setRecordLayering({ foldThreshold: Number(e.target.value) }))} />
              <span className="setting-hint">可见批数超此值则折叠最老批为元批</span>
            </div>
            <div className="setting-item">
              <label>每次折叠批数</label>
              <input type="number" min="2" max="50" step="1" style={{ width: 100 }}
                value={agentSettings.recordLayering?.foldBatchK ?? 10}
                onChange={e => dispatch(setRecordLayering({ foldBatchK: Number(e.target.value) }))} />
              <span className="setting-hint">每次折叠把最老 K 批合成 1 个元批</span>
            </div>

            {/* ★ #14 动态分级（hit×距离）：AI 用 mark_record_hit 标记需要的历史 + 批距离当前轮远近，综合算渲染档位。
                只在压缩点重算固化，渲染只读固化档位 → 不破 prompt cache。 */}
            <h4 style={{ marginTop: 20, marginBottom: 8 }}>动态分级（hit × 距离）</h4>
            <ToggleItem
              label="启用动态分级"
              checked={agentSettings.recordLayering?.dynamicLevelEnabled ?? true}
              onChange={v => dispatch(setRecordLayering({ dynamicLevelEnabled: v }))} />
            <div className="setting-item">
              <span className="setting-hint">开：按「mark_record_hit 命中强度 × 批距当前轮远近」在压缩点给各批算渲染档位（full/骨架/仅标题），渲染只读固化档位、不破 cache；关：回退纯静态位置分层</span>
            </div>
            <div className="setting-item">
              <label>hit 权重</label>
              <input type="number" min="0" max="5" step="0.1" style={{ width: 100 }}
                value={agentSettings.recordLayering?.hitWeight ?? 0.6}
                onChange={e => dispatch(setRecordLayering({ hitWeight: Number(e.target.value) }))} />
              <span className="setting-hint">每次 hit 给命中批的命中强度增量（越大越易升全文）</span>
            </div>
            <div className="setting-item">
              <label>距离权重</label>
              <input type="number" min="0" max="5" step="0.05" style={{ width: 100 }}
                value={agentSettings.recordLayering?.distWeight ?? 0.2}
                onChange={e => dispatch(setRecordLayering({ distWeight: Number(e.target.value) }))} />
              <span className="setting-hint">距离衰减强度：越大则远批掉档越快（距离因子 = 1/(1+距离×权重)）</span>
            </div>
            <div className="setting-item">
              <label>hit 基线</label>
              <input type="number" min="0" max="2" step="0.05" style={{ width: 100 }}
                value={agentSettings.recordLayering?.hitBase ?? 0.4}
                onChange={e => dispatch(setRecordLayering({ hitBase: Number(e.target.value) }))} />
              <span className="setting-hint">无 hit 批的命中强度基线（保证仍能按距离区分远近、不被乘积归零）</span>
            </div>
            <div className="setting-item">
              <label>full 阈值</label>
              <input type="number" min="0" max="5" step="0.05" style={{ width: 100 }}
                value={agentSettings.recordLayering?.fullThreshold ?? 0.6}
                onChange={e => dispatch(setRecordLayering({ fullThreshold: Number(e.target.value) }))} />
              <span className="setting-hint">综合得分 ≥ 此值 → 渲染全文</span>
            </div>
            <div className="setting-item">
              <label>summary 阈值</label>
              <input type="number" min="0" max="5" step="0.05" style={{ width: 100 }}
                value={agentSettings.recordLayering?.summaryThreshold ?? 0.3}
                onChange={e => dispatch(setRecordLayering({ summaryThreshold: Number(e.target.value) }))} />
              <span className="setting-hint">得分 ≥ 此值（且 &lt; full 阈值）→ 渲染骨架；更低 → 仅标题</span>
            </div>
          </div>
        )}

        {activeTab === 'safety' && (
          <div className="settings-section">
            <h3>🛡 安全与审批</h3>
            <h4 className="settings-subheading">路径访问范围</h4>
            <ToggleItem label="完全访问（手动开启）" checked={settings.safety?.fullAccess ?? false}
              inputRef={fullAccessToggleRef}
              onChange={v => {
                if (v) setFullAccessConfirmOpen(true);
                else {
                  setFullAccessConfirmOpen(false);
                  dispatch(setSafety({ fullAccess: false }));
                }
              }} />
            <p className="setting-hint">默认仅允许工作区内路径；完全访问会对所有工作区和对话持续生效，直到手动关闭。</p>
            {fullAccessConfirmOpen && !settings.safety?.fullAccess && (
              <div className="permission-confirm-card" role="alertdialog" aria-labelledby="full-access-confirm-title">
                <strong id="full-access-confirm-title">确认开启完全访问？</strong>
                <p>开启后，Agent 可访问工作区之外的路径，并对所有工作区和对话持续生效；写入和命令是否自动批准仍由下方设置决定。</p>
                <div className="permission-confirm-actions">
                  <button type="button" className="settings-btn" onClick={closeFullAccessConfirm} autoFocus>保持工作区模式</button>
                  <button type="button" className="settings-btn danger" onClick={() => {
                    dispatch(setSafety({ fullAccess: true }));
                    closeFullAccessConfirm();
                  }}>确认开启完全访问</button>
                </div>
              </div>
            )}
            {settings.safety?.fullAccess && (
              <div className="permission-active-warning" role="status">⚠️ 完全访问已开启：所有工作区和对话都可访问工作区外路径。</div>
            )}

            <h4 className="settings-subheading">允许范围内的审批方式</h4>
            <ToggleItem label="自动批准读取" checked={autoApproveRead}
              onChange={v => dispatch(setSafety({ autoApproveRead: v }))} />
            <ToggleItem label="自动批准写入" checked={autoApproveWrite}
              onChange={v => dispatch(setSafety({ autoApproveWrite: v }))} />
            <ToggleItem label="自动批准命令" checked={autoApproveCommand}
              onChange={v => dispatch(setSafety({ autoApproveCommand: v }))} />
            <p className="setting-hint">未开启完全访问时，系统命令仍会逐次确认，因为命令文本可以访问工作区外路径。</p>
            <ToggleItem label="自动批准所有允许范围内操作" checked={allAllowedOperationsAutoApproved}
              onChange={v => dispatch(setSafety({ autoApproveAll: v }))} />
            <p className="setting-hint">这是三个审批开关的快捷操作，不会扩大路径访问范围。</p>

            <h3 style={{ marginTop: 24 }}>Sandbox 限制</h3>
            <div className="setting-item">
              <label>命令超时</label>
              <span>30 秒</span>
              <span className="setting-hint">当前为内置默认值</span>
            </div>
            <div className="setting-item">
              <label>内存限制</label>
              <span>256 MB</span>
              <span className="setting-hint">当前为内置默认值</span>
            </div>

            <h3 style={{ marginTop: 24 }}>📌 系统提示注入</h3>
            <ToggleItem label="身份提示词" checked={settings.promptInjection?.injectIdentity ?? true}
              onChange={v => dispatch(setPromptInjection({ injectIdentity: v }))} />
            <ToggleItem label="工具定义" checked={settings.promptInjection?.injectTools ?? true}
              onChange={v => dispatch(setPromptInjection({ injectTools: v }))} />
            <ToggleItem label="SKILL 注入" checked={settings.promptInjection?.injectSkills ?? true}
              onChange={v => dispatch(setPromptInjection({ injectSkills: v }))} />
            <ToggleItem label="上下文注入" checked={settings.promptInjection?.injectContext ?? true}
              onChange={v => dispatch(setPromptInjection({ injectContext: v }))} />
            <ToggleItem label="用户规则" checked={settings.promptInjection?.injectRules ?? true}
              onChange={v => dispatch(setPromptInjection({ injectRules: v }))} />
            <ToggleItem label="Workflow 注入" checked={settings.promptInjection?.injectWorkflows ?? true}
              onChange={v => dispatch(setPromptInjection({ injectWorkflows: v }))} />
          </div>
        )}

        {activeTab === 'synopsis' && (
          <div className="settings-section">
            <h3>📊 Synopsis 引擎</h3>
            <p className="setting-hint">文档解析与 RAG 生成管线参数，修改后会写入本地设置。</p>
            <ToggleItem label="TEXT MODE (纯文本模式)" checked={synopsisSettings.textModeEnabled}
              onChange={v => updateSynopsisSettings({ textModeEnabled: v })} />
            <div className="setting-hint" style={{ padding: '0 16px', fontSize: 12, color: 'var(--syn-text-muted)' }}>
              ℹ️ 当您没有多模态 API 时，开启 TEXT MODE 将使用 OCR 提取文字后送入文本模型
            </div>
            <div className="setting-item">
              <label>每块最大 Token</label>
              <input type="number" min="100" max="8000" step="100" value={synopsisSettings.chunkMaxTokens}
                onChange={e => updateSynopsisSettings({ chunkMaxTokens: clampNumber(e.target.value, 100, 8000, 2000) })} />
            </div>
            <div className="setting-item">
              <label>Map 并发数</label>
              <input type="number" min="1" max="10" step="1" value={synopsisSettings.mapConcurrency}
                onChange={e => updateSynopsisSettings({ mapConcurrency: clampNumber(e.target.value, 1, 10, 3) })} />
            </div>
            <ToggleItem label="索引自动更新" checked={synopsisSettings.autoIndexEnabled}
              onChange={v => updateSynopsisSettings({ autoIndexEnabled: v })} />
            <div className="setting-item">
              <label>更新策略</label>
              <select value={synopsisSettings.autoIndexMethod}
                onChange={e => updateSynopsisSettings({ autoIndexMethod: e.target.value as 'contentHash' | 'timestamp' })}>
                <option value="contentHash">contentHash 对比</option>
                <option value="timestamp">timestamp 时间戳</option>
              </select>
            </div>
          </div>
        )}

        {activeTab === 'plugins' && (
          <div className="settings-section">
            <h3>🧩 插件管理</h3>
            <p className="setting-hint">MCP 在 Electron 模式下读取真实进程状态；扩展条目保留来源信息并支持打开目录。</p>
            <div className="plugin-section">
              <div className="plugin-section-heading">
                <h4>MCP 服务器</h4>
                {isElectron && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {/* ★ M4-7-S4：打开配置文件入口，让用户改 server 路径 / 增删 server / 改 enabled。 */}
                    <button className="settings-btn compact" type="button" onClick={() => handleOpenExtensionPath('~/.synapse/mcp_config.json')}>
                      📂 打开配置
                    </button>
                    <button className="settings-btn compact" type="button" onClick={refreshMcpStatus} disabled={loadingMcpStatus}>
                      {loadingMcpStatus ? '刷新中' : '刷新'}
                    </button>
                  </div>
                )}
              </div>
              <div className="plugin-list">
                {pluginMcpEntries.map(item => {
                  const serverInfo = mcpServers[item.name];
                  const status = isElectron ? getMcpStatus(serverInfo) : { label: 'Electron 模式下可用', tone: 'muted' as const };
                  return (
                    <PluginItem
                      key={item.name}
                      {...item}
                      status={status.label}
                      statusTone={status.tone}
                      actionLabel={isElectron && serverInfo && serverInfo.configured !== false ? (serverInfo.running ? '重启' : '启动') : undefined}
                      actionDisabled={loadingMcpStatus || serverInfo?.enabled === false}
                      onAction={() => serverInfo?.running ? handleRestartMcp(item.name) : handleStartMcp(item.name)}
                    />
                  );
                })}
              </div>
            </div>
            <div className="plugin-section">
              <h4>SKILL ({pluginSkills.length})</h4>
              <div className="plugin-list">
                {pluginSkills.map(item => (
                  <PluginItem
                    key={item.name}
                    {...item}
                    statusTone="ok"
                    actionLabel={isElectron ? '📂 打开目录' : undefined}
                    onAction={() => handleOpenExtensionPath(item.source)}
                  />
                ))}
              </div>
            </div>
            <div className="plugin-section">
              <h4>WORKFLOW ({pluginWorkflows.length})</h4>
              <div className="plugin-list">
                {pluginWorkflows.map(item => (
                  <PluginItem
                    key={item.name}
                    {...item}
                    statusTone="ok"
                    actionLabel={isElectron ? '📂 打开目录' : undefined}
                    onAction={() => handleOpenExtensionPath(item.source)}
                  />
                ))}
              </div>
            </div>
            <div className="plugin-section">
              <h4>RULES</h4>
              <div className="plugin-list">
                {pluginRules.map(item => (
                  <PluginItem
                    key={item.name}
                    {...item}
                    statusTone={item.status === '未配置' ? 'muted' : 'ok'}
                    actionLabel={isElectron ? '📂 打开来源' : undefined}
                    onAction={() => handleOpenExtensionPath(item.source)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'multiAI' && (
          <div className="settings-section">
            <h3>🤝 Multi-AI 协作</h3>
            <p className="setting-hint">启用后，主 Agent 可按当前模式创建子代理协助工作，设置会写入本地持久化。</p>
            <ToggleItem label="启用 Multi-AI" checked={multiAI?.enabled ?? false}
              onChange={v => dispatch(setMultiAIEnabled(v))} />
            <div className="setting-hint" style={{ padding: '0 16px', fontSize: 12, color: 'var(--syn-text-muted)' }}>
              ℹ️ 启用后，主 Agent 可以通过 spawn_subagent 工具创建子代理来协助工作
            </div>

            {(() => {
              const modes: MultiAIMode[] = (multiAI?.modes || []) as MultiAIMode[];
              // ★ M3-2c#fix：草稿（新建/复制未保存，id 不在 modes 里）优先；否则按 id 找已存在的自定义模式。
              const editingMode = editingModeId
                ? (draftMode && draftMode.id === editingModeId ? draftMode : modes.find(m => m.id === editingModeId))
                : undefined;
              // ★ M3-2c：进入编辑器视图（仅自定义模板可编辑；built-in 不会被设为 editingModeId）。
              if (editingMode && !editingMode.isBuiltIn && !(editingMode as any).isBuiltin) {
                return (
                  <WorkflowEditor
                    key={editingMode.id}
                    mode={editingMode}
                    availableModels={availableModels}
                    onSave={updates => saveWorkflowTemplate(editingMode.id, updates)}
                    onCancel={cancelWorkflowEdit}
                    onDelete={() => deleteWorkflowTemplate(editingMode)}
                    notify={(type, title, message) => dispatch(addNotification({ type, title, message }))}
                    // ★ M3-2c#fix 重名校验：与现有 modes（排除本 mode 自身 id）大小写不敏感比对。
                    isNameTaken={(trimmedName) => {
                      const lower = trimmedName.toLowerCase();
                      return modes.some(m => m.id !== editingMode.id && m.name.trim().toLowerCase() === lower);
                    }}
                  />
                );
              }
              // 列表视图：内建（只读 / 可复制）与自定义（可编辑 / 可删）分别给操作。
              return (
                <>
                  <div className="settings-subsection-title">固定工作流模板</div>
                  <p className="setting-hint">
                    内建模板只读（可「复制为模板」后再改）；自定义模板可编辑 / 删除。
                    带工作流的模板可用 <code>{MULTI_AI_TRIGGER_PREFIX}模式名 任务描述</code> 在对话中触发。
                  </p>
                  <div className="multi-ai-mode-list">
                    {modes.map((mode) => {
                      const builtIn = Boolean(mode.isBuiltIn || (mode as any).isBuiltin);
                      const hasWorkflow = Array.isArray(mode.workflow) && mode.workflow.length > 0;
                      const active = (multiAI?.activeMode || 'solo') === mode.id;
                      return (
                        <div key={mode.id} className={`multi-ai-mode ${active ? 'active' : ''}`}>
                          <div className="multi-ai-mode-main">
                            <span className="multi-ai-mode-icon">{hasWorkflow ? '🔀' : '📋'}</span>
                            <div className="multi-ai-mode-text">
                              <span className="multi-ai-mode-name">
                                {mode.name}
                                {' '}
                                <span className={`workflow-mode-badge ${builtIn ? 'builtin' : 'custom'}`}>
                                  {builtIn ? '内建' : '自定义'}
                                </span>
                                {hasWorkflow && <span className="workflow-mode-badge wf">工作流·{mode.workflow!.length}节点</span>}
                              </span>
                              <span className="multi-ai-mode-description">{mode.description}</span>
                            </div>
                          </div>
                          <span className="multi-ai-agent-count">{formatAgentCount(mode.agentCount ?? ((mode.subagents?.length ?? 0) + 1))}</span>
                          <div className="workflow-mode-actions">
                            {active ? (
                              <span className="plugin-status ok">默认</span>
                            ) : (
                              <button className="settings-btn compact" type="button" onClick={() => dispatch(setActiveMode(mode.id))}>
                                选择
                              </button>
                            )}
                            {builtIn ? (
                              <button className="settings-btn compact" type="button" onClick={() => duplicateModeAsTemplate(mode)} title="复制为可编辑的自定义模板">
                                复制为模板
                              </button>
                            ) : (
                              <>
                                <button className="settings-btn compact" type="button" onClick={() => setEditingModeId(mode.id)}>
                                  编辑
                                </button>
                                <button className="settings-btn danger compact" type="button" onClick={() => deleteWorkflowTemplate(mode)}>
                                  删除
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="setting-item">
                    <label>新建工作流模板</label>
                    <button className="settings-btn" type="button" onClick={createWorkflowTemplate}>
                      ＋ 新建模板
                    </button>
                  </div>
                </>
              );
            })()}

            <div className="settings-subsection-title">默认 Subagent 配置</div>
            <div className="setting-item">
              <label>子代理模型</label>
              <select value={multiAI?.defaultSubagentModel ?? multiAI?.subagentDefaultModel ?? ''}
                onChange={e => dispatch(setSubagentDefaultModel(e.target.value))}>
                <option value="">跟随主 Agent 模型</option>
                {availableModels.map(m => (
                  <option key={m.id} value={m.id}>{modelDisplayName(m)}</option>
                ))}
              </select>
            </div>
            <div className="setting-item">
              <label>Token 上限</label>
              <input type="number" min="1024" max="128000" step="1024" value={multiAI?.defaultSubagentMaxTokens ?? 32000}
                onChange={e => dispatch(setDefaultSubagentMaxTokens(clampNumber(e.target.value, 1024, 128000, 32000)))} />
            </div>
            <div className="setting-item">
              <label>最大并行</label>
              <input type="number" min="1" max="10" step="1" value={multiAI?.maxConcurrentSubagents || 3}
                onChange={e => dispatch(setMaxConcurrentSubagents(clampNumber(e.target.value, 1, 10, 3)))} />
            </div>

            {(multiAI?.runningSubagents || []).length > 0 && (
              <>
                <h3 style={{ marginTop: 24 }}>🟢 运行中的子代理</h3>
                {multiAI.runningSubagents.map((sub: any) => (
                  <div key={sub.id} className="plugin-item">
                    <span className="plugin-icon">{sub.status === 'running' ? '⏳' : sub.status === 'complete' ? '✅' : '❌'}</span>
                    <div className="plugin-info">
                      <span className="plugin-name">{sub.role}</span>
                      <span className="plugin-status">{sub.model} • {sub.status}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {activeTab === 'worktree' && (
          <div className="settings-section">
            <h3>🌿 Git 工作树</h3>
            <p className="setting-hint">
              在一个 git 仓库基础上创建、查看、删除独立的工作树（git worktree），为隔离任务环境做准备。
              {' '}这是磁盘上真实的 git worktree，区别于对话分支。
            </p>
            {!isElectron ? (
              <div className="setting-item">
                <span className="plugin-status muted">git worktree 管理仅在 Electron 桌面模式下可用</span>
              </div>
            ) : (
              <>
                <div className="setting-item">
                  <label>目标仓库</label>
                  <div className="setting-control-row">
                    <input
                      type="text"
                      placeholder="选择或填写 git 仓库根目录"
                      value={worktreeRepoRoot}
                      onChange={e => { setWorktreeRepoRoot(e.target.value); setWorktreeLoaded(false); }}
                    />
                    <button className="settings-btn" type="button" onClick={pickWorktreeRepo} disabled={worktreeBusy} style={{ flexShrink: 0 }}>
                      📁 选择
                    </button>
                    <button className="settings-btn" type="button" onClick={refreshWorktrees} disabled={worktreeBusy || !worktreeRepoRoot.trim()} style={{ flexShrink: 0 }}>
                      {worktreeBusy ? '⏳' : '🔄 列出'}
                    </button>
                  </div>
                  <p className="setting-hint">非 git 仓库会提示先执行 git init。新建工作树默认放在用户数据目录的 worktrees/ 下。</p>
                </div>

                <div className="setting-item">
                  <label>新建工作树</label>
                  <div className="setting-control-row">
                    <input
                      type="text"
                      placeholder="新分支名（如 feature-x）"
                      value={worktreeNewBranch}
                      onChange={e => setWorktreeNewBranch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void createWorktree(); }}
                    />
                    <button className="settings-btn" type="button" onClick={createWorktree} disabled={worktreeBusy || !worktreeRepoRoot.trim() || !worktreeNewBranch.trim()} style={{ flexShrink: 0 }}>
                      ➕ 创建
                    </button>
                  </div>
                  <p className="setting-hint">执行 git worktree add &lt;路径&gt; -b &lt;分支&gt;，会在该工作树中新建同名分支。</p>
                </div>

                <ToggleItem
                  label="删除时强制（丢弃未提交改动）"
                  checked={worktreeForce}
                  onChange={setWorktreeForce}
                />
                <p className="setting-hint" style={{ padding: '0 16px', fontSize: 12, color: 'var(--syn-text-muted)' }}>
                  ⚠️ 默认关闭。关闭时若工作树有未提交改动，删除会被 git 拒绝以保护数据；开启后将带 --force 强制删除并丢弃改动。
                </p>

                <div className="plugin-section" style={{ marginTop: 16 }}>
                  <div className="plugin-section-heading">
                    <h4>工作树列表 ({worktrees.length})</h4>
                  </div>
                  <div className="plugin-list">
                    {worktrees.length === 0 ? (
                      <div className="setting-hint" style={{ padding: '8px 0' }}>
                        {worktreeLoaded ? '没有找到工作树（或仅有主工作树）。' : '选择仓库后点击「列出」查看工作树。'}
                      </div>
                    ) : (
                      worktrees.map((wt, index) => {
                        // git worktree list --porcelain 的第一条恒为主工作树（已实测确认）。
                        const isMain = index === 0;
                        return (
                          <div className="plugin-item" key={wt.path}>
                            <span className="plugin-icon">{wt.bare ? '📦' : isMain ? '🏠' : '🌿'}</span>
                            <div className="plugin-info">
                              <span className="plugin-name">{wt.branch ?? (wt.detached ? '(detached HEAD)' : wt.bare ? '(bare)' : '(无分支)')}</span>
                              <div className="plugin-meta">
                                {wt.head && <span className="plugin-status muted">{wt.head.slice(0, 8)}</span>}
                                {isMain && <span className="plugin-status ok">主工作树</span>}
                                {wt.locked && <span className="plugin-status warn">已锁定</span>}
                                <span className="plugin-source settings-wide-scroll">{wt.path}</span>
                              </div>
                            </div>
                            {!isMain && !wt.bare && (
                              <button
                                className="settings-btn danger plugin-action"
                                type="button"
                                disabled={worktreeBusy}
                                onClick={() => void removeWorktree(wt.path)}
                              >
                                🗑 删除
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'data' && (
          <div className="settings-section">
            <h3>📤 数据管理</h3>
            <p className="setting-hint">
              当前按钮只处理本地可访问的数据源：对话导出/清除覆盖持久化对话快照和旧 localStorage 对话键；设置导入/导出只覆盖 Synapse 设置键，不包含 Electron 数据库、用户目录文件或完整备份。
            </p>
            <div className="setting-item">
              <label>导出全部对话</label>
              <button className="settings-btn" onClick={exportConversations}>
                📥 导出为 JSON
              </button>
            </div>
            <div className="setting-item">
              <label>清除对话历史</label>
              <button className="settings-btn danger" onClick={clearConversationHistory}>
                🗑 清除
              </button>
            </div>
            <div className="setting-item">
              <label>存储使用量</label>
              <div className="storage-usage-breakdown">
                <strong>localStorage {formatBytes(storageUsage.localStorageBytes)}</strong>
                <span>
                  浏览器估算 {formatStorageEstimate(storageUsage)}
                </span>
                <small>{storageUsage.source} · {new Date(storageUsage.measuredAt).toLocaleTimeString()}</small>
              </div>
              <button
                className="settings-btn compact"
                type="button"
                disabled={loadingStorageUsage}
                onClick={() => void refreshStorageUsage()}
              >
                {loadingStorageUsage ? '刷新中' : '刷新'}
              </button>
            </div>
            <div className="setting-item">
              <label>清除缓存</label>
              <button className="settings-btn" onClick={clearCache}>
                🧹 清理
              </button>
              <p className="setting-hint">当前清理 localStorage 中的 Synopsis / temp / tmp 缓存键；Electron 文件缓存与数据库缓存由系统自行管理。</p>
            </div>
            <div className="settings-subsection-title">设置导入导出</div>
            <div className="setting-item">
              <label>导出设置</label>
              <button className="settings-btn" onClick={exportSettings}>
                📤 导出
              </button>
              <p className="setting-hint">导出格式为 `synapse-settings.json`，内容来自当前 localStorage 中可识别的设置键。</p>
            </div>
            <div className="setting-item">
              <label>导入设置</label>
              <button className="settings-btn" onClick={() => settingsImportRef.current?.click()}>
                📥 导入
              </button>
              <p className="setting-hint">只导入 JSON 中可识别的 Synapse 设置键；不会覆盖对话记录、文件、数据库或插件目录。</p>
              <input
                ref={settingsImportRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importSettings(file);
                }}
              />
            </div>
          </div>
        )}

        {activeTab === 'about' && (
          <div className="settings-section about-card">
            <span style={{ fontSize: 48 }}>🧠</span>
            <h2>Synapse</h2>
            <p>可扩展的桌面编程智能体</p>
            <p className="about-version">v0.1.0 (Preview)</p>
            <div className="about-details">
              <div><span>运行模式</span><strong>{platformInfo?.isElectron ? 'Electron' : 'Web'}</strong></div>
              <div><span>平台</span><strong>{platformInfo?.platform ?? (isElectron ? 'electron' : 'web')}</strong></div>
              <div><span>版本</span><strong>{platformInfo?.version ?? '0.1.0'}</strong></div>
              <div><span>用户数据目录</span><strong className="settings-wide-scroll">{platformInfo?.userDataPath ?? (isElectron ? '读取中' : '/virtual')}</strong></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PluginItem({
  name,
  description,
  status,
  source,
  sourceType,
  icon,
  statusTone = 'muted',
  actionLabel,
  actionDisabled,
  onAction,
}: PluginEntry & {
  statusTone?: 'ok' | 'warn' | 'danger' | 'muted';
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="plugin-item">
      <span className="plugin-icon">{icon}</span>
      <div className="plugin-info">
        <span className="plugin-name">{name}</span>
        <span className="plugin-description">{description}</span>
        <div className="plugin-meta">
          <span className={`plugin-status ${statusTone}`}>{status}</span>
          {sourceType && <span className="plugin-status muted">{sourceType}</span>}
          <span className="plugin-source settings-wide-scroll">{source}</span>
        </div>
      </div>
      {actionLabel && (
        <button className="settings-btn plugin-action" type="button" disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function getMcpStatus(server?: McpServerInfo): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (!server) return { label: '未配置', tone: 'muted' };
  const raw = String(server.status ?? '').toLowerCase();
  if (server.enabled === false || raw === 'disabled') return { label: '已禁用', tone: 'muted' };
  if (server.running || raw === 'running' || raw.includes('run') || raw.includes('运行')) {
    return { label: '运行中', tone: 'ok' };
  }
  if (raw.includes('start') || raw.includes('启动')) {
    return { label: '启动中', tone: 'warn' };
  }
  if (raw.includes('stop') || raw.includes('exit') || raw.includes('停止')) {
    return { label: server.configured ? '已配置，未启动' : '已停止', tone: 'warn' };
  }
  return { label: server.status || '状态未知', tone: 'muted' };
}

function clampNumber(value: string, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function formatAgentCount(count: number) {
  if (count <= 1) return '仅主';
  return `主+${count - 1}子`;
}

function calculateLocalStorageBytes() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i) ?? '';
    const value = localStorage.getItem(key) ?? '';
    bytes += new Blob([key, value]).size;
  }
  return bytes;
}

function calculateStorageUsageSync(): StorageUsageSnapshot {
  return {
    localStorageBytes: calculateLocalStorageBytes(),
    source: 'localStorage 同步统计',
    measuredAt: Date.now(),
  };
}

async function calculateStorageUsage(): Promise<StorageUsageSnapshot> {
  const localStorageBytes = calculateLocalStorageBytes();
  if (!navigator.storage?.estimate) {
    return {
      localStorageBytes,
      source: 'localStorage；当前运行环境不支持 navigator.storage.estimate',
      measuredAt: Date.now(),
    };
  }
  const estimate = await navigator.storage.estimate();
  return {
    localStorageBytes,
    browserUsageBytes: estimate.usage,
    browserQuotaBytes: estimate.quota,
    source: 'localStorage + 浏览器存储估算',
    measuredAt: Date.now(),
  };
}

function formatStorageEstimate(usage: StorageUsageSnapshot) {
  if (typeof usage.browserUsageBytes !== 'number') return '不可用';
  if (typeof usage.browserQuotaBytes !== 'number' || usage.browserQuotaBytes <= 0) {
    return formatBytes(usage.browserUsageBytes);
  }
  return `${formatBytes(usage.browserUsageBytes)} / ${formatBytes(usage.browserQuotaBytes)}`;
}

function collectLocalStorage(predicate: (key: string) => boolean) {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !predicate(key)) continue;
    result[key] = parseStorageValue(localStorage.getItem(key) ?? '');
  }
  return result;
}

function removeLocalStorage(predicate: (key: string) => boolean) {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && predicate(key)) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
  return keys.length;
}

function isConversationStorageKey(key: string) {
  return key.startsWith('synapse:conversation:')
    || key === 'synapse_conversations'
    || key === 'synapse_autosave'
    || key === 'synapse_conversation_history';
}

function isCacheStorageKey(key: string) {
  return key.startsWith('synapse:synopsis:')
    || key.startsWith('synapse:temp:')
    || key.startsWith('synapse:tmp:')
    || key.startsWith('synapse_temp')
    || key.includes(':cache:');
}

function isSettingsStorageKey(key: string) {
  return key.startsWith('synapse:config:')
    || [
      'synapse:background',
      'synapse:synopsis',
      'synapse:multi-ai',
      'synapse_settings',
      'synapse_theme',
      'synapse_agent_settings',
      'synapse_multi_ai',
    ].includes(key);
}

function parseStorageValue(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeStorageValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function readImageAsDataUrl(file: File, index: number) {
  return new Promise<WallpaperImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve({
        id: `web-${Date.now()}-${index}`,
        name: file.name || `壁纸 ${index + 1}`,
        kind: 'dataUrl',
        url,
        mime: file.type || 'image/*',
        size: file.size,
        addedAt: Date.now(),
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isManagedWallpaper(item: unknown): item is WallpaperImage {
  return Boolean(item && typeof item === 'object' && (item as WallpaperImage).kind === 'managed' && (item as WallpaperImage).relativePath);
}

function ToggleItem({ label, checked, onChange, inputRef }: { label: string; checked: boolean; onChange: (v: boolean) => void; inputRef?: Ref<HTMLInputElement> }) {
  const inputId = useId();
  return (
    <div className="setting-item setting-toggle-item">
      <label className="setting-toggle-label" htmlFor={inputId}>{label}</label>
      <label className="toggle-switch" htmlFor={inputId}>
        <input ref={inputRef} id={inputId} type="checkbox" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} />
        <span className="toggle-slider" />
      </label>
    </div>
  );
}
