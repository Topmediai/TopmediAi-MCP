import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { installCursor, parseCursorArguments } from '../scripts/install-cursor.js';
import { cursorConfiguration } from '../scripts/setup-cursor.js';
import { pluginConfiguration } from '../scripts/setup-plugin.js';
import { ROOT } from '../src/config.js';
import { TopMediaiError } from '../src/types.js';

async function fixture(t: TestContext) {
  const parent = tmpdir(), root = await mkdtemp(resolve(parent, 'topmediai-cursor-'));
  t.after(async () => {
    const rel = relative(parent, root);
    assert.ok(rel.startsWith('topmediai-cursor-') && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory: resolve(root, '.cursor') };
}

test('Cursor reuses public production settings without serializing credentials or depending on the working directory', () => {
  for (const environment of ['production'] as const) {
    const env = { TOPMEDIAI_TOKEN: 'synthetic-account-secret', COOKIE: 'synthetic-cookie', TOPMEDIAI_SOURCE: '2' };
    const cursor = cursorConfiguration(environment, env).mcpServers.topmediai;
    assert.deepEqual(cursor, { type: 'stdio', ...pluginConfiguration(environment, { ...env, MCP_CLIENT_SOURCE: '7' }).mcpServers.topmediai });
    assert.ok(isAbsolute(cursor.command));
    assert.equal(cursor.args[0], resolve(ROOT, 'dist/src/index.js'));
    assert.equal(cursor.env.TOPMEDIAI_ENV, environment);
    assert.equal(cursor.env.TOPMEDIAI_TOKEN, '');
    assert.ok(!JSON.stringify(cursor).includes('synthetic-'));
  }
  assert.equal(cursorConfiguration(undefined, {}).mcpServers.topmediai.env.TOPMEDIAI_ENV, 'production');
});

test('Cursor CLI supports global/project installation and rejects ambiguous options', () => {
  assert.equal(parseCursorArguments([]).environment, 'production');
  assert.throws(() => parseCursorArguments(['--env=unsupported']), (error: unknown) => error instanceof TopMediaiError && error.code === 'INVALID_CONFIG');
  assert.deepEqual(parseCursorArguments(['--project', 'project with spaces', '--env', 'production']), {
    environment: 'production', cursorDirectory: resolve('project with spaces', '.cursor'),
  });
  assert.equal(parseCursorArguments(['--project=project']).cursorDirectory, resolve('project', '.cursor'));
  for (const args of [
    ['--project'], ['--project='], ['--project', '--env', 'production'], ['--project', 'a', '--project=b'],
    ['--env'], ['--env=staging'], ['--env=production', '--env=production'], ['--token=secret'], ['--unknown'],
  ]) assert.throws(() => parseCursorArguments(args), (error: unknown) => error instanceof TopMediaiError && error.code === 'INVALID_CONFIG');
});

test('Cursor installation preserves other servers/settings and backs up the exact previous config and skill', async t => {
  const { directory } = await fixture(t);
  await mkdir(resolve(directory, 'skills/topmediai-mcp'), { recursive: true });
  const original = '\uFEFF' + JSON.stringify({
    customSetting: { enabled: true },
    mcpServers: {
      unrelated: { url: 'https://other.fixture.invalid/mcp', headers: { Authorization: 'synthetic-other-secret' } },
      topmediai: { command: 'outdated-node', env: { TOPMEDIAI_TOKEN: 'synthetic-old-secret' } },
    },
  });
  const oldSkill = 'Existing user skill\r\n';
  await writeFile(resolve(directory, 'mcp.json'), original);
  await writeFile(resolve(directory, 'skills/topmediai-mcp/SKILL.md'), oldSkill);
  const installed = await installCursor({ cursorDirectory: directory, env: {} });
  const config = JSON.parse(await readFile(installed.configPath, 'utf8'));
  assert.deepEqual(config.customSetting, { enabled: true });
  assert.equal(config.mcpServers.unrelated.headers.Authorization, 'synthetic-other-secret');
  assert.deepEqual(config.mcpServers.topmediai, cursorConfiguration(undefined, {}).mcpServers.topmediai);
  assert.ok(!JSON.stringify(config).includes('synthetic-old-secret'));
  assert.equal(installed.backups.length, 2);
  assert.deepEqual(new Set(await Promise.all(installed.backups.map(path => readFile(path, 'utf8')))), new Set([original, oldSkill]));
  assert.ok(installed.backups.every(path => path.startsWith(resolve(directory, 'backups/topmediai-mcp'))));
  assert.equal(await readFile(installed.skillPath, 'utf8'), await readFile(resolve(ROOT, 'plugin/skills/topmediai-mcp/SKILL.md'), 'utf8'));
});

test('fresh installation is idempotent and updated public settings change only the TopMediai entry', async t => {
  const { directory } = await fixture(t);
  const options = { cursorDirectory: directory, env: {} };
  const first = await installCursor(options);
  assert.equal(first.changed, true);
  assert.deepEqual(first.backups, []);
  const again = await installCursor(options);
  assert.equal(again.changed, false);
  assert.deepEqual(again.backups, []);
  const changed = await installCursor({ ...options, env: { TOPMEDIAI_SOURCE: '2' } });
  assert.equal(changed.backups.length, 1);
  const config = JSON.parse(await readFile(changed.configPath, 'utf8'));
  assert.equal(config.mcpServers.topmediai.env.TOPMEDIAI_ENV, 'production');
  assert.equal(config.mcpServers.topmediai.env.TOPMEDIAI_SOURCE, '2');
});

test('invalid existing JSON/shape is left intact, including the previously installed skill', async t => {
  const { directory } = await fixture(t);
  await mkdir(resolve(directory, 'skills/topmediai-mcp'), { recursive: true });
  await writeFile(resolve(directory, 'skills/topmediai-mcp/SKILL.md'), 'unchanged skill');
  for (const original of ['{ bad: "synthetic-secret" }', '[]', 'null', '{"mcpServers":[]}', '{"mcpServers":null}']) {
    await writeFile(resolve(directory, 'mcp.json'), original);
    await assert.rejects(installCursor({ cursorDirectory: directory, env: {} }), (error: unknown) => {
      assert.ok(error instanceof TopMediaiError);
      assert.equal(error.code, 'INVALID_CURSOR_CONFIG');
      assert.ok(!error.message.includes('synthetic-secret'));
      return true;
    });
    assert.equal(await readFile(resolve(directory, 'mcp.json'), 'utf8'), original);
    assert.equal(await readFile(resolve(directory, 'skills/topmediai-mcp/SKILL.md'), 'utf8'), 'unchanged skill');
  }
});

test('invalid endpoint overrides fail before creating any Cursor installation files', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(installCursor({ cursorDirectory: directory, env: { TOPMEDIAI_MEMBER_HOST: 'http://backend.fixture.invalid' } }),
    (error: unknown) => error instanceof TopMediaiError && error.code === 'INVALID_CONFIG');
  await assert.rejects(readFile(resolve(directory, 'mcp.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(resolve(directory, 'skills/topmediai-mcp/SKILL.md')), { code: 'ENOENT' });
});

test('Cursor plugin manifest discovers the shared skill and a separate generated MCP config', async () => {
  const pluginRoot = resolve(ROOT, 'plugin');
  const cursor = JSON.parse(await readFile(resolve(pluginRoot, '.cursor-plugin/plugin.json'), 'utf8'));
  const codex = JSON.parse(await readFile(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(cursor.name, codex.name);
  assert.equal(cursor.version, codex.version);
  assert.equal(cursor.skills, codex.skills);
  assert.notEqual(cursor.mcpServers, codex.mcpServers);
  assert.ok(!isAbsolute(cursor.mcpServers) && !cursor.mcpServers.includes('..'));
  await readFile(resolve(pluginRoot, cursor.skills, 'topmediai-mcp/SKILL.md'));
  await readFile(resolve(pluginRoot, cursor.logo));
});

test('compiled Cursor installer checks the real stdio entry from a different project directory without account/network calls', { timeout: 45_000 }, async t => {
  const { root } = await fixture(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TOPMEDIAI_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  // Isolate credential lookup from the developer's actual account on either OS.
  const result = await promisify(execFile)(process.execPath, [resolve(ROOT, 'dist/scripts/install-cursor.js'), '--project', root], {
    cwd: root, env: { ...env, NODE_OPTIONS: '--import=' + pathToFileURL(resolve(ROOT, 'dist/tests/fixtures/empty-credential-store.js')).href, LOCALAPPDATA: resolve(root, 'local-app-data'), HOME: root, USERPROFILE: root },
    timeout: 40_000, windowsHide: true,
  });
  assert.match(result.stdout, /Installed TopMediAi-MCP for Cursor \(production\)/);
  assert.match(result.stdout, /tools=35/);
  assert.match(result.stdout, /credential_configured=false, credential_refresh=true/);
  assert.ok(!result.stdout.includes('Authorization') && !result.stdout.includes('Cookie'));
  const config = JSON.parse(await readFile(resolve(root, '.cursor/mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.topmediai.env.TOPMEDIAI_ENV, 'production');
  await readFile(resolve(root, '.cursor/skills/topmediai-mcp/SKILL.md'));
});
