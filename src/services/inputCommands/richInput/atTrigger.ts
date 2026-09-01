/**
 * @ 触发检测（contenteditable Range 版）—— Plan_5_M6。
 *
 * 替代 textarea 的 detectTrigger（线性字符下标）：contenteditable 无 selectionStart，基于光标 Range
 * 的 focusNode/focusOffset 在当前文本节点内回看。
 *
 * Plan_5_M6 收尾 C1（联动①）：扩展为跨相邻文本节点回看，治本解决「退格删 token / 粘贴 / IME 二次组合
 * 后立刻打 @ 漏触发或误触发」的所有路径。规则：
 *   - 从光标当前文本节点开始向前累积 stripped 文本，遇 atomic token / BR / DIV / P 立即停（块边界）；
 *   - 累积长度上限 MAX_LOOKBACK_CHARS=64（防极端深 DOM 性能）；
 *   - 任意一节点 stripped 含 \s 后仍未命中即停（@ 前驱已被非法字符阻断）；
 *   - 行内 `^@...` 模式仅在【已扫到真正块边界】（previousTextNodeWithin 返回 null）时允许，
 *     避免「前驱节点尾是非空白字符」时误命中（如 'hello x' + '@' 不该弹菜单）。
 *
 * 对抗审查相关：
 *   P1  调用方应在 compositionend 后先 root.normalize() 再调本函数（仍保留，作为额外保险）；
 *   P6  textBefore 判定前 strip 零宽占位（U+200B），使「token 后占位节点里打 @」也能触发；
 *       startOffset 用未 strip 的原始偏移（@query 在原始节点里连续）。
 *
 * 注：正则用 \s 即可——JS 的 \s 已涵盖普通空格 / Tab / 换行 / 全角空格 U+3000，无需单列全角，源码纯 ASCII。
 */

import type { AtTrigger } from './types';
import { ZWSP } from './domUtils';

const MAX_LOOKBACK_CHARS = 64;

/** @ 上下文合法性（旧 API，保留向后兼容）：光标前文本以「(行首|空白)@(非空白非/)」结尾时命中。 */
export function isValidAtContext(textBefore: string): RegExpExecArray | null {
  return /(^|\s)@([^\s/]*)$/.exec(textBefore);
}

/** 仅 `\s@query` 模式（前驱必须是空白字符）。 */
function matchWhitespaceAt(s: string): string | null {
  const m = /\s@([^\s/]*)$/.exec(s);
  if (!m) return null;
  const q = m[1];
  if (q.includes('/')) return null;
  return q;
}

/** 仅 `^@query` 模式（前驱必须是块边界 = 编辑器顶 / atomic token / BR / DIV / P 之前）。 */
function matchCaretAt(s: string): string | null {
  const m = /^@([^\s/]*)$/.exec(s);
  if (!m) return null;
  const q = m[1];
  if (q.includes('/')) return null;
  return q;
}

/** DFS 找一个 element 内最末尾的文本节点（用于回看时深入 inline element 的内部文本）。 */
function findLastTextNode(el: HTMLElement): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let n = walker.nextNode() as Text | null;
  while (n) { last = n; n = walker.nextNode() as Text | null; }
  return last;
}

/**
 * 找 node 在 root 内的前一个文本节点（按 DOM 序）。遇 atomic token / BR / DIV / P → 返回 null（块边界）。
 * 路径：先向同级前一个 sibling 走、再向上一层级、再向其 sibling 走，直到 root。
 */
function previousTextNodeWithin(node: Node, root: HTMLElement): Text | null {
  let cur: Node | null = node;
  while (cur && cur !== root && cur.parentNode) {
    let sib: Node | null = cur.previousSibling;
    while (sib) {
      if (sib instanceof HTMLElement) {
        if (sib.hasAttribute('data-token')) return null;
        if (sib.tagName === 'BR' || sib.tagName === 'DIV' || sib.tagName === 'P') return null;
        const lastText = findLastTextNode(sib);
        if (lastText) return lastText;
      } else if (sib.nodeType === Node.TEXT_NODE) {
        return sib as Text;
      }
      sib = sib.previousSibling;
    }
    cur = cur.parentNode;
    if (cur === root) return null; // 走到 root 仍没找到前驱 → 编辑器顶（块边界）
  }
  return null;
}

/** 累积段：每段记一个文本节点 + 它的原始 raw（含 ZWSP）。segs 按 DOM 序（旧节点在前）。 */
interface Seg { node: Text; raw: string }

/**
 * 把「累积 stripped 字符串里的某偏移」映射回「具体 Text 节点 + 其原始 raw 偏移」（跳过 ZWSP 字符）。
 * insertTokenAtTrigger 的 range.setStart 需要原始偏移，否则会落到错误位置。
 */
function locateOffset(segs: Seg[], strippedIndex: number): { node: Text; offset: number } | null {
  let consumed = 0;
  for (const seg of segs) {
    const segStripped = seg.raw.split(ZWSP).join('');
    if (strippedIndex <= consumed + segStripped.length) {
      const localStripped = strippedIndex - consumed;
      let rawOffset = 0;
      let strippedSoFar = 0;
      while (rawOffset < seg.raw.length && strippedSoFar < localStripped) {
        if (seg.raw[rawOffset] !== ZWSP) strippedSoFar++;
        rawOffset++;
      }
      return { node: seg.node, offset: rawOffset };
    }
    consumed += segStripped.length;
  }
  return null;
}

