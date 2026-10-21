import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';
import { createRuntimeConfigLoader, loadConfig, ROOT } from '../src/config.js';
import { productionEnvironment } from './fixtures/production.js';
import { createLocalAuthSession, type LocalAuthOptions } from '../src/local-auth.js';
import { LoginFlow, type LoginFlowDependencies } from '../src/login-flow.js';
import { encryptHandoffPayload, handoffProof, type AuthContext, type HandoffPayload } from '../src/auth-protocol.js';
import { readCredential, saveCredential, acquireLoginLock } from '../src/credentials.js';
import { MemoryCredentialStore } from './fixtures/credential-store.js';
import { TopMediaiError } from '../src/types.js';

const token = 'A'.repeat(42);
const account = { memberId: '101', email: 'user@example.test', emailMasked: 'u***@example.test' };
const webOrigin = 'https://web.fixture.invalid';

async function fixture(t: TestContext, options: { browserFails?: boolean; expires?: boolean; privateFiles?: boolean; production?: boolean; storeFailure?: boolean } = {}) {
  const parent = tmpdir(), root = await mkdtemp(join(parent, 'topmediai-login-flow-'));
  const cleanupDirectory = async () => {
    const rel = relative(parent, root); assert.ok(rel.startsWith('topmediai-login-flow-') && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  };
  const environment = options.production ? 'production' : 'production';
  const env = { ...(options.production ? productionEnvironment : {}), TOPMEDIAI_TOKEN: '', TOPMEDIAI_ENV: environment, TOPMEDIAI_DATA_DIR: join(root, 'state'),
    TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid', TOPMEDIAI_IMAGE_HOST: 'https://image.fixture.invalid',
    TOPMEDIAI_PRODUCTION_WEB_ORIGIN: webOrigin };
  let saved = false, corrupt = false, locked = false, browserUrl = '', clock = 0;
  const calls = { browser: 0, verify: 0, save: 0, unlock: 0, balance: 0 };
  const privateDirectory = join(root, 'credentials');
  const credentialStore = new MemoryCredentialStore();
  const reload = createRuntimeConfigLoader(env, environment => {
    if (corrupt) throw new TopMediaiError('CREDENTIAL_CORRUPT', 'The saved credential is corrupt.');
    if (options.privateFiles) return readCredential(environment, credentialStore);
    return saved ? { format_version: 1, environment, token, member_id: account.memberId,
      email_masked: account.emailMasked, obtained_at: new Date().toISOString(), token_expires_at: null } : null;
  });
  if (options.storeFailure) credentialStore.write = async () => { throw new TopMediaiError('CREDENTIAL_STORE_DENIED', 'Allow access to your system credential store, then retry.'); };
  const dependencies: LoginFlowDependencies = {
    credentialStore,
    launchEnvironment: env,
    acquireLock: environment => {
      assert.equal(locked, false); locked = true;
      const unlock = options.privateFiles ? acquireLoginLock(environment, privateDirectory) : () => {};
      return () => { assert.equal(locked, true); locked = false; calls.unlock++; unlock(); };
    },
    createSession: (auth: LocalAuthOptions) => createLocalAuthSession({ ...auth, acknowledgementTimeoutMs: 50,
      ...(options.expires ? { authorizationTimeoutMs: 2000, now: () => clock } : {}),
      verifyAccount: async () => { calls.verify++; return account; },
      saveCredential: async (verified, value, assertCanCommit) => {
        if (options.storeFailure) await auth.saveCredential(verified, value, assertCanCommit);
        else if (options.privateFiles) await saveCredential(auth.environment, verified, value, assertCanCommit, credentialStore);
        else assertCanCommit();
        saved = true; corrupt = false; calls.save++;
      },
    }),
    openBrowser: async url => { browserUrl = url; calls.browser++; return !options.browserFails; },
  };
  const server = createServer(reload(), reload, dependencies);
  const client = new Client({ name: 'login-flow-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await cleanupDirectory(); });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === '127.0.0.1') return originalFetch(input, init);
    assert.equal(url.origin, env.TOPMEDIAI_MEMBER_HOST);
    assert.equal(url.pathname, '/user/permission/info'); assert.equal(new Headers(init?.headers).get('token'), token);
    assert.equal(init?.method ?? 'GET', 'GET'); calls.balance++;
    return new Response(JSON.stringify({ status: 200, data: { tp_all: { left: 88 } } }));
  });
  function packet(decision: 'approve' | 'deny' = 'approve') {
    const params = new URLSearchParams(new URL(browserUrl).hash.slice(1));
    const context: AuthContext = { state: params.get('state')!, environment, port: Number(params.get('port')) };
    const key = createPublicKey({ key: Buffer.from(params.get('public_key')!, 'base64url'), type: 'spki', format: 'der' });
    const nonce = randomBytes(16).toString('base64url');
    const payload: HandoffPayload = decision === 'approve'
      ? { decision, token, expected_member_id: account.memberId, receipt_nonce: nonce } : { decision, receipt_nonce: nonce };
    const ciphertext = encryptHandoffPayload(key, context, payload);
    return { target: `http://127.0.0.1:${context.port}/v1/complete`,
      headers: { Origin: webOrigin, 'Content-Type': 'application/json',
        'handoff-proof': handoffProof(Buffer.from(params.get('secret')!, 'base64url'), context, ciphertext) },
      body: JSON.stringify({ version: 1, state: context.state, environment, ciphertext }) };
  }
  const post = async (value = packet()) => {
    const response = await fetch(value.target, { method: 'POST', headers: value.headers, body: value.body });
    return { status: response.status, body: await response.json() };
  };
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await raw(name, args)).structuredContent as any;
  const error = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args); assert.equal(result.isError, true);
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  return { calls, call, raw, error, packet, post, server, client,
    getBrowserUrl: () => browserUrl, isLocked: () => locked, setCorrupt: () => { corrupt = true; }, expire: () => { clock = 2100; } };
}

