import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadAuthConfig, loadConfig } from '../src/config.js';
import type { Environment } from '../src/auth-protocol.js';
import { TopMediaiError } from '../src/types.js';
import { DEFAULT_ENVIRONMENT, parseEnvironmentArguments } from '../src/environment.js';

export const parsePluginEnvironment = parseEnvironmentArguments;

export function pluginConfiguration(environment: Environment = DEFAULT_ENVIRONMENT, env: NodeJS.ProcessEnv = process.env) {
  if (environment !== 'production') throw new TopMediaiError('INVALID_CONFIG', 'This release supports production only.');
  // Ignore real credentials while validating and freezing the selected public configuration.
  const config = loadConfig({ ...env, TOPMEDIAI_MODE: 'live', TOPMEDIAI_ENV: environment, TOPMEDIAI_TOKEN: '' }, () => null);
  const configEnv: Record<string, string> = {
    TOPMEDIAI_MODE: 'live', TOPMEDIAI_ENV: environment,
    TOPMEDIAI_TOKEN: '', TOPMEDIAI_GATEWAY_HOST: '',
    TOPMEDIAI_SOURCE: String(config.source),
    MCP_CLIENT_SOURCE: config.clientSource === undefined ? '' : String(config.clientSource),
    TOPMEDIAI_MEMBER_HOST: config.memberHost, TOPMEDIAI_IMAGE_HOST: config.imageHost,
    TOPMEDIAI_FFMPEG_PATH: config.ffmpegPath!, TOPMEDIAI_FFPROBE_PATH: config.ffprobePath!,
    TOPMEDIAI_UPLOAD_ROOT: config.uploadRoot ?? '',
    TOPMEDIAI_UPLOAD_HOST: config.uploadHost ?? '',
    TOPMEDIAI_UPLOAD_PUBLIC_ORIGIN: config.uploadPublicOrigin!,
    TOPMEDIAI_MUSIC_HOST: config.musicHost ?? '', TOPMEDIAI_TTS_HOST: config.ttsHost ?? '',
    TOPMEDIAI_AUDIO_TIMEOUT_MS: String(config.audioTimeoutMs),
  };
  configEnv.TOPMEDIAI_PRODUCTION_GATEWAY_HOST = config.gatewayHost ?? '';
  if (!config.gatewayHost || env.TOPMEDIAI_PRODUCTION_WEB_ORIGIN) {
    configEnv.TOPMEDIAI_PRODUCTION_WEB_ORIGIN = loadAuthConfig('production', env).webOrigin;
  }
  // Empty overrides prevent a host process or old .env from selecting stale credentials/gateways.
  // Never serialize token values, Cookie or private credential files.
  return { mcpServers: { topmediai: {
    command: process.execPath, args: [resolve(ROOT, 'dist/src/index.js')],
    env: configEnv,
  } } };
}

export async function setupPlugin(environment: Environment = DEFAULT_ENVIRONMENT, env: NodeJS.ProcessEnv = process.env) {
  const config = pluginConfiguration(environment, env); // Validate before touching the generated file.
  await mkdir(resolve(ROOT, 'plugin'), { recursive: true });
  await writeFile(resolve(ROOT, 'plugin/.mcp.json'), JSON.stringify(config, null, 2) + '\n');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const environment = parsePluginEnvironment(process.argv.slice(2));
    await setupPlugin(environment);
    console.log(`Prepared ${environment} plugin configuration without credentials.`);
  } catch (error) {
    console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'SETUP_FAILED: Plugin configuration could not be written.');
    process.exitCode = 1;
  }
}
