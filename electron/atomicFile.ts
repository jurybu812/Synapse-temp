import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function writeUtf8FileAtomically(filePath: string, content: string): void {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });

    const tempPath = path.join(
        directory,
        `.${path.basename(filePath)}.synapse-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(tempPath, 'wx');
        try {
            const existingMode = fs.statSync(filePath).mode;
            fs.fchmodSync(descriptor, existingMode);
        } catch {
            // 新文件没有可继承权限，使用系统默认值。
        }
        fs.writeFileSync(descriptor, content, 'utf-8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;
        fs.renameSync(tempPath, filePath);
    } finally {
        if (descriptor !== null) {
            try { fs.closeSync(descriptor); } catch { /* ignore */ }
        }
        try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    }
}
