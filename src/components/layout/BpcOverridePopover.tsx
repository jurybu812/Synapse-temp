/**
 * BpcOverridePopover —— Plan_5 M5-BPC PhaseC 验收：footer 压缩环点击弹出的【本对话】压缩面板（CC 式）。
 *
 * 仿 CC context window 面板：常驻使用量（footer 环）→ 点击展开此面板：
 *   ① Context window：当前 token 用量 / 模型窗口 + 总进度条（常驻使用窗口量的展开详情）。
 *   ② 距预压缩：当前用量 vs 预压阈值的进度条 + 本对话 bpcThreshold 滑杆（满=已触发后台预压）。
 *   ③ 距硬压缩：当前用量 vs 硬压阈值的进度条 + 本对话 compactThreshold 滑杆（满=已触发同步压缩）。
 * 阈值留空跟随 agentSettings.bpc 全局；调过即本对话覆盖（conversation.*Override，scheduler/agentLoop 已是
 * 「本对话覆盖 ?? 全局」口径）；恢复全局清覆盖。去掉 CC 的「额度」（Synapse 无此概念）。
 */

import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import { setBpcThresholdOverride, setCompactThresholdOverride } from '@/store/slices/conversation';
import { DEFAULT_BPC_CONFIG } from '@/store/slices/agentSettings';
import { RotateCcw, X } from 'lucide-react';

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  tokenCount: number;
  effectiveContextWindow: number;
  tokenRatio: number;
  /** ★ M6 验收 bug7：token 是否精确（API 实测 / gpt 分词器=true；非 gpt 估算=false）。false 时数字前缀 ≈。 */
  exact?: boolean;
  onClose: () => void;
}

export function BpcOverridePopover({ tokenCount, effectiveContextWindow, tokenRatio, exact = true, onClose }: Props) {
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLDivElement>(null);
  const bpcCfg = useAppSelector((s: RootState) => s.agentSettings.bpc);
  const bpcOverride = useAppSelector((s: RootState) => s.conversation.bpcThresholdOverride);
  const compactOverride = useAppSelector((s: RootState) => s.conversation.compactThresholdOverride);

  // 点击浮层外 / Esc 关闭。
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const globalBpc = bpcCfg?.bpcThreshold ?? DEFAULT_BPC_CONFIG.bpcThreshold;
  const globalCompact = bpcCfg?.compactThreshold ?? DEFAULT_BPC_CONFIG.compactThreshold;
  const bpcVal = bpcOverride ?? globalBpc;
  const compactVal = compactOverride ?? globalCompact;
  const hasOverride = bpcOverride !== undefined || compactOverride !== undefined;

  const pct = Math.round(tokenRatio * 100);
  const ctxColor = tokenRatio > 0.8 ? 'var(--syn-error)' : tokenRatio > 0.5 ? 'var(--syn-warning)' : 'var(--syn-accent)';
  // 距预压/距硬压：当前用量占该阈值的进度（满=已到触发线）。
  const toBpc = bpcVal > 0 ? Math.min(tokenRatio / bpcVal, 1) * 100 : 0;
  const toCompact = compactVal > 0 ? Math.min(tokenRatio / compactVal, 1) * 100 : 0;
  const bpcReached = tokenRatio >= bpcVal;
  const compactReached = tokenRatio >= compactVal;

  return (
    <div ref={ref} className="bpc-override-popover glass-panel">
      <div className="bpc-pop-header">
        <span>本对话 · 上下文压缩</span>
        <button type="button" className="bpc-pop-close" title="关闭" onClick={onClose}><X size={14} /></button>
      </div>

      {/* ① Context window 使用量（常驻使用窗口量的展开详情） */}
      <div className="bpc-pop-ctx">
        <div className="bpc-pop-ctx-head">
          <span>Context window</span>
          <span className="bpc-pop-ctx-val">{exact ? '' : '≈'}{fmt(tokenCount)} / {fmt(effectiveContextWindow)} · {pct}%</span>
        </div>
        <div className="bpc-pop-bar">
          <div className="bpc-pop-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: ctxColor }} />
        </div>
      </div>

      {/* ② 距预压缩 + 本对话预压阈值滑杆 */}
      <div className="bpc-pop-seg">
        <div className="bpc-pop-seg-head">
          <span>距预压缩{bpcReached ? '　· 已触发' : ''}</span>
          <span className="bpc-pop-seg-th">{bpcOverride !== undefined ? `本对话 ${Math.round(bpcVal * 100)}%` : `全局 ${Math.round(bpcVal * 100)}%`}</span>
        </div>
        <div className="bpc-pop-bar bpc-bar-pre">
          <div className="bpc-pop-bar-fill" style={{ width: `${toBpc}%` }} />
        </div>
        <input type="range" min="40" max="90" step="1" value={Math.round(bpcVal * 100)}
          onChange={e => dispatch(setBpcThresholdOverride(Number(e.target.value) / 100))} />
      </div>

      {/* ③ 距硬压缩 + 本对话硬压阈值滑杆 */}
      <div className="bpc-pop-seg">
        <div className="bpc-pop-seg-head">
          <span>距硬压缩{compactReached ? '　· 已触发' : ''}</span>
          <span className="bpc-pop-seg-th">{compactOverride !== undefined ? `本对话 ${Math.round(compactVal * 100)}%` : `全局 ${Math.round(compactVal * 100)}%`}</span>
        </div>
        <div className="bpc-pop-bar bpc-bar-hard">
          <div className="bpc-pop-bar-fill" style={{ width: `${toCompact}%` }} />
        </div>
        <input type="range" min="50" max="95" step="1" value={Math.round(compactVal * 100)}
          onChange={e => dispatch(setCompactThresholdOverride(Number(e.target.value) / 100))} />
      </div>

      <div className="bpc-pop-footer">
        <span className="bpc-pop-hint">阈值仅本对话生效，留空跟随全局</span>
        <button type="button" className="bpc-pop-reset" disabled={!hasOverride}
          onClick={() => { dispatch(setBpcThresholdOverride(undefined)); dispatch(setCompactThresholdOverride(undefined)); }}>
          <RotateCcw size={12} /> 恢复全局
        </button>
      </div>
    </div>
  );
}
