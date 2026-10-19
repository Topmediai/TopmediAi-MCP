import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { ImageService } from '../src/service.js';
import { imageSchema } from '../src/image-options.js';
import { MAX_REFERENCE_BYTES, prepareReferenceImage, referenceUrl, REFERENCE_PREFIX, REFERENCE_SOURCE } from '../src/reference-images.js';
import { TopMediaiError } from '../src/types.js';
import { pluginConfiguration } from '../scripts/setup-plugin.js';

const token = 'R'.repeat(42);
const params = { description: 'Change the sky to sunset', model_type: 6, number: 1, quality: 4, image_quality: 0, aspect_ratio: 1 };
const assetUrl = `https://files.topmediai.com${REFERENCE_PREFIX}fixture.png`;
const errorCode = (code: string) => (error: unknown) => error instanceof TopMediaiError && error.code === code;

async function directories(t: TestContext) {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(resolve(parent, 'topmediai-reference-test-'));
  const root = resolve(dir, 'images'); await mkdir(root);
  t.after(async () => {
    const rel = relative(parent, dir);
    assert.ok(rel.startsWith('topmediai-reference-test-') && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, root };
}
async function png(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 24, channels: 3, background: '#8844cc' } }).png().toBuffer();
}
async function fixture(t: TestContext) {
  const { dir, root } = await directories(t);
  const file = resolve(root, 'private-original-name.png'); await writeFile(file, await png());
  const calls: { path: string; method: string; body: unknown; token?: string; headers: Record<string, unknown> }[] = [];
  const state = { accountStatus: 200, uploadStatus: 200, businessStatus: 200, redirect: false,
    disconnectUpload: false, timeoutUpload: false, disconnectGenerate: false, url: assetUrl, largeReply: false, malformed: false };
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = req.headers['content-type']?.startsWith('multipart/form-data')
      ? await new Response(bytes, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
      : bytes.length ? JSON.parse(bytes.toString()) : undefined;
    calls.push({ path: req.url!, method: req.method!, body, token: req.headers.token as string, headers: req.headers });
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Connection', 'close');
    if (req.url === '/upload_file') {
      if (state.disconnectUpload) { req.socket.destroy(); return; }
      if (state.timeoutUpload) return;
      if (state.redirect) { res.statusCode = 307; res.setHeader('Location', '/redirect-target'); res.end(); return; }
      res.statusCode = state.uploadStatus;
      if (state.largeReply) { res.end(JSON.stringify({ status: 200, data: { url: state.url }, padding: 'x'.repeat(70_000) })); return; }
      res.end(state.malformed ? '{broken' : JSON.stringify({ status: state.businessStatus, message: 'synthetic-private-upstream-detail', data: { url: state.url } }));
      return;
    }
    if (req.url === '/v3/draw/model-consume') {
      res.end(JSON.stringify({ status: 200, data: { list: [6, 11].map(model_type => ({
        ...params, model_type, quality: model_type === 11 ? 13 : params.quality, image_quality: model_type === 11 ? 1 : 0, points: 2, version: 'v1',
      })) } })); return;
    }
    if (req.url === '/v3/draw/text-to-image' || req.url === '/v3/draw/image-to-image') {
      if (state.disconnectGenerate) { req.socket.destroy(); return; }
      res.end(JSON.stringify({ status: 200, data: { group_id: '12345' } })); return;
    }
    if (req.url === '/v3/draw/detail/12345') {
      res.end(JSON.stringify({ status: 200, data: { group_id: '12345', image_data: [{ image_url: 'https://example.invalid/result.png' }], task_ids: [] } })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input);
    if (target.origin === 'https://member.example.test') {
      assert.equal(target.pathname, '/user/member/info');
      assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
      const headers = new Headers(init?.headers); assert.equal(headers.get('token'), token); assert.equal(headers.get('cookie'), null);
      calls.push({ path: '/account-check', method: 'GET', body: undefined, headers: {} });
      return new Response(JSON.stringify({ status: state.accountStatus, data: { member_id: '12345', email: 'fixture@example.test' } }));
    }
    assert.equal(target.origin, origin, 'Only isolated fixture servers may receive requests');
    return originalFetch(input, init);
  });
  const cfg: Config = { mode: 'live', environment: 'production', token, source: 4,
    memberHost: 'https://member.example.test', imageHost: origin, uploadHost: origin, uploadRoot: root,
    uploadPublicOrigin: 'https://files.topmediai.com', timeoutMs: 5000, dataDir: resolve(dir, 'state') };
  return { dir, root, file, cfg, calls, state, service: new ImageService(cfg) };
}

