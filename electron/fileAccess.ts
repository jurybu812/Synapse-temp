import { app } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentFileAccessContext {
    workspaceRoot: string | null;
    fullAccess: boolean;
    approvedPaths: string[];
    operations?: AgentFileOperation[];
    grantId?: string;
    senderId?: number;
}

export type AgentFileOperation = 'read' | 'write' | 'delete';
export type AgentFileAccessScope = 'workspace' | 'external' | 'mixed';

interface FileAccessGrant {
    senderId: number;
    remainingApprovals: Set<string>;
    expiresAt: number;
}

interface PendingFileAccessGrant {
    senderId: number;
    workspaceRoot: string | null;
    approvedPaths: Set<string>;
    operations: Set<AgentFileOperation>;
    scope: AgentFileAccessScope;
    expiresAt: number;
}

export interface PendingFileAccessGrantDetails {
    workspaceRoot: string | null;
    approvedPaths: string[];
    operations: AgentFileOperation[];
    scope: AgentFileAccessScope;
    expiresAt: number;
}

const authorizedWorkspaceRoots = new Set<string>();
const temporaryFileRoots = new Map<string, Set<number>>();
const fileAccessGrants = new Map<string, FileAccessGrant>();
const pendingFileAccessGrants = new Map<string, PendingFileAccessGrant>();
const FILE_ACCESS_GRANT_TTL_MS = 2 * 60 * 1000;
const FILE_ACCESS_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const GLOBAL_TEMP_ROOT_OWNER = -1;

function assertLocalDiskPath(resolvedPath: string): void {
    if (process.platform === 'win32') {
        const normalized = path.win32.normalize(resolvedPath);
        if (!/^[a-zA-Z]:\\/.test(normalized)) {
            throw new Error('仅允许访问本机盘符路径，已拒绝 UNC、设备或命名管道路径');
        }
        return;
    }
    if (!path.isAbsolute(resolvedPath) || resolvedPath.startsWith('\\\\')) {
        throw new Error('仅允许访问本机绝对路径');
    }
}

export function resolveFilePath(filePath: string): string {
    if (!filePath) return filePath;
    let resolved: string;
    if (filePath === '~') resolved = app.getPath('home');
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
        resolved = path.join(app.getPath('home'), filePath.slice(2));
    } else if (filePath !== '~') {
        resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    }
    assertLocalDiskPath(resolved!);
    return resolved!;
}

function canonicalizePotentialPath(inputPath: string): string {
    const resolved = resolveFilePath(inputPath);
    let probe = resolved;
    const missingSegments: string[] = [];
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        missingSegments.unshift(path.basename(probe));
        probe = parent;
    }
    const canonicalBase = fs.existsSync(probe) ? fs.realpathSync.native(probe) : path.resolve(probe);
    return path.resolve(canonicalBase, ...missingSegments);
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isWithinAuthorizedWorkspaceRootPath(targetPath: string): boolean {
    for (const root of authorizedWorkspaceRoots) {
        if (isWithinRoot(targetPath, root)) return true;
    }
    return false;
}

function isWithinTemporaryFileRoot(targetPath: string, senderId?: number): boolean {
    for (const [root, owners] of temporaryFileRoots) {
        if (!isWithinRoot(targetPath, root)) continue;
        if (senderId === undefined || owners.has(GLOBAL_TEMP_ROOT_OWNER) || owners.has(senderId)) return true;
    }
    return false;
}

function isWithinRegisteredRoots(targetPath: string, senderId?: number): boolean {
    if (isWithinAuthorizedWorkspaceRootPath(targetPath)) return true;
    return isWithinTemporaryFileRoot(targetPath, senderId);
}

function fileAccessApprovalKey(filePath: string, operation: AgentFileOperation): string {
    return `${operation}\0${filePath}`;
}

function buildGrantApprovals(paths: Set<string>, operations: Set<AgentFileOperation>): Set<string> {
    const approvals = new Set<string>();
    for (const approvedPath of paths) {
        for (const operation of operations) {
            approvals.add(fileAccessApprovalKey(approvedPath, operation));
        }
    }
    return approvals;
}

function removeTemporaryRootsForSender(senderId: number): void {
    for (const [root, owners] of temporaryFileRoots) {
        owners.delete(senderId);
        if (owners.size === 0) temporaryFileRoots.delete(root);
    }
}

function grantApprovalPath(key: string): string {
    return key.slice(key.indexOf('\0') + 1);
}

function collectGrantApprovalsForRequest(grant: FileAccessGrant, approvals: Set<string>, resolvedPath: string, operation: AgentFileOperation): void {
    approvals.add(fileAccessApprovalKey(resolvedPath, operation));
    if (operation === 'read') return;
    for (const approval of [...grant.remainingApprovals]) {
        if (grantApprovalPath(approval) === resolvedPath) approvals.add(approval);
    }
}

export function isWithinAuthorizedWorkspaceRoot(filePath: string): boolean {
    try {
        return isWithinAuthorizedWorkspaceRootPath(canonicalizePotentialPath(filePath));
    } catch {
        return false;
    }
}

