import type { ReferenceImage, ReferenceMedia, RequestFailure } from '../types.js';
import type { TaskPollTiming } from '../task-polling.js';
import type { ProcessOwner } from '../process-owner.js';

export type GenerationKind = 'music' | 'video' | 'tts' | 'sts' | 'denoise' | 'clone' | 'mv';
export type Resource = 'credits' | 'music_credits' | 'video_units' | 'characters' | 'seconds' | 'uses' | 'clone_slots';
export type Cost = { resource: Resource; amount: number; resource_scope?: string };
export type Budget = Partial<Record<Resource, number>>;
export type GenerationStatus = 'submitting' | 'submission_unknown' | 'queued' | 'running' | 'partially_completed' | 'completed' | 'failed' | 'unknown';
export interface Artifact { kind: 'audio' | 'video' | 'image' | 'subtitle'; url?: string; mime_type: string; media_access?: 'encoded'; encoded_reference?: string; notice?: string; }
export interface ChildResult { id: string; status: GenerationStatus; artifacts: Artifact[]; }
export interface Outcome {
  status: GenerationStatus;
  remote: Record<string, string | string[]>;
  artifacts: Artifact[];
  children?: ChildResult[];
  error?: RequestFailure;
  recovery?: string;
  delivery_error?: string;
  voice_name?: string;
}
export interface GenerationQuote {
  quote_id: string; kind: GenerationKind; operation: string; params: Record<string, unknown>;
  costs: Cost[]; price_version: string; pricing_digest: string; expires_at: string;
  cost_mode: 'alternative_entitlements' | 'selected_entitlement';
  billing?: object;
  model_name?: string;
  used_task?: string;
}
export interface GenerationTask extends Outcome, TaskPollTiming {
  task_handle: string; request_id: string; quote_id: string; kind: GenerationKind; operation: string;
  params: Record<string, unknown>; costs: Cost[]; created_at: string;
  poll_revision?: number;
  poll_after_seconds?: number;
  cached?: boolean;
  execution_mode?: 'synchronous' | 'asynchronous';
  execution_lease?: { lease_id: string; owner: ProcessOwner; expires_at: string };
  finished_at?: string;
  model_name?: string;
  estimated_credits?: number;
}
export interface Estimate {
  costs: Cost[]; price_version: string; pricing: object;
  model_name?: string;
  cost_mode?: GenerationQuote['cost_mode']; sufficient?: boolean;
  expires_at?: string;
  reference_images?: ReferenceImage[]; reference_media?: ReferenceMedia[];
}
export interface Adapter {
  readonly kind: GenerationKind;
  readonly execution_mode?: 'synchronous' | 'asynchronous';
  enabled(): boolean;
  reason(): string | undefined;
  validate(input: unknown): Record<string, unknown>;
  models(): Promise<object>;
  estimate(params: Record<string, unknown>, signal?: AbortSignal): Promise<Estimate>;
  create(params: Record<string, unknown>, referenceImages?: ReferenceImage[], referenceMedia?: ReferenceMedia[], signal?: AbortSignal): Promise<Outcome>;
  poll(task: GenerationTask): Promise<Outcome>;
}
