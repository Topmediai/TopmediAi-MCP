import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { IMAGE_MEDIA_ORIGINS, IMAGE_PREVIEW_URI } from './image-display.js';

export const imagePreviewMetadata = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: IMAGE_MEDIA_ORIGINS, frameDomains: [] } },
  'openai/widgetDescription': 'Shows existing TopMediai images with loading, error and original-link controls. Never submits generation.',
  'openai/widgetCSP': { connect_domains: [], resource_domains: IMAGE_MEDIA_ORIGINS, redirect_domains: IMAGE_MEDIA_ORIGINS },
};

export function registerImagePreview(server: McpServer) {
  registerAppResource(server, 'TopMediai image preview', IMAGE_PREVIEW_URI,
    { description: 'Read-only image viewer for existing task results.', _meta: imagePreviewMetadata },
    async () => ({ contents: [{ uri: IMAGE_PREVIEW_URI, mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL('./image-preview.html', import.meta.url), 'utf8'), _meta: imagePreviewMetadata }] }));
}
