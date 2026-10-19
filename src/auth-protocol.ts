import {
  constants, createHash, createHmac, privateDecrypt, publicEncrypt, timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { TopMediaiError } from './types.js';

export type Environment = 'production';
export const AUTH_PROTOCOL = 'topmediai-openclaw-local';
export const AUTH_VERSION = 1;
export const MAX_BODY_BYTES = 2048;
export const MAX_PLAINTEXT_BYTES = 190;

export class AuthProtocolError extends TopMediaiError {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code, code);
    this.name = 'AuthProtocolError';
  }
}

export interface AuthContext {
  state: string;
  environment: Environment;
  port: number;
}
export interface HandoffEnvelope {
  version: 1;
  state: string;
  environment: Environment;
  ciphertext: string;
}
export type HandoffPayload =
  | { decision: 'approve'; token: string; expected_member_id: string; receipt_nonce: string }
  | { decision: 'deny'; receipt_nonce: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new AuthProtocolError('invalid_request');
  }
}
export function decodeCanonicalBase64url(value: unknown, bytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AuthProtocolError('invalid_request');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) {
    throw new AuthProtocolError('invalid_request');
  }
  return decoded;
}
export function normalizeMemberId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value) : value;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) {
    throw new AuthProtocolError('invalid_request');
  }
  return id;
}
export function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{42}$/.test(value);
}
export function validateContext(context: AuthContext): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(context.state)
    || context.environment !== 'production'
    || !Number.isInteger(context.port) || context.port < 1 || context.port > 65535) {
    throw new AuthProtocolError('invalid_request');
  }
}
export function parseEnvelope(value: unknown): HandoffEnvelope {
  if (!isRecord(value)) throw new AuthProtocolError('invalid_request');
  exactKeys(value, ['version', 'state', 'environment', 'ciphertext']);
  if (value.version !== AUTH_VERSION || typeof value.state !== 'string'
    || value.environment !== 'production') {
    throw new AuthProtocolError('invalid_request');
  }
  validateContext({ state: value.state, environment: value.environment, port: 1 });
  decodeCanonicalBase64url(value.ciphertext, 256);
  return value as unknown as HandoffEnvelope;
}
export function parsePayload(value: unknown): HandoffPayload {
  if (!isRecord(value)) throw new AuthProtocolError('invalid_request');
  decodeCanonicalBase64url(value.receipt_nonce, 16);
  if (value.decision === 'deny') {
    exactKeys(value, ['decision', 'receipt_nonce']);
    return { decision: 'deny', receipt_nonce: value.receipt_nonce as string };
  }
  if (value.decision !== 'approve' || !validToken(value.token) || typeof value.expected_member_id !== 'string') {
    throw new AuthProtocolError('invalid_request');
  }
  exactKeys(value, ['decision', 'token', 'expected_member_id', 'receipt_nonce']);
  return {
    decision: 'approve', token: value.token,
    expected_member_id: normalizeMemberId(value.expected_member_id),
    receipt_nonce: value.receipt_nonce as string,
  };
}
export function oaepLabel(context: AuthContext): Buffer {
  validateContext(context);
  return Buffer.from(JSON.stringify([
    AUTH_PROTOCOL, String(AUTH_VERSION), context.state, context.environment, String(context.port),
  ]), 'utf8');
}
export function handoffProof(secret: Uint8Array, context: AuthContext, ciphertext: string): string {
  validateContext(context);
  if (secret.byteLength !== 32) throw new AuthProtocolError('invalid_request');
  decodeCanonicalBase64url(ciphertext, 256);
  const input = JSON.stringify([
    AUTH_PROTOCOL, String(AUTH_VERSION), 'complete', context.state,
    context.environment, String(context.port), ciphertext,
  ]);
  return createHmac('sha256', secret).update(input, 'utf8').digest('base64url');
}
export function checkHandoffProof(
  proof: unknown, secret: Uint8Array, context: AuthContext, ciphertext: string,
): void {
  let supplied: Buffer;
  try { supplied = decodeCanonicalBase64url(proof, 32); }
  catch { throw new AuthProtocolError('invalid_handoff', 403); }
  const expected = Buffer.from(handoffProof(secret, context, ciphertext), 'base64url');
  if (!timingSafeEqual(expected, supplied)) throw new AuthProtocolError('invalid_handoff', 403);
}
export function encryptHandoffPayload(key: KeyObject, context: AuthContext, value: HandoffPayload): string {
  const payload = parsePayload(value);
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (bytes.length > MAX_PLAINTEXT_BYTES) throw new AuthProtocolError('invalid_request');
  return publicEncrypt({
    key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: oaepLabel(context),
  }, bytes).toString('base64url');
}
export function decryptHandoffPayload(key: KeyObject, context: AuthContext, ciphertext: string): HandoffPayload {
  try {
    const plain = privateDecrypt({
      key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: oaepLabel(context),
    }, decodeCanonicalBase64url(ciphertext, 256));
    if (plain.length > MAX_PLAINTEXT_BYTES) throw new AuthProtocolError('invalid_request');
    return parsePayload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  } catch {
    throw new AuthProtocolError('invalid_request');
  }
}
export function requestFingerprint(envelope: HandoffEnvelope, proof: string): string {
  return createHash('sha256').update(JSON.stringify([
    envelope.version, envelope.state, envelope.environment, envelope.ciphertext, proof,
  ])).digest('hex');
}
