/**
 * Memory Store
 * M1 上下文 harness 的 memory 层数据访问（AI 主动记忆）。
 *
 * memory 是「AI 自己写、自己查」的长期记忆条目：默认按来源对话隔离，沉淀技术方案、踩坑经验、
 * 用户偏好等，由模型通过内置工具 memory_write / memory_query 主动维护。
 * 全局记忆属于更高权限的管理能力，不由模型工具隐式读取，
 * 与按对话主键、随对话生命周期的 record 层（过程日志）正交。
 *
 * 数据访问统一走 platform 抽象：Electron 落 SQLite memories 表，Web 落 localStorage。
 *
 * 设计参考外置 mcp-memory-store 的 MemoryFrontmatter（id / title / content / tags /
 * category / searchSummary / pinned / conversationId），但 Synapse 用 SQLite 单表
 * + LIKE 检索存储，不照搬其 YAML frontmatter 多文件 + 索引方案。
 *
 * ⚠️ 这是 Synapse 内置记忆（存本地 SQLite / localStorage），独立于用户环境里另一套
 *    外置 MCP `mcp__memory-store__*` 工具。两者数据互不相通。
 */

import { platform } from '@/platform';

/** memory 分类（对齐外置 mcp-memory-store 的取值枚举，作弱约束用 string 联合便于扩展） */
export type MemoryCategory =
  | 'problem-solution'
  | 'technical-note'
  | 'conversation'
  | 'general'
  | (string & {});

/** memory 数据模型（运行态 / 持久化对等结构，camelCase） */
export interface SynapseMemory {
  /** 记忆 ID（主键，写入时若缺省由 store 生成） */
  id: string;
  /** 标题（简短，检索主权重字段之一） */
  title: string;
  /** 记忆正文（markdown / 纯文本） */
  content: string;
  /** 标签（去重、去空，便于过滤与检索） */
  tags: string[];
  /** 分类（problem-solution / technical-note / conversation / general / 自定义） */
  category: MemoryCategory;
  /** 检索摘要：关键词、近义词、技术栈等，比正文更影响命中率（可空） */
  searchSummary: string;
  /** 是否置顶（可用于注入 system prompt 的高优记忆） */
  pinned: boolean;
  /** 来源对话 ID（可空，记录这条记忆从哪个对话产生） */
  conversationId?: string;
  /** 创建时间（秒级 Unix 时间戳，与全库 conversations/messages/records 统一单位） */
  createdAt: number;
  /** 最近一次写入时间（秒级 Unix 时间戳） */
  updatedAt: number;
}

/** 写入入参：title/content 必填，其余可选；带 id 时为更新，缺省 id 走新建 */
export interface MemoryWriteInput {
  id?: string;
  title: string;
  content: string;
  tags?: string[];
  category?: MemoryCategory;
  searchSummary?: string;
  pinned?: boolean;
  conversationId?: string;
}

/** 查询入参：query 为关键词；可选过滤 conversation / category / pinned / limit */
export interface MemoryQueryOptions {
  query?: string;
  conversationId?: string;
  category?: MemoryCategory;
  pinnedOnly?: boolean;
  limit?: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 标签规范化：转字符串、trim、去空、去重，最多 12 个（与 conversation tags 口径一致） */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    // 兼容持久化层把 tags 存成 JSON 字符串的情况
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return [...new Set(parsed.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
        }
      } catch {
        // 非 JSON 字符串，按单标签处理
        return [value.trim()];
      }
    }
    return [];
  }
  return [...new Set(value.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

/** 生成 memory id：时间戳 + 随机串，无外部依赖 */
function generateMemoryId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 把 platform 返回的原始行（可能是 snake_case 或 camelCase）规范成 SynapseMemory */
function normalizeMemory(raw: unknown): SynapseMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? '');
  if (!id) return null;
  const createdAt = toNumber(row.createdAt ?? row.created_at, nowSeconds());
  const conversationId = row.conversationId ?? row.conversation_id;
  return {
    id,
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    tags: normalizeTags(row.tags ?? row.tags_json),
    category: String(row.category ?? 'general') as MemoryCategory,
    searchSummary: String(row.searchSummary ?? row.search_summary ?? ''),
    pinned: Boolean(row.pinned),
    conversationId: conversationId ? String(conversationId) : undefined,
    createdAt,
    updatedAt: toNumber(row.updatedAt ?? row.updated_at, createdAt),
  };
}