export function isWithinRegisteredRootForSender(filePath: string, senderId?: number): boolean {
    try {
        return isWithinRegisteredRoots(canonicalizePotentialPath(filePath), senderId);
    } catch {
        return false;
    }
}

function findAuthorizedWorkspaceRoot(targetPath: string): string | null {
    for (const root of authorizedWorkspaceRoots) {
        if (isWithinRoot(targetPath, root)) return root;
    }
    return null;
}

function removeExpiredGrants(now = Date.now()): void {
    for (const [grantId, grant] of fileAccessGrants) {
        if (grant.expiresAt <= now) fileAccessGrants.delete(grantId);
    }
    for (const [challengeId, challenge] of pendingFileAccessGrants) {
        if (challenge.expiresAt <= now) pendingFileAccessGrants.delete(challengeId);
    }
}

export function replaceAuthorizedWorkspaceRoots(workspaceRoots: string[]): void {
    authorizedWorkspaceRoots.clear();
    for (const workspaceRoot of workspaceRoots) {
        try {
            authorizedWorkspaceRoots.add(canonicalizePotentialPath(workspaceRoot));
        } catch {
            // 过期或不安全的历史工作区不应阻塞其它有效工作区恢复。
        }
    }
}

export function registerAuthorizedWorkspaceRoot(workspaceRoot: string): string {
    const canonicalRoot = canonicalizePotentialPath(workspaceRoot);
    authorizedWorkspaceRoots.add(canonicalRoot);
    return canonicalRoot;
}

export function registerTemporaryFileRoot(tempRoot: string, senderId?: number): string {
    const canonicalRoot = canonicalizePotentialPath(tempRoot);
    const owners = temporaryFileRoots.get(canonicalRoot) ?? new Set<number>();
    owners.add(senderId ?? GLOBAL_TEMP_ROOT_OWNER);
    temporaryFileRoots.set(canonicalRoot, owners);
    return canonicalRoot;
}

function deleteTemporaryFileRoot(canonicalRoot: string, senderId?: number): void {
    if (senderId === undefined) {
        temporaryFileRoots.delete(canonicalRoot);
        return;
    }
    const owners = temporaryFileRoots.get(canonicalRoot);
    if (!owners) return;
    owners.delete(senderId);
    if (owners.size === 0) temporaryFileRoots.delete(canonicalRoot);
}

export function unregisterTemporaryFileRoot(tempRoot: string, senderId?: number): void {
    try {
        deleteTemporaryFileRoot(canonicalizePotentialPath(tempRoot), senderId);
    } catch {
        // 清理路径已不存在时按原始规范化路径再尝试移除。
        try {
            deleteTemporaryFileRoot(path.resolve(resolveFilePath(tempRoot)), senderId);
        } catch {
            // 已经不可解析的临时路径不再持有可用授权。
        }
    }
}

export function isRegisteredTemporaryFileRoot(tempRoot: string, senderId?: number): boolean {
    try {
        const owners = temporaryFileRoots.get(canonicalizePotentialPath(tempRoot));
        if (!owners) return false;
        return senderId === undefined || owners.has(GLOBAL_TEMP_ROOT_OWNER) || owners.has(senderId);
    } catch {
        return false;
    }
}

export function isFilePathAuthorized(filePath: string): boolean {
    try {
        return isWithinRegisteredRoots(canonicalizePotentialPath(filePath));
    } catch {
        return false;
    }
}

export function prepareAgentFileAccessGrant(senderId: number, access: AgentFileAccessContext): string {
    removeExpiredGrants();
    const workspaceRoot = access.workspaceRoot ? canonicalizePotentialPath(access.workspaceRoot) : null;
    if (workspaceRoot && !isWithinAuthorizedWorkspaceRootPath(workspaceRoot)) {
        throw new Error('工作区根未经主进程登记，无法创建文件访问授权');
    }
    const approvedPaths = new Set(access.approvedPaths.map(canonicalizePotentialPath));
    if (approvedPaths.size === 0) throw new Error('没有需要授权的文件路径');
    const requestedOperations = (access.operations || []).filter(
        (operation): operation is AgentFileOperation => operation === 'read' || operation === 'write' || operation === 'delete',
    );
    const operations = new Set<AgentFileOperation>(requestedOperations.length > 0 ? requestedOperations : ['read']);
    const pathsWithinWorkspace = workspaceRoot
        ? [...approvedPaths].filter(targetPath => isWithinRoot(targetPath, workspaceRoot)).length
        : 0;
    const scope: AgentFileAccessScope = pathsWithinWorkspace === approvedPaths.size && approvedPaths.size > 0
        ? 'workspace'
        : pathsWithinWorkspace === 0
            ? 'external'
            : 'mixed';
    const challengeId = randomUUID();
    pendingFileAccessGrants.set(challengeId, {
        senderId,
        workspaceRoot,
        approvedPaths,
        operations,
        scope,
        expiresAt: Date.now() + FILE_ACCESS_CHALLENGE_TTL_MS,
    });
    return challengeId;
}

