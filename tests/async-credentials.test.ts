import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readCredentialAsync, saveCredential, deleteCredential, type Credential } from '../src/credentials.js';
import { createAsyncRuntimeConfigLoader } from '../src/config.js';
import { createServer } from '../src/server.js';
import { TopMediaiError } from '../src/types.js';

const account = { memberId: '101', email: 'fixture@example.test', emailMasked: 'f***@example.test' };
const tokenA = 'a'.repeat(42), tokenB = 'b'.repeat(42);
const credential = (token: string): Credential => ({ format_version: 1, environment: 'production', token, member_id: '101',
  email_masked: account.emailMasked, obtained_at: new Date().toISOString(), token_expires_at: null });
async function directory(t: TestContext) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(resolve(parent, 'topmediai-async-credentials-'));
  t.after(async () => {
    const suffix = relative(parent, dir);
    assert.ok(suffix.startsWith('topmediai-async-credentials-') && !isAbsolute(suffix) && !suffix.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  return resolve(dir, 'credentials');
}

test('private credential reads verify permissions asynchronously and see replacement and logout immediately', async t => {
  const dir = await directory(t);
  assert.equal(await readCredentialAsync('production', dir), null);
  await saveCredential('production', account, tokenA, () => {}, dir);
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 5);
  try {
    assert.equal((await readCredentialAsync('production', dir))?.token, tokenA);
    if (process.platform === 'win32') assert.ok(ticks > 1, 'Windows ACL verification must leave the event loop available');
  } finally { clearInterval(timer); }
  await saveCredential('production', account, tokenB, () => {}, dir);
  assert.equal((await readCredentialAsync('production', dir))?.token, tokenB);
  const pending = readCredentialAsync('production', dir); deleteCredential('production', dir);
  assert.equal(await pending, null);
  assert.equal(await readCredentialAsync('production', dir), null);
});

test('async credentials reject unsafe permissions and corruption without reusing the last token', async t => {
  const dir = await directory(t); await saveCredential('production', account, tokenA, () => {}, dir);
  const text = await readFile(resolve(dir, 'production.json'), 'utf8');
  await writeFile(resolve(dir, 'production.json'), JSON.stringify({ ...JSON.parse(text), environment: 'unsupported' }));
  await assert.rejects(readCredentialAsync('production', dir));
  await writeFile(resolve(dir, 'production.json'), '{broken');
  await assert.rejects(readCredentialAsync('production', dir), (error: unknown) => error instanceof TopMediaiError && error.code === 'CREDENTIAL_CORRUPT');
});

test('async runtime reload freezes launch settings, validates before reads and honors explicit overrides', async () => {
  let saved: Credential | null = credential(tokenA), reads = 0;
  const env = { TOPMEDIAI_TOKEN: '', TOPMEDIAI_ENV: 'production', TOPMEDIAI_SOURCE: '4' };
  const reload = createAsyncRuntimeConfigLoader(env, async () => { reads++; return saved; });
  env.TOPMEDIAI_ENV = 'production'; env.TOPMEDIAI_TOKEN = tokenB; env.TOPMEDIAI_SOURCE = '1';
  const first = await reload(); assert.equal(first.token, tokenA); assert.equal(first.environment, 'production'); assert.equal(first.source, 4);
  saved = null; assert.equal((await reload()).token, ''); assert.equal(reads, 2);
  const explicit = createAsyncRuntimeConfigLoader({ TOPMEDIAI_TOKEN: tokenB }, () => { throw new Error('Local credentials must not be read'); });
  assert.equal((await explicit()).token, tokenB);
  await assert.rejects(createAsyncRuntimeConfigLoader({ TOPMEDIAI_ENV: 'invalid' }, () => { reads++; return null; })());
  assert.equal(reads, 2);
});

test('a slow async credential reload does not block another MCP request and failures stop old credentials', async t => {
  const dir = await directory(t); let reads = 0, release!: () => void, notify!: () => void, corrupt = false;
  const gate = new Promise<void>(yes => { release = yes; }), started = new Promise<void>(yes => { notify = yes; });
  const reload = createAsyncRuntimeConfigLoader({ TOPMEDIAI_TOKEN: '', TOPMEDIAI_DATA_DIR: dir }, async () => {
    if (corrupt) throw new TopMediaiError('CREDENTIAL_CORRUPT', 'Fixture credential is invalid.');
    if (++reads === 2) { notify(); await gate; }
    return credential(tokenA);
  });
  const server = createServer(await reload(), reload), client = new Client({ name: 'async-credential-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { release(); await client.close(); await server.close(); });
  const call = () => client.callTool({ name: 'get_service_status', arguments: {} });
  const pending = call(); await started;
  try { assert.equal(((await call()).structuredContent as any).token_configured, true); }
  finally { release(); }
  assert.equal(((await pending).structuredContent as any).token_configured, true);
  corrupt = true;
  const failed = await call(); assert.equal(failed.isError, true);
  assert.equal((failed.structuredContent as any).error.code, 'CREDENTIAL_CORRUPT');
  assert.ok(!JSON.stringify(failed).includes(tokenA));
});
