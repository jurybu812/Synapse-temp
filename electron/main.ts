import { app, BrowserWindow, ipcMain, Menu, screen, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { initDatabase, closeDatabase } from './database';
import { registerConfigHandlers } from './ipc/config';
import { registerConversationHandlers } from './ipc/conversation';
import { registerMemoryHandlers } from './ipc/memory';
import { registerWorkspaceHandlers } from './ipc/workspace';
import { registerFileHandlers, shutdownSensitiveOperationApprovals } from './ipc/file';
import { registerCommandHandlers, shutdownCommandTasks } from './ipc/command';
import { registerToolTaskHandlers, shutdownToolTasks } from './ipc/toolTask';
import { registerWorktreeHandlers } from './ipc/worktree';
import { registerAttachmentHandlers } from './ipc/attachment';
import { registerMCPHandlers, shutdownAllMCP, ensureDefaultMCPConfig, startEnabledMCPServers } from './ipc/mcp';
import { registerWallpaperHandlers, registerWallpaperProtocol } from './ipc/wallpaper';
// ★ M4-4-S3：import 触发顶层 registerSchemesAsPrivileged 副作用（必须在 app.whenReady 前），
//   registerFileProtocol 在 whenReady 内调用。根治图片/视频/PDF 本地资源加载黑屏。
import { registerFileProtocol } from './ipc/fileProtocol';
import { registerProviderHandlers, shutdownProviderRuntime } from './ipc/provider';
import { assertPublicHttpUrl } from './web/publicFetch';
import { readWindowState, writeWindowState } from './windowState';
import {
  createRendererLifecycleLogger,
  recordChildProcessGone,
  registerRendererLifecycleLogging,
  type RendererLifecycleLogFields,
  type RendererLifecycleLogger,
} from './lifecycleLog';
import { DESKTOP_BRIDGE_PROTOCOL_VERSION } from '../shared/desktopBridge';

function tolerateDetachedOutputStream(stream: NodeJS.WriteStream | null) {
  stream?.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') return;
  });
}

tolerateDetachedOutputStream(process.stdout);
tolerateDetachedOutputStream(process.stderr);

const storageRoot = process.env.SYNAPSE_STORAGE_ROOT?.trim();
const externalMcpDisabled = process.env.SYNAPSE_DISABLE_EXTERNAL_MCP === '1'
  || process.argv.includes('--disable-external-mcp');
const startHidden = process.env.SYNAPSE_START_HIDDEN === '1';
const QUIT_CLEANUP_TIMEOUT_MS = 8_000;
const resolvedStorageRoot = storageRoot ? path.resolve(storageRoot) : null;
if (resolvedStorageRoot) {
  const resolvedRoot = resolvedStorageRoot;
  const userDataRoot = path.join(resolvedRoot, 'user-data');
  fs.mkdirSync(userDataRoot, { recursive: true });
  app.setPath('home', resolvedRoot);
  app.setPath('userData', userDataRoot);
}

let mainWindow: BrowserWindow | null = null;
let rendererLifecycleLogger: RendererLifecycleLogger | null = null;
const devServerUrl = process.env.SYNAPSE_DEV_SERVER_URL || 'http://localhost:5173';
const rendererLoadRetryDelaysMs = [0, 750, 2000, 4000, 7000];
const rendererLoadAttemptTimeoutMs = 20_000;
const rendererRecoveryRetryDelaysMs = [750, 2000, 4000];
const rendererRecoveryStableWindowMs = 120_000;
type PendingWindowAction = 'close' | 'reload' | 'reloadIgnoringCache';
type RendererStartupStatus = 'loading' | 'ready' | 'error';
type RendererReloadSource = 'keyboard-shortcut' | 'window-ipc';
type RendererLoadSource = 'startup' | 'startup-retry' | 'did-fail-load' | 'render-process-gone';
type RendererLoadContext = RendererLifecycleLogFields & {
  source: RendererLoadSource;
  loadGeneration?: number;
};
type RendererStartupFailure = {
  title: string;
  summary: string;
  details?: string;
};
let pendingWindowAction: PendingWindowAction | null = null;
let pendingWindowActionSource: RendererReloadSource | null = null;
let pendingUnloadRequestId: string | null = null;
let allowNextUnload = false;
let unloadRequestSequence = 0;
let hasUnsavedChanges = false;
let windowStateWriteTimer: NodeJS.Timeout | null = null;
let rendererRecoveryTimer: NodeJS.Timeout | null = null;
let rendererRecoveryResetTimer: NodeJS.Timeout | null = null;
let rendererRecoveryAttempt = 0;
let rendererLoadInProgress = false;
let rendererLoadGeneration = 0;
let rendererStartupStatus: RendererStartupStatus = 'loading';
let activeRendererLoadContext: RendererLoadContext | null = null;
let revealRendererWhenReady = !startHidden;
let runtimeInitialized = false;
let runtimeInitializationFailure: RendererStartupFailure | null = null;

