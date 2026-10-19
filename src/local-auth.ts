import { generateKeyPair, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import {
  AUTH_VERSION, AuthProtocolError, MAX_BODY_BYTES, checkHandoffProof, decryptHandoffPayload,
  parseEnvelope, requestFingerprint, type AuthContext, type HandoffPayload,
} from './auth-protocol.js';
import { AccountVerificationError, normalizeAccountIdentity, type Environment, type VerifiedAccount } from './account.js';

export type { Environment, VerifiedAccount } from './account.js';
export type LocalAuthResult =
  | { status: 'saved'; account: VerifiedAccount }
  | { status: 'cancelled' | 'expired' | 'aborted' };
export interface LocalAuthOptions {
  environment: Environment;
  webOrigin: string;
  verifyAccount: (token: string, signal: AbortSignal) => Promise<VerifiedAccount>;
  /** Check immediately before replacement; returned ms bounds post-commit checks. Resolve only after file and ACL verification. */
  saveCredential: (account: VerifiedAccount, token: string, assertCanCommit: () => number) => Promise<void>;
  authorizationTimeoutMs?: number;
  acknowledgementTimeoutMs?: number;
  memberTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Injectable monotonic clock for isolated tests; never taken from the browser. */
  now?: () => number;
}
export interface LocalAuthSession {
  authorizationUrl: string;
  completion: Promise<LocalAuthResult>;
  cancel: () => Promise<void>;
  close: () => Promise<void>;
}
type State = 'waiting' | 'verifying' | 'saved' | 'cancelled' | 'expired' | 'aborted';
type Receipt = { status: 'saved' | 'cancelled'; fingerprint: string; nonce: string; deadline: number };
const MAX_REQUESTS = 256;

function duration(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647) {
    throw new AuthProtocolError('invalid_request');
  }
  return ms;
}
function officialOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new AuthProtocolError('invalid_request'); }
}
function rsaKeys(): Promise<{ publicKey: KeyObject; privateKey: KeyObject }> {
  return new Promise((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 2048, publicExponent: 65537 }, (error, publicKey, privateKey) => {
      if (error) reject(new AuthProtocolError('receiver_unavailable', 503));
      else resolve({ publicKey, privateKey });
    });
  });
}
function uniqueHeader(req: IncomingMessage, name: string, required = true): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1] ?? '');
  }
  if (values.length > 1 || (required && (values.length !== 1 || !values[0]))) {
    throw new AuthProtocolError('invalid_handoff', 403);
  }
  return values[0];
}
async function readBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), timeoutMs);
  try {
    const advertised = req.headers['content-length'];
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BODY_BYTES)) {
      throw new AuthProtocolError('invalid_request');
    }
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) throw new AuthProtocolError('invalid_request');
      chunks.push(bytes);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new AuthProtocolError('invalid_request'); }
  finally { clearTimeout(timer); }
}
function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AccountVerificationError('account_unavailable'));
    if (signal.aborted) { pending.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function createLocalAuthSession(options: LocalAuthOptions): Promise<LocalAuthSession> {
  if (options.environment !== 'production') {
    throw new AuthProtocolError('invalid_request');
  }
  const webOrigin = officialOrigin(options.webOrigin);
  const authorizationMs = duration(options.authorizationTimeoutMs, 600_000);
  const acknowledgementMs = duration(options.acknowledgementTimeoutMs, 10_000);
  const memberMs = duration(options.memberTimeoutMs, 60_000);
  const requestMs = duration(options.requestTimeoutMs, 5_000);
  const now = options.now ?? (() => performance.now());
  const stateId = randomUUID();
  const secret = randomBytes(32);
  let state: State = 'waiting';
  let context: AuthContext;
  let privateKey: KeyObject | undefined;
  let deadline = Infinity;
  let receipt: Receipt | undefined;
  let operationId = 0;
  let activeOperation: Promise<void> | undefined;
  let operationAbort: AbortController | undefined;
  let cancellationRequested = false;
  let authorizationTimer: ReturnType<typeof setTimeout> | undefined;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let closingPromise: Promise<void> | undefined;
  let requests = 0;
  let completed = false;
  let resolveCompletion!: (result: LocalAuthResult) => void;
  const completion = new Promise<LocalAuthResult>(resolve => { resolveCompletion = resolve; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });

  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => { void handle(req, res); });
  server.headersTimeout = requestMs;
  server.requestTimeout = requestMs;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 8;
  server.on('clientError', (_error, socket) => {
    const body = JSON.stringify({ code: 400, msg: 'invalid_request', data: null });
    if (socket.writable && !socket.destroyed) {
      socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } else socket.destroy();
  });
  function closeSocket(): Promise<void> {
    if (closingPromise) return closingPromise;
    clearTimeout(authorizationTimer);
    clearTimeout(receiptTimer);
    closingPromise = new Promise(resolve => {
      server.closeAllConnections();
      server.close(() => {
        privateKey = undefined;
        secret.fill(0);
        receipt = undefined;
        resolveClosed();
        resolve();
      });
    });
    return closingPromise;
  }
  function complete(result: LocalAuthResult): void {
    if (!completed) { completed = true; resolveCompletion(result); }
  }
  function finishWithoutReceipt(status: 'expired' | 'aborted'): void {
    state = status;
    complete({ status });
    // Allow a current sanitized error response to flush before shutting down.
    const timer = setTimeout(() => { void closeSocket(); }, 25);
    timer.unref();
  }
  function finishReceipt(
    status: 'saved' | 'cancelled', fingerprint: string, nonce: string, account?: VerifiedAccount,
  ): boolean {
    clearTimeout(authorizationTimer);
    state = status;
    const finishedAt = now();
    const receiptDeadline = Math.min(finishedAt + acknowledgementMs, deadline + acknowledgementMs);
    receipt = { status, fingerprint, nonce, deadline: receiptDeadline };
    if (status === 'saved' && account) complete({ status, account });
    else complete({ status: 'cancelled' });
    const receiptRemaining = Math.max(0, receiptDeadline - finishedAt);
    receiptTimer = setTimeout(() => { void closeSocket(); }, receiptRemaining);
    receiptTimer.unref();
    return receiptRemaining > 0;
  }
  function remaining(): number { return deadline - now(); }
  function assertActive(id: number): void {
    if (cancellationRequested || state !== 'verifying' || operationId !== id || closingPromise) {
      throw new AuthProtocolError('already_completed', 409);
    }
    if (remaining() <= 0) throw new AuthProtocolError('expired', 410);
  }
  function headers(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.headers.origin === webOrigin) res.setHeader('Access-Control-Allow-Origin', webOrigin);
  }
  function json(res: ServerResponse, status: number, msg: string, data: unknown = null): void {
    if (res.destroyed || res.writableEnded) return;
    res.statusCode = status;
    res.end(JSON.stringify({ code: status, msg, data }));
  }
  function boundary(req: IncomingMessage): void {
    if (req.socket.localAddress !== '127.0.0.1' || req.socket.remoteAddress !== '127.0.0.1'
      || uniqueHeader(req, 'host') !== `127.0.0.1:${context?.port}`
      || uniqueHeader(req, 'origin') !== webOrigin) {
      throw new AuthProtocolError('invalid_handoff', 403);
    }
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'forwarded', 'x-forwarded-host', 'x-forwarded-for']) {
      if (uniqueHeader(req, name, false) !== undefined) throw new AuthProtocolError('invalid_handoff', 403);
    }
    if (req.url !== '/v1/complete') throw new AuthProtocolError('invalid_request');
  }
  async function processApproval(
    payload: Extract<HandoffPayload, { decision: 'approve' }>, fingerprint: string, res: ServerResponse, id: number,
  ): Promise<void> {
    let phase: 'account' | 'save' = 'account';
    let commitStarted = false;
    let integrationFailure = false;
    try {
      operationAbort = new AbortController();
      const signal = AbortSignal.any([
        operationAbort.signal, AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(memberMs, remaining())))),
      ]);
      const received = await withAbort(options.verifyAccount(payload.token, signal), signal);
      assertActive(id);
      const account = normalizeAccountIdentity({ member_id: received.memberId, email: received.email });
      if (account.memberId !== payload.expected_member_id) throw new AuthProtocolError('account_changed', 409);
      phase = 'save';
      await options.saveCredential(account, payload.token, () => {
        assertActive(id);
        commitStarted = true;
        return Math.max(0, deadline + acknowledgementMs - now());
      });
      if (!commitStarted) {
        // A faulty integration must not claim success or allow another overwrite.
        integrationFailure = true;
        throw new AuthProtocolError('credential_save_failed', 503);
      }
      if (finishReceipt('saved', fingerprint, payload.receipt_nonce, account)) {
        json(res, 200, 'success', { status: 'saved', receipt_nonce: payload.receipt_nonce });
      } else json(res, 410, 'expired');
    } catch (error) {
      if (commitStarted || integrationFailure) {
        finishWithoutReceipt('aborted');
        json(res, 503, 'credential_commit_unknown');
      } else if (cancellationRequested) {
        finishWithoutReceipt('aborted');
        json(res, 409, 'already_completed');
      } else if (remaining() <= 0) {
        finishWithoutReceipt('expired');
        json(res, 410, 'expired');
      } else {
        state = 'waiting';
        if (error instanceof AccountVerificationError) {
          json(res, error.code === 'login_required' ? 401 : 503, error.code);
        } else if (error instanceof AuthProtocolError) {
          json(res, error.status, error.code);
        } else json(res, 503, phase === 'save' ? 'credential_save_failed' : 'account_unavailable');
      }
    } finally {
      if (operationId === id) { activeOperation = undefined; operationAbort = undefined; }
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    headers(req, res);
    try {
      if (++requests > MAX_REQUESTS) {
        res.setHeader('Retry-After', '1');
        json(res, 429, 'too_many_requests'); return;
      }
      boundary(req);
      if (req.method === 'OPTIONS') {
        if (uniqueHeader(req, 'access-control-request-method') !== 'POST') throw new AuthProtocolError('invalid_request');
        const requested = uniqueHeader(req, 'access-control-request-headers')!.toLowerCase().split(',').map(x => x.trim());
        if (requested.length !== 2 || new Set(requested).size !== 2
          || !requested.includes('content-type') || !requested.includes('handoff-proof')) {
          throw new AuthProtocolError('invalid_request');
        }
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, handoff-proof');
        res.statusCode = 204; res.end(); return;
      }
      if (req.method !== 'POST') throw new AuthProtocolError('invalid_request');
      if (uniqueHeader(req, 'content-type')!.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new AuthProtocolError('invalid_request');
      }
      const proof = uniqueHeader(req, 'handoff-proof')!;
      const envelope = parseEnvelope(await readBody(req, requestMs));
      if (envelope.state !== context.state || envelope.environment !== context.environment || !privateKey) {
        throw new AuthProtocolError('invalid_handoff', 403);
      }
      checkHandoffProof(proof, secret, context, envelope.ciphertext);
      const fingerprint = requestFingerprint(envelope, proof);
      if (state === 'saved' || state === 'cancelled') {
        if (!receipt || now() >= receipt.deadline) throw new AuthProtocolError('expired', 410);
        if (fingerprint !== receipt.fingerprint) throw new AuthProtocolError('already_completed', 409);
        json(res, 200, 'success', { status: receipt.status, receipt_nonce: receipt.nonce }); return;
      }
      if (state === 'expired') throw new AuthProtocolError('expired', 410);
      if (state === 'aborted' || closingPromise) throw new AuthProtocolError('already_completed', 409);
      if (remaining() <= 0) {
        operationAbort?.abort();
        if (state === 'waiting') finishWithoutReceipt('expired');
        throw new AuthProtocolError('expired', 410);
      }
      if (state === 'verifying') throw new AuthProtocolError('in_progress', 409);
      const payload = decryptHandoffPayload(privateKey, context, envelope.ciphertext);
      if (remaining() <= 0) { finishWithoutReceipt('expired'); throw new AuthProtocolError('expired', 410); }
      if (payload.decision === 'deny') {
        if (finishReceipt('cancelled', fingerprint, payload.receipt_nonce)) {
          json(res, 200, 'success', { status: 'cancelled', receipt_nonce: payload.receipt_nonce });
        } else json(res, 410, 'expired');
        return;
      }
      state = 'verifying';
      const id = ++operationId;
      activeOperation = processApproval(payload, fingerprint, res, id);
      await activeOperation;
    } catch (error) {
      if (error instanceof AuthProtocolError) json(res, error.status, error.code);
      else json(res, 503, 'receiver_unavailable');
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new AuthProtocolError('receiver_unavailable', 503));
      server.once('error', fail);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', fail); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new AuthProtocolError('receiver_unavailable', 503);
    context = { state: stateId, environment: options.environment, port: address.port };
    deadline = now() + authorizationMs;
    const expiresAt = Math.floor((Date.now() + authorizationMs) / 1000);
    authorizationTimer = setTimeout(() => {
      if (state === 'waiting') { state = 'expired'; complete({ status: 'expired' }); void closeSocket(); }
      else if (state === 'verifying') operationAbort?.abort();
    }, authorizationMs);
    authorizationTimer.unref();
    const keys = await rsaKeys();
    privateKey = keys.privateKey;
    if (state !== 'waiting' || remaining() <= 0) throw new AuthProtocolError('expired', 410);
    const authorization = new URL('/mcp/connect', webOrigin);
    authorization.hash = new URLSearchParams({
      v: String(AUTH_VERSION), env: options.environment, port: String(context.port), state: context.state,
      secret: secret.toString('base64url'), public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      expires_at: String(expiresAt),
    }).toString();
    async function cancel(): Promise<void> {
      cancellationRequested = true;
      operationAbort?.abort();
      if (activeOperation) await activeOperation;
      if (state === 'waiting' || state === 'verifying') { state = 'aborted'; complete({ status: 'aborted' }); }
      await closeSocket();
    }
    async function close(): Promise<void> {
      if ((state === 'saved' || state === 'cancelled') && receipt) {
        // CLI cleanup must keep the original ACK window after completion resolves.
        await closed;
      } else await cancel();
    }
    return { authorizationUrl: authorization.href, completion, cancel, close };
  } catch (error) {
    state = 'aborted'; complete({ status: 'aborted' });
    await closeSocket();
    if (error instanceof AuthProtocolError) throw error;
    throw new AuthProtocolError('receiver_unavailable', 503);
  }
}
