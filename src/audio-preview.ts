import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { AUDIO_MEDIA_ORIGINS, AUDIO_PREVIEW_URI } from './audio-display.js';

export const audioPreviewMetadata = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: AUDIO_MEDIA_ORIGINS, frameDomains: [] } },
  'openai/widgetDescription': 'Plays existing TopMediai audio on user click with separate version controls and original links. Never generates audio.',
  'openai/widgetCSP': { connect_domains: [], resource_domains: AUDIO_MEDIA_ORIGINS, redirect_domains: AUDIO_MEDIA_ORIGINS },
};

export function registerAudioPreview(server: McpServer) {
  registerAppResource(server, 'TopMediai audio preview', AUDIO_PREVIEW_URI,
    { description: 'Read-only player for existing generated music and speech.', _meta: audioPreviewMetadata },
    async () => ({ contents: [{ uri: AUDIO_PREVIEW_URI, mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL('./audio-preview.html', import.meta.url), 'utf8'), _meta: audioPreviewMetadata }] }));
}
