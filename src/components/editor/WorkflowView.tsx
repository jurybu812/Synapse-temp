/**
 * ★ M3-3b 子代理中间视图（方案见 Plan_4_M3 §五）。
 *
 * 点击对话流里的 WorkflowCard → 在中间编辑器区打开本视图（VS Code 式 tab，非文件视图，仿 ReviewChangesView）。
 * 比 M3-3a 卡片更详细：「真点进每个子代理对话看进度」的 UI 量级。
 *   - 左列：该工作流运行实例（workflowRuns[runId]）的子代理列表——角色 + 四色状态点（复用 M3-3a 同款四色）
 *           + 节点/模型/工具次数/token/耗时。点选任一子代理。
 *   - 右区：选中子代理的【完整对话流】——按 WorkflowRunSubagent.conversationId（M3-3b 桥接：子代理跑完
 *           落库的独立 is_subagent conversation id）走 loadConversationSnapshot 读回 messages，复用 <MessageBubble/> 渲染。
 *   - 实时：useAppSelector 订阅 workflowRuns，子代理状态/落库 conversationId 变化自动重渲染；选中子代理对话
 *           落库后（conversationId 出现）自动加载。
 *   - 子代理还在跑 / 尚未落库 / 落库失败（无 conversationId）→ 显示占位（不崩、不空白）。
 *
 * 数据读取链路（与 M3-1a 落库口径一致）：
 *   persistSubagentConversation 用 createConversationId() 生成独立 conversation id（≠ subagentId），
 *   随完成/失败回填进 WorkflowRunSubagent.conversationId（agentOrchestrator.syncWorkflowRunSubagent）。
 *   本视图据该 id 调 loadConversationSnapshot（内部 platform.conversation.get + listMessages，双模式对等）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import type { WorkflowRun, WorkflowRunSubagent } from '@/store/slices/multiAI';
import { loadConversationSnapshot, type ConversationSnapshot } from '@/services/conversationPersistence';
import { MessageBubble } from '@/components/chat/MessageBubble';

interface WorkflowViewProps {
  runId: string;
}

/** 四色映射（与 M3-3a WorkflowCard / RunningSubagent.status 同款状态机）。 */
function statusColor(status: WorkflowRunSubagent['status']): string {
  switch (status) {
    case 'running': return 'var(--syn-info)';        // 蓝：进行中
    case 'retrying': return 'var(--syn-warning)';    // 黄：retry/重连阻塞
    case 'error': return 'var(--syn-error)';         // 红：失败
    case 'complete': return 'var(--syn-text-muted)'; // 灰：已完成
    default: return 'var(--syn-text-muted)';
  }
}

const STATUS_LABEL: Record<WorkflowRunSubagent['status'], string> = {
  running: '运行中',
  retrying: '重试中',
  complete: '完成',
  error: '失败',
};

function runStatusMeta(status: WorkflowRun['status']): { color: string; label: string } {
  switch (status) {
    case 'running': return { color: 'var(--syn-info)', label: '运行中' };
    case 'complete': return { color: 'var(--syn-text-muted)', label: '已完成' };
    case 'aborted': return { color: 'var(--syn-error)', label: '已中止' };
    default: return { color: 'var(--syn-text-muted)', label: status };
  }
}

