import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { GenerationService } from '../src/generation/service.js';
import { VideoAdapter } from '../src/generation/video.js';
import type { Artifact, GenerationTask } from '../src/generation/types.js';
import { VIDEO_MEDIA_ORIGINS, VIDEO_PREVIEW_URI, videoPreviewItems, videoToolResult, previewVideoUrl } from '../src/video-display.js';

const url = 'https://files.topmediai.com/ai_video/1001/result.mp4?signature=a%2Bb';
const video: Artifact = { kind: 'video', url, mime_type: 'video/mp4' };

async function fixture(t: TestContext) {
  const parent = tmpdir(), root = await mkdtemp(resolve(parent, 'topmediai-video-preview-'));
  const config = loadConfig({ TOPMEDIAI_DATA_DIR: root, TOPMEDIAI_TOKEN: 'x'.repeat(42) }, () => null);
  const service = new GenerationService(config);
  const base: GenerationTask = { task_handle: randomUUID(), request_id: 'completed', quote_id: randomUUID(),
    kind: 'video', operation: 'text_to_video', params: { model_type: 30, duration: 58, real_duration: 5 },
    costs: [{ resource: 'credits', amount: 105 }], created_at: new Date().toISOString(),
    status: 'completed', remote: { task_id: 'synthetic-id' }, artifacts: [video] };
  const cipher = createCipheriv('aes-256-cbc', Buffer.from('123456789imyfone123456789imyfone'), Buffer.from('123456789imyfone'));
  const encoded = Buffer.concat([cipher.update(url), cipher.final()]).toString('base64');
  const tasks: GenerationTask[] = [base,
    { ...base, task_handle: randomUUID(), request_id: 'legacy', artifacts: [{ kind: 'video', mime_type: 'video/mp4', media_access: 'encoded', encoded_reference: encoded }] },
    { ...base, task_handle: randomUUID(), request_id: 'pending', status: 'running', artifacts: [] },
    { ...base, task_handle: randomUUID(), request_id: 'unknown', status: 'submission_unknown', artifacts: [] },
    { ...base, task_handle: randomUUID(), request_id: 'partial', status: 'partially_completed', children: [
      { id: '1', status: 'running', artifacts: [] }, { id: '2', status: 'completed', artifacts: [video] }] },
    { ...base, task_handle: randomUUID(), request_id: 'unresolved', artifacts: [{ kind: 'video', mime_type: 'video/mp4', media_access: 'encoded', encoded_reference: 'A'.repeat(32) }] },
    { ...base, task_handle: randomUUID(), request_id: 'unsupported', artifacts: [{ ...video, url: 'https://unapproved.test/video.mp4' }] },
    { ...base, task_handle: randomUUID(), request_id: 'music', kind: 'music', artifacts: [{ kind: 'audio', url: url.replace('.mp4', '.mp3'), mime_type: 'audio/mpeg' }] },
  ];
  await service.store.transaction(async state => {
    state.generation_tasks = Object.fromEntries(tasks.map(task => [task.request_id, task])); await service.store.save(state);
  });
  const server = createServer(config), client = new Client({ name: 'video-preview-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => {
    await client.close(); await server.close();
    const rel = relative(parent, root); assert.ok(rel.startsWith('topmediai-video-preview-') && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Video preview must not query a backend, CDN or generation endpoint'); });
  return { client, server, service, tasks, config };
}

test('video preview preserves signed URLs only on approved HTTPS media origins and formats', () => {
  assert.equal(previewVideoUrl(url), url);
  for (const value of ['https://files.topmediai.com/ai_video/result.MP4', 'https://files.topmediai.com/result.webm', 'https://files.topmediai.com/result.mov']) assert.equal(previewVideoUrl(value), value);
  for (const value of ['http://files.topmediai.com/video.mp4', 'javascript:alert(1)', 'file:///video.mp4',
    'https://127.0.0.1/video.mp4', 'https://files.topmediai.com.evil.test/video.mp4',
    'https://user:pass@files.topmediai.com/video.mp4', 'https://files.topmediai.com:444/video.mp4',
    'https://files.topmediai.com/video.html', 'https://files.topmediai.com/video.constructor',
    'https://files.topmediai.com/video.mp4#secret', ` ${url}`, 'x'.repeat(8193), null]) assert.equal(previewVideoUrl(value), undefined);
});

test('video resource links preserve JSON and partial version order, ignoring duplicates and unfinished artifacts', () => {
  const task = { kind: 'video', status: 'partially_completed', artifacts: [video], children: [
    { status: 'running', artifacts: [video] }, { status: 'completed', artifacts: [video, video] },
    { status: 'completed', artifacts: [{ ...video, url: 'https://unapproved.test/video.mp4' }] },
    { status: 'failed', artifacts: [video] },
  ] };
  const result = videoToolResult(task);
  assert.deepEqual(result.structuredContent, task);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), task);
  assert.deepEqual(result.content[1], { type: 'resource_link', uri: url, name: 'topmediai-video-1', title: 'Version 2', mimeType: 'video/mp4',
    description: 'TopMediai generated video. Use preview_video_task for inline playback, or open the original link.' });
  assert.equal(result.content.length, 2); assert.equal(videoPreviewItems(task).unavailable, 1);
  assert.equal(videoPreviewItems({ kind: 'video', status: 'running', artifacts: [video] }).items.length, 0);
  assert.equal(videoPreviewItems({ kind: 'music', status: 'completed', artifacts: [video] }).items.length, 0);
  assert.equal(videoPreviewItems({ kind: 'video', status: 'completed', artifacts: Array.from({ length: 15 }, (_, i) => ({ ...video, url: url.replace('result.mp4', `result-${i}.mp4`) })) }).items.length, 10);
});

test('MCP video preview reads completed, legacy, partial and pending results without HTTP or stored-state changes', async t => {
  const { client, service, tasks } = await fixture(t);
  const preview = (await client.listTools()).tools.find(tool => tool.name === 'preview_video_task')!;
  assert.ok(preview); assert.equal(preview.annotations?.readOnlyHint, true); assert.equal(preview.annotations?.openWorldHint, false);
  assert.equal((preview._meta?.ui as { resourceUri: string }).resourceUri, VIDEO_PREVIEW_URI);
  assert.equal(preview._meta?.['openai/outputTemplate'], VIDEO_PREVIEW_URI);
  const before = await service.store.transaction(async state => JSON.stringify(state));
  for (const task of tasks) {
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool({ name: 'preview_video_task', arguments: { task_handle: task.task_handle } }) as CallToolResult;
      assert.equal(result.isError, undefined);
      const data = result.structuredContent as { status: string; artifacts: Artifact[]; display: { model: { name?: string }; estimated_costs: { amount: number }[] } };
      assert.equal(data.status, task.status);
      const links = result.content.filter(item => item.type === 'resource_link');
      assert.equal(links.length, ['completed', 'legacy', 'partial'].includes(task.request_id) ? 1 : 0);
      if (task.request_id === 'legacy') assert.equal(data.artifacts[0]?.url, url);
      if (task.kind === 'video') { assert.ok(data.display.model.name); assert.equal(data.display.estimated_costs[0]?.amount, 105); }
    }
  }
  assert.equal(await service.store.transaction(async state => JSON.stringify(state)), before, 'Preview must not change status, polling reservations, cooldowns or legacy media');
  const missing = await client.callTool({ name: 'preview_video_task', arguments: { task_handle: randomUUID() } }) as CallToolResult;
  assert.equal(missing.isError, true); assert.match((missing.content[0] as { text: string }).text, /TASK_NOT_FOUND/);
});

