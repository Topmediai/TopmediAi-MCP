import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';
import { createRuntimeConfigLoader, ROOT } from '../src/config.js';
import { type Credential } from '../src/credentials.js';
import { checkPluginServer } from '../src/install-check.js';
import { TopMediaiError } from '../src/types.js';

const tokenA = 'A'.repeat(42), tokenB = 'B'.repeat(42);
const image = { description: 'A cat by the window', model_type: 8, number: 1, quality: 8, image_quality: 0, aspect_ratio: 1 };
const credential = (token: string): Credential => ({ format_version: 1, environment: 'production', token,
  member_id: token === tokenA ? '101' : '202', email_masked: 'u***@example.test', obtained_at: new Date().toISOString(), token_expires_at: null });

async function directory(t: TestContext) {
  const parent = tmpdir(), root = await mkdtemp(resolve(parent, 'topmediai-runtime-'));
  t.after(async () => { const rel = relative(parent, root); assert.ok(rel.startsWith('topmediai-runtime-') && !rel.startsWith('..') && !isAbsolute(rel)); await rm(root, { recursive: true, force: true }); });
  return root;
}

async function fixture(t: TestContext) {
  const root = await directory(t);
  let saved: Credential | null = null, corrupt = false;
  const env = { TOPMEDIAI_ENV: 'production', TOPMEDIAI_TOKEN: '', TOPMEDIAI_DATA_DIR: root,
    TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid', TOPMEDIAI_IMAGE_HOST: 'https://image.fixture.invalid',
    TOPMEDIAI_TTS_HOST: 'https://tts.fixture.invalid', TOPMEDIAI_MUSIC_HOST: 'https://music.fixture.invalid' };
  const reload = createRuntimeConfigLoader(env, environment => {
    assert.equal(environment, 'production');
    if (corrupt) throw new TopMediaiError('CREDENTIAL_CORRUPT', 'The saved credential is invalid.');
    return saved;
  });
  const server = createServer(reload(), reload), client = new Client({ name: 'runtime-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const calls: { path: string; token: string | null; method: string }[] = [];
  let priceHook: (() => Promise<void>) | undefined, rejectedToken: string | undefined;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok([env.TOPMEDIAI_MEMBER_HOST, env.TOPMEDIAI_IMAGE_HOST, env.TOPMEDIAI_TTS_HOST].includes(url.origin), 'Only isolated mock endpoints are allowed');
    const token = new Headers(init?.headers).get('token');
    calls.push({ path: url.pathname, token, method: init?.method ?? 'GET' });
    if (token === rejectedToken) return new Response(JSON.stringify({ private_detail: 'Never expose this upstream body' }), { status: 401 });
    let data: unknown;
    if (url.pathname === '/v3/draw/model-consume') {
      if (priceHook) await priceHook();
      data = { list: [{ ...image, model_name: 'Nano Banana 2', points: 2, version: 'v1' }] };
    } else if (url.pathname === '/user/permission/info') data = { tp_all: { left: token === tokenA ? 88 : 44 } };
    else if (url.pathname === '/v3/draw/text-to-image') data = { group_id: '12345' };
    else if (url.pathname === '/v3/voice/list') data = [{ voice_id: 'public1', voice_name: 'Fixture voice' }];
    else if (url.pathname === '/v3/voice/detail') data = { voice_id: 'public1', voice_name: 'Fixture voice' };
    else throw new Error('Unexpected mock route');
    return new Response(JSON.stringify({ status: 200, data }), { headers: { 'Content-Type': 'application/json' } });
  });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { env, calls, call, setCredential: (value: Credential | null) => { saved = value; },
    setCorrupt: (value: boolean) => { corrupt = value; }, setPriceHook: (hook: () => Promise<void>) => { priceHook = hook; },
    rejectToken: (value: string) => { rejectedToken = value; } };
}

function content(result: Awaited<ReturnType<Client['callTool']>>): any { return result.structuredContent; }
function error(result: Awaited<ReturnType<Client['callTool']>>): any {
  assert.equal(result.isError, true);
  const block = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text');
  return JSON.parse(block!.text!);
}

