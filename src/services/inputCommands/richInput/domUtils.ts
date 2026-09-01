/**
 * richInput DOM 工具 —— Plan_5_M6 contenteditable 富文本输入框的底层 DOM 操作。
 *
 * 全部不依赖 React，纯 DOM。承载对抗审查的多个关键修正：
 *   P4/P5  token 用 textContent 赋值 + type 白名单校验（防 XSS + 脏 DOM）
 *   P6     占位用零宽字符 U+200B（非普通空格），token 前后各一个，extract 整体 strip（不与用户空格混淆）
 *   P7     findAtomicTokenBeforeCaret 严格判定，配合默认删字符形成「两段式退格」
 *   P8     cleanupEmptyNodes 移除空节点 + normalize（全选删除残留 / 相邻文本节点合并）
 *   P11    extract 块级元素 div/p 进入前补换行（防多行粘贴丢换行）
 */

import type { AtTrigger, ExtractResult, ExtractedToken, TokenSpec, TokenType } from './types';
import { isTokenType } from './types';

/** 零宽占位符（U+200B）：token 前后各补一个，保证光标在 token 前/后/相邻 token 间/编辑器首尾都有落点；
 *  extract 时整体 strip，不与用户真实空格混淆（对抗审查 P6）。用 fromCharCode 构造，源码里不出现不可见字符。 */
export const ZWSP = String.fromCharCode(0x200b);

/**
 * token 在发送纯文本里的占位形态（语义沿用现有口径：对话/工作流/终端带前缀，文件/目录/MCP 直接 @）。
 * 收尾 C2：value 现已收敛为「持久化锚点」语义——workflow=mode.id（无空格）、file/dir=绝对路径，
 * 让 parseMultiAITrigger 与下游工具调用拿到无歧义形态。
 * export 出去供 buildRichParts（D1 编辑回填重组算法）复用同一份占位规则——单一真相源防漂移。
 */
export const TOKEN_INLINE: Record<TokenType, (value: string) => string> = {
  file: (v) => `@${v}`,
  directory: (v) => `@${v}`,
  conversation: (v) => `@对话:${v}`,
  workflow: (v) => `@MultiAI:${v}`,
  mcp: (v) => `@${v}`,
  terminal: (v) => `@终端:${v}`,
  settings: () => '', // 设置是纯跳转，不进发送文本
  // #12a：/ 命令 token 还原为 `/<cmd>`（前导斜杠，【无尾随空格】）。token 与后续参数的分隔靠 buildTokenFragment
  //   在 token 后补的真实空格（发送 extract 时天然有），故占位不必自带尾空格。这样两条还原路径都更稳：
  //   ① 发送：`/goal`、`/goal 写周报` 经 parseAndDispatch 的 /^(\S+)([\s\S]*)$/ 正确切 name/rest（单空格不双空格）；
  //   ② 编辑回填：buildRichParts 占位 `/goal` 在 trimEnd 后的持久化 content 里 indexOf 命中（含无参 /clear），chip 不退化。
  slash: (v) => `/${v}`,
};

/**
 * 构造 atomic token span。textContent 赋值（自动转义，防对话标题里的 <img onerror> 等 XSS，P4）；type 白名单（P5）。
 * 收尾 C2：textContent 改用 displayLabel ?? value 渲染（保人类可读观感），dataset.label 同步存 displayLabel；
 * dataset.value 仍存「持久化锚点」（workflow=id / file=绝对路径），plainText 占位发送时用它走 TOKEN_INLINE。
 */
export function createTokenSpan(t: TokenSpec): HTMLSpanElement {
  const span = document.createElement('span');
  const type: TokenType = isTokenType(t.type) ? t.type : 'file';
  span.className = `rt-token rt-token-${type}`;
  span.setAttribute('data-token', '');
  span.dataset.type = type;
  span.dataset.id = t.id;
  span.dataset.value = t.value;
  if (t.displayLabel != null) span.dataset.label = t.displayLabel;
  span.contentEditable = 'false';
  // #12a：slash token 前缀用 '/'（命令形态），@ 七类沿用 '@'。chip 文本仍走 displayLabel ?? value 保人类可读。
  const prefix = type === 'slash' ? '/' : '@';
  span.textContent = prefix + (t.displayLabel ?? t.value);
  return span;
}

