/**
 * Record Store
 * M2 上下文 harness 的 record 层数据访问（多批次追加架构）。
 *
 * record 是「给模型读」的结构化对话过程日志（markdown），用于在压缩点之前
 * 把已发生的历史浓缩成稳定前缀，命中 prompt cache。
 *
 * ★ M2-R1 重构：从「单条 contentMd 合并全文」改为「多批次追加」。
 *   - record = 有序批次列表 batches[]，每次压缩只【追加新批次到末尾】，已有批次永不重写。
 *   - 新批次生成输入 = 旧批骨架（只读概览）+ 本批新增原文，不再重喂全量原文让模型覆盖全程。
 *   - 防膨胀靠「改读不改写」：每批两形态——全文 contentMd / 骨架 skeleton（正则零成本提取）。
 *   - 派生水位 totalRounds/totalSteps/lastUpdatedRound/timeSpan = 末批，append 时同步。
 *
 * ★ DB 懒迁移（零丢失）：旧单条 record（content_md 非空、schema_version<2）被 getRecord 读到时，
 *   即时合成 1 个历史批次返回 schemaVersion=2 + batches=[该批]；旧 content_md 列保留不删（回滚保险）、
 *   不强制只读时回写（下次压缩 appendBatch 自然回写）。
 *
 * step 口径全程对齐「不含 tool」（RecordBatch.stepStart/stepEnd / agentLoop requestHistory /
 * clampToBatch keptSteps），任一漂移会导致批次边界与回溯保留错位。
 *
 * 数据访问统一走 platform 抽象：Electron 落 SQLite records 表，Web 落 localStorage。
 */

import { platform } from '@/platform';
import { store } from '@/store';
import { resolveSystemModel } from './modelResolution';
import { resolveProviderModel } from './providerModelRuntime';

/** 当前 record schema 版本：2 = 多批次架构 */
export const RECORD_SCHEMA_VERSION = 2;

/**
 * 单个 record 批次：一次压缩浓缩出的【独立完整过程日志】。
 * 批次有序排列，压缩只 append 末尾、已有批次永不重写。
 */
export interface RecordBatch {
  /** 批次序号（从 0 起，连续递增） */
  index: number;
  /** 本批覆盖的用户轮次起点（含，1 起） */
  roundStart: number;
  /** 本批覆盖的用户轮次终点（含） */
  roundEnd: number;
  /** 本批覆盖的步骤起点（不含 tool，对齐 agentLoop requestHistory 口径；= 上一批 stepEnd） */
  stepStart: number;
  /** 本批覆盖的步骤终点（不含 tool；= stepStart + 本批参与消息条数） */
  stepEnd: number;
  /** 本批独立完整过程日志（markdown） */
  contentMd: string;
  /** 本批骨架（正则从 contentMd 提取：## 标题 + 每节首行要点），渐进式读降级用 */
  skeleton: string;
  /** 模板小节数概览信号（弱语义，正常 0） */
  phases: number;
  /** 本批时间跨度 "YYYY-MM-DD HH:mm ~ YYYY-MM-DD HH:mm"（可空字符串） */
  timeSpan: string;
  /** 本批创建时间（秒级 Unix 时间戳，与全库统一单位） */
  createdAt: number;
  /**
   * ★ R-L4 折叠（设计B）：本批是【被折叠的原始批】——留库（record_read/getBatch/UI 仍可取回全文），
   *   但不进 buildStableRecordPrefix 注入视图（被元批 meta 代表）。缺省 false。
   */
  archived?: boolean;
  /**
   * ★ R-L4 折叠（设计B）：本批是【合成元批】——把最老 K 个原始批的 skeleton 本地拼接成 1 个超级老批，
   *   进注入视图（按位置走三级分层），但不参与派生水位（buildRecord/appendBatch 取「最后一个非 meta 批」）。缺省 false。
   */
  meta?: boolean;
  /** ★ R-L4 折叠（设计B）：本元批覆盖的原始批 index 列表（UI/调试/解折叠用）。仅 meta 批非空，缺省 []。 */
  foldedFrom?: number[];
  /**
   * ★ M5-BPC：本批来源——'auto'（90% 硬阈值自动压缩）/ 'manual'（手动 /compact）/ 'bpc'（后台预压缩）。
   *   随 batch 进 batches_json 整 JSON blob 落库（records 表非拆列，零迁移）；旧批缺省读回 'auto'。
   *   仅供 UI（CompactDivider 分隔线，BPC-7）按来源区分三态渲染，不参与水位/边界逻辑。
   */
  source?: 'auto' | 'manual' | 'bpc';
  /**
   * ★ #14 动态分级（hit 反馈）：本批被 mark_record_hit 标记「正是当前需要的上下文」的累计次数。缺省 0。
   *   随 batch 进 batches_json 整 JSON blob 落库（零迁移，旧批缺省读回 0）。
   *   ★ cache 关键：hitCount【不进 renderRecordPrefix 渲染】——它只在【压缩点】computeRenderLevels 算 renderLevel 时被读，
   *     故 mark_record_hit 写库改 hitCount 绝不破 else 分支（每轮 run）的 prompt cache 稳定性（渲染只看 renderLevel）。
   */
  hitCount?: number;
  /**
   * ★ #14 动态分级（hit 反馈）：本批最近一次被 mark_record_hit 标记时的【当前对话轮号】。缺省 0（从未命中）。
   *   computeRenderLevels 据此判「命中是否新近」（近期命中 + 距离近 → 更可能升 full）。同样【不进渲染】，只在压缩点算分时用。
   */
  lastHitRound?: number;
  /**
   * ★ #14 动态分级（固化决策）：本批在【上一个压缩点】算出的渲染档位——'full'（全文 contentMd）/
   *   'summary'（骨架 skeleton）/ 'brief'（仅标题 titleOnly）。缺省 undefined = 未算过动态分级（旧批 / 开关关）→
   *   renderRecordPrefix 回退纯静态位置分层（与改造前逐字一致，向后兼容）。
   *   ★ cache 关键（方案①）：renderLevel 只在【压缩点】computeRenderLevels 写一次（依据当时轮号 + hit），两次压缩间不变 →
   *     renderRecordPrefix 只读 renderLevel（不读 hit/距离/当前轮号）→ 同一批集合每轮输出逐字相同 → prompt cache 稳定。
   *     动态量（距离当前轮、实时 hit）被隔离在压缩点重算，绝不进每轮的渲染路径。随 batch 进 JSON blob 落库（零迁移）。
   */
  renderLevel?: 'full' | 'summary' | 'brief';
}

