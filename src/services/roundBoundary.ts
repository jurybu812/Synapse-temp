/**
 * Round Boundary（轮边界识别层）—— Plan_5 M5-2 ★地基模块。
 *
 * 规范依据：`Plan_5_压缩回溯统一模型规范.md` §1（轮次 / step 定义，2026-06-17 用户拍板）。
 *
 * ★ step 定义（权威）：step = 一次 user 消息 或 一次 model API 往返；**没有「工具步」之分**——
 *   tool 结果不单独算 step，它附着在那次 model step 上。故本模块输入的消息序列应当是
 *   【已过滤 tool 角色】的序列（与 agentLoop requestHistory / record stepStart/stepEnd 口径一致）；
 *   为健壮起见，identifyRounds 内部也会跳过 tool 角色（不计入 step）。
 *
 * ★ 轮次（round）定义：一轮 = 一个 user→model 完整循环。
 *   - user 段：连续的 user 消息（中间没有 model 完整响应），1 条或连发多条都归同一轮的 user 段。
 *   - model 段：紧随其后的 model 响应（assistant / system），含其间所有工具调用、子代理派发与回收
 *     —— 这些只是把多个 model step 串起来，**不增加轮次**，直到下一轮起点（下一条新 user）。
 *   - 轮起点：上一段已有 model 响应（model 段）之后出现的【第一条新 user 消息】。
 *   - user 已发、model 还没回 = 新一轮【已经开始】。
 *
 * 产出（供压缩 / 回溯 / 分支 / 重试四处共用的单一真相源）：
 *   1. `stepToRound`：消息 index → 轮号（1 起）。长度 = 输入序列长度；被跳过的 tool 角色记 0。
 *   2. `rounds`：轮号 → [stepStart, stepEnd) 半开区间（按【已过滤 tool 的 step 计数】记），
 *      与 RecordBatch.stepStart/stepEnd（半开、不含 tool）口径严格一致。
 *
 * ★ 退化等价：在「无连续 user 合并、无一轮多 model step」的常规交替序列 [u,a,u,a,...] 上，
 *   轮数 === user 条数，与改造前「按 user 条数算轮」完全等价；只有出现连发 user 或多步 model
 *   （工具循环 / 子代理）时，本层才把它们正确收敛进同一轮，从根上修掉「轮 = user 条数」的偏差。
 */

/** 一个轮的 step 跨度，半开区间 [stepStart, stepEnd)，step 计数不含 tool（与 RecordBatch 同口径）。 */
export interface RoundRange {
  /** 轮号（1 起，连续递增） */
  round: number;
  /** 本轮起始 step（含，0 起，不含 tool 的累计计数） */
  stepStart: number;
  /** 本轮终止 step（不含，= 下一轮 stepStart / 序列末尾），半开 */
  stepEnd: number;
}

/** 轮边界识别结果 */
export interface RoundBoundaryResult {
  /**
   * 输入序列每个 index 对应的轮号（1 起）。被跳过的 tool 角色记 0（它不占 step）。
   * 注意：本数组以【原始输入 index】对齐（含 tool 位置），便于按消息下标反查轮号；
   * 而 `rounds` 的 stepStart/stepEnd 是【过滤 tool 后的 step 计数】口径。两者不要混用。
   */
  stepToRound: number[];
  /** 轮号 → [stepStart, stepEnd) 列表（step 计数，不含 tool），按轮号升序。 */
  rounds: RoundRange[];
  /** 总轮数（= 最后一轮 round；空序列为 0）。 */
  totalRounds: number;
  /** 总 step 数（= 不含 tool 的消息条数；= 末轮 stepEnd）。 */
  totalSteps: number;
}

interface RoleLike {
  role: string;
}

/**
 * 在一个消息序列上识别轮边界。
 *
 * @param messages 消息序列（含或不含 tool 均可——tool 角色不计入 step、不影响轮号；
 *   推荐传入已过滤 tool 的序列以与 record / requestHistory 口径完全一致）。
 * @returns 轮号映射表与每轮 step 跨度（见 RoundBoundaryResult）。
 */
export function identifyRounds(messages: ReadonlyArray<RoleLike>): RoundBoundaryResult {
  const stepToRound: number[] = new Array(messages.length).fill(0);
  const rounds: RoundRange[] = [];

  let currentRound = 0;
  let stepCount = 0;          // 不含 tool 的累计 step 计数
  // expectNewRound：下一条 user 是否应开启新一轮。
  //   初值 true → 序列首条 user 即开第 1 轮；
  //   遇 model 段（assistant/system）置 true → 其后第一条 user 开新轮；
  //   连续 user 期间为 false → 不再开新轮（合并进同一轮的 user 段）。
  let expectNewRound = true;

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === 'tool') {
      // tool 结果不是独立 step：不推进 step 计数、不改变轮号、不映射有效轮号（记 0）。
      stepToRound[i] = 0;
      continue;
    }

    if (role === 'user') {
      if (expectNewRound || currentRound === 0) {
        // 新一轮起点：上一段是 model 段（或这是首个有效 step）。
        currentRound++;
        rounds.push({ round: currentRound, stepStart: stepCount, stepEnd: stepCount });
        expectNewRound = false;
      }
      // 连续 user（expectNewRound=false）：合并进当前轮的 user 段，不新增轮。
    } else {
      // model 段（assistant / system 及其它非 user/tool 角色）。
      if (currentRound === 0) {
        // 极端：序列开头就是 model（无 user 前缀，几乎不发生）——开一个隐式第 1 轮收纳它，
        // 避免出现轮号 0 的有效 step。
        currentRound++;
        rounds.push({ round: currentRound, stepStart: stepCount, stepEnd: stepCount });
      }
      // model 出现后，下一条 user 将开启新一轮。
      expectNewRound = true;
    }

    stepToRound[i] = currentRound;
    stepCount++;
    rounds[rounds.length - 1].stepEnd = stepCount; // 当前轮末尾随 step 推进
  }

  return {
    stepToRound,
    rounds,
    totalRounds: currentRound,
    totalSteps: stepCount,
  };
}