test('one MCP connection handles missing login, new login, creation and local logout', async t => {
  const f = await fixture(t);
  const initial = content(await f.call('get_service_status'));
  assert.equal(initial.authentication_state, 'login_required');
  assert.equal(initial.credential_refresh_enabled, true);
  assert.equal(initial.login_guidance.restart_required, false);
  assert.equal(initial.login_guidance.fallback_allowed, false);
  const missing = error(await f.call('get_balance'));
  assert.equal(missing.error.code, 'LOGIN_REQUIRED'); assert.equal(missing.login_guidance.restart_required, false);
  assert.equal(f.calls.length, 0);
  f.setCredential(credential(tokenA));
  assert.equal(content(await f.call('get_service_status')).credential_source, 'system-store');
  assert.equal(content(await f.call('get_balance')).credits, 88);
  const quote = content(await f.call('estimate_image_cost', image));
  assert.equal(content(await f.call('generate_image', { quote_id: quote.quote_id, request_id: 'after-login', max_credits: 2 })).group_id, '12345');
  f.setCredential(null);
  assert.equal(content(await f.call('get_service_status')).token_configured, false);
  const before = f.calls.length;
  assert.equal(error(await f.call('get_balance')).error.code, 'LOGIN_REQUIRED');
  assert.equal(f.calls.length, before); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('account changes isolate quotes, while unchanged credentials preserve voice discovery', async t => {
  const f = await fixture(t); f.setCredential(credential(tokenA));
  const quote = content(await f.call('estimate_image_cost', image));
  await f.call('list_voices'); await f.call('get_service_status');
  assert.equal(content(await f.call('get_voice_detail', { voice_id: 'public1' })).voice_id, 'public1');
  f.setCredential(credential(tokenB));
  assert.equal(content(await f.call('get_balance')).credits, 44);
  assert.equal(error(await f.call('generate_image', { quote_id: quote.quote_id, request_id: 'wrong-account', max_credits: 2 })).error.code, 'QUOTE_NOT_FOUND');
  assert.equal(error(await f.call('get_voice_detail', { voice_id: 'public1' })).error.code, 'VOICE_NOT_LISTED');
  assert.ok(!f.calls.some(call => call.path === '/v3/draw/text-to-image'));
});

test('an in-flight paid request keeps its original credential during an account switch', async t => {
  const f = await fixture(t); f.setCredential(credential(tokenA));
  const quote = content(await f.call('estimate_image_cost', image));
  let notifyPrice!: () => void, releasePrice!: () => void;
  const entered = new Promise<void>(resolve => { notifyPrice = resolve; });
  const released = new Promise<void>(resolve => { releasePrice = resolve; });
  f.setPriceHook(async () => { notifyPrice(); await released; });
  const submitting = f.call('generate_image', { quote_id: quote.quote_id, request_id: 'in-flight', max_credits: 2 });
  await entered;
  try { f.setCredential(credential(tokenB)); assert.equal(content(await f.call('get_balance')).credits, 44); }
  finally { releasePrice(); }
  assert.equal(content(await submitting).group_id, '12345');
  assert.equal(f.calls.find(call => call.path === '/v3/draw/text-to-image')?.token, tokenA);
  assert.equal(error(await f.call('get_image_task', { request_id: 'in-flight' })).error.code, 'TASK_NOT_FOUND');
});

test('corrupt refreshed credentials fail closed instead of sending the previous token', async t => {
  const f = await fixture(t); f.setCredential(credential(tokenA)); await f.call('get_balance');
  f.setCorrupt(true); const before = f.calls.length;
  const failed = error(await f.call('get_balance'));
  assert.equal(failed.error.code, 'CREDENTIAL_CORRUPT'); assert.equal(f.calls.length, before);
  assert.ok(!JSON.stringify(failed).includes(tokenA));
  f.setCorrupt(false); f.setCredential(credential(tokenB));
  assert.equal(content(await f.call('get_balance')).credits, 44);
});

test('backend login expiry gives website login guidance without retrying or exposing upstream content', async t => {
  const f = await fixture(t); f.setCredential(credential(tokenA)); f.rejectToken(tokenA);
  assert.equal(content(await f.call('get_service_status')).token_configured, true);
  const expired = error(await f.call('get_balance'));
  assert.equal(expired.error.code, 'LOGIN_REQUIRED'); assert.equal(expired.login_guidance.restart_required, false);
  assert.equal(expired.login_guidance.fallback_allowed, false); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(expired).includes('private_detail') && !JSON.stringify(expired).includes(tokenA));
  f.setCredential(credential(tokenB));
  assert.equal(content(await f.call('get_balance')).credits, 44); assert.equal(f.calls.length, 2);
});

test('runtime credential refresh freezes launch settings and respects explicit development overrides', () => {
  let saved: Credential | null = null, reads = 0;
  const env = { TOPMEDIAI_TOKEN: '', TOPMEDIAI_SOURCE: '1', TOPMEDIAI_ENV: 'production' };
  const reload = createRuntimeConfigLoader(env, () => { reads++; return saved; });
  const anonymous = reload(); saved = credential(tokenA);
  env.TOPMEDIAI_TOKEN = tokenB; env.TOPMEDIAI_SOURCE = '4'; env.TOPMEDIAI_ENV = 'production';
  const loggedIn = reload();
  assert.equal(loggedIn.token, tokenA); assert.equal(loggedIn.environment, 'production'); assert.equal(loggedIn.source, 1);
  assert.notEqual(loggedIn.dataDir, anonymous.dataDir);
  const overridden = createRuntimeConfigLoader({ TOPMEDIAI_TOKEN: tokenB }, () => { throw new Error('Must not read saved credentials'); });
  assert.equal(overridden().token, tokenB); assert.equal(overridden().credentialSource, 'environment'); assert.equal(reads, 2);
});

function isolatedLaunch(root: string) {
  const preload = `process.loadEnvFile = () => {}; globalThis.fetch = () => { throw new Error('Live network forbidden'); };`;
  return { command: process.execPath, args: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve(ROOT, 'dist/tests/fixtures/stdio-credentials.js')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      TOPMEDIAI_TOKEN: '', TOPMEDIAI_ENV: 'production', TOPMEDIAI_MODE: 'live', TOPMEDIAI_DATA_DIR: join(root, 'state'),
      TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid', TOPMEDIAI_IMAGE_HOST: 'https://image.fixture.invalid',
      TOPMEDIAI_MUSIC_HOST: 'https://music.fixture.invalid', TOPMEDIAI_TTS_HOST: 'https://tts.fixture.invalid',
      TOPMEDIAI_UPLOAD_ROOT: '', TOPMEDIAI_SOURCE: '4',
      LOCALAPPDATA: root, USERPROFILE: root, HOME: root }, stderr: 'pipe' as const };
}

