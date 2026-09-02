const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { app, ipcMain, shell } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-windsurf-local-import-'));
const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming');
process.env.APPDATA = appDataRoot;
process.env.USERPROFILE = path.join(tempRoot, 'home');
process.env.SYNAPSE_DATA_DIR = path.join(tempRoot, 'data');
process.env.SYNAPSE_WINDSURF_IMPORT_DIR = path.join(tempRoot, 'legacy-dsh-disabled');
app.setPath('home', process.env.USERPROFILE);
app.setPath('userData', path.join(tempRoot, 'user-data'));

const handlers = new Map();
let databaseModule;
let providerModule;
let credentialStoreModule;
const openedAuthorizationUrls = [];
const originalOpenExternal = shell.openExternal;
shell.openExternal = async url => {
  openedAuthorizationUrls.push(String(url));
};

ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler);
};

function invoke(channel, ...args) {
  return invokeAs(7, channel, ...args);
}

function invokeAs(senderId, channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return Promise.resolve(handler({ sender: { id: senderId } }, ...args));
}

function assertNoSecret(value, ...secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `IPC result leaked secret: ${secret}`);
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sourceRoot(source) {
  if (source === 'devin') return path.join(appDataRoot, 'devin');
  if (source === 'windsurf') return path.join(appDataRoot, 'Windsurf');
  if (source === 'codeium') return path.join(appDataRoot, 'Codeium', 'Windsurf');
  throw new Error(`Unknown source: ${source}`);
}

function dbPathFor(source) {
  return path.join(sourceRoot(source), 'User', 'globalStorage', 'state.vscdb');
}

function resetSource(source) {
  fs.rmSync(sourceRoot(source), { recursive: true, force: true });
}

function writeStateDb(source, authStatus, selected = undefined) {
  resetSource(source);
  const dbPath = dbPathFor(source);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('windsurfAuthStatus', JSON.stringify(authStatus));
  if (selected !== undefined) {
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('codeium.windsurf-windsurf_auth', JSON.stringify(selected));
  }
  database.close();
  return dbPath;
}

