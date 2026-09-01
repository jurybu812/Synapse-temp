/**
 * IPC Workspace Handler
 * 工作区管理：创建/切换/删除/最近列表
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { getDatabase } from '../database';
import * as path from 'path';
import * as fs from 'fs';
import {
    enforceAgentFileAccess,
    registerAuthorizedWorkspaceRoot,
    replaceAuthorizedWorkspaceRoots,
    type AgentFileAccessContext,
} from '../fileAccess';

export function registerWorkspaceHandlers(): void {
    const db = getDatabase();
    const refreshAuthorizedRoots = () => {
        const rows = db.prepare(`
            SELECT path
            FROM workspaces
            WHERE path IS NOT NULL AND path <> ''
        `).all() as Array<{ path?: string }>;
        replaceAuthorizedWorkspaceRoots(rows.map(row => row.path).filter((value): value is string => Boolean(value)));
        registerAuthorizedWorkspaceRoot(path.join(app.getPath('userData'), 'worktrees'));
    };
    refreshAuthorizedRoots();

    // 创建工作区
    ipcMain.handle('workspace:create', (_e, data: { name: string; path: string }) => {
        const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        db.prepare(
            'INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)',
        ).run(id, data.name, data.path);
        refreshAuthorizedRoots();
        return { id, name: data.name, path: data.path };
    });

    // 打开文件夹选择器创建工作区
    ipcMain.handle('workspace:open', async (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        const result = await dialog.showOpenDialog(win!, {
            properties: ['openDirectory'],
            title: '选择工作区文件夹',
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        const dirPath = result.filePaths[0];
        const name = path.basename(dirPath);
        const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        db.prepare(
            'INSERT OR REPLACE INTO workspaces (id, name, path, last_opened) VALUES (?, ?, ?, unixepoch())',
        ).run(id, name, dirPath);
        refreshAuthorizedRoots();
        return { id, name, path: dirPath };
    });

    // 获取最近工作区
    ipcMain.handle('workspace:recent', (_e, limit = 10) => {
        return db.prepare(
            'SELECT * FROM workspaces ORDER BY COALESCE(last_opened, updated_at) DESC LIMIT ?',
        ).all(limit);
    });

    // 切换工作区（更新 last_opened）
    ipcMain.handle('workspace:switch', (_e, id: string) => {
        db.prepare('UPDATE workspaces SET last_opened = unixepoch() WHERE id = ?').run(id);
        const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
        refreshAuthorizedRoots();
        return ws || null;
    });

    // 删除工作区（不删除文件系统）
    ipcMain.handle('workspace:delete', (_e, id: string) => {
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
        refreshAuthorizedRoots();
        return true;
    });

    // 获取工作区文件树
    // ★ 文件树深度：默认 8（旧值 3 会让第 4 层及更深目录 children 恒空、深层展开看着像 bug）。
    //   渲染层 fileSystem.getWorkspaceTree 会按 settings.fileTreeMaxDepth 显式传值覆盖；此默认是兜底。
    ipcMain.handle('workspace:tree', (e, wsPath: string, maxDepth = 8, access?: AgentFileAccessContext) => {
        wsPath = enforceAgentFileAccess(wsPath, access, e.sender.id);
        function scanDir(dirPath: string, depth: number): unknown {
            if (depth > maxDepth) return null;
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                const children = entries
                    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && !e.isSymbolicLink())
                    .map(entry => {
                        const fullPath = path.join(dirPath, entry.name);
                        if (entry.isDirectory()) {
                            return {
                                name: entry.name,
                                path: fullPath,
                                type: 'directory',
                                children: scanDir(fullPath, depth + 1) || [],
                            };
                        }
                        const stats = fs.lstatSync(fullPath);
                        const ext = path.extname(entry.name).slice(1).toLowerCase();
                        return {
                            name: entry.name,
                            path: fullPath,
                            type: 'file',
                            extension: ext,
                            size: stats.size,
                        };
                    });
                return children;
            } catch {
                return [];
            }
        }
        return {
            name: path.basename(wsPath),
            path: wsPath,
            type: 'directory',
            children: scanDir(wsPath, 1),
        };
    });
}
