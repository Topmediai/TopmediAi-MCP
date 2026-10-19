import type { Config } from '../config.js';
import { TopMediaiError } from '../types.js';
import { readJson } from './json.js';
import { backendResponseError, transportError } from './errors.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TopMediaiError('INVALID_RESPONSE', 'The backend response shape is invalid.');
  return value as Record<string, unknown>;
}
export function numeric(value: unknown, min = 0): number {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) throw new TopMediaiError('INVALID_RESPONSE', 'A required backend number is missing.');
  const result = Number(value);
  if (!Number.isFinite(result) || result < min) throw new TopMediaiError('INVALID_RESPONSE', 'A backend number is outside its expected range.');
  return result;
}
export function identity(value: unknown): string {
  // Numeric database IDs must not be rounded by JSON/JavaScript.
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TopMediaiError('INVALID_RESPONSE', 'The backend identity must be serialized without precision loss.');
  const result = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result) || /^0+$/.test(result)) throw new TopMediaiError('INVALID_RESPONSE', 'The backend identity is invalid.');
  return result;
}
export class BusinessTransport {
  constructor(readonly config: Config, readonly origin: string, readonly auth: 'token' | 'bearer') {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw new TopMediaiError('INVALID_CONFIG', 'Business services require an approved HTTPS origin.');
    }
  }
  async request(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; form?: Record<string, string | number>; multipart?: FormData; timeoutMs?: number; signal?: AbortSignal; speech?: boolean } = {}): Promise<unknown> {
    if (!this.config.token) throw new TopMediaiError('LOGIN_REQUIRED', 'Complete the local website login, then check service status and balance.');
    const url = new URL(path, this.origin);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== this.origin || url.hash || url.username || url.password) throw new TopMediaiError('INVALID_REQUEST', 'Only fixed business service routes are allowed.');
    const form = options.form ? new URLSearchParams(Object.entries(options.form).map(([key, value]) => [key, String(value)])) : undefined;
    const started = performance.now(), timeoutMs = options.timeoutMs ?? this.config.timeoutMs, timeout = AbortSignal.timeout(timeoutMs);
    let httpStatus: number | undefined;
    const timing = () => ({ http_status: httpStatus, timeout_ms: timeoutMs, elapsed_ms: Math.round(performance.now() - started) });
    try {
      // No automatic retry, redirect, token refresh, cookie or supplier fallback.
      const response = await fetch(url, {
        method: options.method ?? (options.body !== undefined || form || options.multipart ? 'POST' : 'GET'),
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', source: String(this.config.source),
          ...(options.speech ? { 'Web-Req': '1', 'X-Requested-With': 'TTS' } : {}),
          ...(this.auth === 'bearer' ? { Authorization: `Bearer ${this.config.token}` } : { token: this.config.token }),
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.multipart ?? form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      httpStatus = response.status;
      if (httpStatus === 401) throw backendResponseError(undefined, timing())!;
      if (!response.ok) {
        let payload: unknown;
        if (response.headers.get('content-type')?.includes('application/json')) { try { payload = await readJson(response); } catch { /* Preserve the HTTP failure without exposing its raw body. */ } }
        throw backendResponseError(payload, timing(), [this.config.token])!;
      }
      const result = record(await readJson(response));
      const rejected = backendResponseError(result, timing(), [this.config.token]);
      if (rejected) throw rejected;
      if (result.data === null || result.data === undefined) throw new TopMediaiError('INVALID_RESPONSE', 'Business response data is missing.');
      return result.data;
    } catch (error) {
      throw transportError(error, timing(), timeout, options.signal);
    }
  }
}
