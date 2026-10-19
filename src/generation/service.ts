import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { usesDirectApis, type Config } from '../config.js';
import { Store } from '../store.js';
import { TopMediaiError } from '../types.js';
import { MusicAdapter } from './music.js';
import { VideoAdapter, videoOperation, videoOperationSchema } from './video.js';
import type { Adapter, Budget, GenerationKind, GenerationQuote, GenerationTask } from './types.js';
import { WEB_MODELS } from '../catalog/models.js';
import { SpeechAdapter } from './speech.js';
import { billingCredits, quoteDisplay, validateCosts } from '../display-policy.js';
import { requestFailure, UNKNOWN_SUBMISSION_RECOVERY } from '../transport/errors.js';
import { pollAfterSeconds, remainingPollSeconds } from '../task-polling.js';
import { resolveMusicTaskMedia } from '../media/music-result.js';
import { resolveVideoTaskMedia } from '../media/video-result.js';
import { ownerState, processOwner } from '../process-owner.js';

export const EXECUTION_LEASE_MS = 30_000;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class GenerationService {
  readonly store: Store;
  private readonly adapters = new Map<GenerationKind, Adapter>();
  constructor(readonly config: Config, adapters?: Adapter[]) {
    // Preserve image state while isolating multimedia state when business origins change.
    this.store = new Store(resolve(config.dataDir, `multimedia-${digest([config.musicHost, config.ttsHost]).slice(0, 16)}`));
    for (const adapter of adapters ?? [new MusicAdapter(config), new VideoAdapter(config), new SpeechAdapter(config, 'tts'), new SpeechAdapter(config, 'sts')]) this.adapters.set(adapter.kind, adapter);
  }
  capabilities() {
    const kinds: GenerationKind[] = ['music', 'video', 'tts', 'sts', 'denoise', 'clone', 'mv'];
    const pending = { denoise: 'Private audio assets and an authoritative cost preview are required.', clone: 'Private consented audio assets and a candidate-selection cost preview are required.', mv: 'Stage-specific quotes, owned assets and private project queries must be verified before paid MV stages.' };
    const uploadConfigured = usesDirectApis(this.config) && !!this.config.uploadRoot && !!this.config.uploadHost;
    return { environment: this.config.environment, model_catalog_revision: WEB_MODELS.source_revision,
      capabilities: kinds.map(kind => ({ kind, implemented: this.adapters.has(kind), catalog_supported: !!this.adapters.get(kind)?.enabled(), generation_enabled: !!this.adapters.get(kind)?.enabled(), reason: this.adapters.get(kind)?.reason() ?? pending[kind as keyof typeof pending], ...(kind === 'tts' || kind === 'sts' ? { execution_mode: 'synchronous', ...(kind === 'sts' ? { speech_upload_enabled: uploadConfigured && !!this.config.ttsHost } : {}) } : {}), ...(kind === 'video' ? { operations: videoOperationSchema.options, reference_upload_enabled: uploadConfigured, reference_media_upload_enabled: uploadConfigured } : {}) })) };
  }
  adapter(kind: GenerationKind) { const adapter = this.adapters.get(kind); if (!adapter) throw new TopMediaiError('CAPABILITY_UNAVAILABLE', 'This generation contract is not ready.'); return adapter; }
  async estimate(kind: GenerationKind, input: unknown, signal?: AbortSignal) {
    const adapter = this.adapter(kind), params = adapter.validate(input), price = await adapter.estimate(params, signal);
    validateCosts(price.costs);
    if (price.expires_at !== undefined && (!Number.isFinite(Date.parse(price.expires_at)) || Date.parse(price.expires_at) <= Date.now())) throw new TopMediaiError('PRICE_UNAVAILABLE', 'The quote expiration is invalid or expired. Obtain a fresh quote before submitting.');
    const quote: GenerationQuote = { quote_id: randomUUID(), kind, operation: kind === 'video' ? videoOperation(params) : String(params.action ?? kind), params, costs: price.costs, cost_mode: price.cost_mode ?? 'alternative_entitlements', ...(price.cost_mode === 'selected_entitlement' ? { billing: price.pricing } : {}), price_version: price.price_version, pricing_digest: digest(price.pricing), expires_at: new Date(Math.min(Date.now() + 600000, price.expires_at ? Date.parse(price.expires_at) : Infinity)).toISOString() };
    if (price.model_name) quote.model_name = price.model_name;
    await this.store.transaction(async state => { state.generation_quotes ??= Object.create(null); state.generation_quotes![quote.quote_id] = quote; await this.store.save(state); });
    return { ...quote, display: quoteDisplay(kind, params, quote.costs, quote.model_name, billingCredits(quote.billing)), ...(price.sufficient !== undefined ? { sufficient: price.sufficient } : {}), note: quote.cost_mode === 'selected_entitlement' ? 'Show the credit estimate from display.estimated_costs as estimated consumption, not billable characters or seconds. Raw costs retain the selected entitlement for budget checks and backend settlement. A changed billing branch requires a new quote. Final settlement is performed by the synthesis backend; budget is a local check, not a backend hard spending cap.' : 'Raw entitlement costs are for internal budget checks only; show only universal credits from display.estimated_costs, without specialized credits or alternative-branch wording. Do not add entitlement costs together. Set a budget for every listed resource. The original backend makes the final settlement; a local budget is not a backend-enforced spending cap.' };
  }
  private assertBudget(quote: GenerationQuote, budget: Budget) {
    validateCosts(quote.costs);
    for (const cost of quote.costs) { const max = budget[cost.resource]; if (typeof max !== 'number' || !Number.isFinite(max) || max < cost.amount) throw new TopMediaiError('BUDGET_EXCEEDED', `A sufficient ${cost.resource} budget is required.`); }
  }
  async generate(kind: GenerationKind, quoteId: string, requestId: string, budget: Budget, signal?: AbortSignal): Promise<GenerationTask> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new TopMediaiError('INVALID_REQUEST_ID', 'Use a stable request_id of 1–80 letters, digits, underscores or hyphens.');
    const adapter = this.adapter(kind);
    const existing = await this.store.transaction(async state => {
      const task = state.generation_tasks?.[requestId];
      return task ? this.restoreCreditEstimate(task, state.generation_quotes?.[task.quote_id]) : undefined;
    });
    if (existing) return this.replay(existing, kind, quoteId);
    if (!adapter.enabled()) throw new TopMediaiError('GENERATION_DISABLED', adapter.reason() ?? 'This generation capability is disabled.');
    const quote = await this.store.transaction(async state => state.generation_quotes?.[quoteId]);
    if (!quote || quote.kind !== kind) throw new TopMediaiError('QUOTE_NOT_FOUND', 'The account-scoped quote is missing or belongs to another capability.');
    this.assertBudget(quote, budget);
    if (!Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now()) throw new TopMediaiError('QUOTE_EXPIRED', 'Estimate this request again.');
    signal?.throwIfAborted();
    const fresh = await adapter.estimate(adapter.validate(quote.params), signal);
    validateCosts(fresh.costs);
    if (fresh.sufficient === false) throw new TopMediaiError('INSUFFICIENT_ENTITLEMENT', 'The quoted speech entitlement is insufficient. No synthesis was submitted.');
    if (fresh.price_version !== quote.price_version || digest(fresh.pricing) !== quote.pricing_digest || digest(fresh.costs) !== digest(quote.costs)) throw new TopMediaiError('PRICE_CHANGED', 'The price or settlement branch changed. Obtain a new quote.');
    const owner = adapter.execution_mode === 'synchronous' ? await processOwner() : undefined;
    const prepared = await this.store.transaction(async state => {
      state.generation_tasks ??= Object.create(null);
      const prior = state.generation_tasks![requestId]; if (prior) return { task: prior, created: false };
      const saved = state.generation_quotes?.[quoteId];
      if (!saved || saved.used_task) throw new TopMediaiError('QUOTE_USED', 'This quote has already been submitted. Query its saved task.');
      if (Date.parse(saved.expires_at) <= Date.now()) throw new TopMediaiError('QUOTE_EXPIRED', 'Estimate this request again.');
      signal?.throwIfAborted();
      const task: GenerationTask = { task_handle: randomUUID(), request_id: requestId, quote_id: quoteId, kind, operation: quote.operation, params: quote.params, costs: quote.costs, created_at: new Date().toISOString(), ...(adapter.execution_mode ? { execution_mode: adapter.execution_mode } : {}), status: 'submitting', remote: {}, artifacts: [] };
      const estimatedCredits = billingCredits(quote.billing);
      if (estimatedCredits !== undefined) task.estimated_credits = estimatedCredits;
      if (owner) task.execution_lease = { lease_id: randomUUID(), owner, expires_at: new Date(Date.now() + EXECUTION_LEASE_MS).toISOString() };
      if (quote.model_name) task.model_name = quote.model_name;
      saved.used_task = task.task_handle; state.generation_tasks![requestId] = task; await this.store.save(state);
      return { task, created: true };
    });
    if (!prepared.created) return this.replay(prepared.task, kind, quoteId);
    // Intent is durable before the single paid POST; no network work holds the store lock.
    const stopHeartbeat = this.heartbeat(prepared.task);
    let outcome;
    try { outcome = await adapter.create(quote.params, fresh.reference_images, fresh.reference_media, signal); }
    catch (error) { outcome = { status: 'submission_unknown' as const, remote: {}, artifacts: [], error: requestFailure(error) }; }
    await stopHeartbeat();
    return this.store.transaction(async state => {
      const saved = state.generation_tasks![requestId]!;
      if (owner && saved.execution_lease?.lease_id !== prepared.task.execution_lease?.lease_id) return this.taskResult(saved);
      Object.assign(saved, outcome, ...(adapter.execution_mode === 'synchronous' && ['completed', 'failed'].includes(outcome.status) ? [{ finished_at: new Date().toISOString() }] : []));
      delete saved.execution_lease;
      await this.store.save(state); return this.taskResult(saved);
    });
  }
  private async replay(task: GenerationTask, kind: GenerationKind, quoteId: string) {
    if (task.kind !== kind || task.quote_id !== quoteId) throw new TopMediaiError('IDEMPOTENCY_CONFLICT', 'This request_id is already bound to another quote or capability.');
    if (task.execution_mode === 'synchronous') return this.synchronousTask(task);
    return this.taskResult(task.status === 'submitting' ? { ...task, status: 'submission_unknown' as const } : task);
  }
  private heartbeat(task: GenerationTask): () => Promise<void> {
    const lease = task.execution_lease;
    if (!lease) return async () => {};
    let pending: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (pending) return;
      pending = this.store.transaction(async state => {
        const latest = state.generation_tasks?.[task.request_id];
        if (latest?.status === 'submitting' && latest.execution_lease?.lease_id === lease.lease_id) {
          latest.execution_lease.expires_at = new Date(Date.now() + EXECUTION_LEASE_MS).toISOString();
          await this.store.save(state);
        }
      }).catch(() => { /* A lost heartbeat never authorizes a second paid submission. */ }).finally(() => { pending = undefined; });
    }, EXECUTION_LEASE_MS / 3);
    timer.unref?.();
    return async () => { clearInterval(timer); await pending; };
  }
  private async synchronousTask(task: GenerationTask): Promise<GenerationTask> {
    if (task.status !== 'submitting') return this.taskResult(task);
    const lease = task.execution_lease, expiration = Date.parse(lease?.expires_at ?? '');
    const expired = !Number.isFinite(expiration) || expiration <= Date.now();
    // Process checks run outside the store transaction. Absence from a local Set
    // cannot establish that a different session's synthesis has stopped.
    if (!expired && await ownerState(lease!.owner) !== 'dead') return this.taskResult(task);
    return this.store.transaction(async state => {
      const latest = state.generation_tasks![task.request_id]!;
      if (latest.status === 'submitting' && latest.execution_lease?.lease_id === lease?.lease_id) {
        const renewed = Date.parse(latest.execution_lease?.expires_at ?? '');
        if (!expired || !Number.isFinite(renewed) || renewed <= Date.now()) {
          latest.status = 'submission_unknown'; await this.store.save(state);
        }
      }
      return this.taskResult(this.restoreCreditEstimate(latest, state.generation_quotes?.[latest.quote_id]));
    });
  }
  private taskResult(task: GenerationTask, cached = false): GenerationTask {
    const { execution_lease: _lease, ...visible } = task;
    return { ...(task.kind === 'music' ? resolveMusicTaskMedia(visible) : task.kind === 'video' ? resolveVideoTaskMedia(visible) : visible), poll_after_seconds: task.execution_mode === 'synchronous' ? undefined : pollAfterSeconds(task, cached),
      ...(task.status === 'submission_unknown' ? { recovery: UNKNOWN_SUBMISSION_RECOVERY } : {}),
      ...(cached ? { cached: true } : {}) };
  }
  private restoreCreditEstimate(task: GenerationTask, quote?: GenerationQuote): GenerationTask {
    if (task.estimated_credits !== undefined) return task;
    const estimatedCredits = billingCredits(quote?.billing);
    return estimatedCredits === undefined ? task : { ...task, estimated_credits: estimatedCredits };
  }
  async task(handle: string, poll = true): Promise<GenerationTask> {
    const prepared = await this.store.transaction(async state => {
      const saved = Object.values(state.generation_tasks ?? {}).find(t => t.task_handle === handle);
      if (!saved) throw new TopMediaiError('TASK_NOT_FOUND', 'Only this account and configuration’s locally created task handles can be queried.');
      const task = this.restoreCreditEstimate(saved, state.generation_quotes?.[saved.quote_id]);
      if (!poll) return { task, poll: false, cached: false };
      if (task?.execution_mode === 'synchronous') {
        return { task, poll: false, cached: false };
      }
      if (['submitting', 'submission_unknown'].includes(task.status)) return { task: { ...task, status: 'submission_unknown' as const }, poll: false, cached: false };
      if (remainingPollSeconds(task)) return { task, poll: false, cached: true };
      task.poll_revision = (task.poll_revision ?? 0) + 1;
      // Reserve only this task while the HTTP request runs outside the store lock.
      // A crashed poll releases its reservation after the transport timeout plus a save margin.
      task.poll_in_flight_until = new Date(Date.now() + this.config.timeoutMs + 5000).toISOString();
      await this.store.save(state);
      return { task, poll: true, cached: false };
    });
    const saved = prepared.task;
    if (poll && saved.execution_mode === 'synchronous') return this.synchronousTask(saved);
    if (!prepared.poll) return this.taskResult(saved, prepared.cached);
    try {
      const adapter = this.adapter(saved.kind);
      if (!adapter.poll) throw new TopMediaiError('CAPABILITY_UNAVAILABLE', 'Remote polling is not supported for this task.');
      const outcome = await adapter.poll(saved), completedAt = new Date().toISOString();
      return await this.store.transaction(async state => {
        const latest = state.generation_tasks![saved.request_id]!;
        // A slower, earlier poll must not overwrite a newer observed result.
        if (latest.poll_revision === saved.poll_revision) {
          Object.assign(latest, outcome, { last_polled_at: completedAt });
          delete latest.poll_in_flight_until;
          await this.store.save(state);
        }
        return this.taskResult(latest);
      });
    } catch (error) {
      await this.store.transaction(async state => {
        const latest = state.generation_tasks![saved.request_id]!;
        if (latest.poll_revision === saved.poll_revision) { delete latest.poll_in_flight_until; await this.store.save(state); }
      });
      throw error;
    }
  }
}
