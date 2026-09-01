/**
 * Synapse 输入区命令层 — @ 两级菜单数据 provider（M6 富文本输入框）
 *
 * 富文本 @ 触发为两级菜单：
 *   ① 一级：选「类型」（七类，复刻 Antigravity，见 AT_TYPE_ENTRIES）。
 *   ② 二级：选该类型下的「具体项」（fetchTypeItems(type, query, ctx) 按 type 派发取数）。
 *
 * 设计要点：
 *   - 对话 / 工作流 / 设置三类【复用】已有 atSources.ts 的 getConversationItems / getWorkflowItems /
 *     getSettingsItems（不重复实现取数与过滤，保持口径一致）。
 *   - 文件 / 目录走 fileSystem.getWorkspaceTree() 取整棵树后递归展平、按 name/path 子串模糊过滤、slice 限量。
 *   - MCP 走 mcpBridge.listRegistered()（已桥接进 toolRegistry 的 mcp__server__tool 全名，同步、Web 天然空集）。
 *   - 终端目前【无】可供 provider 读取的全局数据源（会话态仅存在 TerminalPanel 组件内部 useState），故返回 []。
 *
 * ★ 每条 CompletionItem.meta 必带 { type, id, value } 三元组：富文本侧据此 new TokenSpec 插入 atomic token
 *   （TokenSpec.type / TokenSpec.id / TokenSpec.value，见 richInput/types.ts）。
 *   - file：id = 绝对路径，value = 相对工作区根的路径。
 *   - directory：id = 绝对路径，value = 相对路径且末尾加 `/`。
 *   - mcp：id = mcp__server__tool 全名，value = toolName（不含前缀）。
 *   - 对话 / 工作流 / 设置：在 meta 上叠加 { type, id, value }，与各自既有 meta 字段并存（不破坏原消费方）。
 */
import { fileSystem, type FileNode } from '@/services/fileSystem';
import { mcpBridge } from '@/services/mcpBridge';
import type { AtType } from './richInput/types';
import type { CompletionItem, CompletionGroup } from './types';
import { getConversationItems, getWorkflowItems, getSettingsItems } from './atSources';
import type { ConversationSummary } from '@/store/slices/conversationHistory';

/** 文件 / 目录每次返回上限（防菜单过长）。 */
const FILE_LIMIT = 12;
/** MCP 工具返回上限。 */
const MCP_LIMIT = 12;

/**
 * 一级类型菜单条目（顺序与 richInput/types.ts 的 AT_TYPES 一致：file/directory/conversation/workflow/settings/mcp/terminal）。
 * label 用英文（复刻 Antigravity 一级菜单），icon 用 emoji。
 */
export const AT_TYPE_ENTRIES: { type: AtType; label: string; icon: string }[] = [
  { type: 'file', label: 'Files', icon: '📄' },
  { type: 'directory', label: 'Directories', icon: '📁' },
  { type: 'conversation', label: 'Conversation', icon: '💬' },
  { type: 'workflow', label: 'Workflow', icon: '🔀' },
  { type: 'settings', label: 'Settings', icon: '⚙️' },
  { type: 'mcp', label: 'MCP', icon: '🔌' },
  { type: 'terminal', label: 'Terminal', icon: '🖥️' },
];

/** AtType → CompletionGroup 映射（用于二级候选的分组渲染）。 */
const GROUP_BY_TYPE: Record<AtType, CompletionGroup> = {
  file: '文件',
  directory: '目录',
  conversation: '对话',
  workflow: '工作流',
  settings: '设置',
  mcp: 'MCP',
  terminal: '终端',
};

/** 子串模糊匹配：query 空恒真；否则 haystacks 任一项含 query（忽略大小写）即命中。与 atSources.fuzzyMatch 同口径。 */
function fuzzyMatch(query: string, haystacks: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystacks.some(h => (h || '').toLowerCase().includes(q));
}

/** 归一路径分隔符为 `/`（Windows 反斜杠 → 正斜杠），便于相对路径计算与展示。 */
function normSlash(p: string): string {
  return (p || '').replace(/\\/g, '/');
}

/** 去掉末尾分隔符。 */
function stripTrailingSep(p: string): string {
  return normSlash(p).replace(/\/+$/, '');
}

/**
 * 计算 node.path 相对 rootPath 的相对路径（统一用 `/`）。
 * - node 在根下：返回去掉根前缀的相对段。
 * - node 等于根 / 不在根下（异常）：回退为 basename，避免返回空串或越界路径。
 */
function toRelative(absPath: string, rootPath: string): string {
  const abs = normSlash(absPath);
  const root = stripTrailingSep(rootPath);
  if (!root) return abs.replace(/^\/+/, '');
  if (abs.toLowerCase() === root.toLowerCase()) return ''; // 命中根自身
  const prefix = `${root}/`;
  if (abs.toLowerCase().startsWith(prefix.toLowerCase())) {
    return abs.slice(prefix.length);
  }
  // 不在根下（worktree 外 / 异常）：退化为文件名，至少可读。
  return abs.split('/').pop() || abs;
}

/**
 * 递归展平文件树，收集指定 type（file / directory）的节点，按 name/相对路径子串模糊过滤，限量返回。
 * 根节点本身不计入候选（它是工作区根，不作为可引用项）。
 */
