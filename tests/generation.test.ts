import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { loadConfig } from '../src/config.js';
import { productionEnvironment } from './fixtures/production.js';
import { TopMediaiError } from '../src/types.js';
import { GenerationService } from '../src/generation/service.js';
import { MusicAdapter, musicSchema } from '../src/generation/music.js';
import { VideoAdapter, videoSchema } from '../src/generation/video.js';
import { VoiceCatalog } from '../src/generation/voices.js';
import { BusinessTransport, identity, numeric } from '../src/transport/business.js';
import { resultArtifact } from '../src/media/result.js';
import type { Outcome } from '../src/generation/types.js';

const music = { action: 'auto', mv: 'v6-mini', style: 'Warm acoustic instrumental', instrumental: true };
const video = { content: 'Clouds over a mountain', model_type: 21, duration: 34, mode: 38 };
const code = (expected: string) => (error: unknown) => error instanceof TopMediaiError && error.code === expected;
async function config(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const parent = tmpdir(), dir = await mkdtemp(resolve(parent, 'topmediai-generation-'));
  t.after(async () => { const path = relative(parent, dir); assert.ok(path.startsWith('topmediai-generation-') && !isAbsolute(path) && !path.startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  return loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_DATA_DIR: dir, TOPMEDIAI_TOKEN: 'S'.repeat(42), ...env }, () => null);
}
async function fixture(t: TestContext, environment: 'production' | 'production' = 'production') {
  const cfg = await config(t, { ...(environment === 'production' ? productionEnvironment : {}), TOPMEDIAI_MUSIC_HOST: 'https://music.fixture.invalid', TOPMEDIAI_TTS_HOST: 'https://tts.fixture.invalid', TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid' });
  const calls: { path: string; method: string; body?: any; headers: Headers }[] = [];
  const state = { musicCost: 4, videoCost: 1.8, priceVersion: '2026-A', musicIds: ['9001', '9002'], songRows: [{ id: '9001', status: 0, audio_url: 'https://media.fixture.invalid/a.mp3' }, { id: '9002', status: 2, audio_url: '' }], failSubmit: false, foreignVideo: false, videoUrl: 'https://media.fixture.invalid/result.mp4' };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok([cfg.musicHost, cfg.ttsHost, cfg.memberHost].includes(url.origin), 'No live endpoints allowed');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers), method = init?.method ?? 'GET';
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname + url.search, method, body, headers });
    if (url.origin === cfg.musicHost) { assert.equal(headers.get('authorization'), `Bearer ${cfg.token}`); assert.equal(headers.get('token'), null); }
    else { assert.equal(headers.get('token'), cfg.token); assert.equal(headers.get('authorization'), null); }
    assert.equal(headers.get('cookie'), null);
    let data: unknown;
    if (url.pathname === '/v2/music/generation-prices') data = { current_price_version: state.priceVersion, price_versions: [{ price_version: state.priceVersion, new_pricing_rules: { model_unit_credits: { 'v6-mini': 2, 'v6-pro': 4 } } }] };
    else if (url.pathname === '/v2/music/generation-price') { assert.equal(url.searchParams.get('has_persona'), '0'); data = { price_version: state.priceVersion, legacy_credits_cost: 2, new_credits_cost: state.musicCost, scheme: 1 }; }
    else if (url.pathname === '/v2/user/right') data = { result: { left: 20, tp_all: { left: 40 }, user_id: 'private-member-id' } };
    else if (url.pathname === '/v2/async/text-to-song') { if (state.failSubmit) throw new Error('synthetic upstream secret'); data = { song_ids: state.musicIds }; }
    else if (url.pathname === '/v2/task/results') data = { result: state.songRows };
    else if (url.pathname === '/user/permission/info') { assert.equal(url.searchParams.get('product_name'), 'ai_video'); data = { ai_video: { left: 50 }, tp_all: { left: 100 }, member_id: 'private-member-id' }; }
    else if (url.pathname === '/ai_video/price/model_cost') data = { models: [{ model_type: 21, model_name: 'Pro', pricing: [{ model_type: 21, duration: 34, duration_seconds: 5, mode: 38, quality: '720', version: state.priceVersion, consume: state.videoCost, points: 2 }, { duration: 37, duration_seconds: 15, mode: 50, version: state.priceVersion, consume: 1, points: 1 }] }] };
    else if (url.pathname === '/ai_video/price/preview') data = { ...body, consume: state.videoCost, points: 99, version: state.priceVersion, price_rule_id: 71 };
    else if (url.pathname === '/ai_video/consume_preview') data = { ...body, consume: state.videoCost, points: 2 };
    else if (url.pathname === '/ai_video/generation') data = { task_id: '8001' };
    else if (url.pathname === '/ai_video/batch/detail') { assert.equal(url.searchParams.get('task_ids'), '8001'); data = { data_list: [{ task_id: state.foreignVideo ? '9999' : '8001', task_status: 2, status: 0, audio_url: state.videoUrl }] }; }
    else if (url.pathname === '/v3/voice/list') data = [{ voice_id: 'public_voice_1', voice_name: 'Alice', accent: ['English'], internal_secret: 'not-returned' }, { voice_id: 'c'.repeat(32), voice_name: 'Private clone' }];
    else if (url.pathname === '/v3/voice/detail') data = { voice_id: body.voice_id, voice_name: 'Alice', accent: ['English'], emotion: [{ name: 'Default', show_name: 'Default' }], internal_secret: 'not-returned' };
    else assert.fail(`Unexpected fixture route ${url.pathname}`);
    return new Response(JSON.stringify({ status: 200, check_code: 200000, data }), { headers: { 'Content-Type': 'application/json' } });
  });
  return { cfg, calls, state, service: new GenerationService(cfg) };
}

