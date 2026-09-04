/**
 * Organisation-wide defaults — the floor beneath every grant.
 *
 * NON-NEGOTIABLE 7: one restrictive floor, then grant-only layers.
 *
 * Two properties matter here more than anything else, and both are about what
 * does NOT happen:
 *
 *   1. Shipping this changes nobody's sight-lines. The floor was already
 *      private in code; declaring it must be a no-op on the day it lands.
 *   2. Widening a default can never reach across the book boundary. "Make
 *      leads public" is exactly the setting somebody reaches for at five
 *      o'clock, and the cross-book exposure we are holding an incident report
 *      about must not be one checkbox away.
 *
 * The second is structural rather than checked -- the OWD grant joins the
 * OR-list that is then ANDed with org scope -- but structural properties are
 * the ones a later refactor quietly breaks, so it is tested directly.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { leadScope, clientScope, ticketScope } from '../src/auth.js';
import {
  OWD_LEVELS, OWD_ENTITIES, defaultsFor, allDefaults, setDefaults,
  owdGrant, isExternal, isLevel, exceedsInternal,
  OWD_APPROVAL_KEY, approvalKeyFor,
  DERIVED_ENTITIES, isDerived,
} from '../src/engine/owd.js';
import { partnerScope, portalLeadScope, can } from '../src/auth.js';
import { APPROVAL_SCOPES } from '../src/engine/approvals.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nOrganisation-wide defaults');

/** Run a scope against the leads table and return the ids it admits. */
const visibleLeads = (user) => {
  const sc = leadScope(user, 'l');
  return all(`SELECT l.id FROM leads l WHERE l.deleted_at IS NULL AND ${sc.sql}`, sc.params)
    .map((r) => r.id);
};

const userIn = (org, role) => one(
  'SELECT * FROM users WHERE sales_org = ? AND role = ? AND active = 1 LIMIT 1',
  [org, role],
);

/**
 * Put every object back to private, whatever a test left behind.
 *
 * External first. Internal cannot be narrowed below an external that is still
 * wider -- the invariant refuses it, correctly -- so resetting in the other
 * order silently leaves an object open and every later assertion reads a state
 * nobody set.
 */
const resetAll = () => {
  for (const e of OWD_ENTITIES) {
    setDefaults(e, { external: 'private' });
    setDefaults(e, { internal: 'private' });
  }
};

resetAll();

/* ------------------------------------------------------------- the shape */

test('the default is private, for every object', () => {
  for (const row of allDefaults()) {
    assert.equal(row.owd_internal, 'private', `${row.api_name} does not default to private`);
    assert.equal(row.owd_external, 'private', `${row.api_name} is externally open`);
  }
});

test('only the two documented levels exist', () => {
  const values = OWD_LEVELS.map((l) => l.value);
  assert.deepEqual(values, ['private', 'read'], `levels are ${values.join(', ')}`);
  assert(!isLevel('read_write'),
    'read_write is offered but write is gated by capabilities, so it would not be enforced');
  assert(!isLevel('public'), 'an undocumented level was accepted');
});

test('an unknown level is refused rather than stored', () => {
  const out = setDefaults('lead', { internal: 'everyone' });
  assert(!out.ok, 'an invalid level was accepted');
  assert.equal(defaultsFor('lead').internal, 'private', 'the invalid value reached the column');
});

test('an unknown object is refused', () => {
  const out = setDefaults('not_a_thing', { internal: 'read' });
  assert(!out.ok, 'a setting was stored against an object that does not exist');
});

test('a missing or corrupt value reads as private, never as open', () => {
  /* Fail closed. A typo written straight into the column by hand, or a row that
     predates the migration, must not open an object up. */
  run("UPDATE entity_def SET owd_internal = 'nonsense' WHERE api_name = 'lead'");
  assert.equal(defaultsFor('lead').internal, 'private', 'a corrupt value did not fail closed');
  assert.equal(owdGrant('lead', { id: 1, role: 'sales_rm' }), null,
    'a corrupt value produced a grant');
  resetAll();
});

/* ------------------------------------------------- shipping changes nothing */

