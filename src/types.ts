import type { TaskPollTiming } from './task-polling.js';

export type Mode = 'live';
export interface ImageParams {
  description: string;
  model_type: number;
  number: number;
  quality: number;
  image_quality: number;
  aspect_ratio: number;
  image_urls?: string[];
}
export type ImageEstimateParams = Omit<ImageParams, 'image_urls'> & { reference_image_ids?: string[] };
export interface ReferenceImage {
  reference_image_id: string;
  url: string;
  sha256: string;
  mime_type: 'image/png' | 'image/jpeg';
  bytes: number;
  width: number;
  height: number;
  created_at: string;
}
export interface ReferenceMedia {
  reference_media_id: string;
  media_type: 'video' | 'audio';
  url: string;
  sha256: string;
  mime_type: 'video/mp4' | 'audio/wav';
  bytes: number;
  duration_seconds: number;
  width?: number;
  height?: number;
  fps?: number;
  created_at: string;
}
export interface PriceRow {
  model_type: number;
  model_name: string;
  quality: number;
  quality_name: string;
  image_quality: number;
  image_quality_name: string;
  points: number;
  version: string;
}
export interface Quote {
  quote_id: string;
  params: ImageParams;
  credits: number;
  version: string;
  expires_at: string;
  reference_image_ids?: string[];
}
export interface ImageArtifact {
  url?: string;
  mime_type: string;
}
export interface Task extends TaskPollTiming {
  poll_revision?: number;
  request_id: string;
  quote_id: string;
  params: ImageParams;
  estimated_credits: number;
  group_id?: string;
  created_at: string;
  status: 'submitting' | 'submission_unknown' | 'queued' | 'running' | 'completed' | 'failed';
  images: ImageArtifact[];
  error?: RequestFailure;
}
export interface State {
  version: 2;
  quotes: Record<string, Quote>;
  tasks: Record<string, Task>;
  reference_images?: Record<string, ReferenceImage>;
  reference_media?: Record<string, ReferenceMedia>;
  generation_quotes?: Record<string, import('./generation/types.js').GenerationQuote>;
  generation_tasks?: Record<string, import('./generation/types.js').GenerationTask>;
  speech_assets?: Record<string, import('./media/speech-audio.js').SpeechAsset>;
  display_plans?: Record<string, import('./generation-plan.js').SavedPlan>;
}
export interface UploadUrlDiagnostic {
  reason: 'invalid_type' | 'url_too_long' | 'invalid_url' | 'unsafe_characters' | 'https_required'
    | 'credentials_not_allowed' | 'query_not_allowed' | 'fragment_not_allowed' | 'origin_mismatch'
    | 'path_prefix_mismatch' | 'invalid_filename' | 'noncanonical_url';
  expected_origin: string;
  expected_path_prefix: string;
  returned_origin?: string;
  protocol?: string;
  has_credentials?: boolean;
  has_query?: boolean;
  has_fragment?: boolean;
  path_prefix_matches?: boolean;
  filename_matches?: boolean;
  recovery: {
    action: 'verify_upload_origin_and_reconnect' | 'inspect_upload_response';
    config_key?: 'TOPMEDIAI_UPLOAD_PUBLIC_ORIGIN';
    suggested_origin?: string;
    automatic_retry: false;
  };
}
export interface RequestErrorDetails {
  category: 'authentication' | 'business' | 'http' | 'timeout' | 'network' | 'cancelled' | 'invalid_response' | 'unknown';
  suggestion: string;
  http_status?: number;
  backend_status?: number;
  backend_code?: number;
  network_code?: string;
  timeout_ms?: number;
  elapsed_ms?: number;
}
export interface RequestFailure {
  code: string;
  message: string;
  details?: RequestErrorDetails;
}
export class TopMediaiError extends Error {
  submissionFailure?: RequestFailure;
  constructor(public readonly code: string, message: string, public readonly details?: UploadUrlDiagnostic,
    public readonly requestDetails?: RequestErrorDetails) { super(message); }
}