/** 基于当前光标 Range 检测 @ 触发；无触发返回 null。 */
export function detectAtTrigger(root: HTMLElement): AtTrigger | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const { focusNode, focusOffset } = sel;
  if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return null;
  if (!root.contains(focusNode)) return null;

  // 起点段：focusNode 的 [0, focusOffset)。
  const initRaw = (focusNode.textContent ?? '').slice(0, focusOffset);
  const segs: Seg[] = [{ node: focusNode as Text, raw: initRaw }];
  let accumStripped = initRaw.split(ZWSP).join('');
  let curNode: Text = focusNode as Text;
  let hitBlockBoundary = false;

  // 第一轮：先试 `\s@` 模式（不需要块边界证明）；命中即结束。
  let query: string | null = matchWhitespaceAt(accumStripped);

  // 没命中 → 跨节点向前累积。规则见文件头注释。
  while (query === null && accumStripped.length < MAX_LOOKBACK_CHARS) {
    const prev = previousTextNodeWithin(curNode, root);
    if (!prev) { hitBlockBoundary = true; break; }
    const prevRaw = prev.textContent ?? '';
    segs.unshift({ node: prev, raw: prevRaw });
    const prevStripped = prevRaw.split(ZWSP).join('');
    accumStripped = prevStripped + accumStripped;
    query = matchWhitespaceAt(accumStripped);
    if (query !== null) break;
    if (/\s/.test(prevStripped)) break; // 已扫节点含空白仍没命中 → @ 前驱被非法阻断
    curNode = prev;
  }

  // 退出循环后若未命中、且已扫到真正的块边界 → 允许 `^@` 模式（编辑器顶 / atomic / 块级之前）。
  if (query === null && hitBlockBoundary) {
    query = matchCaretAt(accumStripped);
  }

  if (query === null) return null;

  // 反推 @ 在 accumStripped 里的偏移 → 原始节点 + raw 偏移。
  const needle = '@' + query;
  const atIdx = accumStripped.lastIndexOf(needle);
  if (atIdx < 0) return null;
  const start = locateOffset(segs, atIdx);
  if (!start) return null;

  return { query, startNode: start.node, startOffset: start.offset };
}

/**
 * / 命令触发上下文（单层菜单）。
 * #12a：补 startNode/startOffset 锚点——slash 现在要像 @ 一样删掉 `/query` 段、原位插 atomic chip
 *   （仿 insertTokenAtTrigger 路径），需精确定位 `/` 字符在文本节点内的偏移。
 *   命令始终在编辑器开头首个文本节点，startOffset 指向 `/` 字符（已跳过任何前导零宽占位）。
 */
export interface SlashTrigger {
  /** / 之后到光标的过滤片段（不含斜杠）。 */
  query: string;
  /** `/` 字符所在的文本节点（= 编辑器首个非空文本节点）。 */
  startNode: Text;
  /** `/` 字符在该文本节点内的原始偏移（含可能的前导零宽，故按 raw 定位而非 stripped）。 */
  startOffset: number;
}

/**
 * / 命令触发检测（contenteditable 版，与 @ 互斥，P19）。命中条件（严格，避免与文件路径里的 / 混淆）：
 *   1. 光标 collapsed、focusNode 是文本节点且在 root 内；
 *   2. 编辑器里没有任何 atomic token（/命令是纯文本指令，混 token 不触发；也含已插入的 slash chip 自身）；
 *   3. focusNode 是 root 下首个非空文本节点（命令只在最开头）；
 *   4. 光标前文本（strip 零宽后）形如 /query（^/ 开头、query 无空白无第二个 /）。
 */
export function detectSlashTrigger(root: HTMLElement): SlashTrigger | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const { focusNode, focusOffset } = sel;
  if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return null;
  if (!root.contains(focusNode)) return null;
  if (root.querySelector('[data-token]')) return null; // 含 token → 非纯命令场景
  if (firstTextNode(root) !== focusNode) return null;   // 命令只在编辑器开头
  const raw = (focusNode.textContent ?? '').slice(0, focusOffset);
  const textBefore = raw.split(ZWSP).join('');
  const m = /^\/([^\s/]*)$/.exec(textBefore);
  if (!m) return null;
  // `/` 是 stripped 串的第 0 个字符——映射回 raw 里的实际偏移（跳过任何前导零宽占位）。
  const slashRawOffset = raw.indexOf('/');
  if (slashRawOffset < 0) return null;
  return { query: m[1], startNode: focusNode as Text, startOffset: slashRawOffset };
}

/** root 下深度优先首个非空（去零宽后）文本节点。 */
function firstTextNode(root: HTMLElement): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n && (n.textContent ?? '').split(ZWSP).join('') === '') {
    n = walker.nextNode() as Text | null;
  }
  return n;
}
