import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLocalAuthSession, type LocalAuthOptions } from '../src/local-auth.js';
import { AccountVerificationError, type VerifiedAccount } from '../src/account.js';
import { encryptHandoffPayload, handoffProof, type AuthContext, type HandoffPayload } from '../src/auth-protocol.js';

const webOrigin = 'https://official.example';
const account: VerifiedAccount = { memberId: '123', email: 'user@example.com', emailMasked: 'u***@example.com' };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t: TestContext, overrides: Partial<LocalAuthOptions> = {}) {
  const calls = { verify: 0, save: 0 };
  const session = await createLocalAuthSession({
    environment: 'production', webOrigin, acknowledgementTimeoutMs: 100,
    verifyAccount: async () => { calls.verify++; return account; },
    saveCredential: async (_account, _token, assertCanCommit) => { assertCanCommit(); calls.save++; },
    ...overrides,
  });
  t.after(() => session.cancel());
  const url = new URL(session.authorizationUrl);
  assert.equal(url.origin, webOrigin);
  assert.equal(url.pathname, '/mcp/connect');
  assert.equal(url.search, '');
  const params = new URLSearchParams(url.hash.slice(1));
  const context: AuthContext = { state: params.get('state')!, environment: 'production', port: Number(params.get('port')) };
  const secret = Buffer.from(params.get('secret')!, 'base64url');
  const publicKey = createPublicKey({ key: Buffer.from(params.get('public_key')!, 'base64url'), type: 'spki', format: 'der' });
  const target = `http://127.0.0.1:${context.port}/v1/complete`;
  function submit(decision: 'approve' | 'deny' = 'approve', memberId = '123') {
    const nonce = randomBytes(16).toString('base64url');
    const payload: HandoffPayload = decision === 'approve'
      ? { decision, token: 'a'.repeat(42), expected_member_id: memberId, receipt_nonce: nonce }
      : { decision, receipt_nonce: nonce };
    const ciphertext = encryptHandoffPayload(publicKey, context, payload);
    const body = JSON.stringify({ version: 1, state: context.state, environment: context.environment, ciphertext });
    const headers = { Origin: webOrigin, 'Content-Type': 'application/json', 'handoff-proof': handoffProof(secret, context, ciphertext) };
    return { nonce, body, headers };
  }
  async function post(packet: ReturnType<typeof submit>, extra: RequestInit = {}) {
    const response = await fetch(target, { method: 'POST', headers: packet.headers, body: packet.body, ...extra });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
  }
  return { session, context, target, calls, submit, post };
}

test('saved receipt retries are exact, bounded, and never verify or overwrite twice', async t => {
  const f = await fixture(t);
  const packet = f.submit();
  const first = await f.post(packet);
  assert.equal(first.status, 200); assert.equal(first.body.data.receipt_nonce, packet.nonce);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('access-control-allow-origin'), webOrigin);
  assert.equal((await f.session.completion).status, 'saved');
  assert.deepEqual((await f.post(packet)).body, first.body);
  const different = await f.post(f.submit());
  assert.equal(different.status, 409); assert.equal(different.body.msg, 'already_completed');
  assert.ok(!different.text.includes(packet.nonce));
  assert.deepEqual(f.calls, { verify: 1, save: 1 });
});

test('unlogged denial uses the same encrypted protocol without a member call', async t => {
  const f = await fixture(t); const packet = f.submit('deny');
  const response = await f.post(packet);
  assert.equal(response.body.data.status, 'cancelled');
  assert.equal(response.body.data.receipt_nonce, packet.nonce);
  assert.equal((await f.session.completion).status, 'cancelled');
  assert.equal((await f.post(packet)).status, 200);
  assert.deepEqual(f.calls, { verify: 0, save: 0 });
});

