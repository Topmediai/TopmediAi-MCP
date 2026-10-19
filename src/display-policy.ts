import { WEB_MODELS, imageModel, videoModel } from './catalog/models.js';
import type { Cost, GenerationKind, GenerationTask, Resource } from './generation/types.js';
import { TopMediaiError } from './types.js';

// Product configuration: normalize spacing only for comparison, retain catalog names for display.
export const HIGH_PRICE_MODELS = ['Seedance 2.5', 'MiniMax H3', 'HappyHorse 1.1', 'HappyHorse 1.0'] as const;
export const DISPLAY_RULES_REVISION = '2026-10-19-video-preview';
export const CONFIRMATION_THRESHOLD = 1000;
const resources = new Set<Resource>(['credits', 'music_credits', 'video_units', 'characters', 'seconds', 'uses', 'clone_slots']);
const normalized = (value: string) => value.replace(/\s/g, '').toLowerCase();
export const isHighPriceModel = (name?: string) => !!name && HIGH_PRICE_MODELS.some(model => normalized(model) === normalized(name));

export function validateCosts(costs: Cost[]): void {
  if (!Array.isArray(costs) || !costs.length) throw new TopMediaiError('PRICE_UNAVAILABLE', 'A valid quote is required before any paid submission. Obtain a fresh quote.');
  const seen = new Set<string>();
  for (const cost of costs) {
    if (!cost || !resources.has(cost.resource) || typeof cost.amount !== 'number' || !Number.isFinite(cost.amount) || cost.amount < 0
      || (cost.resource_scope !== undefined && (typeof cost.resource_scope !== 'string' || !cost.resource_scope.trim()))) {
      throw new TopMediaiError('PRICE_UNAVAILABLE', 'A quoted amount or billing unit is unknown or invalid. Obtain a fresh quote; do not submit generation.');
    }
    const key = `${cost.resource}:${cost.resource_scope ?? ''}`;
    if (seen.has(key)) throw new TopMediaiError('PRICE_UNAVAILABLE', 'The quote contains duplicate entitlement costs. Obtain a fresh quote.');
    seen.add(key);
  }
}

export function billingCredits(billing?: object): number | undefined {
  const amount = billing && typeof billing === 'object' && 'credits_required' in billing ? billing.credits_required : undefined;
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

export function displayCosts(costs: Cost[], estimatedCredits?: number) {
  validateCosts(costs);
  const credits = costs.filter(cost => cost.resource === 'credits');
  // Speech quotes calculate a credit estimate even when settlement uses characters.
  // Keep the selected costs intact for budgets; do not infer prices from quantities.
  if (!credits.length && typeof estimatedCredits === 'number' && Number.isFinite(estimatedCredits) && estimatedCredits >= 0) {
    credits.push({ resource: 'credits', amount: estimatedCredits });
  }
  return credits.map(cost => ({ ...cost, label: 'Credits', unit_type: 'credits' as const }));
}

export function costDisplay(costs: Cost[], estimatedCredits?: number) {
  const visible = displayCosts(costs, estimatedCredits);
  return { estimated_costs: visible, estimated_cost_status: visible.length ? 'known' as const : 'unknown' as const };
}

export function modelDisplay(kind: GenerationKind | 'image', params: Record<string, unknown>, suppliedName?: string) {
  const name = suppliedName ?? (kind === 'image' ? imageModel(Number(params.model_type))?.name
    : kind === 'video' ? videoModel(Number(params.model_type))?.name
      : kind === 'music' ? WEB_MODELS.music.find(model => model.mv === params.mv)?.name : undefined);
  return { ...(name ? { name } : {}), status: name ? 'known' as const : 'unknown' as const, high_price: isHighPriceModel(name) };
}

export function quoteDisplay(kind: GenerationKind | 'image', params: Record<string, unknown>, costs: Cost[], suppliedName?: string, estimatedCredits?: number) {
  const model = modelDisplay(kind, params, suppliedName);
  const estimate = costDisplay(costs, estimatedCredits);
  return { model, ...estimate,
    confirmation: { high_price_model: model.high_price,
      exceeds_threshold: estimate.estimated_costs.some(cost => cost.amount > CONFIRMATION_THRESHOLD),
      scope: 'single_step', threshold: CONFIRMATION_THRESHOLD, comparison: 'strictly_greater_than',
      note: 'Review the complete current creative flow before submission; the credit threshold uses universal credits only. Apply the latest explicit preference from this conversation.' },
  };
}

export function taskDisplay(kind: GenerationKind | 'image', params: Record<string, unknown>, costs: Cost[], suppliedName?: string, estimatedCredits?: number) {
  return { model: modelDisplay(kind, params, suppliedName), ...costDisplay(costs, estimatedCredits),
    actual_consumption: { status: 'not_returned' as const, note: 'Display estimated_costs as estimated consumption with its credit type, for example "Estimated consumption: 80 Credits". Do not mention the internal actual_consumption status or label estimates as actual charges.' },
  };
}

export function withTaskDisplay(task: GenerationTask) {
  return { ...task, display: { ...taskDisplay(task.kind, task.params, task.costs, task.model_name, task.estimated_credits),
    ...((task.kind === 'tts' || task.kind === 'sts') && task.voice_name ? { voice: { name: task.voice_name } } : {}) } };
}

export function balanceDisplay(values: { credits?: unknown; music_credits?: unknown }) {
  const value = values.credits;
  return [{
    resource: 'credits' as const, label: 'Credits',
    ...(value === -1 ? { status: 'unlimited' as const } : typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? { status: 'known' as const, amount: value } : { status: 'unknown' as const }),
  }];
}
