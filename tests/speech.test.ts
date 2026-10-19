import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.js';
import { productionEnvironment } from './fixtures/production.js';
import { GenerationService } from '../src/generation/service.js';
import { SpeechAudioService, SPEECH_PREFIX, SPEECH_SOURCE } from '../src/media/speech-audio.js';
import { speechResultArtifact } from '../src/media/speech-result.js';
import { VoiceCatalog } from '../src/generation/voices.js';
import { ttsSchema, stsSchema } from '../src/generation/speech-options.js';
import { createServer } from '../src/server.js';
import { TopMediaiError } from '../src/types.js';
import { BusinessTransport, record } from '../src/transport/business.js';
import { countTtsText } from '../src/generation/tts-billing.js';
import { withTaskDisplay } from '../src/display-policy.js';
import { backendBillingFixtures } from './fixtures/tts-billing.js';

const voiceId = '11111111-1111-4111-8111-111111111111';
const input = { text: 'Hello 世界', voice_id: voiceId, accent: 'English(US)' };
const code = (value: string) => (error: unknown) => error instanceof TopMediaiError && error.code === value;
async function fixture(t: TestContext, environment: 'production' | 'production' = 'production') {
  const directory = await mkdtemp(resolve(tmpdir(), 'topmediai-speech-'));
  t.after(async () => { const suffix = relative(tmpdir(), directory); assert.ok(suffix.startsWith('topmediai-speech-') && !isAbsolute(suffix) && !suffix.startsWith('..')); await rm(directory, { recursive: true, force: true }); });
  const config = loadConfig({ TOPMEDIAI_ENV: environment, ...(environment === 'production' ? productionEnvironment : {}), TOPMEDIAI_DATA_DIR: directory, TOPMEDIAI_UPLOAD_ROOT: directory, TOPMEDIAI_TOKEN: 'a'.repeat(42), TOPMEDIAI_TTS_HOST: 'https://speech.fixture.invalid', TOPMEDIAI_UPLOAD_HOST: 'https://speech.fixture.invalid', TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid' }, () => null);
  const bytes = Buffer.alloc(44 + 8000 * 30.1 * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  await writeFile(resolve(directory, 'sample.wav'), bytes);
  const asset = { file_id: 'owned-file', url: `${config.uploadPublicOrigin}${SPEECH_PREFIX}fixture.wav`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, duration_seconds: 30.1, mime_type: 'audio/wav' };
  const state = { sufficient: true, unit: 'characters', amount: 12400, characterLeft: 800, creditLeft: 50, voiceSku: false, voiceLeft: 0, proTimes: 5, genProTimes: 6, channel: 5, media: 'https://media.fixture.invalid/speech.mp3', timeout: false, reject: false, malformed: false, gate: undefined as Promise<void> | undefined, asset, allowGeneration: true,
    registered: false, missingAsset: false, uploadFailure: false, uploadUrl: '', uploadDuration: 30.1, assetPage: 1 };
  const calls: { path: string; body?: any; signal?: AbortSignal | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (urlLike: string | URL | Request, options?: RequestInit) => {
    const url = new URL(urlLike instanceof Request ? urlLike.url : urlLike);
    assert.ok([config.ttsHost, config.memberHost].includes(url.origin), 'Only isolated fixture origins are allowed');
    const headers = new Headers(options?.headers); assert.equal(headers.get('token'), config.token); assert.equal(headers.get('cookie'), null);
    assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
    const body = options?.body instanceof URLSearchParams ? Object.fromEntries(options.body) : undefined;
    calls.push({ path: url.pathname, body, signal: options?.signal });
    let data: unknown;
    if (url.pathname === '/v3/voice/detail') data = { voice_id: voiceId, voice_name: 'Public voice', channel_id: state.channel, accent: ['English(US)'], emotion: ['Default'], style: [], plan_key: 'never expose' };
    else if (url.pathname === '/v3/voice/list') data = [{ voice_id: voiceId, channel_id: 5 }, { voice_id: 'google', channel_id: 3 }];
    else if (url.pathname === '/sts/consume_preview') data = { billing_unit: state.unit, amount: state.amount, equity_type: state.unit === 'characters' ? 1 : 42, sufficient: state.sufficient, characters_required: 12400, credits_required: 62, billable_seconds: 31 };
    else if (url.pathname === '/v2/user/info') data = { pro_times: state.proTimes, gen_pro_times: state.genProTimes };
    else if (url.pathname === '/v2/user/voice_sku') { assert.equal(url.searchParams.get('speaker'), voiceId); data = { check: state.voiceSku ? 1 : 0, left: state.voiceLeft }; }
    else if (url.pathname === '/user/member/info') data = { member_id: '12345', email: 'fixture@example.invalid' };
    else if (url.pathname === '/upload_file') {
      if (state.uploadFailure) throw new Error('uncertain upload');
      assert.ok(options?.body instanceof FormData);
      assert.equal(headers.get('content-type'), null);
      assert.equal(options.body.get('source'), SPEECH_SOURCE);
      const file = options.body.get('file'); assert.ok(file instanceof Blob);
      const uploaded = Buffer.from(await file.arrayBuffer()); assert.equal(uploaded.toString('ascii', 0, 4), 'RIFF');
      state.asset.bytes = uploaded.length; state.asset.sha256 = createHash('sha256').update(uploaded).digest('hex');
      data = { url: state.uploadUrl || state.asset.url, duration: state.uploadDuration };
    } else if (url.pathname === '/sts/create_task') {
      const files = JSON.parse(body!.file_list!); assert.equal(files.length, 1);
      assert.equal(files[0].is_uploaded, 1); assert.equal(files[0].product_id, 1); assert.equal(files[0].oss_url, state.asset.url);
      assert.equal(files[0].file_time, 30100); assert.equal(files[0].size, state.asset.bytes); assert.equal(files[0].mime_type, 'wav');
      state.registered = true; data = [{ file_id: state.asset.file_id, task_id: 12, oss_path: state.asset.url }];
    } else if (url.pathname === '/sts/file_list') {
      const page = Number(url.searchParams.get('page_num')); assert.equal(url.searchParams.get('product_id'), '1');
      data = { data_list: page < state.assetPage ? Array.from({ length: 100 }, (_, i) => ({ file_id: `other-${i}` })) :
        page === state.assetPage && state.registered && !state.missingAsset ? [{ file_id: state.asset.file_id, oss_url: state.asset.url, file_time: state.asset.duration_seconds * 1000, file_size: state.asset.bytes, mime_type: 'wav', is_record: 0 }] : [] };
    }
    else if (url.pathname === '/user/permission/info') data = { tts: { left: state.characterLeft, is_vip: false }, tp_all: { left: state.creditLeft, is_vip: state.allowGeneration }, clone: { is_vip: false } };
    else if (url.pathname === '/v5/voice/tts' || url.pathname === '/s2s') {
      assert.equal(headers.get('x-mcp-speech'), null); assert.equal(headers.get('web-req'), '1');
      if (state.gate) await Promise.race([state.gate, new Promise<void>((_, reject) => { if (options?.signal?.aborted) reject(options.signal.reason); else options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }); })]);
      if (state.timeout) throw new Error('upstream secret must not escape');
      if (state.reject) return new Response(JSON.stringify({ status: 400, check_code: 400000, message: 'secret' }));
      if (state.malformed) return new Response(JSON.stringify({ status: 400, check_code: 500000, message: 'provider failed after starting' }));
      data = url.pathname === '/s2s' ? { uuid: 'result-uuid', file_id: 'owned-file', oss_url: state.media, use_characters: 12400 } : { id: 12, status: 1, oss_url: state.media };
    } else throw new Error(`Unexpected fixture route ${url.pathname}`);
    return new Response(JSON.stringify({ status: 200, data }));
  });
  return { config, directory, state, calls, generation: new GenerationService(config), audio: new SpeechAudioService(config) };
}

test('existing speech API errors retain HTTP and business semantics without deployment assumptions', async t => {
  const { config } = await fixture(t), api = new BusinessTransport(config, config.ttsHost!, 'token');
  let posts = 0;
  for (const route of ['/sts/create_task']) {
    for (const httpStatus of [200, 404]) {
      t.mock.method(globalThis, 'fetch', async () => { posts++; return new Response(JSON.stringify({ status: 404, check_code: 400404, message: 'private upstream details' }), { status: httpStatus }); });
      await assert.rejects(api.request(route, { form: {}, speech: true }), error => {
        assert.ok(error instanceof TopMediaiError); assert.equal(error.code, httpStatus === 404 ? 'HTTP_ERROR' : 'BUSINESS_ERROR');
        assert.equal(error.message.includes('private upstream'), false); return true;
      });
    }
  }
  assert.equal(posts, 2, 'Each diagnostic call makes a single request without retry');
});

test('production public voices use the configured speech backend and retain catalog selection', async t => {
  const { config, calls } = await fixture(t, 'production');
  const voices = new VoiceCatalog(config);
  const result = await voices.list({ operation: 'tts' });
  assert.equal(result.tts_generation_enabled, true);
  assert.ok(result.voices.some(voice => voice.voice_id === voiceId));
  assert.equal((await voices.detail(voiceId)).voice_id, voiceId);
  assert.deepEqual(calls.map(call => call.path), ['/v3/voice/list', '/v3/voice/detail']);
});

test('ordinary missing business records and login failures are not misreported as undeployed speech routes', async t => {
  const { config } = await fixture(t), api = new BusinessTransport(config, config.ttsHost!, 'token');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 404, check_code: 400404 })));
  await assert.rejects(api.request('/v3/voice/detail', { form: { voice_id: voiceId }, speech: true }), code('BUSINESS_ERROR'));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 401, check_code: 400401 })));
  await assert.rejects(api.request('/s2s', { form: {}, speech: true }), code('LOGIN_REQUIRED'));
});

