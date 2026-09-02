import { useCallback, useEffect, useState } from 'react';
import { Brain, Copy, Minus, Square, WifiOff, X } from 'lucide-react';
import { desktopBridgeState, platform } from '@/platform';

export function WindowTitleBar() {
  const electronShell = desktopBridgeState !== 'web';
  const [maximized, setMaximized] = useState(false);

  const refreshMaximized = useCallback(async () => {
    try {
      setMaximized(await platform.window.isMaximized?.() ?? false);
    } catch {
      setMaximized(false);
    }
  }, []);

  useEffect(() => {
    if (!electronShell) return;
    void refreshMaximized();
    const handleResize = () => void refreshMaximized();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [electronShell, refreshMaximized]);

  if (!electronShell) return null;

  return (
    <div className={`window-titlebar ${desktopBridgeState === 'ready' ? '' : 'bridge-degraded'}`}>
      <div className="window-titlebar-brand">
        <span className="window-titlebar-logo"><Brain size={15} /></span>
        <span className="window-titlebar-name">Synapse</span>
      </div>
      {desktopBridgeState === 'degraded' && (
        <div className="window-titlebar-bridge-warning" role="status">
          <WifiOff size={12} /> 桌面组件版本不一致
        </div>
      )}
      <div className="window-titlebar-spacer" />
      <div className="window-titlebar-controls" aria-label="窗口控制">
        <button
          type="button"
          className="window-control-btn"
          title="最小化"
          aria-label="最小化窗口"
          onClick={() => platform.window.minimize()}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-control-btn"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
          onClick={() => {
            platform.window.maximize();
            window.setTimeout(() => void refreshMaximized(), 120);
          }}
        >
          {maximized
            ? <Copy size={13} aria-hidden="true" />
            : <Square size={13} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="window-control-btn window-control-close"
          title="关闭"
          aria-label="关闭窗口"
          onClick={() => platform.window.close()}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
