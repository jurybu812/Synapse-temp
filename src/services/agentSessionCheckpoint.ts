export type AgentPanelTab = 'chat' | 'plan' | 'context';

export interface ChatScrollCheckpoint {
  scrollTop: number;
  atBottom: boolean;
  visibleUnitStart: number;
  visibleUnitEnd: number;
  anchor?: {
    kind: 'message' | 'boundary';
    id?: string;
    offset: number;
  };
  updatedAt: number;
}

interface AgentSessionCheckpoint {
  version: 1;
  activeConversationId: string | null;
  activeAgentTab: AgentPanelTab;
  chatScroll?: ChatScrollCheckpoint & { conversationId: string };
  tabScroll?: {
    conversationId: string;
    positions: Partial<Record<AgentPanelTab, number>>;
  };
  updatedAt: number;
}

const SESSION_CHECKPOINT_KEY = 'synapse:agent-session-checkpoint:v1';
const LEGACY_ACTIVE_CONVERSATION_KEY = 'synapse_active_conversation_id';
const TAB_SCROLL_STORAGE_PREFIX = 'synapse:agent-tab-scroll:';
const AUTOSAVE_CONVERSATION_ID = 'autosave-current';

function normalizeAgentPanelTab(value: unknown): AgentPanelTab {
  return value === 'plan' || value === 'context' ? value : 'chat';
}

function normalizeCheckpoint(value: unknown): AgentSessionCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<AgentSessionCheckpoint>;
  if (parsed.version !== 1) return null;
  const activeConversationId = typeof parsed.activeConversationId === 'string' ? parsed.activeConversationId : null;
  const legacyTabScrollTop = (parsed as AgentSessionCheckpoint & {
    tabScrollTop?: Partial<Record<AgentPanelTab, number>>;
  }).tabScrollTop;
  const parsedTabScroll = parsed.tabScroll && typeof parsed.tabScroll === 'object'
    && typeof parsed.tabScroll.conversationId === 'string'
    ? parsed.tabScroll
    : legacyTabScrollTop && typeof legacyTabScrollTop === 'object'
      ? {
        conversationId: activeConversationId ?? parsed.chatScroll?.conversationId ?? AUTOSAVE_CONVERSATION_ID,
        positions: legacyTabScrollTop,
      }
      : undefined;
  return {
    version: 1,
    activeConversationId,
    activeAgentTab: normalizeAgentPanelTab(parsed.activeAgentTab),
    chatScroll: parsed.chatScroll && typeof parsed.chatScroll.conversationId === 'string'
      ? parsed.chatScroll
      : undefined,
    tabScroll: parsedTabScroll,
    updatedAt: Number(parsed.updatedAt) || 0,
  };
}

export function readAgentSessionCheckpoint(): AgentSessionCheckpoint | null {
  let desktopCheckpoint: AgentSessionCheckpoint | null = null;
  if (typeof window !== 'undefined') {
    try {
      desktopCheckpoint = normalizeCheckpoint(window.synapse?.config.getSync?.(SESSION_CHECKPOINT_KEY));
    } catch {
      // Packaged startup can briefly lose the synchronous bridge; localStorage remains a valid fallback.
    }
  }
  let localCheckpoint: AgentSessionCheckpoint | null = null;
  try {
    const raw = localStorage.getItem(SESSION_CHECKPOINT_KEY);
    if (raw) localCheckpoint = normalizeCheckpoint(JSON.parse(raw));
  } catch {
    // Fall through to the desktop mirror.
  }
  if (!desktopCheckpoint) return localCheckpoint;
  if (!localCheckpoint) return desktopCheckpoint;
  return localCheckpoint.updatedAt >= desktopCheckpoint.updatedAt ? localCheckpoint : desktopCheckpoint;
}

