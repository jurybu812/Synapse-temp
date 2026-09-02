import type { ToolExecMeta } from './toolRegistry';
import { executionRegistry } from './executionRegistry';
import { redactSensitiveText, redactSensitiveValue } from './sensitiveRedaction';

export type ApprovalLevel = 'auto' | 'read' | 'write' | 'command' | 'dangerous';

export interface ApprovalTicket {
  id: string;
  toolName: string;
  level: ApprovalLevel;
  argsText: string;
  originLabel: string;
  title?: string;
  confirmLabel?: string;
  queuedCount?: number;
  message?: string;
  ownerId?: string;
  conversationId?: string;
  callId?: string;
}

interface PendingApproval extends ApprovalTicket {
  resolve: (approved: boolean) => void;
}

type ApprovalListener = (ticket: ApprovalTicket | null) => void;
type StopHandler = () => void | Promise<void>;

class ApprovalCoordinator {
  private readonly queue: PendingApproval[] = [];
  private readonly listeners = new Set<ApprovalListener>();
  private readonly stopHandlers = new Map<string, StopHandler>();
  private sequence = 0;

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => this.listeners.delete(listener);
  }

  registerStopHandler(conversationId: string, handler: StopHandler): () => void {
    this.stopHandlers.set(conversationId, handler);
    return () => {
      if (this.stopHandlers.get(conversationId) === handler) {
        this.stopHandlers.delete(conversationId);
      }
    };
  }

  async requestStop(conversationId: string): Promise<boolean> {
    const handler = this.stopHandlers.get(conversationId);
    if (handler) {
      await handler();
      return true;
    }
    const cancelledApprovals = this.cancelConversation(conversationId);
    const stoppedExecution = await executionRegistry.stopConversation(conversationId);
    return cancelledApprovals > 0 || stoppedExecution;
  }

  request(
    toolName: string,
    args: Record<string, unknown>,
    level: ApprovalLevel,
    meta?: ToolExecMeta,
    message?: string,
  ): Promise<boolean> {
    const id = `${meta?.callId || `approval_${Date.now()}`}:${++this.sequence}`;
    const originLabel = meta?.isSubagent
      ? `子代理「${meta.subagentRole || '未命名'}」`
      : 'AI';
    return this.enqueue({
      id,
      toolName,
      level,
      argsText: JSON.stringify(redactSensitiveValue(args), null, 2),
      originLabel,
      message,
      ownerId: meta?.ownerId,
      conversationId: meta?.conversationId,
      callId: meta?.callId,
    }, meta);
  }

  requestTicket(ticket: Omit<ApprovalTicket, 'queuedCount'>): Promise<boolean> {
    return this.enqueue({
      ...ticket,
      argsText: redactSensitiveText(ticket.argsText),
      message: ticket.message ? redactSensitiveText(ticket.message) : undefined,
    });
  }

  private enqueue(ticket: Omit<ApprovalTicket, 'queuedCount'>, meta?: ToolExecMeta): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue.push({
        ...ticket,
        resolve,
      });
      if (meta?.ownerId) {
        executionRegistry.registerCancelable(meta.ownerId, `approval:${ticket.id}`, () => {
          this.resolve(ticket.id, false);
        }, meta.runId);
      }
      this.emit();
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const index = this.queue.findIndex(ticket => ticket.id === id);
    if (index < 0) return false;
    const [ticket] = this.queue.splice(index, 1);
    if (ticket.ownerId) executionRegistry.releaseCancelable(ticket.ownerId, `approval:${id}`);
    ticket.resolve(approved);
    this.emit();
    return true;
  }

  cancelConversation(conversationId: string): number {
    if (!conversationId) return 0;
    const cancelled: PendingApproval[] = [];
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const ticket = this.queue[index];
      if (ticket.conversationId !== conversationId) continue;
      this.queue.splice(index, 1);
      if (ticket.ownerId) {
        executionRegistry.releaseCancelable(ticket.ownerId, `approval:${ticket.id}`);
      }
      cancelled.push(ticket);
    }
    if (cancelled.length === 0) return 0;
    for (const ticket of cancelled) ticket.resolve(false);
    this.emit();
    return cancelled.length;
  }

  private current(): ApprovalTicket | null {
    const ticket = this.queue[0];
    if (!ticket) return null;
    const { resolve: _resolve, ...visible } = ticket;
    return { ...visible, queuedCount: Math.max(0, this.queue.length - 1) };
  }

  private emit(): void {
    const ticket = this.current();
    for (const listener of this.listeners) listener(ticket);
  }
}

export const approvalCoordinator = new ApprovalCoordinator();
