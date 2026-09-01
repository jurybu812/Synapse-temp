/**
 * Round Truncation（按轮截断 / record 砍批 共享 helper）—— Plan_5 梯队二 M5-3/4/5 共用真相源。
 *
 * 规范依据：`Plan_5_压缩回溯统一模型规范.md`
 *   §1（轮 / step 定义）、§3（回溯）、§4（分支）、§5（重试）。
 * 返工映射：`Plan_5_压缩核对偏差清单与返工映射.md` §3.2 M5-3 / M5-4 / M5-5。
 *
 * ★ 为什么三处共用一个 helper（回溯 / 重试 / 分支高度交织）：
 *   三者都以「某条 user 消息 = 轮起点」为锚，都要做同一件事——
 *     ① 把点击点向【轮边界】取整定位目标轮；
 *     ② 算出「截到第几条消息」（按轮取整，绝不在轮中间切）；
 *     ③ 把 record 批次砍到同一轮边界（keptRounds / keptSteps 与 clampToBatch / copyRecord 同口径）。
 *   只有「填输入框待发（回溯）/ 自动发出（重试）/ 落成新对话（分支）」这一步不同。
 *   把①②③收敛进本 helper，避免三处各写一遍轮取整逻辑产生口径漂移（M5-2 之前正是因为各处把
 *   「轮」当 user 条数才跑偏）。本 helper 复用 roundBoundary 的 identifyRounds（M5-2 ★地基）。
 *
 * ★ 四种截断模式（对应规范的锚语义）：
 *   - `'undo'`（回溯，规范 §3 现行口径 / 2026-06-17 修订）：点哪条 user，保留【到该 user 所在轮之前】
 *       （上一整轮结束），该 user【及之后】整段丢弃，并把该 user 回填【当前对话】输入框待发。
 *       计算上等价于 branch-user（见下），区别仅在落地：undo 原地裁剪当前对话、branch 落新对话。
 *   - `'round-end'`：保留【目标轮 N 整轮】+ 回填第 N+1 轮 user。M5-3 早期回溯口径，回溯现已改用 undo；
 *       本模式保留供「分支点非 user」复用（见 branch）。
 *   - `'before-user'`（重试）：点某条 user，保留【到该 user 段为止】（含该 user），其所在轮的 model 段
 *       （本轮全部 assistant / tool 中间 step）丢弃，随后该 user 自动重发。即该轮回退成「只发了 user、
 *       还没出 model」的半轮态——record 按轮口径此时该轮尚未完成，keptRounds 取到上一整轮。
 *   - `'branch'`（分支，规范 §4「新对话=老对话回溯到分支点后的状态」）：
 *       · 分支点是 user 消息 → 该 user 所在轮【整轮不进子集】（保留到上一整轮 R−1 结束），该 user 作为
 *         pendingUserMessage 回填【新对话】输入框待发（与回溯对齐：分支点 user = 轮起点，不落进子集而进输入框）。
 *       · 分支点非 user（assistant / tool，即落在某轮 model 段中间/末尾）→ 保留【该轮整轮】（round-end 同款），
 *         无 pendingUserMessage（model 段处不存在「该轮起点 user 回填」语义）。
 *       两种情形都【向轮边界取整、绝不轮中间切】，与回溯/重试同一套口径。
 *
 * ★ step / round 口径（与 recordStore.clampToBatch / copyRecord / RecordBatch.roundEnd 严格一致）：
 *   - keptSteps：保留消息里 role!=='tool' 的条数（tool 不算 step，规范 §1）。
 *   - keptRounds：在【保留且已完成】的消息子集上 identifyRounds 得到的真轮数（连发 user 合并 1 轮）。
 *     —— 'round-end' 模式：保留子集 = slice(0, lastKeptIdx+1)，含目标轮整轮 → keptRounds = N。
 *     —— 'before-user' 模式：保留子集仅到该 user，但该轮 model 段未完成、不应让 record 认为该轮已压；
 *         故 keptRounds 取「该 user 所在轮 − 1」（= 上一整轮），让 clampToBatch 把覆盖该轮的批也砍掉。
 */

import { identifyRounds } from './roundBoundary';
import { clampToBatch, type SynapseRecord } from './recordStore';

interface RoleLike {
  id: string;
  role: string;
}

export type RoundTruncationMode = 'round-end' | 'before-user' | 'branch' | 'undo';

