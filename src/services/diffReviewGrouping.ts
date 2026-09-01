import type { FileDiffSummary, FileSnapshot } from '@/store/slices/conversation';
import { countLineChanges } from './fileChangeTracker';
import { materializeReviewedContent, normalizeHunks } from './fileRollback';
import { hasPendingReviewParts } from './diffReviewCore';
import { resolveWorkspacePath } from './fileSystem';
import {
  diffReviewIdentityPath,
  normalizeDiffPath as normalizeReviewPath,
  resolveDiffReviewPath,
  type DiffReviewPathCarrier,
} from './diffReviewPath';

export interface DiffReviewGroup {
  key: string;
  path: string;
  diffs: FileDiffSummary[];
  activeDiffs: FileDiffSummary[];
  latest: FileDiffSummary;
  additions: number;
  deletions: number;
  status: FileDiffSummary['status'];
}

export function normalizeDiffPath(filePath: string): string {
  return normalizeReviewPath(filePath);
}

export async function reviewPathKeys(
  filePath: string,
  contextId?: string,
  conversationId?: string,
  reviewPath?: string,
): Promise<Set<string>> {
  const keys = new Set([normalizeDiffPath(filePath)]);
  if (reviewPath) keys.add(normalizeDiffPath(reviewPath));
  try {
    keys.add(normalizeDiffPath(await resolveWorkspacePath(filePath, contextId, conversationId)));
  } catch {
    // 原始路径仍可用于旧数据和解析失败时的保守匹配。
  }
  try {
    const resolved = await resolveDiffReviewPath(filePath, contextId, conversationId);
    keys.add(normalizeDiffPath(resolved.resolvedPath));
    keys.add(normalizeDiffPath(resolved.reviewPath));
  } catch {
    // 原始路径与 resolveWorkspacePath 兜底已覆盖旧数据。
  }
  return keys;
}

function expectedContent(diff: FileDiffSummary, snapshots: Record<string, FileSnapshot>): string | undefined {
  if (diff.changeType === 'deleted') return '';
  if (!diff.hunks || diff.hunks.length === 0) return undefined;
  const snapshot = diff.snapshotId ? snapshots[diff.snapshotId] : undefined;
  const beforeContent = diff.changeType === 'created' ? '' : (snapshot?.content ?? '');
  return materializeReviewedContent(beforeContent, normalizeHunks(diff));
}

function summarizeGroupStatus(diffs: FileDiffSummary[]): FileDiffSummary['status'] {
  if (diffs.some(diff => diff.status === 'pending' || diff.status === 'mixed')) {
    return diffs.some(diff => diff.status === 'mixed') ? 'mixed' : 'pending';
  }
  if (diffs.every(diff => diff.status === 'accepted')) return 'accepted';
  if (diffs.every(diff => diff.status === 'rejected')) return 'rejected';
  if (diffs.every(diff => diff.status === 'superseded')) return 'superseded';
  return 'mixed';
}

export function groupFileDiffs(
  diffs: FileDiffSummary[],
  snapshots: Record<string, FileSnapshot>,
): DiffReviewGroup[] {
  const grouped = new Map<string, FileDiffSummary[]>();
  for (const diff of diffs) {
    // pendingDiffs 已经属于当前对话桶；contextId / conversationId 是每批改动的执行与审计归属，
    // 不是文件身份。同一路径跨工具轮、子代理或 autosave promotion 后仍应在审查框中只占一行，
    // 否则用户会看到“19 个文件”实际只有 16 个唯一文件，且接受/拒绝顺序依赖批次。
    const key = diffReviewIdentityPath(diff as DiffReviewPathCarrier);
    const entries = grouped.get(key) ?? [];
    entries.push(diff);
    grouped.set(key, entries);
  }

  return Array.from(grouped.entries()).map(([key, entries]) => {
    const activeDiffs = entries.filter(hasPendingReviewParts);
    const relevant = activeDiffs.length > 0 ? activeDiffs : entries;
    const first = relevant[0];
    const latest = relevant[relevant.length - 1];
    const baselineId = first.originalSnapshotId ?? first.snapshotId;
    const baseline = baselineId ? (snapshots[baselineId]?.content ?? '') : '';
    const proposed = expectedContent(latest, snapshots);
    const lineChanges = proposed === undefined
      ? { additions: latest.additions, deletions: latest.deletions }
      : countLineChanges(baseline, proposed);
    return {
      key,
      path: (latest as DiffReviewPathCarrier).reviewPath ?? latest.path,
      diffs: entries,
      activeDiffs,
      latest,
      additions: lineChanges.additions,
      deletions: lineChanges.deletions,
      status: summarizeGroupStatus(entries),
    };
  });
}
