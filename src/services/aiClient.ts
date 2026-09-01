/**
 * Synapse AI Client
 * OpenAI 兼容 API + SSE 流式解析
 * 支持 OpenAI / DeepSeek / OpenRouter / Ollama
 */

import { normalizeModelOption } from './modelCapabilities';
import type { AIModelOption } from '@/types/aiModel';
import type { OutputStrategy, PseudoStreamSpeed } from '@/store/slices/agentSettings';
import { platform, type ProviderChatEvent, type ProviderChatStartResult, type ProviderRequestMeta } from '@/platform';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'file'; file: { filename: string; file_data?: string; file_id?: string } };

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AIClientConfig {
  providerId?: string;
  conversationId?: string;
  runId?: string;
  ownerId?: string;
  requestKind?: ProviderRequestMeta['requestKind'];
  vision?: boolean;
  contextWindow?: number;
  catalogGeneration?: string;
  compressionGeneration?: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxTokenParameter?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  stream?: boolean;
  streamOptions?: boolean;
  outputStrategy?: OutputStrategy;
  pseudoStreamSpeed?: PseudoStreamSpeed;
  showStreamCursor?: boolean;
  showGeneratingPlaceholder?: boolean;
  streamThinking?: boolean;
  reasoningEffort?: string;
  speedTier?: string;
}

export interface StreamChunk {
  type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error' | 'retry';
  content?: string;
  thinking?: string;
  toolCall?: ToolCallRequest;
  error?: string;
  streamMode?: 'real' | 'pseudo' | 'off';
  fallbackReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    requestId?: string;
    providerId?: string;
    modelId?: string;
    bodySha256?: string;
    sentAt?: number;
    conversationId?: string;
    runId?: string;
    callId?: string;
    ownerId?: string;
    requestKind?: 'agent' | 'record' | 'title' | 'subtitle' | 'subagent' | 'workflow' | 'system';
    catalogGeneration?: string;
    compressionGeneration?: string;
    accountFingerprint?: string | null;
    credentialGeneration?: number;
    inputImages?: Array<{ sha256: string; mime: string; bytes: number }>;
  };
  // M2-S 任务2：重试进度可观测。每次退避重试【前】发一个该事件，让 UI 显示「正在重试 N/M」
  // 而非干等。仅在重试真实发生时发出，不改变现有【是否重试】判定与退避时长。
  retry?: { attempt: number; maxRetries: number; reason: string };
  // M4-8 审查修复：真流式读流【中途】断线重试，会让模型从头重生成整段回复。若本轮已 yield 过
  // 实质 content/thinking（已上屏 + 已累积进 fullContent），直接 continue 重发会造成「半截旧内容 +
  // 完整新内容」首尾拼接污染气泡与 conversation history。故在这类 retry chunk 上带 resetContent，
  // 让 agentLoop 收到时先丢弃本轮已上屏/已累积内容，再接收重试后的新流（覆盖而非追加）。
  resetContent?: boolean;
}

