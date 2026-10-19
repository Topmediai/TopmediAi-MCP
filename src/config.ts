import { createHash } from 'node:crypto';
import { isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { TopMediaiError, type Mode } from './types.js';
import { readCredential, readCredentialAsync, type Credential } from './credentials.js';
import type { Environment } from './auth-protocol.js';
import { defaultUploadPublicOrigin } from './upload-config.js';
import { DEFAULT_ENVIRONMENT, PRODUCTION_DEFAULTS } from './environment.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export interface Config {
  mode: Mode;
  environment: Environment;
  token: string;
  memberHost: string;
  imageHost: string;
  source: number;
  dataDir: string;
  timeoutMs: number;
  gatewayHost?: string;
  credentialSource?: 'environment' | 'local-file' | 'none';
  uploadHost?: string;
  uploadRoot?: string;
  uploadPublicOrigin?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  musicHost?: string;
  ttsHost?: string;
  audioTimeoutMs?: number;
}
function host(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TopMediaiError('INVALID_CONFIG', 'Backend hosts must be valid origins.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TopMediaiError('INVALID_CONFIG', 'Backend hosts must be HTTPS origins.');
  }
  return url.origin;
}

function productionOrigin(origin: string, key: string): string {
  const labels = new URL(origin).hostname.toLowerCase().replace(/\.$/, '').split('.');
  const privateOrigin = labels.some((_, index) => createHash('sha256').update(labels.slice(index).join('.')).digest('hex') === 'b3d4607e5b476bdbb19278bda5f19125f214af97496f216dadcc45c9e4b33d49');
  if (privateOrigin || !origin.startsWith('https://')) {
    throw new TopMediaiError('INVALID_CONFIG', `${key} must use an approved production HTTPS origin.`);
  }
  return origin;
}
function directHost(env: NodeJS.ProcessEnv, key: keyof typeof PRODUCTION_DEFAULTS): string {
  const value = (env[key] ?? PRODUCTION_DEFAULTS[key]).trim();
  if (!value) {
    throw new TopMediaiError('INVALID_CONFIG', `${key} must not be empty when overriding production defaults.`);
  }
  const origin = host(value);
  return productionOrigin(origin, key);
}

/** Shared by capability status and request guards; legacy gateways expose fewer contracts. */
export function usesDirectApis(config: { environment: string; gatewayHost?: string }): boolean {
  return config.environment === 'production' && !config.gatewayHost;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, credentialLoader = readCredential): Config {
  const mode = env.TOPMEDIAI_MODE ?? 'live';
  if (mode !== 'live') throw new TopMediaiError('INVALID_CONFIG', 'Only real API calls are supported. Remove old TOPMEDIAI_MODE overrides or set live.');
  const environment = env.TOPMEDIAI_ENV ?? DEFAULT_ENVIRONMENT;
  if (environment !== 'production') throw new TopMediaiError('INVALID_CONFIG', 'This release supports TOPMEDIAI_ENV=production only.');
  const explicitToken = env.TOPMEDIAI_TOKEN?.trim() ?? '';
  const credential = explicitToken ? null : credentialLoader(environment);
  const token = explicitToken || credential?.token || '';
  if (token && !/^[A-Za-z0-9]{42}$/.test(token)) {
    throw new TopMediaiError('INVALID_CONFIG', 'The membership backend requires a 42-character account token.');
  }
  // A production gateway is an explicit compatibility choice, never a direct-API default.
  const gatewayValue = env.TOPMEDIAI_PRODUCTION_GATEWAY_HOST?.trim();
  const gatewayHost = gatewayValue ? productionOrigin(host(gatewayValue), 'TOPMEDIAI_PRODUCTION_GATEWAY_HOST') : undefined;
  const memberHost = gatewayHost ?? directHost(env, 'TOPMEDIAI_MEMBER_HOST');
  const imageHost = gatewayHost ?? directHost(env, 'TOPMEDIAI_IMAGE_HOST');
  const source = Number(env.TOPMEDIAI_SOURCE ?? 4);
  if (![1, 2, 3, 4].includes(source)) throw new TopMediaiError('INVALID_CONFIG', 'TOPMEDIAI_SOURCE must be an existing backend channel (1–4).');
  const uploadHost = !gatewayHost ? directHost(env, 'TOPMEDIAI_UPLOAD_HOST') : undefined;
  const uploadPublicOrigin = host(env.TOPMEDIAI_UPLOAD_PUBLIC_ORIGIN || defaultUploadPublicOrigin(environment));
  if (!uploadPublicOrigin.startsWith('https://')) throw new TopMediaiError('INVALID_CONFIG', 'Uploaded image URLs must use an approved HTTPS origin.');
  productionOrigin(uploadPublicOrigin, 'TOPMEDIAI_UPLOAD_PUBLIC_ORIGIN');
  const uploadRootValue = env.TOPMEDIAI_UPLOAD_ROOT?.trim();
  if (uploadRootValue && (!isAbsolute(uploadRootValue) || resolve(uploadRootValue) === parse(resolve(uploadRootValue)).root || uploadRootValue.startsWith('\\\\'))) {
    throw new TopMediaiError('INVALID_CONFIG', 'Configure a dedicated absolute local image upload directory, not a drive root or network share.');
  }
  const uploadRoot = uploadRootValue ? resolve(uploadRootValue) : undefined;
  const ffmpegPath = env.TOPMEDIAI_FFMPEG_PATH?.trim() || 'ffmpeg';
  const ffprobePath = env.TOPMEDIAI_FFPROBE_PATH?.trim() || 'ffprobe';
  for (const executable of [ffmpegPath, ffprobePath]) if (executable.length > 4096 || /[\0\r\n]/.test(executable)) throw new TopMediaiError('INVALID_CONFIG', 'Configure a local FFmpeg/FFprobe executable.');
  const identity = createHash('sha256').update([environment, mode, token, memberHost, imageHost, source].join('\n')).digest('hex').slice(0, 24);
  const musicHost = !gatewayHost ? directHost(env, 'TOPMEDIAI_MUSIC_HOST') : undefined;
  const ttsHost = !gatewayHost ? directHost(env, 'TOPMEDIAI_TTS_HOST') : undefined;
  const audioTimeoutMs = Number(env.TOPMEDIAI_AUDIO_TIMEOUT_MS || 300000);
  if (!Number.isInteger(audioTimeoutMs) || audioTimeoutMs < 1000 || audioTimeoutMs > 300000) throw new TopMediaiError('INVALID_CONFIG', 'Audio timeout must be between 1000 and 300000 milliseconds.');
  return {
    mode, environment, token, memberHost, imageHost, source, gatewayHost,
    uploadHost, uploadRoot, uploadPublicOrigin, ffmpegPath, ffprobePath,
    musicHost, ttsHost, audioTimeoutMs,
    credentialSource: explicitToken ? 'environment' : credential ? 'local-file' : 'none',
    dataDir: resolve(env.TOPMEDIAI_DATA_DIR ?? resolve(ROOT, '.data'), `${environment}-${identity}`),
    timeoutMs: 60_000,
  };
}

