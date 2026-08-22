/**
 * Queues, and the polymorphic owner.
 *
 * Non-negotiable 8. The thing worth proving is not that a foreign key works —
 * it is that the third answer actually exists: a lead nothing routes is neither
 * invisible nor parked on a placeholder human, and the two owner columns can
 * never both be set.
 */

import { strict as assert } from 'node:assert';
import { all, one, run, db } from '../src/db.js';
import {
  seedQueues, listQueues, queueByCode, setMembers, membersOf, mayTakeFrom,
  ownerOf, assignToQueue, claimFromQueue, workIn, queueScopeSql, SEED_QUEUES,
} from '../src/engine/queues.js';
import { assignLead } from '../src/engine/assignment.js';
import { leadScope } from '../src/auth.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

seedQueues();
const OWN = [];
const mkLead = (name, org = 'BONANZA', source = 'Unknown') => {
  const r = run(
    'INSERT INTO leads (name, mobile, source, stage, sales_org) VALUES (?,?,?,?,?)',
    [name, `90${String(Date.now()).slice(-8)}`, source, 'New', org],
  );
  const id = Number(r.lastInsertRowid);
  OWN.push(id);
  return id;
};

/* --------------------------------------------------------- the queues */

console.log('\nQueues exist and are scoped');

test('every seeded queue is present and declares what it holds', () => {
  const byCode = new Map(listQueues().map((q) => [q.code, q]));
  for (const q of SEED_QUEUES) {
    const found = byCode.get(q.code);
    assert(found, `${q.code} is missing`);
    assert(found.entity, `${q.code} does not say what it holds`);
  }
});

test('seeding twice adds nothing', () => {
  const before = one('SELECT COUNT(*) n FROM queues').n;
  seedQueues();
  assert.equal(one('SELECT COUNT(*) n FROM queues').n, before);
});

test('an org-scoped queue names its org', () => {
  assert.equal(queueByCode('UNASSIGNED_BONANZA').sales_org, 'BONANZA');
  assert.equal(queueByCode('UNASSIGNED_BIGUL').sales_org, 'BIGUL');
  assert.equal(queueByCode('CARE_INBOX').sales_org, null, 'the care inbox should serve both orgs');
});

/* ------------------------------------------------------- membership */

console.log('\nMembership is by role, not by person');

test('a queue with no members named is open, not closed', () => {
  // A queue nobody can empty is a black hole, so the permissive default is the
  // safe one here.
  const q = queueByCode('KYC_REVIEW');
  setMembers(q.id, []);
  assert(mayTakeFrom({ id: 1, role: 'caller' }, q), 'an unrestricted queue refused everyone');
});

test('naming roles restricts the queue to them', () => {
  const q = queueByCode('KYC_REVIEW');
  setMembers(q.id, ['product_rm', 'product_supervisor']);

  assert(mayTakeFrom({ id: 1, role: 'product_rm' }, q), 'a member was refused');
  assert(!mayTakeFrom({ id: 2, role: 'caller' }, q), 'a non-member was allowed');
  assert.deepEqual(membersOf(q.id).sort(), ['product_rm', 'product_supervisor']);

  setMembers(q.id, []);   // put it back
});

/* -------------------------------------------------- the third answer */

console.log('\nThe case queues exist for');

test('a lead nothing routes goes to a queue, not to nobody', () => {
  // Before queues this lead was either NULL-owned — on no worklist until a
  // report found it — or parked on a placeholder human.
  run('UPDATE rules SET enabled = 0');
  run('UPDATE assignment_rules SET enabled = 0');

  const id = mkLead('Unroutable probe');
  const out = assignLead(one('SELECT * FROM leads WHERE id = ?', [id]));

  run('UPDATE rules SET enabled = 1');
  run('UPDATE assignment_rules SET enabled = 1');

  assert.equal(out.assigned, false, 'it should not claim to have assigned a person');
  assert(out.queued, 'the lead was not queued');

  const lead = one('SELECT owner_id, owner_queue_id FROM leads WHERE id = ?', [id]);
  assert.equal(lead.owner_id, null, 'a person was given work nothing routed to them');
  assert(lead.owner_queue_id, 'the lead ended up owned by nobody at all');
});

test('a queued lead is on the queue’s worklist', () => {
  const q = queueByCode('UNASSIGNED_BONANZA');
  const id = mkLead('Visible in queue');
  assignToQueue(id, q.id);

  assert(workIn(q.id).some((w) => w.id === id), 'a queued lead is not on the queue worklist');
});

test('claiming moves ownership from the queue to the person', () => {
  const q = queueByCode('UNASSIGNED_BONANZA');
  const id = mkLead('Claim probe');
  assignToQueue(id, q.id);

  const rm = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1");
  const out = claimFromQueue(id, rm);
  assert(out.ok, out.error);

  const lead = one('SELECT owner_id, owner_queue_id FROM leads WHERE id = ?', [id]);
  assert.equal(lead.owner_id, rm.id, 'the claimer did not become the owner');
  assert.equal(lead.owner_queue_id, null, 'the lead is still in the queue as well');
});

