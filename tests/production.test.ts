import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { loadAuthConfig, loadConfig, ROOT } from '../src/config.js';
import { checkPluginServer } from '../src/install-check.js';
import { verifyAccountToken } from '../src/account.js';
import { ImageService } from '../src/service.js';
import { GenerationService } from '../src/generation/service.js';
import { VoiceCatalog } from '../src/generation/voices.js';
import { TopMediaiError } from '../src/types.js';
import { REFERENCE_PREFIX } from '../src/reference-url.js';
import { pluginConfiguration } from '../scripts/setup-plugin.js';
import { productionEnvironment } from './fixtures/production.js';

const token = 'P'.repeat(42);
const invalid = (error: unknown) => error instanceof TopMediaiError && error.code === 'INVALID_CONFIG';
const unavailable = (error: unknown) => error instanceof TopMediaiError && error.code === 'CAPABILITY_UNAVAILABLE';
const directKeys = ['TOPMEDIAI_MEMBER_HOST', 'TOPMEDIAI_IMAGE_HOST', 'TOPMEDIAI_MUSIC_HOST', 'TOPMEDIAI_TTS_HOST', 'TOPMEDIAI_UPLOAD_HOST'];

test('production installation freezes every direct origin and clears inherited credential/gateway overrides', () => {
  const installed = pluginConfiguration('production', { ...productionEnvironment,
    TOPMEDIAI_TOKEN: 'synthetic-secret', TOPMEDIAI_GATEWAY_HOST: 'https://obsolete.fixture.invalid',
  }).mcpServers.topmediai.env;
  for (const [key, value] of Object.entries(productionEnvironment)) assert.equal(installed[key], value);
  for (const key of ['TOPMEDIAI_TOKEN', 'TOPMEDIAI_GATEWAY_HOST', 'TOPMEDIAI_PRODUCTION_GATEWAY_HOST']) assert.equal(installed[key], '');
  assert.ok(!JSON.stringify(installed).includes('synthetic-'));
  assert.ok(!Object.keys(installed).some(key => /^TOPMEDIAI_(ALLOW|ENABLE|DISABLE)_/.test(key)));
  const config = loadConfig({ ...installed, TOPMEDIAI_TOKEN: token }, () => null);
  const status = new ImageService(config).status();
  assert.equal(status.environment, 'production'); assert.equal(status.api_connection_mode, 'direct');
  assert.equal(status.gateway_configured, false); assert.equal(status.music_host, productionEnvironment.TOPMEDIAI_MUSIC_HOST);
  assert.equal(status.tts_host, productionEnvironment.TOPMEDIAI_TTS_HOST);
});

test('production direct host overrides must be valid before a business request', () => {
  for (const key of directKeys) {
    for (const value of ['', ' ', 'http://127.0.0.1:12345', 'https://user:synthetic-password@example.invalid', 'https://example.invalid/path', 'https://example.invalid?query=1', 'https://example.invalid#fragment']) {
      assert.throws(() => loadConfig({ ...productionEnvironment, [key]: value }, () => null), error => {
        assert.ok(invalid(error)); assert.ok(!String(error).includes('synthetic-password')); return true;
      }, `${key}=${value}`);
    }
  }
  for (const key of ['TOPMEDIAI_PRODUCTION_WEB_ORIGIN', ...directKeys]) {
    assert.throws(() => pluginConfiguration('production', { ...productionEnvironment, [key]: '' }), invalid);
  }
});

test('production direct account verification uses the original member API across website/member origins', async t => {
  const auth = loadAuthConfig('production', productionEnvironment);
  assert.notEqual(auth.webOrigin, auth.memberOrigin); assert.equal(auth.legacyProductionGateway, undefined);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), `${productionEnvironment.TOPMEDIAI_MEMBER_HOST}/user/member/info?product_type=1`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('token'), token); assert.equal(headers.get('cookie'), null);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    return Response.json({ status: 200, data: { member_id: '123', email: 'user@example.test' } });
  });
  assert.equal((await verifyAccountToken(auth, token)).memberId, '123'); assert.equal(calls, 1);
});

test('production capabilities enable only implemented direct contracts and configured uploads', async t => {
  const config = loadConfig(productionEnvironment, () => null);
  const rows = new GenerationService(config).capabilities().capabilities;
  assert.deepEqual(rows.filter(row => row.generation_enabled).map(row => row.kind), ['music', 'video', 'tts', 'sts']);
  assert.ok(rows.filter(row => row.generation_enabled).every(row => row.catalog_supported));
  assert.equal(new ImageService(config).status().image_upload_enabled, false);
  const uploadRoot = resolve(tmpdir(), 'topmediai-production-inputs');
  const ready = loadConfig({ ...productionEnvironment, TOPMEDIAI_UPLOAD_ROOT: uploadRoot }, () => null);
  assert.equal(new ImageService(ready).status().image_upload_enabled, true);
  assert.equal(new GenerationService(ready).capabilities().capabilities.find(row => row.kind === 'video')?.reference_media_upload_enabled, true);
  const legacy = loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_PRODUCTION_GATEWAY_HOST: 'https://gateway.fixture.invalid' }, () => null);
  assert.equal(new ImageService(legacy).status().api_connection_mode, 'legacy_gateway');
  assert.ok(new GenerationService(legacy).capabilities().capabilities.every(row => !row.generation_enabled && !row.catalog_supported));
  // Explicitly injected business hosts must not bypass the legacy gateway guard.
  const mixed = { ...ready, gatewayHost: legacy.gatewayHost };
  t.mock.method(globalThis, 'fetch', () => assert.fail('Disabled gateway contracts must not access the network'));
  const service = new GenerationService(mixed);
  await assert.rejects(service.adapter('music').models(), unavailable);
  await assert.rejects(service.adapter('video').models(), unavailable);
  await assert.rejects(service.adapter('tts').models(), unavailable);
  await assert.rejects(new VoiceCatalog(mixed).list({}), unavailable);
});

