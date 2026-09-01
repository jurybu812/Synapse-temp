/**
 * ★ M3-3a 工作流运行卡片（方案见 Plan_4_M3 §五）。
 *
 * 让 @MultiAI 固定工作流在对话流里显示为【实时四色子代理卡片】，而非只有一条文本汇总 assistant 消息。
 *   - 数据源：订阅 store.multiAI.workflowRuns[runId]（运行态，runWorkflow 实时写入/流转）。
 *   - 实时：useAppSelector 订阅，子代理状态变化（running→retrying→complete/error）自动重渲染。
 *   - 四色（与 RunningSubagent.status 同款状态机，Plan_4_M3 §五）：
 *       complete       → 灰（--syn-text-muted）
 *       running        → 蓝（--syn-info）
 *       retrying/阻塞  → 黄（--syn-warning）
 *       error/aborted  → 红（--syn-error）
 *   - 卡片整体可点击：onClick 先留 TODO 指向 M3-3b 中间视图（本轮不开视图，仅 console 提示）。
 *
 * 向后兼容：runId 查不到运行实例（如重启后 workflowRuns 已清空，或非工作流消息）→ 返回 null，
 *   由调用方（MessageBubble）回退渲染纯文本汇总。
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import type { RootState } from '@/store';
import type { WorkflowRun, WorkflowRunSubagent } from '@/store/slices/multiAI';
import { openWorkflowTab } from '@/store/slices/editorTabs';

interface WorkflowCardProps {
  runId: string;
}

/** 四色映射（与 RunningSubagent.status / WorkflowRunSubagent.status 对齐）。 */
function statusColor(status: WorkflowRunSubagent['status']): string {
  switch (status) {
    case 'running': return 'var(--syn-info)';      // 蓝：进行中
    case 'retrying': return 'var(--syn-warning)';  // 黄：retry/重连阻塞
    case 'error': return 'var(--syn-error)';       // 红：失败
    case 'complete': return 'var(--syn-text-muted)'; // 灰：已完成
    default: return 'var(--syn-text-muted)';
  }
}

/** 工作流整体状态对应的边框强调色 + 文案。 */
function runStatusMeta(status: WorkflowRun['status']): { color: string; label: string } {
  switch (status) {
    case 'running': return { color: 'var(--syn-info)', label: '运行中' };
    case 'complete': return { color: 'var(--syn-text-muted)', label: '已完成' };
    case 'aborted': return { color: 'var(--syn-error)', label: '已中止' };
    default: return { color: 'var(--syn-text-muted)', label: status };
  }
}

const STATUS_LABEL: Record<WorkflowRunSubagent['status'], string> = {
  running: '运行中',
  retrying: '重试中',
  complete: '完成',
  error: '失败',
};

/** 子代理耗时（运行中按 now-startTime；完成按 endTime-startTime）。 */
function formatDuration(sub: WorkflowRunSubagent, now: number): string {
  const end = sub.endTime ?? now;
  const ms = Math.max(0, end - sub.startTime);
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function SubagentRow({ sub, now }: { sub: WorkflowRunSubagent; now: number }) {
  const color = statusColor(sub.status);
  const metaBits: string[] = [];
  if (sub.model) metaBits.push(sub.model);
  if (sub.toolCalls !== undefined) metaBits.push(`${sub.toolCalls} 次工具`);
  if (sub.tokens !== undefined) metaBits.push(`${sub.tokens} tok`);
  metaBits.push(formatDuration(sub, now));

  return (
    <div className="wf-card-subagent" title={`节点：${sub.nodeId}`}>
      <span
        className={`wf-card-dot${sub.status === 'running' || sub.status === 'retrying' ? ' pulsing' : ''}`}
        style={{ background: color }}
      />
      <div className="wf-card-subagent-main">
        <div className="wf-card-subagent-top">
          <span className="wf-card-role">{sub.role}</span>
          <span className="wf-card-status" style={{ color }}>{STATUS_LABEL[sub.status]}</span>
        </div>
        <div className="wf-card-meta">{metaBits.join(' · ')}</div>
      </div>
    </div>
  );
}

export function WorkflowCard({ runId }: WorkflowCardProps) {
  const dispatch = useAppDispatch();
  // 订阅本 run（运行态变化自动重渲染实现「实时」）。
  const run = useAppSelector((s: RootState) =>
    s.multiAI.workflowRuns.find((r: WorkflowRun) => r.runId === runId),
  );

  // ★ 运行中按秒滴答刷新「耗时」（与 MessageBubble 的 live 计时同款；非运行态不开 timer 省开销）。
  //   注意：Date.now() 不能在 render 期间直接调用（React 纯函数规则），故走 state + 定时器。
  const isRunning = run?.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  // ★ M3-3b：点击卡片 → 在中间编辑器区打开「子代理中间视图」tab（子代理列表 + 各自完整对话流）。
  //   title 用 modeName；openWorkflowTab 内部按 runId 去重（同 run 已开则仅激活不重开）。
  const handleClick = useCallback(() => {
    dispatch(openWorkflowTab({ runId, title: run?.modeName ?? '工作流' }));
  }, [dispatch, runId, run?.modeName]);

  // ★ M3-3b（修 M3-3a low）：role=button 的键盘可达性——Enter/Space 等价点击。
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }, [handleClick]);

  // 运行实例不存在（重启清空 / 非工作流消息）→ null，调用方回退纯文本汇总。
  if (!run) return null;

  const meta = runStatusMeta(run.status);
  const total = run.subagents.length;
  const done = run.subagents.filter(s => s.status === 'complete').length;
  const failed = run.subagents.filter(s => s.status === 'error').length;

  return (
    <div
      className="workflow-card"
      style={{ borderLeftColor: meta.color }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      title="点击查看子代理详情（中间视图：各子代理完整对话流）"
    >
      <div className="wf-card-header">
        <span className="wf-card-title">🧩 {run.modeName}</span>
        <span className="wf-card-run-status" style={{ color: meta.color, borderColor: meta.color }}>
          {meta.label}
        </span>
        <span className="wf-card-progress">
          {done}/{total} 完成{failed > 0 ? ` · ${failed} 失败` : ''}
        </span>
      </div>

      {total === 0 ? (
        <div className="wf-card-empty">等待子代理启动…</div>
      ) : (
        <div className="wf-card-subagents">
          {run.subagents.map(sub => (
            <SubagentRow key={sub.subagentId} sub={sub} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
