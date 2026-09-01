import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Eye, Columns2, Pencil } from 'lucide-react';
import { useAppDispatch } from '@/store/hooks';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { MermaidDiagram } from '@/components/chat/MermaidDiagram';
import { fileSystem } from '@/services/fileSystem';
import { markTabSaved, setTabContent } from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';
import { saveEditorFileWithConflictProtection } from '@/services/editorFileSave';

type MarkdownMode = 'preview' | 'source' | 'split';

interface MarkdownViewerProps {
  tabId: string;
  filePath: string;
  fileName: string;
  tabContent?: string;
  savedContent?: string;
  dirty: boolean;
}

export function MarkdownViewer({
  tabId,
  filePath,
  fileName,
  tabContent,
  savedContent,
  dirty,
}: MarkdownViewerProps) {
  const dispatch = useAppDispatch();
  const [content, setContent] = useState<string>('');
  const [mode, setMode] = useState<MarkdownMode>('preview');
  const [loading, setLoading] = useState(true);

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
      } catch {
        if (!cancelled) {
          const fallback = `# 无法加载文件\n\n文件路径: ${filePath}`;
          setContent(fallback);
          dispatch(setTabContent({ id: tabId, content: fallback, markSaved: true }));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch, filePath, tabContent, tabId]);

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
    return <div className="markdown-viewer-loading">📝 加载 Markdown 中...</div>;
  }

  return (
    <div className="markdown-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-filename">📝 {fileName}</span>
        {dirty && <span className="dirty-indicator" title="未保存">●</span>}
        <div className="viewer-mode-tabs" role="tablist" aria-label="Markdown 查看模式">
          <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')} title="预览">
            <Eye size={14} /> 预览
          </button>
          <button type="button" role="tab" aria-selected={mode === 'source'} className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')} title="源码">
            <Pencil size={14} /> 源码
          </button>
          <button type="button" role="tab" aria-selected={mode === 'split'} className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')} title="分屏">
            <Columns2 size={14} /> 分屏
          </button>
        </div>
      </div>

      {mode === 'preview' && <MarkdownPreview content={content} filePath={filePath} />}
      {mode === 'source' && (
        <CodeEditor
          filename={fileName}
          content={content}
          language="markdown"
          dirty={dirty}
          savedContent={savedContent}
          readOnly={false}
          onChange={handleChange}
          onSave={handleSave}
        />
      )}
      {mode === 'split' && (
        <div className="split-viewer">
          <div className="split-pane">
            <CodeEditor
              filename={fileName}
              content={content}
              language="markdown"
              dirty={dirty}
              savedContent={savedContent}
              readOnly={false}
              onChange={handleChange}
              onSave={handleSave}
            />
          </div>
          <div className="split-pane">
            <MarkdownPreview content={content} filePath={filePath} />
          </div>
        </div>
      )}
    </div>
  );
}

function MarkdownPreview({ content, filePath }: { content: string; filePath: string }) {
  // ★ #8：把 md 里 ![](路径) 的图片源解析为可显示 URL。
  //   - 网络/数据/已是协议的 url 原样透传；
  //   - 本地绝对路径 → fileSystem.getDisplayUrl（Electron 下转 synapse-file://，带白名单+防穿越）；
  //   - 相对路径 → 先拼到当前 md 文件所在目录，再走 getDisplayUrl。
  //   口径与 MessageBubble/HtmlViewer 一致，统一经 synapse-file:// 协议加载本地资源（防黑屏）。
  const resolveImgSrc = (src: string): string => {
    if (!src) return src;
    // 网络 / data / blob / 已是自定义协议：不动。
    if (/^(https?:|data:|blob:|synapse-file:)/i.test(src)) return src;
    // 去掉 file:// 前缀（少数 md 会写 file:///C:/...），剩下当作绝对路径处理。
    let p = src.replace(/^file:\/\//i, '');
    const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
    if (!isAbsolute) {
      // 相对路径：拼到当前 md 文件所在目录下。filePath 为绝对路径，取其目录段。
      const dir = filePath.replace(/[\\/][^\\/]*$/, '');
      p = `${dir}/${p}`;
    }
    return fileSystem.getDisplayUrl(p) || src;
  };

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          img({ src, alt, ...props }) {
            const resolved = typeof src === 'string' ? resolveImgSrc(src) : src;
            return <img src={resolved} alt={alt ?? ''} {...props} />;
          },
          // ★ #7：补 code 映射——```mermaid 代码块渲染成流程图（复用聊天侧 MermaidDiagram，样式在 components.css 全局）。
          //   MarkdownViewer 无流式概念，块永远闭合 → pending 恒 false；其余 code 走默认（react-markdown 自动 <pre> 包裹）。
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const lang = match?.[1];
            const childStr = String(children).replace(/\n$/, '');
            if (lang === 'mermaid') {
              return <MermaidDiagram code={childStr} pending={false} />;
            }
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
