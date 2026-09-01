/**
 * Multi-AI Redux Slice
 * 管理 Multi-AI 协作模式的配置状态
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface SubagentConfig {
  id: string;
  name: string;
  role: string; // 角色描述
  model: string; // 使用的模型
  systemPrompt: string; // 系统提示
  toolPermissions: ('read' | 'write' | 'command' | 'search' | 'generate')[];
  maxTokens: number;
  /**
   * M3-1a 派发深度（递归层数控制）。正整数；不填默认 1。
   *   - 1（默认）→ 不允许该子代理再派发子代理（其工具集剔除 spawn_subagent）。
   *   - N（>1）→ 允许 N 层：子代理工具集【含】spawn_subagent，且其派出的孙代理 maxDepth=N-1，
   *     逐层递减，到 1 时不能再派。防无限递归派发。
   */
  maxDepth?: number;
}

/**
 * ★ M3-2a 固定工作流节点（方案见 Plan_4_M3 §三）。
 * MultiAIMode 从「subagents 列表」升级为「节点编排的固定工作流」——一个 mode 可挂一串 WorkflowNode，
 * 由 runWorkflow 按【数组顺序串行推进】。三类节点覆盖串行 / 并行 / 条件分支：
 *   - agent     ：单子代理节点（串行执行的一步），复用 M3-1a spawnSubagent。
 *   - parallel  ：并行节点（多子代理同时跑），复用 M3-1a spawnMultiple（内部按 maxConcurrent 分批）。
 *   - condition ：判断节点——手动设的清晰语义判断（如「上一步是否发现问题」），由一次轻量 LLM 判断
 *                  基于前序结果得真假；为假按 onFalse：abort=中止整工作流并反馈「无法推进」、continue=跳过继续。
 * 每节点产出汇入「工作流上下文」（前序所有节点 SubagentResult 摘要），作为后续节点 taskTemplate 的可用上下文。
 *
 * 向后兼容：workflow 为可选字段。未填 workflow 的 mode 走旧 subagents[] 语义（solo / 现有预设不破坏）。
 */
export type WorkflowNode =
  | {
      /** 节点唯一 id（节点结果在工作流上下文中的标识 + 卡片/调试溯源）。 */
      id: string;
      type: 'agent';
      /** 本步的子代理配置（model/systemPrompt/工具权限/maxDepth 等，复用 SubagentConfig）。 */
      subagent: SubagentConfig;
      /**
       * 任务模板（可选）。支持占位符 `{{userInput}}`（原始用户输入）与 `{{context}}`（前序节点结果摘要）。
       * 不填时由运行器用默认模板组合 userInput + 上下文。
       */
      taskTemplate?: string;
    }
  | {
      id: string;
      type: 'parallel';
      /** 并行分支：每个分支一个子代理，运行器用 spawnMultiple 同时跑（按 maxConcurrent 分批）。 */
      branches: SubagentConfig[];
      /** 各分支共用的任务模板（可选，占位符同 agent 节点）。每个分支以自身角色独立执行。 */
      taskTemplate?: string;
    }
  | {
      id: string;
      type: 'condition';
      /**
       * 判断语义（手动设的清晰自然语言判断），如「上一步是否发现了需要修复的问题」。
       * 运行器据此 + 前序结果做一次轻量 LLM 判断（true/false）。
       */
      expr: string;
      /** 判断为假时的处理：abort=中止整工作流并反馈「无法推进」；continue=跳过本判断继续后续节点。 */
      onFalse: 'abort' | 'continue';
      /** 中止/跳过时反馈给用户的说明（abort 时拼进「无法推进」原因）。 */
      message?: string;
    };

export interface MultiAIMode {
  id: string;
  name: string;
  description: string;
  agentCount: number;
  isBuiltin: boolean;
  isBuiltIn: boolean;
  mainAgentRole: string; // 主 Agent 角色描述
  subagents: SubagentConfig[];
  triggerConditions: ('stageComplete' | 'reviewPhase' | 'userRequest' | 'error')[];
  /**
   * ★ M3-2a 固定工作流节点编排（可选）。填了 workflow 的 mode 由 runWorkflow 按节点顺序执行；
   * 未填则走旧 subagents[] 语义。向后兼容：现有预设/solo 不受影响。
   */
  workflow?: WorkflowNode[];
}

