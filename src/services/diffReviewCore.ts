export interface ReviewTransitionResult {
  content: string;
  merged: boolean;
}

interface LineOperation {
  type: 'context' | 'add' | 'delete';
  content: string;
}

interface TransitionHunk {
  lines: LineOperation[];
}

interface ReviewStatePart {
  status?: 'pending' | 'accepted' | 'rejected' | 'mixed' | 'superseded';
}

interface ReviewStateHunk extends ReviewStatePart {
  blocks?: ReviewStatePart[];
}

export function hasPendingReviewParts(diff: ReviewStatePart & { hunks?: ReviewStateHunk[] }): boolean {
  if (!diff.hunks || diff.hunks.length === 0) return diff.status === 'pending';
  return diff.hunks.some(hunk => {
    if (hunk.blocks && hunk.blocks.length > 0) {
      return hunk.blocks.some(block => (block.status ?? hunk.status ?? 'pending') === 'pending');
    }
    return (hunk.status ?? 'pending') === 'pending';
  });
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function detectLineEnding(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function hasTrailingLineEnding(content: string): boolean {
  return /(?:\r\n|\n)$/.test(content);
}

function joinMergedLines(
  lines: string[],
  expectedContent: string,
  desiredContent: string,
  currentContent: string,
): string {
  const lineEnding = detectLineEnding(currentContent || expectedContent || desiredContent);
  let trailingLineEnding = hasTrailingLineEnding(currentContent);
  if (hasTrailingLineEnding(currentContent) === hasTrailingLineEnding(expectedContent)) {
    trailingLineEnding = hasTrailingLineEnding(desiredContent);
  }
  const body = lines.join(lineEnding);
  return trailingLineEnding ? `${body}${lineEnding}` : body;
}

function buildLineOperations(before: string, after: string): LineOperation[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const common = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex--) {
      common[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? common[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(common[beforeIndex + 1][afterIndex], common[beforeIndex][afterIndex + 1]);
    }
  }

  const operations: LineOperation[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (
      beforeIndex < beforeLines.length &&
      afterIndex < afterLines.length &&
      beforeLines[beforeIndex] === afterLines[afterIndex]
    ) {
      operations.push({ type: 'context', content: beforeLines[beforeIndex] });
      beforeIndex++;
      afterIndex++;
    } else if (
      afterIndex < afterLines.length &&
      (beforeIndex === beforeLines.length || common[beforeIndex][afterIndex + 1] >= common[beforeIndex + 1][afterIndex])
    ) {
      operations.push({ type: 'add', content: afterLines[afterIndex] });
      afterIndex++;
    } else {
      operations.push({ type: 'delete', content: beforeLines[beforeIndex] });
      beforeIndex++;
    }
  }
  return operations;
}

function buildTransitionHunks(before: string, after: string, context = 3): TransitionHunk[] {
  const operations = buildLineOperations(before, after);
  const hunks: TransitionHunk[] = [];
  let index = 0;

  while (index < operations.length) {
    const relativeChange = operations.slice(index).findIndex(operation => operation.type !== 'context');
    if (relativeChange === -1) break;
    const changeIndex = index + relativeChange;
    const start = Math.max(changeIndex - context, 0);
    let end = changeIndex;
    let trailingContext = 0;
    while (end < operations.length) {
      if (operations[end].type === 'context') {
        trailingContext++;
        if (trailingContext > context) break;
      } else {
        trailingContext = 0;
      }
      end++;
    }
    hunks.push({ lines: operations.slice(start, end) });
    index = end;
  }
  return hunks;
}

function findSequenceMatches(lines: string[], sequence: string[]): number[] {
  if (sequence.length === 0) return [];
  const matches: number[] = [];
  for (let start = 0; start <= lines.length - sequence.length; start++) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset++) {
      if (lines[start + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(start);
  }
  return matches;
}

export function applyReviewTransition(expectedContent: string, desiredContent: string, currentContent: string): ReviewTransitionResult {
  if (currentContent === desiredContent) {
    return { content: desiredContent, merged: true };
  }
  if (currentContent === expectedContent) {
    return { content: desiredContent, merged: false };
  }
  if (expectedContent === desiredContent) {
    return { content: currentContent, merged: true };
  }

  const currentLines = splitLines(currentContent);
  const hunks = buildTransitionHunks(expectedContent, desiredContent);
  for (const hunk of hunks) {
    const expectedLines = hunk.lines
      .filter(line => line.type !== 'add')
      .map(line => line.content);
    const desiredLines = hunk.lines
      .filter(line => line.type !== 'delete')
      .map(line => line.content);
    const matches = findSequenceMatches(currentLines, expectedLines);
    if (matches.length !== 1) {
      throw new Error('当前内容与待审改动在同一区域发生冲突，已保留用户内容');
    }
    currentLines.splice(matches[0], expectedLines.length, ...desiredLines);
  }

  return {
    content: joinMergedLines(currentLines, expectedContent, desiredContent, currentContent),
    merged: true,
  };
}

export function validateReviewAcceptance(
  expectedContent: string,
  baselineContent: string,
  currentContent: string,
): ReviewTransitionResult {
  if (expectedContent !== baselineContent && currentContent === baselineContent) {
    throw new Error('Agent 改动已不在当前内容中，已停止接受并保留用户内容');
  }
  return applyReviewTransition(expectedContent, baselineContent, currentContent);
}
