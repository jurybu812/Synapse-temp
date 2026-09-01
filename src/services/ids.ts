/**
 * 共享运行态 id 生成器（M4-2-S2）。
 *
 * ★ 问题 2b(1) 根因收敛：运行态 message/event id 旧实现是 `${prefix}_${Date.now()}_${base36(6)}`，
 *   同毫秒紧循环里唯一性只剩 6 位 base36 随机后缀（36^6 ≈ 21.7 亿空间）——长对话快速连发时
 *   既可能同批自撞、也可能撞库里历史 id，而 message:replaceConversation 是纯 INSERT（撞 messages.id
 *   UNIQUE 即整事务回滚 → 弹「自动保存失败」toast）。
 *   统一收敛到 crypto.randomUUID（122 位随机，全库碰撞概率趋于 0），与 conversationPersistence.createMessageId
 *   口径一致，治本同批自撞与跨行撞。
 *
 * 设计取舍（与 createMessageId 对齐）：
 *   - 保留 prefix 习惯（msg_ / run_ / evt_ / user_ / assistant_ …），便于日志/调试一眼辨别来源。
 *   - 带回退：非安全上下文 / 旧环境无 crypto.randomUUID 时退回「时间戳 + 双段随机」高熵后缀，
 *     仍显著优于旧单段 base36(6)，把同毫秒同后缀概率压到可忽略。
 */
export function generateId(prefix = 'msg'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  // Fallback（无 crypto.randomUUID 的环境）：双段随机扩大熵，降低同毫秒同后缀概率。
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}
