/**
 * ★ M3-2c 固定工作流模板编辑器（最小可用、表单/列表式，不做拖拽画布）。
 *
 * 职责：让用户在设置区「Multi-AI」标签内新建 / 编辑 / 删除「固定工作流模板」（MultiAIMode + workflow 节点）。
 *   - 编辑 mode.name + workflow 节点列表（agent / parallel / condition 三类，与 runWorkflow 消费的 WorkflowNode 契约严格一致）。
 *   - 节点增删 + 类型切换 + 上下移调顺序（数组序）。
 *   - 保存前基本校验：name 非空、至少一个节点、condition 作首节点给 warning（复用 runWorkflow 已有容错，UI 层仅提示）。
 *   - 展示 `@MultiAI:模式名 任务描述` 触发用法（让用户知道怎么跑）。
 *
 * 数据契约（见 store/slices/multiAI.ts WorkflowNode / SubagentConfig）：编辑产出的结构必须与
 *   services/agentOrchestrator.ts runWorkflow 消费的节点结构一致，否则编辑出的工作流跑不了。
 *
 * 持久化：本组件不直接落库，仅在「保存」时回调 onSave(draft)，由父组件 dispatch updateMode / addMode。
 *   modes（含 workflow）走 persistMiddleware 持久化（只有 workflowRuns / runningSubagents 运行态被剔出 persist）。
 */
import { useMemo, useState } from 'react';
import type {
  MultiAIMode,
  SubagentConfig,
  WorkflowNode,
} from '@/store/slices/multiAI';
import { MULTI_AI_TRIGGER_PREFIX } from '@/services/multiAITrigger';
import type { AIModelOption } from '@/types/aiModel';

type NodeType = WorkflowNode['type'];

/** 子代理工具权限可选项（与 SubagentConfig.toolPermissions 联合类型一致）。 */
const TOOL_PERMISSION_OPTIONS: SubagentConfig['toolPermissions'] = ['read', 'write', 'command', 'search', 'generate'];

const TOOL_PERMISSION_LABELS: Record<SubagentConfig['toolPermissions'][number], string> = {
  read: '读取',
  write: '写入',
  command: '命令',
  search: '搜索',
  generate: '生成',
};