test('local TTS counting matches real Python backend output across Unicode, HTML, SSML and channels', () => {
  assert.equal(backendBillingFixtures.cases.length, 378);
  for (const row of backendBillingFixtures.cases) {
    const result = countTtsText(row.text, row.channel, row.multiplier);
    assert.deepEqual({ input_characters: result.input_characters, characters_required: result.characters_required, credits_required: result.credits_required },
      { input_characters: row.input_characters, characters_required: row.characters_required, credits_required: row.credits_required }, JSON.stringify(row));
  }
});

test('TTS estimates use only existing account APIs, current multipliers and whole entitlement branches', async t => {
  const { generation, state, calls } = await fixture(t);
  const first = await generation.estimate('tts', input);
  assert.deepEqual(first.costs, [{ resource: 'characters', amount: 40, resource_scope: 'account:characters' }]);
  assert.equal(record(first.billing).source, 'local_backend_rules'); assert.equal(record(first.billing).credits_required, 1);
  state.characterLeft = 40;
  assert.equal((await generation.estimate('tts', input)).price_version, first.price_version, 'Same branch and rate survive balance changes');
  state.characterLeft = 39;
  const credits = await generation.estimate('tts', input);
  assert.deepEqual(credits.costs, [{ resource: 'credits', amount: 1, resource_scope: 'account:credits' }]);
  state.proTimes = 3;
  const discounted = await generation.estimate('tts', input);
  assert.equal(record(discounted.billing).characters_required, 24); assert.notEqual(discounted.price_version, first.price_version);
  state.channel = 11;
  assert.equal(record((await generation.estimate('tts', input)).billing).characters_required, 48);
  assert.equal(calls.some(call => call.path.includes('consume_preview')), false);
  assert.equal(calls.some(call => call.path === '/v5/voice/tts'), false);
});

