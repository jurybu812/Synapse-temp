const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'src', 'services', 'agentSessionCheckpoint.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const values = new Map();
let desktopCheckpoint = null;
let throwDesktopGet = false;
const window = {
  synapse: {
    config: {
      getSync() {
        if (throwDesktopGet) throw new Error('sync ipc unavailable');
        return desktopCheckpoint;
      },
      setSync(_key, value) {
        desktopCheckpoint = value;
        return true;
      },
      async set(_key, value) {
        desktopCheckpoint = value;
      },
    },
  },
};
const localStorage = {
  getItem(key) {
    return values.has(key) ? values.get(key) : null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
  removeItem(key) {
    values.delete(key);
  },
};

const moduleRef = { exports: {} };
vm.runInNewContext(output, {
  module: moduleRef,
  exports: moduleRef.exports,
  require,
  localStorage,
  window,
  Date,
  JSON,
  Number,
  String,
});

const checkpoint = moduleRef.exports;
assert.equal(checkpoint.clampChatScrollAnchorOffset(24, 900), 24);
assert.equal(checkpoint.clampChatScrollAnchorOffset(-6000, 900), -900);
assert.equal(checkpoint.isChatScrollAnchorOffsetWithinViewportBand(24, 900), true);
assert.equal(checkpoint.isChatScrollAnchorOffsetWithinViewportBand(-6000, 900), false);
assert.equal(checkpoint.clampChatScrollTopForRestore(6200, 14000, 900), 6200);
assert.equal(checkpoint.clampChatScrollTopForRestore(16000, 14000, 900), 13100);
desktopCheckpoint = {
  version: 1,
  activeConversationId: 'stale-desktop',
  activeAgentTab: 'chat',
  updatedAt: 1,
};
localStorage.setItem('synapse:agent-session-checkpoint:v1', JSON.stringify({
  version: 1,
  activeConversationId: 'fresh-local',
  activeAgentTab: 'plan',
  updatedAt: 2,
}));
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'fresh-local');
assert.equal(checkpoint.readCheckpointAgentTab(), 'plan');
throwDesktopGet = true;
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'fresh-local');
assert.equal(checkpoint.readCheckpointAgentTab(), 'plan');
throwDesktopGet = false;
values.clear();
desktopCheckpoint = null;

checkpoint.writeCheckpointActiveConversationId('conversation-a');
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'conversation-a');
assert.equal(checkpoint.readCheckpointAgentTab(), 'chat');

localStorage.setItem('synapse_active_conversation_id', 'conversation-a');
checkpoint.writeAgentSessionViewport({
  conversationId: 'conversation-a',
  activeAgentTab: 'plan',
  chatScroll: {
    scrollTop: 123,
    atBottom: false,
    visibleUnitStart: 10,
    visibleUnitEnd: 42,
    anchor: { kind: 'message', id: 'message-10', offset: 18 },
    updatedAt: 100,
  },
});
assert.equal(checkpoint.readCheckpointAgentTab(), 'plan');
assert.equal(checkpoint.readCheckpointChatScroll('conversation-a').scrollTop, 123);
checkpoint.writeAgentSessionViewport({
  conversationId: 'conversation-a',
  activeAgentTab: 'plan',
  chatScroll: {
    scrollTop: 222,
    atBottom: false,
    visibleUnitStart: 12,
    visibleUnitEnd: 44,
    anchor: { kind: 'step', id: 'step-7', boundaryId: 'boundary-1', offset: 24 },
    updatedAt: 120,
  },
});
assert.deepEqual(checkpoint.readCheckpointChatScroll('conversation-a').anchor, {
  kind: 'step',
  id: 'step-7',
  boundaryId: 'boundary-1',
  offset: 24,
});
checkpoint.writeAgentSessionViewport({
  conversationId: 'conversation-a',
  activeAgentTab: 'context',
  tabScrollTop: { plan: 456 },
});
assert.equal(checkpoint.readCheckpointAgentTab(), 'context');
assert.equal(checkpoint.readCheckpointTabScroll('conversation-a', 'plan'), 456);
assert.equal(checkpoint.readCheckpointTabScroll('conversation-b', 'plan'), 0);

