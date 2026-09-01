const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain } = require('electron');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-bpc-'));
app.setPath('home', tempHome);

const handlers = new Map();
let databaseModule;
ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler);
};

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

function batch(conversationId, stepEnd, index = 0) {
  return {
    index,
    roundStart: 1,
    roundEnd: 1,
    stepStart: 0,
    stepEnd,
    contentMd: `# ${conversationId}\nvalidated candidate`,
    skeleton: conversationId,
    phases: 1,
    timeSpan: 'test',
    createdAt: Math.floor(Date.now() / 1000),
    source: 'bpc',
  };
}

function candidate(conversationId, stepEnd, revision = 0) {
  const batches = [batch(conversationId, stepEnd)];
  return {
    conversationId,
    batches,
    contentMd: batches[0].contentMd,
    totalRounds: 1,
    totalSteps: stepEnd,
    phases: 1,
    lastUpdatedRound: 1,
    timeSpan: 'test',
    updatedAt: Math.floor(Date.now() / 1000),
    schemaVersion: 2,
    revision,
  };
}

function messages(conversationId) {
  const now = Date.now();
  return [
    { id: `${conversationId}-u1`, role: 'user', content: 'Inspect the workspace and explain the failure.', timestamp: now },
    { id: `${conversationId}-a1`, role: 'assistant', content: 'I inspected the files and found the failed boundary.', timestamp: now + 1 },
  ];
}

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

let activeIdentity = identityA;

function identityPayload(identity = activeIdentity) {
  return {
    providerId: identity.providerId,
    modelId: identity.modelId,
    catalogGeneration: identity.catalogGeneration,
    accountFingerprint: identity.accountFingerprint,
    credentialGeneration: identity.credentialGeneration,
  };
}

function setCredentialIdentity(identity) {
  activeIdentity = identity;
  databaseModule.getDatabase().prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(
    `providerCredentialIdentity:${identity.providerId}`,
    JSON.stringify({
      version: 1,
      accountFingerprint: identity.accountFingerprint,
      credentialGeneration: identity.credentialGeneration,
      updatedAt: Date.now(),
    }),
  );
}

async function createConversation(id, overrides = {}) {
  await invoke('conversation:create', { id, title: id, ...overrides });
}

