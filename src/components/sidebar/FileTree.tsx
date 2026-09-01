import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { ChevronRight, ChevronDown, Copy, FolderOpen, Edit, Trash2, FilePlus, FolderPlus } from 'lucide-react';
import type { FileNode } from '@/services/fileSystem';
import { fileSystem } from '@/services/fileSystem';
import { getFileIcon, getFolderIcon } from '@/services/fileIcons';
import { ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { useAppDispatch } from '@/store/hooks';
import { useAppSelector } from '@/store/hooks';
import { addNotification } from '@/store/slices/notifications';
import { closeTab } from '@/store/slices/editorTabs';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';
import type { RootState } from '@/store';
import { isElectron } from '@platform/index';
import { confirmAction, promptAction } from '@/services/confirmationCoordinator';

interface ContextMenuState {
  x: number;
  y: number;
  mode: 'node' | 'blank';
  node: FileNode;
}

function findTreeNode(node: FileNode, path: string): FileNode | null {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findTreeNode(child, path);
    if (found) return found;
  }
  return null;
}

function collectDescendantFilePaths(node: FileNode): string[] {
  if (node.type === 'file') return [node.path];
  const paths: string[] = [];
  for (const child of node.children ?? []) {
    paths.push(...collectDescendantFilePaths(child));
  }
  return paths;
}

/**
 * ★ M4-3-S5：文件夹优先排序（主人决策）。
 *   规则：目录排在文件之前（type: directory < file）；组内按名称做 zh localeCompare
 *   （numeric=true 让 file2 < file10 自然序、sensitivity=base 忽略大小写差异）。
 *   返回新数组副本，绝不原地 mutate 传入的 FileNode[]（避免污染 store / fileSystem 原始结构）。
 */
function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh', { numeric: true, sensitivity: 'base' });
  });
}

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  /** ★ UI-6：per-workspace 持久化的展开路径集合（默认空=全收起）。 */
  expandedPaths: Set<string>;
  /** ★ UI-6：切换某文件夹展开/收起（主组件落 localStorage）。 */
  onToggleExpand: (path: string) => void;
  onFileClick?: (node: FileNode) => void;
  onContextMenu?: (e: React.MouseEvent, node: FileNode) => void;
  editingPath?: string | null;
  editingName?: string;
  onEditNameChange?: (name: string) => void;
  onEditSubmit?: () => void;
  onEditCancel?: () => void;
}