test('production music uses Bearer JSON, backend totals, multiple owned songs and durable replay', async t => {
  const { service, cfg, calls } = await fixture(t, 'production');
  assert.deepEqual((await service.adapter('music').models() as any).models.map((m: any) => m.mv), ['v6-pro', 'v6-wild-pro', 'v6-mini']);
  assert.deepEqual(await new MusicAdapter(cfg).entitlements(), { music_credits: 20, credits: 40 });
  const quote = await service.estimate('music', music);
  assert.deepEqual(quote.costs, [{ resource: 'music_credits', amount: 2 }, { resource: 'credits', amount: 4 }]);
  await assert.rejects(service.generate('music', quote.quote_id, 'music1', { credits: 4 }), code('BUDGET_EXCEEDED'));
  const task = await service.generate('music', quote.quote_id, 'music1', { credits: 4, music_credits: 2 });
  assert.equal(task.poll_after_seconds, 20);
  assert.deepEqual(task.remote.song_ids, ['9001', '9002']);
  const body = calls.find(c => c.path === '/v2/async/text-to-song')!.body;
  assert.equal(body.instrumental, 1); assert.equal(body.is_public, 0); assert.equal(body.style_optimization, 0);
  assert.equal(body.user_id, undefined); assert.equal(body.scheme, undefined);
  const partial = await service.task(task.task_handle);
  assert.equal(partial.status, 'partially_completed'); assert.equal(partial.poll_after_seconds, 20);
  assert.equal((await new GenerationService(cfg).generate('music', quote.quote_id, 'music1', {})).task_handle, task.task_handle);
  assert.equal(calls.filter(c => c.path === '/v2/async/text-to-song').length, 1);
  await assert.rejects(service.generate('music', quote.quote_id, 'another', { credits: 4, music_credits: 2 }), code('QUOTE_USED'));
});

test('production video uses duration enums, exact price and authenticated account-filtered batch results', async t => {
  const { service, cfg, calls, state } = await fixture(t, 'production');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  assert.deepEqual(await new VideoAdapter(cfg).entitlements(), { video_units: 50, credits: 100 });
  const models = await service.adapter('video').models() as any;
  const pro = models.models.find((model: any) => model.model_type === 21);
  assert.equal(pro.pricing.length, 1); assert.equal(pro.pricing[0].duration_seconds, 5);
  const quote = await service.estimate('video', video);
  assert.deepEqual(quote.costs, [{ resource: 'video_units', amount: 1.8 }, { resource: 'credits', amount: 2 }]);
  const task = await service.generate('video', quote.quote_id, 'video1', { video_units: 1.8, credits: 2 });
  const body = calls.find(c => c.path === '/ai_video/generation')!.body;
  assert.equal(body.model_type, 21); assert.equal(body.duration, 34); assert.equal(body.real_duration, 5); assert.equal(body.generate_audio_switch, '0'); assert.equal(body.is_public, '0');
  const queryStart = calls.length;
  const done = await service.task(task.task_handle); assert.equal(done.status, 'completed'); assert.equal(done.artifacts[0]?.kind, 'video');
  assert.deepEqual(calls.slice(queryStart).map(c => c.path), ['/ai_video/batch/detail?task_ids=8001']);
  state.foreignVideo = true;
  const cached = await new GenerationService(cfg).task(task.task_handle);
  assert.equal(cached.status, 'completed'); assert.equal(cached.cached, true); assert.equal(cached.poll_after_seconds, 20);
  assert.equal(calls.filter(c => c.path.startsWith('/ai_video/batch/detail?')).length, 1);
  t.mock.timers.tick(20000);
  await assert.rejects(service.task(task.task_handle), code('INVALID_RESPONSE'));
});

