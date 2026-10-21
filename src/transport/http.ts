import { parseClientSource, type McpClientSource } from '../client-source.js';

interface BusinessHttpContext {
  clientSource?: McpClientSource;
  memberHost?: string;
  imageHost?: string;
  musicHost?: string;
  ttsHost?: string;
  uploadHost?: string;
  gatewayHost?: string;
}

/** Shared outbound policy; never install a global fetch interceptor. */
export function businessFetch(context: BusinessHttpContext, url: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  // Case-insensitive delete/set prevents legacy or duplicate values from surviving.
  headers.delete('source');
  const source = parseClientSource(context.clientSource);
  const businessOrigins = [context.memberHost, context.imageHost, context.musicHost,
    context.ttsHost, context.uploadHost, context.gatewayHost];
  if (source !== undefined && businessOrigins.includes(url.origin)) headers.set('source', String(source));
  // All business requests already reject redirects; keep the identity on this origin only.
  return fetch(url, { ...init, headers, redirect: 'error' });
}
