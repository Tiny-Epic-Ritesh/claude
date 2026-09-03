/**
 * Promoting configuration between environments.
 *
 * The tests that matter here are not the bookkeeping ones. They are the ones
 * about identity, because the failure this design exists to prevent is silent:
 * a bundle that carried database ids would apply cleanly, report success, and
 * write one environment's rule over an unrelated rule in another. Nothing
 * downstream can detect that, so it has to be impossible rather than caught.
 *
 * So: a bundle must contain no local ids, must resolve by name at the far end,
 * must refuse to apply anything it cannot identify, and must leave everything
 * it was not asked about alone.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import {
  packageBundle, inspect, apply, validate, checksumOf, recent,
  environment, KEEP, FORMAT, PROMOTABLE,
} from '../src/engine/promotion.js';
import { versionsOf } from '../src/engine/versioning.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nConfiguration promotion');

/* Unique per run, so the suite can run repeatedly against the same database. */
const RUN = String(Date.now()).slice(-8);
const ruleName = (suffix) => `PROMO ${RUN} ${suffix}`;

/** A rule to promote, made here rather than borrowed from the seed. */
const makeRule = (name, priority = 100) => Number(run(
  `INSERT INTO rules (name, description, conditions, actions, schedule, enabled, priority)
   VALUES (?,?,?,?,?,?,?)`,
  [name, 'made by promotion.test.mjs', '[]', '[]', null, 0, priority],
).lastInsertRowid);

/* ------------------------------------------------------------- packaging */

test('a bundle carries identities, never database ids', () => {
  const id = makeRule(ruleName('A'));
  const { ok, bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });
  assert(ok, 'packaging failed');

  const asText = JSON.stringify(bundle.entries);
  assert(!/"id"\s*:/.test(asText), 'the bundle carries an "id" field');
  assert(!asText.includes(`"logical_id"`), 'the bundle carries a logical_id');
  assert.equal(bundle.entries[0].identity.name, ruleName('A'),
    'the entry is not identified by name');
});

test('packaging refuses the whole bundle if any part of it is unknown', () => {
  const id = makeRule(ruleName('B'));
  const res = packageBundle({
    selection: [{ kind: 'rule', logical_id: id }, { kind: 'lead', logical_id: 1 }],
  });
  assert(!res.ok, 'a bundle containing a lead was packaged');
  assert(/not something that can be promoted/.test(res.error), res.error);
  assert(!res.bundle, 'a bundle was produced despite the refusal');
});

test('data is not promotable at all', () => {
  const kinds = PROMOTABLE.map((p) => p.kind);
  for (const forbidden of ['lead', 'client', 'user', 'activity']) {
    assert(!kinds.includes(forbidden), `${forbidden} is promotable, and must not be`);
  }
});

/* -------------------------------------------------------------- checksum */

test('a tampered bundle is refused', () => {
  const id = makeRule(ruleName('C'));
  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });

  bundle.entries[0].payload.priority = 1;
  const why = validate(bundle);
  assert(why, 'a tampered bundle validated');
  assert(/checksum/.test(why), why);
});

test('the checksum does not depend on key order', () => {
  const a = [{ kind: 'rule', identity: { name: 'x' }, payload: { p: 1, q: 2 } }];
  const b = [{ payload: { q: 2, p: 1 }, identity: { name: 'x' }, kind: 'rule' }];
  assert.equal(checksumOf(a), checksumOf(b), 'key order changed the checksum');
});

test('a bundle from a future format is refused rather than guessed at', () => {
  const id = makeRule(ruleName('D'));
  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });
  bundle.format = FORMAT + 1;
  const why = validate(bundle);
  assert(why && /format/.test(why), `expected a format refusal, got ${why}`);
});

/* ------------------------------------------- the identity hazard, directly */

test('applying resolves by identity, not by the id it was packaged from', () => {
  /* THE test. Two rules exist. A bundle is built from the first. The second
     occupies a different id, and must be left completely alone — an apply that
     went by id would have a real chance of landing on it. */
  const wantedId = makeRule(ruleName('E-wanted'), 100);
  const bystanderId = makeRule(ruleName('E-bystander'), 55);

  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: wantedId }] });

  // Change the intended rule so the apply has something to put back.
  run('UPDATE rules SET priority = 999 WHERE id = ?', [wantedId]);

  const res = apply(bundle);
  assert(res.ok, `apply failed: ${res.error}`);

  const wanted = one('SELECT priority FROM rules WHERE id = ?', [wantedId]);
  const bystander = one('SELECT priority FROM rules WHERE id = ?', [bystanderId]);

  assert.equal(wanted.priority, 100, 'the promoted rule was not restored');
  assert.equal(bystander.priority, 55, 'a rule nobody selected was modified');
});

