import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow } from 'electron';

export type RendererLifecycleEventName =
  | 'did-start-navigation'
  | 'did-finish-load'
  | 'did-fail-load'
  | 'render-process-gone'
  | 'unresponsive'
  | 'responsive'
  | 'child-process-gone'
  | 'renderer-load-attempt'
  | 'renderer-load-failed'
  | 'renderer-reload-requested'
  | 'renderer-recovery-scheduled'
  | 'renderer-recovery-started'
  | 'renderer-recovery-succeeded'
  | 'renderer-recovery-failed'
  | 'renderer-startup-retry'
  | 'renderer-startup-failed';

export interface RendererLifecycleLogFields {
  windowId?: number;
  webContentsId?: number;
  url?: string;
  isSameDocument?: boolean;
  isMainFrame?: boolean;
  frameProcessId?: number;
  frameRoutingId?: number;
  errorCode?: number;
  errorDescription?: string;
  reason?: string;
  exitCode?: number;
  type?: string;
  serviceName?: string;
  name?: string;
  source?: string;
  action?: string;
  status?: string;
  triggerEvent?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  loadGeneration?: number;
}

export interface RendererLifecycleLogger {
  readonly logFilePath: string;
  record(event: RendererLifecycleEventName, fields?: RendererLifecycleLogFields): void;
}

export interface RendererLifecycleLoggerOptions {
  storageRoot?: string | null;
  fallbackRoot: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => Date;
  getProcessId?: () => number;
}