test('upload requires a dedicated local directory and installer freezes it without any OSS credentials', () => {
  assert.equal(new ImageService(loadConfig({}, () => null)).status().image_upload_enabled, false);
  for (const env of [
    { TOPMEDIAI_UPLOAD_ROOT: 'relative/path' }, { TOPMEDIAI_UPLOAD_ROOT: resolve('/') } ]) {
    assert.throws(() => loadConfig(env, () => null), errorCode('INVALID_CONFIG'));
  }
  const root = resolve('images');
  const installed = pluginConfiguration('production', { TOPMEDIAI_UPLOAD_ROOT: root }).mcpServers.topmediai.env;
  assert.equal(installed.TOPMEDIAI_UPLOAD_ROOT, root);
  assert.equal(new ImageService(loadConfig(installed, () => null)).status().image_upload_enabled, true);
  assert.equal(installed.TOPMEDIAI_UPLOAD_HOST, 'https://tts-api.imyfone.com');
  assert.ok(!JSON.stringify(installed).includes('ACCESS_KEY'));
  const production = loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_PRODUCTION_GATEWAY_HOST: 'https://approved.example.test', TOPMEDIAI_UPLOAD_ROOT: root }, () => null);
  assert.equal(new ImageService(production).status().image_upload_enabled, false);
});

test('reference input rejects arbitrary URLs, empty/duplicate IDs and more than sixteen images', () => {
  const id = '77a81a0a-5b26-4d43-9fc4-6a6505ac0fa1';
  for (const input of [ { ...params, image_urls: ['http://127.0.0.1/private'] },
    { ...params, reference_image_ids: [] }, { ...params, reference_image_ids: [id, id] },
    { ...params, reference_image_ids: Array.from({ length: 17 }, (_, i) => `77a81a0a-5b26-4d43-9fc4-${String(i).padStart(12, '0')}`) } ]) {
    assert.equal(imageSchema.safeParse(input).success, false);
  }
});

test('local allowlist rejects traversal, links, hardlinks, forged MIME, truncated and oversized files', async t => {
  const { dir, root } = await directories(t);
  const outside = resolve(dir, 'outside.png'); await writeFile(outside, await png());
  const forged = resolve(root, 'forged.png'); await writeFile(forged, '<svg><script>private</script></svg>');
  const truncated = resolve(root, 'truncated.png'); await writeFile(truncated, (await png()).subarray(0, 33));
  const oversized = resolve(root, 'large.png'); await writeFile(oversized, Buffer.alloc(MAX_REFERENCE_BYTES + 1));
  const hardlink = resolve(root, 'hardlink.png'); await link(outside, hardlink);
  const junction = resolve(root, 'link'); await symlink(dir, junction, process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of [outside, '../outside.png', root, forged, truncated, oversized, hardlink, resolve(junction, 'outside.png')]) {
    await assert.rejects(prepareReferenceImage(root, path), errorCode('INVALID_REFERENCE_FILE'));
  }
  const apng = await png(); const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
  await writeFile(resolve(root, 'animation.png'), Buffer.concat([apng.subarray(0, 33), animation, apng.subarray(33)]));
  await assert.rejects(prepareReferenceImage(root, 'animation.png'), errorCode('INVALID_REFERENCE_FILE'));
});

