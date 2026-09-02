import { useMemo, useRef } from 'react';
import { isElectron } from '@platform/index';
import { useAppSelector } from '@/store/hooks';
import { Wifi, Zap } from 'lucide-react';
import { countConversationTokensExact } from '@/services/tokenizer';
import { getModelContextWindow } from '@/store/selectors/modelSelectors';
import { buildTokenEntryDetail, CompressionRing, getCacheHitRate } from './CompressionRing';
import { resolveProviderModel } from '@/services/providerModelRuntime';

function isLiveAssistantRunStatus(status: unknown): boolean {
  return status === 'idle' || status === 'pending' || status === 'streaming';
}

export function StatusBar() {
  const messages = useAppSelector((s) => s.conversation.messages);
  const model = useAppSelector((s) => s.agentSettings.currentModel);
  const isStreaming = useAppSelector((s) => s.conversation.isStreaming);
  const isAgentRunActive = useAppSelector((s) => (
    s.conversation.isStreaming || Object.values(s.conversation.assistantRuns).some(run => isLiveAssistantRunStatus(run.status))
  ));
  const tokenUsage = useAppSelector((s) => s.conversation.tokenUsage);
  const projectedTokenCount = useAppSelector((s) => s.conversation.tokenCount);
  const tokenCountSource = useAppSelector((s) => s.conversation.tokenCountSource);
  const providerConfigured = useAppSelector((s) => resolveProviderModel(
    s.agentSettings.currentModel,
    s.agentSettings.availableModels,
    s.settings.providerCredentials,
    s.settings.apiEndpoints,
  ).configured);
  const catalogStale = useAppSelector((s) => resolveProviderModel(
    s.agentSettings.currentModel,
    s.agentSettings.availableModels,
    s.settings.providerCredentials,
    s.settings.apiEndpoints,
  ).option?.catalog?.stale === true);
  const connectionStatus = useAppSelector((s) => s.agentSettings.connectionStatus);
  // M4-1-S3：上下文窗口统一走 selector（capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS），
  // 替代此前「模型名 includes('gpt-4') → 128000」硬编码映射（机制错：换模型/真有 context 字段时会偏）。
  const contextWindow = useAppSelector(getModelContextWindow);

  // ★ M6 验收 bug7：本地 token 计数——gpt 系模型用 gpt-tokenizer o200k_base 精确 encode，非 gpt 字符估算（exact 标志）。
  //   useMemo 缓存（仅 messages/model 变时重算），避免流式每帧 encode 整对话。
  // ★ M7 性能 B：流式期不重算本地 token——messages 引用每帧变会触发对整段对话全量 gpt-tokenizer encode
  //   （单次几十毫秒主线程同步阻塞，是流式卡顿主因之一）。isStreaming 时返回上次缓存值（流式 token 暂停跳动，
  //   可接受；有 API 实测 tokenUsage 时本就优先用实测、不受影响），停流后重算一次精确值。
  const lastLocalTokenRef = useRef<{ count: number; exact: boolean }>({ count: 0, exact: false });
  const localToken = useMemo(() => {
    if (isAgentRunActive) return lastLocalTokenRef.current;
    const v = countConversationTokensExact(messages.map(m => ({ role: m.role, content: m.content })), model);
    lastLocalTokenRef.current = v;
    return v;
  }, [messages, model, isAgentRunActive]);
  // M4-1-S3（openQuestions 4 决议）：「已用 token」与「上下文窗口」分母同口径（纯输入侧）。
  //   请求组装后优先显示当前待发送体投影；API usage 回写时 reducer 会把同一字段替换为精确 promptTokens。
  const hasApiUsage = tokenCountSource === 'api' && !!tokenUsage;
  const tokenCount = tokenCountSource === 'none' ? localToken.count : projectedTokenCount;
  const tokenExact = hasApiUsage || (tokenCountSource === 'none' && localToken.exact);

  const usage = tokenCount / contextWindow;
  const cacheHitRate = hasApiUsage ? getCacheHitRate(tokenUsage) : null;
  const tokenDetail = buildTokenEntryDetail({
    tokenCount,
    effectiveContextWindow: contextWindow,
    tokenRatio: usage,
    exact: tokenExact,
    tokenCountSource,
    tokenUsage,
  });
  const hasApiKey = providerConfigured;
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  const connectionLabel = !isOnline
    ? '离线'
    : !hasApiKey
      ? '未配置 API'
      : connectionStatus === 'checking'
        ? '检测中…'
        : connectionStatus === 'failed'
          ? '连接失败'
          : catalogStale
            ? '已配置 · 缓存目录'
            : '已配置';
  const connectionColor = !isOnline
    ? 'var(--syn-error)'
    : !hasApiKey
      ? 'var(--syn-text-muted)'
      : connectionStatus === 'failed'
        ? 'var(--syn-error)'
        : connectionStatus === 'checking'
          ? 'var(--syn-warning)'
          : catalogStale
            ? 'var(--syn-warning)'
          : 'var(--syn-success)';

  return (
    <div className="status-bar glass-panel">
      <div className="status-bar-left">
        <span className="status-item">
          {isElectron ? '🖥 Electron' : '🌐 Web'}
        </span>
        <span className="status-item">
          <span>{model || '未选择模型'}</span>
        </span>
        {(isStreaming || isAgentRunActive) && (
          <span className="status-item status-streaming">
            <Zap size={12} style={{ color: 'var(--syn-primary)' }} />
            <span>{isStreaming ? '生成中...' : '工具处理中...'}</span>
          </span>
        )}
      </div>
      <div className="status-bar-right">
        <span
          className="status-item status-token-detail"
          title={tokenDetail}
          aria-label={tokenDetail}
        >
          {/* ★ M5-BPC-6：StatusBar token 区同步 CompressionRing（inline + showDot 保留健康度状态点）。 */}
          {/* ★ M6 验收 bug7：exact 透传给 CompressionRing，估算态（非 gpt 模型）token 前缀 ≈。 */}
          <CompressionRing
            variant="inline"
            tokenCount={tokenCount}
            effectiveContextWindow={contextWindow}
            tokenRatio={usage}
            showDot
            exact={tokenExact}
            tokenCountSource={tokenCountSource}
            tokenUsage={tokenUsage}
          />
          {cacheHitRate !== null && <span className="status-cache-summary">cache {cacheHitRate}%</span>}
        </span>
        <span className="status-item">
          <Wifi size={12} style={{ color: connectionColor }} />
          <span>{connectionLabel}</span>
        </span>
        <span className="status-item status-version">Synapse v0.1.0</span>
      </div>
    </div>
  );
}
