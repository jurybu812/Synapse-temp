/**
 * useThemeEffect — 将 Redux theme 状态实时映射到 CSS 变量和 DOM
 */
import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import { getWallpaperUrl, nextBackgroundImage } from '@/store/slices/agentSettings';

export function useThemeEffect() {
  const theme = useAppSelector((s: RootState) => s.theme);
  const settings = useAppSelector((s: RootState) => s.settings);
  const background = useAppSelector((s: RootState) => s.agentSettings.backgroundSettings);
  const dispatch = useAppDispatch();

  useEffect(() => {
    const root = document.documentElement;

    // 1. 主题模式 (dark / light)
    const systemLight = window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: light)').matches
      : false;
    const resolvedTheme = theme.mode === 'system' ? (systemLight ? 'light' : 'dark') : theme.mode;
    root.dataset.theme = resolvedTheme;
    document.body.dataset.theme = resolvedTheme;
    root.style.setProperty('--app-font-size', `${settings.fontSize ?? 14}px`);

    // 2. 背景图
    const currentImage = getWallpaperUrl(background.images[background.selectedIndex]);
    const wallpaperActive = background.enabled && !!currentImage;
    if (wallpaperActive) {
      root.dataset.wallpaper = 'enabled';
      document.body.dataset.wallpaper = 'enabled';
    } else {
      delete root.dataset.wallpaper;
      delete document.body.dataset.wallpaper;
    }
    const bgEls = document.querySelectorAll<HTMLElement>('.app-background');
    bgEls.forEach(bgEl => {
      if (wallpaperActive) {
        bgEl.style.backgroundImage = `url(${currentImage})`;
        bgEl.style.backgroundSize = 'cover';
        bgEl.style.backgroundPosition = 'center';
        bgEl.style.opacity = String(background.opacity);
        bgEl.style.filter = `blur(${background.blur}px)`;
        bgEl.style.transform = background.blur > 0 ? 'scale(1.04)' : 'scale(1)';
        bgEl.dataset.transition = background.transitionEffect;
      } else {
        bgEl.style.backgroundImage = 'none';
        bgEl.style.opacity = '1';
        bgEl.style.filter = 'none';
        bgEl.style.transform = 'scale(1)';
        delete bgEl.dataset.transition;
      }
    });

    // 3. 磨砂参数
    root.style.setProperty('--glass-blur', `${Math.max(0, background.blur)}px`);
    root.style.setProperty('--glass-opacity', String(background.panelOpacity));
    root.style.setProperty('--glass-bg', `rgba(var(--syn-bg-surface-rgb), ${background.panelOpacity})`);

    // 4. 主题色
    if (theme.accentColor) {
      const rgb = hexToRgb(theme.accentColor);
      root.style.setProperty('--syn-accent', theme.accentColor);
      if (rgb) root.style.setProperty('--syn-accent-rgb', rgb);
      root.style.setProperty('--syn-primary', theme.accentColor);
      root.style.setProperty('--syn-primary-hover', theme.accentColor);
      root.style.setProperty('--syn-primary-light', theme.accentColor);
      root.style.setProperty('--syn-border-focused', `color-mix(in srgb, ${theme.accentColor} 60%, transparent)`);
    }
  }, [theme.mode, theme.accentColor, settings.fontSize, background]);

  useEffect(() => {
    if (!background.enabled || background.displayMode === 'static' || background.images.length < 2) return;
    const timer = window.setInterval(() => {
      dispatch(nextBackgroundImage());
    }, Math.max(10, background.carouselInterval || 300) * 1000);
    return () => window.clearInterval(timer);
  }, [dispatch, background.enabled, background.displayMode, background.carouselInterval, background.images.length]);
}

function hexToRgb(hex: string): string | null {
  const normalized = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const value = Number.parseInt(normalized, 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}