/** 子代理耗时（运行中按 now-startTime；完成按 endTime-startTime）。 */
function formatDuration(sub: WorkflowRunSubagent, now: number): string {
  const end = sub.endTime ?? now;
  const ms = Math.max(0, end - sub.startTime);
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 右区：单个子代理的完整对话流（按 conversationId 读回，复用 MessageBubble）。 */
function SubagentConversation({ sub }: { sub: WorkflowRunSubagent }) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const conversationId = sub.conversationId;

  useEffect(() => {
    // 尚未落库（运行中 / 落库失败）→ 不加载，由下方占位分支处理。
    if (!conversationId) {
      setSnapshot(null);
      setError('');
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const loaded = await loadConversationSnapshot(conversationId);
        if (!cancelled) {
          if (loaded) setSnapshot(loaded);
          else setError('未找到该子代理的对话记录（可能已被清理）。');
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || '子代理对话加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  if (!conversationId) {
    // 运行中或落库失败：尽力展示占位（不空白）。
    const hint = sub.status === 'running' || sub.status === 'retrying'
      ? '子代理正在运行，完成后其完整对话流将在此显示…'
      : sub.status === 'error'
        ? '子代理已失败，且未能落库对话记录。'
        : '该子代理暂无可查看的对话记录。';
    return (
      <div className="wf-view-conv-empty">
        <span className="wf-view-conv-empty-dot" style={{ background: statusColor(sub.status) }} />
        <p>{hint}</p>
      </div>
    );
  }

  if (loading) {
    return <div className="wf-view-conv-empty"><p>加载子代理对话中…</p></div>;
  }

  if (error) {
    return <div className="wf-view-conv-empty"><p>⚠️ {error}</p></div>;
  }

  const messages = snapshot?.messages ?? [];
  if (messages.length === 0) {
    return <div className="wf-view-conv-empty"><p>该子代理对话为空。</p></div>;
  }

  return (
    <div className="wf-view-conv-messages">
      {messages.map(msg => (
        <MessageBubble
          key={msg.id}
          id={msg.id}
          role={msg.role}
          content={msg.content}
          timestamp={msg.timestamp}
          model={msg.model}
          // 只读回看：不传任何编辑/重试/删除/分支回调（子代理 transcript 不可改）。
        />
      ))}
    </div>
  );
}

export function WorkflowView({ runId }: WorkflowViewProps) {
  // 订阅本 run（运行态变化——子代理状态、落库 conversationId——自动重渲染实现「实时」）。
  const run = useAppSelector((s: RootState) =>
    s.multiAI.workflowRuns.find((r: WorkflowRun) => r.runId === runId),
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 运行中按秒滴答刷新「耗时」（与 M3-3a 卡片同款；非运行态不开 timer 省开销）。
  const isRunning = run?.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  // 默认选中第一个子代理；选中项被移除（极端容错）时回退到第一个。
  const subagents = run?.subagents ?? [];
  const selected = useMemo(
    () => subagents.find(s => s.subagentId === selectedId) ?? subagents[0],
    [subagents, selectedId],
  );

  // run 不存在（重启/刷新后 workflowRuns 已重置为空，或非工作流 tab）→ 友好提示。
  if (!run) {
    return (
      <div className="wf-view-missing">
        <span style={{ fontSize: 32, opacity: 0.3 }}>🧩</span>
        <p>该工作流运行实例已不可用</p>
        <p className="wf-view-missing-hint">
          工作流运行状态是会话级运行态，应用重启或刷新后会清空。请重新触发工作流以查看子代理详情。
        </p>
      </div>
    );
  }

  const meta = runStatusMeta(run.status);
  const total = run.subagents.length;
  const done = run.subagents.filter(s => s.status === 'complete').length;
  const failed = run.subagents.filter(s => s.status === 'error').length;

  return (
    <div className="wf-view">
      <div className="wf-view-header">
        <span className="wf-view-title">🧩 {run.modeName}</span>
        <span className="wf-view-run-status" style={{ color: meta.color, borderColor: meta.color }}>
          {meta.label}
        </span>
        <span className="wf-view-progress">
          {done}/{total} 完成{failed > 0 ? ` · ${failed} 失败` : ''}
        </span>
      </div>

      <div className="wf-view-body">
        {/* 左列：子代理列表 */}
        <div className="wf-view-sidebar">
          {total === 0 ? (
            <div className="wf-view-sidebar-empty">等待子代理启动…</div>
          ) : (
            run.subagents.map(sub => {
              const color = statusColor(sub.status);
              const active = selected?.subagentId === sub.subagentId;
              const metaBits: string[] = [];
              if (sub.model) metaBits.push(sub.model);
              if (sub.toolCalls !== undefined) metaBits.push(`${sub.toolCalls} 次工具`);
              if (sub.tokens !== undefined) metaBits.push(`${sub.tokens} tok`);
              metaBits.push(formatDuration(sub, now));
              return (
                <button
                  key={sub.subagentId}
                  className={`wf-view-agent${active ? ' active' : ''}`}
                  onClick={() => setSelectedId(sub.subagentId)}
                  title={`节点：${sub.nodeId}`}
                >
                  <span
                    className={`wf-view-dot${sub.status === 'running' || sub.status === 'retrying' ? ' pulsing' : ''}`}
                    style={{ background: color }}
                  />
                  <div className="wf-view-agent-main">
                    <div className="wf-view-agent-top">
                      <span className="wf-view-agent-role">{sub.role}</span>
                      <span className="wf-view-agent-status" style={{ color }}>{STATUS_LABEL[sub.status]}</span>
                    </div>
                    <div className="wf-view-agent-meta">{metaBits.join(' · ')}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* 右区：选中子代理的完整对话流 */}
        <div className="wf-view-detail">
          {selected ? (
            <>
              <div className="wf-view-detail-header">
                <span className="wf-view-dot" style={{ background: statusColor(selected.status) }} />
                <span className="wf-view-detail-role">{selected.role}</span>
                <span className="wf-view-detail-node">节点 {selected.nodeId}</span>
                <span className="wf-view-detail-status" style={{ color: statusColor(selected.status) }}>
                  {STATUS_LABEL[selected.status]}
                </span>
              </div>
              <SubagentConversation sub={selected} />
            </>
          ) : (
            <div className="wf-view-conv-empty"><p>选择左侧任一子代理查看其对话流。</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
