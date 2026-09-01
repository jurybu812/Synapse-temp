import { useAppSelector } from '@/store/hooks';
import { useAppDispatch } from '@/store/hooks';
import type { RootState } from '@/store';
import { TabBar } from '@/components/editor/TabBar';
import { WelcomePage } from '@/components/editor/WelcomePage';
import { ImageViewer } from '@/components/editor/ImageViewer';
import { MarkdownViewer } from '@/components/editor/MarkdownViewer';
import { HtmlViewer } from '@/components/editor/HtmlViewer';
import { MediaPlayer } from '@/components/editor/MediaPlayer';
import { ShowcaseFrame } from '@/components/editor/ShowcaseFrame';
import { PdfViewer } from '@/components/editor/PdfViewer';
import { DocxViewer } from '@/components/editor/DocxViewer';
import { PptxViewer } from '@/components/editor/PptxViewer';
import { OfficeViewer } from '@/components/editor/OfficeViewer';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { ReviewChangesView } from '@/components/editor/ReviewChangesView';
import { SingleDiffView } from '@/components/editor/SingleDiffView';
import { WorkflowView } from '@/components/editor/WorkflowView';
import { fileSystem } from '@/services/fileSystem';
import { applyBlockReview, applyDiffGroupReview, applyDiffReview, applyHunkReview, type ReviewApplyResult } from '@/services/fileRollback';
import { groupFileDiffs, normalizeDiffPath, reviewPathKeys } from '@/services/diffReviewGrouping';
import { closeTab, markTabSaved, reconcileTabFile, setTabContent, closeAllTabs, closeSavedTabs, type EditorTab } from '@/store/slices/editorTabs';
import { hasPendingReviewParts } from '@/services/diffReviewCore';
import { setDiffReviewError, updateDiffBlockStatus, updateDiffStatus, updateHunkStatus, type FileDiffSummary } from '@/store/slices/conversation';
import { addNotification } from '@/store/slices/notifications';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';
import { saveEditorFileWithConflictProtection } from '@/services/editorFileSave';
import { useEffect, useRef, useState } from 'react';

