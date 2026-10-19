import type { CallToolResult, ResourceLink } from '@modelcontextprotocol/sdk/types.js';

// Generated image storage, not API origins. The viewer sends no account credentials.
export const IMAGE_MEDIA_ORIGINS = ['https://files.topmediai.com'];
export const IMAGE_PREVIEW_URI = 'ui://topmediai/image-preview/v1.html';

export function previewImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !IMAGE_MEDIA_ORIGINS.includes(url.origin)
      || !url.pathname.startsWith('/ai-art-generator/images/') || !/\.(png|jpe?g|webp)$/i.test(url.pathname)) return;
    return url.href;
  } catch { return; }
}

export function imageToolResult(result: object): CallToolResult {
  const images = (result as { images?: { url?: unknown; mime_type?: unknown }[] }).images;
  const links: ResourceLink[] = Array.isArray(images) ? images.slice(0, 4).flatMap((image, index) => {
    const uri = previewImageUrl(image?.url);
    if (!uri) return [];
    const mimeType = new URL(uri).pathname.toLowerCase().endsWith('.webp') ? 'image/webp'
      : /\.jpe?g$/i.test(new URL(uri).pathname) ? 'image/jpeg' : 'image/png';
    return [{ type: 'resource_link', uri, name: `topmediai-image-${index + 1}`, title: `Image ${index + 1}`,
      mimeType, description: 'TopMediai generated image. Open the original link if the host cannot show a preview.' }];
  }) : [];
  return { structuredContent: { ...result }, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...links] };
}
