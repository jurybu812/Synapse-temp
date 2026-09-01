import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'progress';
  title: string;
  message?: string;
  duration?: number;      // ms, 0 = persist
  timestamp: number;
  progress?: number;      // 0-100 for progress type
  dismissible?: boolean;
}

interface NotificationsState {
  items: Notification[];
}

const initialState: NotificationsState = {
  items: [],
};

let notifCounter = 0;

export const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    addNotification(state, action: PayloadAction<Omit<Notification, 'timestamp' | 'id'> & { id?: string }>) {
      const id = action.payload.id ?? `notif-${++notifCounter}`;
      state.items.push({
        ...action.payload,
        id,
        timestamp: Date.now(),
        dismissible: action.payload.dismissible ?? true,
      });
    },
    updateNotification(state, action: PayloadAction<{ id: string } & Partial<Notification>>) {
      const idx = state.items.findIndex(n => n.id === action.payload.id);
      if (idx !== -1) {
        state.items[idx] = { ...state.items[idx], ...action.payload };
      }
    },
    removeNotification(state, action: PayloadAction<string>) {
      state.items = state.items.filter(n => n.id !== action.payload);
    },
    clearNotifications(state) {
      state.items = [];
    },
  },
});

export const { addNotification, updateNotification, removeNotification, clearNotifications } = notificationsSlice.actions;

