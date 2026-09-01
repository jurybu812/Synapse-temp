/**
 * Synapse 输入区命令层 — 共享类型（M4-6）
 *
 * CompletionItem 是内联补全浮层（InlineCompletionMenu）与各数据源（atSources / commandRegistry）
 * 之间的统一契约。放在独立 types 模块，避免「组件 ↔ service」互相 import 造成环。
 */

/** 候选分组（浮层按此分组渲染分组标题）。 */
export type CompletionGroup = '对话' | '工作流' | '设置' | '命令' | '文件' | '目录' | 'MCP' | '终端' | '类型';

/**
 * 一条补全候选。
 * - 选中后「插入什么」由各数据源在 onSelect 回调里据 group/meta 决定（@对话插 token、@工作流糖衣、
 *   @设置跳转、/命令补全命令名），CompletionItem 自身只承载展示与定位数据。
 */
export interface CompletionItem {
  /** 候选唯一 id（React key + 选中分发判别）。 */
  id: string;
  /** 主标签（候选名）。 */
  label: string;
  /** 副描述（截断的预览 / 命令说明等，可选）。 */
  description?: string;
  /** 所属分组（浮层分组渲染）。 */
  group: CompletionGroup;
  /**
   * 插入语义所需的额外数据（由各数据源自定义，调用方据 group 解读）：
   *   - 对话：{ conversationId, title }
   *   - 工作流：{ modeName }
   *   - 设置：{ sectionId }
   *   - 命令：{ name }（命令名，不含斜杠）
   */
  meta?: Record<string, unknown>;
}