export function EditorArea() {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const activeTabId = useAppSelector((s: RootState) => s.editorTabs.activeTabId);
  const groupLocked = useAppSelector((s: RootState) => s.editorTabs.groupLocked);
  const conversation = useAppSelector((s: RootState) => s.conversation);
  const activeTab = tabs.find((t: { id: string }) => t.id === activeTabId);

  // ★ M4-3-S8：EditorArea 自管 Ctrl+K 和弦快捷键（主人决议）。
  //   Ctrl+K W = Close All；Ctrl+K U = Close Saved。仅在编辑器区域内聚焦时生效，
  //   按下 Ctrl+K 后进入「等待第二键」状态（chord），1.2s 内未补键则超时取消。
  //   用 ref 持最新 tabs/groupLocked，避免 effect 因依赖频繁重挂、且回调读到陈旧值。
  const editorRef = useRef<HTMLDivElement>(null);
  const chordPendingRef = useRef(false);
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabsRef = useRef(tabs);
  const lockedRef = useRef(groupLocked);
  tabsRef.current = tabs;
  lockedRef.current = groupLocked;

  const closeAllWithConfirm = async () => {
    if (lockedRef.current) {
      dispatch(addNotification({ type: 'info', title: '编辑器组已锁定', message: '请先解锁分组再关闭全部标签' }));
      return;
    }
    const dirtyTabs = tabsRef.current.filter(t => t.isDirty);
    if (dirtyTabs.length > 0) {
      const ok = await resolveUnsavedTabs(dirtyTabs, '关闭全部标签');
      if (!ok) return;
      dirtyTabs.forEach(t => dispatch(markTabSaved({ id: t.id, content: t.content })));
    }
    dispatch(closeAllTabs());
  };

  const closeSavedWithConfirm = () => {
    if (lockedRef.current) {
      dispatch(addNotification({ type: 'info', title: '编辑器组已锁定', message: '请先解锁分组再关闭已保存标签' }));
      return;
    }
    dispatch(closeSavedTabs());
  };

  useEffect(() => {
    const clearChord = () => {
      chordPendingRef.current = false;
      if (chordTimerRef.current) {
        clearTimeout(chordTimerRef.current);
        chordTimerRef.current = null;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // 仅当焦点落在编辑器区内才接管，避免与输入框 / 全局快捷键冲突。
      const root = editorRef.current;
      const target = e.target as Node | null;
      if (!root || !target || !root.contains(target)) {
        if (chordPendingRef.current) clearChord();
        return;
      }

      if (chordPendingRef.current) {
        // 已进入和弦——等待第二键。
        const key = e.key.toLowerCase();
        if (key === 'w') {
          e.preventDefault();
          clearChord();
          void closeAllWithConfirm();
          return;
        }
        if (key === 'u') {
          e.preventDefault();
          clearChord();
          closeSavedWithConfirm();
          return;
        }
        // 其它键 → 取消和弦（不吞）。
        clearChord();
        return;
      }

      // 起始键 Ctrl+K（mac 兼容 metaKey）。
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        chordPendingRef.current = true;
        chordTimerRef.current = setTimeout(clearChord, 1200);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearChord();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reviewConversationId = conversation.id || undefined;

  const editorFor = async (diff: FileDiffSummary): Promise<EditorTab | undefined> => {
    const pathKeys = await reviewPathKeys(diff.path, diff.contextId, reviewConversationId);
    return tabs.find(tab => tab.filePath && tab.content !== undefined && pathKeys.has(normalizeDiffPath(tab.filePath)));
  };

  const editorStateFor = (tab: EditorTab | undefined) => tab ? {
    content: tab.content ?? '',
    savedContent: tab.savedContent ?? '',
  } : undefined;

  const reconcileEditor = (tab: EditorTab | undefined, result: ReviewApplyResult) => {
    if (!tab) return;
    if (result.removeEditor) {
      dispatch(closeTab(tab.id));
      return;
    }
    if (result.editorContent === undefined || result.editorSavedContent === undefined) return;
    dispatch(reconcileTabFile({ id: tab.id, content: result.editorContent, savedContent: result.editorSavedContent }));
  };

  const ensureSingleActiveBatch = (diff: FileDiffSummary) => {
    const group = groupFileDiffs(conversation.pendingDiffs, conversation.fileSnapshots)
      .find(entry => entry.activeDiffs.some(active => active.id === diff.id));
    if (group && group.activeDiffs.length > 1) {
      throw new Error(`该文件还有 ${group.activeDiffs.length} 批待审改动，请先按文件结算最终状态: ${diff.path}`);
    }
  };

  const reviewFile = async (diff: FileDiffSummary, status: 'accepted' | 'rejected') => {
    try {
      const snapshot = diff.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
      const tab = await editorFor(diff);
      const result = await applyDiffReview(diff, snapshot, status, editorStateFor(tab));
      reconcileEditor(tab, result);
      dispatch(updateDiffStatus({ diffId: diff.id, status, conversationId: reviewConversationId }));
      return result;
    } catch (error: any) {
      dispatch(setDiffReviewError({ diffId: diff.id, error: error?.message || diff.path, conversationId: reviewConversationId }));
      throw error;
    }
  };

  const reviewGroup = async (diffs: FileDiffSummary[], status: 'accepted' | 'rejected') => {
    if (diffs.length === 0) return;
    const latest = diffs[diffs.length - 1];
    try {
      const tab = await editorFor(latest);
      const result = await applyDiffGroupReview(diffs, conversation.fileSnapshots, status, editorStateFor(tab));
      reconcileEditor(tab, result);
      for (const diff of diffs) {
        dispatch(updateDiffStatus({ diffId: diff.id, status, conversationId: reviewConversationId }));
      }
      return result;
    } catch (error: any) {
      dispatch(setDiffReviewError({ diffId: latest.id, error: error?.message || latest.path, conversationId: reviewConversationId }));
      throw error;
    }
  };

  const reviewHunk = async (diff: FileDiffSummary, hunkId: string, status: 'accepted' | 'rejected') => {
    try {
      ensureSingleActiveBatch(diff);
      const snapshot = diff.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
      const tab = await editorFor(diff);
      const result = await applyHunkReview(diff, snapshot, hunkId, status, editorStateFor(tab));
      reconcileEditor(tab, result);
      dispatch(updateHunkStatus({ diffId: diff.id, hunkId, status, conversationId: reviewConversationId }));
      return result;
    } catch (error: any) {
      dispatch(setDiffReviewError({ diffId: diff.id, error: error?.message || diff.path, conversationId: reviewConversationId }));
      throw error;
    }
  };

  const reviewBlock = async (diff: FileDiffSummary, hunkId: string, blockId: string, status: 'accepted' | 'rejected') => {
    try {
      ensureSingleActiveBatch(diff);
      const snapshot = diff.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
      const tab = await editorFor(diff);
      const result = await applyBlockReview(diff, snapshot, hunkId, blockId, status, editorStateFor(tab));
      reconcileEditor(tab, result);
      dispatch(updateDiffBlockStatus({ diffId: diff.id, hunkId, blockId, status, conversationId: reviewConversationId }));
      return result;
    } catch (error: any) {
      dispatch(setDiffReviewError({ diffId: diff.id, error: error?.message || diff.path, conversationId: reviewConversationId }));
      throw error;
    }
  };

  const renderContent = () => {
    if (!activeTab || activeTab.type === 'welcome') {
      return <WelcomePage />;
    }

    switch (activeTab.type) {
      case 'pdf':
        return (
          <PdfFileViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      case 'markdown':
        return (
          <MarkdownViewer
            tabId={activeTab.id}
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
            tabContent={activeTab.content}
            savedContent={activeTab.savedContent}
            dirty={activeTab.isDirty}
          />
        );

      case 'html':
        return (
          <HtmlViewer
            tabId={activeTab.id}
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
            tabContent={activeTab.content}
            savedContent={activeTab.savedContent}
            dirty={activeTab.isDirty}
          />
        );

      // ★ M4-4-S2：docx 现归 'office' 路径（OfficeViewer → LibreOffice → PDF 真版式）。
      //   本分支保留作显式 openTab({type:'docx'}) 的兼容兜底（死分支，正常入口不再命中）。
      //   DocxViewer 组件不删——synopsisEngine/SynopsisPanel 的「知识概要」体系仍引用 docx 概念。
      case 'docx':
        return (
          <DocxViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      // ★ M4-4-S3：图片用 getDisplayUrl（Electron→synapse-file:// 协议 / Web→object url），
      //   去掉裸路径 fallback（裸 C:\... 在 Electron http/file 源下必然黑屏）。
      case 'image':
        return (
          <ImageViewer
            src={fileSystem.getDisplayUrl(activeTab.filePath)}
            fileName={activeTab.fileName}
          />
        );

      // ★ M4-4-S3：视频同步切到 getDisplayUrl，消除与图片同源的 Electron 黑屏隐患。
      case 'video':
        return (
          <MediaPlayer
            src={fileSystem.getDisplayUrl(activeTab.filePath)}
            fileName={activeTab.fileName}
            type="video"
          />
        );

      case 'showcase':
        return (
          <ShowcaseFrame
            url={activeTab.filePath}
            title={activeTab.fileName}
          />
        );

      case 'code':
        return (
          <CodeFileViewer
            tabId={activeTab.id}
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
            tabContent={activeTab.content}
            savedContent={activeTab.savedContent}
            dirty={activeTab.isDirty}
            dispatch={dispatch}
          />
        );

      case 'review':
        return (
          <ReviewChangesView
            diffs={conversation.pendingDiffs}
            snapshots={conversation.fileSnapshots}
            onAccept={async (diffId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              if (!diff) return;
              try {
                await reviewFile(diff, 'accepted');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '接受失败', message: err?.message || diff.path }));
              }
            }}
            onReject={async (diffId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              if (!diff) return;
              try {
                await reviewFile(diff, 'rejected');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '回退失败', message: err?.message || diff.path }));
              }
            }}
            onAcceptGroup={async (diffs) => {
              try {
                await reviewGroup(diffs, 'accepted');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '接受失败', message: err?.message || diffs.at(-1)?.path }));
              }
            }}
            onRejectGroup={async (diffs) => {
              try {
                await reviewGroup(diffs, 'rejected');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '回退失败', message: err?.message || diffs.at(-1)?.path }));
              }
            }}
            onAcceptHunk={async (diffId, hunkId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              if (!diff) return;
              try {
                await reviewHunk(diff, hunkId, 'accepted');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '局部接受失败', message: err?.message || diff.path }));
              }
            }}
            onRejectHunk={async (diffId, hunkId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              if (!diff) return;
              try {
                await reviewHunk(diff, hunkId, 'rejected');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '局部回退失败', message: err?.message || diff.path }));
              }
            }}
            onAcceptBlock={async (diffId, hunkId, blockId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              if (!diff) return;
              try {
                await reviewBlock(diff, hunkId, blockId, 'accepted');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: 'inline 接受失败', message: err?.message || diff.path }));
              }
            }}
            onRejectBlock={async (diffId, hunkId, blockId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              if (!diff) return;
              try {
                await reviewBlock(diff, hunkId, blockId, 'rejected');
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: 'inline 回退失败', message: err?.message || diff.path }));
              }
            }}
          />
        );

      // ★ 反馈#2：单文件行内红绿 diff 视图（点 review 框/消息 diff chip 里某个未处理文件打开）。
      //   按 diffId 从 pendingDiffs 定位该文件的 diff：仍未处理（pending/mixed）→ 渲染 SingleDiffView
      //   显示行内红绿改动 + 文件/块/段级 accept/reject（复用 review tab 同一套 applyDiffReview 链路）；
      //   已全部处理（accepted/rejected/已不存在）→ 自动降级回普通文件查看器，显示文件最终内容。
      case 'diffview': {
        const diff = activeTab.diffId
          ? conversation.pendingDiffs.find(item => item.id === activeTab.diffId)
          : conversation.pendingDiffs.find(item => item.path === activeTab.filePath);
        const stillPending = diff && hasPendingReviewParts(diff);
        if (diff && stillPending) {
          const snapshot = diff.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
          const diffGroup = groupFileDiffs(conversation.pendingDiffs, conversation.fileSnapshots)
            .find(group => group.activeDiffs.some(active => active.id === diff.id));
          return (
            <SingleDiffView
              diff={diff}
              snapshot={snapshot}
              partialReviewBlocked={Boolean(diffGroup && diffGroup.activeDiffs.length > 1)}
              onAccept={async (diffId) => {
                const d = conversation.pendingDiffs.find(item => item.id === diffId);
                if (!d) return;
                try {
                  await reviewFile(d, 'accepted');
                } catch (err: any) {
                  dispatch(addNotification({ type: 'error', title: '接受失败', message: err?.message || d.path }));
                }
              }}
              onReject={async (diffId) => {
                const d = conversation.pendingDiffs.find(item => item.id === diffId);
                if (!d) return;
                try {
                  await reviewFile(d, 'rejected');
                } catch (err: any) {
                  dispatch(addNotification({ type: 'error', title: '回退失败', message: err?.message || d.path }));
                }
              }}
              onAcceptHunk={async (diffId, hunkId) => {
                const d = conversation.pendingDiffs.find(item => item.id === diffId);
                if (!d) return;
                try {
                  await reviewHunk(d, hunkId, 'accepted');
                } catch (err: any) {
                  dispatch(addNotification({ type: 'error', title: '局部接受失败', message: err?.message || d.path }));
                }
              }}
              onRejectHunk={async (diffId, hunkId) => {
                const d = conversation.pendingDiffs.find(item => item.id === diffId);
                if (!d) return;
                try {
                  await reviewHunk(d, hunkId, 'rejected');
                } catch (err: any) {
                  dispatch(addNotification({ type: 'error', title: '局部回退失败', message: err?.message || d.path }));
                }
              }}
              onAcceptBlock={async (diffId, hunkId, blockId) => {
                const d = conversation.pendingDiffs.find(item => item.id === diffId);
                if (!d) return;
                try {
                  await reviewBlock(d, hunkId, blockId, 'accepted');
                } catch (err: any) {
                  dispatch(addNotification({ type: 'error', title: 'inline 接受失败', message: err?.message || d.path }));
                }
              }}
              onRejectBlock={async (diffId, hunkId, blockId) => {
                const d = conversation.pendingDiffs.find(item => item.id === diffId);
                if (!d) return;
                try {
                  await reviewBlock(d, hunkId, blockId, 'rejected');
                } catch (err: any) {
                  dispatch(addNotification({ type: 'error', title: 'inline 回退失败', message: err?.message || d.path }));
                }
              }}
            />
          );
        }
        // diff 记录已彻底消失（如对话被清空）→ filePath 是 diff:// 虚拟路径，无真实文件可读，给占位提示。
        if (!diff) {
          return (
            <div className="editor-placeholder">
              <div className="placeholder-content">
                <span style={{ fontSize: 32, opacity: 0.3 }}>✓</span>
                <p>{activeTab.fileName}</p>
                <p className="placeholder-hint">该改动的审查记录已不存在（可能对话已切换或清空）。</p>
              </div>
            </div>
          );
        }
        // 已无未处理 diff（已 accept/reject）→ 用真实路径显示文件最终内容。
        return (
          <CodeFileViewer
            tabId={activeTab.id}
            filePath={diff.path}
            fileName={activeTab.fileName}
            tabContent={activeTab.content}
            savedContent={activeTab.savedContent}
            dirty={activeTab.isDirty}
            dispatch={dispatch}
          />
        );
      }

      // ★ M3-3b：子代理中间视图（点击对话流 WorkflowCard 打开的 tab）。
      case 'workflow':
        return activeTab.workflowRunId
          ? <WorkflowView runId={activeTab.workflowRunId} />
          : (
            <div className="editor-placeholder">
              <div className="placeholder-content">
                <span style={{ fontSize: 32, opacity: 0.3 }}>🧩</span>
                <p>缺少工作流运行实例</p>
              </div>
            </div>
          );

      // ★ M4-4-S2：pptx 现归 'office' 路径（OfficeViewer → LibreOffice → PDF 真版式）。
      //   本分支保留作显式 openTab({type:'pptx'}) 的兼容兜底（死分支，正常入口不再命中）。
      //   PptxViewer 组件不删——synopsisEngine/SynopsisPanel 的「知识概要」体系仍引用 pptx 概念。
      case 'pptx':
        return (
          <PptxViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      case 'office':
        return (
          <OfficeViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      // ★ M4-3-S3：已发消息附件（非图片）专用 viewer——filePath 已是 objectUrl（AgentPanel 解析），
      //   按 mimeType 选渲染方式，不复用现有 fileSystem viewer（它们依赖工作区路径，吃不下 objectUrl）。
      case 'attachment':
        return (
          <AttachmentTabViewer
            objectUrl={activeTab.filePath}
            fileName={activeTab.fileName}
            mimeType={activeTab.mimeType}
          />
        );

      case 'unsupported':
        return (
          <UnsupportedViewer
            fileName={activeTab.fileName}
            filePath={activeTab.filePath}
          />
        );

      default:
        return (
          <div className="editor-placeholder">
            <div className="placeholder-content">
              <span style={{ fontSize: 32, opacity: 0.3 }}>📄</span>
              <p>{activeTab.fileName}</p>
              <p className="placeholder-hint">{activeTab.type} 类型查看器开发中</p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="editor-area glass-panel" ref={editorRef} tabIndex={-1}>
      <TabBar />
      <div className="editor-content">
        {renderContent()}
      </div>
    </div>
  );
}

function PdfFileViewer({ filePath, fileName }: { filePath: string; fileName: string }) {
  const [data, setData] = useState<ArrayBuffer | string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError('');
        // ★ M4-4-S3：Web 上传走 object url；其余（含 Electron 本地 PDF）统一读二进制喂 pdf.js。
        //   PDF 现状本就走 readBinary→ArrayBuffer，不存在图片那类裸路径黑屏（getFileUrl 在 Electron 恒空），
        //   ArrayBuffer 路径对 dev/prod 双源都稳，故 PDF 不切协议 url（避免 pdf.js worker fetch 自定义协议的不确定性）。
        const objectUrl = fileSystem.getFileUrl(filePath);
        if (objectUrl) {
          if (!cancelled) setData(objectUrl);
          return;
        }
        const binary = await fileSystem.readBinary(filePath);
        if (!cancelled) setData(binary);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'PDF 加载失败');
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  if (error) {
    return (
      <div className="pdf-viewer-loading">
        ⚠️ {fileName}: {error}
      </div>
    );
  }

  if (!data) {
    return <div className="pdf-viewer-loading">📄 加载 PDF 中...</div>;
  }

  return <PdfViewer data={data} currentPage={1} />;
}

