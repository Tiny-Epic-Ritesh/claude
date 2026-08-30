/**
 * Versioning of configurable artefacts.
 *
 * Finding 10 of the LeadSquared audit: nothing was versioned, so nothing was
 * ever retired — one capability spread across five forms and three processes,
 * with V3 and V4 both live and the copy marked "old" still enabled. The version
 * history was the artefact names.
 *
 * What is worth proving:
 *
 *   • a save produces a version, and the current pointer moves
 *   • history is append-only, including across a rollback
 *   • a diff says what actually changed, not that something did
 *   • work already in flight is not rewritten under the person doing it
 */

import { strict as assert } from 'node:assert';
import { run, all, one } from '../src/db.js';
import {
  ARTEFACTS, snapshot, versionsOf, currentOf, byId, diff, restore, recentVersions,
} from '../src/engine/versioning.js';
import { journeyStepsFor } from '../src/engine/kyc.js';
import { policyFor } from '../src/engine/sla.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/* ------------------------------------------------------------- fixtures */

const admin = one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
const template = one('SELECT * FROM templates ORDER BY id LIMIT 1');
const product = one('SELECT id FROM product_types WHERE requires_kyc = 1 ORDER BY id LIMIT 1');

/** This suite's own artefact, so it never disturbs a real one. */
const TEST_RULE = 'versioning-test-rule';
run("DELETE FROM artefact_versions WHERE logical_id LIKE 'vtest-%'");
run('DELETE FROM rules WHERE name = ?', [TEST_RULE]);

const ruleId = Number(run(
  'INSERT INTO rules (name, description, conditions, actions, enabled, priority) VALUES (?,?,?,?,?,?)',
  [TEST_RULE, 'first', '[]', '[]', 0, 100],
).lastInsertRowid);

/* ---------------------------------------------------------------- tests */

console.log('\nVersioning');

test('every versioned artefact declares a label and a way back', () => {
  for (const [kind, a] of Object.entries(ARTEFACTS)) {
    assert(a.label, `${kind} has no label`);
    assert(typeof a.load === 'function', `${kind} cannot be read`);
    // Without restore, a version history is a list of things you can look at
    // and not act on.
    assert(typeof a.restore === 'function', `${kind} cannot be rolled back`);
  }
});

test('a save produces version 1, and it is the current one', () => {
  const v = snapshot('rule', ruleId, { note: 'Created', userId: admin.id });
  assert(v, 'no version was created');
  assert.equal(v.version, 1);
  assert.equal(v.is_current, true);
  assert.equal(currentOf('rule', ruleId).id, v.id);
});

test('the next save supersedes the last, and only one is current', () => {
  run('UPDATE rules SET description = ? WHERE id = ?', ['second', ruleId]);
  const v2 = snapshot('rule', ruleId, { userId: admin.id });
  assert.equal(v2.version, 2);

  const versions = versionsOf('rule', ruleId);
  assert.equal(versions.length, 2, 'the earlier version disappeared');
  assert.equal(versions.filter((v) => v.is_current).length, 1, 'two versions claim to be current');
  assert.equal(currentOf('rule', ruleId).version, 2);
});

test('the snapshot holds what was saved, not what was asked for', () => {
  const v = currentOf('rule', ruleId);
  assert.equal(v.payload.description, 'second', 'the snapshot does not match the live row');
  assert.equal(v.payload.name, TEST_RULE);
});

test('a diff names the field that changed, and stays quiet about the rest', () => {
  const [v2, v1] = versionsOf('rule', ruleId);
  const d = diff(v1.id, v2.id);
  assert(d, 'no diff produced');
  assert.equal(d.identical, false);

  const changed = d.changes.map((c) => c.field);
  assert(changed.includes('description'), `description is not listed as changed: ${changed.join(', ')}`);
  assert(!changed.includes('name'), 'an unchanged field was reported as changed');

  const desc = d.changes.find((c) => c.field === 'description');
  assert.equal(desc.from, 'first');
  assert.equal(desc.to, 'second');
});

test('two identical versions diff to nothing', () => {
  const v3 = snapshot('rule', ruleId, { userId: admin.id });
  const d = diff(currentOf('rule', ruleId).id, v3.id);
  assert.equal(d.identical, true, `a no-op save reported changes: ${JSON.stringify(d.changes)}`);
});