function writeCheckpoint(checkpoint: AgentSessionCheckpoint, sync = false) {
  try {
    localStorage.setItem(SESSION_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch {
    // Electron's SQLite mirror below remains available when localStorage is full.
  }
  if (typeof window !== 'undefined') {
    if (sync && window.synapse?.config.setSync) {
      window.synapse.config.setSync(SESSION_CHECKPOINT_KEY, checkpoint);
    } else {
      void window.synapse?.config.set(SESSION_CHECKPOINT_KEY, checkpoint).catch(() => undefined);
    }
  }
}

export function readCheckpointActiveConversationId(): string | null {
  return readAgentSessionCheckpoint()?.activeConversationId ?? null;
}

export function readCheckpointAgentTab(): AgentPanelTab {
  return readAgentSessionCheckpoint()?.activeAgentTab ?? 'chat';
}

export function readCheckpointChatScroll(conversationId: string): ChatScrollCheckpoint | null {
  const scroll = readAgentSessionCheckpoint()?.chatScroll;
  if (!scroll || scroll.conversationId !== conversationId) return null;
  const { conversationId: _conversationId, ...checkpoint } = scroll;
  return checkpoint;
}

export function readCheckpointTabScroll(conversationId: string, tab: AgentPanelTab): number {
  const tabScroll = readAgentSessionCheckpoint()?.tabScroll;
  if (tabScroll?.conversationId === conversationId) {
    return Math.max(0, Number(tabScroll.positions[tab]) || 0);
  }
  try {
    const stored = JSON.parse(localStorage.getItem(`${TAB_SCROLL_STORAGE_PREFIX}${conversationId}`) || '{}') as Partial<Record<AgentPanelTab, number>>;
    return Math.max(0, Number(stored[tab]) || 0);
  } catch {
    return 0;
  }
}

export function writeCheckpointActiveConversationId(activeConversationId: string | null) {
  const current = readAgentSessionCheckpoint();
  writeCheckpoint({
    version: 1,
    activeConversationId,
    activeAgentTab: current?.activeAgentTab ?? 'chat',
      chatScroll: current?.chatScroll?.conversationId === activeConversationId
      || (activeConversationId === null && current?.chatScroll?.conversationId === AUTOSAVE_CONVERSATION_ID)
      ? current?.chatScroll
      : undefined,
    tabScroll: current?.tabScroll?.conversationId === activeConversationId
      || (activeConversationId === null && current?.tabScroll?.conversationId === AUTOSAVE_CONVERSATION_ID)
      ? current.tabScroll
      : undefined,
    updatedAt: Date.now(),
  });
}

export function writeAgentSessionViewport(input: {
  conversationId: string;
  activeAgentTab: AgentPanelTab;
  chatScroll?: ChatScrollCheckpoint;
  tabScrollTop?: Partial<Record<AgentPanelTab, number>>;
  sync?: boolean;
}) {
  if (input.tabScrollTop) {
    try {
      const key = `${TAB_SCROLL_STORAGE_PREFIX}${input.conversationId}`;
      const stored = JSON.parse(localStorage.getItem(key) || '{}') as Partial<Record<AgentPanelTab, number>>;
      localStorage.setItem(key, JSON.stringify({ ...stored, ...input.tabScrollTop }));
    } catch { /* Keep the active checkpoint path available when per-conversation storage is unavailable. */ }
  }
  let selectedConversationId: string | null = null;
  try {
    selectedConversationId = localStorage.getItem(LEGACY_ACTIVE_CONVERSATION_KEY);
  } catch {
    selectedConversationId = readAgentSessionCheckpoint()?.activeConversationId ?? null;
  }
  if (selectedConversationId && selectedConversationId !== input.conversationId) return;
  const current = readAgentSessionCheckpoint();
  const chatScroll = input.chatScroll
    ? { ...input.chatScroll, conversationId: input.conversationId }
    : current?.chatScroll?.conversationId === input.conversationId
      ? current.chatScroll
      : undefined;
  writeCheckpoint({
    version: 1,
    activeConversationId: input.conversationId === AUTOSAVE_CONVERSATION_ID
      ? null
      : selectedConversationId || input.conversationId,
    activeAgentTab: input.activeAgentTab,
    chatScroll,
    tabScroll: {
      conversationId: input.conversationId,
      positions: {
        ...(current?.tabScroll?.conversationId === input.conversationId ? current.tabScroll.positions : {}),
        ...input.tabScrollTop,
      },
    },
    updatedAt: Date.now(),
  }, input.sync === true);
}

export function promoteAgentSessionCheckpoint(fromId: string, toId: string) {
  if (!fromId || !toId || fromId === toId) return;
  const current = readAgentSessionCheckpoint();
  if (current) {
    writeCheckpoint({
      ...current,
      chatScroll: current.chatScroll?.conversationId === fromId
        ? { ...current.chatScroll, conversationId: toId }
        : current.chatScroll,
      tabScroll: current.tabScroll?.conversationId === fromId
        ? { ...current.tabScroll, conversationId: toId }
        : current.tabScroll,
      updatedAt: Date.now(),
    });
  }
  try {
    const sourceTabScrollKey = `${TAB_SCROLL_STORAGE_PREFIX}${fromId}`;
    const targetTabScrollKey = `${TAB_SCROLL_STORAGE_PREFIX}${toId}`;
    const sourceTabScroll = localStorage.getItem(sourceTabScrollKey);
    if (sourceTabScroll && !localStorage.getItem(targetTabScrollKey)) {
      localStorage.setItem(targetTabScrollKey, sourceTabScroll);
    }
    const sourceKey = `synapse:chat-scroll:${fromId}`;
    const targetKey = `synapse:chat-scroll:${toId}`;
    const source = localStorage.getItem(sourceKey);
    if (source && !localStorage.getItem(targetKey)) localStorage.setItem(targetKey, source);
  } catch {
    // The checkpoint mirror above remains available when localStorage is unavailable.
  }
}
