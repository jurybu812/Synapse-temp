const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const { MCPServerProcess } = require(path.resolve(
  __dirname,
  '..',
  'dist-electron',
  'electron',
  'mcp',
  'MCPServerProcess.js',
));

const FIXTURE_MARKER = 'SYNAPSE_MCP_LIFECYCLE_FIXTURE';
const delayedStdioServer = `
const readline = require('node:readline');
const marker = ${JSON.stringify(FIXTURE_MARKER)};
void marker;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') return;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }, 150);
});
setInterval(() => undefined, 1000);
`;
const slowStdioServer = delayedStdioServer.replace('}, 150);', '}, 750);');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

function sendJson(response, id, result, sessionId) {
  response.writeHead(200, {
    'content-type': 'application/json',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

async function testHttpStartStopSingleFlight() {
  let initializeCount = 0;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        initializeCount += 1;
        setTimeout(() => sendJson(response, message.id, {}, 'delayed-session'), 150);
        return;
      }
      response.writeHead(202).end();
    });
  });

  const port = await listen(server);
  const proc = new MCPServerProcess('delayed-http', '', [], {}, {
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    initializeTimeoutMs: 10_000,
  });
  let readyCount = 0;
  proc.on('ready', () => { readyCount += 1; });

  try {
    const firstStart = proc.start();
    const joinedStart = proc.start();
    await sleep(25);
    await proc.stop();
    await assert.rejects(firstStart, /start cancelled|request cancelled/);
    await assert.rejects(joinedStart, /start cancelled|request cancelled/);
    await sleep(175);

    assert.equal(initializeCount, 1, 'concurrent start calls must share one HTTP initialize request');
    assert.equal(proc.status, 'stopped', 'a delayed initialize response must not revive a stopped server');
    assert.equal(readyCount, 0, 'a stopped server must not emit ready from a late handshake');
  } finally {
    await proc.stop().catch(() => undefined);
    await close(server);
  }
}

async function testStdioStartSingleFlightAndStop() {
  const proc = new MCPServerProcess('delayed-stdio', process.execPath, ['-e', delayedStdioServer]);
  let cancelled;
  proc.on('error', () => undefined);
  let readyCount = 0;
  proc.on('ready', () => { readyCount += 1; });

  try {
    let joinedResolved = false;
    const firstStart = proc.start();
    const joinedStart = proc.start().then(() => { joinedResolved = true; });
    await sleep(25);
    assert.equal(joinedResolved, false, 'a concurrent stdio start must wait for the shared initialize handshake');
    await Promise.all([firstStart, joinedStart]);
    assert.equal(proc.status, 'running');
    assert.equal(readyCount, 1, 'a single stdio generation must emit ready once');
    await proc.stop();

    cancelled = new MCPServerProcess('cancelled-stdio', process.execPath, ['-e', delayedStdioServer]);
    cancelled.on('error', () => undefined);
    let cancelledReadyCount = 0;
    cancelled.on('ready', () => { cancelledReadyCount += 1; });
    const firstCancelledStart = cancelled.start();
    const joinedCancelledStart = cancelled.start();
    await sleep(25);
    await cancelled.stop();
    await assert.rejects(firstCancelledStart, /stdio start cancelled/);
    await assert.rejects(joinedCancelledStart, /stdio start cancelled/);
    assert.equal(cancelled.status, 'stopped', 'stdio stop must win over a late initialize rejection');
    assert.equal(cancelledReadyCount, 0, 'cancelled stdio start must not emit ready');
  } finally {
    await cancelled?.stop().catch(() => undefined);
    await proc.stop().catch(() => undefined);
  }
}

async function testConcurrentHttpReinitSingleFlight() {
  let initializeCount = 0;
  let staleToolsRequestCount = 0;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        initializeCount += 1;
        const sessionId = initializeCount === 1 ? 'session-old' : 'session-new';
        setTimeout(() => sendJson(response, message.id, {}, sessionId), initializeCount === 1 ? 0 : 100);
        return;
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      if (message.method === 'tools/list') {
        if (request.headers['mcp-session-id'] !== 'session-new') {
          staleToolsRequestCount += 1;
          setTimeout(
            () => response.writeHead(404).end('session expired'),
            staleToolsRequestCount === 1 ? 20 : 160,
          );
          return;
        }
        sendJson(response, message.id, { tools: [{ name: 'echo', description: 'fixture', inputSchema: {} }] });
        return;
      }
      response.writeHead(400).end();
    });
  });

  const port = await listen(server);
  const proc = new MCPServerProcess('reinit-single-flight', '', [], {}, {
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
  });
  try {
    await proc.start();
    const [firstTools, secondTools] = await Promise.all([proc.listTools(), proc.listTools()]);
    assert.deepEqual(firstTools.map(tool => tool.name), ['echo']);
    assert.deepEqual(secondTools.map(tool => tool.name), ['echo']);
    assert.equal(initializeCount, 2, 'concurrent dead-session requests must share one re-initialize handshake');
    assert.equal(proc.status, 'running');
  } finally {
    await proc.stop().catch(() => undefined);
    await close(server);
  }
}