test('completed legacy video tasks resolve encrypted media on an owned query without resubmission', async t => {
  const { service, cfg, calls, state } = await fixture(t);
  state.videoUrl = 'VyScHU4/TTXDuPra5/t5KAvSx6GnZPAMU/S/MFjbGuf8Hf47IJkvpGjlhnONmnaN';
  const quote = await service.estimate('video', video);
  const task = await service.generate('video', quote.quote_id, 'legacy-video', { video_units: 1.8, credits: 2 });
  await service.store.transaction(async saved => {
    const legacy = saved.generation_tasks![task.request_id]!;
    legacy.status = 'completed';
    legacy.artifacts = [resultArtifact(state.videoUrl, 'video', 'video/mp4')!];
    await service.store.save(saved);
  });
  const queryStart = calls.length;
  const done = await new GenerationService(cfg).task(task.task_handle);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.artifacts, [{ kind: 'video', url: 'https://media.fixture.invalid/result.mp4', mime_type: 'video/mp4' }]);
  assert.equal(calls.filter(c => c.path === '/ai_video/generation').length, 1);
  assert.equal(calls.filter(c => c.path.startsWith('/ai_video/batch/detail?')).length, 1);
  assert.deepEqual(calls.slice(queryStart).map(c => c.path), ['/ai_video/batch/detail?task_ids=8001']);
});

test('unresolved completed video media remains completed and never triggers another generation', async t => {
  const { service, calls, state } = await fixture(t);
  state.videoUrl = 'YWJjZGVmZ2hpamtsbW5vcA==';
  const quote = await service.estimate('video', video);
  const task = await service.generate('video', quote.quote_id, 'unresolved-video', { video_units: 1.8, credits: 2 });
  const done = await service.task(task.task_handle);
  assert.equal(done.status, 'completed');
  assert.equal(done.artifacts[0]?.url, undefined);
  assert.equal(done.artifacts[0]?.encoded_reference, state.videoUrl);
  assert.equal(calls.filter(c => c.path === '/ai_video/generation').length, 1);
});

test('price changes block before a paid request even if the version is unchanged', async t => {
  const { service, state, calls } = await fixture(t);
  const quote = await service.estimate('music', music); state.musicCost = 6;
  await assert.rejects(service.generate('music', quote.quote_id, 'changed', { credits: 100, music_credits: 100 }), code('PRICE_CHANGED'));
  assert.ok(!calls.some(c => c.path === '/v2/async/text-to-song'));
});

test('missing music routes cannot generate; request IDs cannot change meaning', async t => {
  const { cfg, service, calls } = await fixture(t);
  const quote = await service.estimate('music', music);
  await assert.rejects(new GenerationService({ ...cfg, musicHost: undefined }).generate('music', quote.quote_id, 'disabled', { credits: 10, music_credits: 10 }), code('GENERATION_DISABLED'));
  assert.ok(!calls.some(c => c.path === '/v2/async/text-to-song'));
  await service.generate('music', quote.quote_id, 'used', { credits: 10, music_credits: 10 });
  const next = await service.estimate('music', music);
  await assert.rejects(service.generate('music', next.quote_id, 'used', { credits: 10, music_credits: 10 }), code('IDEMPOTENCY_CONFLICT'));
});

