/**
 * A change of owner through bulk update is a reassignment. OPS-11.
 *
 * WHY THIS FILE EXISTS
 *
 * `POST /leads/bulk/field` took `owner_id` on `lead.edit` alone. Sales RMs and
 * dealers hold that; only superadmin, admin and sales_supervisor hold
 * `lead.reassign`. So an RM refused by PATCH /leads/:id for moving one lead
 * could move up to 5,000 of them here, and three rules the list reassign route
 * applies were missing:
 *
 *   1. the `lead.reassign` capability
 *   2. the `bulk_reassign` approval at BULK_THRESHOLD leads and above
 *   3. an active owner in the lead's own book -- a Bonanza lead could be given
 *      to a Bigul user or to someone who has left, and an unknown id died on
 *      the foreign key halfway through the loop, leaving earlier rows moved
 *
 * WHAT IT CHECKS
 *
 * Each refusal, and the halves that make them worth having: an RM can still
 * bulk-set an ordinary field, a holder of lead.reassign still moves a handful
 * directly, and only leads that would actually change hands count towards the
 * threshold. A guard that refused everything would pass the refusals alone.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nBulk update of the owner');

/* One account per role, each signing in once: the login limiter counts per
   account, and the shared seeded ones belong to the rest of the suite. */
const RM = await probeAdmin('bulkowner-rm', { role: 'sales_rm' });
const DEALER = await probeAdmin('bulkowner-dealer', { role: 'dealer' });
const ADMIN = await probeAdmin('bulkowner');

const call = async (who, method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* People to give leads to. Inserted rather than borrowed from the seed, so the
   inactive one and the other-book one are exactly that and nothing else. */
const EMAILS = ['bulkowner-target@bonanza.test', 'bulkowner-bigul@bonanza.test', 'bulkowner-gone@bonanza.test'];
run(`DELETE FROM users WHERE email IN (${EMAILS.map(() => '?').join(',')})`, EMAILS);
const person = (name, email, org, active) => Number(run(
  "INSERT INTO users (name, email, password, role, sales_org, active) VALUES (?,?,'x','sales_rm',?,?)",
  [name, email, org, active],
).lastInsertRowid);
const TARGET = person('Bulk owner target', EMAILS[0], 'BONANZA', 1);
const BIGUL = person('Bulk owner Bigul', EMAILS[1], 'BIGUL', 1);
const GONE = person('Bulk owner gone', EMAILS[2], 'BONANZA', 0);

const NAME = 'Bulk owner probe';
const clear = () => run('DELETE FROM leads WHERE name LIKE ?', [`${NAME}%`]);
clear();

const STAMP = String(Date.now()).slice(-5);
let serial = 0;
const leads = (n, owner) => Array.from({ length: n }, () => {
  serial += 1;
  return Number(run(
    "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,'Referral','New','BONANZA',?)",
    [`${NAME} ${serial}`, `9${STAMP}${String(serial).padStart(4, '0')}`, owner],
  ).lastInsertRowid);
});
const ownerOf = (id) => one('SELECT owner_id FROM leads WHERE id = ?', [id]).owner_id;
const owners = (ids) => ids.map(ownerOf);
const requestsFor = (ownerId) => all(
  "SELECT * FROM approvals WHERE scope = 'bulk_reassign' AND entity_id = ? AND status = 'Pending'", [ownerId],
);
const dropRequests = () => run(
  "DELETE FROM approvals WHERE scope = 'bulk_reassign' AND entity_id IN (?,?)", [TARGET, BIGUL],
);

const adminOptions = (await call(ADMIN, 'GET', '/leads/bulk/options')).body;
const THRESHOLD = adminOptions?.bulk_threshold;

/* ------------------------------------------------ 1. the capability */

await test('a Sales RM cannot reassign leads through bulk update', async () => {
  const [id] = leads(1, RM.id);
  const r = await call(RM, 'POST', '/leads/bulk/field', { field: 'owner_id', value: TARGET, mode: 'ids', ids: [id] });

  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.required, 'lead.reassign', `the refusal names ${r.body.required}`);
  assert.equal(ownerOf(id), RM.id, 'the lead moved anyway');
});

