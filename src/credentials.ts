import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Environment } from './auth-protocol.js';
import type { VerifiedAccount } from './account.js';
import { TopMediaiError } from './types.js';
import { systemCredentialStore, normalizeStoreError, storeError, type CredentialStore } from './credential-store.js';

export interface Credential {
  format_version: 1;
  environment: Environment;
  member_id: string;
  email_masked: string;
  token: string;
  obtained_at: string;
  token_expires_at: null;
}

export function credentialDirectory(): string {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) throw new TopMediaiError('CREDENTIAL_LOCATION_UNAVAILABLE', 'The Windows user private directory is unavailable.');
    return join(process.env.LOCALAPPDATA, 'TopMediai', 'credentials');
  }
  return join(homedir(), '.local', 'share', 'topmediai', 'credentials');
}

function powershell(script: string, timeoutMs = 10_000): string {
  if (timeoutMs < 1) throw new TopMediaiError('CREDENTIAL_PERMISSION_FAILED', 'The credential permission verification deadline has elapsed.');
  const wrapped = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.GetType().Name + ': ' + $_.Exception.Message); exit 1 }`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.ceil(Math.min(10_000, timeoutMs))), stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const error = new TopMediaiError('CREDENTIAL_PERMISSION_FAILED', 'Private Windows credential permissions could not be verified.');
    // The ACL command receives a path only, never the credential contents. CLI output uses the fixed message above.
    error.cause = new Error((result.error as NodeJS.ErrnoException | undefined)?.code ?? result.stderr.trim().slice(0, 1024));
    throw error;
  }
  return result.stdout.trim();
}

function psLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function safeNode(path: string, directory: boolean): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new TopMediaiError('UNSAFE_CREDENTIAL_FILE', 'The credential location must be a regular private file or directory.');
  }
  if (!directory && (info.nlink !== 1 || info.size > 8192)) throw new TopMediaiError('UNSAFE_CREDENTIAL_FILE', 'The credential file is not a supported private file.');
}

function privateAclCheckScript(path: string, directory: boolean): string {
  return `$p=${psLiteral(resolve(path))}; $a=[System.IO.${directory ? 'Directory' : 'File'}]::GetAccessControl($p); $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    if($owner -ne $me -or -not $a.AreAccessRulesProtected) { throw 'private ACL required' };
    $allowed=@($me,'S-1-5-18','S-1-5-32-544'); $mine=$false;
    foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if($r.AccessControlType -eq 'Allow') {
        if($allowed -notcontains $r.IdentityReference.Value) { throw 'unexpected access rule' };
        if($r.IdentityReference.Value -eq $me -and ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {$mine=$true};
      }
    }; if(-not $mine) { throw 'user access required' };`;
}

export function protectPrivatePath(path: string, directory: boolean): void {
  safeNode(path, directory);
  if (process.platform !== 'win32') { chmodSync(path, directory ? 0o700 : 0o600); assertPrivatePath(path, directory); return; }
  powershell(`$p=${psLiteral(resolve(path))}; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $a=[System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}]::new();
    $a.SetOwner($me); $a.SetAccessRuleProtection($true,$false);
    foreach($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')) {
      $id=[System.Security.Principal.SecurityIdentifier]::new($sid);
      $r=[System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl',${directory ? "'ContainerInherit, ObjectInherit'" : "'None'"},'None','Allow');
      $a.AddAccessRule($r);
    }; [System.IO.${directory ? 'Directory' : 'File'}]::SetAccessControl($p,$a);
    ${privateAclCheckScript(path, directory)}`);
  safeNode(path, directory);
}

export function assertPrivatePath(path: string, directory: boolean, timeoutMs = 10_000): void {
  safeNode(path, directory);
  if (process.platform !== 'win32') {
    const info = lstatSync(path);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new TopMediaiError('UNSAFE_CREDENTIAL_PERMISSIONS', 'Credential permissions must be private to the current user.');
    return;
  }
  powershell(privateAclCheckScript(path, directory), timeoutMs);
}

export function ensureCredentialDirectory(directory = credentialDirectory()): void {
  if (!existsSync(directory)) { mkdirSync(directory, { recursive: true, mode: 0o700 }); protectPrivatePath(directory, true); return; }
  assertPrivatePath(directory, true);
}

function parseCredential(text: string, environment: Environment): Credential {
  let value: Credential;
  try {
    if (Buffer.byteLength(text, 'utf8') > 2400) throw new Error();
    value = JSON.parse(text) as Credential;
  } catch { throw new TopMediaiError('CREDENTIAL_CORRUPT', 'The saved system credential is invalid. Connect your account again.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format_version !== 1 || value.environment !== environment
    || typeof value.member_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.member_id)
    || typeof value.token !== 'string' || !/^[A-Za-z0-9]{42}$/.test(value.token)
    || typeof value.email_masked !== 'string' || !value.email_masked || value.email_masked.length > 258
    || typeof value.obtained_at !== 'string' || !Number.isFinite(Date.parse(value.obtained_at)) || value.token_expires_at !== null) {
    throw new TopMediaiError('CREDENTIAL_CORRUPT', 'The local credential is invalid or belongs to another environment. Run login again.');
  }
  const keys = ['format_version', 'environment', 'member_id', 'email_masked', 'token', 'obtained_at', 'token_expires_at'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TopMediaiError('CREDENTIAL_CORRUPT', 'The credential format is unsupported.');
  return value;
}

/** Secrets are never read from or written to legacy JSON files. */
export function readCredential(environment: Environment, store: CredentialStore = systemCredentialStore): Credential | null {
  let text: string | null;
  try { text = store.read(environment); } catch (error) { throw normalizeStoreError(error); }
  return text === null ? null : parseCredential(text, environment);
}

export async function readCredentialAsync(environment: Environment, store: CredentialStore = systemCredentialStore): Promise<Credential | null> {
  let text: string | null;
  try { text = await store.readAsync(environment); } catch (error) { throw normalizeStoreError(error); }
  return text === null ? null : parseCredential(text, environment);
}

/** Caller holds the environment login lock until this transaction settles. */
export async function saveCredential(environment: Environment, account: VerifiedAccount, token: string,
  assertCanCommit: () => number | void, store: CredentialStore = systemCredentialStore): Promise<void> {
  const record: Credential = { format_version: 1, environment, member_id: account.memberId,
    email_masked: account.emailMasked, token, obtained_at: new Date().toISOString(), token_expires_at: null };
  const text = JSON.stringify(record);
  parseCredential(text, environment);
  let previous: string | null;
  try { previous = await store.readAsync(environment); } catch (error) { throw normalizeStoreError(error); }
  // No native operation may begin before the login session permits the commit.
  const budget = assertCanCommit();
  const deadline = performance.now() + (typeof budget === 'number' ? budget : 60_000);
  if (performance.now() >= deadline) throw storeError('CREDENTIAL_COMMIT_UNKNOWN');
  let writeConfirmed = false;
  try {
    await store.write(environment, text);
    writeConfirmed = true;
    assertCanCommit();
    if (await store.readAsync(environment) !== text) throw storeError('CREDENTIAL_COMMIT_UNKNOWN');
    assertCanCommit();
    if (performance.now() >= deadline) throw storeError('CREDENTIAL_COMMIT_UNKNOWN');
  } catch (error) {
    // An interrupted native call may already have reached an OS service. Do not
    // race an uncertain write with a second write/delete presented as recovery.
    if (!writeConfirmed && error instanceof TopMediaiError && error.code === 'CREDENTIAL_COMMIT_UNKNOWN') throw error;
    // For a confirmed write, restore only our value; never overwrite another
    // writer's different credential. Recovery failure stays explicitly unknown.
    try {
      const current = await store.readAsync(environment);
      if (current === text) {
        if (previous === null) await store.remove(environment);
        else await store.write(environment, previous);
      } else if (current !== previous) throw storeError('CREDENTIAL_COMMIT_UNKNOWN');
      if (await store.readAsync(environment) !== previous) throw storeError('CREDENTIAL_COMMIT_UNKNOWN');
    } catch { throw storeError('CREDENTIAL_COMMIT_UNKNOWN'); }
    // Unknown native failures and cancellation after write never claim success.
    throw error instanceof TopMediaiError ? error : storeError('CREDENTIAL_COMMIT_UNKNOWN');
  }
}

export async function deleteCredential(environment: Environment, store: CredentialStore = systemCredentialStore): Promise<void> {
  try {
    await store.remove(environment);
    if (await store.readAsync(environment) !== null) throw storeError('CREDENTIAL_COMMIT_UNKNOWN');
  } catch (error) { throw normalizeStoreError(error); }
}

export function acquireLoginLock(environment: Environment, directory = credentialDirectory()): () => void {
  ensureCredentialDirectory(directory);
  const path = join(directory, `${environment}.login.lock`);
  const startedAt = process.platform === 'win32' ? powershell(`[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToString('o')`) : new Date(Date.now() - process.uptime() * 1000).toISOString();
  const owner = { pid: process.pid, started_at: startedAt, run_id: randomUUID() };
  let handle: number;
  try { handle = openSync(path, 'wx', 0o600); } catch { throw new TopMediaiError('LOGIN_IN_PROGRESS', 'A login is active or a previous login lock remains. Stop the previous CLI and verify its process before removing the environment login lock.'); }
  try { writeFileSync(handle, JSON.stringify(owner), 'utf8'); protectPrivatePath(path, false); fsyncSync(handle); }
  catch { closeSync(handle); unlinkSync(path); throw new TopMediaiError('CREDENTIAL_PERMISSION_FAILED', 'The private login lock could not be created.'); }
  closeSync(handle);
  const identity = lstatSync(path), parentIdentity = lstatSync(directory);
  return () => {
    if (!existsSync(path)) return;
    // Creation already verified this metadata-only file's ACL. On disconnect the
    // host can terminate stdio before another PowerShell process completes. Check
    // the exact private file/directory identities and nonce instead. This lock
    // contains no secret and is separate from the system credential store.
    safeNode(directory, true); safeNode(path, false);
    const currentIdentity = lstatSync(path), currentParent = lstatSync(directory);
    if (identity.dev !== currentIdentity.dev || identity.ino !== currentIdentity.ino
      || parentIdentity.dev !== currentParent.dev || parentIdentity.ino !== currentParent.ino) return;
    const current = JSON.parse(readFileSync(path, 'utf8')) as { run_id?: string };
    if (current.run_id === owner.run_id) unlinkSync(path);
  };
}
