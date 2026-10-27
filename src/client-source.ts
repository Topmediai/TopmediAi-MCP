import { TopMediaiError } from './types.js';

/** MCP host application identity, independent of model, OS and backend payload channel. */
export type McpClientSource = 6 | 7 | 8;

export function parseClientSource(value: unknown): McpClientSource | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 6 || value === '6') return 6;
  if (value === 7 || value === '7') return 7;
  if (value === 8 || value === '8') return 8;
  throw new TopMediaiError('INVALID_CONFIG', 'MCP_CLIENT_SOURCE must be 6 (Codex), 7 (Claude Code), 8 (Cursor), or empty for an unknown client.');
}

/** Supplied by a trusted session router, never by tool arguments or client metadata. */
export interface McpSessionContext {
  clientSource: McpClientSource | undefined;
}
