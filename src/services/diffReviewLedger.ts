import { diffReviewIdentityPath, type DiffReviewPathCarrier } from './diffReviewPath';

export interface DiffLedgerIdentity {
  id: string;
  path: string;
  reviewPath?: string;
  status: string;
  contextId?: string;
  conversationId?: string;
}

export function findMergeableMessageDiffIndex(
  diffs: DiffLedgerIdentity[],
  ownerDiffIds: Set<string>,
  incoming: Pick<DiffLedgerIdentity, 'path' | 'reviewPath' | 'contextId' | 'conversationId'>,
): number {
  const incomingPath = diffReviewIdentityPath(incoming as DiffReviewPathCarrier);
  return diffs.findIndex(diff =>
    ownerDiffIds.has(diff.id) &&
    diffReviewIdentityPath(diff as DiffReviewPathCarrier) === incomingPath &&
    (diff.contextId ?? undefined) === (incoming.contextId ?? undefined) &&
    (diff.conversationId ?? undefined) === (incoming.conversationId ?? undefined) &&
    diff.status === 'pending',
  );
}