/** record 数据模型（多批次架构，运行态 / 持久化对等结构，camelCase） */
export interface SynapseRecord {
  /** 对话 ID（主键） */
  conversationId: string;
  /** 有序批次列表，压缩只 append 末尾、已有永不重写 */
  batches: RecordBatch[];
  /** 派生水位：覆盖到的总轮次（= 末批 roundEnd） */
  totalRounds: number;
  /** 派生水位：覆盖到的总步骤（不含 tool，= 末批 stepEnd） */
  totalSteps: number;
  /** 派生水位：已覆盖到第几轮（= 末批 roundEnd），增量压缩水位线 */
  lastUpdatedRound: number;
  /** 派生：整段时间跨度（首批起 ~ 末批止） */
  timeSpan: string;
  /** schema 版本（2 = 多批次） */
  schemaVersion: number;
  /** 正式 Record 修订号；每次成功写入递增，用作候选发布的父版本校验。 */
  revision: number;
  /** 最近一次写入时间（秒级 Unix 时间戳） */
  updatedAt: number;
  /**
   * 派生只读字段：各批 contentMd 拼接的全文。
   * ★ 不再是真相源——仅为兼容旧调用方/调试保留；真相源是 batches[]。
   */
  contentMd: string;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 各批 contentMd 拼接成派生全文（批次间用分隔线） */
const BATCH_JOIN = '\n\n---\n\n';

export interface RecordGenerationIdentity {
  providerId: string;
  modelId: string;
  catalogGeneration: string | null;
  accountFingerprint: string | null;
  credentialGeneration: number;
}

const pendingRecordGenerationIdentities = new Map<string, RecordGenerationIdentity>();
const PENDING_IDENTITY_LIMIT = 64;

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCredentialGeneration(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
}

export function normalizeRecordGenerationIdentity(
  identity: Partial<RecordGenerationIdentity> | null | undefined,
): RecordGenerationIdentity | null {
  const providerId = typeof identity?.providerId === 'string' ? identity.providerId.trim() : '';
  const modelId = typeof identity?.modelId === 'string' ? identity.modelId.trim() : '';
  const credentialGeneration = normalizeCredentialGeneration(identity?.credentialGeneration);
  if (!providerId || !modelId || credentialGeneration === null) return null;
  return {
    providerId,
    modelId,
    catalogGeneration: normalizeNullableString(identity?.catalogGeneration),
    accountFingerprint: normalizeNullableString(identity?.accountFingerprint),
    credentialGeneration,
  };
}

export function sameRecordGenerationIdentity(
  left: Partial<RecordGenerationIdentity> | null | undefined,
  right: Partial<RecordGenerationIdentity> | null | undefined,
): boolean {
  const a = normalizeRecordGenerationIdentity(left);
  const b = normalizeRecordGenerationIdentity(right);
  return Boolean(a && b
    && a.providerId === b.providerId
    && a.modelId === b.modelId
    && a.catalogGeneration === b.catalogGeneration
    && a.accountFingerprint === b.accountFingerprint
    && a.credentialGeneration === b.credentialGeneration);
}

function recordIdentityContentHash(contentMd: string): string {
  let hash = 2166136261;
  const source = String(contentMd ?? '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function pendingIdentityKey(conversationId: string, contentMd: string): string {
  return `${conversationId}\0${recordIdentityContentHash(contentMd)}`;
}

export function rememberRecordGenerationIdentity(
  conversationId: string,
  contentMd: string,
  identity: Partial<RecordGenerationIdentity> | null | undefined,
): void {
  const normalized = normalizeRecordGenerationIdentity(identity);
  if (!conversationId || !contentMd || !normalized) return;
  pendingRecordGenerationIdentities.set(pendingIdentityKey(conversationId, contentMd), normalized);
  while (pendingRecordGenerationIdentities.size > PENDING_IDENTITY_LIMIT) {
    const oldest = pendingRecordGenerationIdentities.keys().next().value;
    if (!oldest) break;
    pendingRecordGenerationIdentities.delete(oldest);
  }
}

function takeRecordGenerationIdentity(conversationId: string, contentMd: string): RecordGenerationIdentity | null {
  const key = pendingIdentityKey(conversationId, contentMd);
  const identity = pendingRecordGenerationIdentities.get(key) ?? null;
  pendingRecordGenerationIdentities.delete(key);
  return identity;
}

function captureCurrentRecordGenerationIdentity(): RecordGenerationIdentity | null {
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
  return normalizeRecordGenerationIdentity({
    providerId: runtime.providerId,
    modelId: runtime.modelId,
    catalogGeneration: runtime.option?.catalog?.generation ?? null,
    accountFingerprint: settings?.providerCredentials?.[runtime.providerId]?.accountFingerprint ?? null,
    credentialGeneration: settings?.providerCredentials?.[runtime.providerId]?.credentialGeneration ?? 0,
  });
}

export function isRecordGenerationIdentityCurrent(identity: Partial<RecordGenerationIdentity> | null | undefined): boolean {
  return sameRecordGenerationIdentity(identity, captureCurrentRecordGenerationIdentity());
}

function joinBatchContents(batches: RecordBatch[]): string {
  return batches.map(b => b.contentMd).filter(Boolean).join(BATCH_JOIN);
}

/** 解析 "start ~ end" 跨度字符串两端 */
function splitSpan(span?: string): [string, string] {
  if (!span) return ['', ''];
  const idx = span.indexOf('~');
  if (idx < 0) return [span.trim(), span.trim()];
  return [span.slice(0, idx).trim(), span.slice(idx + 1).trim()];
}

/** 把多批 timeSpan 合并成整段跨度：起点取首个非空 start、终点取最后非空 end */
function deriveTimeSpan(batches: RecordBatch[]): string {
  const starts: string[] = [];
  const ends: string[] = [];
  for (const b of batches) {
    const [s, e] = splitSpan(b.timeSpan);
    if (s) starts.push(s);
    if (e) ends.push(e);
  }
  const start = starts.length ? starts.reduce((a, b) => (a <= b ? a : b)) : '';
  const end = ends.length ? ends.reduce((a, b) => (a >= b ? a : b)) : '';
  if (!start && !end) return '';
  return start && end ? `${start} ~ ${end}` : start || end;
}

/**
 * 从 contentMd 本地正则提取骨架：保留每个 `## 二级标题` + 该节首行要点（零成本，不调 LLM）。
 * 用于渐进式读把中段批次降级为骨架，控制注入膨胀。
 */
export function extractSkeleton(contentMd: string): string {
  if (!contentMd || !contentMd.trim()) return '';
  const lines = contentMd.split(/\r?\n/);
  const out: string[] = [];
  // 保留一级标题（# 对话过程日志 等）作为骨架头
  for (const line of lines) {
    if (/^#\s+/.test(line)) { out.push(line.trim()); break; }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      out.push(line.trim());
      // 找该节首行非空要点
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^#{1,6}\s+/.test(next)) break; // 到下一个标题止
        if (next.trim()) { out.push(`  ${next.trim()}`); break; }
      }
    }
  }
  return out.join('\n').trim();
}

/**
 * ★ R-L1：从 contentMd 本地正则提取【仅标题级】骨架——保留首个 `# 一级标题` + 所有 `## 二级标题`，
 *   丢弃 extractSkeleton 会附带的「每节首行要点」。量纲约为 extractSkeleton 骨架的 1/3，用于 R-L2
 *   三级分层把最老中间批进一步降级（titleOnly），进一步压缩 record 注入前缀。
 *   纯正则、零 LLM，与 extractSkeleton 并列。★ 渲染侧对 batch.contentMd 实时调用（不固化进 RecordBatch、
 *   不改 extractSkeleton 口径），保证既有 skeleton 落库与 prompt cache 稳定性不受影响。
 */
export function extractSkeletonTitle(contentMd: string): string {
  if (!contentMd || !contentMd.trim()) return '';
  const lines = contentMd.split(/\r?\n/);
  const out: string[] = [];
  // 一级标题（骨架头）
  for (const line of lines) {
    if (/^#\s+/.test(line)) { out.push(line.trim()); break; }
  }
  // 所有二级标题（仅标题行，不附每节首行要点）
  for (const line of lines) {
    if (/^##\s+/.test(line)) out.push(line.trim());
  }
  return out.join('\n').trim();
}

/** upsert 入参：整条覆盖（底层写，含 batches） */
export interface RecordUpsertInput {
  conversationId: string;
  batches: RecordBatch[];
  /** 可选覆盖 schemaVersion，缺省 RECORD_SCHEMA_VERSION */
  schemaVersion?: number;
  /** 仅更新不进入渲染前缀的弱语义元数据时保留请求代次。 */
  preserveRevision?: boolean;
}

/** appendBatch 入参：本批生成结果（不含 index/stepStart——由 store 依据末批派生） */
export interface AppendBatchInput {
  conversationId: string;
  /** 本批步骤起点（不含 tool）——必须 == 末批 stepEnd（无批为 0），否则视脏写拒绝 */
  stepStart: number;
  /** 本批步骤终点（不含 tool） */
  stepEnd: number;
  /** 本批用户轮次起点（含） */
  roundStart: number;
  /** 本批用户轮次终点（含） */
  roundEnd: number;
  /** 本批独立完整过程日志 */
  contentMd: string;
  /** 本批骨架（缺省由 extractSkeleton 本地提取） */
  skeleton?: string;
  /** 模板小节数（弱语义，缺省 0） */
  phases?: number;
  /** 本批时间跨度（缺省空） */
  timeSpan?: string;
  /** ★ M5-BPC：本批来源（'auto'|'manual'|'bpc'）。缺省 'auto'，随 batch 进 JSON blob 落库。 */
  source?: 'auto' | 'manual' | 'bpc';
  /** 与 Record 水位同一事务保存的完整消息快照，避免崩溃后 Record 超前于原始消息。 */
  messages?: unknown[];
}

export interface PrepareAppendCandidateInput extends AppendBatchInput {
  candidateId: string;
  inputHash: string;
  sourceStepCursor: number;
  sourceRoundCursor: number;
  generationIdentity?: Partial<RecordGenerationIdentity>;
}

export interface PreparedRecordCandidate extends RecordGenerationIdentity {
  conversationId: string;
  candidateId: string;
  parentRevision: number;
  inputHash: string;
  sourceStepCursor: number;
  sourceRoundCursor: number;
  record: SynapseRecord;
}

export interface ContextGenerationState {
  conversationId: string;
  state: string;
  schedulerState: string;
  candidateId: string | null;
  parentRevision: number;
  publishedRevision: number;
  sourceStepCursor: number;
  sourceRoundCursor: number;
  inputHash: string | null;
  providerId: string | null;
  modelId: string | null;
  catalogGeneration: string | null;
  accountFingerprint: string | null;
  credentialGeneration: number | null;
  retryCount: number;
  backoffUntil: number | null;
  hardPaused: boolean;
  cooldownUntil: number | null;
  circuitBroken: boolean;
  lastReplaceStepCursor: number | null;
  immediateRetriggerCount: number;
  lastError: string | null;
  updatedAt: number;
}

export type ContextGenerationStatePatch = Partial<Pick<ContextGenerationState,
  | 'state'
  | 'schedulerState'
  | 'parentRevision'
  | 'publishedRevision'
  | 'sourceStepCursor'
  | 'sourceRoundCursor'
  | 'inputHash'
  | 'providerId'
  | 'modelId'
  | 'catalogGeneration'
  | 'accountFingerprint'
  | 'credentialGeneration'
  | 'retryCount'
  | 'backoffUntil'
  | 'hardPaused'
  | 'cooldownUntil'
  | 'circuitBroken'
  | 'lastReplaceStepCursor'
  | 'immediateRetriggerCount'
  | 'lastError'
>>;

/** 把 RecordBatch 的 source 规范成合法枚举值（非法/缺省 → 'auto'）。 */
function normalizeSource(raw: unknown): 'auto' | 'manual' | 'bpc' {
  return raw === 'manual' || raw === 'bpc' ? raw : 'auto';
}

/** 把任意原始批次行规范成 RecordBatch */
function normalizeBatch(raw: unknown, fallbackIndex: number): RecordBatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const contentMd = String(b.contentMd ?? b.content_md ?? '');
  const skeleton = String(b.skeleton ?? '') || extractSkeleton(contentMd);
  // ★ R-L4：archived/meta 默认 false、foldedFrom 默认 []（旧持久化无此三字段时按缺省读回，行为同改造前）。
  const rawFolded = b.foldedFrom ?? b.folded_from;
  const foldedFrom = Array.isArray(rawFolded)
    ? rawFolded.map(v => toNumber(v)).filter(n => Number.isFinite(n))
    : [];
  return {
    index: toNumber(b.index, fallbackIndex),
    roundStart: toNumber(b.roundStart ?? b.round_start),
    roundEnd: toNumber(b.roundEnd ?? b.round_end),
    stepStart: toNumber(b.stepStart ?? b.step_start),
    stepEnd: toNumber(b.stepEnd ?? b.step_end),
    contentMd,
    skeleton,
    phases: toNumber(b.phases),
    timeSpan: String(b.timeSpan ?? b.time_span ?? ''),
    createdAt: toNumber(b.createdAt ?? b.created_at, nowSec()),
    archived: Boolean(b.archived ?? b.is_archived ?? false),
    meta: Boolean(b.meta ?? b.is_meta ?? false),
    foldedFrom,
    // ★ M5-BPC：来源随 JSON blob 读回，旧批（无此字段）缺省 'auto'。
    source: normalizeSource(b.source),
    // ★ #14 动态分级：hit 反馈 + 固化档位随 JSON blob 读回，旧批（无此字段）缺省 0/0/undefined（→ 回退静态分层）。
    hitCount: Math.max(0, toNumber(b.hitCount ?? b.hit_count, 0)),
    lastHitRound: Math.max(0, toNumber(b.lastHitRound ?? b.last_hit_round, 0)),
    renderLevel: normalizeRenderLevel(b.renderLevel ?? b.render_level),
  };
}

/** ★ #14：把任意原始值规范成合法 renderLevel 枚举（非法/缺省 → undefined = 未算动态分级，回退静态分层）。 */
function normalizeRenderLevel(raw: unknown): 'full' | 'summary' | 'brief' | undefined {
  return raw === 'full' || raw === 'summary' || raw === 'brief' ? raw : undefined;
}

/**
 * ★ R-L4 折叠核心坑：派生水位 / 幂等门所依据的「真实末批」必须【排除 meta 元批】。
 *   元批 index = 末批+1 → sort 后排在数组尾；元批的 step/round 是其 foldedFrom 原始批的并集区间。
 *   若把元批当末批派生 totalSteps/totalRounds，会把水位拍成「并集值（= 折叠那 K 批的旧区间，远小于真实末批）」
 *   → 下次 appendBatch 的 expectedStepStart=末批 stepEnd 幂等门错位 → 静默丢批 / 脏写拒绝。
 *   故派生水位与 appendBatch 续接都用 lastRealBatch（最后一个非 meta 批）。
 */
function lastRealBatch(sorted: RecordBatch[]): RecordBatch | undefined {
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!sorted[i].meta) return sorted[i];
  }
  return undefined;
}

