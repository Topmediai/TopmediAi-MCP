import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkPublicContent, scanText, digest, captureCandidate, assertCandidateUnchanged, isPublicPath } from '../scripts/public-content.mjs';
import { preparePublicRelease } from '../scripts/prepare-public-release.mjs';

const policy = { version: 1, allowed_hosts: ['files.topmediai.com'], reviewed_binaries: {}, exceptions: [] };

test('internal marker fingerprints reject case variants and embedded identifiers without publishing marker values', () => {
  const marker = 'hidden_origin.example';
  const scoped = { ...policy, internal_text_fingerprints: [{ length: marker.length, sha256: digest(marker), reason: 'Synthetic internal marker.' }] };
  assert.ok(!JSON.stringify(scoped).includes(marker));
  for (const text of [marker, marker.toUpperCase(), `prefix${marker}suffix`, `https://${marker}/path`, `${marker}.ts`]) {
    assert.ok(scanText('README.md', text, scoped).findings.some(item => item.category === 'internal-source'));
  }
  assert.deepEqual(scanText('README.md', 'Public documentation', scoped).findings, []);
});

test('historical exceptions require the exact approved blob, path, line and category and never apply to current files', async t => {
  const f = await fixture(t);
  const old = '# Bootstrap\nSee https://' + ['bootstrap', 'private', 'company', 'com'].join('.') + '/repository\n';
  const scoped = { ...policy, historical_exceptions: [{ file: 'README.md', category: 'unreviewed-host',
    line_sha256: digest(old.split('\n')[1].trim()), blob_sha256: digest(old), reason: 'Reviewed synthetic bootstrap history.' }] };
  await writeFile(join(f.root, 'README.md'), old);
  f.git(['add', '--', 'README.md', 'public-content.config.json']); f.git(['commit', '-m', 'Bootstrap']);
  await writeFile(join(f.root, 'README.md'), '# Published guide\n');
  await writeFile(join(f.root, 'public-content.config.json'), JSON.stringify(scoped));
  f.git(['add', '--', 'README.md', 'public-content.config.json']); f.git(['commit', '-m', 'Published guide']);
  assert.deepEqual((await checkPublicContent(f.root, { history: true })).findings, []);
  assert.ok(scanText('README.md', old, scoped).findings.length > 0);
  assert.ok(scanText('README.md', old + 'changed\n', scoped, false, 'README.md', digest(old + 'changed\n')).findings.length > 0);
  assert.ok(scanText('docs/privacy.md', old, scoped, false, 'docs/privacy.md', digest(old)).findings.length > 0);
});
test('hostname fingerprints block plain text and embedded domain labels without publishing the private hostname in policy', () => {
  const scoped = { ...policy, blocked_host_suffix_sha256: [digest('hidden.example')] };
  for (const text of ['host=api.hidden.example', 'https://api.hidden.example.evil.test/path', 'API.HIDDEN.EXAMPLE']) {
    const result = scanText('README.md', text, scoped);
    assert.ok(result.findings.some(item => item.category === 'private-hostname'));
    assert.ok(!JSON.stringify(result.findings).includes(text));
  }
  assert.deepEqual(scanText('README.md', 'https://files.topmediai.com/result', scoped).findings, []);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'topmediai-public-'));
  t.after(async () => {
    const target = resolve(root), parent = resolve(tmpdir());
    assert.ok(relative(parent, target).startsWith('topmediai-public-'));
    assert.ok(!relative(parent, target).includes('..'));
    await rm(target, { recursive: true, force: true });
  });
  await writeFile(join(root, 'public-content.config.json'), JSON.stringify(policy));
  const git = args => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=.git/hooks', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Synthetic Release', '-c', 'user.email=release@example.invalid', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '--template=', '--initial-branch=main']);
  return { root, git };
}

test('localized READMEs are publishable without allowing unrelated or nested files', () => {
  for (const locale of ['ja', 'ko', 'de', 'fr', 'es', 'it', 'zh-TW']) assert.equal(isPublicPath(`docs/i18n/README.${locale}.md`), true);
  for (const path of ['docs/i18n/private.json', 'docs/i18n/README.unknown.md', 'docs/i18n/nested/README.ja.md', 'docs/i18n/../README.ja.md']) assert.equal(isPublicPath(path), false);
});

