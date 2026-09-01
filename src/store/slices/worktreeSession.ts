import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/** worktree 路径归一（反斜杠→正斜杠 + 去尾斜杠 + 小写），用于跨 Windows 大小写/分隔符的路径相等比较。 */
function normalizeWtPath(p: string | null | undefined): string {
  return (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * M2-5：会话级「活动 worktree」运行态（M3 演进：按执行上下文索引）。
 *
 * 设计要点（方案见 Plan_4_M3 §一「worktree 改按需」+ §七「M3 并行子代理隔离」）：
 * - 不默认绑 worktree。无活动 worktree 时（某 contextId 无条目）所有 fs/命令工具在主工作区，
 *   行为与现状逐字节一致——回归零风险。
 * - 只有 agent（自己判断）或用户（明确要求）认为需要隔离时，才调 enter_worktree 进入；
 *   进入后 fs(view_file/list_dir/write_to_file)/run_command 的根路径重定向到该 worktree 目录。
 *
 * 为什么是【按 contextId 索引的 map，而非单一全局槽位】（high 重构）：
 * - 旧版只有一个全局 {activeWorktreePath} 槽位，无法支撑两类场景：
 *   ① 切换对话：A 对话 enter_worktree 后切到 B，B 的 fs/命令仍被重定向到 A 的 worktree（隔离被打穿）；
 *   ② M3 并行子代理：N 个子代理共享同一 store / toolRegistry / getActiveRoots()，并发 enter_worktree
 *      会互相覆盖唯一全局槽位（最后进入者赢），并行隔离根本不成立。
 * - 改为 byContext[contextId] = {activeWorktreePath, activeBranch, repoRoot}：
 *   contextId 现阶段 = conversationId（含 AUTOSAVE_ID）；M3 阶段 = agentId/subagentId。
 *   每个上下文各自一条，互不串台。getActiveRoots/resolveWorktreePath/run_command 的 cwd 解析
 *   都带 contextId 解析对应条目——「当前执行上下文 id」由 agentLoop 执行工具时注入。
 *
 * 为什么是【运行态、不持久化、不进 DB】：
 * - 活动 worktree 是临时状态。重启回主工作区是合理的：worktree 本身在 git 里仍然存在，
 *   重进 enter_worktree（同分支会复用而非重建）即可继续。
 * - 独立 slice 的 action 前缀是 `worktreeSession/`，不匹配 store/index.ts persistMiddleware
 *   的任何持久化分支（settings/theme/agentSettings/multiAI/layout），天然不写 localStorage。
 * - 不塞进 conversation slice：那会牵动 conversationPersistence 落库/迁移与 IPC（M2-6/M2-3 那条链路），
 *   违背「按需 + 回归零风险」；也不放 agentSettings：它的任何 action 都会被 persistMiddleware 固化。
 */

/** 单个执行上下文的活动 worktree 条目。 */
export interface WorktreeContextEntry {
  /** 当前上下文正处于的 worktree 绝对路径；条目存在即代表「处于该 worktree」。 */
  activeWorktreePath: string;
  /** 活动 worktree 对应的分支名（仅展示/诊断用）。 */
  activeBranch: string | null;
  /** 进入该 worktree 时所基于的 git 仓库根（= 进入那一刻的主工作区路径）。
   *  绝对路径前缀重写以【此锚定值】为基准，不随后续工作区切换漂移（见 fileSystem.resolveWorktreePath）。 */
  repoRoot: string | null;
}

interface WorktreeSessionState {
  /** 按执行上下文 id 索引的活动 worktree 条目。无 key = 该上下文在主工作区（默认）。 */
  byContext: Record<string, WorktreeContextEntry>;
}

const initialState: WorktreeSessionState = {
  byContext: {},
};

export const worktreeSessionSlice = createSlice({
  name: 'worktreeSession',
  initialState,
  reducers: {
    /** 某上下文进入某 worktree：后续该上下文的 fs/命令重定向到 activeWorktreePath。 */
    enterWorktree(
      state,
      action: PayloadAction<{
        contextId: string;
        path: string;
        branch?: string | null;
        repoRoot?: string | null;
      }>,
    ) {
      const { contextId, path, branch, repoRoot } = action.payload;
      if (!contextId) return;
      state.byContext[contextId] = {
        activeWorktreePath: path,
        activeBranch: branch ?? null,
        repoRoot: repoRoot ?? null,
      };
    },
    /** 某上下文退出 worktree：回主工作区，该上下文 fs/命令恢复默认根（行为同现状）。
     *  未传 contextId 或该上下文本无条目时是安全空操作。 */
    exitWorktree(state, action: PayloadAction<{ contextId: string } | undefined>) {
      const contextId = action.payload?.contextId;
      if (!contextId) return;
      delete state.byContext[contextId];
    },
    /** 清空所有上下文的活动 worktree（全部回主工作区）。 */
    clearAllWorktrees(state) {
      state.byContext = {};
    },
    /** ★ 审查 MEDIUM：删除某 worktree 目录后，清掉所有仍指向该路径的悬空条目（防后续 fs/命令重定向到已删目录）。
     *  路径归一比较，兼容 Windows 大小写/分隔符差异。 */
    exitWorktreeByPath(state, action: PayloadAction<{ path: string }>) {
      const target = normalizeWtPath(action.payload?.path);
      if (!target) return;
      for (const contextId of Object.keys(state.byContext)) {
        if (normalizeWtPath(state.byContext[contextId].activeWorktreePath) === target) {
          delete state.byContext[contextId];
        }
      }
    },
    /** ★ #8 选A（fork 重绑）：未保存对话 fork 成真 id 时，把其活动 worktree 条目从 fromId 迁到 toId，
     *  让在跑的 run 重绑新 id 后仍解析到同一 worktree（不退回主工作区写错地方）。无该上下文条目时安全空操作。 */
    renameWorktreeContext(state, action: PayloadAction<{ fromId: string; toId: string }>) {
      const { fromId, toId } = action.payload;
      if (!fromId || !toId || fromId === toId) return;
      const src = state.byContext[fromId];
      if (!src) return;
      state.byContext[toId] = src;
      delete state.byContext[fromId];
    },
  },
  extraReducers: (builder) => {
    // ★ medium#6 次生项：工作区打开/切换/关闭 → 所有 worktree 的锚定基准（repoRoot/工作区根）都变了，
    //   旧的活动 worktree 已不对应新工作区，统一清空回主工作区，避免「相对路径仍拼旧 worktree」的割裂。
    //   用 matcher 监听 workspace slice 的 action type（不引入 workspace 依赖、不在 reducer 里 cross-dispatch）。
    builder.addMatcher(
      (action: any) =>
        action?.type === 'workspace/openWorkspace'
        || action?.type === 'workspace/closeWorkspace'
        || action?.type === 'workspace/clearWorkspace',
      (state) => {
        state.byContext = {};
      },
    );
  },
});

export const { enterWorktree, exitWorktree, exitWorktreeByPath, renameWorktreeContext, clearAllWorktrees } = worktreeSessionSlice.actions;

/**
 * 从 worktreeSession state 读出某上下文的活动 worktree 条目（无则 null）。
 * 供 fileSystem.getActiveRoots / toolRegistry 等非组件代码统一取值，避免各处自己摸 state 结构。
 */
export function selectWorktreeEntry(
  state: { worktreeSession?: WorktreeSessionState } | any,
  contextId: string | null | undefined,
): WorktreeContextEntry | null {
  if (!contextId) return null;
  const entry = state?.worktreeSession?.byContext?.[contextId];
  return entry ?? null;
}