await test('nor can a dealer', async () => {
  const [id] = leads(1, DEALER.id);
  const r = await call(DEALER, 'POST', '/leads/bulk/field', { field: 'owner_id', value: TARGET, mode: 'ids', ids: [id] });

  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(ownerOf(id), DEALER.id, 'the lead moved anyway');
});

await test('a Sales RM can still bulk-set an ordinary field', async () => {
  /* The refusal is the capability, not the route: lead.edit still sets the
     fields it always could. */
  const [id] = leads(1, RM.id);
  const r = await call(RM, 'POST', '/leads/bulk/field', { field: 'city', value: 'Nashik', mode: 'ids', ids: [id] });

  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.changed, 1, `changed ${r.body.changed}`);
});

await test('Owner is offered only to a role that may reassign', async () => {
  const rmOptions = (await call(RM, 'GET', '/leads/bulk/options')).body;

  assert(rmOptions.fields.length, 'the RM was offered no fields at all');
  assert(!rmOptions.fields.some((f) => f.key === 'owner_id'), 'a Sales RM is offered Owner, which the write refuses');
  assert(adminOptions.fields.some((f) => f.key === 'owner_id'), 'an administrator is not offered Owner');
  assert(Number.isInteger(THRESHOLD) && THRESHOLD > 1, `bulk_threshold is ${THRESHOLD}`);
});

/* ------------------------------------------------ 3. the owner */

