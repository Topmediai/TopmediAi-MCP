import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Environment } from '../src/auth-protocol.js';
import { ROOT } from '../src/config.js';
import { DEFAULT_ENVIRONMENT, parseEnvironmentArguments } from '../src/environment.js';
import { TopMediaiError } from '../src/types.js';
import { pluginConfiguration } from './setup-plugin.js';

/** Use the same frozen public settings and credential refresh as the Codex entry point. */
export function cursorConfiguration(environment: Environment = DEFAULT_ENVIRONMENT, env: NodeJS.ProcessEnv = process.env) {
  const launch = pluginConfiguration(environment, { ...env, MCP_CLIENT_SOURCE: '7' }).mcpServers.topmediai;
  return { mcpServers: { topmediai: { type: 'stdio' as const, ...launch } } };
}

export async function setupCursor(environment: Environment = DEFAULT_ENVIRONMENT, env: NodeJS.ProcessEnv = process.env) {
  const config = cursorConfiguration(environment, env);
  await mkdir(resolve(ROOT, 'plugin'), { recursive: true });
  await writeFile(resolve(ROOT, 'plugin/.cursor-mcp.json'), JSON.stringify(config, null, 2) + '\n');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const environment = parseEnvironmentArguments(process.argv.slice(2));
    await setupCursor(environment);
    console.log(`Prepared ${environment} Cursor plugin configuration without credentials. Local Node and build paths are specific to this machine.`);
  } catch (error) {
    console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'SETUP_FAILED: Cursor configuration could not be written.');
    process.exitCode = 1;
  }
}
