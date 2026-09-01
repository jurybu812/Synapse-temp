import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface SafetySettings {
  autoApproveRead: boolean;
  autoApproveWrite: boolean;
  autoApproveCommand: boolean;
  autoApproveAll: boolean;
  fullAccess: boolean;
}

interface PromptInjectionSettings {
  injectIdentity: boolean;
  injectTools: boolean;
  injectSkills: boolean;
  injectContext: boolean;
  injectRules: boolean;
  injectWorkflows: boolean;
}

export interface ProviderCredentialMetadata {
  providerId: string;
  configured: boolean;
  persisted: boolean;
  storage: 'safeStorage' | 'memory' | 'none';
  credentialType: string | null;
  updatedAt: number | null;
  accountFingerprint?: string | null;
  credentialGeneration?: number;
}

// ★ C1（M7 第七轮反馈#6）：输入框发送键模式。
//   'enter'     = Enter 发送 / Shift+Enter 换行（默认，IM 习惯）。
//   'ctrlEnter' = Ctrl 或 Cmd+Enter 发送 / Enter 换行（编辑器习惯，旧默认行为）。
export type SendKeyMode = 'enter' | 'ctrlEnter';

// ★ Plan_7 #6：生成中（isStreaming）发送键的【主键动作】——决定生成中“主发送键（Enter / Ctrl+Enter，依 sendKeyMode）”
//   按下时是入【排队】还是【插队】队列，另一组合键自动取相反语义。Shift+Enter 永远换行（不在此列）。
//   'queue'     = 主键→排队（本轮结束自动发），修饰键(Ctrl/Cmd+Enter)→插队（默认，最稳妥）。
//   'interrupt' = 主键→插队（下个空闲轮间插入），修饰键→排队。
//   非生成中不受此影响，维持 C1 的 sendKeyMode（正常发送）。
export type RuntimeEnterAction = 'queue' | 'interrupt';

interface SettingsState {
  language: 'zh-CN' | 'en';
  fontSize: number;
  autoSave: boolean;
  showLineNumbers: boolean;
  wordWrap: boolean;
  // ★ C1：底部主输入框发送键模式（界面交互偏好，随 settings 持久化）。
  sendKeyMode: SendKeyMode;
  // ★ Plan_7 #6：生成中发送键主键动作（'queue' 默认 / 'interrupt'）。随 settings 持久化。
  //   读取处按「=== 'interrupt' 才 interrupt，否则 queue」兜底（旧持久化缺此字段=undefined → 视为 'queue'）。
  runtimeEnterAction: RuntimeEnterAction;
  // ★ H4-1（M8 第七轮反馈）：用户消息是否归入当前 active task_boundary 卡片（默认 true=维持现状）。
  //   false 时 handleSend 发送前先收口 active 边界（endTaskBoundary），新消息落在卡片外。
  //   读取处一律按「!== false」兜底（旧 localStorage 整体替换 settings 时缺此字段会是 undefined → 视为 true）。
  attachUserMsgToBoundary: boolean;
  // ★ #19 个性化：用户/AI 头像（dataURL，已 canvas 压缩裁剪到 ≤256×256）+ 昵称。
  //   全为可选——空/undefined 时 MessageBubble 回退现有图标色块 + 「你」/「Synapse AI」默认文案。
  //   旧持久化缺这些字段时 loadSettings 的 `{...initialState, ...payload}` 天然兜底为 initialState 的 undefined/''。
  userAvatar?: string;
  userName?: string;
  aiAvatar?: string;
  aiName?: string;
  providerCredentials: Record<string, ProviderCredentialMetadata>;
  apiEndpoints: Record<string, string>;
  // New settings
  safety: SafetySettings;
  promptInjection: PromptInjectionSettings;
  maxConversationHistory: number;
  autoArchiveAfter: number; // days, 0 = disabled
  // ★ 文件树最大展开深度（IPC workspace:tree 的 maxDepth）。默认 8；旧硬编码 3 会让第 4 层及更深目录显示为空。
  fileTreeMaxDepth: number;
}

