/**
 * IPC Memory Handler
 * M1 上下文 harness 的 memory 层（AI 主动记忆）持久化。
 *
 * 按来源对话隔离的长期记忆条目，模型通过内置工具 memory_write / memory_query 维护。
 * 与 ipc/conversation.ts 里的 record handler 同构（toJson/fromJson + camelCase/snake_case 映射 + upsert）。
 *
 * ⚠️ 这是 Synapse 内置记忆（本地 SQLite memories 表），独立于外置 MCP memory-store。
 */

import { ipcMain } from 'electron';
import { getDatabase } from '../database';

function toJson(value: unknown): string | null {
    return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJson<T = unknown>(value: unknown): T | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

/** 标签规范化：去重、去空，最多 12 个（与 conversation tags 口径一致） */
function normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 12);
}

function mapMemory(row: any) {
    if (!row) return null;
    return {
        id: row.id,
        title: row.title ?? '',
        content: row.content ?? '',
        tags: normalizeTags(fromJson(row.tags_json)),
        category: row.category ?? 'general',
        searchSummary: row.search_summary ?? '',
        pinned: Boolean(row.pinned),
        conversationId: row.conversation_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** LIKE 转义：把 query 里的 % _ \ 转义掉，配合 ESCAPE '\' 用，避免通配符注入 */
function escapeLike(query: string): string {
    return query.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** 钳制 limit：>0 取值并封顶 200，否则用 fallback */
function clampLimit(limit: unknown, fallback: number): number {
    const n = Number(limit);
    return n > 0 ? Math.min(n, 200) : fallback;
}

interface MemoryQueryOpts {
    query?: string;
    conversationId?: string;
    category?: string;
    pinnedOnly?: boolean;
    limit?: number;
}

/** 组装查询的 WHERE 片段与参数（conversation + 关键词 LIKE + category + pinned 过滤） */
function buildMemoryFilters(opts?: MemoryQueryOpts) {
    const where: string[] = [];
    const values: unknown[] = [];
    const q = opts?.query?.trim();
    if (opts?.conversationId?.trim()) {
        where.push('conversation_id = ?');
        values.push(opts.conversationId.trim());
    }
    if (q) {
        // 拆词检索：query 按空白/中英标点拆成多个 term，每个 term 对 4 字段 LIKE，term 间 OR（宽召回）。
        // 修复「整串子串匹配」导致多关键词查询必败的问题（AI 常把多个词拼成一串查，整串匹配查不到）。
        // tags 口径与 Web mock 的已知小差异同前：此处对 tags_json 原始 JSON 串做 LIKE，仅 query 含 JSON 元字符时可能多命中，tags 为次要信号，可接受。
        const terms = q.split(/[\s,，、;；]+/).map(t => t.trim()).filter(Boolean).slice(0, 12);
        const effectiveTerms = terms.length ? terms : [q];
        const termClauses: string[] = [];
        for (const term of effectiveTerms) {
            const like = `%${escapeLike(term)}%`;
            termClauses.push(`(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR search_summary LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')`);
            values.push(like, like, like, like);
        }
        where.push(`(${termClauses.join(' OR ')})`);
    }
    if (opts?.category && opts.category.trim()) {
        where.push('category = ?');
        values.push(opts.category.trim());
    }
    if (opts?.pinnedOnly) {
        where.push('pinned = 1');
    }
    return { where, values };
}

export function registerMemoryHandlers(): void {
    const db = getDatabase();

    // 写入 / 更新一条记忆（upsert by id）。
    // 已存在则保留原 created_at（用 COALESCE 取库里旧值），仅更新内容与 updated_at。
    ipcMain.handle('memory:write', (_e, data: {
        id: string; title?: string; content?: string; tags?: string[]; category?: string;
        searchSummary?: string; pinned?: boolean; conversationId?: string;
        createdAt?: number; updatedAt?: number;
    }) => {
        if (!data?.id) return null;
        const now = Math.floor(Date.now() / 1000);
        db.prepare(
            `INSERT INTO memories (
              id, title, content, tags_json, category, search_summary,
              pinned, conversation_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              content = excluded.content,
              tags_json = excluded.tags_json,
              category = excluded.category,
              search_summary = excluded.search_summary,
              pinned = excluded.pinned,
              conversation_id = excluded.conversation_id,
              updated_at = excluded.updated_at`,
        ).run(
            data.id,
            data.title ?? '',
            data.content ?? '',
            toJson(normalizeTags(data.tags)),
            data.category?.trim() || 'general',
            data.searchSummary ?? null,
            data.pinned ? 1 : 0,
            data.conversationId || null,
            // 全库时间戳统一为「秒」(unixepoch)；created_at 仅在新建时落，更新走 ON CONFLICT 不动它。
            data.createdAt ?? now,
            data.updatedAt ?? now,
        );
        return mapMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(data.id));
    });

    // 关键词检索记忆（命中 title/content/search_summary/tags），按 pinned 优先、更新时间倒序。
    ipcMain.handle('memory:query', (_e, opts?: MemoryQueryOpts) => {
        const limit = clampLimit(opts?.limit, 50);
        const filters = buildMemoryFilters(opts);
        const whereSql = filters.where.length ? `WHERE ${filters.where.join(' AND ')}` : '';
        return (db.prepare(
            `SELECT * FROM memories
             ${whereSql}
             ORDER BY pinned DESC, updated_at DESC
             LIMIT ?`,
        ).all(...filters.values, limit) as any[]).map(mapMemory);
    });

    // 读取单条记忆。
    ipcMain.handle('memory:get', (_e, id: string) => {
        if (!id) return null;
        return mapMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
    });

    // 列出记忆（可过滤 category / pinned），按 pinned 优先、更新时间倒序。
    ipcMain.handle('memory:list', (_e, opts?: Omit<MemoryQueryOpts, 'query'>) => {
        const limit = clampLimit(opts?.limit, 100);
        const filters = buildMemoryFilters({
            conversationId: opts?.conversationId,
            category: opts?.category,
            pinnedOnly: opts?.pinnedOnly,
        });
        const whereSql = filters.where.length ? `WHERE ${filters.where.join(' AND ')}` : '';
        return (db.prepare(
            `SELECT * FROM memories
             ${whereSql}
             ORDER BY pinned DESC, updated_at DESC
             LIMIT ?`,
        ).all(...filters.values, limit) as any[]).map(mapMemory);
    });

    // 删除一条记忆。
    ipcMain.handle('memory:delete', (_e, id: string) => {
        if (!id) return false;
        db.prepare('DELETE FROM memories WHERE id = ?').run(id);
        return true;
    });
}
