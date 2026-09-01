export interface ExecutionContext {
  readonly conversationId: string;
  readonly runId: string;
  readonly ownerId: string;
}

export interface ToolCallExecutionContext extends ExecutionContext {
  readonly callId: string;
}

function createId(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export function createOwnerId(): string {
  return createId('owner');
}

export function createExecutionContext(conversationId: string, ownerId: string): ExecutionContext {
  if (!conversationId) throw new Error('ExecutionContext requires conversationId');
  if (!ownerId) throw new Error('ExecutionContext requires ownerId');
  return Object.freeze({ conversationId, ownerId, runId: createId('run') });
}

export function createToolCallExecutionContext(
  context: ExecutionContext,
  callId = createId('call'),
): ToolCallExecutionContext {
  if (!callId) throw new Error('Tool call requires callId');
  return Object.freeze({ ...context, callId });
}
