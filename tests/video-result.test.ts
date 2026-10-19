import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { videoResultArtifact } from '../src/media/video-result.js';
import { resultArtifact } from '../src/media/result.js';
import { TopMediaiError } from '../src/types.js';

// Generated independently with the existing web client's CryptoJS implementation
// and synthetic media, rather than by the parser under test.
const url = 'https://media.fixture.invalid/result.mp4';
const encoded = 'VyScHU4/TTXDuPra5/t5KAvSx6GnZPAMU/S/MFjbGuf8Hf47IJkvpGjlhnONmnaN';

function encrypt(value: string | Buffer) {
  const cipher = createCipheriv('aes-256-cbc', Buffer.from('123456789imyfone123456789imyfone'), Buffer.from('123456789imyfone'));
  return Buffer.concat([cipher.update(typeof value === 'string' ? Buffer.from(value) : value), cipher.final()]).toString('base64');
}

test('video addresses match the web client protocol and preserve clear HTTPS media', t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Media address parsing must not fetch or forward credentials'); });
  const expected = { kind: 'video', url, mime_type: 'video/mp4' };
  assert.deepEqual(videoResultArtifact(encoded), expected);
  assert.deepEqual(videoResultArtifact(url), expected);
  assert.equal(videoResultArtifact(undefined), undefined);
  assert.equal(videoResultArtifact(null), undefined);
  assert.equal(videoResultArtifact(''), undefined);
  // Video compatibility is not silently applied to music or other opaque media.
  assert.equal(resultArtifact(encoded, 'audio', 'audio/mpeg')?.url, undefined);
});

test('unknown, damaged and non-UTF-8 video references stay unresolved without exposing a false URL', () => {
  for (const value of [
    'YWJjZGVmZ2hpamtsbW5vcA==',
    encoded.slice(0, -4),
    `${encoded}=`,
    Buffer.alloc(16).toString('base64'),
    encrypt(Buffer.from([0xff, 0xfe, 0xff])),
    encrypt('opaque-reference-only'),
  ]) {
    const artifact = videoResultArtifact(value);
    assert.equal(artifact?.url, undefined);
    assert.equal(artifact?.media_access, 'encoded');
    assert.equal(artifact?.encoded_reference, value);
  }
  for (const value of [false, {}, 'x'.repeat(8193), ` ${encoded}`]) {
    assert.throws(() => videoResultArtifact(value), (error: unknown) => error instanceof TopMediaiError && error.code === 'INVALID_RESPONSE');
  }
});

test('decrypted video addresses cannot bypass the existing HTTPS and public address checks', () => {
  for (const address of [
    'http://media.fixture.invalid/result.mp4',
    'https://user:password@media.fixture.invalid/result.mp4',
    'https://localhost/result.mp4',
    'https://127.0.0.1/result.mp4',
    'https://10.0.0.1/result.mp4',
    'https://192.168.1.1/result.mp4',
    'https://172.16.0.1/result.mp4',
    'https://[::1]/result.mp4',
    'https://media.fixture.invalid/result.mp4#token',
    'file:///private/video.mp4',
  ]) {
    const value = encrypt(address), artifact = videoResultArtifact(value);
    assert.equal(artifact?.url, undefined);
    assert.equal(artifact?.encoded_reference, value);
    assert.ok(!JSON.stringify(artifact).includes(address));
  }
});