test('uncertain submission persists across restart and never exposes the upstream error or retries', async t => {
  const { service, cfg, state, calls } = await fixture(t); state.failSubmit = true;
  const quote = await service.estimate('music', music);
  const task = await service.generate('music', quote.quote_id, 'uncertain', { credits: 10, music_credits: 10 });
  assert.equal(task.status, 'submission_unknown'); assert.ok(!JSON.stringify(task).includes('synthetic upstream secret'));
  assert.equal((await new GenerationService(cfg).generate('music', quote.quote_id, 'uncertain', {})).status, 'submission_unknown');
  assert.equal((await service.task(task.task_handle)).status, 'submission_unknown');
  assert.equal(calls.filter(c => c.path === '/v2/async/text-to-song').length, 1);
});

test('concurrent callers reuse one durable intent; paid network waiting does not hold the store lock', async t => {
  const { service, cfg } = await fixture(t);
  const adapter = service.adapter('music');
  let finish!: (result: Outcome) => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const wait = new Promise<Outcome>(r => { finish = r; });
  let count = 0;
  t.mock.method(adapter, 'create', async () => { count++; started(); return wait; });
  t.after(() => finish({ status: 'queued', remote: { song_ids: ['9001'] }, artifacts: [] }));
  const quote = await service.estimate('music', music);
  const submitting = service.generate('music', quote.quote_id, 'parallel', { credits: 10, music_credits: 10 });
  await ready;
  const secondQuote = await service.estimate('music', music); assert.ok(secondQuote.quote_id);
  const repeated = await Promise.all(Array.from({ length: 5 }, () => new GenerationService(cfg).generate('music', quote.quote_id, 'parallel', {})));
  assert.ok(repeated.every(task => task.status === 'submission_unknown')); assert.equal(count, 1);
  finish({ status: 'queued', remote: { song_ids: ['9001'] }, artifacts: [] });
  assert.equal((await submitting).status, 'queued');
});

test('quotes expire and task handles are isolated by business origins and account', async t => {
  const { service, cfg } = await fixture(t);
  const quote = await service.estimate('music', music);
  await service.store.transaction(async state => { state.generation_quotes![quote.quote_id]!.expires_at = new Date(0).toISOString(); await service.store.save(state); });
  await assert.rejects(service.generate('music', quote.quote_id, 'expired', { credits: 10, music_credits: 10 }), code('QUOTE_EXPIRED'));
  const next = await service.estimate('music', music), task = await service.generate('music', next.quote_id, 'valid', { credits: 10, music_credits: 10 });
  await assert.rejects(new GenerationService({ ...cfg, musicHost: 'https://other.fixture.invalid' }).task(task.task_handle), code('TASK_NOT_FOUND'));
  const other = await config(t, { TOPMEDIAI_TOKEN: 'B'.repeat(42) });
  await assert.rejects(new GenerationService(other).task(task.task_handle), code('TASK_NOT_FOUND'));
});

test('simultaneous first submissions persist a single request before the paid POST', async t => {
  const { service, calls } = await fixture(t);
  const quote = await service.estimate('music', music);
  const tasks = await Promise.all(Array.from({ length: 6 }, () => service.generate('music', quote.quote_id, 'first-race', { credits: 10, music_credits: 10 })));
  assert.equal(new Set(tasks.map(task => task.task_handle)).size, 1);
  assert.equal(calls.filter(c => c.path === '/v2/async/text-to-song').length, 1);
});

