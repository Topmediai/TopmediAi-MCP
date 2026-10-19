import { createDecipheriv } from 'node:crypto';
import type { Artifact, GenerationTask } from '../generation/types.js';
import { resultArtifact } from './result.js';

// Compatibility with the existing web client's video address format:
// AES-256-CBC, PKCS#7 padding and Base64 ciphertext. These client constants
// provide no access control; the adapter authenticates and checks task ownership.
const videoAddressKey = Buffer.from('123456789imyfone123456789imyfone', 'utf8');
const videoAddressIv = Buffer.from('123456789imyfone', 'utf8');

export function videoResultArtifact(value: unknown): Artifact | undefined {
  const artifact = resultArtifact(value, 'video', 'video/mp4');
  if (!artifact?.encoded_reference) return artifact;

  const encoded = artifact.encoded_reference;
  const ciphertext = Buffer.from(encoded, 'base64');
  if (!ciphertext.length || ciphertext.length % 16 !== 0 || ciphertext.toString('base64') !== encoded) return artifact;

  try {
    const decipher = createDecipheriv('aes-256-cbc', videoAddressKey, videoAddressIv);
    const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const address = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Decryption does not bypass the existing public HTTPS URL validation.
    const resolved = resultArtifact(address, 'video', 'video/mp4');
    return resolved?.url ? resolved : artifact;
  } catch {
    // Unknown formats, corrupt ciphertext and unsafe decoded addresses remain
    // unresolved media; they do not change the backend generation status.
    return artifact;
  }
}

// Resolve legacy saved results without polling or mutating the stored task.
export function resolveVideoTaskMedia(task: GenerationTask): GenerationTask {
  const resolve = (artifact: Artifact) => artifact.kind === 'video' && artifact.encoded_reference
    ? videoResultArtifact(artifact.encoded_reference) ?? artifact : artifact;
  return { ...task, artifacts: task.artifacts.map(resolve),
    ...(task.children ? { children: task.children.map(child => ({ ...child, artifacts: child.artifacts.map(resolve) })) } : {}) };
}
