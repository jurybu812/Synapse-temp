/**
 * Synapse 输入区命令层 — / 斜杠命令注册表（M4-6-S3）
 *
 * 提供 SlashCommand 接口 + register/filter，模块加载时把内置命令 + extensionManager 的固定工作流
 * （/review //collect）注册进来。命令体经 SlashRunContext.helpers 拿能力（runAgent/notify/openSettings），
 * 【不直接 import store 链路】，便于测试与隔离（Plan_5 §8 决策 4）。
 *
 * Stage 边界：
 *   - 本文件（S3）：注册表 + register/filter + 迁移 BUILT_IN_WORKFLOWS（真执行）+ 内置命令【壳】。
 *   - /goal /compact /loop 的真实逻辑在 S4 替换各自 run（本文件 S3 先给占位 run，保证 / 菜单有候选可弹、
 *     parseAndDispatch 链路可跑通）。/clear 是低风险样例命令，S3 即可真执行（经 helpers）。
 */
import { extensionManager } from '@/services/extensionManager';
import type { CompletionItem } from './types';

/** 命令参数声明。rest=true 的参数吞掉剩余整段（如 /goal 的目标文本、/loop 的指令）。 */
export interface SlashCommandArg {
  name: string;
  description: string;
  required?: boolean;
  /** 吞掉剩余整段为一个参数（一个命令最多一个 rest 参数，且应放最后）。 */
  rest?: boolean;
}

/** 命令执行上下文：执行器统一注入。命令体只经此拿能力，不直接 import store/dispatch。 */
export interface SlashRunContext {
  /** 命令名之后的原始参数串（未解析，去首尾空白）。 */
  rawArgs: string;
  /** 按 args 声明解析出的命名参数。 */
  parsedArgs: Record<string, string>;
  helpers: {
    /** 把一段文本作为普通用户输入交给主 agent 跑（复用既有 agentLoop.run 链路）。 */
    runAgent: (text: string) => void;
    /** 弹通知。 */
    notify: (payload: { type: 'info' | 'success' | 'warning' | 'error'; title: string; message: string }) => void;
    /** 打开设置（可选定位分区）。 */
    openSettings: (sectionId?: string) => void;
    /** 新建 / 清空当前对话（/clear 用）。 */
    clearConversation: () => void;
    /**
     * ★ M4-6-S4 /goal 设定/清空当前对话目标。text 为空串 → 清空目标。写 conversation.goal（随对话持久化）。
     */
    setGoal?: (text: string) => void;
    /**
     * ★ M4-6-S4 /goal 查询当前对话目标。返回当前 goal（未设则空串/undefined）。
     */
    getGoal?: () => string | undefined;
    /**
     * ★ 手动 record 压缩钩子（/compact 用）。M5-1 压缩归一：压缩有且仅有一套，手动 ＝ 自动，完全同一套逻辑，
     *   仅触发方式不同。AgentPanel 注入的实现只调 agentLoop.compactNow（生成 record 批次 + 落库），
     *   【绝不截断 store.messages】——对话原文全量保留，压缩点由 batchDivider 分隔线呈现。
     *   未接入时为 undefined，命令 run 据此走 stub 提示。
     */
    compactNow?: () => Promise<void> | void;
    /**
     * ★ /loop 最小循环驱动器（S4 接入 loopRunner）。未接时为 undefined，命令 run 走 stub 提示。
     */
    startLoop?: (times: number, instruction: string) => void;
  };
}

export interface SlashCommand {
  /** 命令名（不含斜杠，如 'compact'）。 */
  name: string;
  /** 别名（不含斜杠）。 */
  aliases?: string[];
  /** 一句话说明（命令菜单副描述）。 */
  description: string;
  /** 参数声明（供执行器解析 + 菜单展示用法）。 */
  args?: SlashCommandArg[];
  /** 执行体。 */
  run(ctx: SlashRunContext): Promise<void> | void;
}

class CommandRegistry {
  private commands: SlashCommand[] = [];

  /** 注册一条命令（同名/同别名已存在则覆盖，便于热替换内置命令实现）。 */
  register(cmd: SlashCommand): void {
    const names = new Set([cmd.name, ...(cmd.aliases ?? [])]);
    this.commands = this.commands.filter(c => {
      const cNames = [c.name, ...(c.aliases ?? [])];
      return !cNames.some(n => names.has(n));
    });
    this.commands.push(cmd);
  }

