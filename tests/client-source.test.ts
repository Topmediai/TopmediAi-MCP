import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, createRuntimeConfigLoader } from '../src/config.js';
import { parseClientSource, type McpClientSource } from '../src/client-source.js';
import { businessFetch } from '../src/transport/http.js';
import { BusinessTransport } from '../src/transport/business.js';
import { Backend } from '../src/backend.js';
import { verifyAccountToken } from '../src/account.js';
import { createServer } from '../src/server.js';
import { pluginConfiguration } from '../scripts/setup-plugin.js';
import { cursorConfiguration } from '../scripts/setup-cursor.js';
import { TopMediaiError } from '../src/types.js';

const token = 'F'.repeat(42);
const sources = [5, 6, 7, undefined] as const;

test('client source is explicit, strict and independent of the existing payload channel', () => {
  for (const source of sources) {
    const config = loadConfig({ MCP_CLIENT_SOURCE: source?.toString(), TOPMEDIAI_SOURCE: '2' }, () => null);
    assert.equal(config.clientSource, source);
    assert.equal(config.source, 2);
  }
  assert.equal(parseClientSource(''), undefined);
  for (const value of ['0', '4', '8', 'Codex', 'claude', 'gpt-5', 'windows', '5, 6', '05', '5\nsource: 6', null]) {
    assert.throws(() => parseClientSource(value), (error: unknown) => error instanceof TopMediaiError && error.code === 'INVALID_CONFIG');
  }
  const env = { MCP_CLIENT_SOURCE: '6' };
  const reload = createRuntimeConfigLoader(env, () => null);
  env.MCP_CLIENT_SOURCE = '7';
  assert.equal(reload().clientSource, 6);
});

test('generated launches preserve explicit source and Cursor overrides inherited client identity', () => {
  for (const source of sources) {
    const env = { MCP_CLIENT_SOURCE: source?.toString() };
    assert.equal(pluginConfiguration('production', env).mcpServers.topmediai.env.MCP_CLIENT_SOURCE, source?.toString() ?? '');
    assert.equal(cursorConfiguration('production', env).mcpServers.topmediai.env.MCP_CLIENT_SOURCE, '7');
  }
});

async function httpFixture(t: TestContext) {
  const calls: { path: string; headers: Headers; rawHeaders: string[]; body: string }[] = [];
  const server = createHttpServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url!, headers: new Headers(req.headers as Record<string, string>), rawHeaders: req.rawHeaders, body });
    const data = req.url!.startsWith('/user/member/info') ? { member_id: '101', email: 'test@example.test' }
      : req.url!.includes('generate') || req.url!.includes('text-to-image') ? { group_id: '12345' } : {};
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 200, data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

for (const source of sources) {
  test(`wire headers cover every business transport for source ${source ?? 'unknown'}`, async t => {
    const { origin, calls } = await httpFixture(t);
    const backendOrigin = 'https://backend.fixture.invalid';
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input);
      assert.equal(target.origin, backendOrigin);
      return originalFetch(new URL(target.pathname + target.search, origin), init);
    });
    const config = loadConfig({ TOPMEDIAI_ENV: 'production', TOPMEDIAI_TOKEN: token, MCP_CLIENT_SOURCE: source?.toString(),
      TOPMEDIAI_MEMBER_HOST: backendOrigin, TOPMEDIAI_IMAGE_HOST: backendOrigin, TOPMEDIAI_MUSIC_HOST: backendOrigin,
      TOPMEDIAI_TTS_HOST: backendOrigin, TOPMEDIAI_UPLOAD_HOST: backendOrigin }, () => null);
    const backend = new Backend(config);
    await backend.request(backendOrigin, '/read');
    await backend.create({ description: 'fixture', model_type: 8, number: 1, quality: 8, image_quality: 0, aspect_ratio: 1 });
    await new Backend({ ...config, gatewayHost: backendOrigin }).create({ description: 'fixture', model_type: 8, number: 1, quality: 8, image_quality: 0, aspect_ratio: 1 });
    const multipart = new FormData();
    multipart.set('source', 'original-upload-path');
    await backend.request(backendOrigin, '/upload_file', multipart);
    await new BusinessTransport(config, backendOrigin, 'bearer').request('/music', { body: { prompt: 'fixture' } });
    const transport = new BusinessTransport(config, backendOrigin, 'token');
    await transport.request('/speech', { form: { text: 'hello', source: 4 }, speech: true });
    await transport.request('/media', { multipart });
    await verifyAccountToken({ environment: 'production', memberOrigin: backendOrigin, clientSource: source }, token);

    assert.equal(calls.length, 8);
    for (const call of calls) {
      assert.equal(call.headers.get('source'), source?.toString() ?? null);
      assert.equal(call.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'source').length, source === undefined ? 0 : 1);
      assert.equal(call.headers.get('cookie'), null);
      assert.equal(call.headers.get('accept'), 'application/json');
      assert.equal(call.headers.get('authorization'), call.path === '/music' ? `Bearer ${token}` : null);
      assert.equal(call.headers.get('token'), call.path === '/music' ? null : token);
    }
    assert.equal(JSON.parse(calls[1]!.body).source, 4);
    assert.equal(JSON.parse(calls[2]!.body).source, 4);
    assert.equal(calls[5]!.body, 'text=hello&source=4');
    assert.equal(calls[5]!.headers.get('web-req'), '1');
    assert.equal(calls[5]!.headers.get('x-requested-with'), 'TTS');
    for (const index of [3, 6]) assert.match(calls[index]!.body, /name="source"\r\n\r\noriginal-upload-path/);
  });
}