/** 由 batches 派生出完整 SynapseRecord（统一水位/timeSpan/contentMd 派生口径） */
function buildRecord(
  conversationId: string,
  batches: RecordBatch[],
  updatedAt: number,
  revision = 0,
): SynapseRecord {
  const sorted = [...batches].sort((a, b) => a.index - b.index);
  // ★ R-L4：派生水位排除 meta 元批——真实末批 = 最后一个非 meta 批（见 lastRealBatch 注释）。
  const last = lastRealBatch(sorted);
  // ★ R-L4：派生只读 timeSpan/contentMd 排除 meta 元批——元批 contentMd 是其 foldedFrom 原始批 skeleton 的
  //   本地拼接（注入视图产物），原始批（含 archived）的真实全文仍在 sorted 里；把元批拼进派生全文会与
  //   archived 原文重复且污染时间跨度。getRecord/getBatch/record_read/UI 读全量 batches（不过滤 archived），
  //   满足「原文留库可展开、UI 完整可见」；派生 contentMd 仅兼容旧调用方/调试，按真实批口径即可。
  const realBatches = sorted.filter(b => !b.meta);
  return {
    conversationId,
    batches: sorted,
    totalRounds: last?.roundEnd ?? 0,
    totalSteps: last?.stepEnd ?? 0,
    lastUpdatedRound: last?.roundEnd ?? 0,
    timeSpan: deriveTimeSpan(realBatches),
    schemaVersion: RECORD_SCHEMA_VERSION,
    revision,
    updatedAt,
    contentMd: joinBatchContents(realBatches),
  };
}

/**
 * 把 platform 返回的原始行规范成 SynapseRecord，并执行【懒迁移】。
 * - 已是 v2（有 batches_json / schemaVersion>=2）→ 直接解析 batches。
 * - 旧 v1（content_md 非空、无 batches）→ 即时合成 1 个历史批次 batch{index:0,
 *   roundStart:1, roundEnd:totalRounds, stepStart:0, stepEnd:totalSteps,
 *   contentMd:旧全文, skeleton:正则提取}，返回 schemaVersion=2。
 *   旧 content_md 列保留不删（回滚保险），不在读时强制回写。
 */
function normalizeRecord(raw: unknown): SynapseRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const conversationId = String(row.conversationId ?? row.conversation_id ?? '');
  if (!conversationId) return null;

  const updatedAt = toNumber(row.updatedAt ?? row.updated_at, nowSec());
  const revision = Math.max(0, toNumber(row.revision, 0));
  const schemaVersion = toNumber(row.schemaVersion ?? row.record_schema_version ?? row.schema_version, 1);

  // 解析批次：可能是 batches 数组（运行态/web）或 batches_json 字符串（SQLite 行）
  let rawBatches: unknown = row.batches;
  if (rawBatches === undefined && typeof row.batches_json === 'string') {
    try { rawBatches = JSON.parse(row.batches_json as string); } catch { rawBatches = null; }
  }

  if (Array.isArray(rawBatches) && rawBatches.length > 0) {
    const batches = rawBatches
      .map((b, i) => normalizeBatch(b, i))
      .filter((b): b is RecordBatch => b !== null);
    if (batches.length > 0) return buildRecord(conversationId, batches, updatedAt, revision);
  }

  // —— 懒迁移：v1 单条 record → 合成 1 个历史批次 ——
  const legacyContent = String(row.contentMd ?? row.content_md ?? '');
  if (legacyContent.trim() && schemaVersion < RECORD_SCHEMA_VERSION) {
    const totalRounds = toNumber(row.totalRounds ?? row.total_rounds);
    const totalSteps = toNumber(row.totalSteps ?? row.total_steps);
    let phases = toNumber(row.phases);
    if (!Number.isFinite(phases) || phases < 0) phases = 0;
    const timeSpan = String(row.timeSpan ?? row.time_span ?? '');
    const historicalBatch: RecordBatch = {
      index: 0,
      roundStart: 1,
      roundEnd: totalRounds,
      stepStart: 0,
      stepEnd: totalSteps,
      contentMd: legacyContent,
      skeleton: extractSkeleton(legacyContent),
      phases,
      timeSpan,
      createdAt: updatedAt,
    };
    return buildRecord(conversationId, [historicalBatch], updatedAt, revision);
  }

  // 无批次、无旧全文 → 空 record，视作不存在
  return null;
}

/**
 * 读取某对话的 record（含懒迁移）；不存在返回 null。
 * 任何底层异常都吞掉返回 null —— record 是加速层，绝不能阻塞主对话。
 */
export async function getRecord(conversationId: string): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  try {
    const raw = await platform.conversation.getRecord?.(conversationId);
    return normalizeRecord(raw);
  } catch (err) {
    console.warn('[recordStore] getRecord failed:', err);
    return null;
  }
}

/**
 * 同 getRecord，但【不吞底层异常】——读失败时抛出，让调用方区分「确实不存在(null)」与「读失败(throw)」。
 *
 * ★ R5 修复（问题4）：appendBatch 的幂等水位（expectedStepStart = 末批 stepEnd）依赖这次读到的真实 record。
 *   若用吞异常的 getRecord，瞬时 IPC/IO 抖动会把「实际有旧批」误读成 null → 期望 stepStart==0，
 *   而调用方传入的 stepStart=priorSteps>0 → 幂等校验判脏写拒绝、静默丢批；或新对话恰好 priorSteps=0
 *   时把本应接续的批当首批写入、step 错位。故 appendBatch 改用本函数：读失败直接降级（不基于错误水位写）。
 *   返回 null 仅表示「确实不存在」（normalizeRecord 判定为空 record），与读失败语义分离。
 */
async function getRecordOrThrow(conversationId: string): Promise<SynapseRecord | null> {
  const raw = await platform.conversation.getRecord?.(conversationId);
  return normalizeRecord(raw);
}

async function deleteRecordOrThrow(conversationId: string): Promise<void> {
  const deleted = await platform.conversation.deleteRecord?.(conversationId);
  if (deleted === false) throw new Error(`Record delete failed: ${conversationId}`);
}

async function upsertRecordOrThrow(input: RecordUpsertInput): Promise<SynapseRecord | null> {
  if (!input?.conversationId) throw new Error('Record upsert requires conversationId');
  const batches = (input.batches ?? [])
    .map((b, i) => normalizeBatch(b, i))
    .filter((b): b is RecordBatch => b !== null)
    .sort((a, b) => a.index - b.index);
  if (batches.length === 0) {
    await deleteRecordOrThrow(input.conversationId);
    return null;
  }
  const record = buildRecord(input.conversationId, batches, nowSec());
  const write = await platform.conversation.saveRecord?.(
    toPersistShape(record, undefined, undefined, undefined, input.preserveRevision),
  );
  if (write === false || (typeof write === 'object' && write && write.written === false)) {
    throw new Error(`Record upsert was rejected: ${input.conversationId}`);
  }
  const revision = typeof write === 'object' && write && typeof write.revision === 'number'
    ? write.revision
    : record.revision + 1;
  return { ...record, revision };
}

/**
 * 写入 / 覆盖 record —— 纯持久化层（整条覆盖语义，含 batches）。
 * ★ 职责边界：本函数只做派生水位计算 + 落盘，不做内容生成/合并/追加语义。
 *   追加走 appendBatch、回溯裁剪走 clampToBatch。
 * 成功返回写入后的最新 record，失败返回 null（不抛）。
 */
export async function upsertRecord(input: RecordUpsertInput): Promise<SynapseRecord | null> {
  try {
    return await upsertRecordOrThrow(input);
  } catch (err) {
    console.warn('[recordStore] upsertRecord failed:', err);
    return null;
  }
}