await test('an owner who is inactive, unknown or blank is refused and nothing moves', async () => {
  const ids = leads(3, ADMIN.id);

  for (const value of [GONE, 99999999, '', null, 'abc', true]) {
    const r = await call(ADMIN, 'POST', '/leads/bulk/field', { field: 'owner_id', value, mode: 'ids', ids });
    assert.equal(r.status, 400, `owner ${JSON.stringify(value)}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'Choose an active user', `owner ${JSON.stringify(value)}: ${r.body.error}`);
    assert.deepEqual(owners(ids), [ADMIN.id, ADMIN.id, ADMIN.id], `owner ${JSON.stringify(value)} moved a lead`);
  }
});

await test('a lead is not given to someone outside its book', async () => {
  const ids = leads(2, ADMIN.id);
  const r = await call(ADMIN, 'POST', '/leads/bulk/field', { field: 'owner_id', value: BIGUL, mode: 'ids', ids });

  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.changed, 0, `${r.body.changed} Bonanza leads were given to a Bigul user`);
  assert.equal(r.body.skipped, 2, `skipped ${r.body.skipped}, not 2`);
  assert.deepEqual(owners(ids), [ADMIN.id, ADMIN.id], 'a Bonanza lead now has a Bigul owner');
});

await test('below the threshold a reassignment applies directly', async () => {
  const ids = leads(2, ADMIN.id);
  const r = await call(ADMIN, 'POST', '/leads/bulk/field', { field: 'owner_id', value: String(TARGET), mode: 'ids', ids });

  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.changed, 2, `changed ${r.body.changed}`);
  assert.deepEqual(owners(ids), [TARGET, TARGET], 'the leads did not move');
  assert.equal(requestsFor(TARGET).length, 0, 'two leads raised an approval');
});

/* ------------------------------------------------ 2. the approval */

await test('at the threshold it becomes a bulk_reassign request and nothing moves', async () => {
  try {
    const ids = leads(THRESHOLD, ADMIN.id);
    const r = await call(ADMIN, 'POST', '/leads/bulk/field', {
      field: 'owner_id', value: TARGET, mode: 'ids', ids, reason: 'Coverage while Asha is away',
    });

    assert.equal(r.status, 202, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.approval_required, true, 'the reply does not say it is waiting for approval');
    assert.equal(r.body.requested, THRESHOLD, `requested ${r.body.requested}`);
    assert(owners(ids).every((o) => o === ADMIN.id), 'leads moved before anybody approved');

    const [req] = requestsFor(TARGET);
    assert(req, 'no pending bulk_reassign request was raised');
    assert.equal(req.id, r.body.request_id, 'the reply names a different request');
    const payload = JSON.parse(req.payload);
    assert.equal(payload.owner_id, TARGET, `the request moves them to ${payload.owner_id}`);
    assert.deepEqual([...payload.lead_ids].sort((a, b) => a - b), ids, 'the request carries different leads');
  } finally { dropRequests(); }
});

await test('a request needs a reason, and without one nothing moves', async () => {
  try {
    const ids = leads(THRESHOLD, ADMIN.id);
    const r = await call(ADMIN, 'POST', '/leads/bulk/field', { field: 'owner_id', value: TARGET, mode: 'ids', ids });

    assert.equal(r.status, 400, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.error), /^Say why\./, `refused for another reason: ${r.body.error}`);
    assert.equal(requestsFor(TARGET).length, 0, 'a request was raised with no reason');
    assert(owners(ids).every((o) => o === ADMIN.id), 'leads moved without approval');
  } finally { dropRequests(); }
});

await test('leads already with the new owner do not count towards the threshold', async () => {
  /* THRESHOLD leads, one already the target's: THRESHOLD - 1 change hands,
     which one person may do alone. */
  try {
    const ids = [...leads(THRESHOLD - 1, ADMIN.id), ...leads(1, TARGET)];
    const r = await call(ADMIN, 'POST', '/leads/bulk/field', { field: 'owner_id', value: TARGET, mode: 'ids', ids });

    assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.changed, THRESHOLD - 1, `changed ${r.body.changed}`);
    assert.equal(r.body.unchanged, 1, `unchanged ${r.body.unchanged}`);
    assert(owners(ids).every((o) => o === TARGET), 'not every lead reached the target');
  } finally { dropRequests(); }
});

await test('and are left out of the request', async () => {
  try {
    const moving = leads(THRESHOLD, ADMIN.id);
    const already = leads(1, TARGET);
    const r = await call(ADMIN, 'POST', '/leads/bulk/field', {
      field: 'owner_id', value: TARGET, mode: 'ids', ids: [...moving, ...already], reason: 'Rebalancing the book',
    });

    assert.equal(r.status, 202, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    const [req] = requestsFor(TARGET);
    assert(req, 'no request was raised');
    assert.deepEqual([...JSON.parse(req.payload).lead_ids].sort((a, b) => a - b), moving,
      'the request carries a lead that is not moving');
  } finally { dropRequests(); }
});

await test('leads outside the owner\'s book never reach a request', async () => {
  /* Enough of them to cross the threshold, all in the wrong book. The approval
     handler moves whatever lead ids it is given, so they must be filtered out
     before a request is raised, not only in the direct write. */
  try {
    const ids = leads(THRESHOLD, ADMIN.id);
    const r = await call(ADMIN, 'POST', '/leads/bulk/field', {
      field: 'owner_id', value: BIGUL, mode: 'ids', ids, reason: 'Should never be asked',
    });

    assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.skipped, THRESHOLD, `skipped ${r.body.skipped}`);
    assert.equal(requestsFor(BIGUL).length, 0, 'a request was raised to give Bonanza leads to a Bigul user');
    assert(owners(ids).every((o) => o === ADMIN.id), 'a Bonanza lead now has a Bigul owner');
  } finally { dropRequests(); }
});

clear();
run(`DELETE FROM users WHERE email IN (${EMAILS.map(() => '?').join(',')})`, EMAILS);
RM.cleanup();
DEALER.cleanup();
ADMIN.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
