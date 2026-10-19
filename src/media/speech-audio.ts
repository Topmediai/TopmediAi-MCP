import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { normalizeAccountIdentity } from '../account.js';
import { Store } from '../store.js';
import { TopMediaiError } from '../types.js';
import { BusinessTransport, identity, numeric, record } from '../transport/business.js';
import { assertSpeechContract } from '../generation/speech-options.js';
import { validateUploadUrl } from '../reference-url.js';
import { defaultUploadPublicOrigin } from '../upload-config.js';
import { readLocalMedia } from './local-file.js';

const run = promisify(execFile), MAX_BYTES = 50 * 1024 * 1024;
export const SPEECH_SOURCE = 'app/speech_to_speech/mcp';
export const SPEECH_PREFIX = `/TTS/uploads/${SPEECH_SOURCE}/`;
const storageNotice = 'Existing upload URLs may be publicly accessible. Upload only audio authorized for external storage. Account-scoped IDs do not make the stored audio private. No synthesis was submitted.';
export interface SpeechAsset {
  speech_asset_id: string; file_id: string; sha256: string; mime_type: string; url: string;
  bytes: number; duration_seconds: number; created_at: string; expires_at: string;
}
export function speechAudioUrl(value: unknown, config: Config) {
  return validateUploadUrl(value, config.uploadPublicOrigin ?? defaultUploadPublicOrigin(config.environment), SPEECH_PREFIX, /^[A-Za-z0-9_-]+\.wav$/);
}
async function probe(path: string, config: Config, signal?: AbortSignal) {
  const { stdout } = await run(config.ffprobePath ?? 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'format=format_name,duration:stream=codec_type', '-of', 'json', path],
    { timeout: 15000, maxBuffer: 65536, windowsHide: true, shell: false, signal });
  const data = JSON.parse(stdout), duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300 || !Array.isArray(data.streams) || data.streams.length < 1 || data.streams.length > 2 ||
      data.streams.some((stream: { codec_type?: string }) => stream.codec_type !== 'audio') ||
      !String(data.format?.format_name).split(',').some(format => ['wav', 'mp3', 'aac', 'flac', 'aiff', 'ogg'].includes(format))) throw new Error();
  return duration;
}
export async function prepareSpeechAudio(config: Config, filePath: string, signal?: AbortSignal) {
  const input = await readLocalMedia(config.uploadRoot!, filePath, 'audio', MAX_BYTES, ['.mp3', '.wav', '.aac', '.flac', '.aiff', '.ogg']);
  const parent = resolve(tmpdir()), directory = await mkdtemp(resolve(parent, 'topmediai-speech-'));
  try {
    const source = resolve(directory, `source${input.extension}`), target = resolve(directory, 'speech.wav');
    await writeFile(source, input.data, { mode: 0o600 });
    const duration = await probe(source, config, signal);
    await run(config.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-threads', '1', '-i', source, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
      '-map_metadata', '-1', '-map_chapters', '-1', '-fs', String(MAX_BYTES + 1), '-y', target],
      { timeout: 30000, maxBuffer: 65536, windowsHide: true, shell: false, signal });
    const size = (await stat(target)).size, measured = await probe(target, config, signal);
    if (size < 1 || size > MAX_BYTES || Math.abs(measured - duration) > 0.1) throw new Error();
    const data = await readFile(target);
    return { data, bytes: data.length, duration_seconds: measured, sha256: createHash('sha256').update(data).digest('hex') };
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TopMediaiError('MEDIA_PROBE_UNAVAILABLE', 'Install local FFmpeg/FFprobe or configure their executable paths. No audio was uploaded.');
    throw new TopMediaiError('INVALID_SPEECH_ASSET', 'Audio decoding failed or the audio exceeds the 50 MiB/300 second limits. No audio was uploaded.');
  } finally {
    const suffix = relative(parent, directory);
    if (suffix.startsWith('topmediai-speech-') && !isAbsolute(suffix) && !suffix.startsWith('..')) await rm(directory, { recursive: true, force: true });
  }
}
export class SpeechAudioService {
  private readonly store: Store;
  private readonly api: BusinessTransport;
  constructor(private readonly config: Config) {
    // Do not reuse records created for the withdrawn private-asset backend proposal.
    this.store = new Store(resolve(config.dataDir, `speech-assets-v2-${createHash('sha256').update(JSON.stringify([config.ttsHost, config.uploadHost, config.uploadPublicOrigin])).digest('hex').slice(0, 16)}`));
    this.api = new BusinessTransport(config, config.ttsHost ?? config.memberHost, 'token');
  }
  async upload(filePath: string, signal?: AbortSignal) {
    assertSpeechContract(this.config);
    if (!this.config.uploadRoot || !this.config.uploadHost) throw new TopMediaiError('UPLOAD_DISABLED', 'Configure a dedicated TOPMEDIAI_UPLOAD_ROOT and an upload backend for speech upload.');
    signal?.throwIfAborted();
    normalizeAccountIdentity(await new BusinessTransport(this.config, this.config.memberHost, 'token').request('/user/member/info', { signal }));
    const audio = await prepareSpeechAudio(this.config, filePath, signal);
    const form = new FormData(); form.set('source', SPEECH_SOURCE);
    form.set('file', new Blob([new Uint8Array(audio.data)], { type: 'audio/wav' }), `speech-${randomUUID()}.wav`);
    const uploaded = record(await new BusinessTransport(this.config, this.config.uploadHost, 'token').request('/upload_file', { multipart: form, timeoutMs: this.config.audioTimeoutMs ?? 300000, signal }));
    const url = speechAudioUrl(uploaded.url, this.config), duration = numeric(uploaded.duration);
    if (duration <= 0 || duration > 300 || Math.abs(duration - audio.duration_seconds) > 0.1) throw new TopMediaiError('INVALID_SPEECH_ASSET', 'Uploaded audio duration does not match the local audio. No synthesis was submitted.');
    const registered = await this.api.request('/sts/create_task', { form: { file_list: JSON.stringify([{ name: 'speech.wav', size: audio.bytes, mime_type: 'wav',
      file_time: Math.ceil(duration * 1000), is_record: 0, is_uploaded: 1, product_id: 1, oss_url: url }]) }, signal });
    if (!Array.isArray(registered) || registered.length !== 1) throw new TopMediaiError('INVALID_RESPONSE', 'Speech file registration must return one file.');
    const asset: SpeechAsset = { speech_asset_id: randomUUID(), file_id: identity(record(registered[0]).file_id), url, sha256: audio.sha256,
      bytes: audio.bytes, duration_seconds: Math.ceil(duration * 1000) / 1000, mime_type: 'audio/wav', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() };
    await this.verify(asset, signal);
    await this.store.transaction(async state => { state.speech_assets ??= Object.create(null); state.speech_assets![asset.speech_asset_id] = asset; await this.store.save(state); });
    const { url: _url, file_id: _file, ...publicAsset } = asset;
    return { ...publicAsset, status: 'ready', storage_notice: storageNotice };
  }
  private async verify(asset: SpeechAsset, signal?: AbortSignal) {
    for (let page = 1; page <= 20; page++) {
      const result = record(await this.api.request(`/sts/file_list?${new URLSearchParams({ is_record: '0', product_id: '1', page_size: '100', page_num: String(page) })}`, { signal }));
      if (!Array.isArray(result.data_list)) throw new TopMediaiError('INVALID_RESPONSE', 'Speech file list is invalid.');
      const rows = result.data_list.map(record), row = rows.find(item => item.file_id === asset.file_id);
      if (row) {
        if (row.oss_url !== asset.url || numeric(row.file_size) !== asset.bytes || numeric(row.file_time) / 1000 !== asset.duration_seconds || row.mime_type !== 'wav' || numeric(row.is_record) !== 0) throw new TopMediaiError('SPEECH_ASSET_CHANGED', 'The registered speech audio changed. Upload and estimate it again.');
        return;
      }
      if (rows.length < 100) break;
    }
    throw new TopMediaiError('SPEECH_ASSET_NOT_FOUND', 'Speech audio is not present in the current account file list. No synthesis was submitted.');
  }
  async asset(id: string, refresh = true, signal?: AbortSignal): Promise<SpeechAsset> {
    assertSpeechContract(this.config);
    const saved = await this.store.transaction(async state => state.speech_assets?.[id]);
    if (!saved || !saved.url || Date.parse(saved.expires_at) <= Date.now()) throw new TopMediaiError('SPEECH_ASSET_NOT_FOUND', 'Upload speech audio for this account and environment first.');
    speechAudioUrl(saved.url, this.config);
    if (refresh) await this.verify(saved, signal);
    return saved;
  }
}
