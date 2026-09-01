import * as path from 'path';
import { enforceAgentFileAccess, type AgentFileAccessContext } from '../../fileAccess';
import { searchFilesInDirectory } from '../../fileSearch';
import { ManagedTaskError, ManagedTaskExecutor, type ManagedTaskExecutionContext, type ManagedTaskOutput } from '../ManagedTaskExecutor';

interface FileNameMatch {
    path: string;
    name: string;
    kind: 'file';
}

interface FileSearchTaskInput {
    query: string;
    root: string;
    access?: AgentFileAccessContext;
    fileNameMatches?: FileNameMatch[];
}

function parseInput(input: unknown): FileSearchTaskInput {
    const value = input as Partial<FileSearchTaskInput> | null;
    const query = typeof value?.query === 'string' ? value.query.trim() : '';
    const root = typeof value?.root === 'string' ? value.root.trim() : '';
    if (!query) throw new ManagedTaskError('文件搜索缺少 query', 'invalid_result', false);
    if (!root) throw new ManagedTaskError('文件搜索缺少 root', 'invalid_result', false);
    const fileNameMatches = Array.isArray(value?.fileNameMatches)
        ? value.fileNameMatches.filter(item => item && item.kind === 'file' && typeof item.path === 'string').slice(0, 50)
        : [];
    return { query, root, access: value?.access, fileNameMatches };
}

export class FileSearchTaskExecutor extends ManagedTaskExecutor {
    readonly kind = 'file-search';

    protected hasUnknownSideEffect(): boolean {
        return false;
    }

    protected async execute(input: unknown, context: ManagedTaskExecutionContext): Promise<ManagedTaskOutput> {
        const task = parseInput(input);
        let root: string;
        try {
            root = enforceAgentFileAccess(task.root, task.access);
        } catch (error) {
            throw new ManagedTaskError(error instanceof Error ? error.message : String(error), 'approval_denied', false);
        }
        const report = await searchFilesInDirectory(root, task.query, { signal: context.signal });
        const contentMatches = report.matches.map(match => ({
            path: match.path,
            name: path.basename(match.path),
            kind: 'content' as const,
            line: match.line,
            content: match.content,
        }));
        const results = [...(task.fileNameMatches ?? []), ...contentMatches];
        if (!results.length) {
            return {
                text: `未找到匹配 "${task.query}" 的文件或内容`,
                structured: { query: task.query, root, results, ...report, matches: undefined },
            };
        }
        const lines = results.map(result => result.kind === 'content'
            ? `- ${result.path}:${result.line ?? '?'}  ${String(result.content ?? '').trim()}`
            : `- ${result.path}（文件名匹配）`);
        const suffix = report.truncated ? '\n\n搜索达到结果或遍历上限，结果已截断。' : '';
        return {
            text: `搜索 "${task.query}" 找到 ${results.length} 个结果:\n${lines.join('\n')}${suffix}`,
            structured: {
                query: task.query,
                root,
                results,
                scannedFiles: report.scannedFiles,
                skippedFiles: report.skippedFiles,
                visitedEntries: report.visitedEntries,
                truncated: report.truncated,
            },
        };
    }
}
