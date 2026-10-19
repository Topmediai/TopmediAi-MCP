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
import type { Artifact, GenerationTask } from '../src/generation/types.js';
import { musicResultArtifact } from '../src/media/music-result.js';
import { AUDIO_MEDIA_ORIGINS, AUDIO_PREVIEW_URI, audioPreviewItems, audioToolResult, previewAudioUrl, type AudioPreviewTask } from '../src/audio-display.js';

const url = 'https://files.topmediai.com/aimusic/web/song.mp3?signature=a%2Bb';
const audio: Artifact = { kind: 'audio', url, mime_type: 'audio/mpeg' };
function encoded(value: string) {
  const cipher = createCipheriv('aes-256-cbc', Buffer.from('147258369topmeidia96385topmeidia'), Buffer.from('1597531topmeidia'));
  return Buffer.concat([cipher.update(value), cipher.final()]).toString('base64');
}

async function fixture(t: TestContext) {
  const parent = tmpdir(), root = await mkdtemp(resolve(parent, 'topmediai-audio-preview-'));
  const config = loadConfig({ TOPMEDIAI_DATA_DIR: root, TOPMEDIAI_TOKEN: 'x'.repeat(42) }, () => null);
  const service = new GenerationService(config);
  const tasks: GenerationTask[] = [false, true].map(instrumental => ({
    task_handle: randomUUID(), request_id: instrumental ? 'instrumental' : 'vocal', quote_id: randomUUID(),
    kind: 'music', operation: 'custom', params: { mv: 'v6-wild-pro', title: 'Neon Rise', instrumental },
    costs: [{ resource: 'credits', amount: 4 }], created_at: new Date().toISOString(),
    status: 'completed', remote: { song_ids: ['1', '2'] }, artifacts: [audio],
    children: [{ id: '1', status: 'completed', artifacts: [audio] },
      { id: '2', status: 'completed', artifacts: [{ ...audio, url: url.replace('song.mp3', 'song-2.mp3') }] }],
  }));
  const legacy: GenerationTask = { ...tasks[0]!, task_handle: randomUUID(), request_id: 'legacy',
    artifacts: [{ kind: 'audio', mime_type: 'audio/mpeg', media_access: 'encoded', encoded_reference: encoded(url) }], children: undefined };
  const pending: GenerationTask = { ...tasks[0]!, task_handle: randomUUID(), request_id: 'pending',
    status: 'running', artifacts: [], children: [{ id: '1', status: 'running', artifacts: [] }] };
  tasks.push(legacy, pending);
  for (const kind of ['tts', 'sts'] as const) tasks.push({ ...tasks[0]!, kind, operation: kind, task_handle: randomUUID(), request_id: kind,
    execution_mode: 'synchronous', params: kind === 'tts' ? { article_title: '欢迎语音', accent: 'English(US)' } : {},
    model_name: 'ElevenLabs Gen', voice_name: 'Public voice', artifacts: [audio], children: undefined });
  await service.store.transaction(async state => {
    state.generation_tasks = Object.fromEntries(tasks.map(task => [task.request_id, task])); await service.store.save(state);
  });
  const server = createServer(config), client = new Client({ name: 'audio-preview-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => {
    await client.close(); await server.close();
    const rel = relative(parent, root); assert.ok(rel.startsWith('topmediai-audio-preview-') && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Audio preview must not query a backend, CDN or generation endpoint'); });
  return { client, service, tasks, config };
}

test('audio preview allows verified media hosts and formats, preserving signed URLs', () => {
  assert.equal(previewAudioUrl(url), url);
  for (const value of ['https://files.topmediai.com/production/music/song.wav', 'https://cdn1.suno.ai/song.mp3',
    'https://cdn2.suno.ai/song.m4a', 'https://audiopipe.suno.ai/?item_id=original-id']) assert.equal(previewAudioUrl(value), value);
  for (const value of ['http://files.topmediai.com/song.mp3', 'javascript:alert(1)', 'file:///C:/private.mp3',
    'https://127.0.0.1/song.mp3', 'https://files.topmediai.com.evil.test/song.mp3',
    'https://user:pass@files.topmediai.com/song.mp3', 'https://files.topmediai.com:444/song.mp3',
    'https://files.topmediai.com/song.html', 'https://files.topmediai.com/song.mp3#secret',
    'https://audiopipe.suno.ai/', 'https://audiopipe.suno.ai/private?item_id=1', null]) assert.equal(previewAudioUrl(value), undefined);
});

test('audio links keep original JSON, completed version order and partial success without duplicates', () => {
  const task = { kind: 'music', status: 'partially_completed', artifacts: [audio], children: [
    { status: 'running', artifacts: [audio] }, { status: 'completed', artifacts: [audio, audio] },
    { status: 'completed', artifacts: [{ ...audio, url: 'https://unapproved.test/song.mp3' }] },
    { status: 'failed', artifacts: [audio] },
  ] };
  const result = audioToolResult(task);
  assert.deepEqual(result.structuredContent, task);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), task);
  assert.equal(result.content.length, 2);
  assert.deepEqual(result.content[1], { type: 'resource_link', uri: url, name: 'topmediai-audio-1', title: 'Version 2', mimeType: 'audio/mpeg',
    description: 'TopMediai generated audio. Use preview_audio_task for inline playback, or open the original link.' });
  assert.equal(audioPreviewItems(task).unavailable, 1);
  assert.equal(audioPreviewItems({ kind: 'tts', status: 'completed', artifacts: [audio] }).items.length, 1);
  assert.equal(audioPreviewItems({ kind: 'tts', status: 'completed', artifacts: [audio] }).items[0]?.label, 'Synthesized speech');
  assert.equal(audioPreviewItems({ kind: 'sts', status: 'completed', artifacts: [audio] }).items[0]?.label, 'Voice conversion result');
  assert.equal(audioPreviewItems({ status: 'running', artifacts: [audio] }).items.length, 0);
});

test('music URLs resolve the existing encoding protocol and never turn invalid references into playable URLs', () => {
  assert.deepEqual(musicResultArtifact(url), audio);
  assert.deepEqual(musicResultArtifact(encoded(url)), audio);
  for (const value of [encoded('https://127.0.0.1/private.mp3'), encoded('javascript:alert(1)'), 'A'.repeat(32)]) {
    const result = musicResultArtifact(value)!;
    assert.equal(result.url, undefined); assert.equal(result.media_access, 'encoded'); assert.equal(result.encoded_reference, value);
  }
  assert.equal(musicResultArtifact(''), undefined);
});

test('MCP audio preview is a local read for music, TTS, STS, legacy and pending tasks', async t => {
  const { client, service, tasks } = await fixture(t);
  const preview = (await client.listTools()).tools.find(tool => tool.name === 'preview_audio_task')!;
  assert.ok(preview); assert.equal(preview.annotations?.readOnlyHint, true); assert.equal(preview.annotations?.openWorldHint, false);
  assert.equal((preview._meta?.ui as { resourceUri: string }).resourceUri, AUDIO_PREVIEW_URI);
  const before = await service.store.transaction(async state => JSON.stringify(state));
  for (const task of tasks) {
    const result = await client.callTool({ name: 'preview_audio_task', arguments: { task_handle: task.task_handle } }) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { status: string }).status, task.status);
    assert.equal(result.content.filter(item => item.type === 'resource_link').length,
      task.request_id === 'pending' ? 0 : task.children?.length ?? 1);
    if (task.kind === 'tts' || task.kind === 'sts') {
      const content = result.structuredContent as AudioPreviewTask;
      assert.equal(content.display?.model?.name, 'ElevenLabs Gen');
      assert.equal(content.display?.voice?.name, 'Public voice');
    }
  }
  assert.equal(await service.store.transaction(async state => JSON.stringify(state)), before, 'Preview must not change status, media, polling reservations or cooldowns');
  const missing = await client.callTool({ name: 'preview_audio_task', arguments: { task_handle: randomUUID() } }) as CallToolResult;
  assert.equal(missing.isError, true); assert.match((missing.content[0] as { text: string }).text, /TASK_NOT_FOUND/);
});

