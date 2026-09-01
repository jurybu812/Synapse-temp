/**
 * DocxViewer Component
 * Uses mammoth to convert DOCX to HTML for rendering
 */
import { useState, useEffect } from 'react';
import { fileSystem } from '@/services/fileSystem';

interface DocxViewerProps {
  filePath: string;
  fileName: string;
}

export function DocxViewer({ filePath, fileName }: DocxViewerProps) {
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const arrayBuffer = await fileSystem.readBinary(filePath);
        const mammoth = await import('mammoth');
        const DOMPurify = (await import('dompurify')).default;
        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (cancelled) return;
        setHtml(DOMPurify.sanitize(result.value));
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || '加载 DOCX 失败');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  if (loading) {
    return <div className="docx-viewer-loading">📄 加载文档中...</div>;
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
    <div className="docx-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-filename">📝 {fileName}</span>
      </div>
      <div
        className="docx-content markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
