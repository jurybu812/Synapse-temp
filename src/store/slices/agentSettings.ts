import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AIModelOption } from '@/types/aiModel';

type AgentMode = 'planning' | 'fast';
type ConnectionStatus = 'unknown' | 'missing' | 'checking' | 'configured' | 'failed';
export type OutputStrategy = 'auto' | 'real' | 'pseudo' | 'off';
export type PseudoStreamSpeed = 'slow' | 'medium' | 'fast';
export type WallpaperKind = 'dataUrl' | 'managed';

export interface WallpaperImage {
  id: string;
  name: string;
  kind: WallpaperKind;
  url: string;
  relativePath?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  addedAt: number;
  legacy?: boolean;
}

export interface BackgroundSettings {
  enabled: boolean;
  images: WallpaperImage[];
  selectedIndex: number;
  displayMode: 'static' | 'carousel' | 'random';
  carouselInterval: number;
  transitionEffect: 'fade' | 'slide';
  blur: number;
  opacity: number;
  panelOpacity: number;
}

export interface SynopsisSettings {
  textModeEnabled: boolean;
  chunkMaxTokens: number;
  mapConcurrency: number;
  autoIndexEnabled: boolean;
  autoIndexMethod: 'contentHash' | 'timestamp';
}

/**
 * ★ M5-RL：record 多级分层 + 折叠 + token 硬闸的可调参数（Plan_5 §2.5 / §8.3「可调进设置」强约束）。
 *   全部是「默认值，UI 可改」。分层渲染只依赖批位置、不依赖窗口（保 prompt cache 稳定）；maxRatio 仅
 *   R-L5 token 硬闸危险态兜底用。SettingsPanel 压缩设置区（M5-BPC-7）暴露。
 */
export interface RecordLayeringConfig {
  /** 头部 N 批渲染全文（最老背景/关键决策）。 */
  headFull: number;
  /** 尾部 N 批渲染全文（最近上下文，主人拍板 T=1）。 */
  tailFull: number;
  /** 中间批数超此阈值时，把最老一段中间批降级为 titleOnly（仅标题）。 */
  titleThreshold: number;
  /** R-L5 token 硬闸：record 注入前缀最大占模型窗口的比例（仅危险态兜底，会破 cache）。 */
  maxRatio: number;
  /** R-L4 折叠触发：可见（非 archived）批数超此阈值则折叠最老批。 */
  foldThreshold: number;
  /** R-L4 每次折叠把最老 K 批合成 1 个元批。 */
  foldBatchK: number;
  /**
   * ★ #14 动态分级总开关（默认 true=开）：开则在【压缩点】按「hit 命中强度 × 距离当前轮远近」给各批算固化档位
   *   renderLevel（full/summary/brief），渲染时按档位升降级（叠加在静态位置分层上）；关则回退纯静态位置分层。
   *   ★ 渲染只读固化的 renderLevel、不读 hit/距离/当前轮号 → else 分支每轮前缀稳定，prompt cache 不破（方案①）。
   */
  dynamicLevelEnabled: boolean;
  /** ★ #14 动态分级：hit 命中强度权重（每次 hit 给命中批的强度增量）。默认 0.6。 */
  hitWeight: number;
  /** ★ #14 动态分级：距离衰减权重（dist 每加 1，距离因子按 1/(1+dist×distWeight) 衰减）。默认 0.2。 */
  distWeight: number;
  /** ★ #14 动态分级：hit 强度基线（无 hit 批也有的最小命中项，保证 score 不被乘积归零、仍按距离区分远近）。默认 0.4。 */
  hitBase: number;
  /** ★ #14 动态分级：升 full 的 score 阈值（score >= 此值 → 全文）。默认 0.6。 */
  fullThreshold: number;
  /** ★ #14 动态分级：升 summary 的 score 阈值（fullThreshold > score >= 此值 → 骨架；否则 brief 仅标题）。默认 0.3。
   *  默认梯度：未标记批近批（dist≤1）落 summary（同改造前骨架水平）、dist≥2 才降 brief；被 hit 标记的批近批升 full。 */
  summaryThreshold: number;
  /**
   * ★ #14 动态分级：hit 距离地板（仅对 hitCount>0 的批生效）。被 mark_record_hit 标记过的批，距离因子 distTerm 不再
   *   低于此地板，防折叠老历史元批 dist 极大把 hit 加成乘没（保证 1 次 hit≥summary、2~3 次 full）。默认 0.5。
   *   ★ 可选字段：computeRenderLevels 内部有同名默认 0.5 兜底，缺省/未透传时仍生效（无 hit 批不受影响）。 */
  distFloor?: number;
}

