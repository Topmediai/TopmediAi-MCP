import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CONFIRMATION_THRESHOLD, billingCredits, costDisplay, displayCosts, modelDisplay, validateCosts } from './display-policy.js';
import type { RuntimeContext } from './runtime.js';
import type { Cost, GenerationKind } from './generation/types.js';
import { TopMediaiError } from './types.js';

const kind = z.enum(['image', 'music', 'video', 'tts', 'sts']);
export const planSchema = z.strictObject({
  flow_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).describe('Stable ID for this complete creative request in this conversation, including related steps and retries. Use a new ID for unrelated creation.'),
  steps: z.array(z.strictObject({ kind, quote_id: z.string().uuid() })).max(100).describe('All pending quoted steps. Each quote authorizes one submission; obtain distinct quotes for distinct paid requests.'),
  submitted_steps: z.array(z.strictObject({ kind, request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) })).max(100).default([]).describe('Already submitted requests belonging to this same flow, including failed/uncertain submissions. Never include unrelated history.'),
  confirmation_mode: z.enum(['conditional', 'off', 'always']).default('conditional').describe('Latest explicit preference in this conversation. New conversations default to conditional. always applies within the scope the user requested.'),
  confirmed_plan_id: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Only pass a returned plan_id after the human explicitly approved that exact plan in this conversation.'),
}).refine(args => args.steps.length + args.submitted_steps.length > 0, 'At least one pending or submitted step is required.');
export type PlanInput = z.input<typeof planSchema>;
export interface SavedPlan { flow_id: string; scope_id: string; costs: Cost[]; high_price_models: string[]; estimated_costs?: Cost[]; }
interface Step {
  kind: 'image' | GenerationKind; params: Record<string, unknown>; costs: Cost[]; model_name?: string; estimated_credits?: number;
  identity: string; quote_id: string; phase: 'pending' | 'submitted';
}
// Sorting object keys makes renewed quotes for the same input keep the same plan identity.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
// Add decimal prices without a binary rounding tail changing the strict 1000 boundary.
function addAmount(a: number, b: number) {
  const decimal = (value: number) => {
    const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
    const [whole, fraction = ''] = mantissa!.split('.');
    return { integer: BigInt(whole! + fraction), scale: fraction.length - Number(exponent) };
  };
  const left = decimal(a), right = decimal(b), scale = Math.max(0, left.scale, right.scale);
  const sum = left.integer * 10n ** BigInt(scale - left.scale) + right.integer * 10n ** BigInt(scale - right.scale);
  return Number(`${sum}e-${scale}`);
}
export async function reviewGenerationPlan(input: PlanInput, context: RuntimeContext) {
  const args = planSchema.parse(input);
  const imageState = await context.service.store.transaction(async state => state);
  const generationState = await context.generation.store.transaction(async state => state);
  const steps = new Map<string, Step>();
  for (const ref of args.submitted_steps) {
    const task = ref.kind === 'image' ? imageState.tasks[ref.request_id] : generationState.generation_tasks?.[ref.request_id];
    if (!task || ('kind' in task && task.kind !== ref.kind)) throw new TopMediaiError('TASK_NOT_FOUND', 'A submitted flow step is missing in this account/configuration. Verify the original task; do not submit again.');
    const costs = 'kind' in task ? task.costs : [{ resource: 'credits' as const, amount: task.estimated_credits }];
    const quote = generationState.generation_quotes?.[task.quote_id];
    const identity = `${ref.kind}:${ref.request_id}`;
    steps.set(identity, { kind: ref.kind, params: { ...task.params }, costs, identity, quote_id: task.quote_id, phase: 'submitted', model_name: ('model_name' in task ? task.model_name : undefined) ?? quote?.model_name, estimated_credits: task.estimated_credits ?? billingCredits(quote?.billing) });
  }
  const submittedQuotes = new Set([...steps.values()].map(step => `${step.kind}:${step.quote_id}`));
  for (const ref of args.steps) {
    const quote = ref.kind === 'image' ? imageState.quotes[ref.quote_id] : generationState.generation_quotes?.[ref.quote_id];
    if (submittedQuotes.has(`${ref.kind}:${ref.quote_id}`)) continue;
    if (!quote || ('kind' in quote && quote.kind !== ref.kind)) throw new TopMediaiError('QUOTE_NOT_FOUND', 'A pending flow quote is missing or belongs to another capability. Obtain a valid quote before submitting.');
    const priorTask = ref.kind === 'image' ? Object.values(imageState.tasks).find(task => task.quote_id === ref.quote_id)
      : Object.values(generationState.generation_tasks ?? {}).find(task => task.quote_id === ref.quote_id);
    if (priorTask) throw new TopMediaiError('QUOTE_USED', 'This step is already submitted. Include its original request_id in submitted_steps; do not treat it as a new paid step.');
    if (!Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now()) throw new TopMediaiError('QUOTE_EXPIRED', 'A pending flow quote expired. Obtain a fresh quote before submitting.');
    const costs = 'credits' in quote ? [{ resource: 'credits' as const, amount: quote.credits }] : quote.costs;
    const identity = `${ref.kind}:${ref.quote_id}`;
    steps.set(identity, { kind: ref.kind, params: { ...quote.params }, costs, identity, quote_id: ref.quote_id, phase: 'pending', model_name: 'model_name' in quote ? quote.model_name : undefined, estimated_credits: 'billing' in quote ? billingCredits(quote.billing) : undefined });
  }
  const totals = new Map<string, Cost>();
  const displayTotals = new Map<string, ReturnType<typeof displayCosts>[number]>();
  const high = new Set<string>();
  for (const step of steps.values()) {
    validateCosts(step.costs);
    const model = modelDisplay(step.kind, step.params, step.model_name);
    if (model.high_price && model.name) high.add(model.name);
    for (const cost of step.costs) {
      const key = `${cost.resource}:${cost.resource_scope ?? ''}`;
      const amount = addAmount(totals.get(key)?.amount ?? 0, cost.amount);
      if (!Number.isFinite(amount)) throw new TopMediaiError('PRICE_UNAVAILABLE', 'The flow estimate exceeds the supported numeric range.');
      totals.set(key, { ...cost, amount });
    }
    // Add each quote's rounded credit estimate, rather than converting summed characters.
    for (const { resource_scope: _scope, ...cost } of displayCosts(step.costs, step.estimated_credits)) {
      const amount = addAmount(displayTotals.get(cost.resource)?.amount ?? 0, cost.amount);
      if (!Number.isFinite(amount)) throw new TopMediaiError('PRICE_UNAVAILABLE', 'The flow estimate exceeds the supported numeric range.');
      displayTotals.set(cost.resource, { ...cost, amount });
    }
  }
  const costs = [...totals.values()];
  const estimatedTotals = [...displayTotals.values()];
  const creditTotals = new Map<string, number>();
  for (const cost of estimatedTotals.filter(cost => cost.unit_type === 'credits')) creditTotals.set(cost.resource, addAmount(creditTotals.get(cost.resource) ?? 0, cost.amount));
  const exceeded = [...creditTotals.values()].some(amount => amount > CONFIRMATION_THRESHOLD);
  // Quote IDs and pending/submitted phase are intentionally excluded: polling, recovery and a
  // renewed quote with unchanged terms must not prompt again. Multiplicity is preserved.
  const terms = [...steps.values()].map(step => canonical({ kind: step.kind, params: step.params, costs: step.costs, estimated_costs: displayCosts(step.costs, step.estimated_credits), model: modelDisplay(step.kind, step.params, step.model_name) }));
  const sorted = (items: unknown[]) => items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const planId = hash({ flow_id: args.flow_id, steps: sorted(terms) });
  const scopeId = hash({ flow_id: args.flow_id, steps: sorted([...steps.values()].map(step => canonical({ kind: step.kind, params: step.params, model: modelDisplay(step.kind, step.params, step.model_name) }))) });
  const approved = args.confirmed_plan_id ? imageState.display_plans?.[args.confirmed_plan_id] : undefined;
  const approvedEstimates = approved ? approved.estimated_costs ?? displayCosts(approved.costs) : [];
  const alreadyConfirmed = !!approved && approved.flow_id === args.flow_id && approved.scope_id === scopeId
    && [...high].every(model => approved.high_price_models.includes(model))
    && costs.filter(cost => cost.resource !== 'video_units').every(cost => approved.costs.some(prior => prior.resource === cost.resource && prior.resource_scope === cost.resource_scope && prior.amount >= cost.amount))
    && estimatedTotals.every(cost => approvedEstimates.some(prior => prior.resource === cost.resource && prior.amount >= cost.amount));
  const reasons = [...(high.size ? ['high_price_model'] : []), ...(exceeded ? ['flow_credits_over_threshold'] : []), ...(args.confirmation_mode === 'always' ? ['user_requested'] : [])];
  const pendingCount = [...steps.values()].filter(step => step.phase === 'pending').length;
  const required = pendingCount > 0 && args.confirmation_mode !== 'off' && reasons.length > 0 && !alreadyConfirmed;
  await context.service.store.transaction(async state => {
    state.display_plans ??= Object.create(null);
    state.display_plans![planId] = { flow_id: args.flow_id, scope_id: scopeId, costs, high_price_models: [...high], estimated_costs: estimatedTotals };
    await context.service.store.save(state);
  });
  return { flow_id: args.flow_id, plan_id: planId, confirmation_mode: args.confirmation_mode, confirmation_required: required,
    already_confirmed: alreadyConfirmed, reasons, high_price_models: [...high], estimated_totals: estimatedTotals,
    estimated_cost_status: [...steps.values()].every(step => costDisplay(step.costs, step.estimated_credits).estimated_cost_status === 'known') ? 'known' : 'unknown',
    step_count: steps.size, pending_steps: pendingCount,
    steps: [...steps.values()].map(step => ({ kind: step.kind, phase: step.phase, model: modelDisplay(step.kind, step.params, step.model_name), ...costDisplay(step.costs, step.estimated_credits) })),
    note: 'Decision support only; this tool does not generate or record human consent. Present content, models, key parameters, quantity, step scope and estimated costs before required confirmation. Show only credit estimates, including the quoted speech credit estimate even when settlement uses characters; music_credits, video_units and billable characters/seconds remain internal for settlement and budgets. An unknown estimated_cost_status means the visible totals are incomplete, never free; do not convert hidden entitlements or invent a credit price. Preserve preferences and confirmed plans in the current conversation only. Quote and budget validation still apply when confirmation is off.' };
}
