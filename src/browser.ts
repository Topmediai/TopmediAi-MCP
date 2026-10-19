import { spawn } from 'node:child_process';

/** Open locally without printing the private handoff URL or invoking a shell. */
export async function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    let spawned = false;
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.unref(); resolve(opened);
    };
    const timer = setTimeout(() => finish(spawned), 5_000);
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => finish(false)); child.once('exit', code => finish(code === 0));
  });
}
