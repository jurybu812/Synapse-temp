/**
 * IPC Conversation Handler
 * 对话 CRUD + 消息管理 + 搜索
 */

import { ipcMain } from 'electron';
import { getDatabase, ensureColumn, hasColumn } from '../database';
import { getProviderCredentialStatus } from '../provider/credentialStore';

interface PersistedMessageInput {
    id: string;
    role: string;
    content: string;
    timestamp: number;
    model?: string;
    toolCalls?: unknown[];
    contentParts?: unknown[];
    attachments?: unknown[];
    richTokens?: unknown[];
    thinking?: unknown;
    streamState?: string;
    durationMs?: number;
    streamMode?: string;
    fallbackReason?: string;
    endToEndMs?: number;
    runId?: string;
    runEvents?: unknown[];
    diffs?: unknown[];
    rollbackSnapshotId?: string;
    error?: string;
    subtitle?: string;
    subtitleGeneratedAt?: number;
}

interface ConversationMetadataInput {
    title?: string;
    model?: string;
    mode?: string;
    reasoningEffort?: string;
    workspaceId?: string;
    schemaVersion?: number;
    summary?: unknown;
    lastMessage?: string;
    assistantRuns?: unknown;
    fileSnapshots?: unknown;
    pendingDiffs?: unknown;
    archived?: boolean;
    tags?: string[];
    parentId?: string | null;
    branchedFromMessageId?: string | null;
    isSubAgent?: boolean;
    workspacePath?: string | null;
    goal?: string | null;
    bpcThresholdOverride?: number | null;
    compactThresholdOverride?: number | null;
    taskBoundaries?: unknown;
    taskHeadline?: unknown;
}

interface ConversationCreateInput extends ConversationMetadataInput {
    id: string;
    messages?: PersistedMessageInput[];
    systemTouch?: boolean;
}

interface ConversationUpdateInput extends ConversationMetadataInput {
    messages?: PersistedMessageInput[];
    systemTouch?: boolean;
}

interface ConversationSnapshotInput {
    id: string;
    metadata?: ConversationMetadataInput;
    messages: PersistedMessageInput[];
    systemTouch?: boolean;
}

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

interface RecordGenerationIdentity {
    providerId: string;
    modelId: string;
    catalogGeneration: string | null;
    accountFingerprint: string | null;
    credentialGeneration: number;
}

function normalizeNullableString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCredentialGeneration(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
}

function conversationExists(db: ReturnType<typeof getDatabase>, conversationId: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId));
}

function normalizeGenerationIdentity(value: any): RecordGenerationIdentity | null {
    const providerId = typeof value?.providerId === 'string'
        ? value.providerId.trim()
        : typeof value?.provider_id === 'string'
            ? value.provider_id.trim()
            : '';
    const modelId = typeof value?.modelId === 'string'
        ? value.modelId.trim()
        : typeof value?.model_id === 'string'
            ? value.model_id.trim()
            : '';
    const credentialGeneration = normalizeCredentialGeneration(value?.credentialGeneration ?? value?.credential_generation);
    if (!providerId || !modelId || credentialGeneration === null) return null;
    return {
        providerId,
        modelId,
        catalogGeneration: normalizeNullableString(value?.catalogGeneration ?? value?.catalog_generation),
        accountFingerprint: normalizeNullableString(value?.accountFingerprint ?? value?.account_fingerprint),
        credentialGeneration,
    };
}

function sameGenerationIdentity(left: RecordGenerationIdentity, right: RecordGenerationIdentity): boolean {
    return left.providerId === right.providerId
        && left.modelId === right.modelId
        && left.catalogGeneration === right.catalogGeneration
        && left.accountFingerprint === right.accountFingerprint
        && left.credentialGeneration === right.credentialGeneration;
}

function credentialIdentityIsCurrent(identity: RecordGenerationIdentity): boolean {
    const current = getProviderCredentialStatus(identity.providerId);
    return current.accountFingerprint === identity.accountFingerprint
        && current.credentialGeneration === identity.credentialGeneration;
}

function markCandidateIdentityRejected(
    db: ReturnType<typeof getDatabase>,
    conversationId: string,
    candidateId: string | null,
    reason: string,
) {
    db.prepare(`UPDATE context_generation_state SET
            state = 'discarded',
            candidate_id = ?,
            candidate_json = NULL,
            last_error = ?,
            updated_at = unixepoch()
        WHERE conversation_id = ?`)
        .run(candidateId, reason, conversationId);
    return { published: false, reason };
}

function normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 12);
}

function mapConversation(row: any) {
    if (!row) return null;
    return {
        ...row,
        workspaceId: row.workspace_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        schemaVersion: row.schema_version ?? 1,
        summary: fromJson(row.summary_json),
        lastMessage: row.last_message ?? '',
        assistantRuns: fromJson(row.assistant_runs) ?? {},
        fileSnapshots: fromJson(row.file_snapshots) ?? {},
        pendingDiffs: fromJson(row.pending_diffs) ?? [],
        archived: Boolean(row.archived),
        tags: normalizeTags(fromJson(row.tags_json)),
        archivedAt: row.archived_at,
        // M2-3 对话分支溯源：非分支对话两者为 null。
        parentId: row.parent_id ?? null,
        branchedFromMessageId: row.branched_from_message_id ?? null,
        // M2-6 对话级元数据：mode 由 `...row` 自带（列名同 key）；reasoning_effort 列名带下划线需显式映射。
        // 旧行（建列前）为 null，上层 loadPlatformSnapshot 回退默认。
        reasoningEffort: row.reasoning_effort ?? null,
        // M3-1a 真子代理：子代理对话标记。列名带下划线需显式映射为布尔。旧行/普通对话为 0/null → false。
        isSubAgent: Boolean(row.is_subagent),
        // M4-2-S3 对话工作区归属：列名带下划线需显式映射。旧行/缺列为 null → Global（无归属）。
        workspacePath: row.workspace_path ?? null,
        // ★ M4-6-S4 对话目标（/goal）：goal 列单字无下划线，`...row` 已自带；显式回带保证缺列时为 null。
        //   旧行/缺列为 null → 上层 loadPlatformSnapshot 视作未设目标（undefined）。
        goal: row.goal ?? null,
        // ★ task_boundary：JSON 列（TEXT 存 JSON 串），fromJson 解析成对象返回（仿 assistant_runs/pending_diffs）。
        //   缺列/旧行为 null（fromJson(null) → undefined，`?? null` 兜回 null）→ 上层 loadPlatformSnapshot 视作未设边界。
        taskBoundaries: fromJson(row.task_boundaries_json) ?? null,
        taskHeadline: fromJson(row.task_headline_json) ?? null,
        // ★ M5-BPC 本对话阈值覆盖（REAL 列，下划线 → 驼峰显式映射）。旧行/缺列为 undefined → null。
        //   上层 loadPlatformSnapshot 用 toFiniteNumberOrUndefined 把 null 视作未覆盖（undefined）；落库 0 合法不被吞。
        bpcThresholdOverride: row.bpc_threshold_override ?? null,
        compactThresholdOverride: row.compact_threshold_override ?? null,
    };
}

