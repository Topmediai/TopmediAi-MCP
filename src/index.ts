import { createAsyncRuntimeConfigLoader, loadConfig, loadLocalEnv } from './config.js';
import { startStdioServer } from './stdio-server.js';
import { TopMediaiError } from './types.js';

try {
  loadLocalEnv();
  const reloadConfig = createAsyncRuntimeConfigLoader();
  await startStdioServer(loadConfig(process.env, () => null), reloadConfig);
} catch (error) {
  // stdout is reserved for MCP protocol; never log config, tokens, or raw errors.
  process.stderr.write(error instanceof TopMediaiError ? `${error.code}: ${error.message}\n` : 'Unable to start TopMediAi-MCP.\n');
  process.exitCode = 1;
}