function FileTreeItem({ node, depth, expandedPaths, onToggleExpand, onFileClick, onContextMenu, editingPath, editingName, onEditNameChange, onEditSubmit, onEditCancel }: FileTreeItemProps) {
  // ★ UI-6：展开态由主组件 per-workspace 持久化集合决定（默认全收起、记住每个文件夹的展开/收起状态）。
  const expanded = expandedPaths.has(node.path);
  const isDir = node.type === 'directory';
  const isEditing = editingPath === node.path;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (isDir) {
      onToggleExpand(node.path);
    } else {
      onFileClick?.(node);
    }
  }, [isDir, node, onFileClick, onToggleExpand]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(e, node);
  }, [node, onContextMenu]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const current = e.currentTarget;
    const tree = current.closest<HTMLElement>('[role="tree"]');
    const visibleItems = tree ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')] : [];
    const currentIndex = visibleItems.indexOf(current);
    const focusAt = (index: number) => visibleItems[Math.max(0, Math.min(index, visibleItems.length - 1))]?.focus();
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusAt(currentIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(currentIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(visibleItems.length - 1);
    } else if (e.key === 'ArrowRight' && isDir) {
      e.preventDefault();
      if (!expanded) onToggleExpand(node.path);
      else current.nextElementSibling?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isDir && expanded) {
        onToggleExpand(node.path);
      } else {
        const group = current.parentElement;
        if (group?.getAttribute('role') === 'group') {
          (group.previousElementSibling as HTMLElement | null)?.focus();
        }
      }
    }
  }, [expanded, handleClick, isDir, node.path, onToggleExpand]);

  return (
    <>
      <div
        className={`file-tree-item ${isDir ? 'is-dir' : 'is-file'}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        title={node.path}
        role="treeitem"
        tabIndex={0}
        aria-level={depth + 1}
        aria-expanded={isDir ? expanded : undefined}
        aria-label={`${isDir ? '文件夹' : '文件'} ${node.name}`}
      >
        <span className="tree-chevron">
          {isDir ? (
            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span style={{ width: 14 }} />
          )}
        </span>
        <span
          className="tree-icon"
          dangerouslySetInnerHTML={{
            __html: isDir ? getFolderIcon(expanded) : getFileIcon(node.extension),
          }}
        />
        {isEditing ? (
          <input
            ref={inputRef}
            className="tree-rename-input"
            value={editingName || ''}
            onChange={e => onEditNameChange?.(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onEditSubmit?.();
              if (e.key === 'Escape') onEditCancel?.();
            }}
            onBlur={() => onEditCancel?.()}
            autoFocus
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="tree-name">{node.name}</span>
        )}
        {!isDir && node.size && !isEditing && (
          <span className="tree-size">{fileSystem.formatFileSize(node.size)}</span>
        )}
      </div>
      {isDir && expanded && node.children && (
        <div className="tree-children" role="group">
          {sortNodes(node.children).map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              editingPath={editingPath}
              editingName={editingName}
              onEditNameChange={onEditNameChange}
              onEditSubmit={onEditSubmit}
              onEditCancel={onEditCancel}
            />
          ))}
        </div>
      )}
    </>
  );
}

interface FileTreeProps {
  root: FileNode;
  onFileClick?: (node: FileNode) => void;
  onRefresh?: () => void;
  onOpenWorkspace?: () => Promise<void> | void;
  onClearWorkspace?: () => Promise<void> | void;
}

export function FileTree({ root, onFileClick, onRefresh, onOpenWorkspace, onClearWorkspace }: FileTreeProps) {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // ★ M4-3-S5：root 顶层 children 也走文件夹优先排序（不原地 mutate root.children）。
  const sortedRootChildren = useMemo(() => sortNodes(root.children ?? []), [root.children]);

  // ★ UI-6：文件夹展开态——默认全收起 + per-workspace 持久化（记住每个文件夹展开/收起）。
  //   key 按 root.path 区分工作区；切工作区时按新 key 重载（下方 useEffect）。
  const expandStorageKey = root.path ? `synapse-filetree-expanded:${root.path}` : '';
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    try {
      const raw = expandStorageKey ? localStorage.getItem(expandStorageKey) : null;
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  useEffect(() => {
    try {
      const raw = expandStorageKey ? localStorage.getItem(expandStorageKey) : null;
      setExpandedPaths(raw ? new Set<string>(JSON.parse(raw)) : new Set<string>());
    } catch { setExpandedPaths(new Set<string>()); }
  }, [expandStorageKey]);
  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      try { if (expandStorageKey) localStorage.setItem(expandStorageKey, JSON.stringify([...next])); } catch { /* localStorage 不可用 */ }
      return next;
    });
  }, [expandStorageKey]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    setContextMenu({ x: e.clientX, y: e.clientY, mode: 'node', node });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const notify = useCallback((type: 'success' | 'error' | 'info', title: string, message: string) => {
    dispatch(addNotification({ type, title, message }));
  }, [dispatch]);

  const validateName = useCallback((rawName: string, label: string) => {
    const name = rawName.trim();
    if (!name) {
      notify('error', '名称无效', `${label}不能为空`);
      return null;
    }
    if (/[\\/]/.test(name)) {
      notify('error', '名称无效', `${label}不能包含斜杠`);
      return null;
    }
    return name;
  }, [notify]);

  const moveWebFileEntries = useCallback((oldPaths: string[], oldPrefix: string, newPrefix: string) => {
    const service = fileSystem as any;
    const memoryFiles = service.memoryFiles as Map<string, string> | undefined;
    const memoryFileUrls = service.memoryFileUrls as Map<string, string> | undefined;

    for (const oldPath of oldPaths) {
      const nextPath = `${newPrefix}${oldPath.slice(oldPrefix.length)}`;
      if (memoryFiles?.has(oldPath)) {
        const content = memoryFiles.get(oldPath);
        memoryFiles.delete(oldPath);
        if (content !== undefined) {
          memoryFiles.set(nextPath, content);
        }
      }
      if (memoryFileUrls?.has(oldPath)) {
        const url = memoryFileUrls.get(oldPath);
        memoryFileUrls.delete(oldPath);
        if (url) {
          memoryFileUrls.set(nextPath, url);
        }
      }
    }
  }, []);

  const removeWebFileEntries = useCallback((paths: string[]) => {
    const service = fileSystem as any;
    const memoryFiles = service.memoryFiles as Map<string, string> | undefined;
    const memoryFileUrls = service.memoryFileUrls as Map<string, string> | undefined;

    for (const path of paths) {
      memoryFiles?.delete(path);
      const url = memoryFileUrls?.get(path);
      if (url) {
        URL.revokeObjectURL(url);
        memoryFileUrls?.delete(path);
      }
    }
  }, []);

  const createFileAt = useCallback(async (parentPath: string, fileName: string) => {
    const filePath = `${parentPath}/${fileName}`;
    if (isElectron && window.synapse) {
      await fileSystem.writeFile(filePath, '');
      return filePath;
    }
    return fileSystem.createFile(parentPath, fileName, '');
  }, []);

  // 重命名
  const startRename = useCallback((node: FileNode) => {
    setEditingPath(node.path);
    setEditingName(node.name);
    closeContextMenu();
  }, [closeContextMenu]);

  const submitRename = useCallback(async () => {
    if (!editingPath) {
      setEditingPath(null);
      return;
    }

    const currentNode = findTreeNode(root, editingPath);
    const nextName = validateName(editingName, currentNode?.type === 'directory' ? '文件夹名' : '文件名');
    if (!currentNode || !nextName) {
      setEditingPath(null);
      return;
    }

    const descendantPaths = currentNode.type === 'directory'
      ? collectDescendantFilePaths(currentNode)
      : [];
    const affectedPaths = currentNode.type === 'directory' ? descendantPaths : [currentNode.path];
    const affectedTabs = tabs.filter(tab => affectedPaths.includes(tab.filePath));
    const affectedDirtyTabs = affectedTabs.filter(tab => tab.isDirty);
    if (affectedDirtyTabs.length > 0) {
      const ok = await resolveUnsavedTabs(affectedDirtyTabs, '重命名');
      if (!ok) {
        setEditingPath(null);
        return;
      }
    }

    try {
      const nextPath = await fileSystem.renameFile(editingPath, nextName);
      if (!isElectron && currentNode.type === 'directory' && descendantPaths.length > 0) {
        moveWebFileEntries(descendantPaths, editingPath, nextPath);
      }
      affectedTabs.forEach(tab => dispatch(closeTab(tab.id)));
      onRefresh?.();
      notify('success', '重命名成功', `"${nextName}" 已更新`);
    } catch (err: any) {
      console.error('重命名失败:', err);
      notify('error', '重命名失败', err?.message || '无法完成重命名');
    }
    setEditingPath(null);
  }, [dispatch, editingPath, editingName, moveWebFileEntries, notify, onRefresh, root, tabs, validateName]);

  const cancelRename = useCallback(() => {
    setEditingPath(null);
  }, []);

  // 删除
  const handleDelete = useCallback(async (node: FileNode) => {
    const affectedPaths = node.type === 'directory' ? collectDescendantFilePaths(node) : [node.path];
    const affectedTabs = tabs.filter(tab => affectedPaths.includes(tab.filePath));
    const affectedDirtyTabs = affectedTabs.filter(tab => tab.isDirty);
    const confirmed = await confirmAction({
      title: `删除${node.type === 'directory' ? '文件夹' : '文件'}？`,
      message: `即将删除「${node.name}」。${node.type === 'directory' ? '其中的文件也会一起删除。' : ''}`,
      confirmLabel: '确认删除',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (affectedDirtyTabs.length > 0) {
      const ok = await resolveUnsavedTabs(affectedDirtyTabs, '删除文件');
      if (!ok) return;
    }

    const descendantPaths = !isElectron && node.type === 'directory'
      ? collectDescendantFilePaths(node)
      : [];

    try {
      if (!isElectron && descendantPaths.length > 0) {
        removeWebFileEntries(descendantPaths);
      }
      await fileSystem.deleteFile(node.path);
      affectedTabs.forEach(tab => dispatch(closeTab(tab.id)));
      onRefresh?.();
      notify('success', '删除成功', `"${node.name}" 已删除`);
    } catch (err: any) {
      console.error('删除失败:', err);
      notify('error', '删除失败', err?.message || '无法删除该项');
    }
    closeContextMenu();
  }, [closeContextMenu, dispatch, notify, onRefresh, removeWebFileEntries, tabs]);

  // 新建文件
  const handleNewFile = useCallback(async (parentNode: FileNode) => {
    const inputName = await promptAction({
      title: '新建文件',
      message: '输入新文件名，扩展名可以一起填写。',
      placeholder: '例如 notes.md',
    });
    if (inputName === null) return;
    const name = validateName(inputName, '文件名');
    if (!name) return;
    try {
      await createFileAt(parentNode.path, name);
      onRefresh?.();
      notify('success', '创建成功', `已新建文件 "${name}"`);
    } catch (err: any) {
      console.error('创建文件失败:', err);
      notify('error', '创建文件失败', err?.message || '无法创建文件');
    }
    closeContextMenu();
  }, [closeContextMenu, createFileAt, notify, onRefresh, validateName]);

  // 新建文件夹
  const handleNewFolder = useCallback(async (parentNode: FileNode) => {
    const inputName = await promptAction({
      title: '新建文件夹',
      message: '输入新文件夹名称。',
      placeholder: '例如 src',
    });
    if (inputName === null) return;
    const name = validateName(inputName, '文件夹名');
    if (!name) return;
    try {
      await fileSystem.createDirectory(parentNode.path, name);
      onRefresh?.();
      notify('success', '创建成功', `已新建文件夹 "${name}"`);
    } catch (err: any) {
      console.error('创建文件夹失败:', err);
      notify('error', '创建文件夹失败', err?.message || '无法创建文件夹');
    }
    closeContextMenu();
  }, [closeContextMenu, notify, onRefresh, validateName]);

  const handleTreeContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.file-tree-item')) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, mode: 'blank', node: root });
  }, [root]);

  const buildNodeMenuItems = useCallback((node: FileNode): MenuItem[] => {
    const isDir = node.type === 'directory';
    if (isDir) {
      return [
        {
          label: '新建文件',
          icon: <FilePlus size={14} />,
          onClick: () => handleNewFile(node),
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus size={14} />,
          onClick: () => handleNewFolder(node),
        },
        { label: '', onClick: () => { }, separator: true },
        {
          label: '重命名',
          icon: <Edit size={14} />,
          shortcut: 'F2',
          onClick: () => startRename(node),
        },
        {
          label: '删除',
          icon: <Trash2 size={14} />,
          onClick: () => handleDelete(node),
          danger: true,
        },
      ];
    }

    return [
      {
        label: '复制路径',
        icon: <Copy size={14} />,
        onClick: async () => {
          try {
            if (!navigator.clipboard?.writeText) {
              throw new Error('当前环境不支持剪贴板');
            }
            await navigator.clipboard.writeText(node.path);
            notify('success', '复制成功', '文件路径已复制到剪贴板');
          } catch (err: any) {
            notify('error', '复制失败', err?.message || '无法访问剪贴板');
          }
        },
      },
      { label: '', onClick: () => { }, separator: true },
      {
        label: '重命名',
        icon: <Edit size={14} />,
        shortcut: 'F2',
        onClick: () => startRename(node),
      },
      {
        label: '删除',
        icon: <Trash2 size={14} />,
        onClick: () => handleDelete(node),
        danger: true,
      },
    ];
  }, [handleDelete, handleNewFile, handleNewFolder, notify, startRename]);

  const buildBlankMenuItems = useCallback((): MenuItem[] => ([
    {
      label: '新建文件',
      icon: <FilePlus size={14} />,
      onClick: () => handleNewFile(root),
    },
    {
      label: '新建文件夹',
      icon: <FolderPlus size={14} />,
      onClick: () => handleNewFolder(root),
    },
    { label: '', onClick: () => { }, separator: true },
    {
      label: '打开工作区',
      icon: <FolderOpen size={14} />,
      onClick: () => {
        void onOpenWorkspace?.();
      },
    },
    {
      label: '清空工作区',
      icon: <FolderOpen size={14} />,
      onClick: () => {
        void onClearWorkspace?.();
      },
      danger: true,
    },
  ]), [handleNewFile, handleNewFolder, onClearWorkspace, onOpenWorkspace, root]);

  // 拖拽上传
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    await fileSystem.uploadFiles(files, root.path);
    onRefresh?.();
  }, [root.path, onRefresh]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  return (
    <div
      className="file-tree"
      role="tree"
      aria-label="工作区文件"
      onClick={closeContextMenu}
      onContextMenu={handleTreeContextMenu}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {sortedRootChildren.map((child) => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={0}
          expandedPaths={expandedPaths}
          onToggleExpand={toggleExpand}
          onFileClick={onFileClick}
          onContextMenu={handleContextMenu}
          editingPath={editingPath}
          editingName={editingName}
          onEditNameChange={setEditingName}
          onEditSubmit={submitRename}
          onEditCancel={cancelRename}
        />
      ))}

      {(!root.children || root.children.length === 0) && (
        <div className="file-tree-empty">
          <p>📂 拖拽文件到此处上传</p>
          <p style={{ fontSize: 11, color: 'var(--syn-text-muted)' }}>或右键新建文件</p>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          items={contextMenu.mode === 'blank' ? buildBlankMenuItems() : buildNodeMenuItems(contextMenu.node)}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
