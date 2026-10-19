import { createDecipheriv } from 'node:crypto';
import type { Artifact, GenerationTask } from '../generation/types.js';
import { resultArtifact } from './result.js';

// Existing AI_Music_Server/utils/AES.py protocol; this is URL encoding, not access control.
export function musicResultArtifact(value: unknown): Artifact | undefined {
  const artifact = resultArtifact(value, 'audio', 'audio/mpeg');
  if (!artifact?.encoded_reference) return artifact;
  try {
    const ciphertext = Buffer.from(artifact.encoded_reference, 'base64');
    if (!ciphertext.length || ciphertext.length % 16 || ciphertext.toString('base64') !== artifact.encoded_reference) return artifact;
    const cipher = createDecipheriv('aes-256-cbc', Buffer.from('147258369topmeidia96385topmeidia'), Buffer.from('1597531topmeidia'));
    const url = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([cipher.update(ciphertext), cipher.final()]));
    return resultArtifact(url, 'audio', 'audio/mpeg') ?? artifact;
  } catch { return artifact; }
}

export function resolveMusicTaskMedia(task: GenerationTask): GenerationTask {
  const resolve = (artifact: Artifact) => artifact.kind === 'audio' && artifact.encoded_reference
    ? musicResultArtifact(artifact.encoded_reference) ?? artifact : artifact;
  return { ...task, artifacts: task.artifacts.map(resolve),
    ...(task.children ? { children: task.children.map(child => ({ ...child, artifacts: child.artifacts.map(resolve) })) } : {}) };
}
