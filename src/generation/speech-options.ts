import { z } from 'zod';
import { usesDirectApis } from '../config.js';
import { TopMediaiError } from '../types.js';

export const speechOperation = z.enum(['tts', 'sts']);
const voiceId = z.string().regex(/^[A-Za-z0-9_-]{36}$/).describe('A public voice ID returned by the speech catalog.');
const percent = z.number().int().min(0).max(100);
const tuning = { stability: percent.optional(), similarity: percent.optional(), exaggeration: percent.optional() };
export const ttsSchema = z.strictObject({
  text: z.string().min(1).max(100000).refine(value => Array.from(value).length <= 20000 && value.trim().length > 0, 'Text must contain 1–20000 Unicode characters.'),
  voice_id: voiceId, accent: z.string().trim().min(1).max(100),
  emotion_name: z.string().trim().min(1).max(100).default('Default'),
  speed: z.number().min(0.1).max(2).default(1), volume: percent.default(50),
  pitch: z.number().int().min(1).max(5).optional(), style: z.string().min(1).max(100).optional(),
  article_title: z.string().trim().max(100).default('Speech'), ...tuning,
});
export const stsSchema = z.strictObject({ speech_asset_id: z.string().uuid(), voice_id: voiceId, ...tuning });
export const speechChannels = [
  { channel_id: 3, name: 'Google', text_limit: 500 },
  { channel_id: 4, name: 'Microsoft' },
  { channel_id: 5, name: 'ElevenLabs Gen' },
  { channel_id: 8, name: 'ElevenLabs Des' },
  { channel_id: 9, name: 'PlayHT' },
  { channel_id: 11, name: 'ElevenLabs Gen+' },
  { channel_id: 13, name: 'CosyVoice', text_limit: 1000 },
  { channel_id: 14, name: 'MiniMax' },
] as const;
export const stsChannels = [5, 8, 11];
export function speechParameters(channel: number, operation: 'tts' | 'sts' = 'tts') {
  return {
    ...(operation === 'tts' ? { speed: { min: 0.1, max: 2, default: 1, adjustable: channel !== 13 }, volume: { min: 0, max: 100, default: 50, adjustable: channel !== 13 }, pitch: [3, 4].includes(channel) ? [1, 2, 3, 4, 5] : undefined } : {}),
    stability: [4, ...stsChannels].includes(channel) ? { min: 0, max: 100 } : undefined,
    similarity: stsChannels.includes(channel) ? { min: 0, max: 100 } : undefined,
    exaggeration: stsChannels.includes(channel) ? { min: 0, max: 100 } : undefined,
  };
}
export function assertSpeechContract(config: { environment: string; ttsHost?: string; gatewayHost?: string }) {
  if (!usesDirectApis(config) || !config.ttsHost) throw new TopMediaiError('CAPABILITY_UNAVAILABLE', 'Speech routes require a configured direct speech backend.');
}
