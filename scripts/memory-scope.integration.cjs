const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain } = require('electron');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-memory-scope-'));
app.setPath('home', tempHome);

const handlers = new Map();
let databaseModule;
ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler);
};

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

function memory(id, conversationId, title) {
  return {
    id,
    title,
    content: `${title} body`,
    tags: ['scope-test'],
    category: 'technical-note',
    searchSummary: 'scope isolated memory',
    pinned: false,
    conversationId,
  };
}

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  const { registerMemoryHandlers } = require('../dist-electron/electron/ipc/memory.js');
  databaseModule.initDatabase();
  registerMemoryHandlers();

  await invoke('memory:write', memory('memory-A', 'conversation-A', 'alpha'));
  await invoke('memory:write', memory('memory-B', 'conversation-B', 'beta'));
  await invoke('memory:write', memory('memory-global', undefined, 'global'));

  const queryA = await invoke('memory:query', {
    conversationId: 'conversation-A',
    query: 'scope',
    limit: 20,
  });
  assert.deepEqual(queryA.map(item => item.id), ['memory-A']);

  const listB = await invoke('memory:list', {
    conversationId: 'conversation-B',
    limit: 20,
  });
  assert.deepEqual(listB.map(item => item.id), ['memory-B']);

  const globalManagementView = await invoke('memory:list', { limit: 20 });
  assert.deepEqual(
    new Set(globalManagementView.map(item => item.id)),
    new Set(['memory-A', 'memory-B', 'memory-global']),
  );

  const wildcard = await invoke('memory:query', {
    conversationId: 'conversation-A',
    query: '%',
    limit: 20,
  });
  assert.equal(wildcard.length, 0);

  console.log('Memory scope integration: all assertions passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      databaseModule?.closeDatabase();
    } catch {}
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to remove memory scope test directory:', error);
      process.exitCode = 1;
    }
    app.quit();
  });
