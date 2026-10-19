import type { Environment } from './auth-protocol.js';

export const PRODUCTION_UPLOAD_PUBLIC_ORIGIN = 'https://files.topmediai.com';

export function defaultUploadPublicOrigin(_environment: Environment): string {
  return PRODUCTION_UPLOAD_PUBLIC_ORIGIN;
}
