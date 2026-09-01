import { useEffect, useState } from 'react';
import { AlertTriangle, Code2, Eye, Loader2, ShieldCheck } from 'lucide-react';
import { useAppDispatch } from '@/store/hooks';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { fileSystem } from '@/services/fileSystem';
import { markTabSaved, setTabContent } from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';
import { saveEditorFileWithConflictProtection } from '@/services/editorFileSave';

type HtmlMode = 'render' | 'source';
type HtmlPreviewState = 'loading' | 'ready' | 'timed-out';

const HTML_PREVIEW_TIMEOUT_MS = 5000;
const HTML_PREVIEW_SECURITY_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; media-src data: blob:; style-src \'unsafe-inline\'; font-src data:; connect-src \'none\'; frame-src \'none\'; child-src \'none\'; object-src \'none\'; form-action \'none\'; base-uri \'none\'">';

// ★ UI-9：给渲染 iframe 注入统一滚动条样式。iframe srcDoc 是独立文档（opaque origin），app 全局
//   ::-webkit-scrollbar 样式进不去，默认是浏览器原生粗白滚动条——与 app 风格不一致、突兀。
// ★ 回归真因（playwright 真机定位）：Electron 41 = Chromium 138，与开发机新版 Chromium 渲染不一致。
//   iframe【视口主滚动条】(html root) 用 ::-webkit-scrollbar 样式化跨版本不可靠；改用标准 scrollbar-width:thin
//   又会随 Chromium 版本漂移（某些版本渲染成偏粗 + 可见 track，正是这次回归看到的样子）。
//   根治 = 换滚动层：让 html 不滚、body 滚——body::-webkit-scrollbar 作用于【非 root 元素】，在所有 Chromium 版本
//   都稳定可控 → 细圆角中性灰条，深浅底都协调、跨版本一致。通用 ::-webkit 再统一内部 overflow 容器（代码块/表格）。
//   注：body{margin:0} 防 height:100% 下默认 margin 撑出被 html overflow:hidden 裁底；居中布局多用 container margin:auto，不受影响。
const HTML_SCROLLBAR_STYLE = '<style>'
  + 'html{overflow:hidden !important;height:100% !important;}'
  + 'body{height:100% !important;overflow:auto !important;margin:0 !important;box-sizing:border-box !important;}'
  + 'body::-webkit-scrollbar{width:10px !important;height:10px !important;}'
  + 'body::-webkit-scrollbar-track{background:transparent !important;}'
  + 'body::-webkit-scrollbar-thumb{background:rgba(140,140,160,0.45) !important;border-radius:6px !important;border:2px solid transparent !important;background-clip:padding-box !important;}'
  + 'body::-webkit-scrollbar-thumb:hover{background:rgba(140,140,160,0.7) !important;background-clip:padding-box !important;}'
  + 'body::-webkit-scrollbar-corner{background:transparent !important;}'
  + '::-webkit-scrollbar{width:10px !important;height:10px !important;}'
  + '::-webkit-scrollbar-track{background:transparent !important;}'
  + '::-webkit-scrollbar-thumb{background:rgba(140,140,160,0.45) !important;border-radius:6px !important;border:2px solid transparent !important;background-clip:padding-box !important;}'
  + '::-webkit-scrollbar-thumb:hover{background:rgba(140,140,160,0.7) !important;background-clip:padding-box !important;}'
  + '::-webkit-scrollbar-corner{background:transparent !important;}'
  + '</style>';

/**
 * 把滚动条样式注入 HTML——★ 必须注入 <head> 内，绝不前置到 <!DOCTYPE>/<html> 之前
 * （前置非空内容会触发 quirks mode、破坏用户 HTML 的渲染）。按 head→html→body→片段前置 兜底。
 */
