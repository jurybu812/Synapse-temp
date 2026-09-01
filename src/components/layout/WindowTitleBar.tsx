import { Brain, Minus, Square, X } from 'lucide-react';
import { isElectron, platform } from '@/platform';
import { useEffect, useState } from 'react';

export function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    void platform.window.isMaximized?.().then(value => {
      if (!cancelled) setMaximized(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isElectron) return null;

  const refreshMaximized = () => {
    void platform.window.isMaximized?.().then(setMaximized).catch(() => {});
  };

  return (
    <div className="window-titlebar">
      <div className="window-titlebar-brand">
        <span className="window-titlebar-logo"><Brain size={15} /></span>
        <span className="window-titlebar-name">Synapse</span>
      </div>
      <div className="window-titlebar-spacer" />
      <div className="window-titlebar-controls">
        <button
          className="window-control-btn"
          type="button"
          aria-label="最小化"
          title="最小化"
          onClick={() => platform.window.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          className="window-control-btn"
          type="button"
          aria-label={maximized ? '还原' : '最大化'}
          title={maximized ? '还原' : '最大化'}
          onClick={() => {
            platform.window.maximize();
            window.setTimeout(refreshMaximized, 120);
          }}
        >
          <Square size={12} />
        </button>
        <button
          className="window-control-btn close"
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={() => platform.window.close()}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
