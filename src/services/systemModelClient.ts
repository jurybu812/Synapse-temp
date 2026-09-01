/**
 * System Model Client
 * M4-5-S4：后台 LLM 任务的【共享非流式调用通路】。
 *
 * 与 recordGenerator 的 resolveClient + callOnce 同一范式（低 temperature、stream:false、outputStrategy:'off'、
 * 一次性收集完整回复），但口径走【系统模型】（resolveSystemModel：systemModel || currentModel）。
 *
 * 当前服务对象：自动标题生成（runSystemModelOnce）。后续 /compact 等手动后台任务可复用同一 helper。
 *
 * ★ 铁律（与 record 一致）：后台任务绝不阻塞主对话。任何失败（无 Key / 无模型 / 网络 / 超时 / 空响应）
 *   一律降级返回 null，由调用方决定回退（标题 → 保留截断占位）。
 */

import { AIClient, type ChatMessage } from './aiClient';
import { store } from '@/store';
import { resolveSystemModel } from './modelResolution';
import { capabilityBoundClientOptions, resolveProviderModel } from './providerModelRuntime';

/** 默认一次性调用超时（毫秒）：标题这类轻任务用短超时，避免拖尾。 */
const DEFAULT_TIMEOUT_MS = 20_000;
/** 默认输出 token 上限：标题极短，给一点余量即可（与 Plan_5 决策「maxTokens 极小」一致）。 */
const DEFAULT_MAX_TOKENS = 32;
/** 默认温度：低温稳定输出。 */
const DEFAULT_TEMPERATURE = 0.3;

export interface RunSystemModelOnceOptions {
  conversationId?: string;
  runId?: string;
  ownerId?: string;
  requestKind?: 'title' | 'subtitle' | 'system';
  /** 输出 token 上限（默认 32，适合标题等极短产出）。 */
  maxTokens?: number;
  /** 采样温度（默认 0.3）。 */
  temperature?: number;
  /** 整体超时毫秒（默认 20000），超时降级返回 null。 */
  timeoutMs?: number;
  /** 可选 system 提示，置于 user prompt 之前。 */
  system?: string;
}

/**
 * 从 store 解析【系统模型】非流式 AIClient；缺 Key / 缺模型返回 null。
 * ★ 每次新建独立实例（不复用/缓存），与 recordGenerator 同款隔离前提——abort/超时只掐断本次请求。
 */
function resolveClient(opts: RunSystemModelOnceOptions): AIClient | null {
  const state = store.getState() as any;
  const settings = state?.settings;
  // ★ M4-5：后台任务走系统模型通路（systemModel || currentModel）。
  const selectionId = resolveSystemModel(state);
  const runtime = resolveProviderModel(
    selectionId,
    state?.agentSettings?.availableModels,
    settings?.providerCredentials,
    settings?.apiEndpoints,
  );
  if (!runtime.configured || !runtime.modelId) return null;
  const bounded = capabilityBoundClientOptions(runtime, {
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  });
  return new AIClient({
    providerId: runtime.providerId,
    conversationId: opts.conversationId,
    runId: opts.runId,
    ownerId: opts.ownerId,
    requestKind: opts.requestKind ?? 'system',
    catalogGeneration: runtime.option?.catalog?.generation,
    baseUrl: runtime.baseUrl,
    model: runtime.modelId,
    temperature: bounded.temperature,
    maxTokens: bounded.maxTokens,
    maxTokenParameter: bounded.maxTokenParameter,
    stream: bounded.stream,
    streamOptions: bounded.streamOptions,
    outputStrategy: 'off',
  });
}

/**
 * 非流式收集一次完整回复；timeout 兜底掐断；error chunk 抛出。
 * 与 recordGenerator.callOnce 同结构（精简版：标题任务无需外部 abort signal）。
 */
async function callOnce(client: AIClient, messages: ChatMessage[], timeoutMs: number): Promise<string> {
  let content = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.abort();
      reject(new Error('system model call timeout'));
    }, timeoutMs);
  });

  const collect = (async () => {
    for await (const chunk of client.streamChat(messages)) {
      if (chunk.type === 'content' && chunk.content) content += chunk.content;
      if (chunk.type === 'error') throw new Error(chunk.error || 'system model error');
    }
    return content;
  })();

  try {
    return await Promise.race([collect, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 系统模型【非流式一次性】调用：成功返回完整文本（未清洗），失败/超时/无配置返回 null。
 *
 * 调用方负责对返回文本做任务相关清洗（如标题的 trim / 去引号 / 截断）与重试策略。
 * 本函数自身不重试——单次调用、失败即 null，保持职责单一、成本可控。
 */
export async function runSystemModelOnce(
  prompt: string,
  opts: RunSystemModelOnceOptions = {},
): Promise<string | null> {
  try {
    if (!prompt || !prompt.trim()) return null;
    const client = resolveClient(opts);
    if (!client) return null; // 无 Key / 无系统模型 → 降级

    const messages: ChatMessage[] = [];
    if (opts.system && opts.system.trim()) {
      messages.push({ role: 'system', content: opts.system });
    }
    messages.push({ role: 'user', content: prompt });

    const raw = await callOnce(client, messages, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const text = (raw ?? '').trim();
    return text || null;
  } catch (err) {
    console.warn('[systemModelClient] runSystemModelOnce failed (degrade to null):', err);
    return null;
  }
}
