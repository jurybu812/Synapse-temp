import { useEffect, useCallback } from 'react';
import { X, Info, CheckCircle, AlertTriangle, AlertCircle, Loader2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { removeNotification, type Notification } from '@/store/slices/notifications';
import type { RootState } from '@/store';

const icons: Record<Notification['type'], React.ElementType> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertCircle,
  progress: Loader2,
};

export function ToastContainer() {
  const items = useAppSelector((s: RootState) => s.notifications.items);
  return (
    <div className="toast-container">
      {items.map(item => (
        <ToastItem key={item.id} notification={item} />
      ))}
    </div>
  );
}

function ToastItem({ notification }: { notification: Notification }) {
  const dispatch = useAppDispatch();
  const { id, type, title, message, duration = 4000, progress, dismissible } = notification;

  const dismiss = useCallback(() => dispatch(removeNotification(id)), [dispatch, id]);

  useEffect(() => {
    if (duration > 0 && type !== 'progress') {
      const timer = setTimeout(dismiss, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, type, dismiss]);

  const Icon = icons[type];

  return (
    <div className={`toast-item toast-${type}`}>
      <div className="toast-icon">
        <Icon size={16} className={type === 'progress' ? 'toast-spinner' : ''} />
      </div>
      <div className="toast-body">
        <span className="toast-title">{title}</span>
        {message && <span className="toast-message">{message}</span>}
        {type === 'progress' && progress !== undefined && (
          <div className="toast-progress-bar">
            <div className="toast-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      {dismissible !== false && (
        <button className="toast-dismiss" onClick={dismiss}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}
