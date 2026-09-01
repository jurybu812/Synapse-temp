import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol } from 'electron';
import type { OpenDialogOptions } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

type WallpaperAsset = {
    id: string;
    name: string;
    kind: 'managed';
    url: string;
    relativePath: string;
    mime: string;
    size: number;
    width?: number;
    height?: number;
    addedAt: number;
};

const WALLPAPER_DIR_NAME = 'wallpapers';
const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

protocol.registerSchemesAsPrivileged([
    {
        scheme: 'synapse-wallpaper',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: false,
            corsEnabled: false,
        },
    },
]);

export function registerWallpaperProtocol(): void {
    protocol.registerFileProtocol('synapse-wallpaper', (request, callback) => {
        try {
            const url = new URL(request.url);
            const fileName = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''));
            const resolved = resolveManagedWallpaperPath(fileName);
            if (!resolved || !fs.existsSync(resolved)) {
                callback({ error: -6 });
                return;
            }
            callback({ path: resolved });
        } catch {
            callback({ error: -2 });
        }
    });
}

export function registerWallpaperHandlers(): void {
    ipcMain.handle('wallpaper:importFromDialog', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options: OpenDialogOptions = {
            title: '选择壁纸图片',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
            ],
        };
        const result = win
            ? await dialog.showOpenDialog(win, options)
            : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) return [];
        return importWallpaperFiles(result.filePaths);
    });

    ipcMain.handle('wallpaper:importFiles', async (_event, filePaths: string[]) => {
        if (!Array.isArray(filePaths)) return [];
        return importWallpaperFiles(filePaths);
    });

    ipcMain.handle('wallpaper:remove', (_event, asset: Pick<WallpaperAsset, 'id' | 'relativePath'>) => {
        try {
            const resolved = resolveManagedWallpaperPath(asset?.relativePath || '');
            if (!resolved) throw new Error('无效的壁纸路径');
            fs.rmSync(resolved, { force: true });
            return { success: true };
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    ipcMain.handle('wallpaper:clear', (_event, assets: Array<Pick<WallpaperAsset, 'id' | 'relativePath'>>) => {
        const removed: string[] = [];
        const errors: string[] = [];
        if (!Array.isArray(assets)) return { removed, errors };
        assets.forEach(asset => {
            const resolved = resolveManagedWallpaperPath(asset?.relativePath || '');
            if (!resolved) {
                errors.push(asset?.id || 'unknown');
                return;
            }
            try {
                fs.rmSync(resolved, { force: true });
                removed.push(asset?.id || path.basename(resolved));
            } catch (err: any) {
                errors.push(`${asset?.id || path.basename(resolved)}: ${err.message}`);
            }
        });
        return { removed, errors };
    });
}

async function importWallpaperFiles(filePaths: string[]): Promise<WallpaperAsset[]> {
    const assets: WallpaperAsset[] = [];
    for (const filePath of filePaths) {
        assets.push(importWallpaperFile(filePath));
    }
    return assets;
}

function importWallpaperFile(filePath: string): WallpaperAsset {
    const sourcePath = path.resolve(filePath);
    if (!fs.existsSync(sourcePath)) throw new Error(`文件不存在: ${sourcePath}`);
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error(`不是文件: ${sourcePath}`);
    if (stat.size > MAX_WALLPAPER_BYTES) throw new Error('壁纸图片超过 25MB 限制');

    const ext = path.extname(sourcePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error(`不支持的壁纸类型: ${ext || 'unknown'}`);

    const buffer = fs.readFileSync(sourcePath);
    if (!matchesImageSignature(buffer, ext)) throw new Error('图片内容与扩展名不匹配');

    const id = crypto.randomUUID();
    const fileName = `${id}${ext === '.jpeg' ? '.jpg' : ext}`;
    const relativePath = `${WALLPAPER_DIR_NAME}/${fileName}`;
    const targetPath = path.join(getWallpaperDir(), fileName);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, buffer);

    const image = nativeImage.createFromBuffer(buffer);
    const size = image.isEmpty() ? undefined : image.getSize();
    return {
        id,
        name: path.basename(sourcePath),
        kind: 'managed',
        url: `synapse-wallpaper://${encodeURIComponent(fileName)}`,
        relativePath,
        mime: MIME_BY_EXT[ext] ?? 'image/*',
        size: stat.size,
        width: size?.width,
        height: size?.height,
        addedAt: Date.now(),
    };
}

function getWallpaperDir(): string {
    return path.join(app.getPath('userData'), WALLPAPER_DIR_NAME);
}

function resolveManagedWallpaperPath(relativeOrFileName: string): string | null {
    if (!relativeOrFileName || typeof relativeOrFileName !== 'string') return null;
    const normalized = relativeOrFileName.replace(/\\/g, '/').replace(/^\/+/, '');
    const fileName = normalized.startsWith(`${WALLPAPER_DIR_NAME}/`)
        ? normalized.slice(WALLPAPER_DIR_NAME.length + 1)
        : normalized;
    if (!fileName || fileName.includes('/') || fileName.includes('..')) return null;
    const resolved = path.resolve(getWallpaperDir(), fileName);
    const root = path.resolve(getWallpaperDir());
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
}

function matchesImageSignature(buffer: Buffer, ext: string): boolean {
    if (buffer.length < 12) return false;
    if (ext === '.png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === '.jpg' || ext === '.jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
    if (ext === '.gif') return buffer.subarray(0, 3).toString('ascii') === 'GIF';
    if (ext === '.webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    return false;
}
