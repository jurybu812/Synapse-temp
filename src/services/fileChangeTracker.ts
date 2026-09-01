import type { FileDiffHunk, FileDiffSummary, FileSnapshot } from '@/store/slices/conversation';

export interface TrackedFileChange {
  snapshot: FileSnapshot;
  diff: FileDiffSummary;
}

/**
 * ★ M3-1a medium#3/#5 根治：文件改动账本按 contextId 分桶，杜绝并行子代理与主 agentLoop 共享单一全局
 *   数组导致的竞态串台（A 写文件后到 A consume 之间，B 也写了 → A 的 consume 把 B 的 pending change 一起 splice 吞掉，
 *   或主代理 consume 抢到子代理 diff 挂进主对话）。各 contextId 独立 buffer，record/consume 各操作自己桶。
 *   - contextId 来源：主 agentLoop = 当前对话 id ?? AUTOSAVE_ID；子代理 = subagentId（见 toolRegistry.execute 注入）。
 *   - 缺省键 DEFAULT_BUCKET：极端兜底（contextId 未透传时），保持旧行为不丢账本。
 *   - 桶在 consume（splice 至空）后若为空即删除，避免长期运行下 Map 无限增长（每个 subagentId 含时间戳唯一）。
 */
const DEFAULT_BUCKET = '__default__';
const pendingChangesByContext = new Map<string, TrackedFileChange[]>();

export function generateChangeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hashContent(content = ''): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function buildLineOps(before = '', after = '') {
  const beforeLines = before.length > 0 ? before.split(/\r?\n/) : [];
  const afterLines = after.length > 0 ? after.split(/\r?\n/) : [];
  const dp = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));

  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      dp[i][j] = beforeLines[i] === afterLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Array<{ type: 'context' | 'add' | 'delete'; content: string; oldLine?: number; newLine?: number }> = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      ops.push({ type: 'context', content: beforeLines[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (j < afterLines.length && (i === beforeLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ type: 'add', content: afterLines[j], newLine: j + 1 });
      j++;
    } else if (i < beforeLines.length) {
      ops.push({ type: 'delete', content: beforeLines[i], oldLine: i + 1 });
      i++;
    }
  }

  return { beforeLines, afterLines, ops, unchanged: dp[0][0] };
}

export function countLineChanges(before = '', after = ''): { additions: number; deletions: number } {
  const { beforeLines, afterLines, unchanged } = buildLineOps(before, after);
  return {
    additions: Math.max(afterLines.length - unchanged, 0),
    deletions: Math.max(beforeLines.length - unchanged, 0),
  };
}

export function buildDiffHunks(before = '', after = '', context = 3): FileDiffHunk[] {
  const { ops } = buildLineOps(before, after);
  const hunks: FileDiffHunk[] = [];
  let index = 0;

  const buildInlineBlocks = (hunkId: string, lines: FileDiffHunk['lines']) => {
    const blocks: NonNullable<FileDiffHunk['blocks']> = [];
    let startIndex: number | null = null;
    const flush = (endIndex: number) => {
      if (startIndex === null) return;
      const blockLines = lines.slice(startIndex, endIndex + 1);
      const oldNumbers = blockLines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
      const newNumbers = blockLines.map(line => line.newLine).filter((line): line is number => line !== undefined);
      blocks.push({
        id: `${hunkId}:block:${blocks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`,
        status: 'pending',
        oldStart: oldNumbers[0] ?? 0,
        newStart: newNumbers[0] ?? 0,
        oldLines: oldNumbers.length,
        newLines: newNumbers.length,
        lineStart: startIndex,
        lineEnd: endIndex,
        lines: blockLines,
      });
      startIndex = null;
    };

    lines.forEach((line, lineIndex) => {
      if (line.type === 'context') {
        flush(lineIndex - 1);
        return;
      }
      if (startIndex === null) startIndex = lineIndex;
    });
    flush(lines.length - 1);
    return blocks;
  };

  while (index < ops.length) {
    const relativeChange = ops.slice(index).findIndex(op => op.type !== 'context');
    if (relativeChange === -1) break;
    const changeIndex = index + relativeChange;
    const start = Math.max(changeIndex - context, 0);
    let end = changeIndex;
    let trailingContext = 0;

    while (end < ops.length) {
      if (ops[end].type === 'context') {
        trailingContext++;
        if (trailingContext > context) break;
      } else {
        trailingContext = 0;
      }
      end++;
    }

    const lines = ops.slice(start, end);
    const oldNumbers = lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const newNumbers = lines.map(line => line.newLine).filter((line): line is number => line !== undefined);
    const hunkId = `hunk_${hunks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`;
    hunks.push({
      id: hunkId,
      status: 'pending',
      oldStart: oldNumbers[0] ?? 0,
      newStart: newNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newLines: newNumbers.length,
      blocks: buildInlineBlocks(hunkId, lines),
      lines,
    });
    index = end;
  }

  return hunks;
}

/**
 * 记录一次文件改动到【该 contextId 的桶】。
 * @param contextId 执行上下文 id（主 agentLoop=对话 id ?? AUTOSAVE_ID；子代理=subagentId）。
 *        缺省（极端兜底）落 DEFAULT_BUCKET，保持旧单桶行为。
 */
export function recordTrackedFileChange(change: TrackedFileChange, contextId?: string): void {
  const key = contextId || DEFAULT_BUCKET;
  let bucket = pendingChangesByContext.get(key);
  if (!bucket) {
    bucket = [];
    pendingChangesByContext.set(key, bucket);
  }
  bucket.push(change);
}

/**
 * 取出并清空【该 contextId 桶】的全部 pending 改动；其它上下文的桶不受影响（不再串台）。
 * @param contextId 同 recordTrackedFileChange；缺省消费 DEFAULT_BUCKET。
 */
export function consumeTrackedFileChanges(contextId?: string): TrackedFileChange[] {
  const key = contextId || DEFAULT_BUCKET;
  const bucket = pendingChangesByContext.get(key);
  if (!bucket || bucket.length === 0) {
    // 空桶不必保留（也避免曾创建但无改动的桶残留）。
    if (bucket) pendingChangesByContext.delete(key);
    return [];
  }
  const drained = bucket.splice(0, bucket.length);
  // 消费后桶已空 → 删除，防 Map 随子代理（id 含时间戳唯一）无限增长。
  pendingChangesByContext.delete(key);
  return drained;
}

/**
 * ★ #8 选A（fork 重绑）：对话 fork 成真 id 时，把其【未消费的 pending 文件改动】从 fromId 桶迁到 toId 桶——
 *   防 fork 瞬间正好有 record 了但还没 consume 的改动，因 run 重绑后只 consume(toId) 而漏掉。无该桶时安全空操作。
 */
export function migrateTrackedChanges(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  const src = pendingChangesByContext.get(fromId);
  if (!src || src.length === 0) { if (src) pendingChangesByContext.delete(fromId); return; }
  const dst = pendingChangesByContext.get(toId) ?? [];
  dst.push(...src);
  pendingChangesByContext.set(toId, dst);
  pendingChangesByContext.delete(fromId);
}
