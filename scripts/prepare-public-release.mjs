import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { captureCandidate, assertCandidateUnchanged, checkPublicContent, digest, gitEnvironment } from './public-content.mjs';

export async function preparePublicRelease(root, output) {
  root = resolve(root); output = resolve(output);
  const source = await checkPublicContent(root);
  if (source.findings.length) throw new Error('PUBLIC_SOURCE_CHECK_FAILED');
  const sourceSnapshot = await captureCandidate(root);
  const snapshot = new Map(sourceSnapshot);
  const policy = JSON.parse(snapshot.get('public-content.config.json'));
  delete policy.historical_exceptions;
  for (const exception of policy.exceptions) delete exception.historical_file_sha256;
  policy.require_single_root = true;
  snapshot.set('public-content.config.json', Buffer.from(JSON.stringify(policy, null, 2) + '\n'));
  // A new directory is mandatory. Existing files are never deleted or overwritten.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const inventory = [...snapshot.keys()];
  for (const [file, bytes] of snapshot) {
    const destination = resolve(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  const copied = await checkPublicContent(output, { artifact: true });
  if (copied.findings.length) throw new Error('PUBLIC_COPY_CHECK_FAILED');
  await assertCandidateUnchanged(root, sourceSnapshot);
  const git = args => execFileSync('git', ['-C', output, '-c', 'core.hooksPath=.git/hooks', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: gitEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '--template=', '--initial-branch=main']);
  git(['add', '--', ...inventory]);
  git(['-c', 'user.name=TopMediai Release', '-c', 'user.email=release@example.invalid', 'commit', '-m', 'Prepare public plugin source']);
  const checked = await checkPublicContent(output, { artifact: true, history: true });
  if (checked.findings.length) throw new Error('PUBLIC_HISTORY_CHECK_FAILED');
  await assertCandidateUnchanged(root, sourceSnapshot);
  // Refuse to certify even a fresh snapshot if a private file appeared during preparation.
  if (git(['remote']).trim()) throw new Error('UNEXPECTED_PUBLIC_REMOTE');
  const content_sha256 = digest(inventory.map(file => `${file}:${digest(snapshot.get(file))}`).join('\n'));
  return { directory: output, files: checked.files, commits: checked.commits, findings: 0, content_sha256 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) {
    console.error('Usage: npm run prepare:public -- [--output <new-directory>]'); process.exitCode = 1;
  } else {
    const output = args[1] ?? resolve('.data', 'public-release-' + new Date().toISOString().replace(/[:.]/g, '-'));
    preparePublicRelease(process.cwd(), output).then(result => console.log(JSON.stringify(result))).catch(() => {
      console.error('PUBLIC_RELEASE_FAILED: Run check:public, keep source files unchanged and use a new output directory. No remote was configured or pushed.');
      process.exitCode = 1;
    });
  }
}
