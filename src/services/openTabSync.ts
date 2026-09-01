import { store } from '@/store';
import { fileSystem, resolveWorkspacePath } from '@/services/fileSystem';
import { setTabContent } from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';
import type { TrackedFileChange } from '@/services/fileChangeTracker';

/**
 * ★ #4：AI（主 agentLoop / 子代理）用 write_to_file 改了文件后，刷新「正打开该文件」的 editor tab。
 *
 * 根因：editor tab 的内容是一次性快照存在 Redux tab.content，viewer 加载 effect 头部 `if (tabContent !== undefined) return`
 *   会短路、永不重读盘；而 AI 写盘链路从不更新已打开 tab 的 content → 看到旧内容、必须关掉重开。
 * 策略（混合）：clean tab → 重读磁盘 setTabContent(markSaved) 自动同步（viewer 因 props.tabContent 变化自动重渲染，
 *   不动 viewer 短路逻辑、零回归）；dirty tab → 只提示不覆盖，绝不静默吞掉用户未保存的手动编辑。
 * 只处理带 content 快照的 viewer 类型（code/markdown/html）；office/pdf/image 等按 filePath 直读、本就不缓存 content。
 */
const REFRESHABLE_TAB_TYPES = new Set(['code', 'markdown', 'html']);

// 路径归一：统一分隔符 + 小写（Windows 大小写不敏感），用于 diff.path(解析后) ↔ tab.filePath 对齐比对。
const normPath = (p: string | undefined): string => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export async function refreshOpenTabsForChanges(changes: TrackedFileChange[]): Promise<void> {
  if (!changes || changes.length === 0) return;
  const tabs = store.getState().editorTabs.tabs;
  if (!tabs || tabs.length === 0) return;

  const seen = new Set<string>();
  for (const change of changes) {
    const rawPath = change.diff?.path;
    if (!rawPath || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const contextId = change.diff?.contextId;
    const conversationId = change.diff?.conversationId;

    // diff.path 是 AI 原始 args.path（可能相对/worktree 重定向前）——解析成绝对盘路径，与 tab.filePath 同口径。
    let resolved = rawPath;
    try { resolved = await resolveWorkspacePath(rawPath, contextId, conversationId); } catch { /* 解析失败：用原始路径兜底比对 */ }
    const targets = new Set([normPath(resolved), normPath(rawPath)]);

    const matched = tabs.filter(t => REFRESHABLE_TAB_TYPES.has(t.type) && t.filePath && targets.has(normPath(t.filePath)));
    if (matched.length === 0) continue;

    // 读一次最新磁盘内容（= 本次写入后的内容），所有命中 tab 共用。
    let fresh: string | null = null;
    try { fresh = await fileSystem.readFile(rawPath, contextId, conversationId); } catch { fresh = null; }

    for (const tab of matched) {
      if (tab.isDirty) {
        // 用户正在该 tab 手改且未保存 → 不覆盖，给提示把冲突决定权交还用户。
        store.dispatch(addNotification({
          type: 'warning',
          title: '文件已被 AI 修改',
          message: `${tab.fileName}：磁盘内容已变更，你在该文件的未保存改动未被覆盖（保存前请留意）`,
        }));
        continue;
      }
      if (fresh === null) continue;
      // clean tab：用最新磁盘内容刷新。markSaved → content+savedContent 同步、isDirty=false；
      //   viewer 的 props.tabContent 变化触发其加载 effect 重跑 setContent → 实时同步，无需改 viewer。
      store.dispatch(setTabContent({ id: tab.id, content: fresh, markSaved: true }));
    }
  }
}