/**
 * ★ M5-BPC：后台预压缩（Background Pre-Compaction）全局配置（Plan_5 §8.3 / §8.4「可调进设置」强约束）。
 *   全部是「默认值，UI 可改」。bpcThreshold 是【预压触发】水位（低于硬阈值，提前在后台生成 record）；
 *   compactThreshold 是【硬阻塞】水位（撞到就同步压缩，0.9 历史口径，迁移自 systemPrompt.COMPRESSION_THRESHOLD）。
 *   deltaSteps = δ 替换窗口「最晚上限」step 数；abortCooldownMin = 手动中止后冷却分钟；
 *   circuitBreakGapSteps = 熔断判据「替换后几乎没推进就又触发」的 step 间距（§8.4 待拍板，默认 1，UI 暴露可调）。
 *   SettingsPanel 压缩设置区（M5-BPC-7）暴露。scheduler 读 agentSettings.bpc，对话覆盖见 conversation.*Override。
 */
export interface BpcConfig {
  /** 预压触发水位（ratio >= 此值 && 空闲 → 后台拍快照生成 record）。默认 0.68。 */
  bpcThreshold: number;
  /** 硬阻塞压缩水位（ratio >= 此值 → 同步压缩，丢弃在途 BPC）。默认 0.9。 */
  compactThreshold: number;
  /** δ 替换窗口最晚上限 step 数（targetReplaceStep = snapshotStepCursor + 1 + deltaSteps）。默认 2。 */
  deltaSteps: number;
  /** 用户手动中止后台压缩后的冷却分钟数（冷却期不触发 BPC）。默认 3。 */
  abortCooldownMin: number;
  /** 熔断间距：替换后 step 推进 <= 此值又触发预压即算「立即重触发」（连续 2 次熔断）。默认 1。 */
  circuitBreakGapSteps: number;
}

interface AgentSettingsState {
  mode: AgentMode;
  /** ★ task_boundary：是否启用 Plan 模式任务边界卡片（开关，默认 true；关闭则 systemPrompt 不引导 AI 用这些工具）。 */
  taskBoundaryEnabled: boolean;
  /** ★ M7 第四轮：消息流是否隐藏系统/元工具调用卡片（show_artifact / task_boundary 系列 / worktree 切换等——
   *   它们已有专门卡片可视化，工具调用卡片是冗余噪音）。默认 true=隐藏；关闭则全部显示（调试用）。 */
  hideSystemToolCalls: boolean;
  /** ★ 模型上下文窗口手动覆盖（modelId → 窗口 token）：能力面板推断不准时用户手动改，覆盖所有用 contextWindow 处。 */
  contextWindowOverrides: Record<string, number>;
  currentModel: string;
  /**
   * ★ M4-5-S1：系统模型（后台任务专用），空字符串 = 跟随 currentModel。
   * 历史压缩摘要（recordGenerator）、自动标题等【后台 LLM 任务】走这条独立通路，
   * 与主对话模型（currentModel）解耦。统一通过 resolveSystemModel（services/modelResolution.ts）解析，
   * 口径恒为 systemModel || currentModel。靠 agentSettings 整 slice 自动持久化，无需改持久化代码。
   */
  systemModel: string;
  availableModels: AIModelOption[];
  connectionStatus: ConnectionStatus;
  maxToolRounds: number;
  /** 达到单段工具轮上限后是否自动延续同一任务。默认关闭，避免意外无限运行。 */
  autoContinueToolRounds: boolean;
  enableStreaming: boolean;
  outputStrategy: OutputStrategy;
  pseudoStreamSpeed: PseudoStreamSpeed;
  showStreamCursor: boolean;
  showGeneratingPlaceholder: boolean;
  streamThinking: boolean;
  showThinking: boolean;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningEffort: string;
  speedTier: string;
  backgroundSettings: BackgroundSettings;
  synopsisSettings: SynopsisSettings;
  /** ★ M5-RL：record 分层/折叠/硬闸可调参数。 */
  recordLayering: RecordLayeringConfig;
  /** ★ M5-BPC：后台预压缩可调参数（触发/硬阈值/δ窗口/冷却/熔断间距）。 */
  bpc: BpcConfig;
}

/**
 * ★ M5-BPC：BPC 默认配置单一真相源。initialState.bpc / store sanitize 兜底 / SettingsPanel 复位均引用此常量，
 *   改默认值只改这一处（区别于 recordLayering 当年默认值散落三处需同步——这里收敛成共享常量）。
 */