function UnsupportedViewer({ fileName, filePath }: { fileName: string; filePath: string }) {
  return (
    <div className="editor-placeholder">
      <div className="placeholder-content unsupported-viewer">
        <span style={{ fontSize: 32, opacity: 0.5 }}>📄</span>
        <p>{fileName}</p>
        <p className="placeholder-hint">当前版本暂不支持内置预览，请用系统应用打开。</p>
        <p className="placeholder-hint">{filePath}</p>
      </div>
    </div>
  );
}

// ★ M4-3-S3：已发消息附件专用 viewer。objectUrl 已由 AgentPanel 用 attachment.get → blob → createObjectURL 解析；
//   本组件只按 mime 选渲染方式，绝不碰 fileSystem（附件无工作区路径）。不认识的 mime 给「下载 / 系统打开」兜底。
function AttachmentTabViewer({ objectUrl, fileName, mimeType }: { objectUrl: string; fileName: string; mimeType?: string }) {
  const mime = (mimeType || '').toLowerCase();
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const isImage = mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext);
  const isPdf = mime === 'application/pdf' || ext === 'pdf';
  const isText = mime.startsWith('text/')
    || mime === 'application/json'
    || mime === 'application/xml'
    || ['txt', 'md', 'json', 'csv', 'xml', 'log', 'yml', 'yaml', 'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'css', 'html'].includes(ext);

  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState('');

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    setText(null);
    setTextError('');
    (async () => {
      try {
        const resp = await fetch(objectUrl);
        const body = await resp.text();
        if (!cancelled) setText(body);
      } catch (err: any) {
        if (!cancelled) setTextError(err?.message || '文本读取失败');
      }
    })();
    return () => { cancelled = true; };
  }, [objectUrl, isText]);

  if (isImage) {
    return <ImageViewer src={objectUrl} fileName={fileName} />;
  }

  if (isPdf) {
    return (
      <iframe
        className="attachment-tab-frame"
        src={objectUrl}
        title={fileName}
        style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
      />
    );
  }

  if (isText) {
    if (textError) {
      return (
        <div className="editor-placeholder">
          <div className="placeholder-content">
            <span style={{ fontSize: 32, opacity: 0.5 }}>📄</span>
            <p>{fileName}</p>
            <p className="placeholder-hint">⚠️ {textError}</p>
          </div>
        </div>
      );
    }
    if (text === null) {
      return <div className="editor-placeholder"><div className="placeholder-content"><p>📄 加载中...</p></div></div>;
    }
    return <pre className="attachment-tab-text">{text}</pre>;
  }

  // 不认识的 mime（office / 二进制等）：不硬塞渲染，给下载链接兜底。
  return (
    <div className="editor-placeholder">
      <div className="placeholder-content unsupported-viewer">
        <span style={{ fontSize: 32, opacity: 0.5 }}>📎</span>
        <p>{fileName}</p>
        <p className="placeholder-hint">{mimeType || '未知类型'} 暂不支持内置预览。</p>
        <a className="attachment-tab-download" href={objectUrl} download={fileName}>下载附件</a>
      </div>
    </div>
  );
}