test('one quote cannot be consumed concurrently under different request IDs', async t => {
  const { service, calls } = await fixture(t);
  const quote = await service.estimate('music', music);
  const results = await Promise.allSettled(['a', 'b'].map(id => service.generate('music', quote.quote_id, id, { credits: 10, music_credits: 10 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && code('QUOTE_USED')(rejected.reason));
  assert.equal(calls.filter(c => c.path === '/v2/async/text-to-song').length, 1);
});

test('a persisted submitting intent after a crash is never replayed', async t => {
  const { service, cfg, calls } = await fixture(t);
  const quote = await service.estimate('music', music), task = await service.generate('music', quote.quote_id, 'crash', { credits: 10, music_credits: 10 });
  await service.store.transaction(async state => { const task = state.generation_tasks!.crash!; task.status = 'submitting'; task.remote = {}; await service.store.save(state); });
  const restarted = new GenerationService(cfg);
  assert.equal((await restarted.generate('music', quote.quote_id, 'crash', {})).status, 'submission_unknown');
  assert.equal((await restarted.task(task.task_handle)).status, 'submission_unknown');
  assert.equal(calls.filter(c => c.path === '/v2/async/text-to-song').length, 1);
});

test('concurrent music polls share saved state and wait 20 seconds from the successful response', async t => {
  const { service, cfg } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const quote = await service.estimate('music', music), task = await service.generate('music', quote.quote_id, 'poll-race', { credits: 10, music_credits: 10 });
  let finish!: (outcome: Outcome) => void, ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), delayed = new Promise<Outcome>(resolve => { finish = resolve; });
  let polls = 0;
  t.mock.method(service.adapter('music'), 'poll', async () => { if (++polls === 1) { ready(); return delayed; } return { status: 'completed', remote: task.remote, artifacts: [] }; });
  t.after(() => finish({ status: 'running', remote: task.remote, artifacts: [] }));
  const first = service.task(task.task_handle); await started;
  const restarted = new GenerationService(cfg, [service.adapter('music')]);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => restarted.task(task.task_handle)));
  assert.ok(concurrent.every(result => result.status === 'queued' && result.cached && result.poll_after_seconds === 20));
  assert.equal(polls, 1);
  t.mock.timers.tick(7000);
  finish({ status: 'running', remote: task.remote, artifacts: [] });
  assert.equal((await first).poll_after_seconds, 20);
  t.mock.timers.tick(19999);
  const cached = await restarted.task(task.task_handle);
  assert.equal(cached.status, 'running'); assert.equal(cached.cached, true); assert.equal(cached.poll_after_seconds, 1);
  assert.equal(polls, 1);
  t.mock.timers.tick(1);
  const completed = await restarted.task(task.task_handle);
  assert.equal(completed.status, 'completed'); assert.equal(completed.poll_after_seconds, undefined);
  assert.equal(polls, 2);
});

for (const kind of ['music', 'video'] as const) {
  test(`${kind} query errors release the reservation; successful queries enforce an independent 20-second cooldown`, async t => {
    const { service, cfg } = await fixture(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const quote = await service.estimate(kind, kind === 'music' ? music : video);
    const task = await service.generate(kind, quote.quote_id, 'poll-error', { credits: 10, music_credits: 10, video_units: 10 });
    let polls = 0;
    const adapter = service.adapter(kind);
    t.mock.method(adapter, 'poll', async () => {
      if (++polls === 1) throw new TopMediaiError('BACKEND_UNAVAILABLE', 'Fixture query failed');
      return { status: polls === 2 ? 'running' as const : 'completed' as const, remote: task.remote, artifacts: [] };
    });
    await assert.rejects(service.task(task.task_handle), code('BACKEND_UNAVAILABLE'));
    const failed = await service.store.transaction(async state => state.generation_tasks![task.request_id]!);
    assert.equal(failed.poll_in_flight_until, undefined); assert.equal(failed.last_polled_at, undefined);
    const running = await service.task(task.task_handle);
    assert.equal(running.status, 'running'); assert.equal(running.poll_after_seconds, 20); assert.equal(polls, 2);
    t.mock.timers.tick(19999);
    const restarted = new GenerationService(cfg, [adapter]);
    const cached = await restarted.task(task.task_handle);
    assert.equal(cached.cached, true); assert.equal(cached.poll_after_seconds, 1); assert.equal(polls, 2);
    const otherQuote = await service.estimate(kind, kind === 'music' ? music : video);
    const other = await service.generate(kind, otherQuote.quote_id, 'independent', { credits: 10, music_credits: 10, video_units: 10 });
    assert.equal((await restarted.task(other.task_handle)).status, 'completed'); assert.equal(polls, 3);
    t.mock.timers.tick(1);
    assert.equal((await restarted.task(task.task_handle)).status, 'completed'); assert.equal(polls, 4);
  });
}

test('expired poll reservations recover without allowing a late response to overwrite a newer result', async t => {
  const { service, cfg } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const quote = await service.estimate('music', music), task = await service.generate('music', quote.quote_id, 'late-poll', { credits: 10, music_credits: 10 });
  let finish!: (outcome: Outcome) => void, ready!: () => void, polls = 0;
  const started = new Promise<void>(resolve => { ready = resolve; }), delayed = new Promise<Outcome>(resolve => { finish = resolve; });
  t.mock.method(service.adapter('music'), 'poll', async () => {
    if (++polls === 1) { ready(); return delayed; }
    return { status: 'completed', remote: task.remote, artifacts: [] };
  });
  t.after(() => finish({ status: 'running', remote: task.remote, artifacts: [] }));
  const earlier = service.task(task.task_handle); await started;
  t.mock.timers.tick(cfg.timeoutMs + 5000);
  assert.equal((await service.task(task.task_handle)).status, 'completed');
  finish({ status: 'running', remote: task.remote, artifacts: [] });
  assert.equal((await earlier).status, 'completed'); assert.equal(polls, 2);
});

test('effective video costs must agree with the published version and input', async t => {
  const { service, calls } = await fixture(t);
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await actualFetch(input, init), url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname !== '/ai_video/consume_preview') return response;
    const body = await response.json(); body.data.consume = 100;
    return new Response(JSON.stringify(body));
  });
  await assert.rejects(service.estimate('video', video), code('PRICE_UNAVAILABLE'));
  assert.ok(!calls.some(call => call.path === '/ai_video/generation'));
});

