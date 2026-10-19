import type { CallToolResult, ResourceLink } from '@modelcontextprotocol/sdk/types.js';

// Fixed result storage origins. Never grant CSP permissions based on task data.
export const VIDEO_MEDIA_ORIGINS = ['https://files.topmediai.com'];
export const VIDEO_PREVIEW_URI = 'ui://topmediai/video-preview/v1.html';
const videoMimeTypes = new Map([['mp4', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime']]);

export function previewVideoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !VIDEO_MEDIA_ORIGINS.includes(url.origin)) return;
    if (!videoMimeTypes.has(url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '')) return;
    return url.href;
  } catch { return; }
}

interface PreviewArtifact { kind?: string; url?: unknown; }
export interface VideoPreviewTask {
  kind?: string; status?: string;
  params?: { title?: unknown };
  artifacts?: PreviewArtifact[];
  children?: { status?: string; artifacts?: PreviewArtifact[] }[];
  display?: { model?: { name?: string } };
}
export interface VideoPreviewItem { url: string; mimeType: string; label: string; }

export function videoPreviewItems(task: VideoPreviewTask): { items: VideoPreviewItem[]; unavailable: number } {
  const items: VideoPreviewItem[] = [], seen = new Set<string>();
  let unavailable = 0;
  if (task.kind !== 'video') return { items, unavailable };
  const add = (artifacts: PreviewArtifact[] | undefined, label: string) => {
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      if (artifact?.kind !== 'video') continue;
      const url = previewVideoUrl(artifact.url);
      if (!url) { unavailable++; continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      const extension = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
      if (items.length < 10) items.push({ url, mimeType: videoMimeTypes.get(extension!)!, label });
    }
  };
  if (Array.isArray(task.children) && task.children.length) {
    task.children.slice(0, 10).forEach((child, index) => { if (child?.status === 'completed') add(child.artifacts, `Version ${index + 1}`); });
  } else if (['completed', 'partially_completed'].includes(task.status ?? '')) {
    add(task.artifacts, 'Video');
  }
  return { items, unavailable };
}

export function videoToolResult(result: object): CallToolResult {
  const { items } = videoPreviewItems(result as VideoPreviewTask);
  const links: ResourceLink[] = items.map((item, index) => ({ type: 'resource_link', uri: item.url,
    name: `topmediai-video-${index + 1}`, title: item.label, mimeType: item.mimeType,
    description: 'TopMediai generated video. Use preview_video_task for inline playback, or open the original link.' }));
  return { structuredContent: { ...result }, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...links] };
}