test('declaring the floor changes nobody\'s sight-lines', () => {
  /* The property that makes this safe to ship: private is what the code already
     did, so with every default at private the visible set must be identical to
     the set produced with no OWD grant at all. */
  resetAll();
  for (const role of ['sales_rm', 'sales_supervisor', 'caller', 'admin']) {
    const user = userIn('BONANZA', role);
    if (!user) continue;
    const withFloor = visibleLeads(user);
    assert.equal(owdGrant('lead', user), null,
      `${role}: private produced a grant, so the floor is adding reach`);
    assert(Array.isArray(withFloor), `${role}: scope did not run`);
  }
});

test('private adds no SQL at all', () => {
  // Not `1=0` -- an always-false clause in an OR-list is noise in every query
  // plan for a setting that is doing nothing.
  const user = userIn('BONANZA', 'sales_rm');
  const sql = leadScope(user, 'l').sql;
  assert(!sql.includes('1=0'), 'the floor injected a dead clause');
});

/* ------------------------------------------------------------- widening */

test('widening to read lets an RM see beyond their own book of leads', () => {
  const user = userIn('BONANZA', 'sales_rm');
  assert(user, 'no Bonanza sales RM to test with');

  resetAll();
  const before = visibleLeads(user);

  setDefaults('lead', { internal: 'read' });
  const after = visibleLeads(user);

  assert(after.length > before.length,
    `read did not widen anything: ${before.length} then ${after.length}`);
  for (const id of before) {
    assert(after.includes(id), 'widening took a lead away, so it is not grant-only');
  }
  resetAll();
});

test('a widened default is grant-only — it never removes a sight-line', () => {
  /* The whole point of a floor plus grants. Whatever the default, everything
     visible at private stays visible. */
  for (const role of ['sales_rm', 'caller', 'sales_supervisor']) {
    const user = userIn('BONANZA', role);
    if (!user) continue;
    resetAll();
    const atPrivate = visibleLeads(user);
    setDefaults('lead', { internal: 'read' });
    const atRead = visibleLeads(user);
    for (const id of atPrivate) {
      assert(atRead.includes(id), `${role} lost sight of lead ${id} when the default widened`);
    }
  }
  resetAll();
});

/* ------------------------------------------- the boundary that must hold */

test('widening a default cannot reach across the book boundary', () => {
  /* The one that matters. An open default shows an internal user everything in
     the books they are entitled to, and nothing outside them. */
  const bonanza = userIn('BONANZA', 'sales_rm');
  assert(bonanza, 'no Bonanza RM');

  const bigulLeadIds = all(
    "SELECT id FROM leads WHERE sales_org = 'BIGUL' AND deleted_at IS NULL",
  ).map((r) => r.id);
  assert(bigulLeadIds.length > 0, 'no Bigul leads in the seed, so this proves nothing');

  setDefaults('lead', { internal: 'read' });
  const seen = visibleLeads(bonanza);
  const crossed = seen.filter((id) => bigulLeadIds.includes(id));

  assert.equal(crossed.length, 0,
    `a Bonanza user saw ${crossed.length} Bigul leads once the default was widened`);
  resetAll();
});

test('the same boundary holds for clients and cases', () => {
  const bonanza = userIn('BONANZA', 'sales_rm');
  setDefaults('client', { internal: 'read' });
  setDefaults('case', { internal: 'read' });

  const cs = clientScope(bonanza, 'c');
  const bigulClients = all(
    `SELECT c.id FROM clients c WHERE c.sales_org = 'BIGUL' AND ${cs.sql}`, cs.params,
  );
  assert.equal(bigulClients.length, 0, 'a widened client default crossed the book boundary');

  const ts = ticketScope(bonanza, 't');
  const bigulCases = all(
    `SELECT t.id FROM tickets t WHERE t.sales_org = 'BIGUL' AND ${ts.sql}`, ts.params,
  );
  assert.equal(bigulCases.length, 0, 'a widened case default crossed the book boundary');

  resetAll();
});

/* --------------------------------------------------------- external users */

