import type { Environment } from './auth-protocol.js';
import { TopMediaiError } from './types.js';

export const DEFAULT_ENVIRONMENT: Environment = 'production';

/** Public release endpoints; account credentials are always supplied by browser login. */
export const PRODUCTION_DEFAULTS = Object.freeze({
  TOPMEDIAI_PRODUCTION_WEB_ORIGIN: 'https://www.topmediai.com',
  TOPMEDIAI_MEMBER_HOST: 'https://topmediai-member-api.imyfone.com',
  TOPMEDIAI_IMAGE_HOST: 'https://ai-api.imyfone.com',
  TOPMEDIAI_MUSIC_HOST: 'https://aimusic-api.topmediai.com',
  TOPMEDIAI_TTS_HOST: 'https://tts-api.imyfone.com',
  TOPMEDIAI_UPLOAD_HOST: 'https://tts-api.imyfone.com',
});

export function parseEnvironmentArguments(args: string[]): Environment {
  if (args.length === 0) return DEFAULT_ENVIRONMENT;
  const value = args.length === 2 && args[0] === '--env' ? args[1]
    : args.length === 1 && args[0]?.startsWith('--env=') ? args[0].slice(6) : undefined;
  if (value !== 'production') {
    throw new TopMediaiError('INVALID_CONFIG', 'This public release supports production only. Omit --env or use --env production.');
  }
  return value;
}
