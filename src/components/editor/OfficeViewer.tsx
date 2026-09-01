import { useEffect, useState } from 'react';
import { PdfViewer } from '@/components/editor/PdfViewer';
import { fileSystem } from '@/services/fileSystem';

interface OfficeViewerProps {
  filePath: string;
  fileName: string;
}

export function OfficeViewer({ filePath, fileName }: OfficeViewerProps) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [convertedPath, setConvertedPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let tempDir = '';
      try {
        setLoading(true);
        setError('');
        setData(null);
        setConvertedPath('');
        const converted = await fileSystem.convertOfficeToPdf(filePath);
        tempDir = converted.tempDir || '';
        const binary = await fileSystem.readBinary(converted.outputPath);
        if (!cancelled) {
          setConvertedPath(converted.outputPath);
          setData(binary);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Office 文件转换失败');
      } finally {
        if (tempDir) {
          await fileSystem.cleanupTempPath(tempDir).catch(() => undefined);
        }
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  if (loading) {
    return (
      <div className="office-viewer-loading">
        <span>📑</span>
        <p>正在转换 Office 文件...</p>
        <small>{fileName}</small>
      </div>
    );
  }

  if (error) {
    return (
      <div className="office-viewer-error">
        <span>⚠️</span>
        <p>无法预览 Office 文件</p>
        <small>{fileName}</small>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="office-viewer-error">
        <span>⚠️</span>
        <p>Office 转换未生成可读内容</p>
        <small>{fileName}</small>
      </div>
    );
  }

  return (
    <div className="office-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-filename">📑 {fileName}</span>
        <span className="viewer-muted">已转换为 PDF 预览</span>
        {convertedPath && <span className="viewer-muted" title={convertedPath}>临时预览</span>}
      </div>
      <PdfViewer data={data} currentPage={1} />
    </div>
  );
}
