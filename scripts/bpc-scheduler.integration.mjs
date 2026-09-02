import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const memory = new Map();
globalThis.localStorage = {
  getItem: key => memory.has(key) ? memory.get(key) : null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key),
  clear: () => memory.clear(),
  key: index => [...memory.keys()][index] ?? null,
  get length() { return memory.size; },
};
globalThis.window = globalThis;
globalThis.window.addEventListener = () => undefined;
globalThis.window.removeEventListener = () => undefined;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({
  root,
  appType: 'custom',
  server: { middlewareMode: true },
  logLevel: 'silent',
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  const [
    { BpcScheduler },
    { store },
    { selectBpcUiState },
    { platform },
    { clampToBatch },
    { applyReadyRecordToActiveRequest, readRecordAfterReadyPublication },
    { setProviderCredentialStatus },
    { setAvailableModels, setCurrentModel, setSystemModel },
  ] = await Promise.all([
    vite.ssrLoadModule('/src/services/bpcScheduler.ts'),
    vite.ssrLoadModule('/src/store/index.ts'),
    vite.ssrLoadModule('/src/store/slices/bpc.ts'),
    vite.ssrLoadModule('/src/platform/index.ts'),
    vite.ssrLoadModule('/src/services/recordStore.ts'),
    vite.ssrLoadModule('/src/services/agentLoop.ts'),
    vite.ssrLoadModule('/src/store/slices/settings.ts'),
    vite.ssrLoadModule('/src/store/slices/agentSettings.ts'),
  ]);
  const identityA = {
    providerId: 'openai-codex',
    modelId: 'gpt-5.5',
    catalogGeneration: 'catalog-test-A',
    accountFingerprint: 'test-account-A',
    credentialGeneration: 1,
  };
  const identityB = {
    ...identityA,
    catalogGeneration: 'catalog-test-B',
    accountFingerprint: 'test-account-B',
    credentialGeneration: 2,
  };
  const runtimeFor = identity => ({
    selectionId: 'openai-codex:gpt-5.5',
    providerId: identity.providerId,
    modelId: identity.modelId,
    baseUrl: 'https://chatgpt.com/backend-api',
    catalogGeneration: identity.catalogGeneration,
    accountFingerprint: identity.accountFingerprint,
    credentialGeneration: identity.credentialGeneration,
    temperature: 0.2,
    maxTokens: 2048,
    maxTokenParameter: 'max_output_tokens',
    stream: false,
    streamOptions: false,
  });
  let activeRuntime = runtimeFor(identityA);
  const configureIdentity = identity => {
    activeRuntime = runtimeFor(identity);
    store.dispatch(setProviderCredentialStatus({
      providerId: identity.providerId,
      configured: true,
      persisted: true,
      storage: 'safeStorage',
      credentialType: 'oauth',
      updatedAt: Date.now(),
      accountFingerprint: identity.accountFingerprint,
      credentialGeneration: identity.credentialGeneration,
    }));
    store.dispatch(setAvailableModels([{
      id: 'openai-codex:gpt-5.5',
      providerId: identity.providerId,
      requestModelId: identity.modelId,
      name: 'GPT 5.5 test',
      capabilities: {
        vision: false,
        tools: false,
        thinking: false,
        reasoning: false,
        streaming: false,
        reasoningEffortOptions: [],
        speedTierOptions: [],
        supportedParameters: ['max_output_tokens'],
        source: 'api',
        authority: {
          vision: 'api',
          tools: 'api',
          thinking: 'api',
          streaming: 'api',
          contextWindow: 'api',
          maxOutputTokens: 'api',
          reasoningEffortOptions: 'api',
          speedTierOptions: 'api',
        },
      },
      supportedParameters: ['max_output_tokens'],
      catalog: {
        providerId: identity.providerId,
        generation: identity.catalogGeneration,
        fetchedAt: Date.now(),
        source: 'network',
        stale: false,
        endpointSha256: 'test-endpoint',
        accountFingerprint: identity.accountFingerprint,
        credentialGeneration: identity.credentialGeneration,
      },
    }]));
    store.dispatch(setCurrentModel('openai-codex:gpt-5.5'));
    store.dispatch(setSystemModel('openai-codex:gpt-5.5'));
  };
  configureIdentity(identityA);

  const stepByConversation = new Map([
    ['A', 6],
    ['B', 6],
    ['C', 6],
    ['E', 6],
    ['F', 6],
  ]);
  const createLoop = (name, prepareDelay = 0, initiallyRunning = false) => ({
    isRunning: initiallyRunning,
    computeBpcSnapshotInput(conversationId) {
      const step = stepByConversation.get(conversationId) ?? 6;
      return {
        compressedSegment: [
          { role: 'user', content: `${conversationId} inspect a realistic workspace failure` },
          { role: 'assistant', content: `${conversationId} traced the failure through files and tools` },
        ],
        snapshotStepCursor: step,
        snapshotRoundCursor: 2,
      };
    },
    async bpcGenerate(conversationId, _segment, signal, opts) {
      assert.equal(opts.generationRuntime?.providerId, 'openai-codex');
      assert.equal(opts.generationRuntime?.modelId, 'gpt-5.5');
      assert.equal(opts.generationRuntime?.catalogGeneration, 'catalog-test-A');
      assert.equal(opts.generationRuntime?.accountFingerprint, 'test-account-A');
      assert.equal(opts.generationRuntime?.credentialGeneration, 1);
      if (prepareDelay) await delay(prepareDelay);
      if (signal?.aborted && prepareDelay === 0) {
        return { recordMd: null, candidate: null, totalSteps: 0, totalRounds: 0, outcome: 'failed' };
      }
      const record = {
        conversationId,
        batches: [{
          index: 0,
          roundStart: 1,
          roundEnd: 2,
          stepStart: 0,
          stepEnd: 2,
          contentMd: `# ${conversationId}\nprepared by ${name}`,
          skeleton: conversationId,
          phases: 1,
          timeSpan: 'test',
          createdAt: Math.floor(Date.now() / 1000),
          source: 'bpc',
        }],
        contentMd: `# ${conversationId}\nprepared by ${name}`,
        totalRounds: 2,
        totalSteps: 2,
        phases: 1,
        lastUpdatedRound: 2,
        timeSpan: 'test',
        schemaVersion: 2,
        revision: 0,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      const response = await platform.conversation.prepareRecordCandidate({
        conversationId,
        candidateId: opts.candidateId,
        parentRevision: 0,
        sourceStepCursor: opts.sourceStepCursor,
        sourceRoundCursor: opts.sourceRoundCursor,
        inputHash: opts.inputHash,
        providerId: opts.generationRuntime.providerId,
        modelId: opts.generationRuntime.modelId,
        catalogGeneration: opts.generationRuntime.catalogGeneration,
        accountFingerprint: opts.generationRuntime.accountFingerprint,
        credentialGeneration: opts.generationRuntime.credentialGeneration,
        candidate: record,
      });
      if (!response?.prepared || signal?.aborted) {
        return { recordMd: null, candidate: null, totalSteps: 0, totalRounds: 0, outcome: 'failed' };
      }
      return {
        recordMd: record.contentMd,
        candidate: {
          conversationId,
          candidateId: opts.candidateId,
          parentRevision: 0,
          inputHash: opts.inputHash,
          sourceStepCursor: opts.sourceStepCursor,
          sourceRoundCursor: opts.sourceRoundCursor,
          providerId: opts.generationRuntime.providerId,
          modelId: opts.generationRuntime.modelId,
          catalogGeneration: opts.generationRuntime.catalogGeneration,
          accountFingerprint: opts.generationRuntime.accountFingerprint,
          credentialGeneration: opts.generationRuntime.credentialGeneration,
          record,
        },
        totalSteps: 2,
        totalRounds: 2,
        outcome: 'prepared',
      };
    },
    async finalizePublishedBpc(_conversationId, record) {
      return { recordMd: record.contentMd, revision: record.revision };
    },
    getBpcPublishMessages(conversationId) {
      return [
        { id: `${conversationId}-u`, role: 'user', content: 'Inspect the project files and explain the failure.', timestamp: 1 },
        { id: `${conversationId}-a`, role: 'assistant', content: 'The failure is isolated and verified.', timestamp: 2 },
      ];
    },
  });

  const ui = conversationId => selectBpcUiState(store.getState(), conversationId);
  const createScheduler = () => new BpcScheduler(() => activeRuntime);
  const scheduler = createScheduler();
  const loopA = createLoop('loop-A', 0, true);
  const loopB = createLoop('loop-B', 0, true);
  scheduler.evaluateWater({ conversationId: 'A', triggerTokens: 80, modelContextWindow: 100, currentStepCursor: 6 }, loopA);
  scheduler.evaluateWater({ conversationId: 'B', triggerTokens: 80, modelContextWindow: 100, currentStepCursor: 6 }, loopB);
  await waitFor(() => ui('A').state === 'ready' && ui('B').state === 'ready', 'independent A/B candidates');
  assert.equal(ui('A').state, 'ready');
  assert.equal(ui('B').state, 'ready');

  scheduler.abort('A');
  assert.equal(ui('A').state, 'cooldown');
  assert.equal(ui('B').state, 'ready', 'aborting A must not change B');
  loopB.isRunning = false;
  const publishedB = await scheduler.publishReadyIfIdle('B');
  assert.equal(publishedB, true);
  const publishedRecordB = await platform.conversation.getRecord('B');
  assert.match(publishedRecordB.contentMd, /prepared by loop-B/);
  assert.equal(ui('B').state, 'idle');
  assert.equal(ui('A').state, 'cooldown');

  const projectionScheduler = createScheduler();
  const projectionLoop = createLoop('loop-E', 0, true);
  projectionScheduler.evaluateWater(
    { conversationId: 'E', triggerTokens: 80, modelContextWindow: 100, currentStepCursor: 6 },
    projectionLoop,
  );
  await waitFor(() => ui('E').state === 'ready', 'E candidate ready before projection');
  const requestHistoryE = [
    { role: 'user', content: 'Inspect the workspace.' },
    { role: 'assistant', content: 'I will inspect it.' },
    { role: 'user', content: 'Trace the failure.' },
    { role: 'assistant', content: 'The failure is isolated.' },
    { role: 'user', content: 'Verify the fix.' },
    { role: 'assistant', content: 'The fix is verified.' },
  ];
  const projectedRecordE = await readRecordAfterReadyPublication(
    projectionScheduler,
    'E',
    requestHistoryE,
    id => platform.conversation.getRecord(id),
  );
  assert.match(projectedRecordE.contentMd, /prepared by loop-E/);
  assert.equal(ui('E').state, 'idle', 'ready candidate must publish before current request projection');

  const activeRequestAfterReady = applyReadyRecordToActiveRequest([
    { role: 'system', content: 'stable system prompt' },
    { role: 'user', content: 'old round' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'kept round' },
    { role: 'assistant', content: 'call tool', tool_calls: [{ id: 'call-1' }] },
    { role: 'tool', content: 'tool result', tool_call_id: 'call-1' },
    { role: 'assistant', content: 'continue' },
    { role: 'user', content: 'current round' },
  ], 'published record');
  assert.deepEqual(
    activeRequestAfterReady.map(message => [message.role, message.content]),
    [
      ['system', 'stable system prompt'],
      ['system', '[对话历史摘要]\n\npublished record'],
      ['user', 'kept round'],
      ['assistant', 'call tool'],
      ['tool', 'tool result'],
      ['assistant', 'continue'],
      ['user', 'current round'],
    ],
    'ready BPC must replace the old prefix while preserving the two newest raw rounds and tool results',
  );

  const lateScheduler = createScheduler();
  const lateLoop = createLoop('loop-F', 0, true);
  lateScheduler.evaluateWater(
    { conversationId: 'F', triggerTokens: 80, modelContextWindow: 100, currentStepCursor: 6 },
    lateLoop,
  );
  await waitFor(() => ui('F').state === 'ready', 'F candidate ready before late publish');
  stepByConversation.set('F', 1_000);
  lateLoop.isRunning = false;
  assert.equal(
    await lateScheduler.publishReadyIfIdle('F'),
    true,
    'an append-only raw tail must not invalidate a prepared prefix candidate',
  );
  assert.match((await platform.conversation.getRecord('F')).contentMd, /prepared by loop-F/);
  assert.equal(ui('F').state, 'idle');

  configureIdentity(identityA);
  const identityScheduler = createScheduler();
  const identityLoop = createLoop('loop-identity', 0, true);
  identityScheduler.evaluateWater(
    { conversationId: 'identity-ready-switch', triggerTokens: 80, modelContextWindow: 100, currentStepCursor: 6 },
    identityLoop,
  );
  await waitFor(() => ui('identity-ready-switch').state === 'ready', 'identity candidate ready before account switch');
  const identitySnapshot = identityScheduler.__debugSnapshotMeta('identity-ready-switch');
  assert.equal(identitySnapshot.providerId, 'openai-codex');
  assert.equal(identitySnapshot.modelId, 'gpt-5.5');
  assert.equal(identitySnapshot.catalogGeneration, 'catalog-test-A');
  assert.equal(identitySnapshot.credentialGeneration, 1);
  assert.equal(identitySnapshot.accountFingerprintCaptured, true);
  configureIdentity(identityB);
  identityLoop.isRunning = false;
  assert.equal(
    await identityScheduler.publishReadyIfIdle('identity-ready-switch'),
    false,
    'ready candidate must not publish after provider account/catalog identity changes',
  );
  assert.equal(await platform.conversation.getRecord('identity-ready-switch'), null);
  assert.equal(ui('identity-ready-switch').state, 'idle');
  configureIdentity(identityA);

  const secondBatch = {
    ...publishedRecordB.batches[0],
    index: 1,
    roundStart: 3,
    roundEnd: 4,
    stepStart: 2,
    stepEnd: 4,
    contentMd: '# B\nsecond published batch',
    skeleton: 'second published batch',
  };
  await platform.conversation.saveRecord({
    conversationId: 'B',
    batches: [...publishedRecordB.batches, secondBatch],
    schemaVersion: 2,
    contentMd: `${publishedRecordB.contentMd}\n\n---\n\n${secondBatch.contentMd}`,
    totalRounds: 4,
    totalSteps: 4,
    phases: 1,
    lastUpdatedRound: 4,
    timeSpan: 'test',
  });
  const clampedB = await clampToBatch('B', 2, 2);
  assert.equal(clampedB.totalRounds, 2);
  assert.equal(clampedB.totalSteps, 2);
  await scheduler.reconcileAfterHistoryMutation('B', clampedB);
  const reconciledB = await platform.conversation.getRecordCandidate('B');
  assert.equal(reconciledB.publishedRevision, clampedB.revision);
  assert.equal(reconciledB.parentRevision, clampedB.revision);
  assert.equal(reconciledB.sourceRoundCursor, clampedB.totalRounds);
  assert.equal(reconciledB.sourceStepCursor, clampedB.totalSteps);
  assert.equal(reconciledB.lastReplaceStepCursor, null);
  assert.equal(reconciledB.immediateRetriggerCount, 0);
  assert.equal(reconciledB.inputHash, null);

  const staleDiscardState = {
    conversationId: 'stale-discard',
    state: 'prepared',
    candidateId: 'new-candidate',
    parentRevision: 0,
    publishedRevision: 0,
    inputHash: 'new-hash',
    candidate: { conversationId: 'stale-discard', batches: [] },
    updatedAt: Math.floor(Date.now() / 1000),
  };
  localStorage.setItem('synapse:record-candidate:stale-discard', JSON.stringify(staleDiscardState));
  const staleDiscarded = await platform.conversation.discardRecordCandidate({
    conversationId: 'stale-discard',
    candidateId: 'old-candidate',
    reason: 'late stale discard',
  });
  assert.equal(staleDiscarded, false);
  assert.equal((await platform.conversation.getRecordCandidate('stale-discard')).candidateId, 'new-candidate');

  await scheduler.pauseForHardFailure('A', 'hard compaction still exceeded the safe request budget');
  assert.equal(await scheduler.ensureConversationReady('A'), false);
  assert.equal(await scheduler.ensureConversationReady('B'), true);
  const reloaded = createScheduler();
  assert.equal(await reloaded.ensureConversationReady('A'), false, 'hard pause must survive scheduler reconstruction');
  assert.equal(await reloaded.ensureConversationReady('B'), true);
  await reloaded.restart('A');
  assert.equal(await reloaded.ensureConversationReady('A'), true);
  assert.equal(await reloaded.ensureConversationReady('B'), true);

  const expiredBackoffConversationId = 'expired-backoff';
  localStorage.setItem(`synapse:record-candidate:${expiredBackoffConversationId}`, JSON.stringify({
    conversationId: expiredBackoffConversationId,
    state: 'discarded',
    schedulerState: 'snapshotting',
    candidateId: null,
    parentRevision: 0,
    publishedRevision: 0,
    sourceStepCursor: 6,
    sourceRoundCursor: 2,
    inputHash: null,
    candidate: null,
    retryCount: 4,
    backoffUntil: Date.now() - 5_000,
    hardPaused: false,
    cooldownUntil: null,
    circuitBroken: false,
    lastReplaceStepCursor: null,
    immediateRetriggerCount: 0,
    lastError: 'transient provider failure',
    updatedAt: Math.floor(Date.now() / 1000),
  }));
  const retryReloaded = createScheduler();
  assert.equal(await retryReloaded.ensureConversationReady(expiredBackoffConversationId), true);
  await delay(25);
  const normalizedRetryState = await platform.conversation.getRecordCandidate(expiredBackoffConversationId);
  assert.equal(normalizedRetryState.schedulerState, 'idle');
  assert.equal(normalizedRetryState.retryCount, 0);
  assert.equal(normalizedRetryState.backoffUntil, null);

  const cancellationScheduler = createScheduler();
  cancellationScheduler.evaluateWater(
    { conversationId: 'C', triggerTokens: 80, modelContextWindow: 100, currentStepCursor: 6 },
    createLoop('loop-C', 50),
  );
  await waitFor(() => ui('C').state === 'generating', 'C generation start');
  await cancellationScheduler.discardCurrent('C', 'cancel immediately after snapshot');
  await delay(100);
  const cancelledState = await platform.conversation.getRecordCandidate('C');
  assert.equal(cancelledState.state, 'discarded');
  assert.ok(cancelledState.candidateId, 'discard tombstone must retain the preallocated candidate id');
  assert.equal(ui('C').state, 'idle');

  const promotionScheduler = createScheduler();
  await promotionScheduler.pauseForHardFailure('autosave-current', 'draft hard pause');
  await promotionScheduler.promoteConversation('autosave-current', 'D');
  assert.equal(await platform.conversation.promoteRecord('autosave-current', 'D'), true);
  await delay(25);
  assert.equal(await platform.conversation.getRecordCandidate('autosave-current'), null, 'old draft id must not be recreated by a late state write');
  const promotedState = await platform.conversation.getRecordCandidate('D');
  assert.equal(promotedState.hardPaused, true);
  assert.equal(promotedState.schedulerState, 'hard-paused');

  console.log('BPC scheduler integration: all assertions passed');
} finally {
  await vite.close();
}
