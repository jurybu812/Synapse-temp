export type ToolStatus = 'running' | 'cancelling' | 'success' | 'error' | 'cancelled' | 'unknown';

export type ToolErrorCode =
  | 'not_found'
  | 'approval_denied'
  | 'aborted'
  | 'timeout'
  | 'transport'
  | 'provider'
  | 'rate_limit'
  | 'server_error'
  | 'http_error'
  | 'unauthorized'
  | 'quota_exhausted'
  | 'invalid_result'
  | 'unsupported'
  | 'unknown';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataRef: string }
  | { type: 'resource'; uri: string; name?: string };

export interface ToolArtifact {
  path: string;
  bytes?: number;
  sha256?: string;
}

export interface ToolData {
  content: ToolContentPart[];
  structured?: unknown;
  artifacts?: ToolArtifact[];
}

export type ToolResult =
  | {
      ok: true;
      status: 'success';
      taskId: string | null;
      data: ToolData;
      error: null;
      unknownSideEffect: false;
    }
  | {
      ok: false;
      status: 'running' | 'cancelling';
      taskId: string;
      data: ToolData | null;
      error: null;
      unknownSideEffect: false;
    }
  | {
      ok: false;
      status: 'error' | 'cancelled' | 'unknown';
      taskId: string | null;
      data: ToolData | null;
      error: ToolError;
      unknownSideEffect: boolean;
    };

export function textToolData(text: string, structured?: unknown, artifacts?: ToolArtifact[]): ToolData {
  return {
    content: text ? [{ type: 'text', text }] : [],
    structured,
    artifacts,
  };
}

export function toolSuccess(text: string, options?: { taskId?: string | null; structured?: unknown; artifacts?: ToolArtifact[] }): ToolResult {
  return {
    ok: true,
    status: 'success',
    taskId: options?.taskId ?? null,
    data: textToolData(text, options?.structured, options?.artifacts),
    error: null,
    unknownSideEffect: false,
  };
}

export function toolPending(status: 'running' | 'cancelling', taskId: string, text = ''): ToolResult {
  return {
    ok: false,
    status,
    taskId,
    data: text ? textToolData(text) : null,
    error: null,
    unknownSideEffect: false,
  };
}

export function toolFailure(
  status: 'error' | 'cancelled' | 'unknown',
  code: ToolErrorCode,
  message: string,
  options?: {
    taskId?: string | null;
    text?: string;
    retryable?: boolean;
    unknownSideEffect?: boolean;
    details?: unknown;
    structured?: unknown;
    artifacts?: ToolArtifact[];
  },
): ToolResult {
  const text = options?.text ?? message;
  return {
    ok: false,
    status,
    taskId: options?.taskId ?? null,
    data: text ? textToolData(text, options?.structured, options?.artifacts) : null,
    error: {
      code,
      message,
      retryable: options?.retryable ?? false,
      details: options?.details,
    },
    unknownSideEffect: options?.unknownSideEffect ?? status === 'unknown',
  };
}

export function isToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ToolResult>;
  const status = candidate.status;
  if (!status || !['running', 'cancelling', 'success', 'error', 'cancelled', 'unknown'].includes(status)) return false;
  if (typeof candidate.ok !== 'boolean' || typeof candidate.unknownSideEffect !== 'boolean' || !('taskId' in candidate)) return false;
  if (status === 'success') {
    return candidate.ok === true
      && candidate.error === null
      && Boolean(candidate.data)
      && Array.isArray(candidate.data?.content);
  }
  if (status === 'running' || status === 'cancelling') {
    return candidate.ok === false && typeof candidate.taskId === 'string' && candidate.taskId.length > 0 && candidate.error === null;
  }
  return candidate.ok === false && Boolean(candidate.error) && typeof candidate.error?.message === 'string';
}

export function appendToolText(result: ToolResult, text: string): ToolResult {
  if (!text) return result;
  const data = result.data ?? textToolData('');
  return {
    ...result,
    data: {
      ...data,
      content: [...data.content, { type: 'text', text }],
    },
  } as ToolResult;
}

export function renderToolResultForModel(result: ToolResult): string {
  const rendered = (result.data?.content ?? []).map(part => {
    if (part.type === 'text') return part.text;
    if (part.type === 'image') return `[图片内容 ${part.mimeType}: ${part.dataRef}]`;
    return `[资源: ${part.name ? `${part.name} ` : ''}${part.uri}]`;
  }).filter(Boolean).join('\n');
  if (rendered) return rendered;
  if (result.error) return `Error: ${result.error.message}`;
  return result.status === 'success' ? '[工具无返回内容]' : `工具状态: ${result.status}`;
}
