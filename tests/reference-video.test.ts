import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { productionEnvironment } from './fixtures/production.js';
import { createServer } from '../src/server.js';
import { ImageService } from '../src/service.js';
import { GenerationService } from '../src/generation/service.js';
import { VideoAdapter, videoSchema } from '../src/generation/video.js';
import { ReferenceMediaService, prepareReferenceMedia, mediaReferenceUrl, MEDIA_REFERENCE_PREFIX, MEDIA_REFERENCE_SOURCE } from '../src/media/reference-media.js';
import { readLocalMedia } from '../src/media/local-file.js';
import { REFERENCE_PREFIX } from '../src/reference-url.js';
import { TopMediaiError } from '../src/types.js';

const run = promisify(execFile);
const input = { content: '@Image1 walks across the garden', model_type: 30, duration: 52, real_duration: 5, mode: 64 };
const omni = { content: '@Image1 follows @Video1 with @Audio1', operation: 'omni_reference_to_video', model_type: 26, duration: 48, real_duration: 5, mode: 55 };
const budget = { video_units: 1.8, credits: 2 };
const code = (expected: string) => (error: unknown) => error instanceof TopMediaiError && error.code === expected;

async function fixture(t: TestContext, environment: 'production' | 'production' = 'production') {
  const parent = resolve(tmpdir()), dir = await mkdtemp(resolve(parent, 'topmediai-reference-video-'));
  const root = resolve(dir, 'media'); await mkdir(root);
  t.after(async () => { const suffix = relative(parent, dir); assert.ok(suffix.startsWith('topmediai-reference-video-') && !isAbsolute(suffix) && !suffix.startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  const file = resolve(root, 'image.png');
  await writeFile(file, await sharp({ create: { width: 400, height: 400, channels: 3, background: '#99aabb' } }).png().toBuffer());
  const cfg = loadConfig({ TOPMEDIAI_ENV: environment, ...(environment === 'production' ? productionEnvironment : {}), TOPMEDIAI_DATA_DIR: dir, TOPMEDIAI_TOKEN: 'F'.repeat(42), TOPMEDIAI_UPLOAD_ROOT: root,
    TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid', TOPMEDIAI_TTS_HOST: 'https://video.fixture.invalid', TOPMEDIAI_UPLOAD_HOST: 'https://upload.fixture.invalid' }, () => null);
  const calls: { path: string; body: any }[] = [];
  const state = { login: 200, uploadFailure: false, submitFailure: false, uploads: 0, effective: {} as Record<string, unknown>, uploadUrl: '', unitPrice: undefined as number | undefined };
  t.mock.method(globalThis, 'fetch', async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(raw instanceof Request ? raw.url : raw);
    assert.ok([cfg.memberHost, cfg.ttsHost, cfg.uploadHost].includes(url.origin), 'No real endpoint is allowed');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers); assert.equal(headers.get('token'), cfg.token); assert.equal(headers.get('cookie'), null);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ path: url.pathname + url.search, body });
    let data: unknown;
    if (url.pathname === '/user/member/info') return new Response(JSON.stringify({ status: state.login, data: { member_id: '12345', email: 'fixture@example.invalid' } }));
    else if (url.pathname === '/upload_file') {
      if (state.uploadFailure) throw new Error('Uncertain upload');
      const form = body as FormData, file = form.get('file') as File;
      const media = form.get('source') === MEDIA_REFERENCE_SOURCE;
      const prefix = media ? MEDIA_REFERENCE_PREFIX : REFERENCE_PREFIX, extension = file.name.split('.').at(-1);
      data = { url: state.uploadUrl || `${cfg.uploadPublicOrigin}${prefix}fixture-${++state.uploads}.${extension}` };
    } else if (url.pathname === '/ai_video/price/model_cost') {
      const task = Number(url.searchParams.get('task_type'));
      data = { models: [
        { model_type: 30, model_name: 'PixVerse 6', pricing: [{ duration: 52, duration_seconds: -1, real_duration: -1, task_type: task, mode: 64, quality: '720', version: 'v1', consume: 1.8, points: 2 }] },
        { model_type: 26, model_name: 'Seedance 2', pricing: [{ duration: 48, duration_seconds: -1, real_duration: 5, task_type: task, mode: 55, quality: '720', version: 'v1', consume: 1.8, points: 2 }] },
        { model_type: 24, model_name: 'Kling O1', pricing: [{ duration: 47, duration_seconds: -1, real_duration: -1, task_type: task, mode: 53, quality: '720', version: 'v1', consume: 1.8, points: 2 }] },
      ] };
    } else if (url.pathname === '/ai_video/price/preview') data = { ...body, consume: state.unitPrice ?? 1.8, ...(state.unitPrice !== undefined ? { real_duration: -1 } : {}), points: 99, price_rule_id: 71, version: 'v1' };
    else if (url.pathname === '/ai_video/consume_preview') data = { ...body, consume: 1.8, points: 2, ...state.effective };
    else if (url.pathname === '/ai_video/generation') { if (state.submitFailure) throw new Error('Uncertain submission'); data = { task_id: '9001' }; }
    else if (url.pathname === '/ai_video/batch/detail') data = { data_list: [{ task_id: '9001', task_status: 2, audio_url: 'https://media.fixture.invalid/video.mp4' }] };
    else assert.fail(`Unexpected route ${url.pathname}`);
    return new Response(JSON.stringify({ status: 200, check_code: 200000, data }));
  });
  return { cfg, file, root, calls, state, images: new ImageService(cfg), media: new ReferenceMediaService(cfg), service: new GenerationService(cfg) };
}

async function mediaFiles(root: string) {
  const video = resolve(root, 'video.mp4'), audio = resolve(root, 'audio.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=854x480:r=10:d=2.1', '-threads', '1', '-c:v', 'libx264', '-metadata', 'title=private-fixture-title', '-y', video], { windowsHide: true });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.1', '-threads', '1', '-metadata', 'title=private-fixture-title', '-y', audio], { windowsHide: true });
  return { video, audio };
}

