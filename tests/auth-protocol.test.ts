import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomBytes, webcrypto } from 'node:crypto';
import {
  AuthProtocolError, decodeCanonicalBase64url, decryptHandoffPayload, encryptHandoffPayload,
  handoffProof, normalizeMemberId, oaepLabel, parseEnvelope, parsePayload, type AuthContext,
} from '../src/auth-protocol.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
const context: AuthContext = { state: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', environment: 'production', port: 43210 };
const token = 'a'.repeat(42);
const payload = { decision: 'approve' as const, token, expected_member_id: '18446744073709551615', receipt_nonce: randomBytes(16).toString('base64url') };
const protocolError = (error: unknown) => error instanceof AuthProtocolError && error.code === 'invalid_request';

test('browser Web Crypto RSA-OAEP and HMAC interoperate with the Node receiver', async () => {
  const spki = keys.publicKey.export({ format: 'der', type: 'spki' });
  const browserKey = await webcrypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 190);
  const ciphertext = Buffer.from(await webcrypto.subtle.encrypt(
    { name: 'RSA-OAEP', label: oaepLabel(context) }, browserKey, Buffer.from(JSON.stringify(payload)),
  )).toString('base64url');
  assert.equal(ciphertext.length, 342);
  assert.deepEqual(decryptHandoffPayload(keys.privateKey, context, ciphertext), payload);
  const secret = randomBytes(32);
  const hmacKey = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const input = JSON.stringify(['topmediai-openclaw-local', '1', 'complete', context.state, 'production', '43210', ciphertext]);
  const browserProof = Buffer.from(await webcrypto.subtle.sign('HMAC', hmacKey, Buffer.from(input))).toString('base64url');
  assert.equal(handoffProof(secret, context, ciphertext), browserProof);
  assert.equal(createPublicKey({ key: spki, type: 'spki', format: 'der' }).asymmetricKeyDetails?.modulusLength, 2048);
});

test('ciphertext cannot be decrypted for a different state or port', () => {
  const ciphertext = encryptHandoffPayload(keys.publicKey, context, payload);
  for (const changed of [
    { ...context, port: context.port + 1 },
    { ...context, state: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  ]) assert.throws(() => decryptHandoffPayload(keys.privateKey, changed, ciphertext), protocolError);
});

test('canonical encodings and schema reject ambiguity without exposing values', () => {
  const canonical = Buffer.alloc(32).toString('base64url');
  assert.throws(() => decodeCanonicalBase64url(`${canonical}=`, 32), protocolError);
  assert.throws(() => decodeCanonicalBase64url(`${canonical.slice(0, -1)}B`, 32), protocolError);
  assert.throws(() => parsePayload({ ...payload, ignored: 'secret-marker' }), protocolError);
  assert.throws(() => parsePayload({ decision: 'deny', token, receipt_nonce: payload.receipt_nonce }), protocolError);
  assert.throws(() => parseEnvelope({ version: '1', state: context.state, environment: 'production', ciphertext: 'x' }), protocolError);
  assert.throws(() => parsePayload({ ...payload, receipt_nonce: `${payload.receipt_nonce}=` }), protocolError);
  assert.throws(() => parsePayload({ ...payload, token: 'b'.repeat(43) }), protocolError);
  assert.throws(() => parsePayload({ ...payload, expected_member_id: 123 }), protocolError);
});

test('member IDs preserve long integers as strings and reject unsafe numeric coercion', () => {
  assert.equal(normalizeMemberId('18446744073709551615'), '18446744073709551615');
  assert.equal(normalizeMemberId(123), '123');
  for (const value of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '00123', '0', '1'.repeat(21), '1e3']) {
    assert.throws(() => normalizeMemberId(value), protocolError);
  }
});
