import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { readCheckpointActiveConversationId } from '@/services/agentSessionCheckpoint';

export const ACTIVE_CONVERSATION_KEY = 'synapse_active_conversation_id';

function loadActiveConversationId(): string | null {
  try {
    return readCheckpointActiveConversationId() ?? localStorage.getItem(ACTIVE_CONVERSATION_KEY);
  } catch {
    return null;
  }
}

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: number;
  messageCount: number;
  model: string;
  archived?: boolean;
  tags?: string[];
  // M4-2-S4 工作区归属：以工作区 path 为稳定身份键（null = Global 无归属）。左右栏共用此数据源，
  //   S6 左侧栏 / S7 右侧栏浮层据此显示工作区小标记并按归属三态过滤。listConversationSummaries
  //   返回的 summary 已带 workspacePath（缺省/legacy 为 null=Global），dispatch 进来后两栏即时一致。
  workspacePath?: string | null;
}

interface ConversationHistoryState {
  conversations: ConversationSummary[];
  selectedId: string | null;
}

const initialState: ConversationHistoryState = {
  conversations: [],
  selectedId: loadActiveConversationId(),
};

export const conversationHistorySlice = createSlice({
  name: 'conversationHistory',
  initialState,
  reducers: {
    addConversation(state, action: PayloadAction<ConversationSummary>) {
      state.conversations.unshift(action.payload);
    },
    removeConversation(state, action: PayloadAction<string>) {
      state.conversations = state.conversations.filter(c => c.id !== action.payload);
    },
    updateConversation(state, action: PayloadAction<Partial<ConversationSummary> & { id: string }>) {
      const idx = state.conversations.findIndex(c => c.id === action.payload.id);
      if (idx >= 0) Object.assign(state.conversations[idx], action.payload);
    },
    setSelectedId(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
    },
    setConversations(state, action: PayloadAction<ConversationSummary[]>) {
      state.conversations = action.payload;
    },
  },
});

export const {
  addConversation, removeConversation, updateConversation,
  setSelectedId, setConversations,
} = conversationHistorySlice.actions;
