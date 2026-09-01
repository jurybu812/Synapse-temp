/**
 * System Prompt Builder
 * 组装 XML 结构的系统提示词，集成 SKILL/WORKFLOW/RULES
 */

import { extensionManager } from './extensionManager';
import { keepRecentRoundsStartStep } from './roundBoundary';

interface PromptContext {
  workspaceName?: string;
  files?: string[];
  userRules?: string;
  synopsis?: string;
  mode?: 'fast' | 'planning';
  /** ★ task_boundary：本对话是否启用任务边界（false 则 planning guidelines 提示无需调用这些工具）。 */
  taskBoundaryEnabled?: boolean;
  // ★ M4-6-S4 /goal：当前对话目标。非空时 build 输出 <current_goal> 段，agentLoop 每轮自动注入，
  //   让 AI 始终对齐用户设定的目标。空/undefined → 不注入该段（cache 友好：goal 低频变更）。
  goal?: string;
  // ★ M4-6-S4 @对话引用：本轮引用的历史对话内容（record 摘要优先 / 回退最近 N 条，由调用方组装）。
  //   非空时 build 输出 <referenced_conversation> 段。这是【本轮临时附加上下文】（发送后即清），
  //   经 agentLoop.run 的 opts.injectedContext 透传至此——不污染可见对话流，也不重复落库。
  referencedContext?: string;
  // ★ 反馈#8a 当前对话 ID 注入：把当前对话 ID 直接写进 system prompt，让 AI 引用本对话 / 写记忆来源时
  //   无需先调 read_conversation(conversationId='') 探测。由 agentLoop.run 每轮从 store 取
  //   conversation.id（草稿态 null 时回退 AUTOSAVE_ID 'autosave-current'）传入。
  //   ★ prompt cache：conversationId 在【同一对话内恒定不变】，故进 system prompt 不会引入对话内的前缀漂移
  //   （与 goal 同口径：低频/对话内稳定字段可安全进 apiMessages[0]）；仅跨对话才不同，本就不共享 cache 前缀。
  conversationId?: string;
  // ★ 反馈#8a：true 表示当前对话尚未持久化（id 为 null，走 AUTOSAVE_ID 草稿态）——渲染时附注「未持久化草稿」，
  //   提示 AI 此 ID 为临时草稿标识，正式落库后会变更。
  conversationIsDraft?: boolean;
  // ★ M4-5 审查 medium#2：原 openFiles / activeFilePath 字段已移除——<open_files> 不再由 build 注入 system prompt，
  //   改由 renderOpenFilesSection（导出函数）渲染、agentLoop 注入到 messages 末尾以保 cache 前缀稳定。
  promptInjection?: {
    injectIdentity?: boolean;
    injectSkills?: boolean;
    injectRules?: boolean;
    injectWorkflows?: boolean;
    injectContext?: boolean;
    injectTools?: boolean;
  };
}

const FAST_IDENTITY = `<identity>
你是 Synapse AI 快速模式，一个可扩展的桌面编程智能体。
- 回答尽量简洁，控制在 300 字以内
- 直接给出答案，不做冗余展开
- 不主动调用工具，除非用户明确要求
- 优先给出可执行的结论、命令或下一步
</identity>`;

const PLAN_IDENTITY = `<identity>
你是 Synapse AI，一个可扩展的桌面编程智能体。
你能够读取真实工作区与文档、调用工具修改文件、运行验证、检索资料，并在长任务中保持状态与证据连续。
请用中文回复，语气友好且专业。
- 对复杂任务先给出简短计划，再按计划逐步执行
- 在需要使用工具前说明目标，执行后结合结果继续回答
- 优先依据真实文件、运行结果、页面状态和权威来源，而不是凭印象猜测
- 修改代码时聚焦根因，保持改动最小，并用针对性测试验证真实链路
- 涉及文档、网页和界面时结合原文、结构与视觉证据检查
- 解释概念时使用类比和示例、图表、代码
- 对于数学/算法题目，展示详细推导过程
- 使用 Markdown 格式化（标题、列表、代码块、LaTeX 公式、Mermaid 图）
</identity>`;

export const MAX_CONTEXT_TOKENS = 128000;
export const COMPRESSION_THRESHOLD = 0.9; // 90% of model context window triggers compression
/**
 * ★ M5-2 轮次地基：压缩时「保留最近原文」的 token 预算比例（占模型上下文窗口）。
 * compressContext 不再按固定条数（旧 keepCount=4）保留，而是按此预算从最后一轮往前纳入【整轮】原文，
 * 向轮边界取整（绝不在轮中间切，见规范 §1/§2）。0.25 = 约保留 1/4 窗口的最近整轮原文，
 * 既留足最近上下文连贯性，又给被压段（>0.9 窗口的总量减去保留段）足够压缩空间。
 */
