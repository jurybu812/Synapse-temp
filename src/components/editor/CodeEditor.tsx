/**
 * CodeEditor Component
 * Lightweight code display with syntax highlighting (no Monaco dependency)
 * - 只读分支：react-syntax-highlighter（Prism，PrismAsyncLight 按需注册语言）语法高亮。
 * - 可编辑分支（★ FIX-3）：透明 textarea 叠在同样 Prism 高亮的 pre 层之上，二者像素级对齐 +
 *   滚动同步，做到「可编辑也带高亮」。保留 Ctrl+S / Tab / onChange / onSave 全部原有行为。
 *   高亮层与 textarea 共用同一 padding/font/line-height（见 .code-editor-edit-* CSS），
 *   确保 caret 与高亮字符不串位。无高亮语言（text）或超大文件降级为纯透明 textarea（无高亮层）。
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Copy, Check, Save } from 'lucide-react';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
// ★ 主题修复：深色用 vscDarkPlus（VS Code Dark+），浅色用 vs（VS Code Light）——
//   官方成对配色，浅底高对比且专业（绿注释/红字符串/蓝关键字），非简单反色。按当前主题切换。
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';

// ── M4-4-S1：按需注册 Prism 语言（避免全量 bundle）。
//   只注册 detectLanguage / mapToPrismLang 可能产出的语言；新增语言时在此处补 import + register。
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'; // html/xml
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';

SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('html', markup);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('c', c);

// 高亮性能护栏：超大文件高亮会阻塞主线程，降级为裸 pre。
const MAX_HIGHLIGHT_LINES = 2000;
const MAX_HIGHLIGHT_BYTES = 256 * 1024;

/**
 * detectLanguage 产出的 lang 串 → Prism 语言名归一。
 * 多数一致；差异项：c++→cpp、html→markup（已 alias 注册 'html'）、text→null（无高亮降级）。
 * 返回 null 表示「不高亮」，调用方走裸 pre。
 */
function mapToPrismLang(lang: string): string | null {
  const map: Record<string, string> = {
    'c++': 'cpp',
    text: '', // 纯文本无高亮
  };
  const mapped = lang in map ? map[lang] : lang;
  return mapped || null;
}

interface CodeEditorProps {
  filename: string;
  content: string;
  language?: string;
  readOnly?: boolean;
  dirty?: boolean;
  savedContent?: string;
  onChange?: (content: string) => void;
  onSave?: (content: string) => void | Promise<void>;
}

