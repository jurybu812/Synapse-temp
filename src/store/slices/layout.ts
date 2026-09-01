import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface LayoutState {
  sidebarVisible: boolean;
  bottomPanelVisible: boolean;
  agentPanelVisible: boolean;
  isFullscreenAgent: boolean;
}

const DEFAULT_LAYOUT_STATE: LayoutState = {
  sidebarVisible: true,
  bottomPanelVisible: true,
  agentPanelVisible: true,
  isFullscreenAgent: false,
};

function loadInitialLayoutState(): LayoutState {
  try {
    const raw = localStorage.getItem('synapse_layout');
    if (!raw) return DEFAULT_LAYOUT_STATE;
    const parsed = JSON.parse(raw);
    return {
      sidebarVisible: typeof parsed.sidebarVisible === 'boolean' ? parsed.sidebarVisible : true,
      bottomPanelVisible: typeof parsed.bottomPanelVisible === 'boolean' ? parsed.bottomPanelVisible : true,
      agentPanelVisible: typeof parsed.agentPanelVisible === 'boolean' ? parsed.agentPanelVisible : true,
      isFullscreenAgent: false,
    };
  } catch {
    return DEFAULT_LAYOUT_STATE;
  }
}

const initialState = loadInitialLayoutState();

export const layoutSlice = createSlice({
  name: 'layout',
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.sidebarVisible = !state.sidebarVisible;
    },
    toggleBottomPanel(state) {
      state.bottomPanelVisible = !state.bottomPanelVisible;
    },
    toggleAgentPanel(state) {
      state.agentPanelVisible = !state.agentPanelVisible;
    },
    toggleFullscreenAgent(state) {
      state.isFullscreenAgent = !state.isFullscreenAgent;
    },
    setSidebarVisible(state, action: PayloadAction<boolean>) {
      state.sidebarVisible = action.payload;
    },
    setBottomPanelVisible(state, action: PayloadAction<boolean>) {
      state.bottomPanelVisible = action.payload;
    },
    setAgentPanelVisible(state, action: PayloadAction<boolean>) {
      state.agentPanelVisible = action.payload;
    },
  },
});

export const {
  toggleSidebar, toggleBottomPanel, toggleAgentPanel,
  toggleFullscreenAgent, setSidebarVisible,
  setBottomPanelVisible, setAgentPanelVisible,
} = layoutSlice.actions;
