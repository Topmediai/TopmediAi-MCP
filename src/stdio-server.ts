import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import type { Config, RuntimeConfigLoader } from './config.js';

/** Start with public config so a locked store cannot hide recovery tools. */
export async function startStdioServer(config: Config, reloadConfig: RuntimeConfigLoader): Promise<void> {
  const server = createServer(config, reloadConfig);
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
}
