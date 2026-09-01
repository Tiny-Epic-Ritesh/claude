/**
 * Case visibility (§6a of the security register).
 *
 * `/api/tickets` and `/api/tickets/:id` carried no capability gate at all.
 * Both were book-scoped, so this was never a cross-book leak — but any signed-in
 * user could read every case in their own book, including the client's own
 * description of their own money and every reply on it.
 *
 * The properties worth holding are the two that pull against each other. A case
 * must not be readable by someone with no claim to it; and the fix must not
 * take a case away from the person who raised it, which is how a security
 * change turns into people losing their own work.
 */

import { strict as assert } from 'node:assert';
import { all, one } from '../src/db.js';
import { ticketScope, can } from '../src/auth.js';
import { CAPABILITY_CATALOGUE } from '../src/engine/access.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nCase visibility');

const userBy = (role) => one('SELECT * FROM users WHERE role = ? AND active = 1 LIMIT 1', [role]);
const visible = (user) => {
  const s = ticketScope(user, 't');
  return all(`SELECT t.id FROM tickets t WHERE ${s.sql}`, s.params).map((r) => r.id);
};

/* ------------------------------------------------------------- the gate */

test('a front-line role no longer reads every case in the book', () => {
  /* The finding itself. Before the gate this returned the whole book, which is
     what made it a finding rather than a preference. */
  const total = one('SELECT COUNT(*) n FROM tickets').n;
  assert(total > 0, 'fixture: no tickets to test against');

  for (const role of ['caller', 'dealer', 'sales_rm', 'partner_rm']) {
    const u = userBy(role);
    if (!u) continue;
    const seen = visible(u).length;
    assert(seen < total, `${role} still sees all ${total} cases`);
  }
});

test('a role with neither capability sees no cases at all', () => {
  // Fails closed. An org-scoped role that was never granted sight of cases
  // gets none, rather than falling through to everything.
  const fake = { id: -1, role: 'nobody_at_all', sales_org: 'BONANZA' };
  assert.equal(visible(fake).length, 0, 'an ungranted role saw cases');
});

/* ------------------------------------------------- not losing your own work */

test('the person who raised a case still sees it after it is assigned away', () => {
  /* The reason this was not implemented in August. Gating on the assignee
     alone silently takes a case off the person who opened it the moment
     support picks it up. */
  const row = one(
    `SELECT t.id, t.created_by FROM tickets t
      WHERE t.created_by IS NOT NULL
        AND t.assignee_id IS NOT NULL
        AND t.assignee_id != t.created_by
      LIMIT 1`,
  );
  if (!row) return;

  const author = one('SELECT * FROM users WHERE id = ?', [row.created_by]);
  assert(author, 'fixture: the raiser no longer exists');
  assert(visible(author).includes(row.id),
    `case ${row.id} is invisible to the person who raised it`);
});

test('a case against a lead you own is visible however it is assigned', () => {
  const row = one(
    `SELECT t.id, l.owner_id FROM tickets t
       JOIN leads l ON l.id = t.lead_id
      WHERE l.owner_id IS NOT NULL
        AND (t.assignee_id IS NULL OR t.assignee_id != l.owner_id)
        AND (t.created_by  IS NULL OR t.created_by  != l.owner_id)
      LIMIT 1`,
  );
  if (!row) return;

  const owner = one('SELECT * FROM users WHERE id = ? AND active = 1', [row.owner_id]);
  if (!owner) return;
  assert(visible(owner).includes(row.id),
    `an RM cannot see a case raised against their own lead (${row.id})`);
});

/* ------------------------------------------------------------ still scoped */

test('the book boundary survives the new rule', () => {
  // The scope carries the org check itself now, so this is the one that would
  // break if the two rules were ever separated again.
  for (const role of ['superadmin', 'admin', 'customer_care', 'sales_rm']) {
    const u = userBy(role);
    if (!u || !u.sales_org) continue;
    const s = ticketScope(u, 't');
    const foreign = all(
      `SELECT t.id, t.sales_org FROM tickets t WHERE ${s.sql} AND t.sales_org != ?`,
      [...s.params, u.sales_org],
    );
    assert.equal(foreign.length, 0,
      `${role} in ${u.sales_org} sees ${foreign.length} case(s) from another book`);
  }
});

test('a supervisor sees more than the rep who reports to them', () => {
  const sup = userBy('sales_supervisor');
  const rep = one("SELECT * FROM users WHERE role = 'sales_rm' AND active = 1 AND manager_id = ? LIMIT 1", [sup?.id ?? -1]);
  if (!sup || !rep) return;
  assert(visible(sup).length >= visible(rep).length,
    'a supervisor sees fewer cases than their own report');
});

/* --------------------------------------------------------- configurability */

test('both capabilities are on the roles screen', () => {
  /* The point of doing it with capabilities rather than hard-coded roles: the
     answer is visible and editable where roles are edited, so the conservative
     default shipped here can be corrected without a release. */
  const codes = CAPABILITY_CATALOGUE.map((c) => c[0]);
  for (const cap of ['ticket.view.all', 'ticket.view.own']) {
    assert(codes.includes(cap), `${cap} is enforced but cannot be granted on the roles screen`);
  }
});

test('view.all is held only by roles declared org scope', () => {
  /* The mistake leadScope calls out by name: Sales Supervisor held
     lead.view.all while being declared `team`, which made data_scope
     decorative. A supervisor reaches their team through the management chain. */
  for (const role of all('SELECT code, data_scope FROM roles')) {
    if (!can(role.code, 'ticket.view.all')) continue;
    assert.equal(role.data_scope, 'org',
      `${role.code} is declared "${role.data_scope}" but holds ticket.view.all`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