test('stdio runtime reloads injected credentials after save and delete without reconnecting', async t => {
  const root = await directory(t), launch = isolatedLaunch(root);
  const client = new Client({ name: 'saved-credential-test', version: '1' });
  const transport = new StdioClientTransport(launch); transport.stderr?.on('data', () => {});
  await client.connect(transport); t.after(() => client.close());
  const status = async () => content(await client.callTool({ name: 'get_service_status', arguments: {} }));
  assert.equal((await status()).token_configured, false);
  const controlFile = join(root, 'state', 'fixture-credential.json');
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(controlFile, JSON.stringify(credential(tokenA)));
  const saved = await status(); assert.equal(saved.token_configured, true); assert.equal(saved.credential_source, 'system-store');
  assert.equal(saved.login_guidance.restart_required, false); assert.ok(!JSON.stringify(saved).includes(tokenA));
  await unlink(controlFile);
  assert.equal((await status()).token_configured, false);
});

test('installation self-check verifies MCP tools without claiming current chat or account readiness', async t => {
  const root = await directory(t);
  const check = await checkPluginServer(isolatedLaunch(root));
  assert.equal(check.server_version, '1.0.0'); assert.equal(check.tool_count, 35);
  assert.equal(check.credential_refresh_enabled, true); assert.equal(check.token_configured, false);
  assert.equal(check.current_chat_tools_verified, false); assert.equal(check.backend_account_verified, false);
});

test('stdio handshake and recovery tools remain available when stored credentials are corrupt', async t => {
  const root = await directory(t), launch = isolatedLaunch(root);
  await mkdir(join(root, 'state'), { recursive: true });
  const controlFile = join(root, 'state', 'fixture-credential.json');
  await writeFile(controlFile, '{broken');
  const client = new Client({ name: 'credential-recovery-test', version: '1' });
  const transport = new StdioClientTransport(launch); transport.stderr?.on('data', () => {});
  await client.connect(transport); t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'start_login'));
  const failed = error(await client.callTool({ name: 'get_balance', arguments: {} }));
  assert.equal(failed.error.code, 'CREDENTIAL_CORRUPT');
  await writeFile(controlFile, JSON.stringify(credential(tokenA)));
  const recovered = content(await client.callTool({ name: 'get_service_status', arguments: {} }));
  assert.equal(recovered.token_configured, true); assert.equal(recovered.credential_source, 'system-store');
});