test('decode limits prevent large dimensions and fresh encoding removes EXIF and trailing data', async t => {
  const { root } = await directories(t);
  const original = await sharp({ create: { width: 50, height: 30, channels: 3, background: '#5588aa' } })
    .withExif({ IFD0: { Artist: 'private-metadata-marker' } }).jpeg().toBuffer();
  const path = resolve(root, 'private-file-name.jpg'); await writeFile(path, Buffer.concat([original, Buffer.from('private-trailing-marker')]));
  const result = await prepareReferenceImage(root, path);
  assert.equal(result.mime_type, 'image/jpeg'); assert.equal(result.width, 50); assert.equal(result.height, 30);
  assert.equal((await sharp(result.data).metadata()).exif, undefined);
  assert.ok(!result.data.includes(Buffer.from('private-metadata-marker')) && !result.data.includes(Buffer.from('private-trailing-marker')));
  const huge = await png(); huge.writeUInt32BE(9000, 16); // Invalid bounds are rejected before full pixel decoding.
  await writeFile(resolve(root, 'huge.png'), huge);
  await assert.rejects(prepareReferenceImage(root, 'huge.png'), errorCode('INVALID_REFERENCE_FILE'));
});

test('upload verifies login, sends a fixed multipart source and random name, and saves only normalized metadata', async t => {
  const f = await fixture(t); const asset = await f.service.uploadReferenceImage(f.file);
  assert.deepEqual(f.calls.map(call => call.path), ['/account-check', '/upload_file']);
  const upload = f.calls[1]!; assert.equal(upload.token, token);
  assert.equal(upload.headers.cookie, undefined);
  const form = upload.body as FormData; assert.equal(form.get('source'), REFERENCE_SOURCE);
  const file = form.get('file') as File;
  assert.match(file.name, /^[0-9a-f-]{36}\.png$/); assert.equal(file.type, 'image/png');
  assert.equal(file.size, asset.bytes); assert.ok(asset.sha256.length === 64);
  assert.equal(asset.url, assetUrl); assert.equal(f.service.status().image_upload_enabled, true);
  const persisted = await readFile(resolve(f.cfg.dataDir, 'store.json'), 'utf8');
  assert.ok(!persisted.includes(token) && !persisted.includes(f.file) && !persisted.includes('private-original-name'));
});

test('unconfigured upload and expired login never transmit an image', async t => {
  const f = await fixture(t);
  for (const config of [
    { ...f.cfg, uploadRoot: undefined }, { ...f.cfg, uploadHost: undefined },
    { ...f.cfg, gatewayHost: 'https://gateway.fixture.invalid' },
  ]) await assert.rejects(new ImageService(config).uploadReferenceImage(f.file), errorCode('IMAGE_UPLOAD_DISABLED'));
  assert.equal(f.calls.length, 0);
  f.state.accountStatus = 401;
  await assert.rejects(f.service.uploadReferenceImage(f.file), errorCode('LOGIN_REQUIRED'));
  assert.deepEqual(f.calls.map(call => call.path), ['/account-check']);
});

test('upload result rejects internal targets, other origins, signed queries and paths outside the upload prefix', () => {
  const suffix = `${REFERENCE_PREFIX}fixture.png`;
  for (const url of [`http://files.topmediai.com${suffix}`, `https://127.0.0.1${suffix}`, `https://[::1]${suffix}`,
    `https://files.topmediai.com.evil.test${suffix}`, `https://user:private@files.topmediai.com${suffix}`,
    `${assetUrl}?token=private`, `${assetUrl}#fragment`, 'https://files.topmediai.com/other/fixture.png',
    `https://files.topmediai.com${REFERENCE_PREFIX}../fixture.png`, `https://files.topmediai.com${REFERENCE_PREFIX}%2e%2e/fixture.png` ]) {
    assert.throws(() => referenceUrl(url, 'https://files.topmediai.com'), errorCode('INVALID_UPLOAD_URL'));
  }
});