export interface RoundTruncationResult {
  /** 是否定位成功（anchorMsgId 在 messages 中、且能算出有效截断点）。失败时其它字段为安全空值。 */
  ok: boolean;
  /** 点击点所在轮号（1 起，含 tool 内联的 model 段）。 */
  anchorRound: number;
  /** 保留范围内【最后一条要保留的消息】下标（含）。-1 表示不保留任何消息（整段清空）。 */
  lastKeptIndex: number;
  /** 保留范围内最后一条消息的 id（= messages[lastKeptIndex].id）；lastKeptIndex<0 时为 null。 */
  lastKeptMessageId: string | null;
  /** 被截掉的消息（lastKeptIndex 之后的全部），供调用方 GC / 复制隔离。 */
  removedMessages: RoleLike[];
  /** record 砍批用：截断后保留的【真轮数】（与 RecordBatch.roundEnd 同口径，连发 user 合并 1 轮）。 */
  keptRounds: number;
  /** record 砍批用：截断后保留的消息条数（不含 tool，与 agentLoop requestHistory 同口径）。 */
  keptSteps: number;
  /**
   * 回溯/分支「填输入框待发」用：要回填到输入框的【那条 user 消息】。
   *   - 'undo'（回溯）/ 'branch'（分支点是 user）：= 点击的那条 user（其所在轮被排除、整段移入输入框）。
   *   - 'round-end' 模式：= 第 N+1 轮的 user 消息；目标轮已是末轮（无 N+1）时为 null。
   *   - 'before-user'（重试）/ 'branch'（分支点非 user）：本字段恒为 null（重试自动重发、不填输入框）。
   */
  pendingUserMessage: RoleLike | null;
}

/**
 * 给 messages 里每条消息（含 tool）标注它所属的轮号（1 起）。
 *
 * identifyRounds 的 stepToRound 对 tool 角色记 0（tool 不占 step），但 tool 物理上夹在同一轮的 model
 * 段中间，逻辑上属于其前一条非 tool 消息所在轮。这里把 0 的位置回填为「前一条已知轮号」，得到
 * 每条消息（含 tool）的所属轮，便于按消息下标找轮边界。开头若出现 tool（极端、几乎不发生）回填为其
 * 后第一条非 tool 的轮号；全程无非 tool 时记 0。
 */
function buildMessageRounds(messages: ReadonlyArray<RoleLike>): number[] {
  const { stepToRound } = identifyRounds(messages);
  const rounds = stepToRound.slice();
  // 前向填充：tool（0）继承前一条非 0 轮号。
  let last = 0;
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i] === 0) rounds[i] = last;
    else last = rounds[i];
  }
  // 后向兜底：开头连续的 tool（前面没有非 tool 可继承，仍为 0）继承其后第一条非 0 轮号。
  let nextKnown = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i] === 0) rounds[i] = nextKnown;
    else nextKnown = rounds[i];
  }
  return rounds;
}

/** 统计一段消息里 role!=='tool' 的条数（= step 口径，不含 tool）。 */
function countSteps(messages: ReadonlyArray<RoleLike>): number {
  let n = 0;
  for (const m of messages) if (m.role !== 'tool') n++;
  return n;
}

/**
 * 按轮截断的统一计算（不产生任何副作用，纯函数）。
 *
 * @param messages   当前对话完整消息列表（含 tool；store.messages / branchConversation 入参均可）。
 * @param anchorMsgId 点击锚定的消息 id（回溯/分支：任意消息；重试：那条 user 消息）。
 * @param mode       截断模式（见 RoundTruncationMode）。
 * @returns RoundTruncationResult；anchor 不存在则 ok=false。
 */
