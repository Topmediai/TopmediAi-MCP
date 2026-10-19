import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPublicContent } from './public-content.mjs';

export async function main(args = process.argv.slice(2)) {
  let root = process.cwd(), artifact = false, history = false, build = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) { root = resolve(args[++i]); artifact = true; }
    else if (args[i] === '--history') history = true;
    else if (args[i] === '--build') build = true;
    else throw new Error('INVALID_CHECK_ARGUMENT');
  }
  const result = await checkPublicContent(root, { artifact, history, build });
  // Never print matching values or caught exception bodies.
  for (const item of result.findings.slice(0, 100)) console.error(`${JSON.stringify(item.file)}:${item.line} [${item.category}]`);
  console.log(JSON.stringify({ files: result.files, commits: result.commits, findings: result.findings.length }));
  if (result.findings.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('PUBLIC_CONTENT_CHECK_FAILED: Check arguments, policy and candidate files locally.'); process.exitCode = 1; });
}