for (const production of [false, true]) test(`${production ? 'production' : 'production'} MCP login saves encrypted website confirmation and resumes account queries in the same connection`, async t => {
  const f = await fixture(t, { privateFiles: true, production });
  const status = await f.call('get_service_status');
  assert.equal(status.environment, production ? 'production' : 'production');
  assert.equal(status.api_connection_mode, 'direct');
  assert.equal(status.login_guidance.start_tool, 'start_login');
  assert.equal(status.login_guidance.wait_tool, 'wait_for_login');
  const started = await f.call('start_login');
  assert.equal(started.status, 'waiting'); assert.equal(started.next_tool, 'wait_for_login');
  assert.equal(started.continue_original_request, true); assert.equal(started.restart_required, false);
  const pending = f.call('wait_for_login', { login_id: started.login_id, wait_seconds: 1 });
  const packet = f.packet();
  const receipt = await f.post(packet); assert.equal(receipt.status, 200);
  const finished = await pending;
  assert.equal(finished.status, 'saved'); assert.deepEqual(finished.next_tools, ['get_service_status', 'get_balance']);
  assert.deepEqual(finished.account, { email_masked: account.emailMasked });
  // The wait result must not close the browser ACK retry window.
  assert.deepEqual((await f.post(packet)).body, receipt.body);
  assert.equal((await f.call('get_service_status')).credential_source, 'system-store');
  assert.equal((await f.call('get_balance')).credits, 88);
  const output = JSON.stringify({ started, finished, status });
  const secret = new URLSearchParams(new URL(f.getBrowserUrl()).hash.slice(1)).get('secret')!;
  assert.ok(!output.includes(token) && !output.includes(account.email) && !output.includes(secret));
  assert.ok(!output.includes('public_key') && !output.includes('ciphertext'));
  assert.equal(f.calls.verify, 1); assert.equal(f.calls.save, 1); assert.equal(f.calls.balance, 1);
});