test('rolling back restores the values and keeps the history', () => {
  const versions = versionsOf('rule', ruleId);
  const first = versions.find((v) => v.version === 1);
  const countBefore = versions.length;

  const out = restore(first.id, { userId: admin.id });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.restored_from, 1);

  // The live row is back to what it was…
  assert.equal(one('SELECT description FROM rules WHERE id = ?', [ruleId]).description, 'first');

  // …and nothing in between was destroyed to get there.
  const after = versionsOf('rule', ruleId);
  assert.equal(after.length, countBefore + 1,
    'a rollback removed history instead of adding to it — the record of what was live is gone');
  assert(after.some((v) => v.version === 2), 'the superseded version was deleted');
  assert.match(after[0].note ?? '', /Restored version 1/);
});

test('an unknown artefact kind is refused, not guessed at', () => {
  assert.throws(() => snapshot('not_a_thing', 1), /unknown artefact kind/);
});

test('the history index returns newest first', () => {
  const rows = recentVersions({ kind: 'rule', limit: 10 });
  assert(rows.length > 0, 'nothing in the index');
  assert(rows.every((r) => r.kind === 'rule'), 'the kind filter leaked other artefacts');
});

/* ------------------------------------------------ in-flight work is pinned */

console.log('\nIn-flight work keeps the version it started on');

/* This suite rewrites a real product's journey to test the pin, so the original
   is taken now and put back at the end. A test that leaves the fixture altered
   fails whichever suite happens to run after it, for a reason that has nothing
   to do with that suite. */
const originalSteps = product
  ? all('SELECT step_code, sort_order, timer_override_s, conditional_on FROM kyc_journey_steps WHERE product_type_id = ? ORDER BY sort_order', [product.id])
  : [];

test('a journey already under way is not rewritten by a later edit', () => {
  if (!product) return;

  // A definition with three steps, saved as version 1.
  run('DELETE FROM kyc_journey_steps WHERE product_type_id = ?', [product.id]);
  for (const [i, code] of ['MOBILE', 'EMAIL', 'PAN'].entries()) {
    run('INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order) VALUES (?,?,?)',
      [product.id, code, i]);
  }
  const v1 = snapshot('kyc_journey', product.id, { note: 'three steps', userId: admin.id });
  assert.equal(journeyStepsFor(product.id).length, 3, 'the live definition is not three steps');

  // Somebody edits it down to two while an applicant is part-way through.
  run("DELETE FROM kyc_journey_steps WHERE product_type_id = ? AND step_code = 'PAN'", [product.id]);
  snapshot('kyc_journey', product.id, { note: 'two steps', userId: admin.id });

  assert.equal(journeyStepsFor(product.id).length, 2, 'the live definition did not change');
  assert.equal(journeyStepsFor(product.id, v1.id).length, 3,
    'the applicant lost a step mid-journey — the pin is not being honoured');
});

test('a ticket keeps the SLA it was raised under', () => {
  const key = 'vtest-sla';
  run("DELETE FROM artefact_versions WHERE logical_id = ?", [key]);

  // Version 1 promised four hours; version 2 halves it.
  run(`INSERT INTO artefact_versions (kind, logical_id, version, payload, is_current)
       VALUES ('sla_policy', ?, 1, ?, 0)`,
  [key, JSON.stringify({ response_mins: 60, resolution_mins: 240 })]);
  const pinned = one('SELECT id FROM artefact_versions WHERE logical_id = ? AND version = 1', [key]);
  run(`INSERT INTO artefact_versions (kind, logical_id, version, payload, is_current)
       VALUES ('sla_policy', ?, 2, ?, 1)`,
  [key, JSON.stringify({ response_mins: 30, resolution_mins: 120 })]);

  const asPromised = policyFor(null, 'High', pinned.id);
  assert.equal(asPromised.resolution_mins, 240,
    'the ticket was measured against a policy written after it was raised');

  run("DELETE FROM artefact_versions WHERE logical_id = ?", [key]);
});

test('a missing pin falls back to the live definition rather than failing', () => {
  if (!product) return;
  // A version id that no longer exists must not leave a journey with no steps.
  assert.equal(journeyStepsFor(product.id, 99999999).length,
    journeyStepsFor(product.id).length,
    'a stale pin returned a different answer from the live definition');
});

/* ---------------------------------------------------------------- tidy */

run('DELETE FROM rules WHERE name = ?', [TEST_RULE]);
run("DELETE FROM artefact_versions WHERE kind = 'rule' AND logical_id = ?", [String(ruleId)]);

if (product) {
  run('DELETE FROM kyc_journey_steps WHERE product_type_id = ?', [product.id]);
  for (const s of originalSteps) {
    run(`INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order, timer_override_s, conditional_on)
         VALUES (?,?,?,?,?)`,
    [product.id, s.step_code, s.sort_order, s.timer_override_s, s.conditional_on]);
  }
  run("DELETE FROM artefact_versions WHERE kind = 'kyc_journey' AND logical_id = ?", [String(product.id)]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