/**
 * 落盘形状：携带 batches（运行态结构）+ 派生水位 + schemaVersion，platform 层各自序列化。
 *
 * @param expectedStepStart 可选的【乐观并发水位门】（仅 appendBatch 传）：
 *   要求落盘时 DB 当前 total_steps（= 末批 stepEnd）必须 == 本值，否则不写、返回 false。
 *   把幂等校验下推到底层单次写入（Electron 走 SQL `ON CONFLICT DO UPDATE ... WHERE total_steps=?`、
 *   Web 走 setItem 前内存比对），杜绝「读改写」交错窗口：两路并发压缩各自读到同一 priorSteps，
 *   第一路写入推进 total_steps 后，第二路写入因 WHERE 不匹配被拒，不再后写覆盖先写。
 *   不传（undefined）= 整条无条件覆盖（upsertRecord / clampToBatch 用），保持原语义。
 */
function toPersistShape(
  record: SynapseRecord,
  expectedStepStart?: number,
  expectedRevision?: number,
  messages?: unknown[],
  preserveRevision?: boolean,
): Record<string, unknown> {
  return {
    conversationId: record.conversationId,
    batches: record.batches,
    contentMd: record.contentMd, // 派生只读，供旧 content_md 列回写（回滚保险）
    totalRounds: record.totalRounds,
    totalSteps: record.totalSteps,
    // 乐观并发水位门（仅 appendBatch 传，整条覆盖路径不传 → undefined → 底层无条件写）
    expectedStepStart,
    expectedRevision,
    messages,
    preserveRevision,
    // phases 真相源 = 各 RecordBatch.phases；这里的全批求和【仅为派生只读统计】（兼容旧 phases_json 列 / 调试）。
    // ★ 读回时 normalizeRecord 一律从 batches[].phases 取每批值，绝不用本标量回填批次（标量无法拆回各批）。
    //   仅 v1 懒迁移（无 batches）分支才用它合成那 1 个历史批的 phases。
    phases: record.batches.reduce((s, b) => s + (b.phases || 0), 0),
    lastUpdatedRound: record.lastUpdatedRound,
    timeSpan: record.timeSpan,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

/**
 * 追加一个新批次到 record 末尾（压缩点调用）。
 * ★ 不变式：只追加末批、已有批次零改动零重写；幂等防脏写。
 *   - 幂等校验：本批 stepStart 必须 == 末批 stepEnd（无批则 0），否则视脏写拒绝（为 fallback 重入预留）。
 *   - index 由末批 index+1 派生（无批则 0），调用方不需关心。
 * 成功返回追加后的最新 record，校验失败/异常返回 null（不抛）。
 *
 * ★ R5 崩溃恢复依赖（务必维持，否则压缩点不再「崩溃可恢复」）：
 *   本函数把【整个 record（旧批 + 新批）】一次性交给 saveRecord 落盘，落盘必须是【原子】操作——
 *     - Electron：platform → record:upsert 单条 INSERT...ON CONFLICT DO UPDATE，better-sqlite3 单语句即单事务，
 *       进程在写中途崩溃也不会留下「写了一半的 batches_json」（要么旧值、要么新值整体）。
 *     - Web：platform → writeWebRecord 单次 localStorage.setItem(整对象 JSON 字符串)，同样整体写入。
 *   叠加上面的【幂等】校验（stepStart == 末批 stepEnd），即可保证：「generateBatch 成功但 saveRecord 崩溃」时，
 *   重启后 getRecord 拿到的是压缩前一致态，下一次压缩仍从同一 priorSteps 重算本批——不重复、不丢、不脏写。
 *   若将来改为「分多次写库」或非原子写入，这条恢复保证会破裂，必须用显式事务包住整批写入。
 */
export async function appendBatch(input: AppendBatchInput): Promise<SynapseRecord | null> {
  if (!input?.conversationId) return null;

  // ★ R5 修复（问题4 上半）：读 record 用【不吞异常】的 getRecordOrThrow，区分「确实不存在」与「读失败」。
  //   读失败（IPC/IO 抖动）时直接降级返回 null（不基于错误水位写），由 agentLoop 走前缀回退——
  //   绝不在读失败的情况下按 stepStart==0 误判首批而脏写/错位写。
  let existing: SynapseRecord | null;
  try {
    existing = await getRecordOrThrow(input.conversationId);
  } catch (err) {
    console.warn('[recordStore] appendBatch 读取 record 失败，降级不写（交由调用方前缀回退）:', err);
    return null;
  }

  try {
    const prevBatches = existing?.batches ?? [];
    // ★ R-L4 核心坑：末批续接（幂等门 + index 派生）必须取【最后一个非 meta 真实批】。
    //   元批 index = 末批+1 排在数组尾，但其 step/round 是折叠那 K 批的旧并集区间；若误当末批，
    //   expectedStepStart 会被拍成元批 stepEnd（远小于真实水位）→ 正常续接的新批被判脏写拒绝 → 静默丢批。
    const sortedPrev = [...prevBatches].sort((a, b) => a.index - b.index);
    const lastBatch = lastRealBatch(sortedPrev);
    const expectedStepStart = lastBatch?.stepEnd ?? 0;

    // 幂等防脏写（本地快速失败）：本批起点必须严格接续末批终点。
    // 这是【串行重入 + 本地读到的水位】这一层的防线；并发交错的最终防线在底层写入的乐观水位门（见下方 saveRecord）。
    if (input.stepStart !== expectedStepStart) {
      console.warn(
        `[recordStore] appendBatch 脏写拒绝：stepStart=${input.stepStart} != 末批 stepEnd=${expectedStepStart}`,
      );
      return existing; // 不破坏已有 record，原样返回
    }
    if (input.stepEnd <= input.stepStart) {
      console.warn('[recordStore] appendBatch 空批次（stepEnd<=stepStart），跳过');
      return existing;
    }

    // ★ R-L4 核心坑：index 必须取【全批（含 meta）最大 index + 1】保证全局唯一。
    //   若沿用「真实末批 index+1」，折叠后元批占了 lastReal+1，新真实批又算 lastReal+1 → 与元批 index 撞，
    //   getBatch/record_read 按 index 查会取到错的批、UI 分隔线错位。故 index 单调取整个数组最大值续。
    const maxIndex = sortedPrev.reduce((m, b) => Math.max(m, b.index), -1);
    const nextIndex = maxIndex + 1;
    const contentMd = String(input.contentMd ?? '');
    const newBatch: RecordBatch = {
      index: nextIndex,
      roundStart: input.roundStart,
      roundEnd: input.roundEnd,
      stepStart: input.stepStart,
      stepEnd: input.stepEnd,
      contentMd,
      skeleton: input.skeleton?.trim() || extractSkeleton(contentMd),
      phases: input.phases ?? 0,
      timeSpan: input.timeSpan ?? '',
      createdAt: nowSec(),
      // ★ M5-BPC：本批来源（缺省 'auto'）随 batch 进 batches_json 落库；UI 据此区分分隔线三态。
      source: normalizeSource(input.source),
    };
    const merged = [...prevBatches, newBatch];
    const record = buildRecord(input.conversationId, merged, nowSec(), existing?.revision ?? 0);
    // ★ R5 修复（问题4 下半）：把幂等水位门 expectedStepStart 下推到底层单次原子写入。
    //   saveRecord 返回 false = DB 当前 total_steps != expectedStepStart（本批读取后已被并发的另一路压缩推进），
    //   说明发生了交错并发——本路放弃写入（不后写覆盖先写），返回读取时的 existing 快照（合法压缩前状态）。
    const wrote = await platform.conversation.saveRecord?.(
      toPersistShape(record, input.stepStart, existing?.revision ?? 0, input.messages),
    );
    if (wrote === false || (typeof wrote === 'object' && wrote && wrote.written === false)) {
      console.warn(
        `[recordStore] appendBatch 并发水位门拒绝：DB 末批 stepEnd 已被另一路推进（expected=${input.stepStart}），放弃本批写入。`,
      );
      return existing;
    }
    const revision = typeof wrote === 'object' && wrote && typeof wrote.revision === 'number'
      ? wrote.revision
      : (existing?.revision ?? 0) + 1;
    return { ...record, revision };
  } catch (err) {
    console.warn('[recordStore] appendBatch failed:', err);
    return null;
  }
}

export async function prepareAppendCandidate(
  input: PrepareAppendCandidateInput,
): Promise<PreparedRecordCandidate | null> {
  if (!input?.conversationId || !input.candidateId || !input.inputHash) return null;
  const generationIdentity = normalizeRecordGenerationIdentity(input.generationIdentity)
    ?? takeRecordGenerationIdentity(input.conversationId, String(input.contentMd ?? ''));
  if (!generationIdentity) {
    console.warn('[recordStore] prepareAppendCandidate 缺少冻结模型/账号身份，拒绝准备候选');
    return null;
  }
  if (!isRecordGenerationIdentityCurrent(generationIdentity)) {
    console.warn('[recordStore] prepareAppendCandidate 发现模型/账号身份已变化，拒绝准备候选');
    return null;
  }
  let existing: SynapseRecord | null;
  try {
    existing = await getRecordOrThrow(input.conversationId);
  } catch (err) {
    console.warn('[recordStore] prepareAppendCandidate 读取正式 Record 失败:', err);
    return null;
  }

  try {
    const prevBatches = existing?.batches ?? [];
    const sortedPrev = [...prevBatches].sort((a, b) => a.index - b.index);
    const lastBatch = lastRealBatch(sortedPrev);
    const expectedStepStart = lastBatch?.stepEnd ?? 0;
    if (input.stepStart !== expectedStepStart || input.stepEnd <= input.stepStart) return null;

    const nextIndex = sortedPrev.reduce((max, batch) => Math.max(max, batch.index), -1) + 1;
    const contentMd = String(input.contentMd ?? '');
    const newBatch: RecordBatch = {
      index: nextIndex,
      roundStart: input.roundStart,
      roundEnd: input.roundEnd,
      stepStart: input.stepStart,
      stepEnd: input.stepEnd,
      contentMd,
      skeleton: input.skeleton?.trim() || extractSkeleton(contentMd),
      phases: input.phases ?? 0,
      timeSpan: input.timeSpan ?? '',
      createdAt: nowSec(),
      source: normalizeSource(input.source),
    };
    const parentRevision = existing?.revision ?? 0;
    const record = buildRecord(
      input.conversationId,
      [...prevBatches, newBatch],
      nowSec(),
      parentRevision,
    );
    const response = await platform.conversation.prepareRecordCandidate?.({
      conversationId: input.conversationId,
      candidateId: input.candidateId,
      parentRevision,
      sourceStepCursor: input.sourceStepCursor,
      sourceRoundCursor: input.sourceRoundCursor,
      inputHash: input.inputHash,
      ...generationIdentity,
      candidate: toPersistShape(record),
    });
    if (!response?.prepared) return null;
    return {
      conversationId: input.conversationId,
      candidateId: input.candidateId,
      parentRevision,
      inputHash: input.inputHash,
      sourceStepCursor: input.sourceStepCursor,
      sourceRoundCursor: input.sourceRoundCursor,
      ...generationIdentity,
      record,
    };
  } catch (err) {
    console.warn('[recordStore] prepareAppendCandidate failed:', err);
    return null;
  }
}

export async function publishPreparedCandidate(
  candidate: PreparedRecordCandidate,
  messages?: unknown[],
): Promise<SynapseRecord | null> {
  if (!candidate?.conversationId || !candidate.candidateId) return null;
  const generationIdentity = normalizeRecordGenerationIdentity(candidate);
  if (!generationIdentity) {
    console.warn('[recordStore] publishPreparedCandidate 缺少冻结模型/账号身份，拒绝发布候选');
    return null;
  }
  if (!isRecordGenerationIdentityCurrent(generationIdentity)) {
    console.warn('[recordStore] publishPreparedCandidate 发现模型/账号身份已变化，拒绝发布候选');
    await discardPreparedCandidate(candidate.conversationId, candidate.candidateId, '模型/账号身份已变化，拒绝发布 BPC 候选');
    return null;
  }
  try {
    const response = await platform.conversation.publishRecordCandidate?.({
      conversationId: candidate.conversationId,
      candidateId: candidate.candidateId,
      parentRevision: candidate.parentRevision,
      inputHash: candidate.inputHash,
      ...generationIdentity,
      messages,
    });
    if (!response?.published) return null;
    return normalizeRecord(response.record);
  } catch (err) {
    console.warn('[recordStore] publishPreparedCandidate failed:', err);
    return null;
  }
}

export async function discardPreparedCandidate(
  conversationId: string,
  candidateId?: string,
  reason?: string,
): Promise<boolean> {
  if (!conversationId) return false;
  try {
    return Boolean(await platform.conversation.discardRecordCandidate?.({
      conversationId,
      candidateId,
      reason,
    }));
  } catch (err) {
    console.warn('[recordStore] discardPreparedCandidate failed:', err);
    return false;
  }
}

export async function getContextGenerationState(
  conversationId: string,
): Promise<ContextGenerationState | null> {
  if (!conversationId) return null;
  try {
    const value = await platform.conversation.getRecordCandidate?.(conversationId);
    return value ? value as ContextGenerationState : null;
  } catch (err) {
    console.warn('[recordStore] getContextGenerationState failed:', err);
    return null;
  }
}

export async function updateContextGenerationState(
  conversationId: string,
  patch: ContextGenerationStatePatch,
): Promise<ContextGenerationState | null> {
  if (!conversationId) return null;
  try {
    const value = await platform.conversation.updateRecordGenerationState?.({ conversationId, ...patch });
    return value ? value as ContextGenerationState : null;
  } catch (err) {
    console.warn('[recordStore] updateContextGenerationState failed:', err);
    return null;
  }
}

/**
 * ★ R-L4 折叠（设计B）参数。与 agentSettings.RecordLayeringConfig 的 foldThreshold/foldBatchK 同义、同默认值
 *   （30/10）。foldOldBatches 默认接收调用方传入的 store 配置快照（agentLoop 持有 store）；不传时按本默认兜底。
 *   ★ 不在 recordStore 顶层 import store —— 保持 recordStore 对 redux 零依赖（纯数据访问层、可被 fixture 直接驱动）。
 */
export interface FoldOptions {
  /** 可见（非 archived）批数超此阈值则触发折叠。 */
  foldThreshold?: number;
  /** 每次折叠把最老 K 个非 meta 可见批合成 1 个元批。 */
  foldBatchK?: number;
}
const FOLD_DEFAULTS = { foldThreshold: 30, foldBatchK: 10 };

/** 元批 contentMd 的拼接分隔（视觉上区隔被折叠的各原始批 skeleton）。 */
const META_JOIN = '\n\n';

/**
 * ★ R-L4 折叠（设计B）：把最老 K 个可见原始批折叠成 1 个【元批】，原始批标 archived 留库（不丢全文）。
 *
 * 触发：可见（非 archived、非 meta）批数 > foldThreshold。
 * 行为（纯本地、零 LLM）：
 *   1. 取最老 foldBatchK 个【非 archived、非 meta】批（按 index 升序）。少于 K 个则取全部可见批的 (K) 上限内。
 *   2. 合成 1 个元批：
 *      - contentMd = 这 K 批 skeleton 本地拼接（不调 LLM）；skeleton 取 extractSkeletonTitle(contentMd)（再降一档，量小）。
 *      - roundStart/roundEnd = 这 K 批 round 的并集（min start ~ max end）；stepStart/stepEnd 同理 step 并集。
 *      - meta=true、foldedFrom=[这K批的index]、index = 当前【全批最大 index + 1】（保证全局唯一，不与真实批/旧元批撞）。
 *      - timeSpan = 这 K 批 timeSpan 并集。
 *   3. 把这 K 批标 archived=true；元批与改后的批整体 upsertRecord 落库。
 *
 * ★ 水位安全：元批 meta=true → buildRecord/appendBatch 派生水位与幂等门都排除它（见 lastRealBatch），不污染水位。
 * ★ 幂等/重入安全：只折叠【未 archived】的可见批；已折叠过的批 archived=true 不会被二次折叠。
 * ★ 可见批不足时（<= foldThreshold）no-op，原样返回当前 record（不写库）。
 * record 是加速层，任何底层异常一律吞掉返回当前/ null，绝不阻塞主对话。
 *
 * @param opts.foldThreshold/foldBatchK 由调用方（agentLoop）从 store.agentSettings.recordLayering 传入快照；
 *   缺省按 FOLD_DEFAULTS（30/10）。
 */
export async function foldOldBatches(
  conversationId: string,
  opts?: FoldOptions,
): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  try {
    const record = await getRecord(conversationId);
    if (!record || record.batches.length === 0) return record;

    const foldThreshold = Number.isFinite(opts?.foldThreshold)
      ? Math.max(0, Math.floor(opts!.foldThreshold!))
      : FOLD_DEFAULTS.foldThreshold;
    const foldBatchK = Number.isFinite(opts?.foldBatchK)
      ? Math.max(1, Math.floor(opts!.foldBatchK!))
      : FOLD_DEFAULTS.foldBatchK;

    const sorted = [...record.batches].sort((a, b) => a.index - b.index);
    // 可见批 = 未 archived 且 非 meta（真正进注入视图、占膨胀的那批真实批）。
    const visibleReal = sorted.filter(b => !b.archived && !b.meta);
    if (visibleReal.length <= foldThreshold) return record; // 未达阈值 → no-op，不写库

    // 取最老 K 个可见真实批折叠（不足 K 时取实际可见数；但既已 > foldThreshold>=K 场景下恒有 K 个）。
    const k = Math.min(foldBatchK, visibleReal.length);
    if (k <= 0) return record;
    const toFold = visibleReal.slice(0, k);
    const foldIdxSet = new Set(toFold.map(b => b.index));

    // —— 合成元批（纯本地拼 skeleton，零 LLM）——
    const metaContentMd = toFold
      .map(b => (b.skeleton || extractSkeleton(b.contentMd) || '').trim())
      .filter(Boolean)
      .join(META_JOIN);
    const roundStart = Math.min(...toFold.map(b => b.roundStart));
    const roundEnd = Math.max(...toFold.map(b => b.roundEnd));
    const stepStart = Math.min(...toFold.map(b => b.stepStart));
    const stepEnd = Math.max(...toFold.map(b => b.stepEnd));
    const metaIndex = sorted.reduce((m, b) => Math.max(m, b.index), -1) + 1;
    const metaBatch: RecordBatch = {
      index: metaIndex,
      roundStart,
      roundEnd,
      stepStart,
      stepEnd,
      // ★ R-L4 审查 #3：metaContentMd 空（K 批都提不出骨架/标题）时兜底占位——否则元批 contentMd='' 会被
      //   renderRecordPrefix 头/尾全文区的 filter(Boolean) 整段吞掉，该段折叠历史在注入视图蒸发、模型连
      //   record_read 提示都看不到。占位保证元批永远非空且指引可展开原批。
      contentMd: metaContentMd || `[折叠摘要：覆盖第 ${roundStart}~${roundEnd} 轮（无可提取骨架），可 record_read 各原批 index 展开全文]`,
      skeleton: extractSkeletonTitle(metaContentMd) || metaContentMd || `[折叠摘要 第 ${roundStart}~${roundEnd} 轮]`,
      phases: 0,
      timeSpan: deriveTimeSpan(toFold),
      createdAt: nowSec(),
      meta: true,
      foldedFrom: toFold.map(b => b.index),
    };

    // 把被折叠的原始批标 archived=true（其余批原样），加入元批整体落库。
    const nextBatches: RecordBatch[] = sorted.map(b =>
      foldIdxSet.has(b.index) ? { ...b, archived: true } : b,
    );
    nextBatches.push(metaBatch);

    // ★ 整体覆盖落库（非 appendBatch——本操作改既有批的 archived 标记 + 插元批，是结构性重写而非追加）。
    //   upsertRecord 内部重新 normalize + 派生水位（已排除 meta）+ 原子写入。
    return await upsertRecord({ conversationId, batches: nextBatches, preserveRevision: true });
  } catch (err) {
    console.warn('[recordStore] foldOldBatches failed:', err);
    return null;
  }
}

/**
 * ★ R-L4 解折叠（回溯/分支专用）：把 record 还原成【纯原始批】——删除所有 meta 元批、把所有 archived 批的
 *   archived 标记清掉。返回还原后的批数组（按 index 升序、index 连续性不保证但单调）。
 *
 * 用途：clampToBatch（回溯裁剪）/ copyRecordFrom（分支继承）在按 step/round 取连续前缀前，先解折叠，
 *   保证裁剪基准全是真实原始批的 step/round（绝不撕裂「元批在但 foldedFrom 的 archived 批被裁」或反之）。
 *   解折叠后批集合 = 纯原始连续批，原裁剪逻辑（findIndex stepEnd/roundEnd + slice 前缀）天然正确。
 *   代价：回溯/分支后折叠态丢失（但 contentMd 全在），下次 compactNow 会按阈值重新折叠——可接受。
 *
 * ★ 纯函数：只做内存数组变换，不读库不写库。
 */
function unfoldBatches(batches: RecordBatch[]): RecordBatch[] {
  return batches
    .filter(b => !b.meta) // 删元批（其内容是 archived 原始批 skeleton 的派生，原始批仍在）
    .map(b => {
      if (!b.archived) return b;
      const { archived: _archived, ...rest } = b;
      return { ...rest } as RecordBatch;
    })
    .sort((a, b) => a.index - b.index)
    // ★ R-L4 审查 #2：删元批后原 index 留空洞（元批 index=max+1 被删、或折叠夹在真实批中间）；重排为
    //   0..n-1 连续，恢复 RecordBatch「index 连续递增」契约。仅回溯/分支场景（本就重建上下文）调用，
    //   重排不影响任何跨调用持久化的 index 引用。
    .map((b, i) => (b.index === i ? b : { ...b, index: i }));
}

/**
 * ★ #14 动态分级（hit 反馈写入）：把某批（或某轮号所在批）标记为「被 AI 主动认定为当前需要的上下文」。
 *
 * 触发：AI 读 record 摘要、发现某批/某轮正是它需要的细节时调 mark_record_hit 工具（见 toolRegistry）。
 * 行为（纯本地、零 LLM）：给命中批 hitCount++、lastHitRound = 传入的 currentRound，整体 upsert 落库。
 *   - 按 batchIndex 精确命中一个批；或按 roundHit（轮号）命中「roundStart<=roundHit<=roundEnd」的那个批。
 *   - hit 只记账，【不立即改 renderLevel / 不改注入前缀】——下次压缩点 computeRenderLevels 才据 hit 重算档位。
 *     故本写入【绝不破 else 分支每轮的 prompt cache】（renderRecordPrefix 渲染不读 hitCount，只读 renderLevel）。
 *
 * ★ 走 upsertRecord（整条覆盖），只改命中批的 hit 字段，不碰 step/round 边界与水位（buildRecord 不读 hit）→
 *   与 appendBatch「已有批永不重写水位」契约不冲突（这里改的是非水位的弱语义字段）。
 *
 * @param conversationId 目标对话 id。
 * @param target.batchIndex 精确命中的批 index；或 target.roundHit 命中该轮号所在批（二者传一个，batchIndex 优先）。
 * @param currentRound 命中时的 live 当前对话轮号（调用方算好传入，recordStore 不依赖 round 识别服务）。
 *   ★ 内部会钳到 record 水位轮 min(currentRound, record.totalRounds) 再写 lastHitRound，与 computeRenderLevels
 *   的 freshness 消费轴（record 水位轮）同轴——见函数体注释。
 * @returns 命中并落库后的最新 record；找不到对话 / 找不到目标批 / 失败 → null（不抛，record 是加速层）。
 */
export async function markRecordHit(
  conversationId: string,
  target: { batchIndex?: number; roundHit?: number },
  currentRound: number,
): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  try {
    const record = await getRecord(conversationId);
    if (!record || record.batches.length === 0) return null;

    // ★ #14 Bug 修复：lastHitRound 必须与消费侧（computeRenderLevels 的 freshness）同轴。
    //   调用方传入的 currentRound 是 live 真轮（identifyRounds(liveMessages).totalRounds，含未压缩的最近几轮）；
    //   而 computeRenderLevels 用 record 水位轮 folded.totalRounds（恒 ≤ live 真轮）算 hitAge = round - lastHitRound。
    //   若原样写 live 真轮，打 hit 后的若干次压缩里 hitAge 恒被 Math.max(0, ...) 夹成 0 → freshness=1（满血不衰减）。
    //   故在写入侧把 lastHitRound 钳到 record 水位（min(liveRound, record.totalRounds)），与消费轴对齐，freshness 才正常衰减。
    const liveRound = Math.max(0, toNumber(currentRound, 0));
    const round = Math.min(liveRound, Math.max(0, toNumber(record.totalRounds, 0)));
    // 命中批定位：batchIndex 优先（精确）；否则按 roundHit 落在 [roundStart, roundEnd] 的批。
    let hitIdx = -1;
    if (Number.isFinite(target.batchIndex)) {
      // ★ 排除 archived 原批——它已被元批代表、不进注入视图，computeRenderLevels 也跳过它打档，
      //   标在它上面纯空转（hit 不会生效）。命中失败（返回 null）让工具如实回提示，不误报「已标记」。
      hitIdx = record.batches.findIndex(b => b.index === Math.floor(target.batchIndex!) && !b.archived);
    } else if (Number.isFinite(target.roundHit)) {
      const rh = Math.floor(target.roundHit!);
      // 命中真实可见批（不命中 archived 原批——它已被元批代表、不进注入视图；命中元批可代表那段折叠历史）。
      hitIdx = record.batches.findIndex(
        b => !b.archived && b.roundStart <= rh && rh <= b.roundEnd,
      );
    }
    if (hitIdx < 0) return null; // 找不到目标批 → 不写库

    const nextBatches = record.batches.map((b, i) =>
      i === hitIdx
        ? { ...b, hitCount: Math.max(0, (b.hitCount || 0)) + 1, lastHitRound: round }
        : b,
    );
    return await upsertRecord({ conversationId, batches: nextBatches });
  } catch (err) {
    console.warn('[recordStore] markRecordHit failed:', err);
    return null;
  }
}