test('multimedia config defaults are safe and business host changes preserve image namespaces', async t => {
  const cfg = await config(t);
  const base = { TOPMEDIAI_TOKEN: cfg.token, TOPMEDIAI_DATA_DIR: cfg.dataDir };
  const a = loadConfig(base, () => null), b = loadConfig({ ...base, TOPMEDIAI_MUSIC_HOST: 'https://other.fixture.invalid' }, () => null);
  assert.ok(new GenerationService(a).capabilities().capabilities.filter(row => ['music','video','tts','sts'].includes(row.kind)).every(row => row.generation_enabled));
  assert.equal(a.dataDir, b.dataDir); assert.notEqual(new GenerationService(a).store.dir, new GenerationService(b).store.dir);
  for (const timeout of ['0', '300001', 'NaN', '1.5']) assert.throws(() => loadConfig({ ...base, TOPMEDIAI_AUDIO_TIMEOUT_MS: timeout }, () => null), code('INVALID_CONFIG'));
  const production = loadConfig({ ...base, TOPMEDIAI_ENV: 'production', TOPMEDIAI_PRODUCTION_GATEWAY_HOST: 'https://gateway.fixture.invalid' }, () => null);
  assert.ok(new GenerationService(production).capabilities().capabilities.every(row => !row.generation_enabled));
});

test('unsafe returned song identities and foreign task results are rejected without replay', async t => {
  const { service, state, calls } = await fixture(t); state.musicIds = ['../foreign'];
  const quote = await service.estimate('music', music);
  const task = await service.generate('music', quote.quote_id, 'bad-id', { credits: 10, music_credits: 10 }); assert.equal(task.status, 'submission_unknown');
  await service.generate('music', quote.quote_id, 'bad-id', {});
  assert.equal(calls.filter(c => c.path === '/v2/async/text-to-song').length, 1);
  state.musicIds = ['9001', '9002']; const next = await service.estimate('music', music);
  const valid = await service.generate('music', next.quote_id, 'good-id', { credits: 10, music_credits: 10 });
  state.songRows = [{ id: 'foreign', status: 0, audio_url: '' }];
  await assert.rejects(service.task(valid.task_handle), code('INVALID_RESPONSE'));
});

test('missing music status or missing song result stays unknown, never completed', async t => {
  const { service, state } = await fixture(t);
  const quote = await service.estimate('music', music), task = await service.generate('music', quote.quote_id, 'missing', { credits: 10, music_credits: 10 });
  state.songRows = [{ id: '9001', status: null as any, audio_url: '' }];
  const result = await service.task(task.task_handle); assert.equal(result.status, 'unknown'); assert.ok(result.children?.every(row => row.status === 'unknown'));
});

test('voice catalog only permits listed public details and excludes clone/private/internal metadata', async t => {
  const { cfg, calls } = await fixture(t); const catalog = new VoiceCatalog(cfg);
  await assert.rejects(catalog.detail('arbitrary'), code('VOICE_NOT_LISTED'));
  const list = await catalog.list({ lang: 'English', page_size: 1 }); assert.equal(list.total, 1); assert.equal(list.voices[0]?.voice_id, 'public_voice_1');
  assert.ok(!JSON.stringify(list).includes('not-returned'));
  const details = await catalog.detail('public_voice_1'); assert.equal(details.voice_name, 'Alice');
  assert.ok(calls.filter(c => c.path.startsWith('/v3/voice/')).every(c => c.method === 'POST' && c.headers.get('content-type') === 'application/x-www-form-urlencoded'));
});

