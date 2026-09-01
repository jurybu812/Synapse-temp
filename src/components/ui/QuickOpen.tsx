import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Search, FileText, X } from 'lucide-react';
import { fileSystem, type FileNode } from '@/services/fileSystem';

interface QuickOpenProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export function QuickOpen({ isOpen, onClose, onSelect }: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Flatten file tree
      fileSystem.getWorkspaceTree().then(tree => {
        const flat: FileNode[] = [];
        const walk = (node: FileNode) => {
          if (node.type === 'file') flat.push(node);
          if (node.children) node.children.forEach(walk);
        };
        walk(tree);
        setFiles(flat);
      });
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!query) return files.slice(0, 20);
    const lower = query.toLowerCase();
    return files.filter(f => f.name.toLowerCase().includes(lower)).slice(0, 20);
  }, [query, files]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex].path);
        onClose();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [filtered, selectedIndex, onSelect, onClose]);

  if (!isOpen) return null;

  return (
    <div className="quick-open-overlay" onClick={onClose}>
      <div className="quick-open glass-panel" onClick={e => e.stopPropagation()}>
        <div className="quick-open-input-row">
          <Search size={16} className="quick-open-icon" />
          <input
            ref={inputRef}
            className="quick-open-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="输入文件名搜索..."
          />
          <button className="quick-open-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="quick-open-results">
          {filtered.length === 0 ? (
            <div className="quick-open-empty">无匹配文件</div>
          ) : (
            filtered.map((file, i) => (
              <div
                key={file.path}
                className={`quick-open-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => { onSelect(file.path); onClose(); }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <FileText size={14} />
                <span className="quick-open-name">{file.name}</span>
                <span className="quick-open-path">{file.path}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