function CodeFileViewer({
  tabId,
  filePath,
  fileName,
  tabContent,
  savedContent,
  dirty,
  dispatch,
}: {
  tabId: string;
  filePath: string;
  fileName: string;
  tabContent?: string;
  savedContent?: string;
  dirty: boolean;
  dispatch: ReturnType<typeof useAppDispatch>;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (tabContent !== undefined) {
      setContent(tabContent);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const text = await fileSystem.readFile(filePath);
        if (!cancelled) {
          setContent(text);
          dispatch(setTabContent({ id: tabId, content: text, markSaved: true }));
        }
      } catch (err: any) {
        if (!cancelled) setContent(`无法加载文件: ${filePath}\n${err?.message || ''}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch, filePath, tabContent, tabId]);

  if (loading) {
    return <div className="markdown-viewer-loading">📄 加载文件中...</div>;
  }

  return (
    <CodeEditor
      filename={fileName}
      content={content}
      dirty={dirty}
      savedContent={savedContent}
      readOnly={false}
      onChange={(nextContent) => {
        dispatch(setTabContent({ id: tabId, content: nextContent }));
      }}
      onSave={async (nextContent) => {
        const result = await saveEditorFileWithConflictProtection(filePath, fileName, nextContent, savedContent);
        setContent(result.content);
        dispatch(markTabSaved({ id: tabId, content: result.content }));
        dispatch(addNotification({
          type: 'success',
          title: result.merged ? '已合并并保存' : '已保存',
          message: fileName,
          duration: 2000,
        }));
      }}
    />
  );
}