function flattenTree(
  root: FileNode,
  wantType: 'file' | 'directory',
  query: string,
  rootPath: string,
  limit: number,
): CompletionItem[] {
  const out: CompletionItem[] = [];

  const walk = (node: FileNode, isRoot: boolean) => {
    if (out.length >= limit) return;
    if (!isRoot && node.type === wantType) {
      const rel = toRelative(node.path, rootPath);
      if (fuzzyMatch(query, [node.name, rel, node.path])) {
        // M6 收尾 C2/联动②：token.value 收敛为【绝对路径】（normSlash 归一）——下游 AI 调 view_file/list_dir
        // 拿绝对路径直查，避「无活动 worktree 时回落 process.cwd → 读到 Synapse 自身源码」高优 bug。
        // displayLabel = 相对路径（菜单/pill 仍是 @src/foo.ts 可读形态），dataset.label 同步存。
        const absNorm = normSlash(node.path);
        const value = wantType === 'directory' ? `${absNorm.replace(/\/+$/, '')}/` : absNorm;
        const displayLabel = rel || node.name;
        out.push({
          id: `at-${wantType}-${node.path}`,
          label: node.name,
          description: rel || undefined,
          group: GROUP_BY_TYPE[wantType],
          meta: { type: wantType, id: node.path, value, displayLabel },
        });
        if (out.length >= limit) return;
      }
    }
    if (node.children) {
      for (const child of node.children) {
        if (out.length >= limit) return;
        walk(child, false);
      }
    }
  };

  walk(root, true);
  return out;
}

/** file / directory 共用：取工作区树 → 展平过滤限量。失败（Web 降级 / 无树）返回 []。 */
async function fetchFileSystemItems(wantType: 'file' | 'directory', query: string): Promise<CompletionItem[]> {
  try {
    const tree = await fileSystem.getWorkspaceTree();
    if (!tree) return [];
    return flattenTree(tree, wantType, query, tree.path, FILE_LIMIT);
  } catch {
    return [];
  }
}

/**
 * @MCP 候选：来源 mcpBridge.listRegistered()（已桥接进 toolRegistry 的 mcp__server__tool 全名）。
 * 同步取数、Web 模式天然空集（mcpBridge.refresh 在 Web 下 servers=[]，registered 为空）。
 * id = mcp__server__tool 全名（token id），value = toolName（不含前缀，展示用）。
 */
function getMcpItems(query: string): CompletionItem[] {
  let fullNames: string[] = [];
  try {
    fullNames = mcpBridge.listRegistered();
  } catch {
    return [];
  }
  const out: CompletionItem[] = [];
  for (const fullName of fullNames) {
    // 解析 mcp__<server>__<tool>。
    const rest = fullName.startsWith('mcp__') ? fullName.slice('mcp__'.length) : fullName;
    const sep = rest.indexOf('__');
    const server = sep >= 0 ? rest.slice(0, sep) : '';
    const tool = sep >= 0 ? rest.slice(sep + 2) : rest;
    if (!fuzzyMatch(query, [tool, server, fullName])) continue;
    out.push({
      id: `at-mcp-${fullName}`,
      label: tool,
      description: server || undefined,
      group: GROUP_BY_TYPE.mcp,
      meta: { type: 'mcp', id: fullName, value: tool },
    });
    if (out.length >= MCP_LIMIT) break;
  }
  return out;
}

/** 给复用 atSources 的候选叠加 { type, id, value } 三元组（不破坏其原有 meta 字段）。 */
function withTriple(items: CompletionItem[], type: AtType, idFrom: (m: Record<string, unknown>) => string): CompletionItem[] {
  return items.map(it => {
    const meta = (it.meta ?? {}) as Record<string, unknown>;
    return {
      ...it,
      meta: { ...meta, type, id: idFrom(meta), value: it.label },
    };
  });
}

/**
 * 二级候选取数：按 AtType 派发。
 * @param type  已选定的一级类型。
 * @param query 二级菜单过滤片段（@type:query 的 query 段，可空）。
 * @param ctx   运行上下文：convCache = AgentPanel @ 触发时独立 load 的全部对话（透传给 getConversationItems）。
 */
export async function fetchTypeItems(
  type: AtType,
  query: string,
  ctx: { convCache: ConversationSummary[] | null },
): Promise<CompletionItem[]> {
  switch (type) {
    case 'conversation':
      // 复用 atSources；token id = conversationId，value = title。
      return withTriple(
        getConversationItems(query, ctx.convCache ?? undefined),
        'conversation',
        m => String(m.conversationId ?? ''),
      );

    case 'workflow':
      // M6 收尾 C2/LOW-2：token.value/id 用 mode.id（英文 slug，无空格），让 `@MultiAI:<id>` 占位
      // 经 parseMultiAITrigger 的 `^(\S+)` 严格扫描不会截断。displayLabel = mode.name（含空格 OK，仅作 pill 显示）。
      return getWorkflowItems(query).map(it => {
        const meta = (it.meta ?? {}) as Record<string, unknown>;
        const modeId = String(meta.modeId ?? '');
        const modeName = String(meta.modeName ?? it.label);
        return {
          ...it,
          meta: {
            ...meta,
            type: 'workflow' as const,
            id: modeId || modeName, // 兜底：极端旧数据没 modeId 时退回 modeName（仍可能被截断，但功能不挂）
            value: modeId || modeName,
            displayLabel: modeName,
          },
        };
      });

    case 'settings':
      // 复用 atSources；token id = sectionId，value = 设置项 label。
      return withTriple(
        getSettingsItems(query),
        'settings',
        m => String(m.sectionId ?? ''),
      );

    case 'file':
      return fetchFileSystemItems('file', query);

    case 'directory':
      return fetchFileSystemItems('directory', query);

    case 'mcp':
      return getMcpItems(query);

    case 'terminal':
      // 终端会话态仅存在于 TerminalPanel 组件内部 useState，无全局可读数据源 → 暂无候选。
      return [];

    default:
      return [];
  }
}