import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TopMediaiError } from '../types.js';

export async function readLocalMedia(root: string, filePath: string, kind: 'audio' | 'video', maximum = (kind === 'video' ? 50 : 20) * 1024 * 1024, audioExtensions = ['.wav', '.mp3']) {
  try {
    const path = resolve(root, filePath), suffix = relative(root, path), extension = extname(path).toLowerCase();
    if (!filePath || filePath.length > 4096 || filePath.includes('\0') || !suffix || isAbsolute(suffix)
      || suffix === '..' || suffix.startsWith(`..${sep}`) || suffix.split(sep).some(part => part.startsWith('.') || part.includes(':'))
      || !(kind === 'video' ? ['.mp4'] : audioExtensions).includes(extension)) throw new Error();
    const canonicalRoot = await realpath(root);
    if (canonicalRoot.startsWith('\\\\') || (await lstat(root)).isSymbolicLink()) throw new Error();
    let current = root;
    for (const part of suffix.split(sep)) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error(); }
    const canonicalPath = await realpath(path), actualSuffix = relative(canonicalRoot, canonicalPath);
    if ((process.platform === 'win32' ? suffix.toLowerCase() !== actualSuffix.toLowerCase() : suffix !== actualSuffix)) throw new Error();
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error();
    const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || !opened.isFile()) throw new Error();
      const data = Buffer.alloc(before.size + 1); let length = 0;
      while (length < data.length) { const part = await handle.read(data, length, data.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat(), pathAfter = await lstat(path);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1
        || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1 || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
        || await realpath(root) !== canonicalRoot || await realpath(path) !== canonicalPath) throw new Error();
      const bytes = data.subarray(0, length);
      if (extension === '.mp4' && bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error();
      if (extension === '.wav' && (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')) throw new Error();
      if (extension === '.mp3' && bytes.toString('ascii', 0, 3) !== 'ID3' && !(bytes[0] === 255 && (bytes[1]! & 224) === 224)) throw new Error();
      if (extension === '.aac' && !(bytes[0] === 255 && (bytes[1]! & 246) === 240)) throw new Error();
      if (extension === '.flac' && bytes.toString('ascii', 0, 4) !== 'fLaC') throw new Error();
      if (extension === '.ogg' && bytes.toString('ascii', 0, 4) !== 'OggS') throw new Error();
      if (extension === '.aiff' && (bytes.toString('ascii', 0, 4) !== 'FORM' || !['AIFF', 'AIFC'].includes(bytes.toString('ascii', 8, 12)))) throw new Error();
      return { data: bytes, extension };
    } finally { await handle.close(); }
  } catch { throw new TopMediaiError('INVALID_REFERENCE_MEDIA', `Select a regular valid ${kind === 'video' ? 'MP4' : audioExtensions.map(value => value.slice(1).toUpperCase()).join(', ')} inside the dedicated upload directory. Links, traversal and oversized media are rejected.`); }
}