test('preflight has its own branch and does not require a proof or consume the session', async t => {
  const f = await fixture(t);
  const response = await fetch(f.target, { method: 'OPTIONS', headers: {
    Origin: webOrigin, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type, handoff-proof',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), webOrigin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.calls, { verify: 0, save: 0 });
  assert.equal((await f.post(f.submit())).status, 200);
});

test('Origin, Host, cookies and malformed proof fail before account verification', async t => {
  const f = await fixture(t); const packet = f.submit();
  for (const headers of [
    { ...packet.headers, Origin: 'null' }, { ...packet.headers, Origin: 'https://attacker.example' },
    { ...packet.headers, Cookie: 'userToken=not-a-real-token' },
    { ...packet.headers, 'handoff-proof': `${packet.headers['handoff-proof']}=` },
  ]) {
    const rejected = await f.post(packet, { headers });
    assert.equal(rejected.status, 403); assert.ok(!rejected.text.includes(packet.nonce));
  }
  for (const headers of [
    { ...packet.headers, Host: `attacker.example:${f.context.port}` },
    { ...packet.headers, Origin: [webOrigin, webOrigin] },
  ]) {
    const rejected = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(f.target, { method: 'POST', headers }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', reject); req.end(packet.body);
    });
    assert.equal(rejected.status, 403); assert.ok(!rejected.text.includes(packet.nonce));
  }
  assert.deepEqual(f.calls, { verify: 0, save: 0 });
  assert.equal((await f.post(packet)).status, 200);
});

test('concurrent approve and deny cannot enter a second verification', async t => {
  const entered = deferred<void>(); const release = deferred<VerifiedAccount>(); let verified = 0;
  const f = await fixture(t, { verifyAccount: async () => { verified++; entered.resolve(); return release.promise; } });
  const packet = f.submit(); const first = f.post(packet); await entered.promise;
  assert.equal((await f.post(packet)).body.msg, 'in_progress');
  assert.equal((await f.post(f.submit('deny'))).body.msg, 'in_progress');
  release.resolve(account); assert.equal((await first).status, 200);
  assert.equal(verified, 1); assert.equal(f.calls.save, 1);
});

test('a disconnected browser does not release the verification lock or lose the saved receipt', async t => {
  const entered = deferred<void>(); const release = deferred<VerifiedAccount>();
  const f = await fixture(t, { verifyAccount: async () => { entered.resolve(); return release.promise; } });
  const packet = f.submit(); const abort = new AbortController();
  const lost = f.post(packet, { signal: abort.signal });
  await entered.promise; abort.abort(); await assert.rejects(lost);
  assert.equal((await f.post(packet)).body.msg, 'in_progress');
  release.resolve(account); assert.equal((await f.session.completion).status, 'saved');
  assert.equal((await f.post(packet)).body.data.receipt_nonce, packet.nonce);
  assert.equal(f.calls.save, 1);
});

test('account mismatch and explicit invalid login never save or reveal a receipt', async t => {
  let rejectLogin = false;
  const f = await fixture(t, { verifyAccount: async () => {
    if (rejectLogin) throw new AccountVerificationError('login_required'); return account;
  } });
  const mismatch = f.submit('approve', '456'); const rejected = await f.post(mismatch);
  assert.equal(rejected.status, 409); assert.equal(rejected.body.msg, 'account_changed');
  assert.ok(!rejected.text.includes(mismatch.nonce)); assert.equal(f.calls.save, 0);
  rejectLogin = true; const invalid = f.submit(); const response = await f.post(invalid);
  assert.equal(response.status, 401); assert.ok(!response.text.includes(invalid.nonce));
  assert.equal(f.calls.save, 0);
});

test('preparation failure permits retry but post-commit uncertainty aborts without a success ACK', async t => {
  let saves = 0;
  const f = await fixture(t, { saveCredential: async (_account, _token, assertCanCommit) => {
    if (++saves === 1) throw new Error('private-path-and-token-must-not-echo');
    assertCanCommit();
  } });
  const packet = f.submit(); const failed = await f.post(packet);
  assert.equal(failed.status, 503); assert.equal(failed.body.msg, 'credential_save_failed');
  assert.ok(!failed.text.includes('private-path')); assert.ok(!failed.text.includes(packet.nonce));
  assert.equal((await f.post(packet)).status, 200); assert.equal(saves, 2);

  const uncertain = await fixture(t, { saveCredential: async (_account, _token, assertCanCommit) => {
    assertCanCommit(); throw new Error('rename-result-unknown');
  } });
  const unknownPacket = uncertain.submit(); const unknown = await uncertain.post(unknownPacket);
  assert.equal(unknown.status, 503); assert.equal(unknown.body.msg, 'credential_commit_unknown');
  assert.ok(!unknown.text.includes(unknownPacket.nonce));
  assert.equal((await uncertain.session.completion).status, 'aborted');
});

test('save integration cannot declare success without checking the commit fence', async t => {
  const f = await fixture(t, { saveCredential: async () => {} });
  const packet = f.submit(); const result = await f.post(packet);
  assert.equal(result.status, 503); assert.equal(result.body.msg, 'credential_commit_unknown');
  assert.ok(!result.text.includes(packet.nonce));
  assert.equal((await f.session.completion).status, 'aborted');
});

test('a slow verification is bounded even when its fixture ignores AbortSignal', async t => {
  const late = deferred<VerifiedAccount>(); let requests = 0;
  const f = await fixture(t, { memberTimeoutMs: 30, verifyAccount: async () => ++requests === 1 ? late.promise : account });
  const packet = f.submit(); assert.equal((await f.post(packet)).body.msg, 'account_unavailable');
  assert.equal((await f.post(packet)).status, 200); late.resolve(account); await sleep(5);
  assert.equal(f.calls.save, 1);
});

test('deadline and cancellation fence late verification and prepared writes', async t => {
  let clock = 0; const entered = deferred<void>(); const release = deferred<void>(); let committed = 0;
  const f = await fixture(t, { now: () => clock, authorizationTimeoutMs: 2000,
    saveCredential: async (_account, _token, assertCanCommit) => {
      entered.resolve(); await release.promise; assertCanCommit(); committed++;
    },
  });
  const packet = f.submit(); const pending = f.post(packet); await entered.promise;
  clock = 2001; assert.equal((await f.post(packet)).status, 410);
  release.resolve(); assert.equal((await pending).status, 410);
  assert.equal((await f.session.completion).status, 'expired'); assert.equal(committed, 0);

  const verifying = deferred<void>(); const late = deferred<VerifiedAccount>(); let writes = 0;
  const cancelled = await fixture(t, { verifyAccount: async () => { verifying.resolve(); return late.promise; },
    saveCredential: async () => { writes++; },
  });
  const request = cancelled.post(cancelled.submit()).catch(() => undefined); await verifying.promise;
  await cancelled.session.cancel(); late.resolve(account); await request; await sleep(5);
  assert.equal((await cancelled.session.completion).status, 'aborted'); assert.equal(writes, 0);
});

test('cancellation after commit preserves saved outcome until post-commit verification finishes', async t => {
  const committed = deferred<void>(); const checked = deferred<void>();
  const f = await fixture(t, { saveCredential: async (_account, _token, assertCanCommit) => {
    assertCanCommit(); committed.resolve(); await checked.promise;
  } });
  const pending = f.post(f.submit()).catch(() => undefined); await committed.promise;
  const cancellation = f.session.cancel(); checked.resolve(); await cancellation; await pending;
  assert.equal((await f.session.completion).status, 'saved');
});

test('terminal receipts survive authorization expiry and never extend their own deadline', async t => {
  let clock = 0;
  const f = await fixture(t, { now: () => clock, authorizationTimeoutMs: 2000, acknowledgementTimeoutMs: 500 });
  clock = 1900; const packet = f.submit(); assert.equal((await f.post(packet)).status, 200);
  clock = 2001; assert.equal((await f.post(packet)).status, 200);
  clock = 2401; assert.equal((await f.post(packet)).status, 410);
  assert.deepEqual(f.calls, { verify: 1, save: 1 });
});

test('post-commit checks shorten ACK and close to the absolute total deadline', async t => {
  let clock = 0; const committed = deferred<void>(); const checked = deferred<void>(); let saves = 0;
  const f = await fixture(t, { now: () => clock, authorizationTimeoutMs: 2000, acknowledgementTimeoutMs: 500,
    saveCredential: async (_account, _token, assertCanCommit) => {
      assert.equal(assertCanCommit(), 600); saves++; committed.resolve(); await checked.promise;
    },
  });
  clock = 1900; const packet = f.submit(); const pending = f.post(packet); await committed.promise;
  clock = 2300; checked.resolve(); assert.equal((await pending).status, 200);
  assert.equal((await f.session.completion).status, 'saved');
  let closed = false; const closing = f.session.close().then(() => { closed = true; });
  clock = 2499; assert.equal((await f.post(packet)).status, 200);
  clock = 2500; const expired = await f.post(packet);
  assert.equal(expired.status, 410); assert.ok(!expired.text.includes(packet.nonce));
  await sleep(225); assert.equal(closed, true); await closing;
  assert.equal(saves, 1); assert.equal(f.calls.verify, 1);
});

test('a known save completed beyond total ACK deadline reports saved only to the CLI', async t => {
  let clock = 0; const committed = deferred<void>(); const checked = deferred<void>();
  const f = await fixture(t, { now: () => clock, authorizationTimeoutMs: 2000, acknowledgementTimeoutMs: 500,
    saveCredential: async (_account, _token, assertCanCommit) => {
      assertCanCommit(); committed.resolve(); await checked.promise;
    },
  });
  clock = 1900; const packet = f.submit(); const pending = f.post(packet); await committed.promise;
  clock = 2600; checked.resolve(); const response = await pending;
  assert.equal(response.status, 410); assert.ok(!response.text.includes(packet.nonce));
  assert.deepEqual(await f.session.completion, { status: 'saved', account });
  await f.session.close();
  await assert.rejects(f.post(packet));
});

test('CLI finally close waits for the existing ACK window instead of closing on completion', async t => {
  const f = await fixture(t, { acknowledgementTimeoutMs: 150 }); const packet = f.submit();
  await f.post(packet); await f.session.completion;
  let closed = false; const cleanup = f.session.close().then(() => { closed = true; });
  await sleep(10); assert.equal(closed, false);
  assert.equal((await f.post(packet)).status, 200);
  await cleanup; assert.equal(closed, true);
});