/** Public settings stay fixed for this process; only private credentials refresh. */
export function createRuntimeConfigLoader(env: NodeJS.ProcessEnv = process.env, credentialLoader = readCredential): () => Config {
  const launchEnvironment = Object.freeze({ ...env });
  return () => loadConfig(launchEnvironment, credentialLoader);
}

export type RuntimeConfigLoader = () => Config | Promise<Config>;
export function createAsyncRuntimeConfigLoader(env: NodeJS.ProcessEnv = process.env,
  credentialLoader: (environment: Environment) => Credential | null | Promise<Credential | null> = readCredentialAsync): () => Promise<Config> {
  const launchEnvironment = Object.freeze({ ...env });
  return async () => {
    // Validate public settings before reading private files. Explicit token
    // overrides continue to bypass local credentials exactly as before.
    const base = loadConfig(launchEnvironment, () => null);
    if (base.credentialSource === 'environment') return base;
    const credential = await credentialLoader(base.environment);
    return loadConfig(launchEnvironment, () => credential);
  };
}

export interface AuthConfig {
  environment: Environment;
  webOrigin: string;
  memberOrigin: string;
  /** Only explicit legacy production gateways use the old account path. */
  legacyProductionGateway?: boolean;
}
export function loadAuthConfig(environment: Environment = DEFAULT_ENVIRONMENT, env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const prefix = 'TOPMEDIAI_PRODUCTION';
  if (environment !== 'production') throw new TopMediaiError('INVALID_CONFIG', 'This release supports production only.');
  const webValue = env[`${prefix}_WEB_ORIGIN`] ?? PRODUCTION_DEFAULTS.TOPMEDIAI_PRODUCTION_WEB_ORIGIN;
  const legacyGateway = !!env.TOPMEDIAI_PRODUCTION_GATEWAY_HOST?.trim();
  const memberKey = legacyGateway ? 'TOPMEDIAI_PRODUCTION_GATEWAY_HOST' : 'TOPMEDIAI_MEMBER_HOST';
  const memberValue = env[memberKey] ?? (!legacyGateway ? PRODUCTION_DEFAULTS.TOPMEDIAI_MEMBER_HOST : undefined);
  if (!webValue || !memberValue) throw new TopMediaiError('INVALID_CONFIG', `Configure ${prefix}_WEB_ORIGIN and ${memberKey} with the approved HTTPS origins.`);
  const webOrigin = host(webValue); const memberOrigin = host(memberValue);
  if (!webOrigin.startsWith('https://') || !memberOrigin.startsWith('https://')) throw new TopMediaiError('INVALID_CONFIG', 'Browser login requires approved HTTPS origins.');
  productionOrigin(webOrigin, 'TOPMEDIAI_PRODUCTION_WEB_ORIGIN');
  productionOrigin(memberOrigin, memberKey);
  if (legacyGateway) {
    if (webOrigin !== memberOrigin) throw new TopMediaiError('INVALID_CONFIG', 'The production connection page and its approved gateway must share an origin.');
    return { environment, webOrigin, memberOrigin, legacyProductionGateway: true };
  }
  return { environment, webOrigin, memberOrigin };
}
export function loadLocalEnv(): void {
  const envFile = resolve(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