function injectHtmlScrollbar(html: string): string {
  const neutralized = html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=)[^>]*>/gi, '')
    .replace(/<([a-z][\w:-]*)\b([^>]*)>/gi, (_full, tag: string, attributes: string) => {
      const safeAttributes = attributes.replace(/\s+(?:href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      return `<${tag}${safeAttributes}>`;
    });
  const headOpen = neutralized.match(/<head\b[^>]*>/i);
  const secured = headOpen?.index !== undefined
    ? neutralized.slice(0, headOpen.index + headOpen[0].length) + HTML_PREVIEW_SECURITY_META + neutralized.slice(headOpen.index + headOpen[0].length)
    : HTML_PREVIEW_SECURITY_META + neutralized;
  // ★ UI-9 修订（修「注入了但不生效」）：之前注入到 <head> 开头，排在用户自有 ::-webkit-scrollbar 样式【之前】，
  //   被 CSS「同特异性后定义赢」覆盖。改为注入到 </body> 前（文档最末，排在所有用户样式之后），fallback </head> 前 /
  //   片段追加末尾。配合样式 !important，确保覆盖精美 HTML 自带滚动条。注入末尾不影响 DOCTYPE/渲染模式。
  const bodyClose = secured.search(/<\/body>/i);
  if (bodyClose >= 0) return secured.slice(0, bodyClose) + HTML_SCROLLBAR_STYLE + secured.slice(bodyClose);
  const headClose = secured.search(/<\/head>/i);
  if (headClose >= 0) return secured.slice(0, headClose) + HTML_SCROLLBAR_STYLE + secured.slice(headClose);
  // 纯片段（无 body/head 闭合）→ 追加末尾（无 DOCTYPE，不影响渲染模式）。
  return secured + HTML_SCROLLBAR_STYLE;
}

interface HtmlViewerProps {
  tabId: string;
  filePath: string;
  fileName: string;
  tabContent?: string;
  savedContent?: string;
  dirty: boolean;
}

export function HtmlViewer({
  tabId,
  filePath,
  fileName,
  tabContent,
  savedContent,
  dirty,
}: HtmlViewerProps) {
  const dispatch = useAppDispatch();
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<HtmlMode>('source');
  const [loading, setLoading] = useState(true);
  const [previewState, setPreviewState] = useState<HtmlPreviewState>('loading');

  useEffect(() => {
    if (tabContent !== undefined) {
      setContent(tabContent);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const text = await fileSystem.readFile(filePath);
        if (!cancelled) {
          setContent(text);
          dispatch(setTabContent({ id: tabId, content: text, markSaved: true }));
        }
      } catch (err: any) {
        if (!cancelled) {
          const fallback = `<!-- 无法加载文件: ${filePath}\n${err?.message || ''} -->`;
          setContent(fallback);
          dispatch(setTabContent({ id: tabId, content: fallback, markSaved: true }));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch, filePath, tabContent, tabId]);

  useEffect(() => {
    if (mode !== 'render') return undefined;

    setPreviewState('loading');
    const timeoutId = window.setTimeout(() => {
      setPreviewState((current) => current === 'loading' ? 'timed-out' : current);
    }, HTML_PREVIEW_TIMEOUT_MS);

    return () => window.clearTimeout(timeoutId);
  }, [mode, content]);

  const handleChange = (nextContent: string) => {
    setContent(nextContent);
    dispatch(setTabContent({ id: tabId, content: nextContent }));
  };

  const handleSave = async (nextContent: string) => {
    const result = await saveEditorFileWithConflictProtection(filePath, fileName, nextContent, savedContent);
    setContent(result.content);
    dispatch(markTabSaved({ id: tabId, content: result.content }));
    dispatch(addNotification({
      type: 'success',
      title: result.merged ? '已合并并保存' : '已保存',
      message: fileName,
      duration: 2000,
    }));
  };

  if (loading) {
    return <div className="markdown-viewer-loading">🌐 加载 HTML 中...</div>;
  }

  return (
    <div className="html-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-filename">🌐 {fileName}</span>
        {dirty && <span className="dirty-indicator" title="未保存">●</span>}
        <div className="viewer-mode-tabs" role="tablist" aria-label="HTML 查看模式">
          <button type="button" role="tab" aria-selected={mode === 'render'} className={mode === 'render' ? 'active' : ''} onClick={() => setMode('render')} title="渲染">
            <Eye size={14} /> 渲染
          </button>
          <button type="button" role="tab" aria-selected={mode === 'source'} className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')} title="源码">
            <Code2 size={14} /> 源码
          </button>
        </div>
      </div>
      {mode === 'render' ? (
        <div className="html-preview-stage">
          <div className="html-preview-safety" role="status">
            <ShieldCheck size={14} aria-hidden="true" />
            <span>安全预览：脚本、表单、外部资源与链接跳转已禁用</span>
          </div>
          <iframe
            className="html-preview-frame"
            srcDoc={injectHtmlScrollbar(content)}
            sandbox=""
            referrerPolicy="no-referrer"
            title={`HTML 预览: ${fileName}`}
            onLoad={() => setPreviewState('ready')}
          />
          <div
            className={`html-preview-loading${previewState === 'ready' ? ' is-hidden' : ''}`}
            aria-hidden={previewState === 'ready'}
          >
            {previewState === 'timed-out' ? (
              <>
                <AlertTriangle size={28} aria-hidden="true" />
                <p>HTML 预览加载超时</p>
                <small>已停止等待，源码仍可安全查看</small>
                <button type="button" onClick={() => setMode('source')}>返回源码</button>
              </>
            ) : (
              <>
                <Loader2 className="html-preview-spinner" size={28} />
                <p>正在安全渲染 HTML...</p>
                <small>{fileName}</small>
              </>
            )}
          </div>
        </div>
      ) : (
        <CodeEditor
          filename={fileName}
          content={content}
          language="html"
          dirty={dirty}
          savedContent={savedContent}
          readOnly={false}
          onChange={handleChange}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