export function computeRoundTruncation(
  messages: ReadonlyArray<RoleLike>,
  anchorMsgId: string,
  mode: RoundTruncationMode,
): RoundTruncationResult {
  const empty: RoundTruncationResult = {
    ok: false,
    anchorRound: 0,
    lastKeptIndex: -1,
    lastKeptMessageId: null,
    removedMessages: [],
    keptRounds: 0,
    keptSteps: 0,
    pendingUserMessage: null,
  };

  const anchorIdx = messages.findIndex(m => m.id === anchorMsgId);
  if (anchorIdx < 0) return empty;

  const msgRounds = buildMessageRounds(messages);
  const anchorRound = msgRounds[anchorIdx] || 0;
  if (anchorRound <= 0) return empty;

  const anchorIsUser = messages[anchorIdx].role === 'user';
  // 分支点 / 回溯点是 user 时按「回到该轮起点」处理：该 user 整轮不进保留子集、改回填输入框。
  //   - 'branch'：分支点 user → 回填【新对话】输入框（规范 §4）。
  //   - 'undo'（回溯，规范 §3 修订口径）：点哪条 user，那条 user 回填【当前对话】输入框，它及之后
  //     全部回溯掉（= 回到该 user 所在轮之前）。与重试 'before-user' 的区别——回溯不保留该 user
  //     （移入输入框待改后再发），重试保留该 user 并自动重发。两者截断点同为「该 user 所在轮之前」。
  const branchExcludesRound = (mode === 'branch' || mode === 'undo') && anchorIsUser;

  // 「保留到第几轮整轮」：
  //   - round-end / branch-非user：保留目标轮 N 整轮 → roundUpperBound = anchorRound。
  //   - branch-user：该 user 所在轮整轮不进子集 → roundUpperBound = anchorRound − 1（保留到上一整轮）。
  const roundUpperBound = branchExcludesRound ? anchorRound - 1 : anchorRound;

  let lastKeptIndex: number;

  if (mode === 'before-user') {
    // 重试：保留到「该 user 段」为止（含该 user），丢弃本轮 model 段。
    // 该 user 段 = 从 anchorIdx 起、同轮、连续的 user 消息（连发多条 user 都保留）；遇到本轮第一条
    // 非 user（model 段起点）即停。这样「截断该 user 段之后全部，含本轮 model 段所有 assistant/tool」。
    let i = anchorIdx;
    while (
      i + 1 < messages.length
      && msgRounds[i + 1] === anchorRound
      && messages[i + 1].role === 'user'
    ) {
      i++;
    }
    lastKeptIndex = i;
  } else {
    // 回溯（round-end）/ 分支：保留 roundUpperBound 整轮 → lastKept = 轮号 <= 上界的最后一条消息下标。
    //   branch-user 且 roundUpperBound=0（分支点是第 1 轮的 user）→ 无任何消息保留（lastKeptIndex=-1，
    //   新对话空、只把该 user 回填输入框）。
    lastKeptIndex = -1;
    if (roundUpperBound >= 1) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (msgRounds[i] > 0 && msgRounds[i] <= roundUpperBound) { lastKeptIndex = i; break; }
      }
    }
  }

  const kept = lastKeptIndex >= 0 ? messages.slice(0, lastKeptIndex + 1) : [];
  const removedMessages = messages.slice(lastKeptIndex + 1);
  const lastKeptMessageId = lastKeptIndex >= 0 ? messages[lastKeptIndex].id : null;

  const keptSteps = countSteps(kept);

  // keptRounds：record 批次按【已完成轮】记 roundEnd。
  //   - 'round-end' / 'branch'：保留子集恰好是若干整轮 → 真轮数 = identifyRounds(kept 去 tool).totalRounds
  //       （= roundUpperBound）。branch-user 已把该 user 整轮排除，子集天然按轮对齐。
  //   - 'before-user'：保留子集到该 user 为止、本轮 model 段未完成；该轮不应被视作「已压缩完成」，
  //       故对 record 而言保留轮 = 该轮 − 1（上一整轮）。identifyRounds(kept) 会把该半轮也算 1 轮，
  //       这里减 1 修正，使 clampToBatch 把覆盖该轮的批一并砍掉（规范 §5「砍对应批次」）。
  const keptFiltered = kept.filter(m => m.role !== 'tool');
  const fullRounds = identifyRounds(keptFiltered).totalRounds;
  const keptRounds = mode === 'before-user'
    ? Math.max(0, anchorRound - 1)
    : fullRounds;

  // 「填输入框待发」的那条 user：
  //   - 'round-end'（回溯）：保留范围之后那一轮（anchorRound+1）的 user 段首条（= 第 N+1 轮 user）。
  //   - 'branch' 分支点是 user：就是被排除的那条 user（anchorRound 这一轮的 user 段首条，通常 = 点击的那条）。
  //   - 'branch' 分支点非 user / 'before-user'：无（null）。
  let pendingUserMessage: RoleLike | null = null;
  if (mode === 'round-end') {
    const nextRound = anchorRound + 1;
    for (let i = lastKeptIndex + 1; i < messages.length; i++) {
      if (msgRounds[i] === nextRound && messages[i].role === 'user') {
        pendingUserMessage = messages[i];
        break;
      }
      // 越过 nextRound（理论不应在找到 user 前发生）→ 停。
      if (msgRounds[i] > nextRound) break;
    }
  } else if (branchExcludesRound) {
    // 被排除轮（anchorRound）的 user 段首条 = 该轮起点 user。从 lastKeptIndex+1 起找该轮第一条 user。
    for (let i = lastKeptIndex + 1; i < messages.length; i++) {
      if (msgRounds[i] === anchorRound && messages[i].role === 'user') {
        pendingUserMessage = messages[i];
        break;
      }
      if (msgRounds[i] > anchorRound) break;
    }
  }

  return {
    ok: true,
    anchorRound,
    lastKeptIndex,
    lastKeptMessageId,
    removedMessages,
    keptRounds,
    keptSteps,
    pendingUserMessage,
  };
}

/**
 * record 砍批到轮边界（回溯 / 重试 共用）：把某对话 record 的批次裁剪到 RoundTruncationResult 算出的
 * keptRounds / keptSteps（recordStore.clampToBatch 内部按「step + round 双口径取保守」整批回退原文，
 * 绝不轮中间切，见 clampToBatch 注释）。历史变更必须 fail-closed：底层失败向上抛出，不能继续截断消息。
 *
 * 分支（M5-5）不走本函数——它要把源 record【拷贝】到新对话（copyRecord / copyRecordFrom，同样消费
 * 本 result 的 keptRounds / keptSteps），而非原地裁剪源对话。
 *
 * @param conversationId 当前对话 id（回溯/重试就地裁剪自身 record）。
 * @param result computeRoundTruncation 的产出（取 keptRounds / keptSteps）。
 */
export async function clampRecordToRoundTruncation(
  conversationId: string,
  result: Pick<RoundTruncationResult, 'keptRounds' | 'keptSteps'>,
): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  return clampToBatch(conversationId, result.keptRounds, result.keptSteps);
}
