const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const conversationSource = fs.readFileSync(path.join(root, 'src', 'store', 'slices', 'conversation.ts'), 'utf8');
const statusBarSource = fs.readFileSync(path.join(root, 'src', 'components', 'layout', 'StatusBar.tsx'), 'utf8');
const compressionRingSource = fs.readFileSync(path.join(root, 'src', 'components', 'layout', 'CompressionRing.tsx'), 'utf8');
const agentPanelSource = fs.readFileSync(path.join(root, 'src', 'components', 'layout', 'AgentPanel.tsx'), 'utf8');

assert.match(conversationSource, /TokenCountSource = 'none' \| 'stale' \| 'projected' \| 'api'/);
assert.match(
  conversationSource,
  /function invalidateTokenProjection\(bucket: PerConversation, preservePrior = false\)[\s\S]{0,500}preservePrior && bucket\.tokenCountSource !== 'none' && bucket\.tokenCount > 0[\s\S]{0,200}bucket\.tokenCountSource = 'stale'[\s\S]{0,120}bucket\.tokenUsage = null/,
);
assert.match(conversationSource, /message\.role === 'user'\) invalidateTokenProjection\(b, true\)/);
assert.match(conversationSource, /editMessage[\s\S]{0,1800}invalidateTokenProjection\(b, true\)/);
assert.match(conversationSource, /truncateAt[\s\S]{0,900}invalidateTokenProjection\(b, true\)/);
assert.match(conversationSource, /deleteMessage[\s\S]{0,900}invalidateTokenProjection\(b, true\)/);
assert.match(conversationSource, /setModel[\s\S]{0,500}invalidateTokenProjection\(b\)/);
assert.match(statusBarSource, /tokenCountSource === 'none' \? localToken\.count : projectedTokenCount/);
assert.match(statusBarSource, /const cacheHitRate = hasApiUsage \? getCacheHitRate\(tokenUsage\) : null/);
assert.match(conversationSource, /setProjectedTokenCount[\s\S]{0,500}b\.tokenCountSource = 'projected';[\s\S]{0,80}b\.tokenUsage = null/);
assert.match(compressionRingSource, /stale: '新请求正在组装，暂显示上一请求输入'/);
assert.match(compressionRingSource, /input\.tokenCountSource === 'stale'/);
assert.match(
  agentPanelSource,
  /active\.tokenCountSource !== 'none' && active\.tokenCountSource !== 'stale'/,
);
assert.match(
  agentPanelSource,
  /if \(tokenCountSource === 'stale'\)[\s\S]{0,260}refreshProjectedTokenCount\(conversationId, \{ allowApiOverride: true \}\)[\s\S]{0,260}return;/,
);

console.log('Token projection integration assertions passed');
