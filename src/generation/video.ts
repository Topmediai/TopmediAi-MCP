import { z } from 'zod';
import { usesDirectApis, type Config } from '../config.js';
import { TopMediaiError, type ReferenceImage, type ReferenceMedia } from '../types.js';
import { mediaReferenceUrl } from '../media/reference-media.js';
import { Store } from '../store.js';
import { referenceUrl } from '../reference-url.js';
import { defaultUploadPublicOrigin } from '../upload-config.js';
import { BusinessTransport, record, numeric, identity } from '../transport/business.js';
import { videoResultArtifact } from '../media/video-result.js';
import type { Adapter, GenerationTask, Outcome } from './types.js';
import { WEB_MODELS, videoModel, videoContract, videoSeconds, optionMatches } from '../catalog/models.js';
import { isHighPriceModel } from '../display-policy.js';

export const videoOperationSchema = z.enum(['text_to_video', 'image_to_video', 'image_to_video_start_end', 'reference_to_video', 'omni_reference_to_video']);
export type VideoOperation = z.infer<typeof videoOperationSchema>;
const taskTypes: Record<VideoOperation, number> = { text_to_video: 1, image_to_video: 2, image_to_video_start_end: 4, reference_to_video: 10, omni_reference_to_video: 14 };
export const referenceModels = Object.fromEntries(WEB_MODELS.videos.filter(model => model.operations.reference_to_video).map(model => {
  const c = model.operations.reference_to_video!, limits = c.reference_upload_limits;
  const omni = [26, 33, 36, 38].includes(model.id);
  return [model.id, { duration: model.duration_protocol ?? c.durations[0]!.value, modes: c.modes.map(m => m.value),
    min_seconds: Math.min(...c.durations.map(d => d.seconds)), max_seconds: Math.max(...c.durations.map(d => d.seconds)),
    images: Number(limits?.maxImages ?? (omni || [32, 37].includes(model.id) ? 9 : model.id === 2 ? 3 : 7)),
    videos: Number(limits?.maxVideos ?? (omni ? 3 : 0)), audios: Number(limits?.maxAudios ?? (omni ? 3 : 0)),
    total: Number(limits?.maxTotal ?? (omni ? 12 : model.id === 2 ? 3 : [32, 37].includes(model.id) ? 9 : 7)),
    media_max_seconds: Number(limits?.videoMaxTotalDuration ?? 15) + 0.2, omni }];
})) as Record<number, { duration: number; modes: number[]; min_seconds: number; max_seconds: number; images: number; videos: number; audios: number; total: number; media_max_seconds: number; omni: boolean }>;
const frameAsReference = (id: number, operation: VideoOperation) => operation === 'image_to_video' && [2, 16, 31].includes(id);
function billingTaskType(id: number, operation: VideoOperation) { return frameAsReference(id, operation) ? 10 : taskTypes[operation]; }
function hasAudioSwitch(id: number, operation: VideoOperation) {
  return !!videoContract(id, operation)?.request_params.includes('generate_audio_switch');
}
function audioSwitch(id: number, operation: VideoOperation, requested?: boolean) {
  return videoModel(id)?.forced_audio || (hasAudioSwitch(id, operation) && requested !== false) ? 1 : 0;
}
function supportsAudioChoice(id: number, operation: VideoOperation, requested?: boolean) {
  if (videoModel(id)?.forced_audio) return requested !== false;
  return requested !== true || hasAudioSwitch(id, operation);
}
export function videoOperation(params: Record<string, unknown>): VideoOperation {
  if (params.operation) return params.operation as VideoOperation;
  if (params.reference_video_ids || params.reference_audio_ids) return 'omni_reference_to_video';
  if (params.reference_images) return 'reference_to_video';
  return params.end_reference_image_id ? 'image_to_video_start_end' : params.first_reference_image_id ? 'image_to_video' : 'text_to_video';
}
function isReference(operation: VideoOperation) { return operation === 'reference_to_video' || operation === 'omni_reference_to_video'; }
function ruleCost(value: unknown, realDuration: number, perSecond: boolean): number {
  const amount = numeric(value);
  if (!perSecond) return amount;
  // Mirror Decimal(str(unit_price)) * seconds, quantized with ROUND_HALF_UP.
  const match = String(amount).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i)!;
  const decimals = match[2] ?? '', scale = decimals.length - Number(match[3] ?? 0);
  const coefficient = BigInt(match[1]! + decimals) * BigInt(realDuration);
  const divisor = scale > 2 ? 10n ** BigInt(scale - 2) : 1n;
  const cents = scale > 2 ? (coefficient + divisor / 2n) / divisor : coefficient * 10n ** BigInt(2 - scale);
  return Number(cents) / 100;
}
function combination(model: number, duration: number, mode: number, operation: VideoOperation = 'text_to_video', realDuration?: number) {
  const m = videoModel(model), c = videoContract(model, operation);
  if (!m || !c || (operation === 'omni_reference_to_video' && !referenceModels[model]?.omni)) return false;
  if (operation === 'image_to_video_start_end' && !c.request_params.includes('end_image_url')) return false;
  if (m.duration_protocol !== undefined && duration !== m.duration_protocol) return false;
  const modes = c.modes.filter(o => o.value === mode);
  return c.durations.some(d => (m.duration_protocol !== undefined ? realDuration === undefined || d.seconds === realDuration : d.value === duration && (realDuration === undefined || d.seconds === realDuration))
    && modes.some(mo => {
      const values = { mode, duration: d.value, end_image_url: operation === 'image_to_video_start_end' };
      return optionMatches(d, values) && optionMatches(mo, values);
    })
    // Cross-check fixed-duration restrictions against the business backend.
    && !(duration === 10 && mode === 4) && !(duration === 3 && mode !== 8)
    && !(duration === 43 && mode === 45) && !(duration === 37 && ![38, 39].includes(mode)));
}
export const videoAudioSchema = z.boolean().optional().describe('Omit when the user has no sound preference: audio defaults to on for operations with an audio switch. Set false only when the user explicitly requests silent or muted video. Models without a switch retain provider behavior; Grok always generates audio. Keep this setting consistent in list_video_models and the quote.');
export const videoSchema = z.strictObject({
  content: z.string().trim().min(1).max(10000),
  model_type: z.number().int(),
  duration: z.number().int().describe('Backend duration enum ID from list_video_models, not seconds.'),
  mode: z.number().int().describe('Backend quality enum ID from list_video_models.'),
  aspect_ratio: z.number().int().min(0).max(8).default(1).describe('Select a ratio from this model’s operation capabilities. Frame models may derive it from the first frame.'),
  first_reference_image_id: z.string().uuid().optional().describe('First frame reference_image_id from upload_reference_image in this account/environment. Omit for text-to-video.'),
  end_reference_image_id: z.string().uuid().optional().describe('Optional last frame reference_image_id. Requires a first frame and a model/duration that supports end frames.'),
  operation: videoOperationSchema.optional().describe('Reference images infer reference_to_video; video/audio references infer omni_reference_to_video. Select omni explicitly for image-only all-in-one.'),
  real_duration: z.number().int().min(1).max(30).optional().describe('Required real seconds for variable-duration models and reference operations. Use the backend duration protocol ID, never a UI duration ID.'),
  generate_audio: videoAudioSchema,
  reference_images: z.array(z.strictObject({ reference_image_id: z.string().uuid(), type: z.enum(['subject', 'background']).default('subject') })).min(1).max(30).optional(),
  reference_video_ids: z.array(z.string().uuid()).min(1).max(10).optional(),
  reference_audio_ids: z.array(z.string().uuid()).min(1).max(10).optional(),
}).superRefine((p, ctx) => {
  const operation = videoOperation(p), reference = isReference(operation);
  const imageIds = p.reference_images?.map(image => image.reference_image_id) ?? [], videoIds = p.reference_video_ids ?? [], audioIds = p.reference_audio_ids ?? [];
  const ids = [...imageIds, ...videoIds, ...audioIds];
  const contract = videoContract(p.model_type, operation), model = videoModel(p.model_type);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Reference material IDs must be unique.' });
  if (reference) {
    if (p.first_reference_image_id || p.end_reference_image_id) ctx.addIssue({ code: 'custom', message: 'Reference generation cannot also use first/last frames.' });
    if (!ids.length || (!imageIds.length && !videoIds.length)) ctx.addIssue({ code: 'custom', message: 'Reference generation requires an image or video; audio alone is not supported.' });
    if (operation === 'reference_to_video' && (videoIds.length || audioIds.length)) ctx.addIssue({ code: 'custom', message: 'Video/audio references require omni_reference_to_video.' });
    if (p.real_duration === undefined) ctx.addIssue({ code: 'custom', message: 'Reference models require real_duration in seconds.' });
    const limits = referenceModels[p.model_type];
    if (!limits || imageIds.length > limits.images || videoIds.length > limits.videos || audioIds.length > limits.audios || ids.length > limits.total) ctx.addIssue({ code: 'custom', message: 'The reference material count exceeds this model limit.' });
  } else {
    if (ids.length) ctx.addIssue({ code: 'custom', message: 'Reference material lists require a reference operation.' });
    const inferred = p.end_reference_image_id ? 'image_to_video_start_end' : p.first_reference_image_id ? 'image_to_video' : 'text_to_video';
    if (operation !== inferred) ctx.addIssue({ code: 'custom', message: 'The selected operation does not match the frame inputs.' });
  }
  if (model?.duration_protocol !== undefined && p.real_duration === undefined) ctx.addIssue({ code: 'custom', path: ['real_duration'], message: 'This variable-duration model requires real_duration in seconds.' });
  if (p.generate_audio === false && model?.forced_audio) ctx.addIssue({ code: 'custom', message: 'This model always generates audio.' });
  if (!model?.forced_audio && !supportsAudioChoice(p.model_type, operation, p.generate_audio)) ctx.addIssue({ code: 'custom', message: 'This model does not expose a generated-audio switch for this operation.' });
  if (contract && p.content.length > contract.prompt_max_length) ctx.addIssue({ code: 'custom', path: ['content'], message: 'The prompt exceeds this model limit.' });
  if (contract?.aspect_ratios.length && !contract.aspect_ratios.some(ratio => ratio.value === p.aspect_ratio)) ctx.addIssue({ code: 'custom', path: ['aspect_ratio'], message: 'The ratio is not supported by this model.' });
  for (const match of p.content.matchAll(/@(?:Image|Video|Audio)(\d+)\b/g)) {
    const count = match[0].startsWith('@Image') ? imageIds.length : match[0].startsWith('@Video') ? videoIds.length : audioIds.length;
    if (reference && (Number(match[1]) < 1 || Number(match[1]) > count)) ctx.addIssue({ code: 'custom', message: 'A prompt reference index is outside the submitted material list.' });
  }
  if (p.end_reference_image_id && !p.first_reference_image_id) ctx.addIssue({ code: 'custom', message: 'A last frame requires a first frame.' });
  if (!combination(p.model_type, p.duration, p.mode, operation, p.real_duration)) ctx.addIssue({ code: 'custom', message: 'The model, duration, quality and reference combination has not been verified.' });
});
export class VideoAdapter implements Adapter {
  readonly kind = 'video';
  private readonly api: BusinessTransport;
  constructor(private readonly config: Config) { this.api = new BusinessTransport(config, config.ttsHost ?? config.memberHost, 'token'); }
  enabled() { return usesDirectApis(this.config) && !!this.config.ttsHost; }
  reason() { return this.enabled() ? undefined : 'Video generation requires a configured direct TTS/video backend; legacy gateways do not expose video routes. Existing upload URLs may be public.'; }
  validate(input: unknown) {
    const result = videoSchema.safeParse(input);
    if (!result.success) throw new TopMediaiError('INVALID_PARAMS', result.error.issues.map(i => i.message).join(' '));
    const params = result.data, operation = videoOperation(params);
    // Save the effective choice in new quotes so later default changes cannot alter it.
    // Leave provider-controlled models untouched to preserve their existing quote contracts.
    if (params.generate_audio === undefined && (videoModel(params.model_type)?.forced_audio || hasAudioSwitch(params.model_type, operation))) {
      return { ...params, generate_audio: !!audioSwitch(params.model_type, operation) };
    }
    return params;
  }
  async models(operation: VideoOperation = 'text_to_video', generateAudio?: boolean) {
    this.assertContract();
    operation = videoOperationSchema.parse(operation);
    const taskType = taskTypes[operation], priceData = new Map<number, Record<string, unknown>[]>(), priceErrors = new Map<number, string>();
    const tasks = [taskType, ...((operation === 'image_to_video') ? [10] : [])];
    for (const task of tasks) {
      try {
        const data = record(await this.api.request(`/ai_video/price/model_cost?task_type=${task}&multiple_shot=0`));
        if (!Array.isArray(data.models)) throw new TopMediaiError('INVALID_RESPONSE', 'Video model prices are missing.');
        priceData.set(task, data.models.map(record));
      } catch (error) { priceErrors.set(task, error instanceof TopMediaiError ? error.code : 'PRICE_UNAVAILABLE'); }
    }
    const models = WEB_MODELS.videos.flatMap(model => {
      const id = model.id, c = videoContract(id, operation);
      if (!c || (operation === 'omni_reference_to_video' && !referenceModels[id]?.omni)
        || (operation === 'image_to_video_start_end' && !c.request_params.includes('end_image_url'))) return [];
      const effectiveTask = billingTaskType(id, operation), audio = audioSwitch(id, operation, generateAudio);
      const priceModel = priceData.get(effectiveTask)?.find(row => Number(row.model_type) === id);
      let pricing: Record<string, unknown>[] = [], pricingError: string | undefined;
      if (supportsAudioChoice(id, operation, generateAudio) && Array.isArray(priceModel?.pricing)) {
        try { pricing = priceModel.pricing.map(record).filter(row => combination(id, Number(row.duration), Number(row.mode), operation, Number(row.real_duration) > 0 ? Number(row.real_duration) : undefined)
          && (row.task_type === undefined || [-1, effectiveTask].includes(Number(row.task_type)))
          && (row.generate_audio_switch === undefined || [-1, audio].includes(Number(row.generate_audio_switch)))
          && (row.multiple_shot === undefined || [-1, 0].includes(Number(row.multiple_shot)))).map(row => ({ model_type: id, duration: numeric(row.duration),
            duration_seconds: model.duration_protocol !== undefined ? (Number(row.real_duration) > 0 ? Number(row.real_duration) : null) : videoSeconds(id, Number(row.duration), undefined, operation),
            real_duration: Number(row.real_duration) > 0 ? Number(row.real_duration) : null, generate_audio: !!audio,
            ...(isReference(operation) ? { limits: referenceModels[id] } : {}),
            billing_basis: Number(row.real_duration) === -1 ? 'per_second' : 'total',
            video_duration_min: row.video_duration_min ?? null, video_duration_max: row.video_duration_max ?? null, video_duration_rule: row.video_duration_rule ?? null,
            mode: numeric(row.mode), quality: String(row.quality ?? ''), version: String(row.version ?? ''), video_units: numeric(row.consume), rule_credits: row.points == null ? null : numeric(row.points) }));
        } catch (error) { pricingError = error instanceof TopMediaiError ? error.code : 'PRICE_UNAVAILABLE'; }
      }
      return [{ model_type: id, model_name: model.name, high_price: isHighPriceModel(model.name), recommended: model.visible, operation, task_type: effectiveTask, pricing,
        pricing_status: pricingError ?? priceErrors.get(effectiveTask) ?? (pricing.length ? 'available' : 'not_configured'),
        requested_audio_supported: supportsAudioChoice(id, operation, generateAudio), generate_audio: !!audio,
        capabilities: { modes: c.modes, aspect_ratios: c.aspect_ratios, prompt_max_length: c.prompt_max_length,
          durations: c.durations.filter(d => !d.disabled).map(d => ({ duration: model.duration_protocol ?? d.value, seconds: d.seconds, real_duration_required: model.duration_protocol !== undefined || isReference(operation), ...(d.only_for ? { only_for: d.only_for } : {}) })),
          supports_end_frame: !!model.operations.image_to_video?.request_params.includes('end_image_url'),
          audio: model.forced_audio ? 'always_on' : c.request_params.includes('generate_audio_switch') ? 'optional' : 'provider_default',
          ...(model.forced_audio || hasAudioSwitch(id, operation) ? { default_generate_audio: true } : {}),
          ...(isReference(operation) ? { reference_limits: referenceModels[id] } : {}) } }];
    });
    return { models, operation, task_type: taskType, default_model_type: WEB_MODELS.defaults.video, source_revision: WEB_MODELS.source_revision,
      note: 'The complete operation catalog is shown independently of price availability. Use each model’s backend duration protocol and allowed real seconds. Pricing rows may be per-second units; use an exact quote. Audio defaults to on for operations with an audio switch unless the user requests silent video; models without a switch retain provider behavior and forced-audio models remain on.' };
  }
  private imageIds(params: Record<string, unknown>): string[] {
    return (params.reference_images as { reference_image_id: string }[] | undefined)?.map(image => image.reference_image_id)
      ?? [params.first_reference_image_id, params.end_reference_image_id].filter((id): id is string => typeof id === 'string');
  }
  private async references(params: Record<string, unknown>) {
    const ids = this.imageIds(params), videoIds = (params.reference_video_ids as string[] | undefined) ?? [], audioIds = (params.reference_audio_ids as string[] | undefined) ?? [];
    if (!ids.length && !videoIds.length && !audioIds.length) return { images: [], media: [] };
    return new Store(this.config.dataDir).transaction(async state => {
      const images = ids.map(id => {
      const asset = state.reference_images?.[id];
      if (!asset || asset.reference_image_id !== id) throw new TopMediaiError('REFERENCE_IMAGE_NOT_FOUND', 'Upload this frame in the current account/environment first.');
      this.reference(asset);
      return asset;
      });
      const media = [...videoIds, ...audioIds].map((id, index) => {
        const asset = state.reference_media?.[id], kind = index < videoIds.length ? 'video' : 'audio';
        if (!asset || asset.reference_media_id !== id || asset.media_type !== kind) throw new TopMediaiError('REFERENCE_MEDIA_NOT_FOUND', 'Upload this reference in the current account/environment with the correct media type.');
        this.media(asset); return asset;
      });
      this.validateReferences(params, images, media);
      return { images, media };
    });
  }
  private media(asset: ReferenceMedia): string {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isFinite(asset.duration_seconds) || asset.duration_seconds < 2 || asset.duration_seconds > 30.2
      || !Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > (asset.media_type === 'video' ? 50 : 5) * 1024 * 1024
      || asset.mime_type !== (asset.media_type === 'video' ? 'video/mp4' : 'audio/wav')
      || (asset.media_type === 'video' && (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width! < 64 || asset.height! < 64 || asset.width! > 1280 || asset.height! > 720 || !Number.isFinite(asset.fps) || asset.fps! < 1 || asset.fps! > 30))) {
      throw new TopMediaiError('INVALID_REFERENCE_MEDIA', 'The reference media record is invalid. Upload it again.');
    }
    return mediaReferenceUrl(asset.url, this.config.uploadPublicOrigin ?? defaultUploadPublicOrigin(this.config.environment), asset.media_type);
  }
  private validateReferences(params: Record<string, unknown>, images: ReferenceImage[], media: ReferenceMedia[]) {
    if (!isReference(videoOperation(params)) && !frameAsReference(Number(params.model_type), videoOperation(params))) return;
    const limits = referenceModels[Number(params.model_type)], minimum = [32, 37].includes(Number(params.model_type)) ? 400 : 300;
    for (const image of images) if (image.width < minimum || image.height < minimum || Math.max(image.width, image.height) > (limits?.omni ? 6000 : 4000)
      || ([30, 34].includes(Number(params.model_type)) && (image.width > 3000 || image.height > 4000))
      || ([32, 37].includes(Number(params.model_type)) && (image.width / image.height < 0.4 || image.width / image.height > 2.5))) throw new TopMediaiError('INVALID_REFERENCE_FILE', 'Reference images must satisfy this model’s dimensions and aspect ratio.');
    for (const kind of ['video', 'audio'] as const) {
      const duration = media.filter(asset => asset.media_type === kind).reduce((sum, asset) => sum + asset.duration_seconds, 0);
      if (duration > (limits?.media_max_seconds ?? 15.2)) throw new TopMediaiError('INVALID_REFERENCE_MEDIA', 'The total reference duration exceeds this model limit.');
    }
    if (Number(params.model_type) === 38 && (images.reduce((sum, asset) => sum + asset.bytes, 0) > 64 * 1024 * 1024
      || media.filter(asset => asset.media_type === 'audio').reduce((sum, asset) => sum + asset.bytes, 0) > 64 * 1024 * 1024)) throw new TopMediaiError('INVALID_REFERENCE_MEDIA', 'Seedance 2.5 reference material size exceeds its aggregate limit.');
  }
  private reference(asset: ReferenceImage): string {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !['image/png', 'image/jpeg'].includes(asset.mime_type)
      || !Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 5 * 1024 * 1024
      || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1
      || asset.width > 8192 || asset.height > 8192 || asset.width * asset.height > 24_000_000) {
      throw new TopMediaiError('INVALID_REFERENCE_FILE', 'The uploaded frame record is invalid. Upload the image again.');
    }
    return referenceUrl(asset.url, this.config.uploadPublicOrigin ?? defaultUploadPublicOrigin(this.config.environment));
  }
  async estimate(params: Record<string, unknown>) {
    this.assertContract();
    params = this.validate(params);
    const { images: referenceImages, media: referenceMedia } = await this.references(params), operation = videoOperation(params);
    const videoDuration = Math.floor(referenceMedia.filter(asset => asset.media_type === 'video').reduce((sum, asset) => sum + asset.duration_seconds, 0));
    const body = { model_type: params.model_type, duration: params.duration, mode: params.mode, real_duration: videoSeconds(Number(params.model_type), Number(params.duration), params.real_duration as number | undefined, operation), task_type: billingTaskType(Number(params.model_type), operation), generate_audio_switch: audioSwitch(Number(params.model_type), operation, params.generate_audio as boolean | undefined), multiple_shot: 0,
      ...(isReference(operation) ? { video_duration: videoDuration } : {}) };
    const data = record(await this.api.request('/ai_video/price/preview', { body }));
    for (const field of ['model_type', 'duration', 'mode']) if (numeric(data[field]) !== params[field]) throw new TopMediaiError('PRICE_UNAVAILABLE', 'Video price preview does not match the requested parameters.');
    if (typeof data.version !== 'string' || !data.version) throw new TopMediaiError('PRICE_UNAVAILABLE', 'An authoritative video price version is required.');
    if (data.task_type !== undefined && ![-1, body.task_type].includes(numeric(data.task_type, -1))) throw new TopMediaiError('PRICE_UNAVAILABLE', 'Video price preview belongs to another operation.');
    // Actual settlement converts the effective consume through get_all_consume;
    // a price table's display points can differ from that conversion.
    const effective = record(await this.api.request('/ai_video/consume_preview', { body }));
    for (const field of ['model_type', 'duration', 'mode']) if (numeric(effective[field]) !== params[field]) throw new TopMediaiError('PRICE_UNAVAILABLE', 'Video entitlement preview does not match the requested parameters.');
    for (const field of ['task_type', 'real_duration', 'generate_audio_switch', 'multiple_shot'] as const) {
      if ((operation !== 'text_to_video' || params.real_duration !== undefined || params.generate_audio !== undefined || videoModel(Number(params.model_type))?.forced_audio || effective[field] !== undefined)
        && numeric(effective[field]) !== body[field]) throw new TopMediaiError('PRICE_UNAVAILABLE', 'Video entitlement preview does not match the requested operation.');
    }
    if (isReference(operation) && numeric(effective.video_duration) !== videoDuration) throw new TopMediaiError('PRICE_UNAVAILABLE', 'The price preview does not match reference video duration.');
    const expectedConsume = ruleCost(data.consume, Number(body.real_duration), Number(data.real_duration) === -1);
    if (numeric(effective.consume) !== expectedConsume) throw new TopMediaiError('PRICE_UNAVAILABLE', 'Video price and effective entitlement preview disagree.');
    const costs = [{ resource: 'video_units' as const, amount: numeric(effective.consume) }, { resource: 'credits' as const, amount: numeric(effective.points) }];
    return { costs, price_version: data.version, reference_images: referenceImages, reference_media: referenceMedia, pricing: { costs, version: data.version, rule: data.price_rule_id ?? null, model_type: data.model_type, duration: data.duration, mode: data.mode,
      // Preserve the existing text-only quote digest across this upgrade.
      ...(referenceImages.length ? { operation, task_type: body.task_type, reference_images: referenceImages } : {}),
      // Preserve legacy no-reference digests when all newly exposed options are absent.
      ...(isReference(operation) || params.real_duration !== undefined || params.generate_audio !== undefined || videoModel(Number(params.model_type))?.forced_audio ? { operation, billing: body, reference_media: referenceMedia } : {}) } };
  }
  async create(params: Record<string, unknown>, referenceImages?: ReferenceImage[], referenceMedia?: ReferenceMedia[]): Promise<Outcome> {
    this.assertContract();
    const parsed = this.validate(params);
    const { first_reference_image_id, end_reference_image_id, aspect_ratio, content, operation: _operation, reference_images: imageInputs,
      reference_video_ids, reference_audio_ids, generate_audio, real_duration, ...base } = parsed;
    const snapshot = referenceImages && referenceMedia ? { images: referenceImages, media: referenceMedia } : await this.references(parsed);
    // Legacy callers may supply only the first/last frame snapshot.
    const references = referenceImages ?? snapshot.images, media = referenceMedia ?? snapshot.media, ids = this.imageIds(parsed);
    if (ids.length !== references.length || references.some((asset, index) => asset.reference_image_id !== ids[index])) throw new TopMediaiError('REFERENCE_IMAGE_CHANGED', 'The quoted frames no longer match. Obtain a new quote.');
    const urls = references.map(asset => this.reference(asset));
    this.validateReferences(parsed, references, media);
    const mediaIds = [...((reference_video_ids as string[] | undefined) ?? []), ...((reference_audio_ids as string[] | undefined) ?? [])];
    if (mediaIds.length !== media.length || media.some((asset, index) => asset.reference_media_id !== mediaIds[index])) throw new TopMediaiError('REFERENCE_IMAGE_CHANGED', 'The quoted media no longer match. Obtain a new quote.');
    const operation = videoOperation(parsed), reference = isReference(operation);
    let prompt = String(content);
    if (reference) prompt = prompt.replace(/@(Image|Video|Audio)(\d+)\b/g, (_, kind: string, index: string) => parsed.model_type === 24 ? `<<<image_${index}>>>` : referenceModels[Number(parsed.model_type)]?.omni ? `[${kind}${index}]` : `@${kind}${index}`);
    const fusion = (imageInputs as { type: string }[] | undefined)?.map((image, index) => ({ type: image.type, img_url: urls[index], ...([30, 34].includes(Number(parsed.model_type)) ? { ref_name: `Image${index + 1}` } : {}) }));
    const referenceBody = reference ? { fusion_imgs: fusion ?? [], aspect_ratio,
      ...(referenceModels[Number(parsed.model_type)]?.omni ? { seedance_generation_mode: operation === 'omni_reference_to_video' ? 'allInOne' : 'keyframes',
        video_list: media.filter(asset => asset.media_type === 'video').map(asset => this.media(asset)), audio_list: media.filter(asset => asset.media_type === 'audio').map(asset => this.media(asset)) } : {}) } : {};
    // The backend infers task_type from these frame URLs. shot_content is the
    // actual generation prompt; content is retained for legacy task metadata.
    const data = record(await this.api.request('/ai_video/generation', { body: { ...base, content, shot_content: prompt,
      ...(reference ? referenceBody : frameAsReference(Number(parsed.model_type), operation) ? { fusion_imgs: urls.map(img_url => ({ type: 'subject', img_url })), aspect_ratio }
        : urls.length ? { first_image_url: urls[0], ...(urls[1] ? { end_image_url: urls[1] } : {}) } : { aspect_ratio }),
      real_duration: videoSeconds(Number(parsed.model_type), Number(parsed.duration), real_duration as number | undefined, operation), is_public: '0', source: this.config.source,
      generate_audio_switch: String(audioSwitch(Number(parsed.model_type), operation, generate_audio as boolean | undefined)), multiple_shot: '0', add_bgm: 0 } }));
    return { status: 'queued', remote: { task_id: identity(data.task_id) }, artifacts: [] };
  }
  async poll(task: GenerationTask): Promise<Outcome> {
    this.assertContract();
    const id = identity(task.remote.task_id);
    if (!/^[1-9][0-9]*$/.test(id)) throw new TopMediaiError('INVALID_RESPONSE', 'Video task IDs must be positive decimal strings.');
    // Query the authenticated, account-scoped batch endpoint.
    const result = record(await this.api.request(`/ai_video/batch/detail?${new URLSearchParams({ task_ids: id })}`));
    if (!Array.isArray(result.data_list) || result.data_list.length > 1) throw new TopMediaiError('INVALID_RESPONSE', 'Private video results are invalid.');
    if (!result.data_list.length) return { status: 'unknown', remote: task.remote, artifacts: [] };
    const data = record(result.data_list[0]);
    if (identity(data.task_id) !== id) throw new TopMediaiError('INVALID_RESPONSE', 'Video result belongs to another task.');
    const status = ({ 1: 'running', 2: 'completed', 3: 'failed' } as const)[Number(data.task_status) as 1 | 2 | 3] ?? 'unknown';
    // The legacy video response calls its watermarked video field audio_url.
    const artifact = videoResultArtifact(data.audio_url);
    return { status, remote: task.remote, artifacts: artifact ? [artifact] : [] };
  }
  async entitlements() {
    this.assertContract();
    const member = new BusinessTransport(this.config, this.config.memberHost, 'token');
    const data = record(await member.request('/user/permission/info?product_name=ai_video&product_type=1'));
    return { video_units: numeric(record(data.ai_video).left, -1), credits: numeric(record(data.tp_all).left, -1) };
  }
  private assertContract() { if (!this.enabled()) throw new TopMediaiError('CAPABILITY_UNAVAILABLE', this.reason()!); }
}
