import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, ROOT, type Config } from '../src/config.js';
import { ImageService } from '../src/service.js';
import { TopMediaiError, type ImageParams } from '../src/types.js';

const params: ImageParams = { description: 'Moonlit valley', model_type: 8, number: 1, quality: 8, image_quality: 0, aspect_ratio: 1 };
async function config(t: TestContext, env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(resolve(parent, 'topmediai-test-'));
  t.after(async () => {
    const rel = relative(parent, dir);
    assert.ok(rel.startsWith('topmediai-test-') && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  return loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_DATA_DIR: dir, ...env }, () => null);
}
function code(expected: string) {
  return (error: unknown) => error instanceof TopMediaiError && error.code === expected;
}
async function fixture(t: TestContext) {
  const calls: { path: string; method: string; token?: string; body?: any }[] = [];
  const state = { points: 2, version: 'v1', failSubmit: false, badBalance: false, pending: true };
  async function body(req: IncomingMessage) {
    let text = ''; for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : undefined;
  }
  const server = createHttpServer(async (req, res) => {
    calls.push({ path: req.url!, method: req.method!, token: req.headers.token as string, body: await body(req) });
    res.setHeader('Content-Type', 'application/json');
    // This temporary server must not leave a pooled connection when its port is released.
    res.setHeader('Connection', 'close');
    let data: unknown;
    if (req.url === '/v3/draw/model-consume') data = { version: state.version, list: [{ ...params, model_name: 'Nano Banana 2', points: state.points, version: state.version }] };
    else if (req.url?.startsWith('/user/permission/info')) {
      if (state.badBalance) { res.end(JSON.stringify({ status: 401, message: 'secret-token-do-not-echo' })); return; }
      data = { tp_all: { left: '88' } };
    } else if (req.url === '/v3/draw/text-to-image') {
      if (state.failSubmit) { req.socket.destroy(); return; }
      data = { group_id: '12345' };
    } else if (req.url === '/v3/draw/detail/12345') data = {
      group_id: '12345', image_data: [{ image_url: 'https://example.com/result.png' }], task_ids: state.pending ? ['remaining-task'] : [],
    };
    else { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ status: 200, data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cfg = await config(t, { TOPMEDIAI_MODE: 'live', TOPMEDIAI_TOKEN: 'a'.repeat(42), TOPMEDIAI_IMAGE_HOST: 'https://backend.fixture.invalid', TOPMEDIAI_MEMBER_HOST: 'https://backend.fixture.invalid' });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input);
    assert.equal(target.origin, cfg.imageHost, 'Only this isolated mock server may receive fixture requests');
    try { return await originalFetch(new URL(target.pathname + target.search, origin), init); }
    catch (error) {
      const cause = (error as { cause?: { code?: unknown } }).cause?.code;
      const known = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'];
      t.diagnostic(`Mock fetch failure category: ${typeof cause === 'string' && known.includes(cause) ? cause : 'unknown'}`);
      throw error;
    }
  });
  return { service: new ImageService(cfg), cfg, calls, state, origin };
}

test('concurrent replay and process restart issue exactly one backend POST', async t => {
  const { cfg, calls, state, origin } = await fixture(t); const first = new ImageService(cfg); const second = new ImageService(cfg);
  const quote = await first.estimate(params);
  const [a, b] = await Promise.all([first.generate(quote.quote_id, 'same-id', 2), second.generate(quote.quote_id, 'same-id', 2)]);
  const original = [a, b].find(result => !result.replayed)!, replay = [a, b].find(result => result.replayed)!;
  assert.equal(original.group_id, '12345'); assert.ok(['queued', 'submission_unknown'].includes(replay.status));
  if (replay.group_id) assert.equal(replay.group_id, original.group_id);
  assert.equal(Number(a.replayed) + Number(b.replayed), 1);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  state.pending = false;
  const task = await second.task('same-id'); assert.equal(task.status, 'completed');
  assert.equal(task.images[0]!.url, 'https://example.com/result.png');
  assert.equal(task.simulated, false);
});
test('budget, expired quote, conflicting request and unknown task reject safely', async t => {
  const { service, calls } = await fixture(t); const a = await service.estimate(params);
  await assert.rejects(service.generate(a.quote_id, 'id', 1), code('BUDGET_EXCEEDED'));
  assert.ok(!calls.some(call => call.method === 'POST'));
  await service.generate(a.quote_id, 'id', 2);
  const b = await service.estimate(params);
  await assert.rejects(service.generate(b.quote_id, 'id', 2), code('REQUEST_ID_CONFLICT'));
  await service.store.transaction(async state => { state.quotes[b.quote_id]!.expires_at = new Date(0).toISOString(); await service.store.save(state); });
  await assert.rejects(service.generate(b.quote_id, 'new-id', 2), code('QUOTE_EXPIRED'));
  await assert.rejects(service.task('unknown'), code('TASK_NOT_FOUND'));
});
test('unsupported model combination is not quoted', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.estimate({ ...params, quality: 4 }), code('UNSUPPORTED_OPTIONS'));
});
test('reserved object keys remain ordinary persistent request IDs', async t => {
  const { cfg, service, calls } = await fixture(t); const quote = await service.estimate(params);
  await service.generate(quote.quote_id, '__proto__', 2);
  assert.equal((await new ImageService(cfg).generate(quote.quote_id, '__proto__', 2)).replayed, true);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
test('live payload uses existing business billing and handles partially finished image groups', async t => {
  const { service, calls, state } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  assert.equal((await service.balance()).credits, 88);
  const quote = await service.estimate(params); await service.generate(quote.quote_id, 'live-1', 2);
  const post = calls.filter(call => call.method === 'POST'); assert.equal(post.length, 1);
  assert.equal(post[0]!.path, '/v3/draw/text-to-image'); assert.equal(post[0]!.token, 'a'.repeat(42));
  assert.deepEqual(post[0]!.body, { ...params, source: 4, translation: 0, is_public: 0, web_search: 0 });
  const partial = await service.task('live-1'); assert.equal(partial.status, 'running'); assert.equal(partial.images.length, 1);
  assert.equal(partial.poll_after_seconds, 20);
  state.pending = false;
  const cached = await service.task('live-1');
  assert.equal(cached.status, 'running'); assert.equal(cached.cached, true); assert.equal(cached.poll_after_seconds, 20);
  t.mock.timers.tick(19999);
  assert.equal((await new ImageService(service.config).task('live-1')).poll_after_seconds, 1);
  assert.equal(calls.filter(call => call.path === '/v3/draw/detail/12345').length, 1);
  t.mock.timers.tick(1);
  const completed = await service.task('live-1');
  assert.equal(completed.status, 'completed'); assert.equal(completed.poll_after_seconds, undefined);
  assert.equal(calls.filter(call => call.path === '/v3/draw/detail/12345').length, 2);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.path), ['/v3/draw/text-to-image']);
  assert.ok(!(await readFile(resolve(service.store.dir, 'store.json'), 'utf8')).includes('a'.repeat(42)));
});
test('image generation submits without a global paid opt-in', async t => {
  const f = await fixture(t);
  const quote = await f.service.estimate(params);
  const task = await f.service.generate(quote.quote_id, 'without-paid-switch', 2);
  assert.equal(task.status, 'queued');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(!('paid_generation_enabled' in f.service.status()));
});
test('updated price blocks submission until a new quote', async t => {
  const f = await fixture(t); const quote = await f.service.estimate(params); f.state.points = 3;
  await assert.rejects(f.service.generate(quote.quote_id, 'changed', 2), code('PRICE_CHANGED'));
  assert.ok(!f.calls.some(call => call.method === 'POST'));
});
test('lost paid submit response is persisted and never posted a second time', async t => {
  const f = await fixture(t); const quote = await f.service.estimate(params); f.state.failSubmit = true;
  await assert.rejects(f.service.generate(quote.quote_id, 'uncertain', 2), code('SUBMISSION_UNKNOWN'));
  const result = await new ImageService(f.cfg).generate(quote.quote_id, 'uncertain', 2);
  assert.equal(result.status, 'submission_unknown'); assert.equal(result.replayed, true);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
test('HTTP 200 with business error fails without echoing backend message', async t => {
  const f = await fixture(t); f.state.badBalance = true;
  await assert.rejects(f.service.balance(), (error: unknown) => {
    assert.ok(error instanceof TopMediaiError); assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.ok(!error.message.includes('secret-token')); return true;
  });
});
test('state corruption fails closed instead of dropping recorded tasks', async t => {
  const { service } = await fixture(t); await service.estimate(params);
  await writeFile(resolve(service.store.dir, 'store.json'), '{broken');
  await assert.rejects(service.task('existing-id'), code('STORE_CORRUPT'));
});
test('account namespaces differ and unsafe host configurations fail', () => {
  assert.notEqual(loadConfig({ TOPMEDIAI_MODE: 'live', TOPMEDIAI_TOKEN: 'a'.repeat(42) }).dataDir,
    loadConfig({ TOPMEDIAI_MODE: 'live', TOPMEDIAI_TOKEN: 'b'.repeat(42) }).dataDir);
  assert.throws(() => loadConfig({ TOPMEDIAI_IMAGE_HOST: 'http://example.com' }, () => null), code('INVALID_CONFIG'));
  assert.throws(() => loadConfig({ TOPMEDIAI_IMAGE_HOST: 'https://user:password@example.com' }, () => null), code('INVALID_CONFIG'));
});
test('stdio MCP preserves image tools and discovers multimedia tools with the real entry point', async t => {
  const { cfg, calls, state, origin } = await fixture(t);
  const client = new Client({ name: 'test-client', version: '1.0' });
  // Exercise the real entry point without opening the developer's .env or contacting a real API.
  const preload = `process.loadEnvFile = () => {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== ${JSON.stringify(cfg.imageHost)}) throw new Error('Only mocked production requests are allowed');
      return originalFetch(new URL(url.pathname + url.search, ${JSON.stringify(origin)}), init);
    };`;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve(ROOT, 'dist/src/index.js')],
    env: { TOPMEDIAI_MODE: 'live', TOPMEDIAI_ENV: 'production', TOPMEDIAI_TOKEN: cfg.token,
      TOPMEDIAI_IMAGE_HOST: cfg.imageHost, TOPMEDIAI_MEMBER_HOST: cfg.memberHost,
      TOPMEDIAI_ALLOW_PAID_GENERATION: 'false', TOPMEDIAI_DATA_DIR: resolve(cfg.dataDir, 'protocol'),
      LOCALAPPDATA: cfg.dataDir, APPDATA: cfg.dataDir, HOME: cfg.dataDir, USERPROFILE: cfg.dataDir } });
  await client.connect(transport); t.after(() => client.close());
  assert.equal(client.getServerVersion()?.version, '1.0.0');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 35);
  assert.ok(tools.some(tool => tool.name === 'upload_reference_image'));
  for (const name of ['generate_music', 'generate_video', 'list_voices', 'get_generation_task', 'get_video_entitlements']) assert.ok(tools.some(tool => tool.name === name));
  const caps = (await client.callTool({ name: 'get_generation_capabilities', arguments: {} })).structuredContent as any;
  assert.equal(caps.capabilities.find((c: any) => c.kind === 'tts').generation_enabled, true);
  const unsafe = await client.callTool({ name: 'estimate_music_cost', arguments: { action: 'auto', mv: 'v5.5', style: 'Test', scheme: 13 } }); assert.equal(unsafe.isError, true);
  const bad = await client.callTool({ name: 'get_image_task', arguments: { request_id: '../escape' } }); assert.equal(bad.isError, true);
  const invalid = await client.callTool({ name: 'estimate_image_cost', arguments: { ...params, number: 9 } }); assert.equal(invalid.isError, true);
  const quote = (await client.callTool({ name: 'estimate_image_cost', arguments: { ...params } })).structuredContent as Record<string, unknown>;
  const beforeReview = calls.filter(call => call.method === 'POST').length;
  const plan = await client.callTool({ name: 'review_generation_plan', arguments: { flow_id: 'protocol-flow', steps: [{ kind: 'image', quote_id: quote.quote_id }] } });
  assert.equal(plan.isError, undefined); assert.equal((plan.structuredContent as any).confirmation_required, false);
  assert.equal(calls.filter(call => call.method === 'POST').length, beforeReview, 'review must not submit paid work');
  const submit = await client.callTool({ name: 'generate_image', arguments: { quote_id: quote.quote_id, request_id: 'protocol', max_credits: 2 } });
  assert.equal(submit.isError, undefined); assert.equal((submit.structuredContent as Record<string, unknown>).simulated, false);
  const repeat = await client.callTool({ name: 'generate_image', arguments: { quote_id: quote.quote_id, request_id: 'protocol', max_credits: 2 } });
  assert.equal((repeat.structuredContent as Record<string, unknown>).replayed, true);
  state.pending = false;
  const task = await client.callTool({ name: 'get_image_task', arguments: { request_id: 'protocol' } });
  assert.equal((task.structuredContent as Record<string, unknown>).status, 'completed');
  assert.equal((task.structuredContent as any).display.actual_consumption.status, 'not_returned');
  assert.equal((task.structuredContent as any).display.model.name, 'Nano Banana 2');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('image cooldown starts after a successful response and a failed query does not start it', async t => {
  const { service } = await fixture(t), quote = await service.estimate(params);
  const submitted = await service.generate(quote.quote_id, 'image-cooldown', 2);
  assert.equal(submitted.poll_after_seconds, 20);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let polls = 0;
  t.mock.method(service.backend, 'detail', async () => {
    if (++polls === 1) throw new TopMediaiError('BACKEND_UNAVAILABLE', 'Fixture query failed');
    t.mock.timers.tick(7000);
    return { status: 'running' as const, images: [] };
  });
  await assert.rejects(service.task('image-cooldown'), code('BACKEND_UNAVAILABLE'));
  assert.equal(await service.store.transaction(async state => state.tasks['image-cooldown']!.last_polled_at), undefined);
  assert.equal(await service.store.transaction(async state => state.tasks['image-cooldown']!.poll_in_flight_until), undefined);
  assert.equal((await service.task('image-cooldown')).poll_after_seconds, 20);
  assert.equal(polls, 2);
  t.mock.timers.tick(19999);
  await service.task('image-cooldown', false);
  const cached = await service.task('image-cooldown');
  assert.equal(cached.cached, true); assert.equal(cached.poll_after_seconds, 1); assert.equal(polls, 2);
  t.mock.timers.tick(1);
  assert.equal((await service.task('image-cooldown')).poll_after_seconds, 20); assert.equal(polls, 3);
});

