import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { Backend } from '../src/backend.js';
import { BusinessTransport } from '../src/transport/business.js';
import { backendResponseError, safeBackendMessage } from '../src/transport/errors.js';
import { TopMediaiError, type ImageParams } from '../src/types.js';
import { ImageService } from '../src/service.js';
import { GenerationService } from '../src/generation/service.js';
import type { Adapter } from '../src/generation/types.js';
import { createServer } from '../src/server.js';

const token = 'f'.repeat(42);
const params: ImageParams = { description: 'Fixture image', model_type: 8, number: 1, quality: 8, image_quality: 0, aspect_ratio: 1 };
const timing = { http_status: 200, timeout_ms: 60000, elapsed_ms: 51 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t: TestContext) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(resolve(parent, 'topmediai-errors-'));
  t.after(async () => {
    const rel = relative(parent, dir);
    assert.ok(rel.startsWith('topmediai-errors-') && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  const config = loadConfig({ TOPMEDIAI_TOKEN: token, TOPMEDIAI_DATA_DIR: dir }, () => null);
  return { config, backend: new Backend(config), api: new BusinessTransport(config, config.ttsHost!, 'token') };
}

test('current and legacy success envelopes are accepted without masking HTTP failures', () => {
  for (const payload of [
    { status: 200000, check_code: 200000, message: 'Success' },
    { status: '200000', check_code: '200000' },
    { status: 200000 },
    { status: 200, check_code: 200000 },
    { status: 200 },
    { check_code: 200000 },
  ]) {
    assert.equal(backendResponseError(payload, timing), undefined);
    assert.equal(backendResponseError(payload, { ...timing, http_status: 503 })?.code, 'HTTP_ERROR');
  }
  assert.equal(backendResponseError({ message: 'Success' }, timing)?.code, 'BUSINESS_ERROR');
});

test('Web business codes have specific messages and actions, including conflicting success fields', () => {
  const cases = [[400022, 'INSUFFICIENT_CREDITS'], [400030, 'CONCURRENCY_LIMIT'], [400151, 'CONTENT_RESTRICTED'],
    [400072, 'MEMBERSHIP_REQUIRED'], [400046, 'UNSUPPORTED_LANGUAGE'], [400401, 'LOGIN_REQUIRED']] as const;
  for (const [code, expected] of cases) {
    for (const payload of [
      { status: 200, check_code: code },
      { status: 200000, check_code: code },
      { status: code, check_code: 200000 },
    ]) {
      const error = backendResponseError({ ...payload, message: `secret=${token}` }, timing, [token])!;
      assert.equal(error.code, expected);
      assert.equal(error.requestDetails?.backend_status, payload.status);
      assert.equal(error.requestDetails?.backend_code, payload.check_code);
      assert.equal(error.requestDetails?.elapsed_ms, 51);
      assert.ok(error.requestDetails?.suggestion);
      assert.ok(!JSON.stringify(error).includes(token));
    }
  }
  assert.equal(backendResponseError({ status: 500, check_code: 200000 }, timing)?.code, 'BUSINESS_ERROR');
  assert.equal(backendResponseError({ status: 200, check_code: 200 }, timing)?.code, 'BUSINESS_ERROR');
  assert.equal(backendResponseError({ status: 200, check_code: 200000 }, timing), undefined);
  assert.equal(backendResponseError({ status: 402 }, timing)?.code, 'BUSINESS_ERROR');
});

test('image and multimedia transports unwrap current success envelopes', async t => {
  const { backend, api } = await fixture(t);
  const data = { version: 'v1', list: [{ ...params, points: 2, version: 'v1' }] };
  t.mock.method(globalThis, 'fetch', async () => json({ status: 200000, check_code: 200000, message: 'Success', data }));
  assert.equal((await backend.prices())[0]!.points, 2);
  assert.deepEqual(await api.request('/fixture'), data);
});

test('unknown business errors retain plain product messages but not credentials, paths or raw bodies', () => {
  for (const key of ['message', 'msg']) {
    const error = backendResponseError({ check_code: 400199, [key]: 'Only one reference image is supported.' }, timing)!;
    assert.equal(error.message, 'Only one reference image is supported.');
  }
  for (const value of [token, `token=${token}`, 'https://private.example/path?signature=abc', 'C:\\Users\\fixture\\secret.txt', 'Account user@example.test is unavailable', 'api_key=example',
    '<html>Private error</html>', 'SQL SELECT password FROM accounts', 'Error\n at internal.ts:1', 'x'.repeat(501), { message: 'not a string' }]) {
    assert.equal(safeBackendMessage(value, [token]), undefined);
    assert.equal(backendResponseError({ check_code: 400199, message: value }, timing, [token])?.message,
      'The service rejected this request. The specific reason was not provided.');
  }
});

test('image and multimedia transports expose the same business reason and preserve HTTP diagnostics', async t => {
  const { backend, api, config } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => json({ status: 400, check_code: 400030, message: 'private internal details' }));
  for (const call of [() => backend.create(params), () => api.request('/fixture', { body: {} })]) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof TopMediaiError); assert.equal(error.code, 'CONCURRENCY_LIMIT');
      assert.equal(error.requestDetails?.category, 'business'); assert.ok(!error.message.includes('private')); return true;
    });
  }
  t.mock.method(globalThis, 'fetch', async () => json({ check_code: 400022, message: config.token }, 400));
  await assert.rejects(api.request('/fixture'), (error: unknown) => {
    assert.ok(error instanceof TopMediaiError); assert.equal(error.code, 'INSUFFICIENT_CREDITS');
    assert.equal(error.requestDetails?.http_status, 400); return true;
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>private crash</html>', { status: 503 }));
  await assert.rejects(backend.create(params), (error: unknown) => {
    assert.ok(error instanceof TopMediaiError); assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.requestDetails?.http_status, 503); assert.ok(!error.message.includes('private')); return true;
  });
});

