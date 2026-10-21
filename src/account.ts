import { AuthProtocolError, isRecord, normalizeMemberId, validToken, type Environment } from './auth-protocol.js';
import { TopMediaiError } from './types.js';
import { readJson } from './transport/json.js';
import { businessFetch } from './transport/http.js';
import type { McpClientSource } from './client-source.js';

export type { Environment } from './auth-protocol.js';
export interface VerifiedAccount {
  memberId: string;
  email: string;
  emailMasked: string;
}
export class AccountVerificationError extends TopMediaiError {
  constructor(public readonly code: 'login_required' | 'account_unavailable') {
    super(code, code);
    this.name = 'AccountVerificationError';
  }
}
export interface AccountVerificationOptions {
  memberOrigin: string;
  environment: Environment;
  /** Compatibility with the separately configured production gateway only. */
  legacyProductionGateway?: boolean;
  timeoutMs?: number;
  clientSource?: McpClientSource;
}
export function normalizeAccountIdentity(value: unknown): VerifiedAccount {
  if (!isRecord(value)) throw new AccountVerificationError('account_unavailable');
  if (['is_tourist', 'is_guest'].some(key => value[key] === true || value[key] === 1 || value[key] === '1')
    || value.identity_type === 'tourist' || value.user_type === 'tourist') {
    throw new AccountVerificationError('login_required');
  }
  if (value.product_type !== undefined && value.product_type !== 1 && value.product_type !== '1') {
    throw new AccountVerificationError('account_unavailable');
  }
  let memberId: string;
  try { memberId = normalizeMemberId(value.member_id); }
  catch (error) {
    if (error instanceof AuthProtocolError) throw new AccountVerificationError('account_unavailable');
    throw error;
  }
  const email = value.email;
  if (typeof email !== 'string' || email.length > 254
    || !/^[^@\s\u0000-\u001f\u007f]+@[^@\s\u0000-\u001f\u007f]+\.[^@\s\u0000-\u001f\u007f]+$/.test(email)) {
    throw new AccountVerificationError('account_unavailable');
  }
  const at = email.lastIndexOf('@');
  return { memberId, email, emailMasked: `${Array.from(email.slice(0, at))[0]}***${email.slice(at)}` };
}
function approvedOrigin(options: AccountVerificationOptions): URL {
  try {
    const url = new URL(options.memberOrigin);
    if (url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash
      || options.environment !== 'production'
      || (options.legacyProductionGateway && options.environment !== 'production')) throw new Error();
    return url;
  } catch { throw new AccountVerificationError('account_unavailable'); }
}
export async function verifyAccountToken(
  options: AccountVerificationOptions, token: string, signal?: AbortSignal,
): Promise<VerifiedAccount> {
  if (!validToken(token)) throw new AccountVerificationError('login_required');
  const origin = approvedOrigin(options);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new AccountVerificationError('account_unavailable');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const path = options.legacyProductionGateway ? '/client/openclaw/v1/account' : '/user/member/info?product_type=1';
    const response = await businessFetch({ memberHost: origin.origin, clientSource: options.clientSource }, new URL(path, origin), {
      method: 'GET', headers: { Accept: 'application/json', token },
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: combined,
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new AccountVerificationError('login_required');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccountVerificationError('account_unavailable');
    }
    const body = await readJson(response);
    if (!isRecord(body)) throw new AccountVerificationError('account_unavailable');
    if (body.status === 401 || body.status === '401') {
      throw new AccountVerificationError('login_required');
    }
    if (body.status !== 200 && body.status !== '200') {
      throw new AccountVerificationError('account_unavailable');
    }
    return normalizeAccountIdentity(body.data);
  } catch (error) {
    if (error instanceof AccountVerificationError) throw error;
    throw new AccountVerificationError('account_unavailable');
  }
}