test('the 1975-character TTS example displays 10 estimated credits through generation and saved-task recovery', async t => {
  const { generation, state, calls, config } = await fixture(t);
  state.characterLeft = 10000;
  const quote = await generation.estimate('tts', { ...input, text: 'a'.repeat(395) });
  const expected = [{ resource: 'credits', amount: 10, label: 'Credits', unit_type: 'credits' }];
  assert.equal(record(quote.billing).characters_required, 1975);
  assert.deepEqual(quote.display.estimated_costs, expected);
  await assert.rejects(generation.generate('tts', quote.quote_id, 'wrong-budget', { credits: 10 }), code('BUDGET_EXCEEDED'));
  const task = await generation.generate('tts', quote.quote_id, 'credit-display', { characters: 1975 });
  assert.equal(task.estimated_credits, 10); assert.deepEqual(task.costs, quote.costs);
  assert.deepEqual(withTaskDisplay(task).display.estimated_costs, expected);
  const before = calls.length;
  // Records saved before this change restore the estimate from their original quote.
  await generation.store.transaction(async saved => {
    delete saved.generation_tasks!['credit-display']!.estimated_credits;
    saved.generation_quotes![quote.quote_id]!.expires_at = new Date(0).toISOString();
    await generation.store.save(saved);
  });
  const restarted = new GenerationService(config);
  assert.deepEqual(withTaskDisplay(await restarted.task(task.task_handle)).display.estimated_costs, expected);
  assert.deepEqual(withTaskDisplay(await restarted.generate('tts', quote.quote_id, 'credit-display', {})).display.estimated_costs, expected);
  // New task snapshots remain useful even if the old quote is no longer present.
  await generation.store.transaction(async saved => {
    saved.generation_tasks!['credit-display']!.estimated_credits = 10;
    delete saved.generation_quotes![quote.quote_id];
    await generation.store.save(saved);
  });
  assert.deepEqual(withTaskDisplay(await restarted.task(task.task_handle, false)).display.estimated_costs, expected);
  assert.equal(calls.length, before, 'Restoring and displaying a price must never synthesize or query the backend again');
});