test('upload URL diagnostics identify the rejected rule without exposing sensitive URL contents', () => {
  const cases: [unknown, string][] = [
    [undefined, 'invalid_type'], ['x'.repeat(2049), 'url_too_long'], ['not-a-url', 'invalid_url'],
    [`http://files.topmediai.com${REFERENCE_PREFIX}sensitive-filename.png`, 'https_required'],
    [`https://fixture-user:fixture-password@files.topmediai.com${REFERENCE_PREFIX}sensitive-filename.png`, 'credentials_not_allowed'],
    [`${assetUrl}?token=fixture-secret`, 'query_not_allowed'], [`${assetUrl}#fixture-secret`, 'fragment_not_allowed'],
    [`${assetUrl}?`, 'query_not_allowed'], [`${assetUrl}#`, 'fragment_not_allowed'],
    ['https://files.topmediai.com/other/sensitive-filename.png', 'path_prefix_mismatch'],
    [`https://files.topmediai.com${REFERENCE_PREFIX}sensitive-filename.svg`, 'invalid_filename'],
    [`https://files.topmediai.com${REFERENCE_PREFIX}%2e%2e/sensitive-filename.png`, 'unsafe_characters'],
    [`https://FILES.TOPMEDIAI.COM${REFERENCE_PREFIX}sensitive-filename.png`, 'noncanonical_url'],
  ];
  for (const [url, reason] of cases) {
    assert.throws(() => referenceUrl(url, 'https://files.topmediai.com'), (error: unknown) => {
      assert.ok(error instanceof TopMediaiError); assert.equal(error.code, 'INVALID_UPLOAD_URL');
      assert.equal(error.details?.reason, reason); assert.equal(error.details?.expected_path_prefix, REFERENCE_PREFIX);
      assert.equal(error.details?.recovery.automatic_retry, false);
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      for (const secret of ['fixture-user', 'fixture-password', 'fixture-secret', 'sensitive-filename']) assert.ok(!serialized.includes(secret));
      return true;
    });
  }
  for (const url of [`https://unapproved.fixture.invalid${REFERENCE_PREFIX}fixture.png`, 'https://unapproved.fixture.invalid/other/fixture.png']) {
    assert.throws(() => referenceUrl(url, 'https://files.topmediai.com'), (error: unknown) => {
      assert.ok(error instanceof TopMediaiError); assert.equal(error.details?.recovery.suggested_origin, undefined); return true;
    });
  }
});

test('default production CDN accepts the recorded upload origin on the first attempt, including consumers', async t => {
  const f = await fixture(t);
  const { uploadPublicOrigin } = loadConfig({ TOPMEDIAI_ENV: 'production' }, () => null);
  f.state.url = `${uploadPublicOrigin}${REFERENCE_PREFIX}fixture.png`;
  // Exercise the same environment fallback in upload and paid image reference validation.
  const service = new ImageService({ ...f.cfg, uploadPublicOrigin: undefined });
  const asset = await service.uploadReferenceImage(f.file);
  assert.equal(asset.url, f.state.url);
  const quote = await service.estimate({ ...params, reference_image_ids: [asset.reference_image_id] });
  await service.generate(quote.quote_id, 'cdn-reference', 2);
  assert.equal(f.calls.filter(c => c.path === '/upload_file').length, 1);
  const submissions = f.calls.filter(c => c.path === '/v3/draw/image-to-image');
  assert.equal(submissions.length, 1);
  assert.deepEqual((submissions[0]!.body as { image_urls: string[] }).image_urls, [f.state.url]);
});

