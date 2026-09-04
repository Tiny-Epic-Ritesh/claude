/**
 * "If any change happens on the lead then last modified date field gets updated
 * everytime" -- Ritesh, 4 September.
 *
 * The column was already there and already wrong. It was maintained by hand,
 * which means it was maintained sometimes: eleven of thirty-two lead writes set
 * it, four of eighteen on tickets. Everything the eleven missed was a real
 * change -- reassignment, automation writing a field by name, partner
 * attribution, KYC progress arriving from the vendor, opt-out, soft delete.
 *
 * So a report ordered by "recently touched" was ordered by "recently touched in
 * one of the eleven ways somebody remembered", and nobody could see which.
 *
 * These tests are about the guarantee rather than the eleven call sites: any
 * statement that changes a row and says nothing about updated_at must move it,
 * including statements written after this file.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nLast modified');

const STALE = '2020-01-01 00:00:00';
const TABLES = ['leads', 'clients', 'tickets', 'users'];

/* --------------------------------------------------------- the guarantee */

test('every table with an updated_at has a trigger to maintain it', () => {
  /* The point of doing this in the database was that it covers writes nobody
     has written yet. That only holds while every such table is covered, so a
     new one with a hand-maintained column fails here rather than quietly
     going stale for a year. */
  const triggers = new Set(
    all("SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name),
  );
  for (const table of TABLES) {
    const cols = all(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name);
    assert(cols.includes('updated_at'), `${table} has no updated_at column`);
    assert(triggers.has(`${table}_touch_updated_at`),
      `${table} carries an updated_at that nothing maintains`);
  }
});

for (const table of TABLES) {
  test(`a change to a ${table.replace(/s$/, '')} moves its last-modified`, () => {
    const row = one(`SELECT id FROM ${table} LIMIT 1`);
    assert(row, `no ${table} seeded`);

    run(`UPDATE ${table} SET updated_at = ? WHERE id = ?`, [STALE, row.id]);
    assert.equal(one(`SELECT updated_at FROM ${table} WHERE id = ?`, [row.id]).updated_at, STALE);

    /* A no-op in business terms -- the value does not change -- but it is still
       an UPDATE, and the rule Ritesh gave has no exception for that. */
    run(`UPDATE ${table} SET id = id WHERE id = ?`, [row.id]);

    const after = one(`SELECT updated_at FROM ${table} WHERE id = ?`, [row.id]).updated_at;
    assert.notEqual(after, STALE, `a write to ${table} left last-modified where it was`);
  });
}

/* ------------------------------------------------------ the real paths */

test('reassigning a lead counts as modifying it', () => {
  /* The one that mattered most and was missed. assignment.js writes exactly
     this statement, and it never touched updated_at -- so a lead moving between
     RMs, which is the change a supervisor is most likely to be looking for,
     left no trace on the field they would look at. */
  const lead = one('SELECT id, owner_id FROM leads WHERE deleted_at IS NULL LIMIT 1');
  run('UPDATE leads SET updated_at = ? WHERE id = ?', [STALE, lead.id]);

  run(
    "UPDATE leads SET owner_id = ?, owner_queue_id = NULL, assigned_at = datetime('now') WHERE id = ?",
    [lead.owner_id, lead.id],
  );

  assert.notEqual(one('SELECT updated_at FROM leads WHERE id = ?', [lead.id]).updated_at, STALE,
    'a reassignment did not count as a modification');
});

test('a soft delete counts as modifying it', () => {
  const lead = one('SELECT id FROM leads WHERE deleted_at IS NULL LIMIT 1');
  run('UPDATE leads SET updated_at = ? WHERE id = ?', [STALE, lead.id]);
  run("UPDATE leads SET deleted_at = datetime('now') WHERE id = ?", [lead.id]);
  const after = one('SELECT updated_at FROM leads WHERE id = ?', [lead.id]).updated_at;
  run('UPDATE leads SET deleted_at = NULL WHERE id = ?', [lead.id]);   // put it back

  assert.notEqual(after, STALE, 'deleting a lead did not count as modifying it');
});

/* ------------------------------------------------ deliberate writes win */

test('a statement that sets last-modified itself is left alone', () => {
  /* Eleven call sites already set this, some to a value that is not "now" --
     an import stamping the source system's timestamp, for instance. The trigger
     fills a gap; it does not overrule somebody who said what they meant. */
  const lead = one('SELECT id FROM leads WHERE deleted_at IS NULL LIMIT 1');
  const chosen = '2021-06-06 06:06:06';

  run('UPDATE leads SET stage = stage, updated_at = ? WHERE id = ?', [chosen, lead.id]);

  assert.equal(one('SELECT updated_at FROM leads WHERE id = ?', [lead.id]).updated_at, chosen,
    'the trigger overwrote a timestamp the statement set deliberately');
});

/* ------------------------------------------------------------- the user */

test('a user who has never been edited reads as modified when created', () => {
  /* Null would be honest about "never edited" and unreadable in an export,
     where it looks the same as "we do not know". */
  const stragglers = all('SELECT id FROM users WHERE updated_at IS NULL');
  assert.equal(stragglers.length, 0,
    `${stragglers.length} users carry no last-modified at all`);
});

test('editing a user moves it', () => {
  const user = one('SELECT id, name FROM users LIMIT 1');
  run('UPDATE users SET updated_at = ? WHERE id = ?', [STALE, user.id]);
  run('UPDATE users SET name = ? WHERE id = ?', [user.name, user.id]);

  assert.notEqual(one('SELECT updated_at FROM users WHERE id = ?', [user.id]).updated_at, STALE,
    'editing a user did not move its last-modified');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