test('voice-specific characters cannot fall back to account credits, including an exhausted SKU', async t => {
  const { generation, state } = await fixture(t);
  state.voiceSku = true; state.voiceLeft = 39;
  const quote = await generation.estimate('tts', input);
  assert.deepEqual(quote.costs, [{ resource: 'characters', amount: 40, resource_scope: `voice:${voiceId}` }]);
  assert.equal(quote.sufficient, false);
  await assert.rejects(generation.generate('tts', quote.quote_id, 'own-short', { characters: 40, credits: 50 }), code('INSUFFICIENT_ENTITLEMENT'));
  state.voiceLeft = 40;
  assert.equal((await generation.estimate('tts', input)).sufficient, true);
});

test('missing account billing data fails closed and cancellation reaches the existing APIs', async t => {
  const { generation, state, calls } = await fixture(t);
  state.proTimes = NaN;
  await assert.rejects(generation.estimate('tts', input), code('INVALID_RESPONSE'));
  state.proTimes = 5;
  const signal = new AbortController().signal;
  await generation.estimate('tts', input, signal);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal));
});

test('production TTS waits for the synchronous response and completed records never poll or synthesize again', async t => {
  const { generation, state, calls, config } = await fixture(t, 'production');
  let release!: () => void; state.gate = new Promise<void>(resolve => { release = resolve; });
  const quote = await generation.estimate('tts', input);
  assert.equal(quote.cost_mode, 'selected_entitlement');
  let completed = false;
  const pending = generation.generate('tts', quote.quote_id, 'sync', { characters: 200 }).then(task => { completed = true; return task; });
  while (!calls.some(call => call.path === '/v5/voice/tts')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  const replay = await generation.generate('tts', quote.quote_id, 'sync', {}); assert.equal(replay.status, 'submitting');
  assert.equal((await generation.task(replay.task_handle)).status, 'submitting');
  release(); const task = await pending;
  assert.equal(task.status, 'completed'); assert.equal(task.execution_mode, 'synchronous'); assert.ok(task.finished_at);
  assert.equal(task.artifacts[0]?.url, state.media);
  const before = calls.length;
  assert.equal((await new GenerationService(config).task(task.task_handle)).status, 'completed');
  assert.deepEqual(await generation.generate('tts', quote.quote_id, 'sync', {}), task);
  assert.equal(calls.length, before);
  const request = calls.find(call => call.path === '/v5/voice/tts')!;
  assert.equal(request.body.is_audition, '0'); assert.equal(request.body.product_id, '1'); assert.equal(request.body.plan_type, '2');
});

test('production STS uses existing upload/registration/list/preview APIs and returns audio directly', async t => {
  const { audio, generation, calls } = await fixture(t, 'production');
  const asset = await audio.upload('sample.wav');
  const quote = await generation.estimate('sts', { speech_asset_id: asset.speech_asset_id, voice_id: voiceId, stability: 0 });
  assert.equal(asset.storage_notice.includes('publicly accessible'), true);
  assert.deepEqual(quote.costs, [{ resource: 'characters', amount: 12400, resource_scope: 'account:characters' }]);
  assert.equal(record(quote.billing).source, 'existing_backend_preview');
  const result = await generation.generate('sts', quote.quote_id, 'sts', { characters: 12400 });
  assert.equal(result.status, 'completed'); assert.equal(result.remote.uuid, 'result-uuid');
  assert.equal(result.remote.file_id, 'owned-file');
  const request = calls.find(call => call.path === '/s2s')!.body;
  assert.equal(request.file_id, 'owned-file'); assert.equal(request.stability, '0'); assert.equal(request.speech_asset_id, undefined);
  const before = calls.length; await generation.task(result.task_handle); assert.equal(calls.length, before);
  assert.deepEqual([...new Set(calls.map(call => call.path))].sort(), [
    '/s2s', '/sts/consume_preview', '/sts/create_task', '/sts/file_list', '/upload_file',
    '/user/member/info', '/v2/user/voice_sku', '/v3/voice/detail',
  ].sort());
});

test('STS derives scope and pricing version from the unchanged preview and current voice SKU', async t => {
  const { audio, generation, state, calls } = await fixture(t);
  const asset = await audio.upload('sample.wav'), params = { speech_asset_id: asset.speech_asset_id, voice_id: voiceId };
  const quote = await generation.estimate('sts', params);
  state.sufficient = false;
  assert.equal((await generation.estimate('sts', params)).price_version, quote.price_version);
  state.sufficient = true; state.voiceSku = true;
  await assert.rejects(generation.generate('sts', quote.quote_id, 'sts-scope', { characters: 12400 }), code('PRICE_CHANGED'));
  const dedicated = await generation.estimate('sts', params);
  assert.equal(dedicated.costs[0]?.resource_scope, `voice:${voiceId}`);
  state.voiceSku = false; state.unit = 'credits'; state.amount = 62;
  const credits = await generation.estimate('sts', params);
  assert.deepEqual(credits.costs, [{ resource: 'credits', amount: 62, resource_scope: 'account:credits' }]);
  state.amount = 61;
  await assert.rejects(generation.estimate('sts', params), code('INVALID_RESPONSE'));
  assert.equal(calls.filter(call => call.path === '/s2s').length, 0);
});

test('speech file verification paginates the existing account list and detects changed metadata', async t => {
  const { audio, state, calls } = await fixture(t); state.assetPage = 2;
  const asset = await audio.upload('sample.wav');
  assert.equal(calls.filter(call => call.path === '/sts/file_list').length, 2);
  state.asset.url = state.asset.url.replace('fixture.wav', 'different.wav');
  await assert.rejects(audio.asset(asset.speech_asset_id), code('SPEECH_ASSET_CHANGED'));
});

test('invalid upload URLs, mismatched duration and uncertain uploads never register or synthesize', async t => {
  const { audio, state, calls } = await fixture(t);
  state.uploadUrl = 'https://unapproved.fixture.invalid/source.wav';
  await assert.rejects(audio.upload('sample.wav'), code('INVALID_UPLOAD_URL'));
  state.uploadUrl = ''; state.uploadDuration = 1;
  await assert.rejects(audio.upload('sample.wav'), code('INVALID_SPEECH_ASSET'));
  state.uploadDuration = 30.1; state.uploadFailure = true;
  await assert.rejects(audio.upload('sample.wav'), code('NETWORK_ERROR'));
  assert.equal(calls.filter(call => call.path === '/upload_file').length, 3);
  assert.equal(calls.some(call => ['/sts/create_task', '/s2s'].includes(call.path)), false);
});

test('damaged audio and an unavailable media decoder fail before any upload', async t => {
  const { audio, directory, calls, config } = await fixture(t);
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.write('WAVE', 8);
  await writeFile(resolve(directory, 'broken.wav'), bytes);
  await assert.rejects(audio.upload('broken.wav'), code('INVALID_SPEECH_ASSET'));
  await assert.rejects(new SpeechAudioService({ ...config, ffprobePath: resolve(directory, 'missing-decoder') }).upload('sample.wav'), code('MEDIA_PROBE_UNAVAILABLE'));
  assert.equal(calls.some(call => ['/upload_file', '/sts/create_task', '/s2s'].includes(call.path)), false);
});

test('billing branch or scope changes, insufficient balances, permissions and budgets prevent submission', async t => {
  const { generation, state, calls } = await fixture(t);
  const quote = await generation.estimate('tts', input);
  await assert.rejects(generation.generate('tts', quote.quote_id, 'budget', { credits: 100 }), code('BUDGET_EXCEEDED'));
  state.voiceSku = true; state.voiceLeft = 800;
  await assert.rejects(generation.generate('tts', quote.quote_id, 'scope', { characters: 200 }), code('PRICE_CHANGED'));
  state.voiceSku = false; state.characterLeft = 0;
  await assert.rejects(generation.generate('tts', quote.quote_id, 'branch', { characters: 200, credits: 1 }), code('PRICE_CHANGED'));
  state.creditLeft = 0; const insufficient = await generation.estimate('tts', input); assert.equal(insufficient.sufficient, false);
  await assert.rejects(generation.generate('tts', insufficient.quote_id, 'insufficient', { credits: 1 }), code('INSUFFICIENT_ENTITLEMENT'));
  state.allowGeneration = false; await assert.rejects(generation.estimate('tts', input), code('ENTITLEMENT_REQUIRED'));
  assert.equal(calls.filter(call => call.path === '/v5/voice/tts').length, 0);
});

test('lost responses and post-start business errors stay unknown across restart without retries', async t => {
  const { generation, config, state, calls } = await fixture(t);
  for (const mode of ['timeout', 'malformed'] as const) {
    state[mode] = true;
    const quote = await generation.estimate('tts', input), task = await generation.generate('tts', quote.quote_id, mode, { characters: 200 });
    assert.equal(task.status, 'submission_unknown'); assert.equal(JSON.stringify(task).includes('secret'), false);
    assert.equal((await new GenerationService(config).generate('tts', quote.quote_id, mode, {})).status, 'submission_unknown');
    assert.equal((await new GenerationService(config).task(task.task_handle)).status, 'submission_unknown'); state[mode] = false;
  }
  assert.equal(calls.filter(call => call.path === '/v5/voice/tts').length, 2);
});

test('a business refusal without a backend outcome query stays unknown and is never replayed', async t => {
  const { generation, state, calls } = await fixture(t); state.reject = true;
  const quote = await generation.estimate('tts', input), task = await generation.generate('tts', quote.quote_id, 'reject', { characters: 200 });
  assert.equal(task.status, 'submission_unknown');
  assert.equal((await generation.generate('tts', quote.quote_id, 'reject', {})).status, 'submission_unknown');
  assert.equal(calls.filter(call => call.path === '/v5/voice/tts').length, 1);
});

test('cancellation after submitting persists unknown, while cancellation before submitting sends no POST', async t => {
  const { generation, state, calls } = await fixture(t);
  const quote = await generation.estimate('tts', input), controller = new AbortController(); controller.abort();
  await assert.rejects(generation.generate('tts', quote.quote_id, 'cancel-before', { characters: 200 }, controller.signal));
  assert.equal(calls.filter(call => call.path === '/v5/voice/tts').length, 0);
  state.gate = new Promise(() => {}); const waiting = new AbortController();
  const pending = generation.generate('tts', quote.quote_id, 'cancel-after', { characters: 200 }, waiting.signal);
  while (!calls.some(call => call.path === '/v5/voice/tts')) await new Promise(resolve => setImmediate(resolve));
  waiting.abort(); assert.equal((await pending).status, 'submission_unknown');
});

test('synchronous generation uses the audio deadline rather than the ordinary business deadline', async t => {
  const { config, state } = await fixture(t);
  const generation = new GenerationService({ ...config, timeoutMs: 10, audioTimeoutMs: 1000 });
  const quote = await generation.estimate('tts', input);
  state.gate = new Promise(resolve => setTimeout(resolve, 35));
  const result = await generation.generate('tts', quote.quote_id, 'long-audio', { characters: 200 });
  assert.equal(result.status, 'completed');
});

test('a crash intent becomes unknown and a changed speech host isolates records', async t => {
  const { generation, config } = await fixture(t);
  const quote = await generation.estimate('tts', input), task = await generation.generate('tts', quote.quote_id, 'crash', { characters: 200 });
  await generation.store.transaction(async state => { state.generation_tasks!.crash!.status = 'submitting'; await generation.store.save(state); });
  assert.equal((await new GenerationService(config).task(task.task_handle)).status, 'submission_unknown');
  await assert.rejects(new GenerationService({ ...config, ttsHost: 'https://other.fixture.invalid' }).task(task.task_handle), code('TASK_NOT_FOUND'));
});

test('audio delivery failure preserves completed generation, and legacy TTS encoding decodes without requests', async t => {
  const { generation, state } = await fixture(t); state.media = 'https://127.0.0.1/private.mp3';
  const quote = await generation.estimate('tts', input), task = await generation.generate('tts', quote.quote_id, 'delivery', { characters: 200 });
  assert.equal(task.status, 'completed'); assert.ok(task.delivery_error); assert.equal(task.artifacts.length, 0);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from('123456789imyfone123456789imyfone'), Buffer.from('123456789imyfone'));
  const url = 'https://media.fixture.invalid/语音.mp3';
  const encoded = Buffer.concat([cipher.update(url), cipher.final()]).toString('base64');
  assert.equal(speechResultArtifact(encoded)?.url, new URL(url).href);
  assert.equal(speechResultArtifact('YWJjYWJjYWJjYWJjYWJjYWJj')?.media_access, 'encoded');
});

