import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAsyncRuntimeConfigLoader, loadLocalEnv } from './config.js';
import { createServer } from './server.js';
import { TopMediaiError } from './types.js';

try {
  loadLocalEnv();
  const reloadConfig = createAsyncRuntimeConfigLoader();
  const server = createServer(await reloadConfig(), reloadConfig);
  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    stopping ??= server.close().catch(() => {
      process.stderr.write('Unable to finish local MCP cleanup. Check local login status.\n');
      process.exitCode = 1;
    });
  };
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
} catch (error) {
  // stdout is reserved for MCP protocol; never log config, tokens, or raw errors.
  process.stderr.write(error instanceof TopMediaiError ? `${error.code}: ${error.message}\n` : 'Unable to start TopMediAi-MCP.\n');
  process.exitCode = 1;
}
