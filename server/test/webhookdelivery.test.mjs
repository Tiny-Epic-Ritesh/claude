/**
 * Posting a queued webhook (P3-16).
 *
 * The interesting behaviour is not the happy path. It is that a partner's
 * server being down does not lose the delivery, that a delivery is not retried
 * for ever, and that the body carries only what the endpoint was registered
 * for — which for a broker whose client data may not leave India is the whole
 * point of registering an endpoint at all.
 *
 * `fetch` is injected rather than intercepted so no test here can reach the
 * network by accident.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { sweepWebhooks, sign } from '../src/engine/webhookdelivery.js';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nWebhook delivery');

const clean = () => {
  run("DELETE FROM webhook_delivery WHERE endpoint_id IN (SELECT id FROM webhook_endpoint WHERE name LIKE 'probe_hook%')");
  run("DELETE FROM webhook_endpoint WHERE name LIKE 'probe_hook%'");
};
clean();

const endpoint = (name, { active = 1, secret = null } = {}) => Number(run(
  'INSERT INTO webhook_endpoint (name, url, secret, active, sales_org) VALUES (?,?,?,?,?)',
  [name, `https://example.invalid/${name}`, secret, active, 'BONANZA'],
).lastInsertRowid);

const queue = (endpointId, payload = { lead_id: 1 }) => Number(run(
  'INSERT INTO webhook_delivery (endpoint_id, payload) VALUES (?,?)',
  [endpointId, JSON.stringify(payload)],
).lastInsertRowid);

/** A fetch that records what it was called with and answers however we say. */
const stub = (answer) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof answer === 'function') return answer(url, init);
    return answer;
  };
  fn.calls = calls;
  return fn;
};

const ok = { ok: true, status: 200 };

/* -------------------------------------------------------------- the send */

await test('a queued delivery is posted and marked sent', async () => {
  const ep = endpoint('probe_hook_ok');
  const id = queue(ep, { lead_id: 7, stage: 'New' });

  const fetchImpl = stub(ok);
  const out = await sweepWebhooks({ fetchImpl });

  assert(out.sent >= 1, JSON.stringify(out));
  const d = one('SELECT * FROM webhook_delivery WHERE id = ?', [id]);
  assert.equal(d.status, 'sent');
  assert.equal(d.http_status, 200);
  assert.equal(d.attempts, 1);

  const call = fetchImpl.calls.find((c) => c.url.endsWith('probe_hook_ok'));
  assert(call, 'the endpoint was never called');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), { lead_id: 7, stage: 'New' });
});

await test('a delivery already sent is not sent again', async () => {
  const fetchImpl = stub(ok);
  await sweepWebhooks({ fetchImpl });
  assert(!fetchImpl.calls.some((c) => c.url.endsWith('probe_hook_ok')),
    'a delivery that had already been sent was posted a second time');
});

await test('the body is signed with the endpoint secret, over the bytes actually sent', async () => {
  const ep = endpoint('probe_hook_signed', { secret: 'shhh' });
  queue(ep, { lead_id: 9 });

  const fetchImpl = stub(ok);
  await sweepWebhooks({ fetchImpl });

  const call = fetchImpl.calls.find((c) => c.url.endsWith('probe_hook_signed'));
  assert(call, 'not called');
  assert.equal(call.init.headers['X-Bonanza-Signature'], `sha256=${sign('shhh', call.init.body)}`);
});

await test('an endpoint with no secret is sent unsigned rather than not at all', async () => {
  const ep = endpoint('probe_hook_nosecret');
  queue(ep);
  const fetchImpl = stub(ok);
  await sweepWebhooks({ fetchImpl });
  const call = fetchImpl.calls.find((c) => c.url.endsWith('probe_hook_nosecret'));
  assert(call, 'not called');
  assert.equal(call.init.headers['X-Bonanza-Signature'], undefined);
});

/* ------------------------------------------------------------- failures */

await test('a server that is down leaves the delivery queued for the next sweep', async () => {
  const ep = endpoint('probe_hook_down');
  const id = queue(ep);

  await sweepWebhooks({ fetchImpl: stub(() => { throw new Error('ECONNREFUSED'); }) });

  const d = one('SELECT * FROM webhook_delivery WHERE id = ?', [id]);
  assert.equal(d.status, 'queued', 'one refused connection threw the delivery away');
  assert.equal(d.attempts, 1);
  assert.equal(d.error, 'ECONNREFUSED');
});

await test('a delivery is given up on after three attempts, not retried for ever', async () => {
  /* A partner who decommissioned an endpoint should not be posted to on every
     tick until somebody notices, and the row has to end somewhere a report can
     find it. */
  const ep = endpoint('probe_hook_gone');
  const id = queue(ep);
  const fetchImpl = stub(() => { throw new Error('ECONNREFUSED'); });

  for (let i = 0; i < 5; i += 1) await sweepWebhooks({ fetchImpl });

  const d = one('SELECT * FROM webhook_delivery WHERE id = ?', [id]);
  assert.equal(d.status, 'failed');
  assert.equal(d.attempts, 3, `attempted ${d.attempts} times`);
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('probe_hook_gone')).length, 3);
});

await test('an HTTP error is recorded with its status', async () => {
  const ep = endpoint('probe_hook_500');
  const id = queue(ep);
  await sweepWebhooks({ fetchImpl: stub({ ok: false, status: 503 }) });

  const d = one('SELECT * FROM webhook_delivery WHERE id = ?', [id]);
  assert.equal(d.http_status, 503);
  assert.equal(d.status, 'queued', 'a 503 is usually a restart and deserves the next sweep');
  assert.equal(d.error, 'HTTP 503');
});

await test('a deactivated endpoint is not posted to', async () => {
  /* Deactivating is how an admin stops data going somewhere. It has to stop the
     deliveries already queued, not only the next one. */
  const ep = endpoint('probe_hook_off', { active: 0 });
  const id = queue(ep);

  const fetchImpl = stub(ok);
  await sweepWebhooks({ fetchImpl });

  assert(!fetchImpl.calls.some((c) => c.url.endsWith('probe_hook_off')),
    'a deactivated endpoint still received data');
  assert.equal(one('SELECT status FROM webhook_delivery WHERE id = ?', [id]).status, 'queued');
});

await test('nothing queued is a quiet no-op, not an error', async () => {
  clean();
  const fetchImpl = stub(ok);
  const out = await sweepWebhooks({ fetchImpl });
  assert.equal(out.tried, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

clean();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
