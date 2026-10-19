import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, sep, dirname, extname, isAbsolute, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const gitEnvironment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.toUpperCase().startsWith('GIT_') && key.toUpperCase() !== 'EMAIL'));
const exactPaths = new Set(['.gitignore', '.env.example', '.agents/plugins/marketplace.json',
  'LICENSE', 'LICENSE.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'public-content.config.json',
  'docs/privacy.md', 'docs/production-switch.md', 'docs/releasing.md', 'docs/speech-integration.md', 'docs/image-to-image-security.md',
  'plugin/.codex-plugin/plugin.json', 'plugin/assets/topmediai-icon.png',
  '.github/workflows/public-content.yml']);
export function isPublicPath(path, build = false) {
  if (path.includes('\\') || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.')) return false;
  if (exactPaths.has(path)) return true;
  // Include only the supported localized READMEs in public snapshots.
  if (/^docs\/i18n\/README\.(?:ja|ko|de|fr|es|it|zh-TW)\.md$/.test(path)) return true;
  // Published TopMediai skill entrypoints remain inspectable after renames, including release history.
  if (/^plugin\/skills\/topmediai(?:-[a-z0-9]+)+\/SKILL\.md$/.test(path)) return true;
  if (build && /^dist\/(?:src|scripts|tests)\/.+\.(?:js|js\.map|html)$/.test(path)) return true;
  return /^(?:src|scripts|tests)\/.+\.(?:ts|mjs|html)$/.test(path);
}
const internalMarkers = [/app\/(?:text-to-speech|ai-cover)\//];
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider-secret', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}|LTAI[A-Za-z0-9]{12,})\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['credential-literal', /\b(?:[A-Z_]*TOKEN|[A-Z_]*SECRET|[A-Z_]*PASSWORD|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session[_-]?proof)\b["']?\s*[:=]\s*["']([^"'\r\n]{20,})["']/i],
  ['env-credential', /^\s*(?:TOPMEDIAI_TOKEN|[A-Z_]*(?:ACCESS_KEY_SECRET|PRIVATE_KEY|PASSWORD))\s*=\s*[^\s#]+/],
  ['client-codec-constant', /Buffer\.from\(['"][A-Za-z0-9]{32}['"]/],
  ['developer-path', /(?:(?<![\w])[A-Za-z]:(?:\\{1,2}|\/)(?!path(?:\\{1,2}|\/)to(?:\\{1,2}|\/))|\/(?:home|Users)\/[^\s/]+)/i],
];
const fixtureHost = host => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  || /(?:^|\.)(?:test|invalid|example)$/.test(host) || /(?:^|\.)example\.(?:com|org|net)$/.test(host);

export function scanText(file, text, policy, compiled = false, exceptionFile = file, historicalHash) {
  const findings = [], usedExceptions = new Set();
  if (policy.production_only && file !== 'scripts/public-content.mjs' && file !== 'dist/scripts/public-content.mjs' && /^(?:dist\/)?(?:src|scripts)\//.test(file)) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/TOPMEDIAI_TEST_|TEST_UPLOAD_|TEST_HOSTNAMES|allowTestLoopback|(?:environment|TOPMEDIAI_ENV)[^\n;]*['"]test['"]|sandbox\.invalid/.test(line)) {
        findings.push({ file, line: index + 1, category: 'non-production-configuration' });
      }
    }
  }
  const blocked = new Set(policy.blocked_host_suffix_sha256 ?? []);
  const markerGroups = new Map();
  for (const marker of policy.internal_text_fingerprints ?? []) {
    if (!markerGroups.has(marker.length)) markerGroups.set(marker.length, new Set());
    markerGroups.get(marker.length).add(marker.sha256);
  }
  const add = (line, category, rawLine) => {
    const hash = digest(rawLine.trim());
    const exception = (policy.exceptions ?? []).find(item => item.file === exceptionFile && item.category === category
      && (item.line_sha256 === hash || compiled && item.build_line_sha256 === hash))
      ?? (historicalHash && (policy.historical_exceptions ?? []).find(item => item.file === file
        && item.blob_sha256 === historicalHash && item.line_sha256 === hash && item.category === category));
    if (exception) { usedExceptions.add(exception); return; }
    findings.push({ file, line, category });
  };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    const privateHostname = blocked.size > 0 && [...raw.matchAll(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g)].some(match => {
      const labels = match[0].toLowerCase().split('.');
      for (let start = 0; start < labels.length - 1; start++) for (let end = start + 2; end <= labels.length; end++) {
        if (blocked.has(digest(labels.slice(start, end).join('.')))) return true;
      }
      return false;
    });
    if (privateHostname) findings.push({ file, line, category: 'private-hostname' });
    for (const [category, pattern] of patterns) if (pattern.test(raw)) add(line, category, raw);
    const fingerprintMatch = markerGroups.size > 0 && [...raw.matchAll(/[A-Za-z0-9_.-]+/g)].some(match => {
      const value = match[0].toLowerCase();
      for (const [length, hashes] of markerGroups) {
        for (let offset = 0; offset + length <= value.length; offset++) {
          if (hashes.has(digest(value.slice(offset, offset + length)))) return true;
        }
      }
      return false;
    });
    if (fingerprintMatch || internalMarkers.some(pattern => pattern.test(raw))) add(line, 'internal-source', raw);
    for (const match of raw.matchAll(/[A-Za-z0-9._%+*-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      const domain = match[1].toLowerCase();
      if (!fixtureHost(domain) && !(policy.public_email_domains ?? []).includes(domain)
        && !(policy.public_emails ?? []).includes(match[0].toLowerCase())) add(line, 'personal-email', raw);
    }
    for (const match of raw.matchAll(/https?:\/\/[^\s"'`<>\])}$]+/g)) {
      let url; try { url = new URL(match[0]); } catch { continue; }
      if (!fixtureHost(url.hostname) && !policy.allowed_hosts.includes(url.hostname)) add(line, 'unreviewed-host', raw);
      if (url.username || url.password) add(line, 'url-credentials', raw);
      const parameters = [...url.searchParams, ...new URLSearchParams(url.hash.slice(1))];
      if (parameters.some(([key, value]) => value && /^(?:accesstoken|token|proof|secret|signature|authorization|xamzsignature)$/i.test(key.replace(/[-_]/g, '')))) add(line, 'private-url', raw);
    }
    if (file.endsWith('.md')) for (const match of raw.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:file:|[A-Za-z]:[\\/])/.test(match[1])) add(line, 'absolute-document-link', raw);
    }
  }
  return { findings, usedExceptions };
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnvironment(), windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
export async function candidateFiles(root) {
  const entries = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const files = [];
  for (const path of new Set(entries)) {
    try { await lstat(resolve(root, path)); files.push(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files.sort();
}
export async function captureCandidate(root) {
  return new Map(await Promise.all((await candidateFiles(root)).map(async file => [file, await readFile(resolve(root, file))])));
}
export async function assertCandidateUnchanged(root, snapshot) {
  const current = await candidateFiles(root);
  if (current.length !== snapshot.size || current.some(file => !snapshot.has(file))) throw new Error('PUBLIC_SOURCE_CHANGED');
  for (const [file, bytes] of snapshot) if (!bytes.equals(await readFile(resolve(root, file)))) throw new Error('PUBLIC_SOURCE_CHANGED');
}
async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === '.git') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...await walk(root, path));
    else files.push(relative(root, path).split(sep).join('/'));
  }
  return files.sort();
}
export async function loadPolicy(root) {
  const policy = JSON.parse(await readFile(resolve(root, 'public-content.config.json'), 'utf8'));
  if (policy.version !== 1 || !Array.isArray(policy.allowed_hosts) || !Array.isArray(policy.exceptions) || !policy.reviewed_binaries) throw new Error('INVALID_PUBLIC_POLICY');
  if (policy.require_single_root !== undefined && typeof policy.require_single_root !== 'boolean'
    || policy.require_single_root && policy.historical_exceptions?.length) throw new Error('INVALID_PUBLIC_POLICY');
  if (policy.internal_text_fingerprints !== undefined && !Array.isArray(policy.internal_text_fingerprints)) throw new Error('INVALID_PUBLIC_POLICY');
  for (const marker of policy.internal_text_fingerprints ?? []) {
    if (!marker.reason || !Number.isInteger(marker.length) || marker.length < 4 || marker.length > 256
      || !/^[a-f0-9]{64}$/.test(marker.sha256)) throw new Error('INVALID_PUBLIC_POLICY');
  }
  for (const exception of policy.exceptions) if (!exception.reason || !/^[a-f0-9]{64}$/.test(exception.line_sha256)
    || exception.build_line_sha256 && !/^[a-f0-9]{64}$/.test(exception.build_line_sha256)
    || exception.historical_file_sha256 && !/^[a-f0-9]{64}$/.test(exception.historical_file_sha256)) throw new Error('INVALID_PUBLIC_EXCEPTION');
  if (policy.historical_exceptions !== undefined && !Array.isArray(policy.historical_exceptions)) throw new Error('INVALID_PUBLIC_EXCEPTION');
  for (const exception of policy.historical_exceptions ?? []) {
    if (!exception.reason || !isPublicPath(exception.file) || typeof exception.category !== 'string'
      || !/^[a-f0-9]{64}$/.test(exception.line_sha256) || !/^[a-f0-9]{64}$/.test(exception.blob_sha256)) throw new Error('INVALID_PUBLIC_EXCEPTION');
  }
  return policy;
}
async function inspectBytes(file, bytes, policy, historical = false) {
  if (extname(file) === '.png') {
    const reviewed = policy.reviewed_binaries[file];
    if (!reviewed?.reason || reviewed.sha256 !== digest(bytes)) return [{ file, line: 0, category: 'unreviewed-binary' }];
    const sharp = (await import('sharp')).default;
    const meta = await sharp(bytes).metadata();
    return meta.exif || meta.xmp || meta.iptc || meta.comments?.length ? [{ file, line: 0, category: 'image-metadata' }] : [];
  }
  if (bytes.includes(0)) return [{ file, line: 0, category: 'unexpected-binary' }];
  let text; try { text = new TextDecoder('utf8', { fatal: true }).decode(bytes); }
  catch { return [{ file, line: 0, category: 'invalid-text' }]; }
  // Compiled files use the same precisely reviewed fixture exceptions as their sources.
  const source = file.replace(/^dist\//, '').replace(/\.js$/, '.ts');
  // Renamed fixtures can retain approval for an exact historical blob without keeping their old path.
  const historicalHash = historical ? digest(bytes) : undefined;
  const exceptionFile = historical
    ? policy.exceptions.find(item => item.historical_file_sha256 === historicalHash)?.file ?? source
    : source;
  if (file.endsWith('.js.map')) {
    try {
      const map = JSON.parse(text);
      if (map.version !== 3 || !Array.isArray(map.sources) || !map.sources.every(value => typeof value === 'string')) throw new Error('INVALID_MAP');
      const embedded = (map.sourcesContent ?? []).flatMap((content, index) => typeof content === 'string'
        ? scanText(file, content, policy, false, posix.normalize(posix.join(posix.dirname(file), map.sources[index]))).findings : []);
      return [...scanText(file, text, policy).findings, ...embedded];
    } catch { return [{ file, line: 0, category: 'invalid-source-map' }]; }
  }
  return scanText(file, text, policy, file.startsWith('dist/'), exceptionFile, historicalHash).findings;
}
export async function checkPublicContent(root, options = {}) {
  root = await realpath(resolve(root));
  const policy = await loadPolicy(root), findings = [];
  const files = options.inventory ?? (options.artifact ? await walk(root) : await candidateFiles(root));
  if (options.build) files.push(...(await walk(root, resolve(root, 'dist'))));
  for (const file of [...new Set(files)].sort()) {
    if (!isPublicPath(file, !!options.build)) { findings.push({ file, line: 0, category: 'non-public-file' }); continue; }
    const path = resolve(root, file), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || relative(root, await realpath(path)).startsWith('..')) {
      findings.push({ file, line: 0, category: 'unsafe-file' }); continue;
    }
    findings.push(...await inspectBytes(file, await readFile(path), policy));
    if (file.endsWith('.md')) {
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const link = match[1];
        if (/^(?:[A-Za-z][\w+.-]*:|#)/.test(link)) continue;
        const target = resolve(dirname(path), decodeURIComponent(link.split('#')[0]));
        const relativeTarget = relative(root, target).split(sep).join('/');
        if (!files.includes(relativeTarget)) findings.push({ file, line: text.slice(0, match.index).split('\n').length, category: 'non-public-document-link' });
      }
    }
  }
  let commits = 0;
  if (options.history) {
    if (policy.require_single_root && git(root, ['rev-list', '--max-parents=0', '--all']).trim().split('\n').filter(Boolean).length !== 1) {
      findings.push({ file: 'git/history', line: 0, category: 'foreign-history-root' });
    }
    for (const ref of git(root, ['for-each-ref', '--format=%(refname) %(objecttype) %(objectname)']).trim().split('\n').filter(Boolean)) {
      const [name, type, oid] = ref.split(' ');
      findings.push(...scanText(`ref/${oid.slice(0, 12)}`, name, policy).findings);
      if (type === 'tag') {
        let target = oid, targetType = type;
        while (targetType === 'tag') {
          const metadata = git(root, ['cat-file', '-p', target]);
          findings.push(...scanText(`tag/${target.slice(0, 12)}`, metadata, policy).findings);
          target = metadata.match(/^object ([a-f0-9]+)$/m)?.[1];
          if (!target) throw new Error('INVALID_TAG');
          targetType = git(root, ['cat-file', '-t', target]).trim();
        }
        if (targetType !== 'commit') findings.push({ file: `ref/${oid.slice(0, 12)}`, line: 0, category: 'unsupported-history-ref' });
      } else if (type !== 'commit') findings.push({ file: `ref/${oid.slice(0, 12)}`, line: 0, category: 'unsupported-history-ref' });
    }
    const revisions = git(root, ['rev-list', '--all']).trim().split('\n').filter(Boolean);
    commits = revisions.length;
    // Inspect all reachable versions, including renamed paths and non-branch refs.
    const versions = new Map();
    for (const revision of revisions) {
      const metadata = git(root, ['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', revision]);
      findings.push(...scanText(`commit/${revision.slice(0, 12)}`, metadata, policy).findings);
      for (const entry of git(root, ['ls-tree', '-r', '-z', revision]).split('\0').filter(Boolean)) {
        const parsed = entry.match(/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/);
        if (!parsed) continue;
        const [, mode, type, oid, file] = parsed;
        if (!isPublicPath(file)) findings.push({ file, line: 0, category: 'non-public-history' });
        else if (mode !== '100644' && mode !== '100755' || type !== 'blob') findings.push({ file, line: 0, category: 'unsafe-history-entry' });
        else versions.set(`${oid}:${file}`, { oid, file });
      }
    }
    for (const { oid, file } of versions.values()) {
      const bytes = execFileSync('git', ['-C', root, 'cat-file', 'blob', oid], { env: gitEnvironment(), windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      findings.push(...await inspectBytes(file, bytes, policy, true));
    }
  }
  const unique = [...new Map(findings.map(item => [`${item.file}:${item.line}:${item.category}`, item])).values()];
  return { files: new Set(files).size, commits, findings: unique };
}