function buildConversationFilters(
    opts?: { archived?: 'all' | 'active' | 'archived'; tags?: string[]; workspacePath?: string | null; globalOnly?: boolean },
    // M4-2-S3：workspace_path 列存在性由调用方（注册闭包）传入；缺列时跳过工作区条件，避免 SQL 引用不存在的列报错。
    hasWorkspacePath = false,
) {
    const where: string[] = [];
    const values: unknown[] = [];
    const archived = opts?.archived ?? 'active';
    if (archived === 'active') where.push('COALESCE(c.archived, 0) = 0');
    if (archived === 'archived') where.push('COALESCE(c.archived, 0) = 1');
    for (const tag of normalizeTags(opts?.tags)) {
        where.push('c.tags_json LIKE ?');
        values.push(`%"${tag.replace(/"/g, '\\"')}"%`);
    }
    // M4-2-S3 工作区归属三态过滤（仅在列存在时生效，缺列降级为「不限/全部」）：
    //   - globalOnly=true → 只显无归属（workspace_path IS NULL）的全局对话；
    //   - workspacePath 为具体非空串 → 只显归属该工作区的对话；
    //   - 两者都不满足 → 不加 workspace 条件（显示全部）。
    //   globalOnly 优先于 workspacePath（语义互斥时取 Global 视图）。
    if (hasWorkspacePath) {
        if (opts?.globalOnly) {
            where.push('c.workspace_path IS NULL');
        } else if (typeof opts?.workspacePath === 'string' && opts.workspacePath) {
            where.push('c.workspace_path = ?');
            values.push(opts.workspacePath);
        }
    }
    return { where, values };
}

function mapRecord(row: any) {
    if (!row) return null;
    const phases = fromJson<number>(row.phases_json);
    // M2-R1：batches 是真相源（v2 落 batches_json），随行返回供 recordStore.normalizeRecord 解析；
    // schemaVersion 决定是否走懒迁移（<2 且无 batches 时合成历史批）。
    const batches = fromJson<unknown[]>(row.batches_json);
    return {
        conversationId: row.conversation_id,
        batches: Array.isArray(batches) ? batches : undefined,
        contentMd: row.content_md ?? '',
        totalRounds: row.total_rounds ?? 0,
        totalSteps: row.total_steps ?? 0,
        phases: typeof phases === 'number' ? phases : 0,
        lastUpdatedRound: row.last_updated_round ?? 0,
        timeSpan: row.time_span ?? '',
        schemaVersion: row.record_schema_version ?? 1,
        revision: row.revision ?? 0,
        updatedAt: row.updated_at,
    };
}

function mapContextGenerationState(row: any) {
    if (!row) return null;
    return {
        conversationId: row.conversation_id,
        state: row.state ?? 'idle',
        schedulerState: row.scheduler_state ?? 'idle',
        candidateId: row.candidate_id ?? null,
        parentRevision: row.parent_revision ?? 0,
        publishedRevision: row.published_revision ?? 0,
        sourceStepCursor: row.source_step_cursor ?? 0,
        sourceRoundCursor: row.source_round_cursor ?? 0,
        inputHash: row.input_hash ?? null,
        providerId: row.provider_id ?? null,
        modelId: row.model_id ?? null,
        catalogGeneration: row.catalog_generation ?? null,
        accountFingerprint: row.account_fingerprint ?? null,
        credentialGeneration: row.credential_generation ?? null,
        retryCount: row.retry_count ?? 0,
        backoffUntil: row.backoff_until ?? null,
        hardPaused: Boolean(row.hard_paused),
        cooldownUntil: row.cooldown_until ?? null,
        circuitBroken: Boolean(row.circuit_broken),
        lastReplaceStepCursor: row.last_replace_step_cursor ?? null,
        immediateRetriggerCount: row.immediate_retrigger_count ?? 0,
        lastError: row.last_error ?? null,
        updatedAt: row.updated_at ?? 0,
    };
}

function mapMessage(row: any) {
    if (!row) return null;
    return {
        ...row,
        conversationId: row.conversation_id,
        toolCalls: fromJson(row.tool_calls),
        contentParts: fromJson(row.content_parts),
        attachments: fromJson(row.attachments),
        // ★ M6 收尾 D1：rich_tokens 列旧库 NULL → fromJson 返回 undefined，buildRichParts 自动降级纯文本，不崩。
        richTokens: fromJson(row.rich_tokens),
        thinking: fromJson(row.thinking),
        streamState: row.stream_state,
        durationMs: row.duration_ms,
        streamMode: row.stream_mode ?? undefined,
        fallbackReason: row.fallback_reason ?? undefined,
        endToEndMs: row.end_to_end_ms ?? undefined,
        runId: row.run_id,
        runEvents: fromJson(row.run_events),
        diffs: fromJson(row.diffs),
        rollbackSnapshotId: row.rollback_snapshot_id,
        // ★ H6：消息小标题（用户消息语义标题，供「消息导航」跳转）。旧行该列 NULL → undefined（不进导航）。
        subtitle: row.subtitle ?? undefined,
        subtitleGeneratedAt: row.subtitle_generated_at ?? undefined,
    };
}

