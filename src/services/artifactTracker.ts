import type { MessageArtifact } from '@/store/slices/conversation';

/**
 * 产物卡片账本（show_artifact 工具用）—— file-change diff 账本（fileChangeTracker）的孪生体，但更简单：
 *   artifact 只是「指向一个已存在文件的卡片」（path + label + editorType），不写盘、无 diff/snapshot。
 *
 * 与 fileChangeTracker 一致地按 contextId 分桶 record/consume，杜绝并行子代理与主 agentLoop 共享单一
 * 全局数组导致的竞态串台（A record 后到 A consume 之间 B 也 record → A 的 consume 把 B 的一并吞掉）。
 *   - contextId 来源：主 agentLoop = execContextId（对话 id ?? AUTOSAVE_ID）；子代理 = subagentId。
 *   - 缺省键 DEFAULT_BUCKET：极端兜底（contextId 未透传时）。
 *   - 桶在 consume（splice 至空）后即删除，避免长期运行下 Map 无限增长。
 */
const DEFAULT_BUCKET = '__default__';
const pendingArtifactsByContext = new Map<string, MessageArtifact[]>();

/**
 * 记录一张产物卡片到【该 contextId 的桶】。
 * @param contextId 执行上下文 id（主 agentLoop=对话 id ?? AUTOSAVE_ID；子代理=subagentId）。缺省落 DEFAULT_BUCKET。
 */
export function recordTrackedArtifact(artifact: MessageArtifact, contextId?: string): void {
  const key = contextId || DEFAULT_BUCKET;
  let bucket = pendingArtifactsByContext.get(key);
  if (!bucket) {
    bucket = [];
    pendingArtifactsByContext.set(key, bucket);
  }
  bucket.push(artifact);
}

/**
 * 取出并清空【该 contextId 桶】的全部 pending 产物卡片；其它上下文的桶不受影响（不串台）。
 * @param contextId 同 recordTrackedArtifact；缺省消费 DEFAULT_BUCKET。
 */
export function consumeTrackedArtifacts(contextId?: string): MessageArtifact[] {
  const key = contextId || DEFAULT_BUCKET;
  const bucket = pendingArtifactsByContext.get(key);
  if (!bucket || bucket.length === 0) {
    if (bucket) pendingArtifactsByContext.delete(key);
    return [];
  }
  const drained = bucket.splice(0, bucket.length);
  pendingArtifactsByContext.delete(key);
  return drained;
}
