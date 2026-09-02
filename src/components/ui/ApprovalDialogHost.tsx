import { useCallback, useEffect, useState } from 'react';
import { store, type RootState } from '@/store';
import { selectConversationById } from '@/store/slices/conversation';
import { approvalCoordinator, type ApprovalLevel } from '@/services/approvalCoordinator';
import { ApprovalDialog, type ApprovalRequest } from './ApprovalDialog';

function conversationLabel(conversationId: string | undefined): string | undefined {
  if (!conversationId) return undefined;
  const sourceConversation = selectConversationById(store.getState() as RootState, conversationId);
  return `${sourceConversation?.title || '未命名对话'} · ${conversationId.slice(-8)}`;
}

function detailsToText(details: string[]): string {
  return details.join('\n');
}

export function ApprovalDialogHost() {
  const [approvalReq, setApprovalReq] = useState<ApprovalRequest | null>(null);
  const handleApprovalApprove = useCallback(() => {
    if (approvalReq) approvalCoordinator.resolve(approvalReq.id, true);
  }, [approvalReq]);
  const handleApprovalReject = useCallback(() => {
    if (approvalReq) approvalCoordinator.resolve(approvalReq.id, false);
  }, [approvalReq]);
  const handleApprovalStop = useCallback(() => {
    if (!approvalReq) return;
    if (!approvalReq.conversationId) {
      approvalCoordinator.resolve(approvalReq.id, false);
      return;
    }
    void approvalCoordinator.requestStop(approvalReq.conversationId)
      .then(stopped => {
        if (!stopped) approvalCoordinator.resolve(approvalReq.id, false);
      })
      .catch(() => {
        approvalCoordinator.resolve(approvalReq.id, false);
      });
  }, [approvalReq]);

  useEffect(() => approvalCoordinator.subscribe(ticket => {
    setApprovalReq(ticket ? {
      id: ticket.id,
      toolName: ticket.toolName,
      level: ticket.level,
      argsText: ticket.argsText,
      originLabel: ticket.originLabel,
      title: ticket.title,
      confirmLabel: ticket.confirmLabel,
      queuedCount: ticket.queuedCount,
      conversationId: ticket.conversationId,
      conversationLabel: conversationLabel(ticket.conversationId),
      message: ticket.message,
    } : null);
  }), []);

  useEffect(() => {
    const approvalBridge = window.synapse?.approval;
    if (!approvalBridge) return undefined;
    const unsubscribeRequest = approvalBridge.onRequest(payload => {
      void approvalCoordinator.requestTicket({
        id: payload.requestId,
        toolName: payload.toolName,
        level: payload.level as ApprovalLevel,
        argsText: detailsToText(payload.details),
        originLabel: 'Synapse',
        title: payload.title,
        confirmLabel: payload.confirmLabel,
        message: payload.message,
        conversationId: payload.conversationId,
        ownerId: payload.ownerId,
        callId: payload.callId,
      }).then(approved => approvalBridge.respond(payload.requestId, approved));
    });
    const unsubscribeCancel = approvalBridge.onCancel(payload => {
      approvalCoordinator.resolve(payload.requestId, false);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeCancel();
    };
  }, []);

  return (
    <ApprovalDialog
      request={approvalReq}
      onApprove={handleApprovalApprove}
      onReject={handleApprovalReject}
      onStop={approvalReq?.conversationId ? handleApprovalStop : undefined}
    />
  );
}
