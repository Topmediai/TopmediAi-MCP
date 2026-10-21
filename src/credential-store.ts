import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import type { Entry, EntryOptions } from '@napi-rs/keyring';
import type { Environment } from './auth-protocol.js';
import { TopMediaiError } from './types.js';

export const CREDENTIAL_SERVICE = 'com.topmediai.mcp';
export type StoreOperation = 'read' | 'write' | 'remove';
export interface CredentialStore {
  read(environment: Environment): string | null;
  readAsync(environment: Environment): Promise<string | null>;
  write(environment: Environment, secret: string): Promise<void>;
  remove(environment: Environment): Promise<void>;
}

export function systemStoreName(platform: string = process.platform): string {
  return platform === 'win32' ? 'Windows Credential Manager' : platform === 'darwin' ? 'macOS Keychain'
    : platform === 'linux' ? 'Linux Secret Service' : 'system credential store';
}

const messages: Record<string, string> = {
  CREDENTIAL_STORE_LOCKED: 'The system credential store is locked. Unlock your keychain or keyring in the system dialog/settings, then retry. Enter your computer password only in the system dialog, never in chat.',
  CREDENTIAL_STORE_DENIED: 'Access to the system credential store was denied or cancelled. Allow access for the TopMediai Node.js process in system settings or the system dialog, then retry.',
  CREDENTIAL_STORE_UNAVAILABLE: 'The system credential store is unavailable. On Linux, start a Secret Service provider (such as GNOME Keyring) in your desktop D-Bus session. On Windows/macOS, check the system credential service and native dependency installation. Credentials will not be saved to a plaintext file.',
  CREDENTIAL_STORE_TIMEOUT: 'The system credential store did not respond in time. Complete any system unlock or access prompt, then retry. Never enter your computer password in chat.',
  CREDENTIAL_COMMIT_UNKNOWN: 'The credential change could not be confirmed. Check login:status after unlocking the system credential store before connecting again. Do not assume login or logout succeeded.',
};

export function storeError(code: string): TopMediaiError {
  const known = Object.hasOwn(messages, code) ? code : 'CREDENTIAL_STORE_UNAVAILABLE';
  return new TopMediaiError(known, messages[known]!);
}

/** Native diagnostics can contain secrets; classify privately and return fixed text only. */
export function normalizeStoreError(error: unknown): TopMediaiError {
  if (error instanceof TopMediaiError && Object.hasOwn(messages, error.code)) return storeError(error.code);
  const message = error instanceof Error ? error.message : '';
  if (/locked|interaction.*not.*allowed|-25308|IsLocked/i.test(message)) return storeError('CREDENTIAL_STORE_LOCKED');
  if (/denied|cancelled|canceled|unauthorized|not authorized|user interaction|errSecAuthFailed|-25293|-128\b/i.test(message)) return storeError('CREDENTIAL_STORE_DENIED');
  return storeError('CREDENTIAL_STORE_UNAVAILABLE');
}

export function nativeOptions(platform: string): EntryOptions {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw storeError('CREDENTIAL_STORE_UNAVAILABLE');
  // Never allow the binding's automatic fallback to the Linux kernel keyring.
  return platform === 'linux' ? { linux: { store: 'secret-service' } } : {};
}

type EntryFactory = (service: string, account: string, options: EntryOptions) => Pick<Entry, 'getPassword' | 'setPassword' | 'deleteCredential'>;
const require = createRequire(import.meta.url);
const nativeEntry: EntryFactory = (service, account, options) => {
  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
  return new Entry(service, account, options);
};

/** Used synchronously only by explicit config embeddings and the isolated helper. */
export function nativeOperation(service: string, environment: Environment, operation: StoreOperation, secret?: string,
  factory: EntryFactory = nativeEntry, platform = process.platform): string | null {
  if (environment !== 'production') throw new TopMediaiError('INVALID_CONFIG', 'This release supports production only.');
  try {
    const entry = factory(service, environment, nativeOptions(platform));
    if (operation === 'read') return entry.getPassword();
    if (operation === 'write') {
      if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') > 2400) throw new Error('Invalid secret size');
      entry.setPassword(secret);
    } else entry.deleteCredential();
    return null;
  } catch (error) { throw normalizeStoreError(error); }
}

/** No shell, arguments, environment variables or disk files carry the secret. */
function isolatedOperation(service: string, environment: Environment, operation: StoreOperation, secret?: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./credential-store-worker.js', import.meta.url), [], {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // Do not forward developer Token overrides or NODE_OPTIONS into the helper.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TOPMEDIAI_|NODE_OPTIONS$)/i.test(key))),
    });
    let reply: { value?: string | null; code?: string } | undefined;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && !Array.isArray(message)) reply = message;
    });
    child.once('error', () => { clearTimeout(timer); reject(storeError('CREDENTIAL_STORE_UNAVAILABLE')); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || !reply) {
        reject(storeError(operation === 'read' ? timedOut ? 'CREDENTIAL_STORE_TIMEOUT' : 'CREDENTIAL_STORE_UNAVAILABLE' : 'CREDENTIAL_COMMIT_UNKNOWN'));
      } else if (reply.code) reject(storeError(reply.code));
      else if (reply.value === null || typeof reply.value === 'string') resolve(reply.value);
      else reject(storeError('CREDENTIAL_STORE_UNAVAILABLE'));
    });
    child.send({ service, environment, operation, secret }, error => { if (error) child.kill(); });
  });
}

export function createSystemCredentialStore(service = CREDENTIAL_SERVICE): CredentialStore {
  return {
    read: environment => nativeOperation(service, environment, 'read'),
    readAsync: environment => isolatedOperation(service, environment, 'read'),
    write: async (environment, secret) => { await isolatedOperation(service, environment, 'write', secret); },
    remove: async environment => { await isolatedOperation(service, environment, 'remove'); },
  };
}

export const systemCredentialStore = createSystemCredentialStore();
