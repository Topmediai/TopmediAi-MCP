import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { WEB_MODELS } from '../src/catalog/models.js';
import { loadConfig } from '../src/config.js';
import { ImageService } from '../src/service.js';
import { GenerationService } from '../src/generation/service.js';
import { MusicAdapter, musicSchema } from '../src/generation/music.js';
import { VideoAdapter, videoSchema } from '../src/generation/video.js';
import { imageSchema } from '../src/image-options.js';
import { REFERENCE_PREFIX } from '../src/reference-url.js';
import { Store } from '../src/store.js';
import { TopMediaiError, type ReferenceImage } from '../src/types.js';

const code = (expected: string) => (error: unknown) => error instanceof TopMediaiError && error.code === expected;
const id = randomUUID();

async function fixture(t: TestContext) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(resolve(parent, 'topmediai-model-alignment-'));
  t.after(async () => { const suffix = relative(parent, dir); assert.ok(suffix.startsWith('topmediai-model-alignment-') && !isAbsolute(suffix) && !suffix.startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  const cfg = loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_TOKEN: 'A'.repeat(42), TOPMEDIAI_DATA_DIR: dir,
    TOPMEDIAI_IMAGE_HOST: 'https://image.fixture.invalid', TOPMEDIAI_MUSIC_HOST: 'https://music.fixture.invalid', TOPMEDIAI_TTS_HOST: 'https://video.fixture.invalid' }, () => null);
  const calls: { path: string; body: any }[] = [];
  const state = { failCatalog: false, failQuote: false, effective: {} as Record<string, unknown>, rows: true, invalidPrice: false };
  t.mock.method(globalThis, 'fetch', async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(raw instanceof Request ? raw.url : raw);
    assert.ok([cfg.imageHost, cfg.musicHost, cfg.ttsHost].includes(url.origin), 'No live endpoints allowed');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname + url.search, body });
    const catalog = ['/v3/draw/model-consume', '/v2/music/generation-prices', '/ai_video/price/model_cost'].includes(url.pathname);
    if (catalog && state.failCatalog) throw new Error('synthetic upstream detail must not leak');
    if (state.failQuote && ['/v2/music/generation-price', '/ai_video/price/preview'].includes(url.pathname)) return new Response('{}', { status: 503 });
    let data: unknown;
    if (url.pathname === '/v3/draw/model-consume') data = { list: state.rows ? [
      { model_type: 15, quality: 25, image_quality: 0, points: 2, version: 'v1' },
      { model_type: 14, quality: 22, image_quality: 5, points: 3, version: 'v1' },
      { model_type: 7, quality: 6, image_quality: 0, points: 1, version: 'v1' },
    ] : [] };
    else if (url.pathname === '/v2/music/generation-prices') data = { current_price_version: 'pricing_B', price_versions: [{ price_version: 'pricing_B', new_pricing_rules: { model_unit_credits: { default: 2 } } }] };
    else if (url.pathname === '/v2/music/generation-price') data = { price_version: 'pricing_B', legacy_credits_cost: 7, new_credits_cost: 70, scheme: 1 };
    else if (url.pathname === '/v2/async/text-to-song') data = { song_ids: ['song-1', 'song-2'] };
    else if (url.pathname === '/ai_video/price/model_cost') data = { models: state.rows ? [{ model_type: 30, pricing: [{ duration: 52, mode: 64, task_type: 1, real_duration: -1, generate_audio_switch: -1, multiple_shot: 0, consume: state.invalidPrice ? 'invalid' : 0.36, points: null, version: 'v1' }] }] : [] };
    else if (url.pathname === '/ai_video/price/preview') data = { ...body, real_duration: -1, consume: 0.36, version: 'v1', price_rule_id: 71 };
    else if (url.pathname === '/ai_video/consume_preview') data = { ...body, consume: Math.round(body.real_duration * 36) / 100, points: body.real_duration, ...state.effective };
    else if (url.pathname === '/ai_video/generation') data = { task_id: '9001' };
    else if (url.pathname === '/v3/draw/text-to-image' || url.pathname === '/v3/draw/image-to-image') data = { group_id: '8001' };
    else assert.fail(`Unexpected fixture request ${url.pathname}`);
    return new Response(JSON.stringify({ status: 200, check_code: 200000, data }));
  });
  return { cfg, calls, state, images: new ImageService(cfg), generation: new GenerationService(cfg) };
}