/**
 * ★ #14 动态分级（评分参数）。与 agentSettings.RecordLayeringConfig 的动态分级字段同义、同默认值。
 *   computeRenderLevels 由调用方（agentLoop 压缩点）从 store.agentSettings.recordLayering 传入快照；缺省按本兜底。
 *   ★ 不在 recordStore 顶层 import store —— 保持 recordStore 对 redux 零依赖（与 FoldOptions 同款约束）。
 */
export interface DynamicLevelOptions {
  /** 是否启用动态分级（关 → computeRenderLevels no-op，清除已固化的 renderLevel 回退静态分层）。 */
  enabled?: boolean;
  /** hit 命中强度权重：每次 hit 给命中项的强度增量。 */
  hitWeight?: number;
  /** 距离衰减权重：dist 每加 1，距离因子按 1/(1+dist×distWeight) 衰减。 */
  distWeight?: number;
  /** hit 强度基线（无 hit 批也有的最小命中项，保证 score 不被乘积归零、仍能按距离区分远近）。 */
  hitBase?: number;
  /** 升 full 的 score 阈值（score >= 此值 → full）。 */
  fullThreshold?: number;
  /** 升 summary 的 score 阈值（fullThreshold > score >= 此值 → summary；否则 brief）。 */
  summaryThreshold?: number;
  /**
   * ★ #14 hit 距离地板（仅 hitCount>0 时生效）：被 mark_record_hit 标记过的批，distTerm 不再低于此地板。
   *   背景：折叠老历史的元批 roundEnd 远低于当前轮 → dist 极大 → distTerm 趋 0 → 把 hit 加成乘没（dist≥15 时
   *   1 次 hit 连 brief 都跳不出），与「标记→保留全文」承诺冲突——而折叠老历史恰是唯一真正依赖 hit 救回的对象。
   *   设地板后保证：1 次 hit 至少到 summary、2~3 次到 full。无 hit 批不受影响（地板仅 hitCount>0 生效），
   *   不破 prompt cache（仍只在压缩点固化重算）。默认 0.5。
   */
  distFloor?: number;
}
const DYNAMIC_LEVEL_DEFAULTS: Required<DynamicLevelOptions> = {
  enabled: true,
  hitWeight: 0.6,
  distWeight: 0.2,
  hitBase: 0.4,
  fullThreshold: 0.6,
  summaryThreshold: 0.3,
  distFloor: 0.5,
};

