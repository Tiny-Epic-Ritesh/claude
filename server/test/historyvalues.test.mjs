/**
 * Field history holds a value's text, not the way node:sqlite happened to bind it.
 *
 * old_value and new_value are TEXT columns, and node:sqlite binds every JS
 * number as a REAL, so a lead passing from user 8 to user 9 was recorded as
 * '8.0' -> '9.0' on every path -- the lead form, an approved transfer, the
 * custom-field writer. The history panel showed ids with a decimal point, and
 * anything comparing the value as text ('8', a Map keyed by String(id),
 * CAST(users.id AS TEXT)) found nothing.
 *
 * Proven here: an integer is written as its digits and nothing else changes
 * spelling; the history names the people on a person lookup and nobody on a
 * lookup to anything else; and the start-up rewrite fixes exactly the old
 * '<integer>.0' lookup rows, leaves every other value alone, and does nothing
 * the second time.
 */

import { strict as assert } from 'node:assert';
import { all, run, db, normaliseLookupHistory } from '../src/db.js';
import { seedMetadata, recordChange, historyFor, setCustomValues } from '../src/engine/metadata.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

seedMetadata();

// A record id well clear of any real lead, and a custom field of our own; every
// row written against either is removed before and after.
const PROBE = 9_100_201;
const PROBE_FIELD = 'hv_probe_count';

function cleanUp() {
  run("DELETE FROM field_history WHERE entity = 'lead' AND record_id = ?", [PROBE]);
  run(`DELETE FROM field_value WHERE field_id IN
       (SELECT id FROM field_def WHERE entity = 'lead' AND api_name = ?)`, [PROBE_FIELD]);
  run("DELETE FROM field_def WHERE entity = 'lead' AND api_name = ?", [PROBE_FIELD]);
}
cleanUp();

const [A, B] = all('SELECT id, name FROM users WHERE active = 1 ORDER BY id LIMIT 2');
assert(A && B, 'needs two active users -- run the seed first');

const rows = (field) => all(
  `SELECT old_value, new_value, typeof(old_value) AS old_type
   FROM field_history WHERE entity = 'lead' AND record_id = ? AND field = ? ORDER BY id`,
  [PROBE, field],
);
// Written as strings, so they land exactly as given -- this is how a row from
// before the fix looks.
const insert = (field, oldValue, newValue) => run(
  `INSERT INTO field_history (entity, record_id, field, old_value, new_value, source)
   VALUES ('lead', ?, ?, ?, ?, 'test')`,
  [PROBE, field, oldValue, newValue],
);

/* ----------------------------------------------------------- writing */

console.log('\nWriting a change');

test("an owner change records '8', not '8.0'", () => {
  // A.id and B.id are JS numbers, which is what both the lead form (a row read
  // back from leads) and an approved transfer pass in.
  assert(recordChange('lead', PROBE, 'owner_id', A.id, B.id, { source: 'ui' }), 'owner_id is not history-tracked');
  const [r] = rows('owner_id');
  assert.equal(r.old_value, String(A.id));
  assert.equal(r.new_value, String(B.id));
  cleanUp();
});

test('strings and nulls are stored exactly as before', () => {
  recordChange('lead', PROBE, 'owner_id', null, String(B.id));
  recordChange('lead', PROBE, 'stage', 'New', 'Contacted');

  const [owner] = rows('owner_id');
  assert.equal(owner.old_value, null);
  assert.equal(owner.old_type, 'null', 'an empty old value was stored as text');
  assert.equal(owner.new_value, String(B.id));

  const [stage] = rows('stage');
  assert.deepEqual([stage.old_value, stage.new_value], ['New', 'Contacted']);
  cleanUp();
});

test("a tracked custom number field records '5', not '5.0'", () => {
  // The other writer of field_history. Its old value comes back out of a REAL
  // column, so both sides were affected.
  run(`INSERT INTO field_def (entity, api_name, label, type, storage, history_tracked, purpose, is_custom)
       VALUES ('lead', ?, 'History probe count', 'number', 'value', 1, 'historyvalues.test', 1)`, [PROBE_FIELD]);
  setCustomValues('lead', PROBE, { [PROBE_FIELD]: 5 });
  setCustomValues('lead', PROBE, { [PROBE_FIELD]: 7 });

  const [first, second] = rows(PROBE_FIELD);
  assert.deepEqual([first.old_value, first.new_value], [null, '5']);
  assert.deepEqual([second.old_value, second.new_value], ['5', '7']);
  cleanUp();
});

/* ----------------------------------------------------------- reading */

console.log('\nReading the history');

test('an owner change names both people', () => {
  recordChange('lead', PROBE, 'owner_id', A.id, B.id);
  recordChange('lead', PROBE, 'stage', 'New', 'Contacted');
  const h = historyFor('lead', PROBE);

  const owner = h.find((x) => x.field === 'owner_id');
  assert.equal(owner.old_label, A.name);
  assert.equal(owner.new_label, B.name);

  const stage = h.find((x) => x.field === 'stage');
  assert.equal(stage.old_label, null);
  assert.equal(stage.new_label, null);
  cleanUp();
});

test('a lookup to partners is never named from users', () => {
  // partner_id holds a partner's id. The same number is somebody's user id, and
  // showing that person's name would be confidently wrong.
  insert('partner_id', null, String(B.id));
  const p = historyFor('lead', PROBE).find((x) => x.field === 'partner_id');
  assert.equal(p.new_label, null, `partner ${B.id} was shown as the user ${B.name}`);
  cleanUp();
});

test("a row written before the fix is still named", () => {
  insert('owner_id', `${A.id}.0`, `${B.id}.0`);
  const owner = historyFor('lead', PROBE).find((x) => x.field === 'owner_id');
  assert.deepEqual([owner.old_label, owner.new_label], [A.name, B.name]);
  cleanUp();
});

/* ------------------------------------------------------ the rewrite */

console.log('\nRewriting old rows');

test("the start-up rewrite fixes old lookup ids and nothing else, once", () => {
  insert('owner_id', `${A.id}.0`, `${B.id}.0`); // what the binding used to write
  insert('partner_id', null, '5.0');            // a lookup to partners: still an id
  insert('city', '12.0', 'Flat 2.0');           // text a person typed
  insert('owner_id', '08.0', null);             // not how a REAL is spelled

  normaliseLookupHistory();
  const got = all(
    "SELECT field, old_value, new_value FROM field_history WHERE entity = 'lead' AND record_id = ? ORDER BY id",
    [PROBE],
  ).map((r) => [r.field, r.old_value, r.new_value]);

  assert.deepEqual(got, [
    ['owner_id', String(A.id), String(B.id)],
    ['partner_id', null, '5'],
    ['city', '12.0', 'Flat 2.0'],
    ['owner_id', '08.0', null],
  ]);
  assert.equal(normaliseLookupHistory(), 0, 'a second run still found something to rewrite');
  cleanUp();
});

cleanUp();

console.log(`\n${passed} passed, ${failed} failed\n`);
db.close();
process.exit(failed ? 1 : 0);
