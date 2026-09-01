/**
 * CompressionRing —— Plan_5 M5-BPC PhaseC（BPC-6）后台预压缩状态环。
 *
 * 定位：把 footer / context tab / StatusBar 三处原本各自写死的「Token: x/y (z%)」纯文本，统一收敛成一个
 *   订阅 bpc slice 的状态组件。idle 时维持原样（红黄灰分级 token%），BPC 后台活跃时切成「状态环 + 文案
 *   [+ 操作按钮]」，让用户看得见后台预压缩在跑、可中止、熔断了能重启。
 *
 * 数据流（决策②单向桥）：bpcScheduler 状态机迁移 → dispatch bpc slice → 本组件 useAppSelector 订阅渲染；
 *   仅中止 / 重启两个按钮反向调 bpcScheduler.abort() / restart()（其余纯订阅，不直接读 scheduler 内存）。
 *
 * variant：
 *   - 'full'（footer 主入口）：活跃态显环 + 文案 + 暗色 token + 中止×/重启↻ 按钮；idle/活跃均可点击打开
 *     本对话 BPC/硬压缩 override 浮层（onConfigClick，CC 式「每对话可调」）。
 *   - 'inline'（context tab / StatusBar）：活跃态显环 + 文案（无按钮、不可点，省空间）。
 * showDot：StatusBar 专用——idle 态在 token 文本前置一个健康度状态点（保留 StatusBar 原 ● 语义）。
 */