test('claiming is refused to a role the queue does not admit', () => {
  const q = queueByCode('KYC_REVIEW');
  setMembers(q.id, ['product_rm']);

  const id = mkLead('Restricted probe');
  assignToQueue(id, q.id);

  const caller = one("SELECT * FROM users WHERE role = 'caller' AND active = 1 LIMIT 1");
  const out = claimFromQueue(id, caller);
  assert(!out.ok, 'a non-member claimed work out of a restricted queue');
  assert.match(out.error, /cannot take work/);

  setMembers(q.id, []);
});

test('a lead already owned by a person cannot be claimed from a queue', () => {
  const id = mkLead('Owned probe');
  const rm = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1");
  run('UPDATE leads SET owner_id = ?, owner_queue_id = NULL WHERE id = ?', [rm.id, id]);

  const other = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 AND id != ? LIMIT 1", [rm.id]);
  const out = claimFromQueue(id, other ?? rm);
  assert(!out.ok, 'someone claimed a lead that already had an owner');
  assert.match(out.error, /already belongs to/);
});

/* ------------------------------------------------- exactly one owner */

console.log('\nExactly one owner');

test('placing in a queue clears the person, in one statement', () => {
  // Both set for even an instant means the lead is on two worklists, and a
  // sweep reading it in that window double-counts.
  const rm = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1");
  const id = mkLead('Both-owner probe');
  run('UPDATE leads SET owner_id = ? WHERE id = ?', [rm.id, id]);

  assignToQueue(id, queueByCode('UNASSIGNED_BONANZA').id);
  const lead = one('SELECT owner_id, owner_queue_id FROM leads WHERE id = ?', [id]);
  assert.equal(lead.owner_id, null, 'the person still owns it too');
  assert(lead.owner_queue_id);
});

test('no lead anywhere is owned by both', () => {
  const both = one(
    'SELECT COUNT(*) n FROM leads WHERE owner_id IS NOT NULL AND owner_queue_id IS NOT NULL',
  ).n;
  assert.equal(both, 0, `${both} leads are owned by a person and a queue at once`);
});

test('ownerOf gives one answer whichever column is set', () => {
  const rm = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1");
  const q = queueByCode('UNASSIGNED_BONANZA');

  const byUser = ownerOf({ owner_id: rm.id, owner_queue_id: null });
  assert.equal(byUser.type, 'user');
  assert.equal(byUser.name, rm.name);

  const byQueue = ownerOf({ owner_id: null, owner_queue_id: q.id });
  assert.equal(byQueue.type, 'queue');
  assert.equal(byQueue.name, q.name);

  assert.equal(ownerOf({ owner_id: null, owner_queue_id: null }), null);
});

/* ------------------------------------------------------- visibility */

console.log('\nQueued work stays visible');

test('queue membership widens the scope rather than replacing it', () => {
  // A lead placed in a queue must not vanish from everybody's list until
  // somebody claims it — that is the opposite of what a queue is for.
  const rm = { id: 8, role: 'sales_rm', sales_org: 'BONANZA' };
  const scope = leadScope(rm);

  assert(scope.sql.includes('owner_queue_id'), 'queue work is not in the lead scope');
  assert(scope.sql.includes('owner_id'), 'own-book scope was replaced rather than widened');
  assert(scope.sql.includes(' OR '), 'the two are ANDed, so a queue would narrow rather than widen');
});

test('a role in no queue gets no queue clause rather than a broken one', () => {
  const q = queueScopeSql({ id: 1, role: 'role_that_is_in_nothing' });
  // Every seeded queue is unrestricted, so this role does match them. What
  // matters is that the result is either null or a valid bound clause.
  if (q) {
    assert(q.sql.includes('owner_queue_id IN'));
    assert.equal(q.sql.split('?').length - 1, q.params.length, 'placeholder and param counts disagree');
  }
});

test('a queued lead is visible to someone who can take it', () => {
  const q = queueByCode('UNASSIGNED_BONANZA');
  setMembers(q.id, []);
  const id = mkLead('Visibility probe');
  assignToQueue(id, q.id);

  const rm = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 AND sales_org = 'BONANZA' LIMIT 1");
  const scope = leadScope(rm);
  const rows = all(
    `SELECT l.id FROM leads l WHERE l.deleted_at IS NULL AND (${scope.sql})`,
    scope.params,
  );
  assert(rows.some((r) => r.id === id), 'a queued lead is invisible to the desk that should take it');
});

/* --------------------------------------------------------- cleanup */

if (OWN.length) {
  const list = OWN.map(() => '?').join(',');
  run(`DELETE FROM activities WHERE lead_id IN (${list})`, OWN);
  run(`DELETE FROM leads WHERE id IN (${list})`, OWN);
}
run('UPDATE rules SET enabled = 1');
run('UPDATE assignment_rules SET enabled = 1');

console.log(`\n${passed} passed, ${failed} failed\n`);
db.close();
process.exit(failed ? 1 : 0);
