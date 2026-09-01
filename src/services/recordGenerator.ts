/**
 * Record Generator
 * M1 上下文 harness：把「即将被压缩」的一批消息调一次 LLM 浓缩成结构化 markdown 过程日志。
 *
 * 产出固定模板：用户意图 / 关键决策 / 工具调用与结果摘要 / 产出文件清单。
 *
 * ★ 契约（务必遵守，多批次架构 generateBatch）：
 *   `input.messages` 永远只是【本批被压缩的切片】，绝不是从第 1 轮起的全量历史。
 *   不喂整段已有全文让模型合并覆盖全程；改喂 `priorSkeleton` 旧批骨架【只读概览】，
 *   模型只就本批新原文产出【本批自己】的独立日志 → 已有批次永不重写、批间不重复、cache 稳定前缀保住。
 *   区间（round/step start/end）由调用方（agentLoop）依据水位自算后透传 appendBatch，本函数不返回累计水位。
 *
 * 关键约束（Plan_4 M1 风险 3）：
 *   生成是「加速 / 增强」能力，绝不能阻塞主对话。
 *   任何失败（无 Key、网络错误、模型报错、解析异常、输出不合格）一律降级返回 null，
 *   由调用方回退到字符截断压缩。
 */

import { AIClient, type ChatMessage } from './aiClient';
import { store } from '@/store';
import {
  extractSkeleton,
  rememberRecordGenerationIdentity,
  sameRecordGenerationIdentity,
  type RecordGenerationIdentity,
} from './recordStore';
import { resolveSystemModel } from './modelResolution';
import { capabilityBoundClientOptions, resolveProviderModel } from './providerModelRuntime';

/** 参与生成的单条消息（取自 store 的 Message 子集，避免耦合完整类型） */
export interface RecordSourceMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
  /** 工具调用（assistant 发起） */
  toolCalls?: Array<{ name?: string; arguments?: string; result?: string; status?: string }>;
  attachmentAnchors?: Array<{
    kind: 'image' | 'file';
    ordinal: number;
    sha256?: string;
    mime?: string;
    bytes?: number;
    name?: string;
    recoverable: boolean;
  }>;
}

/** record 生成模型一次性能力上限（按 OpenAI 兼容端常见上下文留余量，估字符） */
const MAX_SOURCE_CHARS = 120_000;
/** 单条消息正文截断上限，防止超长工具输出/代码块撑爆 prompt */
const PER_MESSAGE_CHARS = 4_000;
/** 生成调用的整体超时（毫秒），超时即降级 */
const GENERATE_TIMEOUT_MS = 60_000;
/** 生成结果正文字符上限：模板要求 1200 字以内，留约 4 倍冗余兜底，超出视为跑飞 */
const MAX_OUTPUT_CHARS = 6_000;
/** record 正文必须包含的标题锚点，缺失视为模型未遵守模板 */
const REQUIRED_HEADING = '# 对话过程日志';

