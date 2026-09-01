import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
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
if (storageRoot) {
  const resolvedRoot = path.resolve(storageRoot);
  const userDataRoot = path.join(resolvedRoot, 'user-data');
  fs.mkdirSync(userDataRoot, { recursive: true });
  app.setPath('home', resolvedRoot);
  app.setPath('userData', userDataRoot);
}

let mainWindow: BrowserWindow | null = null;
const devServerUrl = process.env.SYNAPSE_DEV_SERVER_URL || 'http://localhost:5173';
const rendererLoadRetryDelaysMs = [0, 750, 2000, 4000, 7000];
type PendingWindowAction = 'close' | 'reload' | 'reloadIgnoringCache';
let pendingWindowAction: PendingWindowAction | null = null;
let pendingUnloadRequestId: string | null = null;
let allowNextUnload = false;
let unloadRequestSequence = 0;
let hasUnsavedChanges = false;

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

function requestWindowActionConfirmation(action: PendingWindowAction) {
  if (!mainWindow || pendingUnloadRequestId) return;
  pendingWindowAction = action;
  pendingUnloadRequestId = `window-unload-${Date.now()}-${++unloadRequestSequence}`;
  mainWindow.webContents.send('window:confirm-unload', {
    requestId: pendingUnloadRequestId,
    action,
  });
}

function performWindowAction(action: PendingWindowAction, confirmed = false) {
  if (!mainWindow) return;
  if (hasUnsavedChanges && !confirmed) {
    requestWindowActionConfirmation(action);
    return;
  }
  pendingWindowAction = action;
  allowNextUnload = confirmed;
  if (action === 'close') mainWindow.close();
  else if (action === 'reloadIgnoringCache') mainWindow.webContents.reloadIgnoringCache();
  else mainWindow.webContents.reload();
}

async function loadWindowRenderer(window: BrowserWindow): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < rendererLoadRetryDelaysMs.length; attempt++) {
    const delayMs = rendererLoadRetryDelaysMs[attempt];
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (window.isDestroyed()) return;
    try {
      if (!app.isPackaged) {
        await window.loadURL(devServerUrl);
      } else {
        await window.loadFile(path.join(__dirname, '../../dist/index.html'));
      }
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `[main] Renderer load failed (${attempt + 1}/${rendererLoadRetryDelaysMs.length}):`,
        error,
      );
    }
  }
  if (!window.isDestroyed()) {
    console.error('[main] Renderer failed to load after retries; window remains available for diagnostics.', lastError);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Synapse',
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0f',
    show: !startHidden,
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'public', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // P1-1: 后续评估改为 true
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererNavigation(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      void openExternalSafely(url).catch(error => {
        console.warn('[main] Blocked renderer navigation could not be opened externally:', error);
      });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[main] Blocked renderer popup:', url);
    return { action: 'deny' };
  });

  // 首次启动时 Chromium network service 可能恰好重启；有限重试避免进程仍活着、窗口却永久停在 about:blank。
  // 正式版同样走这一入口，文件加载失败会留明确信息而不是产生未处理 Promise rejection。
  void loadWindowRenderer(mainWindow);

  // ★ FIX-12/FIX-12b：恢复刷新快捷键。app.whenReady 里 Menu.setApplicationMenu(null) 移除了默认菜单，
  //   连带 Ctrl+R / F5 / Ctrl+Shift+R 这些默认 reload accelerator 一并失效——开发时改了前端代码
  //   无法自助刷新（此前只能整进程重启 electron）。这里监听键盘输入补回，不恢复菜单 UI。
  //   ★ 仅开发模式启用（!isPackaged）：正式版给终端用户绑「整页 reload」是脚枪——F5 是肌肉记忆，
  //   误触即无提示重载、丢失未保存编辑/打断进行中的 agent run/清空非持久运行态，开发便利不应以
  //   正式用户的数据安全为代价。
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      const ctrlOrCmd = input.control || input.meta;
      const isReload = key === 'f5' || (ctrlOrCmd && key === 'r');
      if (!isReload) return;
      // 强刷（忽略缓存）只在 Ctrl+Shift+R 或 Ctrl+F5 触发；单 F5 / Shift+F5 / Ctrl+R 走普通刷新。
      //   （旧写法 input.shift 单独成立会把无 Ctrl 的 Shift+F5 也误判成强刷，这里收紧为与 Ctrl/Cmd 绑定。）
      const forceReload = (ctrlOrCmd && input.shift && key === 'r') || (ctrlOrCmd && key === 'f5');
      performWindowAction(forceReload ? 'reloadIgnoringCache' : 'reload');
    });
  }

  mainWindow.on('close', event => {
    if (hasUnsavedChanges && !allowNextUnload) {
      event.preventDefault();
      requestWindowActionConfirmation('close');
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
    if (!pendingUnloadRequestId) pendingWindowAction = null;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    pendingWindowAction = null;
    pendingUnloadRequestId = null;
    allowNextUnload = false;
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
ipcMain.on('window:set-dirty', (_event, dirty: boolean) => {
  hasUnsavedChanges = dirty === true;
});
ipcMain.on('window:confirm-unload', (_event, requestId: string) => {
  if (!pendingUnloadRequestId || requestId !== pendingUnloadRequestId || !pendingWindowAction) return;
  const action = pendingWindowAction;
  pendingUnloadRequestId = null;
  performWindowAction(action, true);
});
ipcMain.on('window:cancel-unload', (_event, requestId: string) => {
  if (requestId !== pendingUnloadRequestId) return;
  pendingUnloadRequestId = null;
  pendingWindowAction = null;
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
    console.log('[main] All IPC handlers registered');
  } catch (err) {
    console.error('[main] IPC init failed:', err);
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
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  void (async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
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
      shutdownProviderRuntime();
      closeDatabase();
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
