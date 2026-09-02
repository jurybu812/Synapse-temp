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
assert.match(statusBarSource, /isLiveAssistantRunStatus\(run\.status\)/);
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
assert.match(agentPanelSource, /const isAgentRunActive = isStreaming \|\| isLoopRunning \|\| liveAssistantRunIds\.size > 0/);
assert.match(agentPanelSource, /runtimeMode: \(\) => isAgentRunActiveRef\.current/);
assert.match(agentPanelSource, /if \(isAgentRunActiveRef\.current\) \{[\s\S]{0,240}当前轮仍在运行/);
assert.match(agentPanelSource, /if \(nextModel === model\) \{[\s\S]{0,180}setModelSearch\(''\);[\s\S]{0,80}return;[\s\S]{0,180}dispatch\(setCurrentModel\(nextModel\)\)/);
assert.doesNotMatch(agentPanelSource, /const isStreamingRef = useRef/);
assert.doesNotMatch(agentPanelSource, /agentLoopRef\.current\?\.isRunning\) \{/);
assert.match(agentPanelSource, /const hasRunningOrSettlingAgent = isAgentRunActiveRef\.current[\s\S]{0,360}if \(hasRunningOrSettlingAgent\) \{[\s\S]{0,360}const target: 'queue' \| 'interrupt'/);
assert.match(agentPanelSource, /isRunning: \(targetLoop\?\.isRunning \?\? false\) \|\| targetRunActive/);
assert.match(agentPanelSource, /isRunning: \(latestLoop\?\.isRunning \?\? false\) \|\| latestRunActive/);
assert.match(agentPanelSource, /isRunning: \(beforeRunLoop\?\.isRunning \?\? false\) \|\| beforeRunActive/);
assert.match(agentPanelSource, /if \(isAgentRunActive\) return lastLocalTokenRef\.current/);
assert.match(statusBarSource, /if \(isAgentRunActive\) return lastLocalTokenRef\.current/);
assert.match(agentPanelSource, /tokenUsageMatchesCurrentGeneration\(active\.tokenUsage[\s\S]{0,700}liveRunIds/);
assert.match(agentPanelSource, /isAgentRunActiveRef\.current && preserveActiveUsage && !usageMatchesSelection/);

console.log('Token projection integration assertions passed');
