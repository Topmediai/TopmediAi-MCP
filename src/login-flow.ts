import { randomUUID } from 'node:crypto';
import { loadAuthConfig, type Config } from './config.js';
import { acquireLoginLock, saveCredential } from './credentials.js';
import { verifyAccountToken } from './account.js';
import { createLocalAuthSession, type LocalAuthResult, type LocalAuthSession } from './local-auth.js';
import { openBrowser } from './browser.js';
import { TopMediaiError } from './types.js';
import type { CredentialStore } from './credential-store.js';

export interface LoginFlowDependencies {
  createSession?: typeof createLocalAuthSession;
  openBrowser?: typeof openBrowser;
  acquireLock?: typeof acquireLoginLock;
  launchEnvironment?: NodeJS.ProcessEnv;
  credentialStore?: CredentialStore;
}
interface LoginAttempt {
  id: string;
  session: LocalAuthSession;
  expiresAt: string;
  result?: LocalAuthResult;
  finished: Promise<LocalAuthResult>;
  cleanup: Promise<void>;
  credentialError?: { code: string; message: string };
}

/** One local authorization attempt; wait calls never create a new browser/session. */
export class LoginFlow {
  private attempt?: LoginAttempt;
  private starting?: Promise<object>;
  private closed = false;
  private readonly launchEnvironment: NodeJS.ProcessEnv;

  constructor(private readonly config: Config, private readonly credentialRefreshEnabled: boolean,
    private readonly dependencies: LoginFlowDependencies = {}) {
    // Auth uses the same frozen member backend/environment as account tools.
    this.launchEnvironment = Object.freeze({ ...(dependencies.launchEnvironment ?? process.env),
      TOPMEDIAI_MEMBER_HOST: config.memberHost,
      TOPMEDIAI_PRODUCTION_GATEWAY_HOST: config.gatewayHost ?? '',
    });
  }

  private reply(attempt: LoginAttempt) {
    const status = attempt.result?.status ?? 'waiting';
    return { login_id: attempt.id, status, environment: this.config.environment,
      expires_at: attempt.expiresAt, restart_required: false,
      ...(status === 'waiting' ? {
        next_tool: 'wait_for_login', wait_seconds: 25, continue_original_request: true,
        instructions: 'The official login page is open. Keep this turn active and call wait_for_login with this login_id. If still waiting, wait again on the same session. Do not end the reply or ask the user to say continue.',
      } : status === 'saved' && attempt.result?.status === 'saved' ? {
        account: { email_masked: attempt.result.account.emailMasked },
        next_tools: ['get_service_status', 'get_balance'], continue_original_request: true,
        instructions: 'Login credentials were saved after account verification. Check get_service_status and get_balance in this chat, then resume the original request using its existing inputs and authorization. Do not replay paid or uncertain submissions.',
      } : {
        continue_original_request: false,
        instructions: `Login ended: ${status}. Report this outcome; do not start another login automatically or submit generation. Existing saved credentials were not automatically removed.`,
      }),
      ...(attempt.credentialError ? { credential_error: attempt.credentialError,
        instructions: 'Credential storage needs attention. Explain credential_error.message and wait for the user to resolve the system prompt. Do not claim login succeeded or reopen the website automatically. If the session is still waiting, retry the connection confirmation in the existing page after resolving the store issue; if terminal, check login:status before starting another connection.' } : {}) };
  }

  async start(): Promise<object> {
    if (this.closed) throw new TopMediaiError('LOGIN_UNAVAILABLE', 'The MCP connection has closed.');
    if (!this.credentialRefreshEnabled || this.config.credentialSource === 'environment') {
      throw new TopMediaiError('LOGIN_RELOAD_REQUIRED', 'Browser login needs automatic saved-credential refresh without a development token override. Remove any launch token override and reconnect this MCP before starting login.');
    }
    if (this.starting) return this.starting;
    if (this.attempt && !this.attempt.result) return this.reply(this.attempt);
    this.starting = this.begin();
    try { return await this.starting; }
    finally { this.starting = undefined; }
  }

