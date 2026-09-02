import { AUTOSAVE_ID, type PerConversation, type ToolCall } from '@/store/slices/conversation';
import { executionRegistry } from './executionRegistry';

type WorkspacePickerHost = {
  __synapseWorkspacePickerPendingCount?: number;
  setTimeout?: typeof window.setTimeout;
};

const PENDING_TOOL_STATUSES = new Set<ToolCall['status']>(['pending', 'running', 'cancelling']);
const PENDING_RUN_STATUSES = new Set(['idle', 'pending', 'streaming']);

function getDefaultHost(): WorkspacePickerHost | null {
  return typeof window === 'undefined' ? null : window;
}

export function getWorkspacePickerPendingCount(host: WorkspacePickerHost | null = getDefaultHost()): number {
  return Math.max(0, host?.__synapseWorkspacePickerPendingCount ?? 0);
}

export function hasWorkspacePickerPending(host: WorkspacePickerHost | null = getDefaultHost()): boolean {
  return getWorkspacePickerPendingCount(host) > 0;
}

export function beginWorkspacePickerPending(host: WorkspacePickerHost | null = getDefaultHost()): () => void {
  if (!host) return () => undefined;
  host.__synapseWorkspacePickerPendingCount = getWorkspacePickerPendingCount(host) + 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    host.__synapseWorkspacePickerPendingCount = Math.max(0, (host.__synapseWorkspacePickerPendingCount ?? 0) - 1);
  };
}

export function tryBeginWorkspacePickerPending(
  host: WorkspacePickerHost | null = getDefaultHost(),
): (() => void) | null {
  if (hasWorkspacePickerPending(host)) return null;
  return beginWorkspacePickerPending(host);
}

export function waitForWorkspacePickerIdle(
  isCurrent: () => boolean,
  options: { host?: WorkspacePickerHost | null; intervalMs?: number } = {},
): Promise<boolean> {
  const host = options.host ?? getDefaultHost();
  const intervalMs = options.intervalMs ?? 100;
  const schedule = host?.setTimeout?.bind(host) ?? setTimeout;
  if (!isCurrent()) return Promise.resolve(false);
  if (!hasWorkspacePickerPending(host)) return Promise.resolve(true);

  return new Promise(resolve => {
    const poll = () => {
      if (!isCurrent()) {
        resolve(false);
        return;
      }
      if (!hasWorkspacePickerPending(host)) {
        resolve(true);
        return;
      }
      schedule(poll, intervalMs);
    };
    schedule(poll, intervalMs);
  });
}

export type WorkspaceToolTaskReferenceSummary = {
  knownTaskCount: number;
  pendingTaskCount: number;
  orphanPendingCallCount: number;
  ownerIds: string[];
};

export type WorkspaceChangeBlockState = WorkspaceToolTaskReferenceSummary & {
  conversationId: string;
  assistantRunPending: boolean;
  executionRegistryRunning: boolean;
  blocked: boolean;
};

export function summarizeWorkspaceToolTaskReferences(
  conversation: Pick<PerConversation, 'messages'> | null | undefined,
): WorkspaceToolTaskReferenceSummary {
  const tasks = new Map<string, { status: ToolCall['status']; ownerId?: string }>();
  const ownerIds = new Set<string>();
  const orphanPendingCallIds = new Set<string>();
  for (const message of conversation?.messages ?? []) {
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.taskOwnerId) ownerIds.add(toolCall.taskOwnerId);
      if (toolCall.taskId) {
        tasks.set(toolCall.taskId, {
          status: toolCall.status,
          ownerId: toolCall.taskOwnerId,
        });
      } else if (PENDING_TOOL_STATUSES.has(toolCall.status)) {
        orphanPendingCallIds.add(toolCall.id);
      }
    }
  }
  return {
    knownTaskCount: tasks.size,
    pendingTaskCount: [...tasks.values()].filter(task => PENDING_TOOL_STATUSES.has(task.status)).length,
    orphanPendingCallCount: orphanPendingCallIds.size,
    ownerIds: [...ownerIds],
  };
}

export function getWorkspaceChangeBlockState(
  conversation: Pick<PerConversation, 'id' | 'isStreaming' | 'assistantRuns' | 'messages'>,
  options: { isConversationRunning?: (conversationId: string) => boolean } = {},
): WorkspaceChangeBlockState {
  const conversationId = conversation.id || AUTOSAVE_ID;
  const toolTaskReferences = summarizeWorkspaceToolTaskReferences(conversation);
  const assistantRunPending = Boolean(
    conversation.isStreaming
    || Object.values(conversation.assistantRuns ?? {}).some(run => PENDING_RUN_STATUSES.has(run.status)),
  );
  const executionRegistryRunning = (options.isConversationRunning ?? executionRegistry.isConversationRunning.bind(executionRegistry))(conversationId);
  const blocked = assistantRunPending
    || executionRegistryRunning
    || toolTaskReferences.pendingTaskCount > 0
    || toolTaskReferences.orphanPendingCallCount > 0;

  return {
    conversationId,
    assistantRunPending,
    executionRegistryRunning,
    blocked,
    ...toolTaskReferences,
  };
}

export function workspaceChangeBlockMessage(blockState: WorkspaceChangeBlockState): string {
  if (blockState.pendingTaskCount > 0 || blockState.orphanPendingCallCount > 0) {
    return '请等待后台工具任务完成恢复对账，再切换工作区，避免旧工具结果跨工作区执行';
  }
  return '请先停止当前任务，再切换工作区，避免后续工具跨工作区执行';
}
