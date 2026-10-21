import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSystemCredentialStore, nativeOperation, nativeOptions, normalizeStoreError, storeError } from '../src/credential-store.js';
import { deleteCredential, readCredential, readCredentialAsync, saveCredential } from '../src/credentials.js';
import { MemoryCredentialStore } from './fixtures/credential-store.js';
import { TopMediaiError } from '../src/types.js';

const account = { memberId: '101', email: 'fixture@example.test', emailMasked: 'f***@example.test' };
const token = 'T'.repeat(42);
const code = (expected: string) => (error: unknown) => error instanceof TopMediaiError && error.code === expected;

test('native adapter selects system stores, pins Linux Secret Service and never masks read/delete failure as absence', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    let value: string | null = null;
    const entry = { getPassword: () => value, setPassword: (v: string) => { value = v; }, deleteCredential: () => { value = null; return true; } };
    const factory = (service: string, environment: string, options: object) => {
      assert.equal(service, 'fixture-service'); assert.equal(environment, 'production');
      assert.deepEqual(options, platform === 'linux' ? { linux: { store: 'secret-service' } } : {});
      return entry;
    };
    const call = (op: 'read' | 'write' | 'remove') => nativeOperation('fixture-service', 'production', op, token, factory, platform);
    assert.equal(call('read'), null); call('write'); assert.equal(call('read'), token); call('remove'); assert.equal(call('read'), null);
    entry.getPassword = () => { throw new Error('credential store is locked'); };
    assert.throws(() => call('read'), code('CREDENTIAL_STORE_LOCKED'));
    entry.deleteCredential = () => { throw new Error('Access denied'); };
    assert.throws(() => call('remove'), code('CREDENTIAL_STORE_DENIED'));
  }
  assert.throws(() => nativeOptions('freebsd'), code('CREDENTIAL_STORE_UNAVAILABLE'));
});

test('credential errors contain actionable fixed text and never native diagnostics or tokens', () => {
  for (const [message, expected] of [['locked', 'CREDENTIAL_STORE_LOCKED'], ['denied', 'CREDENTIAL_STORE_DENIED'],
    ['user canceled', 'CREDENTIAL_STORE_DENIED'], ['D-Bus service missing', 'CREDENTIAL_STORE_UNAVAILABLE']]) {
    const safe = normalizeStoreError(new Error(`${message}: ${token}`));
    assert.equal(safe.code, expected); assert.ok(!JSON.stringify(safe).includes(token)); assert.ok(!safe.message.includes(token));
  }
});

test('read failures do not become logged-out state and do not reuse previous credentials', async () => {
  const store = new MemoryCredentialStore(); await saveCredential('production', account, token, () => {}, store);
  assert.equal(readCredential('production', store)?.token, token);
  store.read = () => { throw new Error('locked'); };
  assert.throws(() => readCredential('production', store), code('CREDENTIAL_STORE_LOCKED'));
  await assert.rejects(readCredentialAsync('production', store), code('CREDENTIAL_STORE_LOCKED'));
});

test('failed delete does not report success or clear the credential', async () => {
  const store = new MemoryCredentialStore(); await saveCredential('production', account, token, () => {}, store);
  store.remove = async () => { throw new Error(`denied ${token}`); };
  await assert.rejects(deleteCredential('production', store), code('CREDENTIAL_STORE_DENIED'));
  assert.equal(readCredential('production', store)?.token, token);
  store.remove = async () => {};
  await assert.rejects(deleteCredential('production', store), code('CREDENTIAL_COMMIT_UNKNOWN'));
});

test('write failure preserves previous credentials; unconfirmable recovery is explicit', async () => {
  const store = new MemoryCredentialStore(); await saveCredential('production', account, token, () => {}, store);
  const write = store.write.bind(store);
  store.write = async () => { throw storeError('CREDENTIAL_STORE_DENIED'); };
  await assert.rejects(saveCredential('production', account, 'B'.repeat(42), () => {}, store), code('CREDENTIAL_STORE_DENIED'));
  assert.equal(readCredential('production', store)?.token, token);
  store.write = async (env, text) => {
    await write(env, text);
    store.readAsync = async () => { throw new Error('store no longer accessible'); };
    throw storeError('CREDENTIAL_COMMIT_UNKNOWN');
  };
  await assert.rejects(saveCredential('production', account, 'C'.repeat(42), () => {}, store), code('CREDENTIAL_COMMIT_UNKNOWN'));
});

test('a changed credential is never overwritten by rollback', async () => {
  const store = new MemoryCredentialStore(); await saveCredential('production', account, token, () => {}, store);
  store.write = async () => { store.values.set('production', 'another-writer'); throw new Error('uncertain'); };
  await assert.rejects(saveCredential('production', account, 'C'.repeat(42), () => {}, store), code('CREDENTIAL_COMMIT_UNKNOWN'));
  assert.equal(store.values.get('production'), 'another-writer');
});

test('an interrupted native write is not raced with a compensating write or deletion', async () => {
  const store = new MemoryCredentialStore();
  let writes = 0, removes = 0, reads = 0;
  store.readAsync = async () => { reads++; return null; };
  store.write = async () => { writes++; throw storeError('CREDENTIAL_COMMIT_UNKNOWN'); };
  store.remove = async () => { removes++; };
  await assert.rejects(saveCredential('production', account, token, () => {}, store), code('CREDENTIAL_COMMIT_UNKNOWN'));
  assert.equal(writes, 1); assert.equal(removes, 0); assert.equal(reads, 1);
});

test('production entry and credential implementation have no legacy file fallback', () => {
  const source = readFileSync(new URL('../../src/credentials.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('`${environment}.json`'));
  assert.ok(!source.includes('writeFileSync(handle, text'));
  const entry = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.ok(entry.includes('loadConfig(process.env, () => null)'));
});

test('native system-store roundtrip in an isolated random service', {
  skip: process.env.TOPMEDIAI_VERIFY_NATIVE_STORE !== '1',
}, async () => {
  const store = createSystemCredentialStore(`com.topmediai.mcp.test.${randomUUID()}`);
  try {
    assert.equal(await readCredentialAsync('production', store), null);
    await saveCredential('production', account, token, () => {}, store);
    assert.equal((await readCredentialAsync('production', store))?.token, token);
    assert.equal(readCredential('production', store)?.token, token);
    await deleteCredential('production', store);
    assert.equal(await readCredentialAsync('production', store), null);
  } finally { await store.remove('production'); }
});