test('video preview cannot read another account/configuration task', async t => {
  const { client, config } = await fixture(t);
  const foreign = new GenerationService(loadConfig({ TOPMEDIAI_DATA_DIR: config.dataDir, TOPMEDIAI_TOKEN: 'y'.repeat(42) }, () => null));
  const foreignHandle = randomUUID();
  await foreign.store.transaction(async state => {
    state.generation_tasks = { foreign: { task_handle: foreignHandle } as GenerationTask }; await foreign.store.save(state);
  });
  const result = await client.callTool({ name: 'preview_video_task', arguments: { task_handle: foreignHandle } }) as CallToolResult;
  assert.equal(result.isError, true); assert.match((result.content[0] as { text: string }).text, /TASK_NOT_FOUND/);
});

test('generation query exposes video resource links and its original handle can open the saved player', async t => {
  const { client, tasks } = await fixture(t);
  const poll = t.mock.method(VideoAdapter.prototype, 'poll', async () => ({ status: 'completed' as const, remote: {}, artifacts: [video] }));
  const result = await client.callTool({ name: 'get_generation_task', arguments: { task_handle: tasks[0]!.task_handle } }) as CallToolResult;
  assert.equal(result.isError, undefined); assert.equal(poll.mock.callCount(), 1);
  const link = result.content.find(item => item.type === 'resource_link');
  assert.equal(link?.uri, url); assert.equal(link?.mimeType, 'video/mp4');
  const preview = await client.callTool({ name: 'preview_video_task', arguments: { task_handle: tasks[0]!.task_handle } }) as CallToolResult;
  assert.equal(preview.isError, undefined); assert.equal(poll.mock.callCount(), 1, 'Preview must not poll after query');
  assert.deepEqual(preview.content.filter(item => item.type === 'resource_link'), result.content.filter(item => item.type === 'resource_link'));
});

test('video player resource is bundled, credential-free and restricted to fixed media origins', async t => {
  const { client } = await fixture(t);
  assert.ok((await client.listResources()).resources.some(resource => resource.uri === VIDEO_PREVIEW_URI));
  const resource = (await client.readResource({ uri: VIDEO_PREVIEW_URI })).contents[0]!;
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  const meta = resource._meta?.ui as { csp: { resourceDomains: string[]; connectDomains: string[]; frameDomains: string[] } };
  assert.deepEqual(meta.csp.resourceDomains, VIDEO_MEDIA_ORIGINS); assert.deepEqual(meta.csp.connectDomains, []); assert.deepEqual(meta.csp.frameDomains, []);
  assert.ok('text' in resource); const html = resource.text as string;
  for (const label of ['Video Preview', 'Play video', 'Retry loading', 'Open original video / Download']) assert.ok(html.includes(label));
  assert.ok(!html.includes('/* VIDEO_PREVIEW_SCRIPT */'));
  assert.ok(!html.includes('x'.repeat(42)) && !html.includes(url) && !html.includes('synthetic-id'));
  assert.ok(!/\b(?:src|href)=["']https?:\/\//.test(html), 'No external scripts, styles, fonts or initial media fetch');
});

test('server instructions and query description default to video cards with links and explicit browser actions', async t => {
  const { client } = await fixture(t);
  assert.match(client.getInstructions()!, /call preview_video_task/);
  assert.ok(!client.getInstructions()!.includes('Video browser playback/preview still requires an explicit user request'));
  const query = (await client.listTools()).tools.find(tool => tool.name === 'get_generation_task')!;
  assert.match(query.description!, /preview_video_task/);
  assert.match(query.description!, /explicit user request/);
});
