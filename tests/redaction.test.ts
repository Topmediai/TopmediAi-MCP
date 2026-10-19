import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDiagnostic } from '../src/redaction.js';
import { saveDiagnosticReports } from '../src/diagnostics.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

test('shared diagnostics hide nested secrets, user data, links and paths without mutating input', () => {
  const input = { environment: 'production', server_version: '0.6.0', token_configured: true,
    task: { request_id: 'private-task', status: 'completed', description: 'private prompt', estimated_credits: 120,
      artifacts: [{ url: 'https://media.example.invalid/private.mp3?signature=private#proof=private', encoded_reference: 'private-media' }],
      error: { code: 'HTTP_ERROR', message: 'private upstream body', details: { elapsed_ms: 25, http_status: 503 } } },
    status: { member_id: 'private-account', userId: 'private-account', email_masked: 'p***@private.example.test',
      'AcCeSs-ToKeN': 'private-token', private_key: 'private-key', authorizationUrl: 'https://example.invalid/connect#proof=private',
      report: 'C:/path/to/private/report.json', unknown: { token: 'private-unknown' } },
    unexpected: { 'private-dynamic-key': 'private-value' } };
  const before = structuredClone(input);
  const result = sanitizeDiagnostic(input) as any;
  assert.deepEqual(input, before);
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.request_id, 'task_001');
  assert.equal(result.status.member_id, result.status.userId);
  assert.equal(result.status['AcCeSs-ToKeN'], '[REDACTED]');
  assert.equal(result.status.report, '[LOCAL_PATH]');
  assert.deepEqual(result.task.error.details, { elapsed_ms: 25, http_status: 503 });
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(result.unexpected, undefined);
  assert.equal(result.status.unknown, undefined);
});

test('aliases stay consistent across arrays within one report and reset for the next report', () => {
  const input = { tasks: [{ request_id: 'one', group_id: 'one' }, { task_id: 'two' }, { task_handle: 'one' }] };
  const result = sanitizeDiagnostic(input) as any;
  assert.deepEqual(result.tasks, [{ request_id: 'task_001', group_id: 'task_001' }, { task_id: 'task_002' }, { task_handle: 'task_001' }]);
  assert.deepEqual(sanitizeDiagnostic({ task_id: 'two' }), { task_id: 'task_001' });
});

test('unknown fields, unsafe typed values, Error bodies and cycles cannot bypass the projection', () => {
  const cyclic: Record<string, unknown> = { status: 'https://example.invalid/private', elapsed_ms: 'private',
    token_configured: 'private', code: 'private message', error: new Error('private-body'), unknown: 'private' };
  cyclic.task = cyclic;
  const result = sanitizeDiagnostic(cyclic) as any;
  assert.deepEqual(result.error, { code: 'DIAGNOSTIC_ERROR' });
  assert.equal(result.task, '[CIRCULAR]');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(sanitizeDiagnostic({ code: 'A'.repeat(40), network_code: 'B'.repeat(40) }), {});
});

test('report persistence keeps original local data while console and explicit sharing use safe copies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'topmediai-diagnostic-'));
  t.after(async () => {
    const scope = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(scope.startsWith('topmediai-diagnostic-') && !scope.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const report = { status: { environment: 'production', token_configured: true, member_id: 'private-account' },
    task: { request_id: 'private-task', status: 'completed', description: 'private-prompt',
      artifacts: [{ url: 'https://media.example.invalid/private-asset.mp3' }] } };
  const before = structuredClone(report);
  const summary = await saveDiagnosticReports(report, directory, 'production', false);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'latest-production.json'), 'utf8')), report);
  await assert.rejects(readFile(join(directory, 'shared-production.json')));
  assert.deepEqual(summary, { environment: 'production', token_configured: true, task: { status: 'completed' }, report_saved: true, shared_report_saved: false });
  await saveDiagnosticReports(report, directory, 'production', true);
  const shared = JSON.parse(await readFile(join(directory, 'shared-production.json'), 'utf8'));
  assert.ok(!JSON.stringify(shared).includes('private-'));
  assert.equal(shared.task.request_id, 'task_001');
  assert.deepEqual(report, before);
});
