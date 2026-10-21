import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAsyncRuntimeConfigLoader, loadConfig } from '../../src/config.js';
import { startStdioServer } from '../../src/stdio-server.js';
import { readCredentialAsync } from '../../src/credentials.js';
import { MemoryCredentialStore } from './credential-store.js';

// Test control file contains only synthetic credentials. This provider is never
// reachable from src/index.ts or production environment settings.
const store = new MemoryCredentialStore();
store.readAsync = async () => {
  try { return await readFile(join(process.env.TOPMEDIAI_DATA_DIR!, 'fixture-credential.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
await startStdioServer(loadConfig(process.env, () => null),
  createAsyncRuntimeConfigLoader(process.env, environment => readCredentialAsync(environment, store)));
