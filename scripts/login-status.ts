import { loadLocalEnv } from '../src/config.js';
import { readCredential } from '../src/credentials.js';
import { TopMediaiError } from '../src/types.js';
import { parseEnvironmentArguments } from '../src/environment.js';

try {
  const environment = parseEnvironmentArguments(process.argv.slice(2));
  loadLocalEnv(); const credential = readCredential(environment);
  console.log(credential ? `A credential is saved for ${environment}. Token validity is checked by the service, not this offline status.` : `No saved ${environment} credential.`);
  if (process.env.TOPMEDIAI_TOKEN?.trim()) console.error('An environment token override is configured. MCP uses it before saved credentials.');
} catch (error) { console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'STATUS_FAILED: The local credential could not be inspected.'); process.exitCode = 1; }