test('strict business schemas reject unverified models, channel overrides and arbitrary assets', () => {
  assert.equal(musicSchema.safeParse(music).success, true); assert.equal(videoSchema.safeParse(video).success, true);
  for (const input of [{ ...music, mv: 'v6.0' }, { ...music, scheme: 12 }, { ...music, audio_url: 'https://example.test/a' }, { ...music, action: 'custom', instrumental: false }, { ...music, mv: 'v4.0', style: 'a'.repeat(201) }]) assert.equal(musicSchema.safeParse(input).success, false);
  for (const input of [{ ...video, duration: 5 }, { ...video, model_type: 1, duration: 10, mode: 4 }, { ...video, duration: 29, mode: 34 }, { ...video, first_image_url: 'https://example.test/a' }, { ...video, source: 3 }, { ...video, model_type: 99 }]) assert.equal(videoSchema.safeParse(input).success, false);
});

test('missing production backends reject multimedia calls before network access', async t => {
  const cfg = await config(t); const production = { ...cfg, environment: 'production' as const, musicHost: undefined, ttsHost: undefined };
  t.mock.method(globalThis, 'fetch', () => { assert.fail('No network for unapproved production routes'); });
  await assert.rejects(new MusicAdapter(production).models(), code('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(new VideoAdapter(production).models(), code('CAPABILITY_UNAVAILABLE'));
  const caps = new GenerationService(production).capabilities(); assert.equal(caps.capabilities.find(c => c.kind === 'tts')?.generation_enabled, false);
  assert.equal(caps.capabilities.find(c => c.kind === 'sts')?.implemented, true);
});

test('business transport rejects authentication/business failures and invalid JSON without leaking messages', async t => {
  const cfg = await config(t); const api = new BusinessTransport(cfg, 'https://fixture.invalid', 'token');
  for (const payload of [{ status: 401, check_code: 400401, message: 'sensitive', data: {} }, { status: 200, check_code: 400001, data: {} }, { status: 200 }, { status: 200, data: {} }]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
    if (Object.hasOwn(payload, 'data') && payload.status === 200 && !Object.hasOwn(payload, 'check_code')) assert.deepEqual(await api.request('/fixture'), {});
    else await assert.rejects(api.request('/fixture'), (error: unknown) => error instanceof TopMediaiError && !error.message.includes('sensitive'));
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(api.request('/fixture'), code('INVALID_RESPONSE'));
  await assert.rejects(api.request('//foreign.invalid/fixture'), code('INVALID_REQUEST'));
});

test('business transport accepts valid responses above the former 1 MiB limit', async t => {
  const cfg = await config(t); const api = new BusinessTransport(cfg, 'https://fixture.invalid', 'token');
  const data = { result: '橘猫', padding: '猫'.repeat(1024 * 1024) };
  const body = JSON.stringify({ status: 200, data });
  for (const headers of [new Headers({ 'Content-Length': String(Buffer.byteLength(body)) }), new Headers()]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers }));
    assert.deepEqual(await api.request('/fixture'), data);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test('media references preserve opaque encoding and reject dangerous URLs without fetching a CDN', () => {
  const encoded = 'YWJjZGVmZ2hpamtsbW5vcA=='; assert.equal(resultArtifact(encoded, 'video', 'video/mp4')?.encoded_reference, encoded);
  assert.equal(resultArtifact(encoded, 'video', 'video/mp4')?.url, undefined);
  for (const url of ['http://example.test/a', 'https://user:password@example.test/a', 'https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://172.16.0.1/a', 'https://[::1]/a', 'file:///x', 'https://example.test/a#token']) assert.throws(() => resultArtifact(url, 'audio', 'audio/mpeg'), code('INVALID_RESPONSE'));
  for (const id of [9007199254740992, '../x', null, 0]) assert.throws(() => identity(id), code('INVALID_RESPONSE'));
  for (const value of [NaN, null, '', '   ', [], false, -1]) assert.throws(() => numeric(value), code('INVALID_RESPONSE'));
});