/** 规范化一批行，丢弃无法解析的条目 */
function normalizeMemoryList(rows: unknown): SynapseMemory[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeMemory).filter((m): m is SynapseMemory => m !== null);
}

/**
 * 写入 / 更新一条记忆。
 * - 不带 id：新建（生成 id、createdAt=updatedAt=now）。
 * - 带 id：交给持久化层 upsert（若已存在则保留原 createdAt，仅更新内容与 updatedAt）。
 * 成功返回写入后的最新记忆，失败返回 null（不抛）—— 记忆是辅助层，绝不阻塞主对话。
 */
export async function writeMemory(input: MemoryWriteInput): Promise<SynapseMemory | null> {
  // title 与 content 都必填非空，与工具 schema 的 required:['title','content'] 对齐。
  // title 是检索主权重字段之一，空 title 会拖垮检索体验，故二者缺一即拒绝写入。
  if (!input?.title?.trim() || !input?.content?.trim()) return null;
  try {
    const now = nowSeconds();
    const payload = {
      id: input.id?.trim() || generateMemoryId(),
      title: input.title?.trim() ?? '',
      content: input.content ?? '',
      tags: normalizeTags(input.tags),
      category: (input.category?.trim() || 'general') as MemoryCategory,
      searchSummary: input.searchSummary?.trim() ?? '',
      pinned: Boolean(input.pinned),
      conversationId: input.conversationId?.trim() || undefined,
      // 秒级 Unix 时间戳；带 id 更新时持久化层会保留原 createdAt。
      createdAt: now,
      updatedAt: now,
    };
    const saved = await platform.memory?.write?.(payload);
    // 持久化层回写规范化后的行则用其结果，否则回落本地构造（Web mock 已回写）。
    return normalizeMemory(saved) ?? normalizeMemory(payload);
  } catch (err) {
    console.warn('[memoryStore] writeMemory failed:', err);
    return null;
  }
}

/**
 * 关键词检索记忆。
 * - query 命中 title / content / searchSummary / tags（持久化层用 LIKE，Web mock 用 includes）。
 * - 空 query 时返回最近更新的若干条（受 limit 约束）。
 * 任何异常都吞掉返回 []，绝不阻塞主对话。
 */
export async function queryMemory(
  query?: string,
  options?: Omit<MemoryQueryOptions, 'query'>,
): Promise<SynapseMemory[]> {
  try {
    const rows = await platform.memory?.query?.({
      query: query?.trim() || undefined,
      conversationId: options?.conversationId?.trim() || undefined,
      category: options?.category,
      pinnedOnly: options?.pinnedOnly,
      limit: options?.limit,
    });
    return normalizeMemoryList(rows);
  } catch (err) {
    console.warn('[memoryStore] queryMemory failed:', err);
    return [];
  }
}

/**
 * 读取单条记忆；不存在返回 null。任何异常都吞掉返回 null。
 */
export async function getMemory(id: string): Promise<SynapseMemory | null> {
  if (!id) return null;
  try {
    const raw = await platform.memory?.get?.(id);
    return normalizeMemory(raw);
  } catch (err) {
    console.warn('[memoryStore] getMemory failed:', err);
    return null;
  }
}

/**
 * 列出记忆（默认按更新时间倒序），可过滤 category / pinned。
 * 任何异常都吞掉返回 []。
 */
export async function listMemories(options?: Omit<MemoryQueryOptions, 'query'>): Promise<SynapseMemory[]> {
  try {
    const rows = await platform.memory?.list?.({
      conversationId: options?.conversationId?.trim() || undefined,
      category: options?.category,
      pinnedOnly: options?.pinnedOnly,
      limit: options?.limit,
    });
    return normalizeMemoryList(rows);
  } catch (err) {
    console.warn('[memoryStore] listMemories failed:', err);
    return [];
  }
}

/**
 * 删除一条记忆。失败返回 false，不抛。
 */
export async function deleteMemory(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    await platform.memory?.delete?.(id);
    return true;
  } catch (err) {
    console.warn('[memoryStore] deleteMemory failed:', err);
    return false;
  }
}
