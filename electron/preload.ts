import { contextBridge, ipcRenderer } from 'electron';

type AgentFileOperation = 'read' | 'write' | 'delete';
type AgentFileAccessContext = { workspaceRoot: string | null; fullAccess: boolean; approvedPaths: string[]; operations?: AgentFileOperation[]; grantId?: string };

contextBridge.exposeInMainWorld('synapse', {
  // 平台信息
  platform: {
    info: () => ipcRenderer.invoke('platform:info'),
    openExternal: (url: string) => ipcRenderer.invoke('platform:openExternal', url),
    isElectron: true,
  },

  // 窗口操作
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onCloseRequested: (callback: (payload: { requestId: string; action: 'close' | 'reload' | 'reloadIgnoringCache' }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: string; action: 'close' | 'reload' | 'reloadIgnoringCache' }) => callback(payload);
      ipcRenderer.on('window:confirm-unload', listener);
      return () => ipcRenderer.removeListener('window:confirm-unload', listener);
    },
    setDirty: (dirty: boolean) => ipcRenderer.send('window:set-dirty', dirty),
    confirmClose: (requestId: string) => ipcRenderer.send('window:confirm-unload', requestId),
    cancelClose: (requestId: string) => ipcRenderer.send('window:cancel-unload', requestId),
  },

  // 文件操作 (Stage 4 实现)
  file: {
    setApprovalPolicy: (policy: { autoApproveWrite: boolean }) => ipcRenderer.invoke('file:setApprovalPolicy', policy) as Promise<{ autoApproveWrite: boolean }>,
    prepareAccessGrant: (access: AgentFileAccessContext) => ipcRenderer.invoke('file:prepareAccessGrant', access),
    completeAccessGrant: (challengeId: string) => ipcRenderer.invoke('file:completeAccessGrant', challengeId),
    cancelAccessGrant: (challengeId: string) => ipcRenderer.invoke('file:cancelAccessGrant', challengeId),
    exists: (filePath: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:exists', filePath, access),
    read: (filePath: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:read', filePath, access),
    readBinary: (filePath: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:readBinary', filePath, access),
    convertOffice: (filePath: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:convertOffice', filePath, access),
    cleanupTemp: (targetPath: string) => ipcRenderer.invoke('file:cleanupTemp', targetPath),
    write: (filePath: string, content: string, access?: AgentFileAccessContext, options?: { expectedContent?: string }) => ipcRenderer.invoke('file:write', filePath, content, access, options),
    list: (dir: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:list', dir, access),
    search: (dir: string, pattern: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:search', dir, pattern, access),
    grep: (dir: string, query: string, opts: any, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:grep', dir, query, opts, access),
    rename: (oldPath: string, newPath: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:rename', oldPath, newPath, access),
    delete: (targetPath: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:delete', targetPath, access),
    mkdir: (targetPath: string, access?: AgentFileAccessContext) => ipcRenderer.invoke('file:mkdir', targetPath, access),
    classifyAccess: (filePath: string, workspaceRoot: string | null) => ipcRenderer.invoke('file:classifyAccess', filePath, workspaceRoot),
    showInFolder: (targetPath: string) => ipcRenderer.invoke('file:showInFolder', targetPath),
  },

  wallpaper: {
    importFromDialog: () => ipcRenderer.invoke('wallpaper:importFromDialog'),
    importFiles: (filePaths: string[]) => ipcRenderer.invoke('wallpaper:importFiles', filePaths),
    remove: (asset: any) => ipcRenderer.invoke('wallpaper:remove', asset),
    clear: (assets: any[]) => ipcRenderer.invoke('wallpaper:clear', assets),
  },

  // 工作区操作
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    recent: (limit?: number) => ipcRenderer.invoke('workspace:recent', limit),
    switch: (id: string) => ipcRenderer.invoke('workspace:switch', id),
    delete: (id: string) => ipcRenderer.invoke('workspace:delete', id),
    tree: (wsPath: string, maxDepth?: number, access?: AgentFileAccessContext) => ipcRenderer.invoke('workspace:tree', wsPath, maxDepth, access),
  },

  // MCP 操作 (Stage 8 实现)
  mcp: {
    callTool: (server: string, tool: string, params: any) =>
      ipcRenderer.invoke('mcp:callTool', server, tool, params),
    listTools: (server: string) => ipcRenderer.invoke('mcp:listTools', server),
    getStatus: () => ipcRenderer.invoke('mcp:status'),
    restart: (server: string) => ipcRenderer.invoke('mcp:restart', server),
    start: (server: string) => ipcRenderer.invoke('mcp:start', server),
    stop: (server: string) => ipcRenderer.invoke('mcp:stop', server),
    // ★ MCP 竞态修复：订阅主进程广播的「server 状态变更（已就绪 running）」事件。
    //   主进程在 server initialize 握手成功后 webContents.send('mcp:status-changed', {name})，
    //   渲染端 mcpBridge 据此自动 refresh() 补注册 mcp__* 工具。返回取消订阅函数。
    onStatusChanged: (cb: (payload: { name: string; status: string }) => void) => {
      const listener = (_e: any, payload: { name: string; status: string }) => cb(payload);
      ipcRenderer.on('mcp:status-changed', listener);
      return () => ipcRenderer.removeListener('mcp:status-changed', listener);
    },
  },

  // 命令执行 (Stage 7 实现)
  command: {
    start: (request: { command: string; cwd?: string; taskId?: string; conversationId: string; runId: string; callId: string; ownerId: string }) => ipcRenderer.invoke('command:start', request),
    status: (taskId: string, access: { conversationId?: string; ownerId: string }) => ipcRenderer.invoke('command:status', taskId, access),
    wait: (taskId: string, waitSeconds: number, access: { conversationId?: string; ownerId: string }) => ipcRenderer.invoke('command:wait', taskId, waitSeconds, access),
    cancel: (taskId: string, access: { conversationId?: string; ownerId: string }) => ipcRenderer.invoke('command:cancel', taskId, access),
    rebindConversation: (request: { ownerId: string; fromId: string; toId: string }) => ipcRenderer.invoke('command:rebindConversation', request),
  },

  toolTask: {
    start: (request: { kind: string; taskId?: string; identity: { conversationId: string; runId: string; callId: string; ownerId: string }; input: unknown }) => ipcRenderer.invoke('tool-task:start', request),
    list: (request: { conversationId: string; ownerId: string }) => ipcRenderer.invoke('tool-task:list', request),
    status: (taskId: string, access: { conversationId?: string; ownerId: string }) => ipcRenderer.invoke('tool-task:status', taskId, access),
    wait: (taskId: string, waitSeconds: number, access: { conversationId?: string; ownerId: string }) => ipcRenderer.invoke('tool-task:wait', taskId, waitSeconds, access),
    cancel: (taskId: string, access: { conversationId?: string; ownerId: string }) => ipcRenderer.invoke('tool-task:cancel', taskId, access),
    cancelPendingApproval: (taskId: string) => ipcRenderer.invoke('tool-task:cancelPendingApproval', taskId),
    rebindConversation: (request: { ownerId: string; fromId: string; toId: string }) => ipcRenderer.invoke('tool-task:rebindConversation', request),
  },

  // git worktree 管理 (M2-4)
  worktree: {
    list: (opts: { repoRoot: string }) => ipcRenderer.invoke('worktree:list', opts),
    create: (opts: { repoRoot: string; branch: string; path?: string; name?: string }) =>
      ipcRenderer.invoke('worktree:create', opts),
    remove: (opts: { repoRoot: string; path: string; force?: boolean }) =>
      ipcRenderer.invoke('worktree:remove', opts),
    status: (opts: { repoRoot: string; path: string }) => ipcRenderer.invoke('worktree:status', opts),
  },

  // 附件分离存储 (M2-R6) — 内容寻址 blob 层。桌面走 IPC，落 userData/attachments/。
  attachment: {
    put: (opts: { data: string; mime?: string; name?: string; kind?: string }) =>
      ipcRenderer.invoke('attachment:put', opts),
    get: (sha256: string) => ipcRenderer.invoke('attachment:get', sha256),
    has: (sha256: string) => ipcRenderer.invoke('attachment:has', sha256),
    delete: (sha256: string) => ipcRenderer.invoke('attachment:delete', sha256),
    addRef: (sha256: string) => ipcRenderer.invoke('attachment:addRef', sha256),
    release: (sha256: string) => ipcRenderer.invoke('attachment:release', sha256),
  },

  // 终端 (Stage 13 实现)
  terminal: {
    create: (opts: any) => ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  },

  // 设置 (Stage 12 实现)
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    getSync: (key: string) => {
      const result = ipcRenderer.sendSync('config:getSync', key) as { ok?: boolean; value?: unknown } | undefined;
      return result?.ok ? result.value : null;
    },
    setSync: (key: string, value: any) => {
      const result = ipcRenderer.sendSync('config:setSync', key, value) as { ok?: boolean } | undefined;
      return result?.ok === true;
    },
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
  },

  provider: {
    credentialStatus: (providerId: string) => ipcRenderer.invoke('provider:credentialStatus', providerId),
    setApiKey: (providerId: string, apiKey: string, baseUrl: string) => ipcRenderer.invoke('provider:setApiKey', providerId, apiKey, baseUrl),
    deleteCredential: (providerId: string) => ipcRenderer.invoke('provider:deleteCredential', providerId),
    fetchModels: (providerId: string, force?: boolean) => ipcRenderer.invoke('provider:fetchModels', providerId, force),
    startChat: (request: any) => ipcRenderer.invoke('provider:chatStart', request),
    recordUsage: (usage: any) => ipcRenderer.invoke('provider:recordUsage', usage),
    latestUsage: (conversationId: string) => ipcRenderer.invoke('provider:latestUsage', conversationId),
    invalidateUsage: (conversationId: string) => ipcRenderer.invoke('provider:invalidateUsage', conversationId),
    promoteUsage: (fromId: string, toId: string) => ipcRenderer.invoke('provider:promoteUsage', fromId, toId),
    cancelChat: (request: { requestId: string; cancelToken: string }) => ipcRenderer.invoke('provider:chatCancel', request),
    onChatEvent: (callback: (payload: any) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: any) => callback(payload);
      ipcRenderer.on('provider:chat:event', listener);
      return () => ipcRenderer.removeListener('provider:chat:event', listener);
    },
    openAICodexStatus: () => ipcRenderer.invoke('provider:openAICodexStatus'),
    openAICodexLogin: () => ipcRenderer.invoke('provider:openAICodexLogin'),
    openAICodexCancel: () => ipcRenderer.invoke('provider:openAICodexCancel'),
    openAICodexLogout: () => ipcRenderer.invoke('provider:openAICodexLogout'),
    openAICodexModels: (force?: boolean) => ipcRenderer.invoke('provider:openAICodexModels', force),
    windsurfStatus: () => ipcRenderer.invoke('provider:windsurfStatus'),
    windsurfLogin: () => ipcRenderer.invoke('provider:windsurfLogin'),
    windsurfComplete: (transactionId: string, token: string) => ipcRenderer.invoke('provider:windsurfComplete', transactionId, token),
    windsurfImportLocal: (options?: { confirmationToken?: string }) => ipcRenderer.invoke('provider:windsurfImportLocal', options),
    windsurfCancel: () => ipcRenderer.invoke('provider:windsurfCancel'),
    windsurfLogout: () => ipcRenderer.invoke('provider:windsurfLogout'),
    windsurfModels: (force?: boolean) => ipcRenderer.invoke('provider:windsurfModels', force),
  },

  // 对话持久化
  conversation: {
    create: (data: any) => ipcRenderer.invoke('conversation:create', data),
    list: (opts?: any) => ipcRenderer.invoke('conversation:list', opts),
    get: (id: string) => ipcRenderer.invoke('conversation:get', id),
    update: (id: string, data: any) => ipcRenderer.invoke('conversation:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('conversation:delete', id),
    batchDelete: (ids: string[]) => ipcRenderer.invoke('conversation:batchDelete', ids),
    batchUpdate: (ids: string[], data: any) => ipcRenderer.invoke('conversation:batchUpdate', ids, data),
    addMessage: (message: any) => ipcRenderer.invoke('message:add', message),
    // M4-2-S1：透传 opts.systemTouch（切走对话的系统性保存不刷 updated_at）。
    replaceMessages: (conversationId: string, messages: any[], opts?: { systemTouch?: boolean }) =>
      ipcRenderer.invoke('message:replaceConversation', conversationId, messages, opts),
    listMessages: (conversationId: string) => ipcRenderer.invoke('message:list', conversationId),
    search: (query: string, opts?: any) => ipcRenderer.invoke('conversation:search', query, opts),
    // Record（M1 上下文 harness 过程日志）
    getRecord: (conversationId: string) => ipcRenderer.invoke('record:get', conversationId),
    saveRecord: (data: any) => ipcRenderer.invoke('record:upsert', data),
    deleteRecord: (conversationId: string) => ipcRenderer.invoke('record:delete', conversationId),
    getRecordCandidate: (conversationId: string) => ipcRenderer.invoke('record:candidate:get', conversationId),
    updateRecordGenerationState: (data: any) => ipcRenderer.invoke('record:generation:update', data),
    prepareRecordCandidate: (data: any) => ipcRenderer.invoke('record:candidate:prepare', data),
    publishRecordCandidate: (data: any) => ipcRenderer.invoke('record:candidate:publish', data),
    discardRecordCandidate: (data: any) => ipcRenderer.invoke('record:candidate:discard', data),
    promoteRecord: (fromId: string, toId: string, options?: any) => ipcRenderer.invoke('record:promote', fromId, toId, options),
  },

  // Memory（M1 上下文 harness：AI 主动记忆，内置 memory_write/memory_query 工具的后端）
  memory: {
    write: (data: any) => ipcRenderer.invoke('memory:write', data),
    query: (opts?: any) => ipcRenderer.invoke('memory:query', opts),
    get: (id: string) => ipcRenderer.invoke('memory:get', id),
    list: (opts?: any) => ipcRenderer.invoke('memory:list', opts),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
  },
});
