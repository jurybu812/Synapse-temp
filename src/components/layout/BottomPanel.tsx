import { Terminal, FileOutput } from 'lucide-react';
import { useState } from 'react';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';

export function BottomPanel() {
  const [activeTab, setActiveTab] = useState<'terminal' | 'output'>('terminal');

  return (
    <div className="bottom-panel glass-panel">
      <div className="bottom-panel-tabs">
        <button
          className={`bottom-tab ${activeTab === 'terminal' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('terminal');
            window.dispatchEvent(new CustomEvent('synapse:focus-terminal'));
          }}
        >
          <Terminal size={14} />
          <span>终端</span>
        </button>
        <button
          className={`bottom-tab ${activeTab === 'output' ? 'active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          <FileOutput size={14} />
          <span>输出</span>
        </button>
      </div>

      <div className="bottom-panel-content">
        <div className={`bottom-panel-view ${activeTab === 'terminal' ? 'active' : ''}`}>
          <TerminalPanel />
        </div>
        <div className={`bottom-panel-view ${activeTab === 'output' ? 'active' : ''}`}>
          <div className="output-placeholder">
            <p style={{ color: 'var(--syn-text-muted)', fontSize: '12px' }}>
              暂无输出
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
