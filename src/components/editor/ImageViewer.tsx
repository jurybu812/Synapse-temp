import { useState, useCallback, useRef } from 'react';
import { ZoomIn, ZoomOut, RotateCw, Maximize2 } from 'lucide-react';

interface ImageViewerProps {
  src: string;
  fileName: string;
}

export function ImageViewer({ src, fileName }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const zoomIn = useCallback(() => setScale(s => Math.min(s * 1.25, 5)), []);
  const zoomOut = useCallback(() => setScale(s => Math.max(s / 1.25, 0.1)), []);
  const rotate = useCallback(() => setRotation(r => (r + 90) % 360), []);
  const resetView = useCallback(() => { setScale(1); setRotation(0); }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
  }, [zoomIn, zoomOut]);

  return (
    <div className="image-viewer" ref={containerRef} onWheel={handleWheel}>
      <div className="viewer-toolbar">
        <span className="viewer-filename">{fileName}</span>
        <div className="viewer-controls">
          <button onClick={zoomOut} title="缩小"><ZoomOut size={14} /></button>
          <span className="viewer-scale">{Math.round(scale * 100)}%</span>
          <button onClick={zoomIn} title="放大"><ZoomIn size={14} /></button>
          <button onClick={rotate} title="旋转"><RotateCw size={14} /></button>
          <button onClick={resetView} title="重置"><Maximize2 size={14} /></button>
        </div>
      </div>
      <div className="image-canvas">
        <img
          src={src}
          alt={fileName}
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            transition: 'transform 0.2s ease',
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}
