import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { VIDEO_MEDIA_ORIGINS, VIDEO_PREVIEW_URI } from './video-display.js';

export const videoPreviewMetadata = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: VIDEO_MEDIA_ORIGINS, frameDomains: [] } },
  'openai/widgetDescription': 'Shows existing TopMediai videos with click-to-play, seek, volume, fullscreen, retry and original links. Never generates video.',
  'openai/widgetCSP': { connect_domains: [], resource_domains: VIDEO_MEDIA_ORIGINS, redirect_domains: VIDEO_MEDIA_ORIGINS },
};

export function registerVideoPreview(server: McpServer) {
  registerAppResource(server, 'TopMediai video preview', VIDEO_PREVIEW_URI,
    { description: 'Read-only player for existing generated videos.', _meta: videoPreviewMetadata },
    async () => ({ contents: [{ uri: VIDEO_PREVIEW_URI, mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL('./video-preview.html', import.meta.url), 'utf8'), _meta: videoPreviewMetadata }] }));
}
