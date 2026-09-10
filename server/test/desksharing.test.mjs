/**
 * Supervising a sales group grants sight of what that group owns. N-7a.
 *
 * THE GAP
 *
 * Visibility inherited through the management chain and nothing else. A desk
 * supervisor who is not the org-chart manager of the RMs on their desk could
 * not see a single one of their leads. Ritesh confirmed on 10 September that
 * Bonanza has those people, and the seeded data does not — every seeded desk
 * manager is also the members' manager — so these fixtures build the shape the
 * business has rather than the one the seed happens to hold.
 *
 * WHAT THESE ARE CHECKING, AND WHY EACH ONE
 *
 * An access change is the one place where a test proving the feature works is
 * only half the job. The other half is proving it did not widen anything else:
 * a grant that also lets an RM read the desk's other books, or that reaches
 * across the book boundary, has caused a data breach rather than fixed a
 * visibility gap. Four of the seven below assert an absence for that reason.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { leadScope } from '../src/auth.js';
import { desksManagedBy, explainVisibility } from '../src/engine/sharing.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nDesk sharing');

/* ------------------------------------------------------------- fixtures */

const clean = () => {
  run("DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE name LIKE 'probe_desk%')");
  run("DELETE FROM teams WHERE name LIKE 'probe_desk%'");
  run("DELETE FROM leads WHERE name LIKE 'Desk probe%'");
  run("DELETE FROM users WHERE email LIKE 'probe-desk-%@bonanza.test'");
};
clean();

/* The supervisor. Signed in as, so `probeAdmin` builds them — and it creates
   them with no `manager_id` and nobody reporting to them, which is exactly the
   person this feature is for: they supervise a desk and appear nowhere above
   its members on the org chart. */
const SUP = await probeAdmin('desksup', { role: 'sales_supervisor', sales_org: 'BONANZA' });

/* And one of the RMs on that desk, signed in as, to prove membership alone
   grants nothing. */
const MEMBER = await probeAdmin('deskrm', { role: 'sales_rm', sales_org: 'BONANZA' });

const seededPassword = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'").password;

const makeUser = (slug, org = 'BONANZA') => Number(run(
  `INSERT INTO users (name, email, password, role, sales_org, active)
   VALUES (?,?,?,'sales_rm',?,1)`,
  [`Desk probe ${slug}`, `probe-desk-${slug}@bonanza.test`, seededPassword, org],
).lastInsertRowid);

const MATE = makeUser('mate');        // on the desk, alongside MEMBER
const OUTSIDER = makeUser('outsider'); // no desk
const BIGUL = makeUser('bigul', 'BIGUL');

const makeLead = (slug, ownerId, org = 'BONANZA') => Number(run(
  `INSERT INTO leads (name, mobile, email, source, stage, sales_org, owner_id)
   VALUES (?, '9800000031', ?, 'Referral', 'New', ?, ?)`,
  [`Desk probe ${slug}`, `probe-desk-${slug}@lead.test`, org, ownerId],
).lastInsertRowid);

const LEAD = {
  member: makeLead('member', MEMBER.id),
  mate: makeLead('mate', MATE),
  outsider: makeLead('outsider', OUTSIDER),
  bigul: makeLead('bigul', BIGUL, 'BIGUL'),
};

/* The desk, and a desk beneath it. */
const desk = (name, managerId, parentId = null) => Number(run(
  `INSERT INTO teams (name, manager_id, parent_id, sales_org, active) VALUES (?,?,?, 'BONANZA', 1)`,
  [name, managerId, parentId],
).lastInsertRowid);

const DESK = desk('probe_desk main', SUP.id);
const SUBDESK = desk('probe_desk under it', null, DESK);

const join = (teamId, userId) => run(
  'INSERT INTO team_members (team_id, user_id) VALUES (?,?)', [teamId, userId],
);
join(DESK, MEMBER.id);
join(DESK, MATE);
const DEEP = makeUser('deep');
const LEAD_DEEP = makeLead('deep', DEEP);
join(SUBDESK, DEEP);

/** Which of the probe leads this person can actually read, through the API. */
const visibleTo = async (probe) => {
  /* The lead list answers with a bare array, not an envelope. Asked for in one
     page large enough to hold every probe lead, and filtered by id here rather
     than by a search term -- a search that quietly matches nothing would make
     every assertion below pass for the wrong reason. */
  const res = await fetch(`${BASE}/api/leads?limit=500`, { headers: probe.headers });
  assert.equal(res.status, 200, `lead list refused: HTTP ${res.status}`);
  const rows = await res.json();
  assert(Array.isArray(rows), `the lead list is not an array: ${JSON.stringify(rows).slice(0, 120)}`);
  return new Set(rows.map((r) => r.id));
};

/* ------------------------------------------------------------ the grant */

await test('a desk supervisor sees the leads of somebody who does not report to them', async () => {
  /* The whole point. MEMBER's `manager_id` is null and SUP is not in their
     chain — before this, SUP could not see this lead at all. */
  assert.equal(one('SELECT manager_id FROM users WHERE id = ?', [MEMBER.id]).manager_id, null,
    'the fixture gave the RM a manager, which would prove the wrong thing');

  const seen = await visibleTo(SUP);
  assert(seen.has(LEAD.member), "a desk supervisor cannot see their own desk's lead");
});

