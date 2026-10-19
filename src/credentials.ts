import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Environment } from './auth-protocol.js';
import type { VerifiedAccount } from './account.js';
import { TopMediaiError } from './types.js';

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

function assertPrivateNodes(nodes: { path: string; directory: boolean }[]): void {
  if (process.platform !== 'win32') { nodes.forEach(node => assertPrivatePath(node.path, node.directory)); return; }
  nodes.forEach(node => safeNode(node.path, node.directory));
  powershell(nodes.map(node => privateAclCheckScript(node.path, node.directory)).join('\n'));
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

function filePath(environment: Environment, directory: string): string {
  if (environment !== 'production') throw new TopMediaiError('INVALID_CONFIG', 'This release supports production only.');
  return join(directory, `${environment}.json`);
}

function parseCredential(text: string, environment: Environment): Credential {
  let value: Credential;
  try { value = JSON.parse(text) as Credential; } catch { throw new TopMediaiError('CREDENTIAL_CORRUPT', 'The local credential file is invalid. Run login again.'); }
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

export function readCredential(environment: Environment, directory = credentialDirectory()): Credential | null {
  const path = filePath(environment, directory);
  if (!existsSync(path)) return null;
  assertPrivateNodes([{ path: directory, directory: true }, { path, directory: false }]);
  return parseCredential(readFileSync(path, 'utf8'), environment);
}

const run = promisify(execFile);
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;
async function privateNode(path: string, directory: boolean): Promise<Stats> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && (info.nlink !== 1 || info.size > 8192))) {
    throw new TopMediaiError('UNSAFE_CREDENTIAL_FILE', 'The credential location must be a regular private file or directory.');
  }
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) {
    throw new TopMediaiError('UNSAFE_CREDENTIAL_PERMISSIONS', 'Credential permissions must be private to the current user.');
  }
  return info;
}

/** Runtime reads stay asynchronous and revalidate every file version; no token cache. */
export async function readCredentialAsync(environment: Environment, directory = credentialDirectory()): Promise<Credential | null> {
  const path = filePath(environment, directory);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = await privateNode(path, false), parent = await privateNode(directory, true);
      if (process.platform === 'win32') {
        const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${privateAclCheckScript(directory, true)} ${privateAclCheckScript(path, false)}`;
        try {
          await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 16_384 });
        } catch {
          // Deletion is logout; replacement must be checked as a fresh version.
          const current = await privateNode(path, false);
          if (!sameFile(before, current)) continue;
          throw new TopMediaiError('CREDENTIAL_PERMISSION_FAILED', 'Private Windows credential permissions could not be verified.');
        }
      }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text: string, stable: boolean;
      try {
        const opened = await handle.stat(), bytes = Buffer.alloc(8193);
        let length = 0;
        while (length < bytes.length) {
          const chunk = await handle.read(bytes, length, bytes.length - length, length);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        if (length > 8192) throw new TopMediaiError('UNSAFE_CREDENTIAL_FILE', 'The credential file exceeds its supported size.');
        stable = sameFile(before, opened) && sameFile(opened, await handle.stat()) && opened.size === length;
        text = bytes.subarray(0, length).toString('utf8');
      } finally { await handle.close(); }
      const after = await privateNode(path, false), parentAfter = await privateNode(directory, true);
      if (!stable || !sameFile(before, after) || parent.dev !== parentAfter.dev || parent.ino !== parentAfter.ino) continue;
      return parseCredential(text, environment);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  throw new TopMediaiError('CREDENTIAL_CHANGED', 'The saved credential changed during verification. Retry this operation; no previous credential was reused.');
}

export async function saveCredential(environment: Environment, account: VerifiedAccount, token: string, assertCanCommit: () => number | void, directory = credentialDirectory()): Promise<void> {
  const target = filePath(environment, directory);
  if (!existsSync(directory)) ensureCredentialDirectory(directory);
  else assertPrivateNodes([{ path: directory, directory: true }, ...(existsSync(target) ? [{ path: target, directory: false }] : [])]);
  const temporary = join(directory, `.${environment}-${randomUUID()}.tmp`);
  const backup = join(directory, `.${environment}-${randomUUID()}.backup`);
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const record: Credential = { format_version: 1, environment, member_id: account.memberId, email_masked: account.emailMasked, token, obtained_at: new Date().toISOString(), token_expires_at: null };
  const text = JSON.stringify(record) + '\n';
  parseCredential(text, environment);
  let handle: number | undefined;
  let replaced = false;
  let keepBackup = false;
  try {
    if (previous !== undefined) {
      handle = openSync(backup, 'wx', 0o600);
      writeFileSync(handle, previous, 'utf8'); protectPrivatePath(backup, false);
      fsyncSync(handle); closeSync(handle); handle = undefined;
    }
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, text, 'utf8'); protectPrivatePath(temporary, false);
    fsyncSync(handle); closeSync(handle); handle = undefined;
    // No await between this state/deadline assertion and the replacement.
    const budget = assertCanCommit();
    const verificationDeadline = performance.now() + (typeof budget === 'number' ? budget : 10_000);
    renameSync(temporary, target); replaced = true;
    assertPrivatePath(target, false, verificationDeadline - performance.now());
    if (readFileSync(target, 'utf8') !== text) throw new TopMediaiError('CREDENTIAL_COMMIT_UNKNOWN', 'Credential save could not be confirmed. Check local login status.');
    if (performance.now() >= verificationDeadline) throw new TopMediaiError('CREDENTIAL_COMMIT_UNKNOWN', 'Credential save verification exceeded its deadline. Check local login status.');
  } catch (error) {
    if (replaced) {
      // Keep the previous private file until post-replacement verification succeeds.
      // Recovery never retries the new credential or emits a success acknowledgement.
      try {
        safeNode(target, false);
        if (previous !== undefined) { renameSync(backup, target); }
        else if (readFileSync(target, 'utf8') === text) unlinkSync(target);
        else throw new Error('Unexpected credential contents');
      } catch { keepBackup = true; }
      throw new TopMediaiError('CREDENTIAL_COMMIT_UNKNOWN', 'Credential save could not be confirmed. Recovery was attempted; check local login status before starting another login.');
    }
    if (error instanceof TopMediaiError) throw error;
    throw new TopMediaiError('CREDENTIAL_SAVE_FAILED', 'The private credential could not be saved. Check local login status.');
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
    if (!keepBackup && existsSync(backup)) unlinkSync(backup);
  }
}

export function deleteCredential(environment: Environment, directory = credentialDirectory()): void {
  const path = filePath(environment, directory);
  if (!existsSync(path)) return;
  assertPrivateNodes([{ path: directory, directory: true }, { path, directory: false }]); unlinkSync(path);
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
    // the exact private file/directory identities and nonce instead; credential
    // reads and credential commits retain their full permission verification.
    safeNode(directory, true); safeNode(path, false);
    const currentIdentity = lstatSync(path), currentParent = lstatSync(directory);
    if (identity.dev !== currentIdentity.dev || identity.ino !== currentIdentity.ino
      || parentIdentity.dev !== currentParent.dev || parentIdentity.ino !== currentParent.ino) return;
    const current = JSON.parse(readFileSync(path, 'utf8')) as { run_id?: string };
    if (current.run_id === owner.run_id) unlinkSync(path);
  };
}