test('timeouts, network failures, caller cancellation and invalid JSON stay distinct without raw exceptions', async t => {
  const { backend, api } = await fixture(t);
  for (const [failure, expected] of [[new DOMException('private timeout', 'TimeoutError'), 'REQUEST_TIMEOUT'],
    [new TypeError('private URL and credentials', { cause: { code: 'ECONNREFUSED' } }), 'NETWORK_ERROR'],
    [new TypeError('private connection details', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), 'REQUEST_TIMEOUT']] as const) {
    t.mock.method(globalThis, 'fetch', async () => { throw failure; });
    for (const call of [() => backend.create(params), () => api.request('/fixture')]) {
      await assert.rejects(call(), (error: unknown) => {
        assert.ok(error instanceof TopMediaiError); assert.equal(error.code, expected);
        assert.equal(error.requestDetails?.timeout_ms, 60000); assert.ok(error.requestDetails!.elapsed_ms! >= 0);
        assert.ok(!error.message.includes('private')); return true;
      });
    }
  }
  const controller = new AbortController(); controller.abort();
  t.mock.method(globalThis, 'fetch', async () => { throw controller.signal.reason; });
  await assert.rejects(api.request('/fixture', { signal: controller.signal }), (error: unknown) => error instanceof TopMediaiError && error.code === 'REQUEST_CANCELLED');
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
  await assert.rejects(backend.create(params), (error: unknown) => error instanceof TopMediaiError && error.code === 'INVALID_RESPONSE' && error.requestDetails?.category === 'invalid_response');
});