function roleLabel(role: RecordSourceMessage['role']): string {
  switch (role) {
    case 'user': return '用户';
    case 'assistant': return 'AI';
    case 'tool': return '工具结果';
    case 'system': return '系统';
    default: return role;
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…(已截断)` : text;
}

function formatTimestamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 计算本批消息的时间窗 [最早, 最晚]，无有效时间戳返回 [null, null] */
function computeTimeBounds(messages: RecordSourceMessage[]): [number | null, number | null] {
  const times = messages.map(m => m.timestamp).filter((t): t is number => typeof t === 'number' && t > 0);
  if (times.length === 0) return [null, null];
  return [Math.min(...times), Math.max(...times)];
}

/** 解析 "start ~ end" 跨度字符串两端的展示文本（已格式化，不再是时间戳） */
function parseTimeSpan(span?: string | null): [string, string] {
  if (!span) return ['', ''];
  const idx = span.indexOf('~');
  if (idx < 0) return [span.trim(), span.trim()];
  return [span.slice(0, idx).trim(), span.slice(idx + 1).trim()];
}

/**
 * 把本批时间窗与已有跨度合并：起点取「更早」、终点取「更晚」。
 * 已有跨度两端已是格式化字符串（无原始时间戳），用字典序近似比较——
 * "YYYY-MM-DD HH:mm" 格式下字典序与时间序一致，足够概览用途。
 */
function mergeTimeSpan(prior: string | null | undefined, batch: RecordSourceMessage[]): string {
  const [batchMin, batchMax] = computeTimeBounds(batch);
  const batchStart = formatTimestamp(batchMin ?? undefined);
  const batchEnd = formatTimestamp(batchMax ?? undefined);
  const [priorStart, priorEnd] = parseTimeSpan(prior);

  const starts = [priorStart, batchStart].filter(Boolean);
  const ends = [priorEnd, batchEnd].filter(Boolean);
  const start = starts.length ? starts.reduce((a, b) => (a <= b ? a : b)) : '';
  const end = ends.length ? ends.reduce((a, b) => (a >= b ? a : b)) : '';
  if (!start && !end) return '';
  return start && end ? `${start} ~ ${end}` : start || end;
}

/** 把消息序列化成喂给生成模型的对话正文（含工具调用摘要、按字符预算截断） */
function serializeMessages(messages: RecordSourceMessage[]): string {
  const parts: string[] = [];
  let budget = MAX_SOURCE_CHARS;
  for (const msg of messages) {
    if (budget <= 0) {
      parts.push('…(更早内容因长度限制省略)');
      break;
    }
    const segments: string[] = [];
    const text = truncate(msg.content ?? '', PER_MESSAGE_CHARS);
    if (text) segments.push(text);
    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        const name = tc.name || '未知工具';
        const args = truncate(tc.arguments ?? '', 600);
        const result = truncate(tc.result ?? '', 800);
        segments.push(
          `〔工具调用〕${name}` +
          (args ? `\n  参数: ${args}` : '') +
          (result ? `\n  结果: ${result}` : '') +
          (tc.status ? `\n  状态: ${tc.status}` : ''),
        );
      }
    }
    if (Array.isArray(msg.attachmentAnchors)) {
      for (const anchor of msg.attachmentAnchors) {
        segments.push(`〔附件锚点〕${JSON.stringify(anchor)}`);
      }
    }
    if (segments.length === 0) continue;
    const block = `[${roleLabel(msg.role)}] ${segments.join('\n')}`;
    parts.push(block);
    budget -= block.length;
  }
  return parts.join('\n\n');
}

const TEMPLATE_RULES = `## 输出模板（严格遵守）

按下列固定结构输出纯 markdown 过程日志，不要用代码块包裹整个输出：

# 对话过程日志

## 用户意图
- 用要点概括用户在这段对话里想达成的目标（按出现顺序）

## 关键决策
- 列出 AI 做出的重要判断、方案选择、取舍及理由

## 工具调用与结果摘要
- 按时间顺序概括关键工具调用：做了什么、关键参数、得到什么结果（失败也记）
- 同类重复调用可合并；无工具调用则写「无」

## 产出文件清单
- 列出新建/修改/删除的文件路径及一句话说明；无则写「无」

要求：
1. 客观、信息密度高，省略寒暄与无关细节
2. 保留关键事实（文件路径、命令、报错、数字、决策理由）
3. 不要臆造未在对话中出现的内容
4. 全文控制在 1200 字以内`;

/**
 * M2-R1 批次日志 prompt：本批【独立完整】日志语义。
 * - 旧批骨架（priorSkeleton）只读概览，仅供模型理解上文、避免重复，【绝不要把它合并进输出】。
 * - 仅就「本批新增对话内容」产出本批自己的过程日志，不重揉旧全文（防膨胀 + 命中下一轮 cache 稳定前缀）。
 */
function buildBatchPrompt(
  input: GenerateBatchInput,
  body: string,
  roundStart: number,
  roundEnd: number,
  priorSkeleton: string,
): string {
  const skeletonSection = priorSkeleton.trim()
    ? `## 已有历史批次骨架（只读上下文，帮助你理解上文，【不要】把它写进输出）

${priorSkeleton.trim()}

`
    : '';
  return `你是一个技术过程记录助手。请把「本批新增对话内容」浓缩成一份【独立完整】的「对话过程日志」，供后续轮次的 AI 快速回顾这一批发生的工作。

${skeletonSection}${TEMPLATE_RULES}

特别要求（多批次架构）：
1. 只记录「本批新增对话内容」里发生的事，不要复述上面的历史骨架。
2. 本批日志要能独立阅读，不依赖未在本批出现的细节。

## 元数据（写入日志开头，逐字使用）
- 工作区: ${input.workspaceName || '（未指定）'}
- 本批轮次: 第 ${roundStart} ~ ${roundEnd} 轮

## 本批新增对话内容

${body}`;
}

/**
 * 从 store 的 settings slice 解析出可用的 AIClient 配置；缺 Key 返回 null。
 *
 * ★ R5 可中止安全前提（务必保持）：本函数【每次都 new 一个独立 AIClient 实例】，绝不复用/缓存。
 *   这条压缩调用拿到的 client 与【主对话 client】（agentLoop 构造时持有的那一个）、以及其它任何
 *   record 调用的 client 完全隔离。因此 callOnce 在中止/超时时直接 `client.abort()` 只会中断【本次压缩】
 *   的底层 LLM 请求，不会误伤主对话或并发的其它 record 生成。若将来改成复用/缓存 client，
 *   abort 语义会破裂——必须改为「为本次压缩传入独立 signal 的安全路径」，否则会误中断他人请求。
 */
export interface RecordGenerationRuntime extends RecordGenerationIdentity {
  selectionId: string;
  baseUrl: string;
  temperature?: number;
  maxTokens?: number;
  maxTokenParameter?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  stream: boolean;
  streamOptions: boolean;
}

export function captureRecordGenerationRuntime(): RecordGenerationRuntime | null {
  const state = store.getState() as any;
  const settings = state?.settings;
  const selectionId = resolveSystemModel(state);
  const runtime = resolveProviderModel(
    selectionId,
    state?.agentSettings?.availableModels,
    settings?.providerCredentials,
    settings?.apiEndpoints,
  );
  if (!runtime.configured || !runtime.modelId) return null;
  const bounded = capabilityBoundClientOptions(runtime, { temperature: 0.2, maxTokens: 2048, stream: false });
  const credential = settings?.providerCredentials?.[runtime.providerId];
  return {
    selectionId,
    providerId: runtime.providerId,
    modelId: runtime.modelId,
    baseUrl: runtime.baseUrl,
    catalogGeneration: runtime.option?.catalog?.generation ?? null,
    accountFingerprint: typeof credential?.accountFingerprint === 'string' && credential.accountFingerprint
      ? credential.accountFingerprint
      : null,
    credentialGeneration: Number.isFinite(Number(credential?.credentialGeneration))
      ? Math.max(0, Math.round(Number(credential?.credentialGeneration)))
      : 0,
    temperature: bounded.temperature,
    maxTokens: bounded.maxTokens,
    maxTokenParameter: bounded.maxTokenParameter,
    stream: bounded.stream,
    streamOptions: bounded.streamOptions,
  };
}

export function sameRecordGenerationRuntime(
  left: RecordGenerationRuntime | null | undefined,
  right: RecordGenerationRuntime | null | undefined,
): boolean {
  return sameRecordGenerationIdentity(left, right);
}

export function isRecordGenerationRuntimeCurrent(runtime: RecordGenerationRuntime): boolean {
  return sameRecordGenerationRuntime(runtime, captureRecordGenerationRuntime());
}

function resolveClient(
  conversationId: string,
  runId: string,
  frozenRuntime?: RecordGenerationRuntime,
): AIClient | null {
  const runtime = frozenRuntime ?? captureRecordGenerationRuntime();
  if (!runtime) return null;
  // 低 temperature + 关闭流式，稳定一次性产出
  return new AIClient({
    providerId: runtime.providerId,
    conversationId,
    runId,
    ownerId: `record:${conversationId}`,
    requestKind: 'record',
    catalogGeneration: runtime.catalogGeneration ?? undefined,
    baseUrl: runtime.baseUrl,
    model: runtime.modelId,
    temperature: runtime.temperature,
    maxTokens: runtime.maxTokens,
    maxTokenParameter: runtime.maxTokenParameter,
    stream: runtime.stream,
    streamOptions: runtime.streamOptions,
    outputStrategy: 'off',
  });
}

/**
 * 非流式收集一次完整回复；遇到 error chunk 抛出，超时抛出，外部 abort 抛出。
 *
 * R5 可中止：Promise.race 三方竞争——collect（正常收集）/ timeout（60s 兜底）/ abort（外部 signal）。
 *   - 任一 abort 触发（signal 已 aborted 或运行中收到 abort 事件）→ 立即 `client.abort()` 中断底层
 *     LLM fetch，并 reject(Error('aborted'))，调用方据此降级返回 null。
 *   - timeout 与 abort 都靠 `client.abort()` 真正掐断网络请求（client 为本次压缩独立实例，见 resolveClient）。
 *   - 进入前若 signal 已 aborted，直接抛出，连请求都不发。
 */
async function callOnce(client: AIClient, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  // 进入即检查：已中止则连请求都不发
  if (signal?.aborted) throw new Error('aborted');

  let content = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.abort();
      reject(new Error('record generation timeout'));
    }, GENERATE_TIMEOUT_MS);
  });

  // abort 竞争项：外部 signal 触发 → 掐断底层请求 + reject。无 signal 时永不 settle（不干扰其它两路）。
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      client.abort();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const collect = (async () => {
    for await (const chunk of client.streamChat(messages)) {
      if (chunk.type === 'content' && chunk.content) content += chunk.content;
      if (chunk.type === 'error') throw new Error(chunk.error || 'record generation error');
    }
    return content;
  })();

  try {
    return await Promise.race([collect, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 轻量净化 + 校验模型输出。
 * - 若整体被 ``` 代码块包裹则剥离外层围栏；
 * - 必须包含 `# 对话过程日志` 标题，否则视为未遵守模板；
 * - 超长（明显跑飞）视为不合格。
 * 不合格返回 null，由调用方降级。
 */
function sanitizeOutput(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  // 剥离把整段内容包进 ``` / ```markdown 的外层围栏（仅当首尾都是围栏时）
  if (text.startsWith('```')) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline > 0 && text.endsWith('```')) {
      text = text.slice(firstNewline + 1, text.length - 3).trim();
    }
  }
  if (!text) return null;

  if (!text.includes(REQUIRED_HEADING)) return null;
  if (text.length > MAX_OUTPUT_CHARS) return null;
  return text;
}

