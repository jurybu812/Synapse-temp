import { Check, RotateCcw } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { FileDiffBlock, FileDiffHunk, FileDiffSummary } from '@/store/slices/conversation';
import { fileSystem } from '@/services/fileSystem';

/**
 * ★ 反馈#2：单文件行内红绿 diff 视图。
 *   点 review 框里【某个还没 accept 的文件】→ 在中部编辑器打开此视图，显示该文件的行内红绿 diff
 *   （删除行红底 / 新增行绿底，IDE diff 风格双列行号）+ 文件级 / hunk 级 / inline 段级 accept / reject。
 *   只要文件还有 pending diff 就一直这样显示；全部处理完后由 EditorArea 自动降级回普通文件查看器。
 *
 *   渲染与 accept/reject 回调完全复用 ReviewChangesView 的那套（同一份 buildInlineBlocks / 同一套
 *   onAccept… 链路，落到 fileRollback.applyDiffReview/applyHunkReview/applyBlockReview），只是聚焦单文件、
 *   去掉「全部接受/全部拒绝」汇总头，换成单文件标题 + 文件级 accept/reject。
 */
interface SingleDiffViewProps {
  diff: FileDiffSummary;
  snapshot?: { id: string; path: string; content?: string };
  onAccept: (diffId: string) => void | Promise<void>;
  onReject: (diffId: string) => void | Promise<void>;
  onAcceptHunk?: (diffId: string, hunkId: string) => void | Promise<void>;
  onRejectHunk?: (diffId: string, hunkId: string) => void | Promise<void>;
  onAcceptBlock?: (diffId: string, hunkId: string, blockId: string) => void | Promise<void>;
  onRejectBlock?: (diffId: string, hunkId: string, blockId: string) => void | Promise<void>;
  partialReviewBlocked?: boolean;
}

// ★ 与 ReviewChangesView 同源：文件变更类型 / 审阅状态中文标签。
function changeLabel(type: FileDiffSummary['changeType']) {
  if (type === 'created') return '新建';
  if (type === 'deleted') return '已删除';
  return '已编辑';
}

function statusLabel(status: string) {
  if (status === 'accepted') return '已接受';
  if (status === 'rejected') return '已拒绝';
  if (status === 'mixed') return '部分处理';
  return '待处理';
}

// ★ 与 ReviewChangesView / fileRollback 同一算法：把一个 hunk 的连续增删行切成 inline block（段级审阅单元）。
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

export function SingleDiffView({
  diff,
  snapshot,
  onAccept,
  onReject,
  onAcceptHunk,
  onRejectHunk,
  onAcceptBlock,
  onRejectBlock,
  partialReviewBlocked = false,
}: SingleDiffViewProps) {
  const [collapsedHunks, setCollapsedHunks] = useState<Record<string, boolean>>({});
  const fileName = diff.path.split(/[\\/]/).pop() || diff.path;

  return (
    <div className="single-diff-view">
      <div className="single-diff-header">
        <div className="single-diff-title">
          <span className="review-file-icon">{fileSystem.getFileIcon(diff.path.split('.').pop())}</span>
          <div className="single-diff-title-text">
            <strong>{fileName}</strong>
            <span>{diff.path}</span>
          </div>
          <span className={`review-change-kind kind-${diff.changeType}`}>{changeLabel(diff.changeType)}</span>
          <span className="review-lines-badge">
            <span className="review-lines added">+{diff.additions}</span>
            <span className="review-lines removed">-{diff.deletions}</span>
          </span>
        </div>
        <div className="single-diff-actions">
          <span className={`review-status status-${diff.status}`}>{statusLabel(diff.status)}</span>
          {diff.status === 'pending' && !partialReviewBlocked && (
            <>
              <button onClick={() => onReject(diff.id)}>
                <RotateCcw size={14} />
                拒绝全文件
              </button>
              <button className="primary" onClick={() => onAccept(diff.id)}>
                <Check size={14} />
                接受全文件
              </button>
            </>
          )}
        </div>
      </div>

      <div className="single-diff-body">
        {partialReviewBlocked && (
          <div className="review-group-partial-note">
            该文件还有后续待审批次，请回到「审查更改」按文件结算最终状态；为避免把后续 Agent 改动误判成用户冲突，旧批次不开放单独接受或分块操作。
          </div>
        )}
        {snapshot && (
          <div className="review-snapshot-note">快照已就绪：{snapshot.id}</div>
        )}
        {(!diff.hunks || diff.hunks.length === 0) ? (
          <div className="review-empty">该文件无逐行 diff 数据（仅记录了文件级改动），可整文件接受 / 拒绝。</div>
        ) : (
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
                    <span>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
                    <div className="review-hunk-actions">
                      <span className={`review-hunk-status status-${hunkStatus}`}>{statusLabel(hunkStatus)}</span>
                      <button onClick={() => setCollapsedHunks(current => ({ ...current, [hunkId]: !collapsed }))}>
                        {collapsed ? '展开此块' : '折叠此块'}
                      </button>
                      {hunkStatus === 'pending' && !partialReviewBlocked && (
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
                              段 -{block.oldStart || 0},{block.oldLines} +{block.newStart || 0},{block.newLines}
                            </span>
                            <div className="review-hunk-actions">
                              <span className={`review-hunk-status status-${blockStatus}`}>{statusLabel(blockStatus)}</span>
                              {blockStatus === 'pending' && !partialReviewBlocked && (
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