export const KEEP_RECENT_RATIO = 0.25;
/** ★ M5-2 轮次地基：压缩时至少保留的最近【整轮】数（保底，即便单轮超预算也保留整轮）。 */
export const KEEP_RECENT_MIN_ROUNDS = 1;
/**
 * M4-1-S4 护栏阈值：少条超长危险态下，仅当「不含当前消息的历史文本 token」≥ 阈值 * 此比例
 * 才认定为真·历史超长（标 overLimitWithoutCompression）。低于此比例则判超额来自当前消息、护栏放行不截断。
 */
export const HISTORY_OVERLIMIT_RATIO = 0.5;

export class SystemPromptBuilder {
  build(context: PromptContext = {}): string {
    const sections: string[] = [];

    const injection = context.promptInjection ?? {};

    // Mode-specific identity
    if (injection.injectIdentity ?? true) {
      const identity = context.mode === 'fast' ? FAST_IDENTITY : PLAN_IDENTITY;
      sections.push(identity);
    }

    // ★ 反馈#8a 当前对话 ID 注入：紧跟 identity 放高位，让 AI 引用本对话 / 写记忆来源时直接用此 ID，
    //   不必先调 read_conversation(conversationId='') 探测。用 injectContext gating（与 workspace/goal 同口径）。
    //   ★ prompt cache：conversationId 同一对话内恒定，进 system prompt 不引入对话内前缀漂移（cache 友好）。
    if ((injection.injectContext ?? true) && context.conversationId && context.conversationId.trim()) {
      const draftNote = context.conversationIsDraft ? '（未持久化草稿，正式保存后此 ID 会变更）' : '';
      sections.push(`<conversation_meta>
当前对话 ID：${context.conversationId.trim()}${draftNote}
引用本对话、记录记忆来源或调用需要 conversationId 的工具时可直接使用此 ID，无需调用工具查询。
</conversation_meta>`);
    }

    // ★ M4-6-S4 /goal：当前对话目标段——紧跟 identity 放高位，让 AI 每轮都对齐用户设定的目标。
    //   goal 受 injectIdentity 同款语义控制不合适（它是上下文不是身份），用 injectContext gating（与 workspace 同口径）。
    //   非空才注入；goal 低频变更，进 system prompt 对 cache 影响小（不像 open_files 那样每次切 tab 都变）。
    if ((injection.injectContext ?? true) && context.goal && context.goal.trim()) {
      sections.push(`<current_goal>
当前对话目标（用户经 /goal 设定，请在后续每一步都围绕此目标推进，不要偏离）：
${context.goal.trim()}
</current_goal>`);
    }

    if ((injection.injectContext ?? true) && context.workspaceName) {
      sections.push(`<workspace>
当前工作区: ${context.workspaceName}
${context.files?.length ? `当前打开的文件:\n${context.files.map(f => `- ${f}`).join('\n')}` : '暂无打开的文件（工作区目录内容仍可用 list_dir / view_file 访问）'}
</workspace>`);
    }

    if ((injection.injectContext ?? true) && context.synopsis) {
      sections.push(`<knowledge_synopsis>
${context.synopsis}
</knowledge_synopsis>`);
    }

    // Inject SKILL / WORKFLOW / RULES from extension system
    const extensionPrompt = extensionManager.buildExtensionPrompt({
      injectSkills: injection.injectSkills ?? true,
      injectWorkflows: injection.injectWorkflows ?? true,
      injectRules: injection.injectRules ?? true,
    });
    if (extensionPrompt) {
      sections.push(extensionPrompt);
    }

    if ((injection.injectRules ?? true) && context.userRules) {
      sections.push(`<user_rules>
${context.userRules}
</user_rules>`);
    }

    if (context.mode === 'planning') {
      sections.push(`<guidelines>
1. 先用 2-5 行列出计划，再进入执行或回答
2. 开始工作前先核对当前工作区、已有文件、运行状态和用户约束
3. 解释概念时使用类比和示例，涉及外部事实时给出可追溯来源
4. 对于数学/算法题目，展示必要推导，并说明复杂度与边界
5. 主动使用工具读取真实文件、运行验证和检查页面状态；不要臆造工具结果
6. 如需代码示例，提供可运行的完整代码
7. 使用 Markdown 格式化回复（标题、列表、代码块、LaTeX 公式）
8. 长期记忆：开始新任务或需要回忆既往背景/方案/用户偏好时，先调用 memory_query 检索；遇到有长期价值的技术方案、踩坑经验、用户偏好时主动 memory_write 沉淀。这是 Synapse 内置记忆，与外置 MCP 工具无关。
   - ⚠️ 两套记忆工具的分工（务必分清，别混用）：① 记录与检索记忆【默认且首选用原生工具】——memory_write / memory_query / memory_list / memory_read（它们读写的是 Synapse 内部记忆库，是你日常沉淀与回忆的标准通道）。② mcp__memory-store__* 里的【记忆类】工具（memory_write / memory_query / memory_read / memory_list / memory_update / memory_delete / memory_batch / memory_stats）【仅当需要读写「其它 AI 宿主源」（Claude Code / Windsurf / Codex 等）的共享记忆时】才用——日常本地记忆【不要】走它，否则会把本应留在 Synapse 内部的记忆错写到外部共享库、并造成两套记忆来回错乱。
   - 记忆类之外的 memory-store 工具【不受上面约束】，按需正常使用：conversation_read_original（跨源读取其它宿主的对话原文）、record_manage（过程记录）、stage_guard（阶段守卫）等——它们不属于「本地记忆」范畴，需要时直接调用即可。
9. 历史摘要：对话历史摘要（record）里标注为「骨架」的批次只给了标题与要点，需要该批次完整细节时用 record_read(batchIndex) 按需展开全文（batchIndex 取自骨架标注里的「批次N」）。
   - hit 反馈（mark_record_hit）：读 record 摘要时，若发现某段历史（某个批次 / 某一轮）正是当前任务需要反复参考的关键上下文，调 mark_record_hit(batchIndex 或 roundHit) 标记它——系统会在后续压缩时优先为这段历史保留更完整的内容（全文而非仅标题），省得你反复 record_read 展开。这只是给系统的提示、不会立刻改变摘要，放心标记你确实需要的那几段即可。
10. 任务边界（task_boundary，让用户直观看到你在干什么）：开始一个有多个步骤的任务时调 begin_task_boundary(headline, summary) 开一张任务卡；每进入一个新的子阶段/小标题就调 set_task_headline(headline, summary) 更新当前大标题与概述（系统会自动记入「标题变迁历史」）；每完成一个关键动作调 update_task_progress(step) 追加一条进度；整个任务做完时调 end_task_boundary() 收口。让 headline 始终反映你「此刻正在做什么」。${context.taskBoundaryEnabled === false ? '（本对话已关闭任务边界，无需调用这些工具。）' : ''}
   - 使用时机：task_boundary 的目的是把多步骤的干活过程结构化地收纳起来、防止中间过程刷屏占用界面。【只有当工作包含多个步骤时】才在开始时调 begin_task_boundary 把整个过程包起来；单步就能答完的问题不必开任务卡。
   - 何时收口：一旦【当前阶段干完 / 要向用户汇报结果 / 要切换到一个新主题】，就【立刻】调 end_task_boundary() 收口，不要让任务卡一直挂着——挂着会让界面始终停留在「正在干活」的状态。收口之后再向用户汇报，或者另开一张新的 boundary 继续下一阶段。
   - 长时间未收口提醒：如果本轮已经连续干了很多步还没有收口，主动调 end_task_boundary() 汇报一下阶段进展，别闷头一直干下去。
11. 产物呈现（show_artifact）：凡是你【生成的、值得用户查看或保存的产物】（代码、文档、设计、分析结果、报告等），都用 show_artifact 推送给用户，让其在编辑器里打开查看，【优先于把全文直接塞进回复正文】。简单说：想让用户看到的成品就用 artifact 推送，这是产物的标准呈现方式；回复正文里做简短说明与索引即可，不必重复贴全文。
12. 外置 MCP 工具：当你需要执行代码/命令、运行沙箱、抓取网页或截图、读取外部资源时，优先使用工具列表中【确实存在】的 mcp__sandbox__* / mcp__web-fetcher__* 等 MCP 工具来完成。⚠️ 仅当这些工具出现在你当前可用的工具列表中时才调用——若列表里没有对应 mcp__ 工具，说明该 MCP server 未启用，请改用内置工具或如实告知用户，切勿臆造或反复尝试调用不存在的工具。
   - MCP sandbox 与自己文件体系的分工（别搞反）：① 【危险操作 / 改工作区文件 / 需要能回滚撤销的操作】一律走【自己的文件工具】——改文件用 write_to_file（有快照、可回溯，用户能逐项 accept/reject），执行命令走 run_command（有审批门控）。这条路有完整的安全网。② 【一次性计算 / 试验性代码 / 验证某个想法 / 不碰工作区、不需要留痕的】才用 MCP sandbox 执行工具（如 mcp__sandbox__sandbox_exec），隔离环境里跑完即弃。
   - ⚠️ 关键警示：MCP sandbox 跑的东西【不进我们的文件回溯账本】，所以【绝不能用 sandbox 做重要的文件操作】（出了事回滚不了）；同理也【别用 run_command 去间接改文件】（脚本写盘/删文件的副作用同样不进快照、回溯不了）——改文件一律优先 write_to_file。
</guidelines>`);
    }

    // ★ M4-5-S3 工作区感知：<open_files> 段【不再注入 system prompt(apiMessages[0])】。
    //   M4-5 审查（medium#2）根因：prompt cache 是对序列化 messages 的【严格前缀匹配】，
    //   apiMessages[0] 在 apiMessages[1](record 摘要) 之前。把易变的 <open_files>（含「（当前活动）」标注）
    //   放 system prompt 末尾，会在用户切 tab / 开关 tab 时改变 apiMessages[0] 尾部，连带 apiMessages[1]
    //   及后续历史这一整段稳定前缀全部 cache 失效——与 S2 record 摘要逐字稳定化的收益互相抵消。
    //   治本：渲染逻辑抽到 renderOpenFilesSection（见下），由调用方(agentLoop) 注入到整个 messages 数组的
    //   【最末尾】（最新一轮 user 消息内），使 system prompt + record 摘要 + 旧历史 构成的大前缀真正可缓存。
    //   此处 build 不再产出 <open_files>，injectContext gating 与注入位置统一由调用方负责。

    // ★ M4-6-S4 @对话引用：本轮临时附加上下文段，放在 build 输出【末尾】（识别为附加参考资料，而非核心身份/规则）。
    //   内容由调用方（AgentPanel handleSend）从被引用对话组装好（record 摘要优先 / 回退最近 N 条 + token 预算裁剪），
    //   经 agentLoop.run 的 opts.injectedContext 透传到这里。它是本轮一次性的（发送后即清），不进可见对话流、不重复落库。
    //   注意：这是【临时】段，会让本轮 system prompt 变（cache 失效一轮），但 @对话引用本就是按需附加，可接受。
    if (context.referencedContext && context.referencedContext.trim()) {
      sections.push(`<referenced_conversation>
以下是用户在本轮通过 @对话 引用的历史对话内容（作为背景参考，不是用户当前指令）：
${context.referencedContext.trim()}
</referenced_conversation>`);
    }

    return sections.join('\n\n');
  }
}