/**
 * ★ #14 动态分级（评分 + 固化）：在【压缩点】给 record 各可见批算出渲染档位 renderLevel，落库固化。
 *
 * 算法（任务 #14：① hit 命中强度 × ② 距离当前轮远近，两指标【综合相乘】→ 三级 full/summary/brief）：
 *   对每个可见批（非 archived；含 meta 元批）：
 *     - freshness = 1 / (1 + hitAge × distWeight/2)        —— 命中新鲜度（hitAge = currentRound - lastHitRound，越新近越接近 1）。
 *                  ★ 同轴前提：lastHitRound 在 markRecordHit 写入时已钳到 record 水位轮（min(liveRound, totalRounds)），
 *                  与此处 currentRound（= folded.totalRounds 水位轮）同轴；否则 hitAge 恒被夹 0、freshness 永不衰减。
 *     - hitTerm  = hitBase + hitCount × hitWeight × freshness —— 命中强度（hitBase>0 让无 hit 批也有基线，不被乘积归零；新近命中更强）。
 *     - dist     = max(0, currentRound - roundEnd)         —— 批末轮到当前轮的距离（越近越小）。
 *     - distTerm = 1 / (1 + dist × distWeight)             —— 距离因子，dist=0→1，越远越趋 0。
 *                  ★ 但 hitCount>0 时给 distTerm 设地板 distFloor（默认 0.5）——防折叠老历史元批 dist 极大把 hit
 *                  加成乘没（详见 DynamicLevelOptions.distFloor）；无 hit 批不设地板，远批照常衰减到 brief。
 *     - score    = hitTerm × distTerm                       —— 综合相乘。
 *     - score >= fullThreshold    → 'full'（全文）
 *       score >= summaryThreshold → 'summary'（骨架）
 *       否则                       → 'brief'（仅标题）
 *   效果：近 + 有 hit → full；远 + 无 hit → brief；中间 → summary。符合 #14「hit 高+距离近→full，hit 低+距离远→brief」。
 *
 * ★ cache 权衡（方案①，务必维持）：本函数【只在压缩点调用一次】，把"当时轮号 + hit"快照成固化 renderLevel 落库；
 *   两次压缩间 renderRecordPrefix 只读固化的 renderLevel（不读 hit/距离/当前轮号）→ else 分支前缀逐字稳定 → prompt cache 不破。
 *   压缩点本就因 append 新批而失效 cache，顺势重算 renderLevel 零额外失效代价。距离这个"逐轮变量"被隔离在压缩点，绝不进每轮渲染。
 *
 * ★ enabled=false：清除所有批已固化的 renderLevel（置 undefined），renderRecordPrefix 回退纯静态位置分层（与改造前逐字一致）。
 * ★ 走 upsertRecord（整条覆盖）只改 renderLevel（弱语义、不入水位派生），不碰 step/round 边界，不破水位/幂等契约。
 * record 是加速层，任何异常吞掉返回当前/null，绝不阻塞主对话。
 *
 * @param currentRound 压缩点的当前对话轮号（= 落库后 record.totalRounds，调用方传入）。
 * @param opts 评分权重/阈值/开关（agentLoop 从 store.agentSettings.recordLayering 传快照；缺省按 DYNAMIC_LEVEL_DEFAULTS）。
 * @returns 写入固化 renderLevel 后的最新 record；无 record / no-op（值未变） / 失败 → 原 record 或 null。
 */
