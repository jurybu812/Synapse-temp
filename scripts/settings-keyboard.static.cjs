const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const settingsPanelPath = path.join(root, 'src', 'components', 'settings', 'SettingsPanel.tsx');
const layoutCssPath = path.join(root, 'src', 'styles', 'layout.css');

const settingsPanel = fs.readFileSync(settingsPanelPath, 'utf8');
const layoutCss = fs.readFileSync(layoutCssPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertContains(source, needle, label) {
  assert(source.includes(needle), `${label} missing: ${needle}`);
}

function assertOrder(source, checks, label) {
  let cursor = -1;
  for (const check of checks) {
    const index = source.indexOf(check.needle, cursor + 1);
    assert(index !== -1, `${label} missing ${check.label}: ${check.needle}`);
    assert(index > cursor, `${label} order broken at ${check.label}`);
    cursor = index;
  }
}

assertContains(settingsPanel, 'const SETTINGS_PANEL_FOCUSABLE_SELECTOR = [', 'focusable selector');
assertContains(settingsPanel, 'button:not([disabled])', 'focusable selector excludes disabled buttons');
assertContains(settingsPanel, 'input:not([disabled]):not([type="hidden"])', 'focusable selector excludes disabled/hidden inputs');
assertContains(settingsPanel, 'select:not([disabled])', 'focusable selector excludes disabled selects');
assertContains(settingsPanel, 'textarea:not([disabled])', 'focusable selector excludes disabled textareas');
assertContains(settingsPanel, 'element.closest(\'[hidden], [aria-hidden="true"]\')', 'focusable filter excludes hidden ancestors');
assertContains(settingsPanel, 'element.tabIndex < 0', 'focusable filter excludes negative tabindex');

assertContains(settingsPanel, 'const settingsContentRef = useRef<HTMLDivElement>(null);', 'settings panel ref');
assertContains(settingsPanel, 'ref={settingsContentRef}', 'tabpanel ref binding');
assertContains(settingsPanel, 'tabIndex={-1}', 'tabpanel is removed from sequential tab order');
assertContains(settingsPanel, 'role="tabpanel"', 'tabpanel role');
assertContains(settingsPanel, 'aria-labelledby={`settings-tab-${activeTab}`}', 'tabpanel aria-labelledby');
assertContains(settingsPanel, 'role="tablist"', 'tablist role');
assertContains(settingsPanel, 'role="tab"', 'tab role');
assertContains(settingsPanel, 'aria-selected={activeTab === tab.id}', 'tab selected state');
assertContains(settingsPanel, 'aria-controls="settings-active-panel"', 'tab controls panel');

const keyHandlerStart = settingsPanel.indexOf('const handleSettingsTabKeyDown');
const keyHandlerEnd = settingsPanel.indexOf('let nextIndex: number | null = null;', keyHandlerStart);
assert(keyHandlerStart !== -1 && keyHandlerEnd !== -1, 'settings tab key handler not found');
const tabHandlerBlock = settingsPanel.slice(keyHandlerStart, keyHandlerEnd);
assertContains(tabHandlerBlock, "event.key === 'Tab' && !event.shiftKey", 'Tab handoff branch');
assertContains(tabHandlerBlock, 'settingsContentRef.current?.querySelectorAll<HTMLElement>(SETTINGS_PANEL_FOCUSABLE_SELECTOR)', 'Tab handoff query scope');
assertContains(tabHandlerBlock, '.find(isKeyboardReachableSettingElement)', 'Tab handoff visibility/disabled filter');
assertContains(tabHandlerBlock, 'event.preventDefault();', 'Tab handoff prevents browser skip');
assertContains(tabHandlerBlock, 'focusTarget.focus();', 'Tab handoff focuses first field');

const aiStart = settingsPanel.indexOf("{activeTab === 'ai'");
const aiEnd = settingsPanel.indexOf("{activeTab === 'conversation'", aiStart);
assert(aiStart !== -1 && aiEnd !== -1, 'AI settings tab block not found');
const aiBlock = settingsPanel.slice(aiStart, aiEnd);
assertOrder(aiBlock, [
  { label: 'API Key label', needle: '<label>API Key</label>' },
  { label: 'API Key password input', needle: 'type="password" placeholder="sk-..."' },
  { label: 'API endpoint label', needle: '<label>API 端点</label>' },
  { label: 'API endpoint input', needle: 'placeholder="https://api.openai.com/v1"' },
  { label: 'ChatGPT subscription', needle: '<label>ChatGPT / Codex 订阅</label>' },
  { label: 'ChatGPT OAuth button', needle: '连接 ChatGPT' },
  { label: 'Windsurf subscription', needle: '<label>Windsurf / Devin 订阅</label>' },
  { label: 'Windsurf OAuth button', needle: '连接 Windsurf' },
  { label: 'Windsurf local import button', needle: '从本机 Devin/Windsurf 导入' },
  { label: 'manual Windsurf token input', needle: 'aria-label="Windsurf 一次性登录 token"' },
  { label: 'manual Windsurf import button', needle: '安全导入' },
  { label: 'test connection', needle: '<label>测试连接</label>' },
  { label: 'default model label', needle: '<label>默认模型</label>' },
], 'AI settings focus order');

const defaultModelStart = aiBlock.indexOf('<label>默认模型</label>');
const defaultModelEnd = aiBlock.indexOf('{/* ★ M4-5-S1', defaultModelStart);
assert(defaultModelStart !== -1 && defaultModelEnd !== -1, 'default model setting item not found');
assertOrder(aiBlock.slice(defaultModelStart, defaultModelEnd), [
  { label: 'model select', needle: '<select value={selectedModel}' },
  { label: 'fetch models button', needle: 'onClick={fetchModels}' },
], 'default model select/button order');

assertContains(aiBlock, '<input type="checkbox"', 'AI settings contains checkbox controls');
assertContains(aiBlock, 'disabled={selectedCapabilities?.thinking === false}', 'disabled controls remain disabled');
assertContains(aiBlock, 'disabled={!selectedCapabilities?.reasoning}', 'unsupported selects remain disabled');

assertContains(layoutCss, '.settings-panel .settings-tab:focus-visible', 'settings tab focus style');
assertContains(layoutCss, '.settings-panel .settings-btn:focus-visible', 'settings button focus style');
assertContains(layoutCss, '.settings-panel .setting-item input:focus-visible', 'settings input focus style');
assertContains(layoutCss, '.settings-panel .setting-item select:focus-visible', 'settings select focus style');
assertContains(layoutCss, 'outline: 2px solid var(--syn-focus-ring, var(--syn-primary-light, var(--syn-primary)));', 'settings focus outline');
assertContains(layoutCss, '.settings-panel .setting-item input[type="password"]:focus-visible', 'password input visible focus override');
assertContains(layoutCss, 'border-color: var(--syn-border-focused, var(--syn-primary));', 'text control focus border');

console.log('settings keyboard accessibility static assertions passed');
