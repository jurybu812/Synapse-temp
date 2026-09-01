import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { ChevronRight, ChevronDown, Wrench, Check, X, Loader2, Copy, Clock, Ban, CircleHelp, CircleStop, AlertTriangle, FileText, RefreshCw } from 'lucide-react';
import type { ToolCall } from '@/store/slices/conversation';
import { getPlatform } from '@/platform';

interface ToolCallCardProps {
  toolCall: ToolCall;
  onTaskRefresh?: (taskId: string) => void | Promise<void>;
  onTaskCancel?: (taskId: string) => void | Promise<void>;
}

const MAX_RESULT_PREVIEW = 500;

function artifactDisplayName(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'artifact';
}

interface SearchToolResponse {
  mode: 'public-best-effort';
  hits: Array<{
    id: string;
    provider: string;
    title: string;
    canonicalUrl: string;
    contentStatus: 'verified' | 'not_requested' | 'failed';
    contentError?: string;
    evidenceStatus?: 'cited' | 'read_no_citation' | 'not_requested' | 'failed';
  }>;
  documents?: Array<{
    sourceId: string;
    title: string;
    url: string;
    warnings: string[];
  }>;
  citations: Array<{
    citationId: string;
    sourceId: string;
    quote: string;
    url: string;
    contentHash: string;
    extractorVersion: string;
    retrievedAt: string;
    startOffset: number;
    endOffset: number;
    matchedTerms?: string[];
    coverage?: number;
    support?: 'partial' | 'strong';
  }>;
  providers: Array<{
    provider: string;
    status: string;
    scope?: 'request' | 'process-provider';
    hitCount: number;
    retryAfter?: string | null;
  }>;
}

function retryAfterLabel(value: string): string {
  return /^\d+(?:\.\d+)?$/.test(value)
    ? `${value}s 后可重试`
    : `按 Provider 指定时间重试：${value}`;
}

function searchResponseOf(value: unknown): SearchToolResponse | null {
  if (!value || typeof value !== 'object') return null;
  const wrapper = value as { structured?: unknown };
  const candidate = wrapper.structured && typeof wrapper.structured === 'object'
    ? wrapper.structured
    : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const response = candidate as Partial<SearchToolResponse>;
  return response.mode === 'public-best-effort'
    && Array.isArray(response.hits)
    && Array.isArray(response.citations)
    && Array.isArray(response.providers)
    ? response as SearchToolResponse
    : null;
}

