const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const mainSource = source('electron/main.ts');
const preloadSource = source('electron/preload.ts');
const platformSource = source('src/platform/index.ts');
const settingsPanelSource = source('src/components/settings/SettingsPanel.tsx');
const errorBoundarySource = source('src/components/ErrorBoundary.tsx');
const titleBarSource = source('src/components/layout/WindowTitleBar.tsx');
const layoutSource = source('src/styles/layout.css');
const packageJson = JSON.parse(source('package.json'));
const dailyLauncherPath = path.resolve(root, '..', '..', 'Synapse', '启动Synapse.bat');
const dailyLauncherSource = fs.readFileSync(dailyLauncherPath, 'utf8');
const runtimeLauncherPath = path.resolve(root, '..', '启动Synapse.bat');
const runtimeLauncherSource = fs.readFileSync(runtimeLauncherPath, 'utf8');

assert.match(packageJson.scripts['electron:daily'], /vite preview --host 127\.0\.0\.1 --port 5173 --strictPort/);
assert.match(packageJson.scripts['electron:daily'], /electron \. --remote-debugging-port=9333/);
assert.match(packageJson.scripts['electron:daily'], /^npm run build && npm run electron:build &&/);
assert.match(dailyLauncherSource, /call npm run electron:daily/g);
assert.doesNotMatch(dailyLauncherSource, /if "%choice%"=="[12]" \([\s\S]{0,160}call npm run electron:dev/);
assert.match(runtimeLauncherSource, /call npm run electron:daily/g);
assert.doesNotMatch(runtimeLauncherSource, /if "%choice%"=="[12]" \([\s\S]{0,160}call npm run electron:dev/);
for (const launcherSource of [dailyLauncherSource, runtimeLauncherSource]) {
  assert.match(launcherSource, /set "SYNAPSE_DEV_SERVER_URL=http:\/\/127\.0\.0\.1:5173"/g);
}

assert.match(mainSource, /titleBarStyle:\s*'hidden'/);
assert.match(mainSource, /titleBarOverlay:\s*false/);
assert.doesNotMatch(mainSource, /frame:\s*false/);
assert.match(mainSource, /show:\s*false/);
assert.doesNotMatch(mainSource, /show:\s*!startHidden/);
assert.match(mainSource, /let revealRendererWhenReady = !startHidden/);
assert.match(mainSource, /verifyDesktopBridge/);
assert.match(mainSource, /DESKTOP_BRIDGE_PROTOCOL_VERSION/);
assert.doesNotMatch(mainSource, /verifyDesktopBridge[\s\S]{0,1200}reloadIgnoringCache/);
assert.match(mainSource, /showStartupErrorPage/);
assert.match(mainSource, /synapse:\/\/startup\/retry/);
assert.match(mainSource, /synapse:\/\/startup\/quit/);
assert.match(mainSource, /rendererLoadRetryDelaysMs = \[0, 750, 2000, 4000, 7000\]/);
assert.match(mainSource, /rendererRecoveryStableWindowMs = 120_000/);
assert.match(mainSource, /rendererRecoveryResetTimer = setTimeout\(\(\) => \{[\s\S]{0,420}rendererRecoveryAttempt = 0/);
assert.doesNotMatch(mainSource, /webContents\.on\('did-finish-load'[\s\S]{0,180}rendererRecoveryAttempt = 0/);
assert.match(mainSource, /readWindowState/);
assert.match(mainSource, /getNormalBounds/);
assert.match(mainSource, /ipcMain\.on\('window:reload',\s*\(\)\s*=>\s*performWindowAction\('reload', false, 'window-ipc'\)\)/);
assert.match(preloadSource, /reload:\s*\(\)\s*=>\s*ipcRenderer\.send\('window:reload'\)/);
assert.match(platformSource, /reload:\s*\(\)\s*=>\s*void/);
assert.match(platformSource, /reload:\s*\(\)\s*=>\s*window\.location\.reload\(\)/);
assert.match(platformSource, /export function requestWindowReload\(\): void[\s\S]*window\.synapse\.window\.reload\(\);[\s\S]*desktopBridgeState === 'web'[\s\S]*window\.location\.reload\(\);[\s\S]*Refused unsafe renderer reload/);
assert.doesNotMatch(settingsPanelSource, /window\.location\.reload/);
assert.doesNotMatch(errorBoundarySource, /window\.location\.reload/);
assert.match(settingsPanelSource, /requestWindowReload/);
assert.match(errorBoundarySource, /requestWindowReload/);
assert.match(titleBarSource, /desktopBridgeState/);
assert.match(titleBarSource, /桌面组件版本不一致/);
assert.match(titleBarSource, /window-control-btn/);
assert.match(titleBarSource, /platform\.window\.minimize\(\)/);
assert.match(titleBarSource, /platform\.window\.maximize\(\)/);
assert.match(titleBarSource, /platform\.window\.close\(\)/);
assert.match(titleBarSource, /aria-label="最小化窗口"/);
assert.match(titleBarSource, /aria-label=\{maximized \? '还原窗口' : '最大化窗口'\}/);
assert.match(titleBarSource, /aria-label="关闭窗口"/);
assert.match(layoutSource, /\.window-titlebar-controls/);
assert.match(layoutSource, /\.window-control-close:hover/);

const browserWindowIndex = mainSource.indexOf('new BrowserWindow');
const showFalseIndex = mainSource.indexOf('show: false', browserWindowIndex);
assert.ok(browserWindowIndex >= 0 && showFalseIndex > browserWindowIndex, 'BrowserWindow must start hidden by default');
const didFinishIndex = mainSource.indexOf("webContents.on('did-finish-load'");
const bridgeProbeIndex = mainSource.indexOf('await verifyDesktopBridge(targetWindow)', didFinishIndex);
const revealIndex = mainSource.indexOf("revealMainWindowIfReady('renderer-ready')", bridgeProbeIndex);
assert.ok(didFinishIndex >= 0 && bridgeProbeIndex > didFinishIndex && revealIndex > bridgeProbeIndex, 'window reveal must wait for renderer finish and bridge verification');
const bridgeFailureIndex = mainSource.indexOf("title: 'Synapse 桌面桥接失败'", bridgeProbeIndex);
assert.ok(bridgeFailureIndex > bridgeProbeIndex && bridgeFailureIndex < revealIndex, 'bridge failure must show local error page instead of revealing app chrome');
const loadFailureIndex = mainSource.indexOf("title: 'Synapse 界面加载失败'");
assert.ok(loadFailureIndex > mainSource.indexOf('async function loadWindowRenderer'), 'renderer load retry exhaustion must show local error page');
assert.match(mainSource, /const operationGeneration = \+\+rendererLoadGeneration/);
assert.match(mainSource, /rendererLoadGeneration !== operationGeneration\) return/);
assert.match(mainSource, /runtimeInitializationFailure = \{[\s\S]*Synapse 核心服务启动失败/);
assert.match(mainSource, /if \(runtimeInitializationFailure\) \{[\s\S]*showStartupErrorPage\(mainWindow, runtimeInitializationFailure\)/);
assert.match(mainSource, /if \(runtimeInitializationFailure\) \{[\s\S]*app\.relaunch\(\);[\s\S]*app\.exit\(0\)/);

const dirtyGuardIndex = mainSource.indexOf('if (hasUnsavedChanges && mainWindow');
const cleanupIndex = mainSource.indexOf('shutdownSensitiveOperationApprovals()', dirtyGuardIndex);
assert.ok(dirtyGuardIndex >= 0 && cleanupIndex > dirtyGuardIndex, 'dirty close guard must run before shutdown cleanup');

function simulateReloadFlow({ dirty, confirmed }) {
  const events = [];
  let hasUnsavedChanges = dirty;
  let pendingAction = null;
  let pendingRequestId = null;
  let reloadCount = 0;
  function requestConfirmation(action) {
    pendingAction = action;
    pendingRequestId = 'window-unload-test';
    events.push({ type: 'confirm-requested', action, requestId: pendingRequestId });
  }
  function performWindowAction(action, alreadyConfirmed = false) {
    if (hasUnsavedChanges && !alreadyConfirmed) {
      requestConfirmation(action);
      return;
    }
    pendingAction = action;
    reloadCount += action === 'reload' ? 1 : 0;
    events.push({ type: 'performed', action });
  }
  performWindowAction('reload');
  if (pendingRequestId && confirmed === true) {
    const action = pendingAction;
    pendingRequestId = null;
    performWindowAction(action, true);
  } else if (pendingRequestId && confirmed === false) {
    pendingRequestId = null;
    pendingAction = null;
    events.push({ type: 'cancelled' });
  }
  return { events, reloadCount, pendingAction, pendingRequestId };
}

assert.equal(simulateReloadFlow({ dirty: false }).reloadCount, 1, 'clean reload should run immediately');
assert.equal(simulateReloadFlow({ dirty: true, confirmed: false }).reloadCount, 0, 'dirty reload cancellation must not reload');
assert.equal(simulateReloadFlow({ dirty: true, confirmed: true }).reloadCount, 1, 'dirty reload confirmation should reload once');

const { normalizeWindowState, readWindowState, writeWindowState } = require('../dist-electron/electron/windowState.js');
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: 0, width: 2560, height: 1400 };

assert.deepEqual(
  normalizeWindowState({ bounds: { x: 2200, y: 100, width: 1500, height: 1000 }, maximized: true }, [primary, secondary], primary),
  { bounds: { x: 2200, y: 100, width: 1500, height: 1000 }, maximized: true, fullscreen: false },
);
assert.deepEqual(
  normalizeWindowState({ bounds: { x: 9000, y: 9000, width: 1400, height: 900 }, maximized: false }, [primary]),
  { bounds: { x: 520, y: 140, width: 1400, height: 900 }, maximized: false, fullscreen: false },
);
assert.deepEqual(
  normalizeWindowState({ bounds: { x: -50, y: -30, width: 300, height: 200 } }, [primary]),
  { bounds: { x: 0, y: 0, width: 900, height: 600 }, maximized: false, fullscreen: false },
);

assert.deepEqual(
  normalizeWindowState({ bounds: { x: 40, y: 30, width: 700, height: 450 }, fullscreen: true }, [secondary, primary], primary),
  { bounds: { x: 40, y: 30, width: 900, height: 600 }, maximized: false, fullscreen: true },
);
assert.deepEqual(
  normalizeWindowState({ version: 999, bounds: { x: 9000, y: 9000, width: 1, height: 1 } }, [secondary, primary], primary),
  { bounds: { x: 260, y: 70, width: 1400, height: 900 }, maximized: false, fullscreen: false },
);
const tiny = { x: 0, y: 0, width: 800, height: 500 };
assert.deepEqual(
  normalizeWindowState(null, [tiny], tiny),
  { bounds: tiny, maximized: false, fullscreen: false },
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-window-state-'));
const statePath = path.join(tempRoot, 'window-state.json');
const roundTripState = { bounds: { x: 25, y: 35, width: 1200, height: 760 }, maximized: false, fullscreen: true };
try {
  writeWindowState(statePath, roundTripState);
  assert.deepEqual(readWindowState(statePath, [primary], primary), roundTripState);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).version, 2);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('Window shell integration: all assertions passed');