test('public skill entrypoints support TopMediai rename migrations while excluding other files', () => {
  for (const path of ['plugin/skills/topmediai-mcp/SKILL.md', 'plugin/skills/topmediai-image/SKILL.md']) assert.equal(isPublicPath(path), true);
  for (const path of ['plugin/skills/private/SKILL.md', 'plugin/skills/topmediai-mcp/private.json', 'plugin/skills/topmediai-mcp/../SKILL.md', 'plugin/skills/topmediai-mcp/nested/SKILL.md']) assert.equal(isPublicPath(path), false);
});

test('content findings disclose only location/category, and precise exceptions do not suppress changed lines', () => {
  const hidden = 'hidden-origin.example';
  const contentPolicy = { ...policy, internal_text_fingerprints: [{ length: hidden.length, sha256: digest(hidden), reason: 'Synthetic repository marker.' }] };
  const content = ['TOPMEDIAI_TOKEN=' + 'x'.repeat(40), 'Contact ' + ['person', 'private.company.com'].join('@'),
    'Open https://' + hidden + '/private/repository',
    'https://files.topmediai.com/result?signature=' + 'fixture-value'].join('\n');
  const found = scanText('README.md', content, contentPolicy).findings;
  assert.ok(found.some(item => item.category === 'env-credential'));
  assert.ok(found.some(item => item.category === 'personal-email'));
  assert.ok(found.some(item => item.category === 'internal-source'));
  assert.ok(found.some(item => item.category === 'private-url'));
  assert.ok(!JSON.stringify(found).includes('fixture-value'));
  const line = 'const token = ' + JSON.stringify('x'.repeat(40)) + ';';
  const scoped = { ...policy, exceptions: [{ file: 'tests/fixture.ts', category: 'credential-literal', line_sha256: digest(line), reason: 'Synthetic scanner fixture.' }] };
  assert.deepEqual(scanText('tests/fixture.ts', line, scoped).findings, []);
  assert.ok(scanText('tests/other.ts', line, scoped).findings.length);
  assert.ok(scanText('tests/fixture.ts', line.replace('xxx', 'yyy'), scoped).findings.length);
});

test('artifact inventories include ignored private files and reject unreviewed binaries and broken links', async t => {
  const { root, git } = await fixture(t);
  await writeFile(join(root, '.gitignore'), '.env\n');
  await writeFile(join(root, 'README.md'), '[missing](docs/missing.md)\n');
  await writeFile(join(root, '.env'), 'TOPMEDIAI_TOKEN=' + 'x'.repeat(40));
  await mkdir(join(root, 'plugin/assets'), { recursive: true });
  await writeFile(join(root, 'plugin/assets/topmediai-icon.png'), Buffer.from([0, 1, 2]));
  git(['add', '--', '.gitignore', 'README.md', 'public-content.config.json']);
  const source = await checkPublicContent(root);
  assert.ok(!source.findings.some(item => item.file === '.env'));
  assert.ok(source.findings.some(item => item.category === 'non-public-document-link'));
  assert.ok(source.findings.some(item => item.category === 'unreviewed-binary'));
  const artifact = await checkPublicContent(root, { artifact: true });
  assert.ok(artifact.findings.some(item => item.file === '.env' && item.category === 'non-public-file'));
});

test('history checks find removed files and old sensitive content behind additional refs', async t => {
  const { root, git } = await fixture(t);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs/private.md'), 'private document');
  await writeFile(join(root, 'README.md'), 'TOPMEDIAI_TOKEN=' + 'x'.repeat(40));
  git(['add', '--', 'README.md', 'docs/private.md', 'public-content.config.json']);
  git(['commit', '-m', 'Synthetic first revision']);
  git(['update-ref', 'refs/review/previous', 'HEAD']);
  git(['rm', '--', 'docs/private.md']);
  await writeFile(join(root, 'README.md'), 'Public usage guide\n');
  git(['add', '--', 'README.md']); git(['commit', '-m', 'Clean current files']);
  const cleanRoot = git(['commit-tree', 'HEAD^{tree}', '-m', 'Clean public root']).trim();
  git(['update-ref', 'refs/heads/main', cleanRoot]);
  assert.deepEqual((await checkPublicContent(root)).findings, []);
  const result = await checkPublicContent(root, { history: true });
  assert.equal(result.commits, 2);
  assert.ok(result.findings.some(item => item.category === 'non-public-history'));
  assert.ok(result.findings.some(item => item.category === 'env-credential'));
});