test('image quotes allow real zero but cannot submit twice under different request IDs', async t => {
  const { service, calls, state } = await fixture(t); state.points = 0;
  const quote = await service.estimate(params);
  assert.equal(quote.credits, 0); assert.equal(quote.display.estimated_costs[0]?.amount, 0);
  await service.generate(quote.quote_id, 'free-original', 0);
  await assert.rejects(service.generate(quote.quote_id, 'free-duplicate', 0), code('QUOTE_USED'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  for (const unknown of ['   ', []]) {
    state.points = unknown as unknown as number;
    await assert.rejects(service.estimate(params), code('INVALID_RESPONSE'));
  }
});

test('missing stored image cost and invalid budgets stop before any paid submission', async t => {
  const { service, calls } = await fixture(t), quote = await service.estimate(params);
  await assert.rejects(service.generate(quote.quote_id, 'bad-budget', NaN), code('BUDGET_EXCEEDED'));
  await service.store.transaction(async state => { state.quotes[quote.quote_id]!.credits = null as unknown as number; await service.store.save(state); });
  await assert.rejects(service.generate(quote.quote_id, 'unknown-price', 100), code('PRICE_UNAVAILABLE'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('expired image links can re-query the original completed task without another paid request', async t => {
  const { service, calls, state } = await fixture(t), quote = await service.estimate(params);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await service.generate(quote.quote_id, 'recover-original', 2); state.pending = false;
  await service.task('recover-original');
  await service.store.transaction(async state => { state.tasks['recover-original']!.images = [{ url: 'https://example.com/old.png', mime_type: 'image/png' }]; await service.store.save(state); });
  assert.equal((await service.task('recover-original')).images[0]?.url, 'https://example.com/old.png');
  const cached = await service.task('recover-original', true, true);
  assert.equal(cached.cached, true); assert.equal(cached.poll_after_seconds, 20);
  assert.equal(calls.filter(call => call.path === '/v3/draw/detail/12345').length, 1);
  t.mock.timers.tick(20000);
  const recovered = await service.task('recover-original', true, true);
  assert.equal(recovered.images[0]?.url, 'https://example.com/result.png');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
test('production configuration targets official APIs and rejects the removed simulation mode', async t => {
  const cfg = await config(t);
  assert.equal(cfg.mode, 'live'); assert.equal(cfg.environment, 'production');
  assert.equal(cfg.memberHost, 'https://topmediai-member-api.imyfone.com');
  assert.equal(cfg.imageHost, 'https://ai-api.imyfone.com');
  const service = new ImageService(cfg);
  assert.equal(service.status().simulated, false); assert.equal(service.status().token_configured, false);
  await assert.rejects(service.balance(), code('LOGIN_REQUIRED'));
  assert.throws(() => loadConfig({ TOPMEDIAI_MODE: 'mock' }), code('INVALID_CONFIG'));
});