  private async begin(): Promise<object> {
    if (this.attempt) await this.attempt.cleanup;
    if (this.closed) throw new TopMediaiError('LOGIN_UNAVAILABLE', 'The MCP connection has closed.');
    const auth = loadAuthConfig(this.config.environment, this.launchEnvironment);
    const unlock = (this.dependencies.acquireLock ?? acquireLoginLock)(auth.environment);
    let released = false;
    const release = () => { if (!released) { released = true; unlock(); } };
    let session: LocalAuthSession | undefined;
    let credentialError: LoginAttempt['credentialError'];
    try {
      session = await (this.dependencies.createSession ?? createLocalAuthSession)({
        environment: auth.environment, webOrigin: auth.webOrigin,
        verifyAccount: (token, signal) => verifyAccountToken({ ...auth, clientSource: this.config.clientSource }, token, signal),
        saveCredential: async (account, token, assertCanCommit) => {
          credentialError = undefined;
          try { await saveCredential(auth.environment, account, token, assertCanCommit, this.dependencies.credentialStore); }
          catch (error) {
            credentialError = error instanceof TopMediaiError ? { code: error.code, message: error.message }
              : { code: 'CREDENTIAL_COMMIT_UNKNOWN', message: 'Credential storage could not be confirmed. Check login:status before connecting again.' };
            throw error;
          }
        },
      });
      const expiresAt = Number(new URLSearchParams(new URL(session.authorizationUrl).hash.slice(1)).get('expires_at'));
      const attempt: LoginAttempt = { id: randomUUID(), session,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        finished: session.completion, cleanup: Promise.resolve(),
        get credentialError() { return credentialError; } };
      attempt.finished = session.completion.then(result => { attempt.result = result; return result; });
      attempt.cleanup = attempt.finished.then(() => session!.close()).finally(release);
      // Cleanup stays observable to a subsequent start, without an unhandled rejection.
      void attempt.cleanup.catch(() => {});
      this.attempt = attempt;
      if (this.closed) throw new TopMediaiError('LOGIN_UNAVAILABLE', 'The MCP connection has closed.');
      if (!await (this.dependencies.openBrowser ?? openBrowser)(session.authorizationUrl)) {
        throw new TopMediaiError('LOGIN_BROWSER_OPEN_FAILED', 'The browser could not be opened. Use the local login command from login_guidance; open a private link only on this computer, never paste it into chat.');
      }
      return this.reply(attempt);
    } catch (error) {
      try { if (session) await session.cancel(); }
      finally { release(); }
      if (error instanceof TopMediaiError) throw error;
      throw new TopMediaiError('LOGIN_START_FAILED', 'The local login session could not be started. Check the approved login configuration and local permissions.');
    }
  }

  private get(id: string): LoginAttempt {
    if (!this.attempt || this.attempt.id !== id) throw new TopMediaiError('LOGIN_NOT_FOUND', 'This login_id does not belong to the current MCP session. Use the ID returned by start_login.');
    return this.attempt;
  }

  async wait(id: string, seconds = 25, signal?: AbortSignal): Promise<object> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 25) throw new TopMediaiError('INVALID_REQUEST', 'Wait between 1 and 25 seconds per call.');
    const attempt = this.get(id);
    if (!attempt.result && !signal?.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop!: () => void;
      const bounded = new Promise<void>(resolve => { stop = resolve; timer = setTimeout(resolve, seconds * 1000); });
      signal?.addEventListener('abort', stop, { once: true });
      try { await Promise.race([attempt.finished, bounded]); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
    }
    return this.reply(attempt);
  }

  async cancel(id: string): Promise<object> {
    const attempt = this.get(id);
    if (!attempt.result) await attempt.session.cancel();
    await attempt.finished;
    // A completed save retains its original receipt window; cancellation cannot undo it.
    return { ...this.reply(attempt), cancel_requested: true, continue_original_request: false,
      instructions: 'The user requested stopping this login flow. Report its final status and do not resume the original request or submit generation. A login already saved cannot be undone by cancellation; saved credentials were not removed.' };
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.starting; } catch { /* A failed start already releases its lock. */ }
    if (this.attempt) {
      // Explicit disconnect must release the lock before the host terminates stdio.
      // Normal completion still keeps the browser's original receipt retry window.
      await this.attempt.session.cancel();
      await this.attempt.cleanup;
    }
  }
}