async function saveImages(store: Store, count: number) {
  const images: ReferenceImage[] = Array.from({ length: count }, (_, index) => ({ reference_image_id: randomUUID(), url: `https://files.topmediai.com${REFERENCE_PREFIX}fixture-${index}.png`,
    sha256: createHash('sha256').update(`image-${index}`).digest('hex'), mime_type: 'image/png', bytes: 1024, width: 512, height: 512, created_at: new Date().toISOString() }));
  await store.transaction(async state => { state.reference_images ??= Object.create(null); for (const image of images) state.reference_images![image.reference_image_id] = image; await store.save(state); });
  return images;
}

test('Web snapshot includes only current selectable models and defaults', () => {
  assert.deepEqual(WEB_MODELS.music.map(model => model.mv), ['v6-pro', 'v6-wild-pro', 'v6-mini']);
  assert.deepEqual(WEB_MODELS.images.map(model => model.id), [15, 14, 13, 11, 9, 5, 12, 10, 6, 4, 8]);
  assert.equal(WEB_MODELS.videos.length, 23);
  assert.ok([...WEB_MODELS.images, ...WEB_MODELS.videos].every(model => model.visible));
  assert.ok(!WEB_MODELS.videos.some(model => model.id === 9));
  assert.equal(WEB_MODELS.defaults.image, 15); assert.equal(WEB_MODELS.defaults.video, 30);
  assert.ok(!WEB_MODELS.images.some(model => model.id === 7));
  assert.ok(!WEB_MODELS.videos.some(model => model.id === 20));
  assert.ok(WEB_MODELS.source_files.every(file => !isAbsolute(file) && !file.includes('..')));
  assert.equal(musicSchema.safeParse({ mv: 'v5.5', style: 'Acoustic instrumental', instrumental: true }).success, false);
});

test('all nine removed models fail public and internal validation without backend requests', async t => {
  const f = await fixture(t), music = new MusicAdapter(f.cfg), video = new VideoAdapter(f.cfg);
  for (const mv of ['v3.0', 'v3.5', 'v4.0', 'v4.5', 'v4.5-plus', 'v5.0', 'v5.5']) {
    const params = { mv, style: 'Acoustic instrumental', instrumental: true };
    assert.equal(musicSchema.safeParse(params).success, false);
    assert.throws(() => music.validate(params), code('INVALID_PARAMS'));
    await assert.rejects(f.generation.estimate('music', params), code('INVALID_PARAMS'));
  }
  const image = { description: 'A landscape', model_type: 7, number: 1, quality: 6, image_quality: 0, aspect_ratio: 1 };
  assert.equal(imageSchema.safeParse(image).success, false);
  await assert.rejects(f.images.estimate(image), code('UNSUPPORTED_OPTIONS'));
  await assert.rejects(f.images.backend.create(image), code('UNSUPPORTED_OPTIONS'));
  for (const frames of [{}, { first_reference_image_id: id }, { first_reference_image_id: id, end_reference_image_id: randomUUID() }]) {
    const params = { content: 'Clouds move', model_type: 20, duration: 30, mode: 35, ...frames };
    assert.equal(videoSchema.safeParse(params).success, false);
    assert.throws(() => video.validate(params), code('INVALID_PARAMS'));
    await assert.rejects(f.generation.estimate('video', params), code('INVALID_PARAMS'));
  }
  assert.equal(f.calls.length, 0);
});

