import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.js';
import { parsePluginEnvironment, setupPlugin } from './setup-plugin.js';
import { TopMediaiError } from '../src/types.js';
import { checkPluginServer } from '../src/install-check.js';

try {
  const environment = parsePluginEnvironment(process.argv.slice(2));
  const configuration = await setupPlugin(environment, { ...process.env, MCP_CLIENT_SOURCE: '5' });
  for (const args of [
    ['plugin', 'marketplace', 'add', ROOT, '--json'],
    ['plugin', 'add', 'topmediai-mcp@topmediai-local', '--json'],
  ]) {
    const result = spawnSync('codex', args, { encoding: 'utf8', shell: false, windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new TopMediaiError('INSTALL_FAILED', 'Codex CLI installation failed. Check that codex is on PATH and inspect local plugin settings.');
    }
  }
  console.log(`Installed TopMediAi-MCP for ${environment}. No token was copied into the plugin.`);
  const launch = configuration.mcpServers.topmediai;
  const check = await checkPluginServer({ ...launch, env: {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...launch.env,
  } });
  console.log(`Local MCP check: version=${check.server_version}, environment=${check.environment}, connection=${check.api_connection_mode}, tools=${check.tool_count}, credential_configured=${check.token_configured}, credential_refresh=${check.credential_refresh_enabled}. This verifies a separate MCP process, not tool availability in the current Codex chat or backend login validity.`);
  console.log('Next, call TopMediai get_service_status in the current chat. Do not require a Codex restart by default. If tools are missing, first check plugin enablement and refresh/reconnect it; try a new chat if necessary. Never silently use built-in image generation instead.');
  if (!check.token_configured) console.log(`In the same chat, call start_login, confirm the account on the official website, and keep calling wait_for_login with the returned login_id until saved or a terminal outcome. After saved, check get_service_status/get_balance and resume the original request. Do not end the turn after opening the page or ask the user to say continue. Fallback: ${process.platform === 'win32' ? 'npm.cmd' : 'npm'} run login; keep polling its process until it exits. Login does not require a Codex or MCP restart.`);
  else console.log('A saved credential is configured. Verify it with get_balance before creation; the local check does not prove the backend accepts it.');
  console.log('For a plugin version update, refresh the cached package and reconnect its MCP process so the new code is used. Restart the app only as a last resort for a diagnosed host loading issue.');
} catch (error) {
  console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'INSTALL_FAILED: Plugin installation could not be completed.');
  process.exitCode = 1;
}