const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.exit(0);
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  revealRendererWhenReady = true;
  if (rendererStartupStatus === 'ready' || rendererStartupStatus === 'error') {
    revealMainWindow('second-instance');
  }
});

function windowStateFilePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function persistWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  try {
    writeWindowState(windowStateFilePath(), {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
    });
  } catch (error) {
    console.warn('[main] Window state could not be persisted:', error);
  }
}

function scheduleWindowStateWrite(window: BrowserWindow): void {
  if (windowStateWriteTimer) clearTimeout(windowStateWriteTimer);
  windowStateWriteTimer = setTimeout(() => {
    windowStateWriteTimer = null;
    persistWindowState(window);
  }, 250);
}

function isReloadWindowAction(action: PendingWindowAction | null): boolean {
  return action === 'reload' || action === 'reloadIgnoringCache';
}

function recordRendererLifecycle(
  event: Parameters<RendererLifecycleLogger['record']>[0],
  fields: RendererLifecycleLogFields = {},
): void {
  rendererLifecycleLogger?.record(event, fields);
}

function isAutomaticRecoverySource(source: RendererLoadSource): boolean {
  return source === 'did-fail-load' || source === 'render-process-gone';
}

async function waitForRendererLoad(
  window: BrowserWindow,
  loadPromise: Promise<void>,
  operationGeneration: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      if (rendererLoadGeneration === operationGeneration && !window.isDestroyed()) {
        window.webContents.stop();
      }
      reject(new Error(`Renderer load timed out after ${rendererLoadAttemptTimeoutMs}ms`));
    }, rendererLoadAttemptTimeoutMs);
  });
  try {
    await Promise.race([loadPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function completePendingReloadAction(): void {
  if (!isReloadWindowAction(pendingWindowAction)) return;
  allowNextUnload = false;
  if (!pendingUnloadRequestId) {
    pendingWindowAction = null;
    pendingWindowActionSource = null;
  }
}

function clearRendererRecoveryTimer(): void {
  if (!rendererRecoveryTimer) return;
  clearTimeout(rendererRecoveryTimer);
  rendererRecoveryTimer = null;
}

function clearRendererRecoveryResetTimer(): void {
  if (!rendererRecoveryResetTimer) return;
  clearTimeout(rendererRecoveryResetTimer);
  rendererRecoveryResetTimer = null;
}

function revealMainWindow(reason: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) {
    console.log('[main] Revealing BrowserWindow.', { reason });
    mainWindow.show();
  }
  mainWindow.focus();
}

function revealMainWindowIfReady(reason: string): void {
  if (!revealRendererWhenReady) return;
  if (rendererStartupStatus !== 'ready' && rendererStartupStatus !== 'error') return;
  revealMainWindow(reason);
}

function rendererRecoveryDetails(context: RendererLoadContext): string {
  const fields = [
    `source=${context.source}`,
    context.triggerEvent ? `trigger=${context.triggerEvent}` : undefined,
    typeof context.errorCode === 'number' ? `errorCode=${context.errorCode}` : undefined,
    context.errorDescription ? `description=${context.errorDescription}` : undefined,
    context.reason ? `reason=${context.reason}` : undefined,
    typeof context.exitCode === 'number' ? `exitCode=${context.exitCode}` : undefined,
  ];
  return fields.filter(Boolean).join(' ');
}

function scheduleRendererRecovery(context: RendererLoadContext): void {
  if (!mainWindow || mainWindow.isDestroyed() || pendingWindowAction === 'close') return;
  clearRendererRecoveryResetTimer();
  if (rendererRecoveryTimer) return;
  if (rendererRecoveryAttempt >= rendererRecoveryRetryDelaysMs.length) {
    recordRendererLifecycle('renderer-recovery-failed', {
      ...context,
      status: 'exhausted',
      maxAttempts: rendererRecoveryRetryDelaysMs.length,
      loadGeneration: rendererLoadGeneration,
    });
    void showStartupErrorPage(mainWindow, {
      title: 'Synapse 界面恢复失败',
      summary: '主窗口进程仍在运行，但界面多次恢复都没有成功。',
      details: rendererRecoveryDetails(context),
    });
    return;
  }
  const delayMs = rendererRecoveryRetryDelaysMs[rendererRecoveryAttempt];
  const recoveryContext = {
    ...context,
    status: 'scheduled',
    attempt: rendererRecoveryAttempt + 1,
    maxAttempts: rendererRecoveryRetryDelaysMs.length,
    delayMs,
  };
  rendererRecoveryAttempt += 1;
  recordRendererLifecycle('renderer-recovery-scheduled', recoveryContext);
  console.warn('[main] Scheduling renderer recovery reload.', {
    source: context.source,
    triggerEvent: context.triggerEvent,
    delayMs,
    attempt: recoveryContext.attempt,
  });
  const targetWindow = mainWindow;
  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = null;
    if (targetWindow.isDestroyed() || mainWindow !== targetWindow) return;
    recordRendererLifecycle('renderer-recovery-started', {
      ...recoveryContext,
      status: 'loading',
    });
    void loadWindowRenderer(targetWindow, recoveryContext);
  }, delayMs);
}

