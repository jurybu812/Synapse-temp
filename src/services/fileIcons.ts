/**
 * ★ M4-3-S6：FileTree 彩色图标主题（内置 material-icon-theme 风格 SVG 子集）。
 *
 * 设计依据：Plan_5_M4-3 ④E / ⑦决议3——主人决策「内置 material-icon-theme 风格 SVG 子集，
 *   不引 npm 包，只动 FileTree」。material-icon-theme npm 包是 VS Code 扩展形态、整包大、
 *   无现成 React/ext→icon API，集成成本高；故这里内置一个精选 SVG 子集（首批 ~40 常见扩展
 *   + 默认 file + 文件夹 open/closed），彩色由 SVG 自带 fill 区分。
 *
 * 用法：
 *   getFileIcon(ext)  → 返回该扩展对应彩色 SVG 字符串（未命中回退默认 file 图标）。
 *   getFolderIcon(open) → 返回文件夹开/合两态 SVG 字符串。
 *
 * SVG 风格：material-icon-theme 取色，统一 16x16 viewBox，单色块为主（轻量、tree-shaking 友好）。
 *   只动 FileTree（主人决策），TabBar 的 lucide + tab-icon-* 体系本里程碑不动。
 *
 * 许可：material-icon-theme 为 MIT，此处为风格化重绘的精简子集，非原始资产拷贝。
 */

// 统一外框 helper：所有图标 16x16，currentColor 不参与（彩色靠各自 fill）。
const wrap = (inner: string): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;

// 通用「文档底板」：一个带折角的纸张，传入主色 + 角标文字色，复用给大多数扩展。
const docBase = (bodyColor: string): string =>
  `<path d="M3 1.5h6.5L13 5v9.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z" fill="${bodyColor}"/>` +
  `<path d="M9.5 1.5 13 5H10.3a.8.8 0 0 1-.8-.8V1.5z" fill="#ffffff" fill-opacity="0.35"/>`;

// 带角标字母的文档图标（如 TS / JS / PY 等），letter 为白色叠字。
const docWithLetter = (bodyColor: string, letter: string, letterColor = '#ffffff'): string =>
  wrap(
    docBase(bodyColor) +
    `<text x="7.5" y="12" font-family="Segoe UI, Arial, sans-serif" font-size="5.5" font-weight="700" text-anchor="middle" fill="${letterColor}">${letter}</text>`
  );

// ---- 默认文件 / 文件夹 ----
const DEFAULT_FILE = wrap(docBase('#90a4ae'));

const FOLDER_CLOSED = wrap(
  `<path d="M1.5 3.5a1 1 0 0 1 1-1h3.3l1.2 1.4H13.5a1 1 0 0 1 1 1v8.1a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5z" fill="#90a4ae"/>`
);
const FOLDER_OPEN = wrap(
  `<path d="M1.5 3.5a1 1 0 0 1 1-1h3.3l1.2 1.4H13.5a1 1 0 0 1 1 1v1.1H1.5V3.5z" fill="#78909c"/>` +
  `<path d="M2.4 6h12.1l-1.6 6.4a1 1 0 0 1-1 .76H2.1a.6.6 0 0 1-.58-.74L2.4 6z" fill="#b0bec5"/>`
);