/**
 * M3-1a 运行态子代理（为 M3-3 卡片四色 + token 统计 + 计时实时刷新打底）。
 * 四色状态映射（Plan_4_M3 五）：灰=complete、蓝=running、黄=retrying（retry/重连阻塞）、红=error。
 */
export interface RunningSubagent {
  id: string;                 // = subagentId（同时作为 toolRegistry.execute 的 contextId 隔离键）
  parentConversationId: string; // 主对话 id（卡片归属 + 子对话 parent_id）
  status: 'running' | 'complete' | 'error' | 'retrying';
  model: string;
  role: string;
  startTime: number;
  endTime?: number;           // 完成/失败时间（计时停止）
  result?: string;            // 完成 report 摘要 / 错误信息
  toolCallsUsed?: number;     // 工具调用次数（卡片展示）
  tokensUsed?: number;        // 粗估 token 用量（卡片展示）
  depth?: number;             // 本子代理的 maxDepth（剩余可派发层数；卡片可视化递归层级）
  conversationId?: string;    // 子代理落库的独立 conversation id（卡片点进查看其完整对话流）
}

/**
 * ★ M3-3a 工作流运行实例内的单个子代理快照（方案见 Plan_4_M3 §五）。
 * 与全局 RunningSubagent 的区别：
 *   - RunningSubagent 是【全局活动子代理表】（不区分归属哪个工作流，且 clearCompletedSubagents 会清理）；
 *   - WorkflowRunSubagent 是【某次工作流运行内】的子代理快照，随 WorkflowRun 长期存在（卡片回看），
 *     带 nodeId（归属哪个节点）+ role + 四色 status（与 RunningSubagent.status 同款状态机）。
 * 四色状态（与 RunningSubagent.status 对齐）：灰=complete、蓝=running、黄=retrying、红=error。
 */
export interface WorkflowRunSubagent {
  /** 子代理唯一 id（= spawnSubagent 生成的 subagentId；卡片 key + 与全局 runningSubagents 对应）。 */
  subagentId: string;
  /** 角色名（卡片主标签，取 SubagentConfig.name）。 */
  role: string;
  /** 归属节点 id（卡片可按节点分组/溯源；agent 节点 = 节点 id，parallel 分支 = 节点 id）。 */
  nodeId: string;
  /** 四色状态（与 RunningSubagent.status 同款，复用同一状态机）。 */
  status: RunningSubagent['status'];
  /** 使用的模型（卡片副标签）。 */
  model: string;
  /** 工具调用次数（卡片展示，完成/失败时回填）。 */
  toolCalls?: number;
  /** 粗估 token 用量（卡片展示，完成时回填）。 */
  tokens?: number;
  startTime: number;
  /** 完成/失败时间（卡片据此算耗时，停止计时）。 */
  endTime?: number;
  /**
   * ★ M3-3b 子代理对话桥接：本子代理跑完落库的独立 conversation id（is_subagent=true，由
   *   persistSubagentConversation 用 createConversationId 生成——【不等于】subagentId）。
   *   中间视图 WorkflowView 据此 loadConversationSnapshot(conversationId) 读回该子代理完整对话流。
   *   运行中 / 尚未落库 / 落库失败时为 undefined（视图侧显示占位）。
   */
  conversationId?: string;
}

/**
 * ★ M3-3a 一次固定工作流运行实例（方案见 Plan_4_M3 §五）。
 * 由 runWorkflow 在开始时 startWorkflowRun 创建、按节点 spawn 子代理时登记/流转、结束 finishWorkflowRun 收口。
 * 关联到对话流里【触发它的那条消息】（triggerMessageId），由 WorkflowCard 在该消息体内渲染实时四色卡片。
 */
export interface WorkflowRun {
  /** 运行实例唯一 id（稳定生成；triggerMessageId 关联 + 卡片订阅键）。 */
  runId: string;
  /** 模式名（卡片标题，取 MultiAIMode.name）。 */
  modeName: string;
  /** 关联的触发消息 id（对话里那条 assistant 汇总消息 / 触发用的 user 消息；卡片渲染锚点）。可空（先建 run 后回填）。 */
  triggerMessageId?: string;
  /** 工作流整体状态：running=进行中、complete=全部完成、aborted=中止（含用户终止/护栏/判断中止）。 */
  status: 'running' | 'complete' | 'aborted';
  startTime: number;
  endTime?: number;
  /** 本次运行登记的子代理快照列表（按登记顺序，含各节点/各并行分支）。 */
  subagents: WorkflowRunSubagent[];
}

