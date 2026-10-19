import { loadLocalEnv } from '../src/config.js';
import { acquireLoginLock, deleteCredential } from '../src/credentials.js';
import { TopMediaiError } from '../src/types.js';
import { parseEnvironmentArguments } from '../src/environment.js';

try {
  const environment = parseEnvironmentArguments(process.argv.slice(2));
  loadLocalEnv(); const release = acquireLoginLock(environment);
  try { deleteCredential(environment); } finally { release(); }
  console.log(`Removed the saved ${environment} credential. The standard MCP entry point observes logout on its next tool call; no Codex or MCP restart is required. Already running requests can finish with their original credential. Website login is unchanged.`);
  if (process.env.TOPMEDIAI_TOKEN?.trim()) console.error('TOPMEDIAI_TOKEN is still configured and overrides local logout. Remove it to stop using that credential.');
} catch (error) { console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'LOGOUT_FAILED: The local credential could not be removed.'); process.exitCode = 1; }
