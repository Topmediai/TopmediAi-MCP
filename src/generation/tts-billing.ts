import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { TopMediaiError } from '../types.js';
import { BusinessTransport, numeric, record } from '../transport/business.js';
import type { Estimate } from './types.js';
import { html5Entities, invalidCharacterReferences } from './tts-entities.js';

// Mirrors TTSService.text_all_count/countSsmlText/skip_special_char and
// helper.functions.optimize_newlines. Python counts Unicode code points.
const length = (text: string) => Array.from(text).length;
const whitespace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
const punctuation = new Set(Array.from('。？！，、；：“”‘’（）【】.?!,;:\"\'()[]'));
function unescapeHtml(text: string) {
  return text.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (_, name: string) => {
    if (name.startsWith('#')) {
      const hex = /^#x/i.test(name), value = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Object.hasOwn(invalidCharacterReferences, value)) return invalidCharacterReferences[value]!;
      if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) return '\ufffd';
      if ((value >= 1 && value <= 8) || value === 11 || (value >= 14 && value <= 31) ||
          (value >= 127 && value <= 159) || (value >= 0xfdd0 && value <= 0xfdef) ||
          (value & 0xffff) === 0xfffe || (value & 0xffff) === 0xffff) return '';
      return String.fromCodePoint(value);
    }
    for (let end = name.length; end > 1; end--) {
      const key = name.slice(0, end);
      if (Object.hasOwn(html5Entities, key)) return html5Entities[key]! + name.slice(end);
    }
    return '&' + name;
  });
}
export function countTtsText(input: string, channel: number, multiplier: number) {
  let text = input;
  for (const newline of ['\r\n', '\r', '\n']) while (text.includes(newline + newline)) text = text.replaceAll(newline + newline, newline);
  text = text.replace(/^(?:\r\n|\r|\n)+|(?:\r\n|\r|\n)+$/g, '');
  const original = text;
  text = text.replace(/\r\n|\r|\n/g, (newline, index: number) => punctuation.has(original[index - 1]!) ? '\r\n' : punctuation.has(original[index + newline.length]!) ? '' : '。');
  text = unescapeHtml(text.replace(whitespace, ' ').replace(/[\u200b-\u200d\ufeff]/g, ''));
  let inputCharacters: number, ssmlCharacters = 0;
  if ([3, 4, 5, 8, 11, 12, 13, 14].includes(channel)) {
    text = text.replace(/<speak>|<\/speak>|<voice>|<\/voice>/g, '');
    const breaks = (text.match(/<break time="[^\n]*?" \/>/g) ?? []).length;
    text = text.replace(/<break time="[^\n]*?" \/>|<\/break>/g, '');
    const tags = (text.match(/<[^>]+>/g) ?? []).length;
    ssmlCharacters = (breaks + tags) * 2;
    const raw = text.replace(/<[^>]+>/g, '').replace(/\r|\n/g, ' ').replace(whitespace, ' ');
    inputCharacters = length(raw) + ssmlCharacters;
  } else inputCharacters = length(text); // PlayHT counts the literal markup.
  const characters = (inputCharacters - ssmlCharacters) * multiplier + ssmlCharacters;
  if (!Number.isSafeInteger(characters) || characters < 0) throw new TopMediaiError('INVALID_RESPONSE', 'The TTS character calculation is outside its supported range.');
  return { input_characters: inputCharacters, ssml_characters: ssmlCharacters, characters_required: characters, credits_required: Math.ceil(characters / 200) };
}
function flag(value: unknown): boolean {
  if (![true, false, 0, 1].includes(value as boolean)) throw new TopMediaiError('INVALID_RESPONSE', 'Speech membership permission is missing or invalid.');
  return value === true || value === 1;
}
export function speechEntitlements(value: unknown) {
  const data = record(value), tts = record(data.tts), credits = record(data.tp_all), clone = record(data.clone);
  const vip = [tts, credits, clone].map(row => flag(row.is_vip)).some(Boolean);
  return { characters: { left: numeric(tts.left, -Number.MAX_SAFE_INTEGER) }, credits: { left: numeric(credits.left, -Number.MAX_SAFE_INTEGER) }, can_generate: vip };
}
export async function estimateLocalTts(config: Config, params: Record<string, unknown>, channel: number, signal?: AbortSignal): Promise<Estimate> {
  const api = new BusinessTransport(config, config.ttsHost!, 'token');
  const [accountValue, skuValue, entitlementValue] = await Promise.all([
    api.request('/v2/user/info', { signal }),
    api.request(`/v2/user/voice_sku?${new URLSearchParams({ speaker: String(params.voice_id) })}`, { signal }),
    new BusinessTransport(config, config.memberHost, 'token').request('/user/permission/info?product_name=tts&product_type=1', { signal }),
  ]);
  const account = record(accountValue), sku = record(skuValue), entitlements = speechEntitlements(entitlementValue);
  if (!entitlements.can_generate) throw new TopMediaiError('ENTITLEMENT_REQUIRED', 'Complete TTS generation requires TTS, clone or universal membership permission.');
  const multiplier = [5, 8, 9, 13, 14].includes(channel) ? numeric(account.pro_times, 1) : channel === 11 ? numeric(account.gen_pro_times, 1) : channel === 12 ? 2 : 1;
  if (!Number.isSafeInteger(multiplier)) throw new TopMediaiError('INVALID_RESPONSE', 'The account TTS multiplier is invalid.');
  const counts = countTtsText(String(params.text), channel, multiplier);
  const limit = channel === 3 ? 500 : channel === 13 ? 1000 : [5, 8, 9].includes(channel) ? 20000 : 4000;
  if (counts.characters_required === 0 || counts.input_characters > limit) throw new TopMediaiError('INVALID_PARAMS', 'Text is empty after normalization or exceeds this voice’s input limit.');
  const voiceSku = flag(sku.check), characterLeft = voiceSku ? numeric(sku.left, -Number.MAX_SAFE_INTEGER) : entitlements.characters.left;
  const resource = voiceSku || characterLeft >= counts.characters_required ? 'characters' : 'credits';
  const amount = resource === 'characters' ? counts.characters_required : counts.credits_required;
  const scope = voiceSku ? `voice:${params.voice_id}` : `account:${resource}`;
  const pricing = { source: 'local_backend_rules', rules_version: 'tts-local-v1', channel_id: channel, multiplier, ...counts, max_input_characters: limit,
    unit: resource, amount, resource_scope: scope, equity_type: resource === 'characters' ? '1' : '42' };
  return { costs: [{ resource, amount, resource_scope: scope }], cost_mode: 'selected_entitlement', sufficient: (resource === 'characters' ? characterLeft : entitlements.credits.left) >= amount,
    price_version: 'tts-local-v1-' + createHash('sha256').update(JSON.stringify(pricing)).digest('hex').slice(0, 20), pricing };
}
