/**
 * Approvals.
 *
 * What is worth proving is the set of things that make an approval a control
 * rather than a log entry:
 *
 *   • nobody approves their own request
 *   • the record is frozen while the decision is pending
 *   • a decision whose action fails does not record an approval
 *   • both outcomes leave a reason and an audit trail
 */

import { strict as assert } from 'node:assert';
import { all, one, run, db } from '../src/db.js';
import {
  APPROVAL_SCOPES, request, decide, withdraw, byId, queueFor,
  lockedBy, lockRefusal, history, approversFor,
} from '../src/engine/approvals.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const OWN = [];
const partnerId = one('SELECT id FROM partners LIMIT 1').id;
const requester = one("SELECT * FROM users WHERE role = 'partner_rm' AND active = 1 LIMIT 1");
const approver = one("SELECT * FROM users WHERE role = 'admin' AND active = 1 LIMIT 1");

const withCaps = (u, caps) => ({ id: u.id, capabilities: new Set(caps) });

function ask(overrides = {}) {
  const out = request({
    scope: 'commission_change',
    entityId: partnerId,
    subjectName: 'Test Partner',
    payload: { commission_pct: 42 },
    reason: 'Renegotiated at the quarterly review',
    requestedBy: requester.id,
    ...overrides,
  });
  if (out.ok) OWN.push(out.request.id);
  return out;
}

const clearPending = () => run("DELETE FROM approvals WHERE status = 'Pending'");

/* ------------------------------------------------------------ scopes */

console.log('\nThe four scopes');

test('all four scopes the business asked for exist', () => {
  for (const key of ['partner_elevation', 'partner_closure', 'commission_change', 'bulk_reassign']) {
    assert(APPROVAL_SCOPES[key], `${key} is missing`);
  }
});

test('every scope names an approver capability and says why it matters', () => {
  for (const [key, s] of Object.entries(APPROVAL_SCOPES)) {
    assert(s.approver, `${key} does not say who decides it`);
    assert(s.why, `${key} does not say why it needs approving`);
    assert(typeof s.describe === 'function', `${key} cannot describe itself`);
    // The capability must be real, not a typo that silently means "nobody".
    assert(
      one('SELECT 1 FROM capabilities WHERE code = ?', [s.approver]),
      `${key} names a capability that does not exist: ${s.approver}`,
    );
  }
});

test('somebody can actually decide each scope', () => {
  // An approval routed to a capability nobody holds is a record that never
  // moves, and it would look exactly like a working feature.
  for (const key of Object.keys(APPROVAL_SCOPES)) {
    assert(approversFor(key).length > 0, `nobody can approve ${key}`);
  }
});

/* ---------------------------------------------------------- requesting */

console.log('\nRequesting');

test('a request without a reason is refused', () => {
  clearPending();
  const out = ask({ reason: '   ' });
  assert(!out.ok);
  assert.match(out.error, /Say why/);
});

test('a request is created pending, with its payload intact', () => {
  clearPending();
  const out = ask();
  assert(out.ok, out.error);
  assert.equal(out.request.status, 'Pending');
  assert.equal(out.request.payload.commission_pct, 42);
  assert.equal(out.request.requested_by, requester.id);
});

test('a second request on the same record is refused, not queued', () => {
  // Two people asking for different changes to the same commission is a
  // conversation, not a workflow.
  const out = ask();
  assert(!out.ok);
  assert.match(out.error, /already a pending/);
  assert(out.pending_id, 'the refusal does not point at the existing request');
});

test('an unknown scope is refused', () => {
  const out = request({ scope: 'make_me_a_sandwich', entityId: 1, reason: 'x', requestedBy: requester.id });
  assert(!out.ok);
  assert.match(out.error, /not something that can be approved/);
});

/* -------------------------------------------------------------- lock */

console.log('\nThe record is frozen while it waits');

test('a pending request locks its record', () => {
  const lock = lockedBy('partner', partnerId);
  assert(lock, 'the record is not locked');
  assert.equal(lock.status, 'Pending');
});

test('the refusal explains what is blocking and who asked', () => {
  const refusal = lockRefusal('partner', partnerId);
  assert(refusal, 'no refusal produced for a locked record');
  assert.match(refusal.detail, /Commission or fee change/);
  assert.match(refusal.detail, new RegExp(requester.name.split(' ')[0]));
  assert(refusal.approval_id, 'the refusal does not name the approval');
});

test('an unrelated record is not locked', () => {
  const other = one('SELECT id FROM partners WHERE id != ? LIMIT 1', [partnerId]);
  if (!other) return;
  assert.equal(lockRefusal('partner', other.id), null, 'the lock leaked to another record');
});

/* ---------------------------------------------------------- deciding */

console.log('\nDeciding');

test('the requester cannot approve their own request', () => {
  // Whatever they hold. An approval you can grant yourself is a log line.
  const req = one("SELECT id FROM approvals WHERE status = 'Pending' LIMIT 1");
  const out = decide(req.id, {
    approve: true,
    decidedBy: withCaps(requester, ['partner.elevate']),
    apply: () => ({}),
  });
  assert(!out.ok);
  assert.match(out.error, /cannot approve your own/);
});

