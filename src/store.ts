import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { TopMediaiError, type State } from './types.js';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { ownerState, processOwner, type ProcessOwner } from './process-owner.js';

const busy = () => new TopMediaiError('STORE_BUSY', 'Another request is using the local task store. Retry the same request_id later; do not submit a replacement task.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const queues = new Map<string, Promise<void>>();

export class Store {
  constructor(public readonly dir: string) {}
  private async coordinator(deadline: number): Promise<DatabaseSync> {
    // SQLite supplies an OS-managed cross-process mutex, released even after SIGKILL.
    // JSON remains the task format; this connection never contains account data.
    let db: DatabaseSync | undefined;
    while (true) {
      try {
        db ??= new DatabaseSync(resolve(this.dir, 'store-mutex.sqlite'), { timeout: 0, allowExtension: false });
        db.exec('BEGIN EXCLUSIVE');
        return db;
      } catch (error) {
        const number = (error as { errcode?: number }).errcode;
        if (number === undefined || ![5, 6].includes(number & 255)) { db?.close(); throw new TopMediaiError('STORE_LOCK_UNAVAILABLE', 'The local task coordinator could not be opened. Preserve the original request_id and verify its task history.'); }
        if (performance.now() >= deadline) { db?.close(); throw busy(); }
        await sleep(25 + Math.floor(Math.random() * 25));
      }
    }
  }
  private async marker(path: string): Promise<{ text: string; owner: Partial<ProcessOwner> & { lock_id?: string } } | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
      const text = await readFile(path, 'utf8'), owner = JSON.parse(text);
      return owner && typeof owner === 'object' && !Array.isArray(owner) ? { text, owner } : undefined;
    } catch (error) { if (missing(error) || error instanceof SyntaxError) return undefined; throw error; }
  }
  private async acquireMarker(path: string, pending: string, deadline: number): Promise<void> {
    while (true) {
      try { await link(pending, path); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const prior = await this.marker(path);
      if (prior && await ownerState(prior.owner) === 'dead') {
        // Recovery is serialized by the SQLite mutex. Old plugin versions may still
        // acquire store.lock, so recheck the exact marker before removing a dead owner.
        if ((await this.marker(path))?.text === prior.text) await unlink(path).catch(error => { if (!missing(error)) throw error; });
        continue;
      }
      if (performance.now() >= deadline) throw busy();
      await sleep(50);
    }
  }
  async transaction<T>(fn: (state: State) => Promise<T>): Promise<T> {
    // Queue local callers before trying OS locks. Opening competing SQLite
    // connections repeatedly can otherwise starve asynchronous disk work on Windows.
    const absolute = resolve(this.dir), key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>(yes => { release = yes; });
    queues.set(key, finished);
    await previous;
    try { return await this.runTransaction(fn); }
    finally { release(); if (queues.get(key) === finished) queues.delete(key); }
  }
  private async runTransaction<T>(fn: (state: State) => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    const lockPath = resolve(this.dir, 'store.lock');
    const owner = await processOwner(), lockId = randomUUID();
    const pending = resolve(this.dir, `store-lock-${lockId}.tmp`), deadline = performance.now() + 5000;
    const db = await this.coordinator(deadline);
    let acquired = false;
    try {
      // Publish a complete owner record atomically: a crash must not leave an empty lock.
      await writeFile(pending, JSON.stringify({ ...owner, lock_id: lockId, created_at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      await this.acquireMarker(lockPath, pending, deadline); acquired = true;
      await unlink(pending);
      let state: State;
      try {
        state = JSON.parse(await readFile(resolve(this.dir, 'store.json'), 'utf8')) as State;
        if (state.version !== 2 || !state.quotes || typeof state.quotes !== 'object' || Array.isArray(state.quotes) || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks)) throw new Error('Invalid store');
        Object.setPrototypeOf(state.quotes, null);
        Object.setPrototypeOf(state.tasks, null);
        for (const key of ['generation_quotes', 'generation_tasks', 'reference_media', 'speech_assets', 'display_plans'] as const) {
          const value = state[key];
          if (value !== undefined) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid generation store');
            Object.setPrototypeOf(value, null);
          }
        }
        if (state.reference_images !== undefined) {
          if (!state.reference_images || typeof state.reference_images !== 'object' || Array.isArray(state.reference_images)) throw new Error('Invalid reference image store');
          Object.setPrototypeOf(state.reference_images, null);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TopMediaiError('STORE_CORRUPT', 'The local state could not be read; restore it before continuing.');
        state = { version: 2, quotes: Object.create(null), tasks: Object.create(null) };
      }
      return await fn(state);
    } finally {
      try {
        if (acquired && (await this.marker(lockPath))?.owner.lock_id === lockId) await unlink(lockPath);
        await unlink(pending).catch(error => { if (!missing(error)) throw error; });
      } finally { try { db.exec('ROLLBACK'); } finally { db.close(); } }
    }
  }
  async save(state: State): Promise<void> {
    const temp = resolve(this.dir, `store-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, resolve(this.dir, 'store.json'));
  }
}
