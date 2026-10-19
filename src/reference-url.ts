import { TopMediaiError, type UploadUrlDiagnostic } from './types.js';
import { PRODUCTION_UPLOAD_PUBLIC_ORIGIN } from './upload-config.js';

export const REFERENCE_SOURCE = 'app/ai_draw/image';
export const REFERENCE_PREFIX = `/TTS/uploads/${REFERENCE_SOURCE}/`;

export function referenceUrl(value: unknown, origin: string): string {
  return validateUploadUrl(value, origin, REFERENCE_PREFIX, /^[A-Za-z0-9_-]+\.(?:png|jpe?g)$/i);
}

/** Only expose URL structure: never the full URL, credentials, query or filename. */
export function validateUploadUrl(value: unknown, origin: string, prefix: string, filenamePattern: RegExp): string {
  let url: URL | undefined;
  const reject = (reason: UploadUrlDiagnostic['reason']): never => {
    const details: UploadUrlDiagnostic = {
      reason, expected_origin: new URL(origin).origin, expected_path_prefix: prefix,
      ...(url ? {
        ...(url.origin !== 'null' ? { returned_origin: url.origin } : {}),
        protocol: ['https:', 'http:'].includes(url.protocol) ? url.protocol : 'other',
        has_credentials: !!(url.username || url.password),
        has_query: typeof value === 'string' && value.includes('?'),
        has_fragment: typeof value === 'string' && value.includes('#'),
        path_prefix_matches: url.pathname.startsWith(prefix),
        filename_matches: filenamePattern.test(url.pathname.slice(prefix.length)),
      } : {}),
      recovery: reason === 'origin_mismatch' ? {
        action: 'verify_upload_origin_and_reconnect', config_key: 'TOPMEDIAI_UPLOAD_PUBLIC_ORIGIN',
        ...(url && url.origin === PRODUCTION_UPLOAD_PUBLIC_ORIGIN
          && url.pathname.startsWith(prefix) && filenamePattern.test(url.pathname.slice(prefix.length)) && value === url.href
          ? { suggested_origin: url.origin } : {}),
        automatic_retry: false,
      } : { action: 'inspect_upload_response', automatic_retry: false },
    };
    throw new TopMediaiError('INVALID_UPLOAD_URL', `The upload URL failed validation: ${reason}. Inspect the diagnostic fields before another upload attempt.`, details);
  };
  if (typeof value !== 'string') return reject('invalid_type');
  if (value.length > 2048) return reject('url_too_long');
  try { url = new URL(value); } catch { return reject('invalid_url'); }
  // Preserve the existing origin/path checks; diagnostics do not approve a URL.
  if (/[\\\s%]/u.test(value)) return reject('unsafe_characters');
  if (url.protocol !== 'https:') return reject('https_required');
  if (url.username || url.password) return reject('credentials_not_allowed');
  if (value.includes('?')) return reject('query_not_allowed');
  if (value.includes('#')) return reject('fragment_not_allowed');
  if (url.origin !== origin) return reject('origin_mismatch');
  if (!url.pathname.startsWith(prefix)) return reject('path_prefix_mismatch');
  if (!filenamePattern.test(url.pathname.slice(prefix.length))) return reject('invalid_filename');
  if (value !== url.href) return reject('noncanonical_url');
  return url.href;
}