/** 组装 token + 前后零宽占位的 fragment（after 末尾补一个真实空格，便于接着打字）。 */
function buildTokenFragment(t: TokenSpec): { frag: DocumentFragment; afterNode: Text } {
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode(ZWSP));
  frag.appendChild(createTokenSpan(t));
  const afterNode = document.createTextNode(ZWSP + ' ');
  frag.appendChild(afterNode);
  return { frag, afterNode };
}

/** 把光标收拢到指定文本节点末尾。 */
function collapseCaretToEnd(node: Text): void {
  const sel = window.getSelection();
  if (!sel) return;
  const caret = document.createRange();
  caret.setStart(node, node.textContent?.length ?? 0);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
}

/** 删掉 @query 段、在原位插入 atomic token（前后零宽占位），光标收拢到 token 之后。 */
export function insertTokenAtTrigger(root: HTMLElement, trigger: AtTrigger, t: TokenSpec): void {
  // M6 验收 bug1 主修：trigger.startNode 一定在 root 内（来自 detectAtTrigger），但 startNode 若已被
  //   normalize 摘除则防御性退出。
  if (!root.contains(trigger.startNode)) return;
  const sel = window.getSelection();
  const range = document.createRange();
  try {
    range.setStart(trigger.startNode, trigger.startOffset);
    // ★ bug1 根治：终点不再无条件信任 window.getSelection().focusNode——异步文件树菜单的空窗期，点击候选时
    //   选区可能已漂到编辑器【外部】（如左侧『最近工作区』列表），跨容器拼 Range 会把 token 插进欢迎页 DOM。
    //   仅当 focusNode 仍在 root 内才用它删 @query 段；否则 collapse 到 @ 锚点原位插入（绝不跨容器）。
    if (sel && sel.rangeCount > 0 && sel.focusNode && root.contains(sel.focusNode)) {
      range.setEnd(sel.focusNode, sel.focusOffset);
    } else {
      range.setEnd(trigger.startNode, trigger.startOffset); // collapsed 到 @ 处
    }
  } catch {
    return;
  }
  range.deleteContents();
  const { frag, afterNode } = buildTokenFragment(t);
  range.insertNode(frag);
  collapseCaretToEnd(afterNode);
  root.normalize();
}

/** 在当前光标处直接插入 token（无 @query 段；编辑回填 / 程序化插入）。 */
export function insertTokenAtCaret(root: HTMLElement, t: TokenSpec): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    const { frag, afterNode } = buildTokenFragment(t);
    root.appendChild(frag);
    collapseCaretToEnd(afterNode);
    return;
  }
  const range = sel.getRangeAt(0);
  // LOW-3：range 不在编辑器内（选区在 root 外）→ append 兜底，避免把 token 插到编辑器外部 DOM。
  if (!root.contains(range.commonAncestorContainer)) {
    const fb = buildTokenFragment(t);
    root.appendChild(fb.frag);
    collapseCaretToEnd(fb.afterNode);
    return;
  }
  range.deleteContents();
  const { frag, afterNode } = buildTokenFragment(t);
  range.insertNode(frag);
  collapseCaretToEnd(afterNode);
  root.normalize();
}

/** 用结构化内容（文本 + 有序 token）重建编辑器，禁 innerHTML（编辑回填，P4/P17）。 */
export function setEditorContent(root: HTMLElement, parts: Array<string | TokenSpec>): void {
  root.textContent = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      const lines = part.split('\n');
      lines.forEach((line, i) => {
        if (i > 0) root.appendChild(document.createElement('br'));
        if (line) root.appendChild(document.createTextNode(line));
      });
    } else {
      const { frag } = buildTokenFragment(part);
      root.appendChild(frag);
    }
  }
  root.normalize();
}

