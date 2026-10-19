import { ROOT, type Config } from './config.js';

export function loginGuidance(config: Config, credentialRefreshEnabled: boolean) {
  const overridden = config.credentialSource === 'environment';
  return {
    action: overridden ? 'remove_environment_override' : 'login',
    provider: 'topmediai',
    command: `${process.platform === 'win32' ? 'npm.cmd' : 'npm'} run login`,
    working_directory: ROOT,
    ...(credentialRefreshEnabled && !overridden ? {
      start_tool: 'start_login', wait_tool: 'wait_for_login', cancel_tool: 'cancel_login',
      wait_seconds: 25, continue_original_request: true,
    } : {}),
    follow_up_tool: 'get_service_status',
    verify_account_tool: 'get_balance',
    restart_required: overridden || !credentialRefreshEnabled,
    fallback_allowed: false,
    instructions: overridden
      ? 'A development TOPMEDIAI_TOKEN override takes precedence. Remove it from the launch configuration and reconnect this MCP server, then sign in through the official website.'
      : credentialRefreshEnabled
        ? 'Call start_login to open the official login page, then keep this turn active and call wait_for_login with its login_id until saved or a terminal outcome. waiting means wait again on the same attempt, not finish the reply. After saved, call get_service_status and get_balance and resume the original request with existing inputs and authorization. Do not ask the user to say continue or restart Codex/MCP. If the login tools are unavailable, run the local login command and keep polling its process until it exits; opening the browser alone is not completion.'
        : 'Complete login and confirm the account on the official website. This fixed-config embedding must reload its configuration before using the new credential.',
  };
}