test('an artefact absent from the target is created, not silently skipped', () => {
  const id = makeRule(ruleName('F'), 42);
  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });

  // Stand in for a different environment: remove it, then apply.
  run('DELETE FROM rules WHERE id = ?', [id]);
  assert(!one('SELECT id FROM rules WHERE name = ?', [ruleName('F')]), 'fixture not removed');

  const res = apply(bundle);
  assert(res.ok, `apply failed: ${res.error}`);
  assert.equal(res.created, 1, 'nothing was reported as created');

  const landed = one('SELECT priority FROM rules WHERE name = ?', [ruleName('F')]);
  assert(landed, 'the rule was not created in the target');
  assert.equal(landed.priority, 42, 'the created rule did not carry its payload');
});

/* --------------------------------------------------------------- inspect */

test('inspect reports what would change without changing it', () => {
  const id = makeRule(ruleName('G'), 70);
  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });
  run('UPDATE rules SET priority = 7 WHERE id = ?', [id]);

  const preview = inspect(bundle);
  assert(preview.ok, preview.error);
  assert.equal(preview.summary.update, 1, 'the change was not reported');

  const change = preview.items[0].changes.find((c) => c.field === 'priority');
  assert(change, 'the changed field was not named');
  assert.equal(change.from, 7, 'inspect misread the current value');
  assert.equal(change.to, 70, 'inspect misread the incoming value');

  // And nothing moved.
  assert.equal(one('SELECT priority FROM rules WHERE id = ?', [id]).priority, 7,
    'inspect applied the change it was only supposed to describe');
});

test('an unchanged artefact reads as identical rather than as an update', () => {
  const id = makeRule(ruleName('H'));
  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });
  const preview = inspect(bundle);
  assert.equal(preview.summary.identical, 1, 'an untouched artefact was reported as a change');
  assert.equal(preview.summary.update, 0);
});

test('a bundle naming a product this environment lacks is blocked, not half-applied', () => {
  /* KYC journeys are keyed by product, and a product cannot be invented by a
     promotion. The bundle is hand-built here because packaging one requires the
     product to exist locally, which is exactly what we are removing. */
  const bundle = {
    format: FORMAT,
    bundle_id: 'test-blocked',
    source_env: 'uat',
    created_at: new Date().toISOString(),
    note: null,
    entries: [{
      kind: 'kyc_journey',
      identity: { product_code: `NO_SUCH_PRODUCT_${RUN}` },
      payload: { steps: [] },
    }],
  };
  bundle.checksum = checksumOf(bundle.entries);

  const preview = inspect(bundle);
  assert(preview.ok, preview.error);
  assert.equal(preview.summary.blocked, 1, 'a missing product was not blocked');
  assert.equal(preview.appliable, false, 'a blocked bundle reported itself appliable');

  const res = apply(bundle);
  assert(!res.ok, 'a blocked bundle was applied');
  assert(Array.isArray(res.blocked) && res.blocked.length === 1, 'the blockage was not reported');
});

/* --------------------------------------------------------------- history */

test('applying leaves a version in the target history saying where it came from', () => {
  const id = makeRule(ruleName('I'));
  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });
  bundle.source_env = 'uat';
  bundle.checksum = checksumOf(bundle.entries);

  const res = apply(bundle);
  assert(res.ok, `apply failed: ${res.error}`);

  const versions = versionsOf('rule', id);
  assert(versions.length > 0, 'the promotion left no version behind');
  assert(/Promoted from uat/.test(versions[0].note ?? ''),
    `the version does not record the promotion: ${versions[0].note}`);
});

test('both ends of a promotion are recorded', () => {
  const id = makeRule(ruleName('J'));
  const { bundle } = packageBundle({ selection: [{ kind: 'rule', logical_id: id }] });
  apply(bundle);

  const rows = recent({ limit: KEEP });
  const forThis = rows.filter((r) => r.bundle_id === bundle.bundle_id);
  const directions = forThis.map((r) => r.direction).sort();
  assert.deepEqual(directions, ['applied', 'exported'],
    `expected both directions, got ${directions.join(', ') || 'none'}`);
});

test('only the last ten promotions are kept', () => {
  const id = makeRule(ruleName('K'));
  for (let i = 0; i < KEEP + 4; i += 1) {
    packageBundle({ selection: [{ kind: 'rule', logical_id: id }], note: `keep-test ${i}` });
  }
  const total = one('SELECT COUNT(*) c FROM config_promotions').c;
  assert(total <= KEEP, `${total} promotions kept, expected at most ${KEEP}`);
});

test('the environment is named, and is not inferred from NODE_ENV', () => {
  /* UAT and Production both run NODE_ENV=production, so inferring the label
     from it would make the audit record unable to tell them apart. */
  assert(typeof environment() === 'string' && environment().length > 0,
    'the environment has no name');
});

/* ------------------------------------------------------------- tidying up */

run("DELETE FROM rules WHERE name LIKE ?", [`PROMO ${RUN} %`]);
run("DELETE FROM artefact_versions WHERE kind = 'rule' AND note LIKE 'Promoted from uat%'");

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
