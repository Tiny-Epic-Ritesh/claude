/**
 * The role desk, held to one book (OPS-08).
 *
 * Two businesses share one database and every owned record carries a
 * `sales_org`. So naming a role does not name a desk: there is a `sales_rm`
 * desk in Bonanza and another in Bigul, and a query that asks only for the role
 * is asking about both at once.
 *
 * Two places were asking that way. The `assign_queue` automation action picked
 * `WHERE role = ? AND active = 1` and took the least loaded, counting load
 * across both books; and the ticket route restated the book rule for itself as
 * `sales_org = ? OR org_access LIKE ?`, which is not the rule `orgsFor`
 * implements.
 *
 * What makes this worth a test rather than a one-line fix is the failure mode.
 * A lead handed across the boundary is not assigned to the wrong person in a
 * way anybody notices -- the owner cannot open the record at all, so it appears
 * on no work list, and the only evidence is a lead that never gets called.
 * Every test below is written to fail if the boundary is dropped, not merely if
 * the ordering changes.
 *
 * The desk here is a role of this file's own (`probe_rolebook_desk`) rather
 * than a seeded one, so the candidate set is exactly the five users below and
 * the least-loaded arithmetic is not decided by whoever the seed happens to
 * have created.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { orgsFor, mayUseOrg } from '../src/auth.js';
import { leastLoadedForRole } from '../src/engine/assignment.js';
import { runAction, leadFacts } from '../src/engine/rules.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const PROBE = await probeAdmin('rolebook');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nThe role desk, held to one book');

/* ------------------------------------------------------------- fixtures */

const ROLE = 'probe_rolebook_desk';

const clean = () => {
  run("DELETE FROM tickets WHERE subject LIKE 'probe_rolebook%'");
  run("DELETE FROM ticket_categories WHERE name LIKE 'probe_rolebook%'");
  run("DELETE FROM activities WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE 'probe_rolebook%')");
  run("DELETE FROM leads WHERE name LIKE 'probe_rolebook%'");
  run('DELETE FROM users WHERE role = ?', [ROLE]);
};

clean();

/** A desk member. `orgs` is the JSON access list; null means their own book. */
const addDeskMember = (name, salesOrg, orgs = null, active = 1) => {
  const r = run(
    `INSERT INTO users (name, email, password, role, sales_org, org_access, active)
     VALUES (?,?,?,?,?,?,?)`,
    [`probe_rolebook ${name}`, `probe-rolebook-${name}@bonanza.test`, 'x', ROLE, salesOrg,
      orgs ? JSON.stringify(orgs) : null, active],
  );
  return Number(r.lastInsertRowid);
};

const DESK = {
  /* Bonanza only, by their own book. */
  bonanza: addDeskMember('bonanza', 'BONANZA'),
  /* Bigul only, by their own book. */
  bigul: addDeskMember('bigul', 'BIGUL'),
  /* Carries both, the way the seeded cross-org RM does. */
  both: addDeskMember('both', 'BONANZA', ['BONANZA', 'BIGUL']),
  /* The case the two SQL statements disagreed about: an access list that
     REPLACES their own book rather than adding to it. `orgsFor` reads this
     person as Bigul-only; `sales_org = 'BONANZA' OR ...` read them as Bonanza. */
  moved: addDeskMember('moved', 'BONANZA', ['BIGUL']),
  /* On the Bigul desk but not working. */
  dormant: addDeskMember('dormant', 'BIGUL', null, 0),
};

const userRow = (id) => one('SELECT * FROM users WHERE id = ?', [id]);

const addLead = (name, salesOrg, extra = {}) => {
  const r = run(
    `INSERT INTO leads (name, sales_org, stage, owner_id, deleted_at)
     VALUES (?,?,?,?,?)`,
    [`probe_rolebook ${name}`, salesOrg, extra.stage ?? 'New', extra.owner_id ?? null,
      extra.deleted_at ?? null],
  );
  return Number(r.lastInsertRowid);
};

/** Give someone `n` open leads in a book, so "least loaded" has something to weigh. */
const loadWith = (ownerId, salesOrg, n, extra = {}) => {
  for (let i = 0; i < n; i += 1) addLead(`load ${ownerId} ${salesOrg} ${i}`, salesOrg, { owner_id: ownerId, ...extra });
};

const assignQueue = (leadId, role = ROLE) =>
  runAction({ type: 'assign_queue', params: { role } }, leadFacts(leadId), { dryRun: false });

const ownerOf = (leadId) => one('SELECT owner_id FROM leads WHERE id = ?', [leadId]).owner_id;

/* ------------------------------------------------ the boundary itself */