await test('and the leads of a desk beneath the one they manage', async () => {
  /* A regional head over two desks would otherwise see neither, because their
     desk's members are supervisors and the leads sit under those. */
  const seen = await visibleTo(SUP);
  assert(seen.has(LEAD_DEEP), 'a sub-desk is invisible, so the tree only works one level deep');
});

await test('but nothing owned by somebody on no desk of theirs', async () => {
  const seen = await visibleTo(SUP);
  assert(!seen.has(LEAD.outsider), 'the grant reaches past the desks it is for');
});

await test('and nothing in the other business', async () => {
  /* The grant is ORed into reach and reach is ANDed with org entitlement, so
     this should be structurally impossible — which is exactly the kind of
     claim worth checking rather than reasoning about. */
  const seen = await visibleTo(SUP);
  assert(!seen.has(LEAD.bigul), 'a Bonanza supervisor can read a Bigul lead');
});

/* ------------------------------------------------ what it does NOT widen */

await test('being on a desk grants nothing on its own', async () => {
  /* Deliberately excluded. Letting every RM on a desk read every other RM's
     book is a much larger change to who can reach client PII, and it is a
     decision to take out loud rather than to slip in under a ticket about
     supervisors. Managing a desk grants; being on one does not. */
  const seen = await visibleTo(MEMBER);
  assert(seen.has(LEAD.member), 'an RM cannot see their own lead, so this proves nothing');
  assert(!seen.has(LEAD.mate),
    'an RM can read a deskmate\'s book — membership is granting visibility, which was not asked for');
});

await test('the grant only ever adds, never takes away', async () => {
  /* The property that makes this a floor with layers rather than a set of
     competing rules. Removing the desk must leave the supervisor's own book
     exactly where it was. */
  const own = makeLead('supown', SUP.id);
  const before = await visibleTo(SUP);
  assert(before.has(own), 'the supervisor cannot see their own lead');

  run('UPDATE teams SET manager_id = NULL WHERE id = ?', [DESK]);
  const after = await visibleTo(SUP);
  run('UPDATE teams SET manager_id = ? WHERE id = ?', [SUP.id, DESK]);

  assert(after.has(own), 'losing a desk took away the supervisor\'s own book');
  assert(!after.has(LEAD.member), 'losing the desk did not take the desk away');
});

/* ------------------------------------------------------- the mechanics */

await test('a cycle in the desk tree terminates instead of hanging', () => {
  /* One bad edit in any admin screen. `UNION` rather than `UNION ALL` is what
     makes this end; without it the recursive walk never closes. */
  run('UPDATE teams SET parent_id = ? WHERE id = ?', [SUBDESK, DESK]);
  const desks = desksManagedBy(SUP.id);
  run('UPDATE teams SET parent_id = NULL WHERE id = ?', [DESK]);

  assert(desks.includes(DESK) && desks.includes(SUBDESK), `a cycle lost a desk: ${desks.join(',')}`);
});

await test('an inactive desk grants nothing', () => {
  run('UPDATE teams SET active = 0 WHERE id = ?', [DESK]);
  const desks = desksManagedBy(SUP.id);
  run('UPDATE teams SET active = 1 WHERE id = ?', [DESK]);
  assert(!desks.includes(DESK), 'a retired desk still grants sight of its members');
});

await test('somebody who manages no desk gets no clause at all', () => {
  /* `owner_id IN ()` is a syntax error in SQLite, so the grant has to be
     omitted rather than emitted empty. Every request by every RM goes through
     this path. */
  const scope = leadScope({ id: MEMBER.id, role: 'sales_rm', sales_org: 'BONANZA' }, 'l', null);
  assert(scope.sql.length > 0, 'no scope produced');
  assert(!/IN \(\s*\)/.test(scope.sql), `an empty IN () reached the SQL: ${scope.sql}`);
  const rows = all(`SELECT COUNT(*) n FROM leads l WHERE ${scope.sql}`, scope.params);
  assert(rows.length === 1, 'the scope does not run');
});

await test('the explanation names the desk grant separately from the chain', () => {
  /* "Why can they see this?" is the question the audit says nobody could
     answer. Supervising a desk and managing a person are different reasons and
     have to read as different reasons. */
  const { grants } = explainVisibility({ id: SUP.id, role: 'sales_supervisor' }, 'team');
  const desk = grants.find((g) => /desk/i.test(g.grant));
  assert(desk, `no desk grant in the explanation: ${grants.map((g) => g.grant).join(', ')}`);
  assert(/whether or not those people report to them/i.test(desk.detail),
    'the explanation does not say what makes this different from the management chain');
});

/* Everything this file made, including the two accounts it signed in with.
 *
 * `probeAdmin` says its accounts are swept by the seed, and between runs that
 * is true -- but the seed runs BEFORE the unit chain, not after, so an account
 * left here is still there when the end-to-end suite runs later in the same
 * `npm test`. That suite picks users out of a list by position, and two extra
 * people in the list is enough to change which one it picks. A test that
 * mutates shared state and does not put it back breaks a different suite for
 * reasons nobody can trace. */
clean();
SUP.cleanup();
MEMBER.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
