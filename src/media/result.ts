import type { Artifact } from '../generation/types.js';
import { TopMediaiError } from '../types.js';

// Parsing does not fetch a CDN or forward account headers.
export function resultArtifact(value: unknown, kind: Artifact['kind'], mime: string): Artifact | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value) throw new TopMediaiError('INVALID_RESPONSE', 'The media result is invalid.');
  if (!value.startsWith('https://')) {
    if (/^[A-Za-z0-9+/=_-]+$/.test(value) && value.length >= 16) return { kind, mime_type: mime, media_access: 'encoded', encoded_reference: value, notice: 'This media reference could not be resolved to a playable URL. Explain the delivery limitation; do not automatically open a browser, play media, capture screenshots or submit another generation. Encoding does not provide private access control.' };
    throw new TopMediaiError('INVALID_RESPONSE', 'The media result must use HTTPS.');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new TopMediaiError('INVALID_RESPONSE', 'The media result URL is invalid.'); }
  if (url.username || url.password || url.hash || url.protocol !== 'https:' || url.hostname === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) || url.hostname.includes(':')) {
    throw new TopMediaiError('INVALID_RESPONSE', 'The media result URL is not an allowed public HTTPS URL.');
  }
  const extension = url.pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  const known: Record<string, string> = kind === 'image' ? { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
    : kind === 'audio' ? { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm' }
    : kind === 'video' ? { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' } : { '.lrc': 'text/plain', '.srt': 'application/x-subrip', '.vtt': 'text/vtt' };
  return { kind, url: url.href, mime_type: known[extension ?? ''] ?? mime };
}