export interface MultiAIState {
  enabled: boolean;
  activeMode: string; // mode id
  modes: MultiAIMode[];
  runningSubagents: RunningSubagent[];
  /**
   * ★ M3-3a 工作流运行实例表（运行态，卡片可视化数据源）。与 runningSubagents 一样属【运行态】，
   *   不应持久化复用（store/index sanitizePersistedMultiAI 在加载时重置为空，见该处）。
   */
  workflowRuns: WorkflowRun[];
  maxConcurrentSubagents: number;
  defaultSubagentModel: string;
  defaultSubagentMaxTokens: number;
  subagentDefaultModel: string;
}

/**
 * ★ medium#1（M3-3a 审查）workflowRuns FIFO 上限：单次会话内每跑一个工作流就 push 一条 WorkflowRun，
 *   且每个 multiAI/* dispatch 都被 persistMiddleware 序列化（虽治本已剔除运行态出 localStorage，仍要控内存增长）。
 *   startWorkflowRun 在 push 后把超出本上限的最旧实例 shift 掉，让 workflowRuns 始终 ≤ MAX_WORKFLOW_RUNS。
 */
const MAX_WORKFLOW_RUNS = 20;

export const BUILT_IN_MODES: MultiAIMode[] = [
  {
    id: 'solo',
    name: 'Solo (单Agent)',
    description: '仅使用主 Agent 直接完成任务。',
    agentCount: 1,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是直接与用户协作的主 Agent，独立完成任务。',
    subagents: [],
    triggerConditions: [],
  },
  {
    id: 'adversarial-vibe-coding',
    name: '对抗式 vibe-coding',
    description: '主Agent编码 + 审查Subagent Review，提升代码质量',
    agentCount: 2,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是项目的主力编码 Agent，直接与用户交互。每完成一个 Stage，等待审查 Subagent 的 Review 报告，逐条处理反馈。',
    subagents: [{
      id: 'reviewer',
      name: '审查者',
      role: '代码审查与质量检测',
      model: '',
      systemPrompt: `你是审查者 Agent。审查标准：功能完整性、代码质量(命名/结构/可读性)、错误处理(边界/异常)、性能问题。
输出格式：🔴 严重问题 (必须修复) | 🟡 建议改进 (推荐修复) | 🟢 肯定亮点 (做得好的地方)`,
      toolPermissions: ['read', 'search'],
      maxTokens: 4096,
    }],
    triggerConditions: ['stageComplete', 'reviewPhase'],
  },
  {
    id: 'deep-research',
    name: '深度研究',
    description: '主 Agent 分析 + 资料检索/证据验证 Subagent 并行辅助',
    agentCount: 3,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是深度研究协调 Agent。分析问题，同时 spawn 资料检索子代理寻找权威来源、证据验证子代理核对推导和数据。整合证据后给出可追溯结论。',
    subagents: [
      {
        id: 'literature',
        name: '文献分析',
        role: '搜索工作区与外部资料并整理引用',
        model: '',
        systemPrompt: '你是资料检索子代理。根据主题搜索工作区与可用外部资料，提取关键引用和上下文。返回结构化报告。',
        toolPermissions: ['read', 'search'],
        maxTokens: 2048,
      },
      {
        id: 'validator',
        name: '数据验证',
        role: '验证公式推导和数据准确性',
        model: '',
        systemPrompt: '你是数据验证子代理。验证主Agent给出的公式推导、数据计算的正确性。如果发现错误，明确指出错误位置和正确答案。',
        toolPermissions: ['read'],
        maxTokens: 2048,
      },
    ],
    triggerConditions: ['userRequest'],
  },
  {
    id: 'teaching-collaboration',
    name: '方案协作',
    description: '主 Agent 形成方案，审查 Subagent 生成追问、边界与验证点。',
    agentCount: 2,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是方案协调主 Agent，负责形成清晰可执行的方案，并整合审查子代理提出的风险与验证建议。',
    subagents: [{
      id: 'tutor',
      name: '方案审查',
      role: '生成追问、边界条件和验证检查点',
      model: '',
      systemPrompt: '你是方案审查子代理。根据主 Agent 的方案生成关键追问、边界条件和验证检查点，帮助发现遗漏与风险。',
      toolPermissions: ['read', 'search'],
      maxTokens: 4096,
    }],
    triggerConditions: ['userRequest'],
  },
  // ★ M3-2a 示例固定工作流（方案见 Plan_4_M3 §三）：找茬模式。
  //   演示串行 / 并行 / 判断三类节点完整链路，便于 M3-2b @触发 与运行器测试：
  //     节点1（agent，串行）：推进子代理——先理解/推进任务产出初版方案。
  //     节点2（parallel，并行）：3 个找茬子代理同时审查，从不同角度挑问题（spawnMultiple）。
  //     节点3（condition，判断）：基于前序结果判断「是否发现需修复的问题」——
  //                              为真→继续修复；为假→onFalse=abort 中止并反馈「无可推进的修复项」。
  //     节点4（agent，串行）：修复子代理——综合找茬意见修复并给出最终方案。
  {
    id: 'fault-finding-workflow',
    name: '找茬模式',
    description: '固定工作流：推进 → 3 子代理并行找茬 → 判断有无问题 → 修复。演示串行/并行/判断节点。',
    agentCount: 5,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是固定工作流「找茬模式」的协调者，按节点编排推进任务。',
    // 旧 subagents[] 留空——本 mode 走 workflow 节点编排。
    subagents: [],
    triggerConditions: ['userRequest'],
    workflow: [
      {
        id: 'advance',
        type: 'agent',
        subagent: {
          id: 'advancer',
          name: '推进者',
          role: '理解任务并产出初版方案',
          model: '',
          systemPrompt: '你是推进者子代理。理解用户任务，产出一份清晰、结构化的初版方案/答案，作为后续找茬与修复的基础。',
          toolPermissions: ['read', 'search'],
          maxTokens: 4096,
        },
        taskTemplate: '请针对以下任务产出初版方案：\n{{userInput}}',
      },
      {
        id: 'nitpick',
        type: 'parallel',
        taskTemplate: '请审查前序节点产出的初版方案，从你的专长角度找出具体问题。\n\n## 用户原始任务\n{{userInput}}\n\n## 前序结果\n{{context}}',
        branches: [
          {
            id: 'nitpick-logic',
            name: '逻辑找茬',
            role: '检查逻辑严谨性与推理漏洞',
            model: '',
            systemPrompt: '你是逻辑找茬子代理。专注检查方案的逻辑严谨性、推理链漏洞、前后矛盾。逐条列出发现的问题；若无问题，明确说「未发现逻辑问题」。',
            toolPermissions: ['read', 'search'],
            maxTokens: 2048,
          },
          {
            id: 'nitpick-detail',
            name: '细节找茬',
            role: '检查细节完整性与边界遗漏',
            model: '',
            systemPrompt: '你是细节找茬子代理。专注检查方案的细节完整性、边界条件遗漏、异常处理缺失。逐条列出问题；若无问题，明确说「未发现细节问题」。',
            toolPermissions: ['read', 'search'],
            maxTokens: 2048,
          },
          {
            id: 'nitpick-practice',
            name: '实践找茬',
            role: '检查可行性与落地风险',
            model: '',
            systemPrompt: '你是实践找茬子代理。专注检查方案的可行性、落地风险、与现实约束的冲突。逐条列出问题；若无问题，明确说「未发现可行性问题」。',
            toolPermissions: ['read', 'search'],
            maxTokens: 2048,
          },
        ],
      },
      {
        id: 'has-issue',
        type: 'condition',
        expr: '前序找茬子代理是否发现了需要修复的实质问题（而非全部回复「未发现问题」）',
        onFalse: 'abort',
        message: '三个找茬子代理均未发现需修复的实质问题，初版方案已可用，无需进入修复阶段。',
      },
      {
        id: 'fix',
        type: 'agent',
        subagent: {
          id: 'fixer',
          name: '修复者',
          role: '综合找茬意见修复并产出最终方案',
          model: '',
          systemPrompt: '你是修复者子代理。综合前序找茬子代理提出的问题，逐条修复初版方案，产出最终的、经过打磨的完整方案。',
          toolPermissions: ['read', 'search', 'write'],
          maxTokens: 4096,
        },
        taskTemplate: '请综合找茬意见，修复初版方案并产出最终方案。\n\n## 用户原始任务\n{{userInput}}\n\n## 前序结果（含初版方案与找茬意见）\n{{context}}',
      },
    ],
  },
];

