/**
 * SearchPanel —— ★ FIX-4：左侧栏「搜索」面板实装（替代旧静态占位）。
 *
 * - 受控 input + 防抖（300ms）触发搜索；
 * - 调 fileSystem.searchInWorkspace（文件名 + 内容；Electron 走主进程 fs grep，Web 降级仅内存文件）；
 * - 结果分「文件名匹配 / 内容匹配」两组列出；
 * - 点结果 → openTab（用 resolveEditorType 判类型）在中间编辑器打开。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, FileText, X } from 'lucide-react';
import { useAppDispatch } from '@/store/hooks';
import { openTab } from '@/store/slices/editorTabs';
import { fileSystem } from '@/services/fileSystem';
import { resolveEditorType } from '@/services/editorFileTypes';

type SearchHit = {
  path: string;
  name: string;
  kind: 'file' | 'content';
  line?: number;
  content?: string;
};

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export function SearchPanel() {
  const dispatch = useAppDispatch();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 竞态守卫：只采纳最后一次发起的搜索结果。
  const seqRef = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([]);
      setSearched(false);
      setSearching(false);
      return;
    }
    const seq = ++seqRef.current;
    setSearching(true);
    try {
      const hits = await fileSystem.searchInWorkspace(trimmed);
      if (seq !== seqRef.current) return; // 已被更新的搜索取代。
      setResults(hits);
      setSearched(true);
    } catch {
      if (seq === seqRef.current) {
        setResults([]);
        setSearched(true);
      }
    } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  }, []);

  // 防抖触发。
  useEffect(() => {
    const t = setTimeout(() => { void runSearch(query); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const openHit = useCallback((hit: SearchHit) => {
    const ext = (hit.name.split('.').pop() || '').toLowerCase();
    dispatch(openTab({
      id: `tab-${Date.now()}`,
      filePath: hit.path,
      fileName: hit.name,
      isDirty: false,
      isPreview: true,
      type: resolveEditorType(ext),
    }));
  }, [dispatch]);

  const fileHits = results.filter(r => r.kind === 'file');
  const contentHits = results.filter(r => r.kind === 'content');

  return (
    <div className="search-panel">
      <div className="search-input-row">
        <Search size={14} className="search-input-icon" />
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          value={query}
          placeholder="搜索文件名或内容…"
          onChange={e => setQuery(e.target.value)}
          spellCheck={false}
          autoFocus
        />
        {query && (
          <button className="search-clear-btn" title="清空" onClick={() => { setQuery(''); inputRef.current?.focus(); }}>
            <X size={13} />
          </button>
        )}
      </div>

      {searching && <div className="search-status">搜索中…</div>}

      {!searching && query.trim().length >= MIN_QUERY_LEN && searched && results.length === 0 && (
        <div className="search-status">无匹配结果</div>
      )}

      {!searching && query.trim().length > 0 && query.trim().length < MIN_QUERY_LEN && (
        <div className="search-status">至少输入 {MIN_QUERY_LEN} 个字符</div>
      )}

      {!searching && results.length > 0 && (
        <div className="search-results">
          {fileHits.length > 0 && (
            <div className="search-group">
              <div className="search-group-title">文件名（{fileHits.length}）</div>
              {fileHits.map(hit => (
                <button
                  key={`f-${hit.path}`}
                  className="search-result-item"
                  onClick={() => openHit(hit)}
                  title={hit.path}
                >
                  <FileText size={13} className="search-result-icon" />
                  <span className="search-result-name">{hit.name}</span>
                  <span className="search-result-path">{hit.path}</span>
                </button>
              ))}
            </div>
          )}

          {contentHits.length > 0 && (
            <div className="search-group">
              <div className="search-group-title">内容（{contentHits.length}）</div>
              {contentHits.map((hit, i) => (
                <button
                  key={`c-${hit.path}-${hit.line}-${i}`}
                  className="search-result-item search-result-content"
                  onClick={() => openHit(hit)}
                  title={hit.path}
                >
                  <span className="search-result-name">
                    {hit.name}{hit.line ? <span className="search-result-line">:{hit.line}</span> : null}
                  </span>
                  {hit.content && <span className="search-result-snippet">{hit.content}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