test('external may never exceed internal', () => {
  /* The invariant that replaced the pin. Without it, leads Private internally
     and Public Read externally would show a partner every lead in the book
     while an RM still saw only their own -- an outside party with more reach
     than the firm's own staff, one careless PATCH away. */
  resetAll();
  const out = setDefaults('lead', { external: 'read' });
  assert(!out.ok, 'external was widened past internal');
  assert(/more reach than staff/i.test(out.error), `unclear refusal: ${out.error}`);
  assert.equal(defaultsFor('lead').external, 'private', 'the column moved anyway');

  assert(exceedsInternal('read', 'private'), 'read over private was not caught');
  assert(!exceedsInternal('private', 'read'), 'narrower external was wrongly refused');
  assert(!exceedsInternal('read', 'read'), 'equal levels were refused');
});

test('external can be widened once internal allows it', () => {
  resetAll();
  setDefaults('lead', { internal: 'read' });
  const out = setDefaults('lead', { external: 'read' });
  assert(out.ok, `external was refused even at parity: ${out.error}`);
  assert.equal(defaultsFor('lead').external, 'read');
  /* And internal cannot then be narrowed underneath it -- the same inversion
     from the other side, which the engine refuses with the ordering to fix it. */
  const blocked = setDefaults('lead', { internal: 'private' });
  assert(!blocked.ok, 'internal was narrowed below a wider external');
  assert(/Narrow the partner-portal default first/i.test(blocked.error), blocked.error);

  resetAll();
  assert.equal(defaultsFor('lead').external, 'private', 'external did not reset');
  assert.equal(defaultsFor('lead').internal, 'private', 'internal did not reset');
});

test('an external caller reads the external default, never the internal one', () => {
  /* The two are never mixed. A partner must not inherit what staff were given,
     which is what would happen if the grant fell back by omission. */
  resetAll();
  setDefaults('lead', { internal: 'read' });
  assert(isExternal({ partner_id: 7 }), 'a partner session was not recognised as external');
  assert.equal(owdGrant('lead', { partner_id: 7 }), null,
    'an external caller inherited the internal default');

  // Staff do get it, so the fixture is doing something.
  assert(owdGrant('lead', userIn('BONANZA', 'sales_rm')), 'internal read produced no grant');
  resetAll();
});

/* ------------------------------------------------------------- coverage */

test('every enforced object is one the scope functions actually consult', () => {
  for (const entity of OWD_ENTITIES) {
    assert(one('SELECT api_name FROM entity_def WHERE api_name = ?', [entity]),
      `${entity} is enforced but is not a configured object`);
  }
  assert(allDefaults().some((e) => e.enforced), 'nothing reports itself as enforced');
});

/* ------------------------------------- the last four objects, 4 Sep 2026 */

test('two objects are derived, and must never get a floor', () => {
  /* An interaction is visible exactly when its lead is; a product card the
     same. Public Read on `interaction` would show somebody the calls logged
     against leads they cannot see -- a worse leak than the one the floor exists
     to prevent, because an interaction carries what was said. */
  for (const entity of ['interaction', 'product_interest']) {
    assert(isDerived(entity), `${entity} is no longer marked derived`);
    assert(!OWD_ENTITIES.includes(entity),
      `${entity} was given a row-level floor, which would break the lead's`);
    assert.equal(owdGrant(entity, { id: 1, role: 'admin' }), null,
      `${entity} produced a grant`);
    assert(DERIVED_ENTITIES[entity], `${entity} has no note explaining what it follows`);
  }
});

test('the Setup screen can tell derived from unenforced', () => {
  // "Not read" and "follows the lead" look the same on a screen and are not the
  // same thing; one is an omission, the other is the design.
  const rows = allDefaults();
  const interaction = rows.find((r) => r.api_name === 'interaction');
  assert(interaction, 'interaction is not a configured object');
  assert.equal(interaction.derived, true);
  assert(/follows the lead/i.test(interaction.derived_note ?? ''), interaction.derived_note);

  const lead = rows.find((r) => r.api_name === 'lead');
  assert.equal(lead.derived, false, 'lead was marked derived');
  assert.equal(lead.enforced, true);
});

test('tasks and partners now carry a floor', () => {
  for (const entity of ['task', 'partner']) {
    assert(OWD_ENTITIES.includes(entity), `${entity} is not enforced`);
    assert(approvalKeyFor(entity), `${entity} has no approval key, so it cannot be changed`);
  }
});