export async function computeRenderLevels(
  conversationId: string,
  currentRound: number,
  opts?: DynamicLevelOptions,
): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  try {
    const record = await getRecord(conversationId);
    if (!record || record.batches.length === 0) return record;

    const cfg = { ...DYNAMIC_LEVEL_DEFAULTS, ...(opts ?? {}) };
    const round = Math.max(0, toNumber(currentRound, 0));

    // —— enabled=false：清空已固化档位，回退静态分层（仅在确有固化值时才写库，避免无谓覆盖）——
    if (!cfg.enabled) {
      const hasLevel = record.batches.some(b => b.renderLevel !== undefined);
      if (!hasLevel) return record; // no-op
      const cleared = record.batches.map(b =>
        b.renderLevel === undefined ? b : (() => { const { renderLevel: _r, ...rest } = b; return rest as RecordBatch; })(),
      );
      return await upsertRecord({ conversationId, batches: cleared });
    }

    const hitWeight = Math.max(0, cfg.hitWeight);
    const distWeight = Math.max(0, cfg.distWeight);
    const hitBase = Math.max(0, cfg.hitBase);
    const fullThreshold = cfg.fullThreshold;
    const summaryThreshold = Math.min(cfg.summaryThreshold, fullThreshold); // summary 阈值不得高于 full 阈值
    const distFloor = Math.min(1, Math.max(0, cfg.distFloor)); // hit 距离地板，钳到 [0,1]（distTerm 本就 ∈(0,1]）

    let changed = false;
    const nextBatches = record.batches.map(b => {
      // archived 原批不进注入视图（被元批代表）→ 不打档位（保留原值，通常 undefined）。
      if (b.archived) return b;
      const hitCount = Math.max(0, b.hitCount || 0);
      // ★ 命中新鲜度（消费 lastHitRound）：命中越新近（lastHitRound 越接近当前轮）→ 命中强度保留越多。
      //   freshness ∈ (0,1]，age=0（本轮刚标）→ 1，越久远越衰减。用 distWeight 的一半作衰减系数（比距离温和），
      //   无 hit（hitCount=0 / lastHitRound 缺省 0）→ freshness 不参与（hitTerm 退化为 hitBase 基线）。
      const hitAge = hitCount > 0 ? Math.max(0, round - (b.lastHitRound || 0)) : 0;
      const freshness = 1 / (1 + hitAge * (distWeight * 0.5));
      const hitTerm = hitBase + hitCount * hitWeight * freshness;
      const dist = Math.max(0, round - (b.roundEnd || 0));
      // ★ #14 hit 距离地板：被标记过的批（hitCount>0）distTerm 不低于 distFloor，防折叠老历史元批 dist 极大把 hit 乘没；
      //   无 hit 批（hitCount=0）走原始衰减，远批照常降到 brief（地板仅 hitCount>0 生效，无 hit 远批行为完全不变）。
      const rawDistTerm = 1 / (1 + dist * distWeight);
      const distTerm = hitCount > 0 ? Math.max(distFloor, rawDistTerm) : rawDistTerm;
      const score = hitTerm * distTerm;
      const level: 'full' | 'summary' | 'brief' =
        score >= fullThreshold ? 'full' : score >= summaryThreshold ? 'summary' : 'brief';
      if (b.renderLevel !== level) changed = true;
      return b.renderLevel === level ? b : { ...b, renderLevel: level };
    });

    if (!changed) return record; // 档位无变化 → no-op，不写库（省一次 IO，且不破已稳定的前缀）
    return await upsertRecord({ conversationId, batches: nextBatches });
  } catch (err) {
    console.warn('[recordStore] computeRenderLevels failed:', err);
    return null;
  }
}

/**
 * 各批 skeleton 拼接（渐进式读 / generateBatch 喂「旧批骨架概览」用）。
 * 可选指定截止批次 index（不含），用于「本批之前的所有旧批骨架」。
 */
export async function getRecordSkeleton(
  conversationId: string,
  beforeIndex?: number,
): Promise<string> {
  const record = await getRecord(conversationId);
  if (!record) return '';
  // ★ R-L4：generateBatch 的「旧批骨架概览」排除 meta 元批——元批 contentMd 是其 foldedFrom 原始批
  //   skeleton 的本地拼接，archived 原始批的 skeleton 仍在 batches 里（更细粒度、真实历史）；
  //   带上元批会与 archived skeleton 重复。喂细粒度 archived skeleton 即可，不喂元批的二次拼接。
  const batches = (typeof beforeIndex === 'number'
    ? record.batches.filter(b => b.index < beforeIndex)
    : record.batches
  ).filter(b => !b.meta);
  return batches.map(b => b.skeleton).filter(Boolean).join(BATCH_JOIN);
}

/**
 * 取某对话 record 中【单个批次的完整全文 contentMd】（record_read 工具后端 / 渐进式读按需展开）。
 * 渐进式读把中段批次降级为骨架注入；AI 需要细节时调 record_read(batchIndex) 经本函数取回该批全文。
 * - batchIndex 按 RecordBatch.index 匹配（从 0 起，连续递增）。
 * - 找不到对话 / 找不到该批 / 该批全文为空 → 返回 null（不抛）。
 * record 是加速层，任何底层异常一律吞掉返回 null，绝不能阻塞主对话。
 */
export async function getBatch(
  conversationId: string,
  batchIndex: number,
): Promise<string | null> {
  if (!conversationId || !Number.isFinite(batchIndex)) return null;
  try {
    const record = await getRecord(conversationId);
    if (!record || record.batches.length === 0) return null;
    const batch = record.batches.find(b => b.index === batchIndex);
    const content = batch?.contentMd?.trim();
    return content ? batch!.contentMd : null;
  } catch (err) {
    console.warn('[recordStore] getBatch failed:', err);
    return null;
  }
}

/**
 * 删除某对话的 record（对话删除 / rollback 完全失效时调用）。
 * 失败返回 false，不抛。
 */
export async function deleteRecord(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  try {
    await platform.conversation.deleteRecord?.(conversationId);
    return true;
  } catch (err) {
    console.warn('[recordStore] deleteRecord failed:', err);
    return false;
  }
}

/**
 * ★ M5-2 轮次地基：从 step 截断 idx 与 round 截断 idx 中取【较保守者】（更早的 cutIdx）作为裁剪基准。
 *   findIndex 约定：返回首个越界批的下标，无越界返回 -1（= 全部保留）。
 *   取保守语义：两者都为 -1（都不越界）→ -1；任一为 -1 视作「不限制」（取另一个）；都有值取较小（更早裁）。
 *   这样 step 与 round 双口径任一触发裁剪都会生效，保证「所在轮整轮回退、绝不轮中间切」。
 */
function pickCutIdx(cutByStep: number, cutByRound: number): number {
  if (cutByStep < 0 && cutByRound < 0) return -1;
  if (cutByStep < 0) return cutByRound;
  if (cutByRound < 0) return cutByStep;
  return Math.min(cutByStep, cutByRound);
}

