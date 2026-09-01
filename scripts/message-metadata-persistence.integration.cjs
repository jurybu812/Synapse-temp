const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain } = require('electron');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-message-metadata-'));
app.setPath('home', tempHome);

const handlers = new Map();
let databaseModule;
ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler);
};

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  try {
    return Promise.resolve(handler({}, ...args));
  } catch (error) {
    return Promise.reject(error);
  }
}

function buildMessage(overrides = {}) {
  return {
    id: 'assistant-message',
    role: 'assistant',
    content: 'Completed response',
    timestamp: 1700000000000,
    model: 'gpt-test',
    toolCalls: [{ id: 'tool-call-1', name: 'read_file', arguments: { path: 'src/App.tsx' } }],
    contentParts: [{ type: 'text', text: 'Completed response' }],
    attachments: [{ id: 'attachment-1', sha256: 'sha-attachment-1', name: 'evidence.png', kind: 'image' }],
    richTokens: [{ type: 'mention', label: '@file', value: 'src/App.tsx' }],
    thinking: { summary: 'kept' },
    streamState: 'complete',
    durationMs: 4000,
    streamMode: 'real',
    fallbackReason: 'provider_fallback',
    endToEndMs: 32000,
    runId: 'run-1',
    runEvents: [{ type: 'tool', status: 'done' }],
    diffs: [{ path: 'src/App.tsx', status: 'modified' }],
    rollbackSnapshotId: 'rollback-1',
    subtitle: '已完成',
    subtitleGeneratedAt: 1700000000500,
    ...overrides,
  };
}

function buildMetadata(overrides = {}) {
  return {
    title: 'metadata-conversation',
    model: 'gpt-test',
    mode: 'coding',
    reasoningEffort: 'high',
    schemaVersion: 1,
    lastMessage: 'Completed response',
    assistantRuns: { 'run-1': { status: 'completed', messageId: 'assistant-message' } },
    fileSnapshots: { 'src/App.tsx': { path: 'src/App.tsx', sha256: 'file-sha' } },
    pendingDiffs: [{ path: 'src/App.tsx', status: 'pending' }],
    archived: false,
    tags: ['metadata', 'atomic'],
    workspacePath: 'C:/tmp/synapse-workspace',
    goal: 'ship atomic snapshot',
    bpcThresholdOverride: 0,
    compactThresholdOverride: 0,
    taskBoundaries: [{
      id: 'boundary-1',
      title: 'Stage 6A',
      status: 'running',
      messageIds: ['assistant-message'],
    }],
    taskHeadline: {
      title: 'Stage 6A',
      updatedAt: 1700000000600,
    },
    ...overrides,
  };
}