test('the task floor is private by default and adds nothing', () => {
  resetAll();
  const user = userIn('BONANZA', 'sales_rm');
  assert.equal(owdGrant('task', user), null, 'private produced a grant on tasks');

  setDefaults('task', { internal: 'read' });
  assert(owdGrant('task', user), 'read produced no grant on tasks');
  resetAll();
});

/* ------------------------------------------------------- partners */

/** Partners this person may read, through the scope rather than a route. */
const visiblePartners = (user) => {
  const sc = partnerScope(user, 'p');
  return all(`SELECT p.id FROM partners p WHERE ${sc.sql}`, sc.params).map((r) => r.id);
};

test('the partner refactor changed nobody: an RM still sees only their own', () => {
  /* The behaviour that used to be `req.user.role === 'partner_rm'` written into
     partnerFilter. It is now the absence of `partner.view.all`, and it has to
     resolve to exactly the same set or the refactor moved somebody. */
  const rm = userIn('BONANZA', 'partner_rm');
  assert(rm, 'no Bonanza partner RM seeded');
  assert(!can(rm.role, 'partner.view.all'), 'a Partner RM was given the wide grant');

  resetAll();
  const seen = visiblePartners(rm);
  const owned = all('SELECT id FROM partners WHERE owner_id = ?', [rm.id]).map((r) => r.id);

  for (const id of seen) {
    assert(owned.includes(id), `the RM sees partner ${id}, which they do not own`);
  }
});

test('the three roles that could see the whole book still can', () => {
  for (const role of ['superadmin', 'admin', 'sales_supervisor']) {
    const user = userIn('BONANZA', role);
    if (!user) continue;
    assert(can(role, 'partner.view.all'), `${role} lost its reach across the partner book`);

    const seen = visiblePartners(user);
    const inBook = all("SELECT id FROM partners WHERE sales_org = 'BONANZA'").map((r) => r.id);
    for (const id of inBook) {
      assert(seen.includes(id), `${role} lost sight of partner ${id}`);
    }
  }
});

test('widening the partner default cannot cross the book boundary', () => {
  const rm = userIn('BONANZA', 'partner_rm');
  const bigul = all("SELECT id FROM partners WHERE sales_org = 'BIGUL'").map((r) => r.id);
  if (!bigul.length) { assert(true, 'no Bigul partners seeded'); return; }

  setDefaults('partner', { internal: 'read' });
  const seen = visiblePartners(rm);
  const crossed = seen.filter((id) => bigul.includes(id));

  assert.equal(crossed.length, 0,
    `a Bonanza RM saw ${crossed.length} Bigul partners once the default was widened`);
  resetAll();
});

test('widening the partner default is grant-only', () => {
  const rm = userIn('BONANZA', 'partner_rm');
  resetAll();
  const atPrivate = visiblePartners(rm);

  setDefaults('partner', { internal: 'read' });
  const atRead = visiblePartners(rm);

  for (const id of atPrivate) {
    assert(atRead.includes(id), `the RM lost sight of partner ${id} when the default widened`);
  }
  assert(atRead.length >= atPrivate.length, 'read narrowed the set');
  resetAll();
});

/* ---------------------------------------- the portal, and the lifted pin */

const partnerIn = (org) => one(
  'SELECT * FROM partners WHERE sales_org = ? ORDER BY id LIMIT 1', [org],
);

/** Leads this partner may read, through the scope the portal now uses. */
const portalLeads = (partner) => {
  const sc = portalLeadScope(partner, 'l');
  return all(`SELECT l.id FROM leads l WHERE ${sc.sql}`, sc.params).map((r) => r.id);
};

test('a partner sees only what they sourced, by default', () => {
  /* The behaviour the hardcoded `partner_id = ?` filter had. Declaring it must
     not have moved anybody, which is the same property the internal floor had
     to have on the day it shipped. */
  resetAll();
  const partner = partnerIn('BONANZA');
  assert(partner, 'no Bonanza partner seeded');

  const seen = portalLeads(partner);
  const sourced = all(
    'SELECT id FROM leads WHERE partner_id = ? AND deleted_at IS NULL', [partner.id],
  ).map((r) => r.id);

  assert.deepEqual([...seen].sort(), [...sourced].sort(),
    'the scope does not match the filter it replaced');
});

