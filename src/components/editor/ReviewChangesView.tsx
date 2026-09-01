import { Check, RotateCcw } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { FileDiffBlock, FileDiffHunk, FileDiffSummary, FileSnapshot } from '@/store/slices/conversation';
import { fileSystem } from '@/services/fileSystem';
import { groupFileDiffs } from '@/services/diffReviewGrouping';

interface ReviewChangesViewProps {
  diffs: FileDiffSummary[];
  snapshots: Record<string, FileSnapshot>;
  onAccept: (diffId: string) => void | Promise<void>;
  onReject: (diffId: string) => void | Promise<void>;
  onAcceptGroup?: (diffs: FileDiffSummary[]) => void | Promise<void>;
  onRejectGroup?: (diffs: FileDiffSummary[]) => void | Promise<void>;
  onAcceptHunk?: (diffId: string, hunkId: string) => void | Promise<void>;
  onRejectHunk?: (diffId: string, hunkId: string) => void | Promise<void>;
  onAcceptBlock?: (diffId: string, hunkId: string, blockId: string) => void | Promise<void>;
  onRejectBlock?: (diffId: string, hunkId: string, blockId: string) => void | Promise<void>;
}

// ★ 中文化：文件变更类型标签
function changeLabel(type: FileDiffSummary['changeType']) {
  if (type === 'created') return '新建';
  if (type === 'deleted') return '已删除';
  return '已编辑';
}

// ★ 中文化：审阅状态标签（文件 / hunk / block 通用）
function statusLabel(status: string) {
  if (status === 'accepted') return '已接受';
  if (status === 'rejected') return '已拒绝';
  if (status === 'mixed') return '部分处理';
  return '待处理';
}

// ★ #1：把 unified diff 的 @@ -a,b +c,d @@ / 段 -a,b +c,d 翻成人话（主人反馈 @@ 太黑话、看不懂）。
//   只用新文件行号区间表达「改哪几行」，纯增/纯删/改动分别给措辞；不再暴露 @@ 原始语法。
function formatRangeHeader(oldStart: number, oldLines: number, newStart: number, newLines: number): string {
  if (oldLines === 0 && newLines > 0) {
    return newLines === 1 ? `新增第 ${newStart} 行` : `新增第 ${newStart}–${newStart + newLines - 1} 行`;
  }
  if (newLines === 0 && oldLines > 0) {
    return oldLines === 1 ? `删除原第 ${oldStart} 行` : `删除原第 ${oldStart}–${oldStart + oldLines - 1} 行`;
  }
  const end = newStart + Math.max(newLines, 1) - 1;
  return newStart === end ? `第 ${newStart} 行改动` : `第 ${newStart}–${end} 行改动`;
}

function buildInlineBlocks(hunk: FileDiffHunk, hunkId: string): FileDiffBlock[] {
  const blocks: FileDiffBlock[] = [];
  let startIndex: number | null = null;
  const flush = (endIndex: number) => {
    if (startIndex === null) return;
    const lines = hunk.lines.slice(startIndex, endIndex + 1);
    const oldNumbers = lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const newNumbers = lines.map(line => line.newLine).filter((line): line is number => line !== undefined);
    blocks.push({
      id: `${hunkId}:block:${blocks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`,
      status: hunk.status === 'accepted' || hunk.status === 'rejected' ? hunk.status : 'pending',
      oldStart: oldNumbers[0] ?? 0,
      newStart: newNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newLines: newNumbers.length,
      lineStart: startIndex,
      lineEnd: endIndex,
      lines,
    });
    startIndex = null;
  };

  hunk.lines.forEach((line, index) => {
    if (line.type === 'context') {
      flush(index - 1);
      return;
    }
    if (startIndex === null) startIndex = index;
  });
  flush(hunk.lines.length - 1);
  return blocks;
}