test('MCP upload errors expose actionable origin diagnostics without retrying or registering a reference', async t => {
  const f = await fixture(t);
  f.state.url = `https://unapproved.fixture.invalid${REFERENCE_PREFIX}fixture.png`;
  const server = createServer(f.cfg);
  const client = new Client({ name: 'upload-diagnostics-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'upload_reference_image', arguments: { file_path: f.file } });
  assert.equal(result.isError, true);
  const content = result.content as { type: string; text: string }[];
  const error = JSON.parse(content[0]!.text).error;
  assert.equal(error.code, 'INVALID_UPLOAD_URL');
  assert.equal(error.details.reason, 'origin_mismatch');
  assert.equal(error.details.expected_origin, f.cfg.uploadPublicOrigin);
  assert.equal(error.details.returned_origin, 'https://unapproved.fixture.invalid');
  assert.equal(error.details.recovery.suggested_origin, undefined);
  assert.equal(error.details.recovery.automatic_retry, false);
  assert.equal(f.calls.filter(c => c.path === '/upload_file').length, 1);
  assert.ok(!JSON.stringify(result).includes(token) && !JSON.stringify(result).includes(f.file));
  assert.ok(!f.calls.some(c => c.path.includes('image-to-image')));
  await f.service.store.transaction(async state => assert.equal(Object.keys(state.reference_images ?? {}).length, 0));
});

test('redirects, upload timeouts/disconnects and malformed replies are single attempts and create no reference', async t => {
  const f = await fixture(t);
  f.cfg.timeoutMs = 100;
  for (const kind of ['redirect', 'timeoutUpload', 'disconnectUpload', 'malformed'] as const) {
    f.state[kind] = true;
    const before = f.calls.filter(c => c.path === '/upload_file').length;
    await assert.rejects(f.service.uploadReferenceImage(f.file));
    assert.equal(f.calls.filter(c => c.path === '/upload_file').length, before + 1);
    assert.ok(!f.calls.some(c => c.path === '/redirect-target'));
    await f.service.store.transaction(async state => assert.equal(Object.keys(state.reference_images ?? {}).length, 0));
    f.state[kind] = false;
  }
});

test('upload accepts a valid reply above the former 64 KiB limit and registers one reference', async t => {
  const f = await fixture(t); f.state.largeReply = true;
  const asset = await f.service.uploadReferenceImage(f.file);
  assert.equal(asset.url, assetUrl);
  assert.equal(f.calls.filter(c => c.path === '/upload_file').length, 1);
  await f.service.store.transaction(async state => {
    assert.deepEqual(Object.keys(state.reference_images ?? {}), [asset.reference_image_id]);
  });
});

test('unapproved upload URL and business failures never expose upstream details or mint an ID', async t => {
  const f = await fixture(t);
  f.state.url = 'https://private.example.test/secret?token=private';
  await assert.rejects(f.service.uploadReferenceImage(f.file), errorCode('INVALID_UPLOAD_URL'));
  f.state.url = assetUrl; f.state.businessStatus = 500;
  await assert.rejects(f.service.uploadReferenceImage(f.file), (error: unknown) => {
    assert.ok(error instanceof TopMediaiError); assert.equal(error.code, 'BUSINESS_ERROR');
    assert.ok(!error.message.includes('synthetic-private-upstream-detail') && !error.message.includes(token)); return true;
  });
});

test('image-to-image quote binds reference images, resumes after restart and submits only once', async t => {
  const f = await fixture(t); const asset = await f.service.uploadReferenceImage(f.file);
  const options = { ...params, reference_image_ids: [asset.reference_image_id] };
  const quote = await f.service.estimate(options);
  assert.deepEqual(quote.params.image_urls, [assetUrl]); assert.deepEqual(quote.reference_image_ids, options.reference_image_ids);
  const service = new ImageService(f.cfg);
  await service.generate(quote.quote_id, 'edit-once', 2);
  assert.equal((await new ImageService(f.cfg).generate(quote.quote_id, 'edit-once', 2)).replayed, true);
  const submissions = f.calls.filter(c => c.path === '/v3/draw/image-to-image'); assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0]!.body, { ...params, image_urls: [assetUrl], source: 4, translation: 0, is_public: 0, web_search: 0 });
  assert.equal((await service.task('edit-once')).status, 'completed');
  assert.ok(!f.calls.some(c => c.path.includes('permission/consume')));
  const models = await service.models(); assert.ok(!models.models.some(m => m.model_type === 7));
  assert.equal(models.models.find(m => m.model_type === 11)?.supports_image_to_image, true);
});

