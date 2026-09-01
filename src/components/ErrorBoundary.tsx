import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        // ★ P1 主题修复：原整页写死深色(#0a0a0f/#e0e0e0/#888)——浅色模式崩溃页仍是深底。
        //   改用主题语义变量（:root 与 [data-theme='light'] 各有定义，即使崩溃时 CSS 变量仍在 DOM 上生效）。
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', gap: 16,
          background: 'var(--syn-bg-base)', color: 'var(--syn-text-primary)', fontFamily: 'var(--syn-font-sans, Inter, sans-serif)',
        }}>
          <span style={{ fontSize: 48 }}>⚠️</span>
          <h2 style={{ margin: 0 }}>应用出现错误</h2>
          <p style={{ color: 'var(--syn-text-muted)', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error?.message || '未知错误'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 24px', borderRadius: 8, border: 'none',
              background: 'var(--syn-primary)', color: 'white', cursor: 'pointer',
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