async function prepare(conversationId, candidateId, parentRevision, stepEnd, inputHash = `${candidateId}-hash`) {
  return invoke('record:candidate:prepare', {
    conversationId,
    candidateId,
    parentRevision,
    sourceStepCursor: stepEnd + 4,
    sourceRoundCursor: 3,
    inputHash,
    ...identityPayload(),
    candidate: candidate(conversationId, stepEnd, parentRevision),
  });
}

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  const { registerConversationHandlers } = require('../dist-electron/electron/ipc/conversation.js');
  databaseModule.initDatabase();
  registerConversationHandlers();
  setCredentialIdentity(identityA);

  await createConversation('A');
  await createConversation('B');
  await createConversation('C');
  await createConversation('guarded-insert');
  await createConversation('identity-snapshot-stale');
  await createConversation('identity-ready-restart');
  await createConversation('legacy-null-identity');
  await createConversation('autosave-current');
  await createConversation('promoted');
  await createConversation('thresholds', { bpcThresholdOverride: 0.61, compactThresholdOverride: 0.88 });

  const missingGenerationState = await invoke('record:generation:update', {
    conversationId: 'missing-parent',
    schedulerState: 'idle',
  });
  assert.equal(missingGenerationState, null, 'generation state must not create a child row before its conversation parent exists');
  const missingRecord = await invoke('record:upsert', candidate('missing-parent', 2, 0));
  assert.equal(missingRecord.written, false);
  assert.equal(missingRecord.reason, 'conversation-not-persisted');
  const missingCandidate = await invoke('record:candidate:prepare', {
    conversationId: 'missing-parent',
    candidateId: 'missing-c1',
    parentRevision: 0,
    sourceStepCursor: 6,
    sourceRoundCursor: 3,
    inputHash: 'missing-hash',
    ...identityPayload(),
    candidate: candidate('missing-parent', 2, 0),
  });
  assert.equal(missingCandidate.prepared, false);
  assert.equal(missingCandidate.reason, 'conversation-not-persisted');
  assert.equal(await invoke('record:candidate:get', 'missing-parent'), null);

  await invoke('record:generation:update', {
    conversationId: 'guarded-insert',
    credentialGeneration: null,
  });
  assert.equal(
    databaseModule.getDatabase().prepare('SELECT credential_generation FROM context_generation_state WHERE conversation_id = ?')
      .get('guarded-insert').credential_generation,
    null,
    'an absent credential generation must remain SQL NULL instead of becoming generation zero',
  );

  await invoke('record:generation:update', {
    conversationId: 'A',
    schedulerState: 'hard-paused',
    hardPaused: true,
    cooldownUntil: 123456,
    circuitBroken: true,
    lastReplaceStepCursor: 42,
    immediateRetriggerCount: 2,
    lastError: 'protected pause',
  });
  const preparedA = await prepare('A', 'A-c1', 0, 2);
  assert.equal(preparedA.prepared, true);
  assert.equal(await invoke('record:get', 'A'), null, 'prepare must not mutate the published Record');
  const stateAfterPrepare = await invoke('record:candidate:get', 'A');
  assert.equal(stateAfterPrepare.hardPaused, true, 'candidate prepare must not clear hard pause');
  assert.equal(stateAfterPrepare.cooldownUntil, 123456);
  assert.equal(stateAfterPrepare.circuitBroken, true);
  assert.equal(stateAfterPrepare.providerId, identityA.providerId);
  assert.equal(stateAfterPrepare.modelId, identityA.modelId);
  assert.equal(stateAfterPrepare.catalogGeneration, identityA.catalogGeneration);
  assert.equal(stateAfterPrepare.credentialGeneration, identityA.credentialGeneration);

  await assert.rejects(
    async () => invoke('record:candidate:publish', {
      conversationId: 'A',
      candidateId: 'A-c1',
      parentRevision: 0,
      inputHash: 'A-c1-hash',
      ...identityPayload(),
      messages: [{ id: 'invalid', role: 'invalid', content: 'invalid role', timestamp: Date.now() }],
    }),
  );
  assert.equal(await invoke('record:get', 'A'), null, 'failed message persistence must roll back Record publication');
  assert.equal((await invoke('record:candidate:get', 'A')).state, 'prepared');

  const publishedA = await invoke('record:candidate:publish', {
    conversationId: 'A',
    candidateId: 'A-c1',
    parentRevision: 0,
    inputHash: 'A-c1-hash',
    ...identityPayload(),
    messages: messages('A'),
  });
  assert.equal(publishedA.published, true);
  assert.equal(publishedA.revision, 1);
  assert.equal((await invoke('record:get', 'A')).totalSteps, 2);
  assert.equal((await invoke('message:list', 'A')).length, 2);

  const stalePrepared = await prepare('A', 'A-c2', 1, 3);
  assert.equal(stalePrepared.prepared, true);
  const advanced = await invoke('record:upsert', { ...candidate('A', 4, 1), expectedRevision: 1 });
  assert.equal(advanced.written, true);
  assert.equal(advanced.revision, 2);
  const hitOnly = candidate('A', 4, 2);
  hitOnly.batches[0].hitCount = 1;
  const preserved = await invoke('record:upsert', { ...hitOnly, preserveRevision: true });
  assert.equal(preserved.written, true);
  assert.equal(preserved.revision, 2, 'hit-only metadata must not invalidate the rendered request generation');
  assert.equal((await invoke('record:get', 'A')).batches[0].hitCount, 1);
  const stalePublish = await invoke('record:candidate:publish', {
    conversationId: 'A',
    candidateId: 'A-c2',
    parentRevision: 1,
    inputHash: 'A-c2-hash',
    ...identityPayload(),
    messages: messages('A'),
  });
  assert.equal(stalePublish.published, false);
  assert.equal(stalePublish.reason, 'stale-parent');
  assert.equal((await invoke('record:get', 'A')).revision, 2);

  const rejectedMissingRevision = await invoke('record:upsert', {
    ...candidate('guarded-insert', 2, 0),
    expectedRevision: 1,
  });
  assert.equal(rejectedMissingRevision.written, false, 'missing Record must not bypass a non-zero revision gate');
  assert.equal(await invoke('record:get', 'guarded-insert'), null);
  const rejectedMissingStep = await invoke('record:upsert', {
    ...candidate('guarded-insert', 2, 0),
    expectedStepStart: 1,
  });
  assert.equal(rejectedMissingStep.written, false, 'missing Record must not bypass a non-zero step gate');
  assert.equal(await invoke('record:get', 'guarded-insert'), null);

  await assert.rejects(async () => invoke('record:upsert', {
    ...candidate('C', 2, 0),
    expectedRevision: 0,
    messages: [{ id: 'C-invalid', role: 'invalid', content: 'invalid role', timestamp: Date.now() }],
  }));
  assert.equal(await invoke('record:get', 'C'), null, 'failed hard/manual snapshot must roll back Record append');
  const publishedC = await invoke('record:upsert', {
    ...candidate('C', 2, 0),
    expectedRevision: 0,
    messages: messages('C'),
  });
  assert.equal(publishedC.written, true);
  assert.equal((await invoke('message:list', 'C')).length, 2);
  await invoke('record:candidate:discard', { conversationId: 'A', candidateId: 'A-c2', reason: 'stale' });
  const discardedRetry = await prepare('A', 'A-c2', 2, 5);
  assert.equal(discardedRetry.prepared, false);
  assert.equal(discardedRetry.reason, 'candidate-discarded');

  const preparedA3 = await prepare('A', 'A-c3', 2, 5);
  const preparedB = await prepare('B', 'B-c1', 0, 2);
  assert.equal(preparedA3.prepared, true);
  assert.equal(preparedB.prepared, true);
  const lateDiscard = await invoke('record:candidate:discard', {
    conversationId: 'A',
    candidateId: 'A-c2',
    reason: 'late stale discard',
  });
  assert.equal(lateDiscard, false, 'discarding an older candidate must not erase a newer prepared candidate');
  assert.equal((await invoke('record:candidate:get', 'A')).candidateId, 'A-c3');
  const publishedB = await invoke('record:candidate:publish', {
    conversationId: 'B',
    candidateId: 'B-c1',
    parentRevision: 0,
    inputHash: 'B-c1-hash',
    ...identityPayload(),
    messages: messages('B'),
  });
  assert.equal(publishedB.published, true);
  assert.equal((await invoke('record:candidate:get', 'A')).candidateId, 'A-c3');
  assert.equal((await invoke('record:get', 'A')).revision, 2);

  setCredentialIdentity(identityB);
  const staleIdentityPrepare = await invoke('record:candidate:prepare', {
    conversationId: 'identity-snapshot-stale',
    candidateId: 'identity-stale-c1',
    parentRevision: 0,
    sourceStepCursor: 6,
    sourceRoundCursor: 3,
    inputHash: 'identity-stale-hash',
    ...identityPayload(identityA),
    candidate: candidate('identity-snapshot-stale', 2, 0),
  });
  assert.equal(staleIdentityPrepare.prepared, false);
  assert.equal(staleIdentityPrepare.reason, 'stale-identity');
  assert.equal(await invoke('record:candidate:get', 'identity-snapshot-stale'), null);
  setCredentialIdentity(identityA);

  const readyBeforeRestart = await prepare('identity-ready-restart', 'identity-ready-c1', 0, 2);
  assert.equal(readyBeforeRestart.prepared, true);
  const readyState = await invoke('record:candidate:get', 'identity-ready-restart');
  assert.equal(readyState.providerId, identityA.providerId);
  assert.equal(readyState.modelId, identityA.modelId);
  assert.equal(readyState.catalogGeneration, identityA.catalogGeneration);
  assert.equal(readyState.credentialGeneration, identityA.credentialGeneration);

  databaseModule.getDatabase().prepare(`INSERT INTO context_generation_state (
      conversation_id, state, candidate_id, parent_revision, published_revision,
      source_step_cursor, source_round_cursor, input_hash, candidate_json, updated_at
    ) VALUES (?, 'prepared', ?, 0, 0, 6, 3, ?, ?, unixepoch())`)
    .run(
      'legacy-null-identity',
      'legacy-null-c1',
      'legacy-null-hash',
      JSON.stringify(candidate('legacy-null-identity', 2, 0)),
    );
  const legacyNullPublish = await invoke('record:candidate:publish', {
    conversationId: 'legacy-null-identity',
    candidateId: 'legacy-null-c1',
    parentRevision: 0,
    inputHash: 'legacy-null-hash',
    ...identityPayload(identityA),
    messages: messages('legacy-null-identity'),
  });
  assert.equal(legacyNullPublish.published, false);
  assert.equal(legacyNullPublish.reason, 'missing-identity');
  assert.equal(await invoke('record:get', 'legacy-null-identity'), null);
  assert.equal((await invoke('record:candidate:get', 'legacy-null-identity')).state, 'discarded');

  const autosaveRecord = await invoke('record:upsert', {
    ...candidate('autosave-current', 3, 0),
    expectedRevision: 0,
  });
  assert.equal(autosaveRecord.written, true);
  assert.equal(autosaveRecord.revision, 1);
  await prepare('autosave-current', 'draft-c1', 1, 4);
  await invoke('record:generation:update', {
    conversationId: 'autosave-current',
    schedulerState: 'generating',
    retryCount: 2,
    backoffUntil: 987654,
    hardPaused: false,
  });
  databaseModule.getDatabase().prepare(`INSERT INTO provider_request_ledger (
      request_id, renderer_id, conversation_id, run_id, call_id, owner_id,
      request_kind, provider_id, model_id, body_sha256, sent_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'promote-request',
      1,
      'autosave-current',
      'promote-run',
      'promote-call',
      'promote-owner',
      'agent',
      'openai-codex',
      'gpt-5.5',
      'promote-body-sha',
      Date.now(),
      'completed',
    );
  assert.equal(await invoke('record:promote', 'autosave-current', 'promoted'), true);
  assert.equal(await invoke('record:candidate:get', 'autosave-current'), null);
  assert.equal(await invoke('record:get', 'autosave-current'), null);
  const promotedRecord = await invoke('record:get', 'promoted');
  assert.equal(promotedRecord.revision, 1);
  assert.equal(promotedRecord.totalSteps, 3);
  const promotedState = await invoke('record:candidate:get', 'promoted');
  assert.equal(promotedState.state, 'idle');
  assert.equal(promotedState.schedulerState, 'idle');
  assert.equal(promotedState.candidateId, null);
  assert.equal(promotedState.publishedRevision, 1);
  assert.equal(databaseModule.getDatabase().prepare(
    'SELECT conversation_id FROM provider_request_ledger WHERE request_id = ?',
  ).get('promote-request').conversation_id, 'promoted');

  await invoke('conversation:update', 'thresholds', {
    title: 'thresholds-preserved',
  });
  const preservedThresholds = await invoke('conversation:get', 'thresholds');
  assert.equal(preservedThresholds.bpcThresholdOverride, 0.61);
  assert.equal(preservedThresholds.compactThresholdOverride, 0.88);

  await invoke('conversation:update', 'thresholds', {
    bpcThresholdOverride: null,
    compactThresholdOverride: null,
  });
  const clearedThresholds = await invoke('conversation:get', 'thresholds');
  assert.equal(clearedThresholds.bpcThresholdOverride, null);
  assert.equal(clearedThresholds.compactThresholdOverride, null);

  await createConversation('delete-generation');
  await invoke('record:generation:update', {
    conversationId: 'delete-generation',
    schedulerState: 'hard-paused',
    hardPaused: true,
    lastError: 'stale generation must be deleted with the record',
  });
  assert.ok(databaseModule.getDatabase().prepare(
    'SELECT 1 FROM context_generation_state WHERE conversation_id = ?',
  ).get('delete-generation'));
  assert.equal(await invoke('record:delete', 'delete-generation'), true);
  assert.equal(databaseModule.getDatabase().prepare(
    'SELECT 1 FROM context_generation_state WHERE conversation_id = ?',
  ).get('delete-generation'), undefined);

  databaseModule.closeDatabase();
  handlers.clear();
  databaseModule.initDatabase();
  registerConversationHandlers();
  setCredentialIdentity(identityB);
  const staleAfterRestart = await invoke('record:candidate:publish', {
    conversationId: 'identity-ready-restart',
    candidateId: 'identity-ready-c1',
    parentRevision: 0,
    inputHash: 'identity-ready-c1-hash',
    ...identityPayload(identityA),
    messages: messages('identity-ready-restart'),
  });
  assert.equal(staleAfterRestart.published, false);
  assert.equal(staleAfterRestart.reason, 'stale-identity');
  assert.equal(await invoke('record:get', 'identity-ready-restart'), null);
  assert.equal((await invoke('record:candidate:get', 'identity-ready-restart')).state, 'discarded');
  setCredentialIdentity(identityA);
  const reloadedA = await invoke('record:candidate:get', 'A');
  assert.equal(reloadedA.hardPaused, true);
  assert.equal(reloadedA.circuitBroken, true);
  assert.equal((await invoke('record:get', 'B')).revision, 1);

  databaseModule.closeDatabase();
  console.log('BPC generation integration: all assertions passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      databaseModule?.closeDatabase();
    } catch {}
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to remove BPC test directory:', error);
      process.exitCode = 1;
    }
    app.quit();
  });