test('unknown IDs, another account, removed models and production gateways fail before any paid submission', async t => {
  const f = await fixture(t); const asset = await f.service.uploadReferenceImage(f.file);
  const options = { ...params, reference_image_ids: [asset.reference_image_id] };
  await assert.rejects(f.service.estimate({ ...params, reference_image_ids: ['77a81a0a-5b26-4d43-9fc4-6a6505ac0fa1'] }), errorCode('REFERENCE_IMAGE_NOT_FOUND'));
  await assert.rejects(new ImageService({ ...f.cfg, token: 'S'.repeat(42), dataDir: resolve(f.dir, 'other-account') }).estimate(options), errorCode('REFERENCE_IMAGE_NOT_FOUND'));
  await assert.rejects(f.service.estimate({ ...options, model_type: 7 }), errorCode('UNSUPPORTED_OPTIONS'));
  await assert.rejects(new ImageService({ ...f.cfg, gatewayHost: 'https://approved.example.test' }).estimate(options), errorCode('IMAGE_TO_IMAGE_UNAVAILABLE'));
  await assert.rejects(f.service.backend.create({ ...params, image_urls: ['http://127.0.0.1/private'] }), errorCode('INVALID_UPLOAD_URL'));
  await assert.rejects(f.service.backend.create({ ...params, model_type: 7, image_urls: [assetUrl] }), errorCode('UNSUPPORTED_OPTIONS'));
  assert.ok(!f.calls.some(c => c.path.includes('image-to-image')));
});

test('changed quoted references block POST; lost edit response stays unknown', async t => {
  const f = await fixture(t); const asset = await f.service.uploadReferenceImage(f.file);
  const options = { ...params, reference_image_ids: [asset.reference_image_id] };
  const quote = await f.service.estimate(options);
  await f.service.store.transaction(async state => { state.quotes[quote.quote_id]!.params.image_urls = [`https://files.topmediai.com${REFERENCE_PREFIX}changed.png`]; await f.service.store.save(state); });
  await assert.rejects(f.service.generate(quote.quote_id, 'changed-edit', 2), errorCode('REFERENCE_IMAGE_CHANGED'));
  assert.ok(!f.calls.some(c => c.path === '/v3/draw/image-to-image'));
  const fresh = await f.service.estimate(options); f.state.disconnectGenerate = true;
  await assert.rejects(f.service.generate(fresh.quote_id, 'unknown-edit', 2), errorCode('SUBMISSION_UNKNOWN'));
  assert.equal((await new ImageService(f.cfg).generate(fresh.quote_id, 'unknown-edit', 2)).status, 'submission_unknown');
  assert.equal(f.calls.filter(c => c.path === '/v3/draw/image-to-image').length, 1);
});

test('MCP protocol exposes upload and accepts reference IDs through estimate and generate', async t => {
  const f = await fixture(t); const server = createServer(f.cfg);
  const client = new Client({ name: 'reference-protocol-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const uploaded = await client.callTool({ name: 'upload_reference_image', arguments: { file_path: f.file } });
  assert.equal(uploaded.isError, undefined);
  const asset = uploaded.structuredContent as Record<string, unknown>;
  const estimate = await client.callTool({ name: 'estimate_image_cost', arguments: { ...params, reference_image_ids: [asset.reference_image_id] } });
  assert.equal(estimate.isError, undefined);
  const quote = estimate.structuredContent as Record<string, unknown>;
  const task = await client.callTool({ name: 'generate_image', arguments: { quote_id: quote.quote_id, request_id: 'protocol-edit', max_credits: 2 } });
  assert.equal(task.isError, undefined);
  assert.equal(f.calls.filter(c => c.path === '/v3/draw/image-to-image').length, 1);
});