test('the external default now governs the portal rather than describing it', () => {
  /* The pin is lifted: this is the assertion that could not have been written
     before, because the column did not reach the query. */
  resetAll();
  const partner = partnerIn('BONANZA');
  const before = portalLeads(partner);

  setDefaults('lead', { internal: 'read' });
  setDefaults('lead', { external: 'read' });
  const after = portalLeads(partner);

  assert(after.length > before.length,
    `the external default did not reach the portal: ${before.length} then ${after.length}`);
  for (const id of before) {
    assert(after.includes(id), 'widening took a lead away, so it is not grant-only');
  }
  resetAll();
});

test('a widened portal cannot cross the book boundary', () => {
  /* The clause that matters most in portalLeadScope. A partner is an outside
     party; handing a Bigul partner the Bonanza book would be the cross-book
     exposure we hold an incident report about, with a third party on the far
     side of it. */
  const partner = partnerIn('BIGUL');
  assert(partner, 'no Bigul partner seeded, so this proves nothing');

  const bonanza = all(
    "SELECT id FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL",
  ).map((r) => r.id);
  assert(bonanza.length > 0, 'no Bonanza leads seeded');

  setDefaults('lead', { internal: 'read' });
  setDefaults('lead', { external: 'read' });

  const seen = portalLeads(partner);
  const crossed = seen.filter((id) => bonanza.includes(id));
  assert.equal(crossed.length, 0,
    `a Bigul partner saw ${crossed.length} Bonanza leads once the portal was widened`);

  resetAll();
});

test('a deleted lead stays invisible however wide the default', () => {
  const partner = partnerIn('BONANZA');
  setDefaults('lead', { internal: 'read' });
  setDefaults('lead', { external: 'read' });

  const sc = portalLeadScope(partner, 'l');
  assert(/deleted_at IS NULL/.test(sc.sql), 'the portal scope dropped its deleted-at clause');

  const deleted = all('SELECT id FROM leads WHERE deleted_at IS NOT NULL').map((r) => r.id);
  const seen = portalLeads(partner);
  for (const id of deleted) {
    assert(!seen.includes(id), `a deleted lead ${id} was visible in the portal`);
  }
  resetAll();
});

/* ------------------------------------------------ the approval gate */

test('the approval numbering is fixed, and covers every enforced object', () => {
  /* approvals.entity_id is an INTEGER and these objects are keyed by name, so a
     fixed number bridges the two. Renumbering would attach a pending request to
     a different object than the one it was raised against -- silently, because
     the payload would still read correctly. Add to these; never move them. */
  /* Written as "these numbers never move" rather than "this is the whole map",
     so adding an object is allowed and renumbering one is not. The first three
     are spelled out because they are the ones with history: a pending request
     raised against lead 1 must still mean lead after any later edit here. */
  const FIXED = { lead: 1, client: 2, case: 3, task: 4, partner: 5 };
  for (const [entity, key] of Object.entries(FIXED)) {
    assert.equal(OWD_APPROVAL_KEY[entity], key,
      `${entity} was renumbered from ${key} to ${OWD_APPROVAL_KEY[entity]}. `
      + 'A pending request would now point at the wrong object.');
  }

  for (const entity of OWD_ENTITIES) {
    assert(approvalKeyFor(entity), `${entity} is enforced but has no approval key`);
  }
  const keys = Object.values(OWD_APPROVAL_KEY);
  assert.equal(new Set(keys).size, keys.length, 'two objects share an approval key');
});

test('changing a sharing default is an approval scope', () => {
  const scope = APPROVAL_SCOPES.owd_change;
  assert(scope, 'owd_change is not an approval scope');
  assert.equal(scope.approver, 'audit.read',
    'the approver capability must differ from the requester one, or one person holds both and nothing can ever be decided');
  assert(scope.why && scope.why.length > 20, 'the scope does not say why it needs approving');
});

resetAll();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
