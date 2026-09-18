/**
 * OPS-10. Every route that gives a lead to a person takes it off its queue.
 *
 * Non-negotiable 8: an owner is a User or a Queue, never both. The engine
 * writers -- assignLead, claimFromQueue, the approved bulk reassignment and
 * lead transfer -- clear `owner_queue_id` in the statement that sets
 * `owner_id`. Three route writers did not:
 *
 *   PATCH /leads/:id                 owner_id is an editable field
 *   POST  /leads/bulk/field          owner_id is a bulk field
 *   POST  /lists/:id/bulk/reassign   below the approval threshold
 *
 * A lead left with both set is on the queue's worklist and in the person's
 * book, `ownerOf` names the queue, and `claimFromQueue` -- which asks only
 * whether a queue is set -- lets anyone the queue admits take it off the
 * person it was given to. So each check below asks all four questions, not
 * just what the columns say.
 *
 * The queue is this file's own. The seeded ones carry backlog, and `workIn`
 * stops at 100 rows, so a probe lead in one of them could be off the worklist
 * for a reason that has nothing to do with ownership.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { ownerOf, claimFromQueue, workIn } from '../src/engine/queues.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

const PROBE = await probeAdmin('ownerqueue');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: PROBE.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const STAMP = String(Date.now());
run(
  `INSERT INTO queues (code, name, description, sales_org, entity)
   VALUES (?,?,?,?,?)`,
  [`OPS10_PROBE_${STAMP}`, `OPS-10 probe ${STAMP}`, 'Owned by test/ownerqueue.test.mjs', 'BONANZA', 'lead'],
);
const QUEUE = one('SELECT * FROM queues WHERE code = ?', [`OPS10_PROBE_${STAMP}`]);

const rms = all(
  "SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 AND sales_org = 'BONANZA' ORDER BY id LIMIT 2",
);
const [RM, OTHER] = rms;

const OWN = [];
let serial = 0;
/** A Bonanza lead sitting in this file's queue, owned by nobody else. */
const queuedLead = (name) => {
  serial += 1;
  const r = run(
    `INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id, owner_queue_id)
     VALUES (?,?,?,?,?,NULL,?)`,
    [name, `7${STAMP.slice(-7)}${String(serial).padStart(2, '0')}`, 'Unknown', 'New', 'BONANZA', QUEUE.id],
  );
  const id = Number(r.lastInsertRowid);
  OWN.push(id);
  return id;
};

const row = (id) => one('SELECT * FROM leads WHERE id = ?', [id]);
const onWorklist = (id) => workIn(QUEUE.id).some((w) => w.id === id);

/** Owned by the person and only the person, by every reading of it. */
function assertPersonOwns(id, person) {
  const lead = row(id);
  assert.equal(lead.owner_id, person.id, 'the person was not made the owner');
  assert.equal(lead.owner_queue_id, null, 'the lead was given to a person and left in the queue');
  assert(!onWorklist(id), 'a lead given to a person is still on the queue worklist');

  const owner = ownerOf(lead);
  assert.equal(owner?.type, 'user', `ownerOf names a ${owner?.type} as the owner, not the person`);
  assert.equal(owner.id, person.id);

  /* The consequence that matters most: somebody else the queue admits (it
     names no members, so it admits everyone) taking the lead off its owner. */
  const out = claimFromQueue(id, OTHER);
  assert(!out.ok, `${OTHER.name} claimed a lead that had been given to ${person.name}`);
  assert.match(out.error, /already belongs to/);
  assert.equal(row(id).owner_id, person.id, 'the refused claim still moved the lead');
}

/** Still the queue's, and nobody else's. */
function assertQueueOwns(id) {
  const lead = row(id);
  assert.equal(lead.owner_queue_id, QUEUE.id, 'the lead was taken out of its queue');
  assert.equal(lead.owner_id, null);
  assert(onWorklist(id), 'a queued lead fell off its worklist');
  assert.equal(ownerOf(lead)?.type, 'queue');
}

/* ---------------------------------------------------------------- tests */

console.log('\nA lead given to a person leaves its queue (OPS-10)');

await test('the fixtures are what the checks assume', () => {
  assert(RM && OTHER, 'need two active Bonanza Sales RMs');
  assert(QUEUE, 'this file could not create its own queue');
  const id = queuedLead('OPS-10 fixture probe');
  assertQueueOwns(id);
});

