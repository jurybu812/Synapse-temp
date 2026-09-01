import { getWorkspaceRootResolved, resolveCanonicalWorkspacePath } from './fileSystem';

export interface DiffReviewPathCarrier {
  path: string;
  reviewPath?: string;
  contextId?: string;
  conversationId?: string;
}

export interface DiffReviewPathResolution {
  reviewPath: string;
  resolvedPath: string;
  isWorkspaceRelative: boolean;
}

function normalizeSeparators(value: string): string {
  const replaced = value.trim().replace(/\\/g, '/');
  if (replaced.startsWith('//')) {
    return `//${replaced.slice(2).replace(/\/{2,}/g, '/')}`;
  }
  return replaced.replace(/\/{2,}/g, '/');
}

function splitPathPrefix(value: string): { prefix: string; rest: string } {
  const drive = value.match(/^[A-Za-z]:(?:\/|$)/);
  if (drive) {
    const prefix = drive[0].endsWith('/') ? drive[0] : `${drive[0]}/`;
    return { prefix, rest: value.slice(drive[0].length) };
  }
  if (value.startsWith('//')) {
    const parts = value.slice(2).split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const prefix = `//${parts[0]}/${parts[1]}/`;
      return { prefix, rest: parts.slice(2).join('/') };
    }
    return { prefix: '//', rest: value.slice(2) };
  }
  if (value.startsWith('/')) return { prefix: '/', rest: value.slice(1) };
  return { prefix: '', rest: value };
}

function normalizePathSegments(value: string): string {
  const normalized = normalizeSeparators(value);
  const { prefix, rest } = splitPathPrefix(normalized);
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!prefix) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  if (!joined) return prefix || '.';
  return `${prefix}${joined}`;
}

function isWindowsPathLike(...values: Array<string | null | undefined>): boolean {
  return values.some(value => {
    if (!value) return false;
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
  });
}

export function normalizeDiffPath(filePath: string, caseInsensitive = true): string {
  const normalized = normalizePathSegments(filePath);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function workspaceRelativeReviewPath(
  resolvedPath: string,
  workspaceRoot: string,
  caseInsensitive: boolean,
): string | null {
  const resolved = normalizePathSegments(resolvedPath);
  const root = normalizePathSegments(workspaceRoot).replace(/\/+$/, '');
  const resolvedKey = caseInsensitive ? resolved.toLowerCase() : resolved;
  const rootKey = caseInsensitive ? root.toLowerCase() : root;
  if (resolvedKey === rootKey) return '.';
  if (!resolvedKey.startsWith(`${rootKey}/`)) return null;
  return normalizeDiffPath(resolved.slice(root.length + 1), caseInsensitive);
}

export async function resolveDiffReviewPath(
  filePath: string,
  contextId?: string,
  conversationId?: string,
): Promise<DiffReviewPathResolution> {
  const resolvedPath = await resolveCanonicalWorkspacePath(filePath, contextId, conversationId);
  const workspaceRoot = await getWorkspaceRootResolved(contextId, conversationId);
  const caseInsensitive = isWindowsPathLike(resolvedPath, workspaceRoot) || !workspaceRoot;
  const relativeReviewPath = workspaceRoot
    ? workspaceRelativeReviewPath(resolvedPath, workspaceRoot, caseInsensitive)
    : null;
  return {
    resolvedPath,
    reviewPath: relativeReviewPath ?? normalizeDiffPath(resolvedPath, caseInsensitive),
    isWorkspaceRelative: relativeReviewPath !== null,
  };
}

export function diffReviewIdentityPath(diff: DiffReviewPathCarrier): string {
  const reviewPath = typeof diff.reviewPath === 'string' && diff.reviewPath.trim()
    ? diff.reviewPath
    : diff.path;
  return normalizeDiffPath(reviewPath);
}
