/**
 * Synapse 输入区命令层 — /loop 最小循环驱动器（M4-6-S4）
 *
 * 语义（Plan_5 §4.5 + §7 决议 1「本里程碑只做最小版」）：
 *   对【同一条指令】串行重复发送 N 次，每次等上一轮 isStreaming 结束后再发下一轮。
 *   不做 CC 式「AI 自判是否完成、未完成带上轮结果继续」的收敛循环（留后续里程碑）。
 *
 * 硬约束（Plan_5 风险3「/loop 失控连发」必过项）：
 *   1. 硬上限 LOOP_HARD_CAP：无论用户传多大次数，最多跑这么多轮，杜绝失控连发。
 *   2. 可中断：start() 返回前登记中断标志；stop() 置位后，循环在【每个 await 检查点】立即退出，
 *      正在跑的那一轮由 handleStop 同时调 agentLoop.stop() 中止（本驱动器只负责不再发下一轮）。
 *   3. 单例重入闸：已有循环在跑时 start() 拒绝二次进入（避免两路 loop 交错发送）。
 *   4. 每轮等流式结束用轮询 isStreaming()，带【单轮超时】兜底——某轮异常卡死不会让整个循环永久挂起。
 *
 * 依赖注入（不直接 import store/agentLoop，便于测试与隔离，与 SlashRunContext.helpers 同思路）：
 *   - runAgent(text)：把指令作为普通用户输入交给主 agent 跑一轮。
 *   - isStreaming()：读当前是否流式中（= 上一轮是否还在跑）。
 *   - notify(payload)：进度 / 收尾通知。
 */

/** 循环硬上限——无论用户传多大次数，最多串行跑这么多轮（防失控连发）。 */
export const LOOP_HARD_CAP = 20;
/** 轮询 isStreaming 的间隔（ms）。 */
const POLL_INTERVAL_MS = 250;
/** 发出指令后【等待本轮进入流式】的最长时间（ms）——超时视为本轮未真正发出，提前收尾。 */
const ENTER_STREAMING_TIMEOUT_MS = 8000;
/** 单轮【流式持续】的最长等待时间（ms）——某轮异常卡死时兜底退出，不永久挂起整个循环。 */
const ROUND_STREAMING_TIMEOUT_MS = 10 * 60 * 1000;

export interface LoopRunnerDeps {
  /** 把一段文本作为普通用户输入交给主 agent 跑（复用既有 agentLoop.run 链路）。 */
  runAgent: (text: string) => void;
  /** 读当前是否流式中（上一轮是否仍在跑）。 */
  isStreaming: () => boolean;
  /** 进度 / 收尾通知。 */
  notify: (payload: { type: 'info' | 'success' | 'warning' | 'error'; title: string; message: string }) => void;
}

class LoopRunner {
  /** 当前是否有循环在跑（单例重入闸）。 */
  private running = false;
  /** 中断标志：stop() 置 true，循环在每个检查点据此提前退出。 */
  private aborted = false;

  /** 当前是否正在跑循环（供 handleStop 判断是否需要 stop()）。 */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 启动循环：串行重发 instruction 共 effectiveTimes 轮（= min(times, LOOP_HARD_CAP)）。
   * fire-and-forget——内部 await 自管，调用方无需 await（命令 run 立即返回，循环在后台串行推进）。
   */
  start(times: number, instruction: string, deps: LoopRunnerDeps): void {
    const text = (instruction ?? '').trim();
    if (!text) {
      deps.notify({ type: 'warning', title: '/loop', message: '指令为空，未启动循环' });
      return;
    }
    if (this.running) {
      deps.notify({ type: 'info', title: '/loop', message: '已有循环在进行中，请先停止再启动新循环' });
      return;
    }
    // 次数夹取：≥1 且 ≤ 硬上限。
    const requested = Math.max(1, Math.floor(times) || 1);
    const effectiveTimes = Math.min(requested, LOOP_HARD_CAP);

    this.running = true;
    this.aborted = false;
    deps.notify({
      type: 'info',
      title: '/loop 启动',
      message: requested > effectiveTimes
        ? `将串行推进 ${effectiveTimes} 轮（已按硬上限 ${LOOP_HARD_CAP} 截断，原请求 ${requested} 轮）`
        : `将串行推进 ${effectiveTimes} 轮（可随时点停止中断）`,
    });

    void this.loop(effectiveTimes, text, deps);
  }

  /** 请求中断当前循环（handleStop 调用）。正在跑的那一轮由调用方另行 agentLoop.stop()。 */
  stop(): void {
    if (this.running) this.aborted = true;
  }

  /** 串行循环主体。每个 await 检查点都查 aborted，置位即提前收尾。 */
  private async loop(total: number, text: string, deps: LoopRunnerDeps): Promise<void> {
    let completed = 0;
    try {
      for (let i = 0; i < total; i++) {
        if (this.aborted) break;

        // 若上一轮（或外部其它发送）仍在流式中，先等它结束再发下一轮（串行保证）。
        await this.waitUntil(() => !deps.isStreaming(), ENTER_STREAMING_TIMEOUT_MS, deps);
        if (this.aborted) break;

        // 发本轮指令。
        deps.notify({ type: 'info', title: `/loop ${i + 1}/${total}`, message: text.slice(0, 40) });
        deps.runAgent(text);

        // 等本轮真正进入流式（runAgent 内部异步置 isStreaming）。超时则认为本轮未发出，停止循环。
        const entered = await this.waitUntil(() => deps.isStreaming(), ENTER_STREAMING_TIMEOUT_MS, deps);
        if (this.aborted) break;
        if (!entered) {
          deps.notify({ type: 'warning', title: '/loop', message: `第 ${i + 1} 轮未能开始（可能 AI 未就绪），已停止循环` });
          break;
        }

        // 等本轮流式结束（带单轮超时兜底，防某轮卡死永久挂起）。
        await this.waitUntil(() => !deps.isStreaming(), ROUND_STREAMING_TIMEOUT_MS, deps);
        if (this.aborted) break;
        completed++;
      }
    } finally {
      const wasAborted = this.aborted;
      this.running = false;
      this.aborted = false;
      deps.notify({
        type: wasAborted ? 'warning' : 'success',
        title: '/loop 结束',
        message: wasAborted
          ? `循环已中断（已完成 ${completed}/${total} 轮）`
          : `循环完成（共 ${completed}/${total} 轮）`,
      });
    }
  }

  /**
   * 轮询等待 predicate 为真，或超时 / 被中断。
   * @returns predicate 命中返回 true；超时返回 false；被 stop() 中断也返回当前 predicate 值（调用方据 aborted 兜底）。
   */
  private waitUntil(predicate: () => boolean, timeoutMs: number, _deps: LoopRunnerDeps): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const start = Date.now();
      const tick = () => {
        if (this.aborted) { resolve(predicate()); return; }
        if (predicate()) { resolve(true); return; }
        if (Date.now() - start >= timeoutMs) { resolve(false); return; }
        setTimeout(tick, POLL_INTERVAL_MS);
      };
      tick();
    });
  }
}

/** 全局单例（与 agentOrchestrator 同款）：AgentPanel 接 helpers.startLoop / handleStop 调 stop()。 */
export const loopRunner = new LoopRunner();
