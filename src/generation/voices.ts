import { z } from 'zod';
import { usesDirectApis, type Config } from '../config.js';
import { TopMediaiError } from '../types.js';
import { BusinessTransport, record, identity } from '../transport/business.js';
import { assertSpeechContract, speechChannels, speechOperation, speechParameters, stsChannels } from './speech-options.js';
import { resultArtifact } from '../media/result.js';

export const voiceListSchema = z.strictObject({
  operation: speechOperation.default('tts'),
  lang: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/).optional(),
  search_text: z.string().trim().max(100).optional(),
  page: z.number().int().min(1).max(1000).default(1),
  page_size: z.number().int().min(1).max(50).default(20),
});
function text(value: unknown, limit = 1000): string { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function names(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map(item => typeof item === 'string' ? item.slice(0, 100) : (() => { const row = record(item); return { name: text(row.name, 100), display_name: text(row.show_name, 100) }; })());
}
export function publicVoice(value: unknown) {
  const row = record(value);
  const channel = Number(row.channel_id);
  const auditions: { url: string; kind: 'sample'; language?: string; emotion?: string }[] = [];
  const addSample = (value: unknown, language?: string, emotion?: string) => {
    if (auditions.length >= 100) return;
    try { const artifact = resultArtifact(value, 'audio', 'audio/mpeg'); if (artifact?.url) auditions.push({ url: artifact.url, kind: 'sample', ...(language ? { language: text(language, 100) } : {}), ...(emotion ? { emotion: text(emotion, 100) } : {}) }); }
    catch { /* An invalid optional sample must not hide an otherwise usable voice. */ }
  };
  // Verified existing Voice.get_list_v3/get_voice_detail_v3 response fields.
  addSample(row.audition_url);
  if (row.emotion_audition && typeof row.emotion_audition === 'object' && !Array.isArray(row.emotion_audition)) {
    for (const [language, emotions] of Object.entries(row.emotion_audition).slice(0, 100)) {
      if (emotions && typeof emotions === 'object' && !Array.isArray(emotions)) for (const [emotion, url] of Object.entries(emotions).slice(0, 100)) addSample(url, language, emotion);
    }
  }
  const modelName = text(row.voice_model_name, 200) || speechChannels.find(model => model.channel_id === channel)?.name;
  return { voice_id: identity(row.voice_id), voice_name: text(row.voice_name, 200), description: text(row.discription), accent: names(row.accent), emotion: names(row.emotion), style: names(row.style), ...(modelName ? { model_name: modelName } : {}), ...(auditions.length ? { auditions } : {}), ...(Number.isInteger(channel) ? { channel_id: channel, parameters: speechParameters(channel) } : {}), is_vip: row.is_vip === true || row.is_vip === 1, is_free: row.is_free === true || row.is_free === 1 };
}
export async function speechVoice(config: Config, id: string, operation: 'tts' | 'sts', signal?: AbortSignal) {
  assertSpeechContract(config);
  const data = publicVoice(await new BusinessTransport(config, config.ttsHost!, 'token').request('/v3/voice/detail', { form: { voice_id: id, product_id: 1 }, signal }));
  if (data.voice_id !== id || id.length !== 36 || !data.channel_id || (operation === 'sts' && !stsChannels.includes(data.channel_id))) throw new TopMediaiError('VOICE_UNAVAILABLE', 'Select a public voice supported by this operation.');
  return data;
}
export class VoiceCatalog {
  private readonly api: BusinessTransport;
  private readonly listed = new Set<string>();
  constructor(private readonly config: Config) { this.api = new BusinessTransport(config, config.ttsHost ?? config.memberHost, 'token'); }
  private assertContract() { assertSpeechContract(this.config); }
  async list(input: unknown) {
    this.assertContract();
    const parsed = voiceListSchema.safeParse(input); if (!parsed.success) throw new TopMediaiError('INVALID_PARAMS', 'Voice list filters are invalid.');
    const { page, page_size, operation, ...filters } = parsed.data;
    // The legacy all-voices route does not consistently paginate; bound the transport and paginate locally.
    const data = await this.api.request('/v3/voice/list', { form: { ...Object.fromEntries(Object.entries(filters).filter((pair): pair is [string, string] => typeof pair[1] === 'string')), product_id: 1, ...(operation === 'sts' ? { plan_id: '5,8,11' } : {}) } });
    if (!Array.isArray(data)) throw new TopMediaiError('INVALID_RESPONSE', 'Voice catalog must be a list.');
    const rows = data.map(publicVoice).filter(row => row.voice_id.length !== 32 && (operation !== 'sts' || stsChannels.includes(row.channel_id ?? 0)));
    const selected = rows.slice((page - 1) * page_size, page * page_size);
    for (const row of selected) this.listed.add(row.voice_id);
    return { voices: selected, page, page_size, total: rows.length, operation, tts_generation_enabled: usesDirectApis(this.config) && !!this.config.ttsHost, note: 'Catalog metadata does not establish generation entitlement. Obtain an exact speech quote before generating.' };
  }
  async detail(id: string) {
    this.assertContract();
    if (!this.listed.has(id)) throw new TopMediaiError('VOICE_NOT_LISTED', 'Select a public voice returned by list_voices in this session first.');
    const data = publicVoice(await this.api.request('/v3/voice/detail', { form: { voice_id: id, product_id: 1 } }));
    if (data.voice_id !== id) throw new TopMediaiError('INVALID_RESPONSE', 'Voice detail does not match the selected voice.');
    return data;
  }
}