/** 提取 { plainText, tokens }：DFS 遍历，token→占位语义，br/块级→换行，零宽占位 strip（P6/P11）。 */
export function extractContent(root: HTMLElement): ExtractResult {
  const tokens: ExtractedToken[] = [];
  let text = '';
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent ?? '';
      } else if (child instanceof HTMLElement) {
        if (child.hasAttribute('data-token')) {
          const type = child.dataset.type;
          if (isTokenType(type)) {
            const tk: ExtractedToken = {
              type,
              id: child.dataset.id ?? '',
              value: child.dataset.value ?? '',
              ...(child.dataset.label != null ? { displayLabel: child.dataset.label } : {}),
            };
            tokens.push(tk);
            text += TOKEN_INLINE[type](tk.value); // slash → `/<cmd> `；@ 七类 → 各自占位
          } else {
            text += child.textContent ?? ''; // 非法 type 当普通文本（P5）
          }
        } else if (child.tagName === 'BR') {
          text += '\n';
        } else {
          const block = child.tagName === 'DIV' || child.tagName === 'P';
          if (block && text && !text.endsWith('\n')) text += '\n';
          walk(child);
          // MEDIUM-4：块级闭合后也补换行（<div>a</div>b → "a\nb"），前后双边界容错。
          if (block && text && !text.endsWith('\n')) text += '\n';
        }
      }
    });
  };
  walk(root);
  const plainText = text.split(ZWSP).join('').replace(/[ \t]+\n/g, '\n').trimEnd();
  return { plainText, tokens };
}

/** 编辑器是否空（无 token 且去零宽后无可见文本）。 */
export function isEditorEmpty(root: HTMLElement): boolean {
  if (root.querySelector('[data-token]')) return false;
  return (root.textContent ?? '').split(ZWSP).join('').trim() === '';
}

/**
 * 两段式退格第一阶段判定（P7）：光标 collapsed 且其前方紧邻的是 atomic token 时返回该 token；否则 null。
 * 光标在 token 后的占位/文字中间 → 返回 null（走默认删字符），删到紧贴 token（offset 0）时本函数才命中 →
 * 调用方 preventDefault 删整块。这样形成「先删占位再删 token」的两段式，避免一次退格整块惊吓消失。
 */
export function findAtomicTokenBeforeCaret(sel: Selection, root: HTMLElement): HTMLElement | null {
  if (!sel.isCollapsed || sel.rangeCount === 0) return null;
  const { focusNode, focusOffset } = sel;
  if (!focusNode || !root.contains(focusNode)) return null;
  if (focusNode.nodeType === Node.ELEMENT_NODE) {
    const prev = focusOffset > 0 ? focusNode.childNodes[focusOffset - 1] : null;
    return prev instanceof HTMLElement && prev.hasAttribute('data-token') ? prev : null;
  }
  if (focusNode.nodeType === Node.TEXT_NODE && focusOffset === 0) {
    const prev = focusNode.previousSibling;
    return prev instanceof HTMLElement && prev.hasAttribute('data-token') ? prev : null;
  }
  return null;
}

/**
 * 删一个 atomic token 及其【前后】零宽占位（MEDIUM-1：前导也清，避免反复插删累积孤立零宽节点 + 退格手感异常）。
 * Plan_5_M6 收尾 C1：删 token 后 normalize 父节点合并相邻文本节点（消掉「退格删 token 后留下相邻文本碎片
 * → 立刻打 @ 跨节点漏触发」的最频发路径，与 insertTokenAtTrigger/insertTokenAtCaret/setEditorContent 的
 * normalize 行为对称）。RichTextInput.handleKeyDown 退格分支已被 isComposing 守卫（IME 期间走不到），无需重复守卫。
 */
export function removeTokenSpan(token: HTMLElement): void {
  const parent = token.parentNode as (Element | null);
  const prev = token.previousSibling;
  const next = token.nextSibling;
  token.remove();
  if (next && next.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(ZWSP)) {
    next.textContent = next.textContent.slice(ZWSP.length);
  }
  if (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent?.endsWith(ZWSP)) {
    prev.textContent = prev.textContent.slice(0, -ZWSP.length);
  }
  parent?.normalize();
}

/** 清理空节点 + 合并相邻文本节点（全选删除残留 / IME 后 normalize，P8/P1/P14）。 */
export function cleanupEmptyNodes(root: HTMLElement): void {
  root.querySelectorAll('span:not([data-token])').forEach((s) => { if (!s.textContent) s.remove(); });
  root.querySelectorAll('div:empty, p:empty').forEach((d) => d.remove());
  root.normalize();
}

/** 保存当前选区（菜单交互期间光标可能丢失）。 */
export function saveSelection(root: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  return range.cloneRange();
}

/** 恢复选区。 */
export function restoreSelection(range: Range | null): void {
  if (!range) return;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