test('voice operation filtering, unsupported tuning and internal fields are enforced', async t => {
  const { generation, config, state, calls } = await fixture(t);
  const catalog = new VoiceCatalog(config), voices = await catalog.list({ operation: 'sts' });
  assert.equal(voices.voices.length, 1); assert.equal(calls.find(call => call.path === '/v3/voice/list')?.body.plan_id, '5,8,11');
  assert.equal(JSON.stringify(await catalog.detail(voiceId)).includes('never expose'), false);
  for (const key of ['sku_dict', 'is_audition', 'model_id', 'token', 'product_id']) assert.equal(ttsSchema.safeParse({ ...input, [key]: 'arbitrary' }).success, false);
  assert.equal(stsSchema.safeParse({ file_id: 'arbitrary', voice_id: voiceId }).success, false);
  state.channel = 3;
  await assert.rejects(generation.estimate('tts', { ...input, similarity: 90 }), code('INVALID_PARAMS'));
  await assert.rejects(generation.estimate('tts', { ...input, text: 'a'.repeat(501) }), code('INVALID_PARAMS'));
  await assert.rejects(generation.estimate('tts', { ...input, accent: 'other' }), code('INVALID_PARAMS'));
});

test('speech upload enforces root, real decoding, registered metadata and account isolation', async t => {
  const { audio, config, state } = await fixture(t);
  await assert.rejects(audio.upload('../outside.wav'), code('INVALID_REFERENCE_MEDIA'));
  const asset = await audio.upload('sample.wav'); state.asset.bytes++;
  await assert.rejects(audio.asset(asset.speech_asset_id), code('SPEECH_ASSET_CHANGED'));
  state.missingAsset = true;
  await assert.rejects(audio.asset(asset.speech_asset_id), code('SPEECH_ASSET_NOT_FOUND'));
  await assert.rejects(new SpeechAudioService({ ...config, dataDir: resolve(config.dataDir, 'other-account') }).asset(asset.speech_asset_id), code('SPEECH_ASSET_NOT_FOUND'));
  await assert.rejects(new SpeechAudioService({ ...config, ttsHost: 'https://other.fixture.invalid' }).asset(asset.speech_asset_id), code('SPEECH_ASSET_NOT_FOUND'));
  await assert.rejects(new SpeechAudioService({ ...config, uploadRoot: undefined }).upload('sample.wav'), code('UPLOAD_DISABLED'));
  await assert.rejects(new SpeechAudioService({ ...config, uploadHost: undefined }).upload('sample.wav'), code('UPLOAD_DISABLED'));
});