export function ReviewChangesView({
  diffs,
  snapshots,
  onAccept,
  onReject,
  onAcceptGroup,
  onRejectGroup,
  onAcceptHunk,
  onRejectHunk,
  onAcceptBlock,
  onRejectBlock,
}: ReviewChangesViewProps) {
  const groups = useMemo(() => groupFileDiffs(diffs, snapshots), [diffs, snapshots]);
  const activeGroups = groups.filter(group => group.activeDiffs.length > 0);
  const activeBatchCount = activeGroups.reduce((total, group) => total + group.activeDiffs.length, 0);
  const [collapsedHunks, setCollapsedHunks] = useState<Record<string, boolean>>({});

  const runGroup = async (group: (typeof groups)[number], action: 'accept' | 'reject') => {
    if (action === 'accept' && onAcceptGroup) {
      await onAcceptGroup(group.activeDiffs);
      return;
    }
    if (action === 'reject' && onRejectGroup) {
      await onRejectGroup(group.activeDiffs);
      return;
    }
    const entries = action === 'reject' ? [...group.activeDiffs].reverse() : group.activeDiffs;
    for (const diff of entries) {
      if (action === 'accept') await onAccept(diff.id);
      else await onReject(diff.id);
    }
  };

  const runBatch = (action: 'accept' | 'reject') => {
    void (async () => {
      const orderedGroups = action === 'reject' ? [...activeGroups].reverse() : activeGroups;
      for (const group of orderedGroups) {
        await runGroup(group, action);
      }
    })();
  };

  return (
    <div className="review-changes-view">
      <div className="review-header">
        <div>
          <h2>审查更改</h2>
          <p>
            共 {groups.length} 个文件有改动
            {activeGroups.length > 0 ? `，${activeGroups.length} 个待处理` : ''}
            {activeBatchCount > activeGroups.length ? `（${activeBatchCount} 批）` : ''}
          </p>
        </div>
        <div className="review-header-actions">
          <button disabled={activeGroups.length === 0} onClick={() => runBatch('reject')}>
            全部拒绝
          </button>
          <button disabled={activeGroups.length === 0} className="primary" onClick={() => runBatch('accept')}>
            全部接受
          </button>
        </div>
      </div>

      <div className="review-file-list">
        {groups.length === 0 ? (
          <div className="review-empty">暂无可审阅的文件变更</div>
        ) : groups.map((group) => {
          const diff = group.latest;
          const snapshot = diff.snapshotId ? snapshots[diff.snapshotId] : undefined;
          const reviewError = group.activeDiffs.map(entry => entry.reviewError).find(Boolean);
          return (
            <div key={group.key} className={`review-file-card status-${group.status}`}>
              <div className="review-file-title">
                <span className="review-file-icon">{fileSystem.getFileIcon(diff.path.split('.').pop())}</span>
                <div>
                  <strong>{diff.path.split(/[\\/]/).pop()}</strong>
                  <span>{diff.path}</span>
                </div>
                <span className={`review-change-kind kind-${diff.changeType}`}>{changeLabel(diff.changeType)}</span>
                <span className="review-lines-badge">
                  <span className="review-lines added">+{group.additions}</span>
                  <span className="review-lines removed">-{group.deletions}</span>
                </span>
              </div>
              <div className="review-file-actions">
                {group.diffs.length > 1 && <span className="review-batch-count">{group.diffs.length} 批修改</span>}
                <span className={`review-status status-${group.status}`}>{statusLabel(group.status)}</span>
                {group.activeDiffs.length > 0 && (
                  <>
                    <button onClick={() => void runGroup(group, 'reject')}>
                      <RotateCcw size={14} />
                      拒绝
                    </button>
                    <button className="primary" onClick={() => void runGroup(group, 'accept')}>
                      <Check size={14} />
                      接受
                    </button>
                  </>
                )}
              </div>
              {group.diffs.length > 1 && (
                <details className="review-batch-history">
                  <summary>查看 {group.diffs.length} 批修改记录</summary>
                  {group.diffs.map((batch, index) => (
                    <div key={batch.id} className="review-batch-row">
                      <span>第 {index + 1} 批</span>
                      <span>+{batch.additions} / -{batch.deletions}</span>
                      <span>{statusLabel(batch.status)}</span>
                    </div>
                  ))}
                </details>
              )}
              {reviewError && <div className="review-conflict-note">{reviewError}</div>}
              {group.activeDiffs.length > 1 && (
                <div className="review-group-partial-note">
                  当前文件还有 {group.activeDiffs.length} 批待审改动，请先按文件结算最终状态；分块审阅仅在只剩一批时开放。
                </div>
              )}
              {snapshot && (
                <div className="review-snapshot-note">
                  快照已就绪：{snapshot.id}
                </div>
              )}
              {group.activeDiffs.length === 1 && diff.hunks && diff.hunks.length > 0 && (
                <div className="review-diff-preview">
                  {diff.hunks.map((hunk, hunkIndex) => {
                    const hunkId = hunk.id ?? `${diff.id}:hunk:${hunkIndex}`;
                    const hunkStatus = hunk.status ?? 'pending';
                    const collapsed = !!collapsedHunks[hunkId];
                    const blocks = (hunk.blocks && hunk.blocks.length > 0 ? hunk.blocks : buildInlineBlocks(hunk, hunkId)).map((block, blockIndex) => ({
                      ...block,
                      id: block.id ?? `${hunkId}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
                      status: block.status ?? 'pending',
                    }));
                    const blockByLineStart = new Map(blocks.map(block => [block.lineStart, block]));
                    return (
                    <div className="review-diff-hunk" key={`${diff.id}-${hunkIndex}`}>
                      <div className="review-diff-header">
                        <span>{formatRangeHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines)}</span>
                        <div className="review-hunk-actions">
                          <span className={`review-hunk-status status-${hunkStatus}`}>{statusLabel(hunkStatus)}</span>
                          <button onClick={() => setCollapsedHunks(current => ({ ...current, [hunkId]: !collapsed }))}>
                            {collapsed ? '展开此块' : '折叠此块'}
                          </button>
                          {hunkStatus === 'pending' && (
                            <>
                              <button onClick={() => onRejectHunk?.(diff.id, hunkId)}>
                                <RotateCcw size={13} />
                                拒绝此块
                              </button>
                              <button className="primary" onClick={() => onAcceptHunk?.(diff.id, hunkId)}>
                                <Check size={13} />
                                接受此块
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {!collapsed && hunk.lines.map((line, lineIndex) => {
                        const block = blockByLineStart.get(lineIndex);
                        const blockStatus = block?.status ?? 'pending';
                        return (
                          <Fragment key={lineIndex}>
                            {block && (
                              <div className="review-inline-block-bar">
                                <span>
                                  {formatRangeHeader(block.oldStart || 0, block.oldLines, block.newStart || 0, block.newLines)}
                                </span>
                                <div className="review-hunk-actions">
                                  <span className={`review-hunk-status status-${blockStatus}`}>{statusLabel(blockStatus)}</span>
                                  {blockStatus === 'pending' && (
                                    <>
                                      <button onClick={() => onRejectBlock?.(diff.id, hunkId, block.id!)}>
                                        <RotateCcw size={13} />
                                        拒绝此段
                                      </button>
                                      <button className="primary" onClick={() => onAcceptBlock?.(diff.id, hunkId, block.id!)}>
                                        <Check size={13} />
                                        接受此段
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            )}
                            {/* ★ IDE 风格行号：旧行号 + 新行号双列，删除行无新号、新增行无旧号 */}
                            <div className={`review-diff-line ${line.type}`}>
                              <span className="review-line-no review-line-no-old">{line.oldLine ?? ''}</span>
                              <span className="review-line-no review-line-no-new">{line.newLine ?? ''}</span>
                              <span className="review-diff-sign">{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}</span>
                              <code>{line.content || ' '}</code>
                            </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  )})}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