let nodeIdSeq = 0;
/** 生成稳定的节点 / 子代理 id（节点结果在工作流上下文中的标识 + 卡片溯源；运行期不要求全局唯一，但同模板内应唯一）。 */
function genId(prefix: string): string {
  nodeIdSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${nodeIdSeq}`;
}

/** 新建一个默认 SubagentConfig（model 留空=跟随默认 / 主 Agent；与内建模板写法一致）。 */
function makeSubagent(): SubagentConfig {
  return {
    id: genId('sub'),
    name: '新子代理',
    role: '',
    model: '',
    systemPrompt: '',
    toolPermissions: ['read', 'search'],
    maxTokens: 4096,
  };
}

/** 按类型新建一个默认节点（结构与 runWorkflow 消费契约一致）。 */
function makeNode(type: NodeType): WorkflowNode {
  if (type === 'agent') {
    return {
      id: genId('agent'),
      type: 'agent',
      subagent: makeSubagent(),
      taskTemplate: '',
    };
  }
  if (type === 'parallel') {
    return {
      id: genId('parallel'),
      type: 'parallel',
      branches: [makeSubagent()],
      taskTemplate: '',
    };
  }
  return {
    id: genId('condition'),
    type: 'condition',
    expr: '',
    onFalse: 'abort',
    message: '',
  };
}

/** 深拷贝 workflow 节点，避免直接改 store 里的引用（draft 隔离）。 */
function cloneWorkflow(workflow: WorkflowNode[] | undefined): WorkflowNode[] {
  if (!Array.isArray(workflow)) return [];
  return JSON.parse(JSON.stringify(workflow)) as WorkflowNode[];
}

interface WorkflowEditorProps {
  /** 正在编辑的模式（自定义可写；built-in 不应进入本编辑器，父组件已拦截）。 */
  mode: MultiAIMode;
  /** 可选模型列表（子代理「使用模型」下拉；留空=跟随默认/主 Agent）。 */
  availableModels: AIModelOption[];
  /**
   * ★ M3-2c#fix 保存：父组件据此 dispatch updateMode（落库走 persistMiddleware）。
   *   subagents 显式归一为 []——带 workflow 的工作流模板不应残留旧 subagents 僵尸数据（与内建
   *   fault-finding-workflow 写法一致），尤其复制内建（subagents 非空）后重构为工作流的模板。
   */
  onSave: (updates: { name: string; description: string; workflow: WorkflowNode[]; agentCount: number; subagents: [] }) => void;
  /** 取消：放弃本次草稿，返回列表。 */
  onCancel: () => void;
  /** 删除当前模板（自定义可删，built-in 不可删）。 */
  onDelete: () => void;
  /** 轻提示（复用父级 notification）。 */
  notify: (type: 'success' | 'warning' | 'error' | 'info', title: string, message: string) => void;
  /**
   * ★ M3-2c#fix 重名校验：传入「去首尾空白的目标名称」，父组件用当前 modes（排除本 mode 自身 id）
   *   做大小写不敏感比对，撞名返回 true。用于阻止自定义模板与内建/其它自定义模板同名——
   *   @MultiAI 触发按 name 取首个命中（BUILT_IN_MODES 永远靠前），同名会让用户精心编辑的工作流永远跑不到。
   */
  isNameTaken: (trimmedName: string) => boolean;
}

/** 统计模板涉及的子代理总数（agent=1，parallel=branches.length，condition=0）+ 1 主 Agent，供列表 agentCount 展示。 */
function countAgents(workflow: WorkflowNode[]): number {
  let subs = 0;
  for (const node of workflow) {
    if (node.type === 'agent') subs += 1;
    else if (node.type === 'parallel') subs += node.branches.length;
  }
  return subs + 1;
}

export function WorkflowEditor({ mode, availableModels, onSave, onCancel, onDelete, notify, isNameTaken }: WorkflowEditorProps) {
  const [name, setName] = useState(mode.name);
  const [description, setDescription] = useState(mode.description ?? '');
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => cloneWorkflow(mode.workflow));

  // M6 收尾 D1 修补（review HIGH#3）：示例展示【人类手打语法】用 mode.name（resolveWorkflowMode 走 name 兜底命中，
  //   与 atomic token 内部用 mode.id 是两条独立路径，UX 引导走友好的 name）。富文本菜单 @ 点击插入时仍由 atProviders
  //   设 dataset.value=mode.id 走 `^(\S+)` 严格扫描避空格截断——这是内部协议，不暴露给用户照抄。
  const triggerExample = useMemo(
    () => `${MULTI_AI_TRIGGER_PREFIX}${name.trim() || '模式名'} 你的任务描述`,
    [name],
  );

  // condition 作为首节点的轻提示（复用 runWorkflow 容错，UI 层只 warning）。
  const conditionFirstWarning = nodes.length > 0 && nodes[0].type === 'condition';

  const updateNode = (index: number, next: WorkflowNode) => {
    setNodes(prev => prev.map((n, i) => (i === index ? next : n)));
  };

  const addNode = (type: NodeType) => {
    setNodes(prev => [...prev, makeNode(type)]);
  };

  const removeNode = (index: number) => {
    setNodes(prev => prev.filter((_, i) => i !== index));
  };

  const moveNode = (index: number, dir: -1 | 1) => {
    setNodes(prev => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  /** 切换节点类型：重建为该类型默认节点，但沿用原节点 id（保持工作流上下文标识稳定）。 */
  const changeNodeType = (index: number, type: NodeType) => {
    setNodes(prev => prev.map((n, i) => {
      if (i !== index) return n;
      if (n.type === type) return n;
      const fresh = makeNode(type);
      return { ...fresh, id: n.id } as WorkflowNode;
    }));
  };

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      notify('warning', '名称不能为空', '请为该工作流模板填写一个名称（@MultiAI 触发时按名称匹配）。');
      return;
    }
    // ★ M3-2c#fix 重名校验：与内建/其它自定义模板撞名时阻止保存——@MultiAI 按 name 取首个命中
    //   （BUILT_IN_MODES 永远靠前），同名会让本工作流永远跑不到且无任何提示。
    if (isNameTaken(trimmedName)) {
      notify('warning', '名称已被占用', `已存在同名模式「${trimmedName}」。@MultiAI 触发会匹配到另一个模式（内建模式优先），请改用一个唯一的名称。`);
      return;
    }
    if (nodes.length === 0) {
      notify('warning', '至少需要一个节点', '空工作流无法通过 @MultiAI 触发，请至少添加一个节点。');
      return;
    }
    // 基本字段校验：agent / parallel 的子代理需要 name；condition 需要 expr。
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.type === 'agent' && !node.subagent.name.trim()) {
        notify('warning', '子代理缺少名称', `第 ${i + 1} 个节点（串行）的子代理名称为空，请补全。`);
        return;
      }
      if (node.type === 'parallel') {
        if (node.branches.length === 0) {
          notify('warning', '并行节点缺少分支', `第 ${i + 1} 个节点（并行）至少需要一个分支。`);
          return;
        }
        if (node.branches.some(b => !b.name.trim())) {
          notify('warning', '分支缺少名称', `第 ${i + 1} 个节点（并行）存在未命名的分支，请补全。`);
          return;
        }
      }
      if (node.type === 'condition' && !node.expr.trim()) {
        notify('warning', '判断节点缺少判断语义', `第 ${i + 1} 个节点（判断）的判断语义为空，请填写一句清晰的判断（如「上一步是否发现需要修复的问题」）。`);
        return;
      }
    }
    if (conditionFirstWarning) {
      notify('warning', '判断节点不建议作首节点', '首节点为判断节点时缺少前序产出依据，判断可能不可靠（运行器会容错保守放行）。已照常保存，建议把判断节点放到产出节点之后。');
    }
    // ★ M3-2c#fix nodeId 唯一性收口：节点 id 是工作流上下文标识 + 卡片/汇总文本溯源标签（WorkflowCard
    //   title、buildWorkflowContext 的 [nodeId] 前缀）。重复 nodeId 会让卡片/汇总里两节点同名难区分。
    //   这里发现重复即对重复者自动重分配新 id（不阻断保存），并提示用户。
    const seenIds = new Set<string>();
    let reassigned = 0;
    const dedupedNodes = nodes.map(n => {
      if (!seenIds.has(n.id)) {
        seenIds.add(n.id);
        return n;
      }
      // 重复 → 生成一个不与已见集合冲突的新 id（genId 自增 + 时间戳基本不重；循环兜底极端碰撞）。
      let fresh = genId(n.type);
      while (seenIds.has(fresh)) fresh = genId(n.type);
      seenIds.add(fresh);
      reassigned += 1;
      return { ...n, id: fresh } as WorkflowNode;
    });
    if (reassigned > 0) {
      notify('warning', '已修正重复节点 id', `检测到 ${reassigned} 个节点 id 重复，已自动重新分配唯一 id（避免卡片/汇总中节点同名难以区分）。`);
    }
    onSave({
      name: trimmedName,
      description: description.trim(),
      workflow: dedupedNodes,
      agentCount: countAgents(dedupedNodes),
      // ★ M3-2c#fix：带 workflow 的模板 subagents 显式归一为 []，消除复制内建后重构为工作流时残留的
      //   subagents 僵尸数据（runWorkflow 只看 workflow，残留 subagents 会成 UI 不可见的死数据）。
      subagents: [],
    });
  };

  return (
    <div className="workflow-editor">
      <div className="workflow-editor-head">
        <button className="settings-btn compact" type="button" onClick={onCancel}>← 返回列表</button>
        <div className="workflow-editor-actions">
          <button className="settings-btn danger compact" type="button" onClick={onDelete}>删除模板</button>
          <button className="settings-btn compact" type="button" onClick={handleSave}>💾 保存</button>
        </div>
      </div>

      <div className="setting-item">
        <label>模板名称</label>
        <input
          type="text"
          value={name}
          placeholder="例如：找茬模式"
          onChange={e => setName(e.target.value)}
        />
      </div>
      <div className="setting-item workflow-field-block">
        <label>模板描述</label>
        <textarea
          className="workflow-textarea"
          rows={2}
          value={description}
          placeholder="一句话说明这个工作流做什么（展示在模式列表）"
          onChange={e => setDescription(e.target.value)}
        />
      </div>

      <div className="workflow-trigger-hint">
        <span className="workflow-trigger-hint-title">触发用法</span>
        <code>{triggerExample}</code>
        <span className="setting-hint">
          在对话输入框以此格式发送即可运行本工作流（模式名按名称大小写不敏感匹配）。
        </span>
      </div>

      {conditionFirstWarning && (
        <div className="workflow-warning">
          ⚠️ 首节点为「判断」节点时缺少前序产出依据，判断可能不可靠（运行器会容错放行）。建议把判断节点放到产出节点之后。
        </div>
      )}

      <div className="settings-subsection-title">工作流节点（按顺序串行执行）</div>
      {nodes.length === 0 && (
        <p className="setting-hint">还没有节点。点下方按钮添加第一个节点。</p>
      )}

      <div className="workflow-node-list">
        {nodes.map((node, index) => (
          <WorkflowNodeCard
            key={node.id}
            node={node}
            index={index}
            total={nodes.length}
            availableModels={availableModels}
            onChange={next => updateNode(index, next)}
            onChangeType={type => changeNodeType(index, type)}
            onMove={dir => moveNode(index, dir)}
            onRemove={() => removeNode(index)}
          />
        ))}
      </div>

      <div className="workflow-add-row">
        <span className="setting-hint">添加节点：</span>
        <button className="settings-btn compact" type="button" onClick={() => addNode('agent')}>+ 串行 agent</button>
        <button className="settings-btn compact" type="button" onClick={() => addNode('parallel')}>+ 并行 parallel</button>
        <button className="settings-btn compact" type="button" onClick={() => addNode('condition')}>+ 判断 condition</button>
      </div>
    </div>
  );
}

interface NodeCardProps {
  node: WorkflowNode;
  index: number;
  total: number;
  availableModels: AIModelOption[];
  onChange: (next: WorkflowNode) => void;
  onChangeType: (type: NodeType) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  agent: '串行（单子代理）',
  parallel: '并行（多子代理同时）',
  condition: '判断（条件分支）',
};

function WorkflowNodeCard({ node, index, total, availableModels, onChange, onChangeType, onMove, onRemove }: NodeCardProps) {
  return (
    <div className="workflow-node-card">
      <div className="workflow-node-head">
        <span className="workflow-node-index">#{index + 1}</span>
        <select
          className="workflow-node-type"
          value={node.type}
          onChange={e => onChangeType(e.target.value as NodeType)}
          title="节点类型"
        >
          {(Object.keys(NODE_TYPE_LABELS) as NodeType[]).map(t => (
            <option key={t} value={t}>{NODE_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <div className="workflow-node-head-actions">
          <button className="settings-btn compact" type="button" disabled={index === 0} onClick={() => onMove(-1)} title="上移">↑</button>
          <button className="settings-btn compact" type="button" disabled={index === total - 1} onClick={() => onMove(1)} title="下移">↓</button>
          <button className="settings-btn danger compact" type="button" onClick={onRemove} title="删除节点">✕</button>
        </div>
      </div>

      {node.type === 'agent' && (
        <AgentNodeForm node={node} availableModels={availableModels} onChange={onChange} />
      )}
      {node.type === 'parallel' && (
        <ParallelNodeForm node={node} availableModels={availableModels} onChange={onChange} />
      )}
      {node.type === 'condition' && (
        <ConditionNodeForm node={node} onChange={onChange} />
      )}
    </div>
  );
}

/** SubagentConfig 子表单：name / role / model / maxDepth / maxTokens / toolPermissions / systemPrompt。 */
function SubagentForm({
  sub,
  availableModels,
  onChange,
}: {
  sub: SubagentConfig;
  availableModels: AIModelOption[];
  onChange: (next: SubagentConfig) => void;
}) {
  const patch = (updates: Partial<SubagentConfig>) => onChange({ ...sub, ...updates });
  const togglePermission = (perm: SubagentConfig['toolPermissions'][number]) => {
    const has = sub.toolPermissions.includes(perm);
    const next = has
      ? sub.toolPermissions.filter(p => p !== perm)
      : [...sub.toolPermissions, perm];
    patch({ toolPermissions: next });
  };
  return (
    <div className="workflow-subagent-form">
      <div className="setting-item">
        <label>名称</label>
        <input type="text" value={sub.name} placeholder="如：审查者" onChange={e => patch({ name: e.target.value })} />
      </div>
      <div className="setting-item">
        <label>角色</label>
        <input type="text" value={sub.role} placeholder="一句话角色描述" onChange={e => patch({ role: e.target.value })} />
      </div>
      <div className="setting-item">
        <label>使用模型</label>
        <select value={sub.model ?? ''} onChange={e => patch({ model: e.target.value })}>
          <option value="">跟随默认 / 主 Agent</option>
          {availableModels.map(m => (
            <option key={m.id} value={m.id}>{m.name || m.id}</option>
          ))}
        </select>
      </div>
      <div className="setting-item">
        <label>派发深度</label>
        <input
          type="number"
          min={1}
          max={5}
          step={1}
          style={{ width: 80 }}
          value={sub.maxDepth ?? 1}
          onChange={e => {
            const v = Number(e.target.value);
            patch({ maxDepth: Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 1 });
          }}
        />
        <span className="setting-hint">1=不可再派子代理；N&gt;1 允许逐层递减派发</span>
      </div>
      <div className="setting-item">
        <label>Token 上限</label>
        <input
          type="number"
          min={256}
          max={128000}
          step={256}
          style={{ width: 100 }}
          value={sub.maxTokens}
          onChange={e => {
            const v = Number(e.target.value);
            patch({ maxTokens: Number.isFinite(v) ? Math.min(128000, Math.max(256, v)) : 4096 });
          }}
        />
      </div>
      <div className="setting-item workflow-field-block">
        <label>工具权限</label>
        <div className="settings-chip-row">
          {TOOL_PERMISSION_OPTIONS.map(perm => (
            <label key={perm} className={`workflow-perm-chip ${sub.toolPermissions.includes(perm) ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={sub.toolPermissions.includes(perm)}
                onChange={() => togglePermission(perm)}
              />
              {TOOL_PERMISSION_LABELS[perm]}
            </label>
          ))}
        </div>
      </div>
      <div className="setting-item workflow-field-block">
        <label>系统提示</label>
        <textarea
          className="workflow-textarea"
          rows={3}
          value={sub.systemPrompt}
          placeholder="该子代理的系统提示（角色定位、输出格式要求等）"
          onChange={e => patch({ systemPrompt: e.target.value })}
        />
      </div>
    </div>
  );
}

