import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface EditorTab {
  id: string;
  filePath: string;
  fileName: string;
  isDirty: boolean;
  isPreview: boolean;
  type: 'code' | 'pdf' | 'pptx' | 'docx' | 'office' | 'markdown' | 'html' | 'image' | 'video' | 'welcome' | 'showcase' | 'settings' | 'review' | 'diffview' | 'workflow' | 'attachment' | 'unsupported';
  content?: string;
  savedContent?: string;
  /**
   * ★ M4-3-S3：type==='attachment' 专属——已发消息附件的 MIME，AttachmentTabViewer 据此选渲染方式
   *   （image/* → img、application/pdf → iframe、文本类 → pre、其它 → 下载提示）。其它类型 tab 无此字段。
   */
  mimeType?: string;
  /**
   * ★ M3-3b 子代理中间视图 tab（type==='workflow'）专属：关联的 Multi-AI 工作流运行实例 id
   *   （multiAI.workflowRuns[runId]）。EditorArea 据此渲染 <WorkflowView runId=... />。其它类型 tab 无此字段。
   */
  workflowRunId?: string;
  /**
   * ★ 反馈#2：type==='diffview' 专属——指向 conversation.pendingDiffs 里某个文件改动的 diff id。
   *   EditorArea 据此找出该 diff 渲染单文件行内红绿 diff（SingleDiffView）+ 文件级/hunk/段级 accept/reject；
   *   该 diff 处理完（不再 pending / 已不存在）时自动降级回普通文件查看器。其它类型 tab 无此字段。
   */
  diffId?: string;
}

const welcomeTab: EditorTab = {
  id: 'welcome',
  filePath: '',
  fileName: '欢迎',
  isDirty: false,
  isPreview: false,
  type: 'welcome',
};

interface EditorTabsState {
  tabs: EditorTab[];
  activeTabId: string | null;
  /**
   * ★ M4-3-S7 / UI-10：Enable Preview Editors 开关（VS Code「单击文件=临时斜体 tab」总闸）。
   *   true → 单击文件复用同一个临时 preview tab；false（现默认，见 initialState）→ 每次打开都是固定独立 tab。
   */
  previewEnabled: boolean;
  /**
   * ★ M4-3-S7：Lock Group（轻量版，单 group 架构）。锁定后：openTab 不再复用 preview 位
   *   （强制新固定 tab）、closeAllTabs / closeSavedTabs 不误关本组 tab（由调用方判定阻断）。
   */
  groupLocked: boolean;
}

const initialState: EditorTabsState = {
  tabs: [welcomeTab],
  activeTabId: 'welcome',
  // ★ UI-10：默认 false——单击文件每次开独立固定 tab、互不替换（主人反馈「打开文件互相替换、中部只能存一个」）。
  //   想要 VS Code 式「单击=临时预览位复用」的用户可在 TabBar 的 ⋯ 菜单「Enable Preview Editors」手动开启。
  previewEnabled: false,
  groupLocked: false,
};

