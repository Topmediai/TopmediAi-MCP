import { randomUUID } from 'node:crypto';
import { WEB_MODELS, imageContract } from './catalog/models.js';
import { usesDirectApis, type Config } from './config.js';
import { Backend } from './backend.js';
import { imageSchema } from './image-options.js';
import { MAX_REFERENCE_BYTES, ReferenceImages } from './reference-images.js';
import { Store } from './store.js';
import { TopMediaiError, type ImageEstimateParams, type ImageParams, type Quote, type State, type Task } from './types.js';
import { loginGuidance } from './onboarding.js';
import { defaultUploadPublicOrigin } from './upload-config.js';
import { balanceDisplay, isHighPriceModel, quoteDisplay, taskDisplay, validateCosts } from './display-policy.js';
import { pollAfterSeconds, remainingPollSeconds } from './task-polling.js';
import { requestFailure, UNKNOWN_SUBMISSION_RECOVERY } from './transport/errors.js';

export class ImageService {
  readonly store: Store;
  readonly backend: Backend;
  readonly references: ReferenceImages;
  constructor(readonly config: Config) {
    this.store = new Store(config.dataDir);
    this.backend = new Backend(config);
    this.references = new ReferenceImages(config, this.backend);
  }
  private wrap<T extends object>(data: T): T & { mode: string; environment: Config['environment']; simulated: boolean } {
    return { ...data, mode: this.config.mode, environment: this.config.environment, simulated: false };
  }
  status(credentialRefreshEnabled = false) {
    return this.wrap({ service: 'topmediai-mcp', token_configured: !!this.config.token,
      member_host: this.config.memberHost, image_host: this.config.imageHost,
      credential_source: this.config.credentialSource ?? (this.config.token ? 'environment' : 'none'), gateway_configured: !!this.config.gatewayHost,
      api_connection_mode: this.config.gatewayHost ? 'legacy_gateway' : 'direct',
      music_host: this.config.musicHost, tts_host: this.config.ttsHost,
      image_to_image_enabled: usesDirectApis(this.config),
      image_upload_enabled: this.references.enabled, upload_host: this.config.uploadHost,
      upload_public_origin: this.config.uploadPublicOrigin ?? defaultUploadPublicOrigin(this.config.environment),
      upload_configuration_warnings: [],
      reference_image_limit_bytes: MAX_REFERENCE_BYTES,
      credential_refresh_enabled: credentialRefreshEnabled,
      authentication_state: this.config.token ? 'credential_loaded' : 'login_required',
      authentication: 'Follow login_guidance to start official website login and wait for its result in this turn, then verify get_balance and resume the original request. A configured token is not proof of a valid backend session.',
      login_guidance: loginGuidance(this.config, credentialRefreshEnabled),
      ...(this.config.credentialSource === 'environment' ? { credential_override: 'An environment token overrides saved browser credentials.' } : {}) });
  }
  async models() {
    let rows: Awaited<ReturnType<Backend['prices']>> = [], priceError: string | undefined;
    try { rows = await this.backend.prices(); } catch (error) { priceError = error instanceof TopMediaiError ? error.code : 'PRICE_UNAVAILABLE'; }
    return this.wrap({ models: WEB_MODELS.images.map(model => ({ model_type: model.id, model_name: model.name, high_price: isHighPriceModel(model.name), recommended: model.visible,
      supports_text_to_image: !!model.operations.text, supports_image_to_image: usesDirectApis(this.config) && !!model.operations.image,
      capabilities: model.operations, pricing: rows.filter(row => row.model_type === model.id),
      pricing_status: priceError ?? (rows.some(row => row.model_type === model.id) ? 'available' : 'not_configured') })),
      default_model_type: WEB_MODELS.defaults.image, source_revision: WEB_MODELS.source_revision,
      note: 'The complete Web model catalog is shown independently of price availability. Select this model’s own options. Pricing is live; an exact quote is required before generation.' });
  }
  async balance() {
    const balance = await this.backend.balance();
    return this.wrap({ ...balance, display: { balances: balanceDisplay(balance) } });
  }
  private async price(params: ImageParams) {
    if (!imageContract(params.model_type, params.image_urls !== undefined)) throw new TopMediaiError('UNSUPPORTED_OPTIONS', 'Select a current model and operation from list_image_models.');
    if (params.image_urls) {
      if (!usesDirectApis(this.config)) throw new TopMediaiError('IMAGE_TO_IMAGE_UNAVAILABLE', 'The legacy gateway has not enabled the image-to-image contract.');
      if (!params.image_urls.length || params.image_urls.length > imageContract(params.model_type, true)!.max_reference_images) throw new TopMediaiError('INVALID_REQUEST', 'The reference count exceeds this model limit.');
      params.image_urls.forEach(url => this.references.url(url));
    }
    const rows = await this.backend.prices();
    const row = rows.find(row => row.model_type === params.model_type && row.quality === params.quality && row.image_quality === params.image_quality);
    if (!row) throw new TopMediaiError('UNSUPPORTED_OPTIONS', 'Call list_image_models and select an available model/quality/image_quality combination.');
    return { credits: Math.round((row.points * params.number + Number.EPSILON) * 100) / 100, version: row.version };
  }
  async uploadReferenceImage(filePath: string) {
    const asset = await this.references.upload(filePath);
    await this.store.transaction(async state => {
      state.reference_images ??= Object.create(null);
      state.reference_images![asset.reference_image_id] = asset;
      await this.store.save(state);
    });
    return this.wrap({ ...asset, storage_notice: 'The existing upload service may return a publicly retrievable URL. Upload only images authorized for external storage. No generation was submitted.' });
  }
  private referenceUrls(state: State, ids: string[]): string[] {
    return ids.map(id => {
      const asset = state.reference_images?.[id];
      if (!asset || asset.reference_image_id !== id) throw new TopMediaiError('REFERENCE_IMAGE_NOT_FOUND', 'Upload this reference image in the current account/environment first.');
      return this.references.url(asset.url);
    });
  }
  async estimate(input: ImageEstimateParams) {
    const parsed = imageSchema.safeParse(input);
    if (!parsed.success) throw new TopMediaiError('UNSUPPORTED_OPTIONS', parsed.error.issues.map(issue => issue.message).join(' '));
    const { reference_image_ids, ...base } = parsed.data;
    const image_urls = reference_image_ids
      ? await this.store.transaction(async state => this.referenceUrls(state, reference_image_ids)) : undefined;
    const params: ImageParams = { ...base, ...(image_urls ? { image_urls } : {}) };
    const price = await this.price(params);
    validateCosts([{ resource: 'credits', amount: price.credits }]);
    const quote: Quote = { ...price, quote_id: randomUUID(), params,
      ...(reference_image_ids ? { reference_image_ids: [...reference_image_ids] } : {}),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString() };
    await this.store.transaction(async state => {
      if (reference_image_ids && JSON.stringify(this.referenceUrls(state, reference_image_ids)) !== JSON.stringify(image_urls)) {
        throw new TopMediaiError('REFERENCE_IMAGE_CHANGED', 'The reference images changed while estimating. Create a new quote.');
      }
      state.quotes[quote.quote_id] = quote; await this.store.save(state);
    });
    return this.wrap({ ...quote, unit: 'credits', display: quoteDisplay('image', { ...quote.params }, [{ resource: 'credits', amount: quote.credits }]), note: 'Estimate from the selected price row. The backend chooses entitlements and performs final settlement.' });
  }
  private replay(task: Task, quoteId: string) {
    if (task.quote_id !== quoteId) throw new TopMediaiError('REQUEST_ID_CONFLICT', 'This request_id is already bound to another quote.');
    return this.taskResult(task, true);
  }
  private assertQuote(state: State, quoteId: string, maxCredits: number): Quote {
    const quote = state.quotes[quoteId];
    if (!quote) throw new TopMediaiError('QUOTE_NOT_FOUND', 'Create a quote in the current account/mode first.');
    if (Object.values(state.tasks).some(task => task.quote_id === quoteId)) throw new TopMediaiError('QUOTE_USED', 'This quote has already been submitted. Query the original request_id or obtain a distinct quote for new creation.');
    if (quote.params.image_urls || quote.reference_image_ids) {
      if (!quote.reference_image_ids || JSON.stringify(this.referenceUrls(state, quote.reference_image_ids)) !== JSON.stringify(quote.params.image_urls)) {
        throw new TopMediaiError('REFERENCE_IMAGE_CHANGED', 'The quoted reference images no longer match. Create a new quote before generating.');
      }
    }
    validateCosts([{ resource: 'credits', amount: quote.credits }]);
    if (!Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now()) throw new TopMediaiError('QUOTE_EXPIRED', 'The estimate expired. Create a new quote.');
    if (typeof maxCredits !== 'number' || !Number.isFinite(maxCredits) || maxCredits < 0) throw new TopMediaiError('BUDGET_EXCEEDED', 'A valid maximum estimated credit budget is required.');
    if (quote.credits > maxCredits) throw new TopMediaiError('BUDGET_EXCEEDED', 'The estimated credits exceed the supplied budget.');
    return quote;
  }
  async generate(quoteId: string, requestId: string, maxCredits: number) {
    const snapshot = await this.store.transaction(async state => {
      const previous = state.tasks[requestId];
      return previous ? { previous } : { quote: this.assertQuote(state, quoteId, maxCredits) };
    });
    if (snapshot.previous) return this.replay(snapshot.previous, quoteId);
    const quote = snapshot.quote!;
    this.backend.requireToken();
    const current = await this.price(quote.params);
    validateCosts([{ resource: 'credits', amount: current.credits }]);
    if (current.credits !== quote.credits || current.version !== quote.version) throw new TopMediaiError('PRICE_CHANGED', 'The price changed. Create a new quote before generating.');
    const prepared = await this.store.transaction(async state => {
      const prior = state.tasks[requestId];
      if (prior) return { task: prior, created: false };
      // Recheck the quote and references after the unlocked price request.
      const saved = this.assertQuote(state, quoteId, maxCredits);
      if (JSON.stringify(saved) !== JSON.stringify(quote)) throw new TopMediaiError('PRICE_CHANGED', 'The quote changed. Create a new quote before generating.');
      const task: Task = {
        request_id: requestId, quote_id: quoteId, params: saved.params, estimated_credits: saved.credits,
        created_at: new Date().toISOString(), status: 'submitting', images: [],
      };
      state.tasks[requestId] = task;
      // Save BEFORE the paid POST. A crash or timeout must not silently resubmit it.
      await this.store.save(state);
      return { task, created: true };
    });
    if (!prepared.created) return this.replay(prepared.task, quoteId);
    let groupId: string;
    try { groupId = await this.backend.create(prepared.task.params); }
    catch (error) {
      const cause = requestFailure(error);
      await this.store.transaction(async state => {
        const task = state.tasks[requestId]!;
        task.status = 'submission_unknown';
        task.error = cause;
        await this.store.save(state);
      });
      const failure = new TopMediaiError('SUBMISSION_UNKNOWN', `${cause.message} ${UNKNOWN_SUBMISSION_RECOVERY}`);
      failure.submissionFailure = cause;
      throw failure;
    }
    return this.store.transaction(async state => {
      const task = state.tasks[requestId]!;
      task.group_id = groupId; task.status = 'queued';
      await this.store.save(state);
      return this.taskResult(task, false);
    });
  }
  private taskResult(task: Task, replayed: boolean, cached = false) {
    const status = task.status === 'submitting' ? 'submission_unknown' : task.status;
    return this.wrap({ request_id: task.request_id, group_id: task.group_id, status, images: task.images,
      estimated_credits: task.estimated_credits, replayed,
      ...(task.error ? { error: task.error } : {}),
      display: taskDisplay('image', { ...task.params }, [{ resource: 'credits', amount: task.estimated_credits }]),
      poll_after_seconds: pollAfterSeconds(task, cached),
      ...(cached ? { cached: true } : {}),
      ...(status === 'submission_unknown' ? { recovery: UNKNOWN_SUBMISSION_RECOVERY } : {}),
    });
  }
  async task(requestId: string, refresh = true, refreshResult = false) {
    const prepared = await this.store.transaction(async state => {
      const task = state.tasks[requestId];
      if (!task) throw new TopMediaiError('TASK_NOT_FOUND', 'No task exists for this request_id in the current credential/environment/backend namespace. Check website history for tasks made before login or configuration changes; do not automatically resubmit.');
      if (!refresh || ['failed', 'submission_unknown', 'submitting'].includes(task.status) || (task.status === 'completed' && !refreshResult)) return { task, poll: false, cached: false };
      if (!task.group_id) throw new TopMediaiError('SUBMISSION_UNKNOWN', 'The backend group identity is missing. Check account history.');
      if (remainingPollSeconds(task)) return { task, poll: false, cached: true };
      task.poll_revision = (task.poll_revision ?? 0) + 1;
      // Reserve this task only; other sessions may query or submit unrelated tasks.
      task.poll_in_flight_until = new Date(Date.now() + this.config.timeoutMs + 5000).toISOString();
      await this.store.save(state);
      return { task, poll: true, cached: false };
    });
    const saved = prepared.task;
    if (!prepared.poll) return this.taskResult(saved, false, prepared.cached);
    try {
      const detail = await this.backend.detail(saved.group_id!), completedAt = new Date().toISOString();
      return await this.store.transaction(async state => {
        const latest = state.tasks[requestId]!;
        // An expired earlier poll must not overwrite a newer result.
        if (latest.poll_revision === saved.poll_revision) {
          Object.assign(latest, detail, { last_polled_at: completedAt });
          delete latest.poll_in_flight_until;
          await this.store.save(state);
        }
        return this.taskResult(latest, false);
      });
    } catch (error) {
      await this.store.transaction(async state => {
        const latest = state.tasks[requestId]!;
        if (latest.poll_revision === saved.poll_revision) { delete latest.poll_in_flight_until; await this.store.save(state); }
      });
      throw error;
    }
  }
}
