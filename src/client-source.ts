import { TopMediaiError } from './types.js';

/** MCP host application identity, independent of model, OS and backend payload channel. */
export type McpClientSource = 5 | 6 | 7;

export function parseClientSource(value: unknown): McpClientSource | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 5 || value === '5') return 5;
  if (value === 6 || value === '6') return 6;
  if (value === 7 || value === '7') return 7;
  throw new TopMediaiError('INVALID_CONFIG', 'MCP_CLIENT_SOURCE must be 5 (Codex), 6 (Claude Code), 7 (Cursor), or empty for an unknown client.');
}

/** Supplied by a trusted session router, never by tool arguments or client metadata. */
export interface McpSessionContext {
  clientSource: McpClientSource | undefined;
}