test('audio preview does not expose a different account’s saved task', async t => {
  const { client, config } = await fixture(t);
  const foreignService = new GenerationService({ ...config, dataDir: resolve(config.dataDir, 'other-account') });
  const foreignHandle = randomUUID();
  await foreignService.store.transaction(async state => {
    state.generation_tasks = { foreign: { task_handle: foreignHandle } as GenerationTask }; await foreignService.store.save(state);
  });
  const result = await client.callTool({ name: 'preview_audio_task', arguments: { task_handle: foreignHandle } }) as CallToolResult;
  assert.equal(result.isError, true); assert.match((result.content[0] as { text: string }).text, /TASK_NOT_FOUND/);
});

test('MCP audio player resource bundles UI code with fixed media CSP and no private data', async t => {
  const { client } = await fixture(t);
  assert.ok((await client.listResources()).resources.some(resource => resource.uri === AUDIO_PREVIEW_URI));
  const { contents } = await client.readResource({ uri: AUDIO_PREVIEW_URI });
  const resource = contents[0]!;
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  const meta = resource._meta?.ui as { csp: { resourceDomains: string[]; connectDomains: string[]; frameDomains: string[] } };
  assert.deepEqual(meta.csp.resourceDomains, AUDIO_MEDIA_ORIGINS); assert.deepEqual(meta.csp.connectDomains, []); assert.deepEqual(meta.csp.frameDomains, []);
  assert.ok('text' in resource); const html = resource.text as string;
  for (const label of ['Music Preview', 'Play', 'Retry loading', '/ Download']) assert.ok(html.includes(label));
  assert.ok(!html.includes('/* AUDIO_PREVIEW_SCRIPT */'));
  assert.ok(!html.includes('x'.repeat(42)) && !html.includes(url) && !html.includes('Neon Rise'));
  assert.ok(!/\b(?:src|href)=["']https?:\/\//.test(html), 'No external script, stylesheet, font or initial media fetch');
});
