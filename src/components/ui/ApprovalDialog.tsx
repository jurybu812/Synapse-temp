/**
 * ApprovalDialog —— 危险工具审批浮层（替代原生 window.confirm）。
 *
 * 诊断(workflow w0b0hdiwc #4)：run_command / enter_worktree 等工具的审批此前用浏览器原生
 * window.confirm——样式与 app 玻璃拟态不一致、无动画、参数被截断 200 字、同步阻塞。
 * 底层审批机制(toolRegistry.setApprovalCallback)本就是 Promise 化的，这里只替换 UI 端：
 * createPortal 到 body + glass-panel + 进出场动画 + Esc 拒绝 / Ctrl·Cmd+Enter 同意 / 点遮罩拒绝。
 *
 * 受控组件：request 为 null = 关闭；非 null = 展示该审批请求。父组件(AgentPanel)用一个
 * pending resolve ref 把用户的同意/拒绝回填给 Promise。
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert } from 'lucide-react';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  /** 权限级别：read / write / command / dangerous（来自工具注册的 approvalLevel）。 */
  level: string;
  /** 参数 JSON 文本（完整，不截断；UI 里可滚动）。 */
  argsText: string;
  /** 发起方文案：'AI' 或 '子代理「角色」'。 */
  originLabel: string;
  title?: string;
  confirmLabel?: string;
  queuedCount?: number;
  /** 审批所属对话，避免切换页面后误把 A 的操作当成 B 批准。 */
  conversationId?: string;
  conversationLabel?: string;
  /** 可选的定制说明（如 enter_worktree 解释会建工作树目录+分支）。参数仍会同时展示。 */
  message?: string;
}

interface Props {
  request: ApprovalRequest | null;
  onApprove: () => void;
  onReject: () => void;
  onStop?: () => void;
}

const LEVEL_META: Record<string, { label: string; cls: string }> = {
  read: { label: '读取', cls: 'read' },
  write: { label: '写入', cls: 'write' },
  command: { label: '命令', cls: 'danger' },
  dangerous: { label: '危险', cls: 'danger' },
};

export function ApprovalDialog({ request, onApprove, onReject, onStop }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const isOpen = Boolean(request);

  if (isOpen && !wasOpenRef.current) {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = isOpen;

  useEffect(() => {
    if (request) {
      rejectButtonRef.current?.focus();
      return;
    }
    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  }, [request]);

  useEffect(() => () => {
    const previousFocus = previousFocusRef.current;
    if (previousFocus?.isConnected) previousFocus.focus();
  }, []);

  // Esc = 拒绝；Ctrl/Cmd+Enter = 同意。普通 Enter 不批准，避免输入习惯或按键重复误放行后续审批。
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onReject(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.repeat) { e.preventDefault(); onApprove(); }
      else if (e.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])
          .filter(element => !element.hasAttribute('disabled'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onApprove, onReject]);

  if (!request) return null;
  const lv = LEVEL_META[request.level] || { label: request.level, cls: 'write' };
  const approveLabel = request.level === 'read'
    ? '仅允许此次读取'
    : request.level === 'write'
      ? '仅允许此次写入'
      : '仅允许此次操作';
  const confirmLabel = request.confirmLabel ?? approveLabel;
  const titleId = `approval-title-${request.id}`;
  const descriptionId = `approval-description-${request.id}`;

  return createPortal(
    <div
      className="approval-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onReject(); }}
    >
      <div
        ref={dialogRef}
        className="approval-dialog glass-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="approval-header">
          <ShieldAlert size={18} className="approval-icon" />
          <span id={titleId} className="approval-title">{request.title ?? `${request.originLabel}请求执行工具`}</span>
          <span className={`approval-badge ${lv.cls}`}>{lv.label}</span>
          {request.queuedCount ? <span className="approval-queue">排队 {request.queuedCount} 个</span> : null}
        </div>
        <div className="approval-tool">{request.toolName}</div>
        <div id={descriptionId} className="approval-content">
          {request.conversationLabel && <div className="approval-message">对话归属：{request.conversationLabel}</div>}
          {request.message && <div className="approval-message">{request.message}</div>}
          <div className="approval-args-section">
            <div className="approval-section-label">
              {request.level === 'command' || request.level === 'dangerous'
                ? '本次命令与工作目录'
                : '本次工具参数'}
            </div>
            <pre className="approval-args">{request.argsText}</pre>
          </div>
        </div>
        <div className="approval-actions">
          {onStop ? <button type="button" className="approval-btn danger" onClick={onStop}>停止任务</button> : null}
          <button ref={rejectButtonRef} type="button" className="approval-btn reject" onClick={onReject}>拒绝 (Esc)</button>
          <button type="button" className="approval-btn approve" onClick={onApprove}>{confirmLabel} (Ctrl+Enter)</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