test('production image upload, text/image generation and recovery use only direct routes with durable isolation', async t => {
  const parent = tmpdir(), directory = await mkdtemp(resolve(parent, 'topmediai-production-'));
  t.after(async () => {
    const suffix = relative(parent, directory); assert.ok(suffix.startsWith('topmediai-production-') && !isAbsolute(suffix) && !suffix.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const config = loadConfig({ ...productionEnvironment, TOPMEDIAI_DATA_DIR: directory, TOPMEDIAI_UPLOAD_ROOT: directory, TOPMEDIAI_TOKEN: token }, () => null);
  const file = resolve(directory, 'reference.png');
  await writeFile(file, await sharp({ create: { width: 256, height: 256, channels: 3, background: '#aabbcc' } }).png().toBuffer());
  const params = { description: 'A quiet garden', model_type: 8, quality: 8, image_quality: 0, number: 1, aspect_ratio: 1 };
  const calls: { origin: string; path: string; body: any }[] = [];
  let submissions = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok([config.memberHost, config.imageHost, config.uploadHost].includes(url.origin));
    assert.ok(!url.pathname.startsWith('/client/openclaw/'));
    assert.equal(new Headers(init?.headers).get('token'), token);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ origin: url.origin, path: url.pathname, body });
    let data: unknown;
    if (url.pathname === '/user/member/info') { assert.equal(url.origin, config.memberHost); data = { member_id: '123', email: 'user@example.test' }; }
    else if (url.pathname === '/user/permission/info') { assert.equal(url.origin, config.memberHost); data = { tp_all: { left: 88 } }; }
    else if (url.pathname === '/upload_file') { assert.equal(url.origin, config.uploadHost); assert.ok(body instanceof FormData); data = { url: `${config.uploadPublicOrigin}${REFERENCE_PREFIX}fixture.png` }; }
    else if (url.pathname === '/v3/draw/model-consume') { assert.equal(url.origin, config.imageHost); data = { list: [{ ...params, model_name: 'Fixture', points: 2, version: 'v1' }] }; }
    else if (url.pathname === '/v3/draw/text-to-image' || url.pathname === '/v3/draw/image-to-image') { assert.equal(url.origin, config.imageHost); submissions++; data = { group_id: String(1200 + submissions) }; }
    else if (url.pathname.startsWith('/v3/draw/detail/')) { assert.equal(url.origin, config.imageHost); data = { group_id: url.pathname.split('/').at(-1), task_ids: [], image_data: [{ image_url: 'https://files.topmediai.com/result.png' }] }; }
    else assert.fail(`Unexpected fixture route ${url.pathname}`);
    return Response.json({ status: 200, data });
  });
  const service = new ImageService(config);
  assert.equal((await service.balance()).credits, 88);
  const asset = await service.uploadReferenceImage(file);
  for (const editing of [false, true]) {
    const options = { ...params, ...(editing ? { reference_image_ids: [asset.reference_image_id] } : {}) };
    const quote = await service.estimate(options);
    const request = { quote_id: quote.quote_id, request_id: editing ? 'production-edit' : 'production-text', max_credits: 2 };
    await service.generate(request.quote_id, request.request_id, request.max_credits);
    assert.equal((await service.task(request.request_id)).status, 'completed');
    await new ImageService(config).generate(request.quote_id, request.request_id, request.max_credits);
  }
  assert.equal(submissions, 2);
  assert.equal(calls.filter(call => call.path === '/v3/draw/image-to-image').length, 1);
  const otherAccountConfig = loadConfig({ ...productionEnvironment, TOPMEDIAI_DATA_DIR: directory, TOPMEDIAI_TOKEN: 'Q'.repeat(42) }, () => null);
  assert.notEqual(config.dataDir, otherAccountConfig.dataDir);
  const other = new ImageService(otherAccountConfig);
  await assert.rejects(other.task('production-text'), error => error instanceof TopMediaiError && error.code === 'TASK_NOT_FOUND');
  await assert.rejects(other.estimate({ ...params, reference_image_ids: [asset.reference_image_id] }), error => error instanceof TopMediaiError && error.code === 'REFERENCE_IMAGE_NOT_FOUND');
});

test('production stdio entry starts with the release version and the complete tool set', async () => {
  const checked = await checkPluginServer({ command: process.execPath, args: [resolve(ROOT, 'dist/src/index.js')],
    env: { ...productionEnvironment, TOPMEDIAI_TOKEN: token, TOPMEDIAI_PRODUCTION_GATEWAY_HOST: '' } });
  assert.equal(checked.server_version, '1.0.0'); assert.equal(checked.tool_count, 35);
  assert.equal(checked.environment, 'production'); assert.equal(checked.api_connection_mode, 'direct');
  assert.equal(checked.credential_refresh_enabled, true);
  assert.equal(checked.backend_account_verified, false);
});
