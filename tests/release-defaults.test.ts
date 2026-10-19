import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAuthConfig, loadConfig, createAsyncRuntimeConfigLoader, ROOT } from '../src/config.js';
import { parseEnvironmentArguments, PRODUCTION_DEFAULTS } from '../src/environment.js';
import { pluginConfiguration } from '../scripts/setup-plugin.js';
import { loginGuidance } from '../src/onboarding.js';
import { verifyAccountToken } from '../src/account.js';

test('fresh install and distributed example resolve the same production configuration', () => {
  const example: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(resolve(ROOT, '.env.example'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) example[match[1]!] = match[2]!;
  }
  const installed = pluginConfiguration(undefined, {}).mcpServers.topmediai.env;
  assert.deepEqual(pluginConfiguration(undefined, example).mcpServers.topmediai.env, installed);
  for (const [key, origin] of Object.entries(PRODUCTION_DEFAULTS)) assert.equal(installed[key], origin);
  assert.equal(installed.TOPMEDIAI_ENV, 'production');
  assert.equal(installed.TOPMEDIAI_TOKEN, '');
  assert.equal(loadConfig(example, () => null).gatewayHost, undefined);
  assert.equal(loadConfig(example, () => null).uploadPublicOrigin, 'https://files.topmediai.com');
});

test('public configuration and command arguments reject unsupported environments before reading credentials', () => {
  assert.equal(parseEnvironmentArguments([]), 'production');
  assert.equal(parseEnvironmentArguments(['--env=production']), 'production');
  for (const value of ['development', 'staging', '', 'unsupported']) {
    assert.throws(() => parseEnvironmentArguments(['--env', value]), { code: 'INVALID_CONFIG' });
    assert.throws(() => loadConfig({ TOPMEDIAI_ENV: value }, () => assert.fail('Must reject before private reads')), { code: 'INVALID_CONFIG' });
    assert.throws(() => loadAuthConfig(value as 'production', {}), { code: 'INVALID_CONFIG' });
    assert.throws(() => pluginConfiguration(value as 'production', {}), { code: 'INVALID_CONFIG' });
  }
});

test('runtime refresh and browser login select only production credentials and origins', async () => {
  const loader = createAsyncRuntimeConfigLoader({}, async environment => {
    assert.equal(environment, 'production'); return null;
  });
  const config = await loader();
  assert.deepEqual(loadAuthConfig(undefined, {}), {
    environment: 'production', webOrigin: PRODUCTION_DEFAULTS.TOPMEDIAI_PRODUCTION_WEB_ORIGIN,
    memberOrigin: PRODUCTION_DEFAULTS.TOPMEDIAI_MEMBER_HOST,
  });
  assert.equal(loginGuidance(config, true).command, `${process.platform === 'win32' ? 'npm.cmd' : 'npm'} run login`);
});

test('account verification refuses insecure origins without issuing a request', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Rejected origin must not reach the network'));
  for (const memberOrigin of ['http://127.0.0.1:12345', 'https://example.invalid/path']) {
    await assert.rejects(verifyAccountToken({ environment: 'production', memberOrigin }, 'A'.repeat(42)), { code: 'account_unavailable' });
  }
});
