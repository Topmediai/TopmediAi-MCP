import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { Store } from '../src/store.js';
import { EXECUTION_LEASE_MS, GenerationService } from '../src/generation/service.js';
import { processOwner } from '../src/process-owner.js';
import type { Adapter, Outcome } from '../src/generation/types.js';

const completed: Outcome = { status: 'completed', remote: {}, artifacts: [] };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function directory(t: TestContext) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(resolve(parent, 'topmediai-recovery-'));
  t.after(async () => {
    const suffix = relative(parent, dir);
    assert.ok(suffix.startsWith('topmediai-recovery-') && !isAbsolute(suffix) && !suffix.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
const config = (dir: string) => loadConfig({ TOPMEDIAI_DATA_DIR: dir, TOPMEDIAI_TOKEN: 'f'.repeat(42) }, () => null);
function adapter(kind: 'tts' | 'sts', create: Adapter['create']): Adapter {
  return { kind, execution_mode: 'synchronous', enabled: () => true, reason: () => undefined,
    models: async () => ({}), validate: input => input as Record<string, unknown>,
    estimate: async () => ({ costs: [{ resource: 'credits', amount: 1 }], price_version: 'fixture', pricing: {} }), create,
    poll: async () => { throw new Error('Synchronous speech must never poll a backend.'); } };
}

const childCode = `
import { Store } from './dist/src/store.js';
import { loadConfig } from './dist/src/config.js';
import { GenerationService } from './dist/src/generation/service.js';
globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
const [mode, dir] = process.argv.slice(1);
if (mode !== 'increment') process.on('message', () => {});
const cfg = loadConfig({ TOPMEDIAI_DATA_DIR: dir, TOPMEDIAI_TOKEN: 'f'.repeat(42) }, () => null);
if (mode === 'speech') {
  let service;
  const a = { kind: 'tts', execution_mode: 'synchronous', enabled: () => true, reason: () => undefined,
    models: async () => ({}), validate: x => x,
    estimate: async () => ({ costs: [{ resource: 'credits', amount: 1 }], price_version: 'fixture', pricing: {} }),
    create: async () => {
      const saved = await service.store.transaction(async s => s.generation_tasks['child-speech']);
      process.send({ ready: true, handle: saved.task_handle, quote: saved.quote_id });
      return new Promise(() => {});
    } };
  service = new GenerationService(cfg, [a]);
  const quote = await service.estimate('tts', {});
  await service.generate('tts', quote.quote_id, 'child-speech', { credits: 1 });
} else {
  const store = new Store(dir);
  const increment = async state => {
    state.quotes.counter ??= { quote_id: 'counter', credits: 0 };
    state.quotes.counter.credits++;
    await store.save(state);
  };
  if (mode === 'hold') {
    await store.transaction(async state => { await increment(state); process.send({ ready: true }); await new Promise(() => {}); });
  } else {
    for (let i = 0; i < 8; i++) await store.transaction(increment);
    process.send({ done: true });
  }
}
`;
async function helper(t: TestContext, mode: string, dir: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, mode, dir],
    { cwd: ROOT, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<number | null>(yes => child.once('exit', yes));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  const message = await new Promise<Record<string, any>>((yes, no) => {
    child.once('message', value => yes(value as Record<string, any>));
    child.once('error', no);
    void exited.then(code => no(new Error(`Isolated child exited before its result (${code}).`)));
  });
  return { child, exited, message };
}
async function terminate(child: ChildProcess, exited: Promise<number | null>) { child.kill(); await exited; }

test('legacy abandoned locks recover and current live owners are never removed', async t => {
  const dir = await directory(t), store = new Store(dir);
  await writeFile(resolve(dir, 'store.lock'), JSON.stringify({ pid: 2147483647, created_at: '1970-01-01T00:00:00.000Z' }));
  assert.equal(await store.transaction(async () => 'recovered'), 'recovered');
  await assert.rejects(readFile(resolve(dir, 'store.lock')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  const marker = JSON.stringify({ pid: process.pid, created_at: new Date(0).toISOString() });
  await writeFile(resolve(dir, 'store.lock'), marker);
  await assert.rejects(store.transaction(async () => 'must not enter'), (error: unknown) => (error as { code: string }).code === 'STORE_BUSY');
  assert.equal(await readFile(resolve(dir, 'store.lock'), 'utf8'), marker);
});

test('a crashed holder releases the OS coordinator and concurrent recovery preserves every write', async t => {
  const dir = await directory(t), holder = await helper(t, 'hold', dir);
  assert.equal(holder.message.ready, true);
  let entered = false;
  const waiting = new Store(dir).transaction(async () => { entered = true; });
  await new Promise(yes => setTimeout(yes, 100)); assert.equal(entered, false);
  await terminate(holder.child, holder.exited); await waiting;
  const workers = await Promise.all(Array.from({ length: 4 }, () => helper(t, 'increment', dir)));
  for (const worker of workers) { assert.equal(worker.message.done, true); assert.equal(await worker.exited, 0); }
  assert.equal(await new Store(dir).transaction(async state => state.quotes.counter!.credits), 33);
});

test('foreign or malformed lock ownership fails closed rather than guessing that the lock expired', async t => {
  const dir = await directory(t), text = '{incomplete';
  await writeFile(resolve(dir, 'store.lock'), text);
  await assert.rejects(new Store(dir).transaction(async () => 'must not enter'), (error: unknown) => (error as { code: string }).code === 'STORE_BUSY');
  assert.equal(await readFile(resolve(dir, 'store.lock'), 'utf8'), text);
});

test('PID reuse is distinguished by process start time and release never deletes another lock identity', async t => {
  const dir = await directory(t), owner = await processOwner();
  if (!owner.started_at) { t.skip('The operating system did not provide process start time.'); return; }
  await writeFile(resolve(dir, 'store.lock'), JSON.stringify({ ...owner, instance_id: 'previous-process', started_at: '1', lock_id: 'previous-lock' }));
  assert.equal(await new Store(dir).transaction(async () => 'recovered reused PID'), 'recovered reused PID');
  const replacement = JSON.stringify({ ...owner, lock_id: 'replacement-lock' });
  await new Store(dir).transaction(async () => { await writeFile(resolve(dir, 'store.lock'), replacement); });
  assert.equal(await readFile(resolve(dir, 'store.lock'), 'utf8'), replacement);
});

for (const kind of ['tts', 'sts'] as const) {
  test(`${kind} remains in progress across sessions and repeated requests submit once`, async t => {
    const cfg = config(await directory(t)), started = deferred<void>(), response = deferred<Outcome>(); let posts = 0;
    const a = adapter(kind, async () => { posts++; started.resolve(); return response.promise; });
    const owner = new GenerationService(cfg, [a]), observer = new GenerationService(cfg, [a]);
    const quote = await owner.estimate(kind, {}), pending = owner.generate(kind, quote.quote_id, 'active', { credits: 1 });
    await started.promise;
    try {
      const record = await owner.store.transaction(async state => state.generation_tasks!.active!);
      assert.ok(record.execution_lease?.owner.instance_id);
      const visible = await observer.task(record.task_handle);
      assert.equal(visible.status, 'submitting'); assert.equal(visible.execution_lease, undefined);
      assert.equal((await observer.generate(kind, quote.quote_id, 'active', {})).status, 'submitting');
      assert.equal((await owner.store.transaction(async state => state.generation_tasks!.active!.status)), 'submitting');
      assert.equal(posts, 1);
    } finally { response.resolve(completed); }
    assert.equal((await pending).status, 'completed');
    assert.equal(await owner.store.transaction(async state => state.generation_tasks!.active!.execution_lease), undefined);
  });
}

test('expired speech leases stay unknown without a second submission and late completion remains recoverable', async t => {
  const cfg = config(await directory(t)), started = deferred<void>(), response = deferred<Outcome>(); let posts = 0;
  const a = adapter('tts', async () => { posts++; started.resolve(); return response.promise; });
  const owner = new GenerationService(cfg, [a]), observer = new GenerationService(cfg, [a]);
  const quote = await owner.estimate('tts', {}), pending = owner.generate('tts', quote.quote_id, 'expired', { credits: 1 });
  await started.promise;
  try {
    const handle = await owner.store.transaction(async state => {
      const task = state.generation_tasks!.expired!; task.execution_lease!.expires_at = new Date(0).toISOString();
      await owner.store.save(state); return task.task_handle;
    });
    assert.equal((await observer.task(handle)).status, 'submission_unknown');
    assert.equal((await observer.generate('tts', quote.quote_id, 'expired', {})).status, 'submission_unknown');
    assert.equal(posts, 1);
  } finally { response.resolve(completed); }
  assert.equal((await pending).status, 'completed');
});

test('speech heartbeat renews its shared lease while a long synthesis is active', async t => {
  const cfg = config(await directory(t)); await processOwner();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const started = deferred<void>(), response = deferred<Outcome>();
  const a = adapter('tts', async () => { started.resolve(); return response.promise; });
  const owner = new GenerationService(cfg, [a]), observer = new GenerationService(cfg, [a]);
  const quote = await owner.estimate('tts', {}), pending = owner.generate('tts', quote.quote_id, 'heartbeat', { credits: 1 });
  await started.promise;
  try {
    const initial = await owner.store.transaction(async state => state.generation_tasks!.heartbeat!);
    for (let step = 0; step < 4; step++) {
      t.mock.timers.tick(EXECUTION_LEASE_MS / 3);
      let expiration = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        expiration = await owner.store.transaction(async state => Date.parse(state.generation_tasks!.heartbeat!.execution_lease!.expires_at));
        if (expiration > Date.now()) break;
        await new Promise(yes => setImmediate(yes));
      }
      assert.ok(expiration > Date.now());
    }
    assert.ok(Date.now() > Date.parse(initial.execution_lease!.expires_at));
    assert.equal((await observer.task(initial.task_handle)).status, 'submitting');
  } finally { response.resolve(completed); await pending; }
});

test('independent speech processes recognize the live owner, then recover its crashed task without reposting', async t => {
  const dir = await directory(t), running = await helper(t, 'speech', dir); let posts = 0;
  const observer = new GenerationService(config(dir), [adapter('tts', async () => { posts++; return completed; })]);
  assert.equal((await observer.task(running.message.handle)).status, 'submitting');
  assert.equal((await observer.generate('tts', running.message.quote, 'child-speech', {})).status, 'submitting');
  await terminate(running.child, running.exited);
  assert.equal((await observer.task(running.message.handle)).status, 'submission_unknown');
  assert.equal((await observer.generate('tts', running.message.quote, 'child-speech', {})).status, 'submission_unknown');
  assert.equal(posts, 0);
});