test('renamed fixture exceptions recognize only the approved historical blob', async t => {
  const { root, git } = await fixture(t);
  await mkdir(join(root, 'tests'));
  const line = 'const token = ' + JSON.stringify('x'.repeat(40)) + ';';
  const content = line + '\n';
  await writeFile(join(root, 'public-content.config.json'), JSON.stringify({ ...policy, exceptions: [{
    file: 'tests/current.test.ts', category: 'credential-literal', line_sha256: digest(line),
    historical_file_sha256: digest(content), reason: 'Synthetic fixture approved before a file rename.',
  }] }));
  await writeFile(join(root, 'tests/previous.test.ts'), content);
  git(['add', '--', 'tests', 'public-content.config.json']); git(['commit', '-m', 'Original synthetic fixture']);
  git(['mv', 'tests/previous.test.ts', 'tests/current.test.ts']); git(['commit', '-m', 'Rename synthetic fixture']);
  assert.deepEqual((await checkPublicContent(root, { history: true })).findings, []);
  await writeFile(join(root, 'tests/unreviewed.test.ts'), content);
  assert.ok((await checkPublicContent(root)).findings.some(item => item.file === 'tests/unreviewed.test.ts' && item.category === 'credential-literal'));
  await rm(join(root, 'tests/unreviewed.test.ts'));
  await writeFile(join(root, 'tests/previous.test.ts'), content + '// Different historical snapshot\n');
  git(['add', '--', 'tests/previous.test.ts']); git(['commit', '-m', 'Different historical fixture']);
  git(['rm', '--', 'tests/previous.test.ts']); git(['commit', '-m', 'Remove different fixture']);
  assert.ok((await checkPublicContent(root, { history: true })).findings.some(item => item.file === 'tests/previous.test.ts' && item.category === 'credential-literal'));
});

test('history checks inspect annotated tag messages as well as commits', async t => {
  const { root, git } = await fixture(t);
  await writeFile(join(root, 'README.md'), 'Public usage guide\n');
  git(['add', '--', 'README.md', 'public-content.config.json']);
  git(['commit', '-m', 'Public root']);
  git(['tag', '-a', 'v1', '-m', 'https://files.topmediai.com/result?signature=' + 'synthetic-tag-value']);
  git(['tag', '-a', 'v2', 'v1', '-m', 'Public outer tag']);
  git(['tag', '-d', 'v1']);
  const result = await checkPublicContent(root, { history: true });
  assert.ok(result.findings.some(item => item.file.startsWith('tag/') && item.category === 'private-url'));
});

test('build checks inspect decoded source-map content and reject unreviewed compiled files', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, '.gitignore'), 'dist/\n');
  await mkdir(join(root, 'dist/src'), { recursive: true });
  const map = { version: 3, sources: ['../../src/fixture.ts'], sourcesContent: ['const value = ' + JSON.stringify('ghp_' + 'x'.repeat(36))], mappings: '' };
  await writeFile(join(root, 'dist/src/fixture.js.map'), JSON.stringify(map));
  await writeFile(join(root, 'dist/private.json'), '{}');
  const result = await checkPublicContent(root, { build: true });
  assert.ok(result.findings.some(item => item.category === 'provider-secret'));
  assert.ok(result.findings.some(item => item.file === 'dist/private.json' && item.category === 'non-public-file'));
});

