import type { ToolExecMeta } from './toolRegistry';
import { executionRegistry } from './executionRegistry';

export interface ApprovalTicket {
  id: string;
  toolName: string;
  level: 'auto' | 'read' | 'write' | 'dangerous';
  argsText: string;
  originLabel: string;
  message?: string;
  ownerId?: string;
  conversationId?: string;
  callId?: string;
}

interface PendingApproval extends ApprovalTicket {
  resolve: (approved: boolean) => void;
}

type ApprovalListener = (ticket: ApprovalTicket | null) => void;

class ApprovalCoordinator {
  private readonly queue: PendingApproval[] = [];
  private readonly listeners = new Set<ApprovalListener>();
  private sequence = 0;

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => this.listeners.delete(listener);
  }

  request(
    toolName: string,
    args: Record<string, unknown>,
    level: ApprovalTicket['level'],
    meta?: ToolExecMeta,
    message?: string,
  ): Promise<boolean> {
    const id = `${meta?.callId || `approval_${Date.now()}`}:${++this.sequence}`;
    const originLabel = meta?.isSubagent
      ? `子代理「${meta.subagentRole || '未命名'}」`
      : 'AI';
    return new Promise<boolean>((resolve) => {
      this.queue.push({
        id,
        toolName,
        level,
        argsText: JSON.stringify(args, null, 2),
        originLabel,
        message,
        ownerId: meta?.ownerId,
        conversationId: meta?.conversationId,
        callId: meta?.callId,
        resolve,
      });
      if (meta?.ownerId) {
        executionRegistry.registerCancelable(meta.ownerId, `approval:${id}`, () => {
          this.resolve(id, false);
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

  private current(): ApprovalTicket | null {
    const ticket = this.queue[0];
    if (!ticket) return null;
    const { resolve: _resolve, ...visible } = ticket;
    return visible;
  }

  private emit(): void {
    const ticket = this.current();
    for (const listener of this.listeners) listener(ticket);
  }
}

export const approvalCoordinator = new ApprovalCoordinator();
