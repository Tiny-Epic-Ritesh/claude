/**
 * Registering an outbound webhook endpoint (P3-16).
 *
 * The registry exists so that "this destination may hold client data" is a
 * decision a named administrator made, rather than one made by whoever last
 * edited an automation. So the tests are about the refusals that make that
 * true: plain HTTP, a field nobody registered, another book's endpoint, and
 * deleting one that automations still post to.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
/* Superadmin, because these routes sit behind admin.system like every other
   platform-configuration screen — registering somewhere client data may go is
   exactly that kind of decision. */
const ORG = 'BONANZA';
const PROBE = await probeAdmin('webhookendpoints', { role: 'superadmin', sales_org: ORG });

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nWebhook endpoints');

const clean = () => {
  run("DELETE FROM webhook_delivery WHERE endpoint_id IN (SELECT id FROM webhook_endpoint WHERE name LIKE 'probe_ep%')");
  run("DELETE FROM webhook_endpoint WHERE name LIKE 'probe_ep%'");
  run("DELETE FROM automation_step WHERE automation_id IN (SELECT id FROM automation WHERE name LIKE 'probe_ep%')");
  run("DELETE FROM automation WHERE name LIKE 'probe_ep%'");
};
clean();

/* ---------------------------------------------------------- registering */

let created = null;

await test('an endpoint is registered with the fields it may carry', async () => {
  const res = await call('POST', '/setup/webhook-endpoints', {
    name: 'probe_ep_main',
    url: 'https://partner.example.com/leads',
    secret: 'top-secret',
    fields: ['name', 'stage'],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  created = res.body;
  assert.deepEqual(created.fields, ['name', 'stage']);
  assert.equal(created.active, 1);
});

await test('the signing secret is never handed back', async () => {
  /* A secret a screen can display is a secret in a screenshot. */
  assert.equal(created.secret, undefined, 'the secret came back from the create call');
  const list = await call('GET', '/setup/webhook-endpoints');
  const mine = list.body.endpoints.find((e) => e.id === created.id);
  assert.equal(mine.secret, undefined, 'the secret came back from the list');
  assert.equal(mine.has_secret, true, 'but the screen still has to know one is set');
});

await test('plain HTTP is refused', async () => {
  /* Client data over plain HTTP is client data on the wire, and there is no
     endpoint worth registering that cannot manage TLS. */
  const res = await call('POST', '/setup/webhook-endpoints', {
    name: 'probe_ep_insecure',
    url: 'http://partner.example.com/leads',
    fields: [],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert(res.body.error.includes('https'), res.body.error);
});

await test('a URL that is not a URL is refused', async () => {
  const res = await call('POST', '/setup/webhook-endpoints', { name: 'probe_ep_bad', url: 'partner.example.com', fields: [] });
  assert.equal(res.status, 400);
});

await test('a field nobody registered as sendable is refused', async () => {
  /* The list is a positive allowlist. pan is on the lead and must not be
     postable to a partner because somebody typed it into a form. */
  const res = await call('POST', '/setup/webhook-endpoints', {
    name: 'probe_ep_pan',
    url: 'https://partner.example.com/x',
    fields: ['name', 'pan'],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert(res.body.error.includes('pan'), res.body.error);
});

await test('the sendable field list is served, so the screen does not invent one', async () => {
  const res = await call('GET', '/setup/webhook-endpoints');
  assert(Array.isArray(res.body.sendable_fields) && res.body.sendable_fields.length);
  assert(!res.body.sendable_fields.includes('pan'), 'pan is offered as a sendable field');
  assert(!res.body.sendable_fields.includes('pan_bidx'), 'the PAN blind index is offered as a sendable field');
});

/* -------------------------------------------------------------- editing */

await test('editing without a new secret keeps the old one', async () => {
  const res = await call('PATCH', `/setup/webhook-endpoints/${created.id}`, { fields: ['name'] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.fields, ['name']);
  assert.equal(res.body.has_secret, true, 'an edit that said nothing about the secret cleared it');
  assert.equal(
    one('SELECT secret FROM webhook_endpoint WHERE id = ?', [created.id]).secret, 'top-secret',
  );
});

await test('pausing stops deliveries without deleting the record of them', async () => {
  const res = await call('PATCH', `/setup/webhook-endpoints/${created.id}`, { active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, 0);
});

await test('every change is audited, because somebody will ask who allowed this', async () => {
  const entries = all(
    "SELECT action FROM audit_log WHERE entity = 'webhook_endpoint' AND entity_id = ? ORDER BY id",
    [created.id],
  ).map((a) => a.action);
  assert(entries.includes('webhook_endpoint_created'), entries.join(', '));
  assert(entries.includes('webhook_endpoint_updated'), entries.join(', '));
});

/* ------------------------------------------------------------- deleting */

await test('an endpoint an automation still posts to cannot be deleted', async () => {
  const autoId = Number(run(
    `INSERT INTO automation (name, trigger_type, status, sales_org) VALUES ('probe_ep_user', 'lead.created', 'active', ?)`,
    [ORG],
  ).lastInsertRowid);
  run(
    "INSERT INTO automation_step (automation_id, kind, config, sort_order) VALUES (?, 'action', ?, 0)",
    [autoId, JSON.stringify({ type: 'webhook', params: { endpoint_id: created.id } })],
  );

  const res = await call('DELETE', `/setup/webhook-endpoints/${created.id}`);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert(res.body.automations.some((a) => a.id === autoId), 'it did not say which automation');

  run('DELETE FROM automation_step WHERE automation_id = ?', [autoId]);
  run('DELETE FROM automation WHERE id = ?', [autoId]);
});

await test('an endpoint nothing points at is deleted', async () => {
  const res = await call('DELETE', `/setup/webhook-endpoints/${created.id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert(!one('SELECT id FROM webhook_endpoint WHERE id = ?', [created.id]));
});

/* -------------------------------------------------------- the boundary */

/*
 * NOT TESTED HERE, deliberately, and for the reason leadads.test.mjs already
 * sets out: these routes sit behind `admin.system`, which only superadmin
 * holds, and `orgsFor` gives a superadmin every book by definition. So no actor
 * can both reach the route and fail `mayUseOrg`, and a test asserting that
 * refusal would be asserting something unreachable.
 *
 * The cross-book rule that IS reachable does not depend on the actor: an
 * endpoint registered in one book must not receive the other book's leads, and
 * that is enforced where the action runs. It is tested in automation.test.mjs,
 * where an actor with one book performs the card.
 */

clean();
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);

// exitCode rather than process.exit(), for the reason bookscope.test.mjs gives:
// exiting straight after the live HTTP calls tears down libuv handles
// mid-flight. On Node 24.19 this file died on that assertion every time, after
// reporting 11 passed -- and being last in the unit chain, it took the
// end-to-end suite down with it.
process.exitCode = failed ? 1 : 0;
