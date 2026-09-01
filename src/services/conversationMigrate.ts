/**
 * conversationMigrate — 未保存对话 fork 成真实 id 时的「迁桶 + owner alias」迁移 helper。
 *
 * ★ #8 选A（byId 真并发）：未保存对话（AUTOSAVE_ID 草稿）在生成中被切走时，saveConversationSnapshot 会把它
 *   fork 成一个新的真实对话 id。此时若后台仍有 AgentLoop 在跑这条对话（runConvId === fromId），它后续的
 *   对话私有写入仍指向旧的 fromId 桶，而 UI/持久化已转移到 toId 桶——后台进度会写到一个被遗弃的桶里（丢进度），
 *   或与新草稿桶串台。这里三件事一起做，保证 fork 后不丢后台进度、不串台：
 *     1) executionRegistry.promoteConversation：保持 ownerId 不变，只把该 owner 的别名从 fromId 指向 toId。
 *     2) renameConversationBucket：把 Redux 桶整体迁到 toId；新 AUTOSAVE 会获得新的 ownerId。
 */
import { store } from '@/store';
import { renameConversationBucket } from '@/store/slices/conversation';
import { executionRegistry } from '@/services/executionRegistry';
import { bpcScheduler } from '@/services/bpcScheduler';
import { platform } from '@/platform';
import type { ContextGenerationState } from '@/services/recordStore';
import { promoteAgentSessionCheckpoint } from '@/services/agentSessionCheckpoint';

export async function migrateForkedConversation(
  fromId: string | null | undefined,
  toId: string | null | undefined,
  generationSnapshot?: ContextGenerationState | null,
  restoredRecordRevision?: number | null,
): Promise<void> {
  if (!fromId || !toId || fromId === toId) return;
  const promoted = await platform.conversation.promoteRecord?.(fromId, toId, {
    generationSnapshot,
    restoredRecordRevision,
  });
  if (promoted === false) throw new Error(`Conversation runtime promotion failed: ${fromId} -> ${toId}`);
  await executionRegistry.promoteConversation(fromId, toId);
  await bpcScheduler.promoteConversation(fromId, toId);
  promoteAgentSessionCheckpoint(fromId, toId);
  store.dispatch(renameConversationBucket({ fromId, toId }));
}
