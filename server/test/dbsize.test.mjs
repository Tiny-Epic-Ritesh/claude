/**
 * Database size reporting (P2-19).
 *
 * The thing worth guarding here is honesty rather than arithmetic. The total
 * and the per-object bytes are measured; the per-business split is
 * apportioned, and a number that looks precise and is not will eventually end
 * up in a capacity plan or a licensing conversation.
 */

import { strict as assert } from 'node:assert';
import { all, one } from '../src/db.js';
import {
  totalBytes, perTable, breakdown, nonObjectBytes, growth, history,
} from '../src/engine/dbsize.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nDatabase size');

test('the total is measured, not guessed', () => {
  const t = totalBytes();
  assert(t.total > 0, 'the database reports no size at all');
  assert.equal(t.total, t.pages * t.page_size, 'the total does not match pages x page size');
  assert(t.reclaimable <= t.total, 'more space is reclaimable than exists');
});

test('every object reports a real table and a real size', () => {
  for (const o of breakdown(['BONANZA', 'BIGUL'])) {
    assert(one(`SELECT COUNT(*) n FROM ${o.table}`), `${o.object} points at a table that cannot be read`);
    assert(o.bytes >= 0, `${o.object} reports negative bytes`);
    assert.equal(o.bytes_are_estimated, false, 'per-object bytes should be measured, not estimated');
  }
});

test('a per-business split is always labelled as an estimate', () => {
  /* The honesty rule. Anything carrying a split must also carry the flag that
     says the split is apportioned — otherwise the screen can show a precise
     looking number with nothing marking it. */
  for (const o of breakdown(['BONANZA', 'BIGUL'])) {
    if (o.estimated_bytes_by_org) {
      assert.equal(o.split_is_estimated, true,
        `${o.object} reports a per-business split without marking it estimated`);
    }
  }
});

test('a table with no book does not invent one', () => {
  // Interactions hang off a lead. Splitting them would be making a number up.
  const interactions = breakdown([]).find((o) => o.object === 'interaction');
  assert(interactions, 'interactions are missing from the breakdown');
  assert.equal(interactions.estimated_bytes_by_org, null,
    'a table with no sales_org column was given a per-business split');
});

test('the split adds up to the table it came from', () => {
  for (const o of breakdown(['BONANZA', 'BIGUL'])) {
    if (!o.estimated_bytes_by_org) continue;
    const summed = Object.values(o.estimated_bytes_by_org).reduce((a, b) => a + b, 0);
    // Rounding per book, so allow a byte per book of drift.
    assert(Math.abs(summed - o.bytes) <= Object.keys(o.estimated_bytes_by_org).length + 1,
      `${o.object}: split sums to ${summed} but the table is ${o.bytes}`);
  }
});

test('objects and everything else do not double-count', () => {
  /* The first question anybody asks about a size report is why the numbers do
     not add up. They should add up to the total, less SQLite's own overhead. */
  const objectTables = new Set(all('SELECT table_name FROM entity_def').map((e) => e.table_name));
  for (const row of nonObjectBytes()) {
    assert(!objectTables.has(row.table),
      `${row.table} is counted both as an object and as "everything else"`);
  }
});

test('an index is folded into the table it serves', () => {
  // An index is not something an administrator can reason about separately, and
  // reporting it apart makes the biggest table look smaller than it is.
  const names = new Set(perTable().keys());
  for (const idx of all("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")) {
    assert(!names.has(idx.name), `${idx.name} is reported as if it were a table`);
  }
});

test('growth is null rather than zero when there is no history', () => {
  /* "0 MB/day" on a database sampled once is a lie, and a projection built on
     it is a worse one. */
  const g = growth();
  if (history(90).length < 2) {
    assert.equal(g.per_day, null, 'a growth rate was reported from a single sample');
    assert(g.note, 'nothing explains why there is no rate');
  } else {
    assert.equal(typeof g.per_day, 'number');
  }
});

test('config_audit is covered by a retention policy', () => {
  /* It had none, and the size screen is how that was found: 2,876 rows in ten
     days and 41% of the whole database. A log with no ceiling eventually costs
     more than the data it describes. */
  const covered = one("SELECT kind FROM log_retention WHERE kind = 'config_detail'");
  assert(covered, 'config_audit has no retention period');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
