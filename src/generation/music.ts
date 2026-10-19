import { z } from 'zod';
import { usesDirectApis, type Config } from '../config.js';
import { TopMediaiError } from '../types.js';
import { BusinessTransport, record, numeric, identity } from '../transport/business.js';
import { resultArtifact } from '../media/result.js';
import { musicResultArtifact } from '../media/music-result.js';
import type { Adapter, GenerationTask, Outcome, GenerationStatus, Artifact } from './types.js';
import { WEB_MODELS } from '../catalog/models.js';

export const musicSchema = z.strictObject({
  action: z.enum(['auto', 'custom']).default('auto'),
  mv: z.enum(['v6-pro', 'v6-wild-pro', 'v6-mini']).describe('Current Web music model ID from list_music_models.'),
  style: z.string().trim().min(1).max(980),
  lyrics: z.string().max(5000).default(''),
  title: z.string().trim().max(80).default(''),
  instrumental: z.boolean().default(false),
}).superRefine((p, ctx) => {
  if (p.action === 'custom' && !p.instrumental && !p.lyrics.trim()) ctx.addIssue({ code: 'custom', path: ['lyrics'], message: 'Custom vocal music requires lyrics.' });
  if (p.instrumental && p.lyrics.trim()) ctx.addIssue({ code: 'custom', path: ['lyrics'], message: 'Instrumental music must omit lyrics.' });
});
function status(value: unknown): GenerationStatus {
  if (!['number', 'string'].includes(typeof value) || value === '') return 'unknown';
  return ({ 0: 'completed', 2: 'running', 3: 'failed', 4: 'queued' } as Record<number, GenerationStatus>)[Number(value)] ?? 'unknown';
}
export function aggregate(statuses: GenerationStatus[]): GenerationStatus {
  if (!statuses.length) return 'unknown';
  if (statuses.every(s => s === 'completed')) return 'completed';
  if (statuses.every(s => s === 'failed')) return 'failed';
  if (statuses.includes('completed')) return 'partially_completed';
  if (statuses.includes('unknown')) return 'unknown';
  return statuses.includes('running') ? 'running' : statuses.includes('queued') ? 'queued' : 'unknown';
}
export class MusicAdapter implements Adapter {
  readonly kind = 'music';
  private readonly api: BusinessTransport;
  constructor(private readonly config: Config) { this.api = new BusinessTransport(config, config.musicHost ?? config.memberHost, 'bearer'); }
  enabled() { return usesDirectApis(this.config) && !!this.config.musicHost; }
  reason() { return this.enabled() ? undefined : 'Music generation requires a configured direct music backend; legacy gateways do not expose music routes.'; }
  validate(input: unknown) { const result = musicSchema.safeParse(input); if (!result.success) throw new TopMediaiError('INVALID_PARAMS', result.error.issues.map(i => i.message).join(' ')); return result.data; }
  async models() {
    this.assertContract();
    let map: Record<string, unknown> = {}, priceVersion: string | undefined, priceError: string | undefined;
    try {
      const data = record(await this.api.request('/v2/music/generation-prices'));
      if (!Array.isArray(data.price_versions)) throw new TopMediaiError('INVALID_RESPONSE', 'Music price versions are missing.');
      const current = data.price_versions.map(record).find(v => String(v.price_version) === String(data.current_price_version));
      if (!current) throw new TopMediaiError('PRICE_UNAVAILABLE', 'The active music price version is missing.');
      map = record(record(current.new_pricing_rules).model_unit_credits); priceVersion = String(data.current_price_version);
    } catch (error) { priceError = error instanceof TopMediaiError ? error.code : 'PRICE_UNAVAILABLE'; }
    return { price_version: priceVersion, default_mv: WEB_MODELS.defaults.music, source_revision: WEB_MODELS.source_revision,
      models: WEB_MODELS.music.map(model => {
        const value = map[model.mv] ?? map.default;
        let base: number | undefined;
        try { if (value !== undefined) base = numeric(value); } catch { /* Unknown prices stay unknown, never zero. */ }
        return { ...model, model_name: model.name, actions: ['auto', 'custom'], instrumental: true,
          ...(base !== undefined ? { pricing: [{ resource: 'credits', amount: base, billing_basis: 'per_song_base', starting_price: true, quantity: 1,
            conditions: 'Base price for one song; excludes action, persona, duration and media surcharges. Use the exact generation quote for the total.' }] } : {}),
          pricing_status: priceError ?? (base === undefined ? 'not_configured' : Object.hasOwn(map, model.mv) ? 'configured' : 'default_rule') };
      }),
      note: 'The complete current Web music catalog is shown independently of price configuration. Use an exact quote; default rules do not prove generation availability.' };
  }
  async entitlements() {
    this.assertContract();
    const data = record(await this.api.request('/v2/user/right')), rights = record(data.result), all = record(rights.tp_all);
    return { music_credits: numeric(rights.left, -1), credits: numeric(all.left, -1) };
  }
  async estimate(params: Record<string, unknown>) {
    this.assertContract();
    const query = new URLSearchParams({ action: String(params.action), mv: String(params.mv), has_persona: '0' });
    const data = record(await this.api.request(`/v2/music/generation-price?${query}`));
    if (!['string', 'number'].includes(typeof data.price_version)) throw new TopMediaiError('PRICE_UNAVAILABLE', 'Music price version is missing.');
    const costs = [{ resource: 'music_credits' as const, amount: numeric(data.legacy_credits_cost) }, { resource: 'credits' as const, amount: numeric(data.new_credits_cost) }];
    // Each cost is already the backend total for all songs, not a unit price.
    return { costs, price_version: String(data.price_version), pricing: { costs, price_version: data.price_version, scheme: data.scheme } };
  }
  async create(params: Record<string, unknown>): Promise<Outcome> {
    this.assertContract();
    const data = record(await this.api.request('/v2/async/text-to-song', { body: { ...params, instrumental: params.instrumental ? 1 : 0, is_public: 0, style_optimization: 0 } }));
    if (!Array.isArray(data.song_ids) || !data.song_ids.length || data.song_ids.length > 10) throw new TopMediaiError('INVALID_RESPONSE', 'Music generation did not return bounded song IDs.');
    const ids = data.song_ids.map(identity);
    if (new Set(ids).size !== ids.length) throw new TopMediaiError('INVALID_RESPONSE', 'Music generation returned duplicate IDs.');
    return { status: 'queued', remote: { song_ids: ids }, artifacts: [], children: ids.map(id => ({ id, status: 'queued', artifacts: [] })) };
  }
  async poll(task: GenerationTask): Promise<Outcome> {
    this.assertContract();
    const ids = task.remote.song_ids;
    if (!Array.isArray(ids) || !ids.length) throw new TopMediaiError('INVALID_RESPONSE', 'Saved music identities are missing.');
    const data = record(await this.api.request(`/v2/task/results?${new URLSearchParams({ ids: ids.map(identity).join(',') })}`));
    if (!Array.isArray(data.result) || data.result.length > ids.length) throw new TopMediaiError('INVALID_RESPONSE', 'Music task results are invalid.');
    const rows = data.result.map(record), seen = new Set<string>();
    for (const row of rows) { const id = identity(row.id); if (!ids.includes(id) || seen.has(id)) throw new TopMediaiError('INVALID_RESPONSE', 'Music results contain an unrelated or duplicate song.'); seen.add(id); }
    const children = ids.map(id => {
      const row = rows.find(row => String(row.id) === id);
      if (!row) return { id, status: 'unknown' as const, artifacts: [] };
      const artifacts = [musicResultArtifact(row.audio_url), resultArtifact(row.cover_url, 'image', 'image/jpeg'), resultArtifact(row.lrc_url, 'subtitle', 'text/plain')].filter((a): a is Artifact => !!a);
      return { id, status: status(row.status), artifacts };
    });
    return { status: aggregate(children.map(c => c.status)), remote: task.remote, children, artifacts: children.flatMap(c => c.artifacts) };
  }
  private assertContract() { if (!this.enabled()) throw new TopMediaiError('CAPABILITY_UNAVAILABLE', this.reason()!); }
}