test('production MCP multi-image reference flow preserves roles, order, prompt tags and backend task type 10', async t => {
  const f = await fixture(t, 'production'), server = createServer(f.cfg), client = new Client({ name: 'reference-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent as any; };
  assert.equal((await client.listTools()).tools.length, 35);
  const first = await call('upload_reference_image', { file_path: f.file }), second = await call('upload_reference_image', { file_path: f.file });
  const catalog = await call('list_video_models', { operation: 'reference_to_video' });
  assert.equal(catalog.task_type, 10); assert.equal(catalog.models.find((model: any) => model.model_type === 30).pricing[0].duration_seconds, null);
  const quote = await call('estimate_video_cost', { ...input, reference_images: [{ reference_image_id: first.reference_image_id }, { reference_image_id: second.reference_image_id, type: 'background' }] });
  assert.equal(quote.operation, 'reference_to_video');
  assert.equal(f.calls.find(c => c.path === '/ai_video/price/preview')!.body.task_type, 10);
  const task = await call('generate_video', { quote_id: quote.quote_id, request_id: 'multi', budget });
  const submitted = f.calls.find(c => c.path === '/ai_video/generation')!.body;
  assert.deepEqual(submitted.fusion_imgs, [{ type: 'subject', img_url: first.url, ref_name: 'Image1' }, { type: 'background', img_url: second.url, ref_name: 'Image2' }]);
  assert.equal(submitted.real_duration, 5); assert.equal(submitted.duration, 52); assert.equal(submitted.aspect_ratio, 1);
  assert.equal(submitted.reference_images, undefined); assert.equal(submitted.first_image_url, undefined);
  assert.equal((await call('get_generation_task', { task_handle: task.task_handle })).status, 'completed');
});

test('production media upload verifies MP4/WAV, strips metadata and uses random names', async t => {
  const f = await fixture(t, 'production'), files = await mediaFiles(f.root);
  for (const [kind, file] of [['video', files.video], ['audio', files.audio]] as const) {
    const result = await f.media.upload(file, kind);
    assert.equal(result.media_type, kind); assert.ok(result.duration_seconds >= 2 && result.duration_seconds < 2.3);
    const upload = f.calls.filter(c => c.path === '/upload_file').at(-1)!.body as FormData, blob = upload.get('file') as File;
    assert.match(blob.name, /^[a-f0-9-]+\.(mp4|wav)$/); assert.equal(upload.get('source'), MEDIA_REFERENCE_SOURCE);
    assert.ok(!Buffer.from(await blob.arrayBuffer()).includes(Buffer.from('private-fixture-title')));
    await f.images.store.transaction(async state => { assert.equal(state.reference_media?.[result.reference_media_id]?.sha256, result.sha256); });
  }
  assert.ok(!f.calls.some(c => c.path === '/ai_video/generation'));
});

test('mixed image/video/audio reference quote uses backend floor duration and exact asset snapshot', async t => {
  const f = await fixture(t), files = await mediaFiles(f.root), image = await f.images.uploadReferenceImage(f.file);
  const video = await f.media.upload(files.video, 'video'), audio = await f.media.upload(files.audio, 'audio');
  const params = { ...omni, generate_audio: true, reference_images: [{ reference_image_id: image.reference_image_id }], reference_video_ids: [video.reference_media_id], reference_audio_ids: [audio.reference_media_id] };
  const quote = await f.service.estimate('video', params);
  assert.equal(quote.operation, 'omni_reference_to_video');
  const preview = f.calls.find(c => c.path === '/ai_video/price/preview')!.body;
  assert.equal(preview.task_type, 14); assert.equal(preview.video_duration, Math.floor(video.duration_seconds)); assert.equal(preview.generate_audio_switch, 1);
  const resumed = new GenerationService(f.cfg), task = await resumed.generate('video', quote.quote_id, 'omni', budget);
  const submitted = f.calls.find(c => c.path === '/ai_video/generation')!.body;
  assert.equal(submitted.seedance_generation_mode, 'allInOne'); assert.deepEqual(submitted.video_list, [video.url]); assert.deepEqual(submitted.audio_list, [audio.url]);
  assert.equal(submitted.shot_content, '[Image1] follows [Video1] with [Audio1]'); assert.equal(submitted.generate_audio_switch, '1');
  await resumed.generate('video', quote.quote_id, 'omni', {}); assert.equal(f.calls.filter(c => c.path === '/ai_video/generation').length, 1);
  assert.equal((await resumed.task(task.task_handle)).status, 'completed');
  const extendedAudioVideo = resolve(f.root, 'audio-longer.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=854x480:r=10:d=2.9',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.1', '-c:v', 'libx264', '-c:a', 'aac', '-threads', '1', '-y', extendedAudioVideo], { windowsHide: true });
  const extended = await f.media.upload(extendedAudioVideo, 'video');
  assert.ok(extended.duration_seconds >= 3.1, 'Use full container duration, including the longer audio stream');
  await f.service.estimate('video', { ...omni, content: '@Video1 moves', reference_video_ids: [extended.reference_media_id] });
  assert.equal(f.calls.filter(c => c.path === '/ai_video/consume_preview').at(-1)!.body.video_duration, 3);
});

test('Kling O1 prompt placeholders and image-only Seedance all-in-one use distinct contracts', async t => {
  const f = await fixture(t), image = await f.images.uploadReferenceImage(f.file), images = [{ reference_image_id: image.reference_image_id }];
  const kling = await f.service.estimate('video', { ...input, model_type: 24, duration: 47, mode: 53, reference_images: images });
  await f.service.generate('video', kling.quote_id, 'kling', budget);
  assert.equal(f.calls.find(c => c.path === '/ai_video/generation')!.body.shot_content, '<<<image_1>>> walks across the garden');
  const quote = await f.service.estimate('video', { ...omni, content: '@Image1 moves', reference_images: images });
  await f.service.generate('video', quote.quote_id, 'image-omni', budget);
  assert.equal(f.calls.filter(c => c.path === '/ai_video/generation').at(-1)!.body.seedance_generation_mode, 'allInOne');
});

test('reference schemas reject frame mixing, duplicate materials, audio-only, unsupported modes and out-of-range tags', () => {
  const id = randomUUID(), images = [{ reference_image_id: id }], valid = { ...input, reference_images: images };
  assert.equal(videoSchema.safeParse(valid).success, true);
  for (const invalid of [
    { ...valid, first_reference_image_id: randomUUID() }, { ...valid, real_duration: undefined },
    { ...valid, reference_images: [images[0], images[0]] }, { ...valid, content: '@Image2' },
    { ...valid, operation: 'text_to_video' }, { ...valid, reference_video_ids: [id] },
    { ...valid, reference_images: Array.from({ length: 8 }, () => ({ reference_image_id: randomUUID() })) },
    { ...omni, reference_audio_ids: [id] }, { ...valid, model_type: 24, duration: 47, mode: 53, real_duration: 6 },
    { ...valid, video_list: ['http://127.0.0.1/private'] }, { ...valid, reference_images: [{ reference_image_id: id, type: 'arbitrary' }] },
  ]) assert.equal(videoSchema.safeParse(invalid).success, false);
});

test('media boundary rejects disguised files, traversal, hardlinks, bad containers and long media before upload', async t => {
  const f = await fixture(t), files = await mediaFiles(f.root);
  const fake = resolve(f.root, 'fake.mp4'); await writeFile(fake, await readFile(f.file));
  await assert.rejects(readLocalMedia(f.root, fake, 'video'), code('INVALID_REFERENCE_MEDIA'));
  await assert.rejects(readLocalMedia(f.root, '../outside.wav', 'audio'), code('INVALID_REFERENCE_MEDIA'));
  const hardlink = resolve(f.root, 'linked.wav'); await link(files.audio, hardlink);
  await assert.rejects(readLocalMedia(f.root, hardlink, 'audio'), code('INVALID_REFERENCE_MEDIA'));
  const corrupt = resolve(f.root, 'corrupt.mp4'); await writeFile(corrupt, Buffer.from('0000ftypinvalid-data'));
  await assert.rejects(f.media.upload(corrupt, 'video'), code('INVALID_REFERENCE_MEDIA'));
  const long = resolve(f.root, 'long.wav'); await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=16', '-y', long], { windowsHide: true });
  await assert.rejects(f.media.upload(long, 'audio'), code('INVALID_REFERENCE_MEDIA'));
  await assert.rejects(prepareReferenceMedia(f.root, files.video, 'video', { ...f.cfg, ffprobePath: resolve(f.root, 'missing-ffprobe.exe') }), code('MEDIA_PROBE_UNAVAILABLE'));
  assert.equal(f.calls.length, 0);
});

test('media upload configuration and login failures block transmission, uncertain upload mints no ID', async t => {
  const f = await fixture(t), files = await mediaFiles(f.root);
  for (const config of [
    { ...f.cfg, uploadRoot: undefined }, { ...f.cfg, uploadHost: undefined },
    { ...f.cfg, gatewayHost: 'https://gateway.fixture.invalid' },
  ]) await assert.rejects(new ReferenceMediaService(config).upload(files.audio, 'audio'), code('REFERENCE_MEDIA_UPLOAD_DISABLED'));
  assert.equal(f.calls.length, 0);
  f.state.login = 401; await assert.rejects(f.media.upload(files.audio, 'audio'), code('LOGIN_REQUIRED'));
  assert.ok(!f.calls.some(c => c.path === '/upload_file'));
  f.state.login = 200; f.state.uploadFailure = true;
  await assert.rejects(f.media.upload(files.audio, 'audio'), code('NETWORK_ERROR'));
  assert.equal(f.calls.filter(c => c.path === '/upload_file').length, 1);
  await f.images.store.transaction(async state => { assert.equal(Object.keys(state.reference_media ?? {}).length, 0); });
  assert.throws(() => mediaReferenceUrl(`https://evil.invalid${MEDIA_REFERENCE_PREFIX}audio.wav`, 'https://files.topmediai.com', 'audio'), code('INVALID_UPLOAD_URL'));
});

test('missing/wrong/foreign media IDs and aggregate duration limits fail before any paid submission', async t => {
  const f = await fixture(t), files = await mediaFiles(f.root), image = await f.images.uploadReferenceImage(f.file), video = await f.media.upload(files.video, 'video');
  const params = { ...omni, content: '@Image1 moves', reference_images: [{ reference_image_id: image.reference_image_id }] };
  await assert.rejects(f.service.estimate('video', { ...params, reference_video_ids: [randomUUID()] }), code('REFERENCE_MEDIA_NOT_FOUND'));
  await assert.rejects(f.service.estimate('video', { ...params, reference_audio_ids: [video.reference_media_id] }), code('REFERENCE_MEDIA_NOT_FOUND'));
  await assert.rejects(new GenerationService({ ...f.cfg, dataDir: resolve(f.cfg.dataDir, 'other') }).estimate('video', { ...params, reference_video_ids: [video.reference_media_id] }), code('REFERENCE_IMAGE_NOT_FOUND'));
  const clone = { ...video, reference_media_id: randomUUID(), duration_seconds: 8 };
  await f.images.store.transaction(async state => { state.reference_media![video.reference_media_id]!.duration_seconds = 8; state.reference_media![clone.reference_media_id] = clone; await f.images.store.save(state); });
  await assert.rejects(f.service.estimate('video', { ...params, reference_video_ids: [video.reference_media_id, clone.reference_media_id] }), code('INVALID_REFERENCE_MEDIA'));
  assert.ok(!f.calls.some(c => c.path.startsWith('/ai_video/')));
});

test('media changes, incorrect duration previews and lost paid responses retain quote protections', async t => {
  const f = await fixture(t), files = await mediaFiles(f.root), image = await f.images.uploadReferenceImage(f.file), video = await f.media.upload(files.video, 'video');
  const params = { ...omni, content: '@Image1 follows @Video1', reference_images: [{ reference_image_id: image.reference_image_id }], reference_video_ids: [video.reference_media_id] };
  f.state.effective = { video_duration: 9 };
  await assert.rejects(f.service.estimate('video', params), code('PRICE_UNAVAILABLE'));
  f.state.effective = {};
  const quote = await f.service.estimate('video', params);
  await f.images.store.transaction(async state => { state.reference_media![video.reference_media_id]!.sha256 = 'a'.repeat(64); await f.images.store.save(state); });
  await assert.rejects(f.service.generate('video', quote.quote_id, 'changed', budget), code('PRICE_CHANGED'));
  const next = await f.service.estimate('video', params); f.state.submitFailure = true;
  const task = await f.service.generate('video', next.quote_id, 'uncertain', budget);
  assert.equal(task.status, 'submission_unknown');
  assert.equal((await new GenerationService(f.cfg).generate('video', next.quote_id, 'uncertain', {})).task_handle, task.task_handle);
  assert.equal(f.calls.filter(c => c.path === '/ai_video/generation').length, 1);
});

test('reference catalogs exclude unsupported omni models and select the sound generation price dimension', async t => {
  const f = await fixture(t), adapter = new VideoAdapter(f.cfg), catalog = await adapter.models('omni_reference_to_video', true);
  assert.deepEqual(catalog.models.map(model => model.model_type), [38, 36, 33, 26]);
  assert.ok(f.calls[0]!.path.includes('task_type=14'));
  assert.equal(catalog.models.find(model => model.model_type === 26)!.pricing[0]!.real_duration, 5);
  const caps = f.service.capabilities().capabilities.find(cap => cap.kind === 'video')!;
  assert.equal(caps.reference_media_upload_enabled, true);
});

test('Seedance 2.5 explicitly enables longer media uploads while older models keep their limits', async t => {
  const f = await fixture(t), file = resolve(f.root, 'sixteen-seconds.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=16', '-y', file], { windowsHide: true });
  await assert.rejects(f.media.upload(file, 'audio'), code('INVALID_REFERENCE_MEDIA'));
  const audio = await f.media.upload(file, 'audio', 38), image = await f.images.uploadReferenceImage(f.file);
  assert.ok(audio.duration_seconds >= 16 && audio.duration_seconds < 16.2);
  const params = { ...omni, model_type: 38, duration: 58, real_duration: 30, content: '@Image1 follows @Audio1', reference_images: [{ reference_image_id: image.reference_image_id }], reference_audio_ids: [audio.reference_media_id] };
  const quote = await f.service.estimate('video', params);
  assert.equal(quote.params.real_duration, 30);
  await assert.rejects(f.service.estimate('video', { ...params, model_type: 26, duration: 48, real_duration: 15 }), code('INVALID_REFERENCE_MEDIA'));
  assert.ok(!f.calls.some(call => call.path === '/ai_video/generation'));
});

test('per-second price rules use backend decimal HALF_UP totals rather than comparing unit prices', async t => {
  const f = await fixture(t), image = await f.images.uploadReferenceImage(f.file);
  const params = { ...input, reference_images: [{ reference_image_id: image.reference_image_id }] };
  f.state.unitPrice = 0.36;
  assert.equal((await f.service.estimate('video', params)).costs[0]?.amount, 1.8);
  f.state.unitPrice = 0.325; f.state.effective = { consume: 1.63 };
  assert.equal((await f.service.estimate('video', params)).costs[0]?.amount, 1.63);
  f.state.effective = { consume: 1.62 };
  await assert.rejects(f.service.estimate('video', params), code('PRICE_UNAVAILABLE'));
});