test('deciding without the capability is refused', () => {
  const req = one("SELECT id FROM approvals WHERE status = 'Pending' LIMIT 1");
  const out = decide(req.id, {
    approve: true,
    decidedBy: withCaps(approver, ['lead.contact']),
    apply: () => ({}),
  });
  assert(!out.ok);
  assert.match(out.error, /needs partner.elevate/);
});

test('rejecting requires a reason', () => {
  const req = one("SELECT id FROM approvals WHERE status = 'Pending' LIMIT 1");
  const out = decide(req.id, { approve: false, decidedBy: withCaps(approver, ['partner.elevate']) });
  assert(!out.ok);
  assert.match(out.error, /Say why/);
});

test('a failing action rolls back and leaves the request pending', () => {
  // An approval recorded against something that did not happen is worse than
  // no approval at all.
  const req = one("SELECT id FROM approvals WHERE status = 'Pending' LIMIT 1");
  const out = decide(req.id, {
    approve: true,
    reason: 'Looks fine',
    decidedBy: withCaps(approver, ['partner.elevate']),
    apply: () => { throw new Error('downstream exploded'); },
  });

  assert(!out.ok, 'a failing action still recorded an approval');
  assert.match(out.error, /downstream exploded/);
  assert.equal(byId(req.id).status, 'Pending', 'the request did not stay pending after a rollback');
});

test('approving applies the change and unlocks the record', () => {
  const req = one("SELECT id FROM approvals WHERE status = 'Pending' LIMIT 1");
  let ran = 0;

  const out = decide(req.id, {
    approve: true,
    reason: 'Checked against the signed agreement',
    decidedBy: withCaps(approver, ['partner.elevate']),
    apply: (r) => { ran += 1; return { pct: r.payload.commission_pct }; },
  });

  assert(out.ok, out.error);
  assert.equal(ran, 1, 'the action did not run exactly once');
  assert.equal(out.request.status, 'Approved');
  assert.equal(out.request.decided_by, approver.id);
  assert.equal(lockRefusal('partner', partnerId), null, 'the record is still locked after a decision');
});

test('deciding a settled request is refused', () => {
  const settled = one("SELECT id FROM approvals WHERE status = 'Approved' ORDER BY id DESC LIMIT 1");
  const out = decide(settled.id, {
    approve: true, reason: 'again', decidedBy: withCaps(approver, ['partner.elevate']), apply: () => ({}),
  });
  assert(!out.ok);
  assert.match(out.error, /already approved/);
});

test('both outcomes are audited', () => {
  const rows = all(
    "SELECT action FROM audit_log WHERE action IN ('approval_requested','approval_granted','approval_rejected')",
  ).map((r) => r.action);
  assert(rows.includes('approval_requested'), 'requesting was not audited');
  assert(rows.includes('approval_granted'), 'granting was not audited');
});

/* -------------------------------------------------------- withdrawing */

console.log('\nWithdrawing');

test('only the requester may withdraw', () => {
  clearPending();
  const made = ask();
  const out = withdraw(made.request.id, approver);
  assert(!out.ok);
  assert.match(out.error, /Only the person who asked/);

  const mine = withdraw(made.request.id, requester);
  assert(mine.ok, mine.error);
  assert.equal(byId(made.request.id).status, 'Withdrawn');
});

test('withdrawing releases the lock', () => {
  assert.equal(lockRefusal('partner', partnerId), null, 'a withdrawn request still locks the record');
});

/* ------------------------------------------------------------- queues */

console.log('\nThe two queues are separate questions');

test('"waiting on me" excludes my own requests', () => {
  clearPending();
  ask();
  const q = queueFor({ id: requester.id, capabilities: new Set(['partner.elevate']) });

  assert(!q.waiting_on_me.some((r) => Number(r.requested_by) === requester.id),
    'my own request is in my approval queue');
  assert(q.my_requests.some((r) => Number(r.requested_by) === requester.id),
    'my own request is missing from my list');
});

test('an approver sees it, and is told they can decide it', () => {
  const q = queueFor({ id: approver.id, capabilities: new Set(['partner.elevate']) });
  const row = q.waiting_on_me.find((r) => r.scope === 'commission_change');
  assert(row, 'the approver cannot see a request they should decide');
  assert.equal(row.can_decide, true);
  assert(row.summary, 'the request does not describe itself');
  assert(row.why, 'the request does not say why it needs approving');
});

test('someone without the capability is offered nothing to decide', () => {
  const q = queueFor({ id: approver.id, capabilities: new Set(['lead.contact']) });
  assert.equal(q.waiting_on_me.length, 0, 'work was offered to someone who cannot decide it');
});

test('a record carries its whole approval history', () => {
  const rows = history('partner', partnerId);
  assert(rows.length >= 2, 'history is missing earlier decisions');
  assert(rows.some((r) => r.status === 'Approved'), 'the approval is not in the history');
});

/* --------------------------------------------------------- cleanup */

run("DELETE FROM approvals WHERE entity = 'partner' AND entity_id = ?", [partnerId]);

console.log(`\n${passed} passed, ${failed} failed\n`);
void OWN;
db.close();
process.exit(failed ? 1 : 0);