  /** 按命令名精确查找（含别名匹配）。 */
  find(name: string): SlashCommand | undefined {
    const n = name.toLowerCase();
    return this.commands.find(c =>
      c.name.toLowerCase() === n || (c.aliases ?? []).some(a => a.toLowerCase() === n),
    );
  }

  /** 全部命令（buildExtensionPrompt 统一生成提示文字用，Plan_5 §7 决议 6）。 */
  list(): SlashCommand[] {
    return [...this.commands];
  }

  /**
   * 按 query 过滤命令 → 候选（/ 菜单数据源）。query 为 `/` 之后到光标的片段（不含斜杠）。
   * 匹配命令名 / 别名 / 描述（前缀优先，含子串）。
   */
  filter(query: string): CompletionItem[] {
    const q = query.trim().toLowerCase();
    const matched = this.commands.filter(c => {
      if (!q) return true;
      const names = [c.name, ...(c.aliases ?? [])].map(n => n.toLowerCase());
      return names.some(n => n.includes(q)) || c.description.toLowerCase().includes(q);
    });
    // 前缀命中（命令名以 q 开头）排前面。
    matched.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp;
    });
    return matched.map(c => ({
      id: `cmd-${c.name}`,
      label: `/${c.name}${formatArgsHint(c.args)}`,
      description: c.description,
      group: '命令' as const,
      meta: { name: c.name },
    }));
  }
}

/** 把 args 声明拼成用法提示（如 ` <次数?> <指令>`）。 */
function formatArgsHint(args?: SlashCommandArg[]): string {
  if (!args || args.length === 0) return '';
  return ' ' + args
    .map(a => (a.required === false || a.required === undefined ? `<${a.name}?>` : `<${a.name}>`))
    .join(' ');
}

export const commandRegistry = new CommandRegistry();

// ===================== 内置命令注册（模块加载时执行一次）=====================

/**
 * /clear —— 低风险样例命令（验证执行链路）。复用 helpers.clearConversation（= 新建/清空当前对话）。
 */
commandRegistry.register({
  name: 'clear',
  aliases: ['new'],
  description: '清空 / 新建当前对话',
  run(ctx) {
    ctx.helpers.clearConversation();
    ctx.helpers.notify({ type: 'info', title: '新对话', message: '已清空当前对话' });
  },
});

/**
 * /goal —— 设定 / 查看当前对话目标（M4-6-S4 实装）。
 *   - 有参数 → 写入 conversation.goal（随对话持久化），并经 promptBuilder.build 每轮注入 <current_goal>。
 *   - 无参数 → 查看当前 goal（未设则提示如何设定）。
 *   - 参数为「clear / 清空 / 清除」→ 清空当前目标（语义糖，便于无 UI 时取消目标）。
 */
commandRegistry.register({
  name: 'goal',
  description: '设定 / 查看当前对话目标（设目标后每轮自动注入）',
  args: [{ name: '目标文本', description: '目标内容；留空查看当前目标；填 clear 清空目标', required: false, rest: true }],
  run(ctx) {
    const text = ctx.rawArgs.trim();
    // 无参 → 查看当前目标。
    if (!text) {
      const current = ctx.helpers.getGoal?.();
      ctx.helpers.notify({
        type: 'info',
        title: '当前对话目标',
        message: current ? current : '尚未设定目标。用法：/goal <你的目标>，设定后每轮自动注入给 AI',
      });
      return;
    }
    // 显式清空。
    if (/^(clear|清空|清除|取消)$/i.test(text)) {
      ctx.helpers.setGoal?.('');
      ctx.helpers.notify({ type: 'success', title: '目标已清空', message: '后续不再注入对话目标' });
      return;
    }
    // 设定目标。
    ctx.helpers.setGoal?.(text);
    ctx.helpers.notify({ type: 'success', title: '已设定对话目标', message: text });
  },
});

/**
 * /compact —— 手动触发 record 压缩（M5-1 压缩归一）。压缩有且仅有一套：手动 /compact ＝ 自动压缩，
 *   完全同一套逻辑（同一函数 agentLoop.compactNow，复用 generateBatch → appendBatch），仅触发方式不同
 *   （手敲命令 vs 聊到 token 水位）。helpers.compactNow 由 AgentPanel 注入，只生成 record 批次 + 落库，
 *   【绝不截断 store.messages】——UI 与本地完整对话照常全量保留，压缩点由 batchDivider「已压缩」分隔线呈现。
 *   helpers.compactNow 缺省（AI 未就绪/未注入）时走降级提示。
 */