/**
 * ★ M4-5 审查 medium#2：渲染 <open_files> 段（与 system prompt 解耦，供 agentLoop 注入到 messages 末尾）。
 *   - 只列【路径 / 名 / 类型】，不含正文——明确告知模型正文未注入、需要时用读文件工具按需读取。
 *   - openFiles 已由调用方（agentLoop）过滤非文件视图、做上限裁剪（超出标注「等 N 个」由调用方追加占位项）。
 *   - 无可渲染项时返回空串（调用方据此跳过注入）。
 */
export function renderOpenFilesSection(
  openFiles?: Array<{ path: string; name: string; type: string }>,
  activeFilePath?: string,
): string {
  if (!openFiles || openFiles.length === 0) return '';
  const lines = openFiles.map(f => {
    // 溢出占位项（path/type 空，仅 name 承载「等 N 个」）：只渲染 name 一行，省略方括号与路径行。
    if (!f.path) return `- ${f.name}`;
    const typeMark = f.type ? ` [${f.type}]` : '';
    const activeMark = activeFilePath && f.path === activeFilePath ? '（当前活动）' : '';
    return `- ${f.name}${typeMark}${activeMark}\n  ${f.path}`;
  });
  return `<open_files>
用户当前在编辑器中打开的文件（仅路径/名称/类型概要，正文未注入）：
${lines.join('\n')}
需要某个文件的完整内容时，请用读文件工具按需读取，不要臆测正文。
</open_files>`;
}

