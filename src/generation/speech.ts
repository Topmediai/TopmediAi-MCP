import { createHash } from 'node:crypto';
import { usesDirectApis, type Config } from '../config.js';
import { TopMediaiError } from '../types.js';
import { BusinessTransport, identity, numeric, record } from '../transport/business.js';
import type { Adapter, Estimate, Outcome, GenerationTask } from './types.js';
import { assertSpeechContract, speechChannels, speechParameters, stsChannels, stsSchema, ttsSchema } from './speech-options.js';
import { speechVoice } from './voices.js';
import { SpeechAudioService } from '../media/speech-audio.js';
import { speechResultArtifact } from '../media/speech-result.js';
import { estimateLocalTts, speechEntitlements } from './tts-billing.js';

export class SpeechAdapter implements Adapter {
  readonly execution_mode = 'synchronous' as const;
  private readonly api: BusinessTransport;
  constructor(private readonly config: Config, readonly kind: 'tts' | 'sts') { this.api = new BusinessTransport(config, config.ttsHost ?? config.memberHost, 'token'); }
  enabled() { return usesDirectApis(this.config) && !!this.config.ttsHost; }
  reason() { return this.enabled() ? undefined : 'Speech generation requires a configured direct speech backend; legacy gateways do not expose speech routes.'; }
  validate(input: unknown): Record<string, unknown> {
    const result = (this.kind === 'tts' ? ttsSchema : stsSchema).safeParse(input);
    if (!result.success) throw new TopMediaiError('INVALID_PARAMS', 'Select a public voice and use only the documented speech parameters.');
    return result.data;
  }
  async models() {
    assertSpeechContract(this.config);
    return { execution_mode: this.execution_mode, models: speechChannels.filter(row => this.kind === 'tts' || stsChannels.includes(row.channel_id)).map(row => ({ ...row, parameters: speechParameters(row.channel_id, this.kind), pricing_status: this.config.token ? 'requires_input' : 'LOGIN_REQUIRED' })), voice_selection: 'Select voice_id from list_voices with the matching operation, then get_voice_detail.', generation_enabled: this.enabled(), note: `${this.kind === 'tts' ? 'TTS cost is estimated locally using backend counting rules and current account/voice entitlements.' : 'STS cost uses the backend preview for the selected voice and audio.'} Successful generation returns audio in this tool call; no polling is required.` };
  }
  async entitlements() {
    assertSpeechContract(this.config);
    const data = record(await new BusinessTransport(this.config, this.config.memberHost, 'token').request('/user/permission/info?product_name=tts&product_type=1'));
    return { ...speechEntitlements(data), note: 'TTS estimates check voice-specific characters and account multipliers through existing account APIs. Final settlement is performed by the synthesis backend.' };
  }
  private async form(params: Record<string, unknown>, signal?: AbortSignal) {
    const voice = await speechVoice(this.config, String(params.voice_id), this.kind, signal);
    if (!speechChannels.some(row => row.channel_id === voice.channel_id)) throw new TopMediaiError('VOICE_UNAVAILABLE', 'This voice channel is not supported.');
    const allowed = speechParameters(voice.channel_id!, this.kind);
    for (const key of ['stability', 'similarity', 'exaggeration', 'pitch'] as const) if (params[key] !== undefined && !allowed[key]) throw new TopMediaiError('INVALID_PARAMS', `The selected voice does not support ${key}.`);
    if (this.kind === 'sts') return { voice, form: { file_id: (await new SpeechAudioService(this.config).asset(String(params.speech_asset_id), true, signal)).file_id, ...Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'speech_asset_id')) } as Record<string, string | number> };
    const names = (items: typeof voice.accent) => items.map(item => typeof item === 'string' ? item : item.name);
    if (!names(voice.accent).includes(String(params.accent)) || (params.emotion_name !== 'Default' && !names(voice.emotion).includes(String(params.emotion_name))) || (params.style !== undefined && !names(voice.style).includes(String(params.style)))) throw new TopMediaiError('INVALID_PARAMS', 'Select accent, emotion and style from this voice’s detail.');
    if (voice.channel_id === 13 && (params.speed !== 1 || params.volume !== 50)) throw new TopMediaiError('INVALID_PARAMS', 'This channel uses fixed speech settings.');
    return { voice, form: { ...params, product_id: 1, is_audition: 0, plan_type: 2, eliminate_noise: 0 } as Record<string, string | number> };
  }
  async estimate(params: Record<string, unknown>, signal?: AbortSignal): Promise<Estimate> {
    assertSpeechContract(this.config);
    const { form, voice } = await this.form(params, signal);
    const model_name = voice.model_name ?? speechChannels.find(row => row.channel_id === voice.channel_id)?.name;
    if (this.kind === 'tts') return { ...await estimateLocalTts(this.config, params, voice.channel_id!, signal), model_name };
    const path = `/sts/consume_preview?${new URLSearchParams({ file_id: String(form.file_id), voice_id: String(form.voice_id) })}`;
    const [preview, skuValue] = await Promise.all([
      this.api.request(path, { timeoutMs: this.config.audioTimeoutMs ?? 300000, signal, speech: true }),
      this.api.request(`/v2/user/voice_sku?${new URLSearchParams({ speaker: String(params.voice_id) })}`, { signal }),
    ]);
    const data = record(preview), sku = record(skuValue);
    if (!['characters', 'credits'].includes(String(data.billing_unit)) || typeof data.sufficient !== 'boolean') throw new TopMediaiError('INVALID_RESPONSE', 'An authoritative speech billing unit and sufficiency decision are required.');
    const amount = numeric(data.amount);
    const resource = data.billing_unit as 'characters' | 'credits';
    if (![true, false, 0, 1].includes(sku.check as boolean)) throw new TopMediaiError('INVALID_RESPONSE', 'The voice entitlement decision is invalid.');
    const voiceSku = sku.check === true || sku.check === 1;
    if (voiceSku && resource !== 'characters') throw new TopMediaiError('INVALID_RESPONSE', 'Speech billing does not match the voice-specific character entitlement.');
    const scope = voiceSku ? `voice:${params.voice_id}` : `account:${resource}`;
    const characters = numeric(data.characters_required), credits = numeric(data.credits_required);
    const seconds = numeric(data.billable_seconds, 1);
    if (!Number.isSafeInteger(seconds) || seconds > 300 || characters !== seconds * 400 || credits !== seconds * 2 || amount !== (resource === 'characters' ? characters : credits) || identity(data.equity_type) !== (resource === 'characters' ? '1' : '42')) throw new TopMediaiError('INVALID_RESPONSE', 'Speech cost does not match the selected entitlement and billable seconds.');
    const asset = await new SpeechAudioService(this.config).asset(String(params.speech_asset_id), false, signal);
    const pricing = { source: 'existing_backend_preview', unit: resource, amount, resource_scope: scope, equity_type: identity(data.equity_type), characters_required: characters,
      credits_required: credits, billable_seconds: seconds, asset_sha256: asset.sha256, asset_url_sha256: createHash('sha256').update(asset.url).digest('hex'), file_id: asset.file_id, duration_seconds: asset.duration_seconds };
    return { model_name, costs: [{ resource, amount, resource_scope: scope }], cost_mode: 'selected_entitlement', sufficient: data.sufficient,
      price_version: 'sts-existing-v1-' + createHash('sha256').update(JSON.stringify(pricing)).digest('hex').slice(0, 20), expires_at: asset.expires_at, pricing };
  }
  async create(params: Record<string, unknown>, _images?: unknown, _media?: unknown, signal?: AbortSignal): Promise<Outcome> {
    const { form, voice } = await this.form(params, signal);
    const data = record(await this.api.request(this.kind === 'tts' ? '/v5/voice/tts' : '/s2s', { form, timeoutMs: this.config.audioTimeoutMs ?? 300000, signal, speech: true }));
    const remote: Record<string, string> = this.kind === 'tts' ? { task_id: identity(data.id), record_type: 'conversion' } : { uuid: identity(data.uuid), file_id: identity(data.file_id) };
    if (this.kind === 'tts' && numeric(data.status) !== 1) throw new TopMediaiError('INVALID_RESPONSE', 'Synchronous TTS did not confirm a completed conversion. Do not submit again.');
    if (this.kind === 'sts' && data.file_id !== form.file_id) throw new TopMediaiError('INVALID_RESPONSE', 'Speech result does not match the submitted asset.');
    try {
      const artifact = speechResultArtifact(data.oss_url);
      return { status: 'completed', remote, artifacts: artifact ? [artifact] : [], ...(voice.voice_name ? { voice_name: voice.voice_name } : {}),
        ...(!artifact?.url ? { delivery_error: 'Speech completed, but a playable audio URL is unavailable. Do not generate again.' } : {}) };
    } catch { return { status: 'completed', remote, artifacts: [], ...(voice.voice_name ? { voice_name: voice.voice_name } : {}), delivery_error: 'Speech completed, but the media address is invalid. Do not generate again.' }; }
  }
  // Required by the legacy adapter interface; synchronous task reads never call it.
  async poll(task: GenerationTask): Promise<Outcome> { return task; }
}