const DEFAULT_LOG_FILE_NAME = 'renderer-lifecycle.jsonl';
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const MAX_URL_LENGTH = 512;
const MAX_TEXT_LENGTH = 256;
const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(token|api[_-]?key|password|passwd|pwd|secret|credential|authorization|cookie|session(?:id)?)\b\s*[:=]\s*["']?[^"',;\s]+/gi,
];
const urlLikePattern = /\b(?:https?|file):\/\/[^\s"'<>]+/gi;
const dangerousSchemePattern = /\b(?:data|javascript):[^\s"'<>]*/gi;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function trimLifecycleLogText(value: string, maxLength = MAX_TEXT_LENGTH): string {
  if (value.length > maxLength) return `${value.slice(0, maxLength)}…`;
  return value;
}

function redactLifecycleLogSecrets(value: string): string {
  let redacted = value;
  redacted = redacted.replace(secretPatterns[0], 'Bearer [redacted]');
  redacted = redacted.replace(secretPatterns[1], '$1=[redacted]');
  return redacted;
}

export function sanitizeLifecycleLogUrl(value: string | undefined): string | undefined {
  const rawUrl = value?.trim();
  if (!rawUrl) return undefined;
  if (/^(data|javascript):/i.test(rawUrl)) return `${rawUrl.split(':', 1)[0].toLowerCase()}:[redacted]`;
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return trimLifecycleLogText(redactLifecycleLogSecrets(parsed.toString()), MAX_URL_LENGTH);
  } catch {
    const withoutQueryOrFragment = rawUrl.replace(/[?#].*$/, '');
    return trimLifecycleLogText(redactLifecycleLogSecrets(withoutQueryOrFragment), MAX_URL_LENGTH);
  }
}

function redactLifecycleLogText(value: string | undefined, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (!value) return undefined;
  let redacted = redactLifecycleLogSecrets(value);
  redacted = redacted.replace(urlLikePattern, match => sanitizeLifecycleLogUrl(match) ?? '[redacted-url]');
  redacted = redacted.replace(dangerousSchemePattern, match => `${match.split(':', 1)[0].toLowerCase()}:[redacted]`);
  return trimLifecycleLogText(redacted, maxLength);
}

function resolveLifecycleLogFilePath(options: RendererLifecycleLoggerOptions): string {
  const root = options.storageRoot?.trim()
    ? path.resolve(options.storageRoot)
    : path.resolve(options.fallbackRoot);
  return path.join(root, 'logs', options.fileName ?? DEFAULT_LOG_FILE_NAME);
}

function rotateLifecycleLog(logFilePath: string, nextLineBytes: number, maxBytes: number, maxFiles: number): void {
  if (maxBytes <= 0 || maxFiles <= 0) return;
  let currentBytes = 0;
  try {
    currentBytes = fs.statSync(logFilePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (currentBytes === 0 || currentBytes + nextLineBytes <= maxBytes) return;
  const oldestPath = `${logFilePath}.${maxFiles}`;
  if (fs.existsSync(oldestPath)) fs.rmSync(oldestPath, { force: true });
  for (let index = maxFiles - 1; index >= 1; index--) {
    const sourcePath = `${logFilePath}.${index}`;
    if (fs.existsSync(sourcePath)) fs.renameSync(sourcePath, `${logFilePath}.${index + 1}`);
  }
  if (fs.existsSync(logFilePath)) fs.renameSync(logFilePath, `${logFilePath}.1`);
}

function sanitizedLifecycleFields(fields: RendererLifecycleLogFields) {
  return {
    windowId: finiteNumber(fields.windowId),
    webContentsId: finiteNumber(fields.webContentsId),
    url: sanitizeLifecycleLogUrl(fields.url),
    isSameDocument: typeof fields.isSameDocument === 'boolean' ? fields.isSameDocument : undefined,
    isMainFrame: typeof fields.isMainFrame === 'boolean' ? fields.isMainFrame : undefined,
    frameProcessId: finiteNumber(fields.frameProcessId),
    frameRoutingId: finiteNumber(fields.frameRoutingId),
    errorCode: finiteNumber(fields.errorCode),
    errorDescription: redactLifecycleLogText(fields.errorDescription),
    reason: redactLifecycleLogText(fields.reason),
    exitCode: finiteNumber(fields.exitCode),
    type: redactLifecycleLogText(fields.type),
    serviceName: redactLifecycleLogText(fields.serviceName),
    name: redactLifecycleLogText(fields.name),
    source: redactLifecycleLogText(fields.source),
    action: redactLifecycleLogText(fields.action),
    status: redactLifecycleLogText(fields.status),
    triggerEvent: redactLifecycleLogText(fields.triggerEvent),
    attempt: finiteNumber(fields.attempt),
    maxAttempts: finiteNumber(fields.maxAttempts),
    delayMs: finiteNumber(fields.delayMs),
    loadGeneration: finiteNumber(fields.loadGeneration),
  };
}

function pruneUndefinedValues<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function createRendererLifecycleLogger(options: RendererLifecycleLoggerOptions): RendererLifecycleLogger {
  const logFilePath = resolveLifecycleLogFilePath(options);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const now = options.now ?? (() => new Date());
  const getProcessId = options.getProcessId ?? (() => process.pid);
  let warnedWriteFailure = false;

  return {
    logFilePath,
    record(event, fields = {}) {
      const record = pruneUndefinedValues({
        timestamp: now().toISOString(),
        event,
        processId: getProcessId(),
        ...sanitizedLifecycleFields(fields),
      });
      const line = `${JSON.stringify(record)}\n`;
      try {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        rotateLifecycleLog(logFilePath, Buffer.byteLength(line), maxBytes, maxFiles);
        fs.appendFileSync(logFilePath, line, 'utf8');
      } catch (error) {
        if (warnedWriteFailure) return;
        warnedWriteFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[main] Renderer lifecycle log write failed:', redactLifecycleLogText(message));
      }
    },
  };
}

function rendererFields(window: BrowserWindow): RendererLifecycleLogFields {
  const webContents = window.webContents;
  return {
    windowId: window.id,
    webContentsId: webContents.id,
    url: webContents.isDestroyed() ? undefined : webContents.getURL(),
  };
}

export function registerRendererLifecycleLogging(
  window: BrowserWindow,
  logger: RendererLifecycleLogger,
): void {
  const webContents = window.webContents;
  webContents.on('did-start-navigation', (event) => {
    logger.record('did-start-navigation', {
      ...rendererFields(window),
      url: event.url,
      isSameDocument: event.isSameDocument,
      isMainFrame: event.isMainFrame,
    });
  });
  webContents.on('did-finish-load', () => {
    logger.record('did-finish-load', {
      ...rendererFields(window),
      isMainFrame: true,
    });
  });
  webContents.on('did-fail-load', (
    _event,
    errorCode,
    errorDescription,
    validatedURL,
    isMainFrame,
    frameProcessId,
    frameRoutingId,
  ) => {
    logger.record('did-fail-load', {
      ...rendererFields(window),
      url: validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
      errorCode,
      errorDescription,
    });
  });
  webContents.on('render-process-gone', (_event, details) => {
    logger.record('render-process-gone', {
      ...rendererFields(window),
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.on('unresponsive', () => {
    logger.record('unresponsive', rendererFields(window));
  });
  window.on('responsive', () => {
    logger.record('responsive', rendererFields(window));
  });
}

export function recordChildProcessGone(
  logger: RendererLifecycleLogger,
  details: { type: string; reason: string; exitCode: number; serviceName?: string; name?: string },
): void {
  logger.record('child-process-gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
    name: details.name,
  });
}