/**
 * 统计模板 4 个固定小节之外的额外 `##` 二级标题数（弱语义概览信号）。
 * 模板本身固定含 4 个 `##`，故这里减去命中的固定小节，正常返回 0。
 */
function countSections(md: string): number {
  const headings = md.match(/^##\s+(.+)$/gm) ?? [];
  const fixed = new Set(['用户意图', '关键决策', '工具调用与结果摘要', '产出文件清单', '附件锚点', '输出模板（严格遵守）']);
  let extra = 0;
  for (const h of headings) {
    const title = h.replace(/^##\s+/, '').trim();
    if (!fixed.has(title)) extra += 1;
  }
  return extra;
}

/**
 * M2-R1 批次生成入参：只描述【本批切片】，区间由调用方（agentLoop）依据水位自算后透传。
 * 不传 existingRecordMd 整段全文，改传 priorSkeleton 只读骨架（已有批次永不重写、批间不重复）。
 */
export interface GenerateBatchInput {
  conversationId: string;
  /** 本批要浓缩的消息切片（与上一批不重叠），含 tool 轮次 */
  messages: RecordSourceMessage[];
  /** 旧批骨架拼接（只读概览，帮助模型理解上文、避免重复，不进输出），可空 */
  priorSkeleton?: string | null;
  /** 本批用户轮次起点（含，1 起），由调用方自算透传 */
  roundStart: number;
  /** 本批用户轮次终点（含），由调用方自算透传 */
  roundEnd: number;
  /** 工作区名（写入元数据，可空） */
  workspaceName?: string;
  /** BPC 拍快照时冻结的系统模型运行时；缺省仅供同步手动压缩现取。 */
  generationRuntime?: RecordGenerationRuntime;
}

/** M2-R1 批次生成结果：仅本批自身内容与派生信号，区间由调用方持有后传 appendBatch */
export interface GenerateBatchResult {
  /** 本批独立完整过程日志 markdown */
  contentMd: string;
  /** 本批骨架（正则本地提取，零成本） */
  skeleton: string;
  /** 模板小节数概览信号（弱语义，正常 0） */
  phases: number;
  /** 本批时间跨度 "start ~ end"（可空） */
  timeSpan: string;
}

/**
 * 生成【单个批次】的独立过程日志（M2-R1 多批次架构压缩点专用）。
 *
 * 多批次架构要点：
 *   - 不喂整段全文让模型合并覆盖全程；只喂 priorSkeleton 旧批骨架【只读概览】，
 *     模型只就本批新原文产出【本批自己】的日志 → 已有批次永不重写、批间不重复、cache 稳定前缀保住。
 *   - 不返回累计水位；区间（round/step start/end）由 agentLoop 持有后透传 appendBatch。
 *
 * R5 可中止：可选 signal 透传到 callOnce。调用方（agentLoop）在用户 stop 时 abort 该 signal，
 *   本函数随即返回 null（abort/超时/失败统一降级口径），调用方据此走【不 appendBatch】回退路径，
 *   record 保持压缩前状态、apiHistory 走字符截断或旧 record 前缀，绝不丢 store.messages。
 *
 * @returns 成功返回 GenerateBatchResult；任何失败/中止/输出不合格返回 null（调用方据此降级）。
 */
export async function generateBatch(
  input: GenerateBatchInput,
  signal?: AbortSignal,
): Promise<GenerateBatchResult | null> {
  try {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (messages.length === 0) return null;
    // 进入即检查：已中止则不浪费一次 LLM 调用
    if (signal?.aborted) return null;

    const runtime = input.generationRuntime ?? captureRecordGenerationRuntime();
    if (!runtime) {
      console.warn('[recordGenerator] 缺少可用 API Key / 模型，跳过 batch 生成');
      return null;
    }
    if (!isRecordGenerationRuntimeCurrent(runtime)) {
      console.warn('[recordGenerator] 模型/账号身份已变化，跳过 batch 生成');
      return null;
    }

    const client = resolveClient(
      input.conversationId,
      `record:${input.roundStart}-${input.roundEnd}`,
      runtime,
    );
    if (!client) {
      console.warn('[recordGenerator] 缺少可用 API Key / 模型，跳过 batch 生成');
      return null;
    }

    const body = serializeMessages(messages);
    if (!body.trim()) return null;

    const timeSpan = mergeTimeSpan(null, messages);
    const prompt = buildBatchPrompt(
      input,
      body,
      Math.max(1, input.roundStart),
      Math.max(input.roundStart, input.roundEnd),
      String(input.priorSkeleton ?? ''),
    );

    const generatedContentMd = sanitizeOutput(await callOnce(client, [{ role: 'user', content: prompt }], signal));
    if (!isRecordGenerationRuntimeCurrent(runtime)) {
      console.warn('[recordGenerator] batch 返回后模型/账号身份已变化，丢弃本批结果');
      return null;
    }
    if (!generatedContentMd) {
      console.warn('[recordGenerator] batch 输出不合格（缺模板头/超长/为空），降级');
      return null;
    }
    const anchors = messages.flatMap(message => message.attachmentAnchors ?? []);
    const anchorSection = anchors.length > 0
      ? `\n\n## 附件锚点\n${anchors.map(anchor => `- ${JSON.stringify(anchor)}`).join('\n')}`
      : '\n\n## 附件锚点\n- 无';
    const contentMd = `${generatedContentMd}${anchorSection}`;
    rememberRecordGenerationIdentity(input.conversationId, contentMd, runtime);

    return {
      contentMd,
      skeleton: extractSkeleton(contentMd),
      phases: countSections(contentMd),
      timeSpan,
    };
  } catch (err) {
    console.warn('[recordGenerator] generateBatch failed, falling back:', err);
    return null;
  }
}
