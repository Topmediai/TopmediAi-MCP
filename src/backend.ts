import { usesDirectApis, type Config } from './config.js';
import { TopMediaiError, type ImageParams, type PriceRow } from './types.js';
import { referenceUrl } from './reference-url.js';
import { readJson } from './transport/json.js';
import { defaultUploadPublicOrigin } from './upload-config.js';
import { WEB_MODELS, imageContract, imagePriceSupported } from './catalog/models.js';
import { backendResponseError, transportError } from './transport/errors.js';

export const SUPPORTED_MODELS = WEB_MODELS.images.map(model => model.id);
export const IMAGE_TO_IMAGE_MODELS = WEB_MODELS.images.filter(model => model.operations.image).map(model => model.id);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TopMediaiError('INVALID_RESPONSE', 'The backend returned an unexpected response shape.');
  return value as Record<string, unknown>;
}
function finite(value: unknown): number {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) throw new TopMediaiError('INVALID_RESPONSE', 'A required numeric value is missing.');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TopMediaiError('INVALID_RESPONSE', 'A required numeric value is invalid.');
  return number;
}
export class Backend {
  constructor(private readonly config: Config) {}
  async request(origin: string, path: string, body?: unknown): Promise<unknown> {
    const authenticated = !!this.config.token;
    const multipart = body instanceof FormData;
    const started = performance.now(), timeout = AbortSignal.timeout(this.config.timeoutMs);
    let httpStatus: number | undefined;
    const timing = () => ({ http_status: httpStatus, timeout_ms: this.config.timeoutMs, elapsed_ms: Math.round(performance.now() - started) });
    try {
      const response = await fetch(new URL(path, origin), {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(authenticated ? { token: this.config.token } : {}),
          ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : multipart ? body as FormData : JSON.stringify(body),
        signal: timeout,
      });
      httpStatus = response.status;
      if (httpStatus === 401) throw backendResponseError(undefined, timing())!;
      if (!response.ok) {
        let payload: unknown;
        if (response.headers.get('content-type')?.includes('application/json')) { try { payload = await readJson(response); } catch { /* HTTP status remains available for unreadable error bodies. */ } }
        throw backendResponseError(payload, timing(), [this.config.token])!;
      }
      const result = object(await readJson(response));
      const rejected = backendResponseError(result, timing(), [this.config.token]);
      if (rejected) throw rejected;
      if (result.data === null || result.data === undefined) throw new TopMediaiError('INVALID_RESPONSE', 'Backend response data is missing.');
      return result.data;
    } catch (error) {
      throw transportError(error, timing(), timeout);
    }
  }
  requireToken(): void {
    if (!this.config.token) throw new TopMediaiError('LOGIN_REQUIRED', 'Complete the local website login, then check service status and balance before using account tools.');
  }
  async prices(): Promise<PriceRow[]> {
    const data = object(await this.request(this.config.gatewayHost ?? this.config.imageHost,
      this.config.gatewayHost ? '/client/openclaw/v1/image/models' : '/v3/draw/model-consume'));
    if (!Array.isArray(data.list)) throw new TopMediaiError('INVALID_RESPONSE', 'Image price rows are missing.');
    return data.list.map(value => {
      const row = object(value);
      const points = finite(row.points);
      if (points < 0) throw new TopMediaiError('INVALID_RESPONSE', 'The image credit estimate must be non-negative.');
      return {
        model_type: finite(row.model_type), model_name: String(row.model_name ?? ''),
        quality: finite(row.quality), quality_name: String(row.quality_name ?? ''),
        image_quality: finite(row.image_quality), image_quality_name: String(row.image_quality_name ?? ''),
        points, version: String(row.version ?? data.version ?? ''),
      };
    }).filter(row => imagePriceSupported(row.model_type, row.quality, row.image_quality));
  }
  async balance(): Promise<{ credits: number; unlimited: boolean }> {
    this.requireToken();
    const data = object(await this.request(this.config.gatewayHost ?? this.config.memberHost,
      this.config.gatewayHost ? '/client/openclaw/v1/balance' : '/user/permission/info?product_name=tp_all&product_type=1'));
    const credits = finite(object(data.tp_all).left);
    if (credits < 0 && credits !== -1) throw new TopMediaiError('INVALID_RESPONSE', 'The credit balance is invalid.');
    return { credits, unlimited: credits === -1 };
  }
  async create(params: ImageParams): Promise<string> {
    this.requireToken();
    const editing = params.image_urls !== undefined;
    if (!imageContract(params.model_type, editing)) throw new TopMediaiError('UNSUPPORTED_OPTIONS', 'Select a current model and operation from list_image_models.');
    if (editing && (!params.image_urls?.length || params.image_urls.length > (imageContract(params.model_type, true)?.max_reference_images ?? 0))) {
      throw new TopMediaiError('UNSUPPORTED_OPTIONS', 'Reference images exceed the selected model capability.');
    }
    if (editing && !usesDirectApis(this.config)) {
      throw new TopMediaiError('IMAGE_TO_IMAGE_UNAVAILABLE', 'The production gateway has not enabled the image-to-image contract.');
    }
    if (editing) params.image_urls!.forEach(url => referenceUrl(url, this.config.uploadPublicOrigin ?? defaultUploadPublicOrigin(this.config.environment)));
    // This paid request is deliberately a single fetch. A timeout/redirect/401 must never replay it.
    const data = object(await this.request(this.config.gatewayHost ?? this.config.imageHost,
      this.config.gatewayHost ? '/client/openclaw/v1/image/generate' : editing ? '/v3/draw/image-to-image' : '/v3/draw/text-to-image', {
      ...params, source: this.config.source, translation: 0, is_public: 0, web_search: 0,
    }));
    const id = String(data.group_id ?? '');
    if (!/^[0-9]{1,64}$/.test(id) || /^0+$/.test(id)) throw new TopMediaiError('INVALID_RESPONSE', 'The backend did not return a valid group_id.');
    return id;
  }
  async detail(groupId: string): Promise<{ status: 'running' | 'completed' | 'failed'; images: { url: string; mime_type: string }[] }> {
    this.requireToken();
    if (!/^[0-9]{1,64}$/.test(groupId) || /^0+$/.test(groupId)) throw new TopMediaiError('INVALID_REQUEST', 'Image group_id must contain 1–64 decimal digits and be greater than zero.');
    const data = object(await this.request(this.config.gatewayHost ?? this.config.imageHost,
      this.config.gatewayHost ? `/client/openclaw/v1/image/tasks/${groupId}` : `/v3/draw/detail/${groupId}`));
    if (String(data.group_id) !== groupId) throw new TopMediaiError('INVALID_RESPONSE', 'The backend returned a different image group.');
    const entries = data.image_data == null ? [] : data.image_data;
    const tasks = data.task_ids == null ? [] : data.task_ids;
    if (!Array.isArray(entries) || !Array.isArray(tasks)) throw new TopMediaiError('INVALID_RESPONSE', 'Image task data is invalid.');
    const images = entries.flatMap(item => {
      const raw = object(item).image_url;
      if (typeof raw !== 'string' || !raw) return [];
      let url: URL;
      try { url = new URL(raw); } catch { throw new TopMediaiError('INVALID_RESPONSE', 'The backend image URL is invalid.'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TopMediaiError('INVALID_RESPONSE', 'The backend image URL is invalid.');
      const ext = url.pathname.toLowerCase();
      const mime_type = ext.endsWith('.webp') ? 'image/webp' : /\.jpe?g$/.test(ext) ? 'image/jpeg' : 'image/png';
      return [{ url: url.href, mime_type }];
    });
    return { status: tasks.length ? 'running' : images.length ? 'completed' : 'failed', images };
  }
}
