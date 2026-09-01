import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Terminal, Settings, FileText, Sun, FolderOpen, MessageSquare, Keyboard } from 'lucide-react';

interface Command {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  icon?: React.ElementType;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(query.toLowerCase()) ||
    cmd.category.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && filtered[selectedIdx]) {
      filtered[selectedIdx].action();
      onClose();
    }
  }, [filtered, selectedIdx, onClose]);

  if (!isOpen) return null;

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="cmd-input-row">
          <Search size={16} />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="输入命令..."
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIdx(0); }}
          />
        </div>
        <div className="cmd-list">
          {filtered.length === 0 ? (
            <div className="cmd-empty">没有匹配的命令</div>
          ) : (
            filtered.map((cmd, i) => {
              const Icon = cmd.icon || Terminal;
              return (
                <div
                  key={cmd.id}
                  className={`cmd-item ${i === selectedIdx ? 'selected' : ''}`}
                  onClick={() => { cmd.action(); onClose(); }}
                  onMouseEnter={() => setSelectedIdx(i)}
                >
                  <Icon size={14} />
                  <span className="cmd-label">{cmd.label}</span>
                  <span className="cmd-category">{cmd.category}</span>
                  {cmd.shortcut && <kbd className="cmd-shortcut">{cmd.shortcut}</kbd>}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// 预定义命令列表
export function useDefaultCommands(actions: {
  toggleSidebar: () => void;
  toggleTheme: () => void;
  openSettings: () => void;
  newFile: () => void;
  openWorkspace: () => void;
}): Command[] {
  return [
    { id: 'toggle-sidebar', label: '切换侧边栏', category: '布局', shortcut: 'Ctrl+B', icon: FolderOpen, action: actions.toggleSidebar },
    { id: 'toggle-theme', label: '切换主题', category: '外观', shortcut: 'Ctrl+Shift+T', icon: Sun, action: actions.toggleTheme },
    { id: 'open-settings', label: '打开设置', category: '偏好', shortcut: 'Ctrl+,', icon: Settings, action: actions.openSettings },
    { id: 'new-file', label: '新建文件', category: '文件', shortcut: 'Ctrl+N', icon: FileText, action: actions.newFile },
    { id: 'open-workspace', label: '打开工作区', category: '文件', icon: FolderOpen, action: actions.openWorkspace },
    { id: 'focus-chat', label: '聚焦到 AI 对话', category: '导航', icon: MessageSquare, action: () => {} },
    { id: 'keyboard-shortcuts', label: '键盘快捷键', category: '帮助', icon: Keyboard, action: () => {} },
  ];
}