await test('a Bigul lead is not handed to the Bonanza-only desk, even when they are idle', () => {
  /* The defect, stated as directly as it can be. The Bonanza member holds
     nothing and the Bigul member is carrying work, so every "least loaded"
     rule that ignores the book picks the Bonanza member -- and the lead lands
     with someone who cannot open it. */
  loadWith(DESK.bigul, 'BIGUL', 3);
  loadWith(DESK.both, 'BIGUL', 3);
  const lead = addLead('bigul enquiry', 'BIGUL');

  const result = assignQueue(lead);
  assert(!result.skipped, `skipped: ${result.skipped}`);

  const owner = ownerOf(lead);
  assert.notEqual(owner, DESK.bonanza, 'the Bigul lead went to the Bonanza-only desk member');
  assert(orgsFor(userRow(owner)).includes('BIGUL'), 'the owner does not hold the Bigul book');
});

await test('whoever is picked always holds the book the lead is in', () => {
  /* The property behind the test above, asserted for both books so a fix that
     only happens to work one way round does not pass. */
  for (const org of ['BONANZA', 'BIGUL']) {
    const lead = addLead(`property ${org}`, org);
    const result = assignQueue(lead);
    assert(!result.skipped, `${org}: skipped: ${result.skipped}`);
    const owner = ownerOf(lead);
    assert(
      orgsFor(userRow(owner)).includes(org),
      `${org}: picked ${owner}, who holds ${JSON.stringify(orgsFor(userRow(owner)))}`,
    );
  }
});

await test('an access list that replaces the home book is honoured, not added to', () => {
  /* `moved` has sales_org BONANZA and org_access ["BIGUL"], and carries no load
     at all -- so any rule that tests `sales_org = 'BONANZA' OR org_access LIKE
     '%BONANZA%'` picks them first for a Bonanza lead. `orgsFor` says they hold
     Bigul only, and that is the rule the rest of the CRM enforces: they cannot
     open a Bonanza record, so they must not be given one. */
  assert.equal(mayUseOrg(userRow(DESK.moved), 'BONANZA'), false, 'fixture: moved should not hold BONANZA');
  loadWith(DESK.bonanza, 'BONANZA', 2);
  loadWith(DESK.both, 'BONANZA', 2);

  const lead = addLead('bonanza enquiry', 'BONANZA');
  assignQueue(lead);

  assert.notEqual(ownerOf(lead), DESK.moved, 'a lead went to someone whose access list had moved them off that book');
});

/* --------------------------------------------------- what "loaded" means */

await test('load is counted inside the book, so a second book is not a penalty', () => {
  /* The cross-book member carries a large Bonanza book and nothing in Bigul.
     Counting their leads across both businesses keeps Bigul work away from
     them for a reason that has nothing to do with Bigul. */
  clean();
  Object.assign(DESK, {
    bonanza: addDeskMember('bonanza', 'BONANZA'),
    bigul: addDeskMember('bigul', 'BIGUL'),
    both: addDeskMember('both', 'BONANZA', ['BONANZA', 'BIGUL']),
  });

  loadWith(DESK.both, 'BONANZA', 9);   // heavy elsewhere
  loadWith(DESK.bigul, 'BIGUL', 2);    // lighter overall, heavier in this book

  assert.equal(
    leastLoadedForRole(ROLE, 'BIGUL'), DESK.both,
    'the two-book member was passed over for work in a book where they are carrying nothing',
  );
});

await test('deleted leads are not load', () => {
  /* A lead in the recycle bin is nobody's work. Counting it keeps new work
     away from whoever has been tidying their book.

     Settled leads are deliberately not tested either way. The helper counts
     Won and Lost as load, as OPS-05 shipped it, and `leastLoaded` in the same
     file does not -- that is a ruling to ask for, not something to pin here. */
  clean();
  Object.assign(DESK, {
    bigul: addDeskMember('bigul', 'BIGUL'),
    both: addDeskMember('both', 'BONANZA', ['BONANZA', 'BIGUL']),
  });

  loadWith(DESK.both, 'BIGUL', 4, { deleted_at: '2026-09-01 10:00:00' });
  loadWith(DESK.bigul, 'BIGUL', 1);    // the only live lead on the desk

  assert.equal(
    leastLoadedForRole(ROLE, 'BIGUL'), DESK.both,
    'deleted leads were counted as work in hand',
  );
});

/* ------------------------------------------------- when there is nobody */

await test('no one on that desk in that book leaves the lead where it is', () => {
  /* There is a desk and it has people on it -- they are just all in the other
     business. Unassigned in the right book beats assigned in the wrong one, so
     the card reports why and changes nothing. */
  clean();
  Object.assign(DESK, { bonanza: addDeskMember('bonanza', 'BONANZA') });

  const keeper = one("SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").id;
  const lead = addLead('orphan', 'BIGUL', { owner_id: keeper });

  const result = assignQueue(lead);
  assert(result.skipped, 'the card claimed to have assigned the lead');
  assert(result.skipped.includes('BIGUL'), `the reason does not say which book: ${result.skipped}`);
  assert.equal(ownerOf(lead), keeper, 'the lead was moved anyway');
});