async function verifyDesktopBridge(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed()) return false;
  let bridgeProtocolVersion: number | null = null;
  try {
    bridgeProtocolVersion = await window.webContents.executeJavaScript(
      'Number(window.synapse?.platform?.bridgeProtocolVersion) || null',
      true,
    ) as number | null;
  } catch (error) {
    console.warn('[main] Desktop bridge probe failed:', error);
  }
  if (bridgeProtocolVersion === DESKTOP_BRIDGE_PROTOCOL_VERSION) return true;
  console.error('[main] Desktop preload bridge protocol mismatch; restart Synapse to load one build generation.', {
    expected: DESKTOP_BRIDGE_PROTOCOL_VERSION,
    actual: bridgeProtocolVersion,
  });
  return false;
}

function isTrustedRendererNavigation(rawUrl: string): boolean {
  try {
    const target = new URL(rawUrl);
    if (!app.isPackaged) {
      return target.origin === new URL(devServerUrl).origin;
    }
    const rendererUrl = pathToFileURL(path.join(__dirname, '../../dist/index.html'));
    return target.protocol === 'file:' && target.pathname === rendererUrl.pathname;
  } catch {
    return false;
  }
}

async function openExternalSafely(rawUrl: string): Promise<boolean> {
  const url = new URL(String(rawUrl));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只允许打开不含凭据的 HTTP(S) 链接');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('open-external-dns-timeout')), 5_000);
  try {
    await assertPublicHttpUrl(url.toString(), controller.signal);
  } finally {
    clearTimeout(timer);
  }
  await shell.openExternal(url.toString());
  return true;
}

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error ?? 'unknown error');
}

function rendererTargetLabel(): string {
  return app.isPackaged ? path.join(__dirname, '../../dist/index.html') : devServerUrl;
}

