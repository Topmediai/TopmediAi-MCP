import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AccountVerificationError, verifyAccountToken } from '../account.js';
import { Backend } from '../backend.js';
import { usesDirectApis, type Config } from '../config.js';
import { Store } from '../store.js';
import { TopMediaiError, type ReferenceMedia } from '../types.js';
import { readLocalMedia } from './local-file.js';
import { validateUploadUrl } from '../reference-url.js';
import { defaultUploadPublicOrigin } from '../upload-config.js';

const run = promisify(execFile);
export const MEDIA_REFERENCE_SOURCE = 'app/ai_video/reference';
export const MEDIA_REFERENCE_PREFIX = `/TTS/uploads/${MEDIA_REFERENCE_SOURCE}/`;
export function mediaReferenceUrl(value: unknown, origin: string, kind: 'audio' | 'video'): string {
  const extension = kind === 'video' ? 'mp4' : 'wav';
  return validateUploadUrl(value, origin, MEDIA_REFERENCE_PREFIX, new RegExp(`^[A-Za-z0-9_-]+\\.${extension}$`));
}

async function probe(path: string, config: Config, kind: 'audio' | 'video', maxDuration: number) {
  const { stdout } = await run(config.ffprobePath ?? 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration', '-of', 'json', path],
    { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
  const data = JSON.parse(stdout), stream = data.streams?.find((item: any) => item.codec_type === kind);
  // MoviePy's backend duration follows the whole container (including audio),
  // which may outlast the video stream and change the integer billing tier.
  const containerDuration = Number(data.format?.duration);
  const duration = Number.isFinite(containerDuration) && containerDuration > 0 ? containerDuration : Number(stream?.duration);
  if (!stream || !Number.isFinite(duration) || duration < 2 || duration > maxDuration || data.streams.length > 2
    || data.streams.some((item: any) => !['audio', 'video'].includes(item.codec_type))
    || !(kind === 'video' ? String(data.format?.format_name).includes('mp4') : /(?:wav|mp3)/.test(String(data.format?.format_name)))) throw new Error();
  if (kind === 'audio' && data.streams.some((item: any) => item.codec_type !== 'audio')) throw new Error();
  if (kind === 'video' && (!Number.isInteger(stream.width) || !Number.isInteger(stream.height)
    || stream.width < 64 || stream.height < 64 || stream.width > 4096 || stream.height > 4096)) throw new Error();
  const rate = String(stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = rate[0]! / rate[1]!;
  if (kind === 'video' && (!Number.isFinite(fps) || fps < 1 || fps > 60)) throw new Error();
  return { duration_seconds: duration, ...(kind === 'video' ? { width: stream.width as number, height: stream.height as number, fps } : {}) };
}

export async function prepareReferenceMedia(root: string, filePath: string, kind: 'audio' | 'video', config: Config, modelType = 26) {
  if (![26, 33, 36, 38].includes(modelType)) throw new TopMediaiError('INVALID_PARAMS', 'Select an omni-reference model from the catalog.');
  const maxDuration = modelType === 38 ? 30.2 : 15.2;
  const maximum = (modelType === 38 ? kind === 'video' ? 200 : 15 : kind === 'video' ? 50 : 20) * 1024 * 1024;
  const input = await readLocalMedia(root, filePath, kind, maximum);
  const parent = resolve(tmpdir()), temporary = await mkdtemp(resolve(parent, 'topmediai-media-'));
  try {
    const source = resolve(temporary, `input${input.extension}`), target = resolve(temporary, kind === 'video' ? 'normalized.mp4' : 'normalized.wav');
    await writeFile(source, input.data, { mode: 0o600 });
    const original = await probe(source, config, kind, maxDuration);
    const encoding = kind === 'video'
      ? ['-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']
      : ['-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1'];
    await run(config.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-threads', '1', '-i', source, ...encoding, '-threads', '1', '-fs', String((kind === 'video' ? 50 : 5) * 1024 * 1024 + 1), '-map_metadata', '-1', '-map_chapters', '-1', '-y', target],
      { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size < 1 || stat.size > (kind === 'video' ? 50 : 5) * 1024 * 1024) throw new Error();
    const metadata = await probe(target, config, kind, maxDuration), data = await readFile(target);
    if (Math.abs(metadata.duration_seconds - original.duration_seconds) > 0.2) throw new Error();
    return { data, ...metadata, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      mime_type: kind === 'video' ? 'video/mp4' as const : 'audio/wav' as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TopMediaiError('MEDIA_PROBE_UNAVAILABLE', 'Install local FFmpeg/FFprobe or configure TOPMEDIAI_FFMPEG_PATH and TOPMEDIAI_FFPROBE_PATH. No media was uploaded.');
    throw new TopMediaiError('INVALID_REFERENCE_MEDIA', 'Media decoding or normalization failed, or its duration/dimensions exceed the reference limits. No media was uploaded.');
  } finally {
    const suffix = relative(parent, temporary);
    if (suffix.startsWith('topmediai-media-') && !isAbsolute(suffix) && !suffix.startsWith('..')) await rm(temporary, { recursive: true, force: true });
  }
}

export class ReferenceMediaService {
  constructor(private readonly config: Config) {}
  async upload(filePath: string, kind: 'audio' | 'video', modelType = 26) {
    if (!usesDirectApis(this.config) || !this.config.uploadRoot || !this.config.uploadHost) {
      throw new TopMediaiError('REFERENCE_MEDIA_UPLOAD_DISABLED', 'Configure a dedicated TOPMEDIAI_UPLOAD_ROOT and a direct upload backend.');
    }
    const backend = new Backend({ ...this.config, timeoutMs: this.config.audioTimeoutMs ?? 300_000 }); backend.requireToken();
    const media = await prepareReferenceMedia(this.config.uploadRoot, filePath, kind, this.config, modelType);
    try { await verifyAccountToken({ environment: this.config.environment, memberOrigin: this.config.memberHost, clientSource: this.config.clientSource }, this.config.token); }
    catch (error) { throw new TopMediaiError(error instanceof AccountVerificationError && error.code === 'login_required' ? 'LOGIN_REQUIRED' : 'ACCOUNT_UNAVAILABLE', 'The account could not be verified. No media was uploaded.'); }
    const form = new FormData(); form.set('source', MEDIA_REFERENCE_SOURCE);
    form.set('file', new Blob([new Uint8Array(media.data)], { type: media.mime_type }), `${randomUUID()}.${kind === 'video' ? 'mp4' : 'wav'}`);
    const response = await backend.request(this.config.uploadHost, '/upload_file', form);
    const url = mediaReferenceUrl((response as { url?: unknown })?.url, this.config.uploadPublicOrigin ?? defaultUploadPublicOrigin(this.config.environment), kind);
    const { data: _bytes, ...metadata } = media;
    const asset: ReferenceMedia = { ...metadata, reference_media_id: randomUUID(), media_type: kind, url, created_at: new Date().toISOString() };
    const store = new Store(this.config.dataDir);
    await store.transaction(async state => { state.reference_media ??= Object.create(null); state.reference_media![asset.reference_media_id] = asset; await store.save(state); });
    return { ...asset, storage_notice: 'Existing upload URLs may be public. Upload only media authorized for external storage. No generation was submitted.' };
  }
}