test('public preparation copies reviewed content into fresh history and refuses existing output', async t => {
  const { root, git } = await fixture(t);
  await writeFile(join(root, '.gitignore'), '.data/\n.env\n');
  await writeFile(join(root, 'README.md'), 'Public usage guide\n');
  git(['add', '--', '.gitignore', 'README.md', 'public-content.config.json']);
  git(['commit', '-m', 'Synthetic private history']);
  git(['commit', '--allow-empty', '-m', 'Another private revision']);
  await writeFile(join(root, '.env'), 'TOPMEDIAI_TOKEN=' + 'x'.repeat(40));
  const output = join(root, '.data', 'public');
  const result = await preparePublicRelease(root, output);
  assert.equal(result.commits, 1);
  assert.equal(result.findings, 0);
  assert.equal((await checkPublicContent(output, { artifact: true, history: true })).findings.length, 0);
  await assert.rejects(readFile(join(output, '.env')));
  await assert.rejects(preparePublicRelease(root, output));
  assert.equal(await readFile(join(output, 'README.md'), 'utf8'), 'Public usage guide\n');
  const preparedPolicy = JSON.parse(await readFile(join(output, 'public-content.config.json'), 'utf8'));
  assert.equal(preparedPolicy.require_single_root, true);
  assert.equal(preparedPolicy.historical_exceptions, undefined);
});

test('delivery snapshots remove historical waivers and reject foreign roots and personal commit emails', async t => {
  const { root, git } = await fixture(t);
  const originalPolicy = { ...policy, historical_exceptions: [{ file: 'README.md', category: 'unreviewed-host',
    blob_sha256: digest('old'), line_sha256: digest('old'), reason: 'Synthetic legacy approval.' }] };
  await writeFile(join(root, '.gitignore'), '.data/\n');
  await writeFile(join(root, 'README.md'), 'Clean delivery\n');
  await writeFile(join(root, 'public-content.config.json'), JSON.stringify(originalPolicy));
  git(['add', '.']); git(['commit', '-m', 'Existing collaboration history']);
  const output = join(root, '.data', 'delivery');
  await preparePublicRelease(root, output);
  const prepared = JSON.parse(await readFile(join(output, 'public-content.config.json'), 'utf8'));
  assert.equal(prepared.historical_exceptions, undefined);
  const deliveryGit = args => execFileSync('git', ['-C', output, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  deliveryGit(['fetch', '--no-tags', root, 'HEAD:refs/heads/foreign']);
  assert.ok((await checkPublicContent(output, { history: true })).findings.some(item => item.category === 'foreign-history-root'));
  deliveryGit(['branch', '-D', 'foreign']);
  const email = ['person', 'private.company.com'].join('@');
  deliveryGit(['-c', 'user.name=Synthetic', '-c', 'user.email=' + email, '-c', 'core.hooksPath=.git/hooks', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Synthetic personal author']);
  assert.ok((await checkPublicContent(output, { history: true })).findings.some(item => item.category === 'personal-email'));
});

test('a content or inventory change invalidates a captured release even when it contains no secrets', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'README.md'), 'First public version\n');
  const snapshot = await captureCandidate(root);
  await assertCandidateUnchanged(root, snapshot);
  await writeFile(join(root, 'README.md'), 'Different public version\n');
  await assert.rejects(assertCandidateUnchanged(root, snapshot), /PUBLIC_SOURCE_CHANGED/);
  await writeFile(join(root, 'README.md'), 'First public version\n');
  await writeFile(join(root, 'package.json'), '{}');
  await assert.rejects(assertCandidateUnchanged(root, snapshot), /PUBLIC_SOURCE_CHANGED/);
});

test('content and history checks inspect the requested repository despite inherited Git variables', async t => {
  const actual = await fixture(t), foreign = await fixture(t);
  await writeFile(join(actual.root, 'README.md'), 'Public guide\n');
  actual.git(['add', '--', 'README.md', 'public-content.config.json']); actual.git(['commit', '-m', 'Public root']);
  await mkdir(join(foreign.root, 'docs')); await writeFile(join(foreign.root, 'docs/private.md'), 'Private notes\n');
  foreign.git(['add', '--', 'docs/private.md', 'public-content.config.json']); foreign.git(['commit', '-m', 'Foreign root']);
  const saved = process.env.GIT_DIR; process.env.GIT_DIR = join(foreign.root, '.git');
  try {
    const result = await checkPublicContent(actual.root, { history: true });
    assert.equal(result.commits, 1); assert.deepEqual(result.findings, []);
  } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
});