export function renderRuntimeContextSection(context: {
  systemTimeUtc: string;
  timeZone: string;
  providerId: string;
  modelId: string;
  contextWindow: number;
  mode: 'fast' | 'planning';
  reasoningEffort?: string;
  speedTier?: string;
  supportsVision: boolean;
  supportsTools: boolean;
}): string {
  return `<runtime_context>
本轮请求时间（当前系统时钟，UTC）：${context.systemTimeUtc}
系统时区：${context.timeZone}
实际请求 Provider：${context.providerId}
实际请求模型：${context.modelId}
上下文窗口：${context.contextWindow} tokens
工作模式：${context.mode}
思考档位：${context.reasoningEffort || '未指定'}
速度档位：${context.speedTier || '未指定'}
视觉输入：${context.supportsVision ? '支持' : '不支持'}
工具调用：${context.supportsTools ? '支持' : '不支持'}
以上是本轮运行元数据；用户正文与历史消息保持原义。
</runtime_context>`;
}

export const promptBuilder = new SystemPromptBuilder();

/**
 * 估算 token 数量（简易版，按字符数粗略估计）
 * 中文约 1.5 tokens/字，英文约 0.25 tokens/character
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
}

/**
 * 计算对话的总 token 数
 */
export function countConversationTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    total += 4;
  }
  total += 2;
  return total;
}

