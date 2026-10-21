import { openBrowser } from '../src/browser.js';
import { loadAuthConfig, loadLocalEnv } from '../src/config.js';
import { acquireLoginLock, saveCredential } from '../src/credentials.js';
import { verifyAccountToken } from '../src/account.js';
import { createLocalAuthSession } from '../src/local-auth.js';
import type { Environment } from '../src/auth-protocol.js';
import { TopMediaiError } from '../src/types.js';
import { parseEnvironmentArguments } from '../src/environment.js';
import { parseClientSource } from '../src/client-source.js';

function parseArguments(): { environment: Environment; showPrivateLink: boolean } {
  const args = process.argv.slice(2);
  return {
    environment: parseEnvironmentArguments(args.filter(arg => arg !== '--show-private-link')),
    showPrivateLink: args.includes('--show-private-link'),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(); loadLocalEnv();
  const config = loadAuthConfig(args.environment);
  const clientSource = parseClientSource(process.env.MCP_CLIENT_SOURCE);
  const release = acquireLoginLock(args.environment);
  let session: Awaited<ReturnType<typeof createLocalAuthSession>> | undefined;
  const interrupt = () => { void session?.cancel(); };
  try {
    session = await createLocalAuthSession({ environment: config.environment, webOrigin: config.webOrigin,
      verifyAccount: (token, signal) => verifyAccountToken({ memberOrigin: config.memberOrigin, environment: config.environment, legacyProductionGateway: config.legacyProductionGateway, clientSource }, token, signal),
      saveCredential: async (account, token, assertCanCommit) => {
        try { await saveCredential(config.environment, account, token, assertCanCommit); }
        catch (error) {
          console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'CREDENTIAL_COMMIT_UNKNOWN: Check login:status before connecting again.');
          throw error;
        }
      },
    });
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    console.log(`Opening the official ${config.environment} connection page. Confirm the account in the browser. Waiting up to 10 minutes.`);
    if (args.showPrivateLink) console.log(`Private link: ${session.authorizationUrl}\nOpen only in this computer's browser. Do not share this link.`);
    if (!await openBrowser(session.authorizationUrl)) {
      if (!args.showPrivateLink) { console.error('The browser could not be opened. Run login again with --show-private-link to open the private link on this computer.'); await session.cancel(); }
      else console.error('Open the private link above in this computer\'s browser.');
    }
    const result = await session.completion;
    if (result.status === 'saved') {
      console.log(`Connected (${config.environment}). The standard MCP entry point reloads saved credentials automatically. Call get_service_status and get_balance again in the same chat; login does not require restarting Codex or MCP.`);
      if (process.env.TOPMEDIAI_TOKEN?.trim()) console.error('A development TOPMEDIAI_TOKEN override takes precedence. If the MCP launch configuration contains it, remove that override and reconnect this MCP server to use saved credentials.');
      console.log('New credentials or backend settings may use a new local task directory. Check website history before resubmitting old tasks.');
    } else { console.log(`Connection ended: ${result.status}. Existing credentials were not automatically removed.`); process.exitCode = 1; }
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); if (session) await session.close(); release(); }
}
main().catch(error => { console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'LOGIN_FAILED: Connection could not be completed. Check local login status.'); process.exitCode = 1; });