/**
 * 回溯/编辑/重试截断后，把 record 按批次裁剪到保留范围（M2-R1 批次整体保留语义，替代旧 clampRecord 数字 clamp）。
 * - keptRounds：截断后剩余的用户轮次（真轮口径，见 roundBoundary；M5-2 后参与裁剪基准、不再仅告警）。
 * - keptSteps：截断后剩余的消息条数（**不含 tool 角色**，对齐 agentLoop requestHistory 口径）。
 *
 * 行为（批次整体保留，对齐 Plan_4 M2「回溯」算例）：
 *   - ★ M5-2 截断基准【step + round 双口径取保守】：找到「第一个 stepEnd > keptSteps 或 roundEnd > keptRounds」
 *     的批次（该批被截断点穿过），二者取较早者（pickCutIdx），take 其之前的【连续前缀】整批保留、
 *     该批及之后整批丢弃（回退原文）。round 口径从「仅告警」升级为真实裁剪依据，保证「所在轮整轮回退、
 *     绝不轮中间切」，即便合并轮导致 step/round 口径不一致也能兜住。
 *     —— 用 findIndex + slice 取前缀（而非 filter 全数组），保证结果恒为连续前缀，
 *        即使脏数据导致批次 stepEnd/roundEnd 非单调也不会从中间挖空批次。
 *   - 末批 stepEnd <= keptSteps 且 roundEnd <= keptRounds（保留范围覆盖全部批次）→ 不动。
 *   - 裁剪后无批次（截断点落在首批之前）→ 删除 record。
 * 这是破坏性历史变更的一部分，底层失败必须抛出，不能与“确实不存在/正常删除”混成 null。
 */
export async function clampToBatch(
  conversationId: string,
  keptRounds: number,
  keptSteps: number,
): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  try {
    const record = await getRecordOrThrow(conversationId);
    if (!record || record.batches.length === 0) return record;

    const safeSteps = Math.max(0, keptSteps);
    const safeRounds = Math.max(0, keptRounds);

    // ★ R-L4 防撕裂：裁剪前先【解折叠】成纯原始批（删 meta 元批、清 archived 标记）。
    //   元批的 step/round 是其 foldedFrom 原始批的并集区间，若直接 findIndex 会撕裂「元批在但 archived 批被裁」
    //   或反之。解折叠后批集合 = 纯原始连续批，按 step/round 取前缀天然不撕裂；折叠态丢失但全文都在，
    //   下次 compactNow 会按阈值重新折叠（可接受，见 unfoldBatches 注释）。
    //   ★ 仅在确实有折叠态（含 meta 或 archived）时才解折叠并重排序，避免无折叠态时多一次数组变换。
    const hasFold = record.batches.some(b => b.meta || b.archived);
    const baseBatches = hasFold ? unfoldBatches(record.batches) : record.batches;

    // 末批整个在保留范围内（step 与 round 双口径都覆盖）→ 无需动（但若解过折叠仍需落库还原态）。
    const last = baseBatches[baseBatches.length - 1];
    if (last.stepEnd <= safeSteps && last.roundEnd <= safeRounds) {
      return hasFold ? await upsertRecordOrThrow({ conversationId, batches: baseBatches }) : record;
    }

    // ★ M5-2 轮次地基：keptRounds 从「仅告警」升级为【真实裁剪依据】（规范 §1/§3，向轮边界取整）。
    //   截断点穿过的批 = 第一个 (stepEnd > keptSteps) 或 (roundEnd > keptRounds) 的批，二者取【较保守者】
    //   （更早的 cutIdx）。这样回溯时「所在轮整轮回退原文、绝不在轮中间切」：即便调用方传入的 keptRounds
    //   与 keptSteps 因合并轮（连发 user / 一轮多 model step）而口径不一致，round 口径也能兜住、不少裁。
    //   findIndex + slice 取连续前缀，脏数据导致 stepEnd/roundEnd 非单调也不会从中间挖空批次。
    //   ★ R-L4：在【解折叠后的纯原始批 baseBatches】上算 cutIdx + 取前缀（绝不在含元批的并集区间上裁）。
    const cutByStep = baseBatches.findIndex(b => b.stepEnd > safeSteps);
    const cutByRound = baseBatches.findIndex(b => b.roundEnd > safeRounds);
    const cutIdx = pickCutIdx(cutByStep, cutByRound);
    const kept = cutIdx < 0 ? baseBatches : baseBatches.slice(0, cutIdx);

    if (kept.length === 0) {
      await deleteRecordOrThrow(conversationId);
      return null;
    }
    // 重新派生水位落盘（批次本身零改动，仅截掉尾部若干批）
    return await upsertRecordOrThrow({ conversationId, batches: kept });
  } catch (err) {
    console.warn('[recordStore] clampToBatch failed:', err);
    throw err;
  }
}

/**
 * 对话分支（M2-3）：把【源对话 record 截到 keptSteps 的连续前缀批次】拷贝到【目标新对话】。
 *
 * 用途：用户在源对话第 N 条消息处「从此分支」，新对话继承到该点为止已生成的 record 摘要，
 * 后续在新对话里的增量压缩可从正确的批次起点续接（与源对话的 record 互不影响）。
 *
 * ★ 截断口径与 clampToBatch 完全一致（同款「step + round 双口径取保守」逻辑，避免两处口径漂移）：
 *   - 保留被截断点之前的【连续前缀整批】；丢弃被截断点穿过的批及其之后所有批。
 *   - 截断点 = 第一个 (stepEnd > keptSteps) 或 (roundEnd > keptRounds) 的批，二者取较早者（pickCutIdx）。
 *   - 用 findIndex + slice 取前缀，保证结果恒为连续前缀（脏数据导致 stepEnd 非单调也不会从中间挖空）。
 *   - ★ M5-2 后 keptRounds 为【真轮口径】（见 roundBoundary）并真实参与裁剪，不再仅作 sanity 告警；
 *     调用方须传 identifyRounds(过滤 tool).totalRounds，与批 roundEnd 同口径，否则 round 分支会兜不住而退化。
 *
 * ★ 不修改源对话：只读源 record（getRecord），把裁出的批次原样（深拷贝）upsert 到目标对话。
 *   目标对话本无 record，是首次写入；批次内容/边界零改动直接复用源批（index/stepStart/stepEnd 一并继承，
 *   保证后续 appendBatch 的幂等水位门 expectedStepStart == 末批 stepEnd 成立）。
 *
 * 全程吞异常返回 null（record 是加速层，分支主流程绝不能被它阻塞）。
 *
 * @returns 写入目标对话后的最新 record；源无 record / 截后无批次 / 失败 → null。
 */
export async function copyRecord(
  srcConvId: string,
  dstConvId: string,
  keptSteps: number,
  keptRounds: number,
): Promise<SynapseRecord | null> {
  if (!srcConvId || !dstConvId || srcConvId === dstConvId) return null;
  try {
    const src = await getRecord(srcConvId);
    return await copyRecordFrom(src, dstConvId, keptSteps, keptRounds);
  } catch (err) {
    console.warn('[recordStore] copyRecord failed:', err);
    return null;
  }
}

/**
 * 同 copyRecord，但源是【已在内存里的 SynapseRecord 快照】而非按 id 现读。
 *
 * ★ 审查 issue④⑤修复（autosave 分支 record 继承被 FK CASCADE 抹掉 + 双模式不对等）：
 *   Electron 的 records 表对 conversations 有 `FOREIGN KEY ... ON DELETE CASCADE`（foreign_keys=ON）。
 *   handleBranch 在 autosave 源分支时会先 clearAutosaveSnapshot()（删 `autosave-current` 对话行）以释放
 *   message.id 主键占用，SQLite 随即级联删掉 `records WHERE conversation_id='autosave-current'`；
 *   等到 copyRecord(AUTOSAVE_ID) 再去 getRecord 时已读到 null → 新分支【零 record 继承】。
 *   而 Web 模式 record 存独立分键 `synapse:record:<id>`、delete 路径不级联 → 继承正常 → 跨平台行为分叉。
 *
 *   统一修法（二者都「继承成功」）：在 clearAutosaveSnapshot【之前】先把源 record 读成内存快照（getRecord），
 *   再把该快照传进来从内存继承，不再依赖可能已被级联删除的库行。其余截断/守恒口径与 copyRecord 完全一致。
 *
 * @param src 源 record 内存快照（调用方在级联删除前抓取）；null/空批 → 无可继承，返回 null。
 */
export async function copyRecordFrom(
  src: SynapseRecord | null,
  dstConvId: string,
  keptSteps: number,
  keptRounds: number,
): Promise<SynapseRecord | null> {
  if (!dstConvId) return null;
  try {
    if (!src || src.conversationId === dstConvId || src.batches.length === 0) return null;

    const safeSteps = Math.max(0, keptSteps);
    const safeRounds = Math.max(0, keptRounds);

    // ★ R-L4 防撕裂：分支继承同 clampToBatch——裁剪前先【解折叠】源 record 成纯原始批（删 meta、清 archived），
    //   在纯原始批上按 step/round 取连续前缀，绝不在元批并集区间上裁。新对话从纯原始批起继承（无折叠态），
    //   后续 compactNow 会按阈值自行重新折叠。
    const srcBatches = src.batches.some(b => b.meta || b.archived)
      ? unfoldBatches(src.batches)
      : [...src.batches].sort((a, b) => a.index - b.index);

    // ★ M5-2 轮次地基：与 clampToBatch 同款【step + round 双口径取保守】裁剪（keptRounds 参与，不再仅告警）。
    //   末批整个在保留范围内（step 与 round 都覆盖）→ 整份拷贝；否则取被截断点之前的连续前缀。
    const last = srcBatches[srcBatches.length - 1];
    let kept: RecordBatch[];
    if (last.stepEnd <= safeSteps && last.roundEnd <= safeRounds) {
      kept = srcBatches;
    } else {
      const cutByStep = srcBatches.findIndex(b => b.stepEnd > safeSteps);
      const cutByRound = srcBatches.findIndex(b => b.roundEnd > safeRounds);
      const cutIdx = pickCutIdx(cutByStep, cutByRound);
      kept = cutIdx < 0 ? srcBatches : srcBatches.slice(0, cutIdx);
    }

    if (kept.length === 0) return null; // 分支点落在首批之前 → 新对话无可继承摘要

    // 深拷贝批次写入目标（避免与源 record 共享对象引用；upsertRecord 内部会重新 normalize + 派生水位）。
    const cloned: RecordBatch[] = kept.map(b => ({ ...b }));
    return await upsertRecord({ conversationId: dstConvId, batches: cloned });
  } catch (err) {
    console.warn('[recordStore] copyRecordFrom failed:', err);
    return null;
  }
}
