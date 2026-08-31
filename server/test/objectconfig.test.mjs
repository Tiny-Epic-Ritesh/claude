/**
 * Object configuration — P2-21.
 *
 * "Edit and configuration options for all objects" is a claim about coverage,
 * and coverage claims rot quietly: an object added later gets a table, screens
 * and reports, and nobody notices it never got a metadata definition. That is
 * exactly what had happened to Client, which had all three and could not be
 * configured at all.
 *
 * These are conformance checks rather than examples. They fail when the
 * configuration surface stops covering something, not when a particular field
 * changes.
 */

import { strict as assert } from 'node:assert';
import { all, one } from '../src/db.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nObject configuration');

/* The objects a user actually works with, and which the feedback named. Kept
   explicit so adding a screen for something without defining it fails here. */
const MUST_BE_CONFIGURABLE = ['lead', 'client', 'case'];

test('every object the product exposes has a metadata definition', () => {
  for (const api of MUST_BE_CONFIGURABLE) {
    const e = one('SELECT api_name, table_name, active FROM entity_def WHERE api_name = ?', [api]);
    assert(e, `${api} has no entity_def row, so it cannot be configured at all`);
    assert(e.active, `${api} is defined but inactive`);
    const n = one('SELECT COUNT(*) n FROM field_def WHERE entity = ? AND active = 1', [api]).n;
    assert(n > 0, `${api} is defined but has no fields`);
  }
});

test('every defined object points at a table that exists', () => {
  const tables = new Set(all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name));
  for (const e of all('SELECT api_name, table_name FROM entity_def WHERE active = 1')) {
    assert(tables.has(e.table_name),
      `${e.api_name} points at "${e.table_name}", which does not exist`);
  }
});

test('every field maps to a real column, or is stored as a value', () => {
  /* A core field claims storage = 'column'. If the column is not there the
     field reads as permanently empty on every screen and in every export, with
     no error anywhere. */
  for (const e of all('SELECT api_name, table_name FROM entity_def WHERE active = 1')) {
    const cols = new Set(all(`PRAGMA table_info(${e.table_name})`).map((c) => c.name));
    for (const f of all(
      "SELECT api_name, storage FROM field_def WHERE entity = ? AND active = 1 AND storage = 'column'",
      [e.api_name],
    )) {
      assert(cols.has(f.api_name),
        `${e.api_name}.${f.api_name} claims a column that ${e.table_name} does not have`);
    }
  }
});

test('no field is offered as a choice with nothing to choose from', () => {
  /* Eight were, including case.status — the status of the Ticket object. A
     picklist with no values is worse than a text field: it promises a
     controlled vocabulary and delivers an empty dropdown. */
  const empty = [];
  for (const f of all(
    "SELECT id, entity, api_name FROM field_def WHERE active = 1 AND type IN ('picklist','multipicklist')",
  )) {
    const n = one('SELECT COUNT(*) n FROM picklist_value WHERE field_id = ? AND active = 1', [f.id]).n;
    if (n === 0) empty.push(`${f.entity}.${f.api_name}`);
  }
  assert.equal(empty.length, 0, `picklists with no values: ${empty.join(', ')}`);
});

test('a picklist sourced from another table matches that table', () => {
  /* Call outcomes live in the dispositions table, which has its own screen.
     Restating them in a second list is how the outcome an RM picks stops
     matching the one a report counts. */
  const check = (apiName, sql) => {
    const f = one("SELECT id FROM field_def WHERE entity = 'interaction' AND api_name = ?", [apiName]);
    const offered = new Set(all('SELECT value FROM picklist_value WHERE field_id = ? AND active = 1', [f.id]).map((v) => v.value));
    for (const r of all(sql)) {
      assert(offered.has(r.v), `interaction.${apiName} does not offer "${r.v}", which the dispositions table defines`);
    }
  };
  check('disposition', "SELECT DISTINCT outcome AS v FROM dispositions WHERE active = 1 AND outcome IS NOT NULL");
  check('sub_disposition', "SELECT DISTINCT label AS v FROM dispositions WHERE active = 1 AND label IS NOT NULL");
});

test('every custom field has an owner and a stated purpose', () => {
  /* The legacy audit's Finding 3 is 289 unowned custom fields after four
     years. This product asks who owns a field and why it exists precisely so
     that cannot accumulate — and then accumulated 161 of them in nine days,
     because the end-to-end suite adds one per run and reseeding never cleared
     them. This is the check that would have said so. */
  const orphans = all(
    `SELECT entity, api_name, owner_user_id, purpose FROM field_def
     WHERE is_custom = 1 AND active = 1
       AND (owner_user_id IS NULL OR purpose IS NULL OR trim(purpose) = '')`,
  );
  assert.equal(orphans.length, 0,
    `${orphans.length} custom field(s) with no owner or no purpose: `
    + orphans.slice(0, 8).map((f) => `${f.entity}.${f.api_name}`).join(', '));
});

test('custom fields have not silently accumulated', () => {
  // A blunt ceiling, deliberately. It is not a design limit; it is a smoke
  // alarm for the failure above, which was invisible for nine days.
  const n = one('SELECT COUNT(*) n FROM field_def WHERE is_custom = 1').n;
  assert(n < 40, `${n} custom fields — that is test residue accumulating, not configuration`);
});

test('an encrypted field never becomes readable by relabelling it', () => {
  // PAN is the field the whole masking engine exists for.
  for (const entity of ['lead', 'client']) {
    const pan = one("SELECT encrypted, read_scope, read_capability FROM field_def WHERE entity = ? AND api_name = 'pan'", [entity]);
    if (!pan) continue;
    assert.equal(pan.encrypted, 1, `${entity}.pan is not encrypted`);
    assert.equal(pan.read_scope, 'capability', `${entity}.pan is not capability-scoped`);
    assert(pan.read_capability, `${entity}.pan names no capability`);
  }
});

test('the Client object exposes what an administrator would configure, and no more', () => {
  const fields = new Set(
    all("SELECT api_name FROM field_def WHERE entity = 'client' AND active = 1").map((f) => f.api_name),
  );
  for (const expected of ['name', 'client_code', 'pan', 'status', 'owner_id']) {
    assert(fields.has(expected), `client.${expected} is missing`);
  }
  /* The trading aggregates are written by the broking back office. Offering
     them here would invite an edit that the next sync silently overwrites. */
  for (const backOffice of ['ledger_balance', 'margin_available', 'holding_value', 'trades_last_year']) {
    assert(!fields.has(backOffice),
      `client.${backOffice} is back-office data and should not be configurable here`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
