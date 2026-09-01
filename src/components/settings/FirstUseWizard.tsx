/**
 * FirstUseWizard Component
 * 4-step onboarding wizard for new users
 */
import { useState, useCallback } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { setApiEndpoint } from '@/store/slices/settings';
import { setAccentColor } from '@/store/slices/theme';
import { addNotification } from '@/store/slices/notifications';
import { saveProviderApiKey } from '@/services/providerCredentials';

const THEME_PRESETS = [
  { name: '紫罗兰', color: '#7c3aed' },
  { name: '天蓝', color: '#3b82f6' },
  { name: '翡翠', color: '#10b981' },
  { name: '玫瑰', color: '#f43f5e' },
  { name: '琥珀', color: '#f59e0b' },
  { name: '靛蓝', color: '#6366f1' },
];

interface FirstUseWizardProps {
  onComplete: () => void;
}

export function FirstUseWizard({ onComplete }: FirstUseWizardProps) {
  const dispatch = useAppDispatch();
  const [step, setStep] = useState(0);
  const [apiKey, setKey] = useState('');
  const [apiEndpoint, setEndpoint] = useState('https://openrouter.ai/api/v1');
  const [selectedTheme, setSelectedTheme] = useState('#7c3aed');

  const steps = [
    { title: '欢迎使用 Synapse', icon: '🧠' },
    { title: '配置 AI 模型', icon: '🔑' },
    { title: '选择主题色', icon: '🎨' },
    { title: '准备就绪', icon: '🚀' },
  ];

  const handleNext = useCallback(async () => {
    if (step === 1 && apiKey) {
      try {
        await saveProviderApiKey(dispatch, 'openai', apiKey, apiEndpoint);
        dispatch(setApiEndpoint({ provider: 'openai', url: apiEndpoint }));
        setKey('');
      } catch (error) {
        dispatch(addNotification({ type: 'error', title: '凭据保存失败', message: error instanceof Error ? error.message : '无法写入系统安全存储' }));
        return;
      }
    }
    if (step === 2) {
      dispatch(setAccentColor(selectedTheme));
    }
    if (step === 3) {
      localStorage.setItem('synapse_onboarded', 'true');
      dispatch(addNotification({ type: 'success', title: '设置完成', message: 'Synapse 已准备好处理你的任务' }));
      onComplete();
      return;
    }
    setStep(s => s + 1);
  }, [step, apiKey, apiEndpoint, selectedTheme, dispatch, onComplete]);

  return (
    <div className="wizard-overlay">
      <div className="wizard-container glass-panel">
        {/* Progress */}
        <div className="wizard-progress">
          {steps.map((_s, i) => (
            <div key={i} className={`wizard-dot ${i <= step ? 'active' : ''} ${i === step ? 'current' : ''}`} />
          ))}
        </div>

        {/* Step Content */}
        <div className="wizard-content">
          <div className="wizard-icon">{steps[step].icon}</div>
          <h2 className="wizard-title">{steps[step].title}</h2>

          {step === 0 && (
            <div className="wizard-body">
              <p>Synapse 是可扩展的桌面编程智能体</p>
              <ul style={{ textAlign: 'left', fontSize: 13, color: 'var(--syn-text-secondary)', lineHeight: 2 }}>
                <li>📁 读取真实工作区与多种文档</li>
                <li>🛠 调用工具修改文件并运行验证</li>
                <li>🧠 保留长任务上下文与历史证据</li>
                <li>🔌 连接多种模型与可扩展工具</li>
              </ul>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-body">
              <p style={{ fontSize: 12, color: 'var(--syn-text-muted)' }}>配置 AI API 以启用对话功能</p>
              <div className="wizard-form-group">
                <label htmlFor="wizard-endpoint">API 端点</label>
                <input
                  id="wizard-endpoint"
                  type="url"
                  value={apiEndpoint}
                  onChange={e => setEndpoint(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="wizard-input"
                />
              </div>
              <div className="wizard-form-group">
                <label htmlFor="wizard-apikey">API Key</label>
                <input
                  id="wizard-apikey"
                  type="password"
                  value={apiKey}
                  onChange={e => setKey(e.target.value)}
                  placeholder="sk-..."
                  className="wizard-input"
                />
              </div>
              <p style={{ fontSize: 11, color: 'var(--syn-text-muted)' }}>
                支持 OpenAI / DeepSeek / OpenRouter / Ollama 等兼容端点
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="wizard-body">
              <p style={{ fontSize: 12, color: 'var(--syn-text-muted)' }}>选择你喜欢的强调色</p>
              <div className="wizard-theme-grid">
                {THEME_PRESETS.map(t => (
                  <button
                    key={t.color}
                    className={`wizard-theme-btn ${selectedTheme === t.color ? 'selected' : ''}`}
                    onClick={() => setSelectedTheme(t.color)}
                    style={{ '--theme-color': t.color } as any}
                  >
                    <div className="wizard-theme-swatch" style={{ background: t.color }} />
                    <span>{t.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="wizard-body">
              <p>一切准备就绪！</p>
              <div style={{ fontSize: 13, color: 'var(--syn-text-secondary)', textAlign: 'left', lineHeight: 2 }}>
                <p>✅ AI 端点已配置{apiKey ? '' : '（可稍后配置）'}</p>
                <p>✅ 主题色已设置</p>
                <p>💡 打开一个工作区，或直接向 AI 描述任务</p>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="wizard-actions">
          {step > 0 && (
            <button className="wizard-btn secondary" onClick={() => setStep(s => s - 1)}>上一步</button>
          )}
          <button className="wizard-btn primary" onClick={handleNext}>
            {step === 3 ? '开始使用' : step === 1 && !apiKey ? '跳过' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
