/**
 * IPC Workspace Handler
 * 工作区管理：创建/切换/删除/最近列表
 */

import { app, BrowserWindow, ipcMain, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { getDatabase } from '../database';
import * as path from 'path';
import * as fs from 'fs';
import {
    enforceAgentFileAccess,
    registerAuthorizedWorkspaceRoot,
    replaceAuthorizedWorkspaceRoots,
    type AgentFileAccessContext,
} from '../fileAccess';

type WorkspaceRecord = {
    id: string;
    name: string;
    path: string;
    created_at?: number;
    updated_at?: number;
    last_opened?: number | null;
};

type WorkspaceSwitchInput = string | {
    id?: unknown;
    name?: unknown;
    path?: unknown;
    restore?: unknown;
};

type WorkspaceDeleteInput = string | {
    id?: unknown;
    path?: unknown;
};

function createWorkspaceId(): string {
    return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function safeWorkspaceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(trimmed)) return null;
    return trimmed;
}

function workspaceNameForPath(dirPath: string, preferredName?: unknown): string {
    const name = typeof preferredName === 'string' ? preferredName.trim() : '';
    return name || path.basename(dirPath) || dirPath;
}

function workspacePathKey(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) return '';
    const normalized = path.resolve(trimmed).replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function workspaceRealPathKey(rawPath: string): string {
    if (!rawPath.trim()) return '';
    try {
        return workspacePathKey(fs.realpathSync.native(path.resolve(rawPath)));
    } catch {
        return workspacePathKey(rawPath);
    }
}

function workspaceEquivalentKeys(rawPath: string): Set<string> {
    return new Set([workspacePathKey(rawPath), workspaceRealPathKey(rawPath)].filter(Boolean));
}

function workspaceMatchesAnyKey(rawPath: string, keys: Set<string>): boolean {
    for (const key of workspaceEquivalentKeys(rawPath)) {
        if (keys.has(key)) return true;
    }
    return false;
}

function workspaceSortTime(record: WorkspaceRecord): number {
    return record.last_opened ?? record.updated_at ?? record.created_at ?? 0;
}

function directoryAccessError(action: string, error: unknown): Error {
    const code = typeof error === 'object' && error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : '';
    if (code === 'ENOENT') return new Error(`${action}失败：目录不存在`);
    if (code === 'ENOTDIR') return new Error(`${action}失败：路径不是文件夹`);
    if (code === 'EACCES' || code === 'EPERM') return new Error(`${action}失败：目录不可读取`);
    return new Error(`${action}失败：无法访问目录`);
}

function validateWorkspaceDirectory(rawPath: unknown, action: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error(`${action}失败：工作区路径为空`);
    }
    const resolvedPath = path.resolve(rawPath);
    let realPath: string;
    try {
        realPath = fs.realpathSync.native(resolvedPath);
    } catch (error) {
        throw directoryAccessError(action, error);
    }
    try {
        const stats = fs.statSync(realPath);
        if (!stats.isDirectory()) throw new Error(`${action}失败：路径不是文件夹`);
        fs.accessSync(realPath, fs.constants.R_OK);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith(`${action}失败`)) throw error;
        throw directoryAccessError(action, error);
    }
    return realPath;
}

function resolvesToSameDirectory(rawPath: string, realPath: string): boolean {
    try {
        return fs.realpathSync.native(path.resolve(rawPath)) === realPath;
    } catch {
        return false;
    }
}

type WorkspaceDirectoryPickerPurpose = 'workspace-open' | 'directory-select';

let workspaceDirectoryPickerPending: {
    purpose: WorkspaceDirectoryPickerPurpose;
    request: Promise<string | null>;
} | null = null;
let workspaceOpenPending: Promise<WorkspaceRecord | null> | null = null;

