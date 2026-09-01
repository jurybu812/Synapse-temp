/**
 * Synapse 输入区命令层 — @设置可寻址清单（M4-6-S2）
 *
 * 设置项【无单一数据源】（settings slice 是扁平字段、SettingsPanel 是分区 UI），故本里程碑手工建一份
 * 「可寻址设置项清单」：每条带 label（展示名）+ sectionId（所属分区，对齐 SettingsPanel.tabs 的 id）
 * + keywords（模糊搜索辅助词，含近义/英文）。
 *
 * @设置 选中后是【纯跳转】（Plan_5 §7 决议 3）：openSettings + 发 `synapse:settings-focus-section`
 * 事件带 sectionId，SettingsPanel 监听后切到该分区。故 sectionId 必须与 SettingsPanel.tabs 的 id 严格一致：
 *   general / ai / conversation / safety / synopsis / multiAI / plugins / worktree / data / about
 */

export interface SettingsIndexEntry {
  /** 条目唯一 id。 */
  id: string;
  /** 展示名（候选 label）。 */
  label: string;
  /** 所属分区 id（= SettingsPanel.tabs[].id，跳转定位用）。 */
  sectionId: string;
  /** 模糊搜索辅助关键词（含近义词 / 英文 / 技术栈词）。 */
  keywords: string[];
}

/**
 * 可寻址设置项清单。覆盖 SettingsPanel 现有分区的可定位项（AI / 安全 / 提示注入 / 外观 / 工作树等）。
 * 同一分区可有多条（不同自然搜索词都能命中并跳到该分区）。
 */
export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  // —— 通用（general）——
  { id: 'set-language', label: '语言', sectionId: 'general', keywords: ['语言', 'language', '中文', '英文', 'lang'] },
  { id: 'set-fontsize', label: '字号', sectionId: 'general', keywords: ['字号', '字体大小', 'font', 'fontsize', '大小'] },
  { id: 'set-theme', label: '主题 / 外观', sectionId: 'general', keywords: ['主题', '外观', 'theme', '深色', '浅色', 'dark', 'light', '强调色', 'accent', '颜色'] },
  { id: 'set-wallpaper', label: '壁纸 / 背景', sectionId: 'general', keywords: ['壁纸', '背景', 'wallpaper', 'background', '背景图'] },

  // —— AI ——
  { id: 'set-apikey', label: 'API Key', sectionId: 'ai', keywords: ['api', 'apikey', 'key', '密钥', '令牌', 'token'] },
  { id: 'set-endpoint', label: 'API 端点', sectionId: 'ai', keywords: ['端点', 'endpoint', '地址', 'baseurl', 'url', 'api'] },
  { id: 'set-model', label: '模型选择', sectionId: 'ai', keywords: ['模型', 'model', '获取模型', 'models', 'gpt', 'claude'] },
  { id: 'set-system-model', label: '系统模型', sectionId: 'ai', keywords: ['系统模型', 'system model', '后台模型', '压缩模型', '标题模型'] },
  { id: 'set-params', label: '模型参数（温度 / Top P / Max Tokens）', sectionId: 'ai', keywords: ['参数', '温度', 'temperature', 'topp', 'top p', 'maxtokens', 'max tokens', 'reasoning', 'speed'] },

  // —— 对话（conversation）——
  { id: 'set-history-limit', label: '对话历史上限', sectionId: 'conversation', keywords: ['历史', '对话历史', 'history', '上限', '保留', '条数'] },
  { id: 'set-auto-archive', label: '自动归档', sectionId: 'conversation', keywords: ['归档', 'archive', '自动归档', '过期'] },

  // —— 安全（safety）——
  { id: 'set-safety', label: '安全 / 工具审批', sectionId: 'safety', keywords: ['安全', 'safety', '审批', '自动批准', 'approve', '工具权限', '读', '写', '命令', 'autoapprove'] },

  // —— 提示注入（promptInjection 在 safety/synopsis 区，按现有 UI 归 safety）——
  { id: 'set-prompt-injection', label: '提示注入', sectionId: 'safety', keywords: ['提示注入', 'prompt injection', '注入', 'injection', '提示词'] },

  // —— Synopsis ——
  { id: 'set-synopsis', label: 'Synopsis 概要', sectionId: 'synopsis', keywords: ['synopsis', '概要', '摘要', '自动索引', '索引', 'index'] },

  // —— Multi-AI ——
  { id: 'set-multiai', label: 'Multi-AI / 工作流', sectionId: 'multiAI', keywords: ['multiai', 'multi-ai', '工作流', 'workflow', '子代理', 'subagent', '并发', '协作'] },

  // —— 插件（plugins）——
  { id: 'set-plugins', label: '插件 / MCP', sectionId: 'plugins', keywords: ['插件', 'plugin', 'mcp', '扩展', 'extension', 'skill', '技能'] },

  // —— 工作树（worktree）——
  { id: 'set-worktree', label: '工作树（git worktree）', sectionId: 'worktree', keywords: ['工作树', 'worktree', 'git', '隔离', '分支', 'branch'] },

  // —— 数据（data）——
  { id: 'set-data', label: '数据 / 导出 / 存储', sectionId: 'data', keywords: ['数据', 'data', '导出', 'export', '存储', 'storage', '清理', '备份'] },

  // —— 关于（about）——
  { id: 'set-about', label: '关于', sectionId: 'about', keywords: ['关于', 'about', '版本', 'version', '信息'] },
];
