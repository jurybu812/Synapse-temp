const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'src', 'components', 'chat', 'TaskBoundaryCard.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const agentPanelSource = fs.readFileSync(
  path.join(repoRoot, 'src', 'components', 'layout', 'AgentPanel.tsx'),
  'utf8',
);
const chatStyles = fs.readFileSync(path.join(repoRoot, 'src', 'styles', 'chat.css'), 'utf8');

const checks = [
  {
    name: 'disclosure storage key is scoped by conversation and boundary',
    pass: /function disclosureStorageKey\(conversationId: string, boundaryId: string, section: DisclosureSection\): string \{[\s\S]*synapse:task-boundary:v2:\$\{storageKeyPart\(conversationId\)\}:\$\{storageKeyPart\(boundaryId\)\}:\$\{section\}:open/.test(source),
  },
  {
    name: 'legacy boundary-only storage key is not used',
    pass: !source.includes('synapse:task-boundary:${boundaryId}:${section}:open'),
  },
  {
    name: 'card receives its owning conversation id instead of reading the active conversation',
    pass: /interface TaskBoundaryCardProps \{\s*conversationId: string;/.test(source)
      && /disclosureStorageKey\(conversationId, boundary\.id, 'body'\)/.test(source)
      && !/selectActiveConversation|useAppSelector/.test(source)
      && /<TaskBoundaryCard[\s\S]{0,180}conversationId=\{conversation\.id\}/.test(agentPanelSource),
  },
  {
    name: 'navigation reveal opens the body for the session without overwriting persisted disclosure',
    pass: /consumedRevealNonceRef\.current = revealNonce;\s*setBodyOpenForSession\(true\);/.test(source)
      && !/consumedRevealNonceRef\.current = revealNonce;\s*setBodyOpen\(true\);/.test(source),
  },
  {
    name: 'storage key changes rehydrate disclosure state without reacting to same-key fallback changes',
    pass: /if \(currentStorageKeyRef\.current === storageKey\) return;[\s\S]*setOpenState\(readDisclosureState\(storageKey, fallback\)\);/.test(source),
  },
  {
    name: 'completion auto-collapse only runs while the user is following the tail',
    pass: /if \(prevActiveRef\.current && !isActive && followTail\) \{[\s\S]*setBodyOpenForSession\(false\);[\s\S]*setStepsOpenForSession\(false\);/.test(source),
  },
  {
    name: 'completion auto-collapse does not persist over manual disclosure state',
    pass: /return \[open, setOpen, setOpenForSession\] as const;/.test(source)
      && !/prevActiveRef\.current && !isActive[\s\S]{0,160}setBodyOpen\(false\)/.test(source),
  },
  {
    name: 'disclosure toggles capture the outer message scroll anchor before layout changes',
    pass: /function captureOuterScrollAnchor\(container: HTMLElement\): OuterScrollAnchor \| undefined \{[\s\S]{0,1200}OUTER_SCROLL_ANCHOR_SELECTOR/.test(source)
      && /outerScrollContainerFor\(cardRef\.current\)/.test(source)
      && /const anchor = scrollContainer && !wasNearTailBeforeToggle[\s\S]{0,120}captureOuterScrollAnchor\(scrollContainer\)/.test(source),
  },
  {
    name: 'disclosure anchor prefers visible message or step over a giant outer unit',
    pass: /specificCandidates\.length > 0 \? specificCandidates : candidates/.test(source),
  },
  {
    name: 'body and progress toggles restore the captured outer anchor after two frames',
    pass: /window\.requestAnimationFrame\(\(\) => \{[\s\S]{0,120}window\.requestAnimationFrame\(\(\) => \{[\s\S]{0,260}restoreOuterScrollAnchor\(currentContainer, anchor\)/.test(source)
      && /const handleStepsToggle = useCallback\(\(\) => \{[\s\S]{0,140}setStepsOpen\(open => !open\)/.test(source)
      && /const handleBodyToggle = useCallback\(\(\) => \{[\s\S]{0,140}setBodyOpen\(open => !open\)/.test(source)
      && /onClick=\{handleStepsToggle\}/.test(source)
      && /onClick=\{handleBodyToggle\}/.test(source),
  },
  {
    name: 'checkpoint reveal can open a specific progress step',
    pass: /revealStepId\?: string/.test(source)
      && /const targetIndex = boundary\.steps\.findIndex\(step => step\.id === revealStepId\);/.test(source)
      && /setStepsOpenForSession\(true\);/.test(source)
      && /messageWindowRangeForIndex\(boundary\.steps\.length, targetIndex, MAX_STEP_RENDER_ITEMS, 8\)/.test(source)
      && /revealStepId=\{boundaryRevealRequest && boundaryRevealRequest\.boundaryId === r\.b\.id/.test(agentPanelSource),
  },
  {
    name: 'scroll checkpoint captures and restores task step anchors',
    pass: /\[data-message-id\], \[data-task-step-id\], \[data-task-boundary-id\]/.test(agentPanelSource)
      && /kind: anchorElement\.dataset\.messageId \? 'message' : anchorElement\.dataset\.taskStepId \? 'step' : 'boundary'/.test(agentPanelSource)
      && /restored\.anchor\?\.kind === 'step'[\s\S]{0,220}findBoundaryIdForStep/.test(agentPanelSource)
      && /candidate\.dataset\.taskStepId === restored\.anchor\?\.id/.test(agentPanelSource),
  },
  {
    name: 'terminal failure keeps expanded projections near the failure tail',
    pass: /boundary\.status !== 'aborted' && boundary\.status !== 'interrupted'/.test(source)
      && /setVisibleBodyRange\(tailMessageWindowRange\(bodyItemCount, INITIAL_BODY_RENDER_ITEMS, MAX_BODY_RENDER_ITEMS\)\);/.test(source)
      && /setVisibleStepRange\(tailMessageWindowRange\(boundary\.steps\.length, INITIAL_STEP_RENDER_ITEMS, MAX_STEP_RENDER_ITEMS\)\);/.test(source),
  },
  {
    name: 'disclosure toggles only stick to tail when the pre-toggle viewport was near tail',
    pass: /const wasNearTailBeforeToggle = scrollContainer[\s\S]{0,140}isOuterScrollNearTail\(scrollContainer\)/.test(source)
      && /if \(wasNearTailBeforeToggle\) \{[\s\S]{0,120}currentContainer\.scrollTop = currentContainer\.scrollHeight;[\s\S]{0,80}return;/.test(source),
  },
  {
    name: 'long expanded boundaries keep a sticky semantic header without becoming their own scroll container',
    pass: /\.task-boundary-card\s*\{[\s\S]{0,220}overflow:\s*clip;/.test(chatStyles)
      && /\.tb-card-header\s*\{[\s\S]{0,320}position:\s*sticky;[\s\S]{0,120}top:\s*0;/.test(chatStyles),
  },
  {
    name: 'history dialog exposes modal semantics, close control, initial focus, and trigger focus return',
    pass: /role="dialog" aria-modal="true" aria-label="标题变迁历史"/.test(source)
      && /const closeButtonRef = useRef<HTMLButtonElement>\(null\);/.test(source)
      && /closeButtonRef\.current\?\.focus\(\);/.test(source)
      && /aria-label="关闭标题变迁历史"/.test(source)
      && /const historyTriggerRef = useRef<HTMLButtonElement>\(null\);/.test(source)
      && /historyTriggerRef\.current\?\.focus\(\)/.test(source)
      && /onClose=\{closeHistoryOverlay\}/.test(source),
  },
];

const failed = checks.filter(check => !check.pass);
if (failed.length > 0) {
  console.error('task-boundary disclosure checks failed:');
  for (const check of failed) console.error(`- ${check.name}`);
  process.exit(1);
}

console.log(`${checks.length} task-boundary disclosure assertions passed`);
