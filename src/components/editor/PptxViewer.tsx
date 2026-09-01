import { useEffect, useState } from 'react';
import { fileSystem } from '@/services/fileSystem';

interface PptxSlideText {
  number: number;
  lines: string[];
}

interface PptxViewerProps {
  filePath: string;
  fileName: string;
}

export function PptxViewer({ filePath, fileName }: PptxViewerProps) {
  const [slides, setSlides] = useState<PptxSlideText[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const JSZip = (await import('jszip')).default;
        const data = await fileSystem.readBinary(filePath);
        const zip = await JSZip.loadAsync(data);
        const slideFiles = Object.keys(zip.files)
          .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => getSlideNumber(a) - getSlideNumber(b));

        const nextSlides: PptxSlideText[] = [];
        for (const slidePath of slideFiles) {
          const xml = await zip.files[slidePath].async('text');
          nextSlides.push({
            number: getSlideNumber(slidePath),
            lines: extractSlideText(xml),
          });
        }
        if (!cancelled) setSlides(nextSlides);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'PPTX 加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  if (loading) {
    return <div className="docx-viewer-loading">📊 加载 PPTX 中...</div>;
  }

  if (error) {
    return (
      <div className="docx-viewer-error">
        <p>⚠️ {error}</p>
        <p className="error-hint">{fileName}</p>
      </div>
    );
  }

  return (
    <div className="pptx-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-filename">📊 {fileName}</span>
        <span className="viewer-muted">{slides.length} 张幻灯片文本预览</span>
      </div>
      <div className="pptx-outline">
        {slides.length === 0 ? (
          <div className="unsupported-viewer">
            <p>未提取到可读文本</p>
            <p className="placeholder-hint">当前阶段提供 PPTX 文本大纲预览，完整版式渲染保留为后续扩展。</p>
          </div>
        ) : slides.map(slide => (
          <section className="pptx-slide-card" key={slide.number}>
            <h3>Slide {slide.number}</h3>
            {slide.lines.length === 0 ? (
              <p className="placeholder-hint">此页没有可提取文本</p>
            ) : (
              <ul>
                {slide.lines.map((line, index) => <li key={`${slide.number}-${index}`}>{line}</li>)}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function getSlideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] || '0');
}

function extractSlideText(xml: string): string[] {
  const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
  return matches
    .map(item => decodeXml(item.replace(/<[^>]+>/g, '').trim()))
    .filter(Boolean);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