test('saved quotes for removed models cannot reach price previews or paid submissions', async t => {
  const f = await fixture(t);
  const music = await f.generation.estimate('music', { mv: 'v6-pro', style: 'Acoustic instrumental', instrumental: true });
  const video = await f.generation.estimate('video', { content: 'Clouds move', model_type: 30, duration: 52, real_duration: 7, mode: 64 });
  const image = await f.images.estimate({ description: 'A landscape', model_type: 15, number: 1, quality: 25, image_quality: 0, aspect_ratio: 2 });
  const before = f.calls.length, budget = { music_credits: 10, credits: 100, video_units: 100 };
  for (const mv of ['v3.0', 'v3.5', 'v4.0', 'v4.5', 'v4.5-plus', 'v5.0', 'v5.5']) {
    await f.generation.store.transaction(async state => { state.generation_quotes![music.quote_id]!.params.mv = mv; await f.generation.store.save(state); });
    await assert.rejects(f.generation.generate('music', music.quote_id, `removed-${mv.replaceAll('.', '-')}`, budget), code('INVALID_PARAMS'));
  }
  await f.generation.store.transaction(async state => {
    state.generation_quotes![video.quote_id]!.params = { content: 'Clouds move', model_type: 20, duration: 30, mode: 35, aspect_ratio: 1 };
    await f.generation.store.save(state);
  });
  await assert.rejects(f.generation.generate('video', video.quote_id, 'removed-basic', budget), code('INVALID_PARAMS'));
  await f.images.store.transaction(async state => { Object.assign(state.quotes[image.quote_id]!.params, { model_type: 7, quality: 6 }); await f.images.store.save(state); });
  await assert.rejects(f.images.generate(image.quote_id, 'removed-zimage', 2), code('UNSUPPORTED_OPTIONS'));
  assert.equal(f.calls.length, before);
  assert.ok(!f.calls.some(call => ['/v2/async/text-to-song', '/ai_video/generation', '/v3/draw/text-to-image'].includes(call.path)));
});

test('all current image contracts reach the schema, including high quality IDs and per-model reference limits', () => {
  for (const model of WEB_MODELS.images) for (const [operation, c] of Object.entries(model.operations)) {
    const input = { model_type: model.id, description: 'An illustrated landscape', quality: c.qualities[0]!.value, image_quality: c.quality_levels[0]!.value,
      number: c.numbers[0]!.value, aspect_ratio: c.aspect_ratios[0]!.value, ...(operation === 'image' ? { reference_image_ids: [id] } : {}) };
    assert.equal(imageSchema.safeParse(input).success, true, `${model.name}/${operation}`);
  }
  const nano = { model_type: 15, description: 'A landscape', quality: 26, image_quality: 0, aspect_ratio: 2 };
  assert.equal(imageSchema.safeParse(nano).success, true);
  assert.equal(imageSchema.safeParse({ ...nano, reference_image_ids: Array.from({ length: 10 }, randomUUID) }).success, true);
  for (const invalid of [{ ...nano, quality: 22 }, { ...nano, number: 2 }, { ...nano, reference_image_ids: Array.from({ length: 11 }, randomUUID) },
    { ...nano, model_type: 12, quality: 16, description: 'a'.repeat(801) }, { ...nano, model_type: 12, quality: 16, reference_image_ids: [id, randomUUID()] },
    { ...nano, model_type: 14, quality: 22, image_quality: 3, aspect_ratio: 0 }, { ...nano, model_type: 999 }]) assert.equal(imageSchema.safeParse(invalid).success, false);
});