test('concurrent start calls and repeated waiting share one browser session until cancellation', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.call('start_login'), f.call('start_login')]);
  assert.equal(first.login_id, second.login_id); assert.equal(f.calls.browser, 1);
  const waiting = await f.call('wait_for_login', { login_id: first.login_id, wait_seconds: 1 });
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.next_tool, 'wait_for_login');
  assert.equal(waiting.continue_original_request, true); assert.equal(f.isLocked(), true);
  assert.equal((await f.call('start_login')).login_id, first.login_id);
  const pending = f.call('wait_for_login', { login_id: first.login_id, wait_seconds: 1 });
  const cancelled = await f.call('cancel_login', { login_id: first.login_id });
  assert.equal(cancelled.status, 'aborted'); assert.equal((await pending).status, 'aborted');
  assert.equal(cancelled.continue_original_request, false); assert.equal(f.calls.unlock, 1);
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.save, 0); assert.equal(f.calls.browser, 1);
});

test('browser denial and expiry are terminal outcomes rather than new login attempts', async t => {
  for (const expires of [false, true]) await t.test(expires ? 'expired' : 'denied', async t => {
    const f = await fixture(t, { expires }); const started = await f.call('start_login');
    if (expires) f.expire();
    await f.post(f.packet('deny'));
    const result = await f.call('wait_for_login', { login_id: started.login_id, wait_seconds: 1 });
    assert.equal(result.status, expires ? 'expired' : 'cancelled');
    assert.equal(result.continue_original_request, false);
    assert.equal(f.calls.save, 0); assert.equal(f.calls.browser, 1);
  });
});

test('browser launch failure releases the login lock and returns a safe CLI fallback', async t => {
  const f = await fixture(t, { browserFails: true });
  const failed = await f.error('start_login');
  assert.equal(failed.error.code, 'LOGIN_BROWSER_OPEN_FAILED');
  assert.equal(failed.login_guidance.command.endsWith('run login'), true);
  assert.equal(f.isLocked(), false); assert.equal(f.calls.unlock, 1);
  assert.ok(!JSON.stringify(failed).includes(f.getBrowserUrl()));
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.save, 0);
});

test('login repairs a corrupt credential without allowing account tools to reuse old credentials', async t => {
  const f = await fixture(t); f.setCorrupt();
  assert.equal((await f.error('get_balance')).error.code, 'CREDENTIAL_CORRUPT');
  const started = await f.call('start_login'); await f.post();
  assert.equal((await f.call('wait_for_login', { login_id: started.login_id })).status, 'saved');
  assert.equal((await f.call('get_balance')).credits, 88);
});

test('foreign login handles cannot wait or cancel an active session', async t => {
  const f = await fixture(t); const started = await f.call('start_login');
  for (const name of ['wait_for_login', 'cancel_login']) {
    assert.equal((await f.error(name, { login_id: randomUUID() })).error.code, 'LOGIN_NOT_FOUND');
  }
  assert.equal(f.isLocked(), true); assert.equal(f.calls.browser, 1);
  await f.call('cancel_login', { login_id: started.login_id });
});

test('cancellation after a completed save stops continuation without removing credentials', async t => {
  const f = await fixture(t); const started = await f.call('start_login'); await f.post();
  const stopped = await f.call('cancel_login', { login_id: started.login_id });
  assert.equal(stopped.status, 'saved'); assert.equal(stopped.cancel_requested, true);
  assert.equal(stopped.continue_original_request, false);
  assert.equal((await f.call('get_service_status')).token_configured, true);
  assert.equal(f.calls.save, 1); assert.equal(f.calls.browser, 1);
});