import { useEffect, useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import { bpcScheduler } from '@/services/bpcScheduler';
import { AUTOSAVE_ID, selectActiveConversation, type TokenCountSource, type TokenUsage } from '@/store/slices/conversation';
import { selectBpcUiState } from '@/store/slices/bpc';
import { X, RotateCw } from 'lucide-react';

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function exactToken(n: number): string {
  return String(Math.round(n));
}

type TokenDetailSource = 'api' | 'stale' | 'projected' | 'localExact' | 'localEstimate';

const TOKEN_DETAIL_SOURCE_LABELS = {
  api: 'API 实测',
  stale: '新请求正在组装，暂显示上一请求输入',
  projected: '当前待发送请求体估算',
  localExact: '本地分词器精确',
  localEstimate: '本地估算',
} satisfies Record<TokenDetailSource, string>;

export function getCacheHitRate(tokenUsage?: Pick<TokenUsage, 'promptTokens' | 'cacheReadTokens'> | null): number | null {
  const promptTokens = tokenUsage?.promptTokens;
  const cacheReadTokens = tokenUsage?.cacheReadTokens;
  if (typeof promptTokens !== 'number' || promptTokens <= 0) return null;
  if (typeof cacheReadTokens !== 'number' || !Number.isFinite(cacheReadTokens)) return null;
  return Math.round((cacheReadTokens / promptTokens) * 1000) / 10;
}

function providerToken(label: string, value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} 未返回`;
  return `${label} ${exactToken(value)}`;
}

export interface TokenEntryDetailInput {
  tokenCount: number;
  effectiveContextWindow: number;
  tokenRatio: number;
  exact: boolean;
  tokenCountSource: TokenCountSource;
  tokenUsage?: TokenUsage | null;
}

export function buildTokenText({ tokenCount, effectiveContextWindow, tokenRatio, exact }: Pick<TokenEntryDetailInput, 'tokenCount' | 'effectiveContextWindow' | 'tokenRatio' | 'exact'>): string {
  const pct = Math.round(tokenRatio * 100);
  return `Token: ${exact ? '' : '≈'}${fmt(tokenCount)} / ${fmt(effectiveContextWindow)} (${pct}%)`;
}

export function buildTokenEntryDetail(input: TokenEntryDetailInput): string {
  const tokenText = buildTokenText(input);
  const usage = input.tokenUsage;
  if (input.tokenCountSource === 'api') {
    if (!usage) return `API usage 未返回：${tokenText}`;
    const cacheHitRate = getCacheHitRate(usage);
    const parts = [
      `${TOKEN_DETAIL_SOURCE_LABELS.api}：prompt ${exactToken(usage.promptTokens)} / context ${exactToken(input.effectiveContextWindow)} (${Math.round(input.tokenRatio * 100)}%)`,
      `completion ${exactToken(usage.completionTokens)}`,
      `total ${exactToken(usage.totalTokens)}`,
      providerToken('cache read', usage.cacheReadTokens),
      providerToken('cache write', usage.cacheWriteTokens),
      cacheHitRate === null ? '命中率未知' : `命中率 ${cacheHitRate}%`,
    ];
    if (usage.providerId) parts.push(`provider ${usage.providerId}`);
    if (usage.modelId) parts.push(`model ${usage.modelId}`);
    if (usage.requestId) parts.push(`request ${usage.requestId}`);
    if (usage.bodySha256) parts.push(`body ${usage.bodySha256.slice(0, 12)}`);
    if (usage.inputImages?.length) parts.push(`input images ${usage.inputImages.length}`);
    return parts.join('，');
  }
  if (input.tokenCountSource === 'projected') {
    return `${TOKEN_DETAIL_SOURCE_LABELS.projected}：${tokenText}`;
  }
  if (input.tokenCountSource === 'stale') {
    return `${TOKEN_DETAIL_SOURCE_LABELS.stale}：${tokenText}`;
  }
  return `${input.exact ? TOKEN_DETAIL_SOURCE_LABELS.localExact : TOKEN_DETAIL_SOURCE_LABELS.localEstimate}：${tokenText}`;
}

/**
 * UsageDonut —— 常驻使用量圆环（SVG donut，仿 CC footer 环）。
 * 底环灰 + 前景弧按 tokenRatio 填充（从 12 点方向顺时针），颜色由调用方按水位分级传入。
 */
function UsageDonut({ ratio, color, size = 14, stroke = 2.5 }: { ratio: number; color: string; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = Math.min(Math.max(ratio, 0), 1) * circumference;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="cr-donut" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--syn-overlay-strong)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={`${filled} ${circumference}`} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

interface Props {
  tokenCount: number;
  effectiveContextWindow: number;
  tokenRatio: number;
  variant?: 'full' | 'inline';
  /** StatusBar 用：idle 态前置健康度状态点（绿/黄/红），保留 StatusBar 原 ● 语义。 */
  showDot?: boolean;
  /** ★ 验收新增：full（footer）点击打开本对话 BPC/硬压缩 override 浮层（CC 式每对话可调）。仅 full variant 生效。 */
  onConfigClick?: () => void;
  /** ★ M6 验收 bug7：token 是否精确（API 实测 / gpt 分词器=true；非 gpt 字符估算=false）。false 时数字前缀 ≈。 */
  exact?: boolean;
  tokenCountSource?: TokenCountSource;
  tokenUsage?: TokenUsage | null;
}

export function CompressionRing({
  tokenCount,
  effectiveContextWindow,
  tokenRatio,
  variant = 'full',
  showDot = false,
  onConfigClick,
  exact = true,
  tokenCountSource,
  tokenUsage,
}: Props) {
  const activeConversation = useAppSelector((s: RootState) => selectActiveConversation(s));
  const conversationId = activeConversation.id || AUTOSAVE_ID;
  const resolvedTokenCountSource = tokenCountSource ?? activeConversation.tokenCountSource;
  const resolvedTokenUsage = tokenUsage ?? activeConversation.tokenUsage;
  const bpc = useAppSelector((s: RootState) => selectBpcUiState(s, conversationId));
  const [cooldownMinutes, setCooldownMinutes] = useState(0);

  // cooldown 倒计时：仅冷却态每 30s 刷新一次「冷却中 Nm」显示（惰性，不冷却时不开定时器）。
  useEffect(() => {
    if (bpc.state !== 'cooldown' || !bpc.cooldownUntil) return;
    const refresh = () => setCooldownMinutes(Math.max(0, Math.ceil((bpc.cooldownUntil! - Date.now()) / 60000)));
    const immediate = setTimeout(refresh, 0);
    const interval = setInterval(refresh, 30000);
    return () => {
      clearTimeout(immediate);
      clearInterval(interval);
    };
  }, [bpc.state, bpc.cooldownUntil]);

  const isFull = variant === 'full';
  const clickable = isFull && !!onConfigClick;
  const tokenText = buildTokenText({ tokenCount, effectiveContextWindow, tokenRatio, exact });
  const tokenDetail = buildTokenEntryDetail({
    tokenCount,
    effectiveContextWindow,
    tokenRatio,
    exact,
    tokenCountSource: resolvedTokenCountSource,
    tokenUsage: resolvedTokenUsage,
  });
  // 文本分级（footer/context）：低水位灰。圆环分级：低水位 accent 紫（仿 CC 蓝调健康色）→ 中橙 → 高红。
  const textColor = tokenRatio > 0.8 ? 'var(--syn-error)' : tokenRatio > 0.5 ? 'var(--syn-warning)' : 'var(--syn-text-muted)';
  const ringColor = tokenRatio > 0.8 ? 'var(--syn-error)' : tokenRatio > 0.5 ? 'var(--syn-warning)' : 'var(--syn-accent)';

  // ── idle / aborted（瞬态）→ 常驻使用量圆环 + token 文本（仿 CC footer 环，full 可点击打开本对话 override 浮层） ──
  if (bpc.state === 'idle' || bpc.state === 'aborted') {
    // StatusBar（showDot）：环略小、用 token-counter 间距口径；footer/context：标准环。
    const cls = showDot ? 'compression-ring cr-statusbar' : `compression-ring ${isFull ? 'cr-full' : 'cr-inline'}`;
    return (
      <span
        className={`${cls}${clickable ? ' cr-clickable' : ''}`}
        onClick={clickable ? onConfigClick : undefined}
        title={clickable ? `${tokenDetail}（点击调本对话 BPC / 硬压缩阈值）` : tokenDetail}
        aria-label={clickable ? `${tokenDetail}，点击调本对话 BPC / 硬压缩阈值` : tokenDetail}
        role={clickable ? 'button' : undefined}
        tabIndex={0}
        onKeyDown={clickable ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onConfigClick?.();
          }
        } : undefined}
      >
        <UsageDonut ratio={tokenRatio} color={ringColor} size={showDot ? 12 : 14} />
        <span className="cr-token-dim" style={{ color: textColor }}>{tokenText}</span>
      </span>
    );
  }

  // ── 活跃态映射 ──
  let label = '';
  let spinning = false;
  let tone = 'var(--syn-text-muted)';
  let showAbort = false;
  let showRestart = false;

  switch (bpc.state) {
    case 'snapshotting':
      label = '准备压缩…'; spinning = true; tone = 'var(--syn-accent)'; showAbort = isFull; break;
    case 'generating':
      label = '后台压缩中'; spinning = true; tone = 'var(--syn-accent)'; showAbort = isFull; break;
    case 'ready':
      label = '压缩就绪'; tone = 'var(--syn-success)'; break;
    case 'replacing':
      label = '替换中…'; spinning = true; tone = 'var(--syn-accent)'; break;
    case 'cooldown': {
      label = `冷却中 ${cooldownMinutes}m`; tone = 'var(--syn-text-muted)'; break;
    }
    case 'circuit-broken':
      label = 'BPC 已停'; tone = 'var(--syn-error)'; showRestart = isFull; break;
    case 'hard-paused':
      label = '硬压缩已暂停'; tone = 'var(--syn-error)'; showRestart = isFull; break;
    default:
      label = '';
  }

  return (
    <span
      className={`compression-ring ${isFull ? 'cr-full' : 'cr-inline'}${clickable ? ' cr-clickable' : ''}`}
      style={{ color: tone }}
      title={`${tokenDetail}｜后台预压缩：${label}${bpc.lastError ? `｜原因：${bpc.lastError}` : ''}${clickable ? '（点击调本对话阈值）' : ''}`}
      aria-label={`${tokenDetail}，后台预压缩：${label}${bpc.lastError ? `，原因：${bpc.lastError}` : ''}${clickable ? '，点击调本对话阈值' : ''}`}
      onClick={clickable ? onConfigClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={0}
      onKeyDown={clickable ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onConfigClick?.();
        }
      } : undefined}
    >
      <span className={`cr-ring ${spinning ? 'cr-spin' : ''}`} style={{ borderTopColor: tone }} />
      <span className="cr-label">{label}</span>
      {isFull && <span className="cr-token-dim">{tokenText}</span>}
      {showAbort && (
        <button type="button" className="cr-btn" title="中止后台压缩（进入冷却期）" onClick={(e) => { e.stopPropagation(); bpcScheduler.abort(conversationId); }}>
          <X size={12} />
        </button>
      )}
      {showRestart && (
        <button type="button" className="cr-btn cr-restart-btn" title={bpc.lastError ? `恢复压缩与模型请求：${bpc.lastError}` : '显式恢复这条对话的压缩与模型请求'} onClick={(e) => { e.stopPropagation(); void bpcScheduler.restart(conversationId); }}>
          <RotateCw size={12} />
          <span>恢复</span>
        </button>
      )}
    </span>
  );
}