test('every current video operation has a valid schema path using backend duration protocols', () => {
  for (const model of WEB_MODELS.videos) for (const [operation, c] of Object.entries(model.operations)) {
    const accepted = c.durations.some(d => c.modes.some(m => videoSchema.safeParse({ content: 'A landscape moves', model_type: model.id, duration: model.duration_protocol ?? d.value,
      real_duration: d.seconds, mode: m.value, aspect_ratio: c.aspect_ratios[0]?.value ?? 1,
      ...(operation === 'image_to_video' ? { first_reference_image_id: id } : operation === 'reference_to_video' ? { reference_images: [{ reference_image_id: id }] } : {}) }).success));
    assert.equal(accepted, true, `${model.name}/${operation}`);
  }
  const seedance = { content: 'A landscape moves', model_type: 38, duration: 58, real_duration: 30, mode: 55 };
  assert.equal(videoSchema.safeParse(seedance).success, true);
  assert.equal(videoSchema.safeParse({ ...seedance, operation: 'omni_reference_to_video', reference_images: Array.from({ length: 30 }, () => ({ reference_image_id: randomUUID() })) }).success, true);
  for (const invalid of [{ ...seedance, real_duration: 31 }, { ...seedance, duration: 4830 }, { ...seedance, real_duration: undefined },
    { ...seedance, model_type: 36, duration: 48 }, { ...seedance, model_type: 2, duration: 8, real_duration: 8, mode: 5, first_reference_image_id: id, end_reference_image_id: randomUUID() },
    { ...seedance, model_type: 35, duration: 56, real_duration: 5, mode: 74 }, { ...seedance, model_type: 14, duration: 22, real_duration: 5, mode: 28, first_reference_image_id: id },
    { content: 'A landscape', model_type: 5, duration: 3, mode: 7 }, { content: 'A landscape', model_type: 18, duration: 43, mode: 45 }]) assert.equal(videoSchema.safeParse(invalid).success, false);
});

test('missing price rows and failed price services never hide configured models', async t => {
  const f = await fixture(t);
  f.state.rows = false;
  for (const failCatalog of [false, true]) {
    f.state.failCatalog = failCatalog;
    const images = await f.images.models(), music = await new MusicAdapter(f.cfg).models(), video = await new VideoAdapter(f.cfg).models();
    assert.equal(images.models.length, 11); assert.equal(music.models.length, 3); assert.equal(video.models.length, 21);
    assert.ok(images.models.every(model => model.pricing.length === 0));
    assert.ok(video.models.every(model => model.pricing.length === 0));
    assert.equal(images.models[0]?.pricing_status, failCatalog ? 'NETWORK_ERROR' : 'not_configured');
    assert.equal(music.models[0]?.pricing_status, failCatalog ? 'NETWORK_ERROR' : 'default_rule');
    assert.ok(!JSON.stringify({ images, music, video }).includes('synthetic upstream'));
  }
  f.state.failQuote = true;
  await assert.rejects(f.generation.estimate('music', { mv: 'v6-pro', style: 'Acoustic instrumental', instrumental: true }), code('HTTP_ERROR'));
  assert.ok(!f.calls.some(call => call.path === '/v2/async/text-to-song'));
});

test('V6 quotes and submissions preserve actual model IDs, backend totals and one durable submit', async t => {
  const f = await fixture(t), params = { mv: 'v6-pro', style: 'Acoustic instrumental', instrumental: true };
  const quote = await f.generation.estimate('music', params);
  assert.deepEqual(quote.costs, [{ resource: 'music_credits', amount: 7 }, { resource: 'credits', amount: 70 }]);
  const task = await f.generation.generate('music', quote.quote_id, 'v6', { music_credits: 7, credits: 70 });
  assert.equal(task.params.mv, 'v6-pro');
  await f.generation.generate('music', quote.quote_id, 'v6', {});
  assert.equal(f.calls.filter(call => call.path === '/v2/async/text-to-song').length, 1);
  assert.equal(f.calls.find(call => call.path === '/v2/async/text-to-song')!.body.mv, 'v6-pro');
  assert.ok(f.calls.some(call => call.path.includes('mv=v6-pro')));
  assert.equal(musicSchema.safeParse({ ...params, style: 'a'.repeat(981) }).success, false);
});

test('a malformed price row cannot hide the complete catalog or leak upstream data', async t => {
  const f = await fixture(t), adapter = new VideoAdapter(f.cfg);
  const priced = await adapter.models();
  assert.equal(priced.models.find(model => model.model_type === 30)?.pricing[0]?.rule_credits, null);
  f.state.invalidPrice = true;
  const catalog = await adapter.models();
  assert.equal(catalog.models.length, 21);
  assert.equal(catalog.models.find(model => model.model_type === 30)?.pricing_status, 'INVALID_RESPONSE');
  assert.deepEqual(catalog.models.find(model => model.model_type === 30)?.pricing, []);
});