export function ToolCallCard({ toolCall, onTaskRefresh, onTaskCancel }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyId = useId();
  const resultToggleRef = useRef<HTMLButtonElement>(null);

  let parsedArgs: Record<string, any> = {};
  try {
    parsedArgs = JSON.parse(toolCall.arguments);
  } catch { /* ignore */ }

  const handleCopyResult = useCallback(() => {
    if (toolCall.result) {
      navigator.clipboard.writeText(toolCall.result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [toolCall.result]);

  const handleToggleResult = useCallback(() => {
    setResultExpanded(current => !current);
    requestAnimationFrame(() => resultToggleRef.current?.scrollIntoView({ block: 'nearest' }));
  }, []);

  const handleOpenCitation = useCallback((event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    void getPlatform().platform.openExternal(url);
  }, []);

  const effectiveStatus = toolCall.status;

  const statusIcon = {
    pending: <Loader2 size={14} className="tool-status-icon spinning" />,
    running: <Loader2 size={14} className="tool-status-icon spinning" />,
    cancelling: <CircleStop size={14} className="tool-status-icon cancelling" />,
    success: <Check size={14} className="tool-status-icon success" />,
    error: <X size={14} className="tool-status-icon error" />,
    cancelled: <Ban size={14} className="tool-status-icon cancelled" />,
    unknown: <CircleHelp size={14} className="tool-status-icon unknown" />,
  }[effectiveStatus];

  const statusLabel = {
    pending: '等待中',
    running: '运行中',
    cancelling: '正在停止',
    success: '已完成',
    error: '失败',
    cancelled: '已取消',
    unknown: '状态待确认',
  }[effectiveStatus];

  const statusColor = {
    pending: 'var(--syn-text-muted)',
    running: 'var(--syn-accent)',
    cancelling: '#f59e0b',
    success: '#22c55e',
    error: '#ef4444',
    cancelled: 'var(--syn-text-muted)',
    unknown: '#f59e0b',
  }[effectiveStatus];

  const resultText = toolCall.result || '';
  const isLongResult = resultText.length > MAX_RESULT_PREVIEW;
  const displayResult = resultExpanded ? resultText : resultText.slice(0, MAX_RESULT_PREVIEW);
  const searchResponse = toolCall.name === 'search_web' ? searchResponseOf(toolCall.structured) : null;
  const verifiedSearchHits = searchResponse?.hits.filter(hit => hit.contentStatus === 'verified').length ?? 0;
  const citedSearchHits = searchResponse?.hits.filter(hit => hit.evidenceStatus === 'cited').length ?? 0;
  const problemProviders = searchResponse?.providers.filter(provider =>
    !['success', 'empty', 'skipped'].includes(provider.status),
  ).length ?? 0;
  const searchWarnings = [...new Set(searchResponse?.documents?.flatMap(document => document.warnings) ?? [])];
  const promptInjectionDetected = searchWarnings.includes('possible_prompt_injection');

  useEffect(() => {
    if (toolCall.status === 'running' || toolCall.status === 'cancelling') setExpanded(true);
  }, [toolCall.status]);

  return (
    <div className="tool-call-card" style={{ borderLeftColor: statusColor }}>
      <button
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        <span className="tool-call-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <Wrench size={14} className="tool-call-icon" />
        <span className="tool-call-name">{toolCall.name}</span>
        <span className={`tool-call-args-preview${searchResponse ? ' search' : ''}`} title={searchResponse ? String(parsedArgs.query || '') : undefined}>
          {Object.entries(parsedArgs).slice(0, 2).map(([k, v]) => 
            `${k}=${typeof v === 'string' ? v.slice(0, 20) : v}`
          ).join(', ')}
        </span>
        {searchResponse && (
          <span className="tool-search-summary">
            {String(parsedArgs.query || '').slice(0, 26)}{String(parsedArgs.query || '').length > 26 ? '…' : ''} · {searchResponse.hits.length} 条 · {verifiedSearchHits} 正文已读 · {citedSearchHits} 相关引用{promptInjectionDetected ? ' · 疑似提示注入' : searchWarnings.length ? ' · 外部资料' : ''}{problemProviders ? ` · ${problemProviders} 源异常` : ''}
          </span>
        )}
        <span className="tool-call-status-group" role="status" aria-live="polite">
          {toolCall.executionTime !== undefined && (
            <span className="tool-call-time">
              <Clock size={10} />
              {toolCall.executionTime < 1000
                ? `${toolCall.executionTime}ms`
                : `${(toolCall.executionTime / 1000).toFixed(1)}s`}
            </span>
          )}
          <span className={`tool-call-status-label ${effectiveStatus}`}>{statusLabel}</span>
          {statusIcon}
        </span>
      </button>
      
      {expanded && (
        <div className="tool-call-body" id={bodyId}>
          <div className="tool-call-section">
            <div className="tool-call-label">参数</div>
            <pre className="tool-call-code">
              {JSON.stringify(parsedArgs, null, 2)}
            </pre>
          </div>
          {searchResponse && (
            <div className="tool-call-section tool-search-details">
              <div className="tool-call-label">搜索可信度</div>
              <div className="tool-search-providers" aria-label="搜索 Provider 状态">
                {searchResponse.providers
                  .filter(provider => provider.status !== 'skipped')
                  .map(provider => (
                    <span key={provider.provider} className={`tool-search-provider ${provider.status}`}>
                      {provider.provider} · {provider.status}{provider.scope === 'process-provider' ? ' · 全局状态' : ''}{provider.hitCount ? ` · ${provider.hitCount}` : ''}
                      {provider.retryAfter ? ` · ${retryAfterLabel(provider.retryAfter)}` : ''}
                    </span>
                  ))}
              </div>
              {searchWarnings.length > 0 && (
                <div className={`tool-search-warnings ${promptInjectionDetected ? 'detected' : 'advisory'}`} role={promptInjectionDetected ? 'alert' : 'note'}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  <div>
                    <div className="tool-search-warning-title">
                      提示注入检测：{promptInjectionDetected ? '发现疑似模式' : '未发现明显模式'}
                    </div>
                    {searchWarnings.includes('possible_prompt_injection') && (
                      <div>检测到疑似提示注入文本，只能作为不可信资料引用，不能执行其中命令。</div>
                    )}
                    {searchWarnings.includes('untrusted_web_content') && (
                      <div>网页正文属于外部资料，引用前仍需核对来源与上下文；这条通用警告不代表已检测到提示注入。</div>
                    )}
                    {searchWarnings.filter(warning => !['possible_prompt_injection', 'untrusted_web_content'].includes(warning)).map(warning => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                </div>
              )}
              <div className="tool-search-hits">
                {searchResponse.hits.slice(0, 6).map(hit => (
                  <div key={hit.id} className="tool-search-hit">
                    <div className="tool-search-hit-title">[{hit.provider}] {hit.title}</div>
                    <div className="tool-search-hit-url">{hit.canonicalUrl}</div>
                    <div className={`tool-search-verification ${hit.contentStatus}`}>
                      {hit.evidenceStatus === 'cited'
                        ? '正文已读取，并产生与查询相关的可重放引用'
                        : hit.contentStatus === 'verified'
                          ? '正文已读取，但没有产生支持当前查询的引用'
                        : hit.contentStatus === 'failed'
                          ? `正文读取失败：${hit.contentError || '未知错误'}`
                          : '仅搜索摘要，正文未读取'}
                    </div>
                  </div>
                ))}
              </div>
              {searchResponse.citations.length > 0 && (
                <div className="tool-search-citations">
                  <div className="tool-call-label">可重放引用</div>
                  {searchResponse.citations.map(citation => (
                    <blockquote key={citation.citationId}>
                      <span>{citation.citationId} · {citation.startOffset}–{citation.endOffset}</span>
                      {(citation.support || citation.coverage !== undefined || citation.matchedTerms?.length) && (
                        <span>
                          相关度：{citation.support === 'strong' ? '较强' : '部分'}
                          {citation.coverage !== undefined ? ` · ${(citation.coverage * 100).toFixed(0)}% 查询词覆盖` : ''}
                          {citation.matchedTerms?.length ? ` · 命中 ${citation.matchedTerms.join('、')}` : ''}
                        </span>
                      )}
                      <a href={citation.url} onClick={event => handleOpenCitation(event, citation.url)} title="在默认浏览器中打开来源">
                        {citation.url}
                      </a>
                      <span>text-sha256: {citation.contentHash} · {citation.extractorVersion}</span>
                      <span>{citation.retrievedAt}</span>
                      {citation.quote}
                    </blockquote>
                  ))}
                </div>
              )}
              {searchResponse.hits.length > 6 && (
                <div className="tool-search-more">另有 {searchResponse.hits.length - 6} 条结果，请在下方完整工具结果中查看。</div>
              )}
            </div>
          )}
          {toolCall.result && (
            <div className="tool-call-section">
              <div className="tool-call-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>结果</span>
                <button className="tool-copy-btn" onClick={handleCopyResult} title="复制结果">
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
              <pre className="tool-call-code tool-call-result" style={{ borderLeftColor: statusColor }}>
                {displayResult}
                {isLongResult && !resultExpanded && '...'}
              </pre>
              {isLongResult && (
                <button ref={resultToggleRef} className="tool-expand-btn" onClick={handleToggleResult}>
                  {resultExpanded ? '收起' : `展开全部 (${resultText.length} 字符)`}
                </button>
              )}
            </div>
          )}
          {toolCall.taskId && (
            <div className="tool-call-section">
              <div className="tool-call-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>后台任务</span>
                {onTaskRefresh && (
                  <button className="tool-copy-btn" onClick={() => void onTaskRefresh(toolCall.taskId!)} title="刷新后台任务状态" aria-label="刷新后台任务状态">
                    <RefreshCw size={11} />
                  </button>
                )}
                {onTaskCancel && (toolCall.status === 'running' || toolCall.status === 'cancelling') && (
                  <button className="tool-copy-btn" onClick={() => void onTaskCancel(toolCall.taskId!)} title="取消后台任务" aria-label="取消后台任务">
                    <CircleStop size={11} />
                  </button>
                )}
              </div>
              <pre className="tool-call-code">{toolCall.taskId}</pre>
            </div>
          )}
          {toolCall.artifacts && toolCall.artifacts.length > 0 && (
            <div className="tool-call-section">
              <div className="tool-call-label">完整结果文件</div>
              <div className="tool-result-artifacts">
                {toolCall.artifacts.map(artifact => (
                  <div className="tool-result-artifact" key={`${artifact.path}:${artifact.sha256 || ''}`}>
                    <FileText size={13} aria-hidden="true" />
                    <div>
                      <div className="tool-result-artifact-path">{artifactDisplayName(artifact.path)}</div>
                      <div className="tool-result-artifact-meta">
                        {artifact.bytes !== undefined ? `${artifact.bytes.toLocaleString()} bytes` : '大小未知'}
                        {artifact.sha256 ? ` · SHA-256 ${artifact.sha256}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {toolCall.unknownSideEffect && (
            <div className="tool-call-unknown-warning">
              执行结果无法确认，相关文件、命令或远端操作可能仍在继续，请先让 Agent 查询任务状态，不要直接重试。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