localStorage.setItem('synapse_active_conversation_id', 'conversation-b');
checkpoint.writeCheckpointActiveConversationId('conversation-b');
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'conversation-b');
assert.equal(checkpoint.readCheckpointChatScroll('conversation-a'), null);

checkpoint.writeAgentSessionViewport({
  conversationId: 'conversation-a',
  activeAgentTab: 'context',
  tabScrollTop: { plan: 789 },
});
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'conversation-b');
assert.equal(checkpoint.readCheckpointAgentTab(), 'context');
assert.equal(checkpoint.readCheckpointTabScroll('conversation-a', 'plan'), 789);

checkpoint.writeAgentSessionViewport({
  conversationId: 'conversation-b',
  activeAgentTab: 'context',
});
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'conversation-b');
assert.equal(checkpoint.readCheckpointAgentTab(), 'context');

values.clear();
desktopCheckpoint = {
  version: 1,
  activeConversationId: 'conversation-a',
  activeAgentTab: 'chat',
  updatedAt: 300,
};
assert.equal(localStorage.getItem('synapse_active_conversation_id'), null);
checkpoint.writeAgentSessionViewport({
  conversationId: 'conversation-b',
  activeAgentTab: 'context',
  tabScrollTop: { plan: 654 },
  sync: true,
});
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'conversation-a');
assert.equal(checkpoint.readCheckpointAgentTab(), 'chat');
assert.equal(checkpoint.readCheckpointTabScroll('conversation-b', 'plan'), 654);
assert.equal(desktopCheckpoint.activeConversationId, 'conversation-a');

localStorage.removeItem('synapse_active_conversation_id');
checkpoint.writeCheckpointActiveConversationId(null);
checkpoint.writeAgentSessionViewport({
  conversationId: 'autosave-current',
  activeAgentTab: 'plan',
  chatScroll: {
    scrollTop: 88,
    atBottom: false,
    visibleUnitStart: 2,
    visibleUnitEnd: 12,
    updatedAt: 200,
  },
});
assert.equal(checkpoint.readCheckpointActiveConversationId(), null);
assert.equal(checkpoint.readCheckpointAgentTab(), 'plan');
assert.equal(checkpoint.readCheckpointChatScroll('autosave-current').scrollTop, 88);
assert.ok(desktopCheckpoint);

localStorage.setItem('synapse:chat-scroll:autosave-current', JSON.stringify({ scrollTop: 88 }));
checkpoint.promoteAgentSessionCheckpoint('autosave-current', 'conversation-c');
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'conversation-c');
assert.equal(localStorage.getItem('synapse_active_conversation_id'), 'conversation-c');
assert.equal(checkpoint.readCheckpointChatScroll('conversation-c').scrollTop, 88);
assert.equal(checkpoint.readCheckpointTabScroll('conversation-c', 'plan'), 0);
assert.ok(localStorage.getItem('synapse:chat-scroll:conversation-c'));

localStorage.setItem('synapse:agent-tab-scroll:autosave-current', JSON.stringify({ plan: 321 }));
checkpoint.promoteAgentSessionCheckpoint('autosave-current', 'conversation-d');
assert.equal(checkpoint.readCheckpointTabScroll('conversation-d', 'plan'), 321);

checkpoint.writeCheckpointActiveConversationId('conversation-old');
localStorage.setItem('synapse_active_conversation_id', 'conversation-old');
checkpoint.promoteAgentSessionCheckpoint('conversation-old', 'conversation-new');
assert.equal(checkpoint.readCheckpointActiveConversationId(), 'conversation-new');
assert.equal(localStorage.getItem('synapse_active_conversation_id'), 'conversation-new');

localStorage.removeItem('synapse_active_conversation_id');
checkpoint.writeCheckpointActiveConversationId(null);
checkpoint.writeAgentSessionViewport({
  conversationId: 'autosave-current',
  activeAgentTab: 'context',
  sync: true,
});
assert.equal(desktopCheckpoint.activeAgentTab, 'context');

console.log('Agent session checkpoint integration: all assertions passed');
