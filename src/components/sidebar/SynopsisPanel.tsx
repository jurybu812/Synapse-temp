import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Clock, AlertCircle, RefreshCw } from 'lucide-react';
import { fileSystem, type FileNode } from '@/services/fileSystem';
import { useAppDispatch } from '@/store/hooks';
import { addNotification } from '@/store/slices/notifications';

interface SynopsisFile {
  name: string;
  path: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  progress?: number;
  summary?: string;
  chunks?: number;
}

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'pptx', 'docx', 'md', 'txt']);

export function SynopsisPanel() {
  const dispatch = useAppDispatch();
  const [files, setFiles] = useState<SynopsisFile[]>([]);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    const tree = await fileSystem.getWorkspaceTree();
    const candidates: SynopsisFile[] = [];
    const walk = (node: FileNode) => {
      if (node.type === 'file' && SUPPORTED_EXTENSIONS.has((node.extension || '').toLowerCase())) {
        candidates.push({
          name: node.name,
          path: node.path,
          status: 'pending',
        });
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    setFiles(prev => {
      const stateByPath = new Map(prev.map(f => [f.path, f]));
      return candidates.map(file => ({ ...file, ...(stateByPath.get(file.path) || {}) }));
    });
  }, []);

  useEffect(() => {
    void loadFiles();
    const unsub = fileSystem.subscribe(() => { void loadFiles(); });
    return () => { unsub(); };
  }, [loadFiles]);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'processing': return <Clock size={14} className="synopsis-status-processing" />;
      case 'error': return <AlertCircle size={14} className="synopsis-status-error" />;
      case 'done': return <FileText size={14} className="synopsis-status-done" />;
      default: return <FileText size={14} className="synopsis-status-pending" />;
    }
  };

  const handleGenerate = (path: string) => {
    setFiles(prev => prev.map(f => f.path === path ? { ...f, status: 'pending' } : f));
    dispatch(addNotification({
      type: 'info',
      title: '知识概要',
      message: '真实概要生成管线即将接入；当前仅展示工作区候选文件。',
    }));
  };

  const handleGenerateAll = () => {
    dispatch(addNotification({
      type: 'info',
      title: '知识概要',
      message: '批量生成即将支持；当前不会再显示模拟完成状态。',
    }));
  };

  const doneCount = useMemo(() => files.filter(f => f.status === 'done').length, [files]);
  const pendingCount = useMemo(() => files.filter(f => f.status === 'pending').length, [files]);

  return (
    <div className="synopsis-panel">
      <div className="synopsis-header">
        <div className="synopsis-stats">
          <span className="synopsis-stat done">✅ {doneCount} 已完成</span>
          <span className="synopsis-stat pending">⏳ {pendingCount} 待生成</span>
        </div>
        {files.length > 0 && (
          <button className="synopsis-generate-all" onClick={handleGenerateAll}>
            <RefreshCw size={14} /> 全部生成
          </button>
        )}
      </div>

      <div className="synopsis-file-list">
        {files.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--syn-text-muted)', fontSize: 12, textAlign: 'center' }}>
            当前工作区暂无可生成概要的文档文件
          </div>
        ) : files.map(file => (
          <div key={file.path} className="synopsis-file-item">
            <div
              className="synopsis-file-header"
              onClick={() => setExpandedFile(expandedFile === file.path ? null : file.path)}
            >
              {statusIcon(file.status)}
              <span className="synopsis-file-name">{file.name}</span>
              {file.chunks && <span className="synopsis-chunks">{file.chunks} 分片</span>}
              {file.status === 'pending' && (
                <button
                  className="synopsis-gen-btn"
                  onClick={(e) => { e.stopPropagation(); handleGenerate(file.path); }}
                >
                  生成
                </button>
              )}
              {file.status === 'processing' && (
                <div className="synopsis-progress">
                  <div className="synopsis-progress-bar" style={{ width: `${file.progress || 0}%` }} />
                </div>
              )}
            </div>
            {expandedFile === file.path && (
              <div className="synopsis-file-summary">
                <p>{file.summary || '尚未生成概要。'}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
