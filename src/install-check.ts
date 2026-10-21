import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TopMediaiError } from './types.js';

/** Local handshake only. This cannot prove tools are attached to the user's current chat. */
export async function checkPluginServer(launch: StdioServerParameters) {
  const client = new Client({ name: 'topmediai-install-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...launch, stderr: 'pipe' });
  // Drain diagnostics without displaying raw configuration or upstream errors.
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 15_000 });
    const tools = (await client.listTools(undefined, { timeout: 15_000 })).tools.map(tool => tool.name);
    for (const name of ['get_service_status', 'start_login', 'wait_for_login', 'cancel_login', 'get_balance', 'review_generation_plan', 'estimate_image_cost', 'generate_image', 'estimate_tts_cost', 'generate_tts', 'estimate_sts_cost', 'generate_sts', 'upload_speech_audio']) {
      if (!tools.includes(name)) throw new TopMediaiError('PLUGIN_CHECK_FAILED', 'The installed MCP does not expose the required TopMediai generation tools.');
    }
    const result = await client.callTool({ name: 'get_service_status', arguments: {} }, undefined, { timeout: 40_000 });
    const status = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError || !status || typeof status.token_configured !== 'boolean') {
      const failure = status?.error as { code?: string } | undefined;
      if (failure?.code?.startsWith('CREDENTIAL_')) {
        throw new TopMediaiError('PLUGIN_CHECK_FAILED', 'The MCP started, but the system credential store could not be read. Unlock or allow access to your system keychain/keyring, and ensure Linux Secret Service is running, then retry. No plaintext fallback is used.');
      }
      throw new TopMediaiError('PLUGIN_CHECK_FAILED', 'The MCP started, but its local credential status could not be checked. Check the local configuration and system credential store access.');
    }
    if (launch.env?.TOPMEDIAI_ENV && status.environment !== launch.env.TOPMEDIAI_ENV) {
      throw new TopMediaiError('PLUGIN_CHECK_FAILED', 'The MCP environment does not match the selected installation environment.');
    }
    return { server_version: client.getServerVersion()?.version, tool_count: tools.length,
      environment: status.environment, api_connection_mode: status.api_connection_mode,
      token_configured: status.token_configured, credential_source: status.credential_source,
      credential_refresh_enabled: status.credential_refresh_enabled === true,
      current_chat_tools_verified: false, backend_account_verified: false };
  } catch (error) {
    if (error instanceof TopMediaiError) throw error;
    throw new TopMediaiError('PLUGIN_CHECK_FAILED', 'The local MCP handshake failed. Check Node, the installed entry path and system credential store access before reconnecting this plugin.');
  } finally { await client.close(); }
}
