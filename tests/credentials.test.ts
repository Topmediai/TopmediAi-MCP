import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLoginLock, assertPrivatePath, deleteCredential, ensureCredentialDirectory, protectPrivatePath, readCredential, saveCredential } from '../src/credentials.js';
import { MemoryCredentialStore } from './fixtures/credential-store.js';
import { loadAuthConfig, loadConfig } from '../src/config.js';

const account = { memberId: '123456', email: 'alice@example.com', emailMasked: 'a***@example.com' };
const token = 'a'.repeat(42);
function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'topmediai-auth-tests-'));
  t.after(() => { if (!root.startsWith(join(tmpdir(), 'topmediai-auth-tests-'))) throw new Error('Unsafe test cleanup'); rmSync(root, { recursive: true, force: true }); });
  const directory = join(root, 'credentials'); ensureCredentialDirectory(directory); return directory;
}

test('production credential roundtrip never creates credential files', async t => {
  const directory = fixture(t), store = new MemoryCredentialStore();
  await saveCredential('production', account, token, () => {}, store);
  assert.equal(readCredential('production', store)?.token, token);
  assert.equal(existsSync(join(directory, 'production.json')), false);
  const saved = JSON.parse(store.values.get('production')!);
  assert.equal(saved.member_id, account.memberId); assert.equal(saved.token_expires_at, null);
  assert.deepEqual(Object.keys(saved).sort(), ['format_version', 'environment', 'member_id', 'email_masked', 'token', 'obtained_at', 'token_expires_at'].sort());
  await deleteCredential('production', store); assert.equal(readCredential('production', store), null);
});

test('cancelled or expired login never starts a credential write', async () => {
  const store = new MemoryCredentialStore();
  await saveCredential('production', account, token, () => {}, store);
  await assert.rejects(saveCredential('production', account, 'b'.repeat(42), () => { throw new Error('expired'); }, store));
  await assert.rejects(saveCredential('production', account, 'b'.repeat(42), () => 0, store));
  assert.equal(readCredential('production', store)?.token, token);
});

test('cancellation during a native write restores the previous credential or removes the first save', async () => {
  for (const previous of [null, token]) {
    const store = new MemoryCredentialStore();
    if (previous) await saveCredential('production', account, previous, () => {}, store);
    let checks = 0;
    await assert.rejects(saveCredential('production', account, 'b'.repeat(42), () => {
      if (++checks > 1) throw new Error('cancelled while waiting for system dialog');
    }, store));
    assert.equal(readCredential('production', store)?.token ?? null, previous);
  }
});

test('invalid types, wrong environment and corrupt secret fail closed; login can repair corruption', async () => {
  const store = new MemoryCredentialStore(); await saveCredential('production', account, token, () => {}, store);
  const original = JSON.parse(store.values.get('production')!);
  for (const replacement of [{ ...original, environment: 'unsupported' }, { ...original, member_id: 123 }, { ...original, token: 123 }, { ...original, secret: 'not-allowed' }]) {
    store.values.set('production', JSON.stringify(replacement)); assert.throws(() => readCredential('production', store));
  }
  store.values.set('production', '{broken'); assert.throws(() => readCredential('production', store));
  await saveCredential('production', account, token, () => {}, store);
  assert.equal(readCredential('production', store)?.member_id, '123456');
});

test('login lock excludes concurrent writers and does not contain credentials', t => {
  const directory = fixture(t); const release = acquireLoginLock('production', directory);
  assert.throws(() => acquireLoginLock('production', directory), (error: unknown) => (error as { code: string }).code === 'LOGIN_IN_PROGRESS');
  const body = readFileSync(join(directory, 'production.login.lock'), 'utf8'); assert.ok(!body.includes(token));
  assert.ok(JSON.parse(body).started_at); release(); assert.equal(existsSync(join(directory, 'production.login.lock')), false);
  const releaseAgain = acquireLoginLock('production', directory), lock = join(directory, 'production.login.lock');
  const ownMarker = readFileSync(lock, 'utf8');
  writeFileSync(lock, JSON.stringify({ ...JSON.parse(ownMarker), run_id: 'another-owner' }));
  releaseAgain(); assert.equal(existsSync(lock), true);
  writeFileSync(lock, ownMarker); releaseAgain(); assert.equal(existsSync(lock), false);
});

test('login-lock directory and metadata files retain private permission checks', t => {
  const directory = fixture(t);
  const path = join(directory, 'metadata.json'); writeFileSync(path, '{}');
  if (process.platform === 'win32') assert.throws(() => assertPrivatePath(path, false));
  protectPrivatePath(path, false); assertPrivatePath(path, false);
});
