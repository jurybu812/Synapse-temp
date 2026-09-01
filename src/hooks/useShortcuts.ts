import { useEffect, useRef } from 'react';

interface ShortcutDef {
  key: string;        // e.g. 'b', 'p', ','
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description: string;
}

/**
 * 全局快捷键管理 Hook
 * 自动绑定/解绑，防止输入框内触发
 */
export function useShortcuts(shortcuts: ShortcutDef[]) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 忽略在输入框中的按键
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) {
        return;
      }

      for (const s of shortcutsRef.current) {
        const ctrlMatch = (s.ctrl ?? false) === (e.ctrlKey || e.metaKey);
        const shiftMatch = (s.shift ?? false) === e.shiftKey;
        const altMatch = (s.alt ?? false) === e.altKey;
        const keyMatch = e.key.toLowerCase() === s.key.toLowerCase();

        if (ctrlMatch && shiftMatch && altMatch && keyMatch) {
          e.preventDefault();
          e.stopPropagation();
          s.action();
          return;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []); // 只绑定一次，通过 ref 读取最新 shortcuts
}
