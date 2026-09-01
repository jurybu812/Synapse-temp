/**
 * useResolvedTheme — 返回当前【已解析】的主题（'dark' | 'light'）。
 *
 * 背景：Redux `theme.mode` 可能是 'system'，真正落到 DOM 的 data-theme 由 useThemeEffect
 * 依据 prefers-color-scheme 解析。需要在「组件渲染逻辑」里（而非 CSS）按主题分支时（典型：
 * react-syntax-highlighter 的 style 是 JS 对象，无法用 CSS 变量切换），用本 hook 取已解析主题。
 *
 * - mode === 'system' 时跟随系统，并监听 prefers-color-scheme 变化实时重渲染。
 * - 与 useThemeEffect 的解析口径保持一致（systemLight ? 'light' : 'dark'）。
 */
import { useEffect, useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';

export type ResolvedTheme = 'dark' | 'light';

export function useResolvedTheme(): ResolvedTheme {
  const mode = useAppSelector((s: RootState) => s.theme.mode);

  const getSystemLight = () =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: light)').matches
      : false;

  const [systemLight, setSystemLight] = useState<boolean>(getSystemLight);

  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => setSystemLight(e.matches);
    // 同步一次（避免挂载后系统已变但状态未更新）
    setSystemLight(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [mode]);

  if (mode === 'system') return systemLight ? 'light' : 'dark';
  return mode === 'light' ? 'light' : 'dark';
}