export function completeAgentFileAccessGrant(senderId: number, challengeId: string, userActivated: boolean): AgentFileAccessContext {
    removeExpiredGrants();
    const pending = pendingFileAccessGrants.get(challengeId);
    pendingFileAccessGrants.delete(challengeId);
    if (!pending || pending.senderId !== senderId) throw new Error('文件访问批准已失效，请重新确认');
    if (!userActivated) throw new Error('必须由当前窗口中的真实点击或键盘操作确认文件访问');
    const grantId = randomUUID();
    fileAccessGrants.set(grantId, {
        senderId,
        remainingApprovals: buildGrantApprovals(pending.approvedPaths, pending.operations),
        expiresAt: Date.now() + FILE_ACCESS_GRANT_TTL_MS,
    });
    return {
        workspaceRoot: null,
        fullAccess: false,
        approvedPaths: [],
        operations: [],
        grantId,
        senderId,
    };
}

export function cancelPendingFileAccessGrant(senderId: number, challengeId: string): void {
    const pending = pendingFileAccessGrants.get(challengeId);
    if (pending?.senderId === senderId) pendingFileAccessGrants.delete(challengeId);
}

export function getPendingFileAccessGrantDetails(senderId: number, challengeId: string): PendingFileAccessGrantDetails {
    removeExpiredGrants();
    const pending = pendingFileAccessGrants.get(challengeId);
    if (!pending || pending.senderId !== senderId) throw new Error('文件访问批准已失效，请重新确认');
    return {
        workspaceRoot: pending.workspaceRoot,
        approvedPaths: [...pending.approvedPaths],
        operations: [...pending.operations],
        scope: pending.scope,
        expiresAt: pending.expiresAt,
    };
}

export function revokeFileAccessGrantsForSender(senderId: number): void {
    for (const [grantId, grant] of fileAccessGrants) {
        if (grant.senderId === senderId) fileAccessGrants.delete(grantId);
    }
    for (const [challengeId, challenge] of pendingFileAccessGrants) {
        if (challenge.senderId === senderId) pendingFileAccessGrants.delete(challengeId);
    }
    removeTemporaryRootsForSender(senderId);
}

export function classifyAgentFileAccess(filePath: string, workspaceRoot: string | null): {
    resolvedPath: string;
    resolvedRoot: string | null;
    withinWorkspace: boolean;
} {
    const resolvedPath = canonicalizePotentialPath(filePath);
    const resolvedRoot = workspaceRoot ? canonicalizePotentialPath(workspaceRoot) : null;
    if (!resolvedRoot) return { resolvedPath, resolvedRoot, withinWorkspace: false };
    const trustedRoot = findAuthorizedWorkspaceRoot(resolvedRoot);
    const withinWorkspace = Boolean(trustedRoot && isWithinRoot(resolvedPath, resolvedRoot));
    return { resolvedPath, resolvedRoot, withinWorkspace };
}

export interface AgentFileAccessRequest {
    filePath: string;
    operation?: AgentFileOperation;
}

export function enforceAgentFileAccessRequests(
    requests: AgentFileAccessRequest[],
    access?: AgentFileAccessContext,
    senderId?: number,
): string[] {
    const resolvedRequests = requests.map(request => ({
        resolvedPath: canonicalizePotentialPath(request.filePath),
        operation: request.operation ?? 'read',
    }));
    const effectiveSenderId = senderId ?? access?.senderId;
    removeExpiredGrants();
    const grantId = access?.grantId;
    const grant = grantId ? fileAccessGrants.get(grantId) : undefined;
    const grantMatchesSender = Boolean(grant && effectiveSenderId !== undefined && grant.senderId === effectiveSenderId);
    const approvalsToConsume = new Set<string>();

    for (const request of resolvedRequests) {
        if (request.operation === 'read' && isWithinRegisteredRoots(request.resolvedPath, effectiveSenderId)) continue;
        const approvalKey = fileAccessApprovalKey(request.resolvedPath, request.operation);
        if (!grantMatchesSender || !grant!.remainingApprovals.has(approvalKey)) {
            throw new Error(`无权访问未登记工作区之外的路径: ${request.resolvedPath}`);
        }
        collectGrantApprovalsForRequest(grant!, approvalsToConsume, request.resolvedPath, request.operation);
    }

    if (grant && grantId) {
        for (const approval of approvalsToConsume) {
            grant.remainingApprovals.delete(approval);
        }
        if (grant.remainingApprovals.size === 0) fileAccessGrants.delete(grantId);
    }

    return resolvedRequests.map(request => request.resolvedPath);
}

export function enforceAgentFileAccess(
    filePath: string,
    access?: AgentFileAccessContext,
    senderId?: number,
    operation: AgentFileOperation = 'read',
): string {
    return enforceAgentFileAccessRequests([{ filePath, operation }], access, senderId)[0];
}
