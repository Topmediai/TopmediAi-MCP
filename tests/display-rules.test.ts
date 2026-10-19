import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { RuntimeServices, type RuntimeContext } from '../src/runtime.js';
import { reviewGenerationPlan } from '../src/generation-plan.js';
import { balanceDisplay, displayCosts, isHighPriceModel, quoteDisplay, taskDisplay, validateCosts, withTaskDisplay } from '../src/display-policy.js';
import { GenerationService } from '../src/generation/service.js';
import { aggregate, MusicAdapter } from '../src/generation/music.js';
import { createServer } from '../src/server.js';
import { publicVoice } from '../src/generation/voices.js';
import type { Adapter, Cost, GenerationQuote } from '../src/generation/types.js';
import { TopMediaiError } from '../src/types.js';

const code = (expected: string) => (error: unknown) => error instanceof TopMediaiError && error.code === expected;
async function context(t: TestContext) {
  const parent = tmpdir(), dir = await mkdtemp(resolve(parent, 'topmediai-display-'));
  t.after(async () => { const path = relative(parent, dir); assert.ok(path.startsWith('topmediai-display-') && !isAbsolute(path) && !path.startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Display and confirmation tests must not contact live services'));
  return new RuntimeServices(loadConfig({ TOPMEDIAI_DATA_DIR: dir, TOPMEDIAI_TOKEN: 'A'.repeat(42) }, () => null)).current();
}
async function quote(ctx: RuntimeContext, costs: Cost[], options: { kind?: GenerationQuote['kind']; model_type?: number; params?: Record<string, unknown>; expired?: boolean; billing?: object } = {}) {
  const kind = options.kind ?? 'video';
  const saved: GenerationQuote = { quote_id: randomUUID(), kind, operation: kind,
    params: { model_type: options.model_type ?? 30, content: 'A mountain landscape', ...options.params }, costs,
    price_version: 'fixture', pricing_digest: 'fixture', cost_mode: 'selected_entitlement', billing: options.billing, expires_at: new Date(Date.now() + (options.expired ? -10000 : 600000)).toISOString() };
  await ctx.generation.store.transaction(async state => { state.generation_quotes ??= {}; state.generation_quotes[saved.quote_id] = saved; await ctx.generation.store.save(state); });
  return { kind: kind as 'video' | 'music' | 'tts' | 'sts', quote_id: saved.quote_id };
}

test('product high-price names match catalog spelling without aliases to unrelated models', async t => {
  const ctx = await context(t);
  for (const model_type of [38, 37, 32]) {
    const ref = await quote(ctx, [{ resource: 'credits', amount: 0 }], { model_type });
    const result = await reviewGenerationPlan({ flow_id: `high-${model_type}`, steps: [ref] }, ctx);
    assert.equal(result.confirmation_required, true); assert.deepEqual(result.reasons, ['high_price_model']);
  }
  assert.equal(isHighPriceModel('MiniMax H3'), true);
  assert.equal(isHighPriceModel('Happy Horse 1.1'), true);
  assert.equal(isHighPriceModel('Hailuo 2.3'), false);
  assert.equal(isHighPriceModel('MiniMax'), false);
});

test('ordinary models confirm only strictly above 1000 universal credits', async t => {
  const ctx = await context(t);
  for (const [amount, required] of [[0, false], [999.99, false], [1000, false], [1000.01, true]] as const) {
    const ref = await quote(ctx, [{ resource: 'credits', amount }]);
    assert.equal((await reviewGenerationPlan({ flow_id: `boundary-${String(amount).replace('.', '_')}`, steps: [ref] }, ctx)).confirmation_required, required);
  }
  const high = await quote(ctx, [{ resource: 'credits', amount: 2000 }], { model_type: 38 });
  const result = await reviewGenerationPlan({ flow_id: 'both', steps: [high] }, ctx);
  assert.equal(result.confirmation_required, true); assert.equal(result.reasons.length, 2);
});

test('flows sum credit estimates and hide settlement entitlements and billable quantities', async t => {
  const ctx = await context(t);
  const a = await quote(ctx, [{ resource: 'credits', amount: 600 }]);
  const b = await quote(ctx, [{ resource: 'credits', amount: 500 }]);
  assert.equal((await reviewGenerationPlan({ flow_id: 'same', steps: [a, b] }, ctx)).confirmation_required, true);
  const music = await quote(ctx, [{ resource: 'music_credits', amount: 600 }], { kind: 'music', params: { mv: 'v6-mini' } });
  const split = await reviewGenerationPlan({ flow_id: 'split', steps: [a, music] }, ctx);
  assert.equal(split.confirmation_required, false); assert.deepEqual(split.estimated_totals.map(cost => cost.amount), [600]);
  assert.equal(split.estimated_cost_status, 'unknown');
  assert.deepEqual(split.steps[1]?.estimated_costs, []); assert.equal(split.steps[1]?.estimated_cost_status, 'unknown');
  const speech = await quote(ctx, [{ resource: 'characters', amount: 20000, resource_scope: 'voice:one' }], { kind: 'tts', billing: { credits_required: 100 } });
  const old = await quote(ctx, [{ resource: 'video_units', amount: 10000 }, { resource: 'credits', amount: 0 }]);
  const billing = await reviewGenerationPlan({ flow_id: 'billing', steps: [speech, old] }, ctx);
  assert.equal(billing.confirmation_required, false);
  assert.ok(!JSON.stringify(billing.estimated_totals).includes('video_units'));
  assert.deepEqual(billing.estimated_totals.map(({ resource, amount, unit_type }) => ({ resource, amount, unit_type })), [{ resource: 'credits', amount: 100, unit_type: 'credits' }]);
  const other = await quote(ctx, [{ resource: 'characters', amount: 100, resource_scope: 'voice:two' }], { kind: 'tts', billing: { credits_required: 1 } });
  const scoped = await reviewGenerationPlan({ flow_id: 'scoped', steps: [speech, other] }, ctx);
  assert.deepEqual(scoped.estimated_totals.map(cost => cost.amount), [101]);
  const saved = await ctx.generation.store.transaction(async state => state.generation_quotes![speech.quote_id]!);
  assert.deepEqual(saved.costs, [{ resource: 'characters', amount: 20000, resource_scope: 'voice:one' }]);
});

test('speech uses each quoted credit estimate and preserves the strict confirmation boundary', async t => {
  const ctx = await context(t);
  const refs = await Promise.all([1, 2].map(() => quote(ctx, [{ resource: 'characters', amount: 201 }], { kind: 'tts', billing: { credits_required: 2 } })));
  const rounded = await reviewGenerationPlan({ flow_id: 'rounded-speech', steps: refs }, ctx);
  assert.equal(rounded.estimated_totals[0]?.amount, 4, 'Two independently rounded quotes must not be converted from their summed characters');
  assert.equal(rounded.estimated_cost_status, 'known');
  for (const amount of [1000, 1001]) {
    const ref = await quote(ctx, [{ resource: 'characters', amount: amount * 200 }], { kind: 'tts', billing: { credits_required: amount } });
    const result = await reviewGenerationPlan({ flow_id: `speech-boundary-${amount}`, steps: [ref] }, ctx);
    assert.equal(result.estimated_totals[0]?.amount, amount);
    assert.equal(result.confirmation_required, amount > 1000);
    assert.equal(quoteDisplay('tts', {}, [{ resource: 'characters', amount: amount * 200 }], 'sunny', amount).confirmation.exceeds_threshold, amount > 1000);
  }
});

test('speech recovery keeps the original credit estimate and increased estimates require renewed confirmation', async t => {
  const ctx = await context(t), costs: Cost[] = [{ resource: 'characters', amount: 300000, resource_scope: 'account:characters' }];
  const original = await quote(ctx, costs, { kind: 'tts', billing: { credits_required: 1500 } });
  const initial = await reviewGenerationPlan({ flow_id: 'speech-recovery', steps: [original] }, ctx);
  const renewed = await quote(ctx, costs, { kind: 'tts', billing: { credits_required: 1500 } });
  const approved = await reviewGenerationPlan({ flow_id: 'speech-recovery', steps: [renewed], confirmed_plan_id: initial.plan_id }, ctx);
  assert.equal(approved.confirmation_required, false); assert.equal(approved.plan_id, initial.plan_id);
  const higher = await quote(ctx, costs, { kind: 'tts', billing: { credits_required: 1600 } });
  assert.equal((await reviewGenerationPlan({ flow_id: 'speech-recovery', steps: [higher], confirmed_plan_id: initial.plan_id }, ctx)).confirmation_required, true);
  await ctx.generation.store.transaction(async state => {
    const saved = state.generation_quotes![original.quote_id]!;
    state.generation_tasks ??= {};
    state.generation_tasks['speech-original'] = { ...saved, task_handle: randomUUID(), request_id: 'speech-original', estimated_credits: 1500,
      created_at: new Date().toISOString(), status: 'submission_unknown', remote: {}, artifacts: [] };
    await ctx.generation.store.save(state);
  });
  const restored = await reviewGenerationPlan({ flow_id: 'speech-recovery', steps: [original], submitted_steps: [{ kind: 'tts', request_id: 'speech-original' }], confirmed_plan_id: initial.plan_id }, ctx);
  assert.equal(restored.step_count, 1); assert.equal(restored.estimated_totals[0]?.amount, 1500);
  assert.equal(restored.confirmation_required, false); assert.equal(restored.plan_id, initial.plan_id);
});

test('missing speech credit prices stay unknown instead of exposing characters or inventing conversion', async t => {
  const ctx = await context(t), costs: Cost[] = [{ resource: 'characters', amount: 1975 }];
  const ref = await quote(ctx, costs, { kind: 'tts' });
  const result = await reviewGenerationPlan({ flow_id: 'speech-unknown', steps: [ref] }, ctx);
  assert.deepEqual(result.estimated_totals, []); assert.equal(result.estimated_cost_status, 'unknown');
  for (const amount of [undefined, NaN, Infinity, -1]) {
    const display = quoteDisplay('tts', {}, costs, 'sunny', amount);
    assert.deepEqual(display.estimated_costs, []); assert.equal(display.estimated_cost_status, 'unknown');
  }
  assert.deepEqual(quoteDisplay('tts', {}, costs, 'sunny', 0).estimated_costs, [{ resource: 'credits', amount: 0, label: 'Credits', unit_type: 'credits' }]);
});

test('decimal accumulation preserves the exact threshold', async t => {
  const ctx = await context(t);
  const refs = await Promise.all([999.8, 0.1, 0.1].map(amount => quote(ctx, [{ resource: 'credits', amount }])));
  const result = await reviewGenerationPlan({ flow_id: 'decimal', steps: refs }, ctx);
  assert.equal(result.estimated_totals[0]?.amount, 1000); assert.equal(result.confirmation_required, false);
});

test('latest conversation mode disables both conditions, restores conditional or requests confirmation', async t => {
  const ctx = await context(t), ref = await quote(ctx, [{ resource: 'credits', amount: 2000 }], { model_type: 38 });
  assert.equal((await reviewGenerationPlan({ flow_id: 'modes', steps: [ref], confirmation_mode: 'off' }, ctx)).confirmation_required, false);
  assert.equal((await reviewGenerationPlan({ flow_id: 'modes', steps: [ref], confirmation_mode: 'conditional' }, ctx)).confirmation_required, true);
  const low = await quote(ctx, [{ resource: 'credits', amount: 1 }]);
  assert.equal((await reviewGenerationPlan({ flow_id: 'explicit', steps: [low], confirmation_mode: 'always' }, ctx)).confirmation_required, true);
  // No account/process preference is written; a new conversation starts with the schema default.
  assert.equal((await reviewGenerationPlan({ flow_id: 'new-chat', steps: [ref] }, ctx)).confirmation_mode, 'conditional');
});

test('same confirmed terms survive renewed quotes and service restart; new flows and increased costs require consent', async t => {
  const ctx = await context(t), original = await quote(ctx, [{ resource: 'credits', amount: 1500 }]);
  const result = await reviewGenerationPlan({ flow_id: 'stable', steps: [original] }, ctx);
  const renewed = await quote(ctx, [{ resource: 'credits', amount: 1500 }]);
  const resumed = new RuntimeServices(ctx.config).current();
  const approved = await reviewGenerationPlan({ flow_id: 'stable', steps: [renewed], confirmed_plan_id: result.plan_id }, resumed);
  assert.equal(approved.plan_id, result.plan_id); assert.equal(approved.confirmation_required, false); assert.equal(approved.already_confirmed, true);
  const cheaper = await quote(ctx, [{ resource: 'credits', amount: 1400 }]);
  assert.equal((await reviewGenerationPlan({ flow_id: 'stable', steps: [cheaper], confirmed_plan_id: result.plan_id }, ctx)).confirmation_required, false);
  const higher = await quote(ctx, [{ resource: 'credits', amount: 1600 }]);
  assert.equal((await reviewGenerationPlan({ flow_id: 'stable', steps: [higher], confirmed_plan_id: result.plan_id }, ctx)).confirmation_required, true);
  assert.equal((await reviewGenerationPlan({ flow_id: 'new-request', steps: [renewed], confirmed_plan_id: result.plan_id }, ctx)).confirmation_required, true);
  const changed = await quote(ctx, [{ resource: 'credits', amount: 1500 }], { params: { content: 'A city skyline' } });
  assert.equal((await reviewGenerationPlan({ flow_id: 'stable', steps: [changed], confirmed_plan_id: result.plan_id }, ctx)).confirmation_required, true);
});

test('duplicate references count once, independent requests count twice, submitted recovery retains original cost', async t => {
  const ctx = await context(t), ref = await quote(ctx, [{ resource: 'credits', amount: 600 }]);
  const duplicate = await reviewGenerationPlan({ flow_id: 'retry', steps: [ref, ref] }, ctx);
  assert.equal(duplicate.step_count, 1); assert.equal(duplicate.confirmation_required, false);
  const independent = await quote(ctx, [{ resource: 'credits', amount: 600 }]);
  const initial = await reviewGenerationPlan({ flow_id: 'two', steps: [ref, independent] }, ctx);
  assert.equal(initial.step_count, 2); assert.equal(initial.confirmation_required, true);
  await ctx.generation.store.transaction(async state => {
    const saved = state.generation_quotes![ref.quote_id]!; saved.expires_at = new Date(0).toISOString();
    state.generation_tasks ??= {}; state.generation_tasks['original-request'] = { ...saved, task_handle: randomUUID(), request_id: 'original-request', created_at: new Date().toISOString(), status: 'submission_unknown', remote: {}, artifacts: [] };
    await ctx.generation.store.save(state);
  });
  const submitted = { kind: 'video' as const, request_id: 'original-request' };
  const restored = await reviewGenerationPlan({ flow_id: 'two', steps: [ref, independent], submitted_steps: [submitted, submitted], confirmed_plan_id: initial.plan_id }, ctx);
  assert.equal(restored.step_count, 2); assert.equal(restored.estimated_totals[0]?.amount, 1200); assert.equal(restored.confirmation_required, false);
  const querying = await reviewGenerationPlan({ flow_id: 'retry', steps: [], submitted_steps: [submitted] }, ctx);
  assert.equal(querying.estimated_totals[0]?.amount, 600);
  await assert.rejects(reviewGenerationPlan({ flow_id: 'used', steps: [ref] }, ctx), code('QUOTE_USED'));
});

test('missing, expired, unknown or used quotes stop review even when reminders are off', async t => {
  const ctx = await context(t), missing = { kind: 'video' as const, quote_id: randomUUID() };
  await assert.rejects(reviewGenerationPlan({ flow_id: 'invalid', steps: [missing], confirmation_mode: 'off' }, ctx), code('QUOTE_NOT_FOUND'));
  const expired = await quote(ctx, [{ resource: 'credits', amount: 1 }], { expired: true });
  await assert.rejects(reviewGenerationPlan({ flow_id: 'expired', steps: [expired], confirmation_mode: 'off' }, ctx), code('QUOTE_EXPIRED'));
  const invalid = await quote(ctx, [{ resource: 'credits', amount: null as unknown as number }]);
  await assert.rejects(reviewGenerationPlan({ flow_id: 'unknown', steps: [invalid], confirmation_mode: 'off' }, ctx), code('PRICE_UNAVAILABLE'));
  const other = new RuntimeServices({ ...ctx.config, dataDir: resolve(ctx.config.dataDir, 'other-account') }).current();
  await assert.rejects(reviewGenerationPlan({ flow_id: 'foreign', steps: [expired] }, other), code('QUOTE_NOT_FOUND'));
});

test('only universal-credit balances are displayed, preserving zero, unlimited and unknown values', () => {
  assert.deepEqual(balanceDisplay({ credits: 0, music_credits: undefined }), [
    { resource: 'credits', label: 'Credits', status: 'known', amount: 0 },
  ]);
  assert.deepEqual(balanceDisplay({ music_credits: 1000 }), [{ resource: 'credits', label: 'Credits', status: 'unknown' }]);
  assert.equal(balanceDisplay({ credits: -1 })[0]?.status, 'unlimited');
  assert.equal(balanceDisplay({ credits: -8 })[0]?.status, 'unknown');
  const visible = displayCosts([{ resource: 'music_credits', amount: 5000 }, { resource: 'video_units', amount: 50 }, { resource: 'credits', amount: 0 }]);
  assert.equal(visible.length, 1); assert.equal(visible[0]?.amount, 0);
  const result = taskDisplay('video', { model_type: 38 }, [{ resource: 'credits', amount: 20 }]);
  assert.equal(result.model.name, 'Seedance 2.5'); assert.equal(result.actual_consumption.status, 'not_returned');
  assert.equal(quoteDisplay('tts', {}, [{ resource: 'characters', amount: 10000 }], 'Microsoft').confirmation.exceeds_threshold, false);
  for (const value of [undefined, null, NaN, Infinity, -1, '0']) assert.throws(() => validateCosts([{ resource: 'credits', amount: value as number }]), code('PRICE_UNAVAILABLE'));
  assert.throws(() => validateCosts([]), code('PRICE_UNAVAILABLE'));
});

test('two music requests display 100 universal credits while retaining both original quote branches', async t => {
  const ctx = await context(t), costs: Cost[] = [{ resource: 'music_credits', amount: 5 }, { resource: 'credits', amount: 50 }];
  const refs = await Promise.all(['epic', 'light'].map(title => quote(ctx, costs, { kind: 'music', params: { mv: 'v6-wild-pro', title } })));
  const plan = await reviewGenerationPlan({ flow_id: 'two-music-styles', steps: refs }, ctx);
  assert.deepEqual(plan.estimated_totals.map(({ resource, amount }) => ({ resource, amount })), [{ resource: 'credits', amount: 100 }]);
  assert.equal(plan.estimated_cost_status, 'known'); assert.equal(plan.confirmation_required, false);
  assert.ok(plan.steps.every(step => step.estimated_costs.length === 1 && step.estimated_costs[0]?.resource === 'credits'));
  for (const display of [quoteDisplay('music', { mv: 'v6-wild-pro' }, costs), taskDisplay('music', { mv: 'v6-wild-pro' }, costs)]) {
    assert.deepEqual(display.estimated_costs.map(({ resource, amount, label }) => ({ resource, amount, label })), [{ resource: 'credits', amount: 50, label: 'Credits' }]);
    assert.equal(display.estimated_cost_status, 'known');
  }
  const saved = await ctx.generation.store.transaction(async state => state.generation_quotes![refs[0]!.quote_id]!);
  assert.deepEqual(saved.costs, costs);
});

test('hidden costs never replace missing universal prices or trigger the universal-credit threshold', async t => {
  const ctx = await context(t), costs: Cost[] = [{ resource: 'music_credits', amount: 10000 }, { resource: 'credits', amount: 10 }];
  assert.equal(quoteDisplay('music', { mv: 'v6-mini' }, costs).confirmation.exceeds_threshold, false);
  const ref = await quote(ctx, costs, { kind: 'music', params: { mv: 'v6-mini' } });
  assert.equal((await reviewGenerationPlan({ flow_id: 'hidden-threshold', steps: [ref] }, ctx)).confirmation_required, false);
  const hiddenOnly: Cost[] = [{ resource: 'music_credits', amount: 5 }];
  for (const display of [quoteDisplay('music', { mv: 'v6-mini' }, hiddenOnly), taskDisplay('music', { mv: 'v6-mini' }, hiddenOnly)]) {
    assert.deepEqual(display.estimated_costs, []); assert.equal(display.estimated_cost_status, 'unknown');
  }
});

test('hidden music costs still require their original budget before paid submission', async t => {
  const ctx = await context(t); let submits = 0;
  const costs: Cost[] = [{ resource: 'music_credits', amount: 5 }, { resource: 'credits', amount: 50 }];
  const adapter: Adapter = { kind: 'music', enabled: () => true, reason: () => undefined, validate: input => input as Record<string, unknown>, models: async () => ({}),
    estimate: async () => ({ costs, price_version: 'fixture', pricing: {} }),
    create: async () => { submits++; return { status: 'queued', remote: {}, artifacts: [] }; }, poll: async task => task };
  const service = new GenerationService(ctx.config, [adapter]), estimate = await service.estimate('music', { mv: 'v6-mini' });
  await assert.rejects(service.generate('music', estimate.quote_id, 'missing-hidden-budget', { credits: 50 }), code('BUDGET_EXCEEDED'));
  assert.equal(submits, 0);
  const task = await service.generate('music', estimate.quote_id, 'complete-budget', { credits: 50, music_credits: 5 });
  assert.equal(submits, 1); assert.deepEqual(task.costs, costs);
  assert.deepEqual(withTaskDisplay(task).display.estimated_costs.map(cost => cost.resource), ['credits']);
});

test('music entitlement MCP responses show only universal credits and retain raw internal entitlements', async t => {
  const ctx = await context(t);
  t.mock.method(MusicAdapter.prototype, 'entitlements', async () => ({ music_credits: 1234, credits: 100 }));
  const server = createServer(ctx.config), client = new Client({ name: 'credit-display-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'get_music_entitlements', arguments: {} });
  assert.equal(result.isError, undefined);
  const content = result.structuredContent as { music_credits: number; credits: number; display: { balances: ReturnType<typeof balanceDisplay> } };
  assert.equal(content.music_credits, 1234); assert.equal(content.credits, 100);
  assert.deepEqual(content.display.balances, [{ resource: 'credits', label: 'Credits', status: 'known', amount: 100 }]);
});

test('invalid fresh costs or changed totals cannot reach a paid adapter even if its pricing digest stayed the same', async t => {
  const ctx = await context(t); let amount = 10, submits = 0;
  const adapter: Adapter = { kind: 'music', enabled: () => true, reason: () => undefined, validate: input => input as Record<string, unknown>, models: async () => ({}),
    estimate: async () => ({ costs: [{ resource: 'credits', amount }], price_version: 'same', pricing: {} }),
    create: async () => { submits++; return { status: 'queued', remote: {}, artifacts: [] }; }, poll: async task => task };
  const service = new GenerationService(ctx.config, [adapter]);
  const original = await service.estimate('music', { mv: 'v6-mini' });
  amount = NaN;
  await assert.rejects(service.generate('music', original.quote_id, 'unknown-cost', { credits: 100 }), code('PRICE_UNAVAILABLE'));
  await assert.rejects(service.estimate('music', { mv: 'v6-mini' }), code('PRICE_UNAVAILABLE'));
  amount = 20;
  await assert.rejects(service.generate('music', original.quote_id, 'changed-total', { credits: 100 }), code('PRICE_CHANGED'));
  assert.equal(submits, 0);
});

test('known successful music is retained when another result is unknown', () => {
  assert.equal(aggregate(['completed', 'unknown']), 'partially_completed');
  assert.equal(aggregate(['completed', 'failed']), 'partially_completed');
  assert.equal(aggregate(['unknown', 'unknown']), 'unknown');
});

test('voice samples expose real backend audition links, separate model from voice and omit unusable optional links', () => {
  const voice = publicVoice({ voice_id: 'public-voice', voice_name: 'Alice', channel_id: 4, voice_model_name: 'Configured speech model', accent: ['English'], style: ['Narration'],
    audition_url: 'https://media.fixture.invalid/sample.mp3', emotion_audition: { English: { Happy: 'https://media.fixture.invalid/happy.mp3', Bad: 'https://127.0.0.1/private.mp3' } }, internal_secret: 'hidden' });
  assert.equal(voice.voice_name, 'Alice'); assert.equal(voice.model_name, 'Configured speech model');
  assert.equal(voice.auditions?.length, 2); assert.ok(voice.auditions?.every(item => item.kind === 'sample'));
  assert.equal(voice.auditions?.[1]?.language, 'English');
  assert.equal(JSON.stringify(voice).includes('internal_secret'), false);
  assert.equal(publicVoice({ voice_id: 'public-voice', audition_url: 'http://media.fixture.invalid/a.mp3' }).auditions, undefined);
});