export const editorTabsSlice = createSlice({
  name: 'editorTabs',
  initialState,
  reducers: {
    openTab(state, action: PayloadAction<EditorTab>) {
      const incoming = action.payload;

      // 同 filePath 已开 → 仅激活（保留原有去重语义；空 filePath 的 review/workflow 等 tab 不会误命中）。
      const existing = incoming.filePath
        ? state.tabs.find(t => t.filePath === incoming.filePath)
        : undefined;
      if (existing) {
        state.activeTabId = existing.id;
        return;
      }

      // ★ M4-3-S7：预览 tab 替换语义（VS Code「单击文件复用同一个临时 tab」）。
      //   仅当：previewEnabled 开 + 未锁组 + 本次确为 preview 打开（incoming.isPreview）时，
      //   才把上一个临时 preview tab 原位替换；否则正常新增。
      //   previewEnabled=false 时强制固定（isPreview:false），保护 review/workflow 等非文件 tab。
      const wantPreview = incoming.isPreview && state.previewEnabled && !state.groupLocked;
      const finalTab: EditorTab = { ...incoming, isPreview: wantPreview };

      if (wantPreview) {
        const previewIdx = state.tabs.findIndex(t => t.isPreview);
        if (previewIdx >= 0) {
          // 原位替换旧 preview tab（同位置，避免标签栏跳动）。
          state.tabs[previewIdx] = finalTab;
          state.activeTabId = finalTab.id;
          return;
        }
      }

      state.tabs.push(finalTab);
      state.activeTabId = finalTab.id;
    },
    /**
     * ★ M4-3-S7：固定 tab（双击或编辑触发）——去 preview 斜体态，转为常驻 tab。
     */
    pinTab(state, action: PayloadAction<string>) {
      const tab = state.tabs.find(t => t.id === action.payload);
      if (tab) tab.isPreview = false;
    },
    /**
     * ★ M4-3-S7：Enable Preview Editors 开关。关闭时把当前已存在的 preview tab 一并固定，
     *   避免「关了开关但旧斜体 tab 还在临时态」的语义错位。
     */
    togglePreviewEnabled(state, action: PayloadAction<boolean | undefined>) {
      state.previewEnabled = action.payload ?? !state.previewEnabled;
      if (!state.previewEnabled) {
        for (const tab of state.tabs) tab.isPreview = false;
      }
    },
    /**
     * ★ M4-3-S7：Lock Group（轻量版）。仅维护开关状态；closeAll/closeSaved 的阻断由
     *   调用方（TabBar）依据此状态判定，reducer 不强行改 tab。
     */
    lockGroup(state, action: PayloadAction<boolean | undefined>) {
      state.groupLocked = action.payload ?? !state.groupLocked;
    },
    /**
     * ★ M4-3-S7：Close Saved——关闭所有「非 dirty 且非 welcome」的 tab（dirty 与 welcome 保留）。
     *   dirty 确认链不在此处理（这些本就未脏，无须确认）。
     */
    closeSavedTabs(state) {
      state.tabs = state.tabs.filter(t => t.isDirty || t.type === 'welcome');
      if (!state.tabs.some(t => t.id === state.activeTabId)) {
        state.activeTabId = state.tabs[state.tabs.length - 1]?.id ?? null;
      }
    },
    /**
     * ★ M3-3b 打开「子代理中间视图」tab（非文件视图，仿 review tab 模式）。
     *   id 用稳定的 `workflow:${runId}`，同 runId 已开则仅激活不重开（去重不依赖 filePath——
     *   workflow tab 无 filePath，故另起 action 而非复用按 filePath 去重的 openTab）。
     */
    openWorkflowTab(state, action: PayloadAction<{ runId: string; title: string }>) {
      const tabId = `workflow:${action.payload.runId}`;
      const existing = state.tabs.find(t => t.id === tabId);
      if (existing) {
        state.activeTabId = existing.id;
        return;
      }
      state.tabs.push({
        id: tabId,
        filePath: '',
        fileName: action.payload.title || '工作流',
        isDirty: false,
        isPreview: false,
        type: 'workflow',
        workflowRunId: action.payload.runId,
      });
      state.activeTabId = tabId;
    },
    closeTab(state, action: PayloadAction<string>) {
      state.tabs = state.tabs.filter(t => t.id !== action.payload);
      if (state.activeTabId === action.payload) {
        state.activeTabId = state.tabs[state.tabs.length - 1]?.id ?? null;
      }
    },
    setActiveTab(state, action: PayloadAction<string>) {
      state.activeTabId = action.payload;
    },
    setTabDirty(state, action: PayloadAction<{ id: string; dirty: boolean }>) {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      tab.isDirty = action.payload.dirty;
      // ★ M4-3-S7：编辑即固定——一旦标脏，自动退出 preview 临时态（符合 VS Code）。
      if (action.payload.dirty) tab.isPreview = false;
    },
    setTabContent(state, action: PayloadAction<{ id: string; content: string; dirty?: boolean; markSaved?: boolean }>) {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      tab.content = action.payload.content;
      if (action.payload.markSaved) {
        tab.savedContent = action.payload.content;
        tab.isDirty = false;
      } else if (action.payload.dirty !== undefined) {
        tab.isDirty = action.payload.dirty;
      } else {
        tab.isDirty = action.payload.content !== (tab.savedContent ?? '');
      }
      // ★ M4-3-S7：编辑即固定——内容变脏即转固定 tab（markSaved/初次加载置 saved 不触发）。
      if (tab.isDirty) tab.isPreview = false;
    },
    reconcileTabFile(state, action: PayloadAction<{ id: string; content: string; savedContent: string }>) {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      tab.content = action.payload.content;
      tab.savedContent = action.payload.savedContent;
      tab.isDirty = action.payload.content !== action.payload.savedContent;
      if (tab.isDirty) tab.isPreview = false;
    },
    markTabSaved(state, action: PayloadAction<{ id: string; content?: string }>) {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      if (action.payload.content !== undefined) {
        tab.content = action.payload.content;
        tab.savedContent = action.payload.content;
      } else {
        tab.savedContent = tab.content;
      }
      tab.isDirty = false;
    },
    closeAllTabs(state) {
      state.tabs = [];
      state.activeTabId = null;
    },
    resetTabsToWelcome(state) {
      state.tabs = [welcomeTab];
      state.activeTabId = 'welcome';
    },
  },
});

export const {
  openTab, openWorkflowTab, closeTab, setActiveTab, setTabDirty, setTabContent, reconcileTabFile, markTabSaved, closeAllTabs, resetTabsToWelcome,
  pinTab, togglePreviewEnabled, lockGroup, closeSavedTabs,
} = editorTabsSlice.actions;

export type { EditorTab };