test('MCP disconnection closes its waiting receiver and releases the lock', async t => {
  const f = await fixture(t); await f.call('start_login');
  const packet = f.packet(); await f.client.close(); await f.server.close();
  // Observe cleanup without a fixed delay; cancellation completes the current wait.
  await assert.rejects(f.post(packet));
  assert.equal(f.calls.unlock, 1); assert.equal(f.calls.save, 0);
});

test('development token overrides and fixed-config embeddings reject login before opening a browser', async () => {
  for (const [config, refresh] of [[loadConfig({ TOPMEDIAI_TOKEN: token }, () => null), true],
    [loadConfig({ TOPMEDIAI_TOKEN: '' }, () => null), false]] as const) {
    const flow = new LoginFlow(config, refresh, { openBrowser: async () => { assert.fail('Must not open a browser'); } });
    await assert.rejects(flow.start(), (error: unknown) => error instanceof TopMediaiError && error.code === 'LOGIN_RELOAD_REQUIRED');
    await flow.close();
  }
});

test('real stdio disconnection cleans a waiting login lock before the host terminates the process', async t => {
  const parent = tmpdir(), root = await mkdtemp(join(parent, 'topmediai-login-flow-'));
  // Intercept only the OS browser launcher. No real browser or backend is accessed.
  const preload = `import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events'; import { syncBuiltinESMExports } from 'node:module';
    const originalSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      const index = args.indexOf('-EncodedCommand');
      const script = index >= 0 ? Buffer.from(args[index + 1], 'base64').toString('utf16le') : '';
      if (script.includes('production.login.lock') && script.includes('GetAccessControl') && !script.includes('SetAccessControl'))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
      return originalSync(command, args, options);
    };
    childProcess.spawn = command => {
      if (!['rundll32.exe', 'open', 'xdg-open'].includes(command)) throw new Error('Unexpected spawn');
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); }); return child;
    }; syncBuiltinESMExports(); process.loadEnvFile = () => {};
    globalThis.fetch = () => { throw new Error('Live network forbidden'); };`;
  const client = new Client({ name: 'stdio-login-cleanup-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve(ROOT, 'dist/tests/fixtures/stdio-credentials.js')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      TOPMEDIAI_TOKEN: '', TOPMEDIAI_ENV: 'production', TOPMEDIAI_MODE: 'live', TOPMEDIAI_DATA_DIR: join(root, 'state'),
      TOPMEDIAI_PRODUCTION_WEB_ORIGIN: webOrigin, TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid',
      TOPMEDIAI_UPLOAD_ROOT: '', LOCALAPPDATA: root, USERPROFILE: root, HOME: root }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  t.after(async () => {
    await client.close();
    const rel = relative(parent, root); assert.ok(rel.startsWith('topmediai-login-flow-') && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const result = await client.callTool({ name: 'start_login', arguments: {} });
  assert.equal((result.structuredContent as any).status, 'waiting');
  const lock = process.platform === 'win32' ? join(root, 'TopMediai', 'credentials', 'production.login.lock')
    : join(root, '.local', 'share', 'topmediai', 'credentials', 'production.login.lock');
  assert.equal(existsSync(lock), true);
  await client.close(); assert.equal(existsSync(lock), false);
});


test('login wait exposes actionable system-store failure without claiming saved or reopening the website', async t => {
  const f = await fixture(t, { storeFailure: true });
  const started = await f.call('start_login');
  const response = await f.post();
  assert.equal(response.status, 503);
  const finished = await f.call('wait_for_login', { login_id: started.login_id, wait_seconds: 1 });
  assert.equal(finished.status, 'aborted');
  assert.equal(finished.credential_error.code, 'CREDENTIAL_STORE_DENIED');
  assert.match(finished.credential_error.message, /system credential store/);
  assert.equal(finished.continue_original_request, false);
  assert.ok(!JSON.stringify(finished).includes(token));
  assert.equal(f.calls.browser, 1); assert.equal(f.calls.balance, 0);
});