/**
 * CHECKPOINT 上下文压缩
 * 当 token 超过阈值时，将旧消息压缩为摘要
 */
export function compressContext(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = MAX_CONTEXT_TOKENS,
  realTokenCount?: number,
  /**
   * M4-1-S4 护栏：调用方传入「除最后一条 user 外的历史文本 token」（不含当前最新 user 消息）。
   * 仅当历史本身也接近阈值（≥ threshold * HISTORY_OVERLIMIT_RATIO）才认为是真·历史超长、标 overLimitWithoutCompression。
   * 若历史远低于阈值（说明超额几乎全来自当前消息估算），不标危险态、不触发 truncate。
   * 向后兼容：不传（undefined）时维持原行为（条数<6 且超阈值即标 true）。
   */
  historyOnlyTokens?: number,
  /**
   * ★ M5-BPC-4：硬压缩触发阈值比例（默认 COMPRESSION_THRESHOLD=0.9）。run() 传 effectiveCompactThreshold
   *   （conversation.compactThresholdOverride ?? agentSettings.bpc.compactThreshold ?? 0.9），让硬阈值可配。
   *   不传时维持原 0.9 行为（向后兼容，其它调用点不受影响）。
   */
  thresholdRatio: number = COMPRESSION_THRESHOLD,
): {
  compressed: Array<{ role: string; content: string }>;
  wasCompressed: boolean;
  /**
   * M2-R4 问题4：少条超长危险态标志。
   * true 表示「token 已超阈值，但消息条数 < 6 无法做切片压缩」——条数过少时按轮保留后无可压缩余量，
   * 直接全量发送有撑爆窗口风险。调用方（agentLoop）应据此对超长单条做内容截断保护后再发送。
   */
  overLimitWithoutCompression?: boolean;
} {
  // 优先使用 API 返回的真实 token 数；没有时回退到字符估算
  const currentTokens = realTokenCount && realTokenCount > 0 ? realTokenCount : countConversationTokens(messages);
  const threshold = maxTokens * thresholdRatio;

  // 未超阈值：无条件不压缩。
  if (currentTokens <= threshold) {
    return { compressed: messages, wasCompressed: false };
  }

  // M2-R4 问题4 修复：原实现 `currentTokens <= threshold || messages.length < 6` 把「条数<6」也当作
  // 无条件不压缩，导致「少条但单条极长」（如粘贴超长文档/代码）即便已超阈值仍全量发送、撑爆窗口。
  // 现拆分：条数<6 只跳过【切片压缩】（按轮保留后无可压缩余量），但暴露 overLimitWithoutCompression 危险态，
  // 由调用方对超长单条做截断保护。此处仅告警，不在 compressed 内截断——因为不压缩分支调用方实际发送的是
  // 原始 requestHistory（含图片/附件 part），截断需在调用方层面对发送体做（见 agentLoop.ts 不压缩守卫）。
  if (messages.length < 6) {
    // M4-1-S4 护栏：若调用方传了 historyOnlyTokens（除最后一条 user 外的历史文本 token），
    // 且历史本身远低于阈值，说明超额几乎全来自当前消息估算（修复块一后这种情况应近乎绝迹，此为最后防线）——
    // 不标危险态、不触发 truncate，避免误截当前消息。仅历史也接近阈值时才认为是真·历史超长。
    if (historyOnlyTokens !== undefined && historyOnlyTokens < threshold * HISTORY_OVERLIMIT_RATIO) {
      console.warn(
        `[compressContext] token(${currentTokens}) 超阈值(${Math.floor(threshold)})但历史(${historyOnlyTokens})` +
        `< 阈值*${HISTORY_OVERLIMIT_RATIO}，判定超额来自当前消息，不标 overLimitWithoutCompression（护栏放行）。`,
      );
      return { compressed: messages, wasCompressed: false };
    }
    console.warn(
      `[compressContext] token(${currentTokens}) 已超阈值(${Math.floor(threshold)})，` +
      `但消息条数(${messages.length})<6 无法切片压缩（少条超长）。已标记 overLimitWithoutCompression，` +
      `调用方应对超长单条做截断保护以防撑爆窗口。`,
    );
    return { compressed: messages, wasCompressed: false, overLimitWithoutCompression: true };
  }

  // ★ M5-2 轮次地基：保留最近原文从「固定 keepCount=4 条」改为「按 token 预算→向轮边界取整保留整轮」。
  //   规范 §1/§2：保留与批次边界一律按轮取整，绝不在轮中间切。
  //   - keepRecentRoundsStartStep 在本序列（已不含 tool，与 agentLoop requestHistory 同口径）上识别轮边界，
  //     从最后一轮往前按 budget 纳入整轮，至少保留 KEEP_RECENT_MIN_ROUNDS 整轮，返回保留段起始 step index。
  //   - 退化等价：常规交替序列 [u,a,u,a,...] 上，轮数 === user 条数，行为与旧条数切平滑过渡；
  //     仅在连发 user / 一轮多 model step（工具循环、子代理）时才正确收敛到整轮。
  //   ★ 与 agentLoop 的衔接：本函数返回 compressed=[checkpoint, ...toKeep]，agentLoop 用
  //     keepCount = compressed.length - 1 反推 compressedSegment = requestHistory.slice(0, len-keepCount)，
  //     故只要这里把保留段对齐到轮起点，被压段（compressedSegment）也自动对齐轮边界——改一处全覆盖。
  const keepBudget = maxTokens * KEEP_RECENT_RATIO;
  const keepStartIdx = keepRecentRoundsStartStep(
    messages,
    keepBudget,
    m => estimateTokens(m.content) + 4, // 与 countConversationTokens 单条口径一致（含每条 +4 开销）
    KEEP_RECENT_MIN_ROUNDS,
  );
  // ★ M5-2 铁律守卫（绝不轮中间切）：若按整轮取整后被压段为空（keepStartIdx<=0，即保留了全部轮——
  //   典型是「只有 1 个超大整轮」或「全部轮都在保底/预算内」），则【不在轮中间硬切】。
  //   这种「单超大轮超阈值」本质是少条超长危险态：交给调用方的超长保护（truncateOverLongHistory）按
  //   文本 part 截断，而不是把这一整轮从某 step 处劈成「半轮摘要 + 半轮原文」破坏轮边界。
  //   （length<6 的少条超长已在上方分支拦截；此处兜住「条数≥6 但全在一个/少数大轮里」的情形。）
  if (keepStartIdx <= 0) {
    console.warn(
      `[compressContext] token 超阈值但按整轮取整后无更早整轮可压（保留全部轮），` +
      `不在轮中间切，转 overLimitWithoutCompression 交超长保护。`,
    );
    return { compressed: messages, wasCompressed: false, overLimitWithoutCompression: true };
  }

  const toCompress = messages.slice(0, keepStartIdx);
  const toKeep = messages.slice(keepStartIdx);

  // Generate summary of old messages
  const summaryParts: string[] = [];
  // P1-5: 区分角色保留不同长度
  for (const msg of toCompress) {
    const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'AI' : msg.role;
    // 用户消息保留完整（通常较短）；AI 消息保留前500字
    const maxLen = msg.role === 'user' ? Infinity : 500;
    const preview = msg.content.length > maxLen ? msg.content.slice(0, maxLen) + '...' : msg.content;
    summaryParts.push(`[${role}] ${preview}`);
  }

  const checkpointMessage = {
    role: 'system' as const,
    content: `[CHECKPOINT] 之前的对话已被压缩。摘要如下：\n\n${summaryParts.join('\n\n')}\n\n---\n以上是对话历史的压缩摘要。后续内容为最近对话：`,
  };

  return {
    compressed: [checkpointMessage, ...toKeep],
    wasCompressed: true,
  };
}
