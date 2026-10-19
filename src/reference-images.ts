import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { AccountVerificationError, verifyAccountToken } from './account.js';
import { Backend } from './backend.js';
import { usesDirectApis, type Config } from './config.js';
import { TopMediaiError, type ReferenceImage } from './types.js';
import { referenceUrl, REFERENCE_SOURCE } from './reference-url.js';
import { defaultUploadPublicOrigin } from './upload-config.js';
export { referenceUrl, REFERENCE_PREFIX, REFERENCE_SOURCE } from './reference-url.js';

export const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function fileError(): TopMediaiError {
  return new TopMediaiError('INVALID_REFERENCE_FILE', 'Select a regular PNG or JPEG inside the configured upload directory. Links, oversized, animated or invalid images are not allowed.');
}

export async function prepareReferenceImage(root: string, filePath: string) {
  try {
    if (!filePath || filePath.length > 4096 || filePath.includes('\0')) throw fileError();
    const path = resolve(root, filePath);
    if (!inside(root, path)) throw fileError();
    const parts = relative(root, path).split(sep);
    if (parts.some(part => part.startsWith('.') || part.includes(':'))) throw fileError();
    const ext = extname(path).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw fileError();
    // Resolve the allowlist before opening; reject every symlink/junction below
    // it. Recheck path and descriptor identities after the bounded read.
    const canonicalRoot = await realpath(root);
    // Windows realpath also expands harmless 8.3 names in TEMP paths. Authorize
    // the canonical root, while still rejecting junctions and network shares.
    if (canonicalRoot.startsWith('\\\\') || (await lstat(root)).isSymbolicLink()) throw fileError();
    let current = root;
    for (const part of parts) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw fileError();
    }
    const canonicalPath = await realpath(path);
    const suffix = relative(root, path); const canonicalSuffix = relative(canonicalRoot, canonicalPath);
    const sameSuffix = process.platform === 'win32' ? suffix.toLowerCase() === canonicalSuffix.toLowerCase() : suffix === canonicalSuffix;
    if (!inside(canonicalRoot, canonicalPath) || !sameSuffix) throw fileError();
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_REFERENCE_BYTES) throw fileError();
    const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let input: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw fileError();
      const bytes = Buffer.alloc(MAX_REFERENCE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const chunk = await handle.read(bytes, length, bytes.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      const after = await handle.stat();
      const pathAfter = await lstat(path);
      if (length !== before.size || after.size !== before.size || after.nlink !== 1 || after.mtimeMs !== before.mtimeMs
        || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1 || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
        || relative(canonicalRoot, await realpath(root)) !== '' || relative(canonicalPath, await realpath(path)) !== '') throw fileError();
      input = bytes.subarray(0, length);
    } finally { await handle.close(); }
    const isPng = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = input[0] === 255 && input[1] === 216 && input[2] === 255;
    if ((ext === '.png' && !isPng) || (ext !== '.png' && !isJpeg)) throw fileError();
    if (isPng) {
      // libvips may decode only the first frame of APNG. Reject animation at
      // the PNG chunk level instead of trusting the decoded page count alone.
      for (let offset = 8; offset + 12 <= input.length;) {
        const length = input.readUInt32BE(offset);
        if (offset + 12 + length > input.length) throw fileError();
        const type = input.toString('ascii', offset + 4, offset + 8);
        if (type === 'acTL') throw fileError();
        if (type === 'IEND') break;
        offset += 12 + length;
      }
    }
    const image = sharp(input, { failOn: 'warning', limitInputPixels: MAX_PIXELS });
    const meta = await image.metadata();
    if (!['png', 'jpeg'].includes(meta.format ?? '') || !meta.width || !meta.height
      || meta.width > 8192 || meta.height > 8192 || (meta.pages ?? 1) !== 1) throw fileError();
    // Full decoding and fresh encoding remove EXIF/GPS, original names, comments
    // and appended payloads. Originals and normalized bytes are never saved.
    const pipeline = image.rotate().timeout({ seconds: 10 });
    const result = await (isPng ? pipeline.png() : pipeline.jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true });
    if (result.data.length > MAX_REFERENCE_BYTES) throw fileError();
    return { data: result.data, mime_type: isPng ? 'image/png' as const : 'image/jpeg' as const,
      extension: isPng ? 'png' : 'jpg', width: result.info.width, height: result.info.height,
      bytes: result.data.length, sha256: createHash('sha256').update(result.data).digest('hex') };
  } catch { throw fileError(); }
}

export class ReferenceImages {
  constructor(private readonly config: Config, private readonly backend: Backend) {}
  get enabled(): boolean {
    return usesDirectApis(this.config)
      && !!this.config.uploadRoot && !!this.config.uploadHost;
  }
  url(value: unknown): string {
    return referenceUrl(value, this.config.uploadPublicOrigin ?? defaultUploadPublicOrigin(this.config.environment));
  }
  async upload(filePath: string): Promise<ReferenceImage> {
    if (!this.enabled) throw new TopMediaiError('IMAGE_UPLOAD_DISABLED', 'Configure TOPMEDIAI_UPLOAD_ROOT as a dedicated local image directory and a direct upload backend, then refresh the launch configuration and reconnect this MCP server.');
    this.backend.requireToken();
    const image = await prepareReferenceImage(this.config.uploadRoot!, filePath);
    // The legacy upload route does not validate login itself. Independently
    // verify the account before transmitting any image to that service.
    try {
      await verifyAccountToken({ environment: this.config.environment, memberOrigin: this.config.memberHost }, this.config.token);
    } catch (error) {
      throw new TopMediaiError(error instanceof AccountVerificationError && error.code === 'login_required' ? 'LOGIN_REQUIRED' : 'ACCOUNT_UNAVAILABLE', 'The account could not be verified. No image was uploaded.');
    }
    const form = new FormData();
    form.set('source', REFERENCE_SOURCE); // Never caller-controlled storage paths.
    form.set('file', new Blob([new Uint8Array(image.data)], { type: image.mime_type }), `${randomUUID()}.${image.extension}`);
    const data = await this.backend.request(this.config.uploadHost!, '/upload_file', form);
    const url = this.url(data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).url : undefined);
    const asset: ReferenceImage = { reference_image_id: randomUUID(), url,
      sha256: image.sha256, mime_type: image.mime_type, bytes: image.bytes,
      width: image.width, height: image.height, created_at: new Date().toISOString() };
    return asset;
  }
}
