import { z } from 'zod';
import { imageContract, imageModel, hasOption } from './catalog/models.js';

// URLs and filesystem paths are never accepted as generation parameters. The
// server resolves account-scoped IDs returned by upload_reference_image.
export const imageSchema = z.object({
  description: z.string().trim().min(1).max(5000).describe('Image prompt; the quote is bound to this exact prompt.'),
  model_type: z.number().int().refine(value => !!imageModel(value)).describe('Actual model_type from list_image_models. Select a model and its own capability and pricing combination.'),
  number: z.number().int().min(1).max(10).default(1),
  quality: z.number().int().min(0).max(26).describe('Use a quality from this model. Nano Banana 2.1 uses 24/25/26; GPT Image 2.5 uses 18–23.'),
  image_quality: z.number().int().min(0).max(5).default(0),
  aspect_ratio: z.number().int().min(0).max(13).default(1),
  reference_image_ids: z.array(z.string().uuid()).min(1).max(16)
    .refine(ids => new Set(ids).size === ids.length).optional()
    .describe('Optional IDs from upload_reference_image in this account/environment. Omit for text-to-image.'),
}).strict().superRefine((p, ctx) => {
  const c = imageContract(p.model_type, !!p.reference_image_ids);
  if (!c) { ctx.addIssue({ code: 'custom', message: 'This model does not support the selected image operation.' }); return; }
  for (const [key, options] of [['quality', c.qualities], ['image_quality', c.quality_levels], ['number', c.numbers], ['aspect_ratio', c.aspect_ratios]] as const) {
    if (!hasOption(options, p[key])) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is not supported by this model. Select its own catalog options.` });
  }
  if (p.description.length > c.prompt_max_length) ctx.addIssue({ code: 'custom', path: ['description'], message: 'The prompt exceeds this model limit.' });
  if ((p.reference_image_ids?.length ?? 0) > c.max_reference_images) ctx.addIssue({ code: 'custom', path: ['reference_image_ids'], message: 'The reference count exceeds this model limit.' });
});
