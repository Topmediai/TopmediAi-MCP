import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ImageService } from '../src/service.js';
import { IMAGE_MEDIA_ORIGINS, IMAGE_PREVIEW_URI, previewImageUrl, imageToolResult } from '../src/image-display.js';

const url = 'https://files.topmediai.com/ai-art-generator/images/cat.png';

async function fixture(t: TestContext) {
  const parent = tmpdir(), root = await mkdtemp(resolve(parent, 'topmediai-preview-'));
  const config = loadConfig({ TOPMEDIAI_DATA_DIR: root, TOPMEDIAI_TOKEN: 'x'.repeat(42) }, () => null);
  const service = new ImageService(config);
  await service.store.transaction(async state => {
    state.tasks['saved-image'] = { request_id: 'saved-image', quote_id: 'saved-quote', group_id: '12345',
      params: { description: 'Cat', model_type: 8, quality: 8, image_quality: 0, number: 1, aspect_ratio: 1 },
      estimated_credits: 1, status: 'running', images: [{ url, mime_type: 'image/png' }], created_at: new Date().toISOString() };
    await service.store.save(state);
  });
  const server = createServer(config), client = new Client({ name: 'preview-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => {
    await client.close(); await server.close();
    const rel = relative(parent, root); assert.ok(rel.startsWith('topmediai-preview-') && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  // Preview must not perform even a backend GET or a CDN fetch.
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Preview must not access any network endpoint'); });
  return { client };
}

test('preview accepts only approved generated-image URLs and preserves signed queries', () => {
  assert.equal(previewImageUrl(`${url}?signature=a%2Bb`), `${url}?signature=a%2Bb`);
  assert.equal(previewImageUrl('https://files.topmediai.com/ai-art-generator/images/cat.webp'), 'https://files.topmediai.com/ai-art-generator/images/cat.webp');
  for (const value of [url.replace('https:', 'http:'), 'javascript:alert(1)', 'file:///C:/secret.png',
    url.replace('files.topmediai.com', 'files.topmediai.com.evil.test'),
    url.replace('https://', 'https://user:pass@'), url.replace('/ai-art-generator/images/', '/private/'),
    url.replace('.png', '.html'), url.replace('.png', '.svg'), url.replace(new URL(url).host, `${new URL(url).host}:444`), null]) {
    assert.equal(previewImageUrl(value), undefined);
  }
});

test('image results remain headless-compatible and add usable typed resource links', () => {
  const task = { status: 'completed', images: [{ url, mime_type: 'incorrect' }, { url: 'https://unapproved.test/a.png' }] };
  const result = imageToolResult(task);
  assert.deepEqual(result.structuredContent, task);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0]!.type, 'text');
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), task);
  assert.equal(result.content[1]!.type, 'resource_link');
  assert.equal((result.content[1] as { uri: string }).uri, url);
  assert.equal((result.content[1] as { mimeType: string }).mimeType, 'image/png');
});

test('MCP preview reads a saved running task without polling, fetching or generation', async t => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  const preview = tools.find(tool => tool.name === 'preview_image_task')!;
  assert.ok(preview); assert.equal((preview._meta?.ui as { resourceUri: string }).resourceUri, IMAGE_PREVIEW_URI);
  assert.equal(preview.annotations?.readOnlyHint, true);
  const result = await client.callTool({ name: 'preview_image_task', arguments: { request_id: 'saved-image' } });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { status: string }).status, 'running');
  assert.equal((result.content as { type: string }[]).filter(item => item.type === 'resource_link').length, 1);
  const missing = await client.callTool({ name: 'preview_image_task', arguments: { request_id: 'unowned-task' } });
  assert.equal(missing.isError, true); assert.match((missing.content as { text: string }[])[0]!.text, /TASK_NOT_FOUND/);
});

test('MCP viewer resource declares narrow image CSP and bundles all UI code', async t => {
  const { client } = await fixture(t);
  assert.ok((await client.listResources()).resources.some(resource => resource.uri === IMAGE_PREVIEW_URI));
  const { contents } = await client.readResource({ uri: IMAGE_PREVIEW_URI });
  const resource = contents[0]!;
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  const meta = resource._meta?.ui as { csp: { resourceDomains: string[]; connectDomains: string[]; frameDomains: string[] } };
  assert.deepEqual(meta.csp.resourceDomains, IMAGE_MEDIA_ORIGINS);
  assert.deepEqual(meta.csp.connectDomains, []); assert.deepEqual(meta.csp.frameDomains, []);
  assert.ok('text' in resource); const html = resource.text as string;
  assert.match(html, /Retry loading/); assert.match(html, /Open original image/);
  assert.ok(!html.includes('/* IMAGE_PREVIEW_SCRIPT */'));
  assert.ok(!html.includes('x'.repeat(42)) && !html.includes('saved-image') && !html.includes(url));
  assert.ok(!/\b(?:src|href)=["']https?:\/\//.test(html), 'No external scripts, styles or fonts are needed');
});