commandRegistry.register({
  name: 'compact',
  description: '手动压缩当前对话历史（record）',
  run(ctx) {
    if (ctx.helpers.compactNow) {
      void ctx.helpers.compactNow();
      return;
    }
    ctx.helpers.notify({
      type: 'info',
      title: '手动压缩',
      message: '当前无法手动压缩（AI 未就绪）。既有自动压缩不受影响，照常工作',
    });
  },
});

/**
 * /loop —— 循环任务（最小版：串行重复发送 N 次同指令，M4-6-S4 接 loopRunner）。
 *   解析 <次数?> <指令>；helpers.startLoop 由 AgentPanel 注入（→ loopRunner.start，带硬上限、可 Stop 中断）。
 *   helpers.startLoop 缺省（AI 未就绪）时走降级提示。
 */
commandRegistry.register({
  name: 'loop',
  description: '对同一指令串行推进 N 轮（最小循环，带硬上限，可 Stop 中断）',
  args: [
    { name: '次数', description: '循环次数（默认 1）', required: false },
    { name: '指令', description: '要循环推进的指令', required: true, rest: true },
  ],
  run(ctx) {
    // ★ M4-6 审查修复（medium/correctness 问题2）：parseArgs 对「可选前置位置参数 + rest」无法区分首 token 是
    //   次数还是指令——省略次数直接写 `/loop 写周报` 时，首词「写周报」被错吃进 '次数'、'指令' 为空 → 被反直觉拒绝。
    //   修法：取首 token 为「次数候选」，仅当它是【纯数字】时才视为次数；否则把它并回指令、次数默认 1。
    //   这样 `/loop 写周报`（省略次数）、`/loop 3 写周报`（带次数）都正确，符合规划 §4.5「次数可选」。
    const countToken = (ctx.parsedArgs['次数'] || '').trim();
    let instruction = (ctx.parsedArgs['指令'] || '').trim();
    let times = 1;
    if (/^\d+$/.test(countToken)) {
      times = Math.max(1, parseInt(countToken, 10) || 1);
    } else if (countToken) {
      // 首 token 非纯数字 → 它本是指令首词，被位置参数错吃，并回指令前面。
      instruction = `${countToken} ${instruction}`.trim();
    }
    if (!instruction) {
      ctx.helpers.notify({ type: 'warning', title: '/loop', message: '用法：/loop <次数?> <指令>' });
      return;
    }
    if (ctx.helpers.startLoop) {
      ctx.helpers.startLoop(times, instruction);
      return;
    }
    ctx.helpers.notify({ type: 'info', title: '/loop', message: '当前无法启动循环（AI 未就绪）' });
  },
});

/**
 * 迁移 extensionManager.BUILT_IN_WORKFLOWS（/review //collect）为可真正执行的 SlashCommand。
 * 替代死代码 matchWorkflow——每个 workflow 生成一个 SlashCommand，run 内把该 workflow 的 steps
 * 拼成一条 user 指令交给 runAgent（普通对话链路），由主 agent 按步骤推进。
 *
 * slashCommand 形如 `/review` `/collect`（注意 //collect 是用户书写习惯，实际命令名取 'collect'）。
 */
for (const wf of extensionManager.getWorkflows()) {
  // slashCommand 去掉所有前导斜杠得到命令名（/review→review、//collect→collect）。
  const cmdName = wf.slashCommand.replace(/^\/+/, '').trim();
  if (!cmdName) continue;
  commandRegistry.register({
    name: cmdName,
    description: wf.description,
    run(ctx) {
      const stepsText = wf.steps.map(s => `- ${s}`).join('\n');
      const extra = ctx.rawArgs.trim() ? `\n\n补充说明：${ctx.rawArgs.trim()}` : '';
      const prompt = `请执行固定工作流「${wf.name}」，按以下步骤推进：\n${stepsText}${extra}`;
      ctx.helpers.runAgent(prompt);
      ctx.helpers.notify({ type: 'info', title: `工作流 /${cmdName}`, message: `已触发「${wf.name}」` });
    },
  });
}
