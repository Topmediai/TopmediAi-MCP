import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { ImageService } from '../src/service.js';
import { GenerationService } from '../src/generation/service.js';
import { VideoAdapter, videoSchema } from '../src/generation/video.js';
import { REFERENCE_PREFIX, REFERENCE_SOURCE } from '../src/reference-url.js';
import { TopMediaiError, type ReferenceImage } from '../src/types.js';

const input = { content: 'The clouds move slowly over the mountain', model_type: 21, duration: 34, mode: 38 };
const budget = { video_units: 1.8, credits: 2 };
const code = (expected: string) => (error: unknown) => error instanceof TopMediaiError && error.code === expected;

async function fixture(t: TestContext) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(resolve(parent, 'topmediai-video-frames-'));
  const root = resolve(dir, 'frames'); await mkdir(root);
  t.after(async () => {
    const rel = relative(parent, dir);
    assert.ok(rel.startsWith('topmediai-video-frames-') && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  const file = resolve(root, 'original-private-name.png');
  await writeFile(file, await sharp({ create: { width: 100, height: 80, channels: 3, background: '#668899' } }).png().toBuffer());
  const cfg = loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_DATA_DIR: dir, TOPMEDIAI_TOKEN: 'V'.repeat(42),
    TOPMEDIAI_MEMBER_HOST: 'https://member.fixture.invalid', TOPMEDIAI_TTS_HOST: 'https://video.fixture.invalid',
    TOPMEDIAI_UPLOAD_HOST: 'https://upload.fixture.invalid', TOPMEDIAI_UPLOAD_ROOT: root }, () => null);
  const calls: { path: string; body: any }[] = [];
  const state = { failSubmit: false, effective: {} as Record<string, unknown>, priceTaskType: undefined as number | undefined, uploads: 0 };
  t.mock.method(globalThis, 'fetch', async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(raw instanceof Request ? raw.url : raw);
    assert.ok([cfg.memberHost, cfg.ttsHost, cfg.uploadHost].includes(url.origin), 'Only isolated fixture endpoints are allowed');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('token'), cfg.token); assert.equal(headers.get('cookie'), null);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ path: url.pathname + url.search, body });
    let data: unknown;
    if (url.pathname === '/user/member/info') data = { member_id: '12345', email: 'fixture@example.invalid' };
    else if (url.pathname === '/upload_file') {
      assert.ok(body instanceof FormData);
      assert.equal(body.get('source'), REFERENCE_SOURCE);
      const uploaded = body.get('file'); assert.ok(uploaded instanceof Blob);
      assert.equal(uploaded.type, 'image/png'); assert.ok(uploaded.size > 0);
      assert.ok('name' in uploaded && /^[a-f0-9-]+\.png$/.test(String(uploaded.name)));
      data = { url: `https://files.topmediai.com${REFERENCE_PREFIX}frame-${++state.uploads}.png` };
    } else if (url.pathname === '/ai_video/price/model_cost') {
      const taskType = Number(url.searchParams.get('task_type'));
      const row = (model_type: number, duration: number, mode: number, duration_seconds: number) => ({ model_type, duration, mode, duration_seconds, task_type: taskType, quality: '720', version: 'v1', consume: 1.8, points: 2 });
      data = { models: [
        { model_type: 20, model_name: 'Basic', pricing: [row(20, 30, 35, 5), { ...row(20, 30, 35, 5), task_type: 3 }] },
        { model_type: 1, model_name: 'Topix', pricing: [row(1, 6, 3, 6), row(1, 10, 4, 10)] },
        { model_type: 21, model_name: 'Pro', pricing: [row(21, 34, 38, 5), row(21, 37, 38, 15), row(21, 37, 50, 15), { ...row(21, 34, 38, 5), task_type: 3 }] },
      ] };
    } else if (url.pathname === '/ai_video/price/preview') data = { ...body, task_type: state.priceTaskType ?? body.task_type, consume: 1.8, points: 99, price_rule_id: 71, version: 'v1' };
    else if (url.pathname === '/ai_video/consume_preview') data = { ...body, consume: 1.8, points: 2, ...state.effective };
    else if (url.pathname === '/ai_video/generation') {
      if (state.failSubmit) throw new Error('Uncertain fixture submission');
      data = { task_id: '8001' };
    } else if (url.pathname === '/ai_video/batch/detail') {
      assert.equal(url.searchParams.get('task_ids'), '8001');
      data = { data_list: [{ task_id: '8001', task_status: 2, audio_url: 'https://media.fixture.invalid/result.mp4' }] };
    } else assert.fail(`Unexpected route ${url.pathname}`);
    return new Response(JSON.stringify({ status: 200, check_code: 200000, data }), { headers: { 'Content-Type': 'application/json' } });
  });
  return { cfg, file, calls, state, images: new ImageService(cfg), service: new GenerationService(cfg) };
}

