import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { confirmationCoordinator } from '@/services/confirmationCoordinator';

export function ConfirmationDialogHost() {
  const request = useSyncExternalStore(
    confirmationCoordinator.subscribe,
    confirmationCoordinator.getSnapshot,
    confirmationCoordinator.getSnapshot,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [inputValue, setInputValue] = useState('');
  const isOpen = Boolean(request);

  if (isOpen && !wasOpenRef.current) {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = isOpen;

  useEffect(() => {
    if (request) {
      setInputValue(request.defaultValue ?? '');
      if (request.kind === 'prompt') inputRef.current?.focus();
      else cancelButtonRef.current?.focus();
      return;
    }
    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        confirmationCoordinator.resolve(request.id, request.kind === 'confirm' ? false : null);
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.repeat) {
        event.preventDefault();
        if (request.kind === 'confirm' || request.kind === 'notice') confirmationCoordinator.resolve(request.id, true);
        else if (request.kind === 'prompt') confirmationCoordinator.resolve(request.id, inputValue);
      } else if (event.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])
          .filter(element => !element.hasAttribute('disabled'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [inputValue, request]);

  useEffect(() => () => {
    const previousFocus = previousFocusRef.current;
    if (previousFocus?.isConnected) previousFocus.focus();
  }, []);

  if (!request) return null;
  const titleId = `confirmation-title-${request.id}`;
  const descriptionId = `confirmation-description-${request.id}`;

  return createPortal(
    <div
      className="approval-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) confirmationCoordinator.resolve(request.id, false);
      }}
    >
      <div
        ref={dialogRef}
        className="approval-dialog confirmation-dialog glass-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="approval-header">
          <AlertTriangle size={19} className={`approval-icon ${request.tone === 'danger' ? 'danger' : ''}`} />
          <span id={titleId} className="approval-title">{request.title}</span>
        </div>
        <div id={descriptionId} className="confirmation-message">{request.message}</div>
        {request.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="confirmation-input"
            value={inputValue}
            placeholder={request.placeholder}
            onChange={event => setInputValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                confirmationCoordinator.resolve(request.id, inputValue);
              }
            }}
          />
        )}
        <div className="approval-actions">
          {request.kind !== 'notice' && (
            <button
              ref={cancelButtonRef}
              type="button"
              className="approval-btn reject"
              onClick={() => confirmationCoordinator.resolve(request.id, request.kind === 'confirm' ? false : null)}
            >
              {request.cancelLabel} (Esc)
            </button>
          )}
          {request.kind === 'choice' && request.choices?.map(choice => (
            <button
              key={choice.value}
              type="button"
              className={`approval-btn ${choice.tone === 'danger' ? 'danger' : 'approve'}`}
              onClick={() => confirmationCoordinator.resolve(request.id, choice.value)}
            >
              {choice.label}
            </button>
          ))}
          {request.kind !== 'choice' && (
            <button
              ref={request.kind === 'notice' ? cancelButtonRef : undefined}
              type="button"
              className={`approval-btn ${request.tone === 'danger' ? 'danger' : 'approve'}`}
              onClick={() => confirmationCoordinator.resolve(request.id, request.kind === 'prompt' ? inputValue : true)}
            >
              {request.confirmLabel}{request.kind === 'notice' ? '' : ' (Ctrl+Enter)'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
