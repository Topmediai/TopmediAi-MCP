import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Backend } from '../src/backend.js';
import { loadConfig, ROOT } from '../src/config.js';
import { ImageService } from '../src/service.js';
import { ReferenceImages } from '../src/reference-images.js';
import { REFERENCE_PREFIX } from '../src/reference-url.js';
import { TopMediaiError, type ImageParams, type ReferenceImage } from '../src/types.js';

const params: ImageParams = { description: 'Concurrent image fixture', model_type: 8, number: 1, quality: 8, image_quality: 0, aspect_ratio: 1 };
const prices = [{ ...params, model_name: 'Fixture', quality_name: '2K', image_quality_name: '', points: 2, version: 'fixture' }];
const code = (expected: string) => (error: unknown) => error instanceof TopMediaiError && error.code === expected;
const complete = { status: 'completed' as const, images: [{ url: 'https://fixture.invalid/result.png', mime_type: 'image/png' }] };
const running = { status: 'running' as const, images: [] };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function directory(t: TestContext) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(resolve(parent, 'topmediai-concurrency-'));
  t.after(async () => {
    const rel = relative(parent, dir);
    assert.ok(rel.startsWith('topmediai-concurrency-') && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function fixture(t: TestContext) {
  const dir = await directory(t);
  const cfg = loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_TOKEN: 'c'.repeat(42), TOPMEDIAI_DATA_DIR: dir,
    TOPMEDIAI_IMAGE_HOST: 'https://fixture.invalid', TOPMEDIAI_MEMBER_HOST: 'https://fixture.invalid' }, () => null);
  let submissions = 0;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Concurrency fixtures must never use the network.'); });
  t.mock.method(Backend.prototype, 'prices', async () => prices);
  t.mock.method(Backend.prototype, 'create', async () => String(++submissions));
  t.mock.method(Backend.prototype, 'detail', async () => complete);
  return { service: new ImageService(cfg), other: new ImageService(cfg), cfg, submissions: () => submissions };
}
function reference(name = 'fixture'): ReferenceImage {
  return { reference_image_id: randomUUID(), url: `https://files.topmediai.com${REFERENCE_PREFIX}${name}.png`,
    sha256: 'f'.repeat(64), mime_type: 'image/png', bytes: 100, width: 40, height: 24, created_at: new Date().toISOString() };
}

test('a slow image POST allows another session to quote, generate and query while repeats never submit again', async t => {
  const { service, other } = await fixture(t);
  const started = deferred<void>(), response = deferred<string>();
  let posts = 0;
  t.mock.method(Backend.prototype, 'create', async (input: ImageParams) => {
    posts++;
    if (input.description === params.description) { started.resolve(); return response.promise; }
    return '2';
  });
  const quote = await service.estimate(params), pending = service.generate(quote.quote_id, 'slow', 2);
  await started.promise;
  try {
    const repeats = await Promise.all(Array.from({ length: 5 }, () => other.generate(quote.quote_id, 'slow', 0)));
    assert.ok(repeats.every(result => result.replayed && result.status === 'submission_unknown'));
    assert.equal((await other.task('slow')).status, 'submission_unknown');
    await assert.rejects(other.generate(quote.quote_id, 'duplicate-quote', 2), code('QUOTE_USED'));
    const independent = await other.estimate({ ...params, description: 'Independent task' });
    assert.equal((await other.generate(independent.quote_id, 'independent', 2)).group_id, '2');
    assert.equal((await other.task('independent')).status, 'completed');
    assert.equal(posts, 2);
  } finally { response.resolve('1'); await pending; }
  assert.equal((await other.task('slow', false)).group_id, '1');
  assert.equal((await other.task('independent', false)).status, 'completed');
});

test('simultaneous image submissions share one durable intent across service instances', async t => {
  const { service, cfg, submissions } = await fixture(t), quote = await service.estimate(params);
  const results = await Promise.all(Array.from({ length: 6 }, () => new ImageService(cfg).generate(quote.quote_id, 'same-request', 2)));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(submissions(), 1);
  assert.equal((await new ImageService(cfg).task('same-request', false)).group_id, '1');
});

test('one image quote cannot be consumed concurrently by different request IDs', async t => {
  const { service, other, submissions } = await fixture(t), quote = await service.estimate(params);
  const results = await Promise.allSettled([service.generate(quote.quote_id, 'a', 2), other.generate(quote.quote_id, 'b', 2)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && code('QUOTE_USED')(rejected.reason));
  assert.equal(submissions(), 1);
});

for (const change of ['expiration', 'reference', 'params'] as const) {
  test(`image submission rechecks ${change} after an unlocked price request`, async t => {
    const { service, other, submissions } = await fixture(t), asset = reference();
    await service.store.transaction(async state => {
      state.reference_images = { [asset.reference_image_id]: asset }; await service.store.save(state);
    });
    const quote = await service.estimate({ ...params, reference_image_ids: [asset.reference_image_id] });
    const started = deferred<void>(), response = deferred<typeof prices>();
    t.mock.method(service.backend, 'prices', async () => { started.resolve(); return response.promise; });
    const pending = service.generate(quote.quote_id, 'changed', 2);
    await started.promise;
    try {
      await other.store.transaction(async state => {
        if (change === 'expiration') state.quotes[quote.quote_id]!.expires_at = new Date(0).toISOString();
        else if (change === 'reference') state.reference_images![asset.reference_image_id]!.url = reference('changed').url;
        else state.quotes[quote.quote_id]!.params.description = 'Changed after price validation';
        await other.store.save(state);
      });
    } finally { response.resolve(prices); }
    await assert.rejects(pending, code(change === 'expiration' ? 'QUOTE_EXPIRED' : change === 'reference' ? 'REFERENCE_IMAGE_CHANGED' : 'PRICE_CHANGED'));
    assert.equal(submissions(), 0);
  });
}

test('a slow image estimate leaves the store available and rechecks its references before saving', async t => {
  const { service, other } = await fixture(t), asset = reference();
  await service.store.transaction(async state => { state.reference_images = { [asset.reference_image_id]: asset }; await service.store.save(state); });
  const started = deferred<void>(), response = deferred<typeof prices>();
  t.mock.method(service.backend, 'prices', async () => { started.resolve(); return response.promise; });
  const pending = service.estimate({ ...params, reference_image_ids: [asset.reference_image_id] });
  await started.promise;
  try {
    const unrelated = await other.estimate(params); assert.ok(unrelated.quote_id);
    await other.store.transaction(async state => {
      state.reference_images![asset.reference_image_id]!.url = reference('changed').url;
      await other.store.save(state);
    });
  } finally { response.resolve(prices); }
  await assert.rejects(pending, code('REFERENCE_IMAGE_CHANGED'));
  assert.equal(await other.store.transaction(async state => Object.keys(state.quotes).length), 1);
});

test('slow reference uploads do not block other sessions or overwrite their saved assets and quotes', async t => {
  const { service, other } = await fixture(t), first = reference('first'), second = reference('second');
  const started = deferred<void>(), response = deferred<ReferenceImage>();
  t.mock.method(ReferenceImages.prototype, 'upload', async (filePath: string) => {
    if (filePath === 'first.png') { started.resolve(); return response.promise; }
    return second;
  });
  const pending = service.uploadReferenceImage('first.png'); await started.promise;
  try {
    await other.uploadReferenceImage('second.png');
    await other.estimate(params);
  } finally { response.resolve(first); await pending; }
  await other.store.transaction(async state => {
    assert.deepEqual(Object.keys(state.reference_images!).sort(), [first.reference_image_id, second.reference_image_id].sort());
    assert.equal(Object.keys(state.quotes).length, 1);
  });
});

test('an image poll reserves only its own task and starts its cooldown after the response', async t => {
  const { service, other } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const id of ['slow', 'independent']) { const quote = await service.estimate(params); await service.generate(quote.quote_id, id, 2); }
  const started = deferred<void>(), response = deferred<typeof running>();
  let polls = 0;
  t.mock.method(Backend.prototype, 'detail', async (group: string) => {
    if (group === '1' && ++polls === 1) { started.resolve(); return response.promise; }
    return complete;
  });
  const pending = service.task('slow'); await started.promise;
  try {
    const repeated = await Promise.all(Array.from({ length: 4 }, () => other.task('slow')));
    assert.ok(repeated.every(result => result.cached && result.status === 'queued' && result.poll_after_seconds === 20));
    assert.equal(polls, 1);
    assert.equal((await other.task('independent')).status, 'completed');
    assert.ok((await other.estimate(params)).quote_id);
    t.mock.timers.tick(7000);
  } finally { response.resolve(running); }
  assert.equal((await pending).poll_after_seconds, 20);
  t.mock.timers.tick(19999);
  const cached = await other.task('slow'); assert.equal(cached.cached, true); assert.equal(cached.poll_after_seconds, 1);
  assert.equal(polls, 1);
  t.mock.timers.tick(1);
  assert.equal((await other.task('slow')).status, 'completed'); assert.equal(polls, 2);
});

test('expired image poll reservations recover and a late response cannot overwrite a newer result', async t => {
  const { service, other, cfg } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const quote = await service.estimate(params); await service.generate(quote.quote_id, 'late', 2);
  const started = deferred<void>(), response = deferred<typeof running>(); let polls = 0;
  t.mock.method(Backend.prototype, 'detail', async () => {
    if (++polls === 1) { started.resolve(); return response.promise; }
    return complete;
  });
  const earlier = service.task('late'); await started.promise;
  try {
    t.mock.timers.tick(cfg.timeoutMs + 5000);
    assert.equal((await other.task('late')).status, 'completed');
  } finally { response.resolve(running); }
  const result = await earlier;
  assert.equal(result.status, 'completed'); assert.deepEqual(result.images, complete.images); assert.equal(polls, 2);
});

test('a failed earlier image poll cannot clear a newer poll reservation', async t => {
  const { service, other, cfg } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const quote = await service.estimate(params); await service.generate(quote.quote_id, 'late-error', 2);
  const firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const firstResponse = deferred<typeof complete>(), secondResponse = deferred<typeof complete>(); let polls = 0;
  t.mock.method(Backend.prototype, 'detail', async () => {
    if (++polls === 1) { firstStarted.resolve(); return firstResponse.promise; }
    secondStarted.resolve(); return secondResponse.promise;
  });
  const earlier = service.task('late-error'), rejected = assert.rejects(earlier, code('BACKEND_UNAVAILABLE'));
  await firstStarted.promise; t.mock.timers.tick(cfg.timeoutMs + 5000);
  const newer = other.task('late-error'); await secondStarted.promise;
  try {
    firstResponse.reject(new TopMediaiError('BACKEND_UNAVAILABLE', 'Fixture failure')); await rejected;
    const cached = await service.task('late-error'); assert.equal(cached.cached, true); assert.equal(polls, 2);
    const lease = await service.store.transaction(async state => state.tasks['late-error']!.poll_in_flight_until);
    assert.ok(lease);
  } finally { firstResponse.resolve(complete); secondResponse.resolve(complete); await newer; }
});

test('two independent MCP processes share state while slow generation leaves other sessions available', async t => {
  const dir = await directory(t), started = deferred<void>(), response = deferred<void>();
  let slowPosts = 0, otherPosts = 0;
  const server = createHttpServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Connection', 'close');
    let data: unknown;
    if (req.url === '/v3/draw/model-consume') data = { list: prices };
    else if (req.url === '/v3/draw/text-to-image') {
      let body = ''; for await (const chunk of req) body += chunk;
      if (JSON.parse(body).description === params.description) { slowPosts++; started.resolve(); await response.promise; data = { group_id: '1' }; }
      else { otherPosts++; data = { group_id: '2' }; }
    } else if (req.url === '/v3/draw/detail/1' || req.url === '/v3/draw/detail/2') data = { group_id: req.url.split('/').pop(), image_data: [{ image_url: complete.images[0]!.url }], task_ids: [] };
    else { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ status: 200, data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const preload = `process.loadEnvFile = () => {}; const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== 'https://backend.fixture.invalid') throw new Error('Only mocked production requests are allowed');
      return originalFetch(new URL(url.pathname + url.search, ${JSON.stringify(origin)}), init);
    };`;
  const clients: Client[] = [];
  t.after(async () => {
    response.resolve();
    await Promise.all(clients.map(client => client.close()));
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `parallel-process-${index}`, version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve(ROOT, 'dist/src/index.js')], cwd: ROOT,
      env: { TOPMEDIAI_ENV: 'production', TOPMEDIAI_MODE: 'live', TOPMEDIAI_TOKEN: 'c'.repeat(42), TOPMEDIAI_IMAGE_HOST: 'https://backend.fixture.invalid',
        TOPMEDIAI_MEMBER_HOST: 'https://backend.fixture.invalid', TOPMEDIAI_DATA_DIR: resolve(dir, 'shared'), LOCALAPPDATA: dir } }));
  }
  const call = async (client: Client, name: string, args: object) => {
    const result = await client.callTool({ name, arguments: { ...args } });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    return result.structuredContent as Record<string, any>;
  };
  const quote = await call(clients[0]!, 'estimate_image_cost', params);
  const pending = call(clients[0]!, 'generate_image', { quote_id: quote.quote_id, request_id: 'slow-process', max_credits: 2 });
  await started.promise;
  try {
    const repeated = await call(clients[1]!, 'generate_image', { quote_id: quote.quote_id, request_id: 'slow-process', max_credits: 0 });
    assert.equal(repeated.replayed, true); assert.equal(repeated.status, 'submission_unknown');
    const unrelated = await call(clients[1]!, 'estimate_image_cost', { ...params, description: 'Independent process task' });
    await call(clients[1]!, 'generate_image', { quote_id: unrelated.quote_id, request_id: 'other-process', max_credits: 2 });
    assert.equal((await call(clients[1]!, 'get_image_task', { request_id: 'other-process' })).status, 'completed');
    assert.equal(slowPosts, 1); assert.equal(otherPosts, 1);
  } finally { response.resolve(); await pending; }
  assert.equal((await call(clients[1]!, 'get_image_task', { request_id: 'slow-process' })).status, 'completed');
});