function replaceConversationMessages(
    db: ReturnType<typeof getDatabase>,
    conversationId: string,
    messages: PersistedMessageInput[],
    systemTouch: boolean,
): void {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    const insert = db.prepare(
        `INSERT OR REPLACE INTO messages (
          id, conversation_id, role, content, timestamp, tool_calls, model,
          content_parts, attachments, rich_tokens, thinking, stream_state, duration_ms,
          stream_mode, fallback_reason, end_to_end_ms,
          run_id, run_events, diffs, rollback_snapshot_id, error, subtitle, subtitle_generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const msg of messages) {
        insert.run(
            msg.id,
            conversationId,
            msg.role,
            msg.content,
            msg.timestamp,
            toJson(msg.toolCalls),
            msg.model || null,
            toJson(msg.contentParts),
            toJson(msg.attachments),
            toJson(msg.richTokens),
            toJson(msg.thinking),
            msg.streamState || null,
            msg.durationMs ?? null,
            msg.streamMode || null,
            msg.fallbackReason || null,
            msg.endToEndMs ?? null,
            msg.runId || null,
            toJson(msg.runEvents),
            toJson(msg.diffs),
            msg.rollbackSnapshotId || null,
            msg.error || null,
            msg.subtitle || null,
            msg.subtitleGeneratedAt ?? null,
        );
    }
    const last = messages[messages.length - 1];
    db.prepare(
        `UPDATE conversations
         SET message_count = ?,
             last_message = ?${systemTouch ? '' : ',\n             updated_at = unixepoch()'}
         WHERE id = ?`,
    ).run(messages.length, last?.content?.slice(0, 200) ?? '', conversationId);
}

export function registerConversationHandlers(): void {
    const db = getDatabase();

    try { ensureColumn(db, 'records', 'revision', 'INTEGER NOT NULL DEFAULT 0'); } catch { /* 初始化迁移已覆盖，失败则由写入报错 */ }
    try { ensureColumn(db, 'context_generation_state', 'scheduler_state', "TEXT NOT NULL DEFAULT 'idle'"); } catch { /* 初始化迁移已覆盖 */ }
    try { ensureColumn(db, 'context_generation_state', 'cooldown_until', 'INTEGER'); } catch { /* 初始化迁移已覆盖 */ }
    try { ensureColumn(db, 'context_generation_state', 'circuit_broken', 'INTEGER NOT NULL DEFAULT 0'); } catch { /* 初始化迁移已覆盖 */ }
    try { ensureColumn(db, 'context_generation_state', 'last_replace_step_cursor', 'INTEGER'); } catch { /* 初始化迁移已覆盖 */ }
    try { ensureColumn(db, 'context_generation_state', 'immediate_retrigger_count', 'INTEGER NOT NULL DEFAULT 0'); } catch { /* 初始化迁移已覆盖 */ }

    // ★ M2-6 真机根因防御性自愈：reasoning_effort 列是 ensureColumn 后加的（database.ts ~line164）。
    //   若运行的库该列未迁移成功（旧构建初始化的库、迁移异常等），带该列的 INSERT/UPDATE 会整条 throw，
    //   连 mode/messages 一起存不进去（mode 列建表自带故幸存 → 表象「mode 对、reasoningEffort 错」）。
    //   这里在 handler 注册时再补一次（幂等），把列补齐到当前运行库；万一仍补不上，下方写入路径按
    //   hasReasoningEffortColumn 降级（跳过该字段，至少不拖垮整条保存）。
    try { ensureColumn(db, 'conversations', 'reasoning_effort', 'TEXT'); } catch { /* 自愈失败则靠下方降级兜底 */ }
    // 缓存列存在性（PRAGMA 不必每次写都跑）。注册期仅一次；ensureColumn 已尽力补齐，故通常为 true。
    const hasReasoningEffortColumn = hasColumn(db, 'conversations', 'reasoning_effort');

    // ★ M3-1a is_subagent 列同样防御性自愈 + 缺列降级（与 reasoning_effort 同口径）：
    //   该列是 ensureColumn 后加的，旧库/迁移异常时可能缺失。补不上则写入路径按 hasIsSubAgentColumn 降级
    //   （跳过该字段，至少不拖垮整条子对话保存）。带 DEFAULT 0，旧行/普通对话天然为非子代理。
    try { ensureColumn(db, 'conversations', 'is_subagent', 'INTEGER NOT NULL DEFAULT 0'); } catch { /* 自愈失败则靠下方降级兜底 */ }
    const hasIsSubAgentColumn = hasColumn(db, 'conversations', 'is_subagent');

    // ★ M4-2-S3 workspace_path 列同样防御性自愈 + 缺列降级（与 reasoning_effort / is_subagent 同口径）：
    //   该列是 ensureColumn 后加的，旧库/迁移异常时可能缺失。注册期再补一次（幂等）；补不上则写入路径按
    //   hasWorkspacePathColumn 降级（跳过该字段，至少不拖垮整条对话保存），读取路径缺列时返回 undefined（视为 Global）。
    try { ensureColumn(db, 'conversations', 'workspace_path', 'TEXT'); } catch { /* 自愈失败则靠下方降级兜底 */ }
    const hasWorkspacePathColumn = hasColumn(db, 'conversations', 'workspace_path');

    // ★ M4-6-S4 goal 列同样防御性自愈 + 缺列降级（与 reasoning_effort / is_subagent / workspace_path 同口径）：
    //   对话目标（/goal 设定）随对话持久化。注册期补一次（幂等）；补不上则写入路径按 hasGoalColumn 降级
    //   （跳过该字段，至少不拖垮整条对话保存），读取路径缺列时为 null（视为未设目标）。
    try { ensureColumn(db, 'conversations', 'goal', 'TEXT'); } catch { /* 自愈失败则靠下方降级兜底 */ }
    const hasGoalColumn = hasColumn(db, 'conversations', 'goal');

    // ★ M5-BPC 本对话阈值覆盖列同样防御性自愈 + 缺列降级（与 goal / workspace_path 同口径）：
    //   bpc_threshold_override / compact_threshold_override 是 REAL 列（NULL=未覆盖）。注册期补一次（幂等）；
    //   补不上则写入路径按 hasBpcOverrideColumns 降级（跳过该字段），读取路径缺列时为 null（视为未覆盖）。
    try { ensureColumn(db, 'conversations', 'bpc_threshold_override', 'REAL'); } catch { /* 自愈失败靠下方降级 */ }
    try { ensureColumn(db, 'conversations', 'compact_threshold_override', 'REAL'); } catch { /* 自愈失败靠下方降级 */ }
    const hasBpcThresholdOverrideColumn = hasColumn(db, 'conversations', 'bpc_threshold_override');
    const hasCompactThresholdOverrideColumn = hasColumn(db, 'conversations', 'compact_threshold_override');

    // ★ task_boundary JSON 列同样防御性自愈 + 缺列降级（与 goal / BPC override 同口径）：
    //   task_boundaries_json / task_headline_json 是 ensureColumn 后加的 TEXT 列（存 JSON 串）。注册期补一次（幂等）；
    //   补不上则写入路径按 has*Column 降级（跳过该字段），读取路径缺列时 fromJson(undefined) → null（视为未设边界）。
    try { ensureColumn(db, 'conversations', 'task_boundaries_json', 'TEXT'); } catch { /* 自愈失败靠下方降级 */ }
    try { ensureColumn(db, 'conversations', 'task_headline_json', 'TEXT'); } catch { /* 自愈失败靠下方降级 */ }
    const hasTaskBoundariesColumn = hasColumn(db, 'conversations', 'task_boundaries_json');
    const hasTaskHeadlineColumn = hasColumn(db, 'conversations', 'task_headline_json');

    function insertConversation(data: ConversationCreateInput): { id: string } {
        // ★ 缺列降级：reasoning_effort 列缺失时，动态拼一条【不含该列】的 INSERT，
        //   保住 mode/messages 正常落库（不再因一个缺列整条失败）。列存在则带上（正常路径）。
        const cols = [
            'id', 'workspace_id', 'title', 'model', 'mode',
            'schema_version', 'summary_json', 'last_message',
            'assistant_runs', 'file_snapshots', 'pending_diffs', 'archived', 'tags_json', 'archived_at',
            'parent_id', 'branched_from_message_id',
        ];
        const vals: unknown[] = [
            data.id,
            data.workspaceId || null,
            data.title || '新对话',
            data.model || null,
            data.mode || 'planning',
            data.schemaVersion ?? 1,
            toJson(data.summary),
            data.lastMessage || '',
            toJson(data.assistantRuns ?? {}),
            toJson(data.fileSnapshots ?? {}),
            toJson(data.pendingDiffs ?? []),
            data.archived ? 1 : 0,
            toJson(normalizeTags(data.tags)),
            data.archived ? Math.floor(Date.now() / 1000) : null,
            data.parentId ?? null,
            data.branchedFromMessageId ?? null,
        ];
        if (hasReasoningEffortColumn) {
            // 插在 mode 之后位置一致即可（列顺序与 vals 顺序对应；这里追加到尾部并补对应值）。
            cols.push('reasoning_effort');
            // M2-6 对话级思考层级：缺省/空串落默认 'auto'（与 agentSettings 初值一致；空串也回退避免下拉落空）。
            vals.push(data.reasoningEffort || 'auto');
        }
        if (hasIsSubAgentColumn) {
            // M3-1a：子代理对话写 1，普通对话写 0（列顺序与 vals 顺序对应，追加到尾部并补对应值）。
            cols.push('is_subagent');
            vals.push(data.isSubAgent ? 1 : 0);
        }
        if (hasWorkspacePathColumn) {
            // M4-2-S3：缺列降级——列存在才写归属（path 或 NULL=Global），缺列则整列跳过（旧对话天然 Global）。
            cols.push('workspace_path');
            vals.push(data.workspacePath ?? null);
        }
        if (hasGoalColumn) {
            // ★ M4-6-S4：缺列降级——列存在才写目标（空串落 NULL=未设目标），缺列则整列跳过。
            cols.push('goal');
            vals.push(typeof data.goal === 'string' && data.goal.trim() ? data.goal.trim() : null);
        }
        if (hasBpcThresholdOverrideColumn) {
            // ★ M5-BPC：缺列降级——列存在才写覆盖（typeof==='number'&&isFinite 才落值，否则 NULL=未覆盖）。
            //   ★ 绝不用 `data.x || null` 吞 0（虽阈值现实不为 0，留作正确口径）。
            cols.push('bpc_threshold_override');
            vals.push(
                typeof data.bpcThresholdOverride === 'number' && Number.isFinite(data.bpcThresholdOverride)
                    ? data.bpcThresholdOverride : null,
            );
        }
        if (hasCompactThresholdOverrideColumn) {
            cols.push('compact_threshold_override');
            vals.push(
                typeof data.compactThresholdOverride === 'number' && Number.isFinite(data.compactThresholdOverride)
                    ? data.compactThresholdOverride : null,
            );
        }
        if (hasTaskBoundariesColumn) {
            // ★ task_boundary：缺列降级——列存在才写。复杂对象 toJson 序列化（非 goal 的 .trim()）；
            //   空数组/缺省落 NULL（与「未设边界」对齐），非空数组才 toJson。
            cols.push('task_boundaries_json');
            vals.push(Array.isArray(data.taskBoundaries) && data.taskBoundaries.length ? toJson(data.taskBoundaries) : null);
        }
        if (hasTaskHeadlineColumn) {
            cols.push('task_headline_json');
            vals.push(data.taskHeadline ? toJson(data.taskHeadline) : null);
        }
        const placeholders = cols.map(() => '?').join(', ');
        db.prepare(
            `INSERT INTO conversations (${cols.join(', ')}) VALUES (${placeholders})`,
        ).run(...vals);
        return { id: data.id };
    }

    function updateConversation(id: string, data: ConversationUpdateInput): boolean {
        const systemTouch = Boolean(data.systemTouch);
        // systemTouch 时初始 set 为空；否则保留无条件刷 updated_at 的既有行为（用户主动保存正常置顶）。
        const sets: string[] = systemTouch ? [] : ['updated_at = unixepoch()'];
        const vals: unknown[] = [];
        if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title); }
        if (data.model !== undefined) { sets.push('model = ?'); vals.push(data.model); }
        // M2-6 对话级元数据：每次保存把该对话当前 mode / reasoning_effort 落库（undefined 时不动，保旧值）。
        if (data.mode !== undefined) { sets.push('mode = ?'); vals.push(data.mode); }
        // ★ 缺列降级：reasoning_effort 列缺失时跳过该字段，避免整条 UPDATE throw 拖垮 mode/last_message 等同批写入
        //   （真机根因：M2-6 把 reasoning_effort 耦合进同一 UPDATE，列缺失即连带其它字段一起失败）。
        //   空串也回退默认 'auto'，避免 DB 落空串导致下拉框落空。
        if (hasReasoningEffortColumn && data.reasoningEffort !== undefined) {
            sets.push('reasoning_effort = ?');
            vals.push(data.reasoningEffort || 'auto');
        }
        if (data.schemaVersion !== undefined) { sets.push('schema_version = ?'); vals.push(data.schemaVersion); }
        if (data.summary !== undefined) { sets.push('summary_json = ?'); vals.push(toJson(data.summary)); }
        if (data.lastMessage !== undefined) { sets.push('last_message = ?'); vals.push(data.lastMessage); }
        if (data.assistantRuns !== undefined) { sets.push('assistant_runs = ?'); vals.push(toJson(data.assistantRuns)); }
        if (data.fileSnapshots !== undefined) { sets.push('file_snapshots = ?'); vals.push(toJson(data.fileSnapshots)); }
        if (data.pendingDiffs !== undefined) { sets.push('pending_diffs = ?'); vals.push(toJson(data.pendingDiffs)); }
        if (data.archived !== undefined) {
            sets.push('archived = ?');
            vals.push(data.archived ? 1 : 0);
            sets.push('archived_at = ?');
            vals.push(data.archived ? Math.floor(Date.now() / 1000) : null);
        }
        if (data.tags !== undefined) { sets.push('tags_json = ?'); vals.push(toJson(normalizeTags(data.tags))); }
        if (data.parentId !== undefined) { sets.push('parent_id = ?'); vals.push(data.parentId ?? null); }
        if (data.branchedFromMessageId !== undefined) { sets.push('branched_from_message_id = ?'); vals.push(data.branchedFromMessageId ?? null); }
        // M3-1a：缺列降级——列缺失时跳过该字段，避免整条 UPDATE throw 拖垮同批写入（同 reasoning_effort 口径）。
        if (hasIsSubAgentColumn && data.isSubAgent !== undefined) { sets.push('is_subagent = ?'); vals.push(data.isSubAgent ? 1 : 0); }
        // M4-2-S3：工作区归属缺列降级 + undefined 不动（显式传含 null 才写；null 落 Global）。
        if (hasWorkspacePathColumn && data.workspacePath !== undefined) { sets.push('workspace_path = ?'); vals.push(data.workspacePath ?? null); }
        // ★ M4-6-S4：对话目标缺列降级 + undefined 不动（显式传才写；空串落 NULL=清空目标）。
        if (hasGoalColumn && data.goal !== undefined) {
            sets.push('goal = ?');
            vals.push(typeof data.goal === 'string' && data.goal.trim() ? data.goal.trim() : null);
        }
        // ★ M5-BPC：本对话阈值覆盖缺列降级 + undefined 不动（沿用 goal 口径）；
        //   显式传合法 number（含 0）落 REAL，显式传其它（如 NaN）落 NULL（清空覆盖）。
        //   ★ 注意：IPC/JSON 序列化会丢弃 undefined 值的 key → 清空（store 端传 undefined）经序列化后 key 消失、
        //     走「不动」分支（DB 旧值残留）。0 值落库/读回正确（本批硬要求）；「显式清空持久化」边界留 BPC-7 处理。
        if (hasBpcThresholdOverrideColumn && data.bpcThresholdOverride !== undefined) {
            sets.push('bpc_threshold_override = ?');
            vals.push(
                typeof data.bpcThresholdOverride === 'number' && Number.isFinite(data.bpcThresholdOverride)
                    ? data.bpcThresholdOverride : null,
            );
        }
        if (hasCompactThresholdOverrideColumn && data.compactThresholdOverride !== undefined) {
            sets.push('compact_threshold_override = ?');
            vals.push(
                typeof data.compactThresholdOverride === 'number' && Number.isFinite(data.compactThresholdOverride)
                    ? data.compactThresholdOverride : null,
            );
        }
        // ★ task_boundary：缺列降级 + undefined 不动（沿用 goal 口径）；显式传才写。
        //   复杂对象 toJson 序列化（非 .trim()）；空数组/null 落 NULL=清空边界，非空数组才 toJson。
        if (hasTaskBoundariesColumn && data.taskBoundaries !== undefined) {
            sets.push('task_boundaries_json = ?');
            vals.push(Array.isArray(data.taskBoundaries) && data.taskBoundaries.length ? toJson(data.taskBoundaries) : null);
        }
        if (hasTaskHeadlineColumn && data.taskHeadline !== undefined) {
            sets.push('task_headline_json = ?');
            vals.push(data.taskHeadline ? toJson(data.taskHeadline) : null);
        }
        // ★ M4-2-S1：systemTouch 把 updated_at 移出 set 后，若没有任何实际字段要写，则 set 为空，
        //   直接 return（不发空 UPDATE）。非 systemTouch 路径 sets 至少含 updated_at，永不为空。
        if (sets.length === 0) return true;
        vals.push(id);
        db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return true;
    }

    function writeConversationSnapshot(data: ConversationSnapshotInput): { id: string } {
        const id = data.id;
        const metadata = data.metadata ?? {};
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const systemTouch = Boolean(data.systemTouch);
        const tx = db.transaction(() => {
            const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
            if (existing) {
                updateConversation(id, { ...metadata, systemTouch });
            } else {
                insertConversation({ id, ...metadata });
            }
            replaceConversationMessages(db, id, messages, systemTouch);
        });
        tx();
        return { id };
    }

    // 创建对话
    ipcMain.handle('conversation:create', (_e, data: ConversationCreateInput) => {
        if (Array.isArray(data.messages)) {
            const tx = db.transaction(() => {
                insertConversation(data);
                replaceConversationMessages(db, data.id, data.messages ?? [], Boolean(data.systemTouch));
            });
            tx();
            return { id: data.id };
        }
        return insertConversation(data);
    });

    // 获取对话列表
    ipcMain.handle('conversation:list', (_e, opts?: { workspaceId?: string; workspacePath?: string | null; globalOnly?: boolean; limit?: number; archived?: 'all' | 'active' | 'archived'; tags?: string[] }) => {
        const limit = opts?.limit || 50;
        // M4-2-S3：workspacePath / globalOnly 三态过滤经 buildConversationFilters 接入（缺列降级）。
        const filters = buildConversationFilters(opts, hasWorkspacePathColumn);
        // 既有 workspace_id（死字段）过滤保留兼容，与新 workspace_path 互不干扰。
        if (opts?.workspaceId) {
            filters.where.unshift('c.workspace_id = ?');
            filters.values.unshift(opts.workspaceId);
        }
        const whereSql = filters.where.length ? `WHERE ${filters.where.join(' AND ')}` : '';
        return (db.prepare(
            `SELECT c.* FROM conversations c ${whereSql} ORDER BY c.updated_at DESC LIMIT ?`,
        ).all(...filters.values, limit) as any[]).map(mapConversation);
    });

    // 获取单个对话
    ipcMain.handle('conversation:get', (_e, id: string) => {
        return mapConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id));
    });

    // 更新对话
    ipcMain.handle('conversation:update', (_e, id: string, data: ConversationUpdateInput) => {
        if (Array.isArray(data.messages)) {
            const tx = db.transaction(() => {
                updateConversation(id, data);
                replaceConversationMessages(db, id, data.messages ?? [], Boolean(data.systemTouch));
            });
            tx();
            return true;
        }
        return updateConversation(id, data);
    });

    ipcMain.handle('conversation:saveSnapshot', (_e, data: ConversationSnapshotInput) => {
        return writeConversationSnapshot(data);
    });

    // 删除对话（CASCADE 删消息）
    ipcMain.handle('conversation:delete', (_e, id: string) => {
        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        return true;
    });

    ipcMain.handle('conversation:batchDelete', (_e, ids: string[]) => {
        const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
        const tx = db.transaction(() => {
            const stmt = db.prepare('DELETE FROM conversations WHERE id = ?');
            uniqueIds.forEach(id => stmt.run(id));
        });
        tx();
        return true;
    });

    ipcMain.handle('conversation:batchUpdate', (_e, ids: string[], data: { archived?: boolean; tags?: string[] }) => {
        const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
        const sets: string[] = ['updated_at = unixepoch()'];
        const vals: unknown[] = [];
        if (data.archived !== undefined) {
            sets.push('archived = ?');
            vals.push(data.archived ? 1 : 0);
            sets.push('archived_at = ?');
            vals.push(data.archived ? Math.floor(Date.now() / 1000) : null);
        }
        if (data.tags !== undefined) {
            sets.push('tags_json = ?');
            vals.push(toJson(normalizeTags(data.tags)));
        }
        if (sets.length === 1) return true;
        const tx = db.transaction(() => {
            const stmt = db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`);
            uniqueIds.forEach(id => stmt.run(...vals, id));
        });
        tx();
        return true;
    });

    // 添加消息
    ipcMain.handle('message:add', (_e, msg: {
        id: string; conversationId: string; role: string; content: string; timestamp: number;
        model?: string; toolCalls?: unknown[]; contentParts?: unknown[]; attachments?: unknown[];
        richTokens?: unknown[]; // ★ D1：富文本 atomic token 持久化锚点
        thinking?: unknown; streamState?: string; durationMs?: number;
        streamMode?: string; fallbackReason?: string; endToEndMs?: number; runId?: string;
        runEvents?: unknown[]; diffs?: unknown[]; rollbackSnapshotId?: string; error?: string;
        subtitle?: string; subtitleGeneratedAt?: number; // ★ H6：消息小标题
    }) => {
        // ★ D1/H6：列/占位符/值三者数量严格对齐。subtitle/subtitle_generated_at 排在末尾 error 之后，
        //   与 database.ts ensureColumn 顺序一致。
        db.prepare(
            `INSERT OR REPLACE INTO messages (
              id, conversation_id, role, content, timestamp, tool_calls, model,
              content_parts, attachments, rich_tokens, thinking, stream_state, duration_ms,
              stream_mode, fallback_reason, end_to_end_ms,
              run_id, run_events, diffs, rollback_snapshot_id, error, subtitle, subtitle_generated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            msg.id,
            msg.conversationId,
            msg.role,
            msg.content,
            msg.timestamp,
            toJson(msg.toolCalls),
            msg.model || null,
            toJson(msg.contentParts),
            toJson(msg.attachments),
            toJson(msg.richTokens),
            toJson(msg.thinking),
            msg.streamState || null,
            msg.durationMs ?? null,
            msg.streamMode || null,
            msg.fallbackReason || null,
            msg.endToEndMs ?? null,
            msg.runId || null,
            toJson(msg.runEvents),
            toJson(msg.diffs),
            msg.rollbackSnapshotId || null,
            msg.error || null,
            msg.subtitle || null,
            msg.subtitleGeneratedAt ?? null,
        );
        // 更新对话消息数和时间戳
        db.prepare(
            `UPDATE conversations
             SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
                 last_message = ?,
                 updated_at = unixepoch()
             WHERE id = ?`,
        ).run(msg.conversationId, msg.content.slice(0, 200), msg.conversationId);
        return true;
    });

    // 替换某个对话的全部消息，用于 autosave / rollback 后避免旧消息复活。
    // ★ M4-2-S1 systemTouch：opts.systemTouch=true 时末尾 UPDATE 不刷 updated_at（用于「切走对话的自动保存」
    //   这类系统性保存，不应改变用户感知的排序时间，根治问题9「切换后被点中条跳第二」）。
    ipcMain.handle('message:replaceConversation', (_e, conversationId: string, messages: PersistedMessageInput[], opts?: { systemTouch?: boolean }) => {
        const systemTouch = Boolean(opts?.systemTouch);
        const tx = db.transaction(() => {
            replaceConversationMessages(db, conversationId, messages, systemTouch);
        });
        tx();
        return true;
    });

    // 获取对话消息
    ipcMain.handle('message:list', (_e, conversationId: string) => {
        const rows = db.prepare(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
        ).all(conversationId) as any[];
        return rows.map(mapMessage);
    });

    // 搜索对话（全文）
    ipcMain.handle('conversation:search', (_e, query: string, opts?: { archived?: 'all' | 'active' | 'archived'; tags?: string[]; limit?: number; workspacePath?: string | null; globalOnly?: boolean }) => {
        // M4-2-S3：搜索同样支持工作区三态过滤（与 list 同口径，缺列降级）。
        const filters = buildConversationFilters(opts, hasWorkspacePathColumn);
        const limit = opts?.limit || 50;
        try {
            const whereSql = filters.where.length ? `AND ${filters.where.join(' AND ')}` : '';
            const ftsRows = db.prepare(
                `SELECT c.*, snippet(search_index, 1, '<b>', '</b>', '...', 20) as match_snippet
                 FROM search_index si
                 JOIN conversations c ON si.source_id = c.id AND si.source_type = 'conversation'
                 WHERE search_index MATCH ?
                 ${whereSql}
                 ORDER BY rank LIMIT ?`,
            ).all(query, ...filters.values, limit) as any[];
            if (ftsRows.length > 0) return ftsRows.map(mapConversation);
        } catch {
            // Older databases may have no populated FTS rows; fall through to LIKE search.
        }

        const like = `%${query}%`;
        const filterSql = filters.where.length ? `AND ${filters.where.join(' AND ')}` : '';
        return (db.prepare(
            `SELECT DISTINCT c.*, '' as match_snippet
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE (
                c.title LIKE ?
                OR c.last_message LIKE ?
                OR c.tags_json LIKE ?
                OR m.content LIKE ?
             )
                ${filterSql}
             ORDER BY c.updated_at DESC
             LIMIT ?`,
        ).all(like, like, like, like, ...filters.values, limit) as any[]).map(mapConversation);
    });

    // ===== Record（M1 上下文 harness 过程日志）=====

    // 读取某对话的 record
    ipcMain.handle('record:get', (_e, conversationId: string) => {
        if (!conversationId) return null;
        return mapRecord(db.prepare('SELECT * FROM records WHERE conversation_id = ?').get(conversationId));
    });

    // 写入 / 覆盖 record（upsert 整条，调用方负责合并）。
    // M2-R1：batches_json（多批结构，真相源）+ record_schema_version 一并落盘；
    // content_md 仍写派生全文（v1 回滚保险 / 旧调用方兼容）。
    // ★ R5 崩溃恢复依赖：这是【单条 INSERT...ON CONFLICT DO UPDATE】，better-sqlite3 单语句即单事务、
    //   天然原子——进程在 .run() 中途崩溃不会留下半写的 batches_json（要么旧值、要么新值整体）。
    //   recordStore.appendBatch 的「崩溃可恢复」正建立在此原子性 + 其幂等校验之上；
    //   若将来拆成多条 SQL 写入，必须用 db.transaction(...) 包住，否则恢复保证破裂。
    ipcMain.handle('record:upsert', (_e, data: {
        conversationId: string; batches?: unknown[]; schemaVersion?: number;
        contentMd?: string; totalRounds?: number; totalSteps?: number;
        phases?: number; lastUpdatedRound?: number; timeSpan?: string; updatedAt?: number;
        // ★ R5 修复（问题1/4）：可选乐观并发水位门。appendBatch 落新批时传入「期望的 DB 当前末批 stepEnd」
        // (= 本批 stepStart)。仅当 DB 现有 total_steps（派生 = 末批 stepEnd）等于本值时才 DO UPDATE，
        // 否则不写（changes=0 → 返回 false）。把幂等校验下推到这条【单条原子 upsert】的 WHERE，
        // 杜绝「getRecord→内存合并→saveRecord」的交错读改写窗口（两路并发各自读到同一 priorSteps，
        // 第一路写入推进 total_steps 后，第二路 WHERE 不匹配被拒，不再后写覆盖先写）。
        // 不传（undefined）时保持原【无条件整条覆盖】语义（upsertRecord / clampToBatch 用），始终返回 true。
        expectedStepStart?: number;
        expectedRevision?: number;
        preserveRevision?: boolean;
        messages?: PersistedMessageInput[];
    }) => {
        if (!data?.conversationId) return { written: false, revision: 0 };
        if (!conversationExists(db, data.conversationId)) {
            return { written: false, revision: 0, reason: 'conversation-not-persisted' };
        }
        const upsert = db.transaction(() => {
        const current = db.prepare('SELECT total_steps, revision FROM records WHERE conversation_id = ?')
            .get(data.conversationId) as { total_steps?: number; revision?: number } | undefined;
        const currentStep = Number(current?.total_steps ?? 0);
        const currentRevision = Number(current?.revision ?? 0);
        if (typeof data.expectedStepStart === 'number' && currentStep !== data.expectedStepStart) {
            return { written: false, revision: currentRevision };
        }
        if (typeof data.expectedRevision === 'number' && currentRevision !== data.expectedRevision) {
            return { written: false, revision: currentRevision };
        }
        const nextRevision = current && data.preserveRevision === true
            ? currentRevision
            : (current ? currentRevision + 1 : 1);
        const args = [
            data.conversationId,
            data.contentMd ?? '',
            data.totalRounds ?? 0,
            data.totalSteps ?? 0,
            toJson(data.phases ?? 0),
            data.lastUpdatedRound ?? 0,
            data.timeSpan ?? null,
            // 全库时间戳统一为「秒」(unixepoch)，与 conversations/messages 表一致；
            // 回退也用秒，避免 idx_records_updated 与其它表跨表比较差 1000 倍。
            data.updatedAt ?? Math.floor(Date.now() / 1000),
            toJson(data.batches ?? null),
            data.schemaVersion ?? 2,
            nextRevision,
        ];
        const setClause = `
              content_md = excluded.content_md,
              total_rounds = excluded.total_rounds,
              total_steps = excluded.total_steps,
              phases_json = excluded.phases_json,
              last_updated_round = excluded.last_updated_round,
              time_span = excluded.time_span,
              updated_at = excluded.updated_at,
              batches_json = excluded.batches_json,
              record_schema_version = excluded.record_schema_version,
              revision = excluded.revision`;
        const sql = `INSERT INTO records (
              conversation_id, content_md, total_rounds, total_steps,
              phases_json, last_updated_round, time_span, updated_at,
              batches_json, record_schema_version, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET ${setClause}`;
        const result = db.prepare(sql).run(...args);
        if (result.changes > 0 && Array.isArray(data.messages)) {
            replaceConversationMessages(db, data.conversationId, data.messages, true);
        }
        const revision = Number((db.prepare('SELECT revision FROM records WHERE conversation_id = ?')
            .get(data.conversationId) as { revision?: number } | undefined)?.revision ?? 0);
        return { written: result.changes > 0, revision };
        });
        return upsert();
    });

    ipcMain.handle('record:candidate:get', (_e, conversationId: string) => {
        if (!conversationId) return null;
        return mapContextGenerationState(
            db.prepare('SELECT * FROM context_generation_state WHERE conversation_id = ?').get(conversationId),
        );
    });

    ipcMain.handle('record:generation:update', (_e, data: {
        conversationId: string;
        state?: string;
        schedulerState?: string;
        parentRevision?: number;
        publishedRevision?: number;
        sourceStepCursor?: number;
        sourceRoundCursor?: number;
        inputHash?: string | null;
        providerId?: string | null;
        modelId?: string | null;
        catalogGeneration?: string | null;
        accountFingerprint?: string | null;
        credentialGeneration?: number | null;
        retryCount?: number;
        backoffUntil?: number | null;
        hardPaused?: boolean;
        cooldownUntil?: number | null;
        circuitBroken?: boolean;
        lastReplaceStepCursor?: number | null;
        immediateRetriggerCount?: number;
        lastError?: string | null;
    }) => {
        if (!data?.conversationId) return null;
        if (!conversationExists(db, data.conversationId)) {
            return null;
        }
        const update = db.transaction(() => {
            db.prepare(`INSERT INTO context_generation_state (
                    conversation_id, state, scheduler_state, updated_at
                ) VALUES (?, 'idle', 'idle', unixepoch())
                ON CONFLICT(conversation_id) DO NOTHING`)
                .run(data.conversationId);

            const fields: string[] = [];
            const values: unknown[] = [];
            const add = (column: string, value: unknown) => {
                fields.push(`${column} = ?`);
                values.push(value);
            };
            if (typeof data.state === 'string') add('state', data.state);
            if (typeof data.schedulerState === 'string') add('scheduler_state', data.schedulerState);
            if (typeof data.parentRevision === 'number' && Number.isFinite(data.parentRevision)) {
                add('parent_revision', Math.max(0, Math.round(data.parentRevision)));
            }
            if (typeof data.publishedRevision === 'number' && Number.isFinite(data.publishedRevision)) {
                add('published_revision', Math.max(0, Math.round(data.publishedRevision)));
            }
            if (typeof data.sourceStepCursor === 'number' && Number.isFinite(data.sourceStepCursor)) {
                add('source_step_cursor', Math.max(0, Math.round(data.sourceStepCursor)));
            }
            if (typeof data.sourceRoundCursor === 'number' && Number.isFinite(data.sourceRoundCursor)) {
                add('source_round_cursor', Math.max(0, Math.round(data.sourceRoundCursor)));
            }
            if ('inputHash' in data) add('input_hash', data.inputHash ?? null);
            if ('providerId' in data) add('provider_id', normalizeNullableString(data.providerId));
            if ('modelId' in data) add('model_id', normalizeNullableString(data.modelId));
            if ('catalogGeneration' in data) add('catalog_generation', normalizeNullableString(data.catalogGeneration));
            if ('accountFingerprint' in data) add('account_fingerprint', normalizeNullableString(data.accountFingerprint));
            if ('credentialGeneration' in data) add('credential_generation', normalizeCredentialGeneration(data.credentialGeneration));
            if (typeof data.retryCount === 'number' && Number.isFinite(data.retryCount)) add('retry_count', Math.max(0, Math.round(data.retryCount)));
            if ('backoffUntil' in data) add('backoff_until', data.backoffUntil ?? null);
            if (typeof data.hardPaused === 'boolean') add('hard_paused', data.hardPaused ? 1 : 0);
            if ('cooldownUntil' in data) add('cooldown_until', data.cooldownUntil ?? null);
            if (typeof data.circuitBroken === 'boolean') add('circuit_broken', data.circuitBroken ? 1 : 0);
            if ('lastReplaceStepCursor' in data) add('last_replace_step_cursor', data.lastReplaceStepCursor ?? null);
            if (typeof data.immediateRetriggerCount === 'number' && Number.isFinite(data.immediateRetriggerCount)) {
                add('immediate_retrigger_count', Math.max(0, Math.round(data.immediateRetriggerCount)));
            }
            if ('lastError' in data) add('last_error', data.lastError ?? null);
            if (fields.length > 0) {
                fields.push('updated_at = unixepoch()');
                db.prepare(`UPDATE context_generation_state SET ${fields.join(', ')} WHERE conversation_id = ?`)
                    .run(...values, data.conversationId);
            }
            return mapContextGenerationState(
                db.prepare('SELECT * FROM context_generation_state WHERE conversation_id = ?').get(data.conversationId),
            );
        });
        return update();
    });

    ipcMain.handle('record:candidate:prepare', (_e, data: {
        conversationId: string;
        candidateId: string;
        parentRevision: number;
        sourceStepCursor: number;
        sourceRoundCursor: number;
        inputHash: string;
        providerId?: string | null;
        modelId?: string | null;
        catalogGeneration?: string | null;
        accountFingerprint?: string | null;
        credentialGeneration?: number | null;
        candidate: Record<string, unknown>;
    }) => {
        if (!data?.conversationId || !data.candidateId || !data.candidate || !data.inputHash) {
            return { prepared: false, reason: 'invalid-candidate' };
        }
        if (!conversationExists(db, data.conversationId)) {
            return { prepared: false, reason: 'conversation-not-persisted' };
        }
        const identity = normalizeGenerationIdentity(data);
        if (!identity) return { prepared: false, reason: 'missing-identity' };
        const prepare = db.transaction(() => {
            if (!credentialIdentityIsCurrent(identity)) return { prepared: false, reason: 'stale-identity' };
            const priorState = db.prepare('SELECT state, candidate_id FROM context_generation_state WHERE conversation_id = ?')
                .get(data.conversationId) as { state?: string; candidate_id?: string } | undefined;
            if (priorState?.state === 'discarded' && priorState.candidate_id === data.candidateId) {
                return { prepared: false, reason: 'candidate-discarded' };
            }
            const currentRevision = Number((db.prepare('SELECT revision FROM records WHERE conversation_id = ?')
                .get(data.conversationId) as { revision?: number } | undefined)?.revision ?? 0);
            if (currentRevision !== data.parentRevision) {
                return { prepared: false, reason: 'stale-parent', currentRevision };
            }
            db.prepare(`INSERT INTO context_generation_state (
                    conversation_id, state, candidate_id, parent_revision, published_revision,
                    source_step_cursor, source_round_cursor, input_hash,
                    provider_id, model_id, catalog_generation, account_fingerprint, credential_generation,
                    candidate_json,
                    retry_count, backoff_until, hard_paused, last_error, updated_at
                ) VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, unixepoch())
                ON CONFLICT(conversation_id) DO UPDATE SET
                    state = 'prepared',
                    candidate_id = excluded.candidate_id,
                    parent_revision = excluded.parent_revision,
                    published_revision = excluded.published_revision,
                    source_step_cursor = excluded.source_step_cursor,
                    source_round_cursor = excluded.source_round_cursor,
                    input_hash = excluded.input_hash,
                    provider_id = excluded.provider_id,
                    model_id = excluded.model_id,
                    catalog_generation = excluded.catalog_generation,
                    account_fingerprint = excluded.account_fingerprint,
                    credential_generation = excluded.credential_generation,
                    candidate_json = excluded.candidate_json,
                    updated_at = unixepoch()`)
                .run(
                    data.conversationId,
                    data.candidateId,
                    data.parentRevision,
                    data.parentRevision,
                    data.sourceStepCursor,
                    data.sourceRoundCursor,
                    data.inputHash,
                    identity.providerId,
                    identity.modelId,
                    identity.catalogGeneration,
                    identity.accountFingerprint,
                    identity.credentialGeneration,
                    toJson(data.candidate),
                );
            return {
                prepared: true,
                state: mapContextGenerationState(
                    db.prepare('SELECT * FROM context_generation_state WHERE conversation_id = ?').get(data.conversationId),
                ),
            };
        });
        return prepare();
    });

    ipcMain.handle('record:candidate:publish', (_e, data: {
        conversationId: string;
        candidateId: string;
        parentRevision: number;
        inputHash: string;
        providerId?: string | null;
        modelId?: string | null;
        catalogGeneration?: string | null;
        accountFingerprint?: string | null;
        credentialGeneration?: number | null;
        messages?: PersistedMessageInput[];
    }) => {
        if (!data?.conversationId || !data.candidateId || !data.inputHash) {
            return { published: false, reason: 'invalid-request' };
        }
        const requestIdentity = normalizeGenerationIdentity(data);
        if (!requestIdentity) return { published: false, reason: 'missing-identity' };
        const publish = db.transaction(() => {
            const stateRow = db.prepare('SELECT * FROM context_generation_state WHERE conversation_id = ?')
                .get(data.conversationId) as any;
            if (!stateRow || stateRow.state !== 'prepared') return { published: false, reason: 'not-prepared' };
            if (stateRow.candidate_id !== data.candidateId) return { published: false, reason: 'candidate-mismatch' };
            if (Number(stateRow.parent_revision ?? 0) !== data.parentRevision) return { published: false, reason: 'parent-mismatch' };
            if (stateRow.input_hash !== data.inputHash) return { published: false, reason: 'input-mismatch' };
            const storedIdentity = normalizeGenerationIdentity(stateRow);
            if (!storedIdentity) {
                return markCandidateIdentityRejected(db, data.conversationId, stateRow.candidate_id ?? null, 'missing-identity');
            }
            if (!sameGenerationIdentity(storedIdentity, requestIdentity)) {
                return markCandidateIdentityRejected(db, data.conversationId, stateRow.candidate_id ?? null, 'identity-mismatch');
            }
            if (!credentialIdentityIsCurrent(storedIdentity)) {
                return markCandidateIdentityRejected(db, data.conversationId, stateRow.candidate_id ?? null, 'stale-identity');
            }

            const currentRevision = Number((db.prepare('SELECT revision FROM records WHERE conversation_id = ?')
                .get(data.conversationId) as { revision?: number } | undefined)?.revision ?? 0);
            if (currentRevision !== data.parentRevision) {
                return { published: false, reason: 'stale-parent', currentRevision };
            }
            const candidate = fromJson<Record<string, unknown>>(stateRow.candidate_json);
            if (!candidate || candidate.conversationId !== data.conversationId || !Array.isArray(candidate.batches)) {
                return { published: false, reason: 'invalid-candidate-payload' };
            }
            const nextRevision = data.parentRevision + 1;
            db.prepare(`INSERT INTO records (
                    conversation_id, content_md, total_rounds, total_steps,
                    phases_json, last_updated_round, time_span, updated_at,
                    batches_json, record_schema_version, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET
                    content_md = excluded.content_md,
                    total_rounds = excluded.total_rounds,
                    total_steps = excluded.total_steps,
                    phases_json = excluded.phases_json,
                    last_updated_round = excluded.last_updated_round,
                    time_span = excluded.time_span,
                    updated_at = excluded.updated_at,
                    batches_json = excluded.batches_json,
                    record_schema_version = excluded.record_schema_version,
                    revision = excluded.revision`)
                .run(
                    data.conversationId,
                    candidate.contentMd ?? '',
                    candidate.totalRounds ?? 0,
                    candidate.totalSteps ?? 0,
                    toJson(candidate.phases ?? 0),
                    candidate.lastUpdatedRound ?? 0,
                    candidate.timeSpan ?? null,
                    candidate.updatedAt ?? Math.floor(Date.now() / 1000),
                    toJson(candidate.batches),
                    candidate.schemaVersion ?? 2,
                    nextRevision,
                );
            db.prepare(`UPDATE context_generation_state SET
                    state = 'published',
                    published_revision = ?,
                    candidate_id = NULL,
                    candidate_json = NULL,
                    retry_count = 0,
                    backoff_until = NULL,
                    last_error = NULL,
                    updated_at = unixepoch()
                WHERE conversation_id = ? AND candidate_id = ? AND state = 'prepared'`)
                .run(nextRevision, data.conversationId, data.candidateId);
            if (Array.isArray(data.messages)) {
                replaceConversationMessages(db, data.conversationId, data.messages, true);
            }
            return {
                published: true,
                revision: nextRevision,
                record: mapRecord(db.prepare('SELECT * FROM records WHERE conversation_id = ?').get(data.conversationId)),
            };
        });
        return publish();
    });

    ipcMain.handle('record:candidate:discard', (_e, data: {
        conversationId: string;
        candidateId?: string;
        reason?: string;
    }) => {
        if (!data?.conversationId) return false;
        const discard = db.transaction(() => {
            if (!data.candidateId) {
                const result = db.prepare(`UPDATE context_generation_state SET
                        state = 'idle', candidate_id = NULL, candidate_json = NULL,
                        last_error = ?, updated_at = unixepoch()
                    WHERE conversation_id = ?`)
                    .run(data.reason ?? null, data.conversationId);
                return result.changes > 0;
            }

            const current = db.prepare(`SELECT state, candidate_id
                    FROM context_generation_state WHERE conversation_id = ?`)
                .get(data.conversationId) as { state?: string; candidate_id?: string | null } | undefined;
            if (current?.candidate_id && current.candidate_id !== data.candidateId) return false;
            if (current && !current.candidate_id && current.state !== 'idle' && current.state !== 'discarded') return false;

            const result = db.prepare(`INSERT INTO context_generation_state (
                    conversation_id, state, candidate_id, candidate_json, last_error, updated_at
                ) VALUES (?, 'discarded', ?, NULL, ?, unixepoch())
                ON CONFLICT(conversation_id) DO UPDATE SET
                    state = 'discarded',
                    candidate_id = excluded.candidate_id,
                    candidate_json = NULL,
                    last_error = excluded.last_error,
                    updated_at = unixepoch()`)
                .run(data.conversationId, data.candidateId, data.reason ?? null);
            return result.changes > 0;
        });
        return discard();
    });

    ipcMain.handle('record:promote', (_e, fromId: string, toId: string, options?: {
        generationSnapshot?: Record<string, unknown> | null;
        restoredRecordRevision?: number | null;
    }) => {
        if (!fromId || !toId || fromId === toId) return false;
        const promote = db.transaction(() => {
            const sourceRecord = db.prepare('SELECT * FROM records WHERE conversation_id = ?').get(fromId) as any;
            if (sourceRecord) {
                db.prepare(`INSERT INTO records (
                        conversation_id, content_md, total_rounds, total_steps,
                        phases_json, last_updated_round, time_span, updated_at,
                        batches_json, record_schema_version, revision
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(conversation_id) DO UPDATE SET
                        content_md = excluded.content_md,
                        total_rounds = excluded.total_rounds,
                        total_steps = excluded.total_steps,
                        phases_json = excluded.phases_json,
                        last_updated_round = excluded.last_updated_round,
                        time_span = excluded.time_span,
                        updated_at = excluded.updated_at,
                        batches_json = excluded.batches_json,
                        record_schema_version = excluded.record_schema_version,
                        revision = excluded.revision`)
                    .run(
                        toId,
                        sourceRecord.content_md,
                        sourceRecord.total_rounds,
                        sourceRecord.total_steps,
                        sourceRecord.phases_json,
                        sourceRecord.last_updated_round,
                        sourceRecord.time_span,
                        sourceRecord.updated_at,
                        sourceRecord.batches_json,
                        sourceRecord.record_schema_version,
                        sourceRecord.revision,
                    );
            }
            const sourceState = db.prepare('SELECT * FROM context_generation_state WHERE conversation_id = ?').get(fromId) as any;
            const stateSnapshot = sourceState ?? options?.generationSnapshot;
            if (stateSnapshot) {
                const readState = (camel: string, snake: string) => stateSnapshot[snake] ?? stateSnapshot[camel] ?? null;
                const state = readState('state', 'state');
                const droppedPreparedCandidate = state === 'prepared';
                const publishedRevision = typeof options?.restoredRecordRevision === 'number' && Number.isFinite(options.restoredRecordRevision)
                    ? options.restoredRecordRevision
                    : readState('publishedRevision', 'published_revision');
                db.prepare(`INSERT INTO context_generation_state (
                        conversation_id, state, scheduler_state, candidate_id, parent_revision, published_revision,
                        source_step_cursor, source_round_cursor, input_hash, candidate_json,
                        retry_count, backoff_until, hard_paused, cooldown_until, circuit_broken,
                        last_replace_step_cursor, immediate_retrigger_count, last_error, updated_at
                    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(conversation_id) DO UPDATE SET
                        state = excluded.state,
                        scheduler_state = excluded.scheduler_state,
                        candidate_id = NULL,
                        parent_revision = excluded.parent_revision,
                        published_revision = excluded.published_revision,
                        source_step_cursor = excluded.source_step_cursor,
                        source_round_cursor = excluded.source_round_cursor,
                        input_hash = NULL,
                        candidate_json = NULL,
                        retry_count = excluded.retry_count,
                        backoff_until = excluded.backoff_until,
                        hard_paused = excluded.hard_paused,
                        cooldown_until = excluded.cooldown_until,
                        circuit_broken = excluded.circuit_broken,
                        last_replace_step_cursor = excluded.last_replace_step_cursor,
                        immediate_retrigger_count = excluded.immediate_retrigger_count,
                        last_error = excluded.last_error,
                        updated_at = excluded.updated_at`)
                    .run(
                        toId,
                        droppedPreparedCandidate ? 'idle' : state,
                        droppedPreparedCandidate ? 'idle' : (readState('schedulerState', 'scheduler_state') ?? 'idle'),
                        publishedRevision,
                        publishedRevision,
                        readState('sourceStepCursor', 'source_step_cursor'),
                        readState('sourceRoundCursor', 'source_round_cursor'),
                        readState('retryCount', 'retry_count'),
                        readState('backoffUntil', 'backoff_until'),
                        readState('hardPaused', 'hard_paused'),
                        readState('cooldownUntil', 'cooldown_until'),
                        readState('circuitBroken', 'circuit_broken'),
                        readState('lastReplaceStepCursor', 'last_replace_step_cursor'),
                        readState('immediateRetriggerCount', 'immediate_retrigger_count'),
                        readState('lastError', 'last_error'),
                        readState('updatedAt', 'updated_at') ?? Math.floor(Date.now() / 1000),
                    );
            }
            db.prepare(`UPDATE provider_request_ledger
                    SET conversation_id = ?
                    WHERE conversation_id = ?`)
                .run(toId, fromId);
            db.prepare('DELETE FROM context_generation_state WHERE conversation_id = ?').run(fromId);
            db.prepare('DELETE FROM records WHERE conversation_id = ?').run(fromId);
            return true;
        });
        return promote();
    });

    // 删除某对话的 record（对话删除时已由外键级联，这里供显式失效用）
    ipcMain.handle('record:delete', (_e, conversationId: string) => {
        if (!conversationId) return false;
        const remove = db.transaction(() => {
            db.prepare('DELETE FROM context_generation_state WHERE conversation_id = ?').run(conversationId);
            db.prepare('DELETE FROM records WHERE conversation_id = ?').run(conversationId);
            return true;
        });
        return remove();
    });
}
