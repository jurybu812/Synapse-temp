export interface ExecutionWorkspaceSnapshot {
  runId: string;
  activeWorktreePath: string | null;
  repoRoot: string | null;
  currentPath: string | null;
}

const snapshots = new Map<string, ExecutionWorkspaceSnapshot>();

export function setExecutionWorkspaceSnapshot(
  contextId: string,
  snapshot: ExecutionWorkspaceSnapshot,
): void {
  snapshots.set(contextId, snapshot);
}

export function getExecutionWorkspaceSnapshot(contextId?: string): ExecutionWorkspaceSnapshot | null {
  if (!contextId) return null;
  return snapshots.get(contextId) ?? null;
}

export function clearExecutionWorkspaceSnapshot(contextId: string, runId: string): void {
  const snapshot = snapshots.get(contextId);
  if (snapshot?.runId === runId) snapshots.delete(contextId);
}
