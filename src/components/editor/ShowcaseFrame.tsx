import { RefreshCw, Maximize2, ExternalLink, Code2 } from 'lucide-react';
import { useState, useRef, useCallback } from 'react';
import { getPlatform } from '@/platform';

interface ShowcaseFrameProps {
  url: string;
  title: string;
}

export function ShowcaseFrame({ url, title }: ShowcaseFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleRefresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = url;
    }
  }, [url]);

  const handleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);

  const handleOpenExternal = useCallback(() => {
    void getPlatform().platform.openExternal(url).catch(error => {
      console.warn('[ShowcaseFrame] 无法在外部浏览器中打开:', error);
    });
  }, [url]);

  return (
    <div className={`showcase-container ${isFullscreen ? 'fullscreen' : ''}`}>
      <div className="showcase-toolbar">
        <span className="showcase-title">
          🖥 Showcase: {title}
        </span>
        <div className="showcase-actions">
          <button onClick={handleRefresh} title="刷新">
            <RefreshCw size={14} />
          </button>
          <button onClick={handleFullscreen} title={isFullscreen ? '退出全屏' : '全屏'}>
            <Maximize2 size={14} />
          </button>
          <button onClick={handleOpenExternal} title="在浏览器中打开">
            <ExternalLink size={14} />
          </button>
          <button title="查看源码">
            <Code2 size={14} />
          </button>
        </div>
      </div>
      <iframe
        ref={iframeRef}
        src={url}
        sandbox="allow-scripts"
        className="showcase-iframe"
        title={`Showcase: ${title}`}
      />
    </div>
  );
}
