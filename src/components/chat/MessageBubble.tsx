import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Copy, Check, User, Bot, Wrench, MessageSquare, Pencil, RefreshCw, Trash2, FilePlus, FilePenLine, FileX2, FileText, ExternalLink, ListChecks, Undo2, GitBranch, ChevronDown, ChevronUp, ChevronRight, Plus, Image as ImageIcon, AtSign } from 'lucide-react';
import { memo, useDeferredValue, useState, useCallback, useEffect, useRef } from 'react';
import { ToolCallCard } from './ToolCallCard';
import { WorkflowCard } from './WorkflowCard';
import { ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { MermaidDiagram } from '@/components/chat/MermaidDiagram';
import { RichTextInput } from '@/components/chat/RichTextInput';
import { useAtMention } from '@/components/chat/useAtMention';
import { useAttachments } from '@/hooks/useAttachments';
import type { RichTextInputHandle, ExtractedToken } from '@/services/inputCommands/richInput/types';
import { buildRichParts } from '@/services/inputCommands/richInput/rebuild';
import type { AttachmentRef, ToolCall } from '@/store/slices/conversation';
import { useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import { confirmAction } from '@/services/confirmationCoordinator';

type ToolCallInfo = ToolCall;

interface FileDiffInfo {
  id: string;
  path: string;
  changeType: 'created' | 'edited' | 'deleted';
  additions: number;
  deletions: number;
  status: 'pending' | 'accepted' | 'rejected' | 'mixed' | 'superseded';
}

// ★ show_artifact：产物卡片渲染信息（与 store 的 MessageArtifact 对齐的最小子集；editorType 仅决定卡片图标，
//   实际打开走 AgentPanel.handleOpenArtifact 用 store 里的 editorType）。
interface ArtifactInfo {
  id: string;
  path: string;
  label: string;
  editorType?: 'code' | 'pdf' | 'office' | 'markdown' | 'html' | 'image' | 'video';
}

interface ThinkingInfo {
  content: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  collapsed?: boolean;
  status: 'pending' | 'streaming' | 'complete' | 'error';
}

interface AttachmentInfo {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'document' | 'text' | 'archive' | 'other';
  previewUrl?: string;
  // ★ M4-3-S3：打开已发附件需要这两个字段——sha256 用于按内容寻址 platform.attachment.get 解析 blob，
  //   payloadUrl 是内存态即时可用 URL（http/blob/object，非 data:）。运行时由 AttachmentRef 透传齐全。
  payloadUrl?: string;
  sha256?: string;
  status: 'pending' | 'ready' | 'error' | 'sent';
  error?: string;
}

interface MessageProps {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp?: number;
  model?: string;
  isStreaming?: boolean;
  historyActionsDisabled?: boolean;
  streamState?: 'idle' | 'pending' | 'streaming' | 'complete' | 'error' | 'aborted';
  streamMode?: 'real' | 'pseudo' | 'off';
  fallbackReason?: string;
  showStreamCursor?: boolean;
  showGeneratingPlaceholder?: boolean;
  durationMs?: number;
  // ★ M4-8-S3：重连进度【瞬态】——退避重试期间显示「reconnect i/N」，收到实质数据/本轮收尾即清。
  reconnect?: { attempt: number; max: number };
  // ★ M4-8-S4：端到端总计时（ms）——只挂在 agent loop 最终完成消息那一条上，渲染端到端徽标。
  endToEndMs?: number;
  thinking?: ThinkingInfo;
  attachments?: AttachmentInfo[];
  /** ★ M6 收尾 D1：富文本 atomic token 持久化锚点，编辑回填时供 buildRichParts 重组无损还原 @ 高亮块。 */
  richTokens?: ExtractedToken[];
  toolCalls?: ToolCallInfo[];
  diffs?: FileDiffInfo[];
  // ★ show_artifact：AI 主动推的产物卡片（指向已存在文件，点开即在编辑器打开）。
  artifacts?: ArtifactInfo[];
  // ★ M3-3a：@MultiAI 工作流汇总消息关联的运行实例 id；有则在消息体渲染实时四色 <WorkflowCard/>，
  //   纯文本 content 作为可折叠 fallback。
  workflowRunId?: string;
  onReviewChanges?: () => void;
  onOpenDiff?: (diff: FileDiffInfo) => void;
  // ★ show_artifact：点击产物卡片 → 在中部编辑器打开该文件（由 AgentPanel 实装 handleOpenArtifact）。
  onOpenArtifact?: (artifact: ArtifactInfo) => void;
  // ★ M4-3-S3：点击已发附件——图片走预览模态、文档走编辑器 attachment tab（由 AgentPanel 实装）。
  onOpenAttachment?: (att: AttachmentInfo) => void;
  onUndoToMessage?: (id: string) => void;
  onEdit?: (id: string, newContent: string, attachments?: AttachmentRef[], richTokens?: ExtractedToken[]) => void;
  onRetry?: (id: string) => void;
  onDelete?: (id: string) => void;
  // M2-3 对话分支：从该消息处「从此分支」，把该消息及之前另存为新对话（源对话不变）。
  onBranch?: (id: string) => void;
  onRefreshToolTask?: (taskId: string) => void | Promise<void>;
  onCancelToolTask?: (taskId: string) => void | Promise<void>;
}

// ★ M7 P0-3：判断某个 mermaid 代码块在 content 里是否【已闭合】（后面有结束的 fence），用于「该渲染就渲染」。
//   用正则提取所有已闭合 ```mermaid...``` 的代码体集合做成员判定（trim 比对，规避代码体含 ``` 字面量干扰，
//   不用纯数 fence 偶数法）。流式末尾正在写的未闭合块不会被匹配到 → 返回 false → 显加载占位。
function isMermaidFenceClosed(content: string, blockCode: string): boolean {
  const target = (blockCode ?? '').trim();
  if (!target) return false;
  const re = /```[ \t]*mermaid[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if ((m[1] ?? '').trim() === target) return true;
  }
  return false;
}

// Mermaid 渲染 + 交互式查看（缩放/平移/全屏）已抽到独立组件 MermaidDiagram.tsx。

function changeIcon(type: FileDiffInfo['changeType']) {
  if (type === 'created') return FilePlus;
  if (type === 'deleted') return FileX2;
  return FilePenLine;
}

function changeLabel(type: FileDiffInfo['changeType']) {
  if (type === 'created') return 'Created';
  if (type === 'deleted') return 'Deleted';
  return 'Edited';
}

// ★ M4-8-S4：带空格「X m Y s」+ 补 hour 位（≥1h 显示「H h M m S s」），支持「26 m 39 s」「1 h 5 m 0 s」量级。
function formatDuration(ms: number): string {
  if (ms < 1000) return '<1 s';
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 1) return `${hours} h ${minutes} m ${seconds} s`;
  if (totalMinutes >= 1) return `${minutes} m ${seconds} s`;
  return `${seconds} s`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function MessageBubbleImpl({ id, role, content, timestamp, model, isStreaming, historyActionsDisabled, streamState, streamMode, fallbackReason, showStreamCursor = true, showGeneratingPlaceholder = true, durationMs, reconnect, endToEndMs, thinking, attachments, richTokens, toolCalls, diffs, artifacts, workflowRunId, onReviewChanges, onOpenDiff, onOpenArtifact, onOpenAttachment, onUndoToMessage, onEdit, onRetry, onDelete, onBranch, onRefreshToolTask, onCancelToolTask }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  // ★ C6：编辑框改用 RichTextInput（DOM 唯一真值，与底部输入框完全一致），不再用 editContent 受控字符串。
  const editRichRef = useRef<RichTextInputHandle>(null);
  const [thinkingOpen, setThinkingOpen] = useState(!thinking?.collapsed);
  // ★ M3-3a：工作流卡片消息默认折叠纯文本汇总（卡片是主视图，文本汇总作为可展开 fallback）。
  const [workflowSummaryOpen, setWorkflowSummaryOpen] = useState(false);
  // ★ M5-1 压缩归一：原 role==='system' 压缩摘要卡片的折叠 state 已删除（不再渲染 system 摘要卡片）。
  const [now, setNow] = useState(() => Date.now());
  // ★ B4（反馈#11）：user 长消息折叠/展开（仿 CC）。expanded=用户已点「展开」；overflow=内容实测超过折叠阈值才需展开按钮。
  //   用 ref 测内容容器 scrollHeight 判断是否超高——超阈值才显「展开」，短消息不显。
  const [userMsgExpanded, setUserMsgExpanded] = useState(false);
  const [userMsgOverflow, setUserMsgOverflow] = useState(false);
  const userMsgContentRef = useRef<HTMLDivElement>(null);
  // ★ C6：editRef(textarea) 移除，改 editRichRef(RichTextInput)。
  const live = isStreaming || streamState === 'pending' || streamState === 'streaming';
  const historyMutationLocked = Boolean(historyActionsDisabled || live);
  const isUser = role === 'user';
  const customAvatar = useAppSelector((s: RootState) => (isUser ? s.settings.userAvatar : s.settings.aiAvatar));
  const customName = useAppSelector((s: RootState) => (isUser ? s.settings.userName : s.settings.aiName));
  const roleName = (customName && customName.trim()) ? customName : (isUser ? '你' : 'Synapse AI');
  // ★ M7 性能 D1：markdown 渲染用 deferredContent（滞后一拍的低优先级值）——把长尾 markdown 解析标记为
  //   可中断渲染，让输入/点按钮等紧急交互能插队优先，缓解流式期界面卡顿（React 19）。
  const deferredContent = useDeferredValue(content);
  const elapsedMs = durationMs ?? (timestamp ? now - timestamp : 0);
  const streamLabel = streamMode === 'pseudo'
    ? 'Pseudo'
    : streamMode === 'real'
      ? 'Streaming'
      : streamMode === 'off'
        ? 'Complete'
        : 'Thought';

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (thinking?.collapsed !== undefined) setThinkingOpen(!thinking.collapsed);
  }, [thinking?.collapsed]);

  // ★ B4：测 user 消息内容是否超过折叠阈值（与 CSS .message-text-collapsible 折叠态 max-height 同值）。
  //   超高才显「展开」按钮；内容/编辑态变化后重测。editing 态不折叠（编辑框需完整展开）。
  const USER_MSG_COLLAPSE_PX = 200;
  useEffect(() => {
    if (role !== 'user' || isEditing) { setUserMsgOverflow(false); return; }
    const el = userMsgContentRef.current;
    if (!el) return;
    setUserMsgOverflow(el.scrollHeight > USER_MSG_COLLAPSE_PX + 4);
  }, [role, isEditing, content, richTokens]);

  const handleStartEdit = useCallback(() => {
    setIsEditing(true);
    // setContent + focus 在下方 effect（RichTextInput 挂载后）执行。
  }, []);

  // ★ C6 附件：编辑框复用底部同款附件链路（useAttachments hook，与编辑框 @ 菜单 useAtMention 同构）。
  const editAtt = useAttachments();
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const editImageInputRef = useRef<HTMLInputElement>(null);

  const handleSubmitEdit = useCallback(() => {
    // ★ D1：同时取最新 tokens——用户编辑时可能增删了 atomic 块，必须用 extract 后的最新集合（不能复用进编辑前的旧 richTokens）。
    const extracted = editRichRef.current?.extract();
    const text = (extracted?.plainText ?? '').trim();
    const newTokens = extracted?.tokens ?? [];
    const readyAtts = editAtt.ready();
    // 纯空（无文本无附件）→ 取消 + release 新上传草稿；否则带文本+附件+richTokens 提交。
    if (!text && readyAtts.length === 0) { setIsEditing(false); editAtt.releaseDrafts(); return; }
    onEdit?.(id, text, readyAtts, newTokens.length > 0 ? newTokens : undefined);
    setIsEditing(false);
    editAtt.markCommitted(); // 新上传草稿引用已随消息转移走，清记录不 release（refCount 守恒路径 E）。
  }, [id, content, onEdit, editAtt]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    editAtt.releaseDrafts(); // 取消：release 本次新上传草稿，原消息引用不动（路径 D）。
  }, [editAtt]);

  // ★ C6：编辑框 = RichTextInput + 完整两级 @ 菜单（与底部输入框同一套 useAtMention）。Enter 保存、Shift+Enter 换行、Esc 取消。
  const { menuElement: editMenuElement, handleEditorKeyDown: editKeyDown, refreshMenu: editRefreshMenu, openAtMenu: editOpenAtMenu } = useAtMention({
    richRef: editRichRef,
    onSubmit: handleSubmitEdit,
    submitOnPlainEnter: true,
  });
  // ★ #9：编辑态加号小窗开关（对齐底部输入框「加号」形态，替代旧 📎🖼 两按钮）。
  const [editAddMenuOpen, setEditAddMenuOpen] = useState(false);

  // 进入编辑：RichTextInput 挂载后回填 + 聚焦 + 还原原消息附件成可编辑草稿。
  // ★ D1：用 buildRichParts(content, richTokens) 重组——有 richTokens 时无损还原 atomic 块，旧消息无 richTokens 自动降级纯文本。
  useEffect(() => {
    if (!isEditing) return;
    editRichRef.current?.setContent(buildRichParts(content, richTokens));
    editRichRef.current?.focus();
    editAtt.restoreFrom(attachments as AttachmentRef[] | undefined);
    // richTokens/attachments/editAtt 故意不入依赖：进编辑那一刻快照即可，避免外部刷新覆盖用户编辑（与附件同口径）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, content]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const messageMenuItems: MenuItem[] = [
    {
      label: '复制内容',
      icon: <Copy size={14} />,
      shortcut: 'Ctrl+C',
      onClick: handleCopy,
    },
    {
      label: '复制为 Markdown',
      icon: <Copy size={14} />,
      onClick: () => navigator.clipboard.writeText(`**${role === 'user' ? '用户' : 'AI'}**: ${content}`),
    },
    { label: '', onClick: () => { }, separator: true },
    {
      label: '引用回复',
      icon: <MessageSquare size={14} />,
      onClick: () => console.log('引用:', content.slice(0, 50)),
    },
    // Stage 6: 按角色添加操作
    ...(!historyMutationLocked && role === 'user' ? [{
      label: '编辑消息',
      icon: <Pencil size={14} />,
      shortcut: 'E',
      onClick: handleStartEdit,
    }] : []),
    // ★ Plan_5 M5-4 重试入口（规范 §5）：重试挂在 user 消息上（不再挂 AI 消息）。
    //   点某条 user 的「重新生成」= 回溯到该 user 所在轮（截断该 user 段之后全部，含本轮 model 段所有
    //   assistant/tool 中间 step）+ record 砍批 + 自动重发该 user（不填输入框）。接线见 AgentPanel.handleRetry。
    ...(!historyMutationLocked && role === 'user' && onRetry ? [{
      label: '重新生成回答',
      icon: <RefreshCw size={14} />,
      shortcut: 'R',
      onClick: () => onRetry(id),
    }] : []),
    ...(!historyMutationLocked && onBranch ? [{
      label: '从此分支为新对话',
      icon: <GitBranch size={14} />,
      onClick: () => onBranch(id),
    }] : []),
    ...(!historyMutationLocked ? [{ label: '', onClick: () => { }, separator: true } as MenuItem, {
      label: '删除消息',
      icon: <Trash2 size={14} />,
      onClick: () => {
        void confirmAction({
          title: '删除这条消息？',
          message: '这条消息会从当前对话中移除。',
          confirmLabel: '确认删除',
          tone: 'danger',
        }).then(confirmed => {
          if (confirmed) onDelete?.(id);
        });
      },
      danger: true,
    } as MenuItem] : []),
  ];

  if (role === 'tool') {
    return (
      <div className="message message-tool">
        <div className="message-avatar tool-avatar">
          <Wrench size={14} />
        </div>
        <div className="message-body">
          <div className="tool-result-card glass-panel">
            <pre className="tool-result-content">{content}</pre>
          </div>
        </div>
      </div>
    );
  }

  // ★ M5-1 压缩归一：原 role==='system' 的「手动压缩摘要卡片」渲染分支已删除。
  //   归一后压缩绝不把摘要物化成 system 消息塞进 store.messages，故正常不再有 system 摘要卡片需要渲染。
  //   压缩点改由 AgentPanel.batchDividerByIdx「已压缩」分隔线呈现，对话原文照常全量显示。
  //   遗留 system 摘要的【治本清理】在对话加载入口（conversationPersistence.stripLegacyCompactMessages）一次性剥除，
  //   归一后 store 恒无 system 消息——这是主防线。
  //
  //   下面这条极简 system 兜底是【第二道防线】（纯防御）：万一某条遗留 compact_* system 摘要因边缘路径仍漏进 store，
  //   绝不让它掉到通用气泡分支被当成 AI 正文铺出（既视觉突兀又误导用户以为 AI 真发了这段）。
  //   渲染成与「已压缩」分隔线同款的极简提示，原文不当正文展示。
  if (role === 'system') {
    return (
      <div
        className="message-compact-divider"
        style={{ textAlign: 'center', fontSize: 11, color: 'var(--syn-text-muted)', padding: '6px 12px', margin: '6px 0', borderTop: '1px dashed rgba(255,255,255,0.12)', opacity: 0.75 }}
        title="此处为历史压缩摘要占位（遗留数据）；发送给 AI 时用 record 摘要代替原文"
      >
        ⌁ 历史已压缩为摘要 ⌁
      </div>
    );
  }

  return (
    // ★ H6：data-message-id 作 DOM anchor，供「消息导航」浮层 querySelector 定位 + 滚动跳转 + 高亮闪烁。
    <div className={`message message-${role}`} data-message-id={id} onContextMenu={handleContextMenu}>
      <div className={`message-avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}${customAvatar ? ' has-custom-avatar' : ''}`}>
        {customAvatar
          ? <img src={customAvatar} alt={roleName} className="message-avatar-img" />
          : (isUser ? <User size={16} /> : <Bot size={16} />)}
      </div>
      <div className="message-body">
        <div className="message-header">
          <span className="message-role">{roleName}</span>
          {timestamp && (
            <span className="message-time">
              {new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {/* ★ 主人反馈#4：模型型号只挂 AI 气泡——user 消息虽也带 model 字段（agentLoop 落库时记录当时模型），但显示在用户气泡上无意义且突兀。 */}
          {!isUser && model && <span className="message-model">{model}</span>}
          {!isUser && (live || durationMs !== undefined || streamState === 'aborted') && (
            <span
              className={`message-stream-state state-${streamState ?? (live ? 'streaming' : 'complete')} mode-${streamMode ?? 'unknown'}`}
              title={fallbackReason}
            >
              {streamState === 'aborted'
                ? 'Stopped'
                : live
                  ? `${streamLabel} for ${formatDuration(elapsedMs)}`
                  : `Completed in ${formatDuration(elapsedMs)}`}
            </span>
          )}
          {/* ★ M4-8-S3：重连进度——退避重试期间气泡内显示「reconnect i/N」（瞬态，收到数据/收尾即清）。 */}
          {!isUser && reconnect && (
            <span className="message-reconnect-state" title="连接不稳，正在自动重试">
              <RefreshCw size={11} className="reconnect-spin" /> reconnect {reconnect.attempt}/{reconnect.max}
            </span>
          )}
          {/* ★ M4-8-S4：端到端总计时徽标——只挂在 agent loop 最终完成消息那一条（含多轮工具调用全程）。 */}
          {!isUser && endToEndMs !== undefined && (
            <span className="message-e2e-state" title="本轮端到端总耗时（含多轮工具调用）">
              total {formatDuration(endToEndMs)}
            </span>
          )}
          {/* Action buttons */}
          <div className="message-actions">
            {!isUser && (
              <button className="message-action-btn" onClick={handleCopy} title="复制">
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            )}
            {isUser && !historyMutationLocked && onEdit && (
              <button className="message-action-btn" onClick={handleStartEdit} title="编辑">
                <Pencil size={12} />
              </button>
            )}
            {/* ★ Plan_5 M5-4：重试入口改挂 user 消息（点该 user = 回溯到其所在轮 + 自动重发该 user）。 */}
            {isUser && !historyMutationLocked && onRetry && (
              <button className="message-action-btn" onClick={() => onRetry(id)} title="重新生成回答（回溯到本轮并重发）">
                <RefreshCw size={12} />
              </button>
            )}
            {!historyMutationLocked && onDelete && (
              <button className="message-action-btn danger" onClick={() => onDelete(id)} title="删除">
                <Trash2 size={12} />
              </button>
            )}
            {/* ★ Plan_5 M5-3：回溯入口只挂 user 消息——点该 user = 它及之后全部回溯掉、该 user 回填输入框待改后再发。 */}
            {isUser && !historyMutationLocked && onUndoToMessage && (
              <button className="message-action-btn" onClick={() => onUndoToMessage(id)} title="回溯：清掉这条及之后，这条回到输入框">
                <Undo2 size={12} />
              </button>
            )}
            {!historyMutationLocked && onBranch && (
              <button className="message-action-btn" onClick={() => onBranch(id)} title="从此分支为新对话">
                <GitBranch size={12} />
              </button>
            )}
          </div>
        </div>
        {/* ★ M4-3-S2：思考块移到正文之前（原在正文之后导致「思考显示在回答下方」）。折叠逻辑不变。 */}
        {!isUser && thinking?.content && (
          <div className="thinking-block">
            <button className="thinking-toggle" onClick={() => setThinkingOpen(open => !open)}>
              {thinkingOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Thought for {formatDuration(thinking.durationMs ?? elapsedMs)}</span>
            </button>
            {thinkingOpen && (
              <pre className="thinking-content">{thinking.content}</pre>
            )}
          </div>
        )}
        <div className={`message-content ${isStreaming ? 'streaming' : ''}`}>
          {isUser ? (
            isEditing ? (
              <div className="message-edit-area">
                {/* ★ C6：编辑框与底部输入框完全一致——RichTextInput + 两级 @ 菜单（复用 .agent-input 样式）。 */}
                <div className="agent-input-container message-edit-rich">
                  {editMenuElement}
                  <RichTextInput
                    ref={editRichRef}
                    className="agent-input"
                    placeholder="编辑消息... (Enter 保存，Shift+Enter 换行，Esc 取消；@ 引用，/ 命令)"
                    onContentChange={editRefreshMenu}
                    onPasteFiles={(files) => { void editAtt.addFiles(files, 'image'); }}
                    onEditorKeyDown={(e) => {
                      if (editKeyDown(e)) return true;
                      if (e.key === 'Escape') { e.preventDefault(); handleCancelEdit(); return true; }
                      return false;
                    }}
                  />
                </div>
                {/* ★ C6 附件：编辑态附件 tray（复用底部 .attachment-tray/.attachment-chip 样式 + 行为接 editAtt）。 */}
                {editAtt.pending.length > 0 && (
                  <div className="attachment-tray">
                    {editAtt.pending.map(att => (
                      <button key={att.id} className={`attachment-chip status-${att.status} kind-${att.kind}`} title={att.error || `${att.name} · ${formatBytes(att.size)}`}>
                        {att.kind === 'image' && att.previewUrl ? (
                          <img src={att.previewUrl} alt={att.name} />
                        ) : (
                          <span className="attachment-icon">{att.kind === 'document' ? '📄' : att.kind === 'archive' ? '🗜' : '📎'}</span>
                        )}
                        <span className="attachment-meta"><strong>{att.name}</strong><small>{att.error || formatBytes(att.size)}</small></span>
                        <span className="attachment-remove" role="button" tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); editAtt.remove(att.id); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); editAtt.remove(att.id); } }}
                          aria-label="移除附件">×</span>
                      </button>
                    ))}
                  </div>
                )}
                <input ref={editFileInputRef} type="file" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void editAtt.addFiles(fs, 'file'); e.target.value = ''; }} />
                <input ref={editImageInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void editAtt.addFiles(fs, 'image'); e.target.value = ''; }} />
                <div className="message-edit-actions">
                  {/* ★ #9：附文件/附图两按钮收敛为「加号小窗」，与底部输入框 C3 加号对齐（上传文件/上传图片/提及@）。 */}
                  <div className="add-menu-wrap">
                    <button
                      type="button"
                      className={`input-tool-btn add-menu-trigger${editAddMenuOpen ? ' active' : ''}`}
                      title="添加内容"
                      onClick={() => setEditAddMenuOpen(o => !o)}
                    >
                      <Plus size={16} />
                    </button>
                    {editAddMenuOpen && (
                      <div className="add-menu">
                        <button className="add-menu-item" type="button" onClick={() => { setEditAddMenuOpen(false); editFileInputRef.current?.click(); }}>
                          <FilePlus size={15} /> 上传文件
                        </button>
                        <button className="add-menu-item" type="button" onClick={() => { setEditAddMenuOpen(false); editImageInputRef.current?.click(); }}>
                          <ImageIcon size={15} /> 上传图片
                        </button>
                        <button className="add-menu-item" type="button" onClick={() => { setEditAddMenuOpen(false); editOpenAtMenu(); }}>
                          <AtSign size={15} /> 提及 @
                        </button>
                      </div>
                    )}
                  </div>
                  <button className="edit-btn save" onClick={handleSubmitEdit}>保存并重新发送</button>
                  <button className="edit-btn cancel" onClick={handleCancelEdit}>取消</button>
                </div>
              </div>
            ) : (
              // ★ M6 验收 bug6：已发 user 消息复用 buildRichParts 把 @ 占位还原成只读高亮 chip（与编辑态口径一致）。
              //   只读：不加 contentEditable/data-token（避免被任何编辑逻辑误判）；旧消息无 richTokens 时降级为整段纯文本。
              // ★ B4（反馈#11）：超阈值的 user 长消息默认折叠（CSS max-height + 渐隐遮罩），点「展开」看全文。
              //   ref 挂在内容 <p> 上测 scrollHeight；折叠态加 .is-collapsed，遮罩与展开按钮仅在 userMsgOverflow 时出现。
              <div className="message-text-collapsible">
                <p
                  ref={userMsgContentRef}
                  className={`message-text${userMsgOverflow && !userMsgExpanded ? ' is-collapsed' : ''}`}
                >
                  {buildRichParts(content, richTokens).map((part, i) =>
                    typeof part === 'string'
                      ? part
                      : (
                        <span key={i} className={`rt-token rt-token-${part.type} rt-token-readonly`}>
                          {'@' + (part.displayLabel ?? part.value)}
                        </span>
                      )
                  )}
                </p>
                {userMsgOverflow && (
                  <button
                    className="message-expand-btn"
                    onClick={() => setUserMsgExpanded(v => !v)}
                  >
                    {userMsgExpanded
                      ? <><ChevronUp size={13} />收起</>
                      : <><ChevronDown size={13} />展开</>}
                  </button>
                )}
              </div>
            )
          ) : workflowRunId ? (
            // ★ M3-3a：工作流汇总消息——实时四色卡片为主视图，纯文本汇总折叠为 fallback。
            //   WorkflowCard 在 runId 查不到运行实例时返回 null（重启后运行态已清空），此时仅显示文本汇总。
            <div className="message-workflow">
              <WorkflowCard runId={workflowRunId} />
              {content && (
                <div className="message-workflow-summary">
                  <button
                    className="thinking-toggle"
                    onClick={() => setWorkflowSummaryOpen(open => !open)}
                  >
                    {workflowSummaryOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>文本汇总</span>
                  </button>
                  {workflowSummaryOpen && (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                    >
                      {content}
                    </ReactMarkdown>
                  )}
                </div>
              )}
            </div>
          ) : content ? (
            // ★ M6 验收 C2c 调整：流式期照常渲染 markdown（不再降级纯文本），降频靠 agentLoop flush 节流(~200ms)
            //   控制——主人要的是「降低渲染频率」而非「不渲染」。流式期文字带格式、每 ~200ms 刷一批。
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const lang = match?.[1];
                  const childStr = String(children).replace(/\n$/, '');

                  // Mermaid diagrams ——★ M7 P0-3「该渲染就渲染」：块已闭合(content 里有结束 fence)即渲染，
                  //   即使整条消息还在流式；只有正在书写的最后那个未闭合块 pending=显加载占位。
                  if (lang === 'mermaid') {
                    const closed = !isStreaming || isMermaidFenceClosed(deferredContent, childStr);
                    return <MermaidDiagram code={childStr} pending={!closed} />;
                  }

                  const isBlock = match || (typeof children === 'string' && children.includes('\n'));
                  if (isBlock) {
                    return (
                      <div className="code-block">
                        <div className="code-block-header">
                          <span className="code-lang">{lang || 'code'}</span>
                          <button
                            className="code-copy-btn"
                            onClick={() => navigator.clipboard.writeText(childStr)}
                          >
                            <Copy size={12} /> 复制
                          </button>
                        </div>
                        <pre><code className={className} {...props}>{children}</code></pre>
                      </div>
                    );
                  }
                  return <code className="inline-code" {...props}>{children}</code>;
                },
              }}
            >
              {deferredContent}
            </ReactMarkdown>
          ) : (
            <span className="message-placeholder">{live && showGeneratingPlaceholder ? '思考中...' : ''}</span>
          )}
          {isStreaming && showStreamCursor && <span className="cursor-blink">▊</span>}
        </div>

        {attachments && attachments.length > 0 && (
          <div className="message-attachments">
            {attachments.map(att => {
              // ★ M4-3-S3：可点开判定——非 error 且有解析途径（sha256 内容寻址 / 内存态 payloadUrl / 图片预览）。
              const openable = !!onOpenAttachment && att.status !== 'error'
                && !att.error && !!(att.sha256 || att.payloadUrl || att.previewUrl);
              const handleOpen = () => { if (openable) onOpenAttachment?.(att); };
              return (
                <div
                  key={att.id}
                  className={`message-attachment kind-${att.kind} status-${att.status}${openable ? ' clickable' : ''}`}
                  title={att.error || att.name}
                  role={openable ? 'button' : undefined}
                  tabIndex={openable ? 0 : undefined}
                  onClick={openable ? handleOpen : undefined}
                  onKeyDown={openable ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpen(); }
                  } : undefined}
                >
                  {att.kind === 'image' && att.previewUrl ? (
                    <img src={att.previewUrl} alt={att.name} />
                  ) : (
                    <span className="message-attachment-icon">{att.kind === 'document' ? '📄' : att.kind === 'archive' ? '🗜' : '📎'}</span>
                  )}
                  <span className="message-attachment-name">{att.name}</span>
                  <small>{att.error || formatBytes(att.size)}</small>
                </div>
              );
            })}
          </div>
        )}

        {/* ★ show_artifact：AI 主动推的产物卡片（点开即在中部编辑器打开已存在文件），与 diffs 并列。 */}
        {artifacts && artifacts.length > 0 && (
          <div className="message-artifacts">
            {artifacts.map(art => {
              const fileName = art.label || art.path.split(/[\\/]/).pop() || art.path;
              return (
                <button
                  key={art.id}
                  className="artifact-chip"
                  onClick={() => onOpenArtifact?.(art)}
                  title={art.path}
                >
                  <FileText size={14} />
                  <strong>{fileName}</strong>
                  <span className="artifact-open"><ExternalLink size={12} />打开</span>
                </button>
              );
            })}
          </div>
        )}

        {diffs && diffs.length > 0 && (
          <div className="message-file-changes">
            {diffs.map(diff => {
              const Icon = changeIcon(diff.changeType);
              const fileName = diff.path.split(/[\\/]/).pop() || diff.path;
              return (
                <button
                  key={diff.id}
                  className={`file-change-chip status-${diff.status}`}
                  onClick={() => onOpenDiff?.(diff)}
                  title={diff.path}
                >
                  <Icon size={14} />
                  <span>{changeLabel(diff.changeType)}</span>
                  <strong>{fileName}</strong>
                  <span className="diff-add">+{diff.additions}</span>
                  <span className="diff-del">-{diff.deletions}</span>
                </button>
              );
            })}
            <button className="review-changes-btn" onClick={onReviewChanges}>
              <ListChecks size={14} />
              Review Changes
            </button>
          </div>
        )}

        {/* Tool Call Cards */}
        {toolCalls && toolCalls.length > 0 && (
          <div className="tool-calls-container">
            {toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} onTaskRefresh={onRefreshToolTask} onTaskCancel={onCancelToolTask} />
            ))}
          </div>
        )}

        {/* ★ B3（反馈#5）：AI 消息右下角再放一份操作按钮（与顶部 .message-actions 同款回调），
            读完长消息不必翻回顶部。仅 assistant、非流式时出现；hover 显隐由 .message:hover 控制。
            复用现有回调，不新造逻辑：复制走 handleCopy；回溯/重试/分支/删除直接传本条 id。 */}
        {!isUser && !historyMutationLocked && (
          <div className="message-actions message-actions-bottom">
            <button className="message-action-btn" onClick={handleCopy} title="复制">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            {onUndoToMessage && (
              <button className="message-action-btn" onClick={() => onUndoToMessage(id)} title="回溯：清掉这条及之后">
                <Undo2 size={12} />
              </button>
            )}
            {onRetry && (
              <button className="message-action-btn" onClick={() => onRetry(id)} title="重新生成回答">
                <RefreshCw size={12} />
              </button>
            )}
            {onBranch && (
              <button className="message-action-btn" onClick={() => onBranch(id)} title="从此分支为新对话">
                <GitBranch size={12} />
              </button>
            )}
            {onDelete && (
              <button className="message-action-btn danger" onClick={() => onDelete(id)} title="删除">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          items={messageMenuItems}
          position={contextMenu}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}

// ★ M6 验收 bug4 性能：React.memo 包裹——流式时整个消息列表会重渲，但绝大多数历史气泡 props 引用稳定
//   （content/thinking/toolCalls 等从 Redux 取、回调 useCallback、attachments 由 AgentPanel useMemo 缓存），
//   memo 浅比较命中 → 只重渲「正在生成的那一条」，历史 N 条不再陪跑。这是消掉「30 帧」感受的最大单点。
export const MessageBubble = memo(MessageBubbleImpl);
