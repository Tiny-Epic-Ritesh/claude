/**
 * A database can be built from nothing.
 *
 * This had quietly stopped being true. `node src/seed.js` against an empty data
 * directory died on
 *
 *     Error: no such table: dispositions
 *
 * and then, once that was fixed, on a foreign key from field_def to an empty
 * entity_def. So the project could only be carried forward from a database
 * somebody already had — nobody could stand up a new environment, which is the
 * kind of thing discovered on the day it is needed and not before.
 *
 * It was never tested because it could not be: the database path was hardcoded,
 * so the only way to try was to move the development database aside and hope
 * nothing had it open. `CRM_DATA_DIR` exists for this test.
 *
 * Deliberately slow. It runs the real seed in a real subprocess against a real
 * empty directory, because every cheaper version of this check is a version
 * that passes while the thing it stands for is broken.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { transact, db } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..');

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nBootstrap');

/* ------------------------------------------------------- from nothing */

const dir = mkdtempSync(join(tmpdir(), 'crm-bootstrap-'));

try {
  test('the seed builds a working database in an empty directory', () => {
    try {
      execFileSync(process.execPath, ['src/seed.js', '--quiet'], {
        cwd: SERVER,
        env: { ...process.env, CRM_DATA_DIR: dir },
        stdio: 'pipe',
        timeout: 180_000,
      });
    } catch (err) {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.split('\n').slice(-12).join('\n         ');
      throw new Error(`seeding an empty directory failed:\n         ${out}`);
    }

    const fresh = new DatabaseSync(join(dir, 'bonanza.db'));
    try {
      const count = (t) => fresh.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

      assert(count('users') > 0, 'no users');
      assert(count('leads') > 0, 'no leads');
      assert(count('entity_def') > 0,
        'entity_def is empty — field_def references it, and only src/index.js used to fill it');

      /* The six that started this: declared in COLUMNS and on tables created
         after the migration loop, so on a fresh database they only exist if
         their own CREATE TABLE declares them. */
      for (const [table, column] of [
        ['dispositions', 'edited_at'], ['dispositions', 'edited_by'], ['dispositions', 'is_custom'],
        ['entity_def', 'owd_internal'], ['entity_def', 'owd_external'],
        ['teams', 'parent_id'],
      ]) {
        const has = fresh.prepare('SELECT COUNT(*) n FROM pragma_table_info(?) WHERE name = ?').get(table, column).n;
        assert(has, `${table}.${column} is missing from a freshly built schema`);
      }
    } finally {
      fresh.close();
    }
  });

  test('seeding it a second time works too', () => {
    /* The seed clears and refills. Running it twice is what every `npm test`
       after the first one does. */
    execFileSync(process.execPath, ['src/seed.js', '--quiet'], {
      cwd: SERVER,
      env: { ...process.env, CRM_DATA_DIR: dir },
      stdio: 'pipe',
      timeout: 180_000,
    });
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------------------------------- reentrancy */

test('a transaction inside a transaction joins it rather than failing', () => {
  /* SQLite has no nested transactions, so this used to raise "cannot start a
     transaction within a transaction" from inside whichever helper called it.
     The seed is where it bit: it holds BEGIN IMMEDIATE for its whole run so two
     seeds cannot interleave, and then calls helpers that each wanted a
     transaction of their own — seedMetadata, syncDispositionPicklists. The
     failures came out as foreign-key and unique-constraint errors on users,
     which point nowhere near here. */
  db.exec('BEGIN');
  try {
    assert.equal(transact(() => 'joined'), 'joined', 'a nested transact did not run its function');
    assert.equal(db.isTransaction, true, 'a nested transact committed the transaction it was inside');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('a transaction with nothing open still commits and still rolls back', () => {
  assert.equal(transact(() => 'ran'), 'ran');
  assert.equal(db.isTransaction, false, 'transact left a transaction open');

  assert.throws(() => transact(() => { throw new Error('nope'); }), /nope/);
  assert.equal(db.isTransaction, false, 'a failed transact left a transaction open');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
