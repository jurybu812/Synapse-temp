export type ConfirmationTone = 'default' | 'danger';

export interface DialogChoice {
  value: string;
  label: string;
  tone?: ConfirmationTone;
}

export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmationTone;
}

export interface ConfirmationRequest extends ConfirmationOptions {
  id: string;
  kind: 'confirm' | 'prompt' | 'choice' | 'notice';
  defaultValue?: string;
  placeholder?: string;
  choices?: DialogChoice[];
}

interface ConfirmationEntry {
  request: ConfirmationRequest;
  resolve: (result: boolean | string | null) => void;
}

type Listener = () => void;

class ConfirmationCoordinator {
  private active: ConfirmationEntry | null = null;
  private readonly queue: ConfirmationEntry[] = [];
  private readonly listeners = new Set<Listener>();

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConfirmationRequest | null => this.active?.request ?? null;

  request(options: ConfirmationOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const entry: ConfirmationEntry = {
        request: {
          ...options,
          id: crypto.randomUUID(),
          kind: 'confirm',
          confirmLabel: options.confirmLabel ?? '确认',
          cancelLabel: options.cancelLabel ?? '取消',
          tone: options.tone ?? 'default',
        },
        resolve: result => resolve(result === true),
      };
      this.enqueue(entry);
    });
  }

  prompt(options: Omit<ConfirmationOptions, 'confirmLabel'> & { defaultValue?: string; placeholder?: string }): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.enqueue({
        request: {
          ...options,
          id: crypto.randomUUID(),
          kind: 'prompt',
          confirmLabel: '确认',
          cancelLabel: options.cancelLabel ?? '取消',
          tone: options.tone ?? 'default',
        },
        resolve: result => resolve(typeof result === 'string' ? result : null),
      });
    });
  }

  choose(options: Omit<ConfirmationOptions, 'confirmLabel'> & { choices: DialogChoice[] }): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.enqueue({
        request: {
          ...options,
          id: crypto.randomUUID(),
          kind: 'choice',
          confirmLabel: '',
          cancelLabel: options.cancelLabel ?? '取消',
          tone: options.tone ?? 'default',
        },
        resolve: result => resolve(typeof result === 'string' ? result : null),
      });
    });
  }

  notice(options: Omit<ConfirmationOptions, 'confirmLabel' | 'cancelLabel'>): Promise<void> {
    return new Promise<void>((resolve) => {
      this.enqueue({
        request: {
          ...options,
          id: crypto.randomUUID(),
          kind: 'notice',
          confirmLabel: '知道了',
          cancelLabel: '',
          tone: options.tone ?? 'default',
        },
        resolve: () => resolve(),
      });
    });
  }

  resolve(id: string, result: boolean | string | null): void {
    if (!this.active || this.active.request.id !== id) return;
    const settled = this.active;
    this.active = this.queue.shift() ?? null;
    settled.resolve(result);
    this.emit();
  }

  private enqueue(entry: ConfirmationEntry): void {
    if (this.active) this.queue.push(entry);
    else {
      this.active = entry;
      this.emit();
    }
  }

  private emit(): void {
    this.listeners.forEach(listener => listener());
  }
}

export const confirmationCoordinator = new ConfirmationCoordinator();

export function confirmAction(options: ConfirmationOptions): Promise<boolean> {
  return confirmationCoordinator.request(options);
}

export function promptAction(options: Omit<ConfirmationOptions, 'confirmLabel'> & { defaultValue?: string; placeholder?: string }): Promise<string | null> {
  return confirmationCoordinator.prompt(options);
}

export function chooseAction(options: Omit<ConfirmationOptions, 'confirmLabel'> & { choices: DialogChoice[] }): Promise<string | null> {
  return confirmationCoordinator.choose(options);
}

export function showNotice(options: Omit<ConfirmationOptions, 'confirmLabel' | 'cancelLabel'>): Promise<void> {
  return confirmationCoordinator.notice(options);
}