await test('an inactive desk member is not picked', () => {
  clean();
  Object.assign(DESK, { dormant: addDeskMember('dormant', 'BIGUL', null, 0) });

  const lead = addLead('dormant desk', 'BIGUL');
  const result = assignQueue(lead);
  assert(result.skipped, 'a lead was handed to someone who is not working');
  assert.equal(ownerOf(lead), null, 'the lead was assigned anyway');
});

await test('a lead carrying no book is not guessed at', () => {
  /* `leads.sales_org` is NOT NULL with a default, so this is a lead assembled
     in memory rather than read back. Picking a book for it is how a record ends
     up permanently in the wrong one. */
  const result = runAction(
    { type: 'assign_queue', params: { role: ROLE } },
    { _lead: { id: -1, name: 'probe_rolebook bookless', sales_org: null } },
    { dryRun: false },
  );
  assert(result.skipped, 'a bookless lead was assigned to a desk');
  /* The exact reason. Matching "book" in it passed without the guard at all:
     the desk's own role name contains the word, and the helper refusing a
     missing book reads "nobody active on the probe_rolebook_desk desk in null"
     -- a card telling somebody to staff a desk when the lead is what is wrong. */
  assert.equal(result.skipped, 'the lead carries no book, so there is no desk to hand it to');
});

await test('a card with no role named still reports itself unrun', () => {
  /* Unchanged behaviour, kept under test because the guard sits directly above
     the new one and is easy to lose while editing it. */
  const lead = addLead('no role', 'BONANZA');
  const result = runAction({ type: 'assign_queue', params: {} }, leadFacts(lead), { dryRun: false });
  assert(result.skipped, 'a card with no role claimed to have assigned the lead');
  /* The reason, not just the skip: a missing role would also find nobody on the
     desk, and "nobody active on the undefined desk" tells whoever reads the run
     log to go and staff a desk rather than fix the card. */
  assert.equal(result.skipped, 'no role named on the card');
  assert.equal(ownerOf(lead), null);
});

/* ----------------------------------------- the same rule, on the case route */

await test('a case is auto-assigned inside its own book, by the same definition', async () => {
  /* The ticket route stated the book rule for itself. `moved` is the user the
     two statements disagreed about: idle, so the lowest load on the desk, and
     matching `sales_org = 'BONANZA'` -- but not entitled to the Bonanza book.
     The Bonanza member is carrying an open case, so only a rule that drops the
     boundary picks `moved`. */
  clean();
  const bonanza = addDeskMember('bonanza', 'BONANZA');
  const moved = addDeskMember('moved', 'BONANZA', ['BIGUL']);

  run("INSERT INTO tickets (subject, status, assignee_id, sales_org) VALUES (?,?,?,?)",
    ['probe_rolebook existing load', 'Open', bonanza, 'BONANZA']);

  const cat = run('INSERT INTO ticket_categories (name, auto_assign_role, active) VALUES (?,?,1)',
    ['probe_rolebook desk', ROLE]);
  const lead = addLead('case subject', 'BONANZA');

  const res = await fetch(`${BASE}/api/tickets`, {
    method: 'POST',
    headers: PROBE.headers,
    body: JSON.stringify({
      subject: 'probe_rolebook a case about a Bonanza lead',
      category_id: Number(cat.lastInsertRowid),
      lead_id: lead,
    }),
  });
  assert.equal(res.status, 201, `HTTP ${res.status}`);
  const created = await res.json();

  const row = one('SELECT assignee_id, sales_org FROM tickets WHERE id = ?', [created.id]);
  assert.equal(row.sales_org, 'BONANZA', 'fixture: the case did not land in the Bonanza book');
  assert.notEqual(row.assignee_id, moved, 'the case went to someone who cannot open the book it is in');
  assert.equal(row.assignee_id, bonanza, `expected the Bonanza desk member, got ${row.assignee_id}`);
});

await test('the case route and the lead desk agree on who holds a book', () => {
  /* One definition, asked twice. If these ever disagree, one of the two call
     sites has grown a second copy of the rule again -- which is how this
     defect existed in two shapes in the first place. */
  for (const u of all('SELECT * FROM users WHERE active = 1')) {
    for (const org of ['BONANZA', 'BIGUL']) {
      assert.equal(
        mayUseOrg(u, org), orgsFor(u).includes(org),
        `${u.name} disagrees about ${org}`,
      );
    }
  }
});

clean();
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