test('an uncertain image submission persists its cause across restart and replay never posts again', async t => {
  const { config } = await fixture(t); let submits = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { submits++; throw new DOMException('private response details', 'TimeoutError'); }
    return json({ status: 200, data: { list: [{ ...params, points: 2, version: 'fixture' }] } });
  });
  const service = new ImageService(config), quote = await service.estimate(params);
  await assert.rejects(service.generate(quote.quote_id, 'image-error', 2), (error: unknown) => {
    assert.ok(error instanceof TopMediaiError); assert.equal(error.code, 'SUBMISSION_UNKNOWN');
    assert.equal(error.submissionFailure?.code, 'REQUEST_TIMEOUT');
    assert.match(error.message, /60 seconds/); assert.match(error.message, /not be retried/); return true;
  });
  const restarted = new ImageService(config), result = await restarted.task('image-error');
  assert.equal(result.status, 'submission_unknown'); assert.equal(result.error?.code, 'REQUEST_TIMEOUT');
  assert.equal(result.error?.details?.timeout_ms, 60000);
  assert.equal((await restarted.generate(quote.quote_id, 'image-error', 2)).error?.code, 'REQUEST_TIMEOUT');
  assert.equal(submits, 1);
  const saved = await readFile(resolve(service.store.dir, 'store.json'), 'utf8');
  assert.ok(!saved.includes(token) && !saved.includes('private response details'));
});

test('music, video and synchronous speech preserve safe causes on original task queries', async t => {
  const { config } = await fixture(t);
  for (const kind of ['music', 'video', 'tts', 'sts'] as const) {
    let submits = 0;
    const adapter: Adapter = { kind, ...(kind === 'tts' || kind === 'sts' ? { execution_mode: 'synchronous' as const } : {}),
      enabled: () => true, reason: () => undefined, models: async () => ({}), validate: input => input as Record<string, unknown>,
      estimate: async () => ({ costs: [{ resource: 'credits', amount: 2 }], price_version: 'same', pricing: {} }),
      create: async () => { submits++; throw backendResponseError({ check_code: 400151, message: token }, timing, [token]); },
      poll: async task => task };
    const service = new GenerationService(config, [adapter]), quote = await service.estimate(kind, {});
    const task = await service.generate(kind, quote.quote_id, kind, { credits: 2 });
    assert.equal(task.status, 'submission_unknown'); assert.equal(task.error?.code, 'CONTENT_RESTRICTED');
    assert.ok(task.error?.details?.suggestion); assert.ok(task.recovery);
    const restarted = new GenerationService(config, [adapter]);
    assert.equal((await restarted.task(task.task_handle)).error?.code, 'CONTENT_RESTRICTED');
    assert.equal((await restarted.generate(kind, quote.quote_id, kind, {})).error?.code, 'CONTENT_RESTRICTED');
    assert.equal(submits, 1); assert.ok(!JSON.stringify(task).includes(token));
  }
});

test('MCP exposes the cause in both structured and text errors, including login guidance', async t => {
  const { config } = await fixture(t); let submits = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { submits++; return json({ check_code: 400401, message: token }); }
    return json({ status: 200, data: { list: [{ ...params, points: 2, version: 'fixture' }] } });
  });
  const server = createServer(config), client = new Client({ name: 'error-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const quote = (await client.callTool({ name: 'estimate_image_cost', arguments: { ...params } })).structuredContent as { quote_id: string };
  const result = await client.callTool({ name: 'generate_image', arguments: { quote_id: quote.quote_id, request_id: 'mcp-error', max_credits: 2 } });
  assert.equal(result.isError, true);
  const body = result.structuredContent as { error: { code: string; cause: { code: string }; automatic_retry: boolean }; login_guidance?: object };
  assert.equal(body.error.code, 'SUBMISSION_UNKNOWN'); assert.equal(body.error.cause.code, 'LOGIN_REQUIRED');
  assert.equal(body.error.automatic_retry, false); assert.ok(body.login_guidance);
  assert.deepEqual(JSON.parse((result.content as { type: string; text: string }[])[0]!.text), result.structuredContent);
  assert.ok(!JSON.stringify(result).includes(token));
  const original = (await client.callTool({ name: 'get_image_task', arguments: { request_id: 'mcp-error' } })).structuredContent as { error: { code: string } };
  assert.equal(original.error.code, 'LOGIN_REQUIRED'); assert.equal(submits, 1);
});