async function testHttpReinitStopRace() {
  let initializeCount = 0;
  let signalReinitStarted;
  const reinitStarted = new Promise(resolve => { signalReinitStarted = resolve; });
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        initializeCount += 1;
        if (initializeCount === 2) signalReinitStarted();
        const sessionId = initializeCount === 1 ? 'race-old' : 'race-new';
        setTimeout(() => sendJson(response, message.id, {}, sessionId), initializeCount === 1 ? 0 : 180);
        return;
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      if (message.method === 'tools/list') {
        response.writeHead(404).end('session expired');
        return;
      }
      response.writeHead(400).end();
    });
  });

  const port = await listen(server);
  const proc = new MCPServerProcess('reinit-stop-race', '', [], {}, {
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
  });
  const statusChanges = [];
  proc.on('status-change', event => statusChanges.push(event.status));
  try {
    await proc.start();
    const listPromise = proc.listTools();
    await reinitStarted;
    await proc.stop();
    assert.deepEqual(await listPromise, []);
    await sleep(200);
    assert.equal(proc.status, 'stopped', 'a cancelled re-initialize must not overwrite stopped with error');
    assert.equal(statusChanges.includes('error'), false, 'Stop-cancelled re-initialize must not broadcast a false error state');
  } finally {
    await proc.stop().catch(() => undefined);
    await close(server);
  }
}

async function testIpcPendingStartCanBeStoppedAndStatusFailsClosed() {
  const handlers = new Map();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-mcp-lifecycle-'));
  const configDir = path.join(tempHome, '.synapse');
  const configPath = path.join(configDir, 'mcp_config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    servers: {
      'ipc-start-race': {
        command: process.execPath,
        args: ['-e', delayedStdioServer],
        enabled: false,
      },
      'ipc-stdio-single-flight': {
        command: process.execPath,
        args: ['-e', slowStdioServer],
        enabled: false,
      },
    },
  }), 'utf8');

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => tempHome },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    if (request === './file' && parent?.filename?.endsWith(path.join('ipc', 'mcp.js'))) {
      return {
        confirmSensitiveOperationInMainWindow: async (_sender, options) => {
          if (String(options?.title).includes('启动')) await sleep(100);
          return true;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = path.resolve(__dirname, '..', 'dist-electron', 'electron', 'ipc', 'mcp.js');
  delete require.cache[modulePath];
  let mcp;
  try {
    mcp = require(modulePath);
    mcp.registerMCPHandlers();
    const event = { sender: {} };
    const startPromise = handlers.get('mcp:start')(event, 'ipc-start-race');
    await sleep(20);
    assert.deepEqual(await handlers.get('mcp:stop')(event, 'ipc-start-race'), { status: 'stopped' });
    await assert.rejects(startPromise, /lifecycle superseded/);

    const firstStdioStart = handlers.get('mcp:start')(event, 'ipc-stdio-single-flight');
    let observedStarting = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const status = await handlers.get('mcp:status')();
      if (status.servers.find(item => item.name === 'ipc-stdio-single-flight')?.status === 'starting') {
        observedStarting = true;
        break;
      }
      await sleep(10);
    }
    assert.equal(observedStarting, true, 'fixture must reach starting before the joined IPC start');
    let joinedStdioResolved = false;
    const joinedStdioStart = handlers.get('mcp:start')(event, 'ipc-stdio-single-flight')
      .then(result => {
        joinedStdioResolved = true;
        return result;
      });
    await sleep(20);
    assert.equal(joinedStdioResolved, false, 'IPC start must join the in-flight stdio handshake');
    const [firstStdioResult, joinedStdioResult] = await Promise.all([firstStdioStart, joinedStdioStart]);
    assert.deepEqual(firstStdioResult, { status: 'running', reused: false });
    assert.deepEqual(joinedStdioResult, { status: 'running', reused: true });
    assert.deepEqual(
      await handlers.get('mcp:stop')(event, 'ipc-stdio-single-flight'),
      { status: 'stopped' },
    );

    let initializeCount = 0;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        if (request.method === 'DELETE') {
          response.writeHead(204).end();
          return;
        }
        const message = JSON.parse(raw);
        if (message.method === 'initialize') {
          initializeCount += 1;
          sendJson(response, message.id, {}, 'status-session');
          return;
        }
        if (message.method === 'notifications/initialized') {
          response.writeHead(202).end();
          return;
        }
        sendJson(response, message.id, { tools: [] });
      });
    });
    const port = await listen(server);
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        servers: {
          'http-status': { transport: 'http', url: `http://127.0.0.1:${port}/mcp`, enabled: true },
        },
      }), 'utf8');
      await mcp.startEnabledMCPServers();
      assert.equal(initializeCount, 1);
      await close(server);
      const status = await handlers.get('mcp:status')();
      const projection = status.servers.find(item => item.name === 'http-status');
      assert.equal(projection.status, 'error', 'status projection must expose listTools transport failure');
      assert.equal(projection.running, false, 'network-dead server must not remain visibly running');
      assert.deepEqual(projection.tools, []);
    } finally {
      await close(server);
    }
  } finally {
    await mcp?.shutdownAllMCP().catch(() => undefined);
    Module._load = originalLoad;
    delete require.cache[modulePath];
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

async function run() {
  await testHttpStartStopSingleFlight();
  await testStdioStartSingleFlightAndStop();
  await testConcurrentHttpReinitSingleFlight();
  await testHttpReinitStopRace();
  await testIpcPendingStartCanBeStoppedAndStatusFailsClosed();
  console.log('MCP lifecycle integration: all assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