test('MCP upload, operation catalog, image-to-video quote, single submission and owned polling form a complete flow', async t => {
  const f = await fixture(t), server = createServer(f.cfg), client = new Client({ name: 'video-contract-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent as any;
  };
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 35);
  assert.ok(tools.find(tool => tool.name === 'estimate_video_cost')?.inputSchema.properties?.first_reference_image_id);
  const catalog = await call('list_video_models', { operation: 'image_to_video' });
  assert.equal(catalog.task_type, 2);
  const first = await call('upload_reference_image', { file_path: f.file });
  assert.match(first.storage_notice, /publicly/);
  const quote = await call('estimate_video_cost', { ...input, first_reference_image_id: first.reference_image_id });
  assert.equal(quote.operation, 'image_to_video'); assert.equal(quote.params.first_image_url, undefined);
  assert.deepEqual(quote.costs, [{ resource: 'video_units', amount: 1.8 }, { resource: 'credits', amount: 2 }]);
  for (const preview of f.calls.filter(c => ['/ai_video/price/preview', '/ai_video/consume_preview'].includes(c.path))) assert.equal(preview.body.task_type, 2);
  const task = await call('generate_video', { quote_id: quote.quote_id, request_id: 'first-frame', budget });
  const submitted = f.calls.find(c => c.path === '/ai_video/generation')!.body;
  assert.equal(submitted.first_image_url, first.url); assert.equal(submitted.shot_content, input.content);
  assert.equal(submitted.first_reference_image_id, undefined); assert.equal(submitted.end_reference_image_id, undefined);
  assert.equal(submitted.aspect_ratio, undefined); assert.equal(submitted.task_type, undefined);
  assert.equal(submitted.real_duration, 5); assert.equal(submitted.is_public, '0');
  const queryStart = f.calls.length;
  assert.equal((await call('get_generation_task', { task_handle: task.task_handle })).status, 'completed');
  assert.deepEqual(f.calls.slice(queryStart).map(c => c.path), ['/ai_video/batch/detail?task_ids=8001']);
  await call('generate_video', { quote_id: quote.quote_id, request_id: 'first-frame', budget: {} });
  assert.equal(f.calls.filter(c => c.path === '/ai_video/generation').length, 1);
});

test('first/last-frame video prices task type 4 and keeps exact frame order after restart', async t => {
  const f = await fixture(t), first = await f.images.uploadReferenceImage(f.file), end = await f.images.uploadReferenceImage(f.file);
  const quote = await f.service.estimate('video', { ...input, first_reference_image_id: first.reference_image_id, end_reference_image_id: end.reference_image_id });
  assert.equal(quote.operation, 'image_to_video_start_end');
  assert.equal(f.calls.find(c => c.path === '/ai_video/price/preview')!.body.task_type, 4);
  const restarted = new GenerationService(f.cfg), task = await restarted.generate('video', quote.quote_id, 'two-frames', budget);
  const submitted = f.calls.find(c => c.path === '/ai_video/generation')!.body;
  assert.equal(submitted.first_image_url, first.url); assert.equal(submitted.end_image_url, end.url);
  assert.equal((await restarted.task(task.task_handle)).artifacts[0]?.url, 'https://media.fixture.invalid/result.mp4');
});

test('operation catalogs and schemas enforce Hailuo/Pro contracts and omit Basic despite upstream prices', async t => {
  const f = await fixture(t), adapter = new VideoAdapter(f.cfg), id = randomUUID();
  const text = await adapter.models(), image = await adapter.models('image_to_video'), frames = await adapter.models('image_to_video_start_end');
  assert.equal(text.task_type, 1); assert.equal(image.task_type, 2); assert.equal(frames.task_type, 4);
  for (const catalog of [text, image, frames]) assert.ok(!catalog.models.some(m => m.model_type === 20));
  assert.equal(image.models.find(m => m.model_type === 21)?.pricing.length, 2);
  assert.ok(!frames.models.some(m => m.model_type === 1));
  assert.equal(frames.models.find(m => m.model_type === 21)?.pricing.length, 1);
  assert.equal(videoSchema.safeParse({ ...input, first_reference_image_id: id }).success, true);
  assert.equal(videoSchema.safeParse({ ...input, first_reference_image_id: id, end_reference_image_id: id }).success, true);
  for (const invalid of [
    { ...input, end_reference_image_id: id },
    { ...input, first_reference_image_id: 'not-a-uuid' },
    { ...input, first_image_url: 'https://example.invalid/frame.png' },
    { ...input, first_reference_image_id: id, model_type: 1, duration: 6, mode: 3, end_reference_image_id: id },
    { ...input, first_reference_image_id: id, model_type: 21, duration: 37, mode: 38, end_reference_image_id: id },
    { ...input, model_type: 21, duration: 37, mode: 50 },
    { ...input, first_reference_image_id: id, content: 'a'.repeat(1501) },
  ]) assert.equal(videoSchema.safeParse(invalid).success, false);
  const capabilities = f.service.capabilities().capabilities.find(c => c.kind === 'video')!;
  assert.deepEqual(capabilities.operations, ['text_to_video', 'image_to_video', 'image_to_video_start_end', 'reference_to_video', 'omni_reference_to_video']);
  assert.equal(capabilities.reference_upload_enabled, true);
});

