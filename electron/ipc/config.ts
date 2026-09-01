/**
 * IPC Config Handler
 * 设置读写 + safeStorage 加密 API Key
 */

import { ipcMain } from 'electron';
import { getDatabase } from '../database';

function assertPublicConfigKey(key: string): void {
    if (key === 'apiKeys' || key.startsWith('providerCredential')) {
        throw new Error('Credential settings are only available through the Provider Runtime');
    }
}

function readConfigValue(db: ReturnType<typeof getDatabase>, key: string): unknown {
    assertPublicConfigKey(key);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch {
        return row.value;
    }
}

export function registerConfigHandlers(): void {
    const db = getDatabase();

    const writeConfigValue = (key: string, value: unknown) => {
        assertPublicConfigKey(key);
        const json = JSON.stringify(value);
        db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        ).run(key, json);
    };

    // 通用设置读取
    ipcMain.handle('config:get', (_e, key: string) => {
        return readConfigValue(db, key);
    });

    ipcMain.on('config:getSync', (event, key: string) => {
        try {
            event.returnValue = { ok: true, value: readConfigValue(db, key) };
        } catch (error) {
            event.returnValue = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });

    ipcMain.on('config:setSync', (event, key: string, value: unknown) => {
        try {
            writeConfigValue(key, value);
            event.returnValue = { ok: true };
        } catch (error) {
            event.returnValue = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });

    // 通用设置写入
    ipcMain.handle('config:set', (_e, key: string, value: unknown) => {
        writeConfigValue(key, value);
        return true;
    });

}