export const DEFAULT_BPC_CONFIG: BpcConfig = {
  bpcThreshold: 0.68,
  compactThreshold: 0.9,
  deltaSteps: 2,
  abortCooldownMin: 3,
  circuitBreakGapSteps: 1,
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function normalizeBpcConfig(raw: Partial<BpcConfig> | null | undefined): BpcConfig {
  const source = raw ?? {};
  const compactThreshold = clampNumber(source.compactThreshold, DEFAULT_BPC_CONFIG.compactThreshold, 0.5, 0.95);
  const unclampedBpc = clampNumber(source.bpcThreshold, DEFAULT_BPC_CONFIG.bpcThreshold, 0.4, 0.9);
  return {
    bpcThreshold: Math.min(unclampedBpc, compactThreshold - 0.05),
    compactThreshold,
    deltaSteps: Math.round(clampNumber(source.deltaSteps, DEFAULT_BPC_CONFIG.deltaSteps, 1, 10)),
    abortCooldownMin: Math.round(clampNumber(source.abortCooldownMin, DEFAULT_BPC_CONFIG.abortCooldownMin, 0, 30)),
    circuitBreakGapSteps: Math.round(clampNumber(source.circuitBreakGapSteps, DEFAULT_BPC_CONFIG.circuitBreakGapSteps, 0, 5)),
  };
}

const initialState: AgentSettingsState = {
  mode: 'planning',
  taskBoundaryEnabled: true,
  hideSystemToolCalls: true,
  contextWindowOverrides: {},
  currentModel: '',
  systemModel: '', // M4-5-S1：空 = 跟随 currentModel
  availableModels: [],
  connectionStatus: 'unknown',
  maxToolRounds: 25,
  autoContinueToolRounds: false,
  enableStreaming: true,
  outputStrategy: 'auto',
  pseudoStreamSpeed: 'medium',
  showStreamCursor: true,
  showGeneratingPlaceholder: true,
  streamThinking: true,
  showThinking: true,
  temperature: 0.7,
  topP: 1,
  maxTokens: 4096,
  reasoningEffort: 'auto',
  speedTier: 'auto',
  backgroundSettings: {
    enabled: false,
    images: [],
    selectedIndex: 0,
    displayMode: 'static',
    carouselInterval: 300,
    transitionEffect: 'fade',
    blur: 0,
    opacity: 0.7,
    panelOpacity: 0.75,
  },
  synopsisSettings: {
    textModeEnabled: false,
    chunkMaxTokens: 2000,
    mapConcurrency: 3,
    autoIndexEnabled: true,
    autoIndexMethod: 'contentHash',
  },
  recordLayering: {
    headFull: 2,
    tailFull: 1,
    titleThreshold: 20,
    maxRatio: 0.4,
    foldThreshold: 30,
    foldBatchK: 10,
    // ★ #14 动态分级（默认开）：默认值需与 store/index.ts sanitize 兜底 + agentLoop.DEFAULT_LAYERING 三处同步。
    dynamicLevelEnabled: true,
    hitWeight: 0.6,
    distWeight: 0.2,
    hitBase: 0.4,
    fullThreshold: 0.6,
    summaryThreshold: 0.3,
    distFloor: 0.5,
  },
  bpc: { ...DEFAULT_BPC_CONFIG },
};

export function normalizeWallpaperImage(input: unknown, index = 0): WallpaperImage | null {
  if (typeof input === 'string') {
    if (!input) return null;
    const looksManaged = input.startsWith('synapse-wallpaper://');
    return {
      id: `legacy-${index}-${simpleHash(input)}`,
      name: `壁纸 ${index + 1}`,
      kind: looksManaged ? 'managed' : 'dataUrl',
      url: input,
      addedAt: Date.now(),
      legacy: true,
    };
  }
  if (!input || typeof input !== 'object') return null;
  const item = input as Partial<WallpaperImage>;
  const url = typeof item.url === 'string' ? item.url : '';
  if (!url) return null;
  const id = typeof item.id === 'string' && item.id.trim()
    ? item.id.trim()
    : `wallpaper-${index}-${simpleHash(url)}`;
  const kind: WallpaperKind = item.kind === 'managed' ? 'managed' : 'dataUrl';
  return {
    id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `壁纸 ${index + 1}`,
    kind,
    url,
    relativePath: typeof item.relativePath === 'string' ? item.relativePath : undefined,
    mime: typeof item.mime === 'string' ? item.mime : undefined,
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
    width: Number.isFinite(Number(item.width)) ? Number(item.width) : undefined,
    height: Number.isFinite(Number(item.height)) ? Number(item.height) : undefined,
    addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : Date.now(),
    legacy: Boolean(item.legacy),
  };
}

export function normalizeWallpaperImages(inputs: unknown): WallpaperImage[] {
  if (!Array.isArray(inputs)) return [];
  return inputs
    .map((item, index) => normalizeWallpaperImage(item, index))
    .filter((item): item is WallpaperImage => Boolean(item));
}

export function getWallpaperUrl(input: WallpaperImage | string | undefined): string {
  if (!input) return '';
  return typeof input === 'string' ? input : input.url;
}

export function getWallpaperName(input: WallpaperImage | string | undefined, index: number): string {
  if (!input) return `壁纸 ${index + 1}`;
  return typeof input === 'string' ? `壁纸 ${index + 1}` : input.name || `壁纸 ${index + 1}`;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export const agentSettingsSlice = createSlice({
  name: 'agentSettings',
  initialState,
  reducers: {
    setMode(state, action: PayloadAction<AgentMode>) {
      state.mode = action.payload;
    },
    // ★ task_boundary：开关启用/停用 Plan 模式任务边界（关闭后 systemPrompt 不引导、不再生成新边界）。
    setTaskBoundaryEnabled(state, action: PayloadAction<boolean>) {
      state.taskBoundaryEnabled = action.payload;
    },
    // ★ M7：开关消息流是否隐藏系统/元工具调用卡片（show_artifact / task_boundary / worktree 等）。
    setHideSystemToolCalls(state, action: PayloadAction<boolean>) {
      state.hideSystemToolCalls = action.payload;
    },
    // ★ 设/清模型上下文窗口手动覆盖。value 合法正数 → 设；null/非法 → 清（回退推断值）。
    setContextWindowOverride(state, action: PayloadAction<{ modelId: string; value: number | null }>) {
      if (!state.contextWindowOverrides) state.contextWindowOverrides = {};
      const { modelId, value } = action.payload;
      if (modelId && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        state.contextWindowOverrides[modelId] = Math.round(value);
      } else if (modelId) {
        delete state.contextWindowOverrides[modelId];
      }
    },
    setCurrentModel(state, action: PayloadAction<string>) {
      state.currentModel = action.payload;
    },
    /**
     * ★ M4-5-S1：设置系统模型（后台任务专用）。空字符串 = 跟随 currentModel。
     * 失效回退（模型从端点下线）由 SettingsPanel.fetchModels 成功后并列校验、store 加载期校验处理。
     */
    setSystemModel(state, action: PayloadAction<string>) {
      state.systemModel = action.payload;
    },
    // ★ M5-RL：更新 record 分层参数（部分覆盖，UI 逐项改）。
    setRecordLayering(state, action: PayloadAction<Partial<RecordLayeringConfig>>) {
      state.recordLayering = { ...state.recordLayering, ...action.payload };
    },
    /**
     * ★ M5-BPC：更新后台预压缩参数（部分覆盖，UI 逐项改，仿 setRecordLayering 浅合并）。
     *   ★ 数值口径：只接受【有限 number】的字段覆盖（typeof==='number' && isFinite），过滤掉 undefined/NaN/非数字，
     *   绝不用 `x||fallback` 吞掉合法 0 值（虽阈值现实不为 0，但留作正确口径防未来 0.0 边界）。
     */
    setBpc(state, action: PayloadAction<Partial<BpcConfig>>) {
      state.bpc = normalizeBpcConfig({ ...state.bpc, ...(action.payload ?? {}) });
    },
    setAvailableModels(state, action: PayloadAction<AIModelOption[]>) {
      state.availableModels = action.payload;
    },
    setConnectionStatus(state, action: PayloadAction<ConnectionStatus>) {
      state.connectionStatus = action.payload;
    },
    setMaxToolRounds(state, action: PayloadAction<number>) {
      state.maxToolRounds = Math.max(3, Math.min(100, Math.round(action.payload)));
    },
    setAutoContinueToolRounds(state, action: PayloadAction<boolean>) {
      state.autoContinueToolRounds = action.payload;
    },
    setEnableStreaming(state, action: PayloadAction<boolean>) {
      state.enableStreaming = action.payload;
      state.outputStrategy = action.payload ? 'auto' : 'off';
    },
    setOutputStrategy(state, action: PayloadAction<OutputStrategy>) {
      state.outputStrategy = action.payload;
      state.enableStreaming = action.payload !== 'off';
    },
    setPseudoStreamSpeed(state, action: PayloadAction<PseudoStreamSpeed>) {
      state.pseudoStreamSpeed = action.payload;
    },
    setShowStreamCursor(state, action: PayloadAction<boolean>) {
      state.showStreamCursor = action.payload;
    },
    setShowGeneratingPlaceholder(state, action: PayloadAction<boolean>) {
      state.showGeneratingPlaceholder = action.payload;
    },
    setStreamThinking(state, action: PayloadAction<boolean>) {
      state.streamThinking = action.payload;
    },
    setShowThinking(state, action: PayloadAction<boolean>) {
      state.showThinking = action.payload;
    },
    setTemperature(state, action: PayloadAction<number>) {
      state.temperature = action.payload;
    },
    setTopP(state, action: PayloadAction<number>) {
      state.topP = action.payload;
    },
    setMaxTokens(state, action: PayloadAction<number>) {
      state.maxTokens = action.payload;
    },
    setReasoningEffort(state, action: PayloadAction<string>) {
      state.reasoningEffort = action.payload;
    },
    setSpeedTier(state, action: PayloadAction<string>) {
      state.speedTier = action.payload;
    },
    setBackgroundSettings(state, action: PayloadAction<Partial<BackgroundSettings>>) {
      state.backgroundSettings = {
        ...state.backgroundSettings,
        ...action.payload,
      };
      state.backgroundSettings.images = normalizeWallpaperImages(state.backgroundSettings.images);
      if (state.backgroundSettings.selectedIndex >= state.backgroundSettings.images.length) {
        state.backgroundSettings.selectedIndex = Math.max(0, state.backgroundSettings.images.length - 1);
      }
    },
    addBackgroundImages(state, action: PayloadAction<Array<WallpaperImage | string>>) {
      const images = normalizeWallpaperImages(action.payload);
      if (images.length === 0) return;
      const wasEmpty = state.backgroundSettings.images.length === 0;
      state.backgroundSettings.images.push(...images);
      state.backgroundSettings.enabled = true;
      if (wasEmpty) {
        state.backgroundSettings.selectedIndex = 0;
      }
    },
    selectBackgroundImage(state, action: PayloadAction<number>) {
      const index = action.payload;
      if (index >= 0 && index < state.backgroundSettings.images.length) {
        state.backgroundSettings.selectedIndex = index;
        state.backgroundSettings.enabled = true;
      }
    },
    removeBackgroundImage(state, action: PayloadAction<number>) {
      const index = action.payload;
      if (index < 0 || index >= state.backgroundSettings.images.length) return;
      state.backgroundSettings.images.splice(index, 1);
      if (state.backgroundSettings.images.length === 0) {
        state.backgroundSettings.selectedIndex = 0;
        state.backgroundSettings.enabled = false;
        return;
      }
      if (state.backgroundSettings.selectedIndex >= state.backgroundSettings.images.length) {
        state.backgroundSettings.selectedIndex = state.backgroundSettings.images.length - 1;
      } else if (index < state.backgroundSettings.selectedIndex) {
        state.backgroundSettings.selectedIndex -= 1;
      }
    },
    clearBackgroundImages(state) {
      state.backgroundSettings.images = [];
      state.backgroundSettings.selectedIndex = 0;
      state.backgroundSettings.enabled = false;
    },
    nextBackgroundImage(state) {
      const count = state.backgroundSettings.images.length;
      if (count < 2) return;
      if (state.backgroundSettings.displayMode === 'random') {
        let nextIndex = Math.floor(Math.random() * count);
        if (nextIndex === state.backgroundSettings.selectedIndex) {
          nextIndex = (nextIndex + 1) % count;
        }
        state.backgroundSettings.selectedIndex = nextIndex;
      } else {
        state.backgroundSettings.selectedIndex = (state.backgroundSettings.selectedIndex + 1) % count;
      }
    },
    setSynopsisSettings(state, action: PayloadAction<Partial<SynopsisSettings>>) {
      state.synopsisSettings = {
        ...state.synopsisSettings,
        ...action.payload,
      };
    },
  },
});

export const {
  setMode, setTaskBoundaryEnabled, setHideSystemToolCalls, setContextWindowOverride, setCurrentModel, setSystemModel, setRecordLayering, setBpc, setMaxToolRounds, setAutoContinueToolRounds,
  setAvailableModels, setConnectionStatus,
  setEnableStreaming, setOutputStrategy, setPseudoStreamSpeed,
  setShowStreamCursor, setShowGeneratingPlaceholder, setStreamThinking,
  setShowThinking, setTemperature, setTopP,
  setMaxTokens, setReasoningEffort, setSpeedTier,
  setBackgroundSettings, addBackgroundImages, selectBackgroundImage,
  removeBackgroundImage, clearBackgroundImages, nextBackgroundImage,
  setSynopsisSettings,
} = agentSettingsSlice.actions;