async function pickValidatedDirectory(
    event: IpcMainInvokeEvent,
    { title, action, purpose }: { title: string; action: string; purpose: WorkspaceDirectoryPickerPurpose },
): Promise<string | null> {
    if (workspaceDirectoryPickerPending) {
        return workspaceDirectoryPickerPending.purpose === purpose
            ? workspaceDirectoryPickerPending.request
            : null;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
        properties: ['openDirectory'],
        title,
    };
    const pickRequest = (async (): Promise<string | null> => {
        const result = win
            ? await dialog.showOpenDialog(win, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || result.filePaths.length === 0) return null;
        return validateWorkspaceDirectory(result.filePaths[0], action);
    })();
    workspaceDirectoryPickerPending = { purpose, request: pickRequest };
    try {
        return await pickRequest;
    } finally {
        if (workspaceDirectoryPickerPending?.request === pickRequest) workspaceDirectoryPickerPending = null;
    }
}

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

    const getWorkspaceById = (id: string): WorkspaceRecord | undefined => (
        db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRecord | undefined
    );

    const listWorkspaces = (): WorkspaceRecord[] => (
        db.prepare('SELECT * FROM workspaces').all() as WorkspaceRecord[]
    );

    const getWorkspaceByPath = (dirPath: string): WorkspaceRecord | undefined => (
        db.prepare('SELECT * FROM workspaces WHERE path = ?').get(dirPath) as WorkspaceRecord | undefined
    );

    const getWorkspaceByEquivalentPath = (dirPath: string): WorkspaceRecord | undefined => {
        const exactMatch = getWorkspaceByPath(dirPath);
        if (exactMatch) return exactMatch;
        const dirKeys = workspaceEquivalentKeys(dirPath);
        return listWorkspaces()
            .filter(row => workspaceMatchesAnyKey(row.path, dirKeys))
            .sort((left, right) => workspaceSortTime(right) - workspaceSortTime(left))[0];
    };

    const upsertWorkspace = (dirPath: string, data: { id?: unknown; name?: unknown } = {}): WorkspaceRecord => {
        const existingByPath = getWorkspaceByEquivalentPath(dirPath);
        const name = workspaceNameForPath(dirPath, data.name ?? existingByPath?.name);
        if (existingByPath) {
            db.prepare(
                'UPDATE workspaces SET name = ?, path = ?, updated_at = unixepoch(), last_opened = unixepoch() WHERE id = ?',
            ).run(name, dirPath, existingByPath.id);
            return getWorkspaceById(existingByPath.id)!;
        }

        const requestedId = safeWorkspaceId(data.id);
        const existingById = requestedId ? getWorkspaceById(requestedId) : undefined;
        if (existingById && resolvesToSameDirectory(existingById.path, dirPath)) {
            db.prepare(
                'UPDATE workspaces SET name = ?, path = ?, updated_at = unixepoch(), last_opened = unixepoch() WHERE id = ?',
            ).run(name, dirPath, existingById.id);
            return getWorkspaceById(existingById.id)!;
        }

        const id = existingById ? createWorkspaceId() : requestedId ?? createWorkspaceId();
        db.prepare(
            'INSERT INTO workspaces (id, name, path, last_opened) VALUES (?, ?, ?, unixepoch())',
        ).run(id, name, dirPath);
        return getWorkspaceById(id)!;
    };

    // 创建工作区
    ipcMain.handle('workspace:create', (_e, data: { id?: unknown; name?: unknown; path?: unknown } = {}) => {
        const dirPath = validateWorkspaceDirectory(data.path, '创建工作区');
        const workspace = upsertWorkspace(dirPath, { id: data.id, name: data.name });
        refreshAuthorizedRoots();
        return workspace;
    });

    // 打开文件夹选择器创建工作区
    ipcMain.handle('workspace:open', async (e) => {
        if (workspaceOpenPending) return workspaceOpenPending;
        const openRequest = (async (): Promise<WorkspaceRecord | null> => {
            const dirPath = await pickValidatedDirectory(e, {
                title: '选择工作区文件夹',
                action: '打开工作区',
                purpose: 'workspace-open',
            });
            if (!dirPath) return null;
            const workspace = upsertWorkspace(dirPath);
            refreshAuthorizedRoots();
            return workspace;
        })();
        workspaceOpenPending = openRequest;
        try {
            return await openRequest;
        } finally {
            if (workspaceOpenPending === openRequest) workspaceOpenPending = null;
        }
    });

    // 纯目录选择器：只返回验证后的目录路径，不登记工作区、不刷新最近列表或授权根。
    ipcMain.handle('workspace:selectDirectory', async (e) => (
        pickValidatedDirectory(e, {
            title: '选择文件夹',
            action: '选择目录',
            purpose: 'directory-select',
        })
    ));

    // 获取最近工作区
    ipcMain.handle('workspace:recent', (_e, limit = 10) => {
        const numericLimit = Number(limit);
        const maxItems = Number.isFinite(numericLimit) ? Math.max(0, Math.trunc(numericLimit)) : 10;
        if (maxItems === 0) return [];
        const rows = db.prepare(
            'SELECT * FROM workspaces ORDER BY COALESCE(last_opened, updated_at) DESC',
        ).all() as WorkspaceRecord[];
        const seenKeys = new Set<string>();
        const recentWorkspaces: WorkspaceRecord[] = [];
        for (const row of rows) {
            const keys = workspaceEquivalentKeys(row.path);
            if ([...keys].some(key => seenKeys.has(key))) continue;
            for (const key of keys) seenKeys.add(key);
            recentWorkspaces.push(row);
            if (recentWorkspaces.length >= maxItems) break;
        }
        return recentWorkspaces;
    });

    // 切换工作区（更新 last_opened）
    ipcMain.handle('workspace:switch', async (_e, input: WorkspaceSwitchInput) => {
        const id = typeof input === 'string' ? input : safeWorkspaceId(input?.id);
        const candidate = typeof input === 'string' ? getWorkspaceById(input) : input;
        if (!candidate) return null;

        if (typeof input !== 'string' && input.restore === true && workspaceOpenPending) {
            const openedWorkspace = await workspaceOpenPending;
            if (openedWorkspace) return openedWorkspace;
        }

        const dirPath = validateWorkspaceDirectory(candidate.path, '切换工作区');
        const ws = upsertWorkspace(dirPath, { id, name: candidate.name });
        refreshAuthorizedRoots();
        return ws;
    });

    // 删除工作区（不删除文件系统）
    ipcMain.handle('workspace:delete', (_e, input: WorkspaceDeleteInput) => {
        const requestedId = safeWorkspaceId(typeof input === 'string' ? input : input?.id);
        const requestedPath = typeof input === 'object' && input && typeof input.path === 'string'
            ? input.path.trim()
            : '';
        const workspaces = listWorkspaces();
        const pathMatchedWorkspaces = requestedPath
            ? workspaces.filter(row => workspaceMatchesAnyKey(row.path, workspaceEquivalentKeys(requestedPath)))
            : [];
        const targetWorkspace = pathMatchedWorkspaces[0] ?? (requestedId ? getWorkspaceById(requestedId) : undefined);
        if (!targetWorkspace) return false;

        const targetKeys = workspaceEquivalentKeys(targetWorkspace.path);
        if (requestedPath) {
            for (const key of workspaceEquivalentKeys(requestedPath)) targetKeys.add(key);
        }
        const deleteIds = workspaces
            .filter(row => workspaceMatchesAnyKey(row.path, targetKeys))
            .map(row => row.id);
        let changes = 0;
        for (const id of deleteIds) {
            changes += db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes;
        }
        if (changes > 0) refreshAuthorizedRoots();
        return changes > 0;
    });

    // 获取工作区文件树
    // ★ 文件树深度：默认 8（旧值 3 会让第 4 层及更深目录 children 恒空、深层展开看着像 bug）。
    //   渲染层 fileSystem.getWorkspaceTree 会按 settings.fileTreeMaxDepth 显式传值覆盖；此默认是兜底。
    ipcMain.handle('workspace:tree', (e, wsPath: string, maxDepth = 8, access?: AgentFileAccessContext) => {
        wsPath = enforceAgentFileAccess(wsPath, access, e.sender.id);
        wsPath = validateWorkspaceDirectory(wsPath, '读取工作区目录');
        function scanDir(dirPath: string, depth: number): unknown[] | null {
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
            } catch (error) {
                if (depth === 1) throw directoryAccessError('读取工作区目录', error);
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