test('missing speech routes and legacy gateways cannot route to the speech service', async t => {
  const { config, generation, calls } = await fixture(t);
  const quote = await generation.estimate('tts', input);
  await assert.rejects(new GenerationService({ ...config, ttsHost: undefined }).generate('tts', quote.quote_id, 'off', { characters: 200 }), code('GENERATION_DISABLED'));
  assert.equal(calls.filter(call => call.path === '/v5/voice/tts').length, 0);
  const production = loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_PRODUCTION_GATEWAY_HOST: 'https://gateway.fixture.invalid' }, () => null);
  await assert.rejects(new GenerationService(production).generate('tts', quote.quote_id, 'production', { characters: 200 }), code('GENERATION_DISABLED'));
  const capabilities = generation.capabilities();
  assert.equal(capabilities.capabilities.find(row => row.kind === 'tts')?.execution_mode, 'synchronous');
});

test('speech tools expose synchronous schemas and return completed audio in one call', async t => {
  const { config } = await fixture(t);
  const server = createServer(config), client = new Client({ name: 'speech-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  for (const name of ['list_tts_models', 'list_sts_models', 'estimate_tts_cost', 'estimate_sts_cost', 'generate_tts', 'generate_sts', 'upload_speech_audio', 'get_speech_entitlements']) assert.ok(tools.some(tool => tool.name === name));
  const quote = (await client.callTool({ name: 'estimate_tts_cost', arguments: input })).structuredContent! as Record<string, unknown>;
  const result = await client.callTool({ name: 'generate_tts', arguments: { quote_id: quote.quote_id, request_id: 'mcp', budget: { characters: 200 } } });
  const content = result.structuredContent as Record<string, unknown>; assert.equal(content.status, 'completed'); assert.equal(content.execution_mode, 'synchronous');
});

for (const kind of ['tts', 'sts'] as const) test(`${kind.toUpperCase()} completed tool result opens an owned audio player without polling or another synthesis`, async t => {
  const { config, state, calls } = await fixture(t);
  state.media = `https://files.topmediai.com/TTS/result/${kind}.mp3?signature=a%2Bb`;
  const server = createServer(config), client = new Client({ name: `${kind}-preview-test`, version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.match(tools.find(tool => tool.name === `generate_${kind}`)!.description!, /preview_audio_task/);
  let params: Record<string, unknown> = { ...input, article_title: '欢迎语音' };
  if (kind === 'sts') {
    const upload = await client.callTool({ name: 'upload_speech_audio', arguments: { file_path: 'sample.wav' } }) as CallToolResult;
    assert.equal(upload.isError, undefined);
    params = { speech_asset_id: upload.structuredContent!.speech_asset_id, voice_id: voiceId };
  }
  const quote = await client.callTool({ name: `estimate_${kind}_cost`, arguments: params }) as CallToolResult;
  assert.equal(quote.isError, undefined);
  const expectedCosts = [{ resource: 'credits', amount: kind === 'tts' ? 1 : 62, label: 'Credits', unit_type: 'credits' }];
  assert.deepEqual((quote.structuredContent!.display as { estimated_costs: unknown }).estimated_costs, expectedCosts);
  const generated = await client.callTool({ name: `generate_${kind}`, arguments: { quote_id: quote.structuredContent!.quote_id,
    request_id: `preview-${kind}`, budget: { characters: kind === 'tts' ? 200 : 12400 } } }) as CallToolResult;
  assert.equal(generated.isError, undefined);
  const task = generated.structuredContent!;
  assert.equal(task.status, 'completed'); assert.equal(task.execution_mode, 'synchronous');
  assert.equal((task.display as { voice: { name: string } }).voice.name, 'Public voice');
  assert.deepEqual((task.display as { estimated_costs: unknown }).estimated_costs, expectedCosts);
  assert.equal(JSON.stringify(task).includes('never expose'), false);
  const links = generated.content.filter(item => item.type === 'resource_link');
  assert.equal(links.length, 1);
  assert.equal(links[0]!.uri, state.media); assert.equal(links[0]!.mimeType, 'audio/mpeg');
  assert.equal(links[0]!.title, kind === 'tts' ? 'Synthesized speech' : 'Voice conversion result');
  assert.equal(calls.filter(call => call.path === (kind === 'tts' ? '/v5/voice/tts' : '/s2s')).length, 1);
  const before = calls.length;
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Completed speech previews must not query, synthesize or convert again'); });
  for (const name of ['preview_audio_task', 'preview_audio_task', 'get_generation_task']) {
    const preview = await client.callTool({ name, arguments: { task_handle: task.task_handle } }) as CallToolResult;
    assert.equal(preview.isError, undefined); assert.equal(preview.structuredContent!.status, 'completed');
    assert.deepEqual((preview.structuredContent!.display as { estimated_costs: unknown }).estimated_costs, expectedCosts);
    assert.deepEqual(preview.content.filter(item => item.type === 'resource_link'), links);
  }
  assert.equal(calls.length, before);
});
