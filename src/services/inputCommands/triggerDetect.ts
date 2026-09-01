/**
 * Synapse 输入区命令层 — 触发检测（M4-6-S1）
 *
 * 职责：解析 textarea 当前【光标前文本】，判定光标是否处于 `@`（艾特）或 `/`（斜杠命令）上下文，
 *   并取出 query 片段与 token 起点（tokenStart），供内联补全浮层渲染候选 + 选中后做字符串替换。
 *
 * 与 multiAITrigger.parseMultiAITrigger 的关系：
 *   - parseMultiAITrigger 是【发送瞬间】对整条输入的前缀解析（仅整条开头 `@MultiAI:`）。
 *   - detectTrigger 是【输入实时】的内联补全触发检测，是全新交互层。两者不互相替代。
 *
 * 触发边界（按 Plan_5_M4-6 §4.1 + §7 决议 5 锁定）：
 *   - `@`：允许句中触发（引用语义可嵌在话里）。触发字符前须是【行首或空白】，
 *     且排除 email / scoped npm 包（`@org/pkg`）/ 含 `@` 的路径等误触场景。
 *   - `/`：仅当 `/` 出现在【整条输入去前导空白后的开头】才触发（命令是整条指令语义，不在句中）。
 *   - query = 触发字符到光标之间的连续非空白串；其间出现空白即不再是 query（菜单关闭）。
 *
 * IME 安全：本函数是纯函数，不感知输入法 composition 状态。调用方（AgentPanel）须在
 *   `onCompositionStart`/`End` 期间抑制调用本函数，避免中文拼音未上屏时误弹菜单（见 S5）。
 */

/** 触发类型：at=@艾特、slash=/斜杠命令、null=无触发。 */
export type TriggerKind = 'at' | 'slash';

export interface TriggerDetectResult {
  /** 当前触发上下文类型。 */
  kind: TriggerKind;
  /** 触发字符（不含 `@`/`/`）到光标之间的 query 片段；可为空字符串（刚打出触发字符）。 */
  query: string;
  /**
   * 触发字符在原文中的下标（即 `@`/`/` 自身的位置）。
   * 选中候选后用 `text.slice(0, tokenStart)` + 替换文本 + `text.slice(caretPos)` 做整体替换。
   */
  tokenStart: number;
}

/** 判断字符是否为「token 边界」（行首语义）：换行 / 空格 / 制表 / 全角空格 / undefined（即字符串开头）。 */
function isBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '　';
}

/**
 * 检测光标处的触发上下文。
 *
 * @param text     textarea 当前完整文本。
 * @param caretPos 光标位置（selectionStart）。负数 / 越界时安全夹取。
 * @returns 命中触发返回 TriggerDetectResult；否则 null。
 */
export function detectTrigger(text: string, caretPos: number): TriggerDetectResult | null {
  if (typeof text !== 'string') return null;
  const caret = Math.max(0, Math.min(caretPos, text.length));
  if (caret === 0) return null;

  // 从光标向前扫描，找最近的 `@` 或 `/`；中途遇到空白则判定「光标不在任何 token 内」→ 无触发。
  // （query 不含空白：一旦触发字符与光标间出现空白，菜单应关闭。）
  let i = caret - 1;
  for (; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@' || ch === '/') break;
    if (isBoundaryChar(ch)) return null; // 触发字符前已遇空白/换行 → 当前不在补全 token 中。
  }
  if (i < 0) return null; // 一路向前没遇到 @ 或 /。

  const triggerChar = text[i];
  const query = text.slice(i + 1, caret);
  // query 内不应含空白（理论上前面循环已保证，这里二次防御：含空白即视为已离开 token）。
  if (/[\s　]/.test(query)) return null;

  if (triggerChar === '@') {
    return detectAt(text, i, query);
  }
  // triggerChar === '/'
  return detectSlash(text, i, query);
}

/**
 * `@` 触发判定（句中允许，但须排除 email / scoped 包 / 路径等误触）。
 * @param text  完整文本。
 * @param at    `@` 在文本中的下标。
 * @param query `@` 之后到光标的片段。
 */
function detectAt(text: string, at: number, query: string): TriggerDetectResult | null {
  const prev = at > 0 ? text[at - 1] : undefined;
  // 规则 1：`@` 前须是行首或空白。否则多半是 email（user@host）、scoped 包前缀拼接、或代码片段 → 不触发。
  if (!isBoundaryChar(prev)) return null;

  // 规则 2：scoped npm 包 / 路径排除——`@org/pkg`、`@dir/file`：query 里出现 `/` 即视为路径/包，不触发。
  //   （@对话/@工作流/@设置 的候选 label 不需要用户输入 `/`，故 query 含 `/` 一律排除是安全的。）
  if (query.includes('/')) return null;

  return { kind: 'at', query, tokenStart: at };
}

/**
 * `/` 触发判定（仅整条输入去前导空白后的开头才触发）。
 * @param text  完整文本。
 * @param slash `/` 在文本中的下标。
 * @param query `/` 之后到光标的片段。
 */
function detectSlash(text: string, slash: number, query: string): TriggerDetectResult | null {
  // `/` 之前的所有字符必须全是空白（即 `/` 处于整条输入去前导空白后的开头）。
  const before = text.slice(0, slash);
  if (before.length > 0 && !/^[\s　]*$/.test(before)) return null;
  return { kind: 'slash', query, tokenStart: slash };
}
