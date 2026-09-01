const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const agentLoopSource = fs.readFileSync(path.join(root, 'src', 'services', 'agentLoop.ts'), 'utf8');
const agentSettingsSource = fs.readFileSync(path.join(root, 'src', 'store', 'slices', 'agentSettings.ts'), 'utf8');
const settingsPanelSource = fs.readFileSync(path.join(root, 'src', 'components', 'settings', 'SettingsPanel.tsx'), 'utf8');

assert.match(agentSettingsSource, /maxToolRounds: 25,[\s\S]{0,80}autoContinueToolRounds: false/);
assert.match(settingsPanelSource, /checked=\{agentSettings\.autoContinueToolRounds \?\? false\}/);
assert.match(settingsPanelSource, /默认关闭。开启后达到单段轮数仍会延续同一任务，最多自动续两段；完全相同且无进展的动作会提前停止。/);
assert.match(agentLoopSource, /const MAX_AUTO_TOOL_SEGMENTS = 3;/);
assert.match(agentLoopSource, /const REPEATED_TOOL_ROUND_LIMIT = 3;/);
assert.match(
  agentLoopSource,
  /const maxRounds = currentMode === 'fast'[\s\S]{0,180}segmentRounds \* \(autoContinueToolRounds \? MAX_AUTO_TOOL_SEGMENTS : 1\)/,
);
assert.match(
  agentLoopSource,
  /round % segmentRounds === 0[\s\S]{0,650}【自动续跑】这是同一任务的第 \$\{segmentNumber\}\/\$\{MAX_AUTO_TOOL_SEGMENTS\} 段。继承现有任务边界、工具结果和文件状态继续执行/,
);
assert.match(
  agentLoopSource,
  /const toolRoundSignature = toolRoundOutcome\.join\('\\n'\);[\s\S]{0,500}repeatedToolRoundCount >= REPEATED_TOOL_ROUND_LIMIT[\s\S]{0,350}'repeated_tool_round'/,
);

console.log('Auto-continue safety integration assertions passed');
