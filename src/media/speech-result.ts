import { createDecipheriv } from 'node:crypto';
import type { Artifact } from '../generation/types.js';
import { resultArtifact } from './result.js';

// Compatibility with the existing client's encoded audio address format.
// This legacy encoding is not private access control and requires no CDN request.
export function speechResultArtifact(value: unknown): Artifact | undefined {
  const artifact = resultArtifact(value, 'audio', 'audio/mpeg');
  if (!artifact?.encoded_reference) return artifact;
  try {
    const ciphertext = Buffer.from(artifact.encoded_reference, 'base64');
    if (!ciphertext.length || ciphertext.length % 16 || ciphertext.toString('base64') !== artifact.encoded_reference) return artifact;
    const cipher = createDecipheriv('aes-256-cbc', Buffer.from('123456789imyfone123456789imyfone'), Buffer.from('123456789imyfone'));
    const url = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([cipher.update(ciphertext), cipher.final()]));
    return resultArtifact(url, 'audio', 'audio/mpeg') ?? artifact;
  } catch { return artifact; }
}