test('unknown and foreign frame IDs fail before price or generation calls', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.estimate('video', { ...input, first_reference_image_id: randomUUID() }), code('REFERENCE_IMAGE_NOT_FOUND'));
  assert.equal(f.calls.length, 0);
  const frame = await f.images.uploadReferenceImage(f.file), before = f.calls.length;
  const other = new GenerationService({ ...f.cfg, dataDir: resolve(f.cfg.dataDir, 'other-account'), token: 'W'.repeat(42) });
  await assert.rejects(other.estimate('video', { ...input, first_reference_image_id: frame.reference_image_id }), code('REFERENCE_IMAGE_NOT_FOUND'));
  assert.equal(f.calls.length, before);
});

test('frame URL and content digest changes invalidate a saved quote before paid submission', async t => {
  const f = await fixture(t), frame = await f.images.uploadReferenceImage(f.file);
  const quote = await f.service.estimate('video', { ...input, first_reference_image_id: frame.reference_image_id });
  await f.images.store.transaction(async state => { state.reference_images![frame.reference_image_id]!.sha256 = 'a'.repeat(64); await f.images.store.save(state); });
  await assert.rejects(f.service.generate('video', quote.quote_id, 'changed-frame', budget), code('PRICE_CHANGED'));
  await f.images.store.transaction(async state => { state.reference_images![frame.reference_image_id]!.url = 'http://127.0.0.1/private.png'; await f.images.store.save(state); });
  await assert.rejects(f.service.generate('video', quote.quote_id, 'changed-url', budget), code('INVALID_UPLOAD_URL'));
  assert.ok(!f.calls.some(c => c.path === '/ai_video/generation'));
});

test('paid submission uses the exact frame snapshot verified by the fresh quote', async t => {
  const f = await fixture(t), frame = await f.images.uploadReferenceImage(f.file);
  const quote = await f.service.estimate('video', { ...input, first_reference_image_id: frame.reference_image_id });
  const adapter = f.service.adapter('video'), create = adapter.create.bind(adapter);
  t.mock.method(adapter, 'create', async (params: Record<string, unknown>, references?: ReferenceImage[]) => {
    await f.images.store.transaction(async state => { state.reference_images![frame.reference_image_id]!.url = `https://files.topmediai.com${REFERENCE_PREFIX}changed.png`; await f.images.store.save(state); });
    return create(params, references);
  });
  await f.service.generate('video', quote.quote_id, 'snapshot', budget);
  assert.equal(f.calls.find(c => c.path === '/ai_video/generation')!.body.first_image_url, frame.url);
});

test('image-to-video rejects incorrect operation and entitlement previews', async t => {
  const f = await fixture(t), frame = await f.images.uploadReferenceImage(f.file), params = { ...input, first_reference_image_id: frame.reference_image_id };
  f.state.priceTaskType = 1;
  await assert.rejects(f.service.estimate('video', params), code('PRICE_UNAVAILABLE'));
  f.state.priceTaskType = -1; // Generic price rules are valid; actual preview must still match.
  for (const effective of [{ task_type: 1 }, { real_duration: 10 }, { generate_audio_switch: 1 }, { multiple_shot: 1 }]) {
    f.state.effective = effective;
    await assert.rejects(f.service.estimate('video', params), code('PRICE_UNAVAILABLE'));
  }
  assert.ok(!f.calls.some(c => c.path === '/ai_video/generation'));
});

test('image video keeps capability controls, all budgets and durable uncertain-submission protection', async t => {
  const f = await fixture(t), frame = await f.images.uploadReferenceImage(f.file);
  const quote = await f.service.estimate('video', { ...input, first_reference_image_id: frame.reference_image_id });
  await assert.rejects(f.service.generate('video', quote.quote_id, 'budget', { credits: 2 }), code('BUDGET_EXCEEDED'));
  await assert.rejects(new GenerationService({ ...f.cfg, ttsHost: undefined }).generate('video', quote.quote_id, 'disabled', budget), code('GENERATION_DISABLED'));
  f.state.failSubmit = true;
  const task = await f.service.generate('video', quote.quote_id, 'uncertain', budget);
  assert.equal(task.status, 'submission_unknown');
  assert.equal((await new GenerationService(f.cfg).generate('video', quote.quote_id, 'uncertain', {})).task_handle, task.task_handle);
  assert.equal((await f.service.task(task.task_handle)).status, 'submission_unknown');
  assert.equal(f.calls.filter(c => c.path === '/ai_video/generation').length, 1);
});

test('existing text-only quote digests remain compatible and prompts reach shot_content', async t => {
  const f = await fixture(t), quote = await f.service.estimate('video', input);
  const oldPricing = { costs: quote.costs, version: 'v1', rule: 71, model_type: 21, duration: 34, mode: 38 };
  assert.equal(quote.pricing_digest, createHash('sha256').update(JSON.stringify(oldPricing)).digest('hex'));
  await f.service.generate('video', quote.quote_id, 'legacy-text', budget);
  const submitted = f.calls.find(c => c.path === '/ai_video/generation')!.body;
  assert.equal(submitted.shot_content, input.content); assert.equal(submitted.aspect_ratio, 1);
  assert.equal(submitted.first_image_url, undefined); assert.equal(f.state.uploads, 0);
});