function buildStartupErrorHtml(failure: RendererStartupFailure): string {
  const detailText = failure.details ? failure.details : '没有额外错误细节。';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; navigate-to synapse:" />
  <title>${htmlEscape(failure.title)}</title>
  <style>
    :root { color-scheme: dark; font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; background: #101018; color: #f2f4ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 20% 15%, rgba(118, 92, 255, .28), transparent 32%), #101018; }
    main { width: min(720px, calc(100vw - 48px)); padding: 38px; border: 1px solid rgba(255,255,255,.12); border-radius: 24px; background: rgba(18,18,28,.9); box-shadow: 0 30px 90px rgba(0,0,0,.45); }
    h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.2; }
    p { margin: 0 0 22px; color: #cdd2e8; line-height: 1.7; }
    pre { max-height: 180px; overflow: auto; margin: 0 0 26px; padding: 14px; border-radius: 14px; background: rgba(0,0,0,.32); color: #aeb7d9; white-space: pre-wrap; word-break: break-word; }
    nav { display: flex; gap: 12px; flex-wrap: wrap; }
    a { display: inline-flex; align-items: center; justify-content: center; min-width: 116px; height: 42px; border-radius: 999px; color: #fff; text-decoration: none; font-weight: 700; background: linear-gradient(135deg, #7068ff, #a45dff); }
    a.secondary { background: rgba(255,255,255,.1); color: #dfe3f8; border: 1px solid rgba(255,255,255,.16); }
    small { display: block; margin-top: 20px; color: #8d94b6; }
  </style>
</head>
<body>
  <main>
    <h1>${htmlEscape(failure.title)}</h1>
    <p>${htmlEscape(failure.summary)}</p>
    <pre>${htmlEscape(detailText)}</pre>
    <nav>
      <a href="synapse://startup/retry">重试启动</a>
      <a class="secondary" href="synapse://startup/quit">退出 Synapse</a>
    </nav>
    <small>目标：${htmlEscape(rendererTargetLabel())}</small>
  </main>
</body>
</html>`;
}

async function showStartupErrorPage(window: BrowserWindow, failure: RendererStartupFailure): Promise<void> {
  if (window.isDestroyed()) return;
  clearRendererRecoveryTimer();
  clearRendererRecoveryResetTimer();
  rendererLoadInProgress = false;
  rendererStartupStatus = 'error';
  rendererLoadGeneration += 1;
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildStartupErrorHtml(failure))}`);
  } catch (error) {
    console.error('[main] Startup error page failed to load:', error);
    revealMainWindowIfReady('startup-error-page-fallback');
  }
}

function retryRendererStartup(reason: string): void {
  recordRendererLifecycle('renderer-startup-retry', {
    source: 'startup-retry',
    triggerEvent: reason,
    status: runtimeInitializationFailure ? 'relaunch' : 'load-renderer',
  });
  if (runtimeInitializationFailure) {
    app.relaunch();
    app.exit(0);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  console.log('[main] Retrying renderer startup.', { reason });
  revealRendererWhenReady = true;
  rendererRecoveryAttempt = 0;
  clearRendererRecoveryTimer();
  clearRendererRecoveryResetTimer();
  void loadWindowRenderer(mainWindow, {
    source: 'startup-retry',
    triggerEvent: reason,
  });
}

function handleStartupControlNavigation(rawUrl: string): boolean {
  if (rendererStartupStatus !== 'error') return false;
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'synapse:' || target.hostname !== 'startup') return false;
  if (target.pathname === '/retry') {
    retryRendererStartup('startup-error-page');
    return true;
  }
  if (target.pathname === '/quit') {
    app.quit();
    return true;
  }
  return true;
}

function requestWindowActionConfirmation(action: PendingWindowAction, source: RendererReloadSource) {
  if (!mainWindow || pendingUnloadRequestId) return;
  pendingWindowAction = action;
  pendingWindowActionSource = isReloadWindowAction(action) ? source : null;
  pendingUnloadRequestId = `window-unload-${Date.now()}-${++unloadRequestSequence}`;
  mainWindow.webContents.send('window:confirm-unload', {
    requestId: pendingUnloadRequestId,
    action,
  });
}

function performWindowAction(
  action: PendingWindowAction,
  confirmed = false,
  source: RendererReloadSource = 'window-ipc',
) {
  if (!mainWindow) return;
  if (hasUnsavedChanges && !confirmed) {
    requestWindowActionConfirmation(action, source);
    return;
  }
  pendingWindowAction = action;
  pendingWindowActionSource = isReloadWindowAction(action) ? source : null;
  allowNextUnload = confirmed;
  if (action === 'close') {
    mainWindow.close();
    return;
  }
  recordRendererLifecycle('renderer-reload-requested', {
    source,
    action,
    status: confirmed ? 'confirmed' : 'requested',
    loadGeneration: rendererLoadGeneration,
  });
  if (action === 'reloadIgnoringCache') mainWindow.webContents.reloadIgnoringCache();
  else mainWindow.webContents.reload();
}

async function loadWindowRenderer(
  window: BrowserWindow,
  context: RendererLoadContext = { source: 'startup' },
): Promise<void> {
  let lastError: unknown;
  const operationGeneration = ++rendererLoadGeneration;
  const loadContext = { ...context, loadGeneration: operationGeneration };
  activeRendererLoadContext = loadContext;
  rendererLoadInProgress = true;
  rendererStartupStatus = 'loading';
  try {
    for (let attempt = 0; attempt < rendererLoadRetryDelaysMs.length; attempt++) {
      const delayMs = rendererLoadRetryDelaysMs[attempt];
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (window.isDestroyed() || rendererLoadGeneration !== operationGeneration) return;
      try {
        recordRendererLifecycle('renderer-load-attempt', {
          ...loadContext,
          action: app.isPackaged ? 'loadFile' : 'loadURL',
          status: 'attempting',
          attempt: attempt + 1,
          maxAttempts: rendererLoadRetryDelaysMs.length,
          url: app.isPackaged ? pathToFileURL(path.join(__dirname, '../../dist/index.html')).toString() : devServerUrl,
        });
        if (!app.isPackaged) {
          await waitForRendererLoad(window, window.loadURL(devServerUrl), operationGeneration);
        } else {
          await waitForRendererLoad(
            window,
            window.loadFile(path.join(__dirname, '../../dist/index.html')),
            operationGeneration,
          );
        }
        if (rendererLoadGeneration !== operationGeneration) return;
        return;
      } catch (error) {
        if (rendererLoadGeneration !== operationGeneration) return;
        lastError = error;
        recordRendererLifecycle('renderer-load-failed', {
          ...loadContext,
          status: 'failed',
          attempt: attempt + 1,
          maxAttempts: rendererLoadRetryDelaysMs.length,
          reason: errorToMessage(error),
        });
        console.error(
          `[main] Renderer load failed (${attempt + 1}/${rendererLoadRetryDelaysMs.length}):`,
          error,
        );
      }
    }
  } finally {
    if (rendererLoadGeneration === operationGeneration) rendererLoadInProgress = false;
  }
  if (!window.isDestroyed() && rendererLoadGeneration === operationGeneration) {
    recordRendererLifecycle(isAutomaticRecoverySource(loadContext.source) ? 'renderer-recovery-failed' : 'renderer-startup-failed', {
      ...loadContext,
      status: 'load-failed',
      reason: errorToMessage(lastError),
    });
    activeRendererLoadContext = null;
    await showStartupErrorPage(window, {
      title: 'Synapse 界面加载失败',
      summary: '已经自动重试多次，但前端界面仍然没有加载成功。',
      details: errorToMessage(lastError),
    });
  }
}

function createWindow() {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const workAreas = screen.getAllDisplays().map(display => display.workArea);
  const restoredWindowState = readWindowState(
    windowStateFilePath(),
    workAreas,
    primaryWorkArea,
  );
  mainWindow = new BrowserWindow({
    ...restoredWindowState.bounds,
    minWidth: Math.min(900, restoredWindowState.bounds.width, primaryWorkArea.width),
    minHeight: Math.min(600, restoredWindowState.bounds.height, primaryWorkArea.height),
    title: 'Synapse',
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0f',
    show: false,
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'public', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // P1-1: 后续评估改为 true
    },
  });

  mainWindow.setMenuBarVisibility(false);
  if (restoredWindowState.fullscreen) mainWindow.setFullScreen(true);
  else if (restoredWindowState.maximized) mainWindow.maximize();
  mainWindow.on('move', () => scheduleWindowStateWrite(mainWindow!));
  mainWindow.on('resize', () => scheduleWindowStateWrite(mainWindow!));
  mainWindow.on('maximize', () => scheduleWindowStateWrite(mainWindow!));
  mainWindow.on('unmaximize', () => scheduleWindowStateWrite(mainWindow!));
  mainWindow.on('enter-full-screen', () => scheduleWindowStateWrite(mainWindow!));
  mainWindow.on('leave-full-screen', () => scheduleWindowStateWrite(mainWindow!));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (handleStartupControlNavigation(url)) {
      event.preventDefault();
      return;
    }
    if (isTrustedRendererNavigation(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      void openExternalSafely(url).catch(error => {
        console.warn('[main] Blocked renderer navigation could not be opened externally:', error);
      });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (handleStartupControlNavigation(url)) return { action: 'deny' };
    console.warn('[main] Blocked renderer popup:', url);
    return { action: 'deny' };
  });
  if (rendererLifecycleLogger) {
    registerRendererLifecycleLogging(mainWindow, rendererLifecycleLogger);
  }
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    completePendingReloadAction();
    if (errorCode === -3) return;
    if (rendererLoadInProgress || rendererStartupStatus === 'error') return;
    scheduleRendererRecovery({
      source: 'did-fail-load',
      triggerEvent: 'did-fail-load',
      url: validatedURL,
      errorCode,
      errorDescription,
      reason: `did-fail-load:${errorCode}`,
    });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    completePendingReloadAction();
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    scheduleRendererRecovery({
      source: 'render-process-gone',
      triggerEvent: 'render-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // 首次启动时 Chromium network service 可能恰好重启；有限重试避免进程仍活着、窗口却永久停在 about:blank。
  // 正式版同样走这一入口，文件加载失败会留明确信息而不是产生未处理 Promise rejection。
  if (runtimeInitializationFailure) {
    void showStartupErrorPage(mainWindow, runtimeInitializationFailure);
  } else {
    void loadWindowRenderer(mainWindow, { source: 'startup' });
  }

  // ★ FIX-12/FIX-12b：恢复刷新快捷键。app.whenReady 里 Menu.setApplicationMenu(null) 移除了默认菜单，
  //   连带 Ctrl+R / F5 / Ctrl+Shift+R 这些默认 reload accelerator 一并失效——开发时改了前端代码
  //   无法自助刷新（此前只能整进程重启 electron）。这里监听键盘输入补回，不恢复菜单 UI。
  //   ★ 仅开发模式启用（!isPackaged）：正式版给终端用户绑「整页 reload」是脚枪——F5 是肌肉记忆，
  //   误触即无提示重载、丢失未保存编辑/打断进行中的 agent run/清空非持久运行态，开发便利不应以
  //   正式用户的数据安全为代价。
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      const key = (input.key || '').toLowerCase();
      const ctrlOrCmd = input.control || input.meta;
      const isReload = key === 'f5' || (ctrlOrCmd && key === 'r');
      if (!isReload) return;
      // 强刷（忽略缓存）只在 Ctrl+Shift+R 或 Ctrl+F5 触发；单 F5 / Shift+F5 / Ctrl+R 走普通刷新。
      //   （旧写法 input.shift 单独成立会把无 Ctrl 的 Shift+F5 也误判成强刷，这里收紧为与 Ctrl/Cmd 绑定。）
      const forceReload = (ctrlOrCmd && input.shift && key === 'r') || (ctrlOrCmd && key === 'f5');
      event.preventDefault();
      performWindowAction(forceReload ? 'reloadIgnoringCache' : 'reload', false, 'keyboard-shortcut');
    });
  }

  mainWindow.on('close', event => {
    persistWindowState(mainWindow!);
    if (hasUnsavedChanges && !allowNextUnload) {
      event.preventDefault();
      requestWindowActionConfirmation('close', 'window-ipc');
      return;
    }
    allowNextUnload = false;
    pendingWindowAction ??= 'close';
  });

  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (allowNextUnload) {
      allowNextUnload = false;
      pendingWindowAction = null;
      pendingUnloadRequestId = null;
      event.preventDefault();
      return;
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const targetWindow = mainWindow;
    const finishedGeneration = rendererLoadGeneration;
    if (!targetWindow) return;
    clearRendererRecoveryTimer();
    clearRendererRecoveryResetTimer();
    rendererRecoveryResetTimer = setTimeout(() => {
      rendererRecoveryResetTimer = null;
      if (
        targetWindow.isDestroyed()
        || mainWindow !== targetWindow
        || finishedGeneration !== rendererLoadGeneration
        || rendererStartupStatus !== 'ready'
      ) return;
      rendererRecoveryAttempt = 0;
    }, rendererRecoveryStableWindowMs);
    completePendingReloadAction();
    if (!pendingUnloadRequestId) pendingWindowAction = null;
    if (rendererStartupStatus === 'error') {
      revealMainWindowIfReady('startup-error-page');
      return;
    }
    void (async () => {
      const bridgeReady = await verifyDesktopBridge(targetWindow);
      if (targetWindow.isDestroyed() || mainWindow !== targetWindow || finishedGeneration !== rendererLoadGeneration) return;
      if (!bridgeReady) {
        const loadContext = activeRendererLoadContext?.loadGeneration === finishedGeneration
          ? activeRendererLoadContext
          : null;
        recordRendererLifecycle(loadContext && isAutomaticRecoverySource(loadContext.source) ? 'renderer-recovery-failed' : 'renderer-startup-failed', {
          ...(loadContext ?? { source: 'startup', loadGeneration: finishedGeneration }),
          status: 'bridge-mismatch',
          reason: 'desktop-bridge-protocol-mismatch',
        });
        if (loadContext) activeRendererLoadContext = null;
        await showStartupErrorPage(targetWindow, {
          title: 'Synapse 桌面桥接失败',
          summary: '界面文件已加载，但桌面 preload bridge 没有通过版本校验。',
          details: `expected=${DESKTOP_BRIDGE_PROTOCOL_VERSION}`,
        });
        return;
      }
      rendererStartupStatus = 'ready';
      const loadContext = activeRendererLoadContext?.loadGeneration === finishedGeneration
        ? activeRendererLoadContext
        : null;
      if (loadContext) {
        if (loadContext.source !== 'startup') {
          recordRendererLifecycle('renderer-recovery-succeeded', {
            ...loadContext,
            status: 'ready',
          });
          targetWindow.webContents.send('window:recovery-status', {
            status: 'recovered',
            source: loadContext.source,
            triggerEvent: loadContext.triggerEvent,
            loadGeneration: finishedGeneration,
          });
        }
        activeRendererLoadContext = null;
      }
      revealMainWindowIfReady('renderer-ready');
    })();
  });

  mainWindow.on('closed', () => {
    if (windowStateWriteTimer) clearTimeout(windowStateWriteTimer);
    windowStateWriteTimer = null;
    clearRendererRecoveryTimer();
    clearRendererRecoveryResetTimer();
    mainWindow = null;
    pendingWindowAction = null;
    pendingWindowActionSource = null;
    pendingUnloadRequestId = null;
    allowNextUnload = false;
    rendererStartupStatus = 'loading';
    rendererLoadInProgress = false;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---- IPC Handlers ----

// 窗口操作
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => performWindowAction('close'));
ipcMain.on('window:reload', () => performWindowAction('reload', false, 'window-ipc'));
ipcMain.on('window:set-dirty', (_event, dirty: boolean) => {
  hasUnsavedChanges = dirty === true;
});
ipcMain.on('window:confirm-unload', (_event, requestId: string) => {
  if (!pendingUnloadRequestId || requestId !== pendingUnloadRequestId || !pendingWindowAction) return;
  const action = pendingWindowAction;
  const source = pendingWindowActionSource ?? 'window-ipc';
  pendingUnloadRequestId = null;
  performWindowAction(action, true, source);
});
ipcMain.on('window:cancel-unload', (_event, requestId: string) => {
  if (requestId !== pendingUnloadRequestId) return;
  pendingUnloadRequestId = null;
  pendingWindowAction = null;
  pendingWindowActionSource = null;
});
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

// 平台信息
ipcMain.handle('platform:info', () => ({
  isElectron: true,
  platform: process.platform,
  version: app.getVersion(),
  userDataPath: app.getPath('userData'),
  appPath: app.getAppPath(),
  locale: app.getLocale(),
  bridgeProtocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
}));
ipcMain.handle('platform:openExternal', async (_event, rawUrl: string) => {
  return openExternalSafely(rawUrl);
});

// ---- Stage 3: 数据库 + IPC Handler 集成 ----

// 数据库初始化 + IPC 注册
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerWallpaperProtocol();
  registerFileProtocol();
  rendererLifecycleLogger = createRendererLifecycleLogger({
    storageRoot: resolvedStorageRoot,
    fallbackRoot: app.getPath('userData'),
  });
  app.on('child-process-gone', (_event, details) => {
    if (rendererLifecycleLogger) recordChildProcessGone(rendererLifecycleLogger, details);
  });
  try {
    initDatabase();
    registerConfigHandlers();
    registerProviderHandlers();
    registerConversationHandlers();
    registerMemoryHandlers();
    registerWorkspaceHandlers();
    registerFileHandlers();
    registerWallpaperHandlers();
    registerCommandHandlers();
    registerToolTaskHandlers();
    registerWorktreeHandlers();
    registerAttachmentHandlers();
    registerMCPHandlers({ disabled: externalMcpDisabled });
    if (!externalMcpDisabled) {
      // ★ M4-7-S2：注册 MCP handlers 后确保默认 mcp_config.json 存在（文件不存在才写，存在绝不覆盖）。
      ensureDefaultMCPConfig();
      // ★ FIX-5：fire-and-forget 自动拉起 enabled 的 MCP server（不阻塞创窗）。
      void startEnabledMCPServers();
    } else {
      console.log('[main] External MCP auto-start disabled for isolated runtime');
    }
    runtimeInitialized = true;
    console.log('[main] All IPC handlers registered');
  } catch (err) {
    console.error('[main] IPC init failed:', err);
    runtimeInitializationFailure = {
      title: 'Synapse 核心服务启动失败',
      summary: '数据库或桌面服务没有完成初始化，为避免进入不完整界面，Synapse 已停止继续加载。',
      details: errorToMessage(err),
    };
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitCleanupStarted = false;
let quitCleanupFinished = false;
app.on('before-quit', (event) => {
  if (quitCleanupFinished) return;
  if (hasUnsavedChanges && mainWindow && !mainWindow.isDestroyed() && !allowNextUnload) {
    event.preventDefault();
    requestWindowActionConfirmation('close', 'window-ipc');
    return;
  }
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  void (async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!runtimeInitialized) return;
      shutdownSensitiveOperationApprovals();
      await Promise.race([
        Promise.allSettled([shutdownToolTasks(), shutdownCommandTasks(), shutdownAllMCP()]),
        new Promise<void>(resolve => {
          deadline = setTimeout(() => {
            console.warn(`[main] Quit cleanup exceeded ${QUIT_CLEANUP_TIMEOUT_MS}ms; forcing final shutdown`);
            resolve();
          }, QUIT_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (runtimeInitialized) {
        shutdownProviderRuntime();
        closeDatabase();
      }
      quitCleanupFinished = true;
      app.quit();
    }
  })();
});

// ---- 仍未实现的 IPC Stub ----
const notImplemented = (channel: string) => {
  return () => ({ error: true, message: `[${channel}] 尚未实现，将在后续 Stage 中完成` });
};

// 终端 stub (Stage 13)
ipcMain.handle('terminal:create', notImplemented('terminal:create'));
ipcMain.handle('terminal:write', notImplemented('terminal:write'));
ipcMain.handle('terminal:resize', notImplemented('terminal:resize'));
ipcMain.handle('terminal:kill', notImplemented('terminal:kill'));