/**
 * 把一个【step 计数】向下取整到 ≤ 它的最近轮起点（轮 stepStart）。
 *
 * 用途（规范 §1「保留与批次边界一律按轮取整，不在轮中间切」）：当某个 step 游标（如旧 record 的
 * totalSteps、或回溯保留的 keptSteps）可能落在某一轮中间时，用本函数把它对齐回该轮的起点，
 * 保证「所在轮整轮回退原文 / 整轮保留」，绝不在轮中间切。
 *
 * @param result identifyRounds 的产出（其 rounds 必须基于与 stepCount 同一序列、同一 step 口径）。
 * @param stepCount 待取整的 step 计数（[0, totalSteps]）。
 * @returns ≤ stepCount 的最大轮起点 stepStart；若 stepCount 落在末轮之后（>= totalSteps）则原样返回。
 */
export function floorStepToRoundStart(result: RoundBoundaryResult, stepCount: number): number {
  const s = Math.max(0, stepCount);
  if (s >= result.totalSteps) return s;
  // 找包含 step=s 的轮（stepStart <= s < stepEnd），返回其 stepStart。
  // 恰好落在轮边界（s === 某轮 stepStart）时本身就是轮起点，直接返回。
  for (const r of result.rounds) {
    if (s >= r.stepStart && s < r.stepEnd) return r.stepStart;
  }
  return s;
}

/**
 * 计算「保留最近若干【整轮】原文」的起始 step index（compressContext 按 token→向轮边界取整用）。
 *
 * 规则（规范 §2「按 token / 轮次保底规则算出保留最近几轮原文」）：
 *   - 从最后一轮往前累加各轮 token，纳入整轮，直到再纳入下一更早的整轮会超过 budgetTokens 为止。
 *   - 至少保留 `minRounds` 整轮（保底），即便单轮就超预算也保留整轮（绝不轮中间切）。
 *   - 返回保留段的起始 step index（= 被保留的最早那一轮的 stepStart）；该 index 之前为被压段。
 *
 * ★ 前置条件（硬约束，调用方必须保证）：`messages` 【不含 tool 角色】。
 *   原因：本函数用 rounds 的 [stepStart, stepEnd)（过滤 tool 后的 step 计数）直接索引 `messages`，
 *   仅当输入不含 tool 时，消息下标才与 step 下标对齐；若混入 tool，下标会错位、token 累加与返回的
 *   step index 都不可信。compressContext 入参（requestHistory 已过滤 tool）天然满足；其它复用方
 *   （回溯/分支）务必先过滤 tool 再调本函数，绝不可把含 tool 的 raw message 数组传进来。
 *
 * @param messages   消息序列（★ 必须不含 tool，与 agentLoop requestHistory 同口径）。
 * @param budgetTokens 保留原文的 token 预算上界（大致量；实际保留向整轮取整）。
 * @param tokenOf    单条消息 → token 估算函数（由调用方注入，避免本模块依赖 estimateTokens）。
 * @param minRounds  至少保留的整轮数（默认 1）。
 * @returns 保留段起始 step index（[0, totalSteps]）；无轮时返回 0。
 */
export function keepRecentRoundsStartStep<T extends RoleLike>(
  messages: ReadonlyArray<T>,
  budgetTokens: number,
  tokenOf: (msg: T) => number,
  minRounds = 1,
): number {
  const result = identifyRounds(messages);
  const rounds = result.rounds;
  if (rounds.length === 0) return 0;

  // 预算非正 → 仅保留最低保底轮数。
  const budget = Math.max(0, budgetTokens);

  // 每轮 token：按 rounds 的 step 区间直接索引 messages 累加。
  // ★ 依赖前置条件「messages 不含 tool」——此时消息下标 === step 下标，区间映射成立（见函数头注释）。
  const roundTokens: number[] = rounds.map(r => {
    let t = 0;
    for (let i = r.stepStart; i < r.stepEnd; i++) t += tokenOf(messages[i]);
    return t;
  });

  const minKeep = Math.max(1, minRounds);
  let kept = 0;          // 已保留的轮数（从末轮往前）
  let acc = 0;           // 已保留轮的累计 token
  for (let idx = rounds.length - 1; idx >= 0; idx--) {
    const next = acc + roundTokens[idx];
    if (kept < minKeep) {
      // 保底阶段：无条件纳入（即便超预算也要满足 minRounds）。
      acc = next;
      kept++;
      continue;
    }
    if (next > budget) break; // 再纳入这更早一轮就超预算 → 停，保留已纳入的整轮。
    acc = next;
    kept++;
  }

  const firstKeptRoundIdx = rounds.length - kept;
  return rounds[firstKeptRoundIdx].stepStart;
}