const initialState: MultiAIState = {
  enabled: false,
  activeMode: 'solo',
  modes: BUILT_IN_MODES,
  runningSubagents: [],
  workflowRuns: [],
  maxConcurrentSubagents: 3,
  defaultSubagentModel: '',
  defaultSubagentMaxTokens: 32000,
  subagentDefaultModel: '',
};

const multiAISlice = createSlice({
  name: 'multiAI',
  initialState,
  reducers: {
    setMultiAIEnabled(state, action: PayloadAction<boolean>) {
      state.enabled = action.payload;
      if (action.payload && !state.activeMode) {
        state.activeMode = 'solo';
      }
    },
    setActiveMode(state, action: PayloadAction<string>) {
      state.activeMode = action.payload;
    },
    addMode(state, action: PayloadAction<MultiAIMode>) {
      state.modes.push(action.payload);
    },
    updateMode(state, action: PayloadAction<{ id: string; updates: Partial<MultiAIMode> }>) {
      const mode = state.modes.find(m => m.id === action.payload.id);
      if (mode && !mode.isBuiltIn) {
        Object.assign(mode, action.payload.updates);
      }
    },
    removeMode(state, action: PayloadAction<string>) {
      state.modes = state.modes.filter(m => m.id !== action.payload || m.isBuiltIn);
      if (state.activeMode === action.payload) {
        state.activeMode = 'solo';
      }
    },
    setMaxConcurrentSubagents(state, action: PayloadAction<number>) {
      state.maxConcurrentSubagents = action.payload;
    },
    setSubagentDefaultModel(state, action: PayloadAction<string>) {
      state.subagentDefaultModel = action.payload;
      state.defaultSubagentModel = action.payload;
    },
    setDefaultSubagentMaxTokens(state, action: PayloadAction<number>) {
      state.defaultSubagentMaxTokens = action.payload;
    },
    addRunningSubagent(state, action: PayloadAction<RunningSubagent>) {
      state.runningSubagents.push(action.payload);
    },
    updateSubagentStatus(
      state,
      action: PayloadAction<{
        id: string;
        status: RunningSubagent['status'];
        result?: string;
        // M3-1a 卡片实时字段：完成/失败时回填，运行中（retrying/running）可携进度。
        endTime?: number;
        toolCallsUsed?: number;
        tokensUsed?: number;
        conversationId?: string;
      }>,
    ) {
      const sub = state.runningSubagents.find(s => s.id === action.payload.id);
      if (sub) {
        sub.status = action.payload.status;
        if (action.payload.result !== undefined) sub.result = action.payload.result;
        if (action.payload.endTime !== undefined) sub.endTime = action.payload.endTime;
        if (action.payload.toolCallsUsed !== undefined) sub.toolCallsUsed = action.payload.toolCallsUsed;
        if (action.payload.tokensUsed !== undefined) sub.tokensUsed = action.payload.tokensUsed;
        if (action.payload.conversationId !== undefined) sub.conversationId = action.payload.conversationId;
      }
    },
    clearCompletedSubagents(state) {
      state.runningSubagents = state.runningSubagents.filter(s => s.status === 'running');
    },

    // ===== M3-3a 工作流运行实例（卡片可视化）=====

    /** 开始一次工作流运行：创建 running 状态的 WorkflowRun（无子代理）。runId 由调用方稳定生成。 */
    startWorkflowRun(
      state,
      action: PayloadAction<{ runId: string; modeName: string; triggerMessageId?: string }>,
    ) {
      // 防重复：同 runId 已存在则不重复 push（容错重入）。
      if (state.workflowRuns.some(r => r.runId === action.payload.runId)) return;
      state.workflowRuns.push({
        runId: action.payload.runId,
        modeName: action.payload.modeName,
        triggerMessageId: action.payload.triggerMessageId,
        status: 'running',
        startTime: Date.now(),
        subagents: [],
      });
      // ★ medium#1（M3-3a 审查）控内存：workflowRuns 是运行态数据源，单会话内只增不减会无限膨胀。
      //   开新 run 时把超出 FIFO 上限的最旧实例丢弃（保留最近 MAX_WORKFLOW_RUNS 条供卡片回看）。
      if (state.workflowRuns.length > MAX_WORKFLOW_RUNS) {
        state.workflowRuns.splice(0, state.workflowRuns.length - MAX_WORKFLOW_RUNS);
      }
      // ★ medium#1（M3-3a 审查）顺手清理已落地（complete/error）的全局活动子代理——runningSubagents 同样只增不减，
      //   且 clearCompletedSubagents 此前从未被调用。新工作流启动是个安全清理点（已完成的不再需要保留在活动表）。
      state.runningSubagents = state.runningSubagents.filter(s => s.status === 'running' || s.status === 'retrying');
    },

    /** 更新 run 的元信息（主要用于回填 triggerMessageId——先建 run 跑工作流、拿到汇总消息 id 后再关联）。 */
    updateWorkflowRun(
      state,
      action: PayloadAction<{ runId: string; triggerMessageId?: string; modeName?: string }>,
    ) {
      const run = state.workflowRuns.find(r => r.runId === action.payload.runId);
      if (!run) return;
      if (action.payload.triggerMessageId !== undefined) run.triggerMessageId = action.payload.triggerMessageId;
      if (action.payload.modeName !== undefined) run.modeName = action.payload.modeName;
    },

    /** 向 run 登记一个子代理（节点 spawn 时调用）。同 subagentId 已存在则跳过（容错）。 */
    addWorkflowRunSubagent(
      state,
      action: PayloadAction<{ runId: string; subagent: WorkflowRunSubagent }>,
    ) {
      const run = state.workflowRuns.find(r => r.runId === action.payload.runId);
      if (!run) return;
      if (run.subagents.some(s => s.subagentId === action.payload.subagent.subagentId)) return;
      run.subagents.push(action.payload.subagent);
    },

    /** 流转 run 内某子代理的状态/统计（与 RunningSubagent 同款四色状态机；运行中→完成/失败回填 endTime 等）。 */
    updateWorkflowRunSubagent(
      state,
      action: PayloadAction<{
        runId: string;
        subagentId: string;
        status?: WorkflowRunSubagent['status'];
        toolCalls?: number;
        tokens?: number;
        endTime?: number;
        model?: string;
        // ★ M3-3b：子代理对话落库后回填其 conversation id，供中间视图按 id 读回完整对话流。
        conversationId?: string;
      }>,
    ) {
      const run = state.workflowRuns.find(r => r.runId === action.payload.runId);
      if (!run) return;
      const sub = run.subagents.find(s => s.subagentId === action.payload.subagentId);
      if (!sub) return;
      if (action.payload.status !== undefined) sub.status = action.payload.status;
      if (action.payload.toolCalls !== undefined) sub.toolCalls = action.payload.toolCalls;
      if (action.payload.tokens !== undefined) sub.tokens = action.payload.tokens;
      if (action.payload.endTime !== undefined) sub.endTime = action.payload.endTime;
      if (action.payload.model !== undefined) sub.model = action.payload.model;
      if (action.payload.conversationId !== undefined) sub.conversationId = action.payload.conversationId;
    },

    /** 收口一次工作流运行：置整体 status（complete/aborted）+ endTime。 */
    finishWorkflowRun(
      state,
      action: PayloadAction<{ runId: string; status: 'complete' | 'aborted' }>,
    ) {
      const run = state.workflowRuns.find(r => r.runId === action.payload.runId);
      if (!run) return;
      run.status = action.payload.status;
      run.endTime = Date.now();
    },
  },
});

export const {
  setMultiAIEnabled,
  setActiveMode,
  addMode,
  updateMode,
  removeMode,
  setMaxConcurrentSubagents,
  setSubagentDefaultModel,
  setDefaultSubagentMaxTokens,
  addRunningSubagent,
  updateSubagentStatus,
  clearCompletedSubagents,
  startWorkflowRun,
  updateWorkflowRun,
  addWorkflowRunSubagent,
  updateWorkflowRunSubagent,
  finishWorkflowRun,
} = multiAISlice.actions;

export default multiAISlice.reducer;
