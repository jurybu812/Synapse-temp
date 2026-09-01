import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

type ThemeMode = 'dark' | 'light' | 'system';
type CarouselMode = 'off' | 'sequential' | 'random';

interface BackgroundConfig {
  type: 'image' | 'gradient' | 'solid';
  value: string;
  opacity: number;
  blur: number;
}

interface ThemeState {
  mode: ThemeMode;
  background: BackgroundConfig;
  accentColor: string;
  // Carousel support
  backgroundList: string[]; // multiple image URLs
  carouselMode: CarouselMode;
  carouselInterval: number; // seconds
  currentBgIndex: number;
}

const initialState: ThemeState = {
  mode: 'dark',
  background: {
    type: 'solid',
    value: '',
    opacity: 0.7,
    blur: 2,
  },
  accentColor: '#7c3aed',
  backgroundList: [],
  carouselMode: 'off',
  carouselInterval: 30,
  currentBgIndex: 0,
};

export const themeSlice = createSlice({
  name: 'theme',
  initialState,
  reducers: {
    setThemeMode(state, action: PayloadAction<ThemeMode>) {
      state.mode = action.payload;
    },
    setBackground(state, action: PayloadAction<Partial<BackgroundConfig>>) {
      Object.assign(state.background, action.payload);
    },
    setAccentColor(state, action: PayloadAction<string>) {
      state.accentColor = action.payload;
    },
    // Carousel actions
    setBackgroundList(state, action: PayloadAction<string[]>) {
      state.backgroundList = action.payload;
      if (action.payload.length > 0) {
        state.background.type = 'image';
        state.background.value = action.payload[0];
        state.currentBgIndex = 0;
      }
    },
    addBackgroundImage(state, action: PayloadAction<string>) {
      state.backgroundList.push(action.payload);
      if (state.backgroundList.length === 1) {
        state.background.type = 'image';
        state.background.value = action.payload;
      }
    },
    removeBackgroundImage(state, action: PayloadAction<number>) {
      state.backgroundList.splice(action.payload, 1);
      if (state.backgroundList.length === 0) {
        state.background.type = 'solid';
        state.background.value = '';
      } else if (state.currentBgIndex >= state.backgroundList.length) {
        state.currentBgIndex = 0;
        state.background.value = state.backgroundList[0];
      }
    },
    setCarouselMode(state, action: PayloadAction<CarouselMode>) {
      state.carouselMode = action.payload;
    },
    setCarouselInterval(state, action: PayloadAction<number>) {
      state.carouselInterval = action.payload;
    },
    nextBackground(state) {
      if (state.backgroundList.length < 2) return;
      if (state.carouselMode === 'random') {
        let next = Math.floor(Math.random() * state.backgroundList.length);
        while (next === state.currentBgIndex && state.backgroundList.length > 1) {
          next = Math.floor(Math.random() * state.backgroundList.length);
        }
        state.currentBgIndex = next;
      } else {
        state.currentBgIndex = (state.currentBgIndex + 1) % state.backgroundList.length;
      }
      state.background.type = 'image';
      state.background.value = state.backgroundList[state.currentBgIndex];
    },
  },
});

export const { 
  setThemeMode, setBackground, setAccentColor,
  setBackgroundList, addBackgroundImage, removeBackgroundImage,
  setCarouselMode, setCarouselInterval, nextBackground,
} = themeSlice.actions;