async function assertPersistedState(id, expected) {
  const conversation = await invoke('conversation:get', id);
  assert.ok(conversation, `conversation ${id} should exist`);
  assert.equal(conversation.title, expected.metadata.title);
  assert.equal(conversation.mode, expected.metadata.mode);
  assert.equal(conversation.reasoningEffort, expected.metadata.reasoningEffort);
  assert.equal(conversation.lastMessage, expected.metadata.lastMessage);
  assert.equal(conversation.messageCount, expected.messages.length);
  assert.deepEqual(conversation.tags, expected.metadata.tags);
  assert.equal(conversation.workspacePath, expected.metadata.workspacePath);
  assert.equal(conversation.goal, expected.metadata.goal);
  assert.equal(conversation.bpcThresholdOverride, expected.metadata.bpcThresholdOverride);
  assert.equal(conversation.compactThresholdOverride, expected.metadata.compactThresholdOverride);
  assert.deepEqual(conversation.taskBoundaries, expected.metadata.taskBoundaries);
  assert.deepEqual(conversation.taskHeadline, expected.metadata.taskHeadline);

  const messages = await invoke('message:list', id);
  assert.equal(messages.length, expected.messages.length);
  for (let index = 0; index < expected.messages.length; index += 1) {
    const actual = messages[index];
    const expectedMessage = expected.messages[index];
    assert.equal(actual.id, expectedMessage.id);
    assert.equal(actual.role, expectedMessage.role);
    assert.equal(actual.content, expectedMessage.content);
    assert.equal(actual.model, expectedMessage.model);
    assert.deepEqual(actual.toolCalls, expectedMessage.toolCalls);
    assert.deepEqual(actual.contentParts, expectedMessage.contentParts);
    assert.deepEqual(actual.attachments, expectedMessage.attachments);
    assert.deepEqual(actual.richTokens, expectedMessage.richTokens);
    assert.deepEqual(actual.thinking, expectedMessage.thinking);
    assert.equal(actual.streamState, expectedMessage.streamState);
    assert.equal(actual.durationMs, expectedMessage.durationMs);
    assert.equal(actual.streamMode, expectedMessage.streamMode);
    assert.equal(actual.fallbackReason, expectedMessage.fallbackReason);
    assert.equal(actual.endToEndMs, expectedMessage.endToEndMs);
    assert.equal(actual.runId, expectedMessage.runId);
    assert.deepEqual(actual.runEvents, expectedMessage.runEvents);
    assert.deepEqual(actual.diffs, expectedMessage.diffs);
    assert.equal(actual.rollbackSnapshotId, expectedMessage.rollbackSnapshotId);
    assert.equal(actual.subtitle, expectedMessage.subtitle);
    assert.equal(actual.subtitleGeneratedAt, expectedMessage.subtitleGeneratedAt);
  }
}

async function assertRejectsSnapshotWrite(data) {
  await assert.rejects(
    () => invoke('conversation:saveSnapshot', data),
    /CHECK constraint failed|FOREIGN KEY constraint failed|constraint failed/i,
  );
}

async function restartHandlers() {
  databaseModule.closeDatabase();
  handlers.clear();
  databaseModule.initDatabase();
  const { registerConversationHandlers } = require('../dist-electron/electron/ipc/conversation.js');
  registerConversationHandlers();
}

