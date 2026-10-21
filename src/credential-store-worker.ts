import { nativeOperation, normalizeStoreError } from './credential-store.js';

// This helper never writes diagnostics or secrets to stdout/stderr. A native
// unlock dialog can block here without blocking MCP cancellation or other tools.
process.once('disconnect', () => process.exit(1));
process.once('message', (message: unknown) => {
  let result: { value: string | null } | { code: string };
  try {
    const request = message as Record<string, unknown>;
    if (!request || typeof request.service !== 'string' || request.service.length > 200
      || request.environment !== 'production'
      || !['read', 'write', 'remove'].includes(String(request.operation))) throw new Error('Invalid request');
    result = { value: nativeOperation(request.service, request.environment as 'production',
      request.operation as 'read' | 'write' | 'remove', typeof request.secret === 'string' ? request.secret : undefined) };
  } catch (error) { result = { code: normalizeStoreError(error).code }; }
  if (process.send) process.send(result, () => process.exit(0));
  else process.exit(1);
});
