import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface WorkspaceState {
  currentPath: string | null;
  name: string;
  recentPaths: string[];
  synopsisReady: boolean;
  indexingProgress: number;
}

const initialState: WorkspaceState = {
  currentPath: null,
  name: '',
  recentPaths: [],
  synopsisReady: false,
  indexingProgress: 0,
};

export const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    openWorkspace(state, action: PayloadAction<{ path: string; name: string }>) {
      state.currentPath = action.payload.path;
      state.name = action.payload.name;
      if (!state.recentPaths.includes(action.payload.path)) {
        state.recentPaths.unshift(action.payload.path);
        if (state.recentPaths.length > 10) state.recentPaths.pop();
      }
    },
    closeWorkspace(state) {
      state.currentPath = null;
      state.name = '';
      state.synopsisReady = false;
      state.indexingProgress = 0;
    },
    clearWorkspace(state) {
      state.currentPath = null;
      state.name = '';
      state.synopsisReady = false;
      state.indexingProgress = 0;
    },
    setIndexingProgress(state, action: PayloadAction<number>) {
      state.indexingProgress = action.payload;
      if (action.payload >= 100) state.synopsisReady = true;
    },
    setSynopsisReady(state, action: PayloadAction<boolean>) {
      state.synopsisReady = action.payload;
    },
    setRecentPaths(state, action: PayloadAction<string[]>) {
      state.recentPaths = action.payload;
    },
  },
});

export const {
  openWorkspace, closeWorkspace, clearWorkspace, setIndexingProgress,
  setSynopsisReady, setRecentPaths,
} = workspaceSlice.actions;