/** 任务模板输入（公共：agent / parallel 共用，支持 {{userInput}} / {{context}} 占位符）。 */
function TaskTemplateField({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  return (
    <div className="setting-item workflow-field-block">
      <label>任务模板</label>
      <textarea
        className="workflow-textarea"
        rows={3}
        value={value ?? ''}
        placeholder="可留空（运行器用默认模板）。支持占位符 {{userInput}}（原始用户输入）与 {{context}}（前序节点结果摘要）。"
        onChange={e => onChange(e.target.value)}
      />
      <span className="setting-hint">占位符：{'{{userInput}}'} = 原始用户输入；{'{{context}}'} = 前序节点结果摘要。</span>
    </div>
  );
}

function AgentNodeForm({
  node,
  availableModels,
  onChange,
}: {
  node: Extract<WorkflowNode, { type: 'agent' }>;
  availableModels: AIModelOption[];
  onChange: (next: WorkflowNode) => void;
}) {
  return (
    <div className="workflow-node-body">
      <TaskTemplateField value={node.taskTemplate} onChange={v => onChange({ ...node, taskTemplate: v })} />
      <div className="settings-subsection-title">子代理</div>
      <SubagentForm
        sub={node.subagent}
        availableModels={availableModels}
        onChange={sub => onChange({ ...node, subagent: sub })}
      />
    </div>
  );
}

function ParallelNodeForm({
  node,
  availableModels,
  onChange,
}: {
  node: Extract<WorkflowNode, { type: 'parallel' }>;
  availableModels: AIModelOption[];
  onChange: (next: WorkflowNode) => void;
}) {
  const updateBranch = (i: number, sub: SubagentConfig) => {
    onChange({ ...node, branches: node.branches.map((b, idx) => (idx === i ? sub : b)) });
  };
  const addBranch = () => onChange({ ...node, branches: [...node.branches, makeSubagent()] });
  const removeBranch = (i: number) => onChange({ ...node, branches: node.branches.filter((_, idx) => idx !== i) });
  return (
    <div className="workflow-node-body">
      <TaskTemplateField value={node.taskTemplate} onChange={v => onChange({ ...node, taskTemplate: v })} />
      <div className="settings-subsection-title">并行分支（{node.branches.length}）</div>
      {node.branches.map((branch, i) => (
        <div key={branch.id} className="workflow-branch">
          <div className="workflow-branch-head">
            <span className="setting-hint">分支 {i + 1}</span>
            <button
              className="settings-btn danger compact"
              type="button"
              disabled={node.branches.length <= 1}
              onClick={() => removeBranch(i)}
              title="删除分支"
            >
              ✕
            </button>
          </div>
          <SubagentForm sub={branch} availableModels={availableModels} onChange={sub => updateBranch(i, sub)} />
        </div>
      ))}
      <div className="workflow-add-row">
        <button className="settings-btn compact" type="button" onClick={addBranch}>+ 添加分支</button>
      </div>
    </div>
  );
}

function ConditionNodeForm({
  node,
  onChange,
}: {
  node: Extract<WorkflowNode, { type: 'condition' }>;
  onChange: (next: WorkflowNode) => void;
}) {
  return (
    <div className="workflow-node-body">
      <div className="setting-item workflow-field-block">
        <label>判断语义</label>
        <textarea
          className="workflow-textarea"
          rows={2}
          value={node.expr}
          placeholder="一句清晰的判断，如：前序找茬子代理是否发现了需要修复的实质问题"
          onChange={e => onChange({ ...node, expr: e.target.value })}
        />
        <span className="setting-hint">运行器据此 + 前序结果做一次轻量 LLM 判断（真/假）。</span>
      </div>
      <div className="setting-item">
        <label>判为否时</label>
        <select value={node.onFalse} onChange={e => onChange({ ...node, onFalse: e.target.value as 'abort' | 'continue' })}>
          <option value="abort">中止整工作流（反馈「无法推进」）</option>
          <option value="continue">跳过本判断，继续后续节点</option>
        </select>
      </div>
      <div className="setting-item workflow-field-block">
        <label>说明文案</label>
        <textarea
          className="workflow-textarea"
          rows={2}
          value={node.message ?? ''}
          placeholder="中止 / 跳过时反馈给用户的说明（可选）"
          onChange={e => onChange({ ...node, message: e.target.value })}
        />
      </div>
    </div>
  );
}