function assertAgentPanelAutosaveFallbackPreservesMetadata() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'layout', 'AgentPanel.tsx'), 'utf8');
  const snapshotMatch = source.match(/const autosaveSnapshot = \{([\s\S]*?)\n\s+\};\n\s+void saveAutosaveSnapshot\(autosaveSnapshot\)/);
  assert.ok(snapshotMatch, 'AgentPanel autosave must build a reusable autosaveSnapshot before saving');
  const snapshotSource = snapshotMatch[1];
  assert.match(snapshotSource, /assistantRuns:\s*conversation\.assistantRuns/);
  assert.match(snapshotSource, /fileSnapshots:\s*conversation\.fileSnapshots/);
  assert.match(snapshotSource, /pendingDiffs:\s*conversation\.pendingDiffs/);

  const fallbackMatch = source.match(/saveAutosaveSnapshot\(autosaveSnapshot\)\.catch\(\(\) => \{[\s\S]*?localStorage\.setItem\('synapse_autosave', JSON\.stringify\(\{([\s\S]*?)\}\)\);/);
  assert.ok(fallbackMatch, 'AgentPanel autosave fallback must write the same snapshot shape to localStorage');
  const fallbackSource = fallbackMatch[1];
  assert.match(fallbackSource, /\.\.\.autosaveSnapshot/);
  assert.match(fallbackSource, /messages:\s*sanitizeMessagesForPersistence\(autosaveSnapshot\.messages\)/);
  assert.doesNotMatch(fallbackSource, /messages:\s*sanitizeMessagesForPersistence\(messages\)[\s\S]*model,\s*[\s\S]*timestamp:\s*Date\.now\(\)/);
}

async function main() {
  assertAgentPanelAutosaveFallbackPreservesMetadata();
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  const { registerConversationHandlers } = require('../dist-electron/electron/ipc/conversation.js');
  databaseModule.initDatabase();
  registerConversationHandlers();

  const metadata = buildMetadata();
  const messages = [buildMessage()];
  await invoke('conversation:saveSnapshot', {
    id: 'metadata-conversation',
    metadata,
    messages,
  });
  await assertPersistedState('metadata-conversation', { metadata, messages });

  await restartHandlers();
  await assertPersistedState('metadata-conversation', { metadata, messages });

  await assertRejectsSnapshotWrite({
    id: 'metadata-conversation',
    metadata: buildMetadata({ title: 'should-not-persist', mode: 'planning', lastMessage: 'bad write' }),
    messages: [buildMessage({ id: 'bad-message', role: 'invalid-role', content: 'bad write' })],
  });
  await assertPersistedState('metadata-conversation', { metadata, messages });

  await assertRejectsSnapshotWrite({
    id: 'new-failure',
    metadata: buildMetadata({ title: 'new-failure', lastMessage: 'bad new write' }),
    messages: [buildMessage({ id: 'bad-new-message', role: 'invalid-role', content: 'bad new write' })],
  });
  assert.equal(await invoke('conversation:get', 'new-failure'), null);
  assert.deepEqual(await invoke('message:list', 'new-failure'), []);

  const fallbackMetadata = buildMetadata({
    title: 'fallback-update',
    mode: 'review',
    reasoningEffort: 'xhigh',
    lastMessage: 'Fallback response',
    taskBoundaries: [{
      id: 'boundary-2',
      title: 'Fallback',
      status: 'done',
      messageIds: ['assistant-message'],
    }],
    taskHeadline: {
      title: 'Fallback',
      updatedAt: 1700000000700,
    },
  });
  const fallbackMessages = [buildMessage({
    content: 'Fallback response',
    durationMs: 5000,
    streamMode: 'pseudo',
    fallbackReason: 'stream_unavailable',
    endToEndMs: 41000,
    attachments: [{ id: 'attachment-2', sha256: 'sha-attachment-2', name: 'trace.json', kind: 'artifact' }],
  })];
  await invoke('conversation:update', 'metadata-conversation', {
    ...fallbackMetadata,
    messages: fallbackMessages,
  });
  await assertPersistedState('metadata-conversation', {
    metadata: fallbackMetadata,
    messages: fallbackMessages,
  });

  const createMetadata = buildMetadata({ title: 'fallback-create', lastMessage: 'Created in one IPC' });
  const createMessages = [buildMessage({ id: 'created-message', content: 'Created in one IPC' })];
  await invoke('conversation:create', {
    id: 'fallback-create',
    ...createMetadata,
    messages: createMessages,
  });
  await assertPersistedState('fallback-create', {
    metadata: createMetadata,
    messages: createMessages,
  });

  const legacyMessage = buildMessage({
    id: 'legacy-message',
    durationMs: 6000,
    streamMode: 'legacy',
    fallbackReason: 'legacy_replace',
    endToEndMs: 51000,
  });
  await invoke('conversation:create', { id: 'legacy-conversation', title: 'legacy-conversation' });
  await invoke('message:add', { ...legacyMessage, conversationId: 'legacy-conversation' });
  await invoke('message:replaceConversation', 'legacy-conversation', [legacyMessage]);
  const legacyMessages = await invoke('message:list', 'legacy-conversation');
  assert.equal(legacyMessages.length, 1);
  assert.equal(legacyMessages[0].streamState, legacyMessage.streamState);
  assert.equal(legacyMessages[0].durationMs, legacyMessage.durationMs);
  assert.equal(legacyMessages[0].streamMode, legacyMessage.streamMode);
  assert.equal(legacyMessages[0].fallbackReason, legacyMessage.fallbackReason);
  assert.equal(legacyMessages[0].endToEndMs, legacyMessage.endToEndMs);

  databaseModule.closeDatabase();
  console.log('Message metadata persistence integration: all assertions passed');
}

main()
  .catch((error) => {
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
      console.error('Failed to remove message metadata test directory:', error);
      process.exitCode = 1;
    }
    app.exit(Number(process.exitCode) || 0);
  });
