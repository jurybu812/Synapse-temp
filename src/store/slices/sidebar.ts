import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

type SidebarView = 'explorer' | 'synopsis' | 'search' | 'settings' | 'history';

interface SidebarState {
  activeView: SidebarView;
}

const initialState: SidebarState = {
  activeView: 'explorer',
};

export const sidebarSlice = createSlice({
  name: 'sidebar',
  initialState,
  reducers: {
    setActiveView(state, action: PayloadAction<SidebarView>) {
      state.activeView = action.payload;
    },
  },
});

export const { setActiveView } = sidebarSlice.actions;