async function main() {
  await app.whenReady();
  databaseModule = require('../dist-electron/electron/database.js');
  credentialStoreModule = require('../dist-electron/electron/provider/credentialStore.js');
  providerModule = require('../dist-electron/electron/ipc/provider.js');
  databaseModule.initDatabase();
  providerModule.registerProviderHandlers();

  const firstSecret = 'fixture-local-secret-alpha';
  const secondSecret = 'fixture-local-secret-bravo';
  const extraSecret = 'fixture-local-secret-charlie';

  const missing = await invoke('provider:windsurfImportLocal');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'not_found');
  assertNoSecret(missing, firstSecret, secondSecret, extraSecret);

  const corruptPath = dbPathFor('devin');
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, 'not a sqlite database');
  const corrupt = await invoke('provider:windsurfImportLocal');
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.error.code, 'database_corrupt');
  assertNoSecret(corrupt, firstSecret, secondSecret, extraSecret);
  resetSource('devin');

  const lockedPath = writeStateDb('devin', {
    apiKey: firstSecret,
    apiServerUrl: 'https://server.codeium.com',
    email: 'locked@example.test',
  });
  const lockedDatabase = new Database(lockedPath);
  lockedDatabase.exec('BEGIN EXCLUSIVE');
  const locked = await invoke('provider:windsurfImportLocal');
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, 'database_locked');
  assertNoSecret(locked, firstSecret, secondSecret, extraSecret);
  lockedDatabase.exec('ROLLBACK');
  lockedDatabase.close();
  resetSource('devin');

  writeStateDb('devin', {
    apiKey: firstSecret,
    apiServerUrl: 'https://server.codeium.com',
    email: 'alpha@example.test',
  });
  const ambiguousCorruptPath = dbPathFor('windsurf');
  fs.mkdirSync(path.dirname(ambiguousCorruptPath), { recursive: true });
  fs.writeFileSync(ambiguousCorruptPath, 'not a sqlite database');
  const ambiguousCorrupt = await invoke('provider:windsurfImportLocal');
  assert.equal(ambiguousCorrupt.ok, false);
  assert.equal(ambiguousCorrupt.error.code, 'database_corrupt');
  assert.equal((await invoke('provider:credentialStatus', 'windsurf')).configured, false);
  assertNoSecret(ambiguousCorrupt, firstSecret);
  resetSource('windsurf');

  writeStateDb('devin', {
    apiKey: firstSecret,
    apiServerUrl: 'https://server.codeium.com',
    email: 'alpha@example.test',
  });
  const notAutoImported = await invoke('provider:credentialStatus', 'windsurf');
  assert.equal(notAutoImported.configured, false);
  assertNoSecret(notAutoImported, firstSecret);

  const imported = await invoke('provider:windsurfImportLocal');
  assert.equal(imported.ok, true);
  assert.equal(imported.imported, true);
  assert.equal(imported.status.connected, true);
  assert.equal(imported.status.persisted, true);
  assert.equal(imported.status.credentialSource, 'local-client-import');
  assert.equal(imported.accountLabel, 'alpha@example.test');
  assertNoSecret(imported, firstSecret);

  const configured = await invoke('provider:credentialStatus', 'windsurf');
  assert.equal(configured.configured, true);
  assert.equal(configured.persisted, true);
  assert.equal(configured.credentialType, 'local-client-import');
  assert.match(configured.accountFingerprint, /^[a-f0-9]{64}$/);
  assertNoSecret(configured, firstSecret);

  const stored = databaseModule.getDatabase()
    .prepare("SELECT value FROM settings WHERE key = 'providerCredential:windsurf'")
    .get();
  assert.ok(stored?.value);
  assert.equal(String(stored.value).includes(firstSecret), false);

  credentialStoreModule.markProviderCredentialRejected('windsurf', 'fixture credential rejected');
  const rejectedStatus = await invoke('provider:windsurfStatus');
  assert.equal(rejectedStatus.state, 'error');
  assert.equal(rejectedStatus.connected, false);
  const waitingForComplete = await invoke('provider:windsurfLogin');
  assert.equal(waitingForComplete.state, 'waiting');
  assert.equal(waitingForComplete.connected, false);
  assert.equal(waitingForComplete.error, null);
  assert.match(waitingForComplete.transactionId, /^[A-Za-z0-9_-]{32,}$/);
  await assert.rejects(
    invoke('provider:windsurfComplete', waitingForComplete.transactionId, 'too-short'),
    /Invalid Windsurf login token/,
  );
  const waitingForCancel = await invoke('provider:windsurfLogin');
  assert.equal(waitingForCancel.state, 'waiting');
  const cancelledLogin = await invoke('provider:windsurfCancel');
  assert.equal(cancelledLogin.state, 'error');
  assert.equal(cancelledLogin.error, 'fixture credential rejected');
  assert.equal(openedAuthorizationUrls.length, 2);
  credentialStoreModule.clearProviderCredentialRejection('windsurf');
  assert.equal((await invoke('provider:windsurfStatus')).state, 'connected');

  const repeated = await invoke('provider:windsurfImportLocal');
  assert.equal(repeated.ok, true);
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.imported, false);
  assertNoSecret(repeated, firstSecret);
  const repeatedStatus = await invoke('provider:credentialStatus', 'windsurf');
  assert.equal(repeatedStatus.accountFingerprint, configured.accountFingerprint);
  assert.equal(repeatedStatus.credentialGeneration, configured.credentialGeneration);

  writeStateDb('windsurf', {
    api_key: extraSecret,
    api_server_url: 'https://server.codeium.com',
    user: { email: 'charlie@example.test' },
  });
  const multiple = await invoke('provider:windsurfImportLocal');
  assert.equal(multiple.ok, false);
  assert.equal(multiple.error.code, 'multiple_accounts');
  assert.equal(multiple.error.candidates.length, 2);
  assert.equal(multiple.error.candidates.every(candidate => /^[a-f0-9]{64}$/.test(candidate.candidateFingerprint)), true);
  const alphaCandidate = multiple.error.candidates.find(candidate => candidate.accountLabel === 'alpha@example.test');
  const charlieCandidate = multiple.error.candidates.find(candidate => candidate.accountLabel === 'charlie@example.test');
  assert.ok(alphaCandidate);
  assert.ok(charlieCandidate);
  assert.notEqual(alphaCandidate.candidateFingerprint, charlieCandidate.candidateFingerprint);
  const selectedExisting = await invoke('provider:windsurfImportLocal', {
    candidateFingerprint: alphaCandidate.candidateFingerprint,
  });
  assert.equal(selectedExisting.ok, true);
  assert.equal(selectedExisting.unchanged, true);
  const selectedDifferentChallenge = await invoke('provider:windsurfImportLocal', {
    candidateFingerprint: charlieCandidate.candidateFingerprint,
  });
  assert.equal(selectedDifferentChallenge.ok, false);
  assert.equal(selectedDifferentChallenge.error.code, 'replace_required');
  const selectedDifferent = await invoke('provider:windsurfImportLocal', {
    confirmationToken: selectedDifferentChallenge.error.confirmationToken,
    candidateFingerprint: charlieCandidate.candidateFingerprint,
  });
  assert.equal(selectedDifferent.ok, true);
  assert.equal(selectedDifferent.replaced, true);
  assert.equal(selectedDifferent.accountLabel, 'charlie@example.test');
  const selectedDifferentStatus = await invoke('provider:credentialStatus', 'windsurf');
  const invalidCandidate = await invoke('provider:windsurfImportLocal', {
    candidateFingerprint: '0'.repeat(64),
  });
  assert.equal(invalidCandidate.ok, false);
  assert.equal(invalidCandidate.error.code, 'candidate_selection_invalid');
  assert.equal(invalidCandidate.error.candidates.length, 2);
  const staleCandidateFingerprint = charlieCandidate.candidateFingerprint;
  assertNoSecret(multiple, firstSecret, extraSecret);
  resetSource('windsurf');
  const staleCandidate = await invoke('provider:windsurfImportLocal', {
    candidateFingerprint: staleCandidateFingerprint,
  });
  assert.equal(staleCandidate.ok, false);
  assert.equal(staleCandidate.error.code, 'candidate_selection_invalid');
  assert.equal(staleCandidate.error.candidates.length, 1);
  assert.equal(staleCandidate.error.candidates[0].accountLabel, 'alpha@example.test');

  writeStateDb('devin', {
    sessionToken: secondSecret,
    apiServerUrl: 'https://server.codeium.com',
    user: { name: 'Bravo Local' },
  });
  const replaceRequired = await invoke('provider:windsurfImportLocal');
  assert.equal(replaceRequired.ok, false);
  assert.equal(replaceRequired.error.code, 'replace_required');
  assert.match(replaceRequired.error.confirmationToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(replaceRequired.error.candidates[0].candidateFingerprint, /^[a-f0-9]{64}$/);
  const bravoCandidateFingerprint = replaceRequired.error.candidates[0].candidateFingerprint;
  assertNoSecret(replaceRequired, firstSecret, secondSecret);
  const stillCurrent = await invoke('provider:credentialStatus', 'windsurf');
  assert.equal(stillCurrent.accountFingerprint, selectedDifferentStatus.accountFingerprint);

  const bypassAttempt = await invoke('provider:windsurfImportLocal', { replace: true });
  assert.equal(bypassAttempt.ok, false);
  assert.equal(bypassAttempt.error.code, 'replace_required');
  const wrongConfirmation = await invoke('provider:windsurfImportLocal', {
    confirmationToken: 'wrong-token',
    candidateFingerprint: bravoCandidateFingerprint,
  });
  assert.equal(wrongConfirmation.ok, false);
  assert.equal(wrongConfirmation.error.code, 'replace_confirmation_invalid');
  const tokenOnlyChallenge = await invoke('provider:windsurfImportLocal');
  const tokenOnlyAttempt = await invoke('provider:windsurfImportLocal', {
    confirmationToken: tokenOnlyChallenge.error.confirmationToken,
  });
  assert.equal(tokenOnlyAttempt.ok, false);
  assert.equal(tokenOnlyAttempt.error.code, 'replace_confirmation_invalid');
  const requesterChallenge = await invoke('provider:windsurfImportLocal');
  const wrongRequester = await invokeAs(8, 'provider:windsurfImportLocal', {
    confirmationToken: requesterChallenge.error.confirmationToken,
    candidateFingerprint: bravoCandidateFingerprint,
  });
  assert.equal(wrongRequester.ok, false);
  assert.equal(wrongRequester.error.code, 'replace_confirmation_invalid');
  const generationChallenge = await invoke('provider:windsurfImportLocal');
  credentialStoreModule.setProviderCredential('windsurf', 'browser-oauth', {
    kind: 'local_client_import',
    apiKey: firstSecret,
    createdAt: new Date().toISOString(),
    apiServerUrl: 'https://server.codeium.com',
    accountName: 'alpha@example.test',
  }, firstSecret);
  const changedGeneration = await invoke('provider:windsurfImportLocal', {
    confirmationToken: generationChallenge.error.confirmationToken,
    candidateFingerprint: bravoCandidateFingerprint,
  });
  assert.equal(changedGeneration.ok, false);
  assert.equal(changedGeneration.error.code, 'replace_confirmation_invalid');
  const freshChallenge = await invoke('provider:windsurfImportLocal');
  const replaced = await invoke('provider:windsurfImportLocal', {
    confirmationToken: freshChallenge.error.confirmationToken,
    candidateFingerprint: bravoCandidateFingerprint,
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.status.connected, true);
  assert.equal(replaced.status.credentialSource, 'local-client-import');
  assert.equal(replaced.accountLabel, 'Bravo Local');
  assertNoSecret(replaced, firstSecret, secondSecret);
  const replacedStatus = await invoke('provider:credentialStatus', 'windsurf');
  assert.notEqual(replacedStatus.accountFingerprint, configured.accountFingerprint);
  assert.ok(replacedStatus.credentialGeneration > configured.credentialGeneration);

  const sourceBeforeLogout = sha256File(dbPathFor('devin'));
  const loggedOut = await invoke('provider:windsurfLogout');
  assert.equal(loggedOut.connected, false);
  assert.equal(fs.existsSync(dbPathFor('devin')), true);
  assert.equal(sha256File(dbPathFor('devin')), sourceBeforeLogout);
  assertNoSecret(loggedOut, secondSecret);

  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.ts'), 'utf8');
  assert.match(preloadSource, /windsurfImportLocal/);
  assert.match(preloadSource, /candidateFingerprint/);
  assert.doesNotMatch(preloadSource, /windsurfImportLocal:[\s\S]{0,180}(apiKey|accessToken|sessionToken|jwt)/i);

  const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'settings', 'SettingsPanel.tsx'), 'utf8');
  assert.match(settingsSource, /replace_required/);
  assert.match(settingsSource, /confirmAction/);
  assert.match(settingsSource, /error\.confirmationToken/);
  assert.match(settingsSource, /windsurf-import-candidates/);
  assert.match(settingsSource, /candidate\.accountLabel/);
  assert.match(settingsSource, /candidate\.source/);
  assert.match(settingsSource, /已取消本机导入/);

  console.log('Windsurf local import integration: all assertions passed');
}

let failed = false;
main()
  .catch(error => {
    failed = true;
    console.error(error);
  })
  .finally(() => {
    shell.openExternal = originalOpenExternal;
    try { providerModule?.shutdownProviderRuntime(); } catch {}
    try { databaseModule?.closeDatabase(); } catch {}
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    app.exit(failed ? 1 : 0);
  });
