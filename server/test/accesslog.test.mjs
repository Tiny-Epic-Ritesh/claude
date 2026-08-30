/**
 * Access log.
 *
 * What is worth proving is the set of things that make it evidence rather than
 * noise:
 *
 *   • the path is the whole path, so a row identifies a record
 *   • no query strings, because those carry what somebody searched for
 *   • a read of the other business's record is findable
 *   • it does not grow forever
 */

import { strict as assert } from 'node:assert';
import { db, run, all, one } from '../src/db.js';
import {
  crossBookReads, activityOf, readersOf, accessLogSummary, sweepAccessLog,
} from '../src/engine/accesslog.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/* ------------------------------------------------------------- fixtures */

const MARK = 'accesslog-test';
const clean = () => run("DELETE FROM request_log WHERE ip = ?", [MARK]);

const bonanzaUser = one("SELECT * FROM users WHERE sales_org = 'BONANZA' AND role = 'sales_rm' ORDER BY id LIMIT 1");
const bigulUser = one("SELECT * FROM users WHERE sales_org = 'BIGUL' AND role = 'sales_rm' ORDER BY id LIMIT 1");
const bonanzaLead = one("SELECT * FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL ORDER BY id LIMIT 1");
const bonanzaTicket = one("SELECT * FROM tickets WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");

const write = (user, path, { status = 200, at = null, method = 'GET' } = {}) => run(
  `INSERT INTO request_log (user_id, role, sales_org, method, path, status, duration_ms, ip, at)
   VALUES (?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')))`,
  [user?.id ?? null, user?.role ?? null, user?.sales_org ?? null, method, path, status, 5, MARK, at],
);

clean();

/* ---------------------------------------------------------------- tests */

console.log('\nAccess log');

test('the fixtures this suite needs are present', () => {
  assert(bonanzaUser && bigulUser, 'need a user in each business — reseed first');
  assert(bonanzaLead, 'need a Bonanza lead — reseed first');
});

test('a cross-book read is found, and an in-book read is not', () => {
  clean();
  // The Bigul user reads a Bonanza lead. This is the row the August incident
  // needed and could not produce, because nothing recorded reads at the time.
  write(bigulUser, `/api/leads/${bonanzaLead.id}`);
  // …and the Bonanza user reads the same record, which is simply their job.
  write(bonanzaUser, `/api/leads/${bonanzaLead.id}`);

  const rows = crossBookReads().filter((r) => r.path === `/api/leads/${bonanzaLead.id}`);
  assert.equal(rows.length, 1, `expected exactly one cross-book row, got ${rows.length}`);
  assert.equal(Number(rows[0].user_id), bigulUser.id, 'the wrong reader was reported');
  assert.equal(rows[0].reader_org, 'BIGUL');
  assert.equal(rows[0].record_org, 'BONANZA');
});

test('a stripped path finds nothing — the log must keep the whole path', () => {
  clean();
  /* The bug this guards: the middleware is mounted on '/api', and inside a
   * mounted handler Express rewrites req.url to the remainder. Reading req.path
   * there records '/1' instead of '/api/leads/1'. Every row still lands in the
   * table, so the log looks healthy while being unable to answer anything. */
  write(bigulUser, `/${bonanzaLead.id}`);
  assert.equal(crossBookReads().length, 0,
    'a stripped path resolved to a record — the assertion below would pass on broken data');

  clean();
  write(bigulUser, `/api/leads/${bonanzaLead.id}`);
  assert.equal(crossBookReads().length, 1, 'the full path did not resolve');
});

test('cross-book detection covers tickets, not just leads', () => {
  if (!bonanzaTicket) return;               // no ticket in this seed
  clean();
  write(bigulUser, `/api/tickets/${bonanzaTicket.id}`);
  const rows = crossBookReads();
  assert.equal(rows.length, 1, 'a cross-book ticket read was not detected');
  assert.equal(rows[0].record_org, 'BONANZA');
});

test('a refused read is not reported as a leak', () => {
  clean();
  // The boundary working correctly. A 403 means they were stopped, and
  // reporting it as a cross-book read would bury the real ones in noise.
  write(bigulUser, `/api/leads/${bonanzaLead.id}`, { status: 403 });
  assert.equal(crossBookReads().length, 0, 'a refused request was reported as a read');
});

