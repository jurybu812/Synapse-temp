/**
 * richInput 共享类型 —— Plan_5_M6 富文本输入框（contenteditable + 内联 atomic @token + 两级类型菜单）。
 *
 * AtType 七类复刻 Antigravity。token 在 DOM 里是 contenteditable=false 的 atomic span，
 * data-type/data-id/data-value 三元组承载结构化信息；发送时 extract 成 { plainText, tokens }，
 * 编辑回填时用 tokens[] 逐个 insertToken 重建（禁止 innerHTML 反序列化，对抗审查 P4/P17）。
 */

/** @ 引用类型（七类）。 */
export type AtType = 'file' | 'directory' | 'conversation' | 'workflow' | 'settings' | 'mcp' | 'terminal';

/** 一级类型菜单顺序（复刻 Antigravity：文件/目录在前，设置/MCP/终端在后）。 */
export const AT_TYPES: readonly AtType[] = ['file', 'directory', 'conversation', 'workflow', 'settings', 'mcp', 'terminal'];

/**
 * #12a：/ 斜杠命令也渲染成内联 atomic token（仿 @ 提及的彩色 chip）。
 * slash 与七类 @ 引用共用同一套 atomic token 机制（createTokenSpan / extract / buildRichParts），
 * 但【刻意不并入 AtType / AT_TYPES】——AT_TYPES 驱动一级 @ 类型菜单，混入 slash 会污染该菜单；
 * slash 的触发（detectSlashTrigger）、占位语义（TOKEN_INLINE.slash = `/cmd `）、配色（.rt-token-slash）
 * 都是独立的一条线。故引入 TokenType = AtType | 'slash' 作为 token 全集，TokenSpec / TOKEN_INLINE 走它。
 */
export type TokenType = AtType | 'slash';

/** token 全集（含 slash），供 createTokenSpan/extract/buildRichParts 的类型守卫复用。 */
export const TOKEN_TYPES: readonly TokenType[] = [...AT_TYPES, 'slash'];

/** token 规格（构造 span / 重建 / 提取共用）。 */
export interface TokenSpec {
  type: TokenType;
  /** 稳定标识：conversationId / 文件绝对路径 / modeName / sectionId / mcp__server__tool / terminal sessionId。 */
  id: string;
  /**
   * 持久化锚点 & 发送占位语义。
   * - workflow：mode.id（英文 slug，无空格，避免 parseMultiAITrigger 截断）
   * - file/directory：绝对路径（normSlash 归一），供 AI 直接调 view_file 不依赖 worktree 根
   * - slash：命令名（不含斜杠，如 'goal'）——TOKEN_INLINE.slash 还原为 `/<value>`，下游 parseAndDispatch 命中执行
   * - 其它（conv/settings/mcp/terminal）：可读语义，与显示文本同
   * 这是 plainText 占位串 TOKEN_INLINE[type](value) 的实参，必须语义无歧义。
   */
  value: string;
  /**
   * 可选显示文本（菜单 pill / 编辑器 atomic span textContent 用，不含前导 @）。
   * - 当 value 不可读时（workflow 用 id / file 用绝对路径），用 displayLabel 还原人类可读形态
   *   （如 mode.name 含空格 / 文件相对路径）。
   * - 缺省时 createTokenSpan 自动回落到 value。
   * - 持久化（D1）要落库，编辑回填重建 atomic span 才能保观感。
   */
  displayLabel?: string;
}

/** 发送时从编辑器有序提取的 token。 */
export type ExtractedToken = TokenSpec;

export interface ExtractResult {
  /** 纯文本（token 替换为各自占位语义、零宽占位已 strip、换行已归一）。 */
  plainText: string;
  /** 有序 token 列表（注入分派 + 编辑回填重建用）。 */
  tokens: ExtractedToken[];
}

/** @ 触发上下文（contenteditable Range 版，替代 textarea 的字符下标）。 */
export interface AtTrigger {
  /** @ 之后到光标的过滤片段（可空）。 */
  query: string;
  /** @ 字符所在的文本节点。 */
  startNode: Text;
  /** @ 字符在该文本节点内的偏移。 */
  startOffset: number;
}

/** RichTextInput 通过 forwardRef + useImperativeHandle 暴露给父组件的命令式接口。 */
export interface RichTextInputHandle {
  /** 在当前 @ 触发处插入 atomic token（删掉 @query 段）。 */
  insertTokenAt(trigger: AtTrigger, t: TokenSpec): void;
  /** 在光标处直接插入 token（无 @query 段，如编辑回填）。 */
  insertToken(t: TokenSpec): void;
  /** 提取 { plainText, tokens }。 */
  extract(): ExtractResult;
  /** 用结构化内容重建编辑器（编辑回填：文本 + 有序 token，禁 innerHTML）。 */
  setContent(parts: Array<string | TokenSpec>): void;
  clear(): void;
  focus(): void;
  isEmpty(): boolean;
  /** 当前 @ 触发上下文（供父组件 refreshMenu）。 */
  getAtTrigger(): AtTrigger | null;
  getElement(): HTMLDivElement | null;
}

/** 运行时类型守卫：校验字符串是否合法 AtType（对抗审查 P5，防脏 DOM 的非法 data-type）。 */
export function isAtType(v: unknown): v is AtType {
  return typeof v === 'string' && (AT_TYPES as readonly string[]).includes(v);
}

/** 运行时类型守卫：校验字符串是否合法 TokenType（含 slash）。createTokenSpan/extract 用它放行 slash token。 */
export function isTokenType(v: unknown): v is TokenType {
  return typeof v === 'string' && (TOKEN_TYPES as readonly string[]).includes(v);
}
