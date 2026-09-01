/**
 * Token 计数 —— Plan_5_M6 验收 bug7。
 *
 * 主人决策：gpt 系（OpenAI）模型用 gpt-tokenizer 的 o200k_base 编码做【精确】计数；
 *   非 gpt 模型（Claude / 国产 / 本地网关等）分词不同，仍用字符【估算】并由 UI 标注「≈估算」。
 *
 * 注：encode 有 CPU 开销，调用方（StatusBar / 上下文弹窗）应 useMemo 缓存，避免流式每帧重算整对话。
 *   整对话精确计数仅在「无 API 实测 usage」时回退使用（发送后优先用 API 返回的真实 prompt_tokens）。
 */
import { encode } from 'gpt-tokenizer/encoding/o200k_base';

/** 是否 OpenAI gpt 系模型（用真分词器精确计数）。o200k_base 覆盖 gpt-4o / gpt-5.x / o1 系。 */
export function isExactTokenModel(model: string | undefined): boolean {
  return /\b(gpt|o1|o3|o4|chatgpt|davinci)\b/i.test(model || '');
}

/** 字符估算回退（中文 1.5 / 其它 0.25，与 systemPrompt.estimateTokens 同口径；复制一份避免循环依赖）。 */
function estimateFallback(text: string): number {
  if (!text) return 0;
  const chinese = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length;
  return Math.ceil(chinese * 1.5 + (text.length - chinese) * 0.25);
}

export interface TokenCount {
  count: number;
  /** true=真分词器精确；false=字符估算。 */
  exact: boolean;
}

/** 单段文本 token 数。gpt 系精确 encode，其它估算。 */
export function countTextTokens(text: string, model: string | undefined): TokenCount {
  if (!text) return { count: 0, exact: isExactTokenModel(model) };
  if (isExactTokenModel(model)) {
    try {
      return { count: encode(text).length, exact: true };
    } catch {
      // encode 异常（编码表缺失等）→ 降级估算，不让 token 计数崩掉 UI。
    }
  }
  return { count: estimateFallback(text), exact: false };
}

/** 整对话 token 数（含每消息 +4、整体 +2 的 OpenAI 消息格式开销近似，与 countConversationTokens 同口径）。 */
export function countConversationTokensExact(
  messages: Array<{ role: string; content: string }>,
  model: string | undefined,
): TokenCount {
  const exact = isExactTokenModel(model);
  let total = 2;
  for (const m of messages) {
    total += countTextTokens(m.content, model).count + 4;
  }
  return { count: total, exact };
}
