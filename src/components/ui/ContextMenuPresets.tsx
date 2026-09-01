/**
 * Context Menu Presets
 * 预定义三套右键菜单配置：文件树 / 消息 / 标签页
 */

import { Copy, Edit3, Trash2, FolderPlus, FilePlus, RefreshCw, ExternalLink, Terminal, Send, Clipboard, RotateCcw } from 'lucide-react';
import { createElement } from 'react';
import type { MenuItem } from './ContextMenu';

type MenuAction = (data: any) => void;

/**
 * File Tree context menu
 */
export function getFileTreeMenu(
  filePath: string,
  isDir: boolean,
  actions: {
    onOpen?: MenuAction;
    onRename?: MenuAction;
    onDelete?: MenuAction;
    onNewFile?: MenuAction;
    onNewFolder?: MenuAction;
    onCopyPath?: MenuAction;
    onSendToAI?: MenuAction;
    onOpenInTerminal?: MenuAction;
  }
): MenuItem[] {
  const items: MenuItem[] = [];

  if (!isDir) {
    items.push({
      label: '打开',
      icon: createElement(ExternalLink, { size: 14 }),
      onClick: () => actions.onOpen?.(filePath),
    });
    items.push({
      label: '发送到 AI',
      icon: createElement(Send, { size: 14 }),
      onClick: () => actions.onSendToAI?.(filePath),
    });
    items.push({ label: '', separator: true, onClick: () => {} });
  }

  if (isDir) {
    items.push({
      label: '新建文件',
      icon: createElement(FilePlus, { size: 14 }),
      onClick: () => actions.onNewFile?.(filePath),
    });
    items.push({
      label: '新建文件夹',
      icon: createElement(FolderPlus, { size: 14 }),
      onClick: () => actions.onNewFolder?.(filePath),
    });
    items.push({
      label: '在终端打开',
      icon: createElement(Terminal, { size: 14 }),
      onClick: () => actions.onOpenInTerminal?.(filePath),
    });
    items.push({ label: '', separator: true, onClick: () => {} });
  }

  items.push({
    label: '重命名',
    icon: createElement(Edit3, { size: 14 }),
    shortcut: 'F2',
    onClick: () => actions.onRename?.(filePath),
  });
  items.push({
    label: '复制路径',
    icon: createElement(Copy, { size: 14 }),
    onClick: () => actions.onCopyPath?.(filePath),
  });
  items.push({ label: '', separator: true, onClick: () => {} });
  items.push({
    label: '删除',
    icon: createElement(Trash2, { size: 14 }),
    danger: true,
    onClick: () => actions.onDelete?.(filePath),
  });

  return items;
}

/**
 * Message context menu
 */
export function getMessageMenu(
  messageId: string,
  role: string,
  content: string,
  actions: {
    onCopy?: MenuAction;
    onEdit?: MenuAction;
    onRetry?: MenuAction;
    onDelete?: MenuAction;
  }
): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: '复制文本',
      icon: createElement(Clipboard, { size: 14 }),
      shortcut: 'Ctrl+C',
      onClick: () => {
        navigator.clipboard.writeText(content);
        actions.onCopy?.(messageId);
      },
    },
  ];

  if (role === 'user') {
    items.push({
      label: '编辑消息',
      icon: createElement(Edit3, { size: 14 }),
      onClick: () => actions.onEdit?.(messageId),
    });
  }

  if (role === 'assistant') {
    items.push({
      label: '重新生成',
      icon: createElement(RotateCcw, { size: 14 }),
      onClick: () => actions.onRetry?.(messageId),
    });
  }

  items.push({ label: '', separator: true, onClick: () => {} });
  items.push({
    label: '删除',
    icon: createElement(Trash2, { size: 14 }),
    danger: true,
    onClick: () => actions.onDelete?.(messageId),
  });

  return items;
}

/**
 * Tab context menu
 */
export function getTabMenu(
  tabId: string,
  actions: {
    onClose?: MenuAction;
    onCloseOthers?: MenuAction;
    onCloseAll?: MenuAction;
    onCopyPath?: MenuAction;
    onRevealInTree?: MenuAction;
  }
): MenuItem[] {
  return [
    {
      label: '关闭',
      icon: createElement(RefreshCw, { size: 14 }),
      shortcut: 'Ctrl+W',
      onClick: () => actions.onClose?.(tabId),
    },
    {
      label: '关闭其他标签',
      onClick: () => actions.onCloseOthers?.(tabId),
    },
    {
      label: '关闭所有标签',
      onClick: () => actions.onCloseAll?.(tabId),
      danger: true,
    },
    { label: '', separator: true, onClick: () => {} },
    {
      label: '复制路径',
      icon: createElement(Copy, { size: 14 }),
      onClick: () => actions.onCopyPath?.(tabId),
    },
    {
      label: '在文件树中定位',
      icon: createElement(ExternalLink, { size: 14 }),
      onClick: () => actions.onRevealInTree?.(tabId),
    },
  ];
}
