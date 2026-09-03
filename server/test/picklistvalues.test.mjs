/**
 * Editing what a picklist offers (P2-21).
 *
 * The route existed since the metadata engine was built and had no screen, so
 * an administrator could see that Stage offers six values and could not change
 * them — the single most common configuration change any CRM is asked for, on
 * exactly the three objects the feedback named.
 *
 * The dangerous half is not adding a value, it is removing one. Retiring a
 * value leaves the string on every record that already held it: those records
 * go on showing something the picker no longer offers, reports group by it, and
 * nothing anywhere says how many there are. So the counts have to be right, and
 * they have to be right per book.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run } from '../src/db.js';
import { valueUsage, fieldDef } from '../src/engine/metadata.js';

/* Source read from disk, so line endings are whatever git checked out --
   CRLF on Windows. Every pattern below is written with \n, so normalise once
   here rather than in each assertion. */
const CRLF = /\r\n/g;

let passed = 0;
let failed = 0;
const readSetup = () => readFileSync(new URL('../src/routes/setup.js', import.meta.url), 'utf8').replace(CRLF, '\n');

const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nPicklist values');

/* The three objects A-6 named. Kept explicit so a picklist losing its
   configurability fails here rather than being noticed by an administrator. */
const NAMED = [['lead', 'stage'], ['lead', 'source'], ['client', 'status'], ['case', 'status'], ['case', 'priority']];

test('every picklist on the three named objects can be counted', () => {
  for (const [entity, field] of NAMED) {
    const rows = valueUsage(entity, field);
    assert(rows, `${entity}.${field} cannot be counted, so it cannot be safely edited`);
    assert(rows.length > 0, `${entity}.${field} has no values at all`);
  }
});

test('the counts are the real number of records holding each value', () => {
  /* Asserted against the table rather than against another metadata read —
     a count derived from the same place it is displayed proves nothing. */
  const rows = valueUsage('lead', 'stage');
  for (const r of rows.filter((v) => v.defined)) {
    const actual = one(
      'SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND stage = ?', [r.value],
    ).n;
    assert.equal(r.records, actual, `"${r.label}" reported ${r.records}, the table says ${actual}`);
  }
});

test('soft-deleted records are not counted', () => {
  // They are not on anybody's screen, so counting them would overstate the
  // consequence of a change nobody can see.
  const victim = one("SELECT id, stage FROM leads WHERE deleted_at IS NULL AND stage IS NOT NULL LIMIT 1");
  if (!victim) return;

  const before = valueUsage('lead', 'stage').find((v) => v.value === victim.stage).records;
  run("UPDATE leads SET deleted_at = datetime('now') WHERE id = ?", [victim.id]);
  const after = valueUsage('lead', 'stage').find((v) => v.value === victim.stage).records;
  run('UPDATE leads SET deleted_at = NULL WHERE id = ?', [victim.id]);

  assert.equal(after, before - 1, 'a deleted lead is still being counted against its stage');
});

test('the counts are the administrator\'s own books, not both', () => {
  /* A Bigul admin deciding whether to retire a stage should be told how many
     Bigul leads hold it. The same boundary as every other count, reached here
     through a configuration screen — which is how the two admin cockpit
     metrics went wrong. */
  const orgs = all('SELECT DISTINCT sales_org FROM leads WHERE sales_org IS NOT NULL').map((r) => r.sales_org);
  if (orgs.length < 2) return;

  const both = valueUsage('lead', 'stage', orgs);
  const first = valueUsage('lead', 'stage', [orgs[0]]);

  const total = (rows) => rows.reduce((a, r) => a + r.records, 0);
  assert(total(first) < total(both),
    `one book counted ${total(first)} and both counted ${total(both)} — the scope is not applied`);
});

test('a value on records but not on the list is reported, not hidden', () => {
  /* The wreckage of this exact edit being made without the counts. Hiding it
     would make the screen agree with itself and disagree with the data. */
  const rows = valueUsage('lead', 'source');
  const orphans = rows.filter((v) => !v.defined);
  for (const o of orphans) {
    assert(o.records > 0, `"${o.value}" is reported as an orphan with no records`);
    const actual = one('SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND source = ?', [o.value]).n;
    assert.equal(o.records, actual, `orphan "${o.value}" reported ${o.records}, table says ${actual}`);
  }
});

test('an inactive value still reports what holds it', () => {
  // A retired value is exactly the one somebody needs the count for, when they
  // are deciding whether to bring it back.
  const f = fieldDef('lead', 'stage');
  const v = one('SELECT value FROM picklist_value WHERE field_id = ? AND active = 1 LIMIT 1', [f.id]);
  run('UPDATE picklist_value SET active = 0 WHERE field_id = ? AND value = ?', [f.id, v.value]);

  const row = valueUsage('lead', 'stage').find((r) => r.value === v.value);
  run('UPDATE picklist_value SET active = 1 WHERE field_id = ? AND value = ?', [f.id, v.value]);

  assert(row, 'a retired value vanished from the report entirely');
  assert.equal(row.defined, true, 'a retired value is reported as though it were never defined');
  assert.equal(row.active, false, 'a retired value is reported as active');
});

test('a field that is not a picklist cannot be counted this way', () => {
  assert.equal(valueUsage('lead', 'no_such_field_at_all'), null);
  assert.equal(valueUsage('no_such_object', 'stage'), null);
});

test('an identifier that is not a plain column name is refused', () => {
  /* The names come from our own registry, never from the request — but the
     registry is writable through the admin API, so the shape is checked. */
  assert.equal(valueUsage('lead', 'stage; DROP TABLE leads'), null);
  assert.equal(valueUsage('lead', "stage' OR '1'='1"), null);
});

/* ------------------------------------------------------- the route's guards */

test('the route refuses to empty a picklist', () => {
  const src = readSetup();
  assert(/would have nothing to choose from/.test(src),
    'a picklist can be saved with no values, which is worse than a text field');
});

test('the route refuses two defaults', () => {
  const src = readSetup();
  assert(/Only one value can be the default/.test(src),
    'two defaults can be saved, and the picker then takes whichever sorts first');
});

test('retiring a value that is in use has to be confirmed', () => {
  /* Allowed — it is often exactly what an administrator means — but never by
     accident, and never without being told how many records are affected. */
  const src = readSetup();
  assert(/retire_in_use/.test(src), 'in-use values are retired silently');
  assert(/confirm_with/.test(src), 'the refusal does not say how to proceed');
  assert(/in_use: inUse\.map/.test(src), 'the refusal does not name the values or their counts');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
