import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile), instanceId = randomUUID();
export interface ProcessOwner { pid: number; instance_id: string; started_at?: string; }
let own: Promise<ProcessOwner> | undefined;

async function startTime(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`;
      const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 4096 });
      return /^\d+$/.test(stdout.trim()) ? stdout.trim() : undefined;
    }
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    }
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000, maxBuffer: 4096 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

export function processOwner(): Promise<ProcessOwner> {
  return own ??= startTime(process.pid).then(started_at => ({ pid: process.pid, instance_id: instanceId, ...(started_at ? { started_at } : {}) }));
}

/** Unknown ownership never authorizes taking a live process's lock. */
export async function ownerState(owner: Partial<ProcessOwner>): Promise<'alive' | 'dead' | 'unknown'> {
  if (!Number.isSafeInteger(owner.pid) || owner.pid! < 1) return 'unknown';
  try { process.kill(owner.pid!, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
  if (owner.pid === process.pid && owner.instance_id === instanceId) return 'alive';
  if (!owner.started_at) return 'unknown';
  const current = await startTime(owner.pid!);
  return current === undefined ? 'unknown' : current === owner.started_at ? 'alive' : 'dead';
}
