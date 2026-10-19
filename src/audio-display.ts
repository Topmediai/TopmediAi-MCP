import type { CallToolResult, ResourceLink } from '@modelcontextprotocol/sdk/types.js';

// Existing TopMediai storage and music streaming hosts verified in the Web/backend clients.
// Never derive CSP permissions from a task URL or send account credentials to these hosts.
export const AUDIO_MEDIA_ORIGINS = ['https://files.topmediai.com',
  'https://cdn1.suno.ai', 'https://cdn2.suno.ai', 'https://audiopipe.suno.ai'];
export const AUDIO_PREVIEW_URI = 'ui://topmediai/audio-preview/v1.html';
const audioMimeTypes: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };

export function previewAudioUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !AUDIO_MEDIA_ORIGINS.includes(url.origin)) return;
    const extension = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (!audioMimeTypes[extension ?? ''] && !(url.origin === 'https://audiopipe.suno.ai' && url.pathname === '/' && url.searchParams.get('item_id'))) return;
    return url.href;
  } catch { return; }
}

interface PreviewArtifact { kind?: string; url?: unknown; }
export interface AudioPreviewTask {
  kind?: string; status?: string;
  params?: { title?: unknown; article_title?: unknown; instrumental?: unknown; accent?: unknown };
  artifacts?: PreviewArtifact[];
  children?: { status?: string; artifacts?: PreviewArtifact[] }[];
  display?: { model?: { name?: string }; voice?: { name?: string } };
}
export interface AudioPreviewItem { url: string; mimeType: string; label: string; }

export function audioPreviewItems(task: AudioPreviewTask): { items: AudioPreviewItem[]; unavailable: number } {
  const items: AudioPreviewItem[] = [], seen = new Set<string>();
  let unavailable = 0;
  const add = (artifacts: PreviewArtifact[] | undefined, label: string) => {
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      if (artifact?.kind !== 'audio') continue;
      const url = previewAudioUrl(artifact.url);
      if (!url) { unavailable++; continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      const extension = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
      if (items.length < 10) items.push({ url, mimeType: audioMimeTypes[extension ?? ''] ?? 'audio/mpeg', label });
    }
  };
  if (Array.isArray(task.children) && task.children.length) {
    task.children.slice(0, 10).forEach((child, index) => { if (child?.status === 'completed') add(child.artifacts, `Version ${index + 1}`); });
  } else if (['completed', 'partially_completed'].includes(task.status ?? '')) {
    add(task.artifacts, task.kind === 'music' ? 'Music' : task.kind === 'tts' ? 'Synthesized speech' : task.kind === 'sts' ? 'Voice conversion result' : 'Audio');
  }
  return { items, unavailable };
}

export function audioToolResult(result: object): CallToolResult {
  const { items } = audioPreviewItems(result as AudioPreviewTask);
  const links: ResourceLink[] = items.map((item, index) => ({ type: 'resource_link', uri: item.url,
    name: `topmediai-audio-${index + 1}`, title: item.label, mimeType: item.mimeType,
    description: 'TopMediai generated audio. Use preview_audio_task for inline playback, or open the original link.' }));
  return { structuredContent: { ...result }, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...links] };
}
