export interface CatalogOption {
  value: number;
  label: string;
  is_default?: boolean;
  disabled?: boolean;
  only_for?: Record<string, number[] | boolean>;
}
export interface ImageContract {
  qualities: CatalogOption[];
  quality_levels: CatalogOption[];
  aspect_ratios: CatalogOption[];
  numbers: CatalogOption[];
  max_reference_images: number;
  prompt_max_length: number;
  request_params: string[];
}
export interface VideoContract {
  modes: CatalogOption[];
  durations: (CatalogOption & { seconds: number })[];
  aspect_ratios: CatalogOption[];
  prompt_max_length: number;
  request_params: string[];
  reference_upload_limits?: Record<string, string | number>;
}
export interface WebVideoModel {
  id: number;
  name: string;
  visible: boolean;
  supports_audio: boolean;
  duration_protocol?: number;
  forced_audio?: boolean;
  operations: Partial<Record<'text_to_video' | 'image_to_video' | 'reference_to_video', VideoContract>>;
}
export interface WebCatalog {
  source_revision: string;
  source_files: string[];
  defaults: { music: string; image: number; video: number };
  music: { mv: string; name: string; style_max_length: number; lyrics_max_length: number }[];
  images: { id: number; name: string; visible: boolean; operations: Partial<Record<'text' | 'image', ImageContract>> }[];
  videos: WebVideoModel[];
}
