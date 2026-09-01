import * as fs from 'fs/promises';
import * as path from 'path';

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'dist-electron']);

export interface FileContentMatch {
    path: string;
    line: number;
    content: string;
}

export interface FileSearchReport {
    matches: FileContentMatch[];
    scannedFiles: number;
    skippedFiles: number;
    visitedEntries: number;
    truncated: boolean;
}

export interface FileSearchOptions {
    signal?: AbortSignal;
    maxResults?: number;
    maxFileBytes?: number;
    maxEntries?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('文件搜索已取消');
    error.name = 'AbortError';
    throw error;
}

export async function searchFilesInDirectory(
    rootPath: string,
    pattern: string,
    options: FileSearchOptions = {},
): Promise<FileSearchReport> {
    const query = pattern.trim();
    if (!query) return { matches: [], scannedFiles: 0, skippedFiles: 0, visitedEntries: 0, truncated: false };
    const normalizedQuery = query.toLocaleLowerCase();

    const maxResults = Math.max(1, Math.min(500, options.maxResults ?? DEFAULT_MAX_RESULTS));
    const maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    const maxEntries = Math.max(maxResults, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    const matches: FileContentMatch[] = [];
    const pending = [path.resolve(rootPath)];
    let scannedFiles = 0;
    let skippedFiles = 0;
    let visitedEntries = 0;
    let truncated = false;

    const rootStat = await fs.stat(pending[0]);
    if (!rootStat.isDirectory()) throw new Error(`搜索根目录无效: ${pending[0]}`);

    while (pending.length && matches.length < maxResults) {
        throwIfAborted(options.signal);
        const current = pending.pop()!;
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            skippedFiles++;
            continue;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            throwIfAborted(options.signal);
            visitedEntries++;
            if (visitedEntries > maxEntries) {
                truncated = true;
                pending.length = 0;
                break;
            }
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;

            try {
                const stat = await fs.stat(fullPath);
                if (stat.size > maxFileBytes) {
                    skippedFiles++;
                    continue;
                }
                const content = await fs.readFile(fullPath, 'utf8');
                scannedFiles++;
                const lines = content.split(/\r?\n/);
                for (let index = 0; index < lines.length && matches.length < maxResults; index++) {
                    if (!lines[index].toLocaleLowerCase().includes(normalizedQuery)) continue;
                    matches.push({
                        path: fullPath,
                        line: index + 1,
                        content: lines[index].trim().slice(0, 200),
                    });
                }
            } catch (error) {
                if (options.signal?.aborted) throw error;
                skippedFiles++;
            }
        }
    }

    if (matches.length >= maxResults) truncated = true;
    return { matches, scannedFiles, skippedFiles, visitedEntries, truncated };
}
