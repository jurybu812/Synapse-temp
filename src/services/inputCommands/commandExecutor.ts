/**
 * Synapse 输入区命令层 — / 命令执行分发器（M4-6-S3）
 *
 * parseAndDispatch(inputText, helpers) 把整条输入按 `/name args` 解析：
 *   - 命中注册命令 → 解析参数 → 注入 SlashRunContext.helpers → 调 run → 返回 { handled:true }。
 *   - 是 `/` 开头但命令未注册 → { handled:false, suggestion }（让 handleSend 走原逻辑 / 提示，不误吞）。
 *   - 非 `/` 开头 → { handled:false }（普通对话 / @MultiAI 分流照常）。
 *
 * 参数解析：按命令 args 声明，非 rest 参数按空白切分（鲁棒处理多空格 / 全角空格——S5 加固），
 * rest 参数（应为最后一个）吞掉剩余整段。命令名匹配大小写不敏感（含别名）。
 */
import { commandRegistry, type SlashCommand, type SlashRunContext } from './commandRegistry';

export interface DispatchResult {
  /** 是否被命令层处理（true → 调用方应 return，不再走普通发送链路）。 */
  handled: boolean;
  /** 未命中但以 `/` 开头时的提示（如「未知命令 /xxx」）。 */
  suggestion?: string;
}

/** 解析 `/name rest` → { name, rest }；非 `/` 开头返回 null。 */
function splitNameAndRest(input: string): { name: string; rest: string } | null {
  const trimmed = input.replace(/^[\s　]+/, ''); // 去前导空白（含全角空格）
  if (!trimmed.startsWith('/')) return null;
  // 去掉前导斜杠（容错 //collect 写法），再取命令名 = 到第一个空白前的连续非空白。
  const body = trimmed.replace(/^\/+/, '');
  const m = body.match(/^(\S+)([\s\S]*)$/);
  if (!m) return { name: '', rest: '' };
  return { name: m[1], rest: (m[2] ?? '').replace(/^[\s　]+/, '') };
}

/**
 * ★ M4-6-S5 引号鲁棒：剥掉一个参数值【外层成对引号】（直/弯/中文/反引号）。
 *   适配 `/loop 3 "do the thing"`、`/goal 「写一篇周报」` 等带引号写法——只剥最外层一对，内部引号保留。
 *   未被成对引号包裹则原样返回。
 */
function stripOuterQuotes(value: string): string {
  const v = value.trim();
  if (v.length < 2) return v;
  const pairs: Array<[string, string]> = [
    ['"', '"'], ["'", "'"], ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['`', '`'],
  ];
  for (const [open, close] of pairs) {
    if (v.startsWith(open) && v.endsWith(close) && v.length > open.length + close.length) {
      return v.slice(open.length, v.length - close.length).trim();
    }
  }
  return v;
}

/** 按命令 args 声明解析 rest 串为命名参数（多空格 / 全角空格 / 引号鲁棒——S5 加固）。 */
function parseArgs(cmd: SlashCommand, rest: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const args = cmd.args ?? [];
  if (args.length === 0) return parsed;

  let remaining = rest.trim();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.rest) {
      // rest 参数吞掉剩余整段；剥外层成对引号（如 /loop 3 "do x" → 指令=do x）。
      parsed[arg.name] = stripOuterQuotes(remaining);
      remaining = '';
      break;
    }
    // 非 rest：支持引号包裹的 token（如 "a b" 作为一个参数），否则取下一个空白分隔 token。
    const quoted = remaining.match(/^(["'「『“‘`])([\s\S]*?)(["'」』”’`])([\s\S]*)$/);
    if (quoted && QUOTE_CLOSE[quoted[1]] === quoted[3]) {
      parsed[arg.name] = quoted[2];
      remaining = (quoted[4] ?? '').replace(/^[\s　]+/, '');
      continue;
    }
    const m = remaining.match(/^(\S+)([\s\S]*)$/);
    if (!m) {
      parsed[arg.name] = '';
      continue;
    }
    parsed[arg.name] = m[1];
    remaining = (m[2] ?? '').replace(/^[\s　]+/, '');
  }
  return parsed;
}

/** 开引号 → 对应闭引号（非 rest 参数引号匹配用）。 */
const QUOTE_CLOSE: Record<string, string> = {
  '"': '"', "'": "'", '「': '」', '『': '』', '“': '”', '‘': '’', '`': '`',
};

/**
 * 解析并分发命令。
 * @param inputText 整条输入（用户输入框文本）。
 * @param helpers   能力注入（runAgent/notify/openSettings/clearConversation/compactNow?/startLoop?）。
 */
export function parseAndDispatch(
  inputText: string,
  helpers: SlashRunContext['helpers'],
): DispatchResult {
  const split = splitNameAndRest(inputText);
  if (!split) return { handled: false }; // 非 / 开头 → 普通分流。
  if (!split.name) return { handled: false, suggestion: '请输入命令名，例如 /goal 或 /clear' };

  const cmd = commandRegistry.find(split.name);
  if (!cmd) {
    return { handled: false, suggestion: `未知命令 /${split.name}` };
  }

  const ctx: SlashRunContext = {
    rawArgs: split.rest,
    parsedArgs: parseArgs(cmd, split.rest),
    helpers,
  };
  try {
    void cmd.run(ctx);
  } catch (err: any) {
    helpers.notify({ type: 'error', title: '命令执行失败', message: err?.message || `/${split.name}` });
  }
  return { handled: true };
}
