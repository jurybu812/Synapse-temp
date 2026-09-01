import type { FileDiffHunk, FileDiffSummary, FileSnapshot } from '@/store/slices/conversation';
import { applyReviewTransition, validateReviewAcceptance } from './diffReviewCore';
import { buildDiffHunks, hashContent } from './fileChangeTracker';
import { FileWriteConflictError, fileSystem, resolveCanonicalWorkspacePath } from './fileSystem';

type ReviewStatus = 'pending' | 'accepted' | 'rejected';
type HunkStatus = ReviewStatus | 'mixed';

export interface ReviewEditorState {
  content: string;
  savedContent: string;
}

export interface ReviewApplyResult {
  editorContent?: string;
  editorSavedContent?: string;
  removeEditor?: boolean;
  merged: boolean;
}

interface FileContentState {
  exists: boolean;
  content: string;
}

type ExpectedFileContent = string | null;

function buildInlineBlocks(hunk: FileDiffHunk, hunkId: string): NonNullable<FileDiffHunk['blocks']> {
  const blocks: NonNullable<FileDiffHunk['blocks']> = [];
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

function summarizeBlockStatus(hunk: FileDiffHunk): HunkStatus {
  const blocks = hunk.blocks ?? [];
  if (blocks.length === 0) return hunk.status ?? 'pending';
  if (blocks.every(block => block.status === 'accepted')) return 'accepted';
  if (blocks.every(block => block.status === 'rejected')) return 'rejected';
  if (blocks.some(block => !block.status || block.status === 'pending')) return 'pending';
  return 'mixed';
}

export function normalizeHunks(diff: FileDiffSummary): Array<FileDiffHunk & { id: string; status: HunkStatus }> {
  return (diff.hunks ?? []).map((hunk, index) => ({
    ...hunk,
    id: hunk.id ?? `${diff.id}:hunk:${index}`,
    status: hunk.status ?? 'pending',
    blocks: (hunk.blocks && hunk.blocks.length > 0 ? hunk.blocks : buildInlineBlocks(hunk, hunk.id ?? `${diff.id}:hunk:${index}`)).map((block, blockIndex) => ({
      ...block,
      id: block.id ?? `${hunk.id ?? `${diff.id}:hunk:${index}`}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
      status: block.status ?? (hunk.status === 'accepted' || hunk.status === 'rejected' ? hunk.status : 'pending'),
    })),
  }));
}

function splitLines(content = ''): string[] {
  return content.length > 0 ? content.split(/\r?\n/) : [];
}

export function materializeReviewedContent(beforeContent: string, hunks: Array<FileDiffHunk & { status: HunkStatus }>): string {
  const beforeLines = splitLines(beforeContent);
  const output: string[] = [];
  let beforeCursor = 1;

  const sorted = [...hunks].sort((a, b) => (a.oldStart || a.newStart) - (b.oldStart || b.newStart));
  for (const hunk of sorted) {
    const firstOldLine = hunk.lines.find(line => line.oldLine !== undefined)?.oldLine;
    const hunkOldStart = firstOldLine ?? hunk.oldStart;
    const copyUntil = Math.max((hunkOldStart || beforeCursor) - 1, beforeCursor - 1);
    while (beforeCursor <= copyUntil && beforeCursor <= beforeLines.length) {
      output.push(beforeLines[beforeCursor - 1]);
      beforeCursor += 1;
    }

    for (const [lineIndex, line] of hunk.lines.entries()) {
      const block = hunk.blocks?.find(item => lineIndex >= item.lineStart && lineIndex <= item.lineEnd);
      const reviewStatus = block?.status ?? (hunk.status === 'mixed' ? 'pending' : hunk.status);
      if (line.type === 'context') {
        output.push(line.content);
      } else if (reviewStatus === 'rejected' && line.type === 'delete') {
        output.push(line.content);
      } else if (reviewStatus !== 'rejected' && line.type === 'add') {
        output.push(line.content);
      }
    }

    const oldNumbers = hunk.lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const maxOldLine = oldNumbers.length > 0 ? Math.max(...oldNumbers) : beforeCursor - 1;
    beforeCursor = Math.max(beforeCursor, maxOldLine + 1);
  }

  while (beforeCursor <= beforeLines.length) {
    output.push(beforeLines[beforeCursor - 1]);
    beforeCursor += 1;
  }

  return output.join('\n');
}

function isMissingFileError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'ENOENT' || /(?:^|[\s:])ENOENT(?:[\s:]|$)|文件不存在/.test(message);
}

async function readReviewFile(diff: FileDiffSummary): Promise<FileContentState> {
  try {
    const content = await fileSystem.readFile(diff.path, diff.contextId, diff.conversationId);
    if (diff.changeType === 'created' && !fileSystem.hasNode(diff.path) && content.startsWith('// 文件内容预览:')) {
      return { exists: false, content: '' };
    }
    return { exists: true, content };
  } catch (error) {
    if (isMissingFileError(error)) return { exists: false, content: '' };
    throw error;
  }
}

function expectedContentOption(expectedContent: ExpectedFileContent): { expectedContent?: string } {
  return { expectedContent } as unknown as { expectedContent?: string };
}

function sameExpectedFileContent(current: FileContentState, expectedContent: ExpectedFileContent): boolean {
  return expectedContent === null
    ? !current.exists
    : current.exists && current.content === expectedContent;
}

function fileMutationConflict(diff: FileDiffSummary, actionLabel: string, current: FileContentState): FileWriteConflictError {
  return new FileWriteConflictError(
    `文件在${actionLabel}前又被修改，已停止操作: ${diff.path}`,
    current.exists ? current.content : null,
  );
}

async function assertReviewFileExpected(
  diff: FileDiffSummary,
  expectedContent: ExpectedFileContent,
  actionLabel: string,
): Promise<void> {
  const current = await readReviewFile(diff);
  if (!sameExpectedFileContent(current, expectedContent)) {
    throw fileMutationConflict(diff, actionLabel, current);
  }
}

async function writeReviewFile(
  diff: FileDiffSummary,
  content: string,
  expectedContent: ExpectedFileContent,
): Promise<void> {
  await assertReviewFileExpected(diff, expectedContent, '写入');
  await fileSystem.writeFile(
    diff.path,
    content,
    diff.contextId,
    diff.conversationId,
    undefined,
    expectedContentOption(expectedContent),
  );
}

async function deleteReviewFile(diff: FileDiffSummary, expectedContent: string): Promise<void> {
  await assertReviewFileExpected(diff, expectedContent, '删除');
  await fileSystem.writeFile(
    diff.path,
    expectedContent,
    diff.contextId,
    diff.conversationId,
    undefined,
    expectedContentOption(expectedContent),
  );
  await fileSystem.deleteFile(diff.path, diff.contextId, diff.conversationId);
}

async function applyReviewMutation(
  diff: FileDiffSummary,
  snapshot: FileSnapshot | undefined,
  status: ReviewStatus,
  mutateHunks: (hunks: ReturnType<typeof normalizeHunks>) => ReturnType<typeof normalizeHunks>,
  editorState?: ReviewEditorState,
): Promise<ReviewApplyResult> {
  const disk = await readReviewFile(diff);

  if (diff.changeType === 'deleted') {
    if (status === 'accepted') {
      if (disk.exists || (editorState && editorState.content !== editorState.savedContent)) {
        throw new Error(`文件已在 AI 删除后重新出现，已停止接受删除: ${diff.path}`);
      }
      return { removeEditor: Boolean(editorState), merged: false };
    }
    if (!snapshot) throw new Error(`缺少回退快照: ${diff.path}`);
    const restoredContent = disk.exists ? disk.content : (snapshot.content ?? '');
    if (!disk.exists) {
      await writeReviewFile(diff, restoredContent, null);
    }
    return {
      editorContent: editorState?.content,
      editorSavedContent: restoredContent,
      merged: disk.exists,
    };
  }

  if (diff.changeType !== 'created' && !snapshot) {
    throw new Error(`缺少回退快照: ${diff.path}`);
  }

  const beforeContent = diff.changeType === 'created' ? '' : (snapshot?.content ?? '');
  const currentHunks = normalizeHunks(diff);

  if (currentHunks.length === 0) {
    if (status === 'accepted') {
      if (!disk.exists) throw new Error(`文件已在审阅前被删除，已停止接受: ${diff.path}`);
      if (!diff.afterHash || hashContent(disk.content) !== diff.afterHash) {
        throw new Error(`缺少可验证的逐行差异，当前文件又已变化，已停止接受: ${diff.path}`);
      }
      if (!editorState) return { merged: false };
      if (editorState.savedContent === disk.content) {
        return {
          editorContent: editorState.content,
          editorSavedContent: disk.content,
          merged: editorState.content !== disk.content,
        };
      }
      const editorTransition = applyReviewTransition(editorState.savedContent, disk.content, editorState.content);
      return {
        editorContent: editorTransition.content,
        editorSavedContent: disk.content,
        merged: editorTransition.merged,
      };
    }
    if (diff.changeType === 'created' && diff.afterHash === hashContent('')) {
      if (disk.exists && hashContent(disk.content) !== diff.afterHash) {
        throw new Error(`新建空文件已在审阅前变化，已停止回退: ${diff.path}`);
      }
      if (editorState && editorState.content !== editorState.savedContent) {
        throw new Error(`新建空文件已被删除且编辑器仍有未保存内容，已停止回退: ${diff.path}`);
      }
      if (disk.exists) await deleteReviewFile(diff, disk.content);
      return {
        removeEditor: Boolean(editorState),
        merged: false,
      };
    }
    if (!diff.afterHash || !disk.exists || hashContent(disk.content) !== diff.afterHash) {
      throw new Error(`缺少可验证的逐行差异，当前文件又已变化，已停止回退: ${diff.path}`);
    }
    const editorTransition = editorState
      ? applyReviewTransition(disk.content, beforeContent, editorState.content)
      : undefined;
    await writeReviewFile(diff, beforeContent, disk.content);
    return {
      editorContent: editorTransition?.content,
      editorSavedContent: beforeContent,
      merged: Boolean(editorTransition?.merged),
    };
  }

  const expectedContent = materializeReviewedContent(beforeContent, currentHunks);

  if (status === 'accepted') {
    if (!disk.exists) throw new Error(`文件已在审阅前被删除，已停止接受: ${diff.path}`);
    validateReviewAcceptance(expectedContent, beforeContent, disk.content);
    if (!editorState) {
      return { merged: disk.content !== expectedContent };
    }
    if (editorState.savedContent === beforeContent && beforeContent !== expectedContent) {
      const editorTransition = applyReviewTransition(beforeContent, disk.content, editorState.content);
      return {
        editorContent: editorTransition.content,
        editorSavedContent: disk.content,
        merged: true,
      };
    }
    validateReviewAcceptance(expectedContent, beforeContent, editorState.content);
    if (editorState.savedContent === disk.content || editorState.savedContent === expectedContent) {
      return {
        editorContent: editorState.content,
        editorSavedContent: disk.content,
        merged: disk.content !== expectedContent || editorState.content !== disk.content,
      };
    }
    throw new Error(`编辑器内容基线无法与待审改动对应，已停止接受: ${diff.path}`);
  }

  const nextHunks = mutateHunks(currentHunks);
  const desiredContent = materializeReviewedContent(beforeContent, nextHunks);
  if (!disk.exists && diff.changeType !== 'created') {
    throw new Error(`文件已在审阅前被删除，已停止回退: ${diff.path}`);
  }

  const diskTransition = applyReviewTransition(expectedContent, desiredContent, disk.content);
  let editorTransition: ReturnType<typeof applyReviewTransition> | undefined;
  if (editorState) {
    if (editorState.savedContent === disk.content) {
      editorTransition = applyReviewTransition(disk.content, diskTransition.content, editorState.content);
    } else if (editorState.savedContent === desiredContent || editorState.savedContent === diskTransition.content) {
      editorTransition = { content: editorState.content, merged: true };
    } else {
      editorTransition = applyReviewTransition(expectedContent, desiredContent, editorState.content);
    }
  }

  if (diff.changeType === 'created' && desiredContent.length === 0 && diskTransition.content.length === 0) {
    if (disk.exists) await deleteReviewFile(diff, disk.content);
  } else {
    await writeReviewFile(diff, diskTransition.content, disk.content);
  }

  return {
    editorContent: editorTransition?.content,
    editorSavedContent: diskTransition.content,
    merged: diskTransition.merged || Boolean(editorTransition?.merged),
  };
}

interface PreparedFileDiffRollback {
  diff: FileDiffSummary;
  targetPath: string;
  originalExists: boolean;
  originalContent: string;
  action: 'noop' | 'delete' | 'write';
  targetContent?: string;
  appliedExists: boolean;
  appliedContent: string;
}

export interface FileRollbackTransaction {
  compensate: () => Promise<void>;
}

interface RollbackFileState extends FileContentState {}

async function readRollbackFileState(
  diff: FileDiffSummary,
  targetPath: string,
  treatCreatedPreviewAsMissing = false,
): Promise<RollbackFileState> {
  try {
    const content = await fileSystem.readFile(targetPath);
    if (
      treatCreatedPreviewAsMissing &&
      diff.changeType === 'created' &&
      !fileSystem.hasNode(targetPath) &&
      content.startsWith('// 文件内容预览:')
    ) {
      return { exists: false, content: '' };
    }
    return { exists: true, content };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false, content: '' };
    }
    throw error;
  }
}

function sameRollbackState(left: RollbackFileState, right: RollbackFileState): boolean {
  return left.exists === right.exists && (!left.exists || left.content === right.content);
}

function prepareFileDiffRollback(
  diff: FileDiffSummary,
  targetPath: string,
  snapshot: FileSnapshot | undefined,
  current: RollbackFileState,
): PreparedFileDiffRollback {
  if (diff.changeType === 'deleted') {
    if (current.exists) {
      throw new Error(`文件已在 AI 删除后重新出现，已停止回退: ${diff.path}`);
    }
    if (!snapshot) {
      throw new Error(`缺少回退快照: ${diff.path}`);
    }
    return {
      diff,
      targetPath,
      originalExists: false,
      originalContent: '',
      action: 'write',
      targetContent: snapshot.content ?? '',
      appliedExists: true,
      appliedContent: snapshot.content ?? '',
    };
  }
  if (!current.exists) {
    if (diff.changeType === 'created') {
      return {
        diff,
        targetPath,
        originalExists: false,
        originalContent: '',
        action: 'noop',
        appliedExists: false,
        appliedContent: '',
      };
    }
    throw new Error(`文件已在 AI 修改后被删除，已停止回退: ${diff.path}`);
  }

  if (diff.afterHash && hashContent(current.content) !== diff.afterHash) {
    throw new Error(`文件已在 AI 修改后继续变化，已停止回退: ${diff.path}`);
  }

  if (diff.changeType === 'created') {
    return {
      diff,
      targetPath,
      originalExists: true,
      originalContent: current.content,
      action: 'delete',
      appliedExists: false,
      appliedContent: '',
    };
  }

  if (!snapshot) {
    throw new Error(`缺少回退快照: ${diff.path}`);
  }

  return {
    diff,
    targetPath,
    originalExists: true,
    originalContent: current.content,
    action: 'write',
    targetContent: snapshot.content ?? '',
    appliedExists: true,
    appliedContent: snapshot.content ?? '',
  };
}

function appliedRollbackState(prepared: PreparedFileDiffRollback): RollbackFileState {
  return {
    exists: prepared.appliedExists,
    content: prepared.appliedContent,
  };
}

async function assertRollbackState(
  prepared: PreparedFileDiffRollback,
  expected: RollbackFileState,
  actionLabel: string,
): Promise<void> {
  const current = await readRollbackFileState(prepared.diff, prepared.targetPath);
  if (!sameRollbackState(current, expected)) {
    throw new Error(`文件在${actionLabel}前又被修改，已停止操作: ${prepared.diff.path}`);
  }
}

async function executePreparedFileRollback(
  prepared: PreparedFileDiffRollback,
  onMutationStart: () => void,
): Promise<void> {
  if (prepared.action === 'noop') return;
  await assertRollbackState(prepared, {
    exists: prepared.originalExists,
    content: prepared.originalContent,
  }, '回退');
  onMutationStart();
  if (prepared.action === 'delete') {
    await fileSystem.writeFile(
      prepared.targetPath,
      prepared.originalContent,
      undefined,
      undefined,
      undefined,
      expectedContentOption(prepared.originalContent),
    );
    await fileSystem.deleteFile(prepared.targetPath);
    return;
  }
  await fileSystem.writeFile(
    prepared.targetPath,
    prepared.targetContent ?? '',
    undefined,
    undefined,
    undefined,
    expectedContentOption(prepared.originalExists ? prepared.originalContent : null),
  );
}

async function restorePreparedFileRollback(prepared: PreparedFileDiffRollback): Promise<void> {
  if (prepared.action === 'noop') return;
  const current = await readRollbackFileState(prepared.diff, prepared.targetPath);
  const original = {
    exists: prepared.originalExists,
    content: prepared.originalContent,
  };
  if (sameRollbackState(current, original)) return;
  if (!sameRollbackState(current, appliedRollbackState(prepared))) {
    throw new Error(`文件在回退事务后又被修改，已停止补偿: ${prepared.diff.path}`);
  }
  if (!prepared.originalExists) {
    await fileSystem.writeFile(
      prepared.targetPath,
      prepared.appliedContent,
      undefined,
      undefined,
      undefined,
      expectedContentOption(prepared.appliedContent),
    );
    await fileSystem.deleteFile(prepared.targetPath);
    return;
  }
  await fileSystem.writeFile(
    prepared.targetPath,
    prepared.originalContent,
    undefined,
    undefined,
    undefined,
    expectedContentOption(prepared.appliedExists ? prepared.appliedContent : null),
  );
}

export async function rollbackFileDiffsAtomically(
  entries: Array<{ diff: FileDiffSummary; snapshot?: FileSnapshot }>,
): Promise<FileRollbackTransaction> {
  const resolvedEntries = await Promise.all(entries.map(async entry => ({
    ...entry,
    resolvedPath: await resolveCanonicalWorkspacePath(
      entry.diff.path,
      entry.diff.contextId,
      entry.diff.conversationId,
    ),
  })));
  const groupedEntries = new Map<string, typeof resolvedEntries>();
  for (const entry of resolvedEntries) {
    const groupKey = entry.resolvedPath.replace(/\\/g, '/').toLowerCase();
    const group = groupedEntries.get(groupKey) ?? [];
    group.push(entry);
    groupedEntries.set(groupKey, group);
  }
  const preparedGroups = await Promise.all([...groupedEntries.values()].map(async group => {
    let current = await readRollbackFileState(group[0].diff, group[0].resolvedPath, true);
    const preparedGroup: PreparedFileDiffRollback[] = [];
    for (const entry of group) {
      const item = prepareFileDiffRollback(entry.diff, entry.resolvedPath, entry.snapshot, current);
      preparedGroup.push(item);
      current = appliedRollbackState(item);
    }
    return preparedGroup;
  }));
  const prepared = preparedGroups.flat();
  const executed: PreparedFileDiffRollback[] = [];
  let compensationPromise: Promise<void> | null = null;

  const compensate = () => {
    if (!compensationPromise) {
      compensationPromise = (async () => {
        const failures: string[] = [];
        for (const item of [...executed].reverse()) {
          try {
            await restorePreparedFileRollback(item);
          } catch (error) {
            failures.push(`${item.diff.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (failures.length > 0) throw new Error(`文件回退补偿失败：${failures.join('；')}`);
      })();
    }
    return compensationPromise;
  };

  try {
    for (const item of prepared) {
      await executePreparedFileRollback(item, () => executed.push(item));
    }
  } catch (error) {
    try {
      await compensate();
    } catch (compensationError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}；${compensationError instanceof Error ? compensationError.message : String(compensationError)}`);
    }
    throw error;
  }

  return { compensate };
}

export async function rollbackFileDiff(diff: FileDiffSummary, snapshot?: FileSnapshot): Promise<void> {
  await rollbackFileDiffsAtomically([{ diff, snapshot }]);
}

export async function applyHunkReview(
  diff: FileDiffSummary,
  snapshot: FileSnapshot | undefined,
  hunkId: string,
  status: ReviewStatus,
  editorState?: ReviewEditorState,
): Promise<ReviewApplyResult> {
  if (!diff.hunks || diff.hunks.length === 0) {
    throw new Error(`缺少 hunk 数据，无法局部审阅: ${diff.path}`);
  }
  if (diff.changeType === 'deleted') {
    throw new Error(`删除文件暂不支持 hunk 级审阅: ${diff.path}`);
  }
  const currentHunks = normalizeHunks(diff);
  if (!currentHunks.some(hunk => hunk.id === hunkId)) {
    throw new Error(`找不到 hunk: ${hunkId}`);
  }
  return applyReviewMutation(diff, snapshot, status, hunks => hunks.map(hunk => hunk.id === hunkId
    ? {
      ...hunk,
      blocks: hunk.blocks?.map(block => {
        const currentStatus = block.status ?? 'pending';
        return currentStatus === 'pending' ? { ...block, status } : block;
      }),
    }
    : hunk), editorState);
}

export async function applyDiffReview(
  diff: FileDiffSummary,
  snapshot: FileSnapshot | undefined,
  status: ReviewStatus,
  editorState?: ReviewEditorState,
): Promise<ReviewApplyResult> {
  return applyReviewMutation(diff, snapshot, status, currentHunks => currentHunks.map(hunk => {
    const blocks = hunk.blocks?.map(block => {
      const currentStatus = block.status ?? 'pending';
      return currentStatus === 'pending' ? { ...block, status } : block;
    });
    const nextHunk = { ...hunk, blocks };
    const nextStatus = summarizeBlockStatus(nextHunk);
    return nextStatus === 'pending' ? { ...nextHunk, status } : { ...nextHunk, status: nextStatus };
  }), editorState);
}

function contentBeforeDiff(diff: FileDiffSummary, snapshots: Record<string, FileSnapshot>): string {
  if (diff.changeType === 'created') return '';
  const snapshotId = diff.snapshotId;
  const snapshot = snapshotId ? snapshots[snapshotId] : undefined;
  if (!snapshot) throw new Error(`缺少回退快照: ${diff.path}`);
  return snapshot.content ?? '';
}

function contentAfterDiff(diff: FileDiffSummary, snapshots: Record<string, FileSnapshot>): string {
  if (diff.changeType === 'deleted') return '';
  const beforeContent = contentBeforeDiff(diff, snapshots);
  const hunks = normalizeHunks(diff);
  if (hunks.length === 0) {
    if (diff.afterHash && diff.afterHash === hashContent(beforeContent)) return beforeContent;
    throw new Error(`缺少可验证的逐行差异，无法结算多批修改: ${diff.path}`);
  }
  return materializeReviewedContent(beforeContent, hunks);
}

export async function applyDiffGroupReview(
  diffs: FileDiffSummary[],
  snapshots: Record<string, FileSnapshot>,
  status: 'accepted' | 'rejected',
  editorState?: ReviewEditorState,
): Promise<ReviewApplyResult> {
  if (diffs.length === 0) throw new Error('没有可审阅的文件改动');
  if (diffs.length === 1) {
    const diff = diffs[0];
    const snapshot = diff.snapshotId ? snapshots[diff.snapshotId] : undefined;
    return applyDiffReview(diff, snapshot, status, editorState);
  }

  const first = diffs[0];
  const latest = diffs[diffs.length - 1];
  const baselineSnapshotId = first.originalSnapshotId ?? first.snapshotId;
  const baselineSnapshot = baselineSnapshotId ? snapshots[baselineSnapshotId] : undefined;
  if (first.changeType !== 'created' && !baselineSnapshot) {
    throw new Error(`缺少最早回退快照: ${first.path}`);
  }
  const baselineContent = first.changeType === 'created' ? '' : (baselineSnapshot?.content ?? '');
  const proposedContent = contentAfterDiff(latest, snapshots);

  if (first.changeType === 'created' && latest.changeType === 'deleted' && proposedContent.length === 0) {
    const disk = await readReviewFile(latest);
    if (disk.exists || (editorState && editorState.content !== editorState.savedContent)) {
      throw new Error(`同一路径在 Agent 新建并删除后又出现，已停止结算: ${latest.path}`);
    }
    return { removeEditor: Boolean(editorState), merged: false };
  }

  const changeType: FileDiffSummary['changeType'] = first.changeType === 'created'
    ? 'created'
    : latest.changeType === 'deleted'
      ? 'deleted'
      : 'edited';
  const syntheticSnapshot: FileSnapshot = baselineSnapshot ?? {
    id: `${latest.id}:group-baseline`,
    path: latest.path,
    content: baselineContent,
    contentHash: hashContent(baselineContent),
    createdAt: Date.now(),
    reason: 'before_ai_edit',
  };
  const syntheticDiff: FileDiffSummary = {
    ...latest,
    changeType,
    status: 'pending',
    snapshotId: syntheticSnapshot.id,
    originalSnapshotId: syntheticSnapshot.id,
    beforeHash: hashContent(baselineContent),
    originalBeforeHash: hashContent(baselineContent),
    afterHash: hashContent(proposedContent),
    hunks: buildDiffHunks(baselineContent, proposedContent),
    reviewError: undefined,
  };

  return applyReviewMutation(
    syntheticDiff,
    changeType === 'created' ? undefined : syntheticSnapshot,
    status,
    currentHunks => currentHunks.map(hunk => ({
      ...hunk,
      status,
      blocks: hunk.blocks?.map(block => ({ ...block, status })),
    })),
    editorState,
  );
}

export async function applyBlockReview(
  diff: FileDiffSummary,
  snapshot: FileSnapshot | undefined,
  hunkId: string,
  blockId: string,
  status: ReviewStatus,
  editorState?: ReviewEditorState,
): Promise<ReviewApplyResult> {
  if (!diff.hunks || diff.hunks.length === 0) {
    throw new Error(`缺少 hunk 数据，无法局部审阅: ${diff.path}`);
  }
  if (diff.changeType === 'deleted') {
    throw new Error(`删除文件暂不支持 inline 块级审阅: ${diff.path}`);
  }
  const currentHunks = normalizeHunks(diff);
  const targetHunk = currentHunks.find(hunk => hunk.id === hunkId);
  const targetBlock = targetHunk?.blocks?.find(block => block.id === blockId);
  if (!targetHunk) throw new Error(`找不到 hunk: ${hunkId}`);
  if (!targetBlock) throw new Error(`找不到 inline block: ${blockId}`);
  return applyReviewMutation(diff, snapshot, status, hunks => hunks.map(hunk => {
    if (hunk.id !== hunkId) return hunk;
    const blocks = hunk.blocks?.map(block => block.id === blockId ? { ...block, status } : block);
    const nextHunk = { ...hunk, blocks };
    return { ...nextHunk, status: summarizeBlockStatus(nextHunk) };
  }), editorState);
}