const initialState: SettingsState = {
  language: 'zh-CN',
  fontSize: 14,
  autoSave: true,
  showLineNumbers: true,
  wordWrap: true,
  sendKeyMode: 'enter', // ★ C1：默认 Enter 发送 / Shift+Enter 换行
  runtimeEnterAction: 'queue', // ★ Plan_7 #6：默认生成中主键→排队、Ctrl/Cmd+Enter→插队
  attachUserMsgToBoundary: true, // ★ H4-1：默认用户消息归入当前任务边界卡片（维持现状）
  // ★ #19 个性化：默认全空——头像走图标色块兜底、昵称走「你」/「Synapse AI」兜底。
  userAvatar: undefined,
  userName: '',
  aiAvatar: undefined,
  aiName: '',
  providerCredentials: {},
  apiEndpoints: {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
  },
  safety: {
    autoApproveRead: true,
    autoApproveWrite: false,
    autoApproveCommand: false,
    autoApproveAll: false,
    fullAccess: false,
  },
  promptInjection: {
    injectIdentity: true,
    injectTools: true,
    injectSkills: true,
    injectContext: true,
    injectRules: true,
    injectWorkflows: true,
  },
  maxConversationHistory: 100,
  autoArchiveAfter: 30,
  fileTreeMaxDepth: 8,
};

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setLanguage(state, action: PayloadAction<'zh-CN' | 'en'>) {
      state.language = action.payload;
    },
    setFontSize(state, action: PayloadAction<number>) {
      state.fontSize = action.payload;
    },
    setAutoSave(state, action: PayloadAction<boolean>) {
      state.autoSave = action.payload;
    },
    // ★ C1：切换发送键模式（'enter' / 'ctrlEnter'）。
    setSendKeyMode(state, action: PayloadAction<SendKeyMode>) {
      state.sendKeyMode = action.payload;
    },
    // ★ Plan_7 #6：切换生成中发送键主键动作（'queue' / 'interrupt'）。
    setRuntimeEnterAction(state, action: PayloadAction<RuntimeEnterAction>) {
      state.runtimeEnterAction = action.payload;
    },
    // ★ H4-1：切换「用户消息归入当前任务边界」开关。
    setAttachUserMsgToBoundary(state, action: PayloadAction<boolean>) {
      state.attachUserMsgToBoundary = action.payload;
    },
    // ★ #19 个性化：用户/AI 头像（dataURL，传 undefined 清除回退默认图标）。
    setUserAvatar(state, action: PayloadAction<string | undefined>) {
      state.userAvatar = action.payload;
    },
    setUserName(state, action: PayloadAction<string>) {
      state.userName = action.payload;
    },
    setAiAvatar(state, action: PayloadAction<string | undefined>) {
      state.aiAvatar = action.payload;
    },
    setAiName(state, action: PayloadAction<string>) {
      state.aiName = action.payload;
    },
    setProviderCredentialStatus(state, action: PayloadAction<ProviderCredentialMetadata>) {
      state.providerCredentials[action.payload.providerId] = action.payload;
    },
    setApiEndpoint(state, action: PayloadAction<{ provider: string; url: string }>) {
      state.apiEndpoints[action.payload.provider] = action.payload.url;
    },
    loadSettings(_, action: PayloadAction<Partial<SettingsState>>) {
      return {
        ...initialState,
        ...action.payload,
        providerCredentials: {
          ...initialState.providerCredentials,
          ...(action.payload.providerCredentials ?? {}),
        },
        apiEndpoints: {
          ...initialState.apiEndpoints,
          ...(action.payload.apiEndpoints ?? {}),
        },
        safety: {
          ...initialState.safety,
          ...(action.payload.safety ?? {}),
        },
        promptInjection: {
          ...initialState.promptInjection,
          ...(action.payload.promptInjection ?? {}),
        },
      };
    },
    // Safety settings
    setSafety(state, action: PayloadAction<Partial<SafetySettings>>) {
      state.safety ??= { ...initialState.safety };
      Object.assign(state.safety, action.payload);
      if (action.payload.autoApproveAll !== undefined) {
        state.safety.autoApproveRead = action.payload.autoApproveAll;
        state.safety.autoApproveWrite = action.payload.autoApproveAll;
        state.safety.autoApproveCommand = action.payload.autoApproveAll;
      } else if (
        action.payload.autoApproveRead !== undefined
        || action.payload.autoApproveWrite !== undefined
        || action.payload.autoApproveCommand !== undefined
      ) {
        state.safety.autoApproveAll = state.safety.autoApproveRead
          && state.safety.autoApproveWrite
          && state.safety.autoApproveCommand;
      }
    },
    // Prompt injection settings
    setPromptInjection(state, action: PayloadAction<Partial<PromptInjectionSettings>>) {
      state.promptInjection ??= { ...initialState.promptInjection };
      Object.assign(state.promptInjection, action.payload);
    },
    setMaxConversationHistory(state, action: PayloadAction<number>) {
      state.maxConversationHistory = action.payload;
    },
    setAutoArchiveAfter(state, action: PayloadAction<number>) {
      state.autoArchiveAfter = action.payload;
    },
    // ★ 文件树最大展开深度（修 maxDepth=3 硬编码致深层目录显示空的 bug；可调，下限 1）。
    setFileTreeMaxDepth(state, action: PayloadAction<number>) {
      state.fileTreeMaxDepth = Math.max(1, Math.floor(action.payload));
    },
  },
});

export const {
  setLanguage, setFontSize, setAutoSave, setSendKeyMode, setRuntimeEnterAction, setAttachUserMsgToBoundary,
  setUserAvatar, setUserName, setAiAvatar, setAiName,
  setProviderCredentialStatus, setApiEndpoint, loadSettings,
  setSafety, setPromptInjection,
  setMaxConversationHistory, setAutoArchiveAfter, setFileTreeMaxDepth,
} = settingsSlice.actions;
