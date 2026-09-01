/**
 * CompactDivider —— Plan_5 M5-BPC PhaseC（BPC-7）record 压缩点分隔线。
 *
 * 替代 AgentPanel 原内联虚线 div：按 record 批的 source 区分三态视觉——
 *   - 'manual'（手动 /compact）：灰，✎ 图标
 *   - 'auto'（自动 ~90% 硬阈值）：蓝，⚡ 图标
 *   - 'bpc'（后台预压缩）：紫渐变，✦ 图标 +「BPC 后台压缩」
 *
 * 压缩绝不删 store.messages，分隔线只是「此线以上历史发给 AI 时用 record 摘要代替」的可视标记。
 */

import { FileText, Zap, Sparkles } from 'lucide-react';

export type BatchSource = 'auto' | 'manual' | 'bpc';
export interface BatchMark {
  stepEnd: number;
  source: BatchSource;
  index: number;
}

/**
 * 从 record 提取分隔线标记（过滤元批 + 带 source + 顺序 index）。两处填充（初载 effect / 手动 /compact 后）共用，口径统一。
 * ★ R-L4 审查 #1：元批 stepEnd 必等于某 archived 批，过滤防同边界分隔线重复标签。
 */
export function extractBatchMarks(rec: { batches?: any[] } | null | undefined): BatchMark[] {
  return (rec?.batches ?? [])
    .filter((b: any) => !b.meta)
    .map((b: any) => ({ stepEnd: b.stepEnd as number, source: (b.source ?? 'auto') as BatchSource }))
    .filter((m) => m.stepEnd > 0)
    .map((m, i) => ({ ...m, index: i }));
}

const SOURCE_META: Record<BatchSource, { label: string; Icon: typeof FileText; cls: string }> = {
  manual: { label: '手动压缩', Icon: FileText, cls: 'cd-manual' },
  auto: { label: '自动压缩', Icon: Zap, cls: 'cd-auto' },
  bpc: { label: 'BPC 后台压缩', Icon: Sparkles, cls: 'cd-bpc' },
};

interface Props {
  marks: { index: number; source: BatchSource }[];
}

export function CompactDivider({ marks }: Props) {
  if (!marks || marks.length === 0) return null;
  // 主 source 取第一个批（同一边界通常仅一个批）；标签列出该边界全部批号。
  const primary = marks[0].source;
  const meta = SOURCE_META[primary] ?? SOURCE_META.auto;
  const Icon = meta.Icon;
  const batchLabel = marks.map(m => `#${m.index + 1}`).join('、');
  return (
    <div
      className={`compact-divider ${meta.cls}`}
      title="此线以上的历史已压缩为 record 摘要批次；发送给 AI 时用摘要代替原文，这里仍显示完整对话"
    >
      <span className="cd-line" />
      <span className="cd-chip">
        <Icon size={13} className="cd-icon" />
        <span className="cd-tag">压缩点</span>
        <span className="cd-text">{meta.label} · record 批次 {batchLabel}</span>
      </span>
      <span className="cd-line" />
    </div>
  );
}
