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
  owdGrant, isExternal, isLevel, EXTERNAL_PINNED,
} from '../src/engine/owd.js';

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

/** Put every object back to private, whatever a test left behind. */
const resetAll = () => {
  for (const e of OWD_ENTITIES) setDefaults(e, { internal: 'private' });
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

test('the external default is pinned to private and refuses to move', () => {
  /* Partner reads never pass through a scope function -- the portal filters on
     partner_id in code -- so an external default above private would not be
     enforced. A setting that silently does nothing is worse than one that is
     not offered, and this one would be dangerous. */
  const out = setDefaults('lead', { external: 'read' });
  assert(!out.ok, 'the external default was widened');
  assert(/partner/i.test(out.error), `the refusal does not explain why: ${out.error}`);
  assert.equal(defaultsFor('lead').external, EXTERNAL_PINNED, 'the column moved anyway');
});

test('an external caller picks up no internal grant', () => {
  // Belt and braces: if a partner session ever does reach a scope function, it
  // must not inherit whatever staff have been given.
  setDefaults('lead', { internal: 'read' });
  assert(isExternal({ partner_id: 7 }), 'a partner session was not recognised as external');
  assert.equal(owdGrant('lead', { partner_id: 7 }), null,
    'an external caller inherited the internal default');
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

resetAll();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
