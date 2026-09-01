/**
 * Synapse 输入区命令层 — @ 三类数据源 provider（M4-6-S2）
 *
 * getAtCompletions(query) 合并三类源、按 query 模糊过滤、各组限量（每组 ≤ 8），返回扁平有序候选数组
 * （顺序：对话 → 工作流 → 设置），供 InlineCompletionMenu 渲染。三类「选中后插入什么」的语义差异
 * 由 AgentPanel 据 CompletionItem.group/meta 解读（@对话插 token / @工作流糖衣 / @设置跳转）。
 *
 * 数据源：
 *   ① 对话   = store.conversationHistory.conversations（label=title，meta={conversationId,title}）。
 *   ② 工作流 = store.multiAI.modes 中 workflow 非空者（label=mode.name，meta={modeName}）。
 *   ③ 设置   = settingsIndex.SETTINGS_INDEX（label，meta={sectionId}，keywords 参与匹配）。
 */
import { store } from '@/store';
import type { CompletionItem } from './types';
import { SETTINGS_INDEX } from './settingsIndex';
import type { ConversationSummary } from '@/store/slices/conversationHistory';
import type { MultiAIMode } from '@/store/slices/multiAI';

/** 每组候选上限（防浮层过长 + 不喧宾夺主）。 */
const PER_GROUP_LIMIT = 8;
/** 对话副描述（lastMessage）截断长度。 */
const DESC_MAX = 40;

/** 子串模糊匹配：query 为空恒真；否则在 haystack 列表中任一项含 query（不区分大小写）即命中。 */
function fuzzyMatch(query: string, haystacks: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystacks.some(h => (h || '').toLowerCase().includes(q));
}

function truncate(s: string | undefined, max: number): string {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** 相对时间（粗粒度，候选副描述用）。 */
function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}

/** ① @对话候选。优先用调用方传入的 convOverride（AgentPanel @ 触发时独立 load 的全部对话，不受左侧栏工作区过滤限制、
 *  也不依赖列表 UI 是否挂载过）；未传时回退共享 slice conversationHistory.conversations。按 title/lastMessage 模糊匹配。 */
export function getConversationItems(query: string, convOverride?: ConversationSummary[]): CompletionItem[] {
  const state = store.getState() as any;
  const conversations: ConversationSummary[] = convOverride ?? state?.conversationHistory?.conversations ?? [];
  return conversations
    .filter(c => fuzzyMatch(query, [c.title, c.lastMessage]))
    .slice(0, PER_GROUP_LIMIT)
    .map(c => {
      const rel = relativeTime(c.timestamp);
      const last = truncate(c.lastMessage, DESC_MAX);
      const desc = [last, rel].filter(Boolean).join(' · ');
      return {
        id: `at-conv-${c.id}`,
        label: c.title || '未命名对话',
        description: desc || undefined,
        group: '对话' as const,
        meta: { conversationId: c.id, title: c.title || '未命名对话' },
      };
    });
}

/** ② @工作流候选（来源 multiAI.modes 中 workflow 非空者，与 resolveWorkflowMode 命名口径一致）。 */
export function getWorkflowItems(query: string): CompletionItem[] {
  const state = store.getState() as any;
  const modes: MultiAIMode[] = state?.multiAI?.modes ?? [];
  return modes
    .filter(m => Array.isArray(m.workflow) && m.workflow.length > 0)
    .filter(m => fuzzyMatch(query, [m.name, m.description]))
    .slice(0, PER_GROUP_LIMIT)
    .map(m => ({
      id: `at-wf-${m.id}`,
      label: m.name,
      description: truncate(m.description, DESC_MAX) || undefined,
      group: '工作流' as const,
      // M6 收尾 C2/LOW-2：meta 同时带 modeId（英文 slug，token.value 用）和 modeName（人类可读，displayLabel 用）。
      meta: { modeName: m.name, modeId: m.id },
    }));
}

/** ③ @设置候选（来源 SETTINGS_INDEX，label + keywords 参与模糊匹配）。 */
export function getSettingsItems(query: string): CompletionItem[] {
  return SETTINGS_INDEX
    .filter(s => fuzzyMatch(query, [s.label, ...s.keywords]))
    .slice(0, PER_GROUP_LIMIT)
    .map(s => ({
      id: `at-set-${s.id}`,
      label: s.label,
      group: '设置' as const,
      meta: { sectionId: s.sectionId },
    }));
}

/**
 * 合并三源 → 扁平有序候选（对话 → 工作流 → 设置），各组 ≤ PER_GROUP_LIMIT，按 query 模糊过滤。
 * @param query @ 之后到光标的片段（可空）。
 */
export function getAtCompletions(query: string, convOverride?: ConversationSummary[]): CompletionItem[] {
  return [
    ...getConversationItems(query, convOverride),
    ...getWorkflowItems(query),
    ...getSettingsItems(query),
  ];
}
