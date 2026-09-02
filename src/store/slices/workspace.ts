import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface WorkspaceState {
  currentPath: string | null;
  name: string;
  recentPaths: string[];
  synopsisReady: boolean;
  indexingProgress: number;
}

export type PersistedWorkspaceState = Pick<WorkspaceState, 'currentPath' | 'name' | 'recentPaths'>;

const initialState: WorkspaceState = {
  currentPath: null,
  name: '',
  recentPaths: [],
  synopsisReady: false,
  indexingProgress: 0,
};

export function workspacePathKey(workspacePath: unknown): string {
  if (typeof workspacePath !== 'string') return '';
  return workspacePath.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export function dedupeRecentPaths(paths: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const workspacePath of paths) {
    if (typeof workspacePath !== 'string') continue;
    const key = workspacePathKey(workspacePath);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(workspacePath);
    if (result.length >= 10) break;
  }
  return result;
}

export function isDemoWorkspacePath(workspacePath: unknown): boolean {
  return workspacePathKey(workspacePath) === workspacePathKey('/workspace');
}

export function sanitizePersistedWorkspaceState(workspace: unknown): PersistedWorkspaceState | undefined {
  if (!workspace || typeof workspace !== 'object') return undefined;
  const raw = workspace as Partial<WorkspaceState>;
  const currentPath = typeof raw.currentPath === 'string' && !isDemoWorkspacePath(raw.currentPath)
    ? raw.currentPath
    : null;
  return {
    currentPath,
    name: currentPath && typeof raw.name === 'string' ? raw.name : '',
    recentPaths: dedupeRecentPaths(Array.isArray(raw.recentPaths)
      ? raw.recentPaths.filter(workspacePath => !isDemoWorkspacePath(workspacePath))
      : []),
  };
}

export function buildWorkspaceMoveTargets(currentPath: string | null | undefined, recentPaths: readonly unknown[]): string[] {
  return dedupeRecentPaths([
    ...(currentPath ? [currentPath] : []),
    ...recentPaths,
  ]);
}

export const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    openWorkspace(state, action: PayloadAction<{ path: string; name: string }>) {
      state.currentPath = action.payload.path;
      state.name = action.payload.name;
      const incomingKey = workspacePathKey(action.payload.path);
      state.recentPaths = [
        action.payload.path,
        ...state.recentPaths.filter(workspacePath => workspacePathKey(workspacePath) !== incomingKey),
      ].slice(0, 10);
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
      state.recentPaths = dedupeRecentPaths(action.payload);
    },
  },
});

export const {
  openWorkspace, closeWorkspace, clearWorkspace, setIndexingProgress,
  setSynopsisReady, setRecentPaths,
} = workspaceSlice.actions;
