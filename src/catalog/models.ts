import { WEB_MODELS } from './web-models.js';
import type { CatalogOption } from './types.js';

export { WEB_MODELS };
export const imageModel = (id: number) => WEB_MODELS.images.find(model => model.id === id);
export const imageContract = (id: number, editing = false) => imageModel(id)?.operations[editing ? 'image' : 'text'];
export const hasOption = (options: CatalogOption[], value: number) => options.some(option => option.value === value && !option.disabled);
export function imagePriceSupported(id: number, quality: number, level: number) {
  const model = imageModel(id);
  return !!model && Object.values(model.operations).some(contract => hasOption(contract.qualities, quality) && hasOption(contract.quality_levels, level));
}
export const videoModel = (id: number) => WEB_MODELS.videos.find(model => model.id === id);
export const videoContract = (id: number, operation: string) => videoModel(id)?.operations[
  operation === 'omni_reference_to_video' ? 'reference_to_video' : operation === 'image_to_video_start_end' ? 'image_to_video' : operation as 'text_to_video'
];
export function optionMatches(option: CatalogOption, values: Record<string, number | boolean>) {
  return !option.disabled && Object.entries(option.only_for ?? {}).every(([key, expected]) => Array.isArray(expected)
    ? typeof values[key] === 'number' && expected.includes(values[key] as number) : values[key] === expected);
}
export function videoSeconds(id: number, duration: number, realDuration?: number, operation = 'text_to_video') {
  const model = videoModel(id), contract = videoContract(id, operation);
  if (!model || !contract) return undefined;
  if (model.duration_protocol !== undefined) return duration === model.duration_protocol && contract.durations.some(d => d.seconds === realDuration) ? realDuration : undefined;
  const seconds = contract.durations.find(d => d.value === duration)?.seconds;
  return seconds !== undefined && (realDuration === undefined || realDuration === seconds) ? seconds : undefined;
}