// ---- 扩展 → SVG 映射（首批 ~40 常见扩展，material-icon-theme 取色）----
const ICONS: Record<string, string> = {
  // —— Web / JS 生态 ——
  ts: docWithLetter('#0288d1', 'TS'),
  tsx: docWithLetter('#0288d1', 'TS'),
  js: docWithLetter('#fbc02d', 'JS', '#3e2723'),
  jsx: docWithLetter('#fbc02d', 'JS', '#3e2723'),
  mjs: docWithLetter('#fbc02d', 'JS', '#3e2723'),
  cjs: docWithLetter('#fbc02d', 'JS', '#3e2723'),
  json: docWithLetter('#fbc02d', '{}', '#3e2723'),
  html: docWithLetter('#e44d26', '<>'),
  htm: docWithLetter('#e44d26', '<>'),
  css: docWithLetter('#42a5f5', '#'),
  scss: docWithLetter('#c2185b', 'S'),
  less: docWithLetter('#1565c0', 'L'),
  vue: docWithLetter('#41b883', 'V'),
  svelte: docWithLetter('#ff3e00', 'S'),

  // —— 标记 / 文档 ——
  md: docWithLetter('#42a5f5', 'M'),
  markdown: docWithLetter('#42a5f5', 'M'),
  txt: docWithLetter('#90a4ae', 'T'),
  pdf: docWithLetter('#e53935', 'PDF'),
  doc: docWithLetter('#1565c0', 'W'),
  docx: docWithLetter('#1565c0', 'W'),
  ppt: docWithLetter('#e64a19', 'P'),
  pptx: docWithLetter('#e64a19', 'P'),
  xls: docWithLetter('#2e7d32', 'X'),
  xlsx: docWithLetter('#2e7d32', 'X'),
  csv: docWithLetter('#2e7d32', 'C'),

  // —— 后端 / 系统语言 ——
  py: docWithLetter('#3572a5', 'PY'),
  java: docWithLetter('#e76f00', 'J'),
  kt: docWithLetter('#7f52ff', 'K'),
  rs: docWithLetter('#dea584', 'RS', '#3e2723'),
  go: docWithLetter('#00add8', 'GO'),
  c: docWithLetter('#5c6bc0', 'C'),
  h: docWithLetter('#7986cb', 'H'),
  cpp: docWithLetter('#5c6bc0', '++'),
  cc: docWithLetter('#5c6bc0', '++'),
  cs: docWithLetter('#388e3c', 'C#'),
  rb: docWithLetter('#cc342d', 'RB'),
  php: docWithLetter('#7377ad', 'PHP'),
  swift: docWithLetter('#f05138', 'SW'),
  sh: docWithLetter('#43a047', '$'),
  bash: docWithLetter('#43a047', '$'),

  // —— 配置 ——
  yml: docWithLetter('#cb171e', 'Y'),
  yaml: docWithLetter('#cb171e', 'Y'),
  toml: docWithLetter('#9c4221', 'T'),
  ini: docWithLetter('#90a4ae', 'I'),
  env: docWithLetter('#ffca28', 'E', '#3e2723'),
  xml: docWithLetter('#ff7043', 'X'),

  // —— 图片（统一图片图标）——
  png: wrap(docBase('#26a69a') + '<circle cx="6" cy="8.5" r="1.3" fill="#fff"/><path d="M3 13l2.4-3 1.6 1.9L9 9l3 4H3z" fill="#fff" fill-opacity="0.85"/>'),
  jpg: wrap(docBase('#26a69a') + '<circle cx="6" cy="8.5" r="1.3" fill="#fff"/><path d="M3 13l2.4-3 1.6 1.9L9 9l3 4H3z" fill="#fff" fill-opacity="0.85"/>'),
  jpeg: wrap(docBase('#26a69a') + '<circle cx="6" cy="8.5" r="1.3" fill="#fff"/><path d="M3 13l2.4-3 1.6 1.9L9 9l3 4H3z" fill="#fff" fill-opacity="0.85"/>'),
  gif: wrap(docBase('#8e24aa') + '<circle cx="6" cy="8.5" r="1.3" fill="#fff"/><path d="M3 13l2.4-3 1.6 1.9L9 9l3 4H3z" fill="#fff" fill-opacity="0.85"/>'),
  webp: wrap(docBase('#26a69a') + '<circle cx="6" cy="8.5" r="1.3" fill="#fff"/><path d="M3 13l2.4-3 1.6 1.9L9 9l3 4H3z" fill="#fff" fill-opacity="0.85"/>'),
  bmp: wrap(docBase('#26a69a') + '<circle cx="6" cy="8.5" r="1.3" fill="#fff"/><path d="M3 13l2.4-3 1.6 1.9L9 9l3 4H3z" fill="#fff" fill-opacity="0.85"/>'),
  ico: wrap(docBase('#26a69a') + '<circle cx="6" cy="8.5" r="1.3" fill="#fff"/><path d="M3 13l2.4-3 1.6 1.9L9 9l3 4H3z" fill="#fff" fill-opacity="0.85"/>'),
  svg: docWithLetter('#ffb300', 'SVG', '#3e2723'),

  // —— 媒体 ——
  mp4: docWithLetter('#ab47bc', '▶'),
  mov: docWithLetter('#ab47bc', '▶'),
  webm: docWithLetter('#ab47bc', '▶'),
  mp3: docWithLetter('#ec407a', '♪'),
  wav: docWithLetter('#ec407a', '♪'),

  // —— 归档 ——
  zip: docWithLetter('#fbc02d', 'ZIP', '#3e2723'),
  rar: docWithLetter('#fbc02d', 'RAR', '#3e2723'),
  '7z': docWithLetter('#fbc02d', '7Z', '#3e2723'),
  tar: docWithLetter('#a1887f', 'TAR'),
  gz: docWithLetter('#a1887f', 'GZ'),

  // —— 其它常见 ——
  sql: docWithLetter('#0277bd', 'SQL'),
  lock: docWithLetter('#90a4ae', '🔒'),
  log: docWithLetter('#90a4ae', 'LOG'),
};

/** 按扩展名取彩色文件图标 SVG 字符串；未命中回退默认 file 图标。 */
export function getFileIcon(extension?: string): string {
  const ext = (extension ?? '').toLowerCase().replace(/^\./, '');
  return ICONS[ext] ?? DEFAULT_FILE;
}

/** 取文件夹图标 SVG 字符串（open=true 渲染展开态）。 */
export function getFolderIcon(open: boolean): string {
  return open ? FOLDER_OPEN : FOLDER_CLOSED;
}