function finiteToken(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function providerRequestFromResponse(response: Response): ProviderRequestMeta | null {
  const requestId = response.headers.get('x-synapse-request-id');
  const bodySha256 = response.headers.get('x-synapse-body-sha256');
  if (!requestId || !bodySha256) return null;
  return {
    requestId,
    conversationId: response.headers.get('x-synapse-conversation-id') ?? undefined,
    runId: response.headers.get('x-synapse-run-id') ?? undefined,
    callId: response.headers.get('x-synapse-call-id') ?? undefined,
    ownerId: response.headers.get('x-synapse-owner-id') ?? undefined,
    requestKind: (response.headers.get('x-synapse-request-kind') as ProviderRequestMeta['requestKind'] | null) ?? 'agent',
    providerId: response.headers.get('x-synapse-provider-id') ?? '',
    modelId: response.headers.get('x-synapse-model-id') ?? '',
    accountFingerprint: response.headers.get('x-synapse-account-fingerprint'),
    credentialGeneration: Number(response.headers.get('x-synapse-credential-generation')) || 0,
    catalogGeneration: response.headers.get('x-synapse-catalog-generation') ?? undefined,
    compressionGeneration: response.headers.get('x-synapse-compression-generation') ?? undefined,
    inputImages: (() => {
      try {
        const value = response.headers.get('x-synapse-input-images');
        return value ? JSON.parse(value) : [];
      } catch {
        return [];
      }
    })(),
    bodySha256,
    sentAt: Number(response.headers.get('x-synapse-sent-at')) || Date.now(),
  };
}

function normalizeUsage(data: any, response: Response): StreamChunk['usage'] | undefined {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const request = providerRequestFromResponse(response);
  const rawPromptTokens = finiteToken(usage.prompt_tokens ?? usage.input_tokens);
  const rawCompletionTokens = finiteToken(usage.completion_tokens ?? usage.output_tokens);
  const rawTotalTokens = finiteToken(usage.total_tokens);
  const promptTokens = rawPromptTokens
    ?? (rawTotalTokens !== null && rawCompletionTokens !== null ? rawTotalTokens - rawCompletionTokens : null);
  if (promptTokens === null || promptTokens < 0) return undefined;
  const completionTokens = rawCompletionTokens
    ?? (rawTotalTokens !== null ? rawTotalTokens - promptTokens : null);
  if (completionTokens === null || completionTokens < 0) return undefined;
  const totalTokens = Math.max(rawTotalTokens ?? (promptTokens + completionTokens), promptTokens + completionTokens);
  const cacheReadTokens = finiteToken(
    usage.prompt_tokens_details?.cached_tokens
      ?? usage.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cacheRead,
  );
  const cacheWriteTokens = finiteToken(
    usage.prompt_tokens_details?.cache_creation_tokens
      ?? usage.cache_creation_input_tokens
      ?? usage.cacheWrite,
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(request ?? {}),
  };
}

async function persistNormalizedUsage(usage: StreamChunk['usage'] | undefined): Promise<StreamChunk['usage'] | undefined> {
  if (!usage?.requestId || !platform.provider) return usage;
  try {
    const accepted = await platform.provider.recordUsage({
      requestId: usage.requestId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
    return accepted ? usage : undefined;
  } catch (error) {
    console.warn('[AIClient] Failed to persist provider usage:', error);
    return undefined;
  }
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * M4-8-S5：最大重试次数共享常量（写死，不做设置项）。
 * streamChat（real）/ completeChat（off/pseudo）/ UI 文案的 N 统一引用此常量——
 * brief 文案「reconnect 1/5」暗示 5，最坏退避总等待约 2+4+8+10+10 ≈ 34s 才放弃，
 * 配合气泡 reconnect 进度让等待可见（见 Plan_5 第七节决议2）。
 */
export const MAX_RETRIES = 5;

/** 退避时长（指数，封顶 10s）：第 attempt 次重试前等待 min(1000 * 2^attempt, 10000) ms。 */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 10000);
}

function retryDelay(attempt: number, response?: Response | null): number {
  const fallback = backoffDelay(attempt);
  const raw = response?.headers.get('retry-after')?.trim();
  if (!raw) return fallback;
  const seconds = Number(raw);
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(raw) - Date.now();
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(Math.max(fallback, requested), 60_000);
}

/**
 * M4-8-S1：错误分类——把「可重试性」判定集中到单一可测函数，杜绝散落各处的 status code 判定。
 *
 * 真根因修复（Plan_5 第三节【2】）：旧实现只看 HTTP status，把【被网关包装成 400/422 的上游故障】
 * （body 带 upstream_error / bad gateway / timeout / connection 等文案）误判为「不可重试的参数错」
 * 直接失败、不重连。这里对 400/422 额外看 body 文案：命中保守上游特征词 → 归为可重试 gateway_upstream。
 *
 * 判定优先级（自上而下，命中即返回）：
 *   ① abort（errName==='AbortError' 或 signalAborted）→ 不可重试 aborted（绝不能当网络错重试，
 *      否则 stop 触发重试死循环，见 Plan_5 风险三）。
 *   ② 429 → 可重试 rate_limit。
 *   ③ status >= 500 → 可重试 server_error。
 *   ④ fetch / 流读取异常（有 errName 但非 status，且非 abort）→ 可重试 network。
 *   ⑤ 400/422 且 body 命中上游特征词 → 可重试 gateway_upstream（命中时 console.warn 输出 body 摘要便于真机调参）。
 *   ⑥ 400/422 且 body 无上游特征 → 不可重试 client_error（真参数错）。
 *   ⑦ 401/403 → 不可重试 auth；404 → 不可重试 not_found；其它 → 不可重试 client_error。
 */
export type ErrorCategory =
  | 'usage_quota' | 'rate_limit' | 'server_error' | 'network' | 'gateway_upstream'
  | 'client_error' | 'auth' | 'not_found' | 'aborted';

export interface ErrorClassification {
  retryable: boolean;
  category: ErrorCategory;
  /** 重试耗尽 / 不可重试时给用户的明确文案。 */
  userMessage: string;
}

/** 网关把上游 5xx / 超时 / 连接失败包装成 400/422 时 body 里常见的保守特征词（仅对 400/422 生效）。 */
const UPSTREAM_HINT_WORDS = [
  'upstream_error', 'upstream', 'bad gateway', 'gateway',
  'timeout', 'timed out', 'connection', 'econnreset', 'econnrefused',
  'socket hang up', 'temporarily unavailable', 'service unavailable',
  // ★ H2：补「请求被取消 / 超期」类——网关把上游 context canceled / deadline exceeded 包装成 400/422 时也按可重试处理。
  'context canceled', 'context cancelled', 'deadline exceeded', 'request canceled', 'request cancelled',
];

const TERMINAL_USAGE_QUOTA_PATTERNS = [
  /\b(?:usage_quota|quota_exhausted|billing_hard_limit|resource_exhausted)\b/i,
  /\busage[_ -]?limit\b.{0,80}\b(?:reached|exceeded|hit)\b/i,
  /\b(?:quota|billing|credit|credits|balance|spend limit|hard limit)\b.{0,120}\b(?:exceed|exceeded|reached|depleted|insufficient|required|past due|limit)\b/i,
  /\b(?:exceeded|reached|hit)\b.{0,120}\b(?:quota|usage limit|spend limit|hard limit)\b/i,
  /\binsufficient[_ -]?quota\b/i,
  /\bout of (?:credits|quota)\b/i,
  /(?:额度|配额|用量|余额|点数|账单|欠费).{0,40}(?:不足|耗尽|用完|达到|超过|上限|限制|失效)/i,
];

const TERMINAL_AUTH_ACCOUNT_PATTERNS = [
  /\b(?:authentication_failed|invalid_api_key|unauthenticated|unauthorized|forbidden|permission[_ ]denied|access denied)\b/i,
  /\b(?:incorrect|invalid|expired|revoked)\b.{0,80}\b(?:api key|token|credential|oauth)\b/i,
  /\b(?:api key|token|credential|oauth)\b.{0,80}\b(?:incorrect|invalid|expired|revoked)\b/i,
  /\blogin required\b/i,
  /\baccount\b.{0,100}\b(?:disabled|suspended|deactivated|locked|inactive|not active|not found)\b/i,
  /\borganization\b.{0,100}\b(?:disabled|suspended|deactivated|not active)\b/i,
  /(?:账号|账户|密钥|令牌|凭据|权限|登录).{0,40}(?:无效|过期|撤销|禁用|停用|冻结|未授权|不存在|需要)/i,
];

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function extractProviderErrorText(body?: string): string {
  const raw = typeof body === 'string' ? body.trim() : '';
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as any;
    const candidates = [
      parsed?.error?.message,
      parsed?.error?.errorMessage,
      parsed?.error?.code,
      parsed?.message,
      parsed?.errorMessage,
      parsed?.detail,
      parsed?.reason,
      parsed?.error_description,
    ].map(textValue).filter(Boolean);
    return candidates.length ? candidates.join(' | ') : raw;
  } catch {
    return raw;
  }
}

function errorDetail(body?: string): string {
  return extractProviderErrorText(body).slice(0, 800);
}

function errorDetailSuffix(body?: string): string {
  const detail = errorDetail(body);
  return detail ? `：${detail}` : '';
}

function hasSemanticMatch(body: string | undefined, errName: string | undefined, patterns: RegExp[]): boolean {
  const haystack = [errName ?? '', extractProviderErrorText(body), body ?? ''].join('\n');
  return patterns.some(pattern => pattern.test(haystack));
}

export function classifyError(
  status?: number,
  body?: string,
  errName?: string,
  signalAborted?: boolean,
): ErrorClassification {
  // ① abort 判定——必须是【用户主动停止】（signalAborted = signal.aborted || _userAborted，调用方传 this.aborted）。
  //   ⚠️ H2 修复（图六根因）：服务端/网关取消连接（context canceled 等）时，fetch 在底层也会把异常抛成
  //   errName==='AbortError'，但用户【并没有】点停止。旧逻辑 `errName==='AbortError' || signalAborted` 把这种 API
  //   故障误判成「用户中止」→ 不可重试 + UI 显示「已停止生成」（看着像用户自己停的）。改为只信 signalAborted：
  //   非用户触发的 AbortError 落到下方 status===undefined 的 network 分支 → 可重试，重试耗尽再显示真实网络错文案。
  //   竞态安全：abort() 同步先置 _userAborted=true 再 abortController.abort()，故用户停时 signalAborted 必为真。
  if (signalAborted) {
    return { retryable: false, category: 'aborted', userMessage: 'aborted' };
  }

  if (errName === 'UnsupportedMultimodalRequestError' || errName === 'UnsupportedFileInputError') {
    return {
      retryable: false,
      category: 'client_error',
      userMessage: errName === 'UnsupportedMultimodalRequestError'
        ? '当前模型未确认支持图片，请切换到明确支持 Vision 的模型'
        : '当前模型目录没有可验证的文件输入能力',
    };
  }

  if (errName === 'missing_credential' || errName === 'missing_endpoint' || errName === 'model_not_found') {
    return {
      retryable: false,
      category: errName === 'missing_credential' ? 'auth' : 'client_error',
      userMessage: errName === 'missing_credential'
        ? 'Provider 凭据未配置或已失效'
        : errName === 'missing_endpoint'
          ? 'Provider 端点未配置'
          : '当前模型已失效，请刷新目录后重新选择',
    };
  }

  if (hasSemanticMatch(body, errName, TERMINAL_USAGE_QUOTA_PATTERNS)) {
    return {
      retryable: false,
      category: 'usage_quota',
      userMessage: `🚫 Provider 用量或额度已耗尽${errorDetailSuffix(body || errName)}`,
    };
  }

  if (hasSemanticMatch(body, errName, TERMINAL_AUTH_ACCOUNT_PATTERNS)) {
    return {
      retryable: false,
      category: 'auth',
      userMessage: `🔑 Provider 账号或鉴权不可用${errorDetailSuffix(body || errName)}`,
    };
  }

  // 无 status：fetch / 流读取等抛异常（非 abort，且没有命中终止语义）→ 网络错，可重试。
  if (status === undefined) {
    return {
      retryable: true,
      category: 'network',
      userMessage: `🌐 网络连接异常，请检查网络后重试${errorDetailSuffix(body)}`,
    };
  }

  // ② 限流
  if (status === 429) {
    return { retryable: true, category: 'rate_limit', userMessage: `⏳ 请求过于频繁，请稍后再试（429）${errorDetailSuffix(body)}` };
  }
  // ③ 服务器错误
  if (status >= 500) {
    return { retryable: true, category: 'server_error', userMessage: `🔥 服务器错误（${status}），请稍后重试${errorDetailSuffix(body)}` };
  }
  // ④/⑤ 400 / 422：看 body 文案区分「网关包装的上游故障」vs「真参数错」。
  if (status === 400 || status === 422) {
    const normalized = (body ?? '').toLowerCase();
    const hit = UPSTREAM_HINT_WORDS.some(word => normalized.includes(word));
    if (hit) {
      // 命中上游特征 → 当可重试上游故障；打 warn 摘要便于真机收紧词表。
      console.warn(`[AIClient] HTTP ${status} 命中上游故障特征，按可重试处理。body 摘要:`, (body ?? '').slice(0, 200));
      return {
        retryable: true,
        category: 'gateway_upstream',
        userMessage: `🔁 上游服务暂时不可用（被网关包装为 ${status}），已自动重试${errorDetailSuffix(body)}`,
      };
    }
    return { retryable: false, category: 'client_error', userMessage: `❌ 请求参数错误（${status}）：${(body ?? '').slice(0, 200)}` };
  }
  // ⑥ 鉴权 / 不存在
  if (status === 401 || status === 403) {
    return { retryable: false, category: 'auth', userMessage: `🔑 API Key 无效或已过期，请检查设置（401/403）${errorDetailSuffix(body)}` };
  }
  if (status === 404) {
    return { retryable: false, category: 'not_found', userMessage: `❌ 接口或模型不存在，请检查模型名称（404）${errorDetailSuffix(body)}` };
  }
  // ⑦ 其它 4xx 等 → 不可重试。
  return { retryable: false, category: 'client_error', userMessage: `HTTP ${status}: ${(body ?? '').slice(0, 200)}` };
}

const PSEUDO_STREAM_CHUNK_SIZE: Record<PseudoStreamSpeed, number> = {
  slow: 2,
  medium: 5,
  fast: 10,
};

const PSEUDO_STREAM_DELAY_MS: Record<PseudoStreamSpeed, number> = {
  slow: 55,
  medium: 22,
  fast: 8,
};

function isStreamUnsupported(status: number, text: string): boolean {
  const normalized = text.toLowerCase();
  return [400, 404, 405, 406, 415, 422, 501].includes(status)
    && (
      normalized.includes('stream')
      || normalized.includes('sse')
      || normalized.includes('event-stream')
      || normalized.includes('stream_options')
    );
}

function splitPseudoChunks(text: string, speed: PseudoStreamSpeed): string[] {
  const size = PSEUDO_STREAM_CHUNK_SIZE[speed] ?? PSEUDO_STREAM_CHUNK_SIZE.medium;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export class AIClient {
  private config: AIClientConfig;
  private abortController: AbortController | null = null;
  private _isStreaming = false;
  // ★ P0-2 根因B 加固：用户主动 stop 的显式标志。abort() 会把 abortController 置 null，
  //   此后 `this.abortController?.signal.aborted` 经 ?. 短路成 undefined，classifyError 拿不到「已中止」，
  //   极端时机下可能把用户主动停误判成网络错而重试。该标志独立于 abortController 生命周期，永真兜底。
  private _userAborted = false;

  constructor(config: AIClientConfig) {
    this.config = config;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get providerId(): string {
    return this.config.providerId ?? 'openai';
  }

  get modelId(): string {
    return this.config.model;
  }

  get reasoningEffort(): string | undefined {
    return this.config.reasoningEffort;
  }

  get speedTier(): string | undefined {
    return this.config.speedTier;
  }

  get supportsVision(): boolean {
    return this.config.vision === true;
  }

  get contextWindow(): number | undefined {
    return this.config.contextWindow;
  }

  updateConfig(config: Partial<AIClientConfig>) {
    if (this._isStreaming) {
      console.warn('[AIClient] 生成中禁止切换模型/配置');
      return;
    }
    Object.assign(this.config, config);
  }

  abort() {
    this._userAborted = true; // ★ P0-2：先置位，确保后续 classifyError 即使读不到 signal 也判 aborted。
    this.abortController?.abort();
    this.abortController = null;
    this._isStreaming = false;
  }

  /** P0-2：classifyError 用的「是否已被用户中止」统一口径——signal 与 _userAborted 取或，任一为真即中止。 */
  private get aborted(): boolean {
    return (this.abortController?.signal.aborted ?? false) || this._userAborted;
  }

  private buildBody(messages: ChatMessage[], tools: any[] | undefined, useStream: boolean): any {
    const body: any = {
      model: this.config.model,
      messages,
      stream: useStream,
    };
    // ★ 模型参数门控（诊断#3）：仅当上游显式提供时才写入请求体——不支持该参数的模型由 AgentPanel 传 undefined → 不发。
    //   去掉旧的 `?? 0.7`/`?? 4096` 无条件兜底，兑现面板「不支持的参数不会写入请求」承诺，避免严格端点 400。
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined && this.config.maxTokenParameter) {
      body[this.config.maxTokenParameter] = this.config.maxTokens;
    }
    if (useStream && this.config.streamOptions === true) {
      body.stream_options = { include_usage: true };
    }
    if (this.config.topP !== undefined) body.top_p = this.config.topP;
    if (this.config.reasoningEffort && this.config.reasoningEffort !== 'auto') {
      body.reasoning_effort = this.config.reasoningEffort;
    }
    if (this.config.speedTier && this.config.speedTier !== 'auto') {
      body.service_tier = this.config.speedTier === 'fast' ? 'priority' : this.config.speedTier;
    }
    if (tools?.length) body.tools = tools;
    return body;
  }

  private async requestChat(
    messages: ChatMessage[],
    tools: any[] | undefined,
    useStream: boolean,
    requestTimestamp: number,
  ): Promise<Response> {
    if (!platform.provider) throw new Error('安全 Provider Runtime 仅在 Synapse 桌面版可用');
    return this.requestChatViaProvider(messages, tools, useStream, requestTimestamp);
  }

  private createRequestId(): string {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `provider-chat-${random}`;
  }

  private decodeProviderChunk(encoded: string): Uint8Array {
    const binary = globalThis.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  private async requestChatViaProvider(
    messages: ChatMessage[],
    tools: any[] | undefined,
    useStream: boolean,
    requestTimestamp: number,
  ): Promise<Response> {
    const provider = platform.provider;
    if (!provider) throw new Error('Provider runtime is unavailable');
    const abortSignal = this.abortController?.signal;
    if (!abortSignal || abortSignal.aborted || this._userAborted) {
      const error = new Error('Request aborted before provider start');
      error.name = 'AbortError';
      throw error;
    }
    const containsImage = messages.some(message => Array.isArray(message.content)
      && message.content.some(part => part.type === 'image_url'));
    if (containsImage && this.config.vision !== true) {
      const error = new Error('当前模型未确认支持图片，实际请求已在发送前阻止');
      error.name = 'UnsupportedMultimodalRequestError';
      throw error;
    }
    const containsFile = messages.some(message => Array.isArray(message.content)
      && message.content.some(part => part.type === 'file'));
    if (containsFile) {
      const error = new Error('当前模型目录没有可验证的文件输入能力，实际请求已在发送前阻止');
      error.name = 'UnsupportedFileInputError';
      throw error;
    }

    const requestId = this.createRequestId();
    const cancelToken = crypto.randomUUID();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let unsubscribe: (() => void) | null = null;
    let cleaned = false;
    const handleAbort = () => { void provider.cancelChat({ requestId, cancelToken }); };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      unsubscribe?.();
      abortSignal.removeEventListener('abort', handleAbort);
    };
    const handleEvent = (event: ProviderChatEvent) => {
      if (event.requestId !== requestId || !streamController) return;
      if (event.type === 'data' && event.data) {
        streamController.enqueue(this.decodeProviderChunk(event.data));
        return;
      }
      if (event.type === 'done') {
        streamController.close();
        cleanup();
        return;
      }
      const error = new Error(event.message || 'Provider stream failed');
      error.name = event.code === 'aborted' ? 'AbortError' : (event.code || 'ProviderStreamError');
      streamController.error(error);
      cleanup();
    };
    unsubscribe = provider.onChatEvent(handleEvent);
    if (cleaned) unsubscribe();
    if (abortSignal.aborted || this._userAborted) {
      cleanup();
      const error = new Error('Request aborted before provider start');
      error.name = 'AbortError';
      throw error;
    }
    abortSignal.addEventListener('abort', handleAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        void provider.cancelChat({ requestId, cancelToken });
        cleanup();
      },
    });

    let started: ProviderChatStartResult;
    try {
      if (abortSignal.aborted || this._userAborted) {
        const error = new Error('Request aborted before provider start');
        error.name = 'AbortError';
        throw error;
      }
      started = await provider.startChat({
        requestId,
        cancelToken,
        conversationId: this.config.conversationId,
        runId: this.config.runId,
        callId: requestId,
        ownerId: this.config.ownerId,
        requestKind: this.config.requestKind,
        catalogGeneration: this.config.catalogGeneration,
        compressionGeneration: this.config.compressionGeneration,
        requestTimestamp,
        providerId: this.config.providerId ?? 'openai',
        body: this.buildBody(messages, tools, useStream),
        stream: useStream,
      });
    } catch (error) {
      cleanup();
      throw error;
    }

    const headers = new Headers(started.headers ?? {});
    if (started.request) {
      headers.set('x-synapse-request-id', started.request.requestId);
      if (started.request.conversationId) headers.set('x-synapse-conversation-id', started.request.conversationId);
      if (started.request.runId) headers.set('x-synapse-run-id', started.request.runId);
      if (started.request.callId) headers.set('x-synapse-call-id', started.request.callId);
      if (started.request.ownerId) headers.set('x-synapse-owner-id', started.request.ownerId);
      headers.set('x-synapse-request-kind', started.request.requestKind);
      if (started.request.catalogGeneration) headers.set('x-synapse-catalog-generation', started.request.catalogGeneration);
      if (started.request.compressionGeneration) headers.set('x-synapse-compression-generation', started.request.compressionGeneration);
      headers.set('x-synapse-input-images', JSON.stringify(started.request.inputImages ?? []));
      headers.set('x-synapse-provider-id', started.request.providerId);
      headers.set('x-synapse-model-id', started.request.modelId);
      if (started.request.accountFingerprint) headers.set('x-synapse-account-fingerprint', started.request.accountFingerprint);
      headers.set('x-synapse-credential-generation', String(started.request.credentialGeneration));
      headers.set('x-synapse-body-sha256', started.request.bodySha256);
      headers.set('x-synapse-sent-at', String(started.request.sentAt));
    }
    if (started.error) {
      cleanup();
      const error = new Error(started.error.message);
      error.name = started.error.code === 'aborted' ? 'AbortError' : started.error.code;
      throw error;
    }
    if (!useStream || !started.ok || !started.streaming) {
      cleanup();
      return new Response(started.bodyText ?? '', { status: started.status || 500, headers });
    }
    return new Response(stream, { status: started.status, headers });
  }

  private async waitPseudoDelay(speed: PseudoStreamSpeed): Promise<void> {
    const delay = PSEUDO_STREAM_DELAY_MS[speed] ?? PSEUDO_STREAM_DELAY_MS.medium;
    if (this.abortController?.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(resolve, delay);
      const signal = this.abortController?.signal;
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * M4-8-S1：可中断退避 sleep——退避等待期间用户 stop()（abort signal）能立即中断，
   * 不必干等满 delay（最高 10s）。复用 waitPseudoDelay 的「可中断 sleep」范本：
   * 进入即检查 signal.aborted；等待中监听 abort 立即 reject(AbortError)（由外层 catch 识别为 aborted，
   * 经 classifyError 归为不可重试，杜绝 stop 触发重试死循环，见 Plan_5 风险三）。
   * signal 缺省时取 this.abortController?.signal。
   */
  private async retryableSleep(delay: number, signal?: AbortSignal | null): Promise<void> {
    const sig = signal ?? this.abortController?.signal ?? null;
    if (sig?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(resolve, delay);
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      sig?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async *yieldResponseError(response: Response, errText: string): AsyncGenerator<StreamChunk> {
    const status = response.status;
    if (status === 404) {
      const modelHint = errText.includes('model') ? `模型 "${this.config.model}" 不存在` : '接口不存在';
      yield { type: 'error', error: `❌ ${modelHint}，请检查模型名称（404）${errorDetailSuffix(errText)}` };
      return;
    }
    const cls = classifyError(status, errText, undefined, this.aborted);
    yield { type: 'error', error: cls.userMessage };
  }

  private async *completeChat(
    messages: ChatMessage[],
    tools: any[] | undefined,
    mode: 'pseudo' | 'off',
    requestTimestamp: number,
    fallbackReason?: string,
  ): AsyncGenerator<StreamChunk> {
    // M4-8-S2：非流式路径（off/pseudo）补 retry 覆盖——原先 !ok 直接 yieldResponseError 返回、完全无重试，
    // 与全局「请求要有 retry/重连」决策冲突。这里复用 streamChat 同一套 classifyError + retryableSleep：
    //   - HTTP !ok：classifyError 判定可重试（429/5xx/网关 400-422 upstream）→ yield retry chunk（带 streamMode=mode，
    //     让 agentLoop 知道是非流式重试）→ 可中断退避重试；达上限或不可重试 → yieldResponseError 明确文案。
    //   - fetch / 解析异常：同样进 classifyError。AbortError throw 出去，由 streamChat off/pseudo 外层 catch 统一转 'aborted'
    //     （与现有行为一致），不在此当网络错重试，杜绝 stop 触发重试死循环。
    //   与现有 auto→pseudo 降级互不冲突：那是 streamChat 决定走哪条路，completeChat 只负责本条路内的重试。
    let response: Response;
    let retries = 0;
    while (true) {
      let httpResponse: Response | null = null;
      let fetchErr: any = null;
      try {
        httpResponse = await this.requestChat(messages, tools, false, requestTimestamp);
      } catch (err: any) {
        fetchErr = err;
      }

      if (httpResponse && httpResponse.ok) {
        response = httpResponse;
        break;
      }

      // 统一分类：有 response 用 status+body，否则用 fetch 异常名。
      const status = httpResponse?.status;
      const errText = httpResponse ? await httpResponse.text().catch(() => '') : '';
      const cls = classifyError(
        status,
        httpResponse ? errText : fetchErr?.message,
        fetchErr?.name,
        // ★ H2：用 this.aborted（含 _userAborted 兜底）而非裸 signal.aborted——abort() 会把 abortController 置 null，
        //   裸读 signal.aborted 经 ?. 短路成 undefined 会漏判用户主动停。与 streamChat catch 调用口径统一。
        this.aborted,
      );

      if (cls.category === 'aborted') {
        // 让 streamChat off/pseudo 外层 catch 统一转 'aborted'，与现有中止收尾一致。
        throw new DOMException('Aborted', 'AbortError');
      }

      if (cls.retryable && retries < MAX_RETRIES) {
        retries++;
        const delay = retryDelay(retries, httpResponse);
        yield { type: 'retry', retry: { attempt: retries, maxRetries: MAX_RETRIES, reason: cls.userMessage }, streamMode: mode, fallbackReason };
        await this.retryableSleep(delay, this.abortController?.signal);
        continue;
      }

      // 达上限或不可重试：给明确文案（HTTP 有 response 走 yieldResponseError 复用既有细分文案；
      // 纯 fetch 异常无 response，直接发 classifyError 文案）。
      if (httpResponse) {
        yield* this.yieldResponseError(httpResponse, errText);
      } else {
        yield { type: 'error', error: fetchErr?.message || cls.userMessage, streamMode: mode };
      }
      return;
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message ?? {};
    const speed = this.config.pseudoStreamSpeed ?? 'medium';
    const thinking = message.reasoning_content ?? message.reasoning ?? message.thinking;
    if (thinking) {
      const thinkingText = String(thinking);
      if (mode === 'pseudo' && this.config.streamThinking) {
        for (const part of splitPseudoChunks(thinkingText, speed)) {
          await this.waitPseudoDelay(speed);
          yield { type: 'thinking', thinking: part, streamMode: mode, fallbackReason };
        }
      } else {
        yield { type: 'thinking', thinking: thinkingText, streamMode: mode, fallbackReason };
      }
    }

    if (message.content) {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      if (mode === 'pseudo') {
        for (const part of splitPseudoChunks(content, speed)) {
          await this.waitPseudoDelay(speed);
          yield { type: 'content', content: part, streamMode: mode, fallbackReason };
        }
      } else {
        yield { type: 'content', content, streamMode: mode };
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        yield {
          type: 'tool_call',
          streamMode: mode,
          fallbackReason,
          toolCall: {
            id: tc.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
          },
        };
      }
    }
    if (data.usage) {
      yield {
        type: 'done',
        streamMode: mode,
        fallbackReason,
        usage: await persistNormalizedUsage(normalizeUsage(data, response)),
      };
    } else {
      yield { type: 'done', streamMode: mode, fallbackReason };
    }
  }

  async *streamChat(
    messages: ChatMessage[],
    tools?: any[],
    requestTimestamp = Date.now(),
  ): AsyncGenerator<StreamChunk> {
    this._isStreaming = true;
    this._userAborted = false; // ★ P0-2：每次新流开始清零，避免上一轮 stop 标志污染本轮重试判定。
    this.abortController = new AbortController();
    const strategy = this.config.outputStrategy ?? (this.config.stream === false ? 'off' : 'auto');
    const modelCanStream = this.config.stream !== false;

    if (strategy === 'off') {
      try {
        yield* this.completeChat(messages, tools, 'off', requestTimestamp);
      } catch (err: any) {
        yield { type: 'error', error: this.aborted ? 'aborted' : (err?.message || '网络错误'), streamMode: 'off' };
      } finally {
        this._isStreaming = false;
      }
      return;
    }

    if (strategy === 'pseudo' || (strategy === 'auto' && !modelCanStream)) {
      try {
        yield* this.completeChat(
          messages,
          tools,
          'pseudo',
          requestTimestamp,
          strategy === 'auto' && !modelCanStream ? '当前模型未声明支持真流式，已使用伪流式' : undefined,
        );
      } catch (err: any) {
        yield { type: 'error', error: this.aborted ? 'aborted' : (err?.message || '网络错误'), streamMode: 'pseudo' };
      } finally {
        this._isStreaming = false;
      }
      return;
    }

    if (strategy === 'real' && !modelCanStream) {
      yield { type: 'error', error: '当前模型未声明支持真流式输出，请切换为自动或伪流式。', streamMode: 'off' };
      this._isStreaming = false;
      return;
    }

    let retries = 0;
    const maxRetries = MAX_RETRIES;
    // M4-8 审查修复：是否已向消费者 yield 过实质 content/thinking/tool_call。
    // 一旦为真，说明已有部分输出上屏 + 累积进 agentLoop 的 fullContent；此后真流式读流中途断线
    // 触发的重试会让模型从头重生成整段回复，必须让 agentLoop 先丢弃已发内容（resetContent）再覆盖，
    // 否则「半截旧 + 完整新」拼接污染气泡与 conversation history。仅真流式 read 中途断这一路径需要。
    let streamedAny = false;

    while (retries <= maxRetries) {
      try {
        const response = await this.requestChat(messages, tools, true, requestTimestamp);

        if (!response.ok) {
          const status = response.status;
          const errText = await response.text().catch(() => '');

          // 优先级① 真流式不支持 → auto 降级伪流式（最高优先，先于重试判定）。
          if (strategy === 'auto' && isStreamUnsupported(status, errText)) {
            yield* this.completeChat(messages, tools, 'pseudo', requestTimestamp, `真流式请求失败，已降级伪流式：HTTP ${status}`);
            this._isStreaming = false;
            return;
          }

          // M4-8-S1：优先级② 用统一 classifyError 判定可重试性（替换散落的 429/5xx/404 分支）。
          // 把「被网关包装成 400/422 的上游故障」（body 命中特征词）纳入可重试 gateway_upstream，修真根因。
          const cls = classifyError(status, errText, undefined, this.aborted);
          if (cls.retryable) {
            retries++;
            if (retries <= maxRetries) {
              const delay = retryDelay(retries, response);
              // 重试前发进度事件（让 UI 显示「reconnect N/M」而非干等）。
              yield { type: 'retry', retry: { attempt: retries, maxRetries, reason: cls.userMessage }, streamMode: 'real' };
              // 可中断退避：用户 stop 时立即抛 AbortError，由外层 catch 识别为 aborted。
              await this.retryableSleep(delay, this.abortController?.signal);
              continue;
            }
            // 重试耗尽：可重试错也要给明确文案；auto 流式可再降级伪流式兜底。
            if (strategy === 'auto') {
              yield* this.completeChat(messages, tools, 'pseudo', requestTimestamp, `真流式重试耗尽，已降级伪流式：${cls.userMessage}`);
              this._isStreaming = false;
              return;
            }
            yield { type: 'error', error: cls.userMessage, streamMode: 'real' };
            this._isStreaming = false;
            return;
          }
          // 优先级③ 不可重试 → yieldResponseError（复用既有细分文案，如 404 带模型名、401/403 Key 提示）。
          yield* this.yieldResponseError(response, errText);
          this._isStreaming = false;
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          if (strategy === 'auto') {
            yield* this.completeChat(messages, tools, 'pseudo', requestTimestamp, '端点未返回可读流，已降级伪流式');
            this._isStreaming = false;
            return;
          }
          yield { type: 'error', error: '无法读取响应流' };
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const toolCalls: Map<number, ToolCallRequest> = new Map();
        // ★ P0-2 根因A：是否收到过服务器明确的结束信号（finish_reason 非空 或 [DONE]）。
        //   用于在 reader 自然 done 时区分「正常完成」与「上游中途静默掐断」。
        let sawFinish = false;
        let finalUsage: StreamChunk['usage'] | undefined;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            const eventData = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : null;
            if (!trimmed || eventData === '[DONE]') {
              if (eventData === '[DONE]') {
                // Emit accumulated tool calls
                for (const tc of toolCalls.values()) {
                  streamedAny = true;
                  yield { type: 'tool_call', toolCall: tc, streamMode: 'real' };
                }
                yield { type: 'done', streamMode: 'real', usage: await persistNormalizedUsage(finalUsage) };
                this._isStreaming = false;
                return;
              }
              continue;
            }
            if (eventData === null) continue;

            try {
              const data = JSON.parse(eventData);
              // Usage chunks may arrive without delta when stream_options.include_usage is enabled.
              if (data.usage) {
                finalUsage = normalizeUsage(data, response) ?? finalUsage;
              }
              // ★ P0-2 根因A：先捕获 finish_reason（OpenAI 标准在最后一个 chunk 给出，此时 delta 常为空对象 {}），
              //   必须放在 `if (!delta) continue` 之前，否则空 delta 的结束 chunk 会被跳过、漏标 sawFinish。
              const choice = data.choices?.[0];
              if (choice?.finish_reason) sawFinish = true;
              const delta = choice?.delta;
              if (!delta) continue;

              if (delta.content) {
                streamedAny = true;
                yield { type: 'content', content: delta.content, streamMode: 'real' };
              }

              const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
              if (thinking) {
                streamedAny = true;
                yield { type: 'thinking', thinking: String(thinking), streamMode: 'real' };
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCalls.has(idx)) {
                    toolCalls.set(idx, {
                      id: tc.id ?? `call_${idx}`,
                      type: 'function',
                      function: { name: '', arguments: '' },
                    });
                  }
                  const existing = toolCalls.get(idx)!;
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.function.name += tc.function.name;
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                }
              }

            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        // ★ P0-2 根因A（治本「回答说一半突然停」）：reader 自然返回 done=true 而非抛错。
        //   若全程从未收到 finish_reason、也无 [DONE]，但已 yield 过实质内容（streamedAny）——
        //   说明上游/网关在生成完成前【静默掐断】了连接（TCP 正常关闭，read 返回 done 不抛异常），
        //   内容被截断。抛进下面 catch 当可重试网络错（重连重发 + resetContent），
        //   而不是把半截内容当正常 done 收尾。
        //   注：标准 OpenAI 兼容端点必发 [DONE] 或 finish_reason 之一；仅 streamedAny 时判定，空响应不误伤。
        if (!sawFinish) {
          throw new Error(streamedAny || toolCalls.size > 0
            ? 'STREAM_TRUNCATED: 上游在生成完成前中断连接（无 finish_reason/[DONE]）'
            : 'EMPTY_STREAM: 上游关闭了空流（没有有效内容或结束事件）');
        }
        // 正常结束（端点不发 [DONE] 但给了 finish_reason，或合法空响应）。
        for (const tc of toolCalls.values()) {
          yield { type: 'tool_call', toolCall: tc, streamMode: 'real' };
        }
        yield { type: 'done', streamMode: 'real', usage: await persistNormalizedUsage(finalUsage) };
        this._isStreaming = false;
        return;

      } catch (err: any) {
        // M4-8-S1：fetch / 流读取异常统一进 classifyError。AbortError（含可中断退避抛出的）
        // 归为不可重试 aborted——绝不当网络错重试，杜绝 stop 触发重试死循环（Plan_5 风险三）。
        const cls = classifyError(undefined, err?.message, err?.name, this.aborted);
        if (!cls.retryable) {
          // aborted：发 'aborted' 让 agentLoop 走中止收尾分支；其它不可重试（理论上 catch 这里只会是 abort）给文案。
          yield { type: 'error', error: cls.category === 'aborted' ? 'aborted' : (err?.message || cls.userMessage) };
          this._isStreaming = false;
          return;
        }
        retries++;
        if (retries > maxRetries) {
          if (strategy === 'auto') {
            // M4-8 审查修复：读流中途断线已上屏部分内容时，降级伪流式会一次性吐全量，
            // 同样会拼接到半截旧内容后。先发 resetContent 让 agentLoop 清空已发内容再覆盖。
            if (streamedAny) {
              yield { type: 'retry', retry: { attempt: maxRetries, maxRetries, reason: '已达重连上限，重置后改用伪流式重发' }, streamMode: 'pseudo', resetContent: true };
            }
            yield* this.completeChat(messages, tools, 'pseudo', requestTimestamp, `真流式连接失败，已降级伪流式：${err.message || '网络错误'}`);
            this._isStreaming = false;
            return;
          }
          yield { type: 'error', error: err.message || cls.userMessage };
          this._isStreaming = false;
          return;
        }
        const delay = backoffDelay(retries);
        // 网络异常重试前发进度事件。
        // M4-8 审查修复（问题2/3）：真流式读流【中途】断线（已 yield 过实质内容 streamedAny）重试时，
        // 重发会让模型从头重生成整段回复。带 resetContent 让 agentLoop 先清空本轮已上屏/已累积内容，
        // 重试后的新流覆盖而非追加，杜绝「半截旧 + 完整新」拼接污染气泡与 conversation history。
        yield {
          type: 'retry',
          retry: { attempt: retries, maxRetries, reason: err?.message ? `连接异常（${String(err.message).slice(0, 60)}）` : cls.userMessage },
          streamMode: 'real',
          resetContent: streamedAny,
        };
        // 已发过内容则重发等价于「从头重来」，重置标志，重试连接再次 yield 才重新置位。
        streamedAny = false;
        // 可中断退避：用户 stop 时立即抛 AbortError。
        // M4-8 审查修复（问题1）：catch 块尾退避不像 HTTP !ok 退避（line 512）那样有外层 try 兜底——
        // 此处单独包 try/catch，abort 时与 HTTP !ok 退避路径对齐：干净 yield aborted 收尾后 return，
        // 不让 AbortError 逃逸出 while 与整个 generator（否则一路落到 agentLoop 顶层 catch，
        // 会先塞一条假 error 事件污染 run 历史，再靠 this.running===false 这个外部不变量兜回 aborted）。
        try {
          await this.retryableSleep(delay, this.abortController?.signal);
        } catch (sleepErr: any) {
          const sleepCls = classifyError(undefined, sleepErr?.message, sleepErr?.name, this.aborted);
          if (sleepCls.category === 'aborted') {
            yield { type: 'error', error: 'aborted', streamMode: 'real' };
            this._isStreaming = false;
            return;
          }
          // 理论上 retryableSleep 只会抛 AbortError；其它异常保守按不可重试失败处理，不再 continue。
          yield { type: 'error', error: sleepErr?.message || sleepCls.userMessage, streamMode: 'real' };
          this._isStreaming = false;
          return;
        }
      }
    }
  }

  static getEndpoint(provider: string): string {
    return DEFAULT_ENDPOINTS[provider] ?? DEFAULT_ENDPOINTS.openai;
  }

  /**
   * 从 API 动态获取可用模型列表
   * 自动清洗某些 API（如聚光）在模型 ID 中嵌入的价格前缀 [xxx]
   */
  static async fetchModels(
    _baseUrl: string,
    providerId = 'openai',
    force = true,
    throwOnFailure = false,
  ): Promise<AIModelOption[]> {
    try {
      if (!platform.provider) throw new Error('安全 Provider Runtime 仅在 Synapse 桌面版可用');
      const response = providerId === 'openai-codex'
        ? await platform.provider.openAICodexModels(force)
        : providerId === 'windsurf'
          ? await platform.provider.windsurfModels(force)
        : await platform.provider.fetchModels(providerId, force);
      if (!response.ok) {
        const error = new Error(`fetchModels failed: HTTP ${response.status}`);
        if (throwOnFailure) throw error;
        console.error(`[AIClient] ${error.message}`);
        return [];
      }
      const data = JSON.parse(response.bodyText ?? '{}');
      const models = data.data ?? data;
      if (!Array.isArray(models)) {
        if (throwOnFailure) throw new Error('fetchModels returned an invalid catalog');
        return [];
      }

      const normalized = models
        .map((model: any) => normalizeModelOption({
          ...(typeof model === 'string' ? { id: model } : model),
          __synapseProviderId: providerId,
          __synapseCatalog: response.catalog,
        }))
        .filter(Boolean) as AIModelOption[];
      return [...new Map(normalized.map(model => [model.id, model])).values()];
    } catch (err: any) {
      if (throwOnFailure) throw err;
      console.error('[AIClient] fetchModels error:', err.message);
      return [];
    }
  }
}