await test('PATCH /leads/:id with an owner takes the lead off the queue', async () => {
  const id = queuedLead('OPS-10 patch probe');
  const r = await call('PATCH', `/leads/${id}`, { owner_id: RM.id });
  assert.equal(r.status, 200, `HTTP ${r.status}: ${r.body?.error ?? ''}`);
  assertPersonOwns(id, RM);
});

await test('PATCH /leads/:id clearing the owner leaves the queue alone', async () => {
  /* null is "no person", not a reassignment -- and the edit form sends a
     blank owner as '', which the route reads as null. Neither may empty the
     queue, or the lead ends up owned by nobody. */
  for (const blank of [null, '']) {
    const id = queuedLead(`OPS-10 patch blank ${JSON.stringify(blank)}`);
    const r = await call('PATCH', `/leads/${id}`, { owner_id: blank });  // eslint-disable-line no-await-in-loop
    assert.equal(r.status, 200, `owner_id ${JSON.stringify(blank)}: HTTP ${r.status}: ${r.body?.error ?? ''}`);
    assertQueueOwns(id);
  }
});

await test('PATCH /leads/:id without an owner leaves the queue alone', async () => {
  const id = queuedLead('OPS-10 patch other field');
  const r = await call('PATCH', `/leads/${id}`, { city: 'Pune' });
  assert.equal(r.status, 200, `HTTP ${r.status}: ${r.body?.error ?? ''}`);
  assert.equal(row(id).city, 'Pune', 'the edit did not land, so this proves nothing');
  assertQueueOwns(id);
});

await test('bulk field update of the owner takes the lead off the queue', async () => {
  const id = queuedLead('OPS-10 bulk field probe');
  const r = await call('POST', '/leads/bulk/field', {
    field: 'owner_id', value: RM.id, mode: 'ids', ids: [id],
  });
  assert.equal(r.status, 200, `HTTP ${r.status}: ${r.body?.error ?? ''}`);
  assert.equal(r.body.changed, 1, `the update changed ${r.body.changed} leads, not the one asked for`);
  assertPersonOwns(id, RM);
});

await test('bulk field update of anything else leaves the queue alone', async () => {
  const id = queuedLead('OPS-10 bulk other field');
  const r = await call('POST', '/leads/bulk/field', {
    field: 'city', value: 'Nashik', mode: 'ids', ids: [id],
  });
  assert.equal(r.status, 200, `HTTP ${r.status}: ${r.body?.error ?? ''}`);
  assert.equal(r.body.changed, 1, 'the edit did not land, so this proves nothing');
  assertQueueOwns(id);
});

let LIST = null;
await test('list bulk reassign below the threshold takes the lead off the queue', async () => {
  const id = queuedLead('OPS-10 list reassign probe');

  const made = await call('POST', '/lists', {
    name: `OPS-10 probe ${STAMP}`, kind: 'static',
    snapshot_reason: 'OPS-10 queue ownership check', expires_at: '2030-01-01',
  });
  assert.equal(made.status, 201, `list create: HTTP ${made.status}: ${made.body?.error ?? ''}`);
  LIST = made.body.id;

  const added = await call('POST', `/lists/${LIST}/members`, { lead_ids: [id] });
  assert.equal(added.status, 200, `members: HTTP ${added.status}: ${added.body?.error ?? ''}`);
  assert.equal(added.body.added, 1, 'the queued lead could not be added to the list');

  /* One lead is below any threshold, so this is the direct write and not the
     approval, which clears the queue already. */
  const r = await call('POST', `/lists/${LIST}/bulk/reassign`, { owner_id: RM.id });
  assert.equal(r.status, 200, `reassign: HTTP ${r.status}: ${r.body?.error ?? ''}`);
  assert.equal(r.body.moved, 1, `the reassign moved ${r.body.moved} leads, not the one in the list`);
  assertPersonOwns(id, RM);
});

/* --------------------------------------------------------------- cleanup */

if (LIST) run('DELETE FROM lead_lists WHERE id = ?', [LIST]);
if (OWN.length) {
  const marks = OWN.map(() => '?').join(',');
  run(`DELETE FROM activities WHERE lead_id IN (${marks})`, OWN);
  run(`DELETE FROM leads WHERE id IN (${marks})`, OWN);
}
if (QUEUE) run('DELETE FROM queues WHERE id = ?', [QUEUE.id]);

/* Give the borrowed administrator back, so it does not turn up in every
   owner and assignee picker in the app. */
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