test('one person\'s activity comes back newest first', () => {
  clean();
  write(bonanzaUser, '/api/leads', { at: '2026-08-01 10:00:00' });
  write(bonanzaUser, '/api/clients', { at: '2026-08-02 10:00:00' });
  // Filtered to this suite's rows: a running server logs real traffic for the
  // same user against the same paths, so an unfiltered rows[0] is whatever
  // happened last in reality rather than what this test wrote.
  const rows = activityOf(bonanzaUser.id).filter((r) => r.ip === MARK);
  assert.equal(rows.length, 2, `expected this suite's two rows, got ${rows.length}`);
  assert.equal(rows[0].path, '/api/clients', 'not ordered newest first');
  assert.equal(rows[1].path, '/api/leads', 'the older row is not second');
});

test('a user entitled to both books is not reported as crossing', () => {
  /* Superadmin spans both businesses, and a user may carry an org_access list
   * covering both. An earlier version of crossBookReads() compared the reader's
   * home sales_org against the record's org in SQL, and so flagged every read
   * those two make — the report cried wolf about exactly the people who are
   * supposed to see both books. Entitlement is now decided by the same
   * orgsFor() the API enforces. */
  clean();
  const superadmin = one("SELECT * FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1");
  const bothBooks = one("SELECT * FROM users WHERE org_access LIKE '%BIGUL%' AND org_access LIKE '%BONANZA%' ORDER BY id LIMIT 1");
  const bigulLead = one("SELECT * FROM leads WHERE sales_org = 'BIGUL' AND deleted_at IS NULL ORDER BY id LIMIT 1");
  assert(superadmin && bigulLead, 'need a superadmin and a Bigul lead — reseed first');

  write(superadmin, `/api/leads/${bigulLead.id}`);
  if (bothBooks) write(bothBooks, `/api/leads/${bigulLead.id}`);

  const flagged = crossBookReads();
  assert.equal(flagged.length, 0,
    `an entitled reader was reported as crossing: ${JSON.stringify(flagged[0] ?? {})}`);

  // …and the genuine case still fires, so the filter has not simply muted it.
  write(bigulUser, `/api/leads/${bonanzaLead.id}`);
  assert.equal(crossBookReads().length, 1, 'a real cross-book read stopped being detected');
});

test('everyone who opened one record can be listed', () => {
  clean();
  const path = `/api/leads/${bonanzaLead.id}`;
  write(bonanzaUser, path);
  write(bigulUser, path);
  // Filtered to this suite's own rows. The running server logs real reads of
  // the same record, so an exact count over everything would fail for a reason
  // that has nothing to do with the code under test.
  const rows = readersOf(path).filter((r) => r.ip === MARK);
  assert.equal(rows.length, 2, `expected both readers, got ${rows.length}`);
  assert(rows.every((r) => r.email), 'a reader came back without an identity');
  const ids = rows.map((r) => Number(r.user_id)).sort();
  assert.deepEqual(ids, [bonanzaUser.id, bigulUser.id].sort(), 'the wrong readers came back');
});

test('the summary describes the log without exposing what is in it', () => {
  clean();
  write(bonanzaUser, '/api/leads');
  write(bigulUser, '/api/leads', { status: 403 });
  const s = accessLogSummary();
  assert(s.rows > 0, 'the summary reports an empty log');
  assert(s.retention_days > 0, 'no retention window declared');
  assert(typeof s.refused === 'number', 'refusals are not counted');
  assert(Array.isArray(s.busiest), 'no busiest-path breakdown');
});

test('rows past the retention window are pruned', () => {
  clean();
  write(bonanzaUser, '/api/leads', { at: '2020-01-01 00:00:00' });   // long expired
  write(bonanzaUser, '/api/clients');                                 // today
  const before = one("SELECT COUNT(*) n FROM request_log WHERE ip = ?", [MARK]).n;
  assert.equal(before, 2);

  sweepAccessLog(90);

  const rows = all("SELECT path FROM request_log WHERE ip = ?", [MARK]);
  assert.equal(rows.length, 1, 'the expired row was not pruned');
  assert.equal(rows[0].path, '/api/clients', 'the wrong row was pruned');
});

test('the log holds no query strings', () => {
  // Belt and braces against the whole table, not only this suite's rows: the
  // query string is where a searched PAN or mobile would end up.
  const leaked = one("SELECT COUNT(*) n FROM request_log WHERE path LIKE '%?%'").n;
  assert.equal(leaked, 0, `${leaked} rows carry a query string`);
});

clean();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