test('new image model quotes enforce exact live price tuples and count before a paid submit', async t => {
  const f = await fixture(t), nano = { description: 'A landscape', model_type: 15, number: 1, quality: 25, image_quality: 0, aspect_ratio: 2 };
  assert.ok(!(await f.images.backend.prices()).some(row => row.model_type === 7));
  assert.ok(!(await f.images.models()).models.some(model => model.model_type === 7));
  const quote = await f.images.estimate(nano); assert.equal(quote.credits, 2);
  await f.images.generate(quote.quote_id, 'nano', 2);
  assert.equal(f.calls.find(call => call.path === '/v3/draw/text-to-image')!.body.model_type, 15);
  const sunburst = await f.images.estimate({ ...nano, model_type: 14, quality: 22, image_quality: 5, number: 10 });
  assert.equal(sunburst.credits, 30);
  await assert.rejects(f.images.estimate({ ...nano, quality: 26 }), code('UNSUPPORTED_OPTIONS'));
  assert.equal(f.calls.filter(call => call.path === '/v3/draw/text-to-image').length, 1);
});

test('new variable-duration video quotes bind seconds and audio to the exact submit', async t => {
  const f = await fixture(t), params = { content: 'Clouds move', model_type: 30, duration: 52, real_duration: 7, mode: 64, generate_audio: true };
  const quote = await f.generation.estimate('video', params);
  assert.equal(quote.costs[0]?.amount, 2.52);
  await f.generation.generate('video', quote.quote_id, 'pixverse', { video_units: 2.52, credits: 7 });
  const submitted = f.calls.find(call => call.path === '/ai_video/generation')!.body;
  assert.equal(submitted.duration, 52); assert.equal(submitted.real_duration, 7); assert.equal(submitted.generate_audio_switch, '1');
  for (const preview of f.calls.filter(call => ['/ai_video/price/preview', '/ai_video/consume_preview'].includes(call.path))) {
    assert.equal(preview.body.real_duration, 7); assert.equal(preview.body.generate_audio_switch, 1);
  }
  f.state.effective = { real_duration: 8 };
  await assert.rejects(f.generation.estimate('video', params), code('PRICE_UNAVAILABLE'));
});

test('Seedance 2.5 quotes and submits thirty ordered image references and thirty seconds', async t => {
  const f = await fixture(t), images = await saveImages(new Store(f.cfg.dataDir), 30);
  const params = { content: '@Image30 opens the scene', operation: 'omni_reference_to_video', model_type: 38, duration: 58, real_duration: 30, mode: 55, reference_images: images.map(image => ({ reference_image_id: image.reference_image_id })) };
  const quote = await f.generation.estimate('video', params);
  await f.generation.generate('video', quote.quote_id, 'seedance25', { video_units: 10.8, credits: 30 });
  const submitted = f.calls.find(call => call.path === '/ai_video/generation')!.body;
  assert.equal(submitted.duration, 58); assert.equal(submitted.real_duration, 30); assert.equal(submitted.fusion_imgs.length, 30);
  assert.equal(submitted.fusion_imgs[29].img_url, images[29]!.url); assert.equal(submitted.shot_content, '[Image30] opens the scene');
  assert.equal(submitted.seedance_generation_mode, 'allInOne');
});

test('single-image reference providers use the same fusion task in pricing and submission', async t => {
  const f = await fixture(t), [image] = await saveImages(new Store(f.cfg.dataDir), 1);
  const quote = await f.generation.estimate('video', { content: 'Clouds move', model_type: 2, duration: 8, mode: 5, first_reference_image_id: image!.reference_image_id });
  assert.equal(f.calls.find(call => call.path === '/ai_video/price/preview')!.body.task_type, 10);
  await f.generation.generate('video', quote.quote_id, 'veo', { video_units: 2.88, credits: 8 });
  const submitted = f.calls.find(call => call.path === '/ai_video/generation')!.body;
  assert.equal(submitted.first_image_url, undefined); assert.deepEqual(submitted.fusion_imgs, [{ type: 'subject', img_url: image!.url }]);
});