export function CodeEditor({ filename, content, language, readOnly = true, dirty = false, savedContent, onChange, onSave }: CodeEditorProps) {
  const [value, setValue] = useState(content);
  const [copied, setCopied] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const originalContent = savedContent ?? content;

  // ★ 主题修复：按当前主题选 Prism 配色——深色 vscDarkPlus / 浅色 vs（VS Code Light）。
  //   背景统一在 customStyle 里改 transparent（露出 .code-editor 的 --syn-bg-code），仅借用其 token 配色。
  const resolvedTheme = useResolvedTheme();
  const prismStyle = resolvedTheme === 'light' ? vs : vscDarkPlus;

  // ★ FIX-3：可编辑高亮——textarea 与高亮层滚动同步用的 ref。
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setValue(content);
    setIsDirty(dirty);
  }, [content, dirty]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  const handleSave = useCallback(async () => {
    try {
      await onSave?.(value);
      setIsDirty(false);
    } catch {
      setIsDirty(true);
    }
  }, [value, onSave]);

  // ★ FIX-3：textarea 滚动时把高亮层滚动到同一位置，保持字符对齐。
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const hl = highlightRef.current;
    if (!ta || !hl) return;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }, []);

  // Detect language from filename
  const lang = language || detectLanguage(filename);

  // ── M4-4-S1：高亮的 Prism 语言名 + 大文件降级判定（★ FIX-3 起只读/可编辑两分支共用）。
  //   useMemo 避免每次渲染重算大文件尺寸。逐键编辑会随 value 变化重算 tooLargeForHighlight。
  const prismLang = useMemo(() => mapToPrismLang(lang), [lang]);
  const tooLargeForHighlight = useMemo(() => {
    if (!value) return false;
    // 行数精确统计；字节阈值用字符数近似（>=256K 字符即降级，多字节文本更早降级，偏保守安全）。
    if (value.length >= MAX_HIGHLIGHT_BYTES) return true;
    let lines = 1;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) === 10) {
        lines++;
        if (lines > MAX_HIGHLIGHT_LINES) return true;
      }
    }
    return false;
  }, [value]);

  const useHighlight = prismLang !== null && !tooLargeForHighlight;

  return (
    <div className="code-editor">
      <div className="code-editor-toolbar">
        <span className="code-editor-filename">
          {filename}
          {isDirty && <span className="dirty-indicator" title="未保存"> ●</span>}
        </span>
        <span className="code-editor-lang">{lang}</span>
        <div className="code-editor-actions">
          <button className="code-editor-btn" onClick={handleCopy} title="复制">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {!readOnly && (
            <button className="code-editor-btn" onClick={handleSave} title="保存 (Ctrl+S)">
              <Save size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="code-editor-content">
        {readOnly ? (
          useHighlight ? (
            <SyntaxHighlighter
              language={prismLang as string}
              style={prismStyle}
              showLineNumbers={false}
              wrapLongLines={false}
              // 容器沿用 .code-editor-content 滚动；高亮组件自身背景透明，露出 .code-editor 的 --syn-bg-code（深 #0d1117 / 浅 #f6f8fa）。
              customStyle={{
                margin: 0,
                padding: 12,
                background: 'transparent',
                fontSize: 13,
                lineHeight: 1.5,
                fontFamily: 'var(--syn-font-mono)',
                tabSize: 2,
                minHeight: '100%',
                overflow: 'visible',
              }}
              codeTagProps={{
                style: { fontFamily: 'var(--syn-font-mono)', fontSize: 13 },
              }}
            >
              {value}
            </SyntaxHighlighter>
          ) : (
            // 无高亮语言（text）或超阈值大文件：降级裸 pre（保留现状外观）。
            <pre className="code-editor-pre">
              <code>{value}</code>
            </pre>
          )
        ) : (
          // ★ FIX-3：可编辑 + 高亮。透明 textarea 浮在高亮 pre 层上，二者同 padding/font/line-height
          //   像素对齐 + 滚动同步。无高亮语言（text）或超大文件时 useHighlight=false，高亮层不渲染，
          //   退化为纯 textarea（外观同改造前）。
          <div className="code-editor-edit-wrap">
            {useHighlight && (
              <div className="code-editor-edit-highlight" ref={highlightRef} aria-hidden="true">
                <SyntaxHighlighter
                  language={prismLang as string}
                  style={prismStyle}
                  showLineNumbers={false}
                  wrapLongLines={false}
                  customStyle={{
                    margin: 0,
                    padding: 12,
                    background: 'transparent',
                    fontSize: 13,
                    lineHeight: 1.5,
                    fontFamily: 'var(--syn-font-mono)',
                    tabSize: 2,
                    minHeight: '100%',
                    overflow: 'visible',
                    whiteSpace: 'pre',
                  }}
                  codeTagProps={{
                    style: { fontFamily: 'var(--syn-font-mono)', fontSize: 13, whiteSpace: 'pre' },
                  }}
                >
                  {/* 末尾换行兜底：textarea 末行为空行时高亮层需多一行高度，避免末行错位。 */}
                  {value.endsWith('\n') ? value + ' ' : value}
                </SyntaxHighlighter>
              </div>
            )}
            <textarea
              ref={textareaRef}
              className={`code-editor-textarea${useHighlight ? ' code-editor-textarea-overlay' : ''}`}
              value={value}
              onScroll={syncScroll}
              onChange={e => { const v = e.target.value; setValue(v); setIsDirty(v !== originalContent); onChange?.(v); }}
              onKeyDown={e => {
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleSave();
                }
                // Tab support
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const start = e.currentTarget.selectionStart;
                  const end = e.currentTarget.selectionEnd;
                  const newVal = value.substring(0, start) + '  ' + value.substring(end);
                  setValue(newVal);
                  setIsDirty(newVal !== originalContent);
                  onChange?.(newVal);
                  setTimeout(() => {
                    e.currentTarget.selectionStart = e.currentTarget.selectionEnd = start + 2;
                  });
                }
              }}
              spellCheck={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', css: 'css', html: 'html', json: 'json',
    md: 'markdown', txt: 'text', sh: 'bash', yml: 'yaml', yaml: 'yaml',
    rs: 'rust', go: 'go', java: 'java', cpp: 'c++', c: 'c', h: 'c',
  };
  return langMap[ext || ''] || 'text';
}