test('common HTTP layer replaces duplicate casing, omits unknown and never labels unrelated origins', async t => {
  const { origin, calls } = await httpFixture(t);
  const init = { headers: [['Source', '4'], ['source', '6'], ['X-Test', 'preserved']] as [string, string][] };
  for (const source of sources) {
    await businessFetch({ memberHost: origin, clientSource: source }, new URL('/business', origin), init);
    assert.equal(calls.at(-1)!.headers.get('source'), source?.toString() ?? null);
    assert.equal(calls.at(-1)!.headers.get('x-test'), 'preserved');
  }
  await businessFetch({ memberHost: 'https://business.fixture.invalid', clientSource: 5 }, new URL('/cdn', origin), init);
  assert.equal(calls.at(-1)!.headers.get('source'), null);
  assert.deepEqual(init.headers, [['Source', '4'], ['source', '6'], ['X-Test', 'preserved']]);
});

test('shared process isolates concurrent MCP sessions, explicit unknown, reloads and disconnects', async t => {
  const calls: { source: string | null; token: string | null }[] = [];
  let release!: () => void;
  let allArrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { allArrived = resolve; });
  t.after(() => release());
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ source: headers.get('source'), token: headers.get('token') });
    if (calls.length === sources.length) allArrived();
    if (calls.length <= sources.length) await held;
    return Response.json({ status: 200, data: { tp_all: { left: 88 } } });
  });
  const clients: Client[] = [];
  for (const [index, source] of sources.entries()) {
    const config = loadConfig({ MCP_CLIENT_SOURCE: '5', TOPMEDIAI_TOKEN: String.fromCharCode(65 + index).repeat(42) }, () => null);
    const session = { clientSource: source as McpClientSource | undefined };
    const server = createServer(config, async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      // Even a shared loader returning another source cannot overwrite session identity.
      return { ...config, clientSource: 7 };
    }, undefined, session);
    session.clientSource = 7;
    config.clientSource = 6;
    // All peers claim the same client name; source must come from trusted configuration.
    const client = new Client({ name: 'codex', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);
    t.after(async () => { await client.close(); await server.close(); });
    const status = await client.callTool({ name: 'get_service_status', arguments: {} });
    assert.equal((status.structuredContent as Record<string, unknown>).mcp_client_source, source ?? null);
    const tools = await client.listTools();
    assert.ok(tools.tools.every(tool => !('source' in (tool.inputSchema.properties ?? {})) && !('clientSource' in (tool.inputSchema.properties ?? {}))));
  }
  const pending = clients.map(client => client.callTool({ name: 'get_balance', arguments: {} }));
  const completed = Promise.all(pending);
  await arrived;
  // Interleave another round while the first round is still waiting in HTTP.
  await Promise.all(clients.map(client => client.callTool({ name: 'get_balance', arguments: {} })));
  release();
  assert.ok((await completed).every(result => !result.isError));
  await clients[0]!.close();
  await clients[2]!.callTool({ name: 'get_balance', arguments: {} });
  assert.equal(calls.length, 9);
  for (const call of calls) {
    const index = call.token!.charCodeAt(0) - 65;
    assert.equal(call.source, sources[index]?.toString() ?? null);
  }
});
