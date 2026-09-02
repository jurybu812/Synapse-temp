const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(root, 'electron/lifecycleLog.ts'), 'utf8');
const {
  createRendererLifecycleLogger,
  recordChildProcessGone,
  registerRendererLifecycleLogging,
  sanitizeLifecycleLogUrl,
} = require(path.join(root, 'dist-electron/electron/lifecycleLog.js'));

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function makeEmitter(properties = {}) {
  const handlers = new Map();
  return {
    ...properties,
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(listener);
      return this;
    },
    emit(event, ...args) {
      for (const listener of handlers.get(event) || []) listener(...args);
    },
  };
}

assert.equal(
  sanitizeLifecycleLogUrl('https://user:pass@example.test/app?token=abc#frag'),
  'https://example.test/app',
);
assert.equal(sanitizeLifecycleLogUrl('data:text/plain,secret-token'), 'data:[redacted]');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-lifecycle-log-'));
try {
  const logger = createRendererLifecycleLogger({
    storageRoot: tempRoot,
    fallbackRoot: path.join(tempRoot, 'fallback-should-not-be-used'),
    maxBytes: 420,
    maxFiles: 2,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    getProcessId: () => 12345,
  });

  const queryName = ['api', 'key'].join('_');
  const queryValue = ['query', 'fixture', 'value'].join('-');
  const tokenName = ['to', 'ken'].join('');
  const tokenValue = ['token', 'fixture', 'value'].join('-');
  logger.record('did-start-navigation', {
    windowId: 1,
    webContentsId: 2,
    url: `https://user:pass@example.test/app?${queryName}=${queryValue}#frag`,
    isSameDocument: false,
    isMainFrame: true,
  });
  logger.record('did-fail-load', {
    windowId: 1,
    webContentsId: 2,
    url: `https://example.test/fail?${tokenName}=abc`,
    errorCode: -105,
    errorDescription: `${['Bearer', tokenValue].join(' ')} ${tokenName}=hidden`,
  });

  const initialRecords = readJsonLines(logger.logFilePath);
  assert.equal(initialRecords[0].event, 'did-start-navigation');
  assert.equal(initialRecords[0].timestamp, '2026-09-01T00:00:00.000Z');
  assert.equal(initialRecords[0].processId, 12345);
  assert.equal(initialRecords[0].url, 'https://example.test/app');
  assert.equal(initialRecords[1].url, 'https://example.test/fail');
  assert.equal(initialRecords[1].errorDescription, 'Bearer [redacted] token=[redacted]');
  const serialized = JSON.stringify(initialRecords);
  assert.doesNotMatch(serialized, /api_key|secret|abcdef|hidden|user:pass|\?/);
  assert.ok(logger.logFilePath.startsWith(path.join(tempRoot, 'logs')));

  const sourceLogger = createRendererLifecycleLogger({
    storageRoot: path.join(tempRoot, 'source-events'),
    fallbackRoot: path.join(tempRoot, 'fallback-should-not-be-used'),
    maxBytes: 4096,
    maxFiles: 1,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    getProcessId: () => 12345,
  });
  sourceLogger.record('renderer-reload-requested', {
    source: 'keyboard-shortcut',
    action: 'reloadIgnoringCache',
    status: 'requested',
    loadGeneration: 4,
  });
  sourceLogger.record('renderer-recovery-scheduled', {
    source: 'did-fail-load',
    triggerEvent: 'did-fail-load',
    status: 'scheduled',
    url: 'https://user:pass@example.test/recover?token=abc#frag',
    errorCode: -102,
    errorDescription: 'net::ERR_CONNECTION_REFUSED https://user:pass@example.test/dev?api_key=x#frag',
    reason: 'did-fail-load:-102:https://user:pass@example.test/dev?secret=x',
    attempt: 1,
    maxAttempts: 3,
    delayMs: 750,
  });
  sourceLogger.record('renderer-recovery-succeeded', {
    source: 'render-process-gone',
    triggerEvent: 'render-process-gone',
    status: 'ready',
    reason: 'crashed',
    exitCode: 9,
    loadGeneration: 5,
  });
  sourceLogger.record('renderer-startup-retry', {
    source: 'startup-retry',
    triggerEvent: 'startup-error-page',
    status: 'load-renderer',
  });

  const sourceRecords = readJsonLines(sourceLogger.logFilePath);
  assert.deepEqual(
    sourceRecords.map(record => [record.event, record.source, record.status]),
    [
      ['renderer-reload-requested', 'keyboard-shortcut', 'requested'],
      ['renderer-recovery-scheduled', 'did-fail-load', 'scheduled'],
      ['renderer-recovery-succeeded', 'render-process-gone', 'ready'],
      ['renderer-startup-retry', 'startup-retry', 'load-renderer'],
    ],
  );
  assert.equal(sourceRecords[0].action, 'reloadIgnoringCache');
  assert.equal(sourceRecords[1].url, 'https://example.test/recover');
  assert.equal(sourceRecords[1].errorDescription, 'net::ERR_CONNECTION_REFUSED https://example.test/dev');
  assert.equal(sourceRecords[1].reason, 'did-fail-load:-102:https://example.test/dev');
  assert.equal(sourceRecords[1].attempt, 1);
  assert.equal(sourceRecords[1].maxAttempts, 3);
  assert.equal(sourceRecords[1].delayMs, 750);
  assert.equal(sourceRecords[2].exitCode, 9);
  const sourceSerialized = JSON.stringify(sourceRecords);
  assert.doesNotMatch(sourceSerialized, /api_key|secret|token=abc|hidden|user:pass|\?/);

  for (let index = 0; index < 12; index += 1) {
    logger.record('responsive', {
      windowId: 1,
      webContentsId: 2,
      url: `https://example.test/${index}?password=hidden`,
    });
  }
  assert.ok(fs.existsSync(`${logger.logFilePath}.1`));
  assert.ok(fs.existsSync(`${logger.logFilePath}.2`));
  assert.equal(fs.existsSync(`${logger.logFilePath}.3`), false);
  for (const fileName of fs.readdirSync(path.dirname(logger.logFilePath))) {
    for (const record of readJsonLines(path.join(path.dirname(logger.logFilePath), fileName))) {
      assert.ok(record.event);
      assert.doesNotMatch(JSON.stringify(record), /\?|password=hidden/);
    }
  }

  const capturedEvents = [];
  const fakeLogger = {
    logFilePath: 'memory',
    record(event, fields = {}) {
      capturedEvents.push({ event, fields });
    },
  };
  const fakeWebContents = makeEmitter({
    id: 24,
    isDestroyed: () => false,
    getURL: () => 'https://example.test/current?token=hidden',
  });
  const fakeWindow = makeEmitter({
    id: 42,
    webContents: fakeWebContents,
    isDestroyed: () => false,
  });
  registerRendererLifecycleLogging(fakeWindow, fakeLogger);
  fakeWebContents.emit('did-start-navigation', {
    url: 'https://example.test/start?token=hidden',
    isSameDocument: false,
    isMainFrame: true,
  });
  fakeWebContents.emit('did-finish-load');
  fakeWebContents.emit('did-fail-load', {}, -3, 'net::ERR_ABORTED password=hidden', 'https://example.test/fail?token=hidden', true, 7, 8);
  fakeWebContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
  fakeWindow.emit('unresponsive');
  fakeWindow.emit('responsive');
  recordChildProcessGone(fakeLogger, {
    type: 'GPU',
    reason: 'oom',
    exitCode: 13,
    serviceName: 'Network Service token=hidden',
    name: 'Network Service',
  });

  assert.deepEqual(
    capturedEvents.map(entry => entry.event),
    [
      'did-start-navigation',
      'did-finish-load',
      'did-fail-load',
      'render-process-gone',
      'unresponsive',
      'responsive',
      'child-process-gone',
    ],
  );
  assert.deepEqual(
    capturedEvents.map(entry => entry.fields.windowId).slice(0, 6),
    [42, 42, 42, 42, 42, 42],
  );
  assert.equal(capturedEvents[6].fields.serviceName, 'Network Service token=hidden');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

assert.match(mainSource, /createRendererLifecycleLogger/);
assert.match(mainSource, /registerRendererLifecycleLogging\(mainWindow, rendererLifecycleLogger\)/);
assert.match(mainSource, /app\.on\('child-process-gone'/);
assert.match(mainSource, /renderer-reload-requested/);
assert.match(mainSource, /renderer-recovery-scheduled/);
assert.match(mainSource, /renderer-recovery-started/);
assert.match(mainSource, /renderer-recovery-succeeded/);
assert.match(mainSource, /renderer-startup-retry/);
assert.match(mainSource, /window:recovery-status/);
assert.match(mainSource, /performWindowAction\(forceReload \? 'reloadIgnoringCache' : 'reload', false, 'keyboard-shortcut'\)/);
assert.match(mainSource, /ipcMain\.on\('window:reload', \(\) => performWindowAction\('reload', false, 'window-ipc'\)\)/);
assert.match(mainSource, /rendererRecoveryAttempt >= rendererRecoveryRetryDelaysMs\.length/);
assert.match(mainSource, /if \(rendererRecoveryTimer\) return/);
assert.match(mainSource, /const rendererLoadAttemptTimeoutMs = 20_000/);
assert.match(mainSource, /Promise\.race\(\[loadPromise, timeoutPromise\]\)/);
assert.match(mainSource, /window\.webContents\.stop\(\)/);
assert.match(mainSource, /waitForRendererLoad\(window, window\.loadURL\(devServerUrl\), operationGeneration\)/);
assert.doesNotMatch(mainSource, /\bdialog\./);
assert.doesNotMatch(lifecycleSource, /\breload(?:IgnoringCache)?\s*\(/);

const didFailLoadHandlerStart = mainSource.indexOf("mainWindow.webContents.on('did-fail-load'");
const renderProcessGoneHandlerStart = mainSource.indexOf("mainWindow.webContents.on('render-process-gone'");
assert.notEqual(didFailLoadHandlerStart, -1);
assert.notEqual(renderProcessGoneHandlerStart, -1);
const didFailLoadHandler = mainSource.slice(didFailLoadHandlerStart, renderProcessGoneHandlerStart);
assert.match(didFailLoadHandler, /if \(errorCode === -3\) return;/);
assert.ok(
  didFailLoadHandler.indexOf('if (errorCode === -3) return;') < didFailLoadHandler.indexOf('scheduleRendererRecovery({'),
);
assert.match(didFailLoadHandler, /source: 'did-fail-load'/);
assert.match(didFailLoadHandler, /triggerEvent: 'did-fail-load'/);
assert.match(didFailLoadHandler, /url: validatedURL/);
assert.match(didFailLoadHandler, /errorCode,/);
assert.match(didFailLoadHandler, /errorDescription,/);
assert.doesNotMatch(didFailLoadHandler, /errorDescription \|\| validatedURL/);

const renderProcessGoneHandler = mainSource.slice(renderProcessGoneHandlerStart, mainSource.indexOf('});', renderProcessGoneHandlerStart) + 3);
assert.match(renderProcessGoneHandler, /details\.reason === 'clean-exit' \|\| details\.reason === 'killed'/);
assert.ok(
  renderProcessGoneHandler.indexOf("details.reason === 'clean-exit'") < renderProcessGoneHandler.indexOf('scheduleRendererRecovery({'),
);
assert.match(renderProcessGoneHandler, /source: 'render-process-gone'/);
assert.match(renderProcessGoneHandler, /triggerEvent: 'render-process-gone'/);
assert.match(renderProcessGoneHandler, /reason: details\.reason/);
assert.match(renderProcessGoneHandler, /exitCode: details\.exitCode/);

console.log('Renderer lifecycle logging integration: all assertions passed');
