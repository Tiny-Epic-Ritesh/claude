/**
 * The guided lead import (P3-33) and its record (P3-34).
 *
 * The mapping is the reason this exists. A file exported from the system being
 * replaced says "Mobile No" and "City/Town" and carries thirty columns when we
 * want nine, so an importer that assumes the headers are already our field
 * names only works on files somebody prepared by hand — which is the version
 * nobody uses twice.
 *
 * Two promises are load-bearing and both are tested directly:
 *
 *   the preview does not lie   step 4 shows the server's own dry run, through
 *                              the same code the real import uses. A preview
 *                              kinder than the import is worse than none,
 *                              because it is believed
 *   the result survives        P3-34: "retrievable after the fact, not only
 *                              immediately on completion" — the person who
 *                              needs it is the one who saw "112 failed" and
 *                              came back on Monday to ask which
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

/* Its own administrator. Several test files and the e2e run all signed in as
   admin@bonanza.test, and ten a minute is the limiter's budget for one account --
   so the eleventh attempt was refused and the failure looked like a broken
   feature. A test that needs to sign in as somebody brings its own somebody. */
const PROBE = await probeAdmin('importwizard');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nGuided lead import');

let adminToken = null;
const admin = async () => {
  if (adminToken) return adminToken;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: PROBE.email, password: 'bonanza' }),
  });
  if (!res.ok) throw new Error(`could not sign in: HTTP ${res.status}`);
  adminToken = (await res.json()).token;
  return adminToken;
};

const post = async (path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await admin()}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const get = async (path) => {
  const res = await fetch(`${BASE}/api${path}`, { headers: { Authorization: `Bearer ${await admin()}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* A file with the old system's headers, which is the case the mapping exists
   for, and one deliberate problem of each kind. */
const HEADER = ['Full Name', 'Mobile No', 'City/Town', 'Lead Owner'];
const MAPPING = { 'Full Name': 'name', 'Mobile No': 'mobile', 'City/Town': 'city' };
const ROWS = [
  ['Import Probe One', '9811100001', 'Nashik', 'ignored'],
  ['Import Probe Two', '9811100002', 'Nagpur', 'ignored'],
  ['', '9811100003', 'Akola', 'ignored'],                 // no name
  ['Import Probe Bad', '123', 'Pune', 'ignored'],         // bad mobile
];

const MOBILES = ['9811100001', '9811100002', '9811100003'];
const clean = () => {
  run(`DELETE FROM leads WHERE mobile IN (${MOBILES.map(() => '?').join(',')})`, MOBILES);
  run("DELETE FROM lead_lists WHERE name LIKE 'Import probe%'");
};
clean();

/* ------------------------------------------------------------ the mapping */

await test('a column the mapping does not name is ignored, not guessed at', async () => {
  /* "Lead Owner" is mapped to nothing. Matching it to something by similarity
     is how a column of names ends up in `source`. */
  const r = await post('/leads/import/preview', { header: HEADER, rows: ROWS, mapping: MAPPING, mode: 'create' });
  assert.equal(r.status, 200, `preview refused: ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body.unmapped, ['Lead Owner'], `unmapped was ${JSON.stringify(r.body.unmapped)}`);
});

await test('a file with no name column is refused, with the reason', async () => {
  const r = await post('/leads/import/preview', {
    header: HEADER, rows: ROWS, mapping: { 'Mobile No': 'mobile' }, mode: 'create',
  });
  assert.equal(r.status, 400, `a nameless import was accepted: HTTP ${r.status}`);
  assert(/name/i.test(r.body.error), `the refusal does not mention the name: ${r.body.error}`);
});

await test('two columns cannot be mapped onto one field', async () => {
  /* Silent otherwise: one of them wins and which depends on column order. */
  const r = await post('/leads/import/preview', {
    header: HEADER, rows: ROWS,
    mapping: { 'Full Name': 'name', 'Lead Owner': 'name' },
    mode: 'create',
  });
  assert.equal(r.status, 400, 'two columns were allowed onto one field');
});

/* ------------------------------------------------------------ the preview */

await test('the preview names the rows that will not import, and why', async () => {
  const r = await post('/leads/import/preview', { header: HEADER, rows: ROWS, mapping: MAPPING, mode: 'create' });

  assert.equal(r.body.created, 2, `expected 2 creatable, got ${r.body.created}`);
  assert.equal(r.body.failed, 2, `expected 2 failures, got ${r.body.failed}`);

  const byRow = new Map(r.body.failures.map((f) => [f.row, f.reason]));
  assert(/name/i.test(byRow.get(3) ?? ''), `row 3 should fail for its name: ${byRow.get(3)}`);
  assert(/mobile/i.test(byRow.get(4) ?? ''), `row 4 should fail for its mobile: ${byRow.get(4)}`);
});

await test('the preview writes nothing', async () => {
  /* The whole basis for showing it. */
  await post('/leads/import/preview', { header: HEADER, rows: ROWS, mapping: MAPPING, mode: 'create' });
  const found = all(`SELECT id FROM leads WHERE mobile IN (${MOBILES.map(() => '?').join(',')})`, MOBILES);
  assert.equal(found.length, 0, `the preview created ${found.length} leads`);
});

/* --------------------------------------------------------------- the run */

let runId = null;

await test('the import does what the preview said it would', async () => {
  /* Compared against the preview rather than against numbers written here: the
     promise is that the two agree, and asserting each separately would let them
     drift apart while both tests passed. */
  const preview = await post('/leads/import/preview', { header: HEADER, rows: ROWS, mapping: MAPPING, mode: 'create' });
  const done = await post('/leads/import/run', {
    header: HEADER, rows: ROWS, mapping: MAPPING, mode: 'create',
    filename: 'probe.csv', list_name: 'Import probe list',
  });

  assert.equal(done.status, 201, `import failed: ${JSON.stringify(done.body)}`);
  for (const k of ['created', 'updated', 'skipped', 'failed']) {
    assert.equal(done.body[k], preview.body[k], `${k}: preview said ${preview.body[k]}, import did ${done.body[k]}`);
  }

  runId = done.body.run_id;
  assert(runId, 'the import returned no run id');
  assert(done.body.list_id, 'the named list was not created');

  const made = all("SELECT name, city FROM leads WHERE mobile IN ('9811100001','9811100002')");
  assert.equal(made.length, 2, `expected 2 leads, found ${made.length}`);
  assert.equal(made.find((l) => l.name === 'Import Probe One')?.city, 'Nashik', 'the mapped city did not land');
});

await test('create mode leaves an existing lead alone', async () => {
  const before = one("SELECT city FROM leads WHERE mobile = '9811100001'").city;
  const r = await post('/leads/import/run', {
    header: HEADER, rows: [['Changed Name', '9811100001', 'Somewhere Else', 'x']],
    mapping: MAPPING, mode: 'create',
  });

  assert.equal(r.body.skipped, 1, `expected the row to be skipped, got ${JSON.stringify(r.body)}`);
  assert.equal(one("SELECT city FROM leads WHERE mobile = '9811100001'").city, before,
    'create mode changed an existing lead');
});

await test('update mode changes the match and creates nothing', async () => {
  const r = await post('/leads/import/run', {
    header: HEADER, rows: [['Import Probe One', '9811100001', 'Satara', 'x']],
    mapping: MAPPING, mode: 'update',
  });

  assert.equal(r.body.updated, 1, `expected 1 updated, got ${JSON.stringify(r.body)}`);
  assert.equal(r.body.created, 0, 'update mode created a lead');
  assert.equal(one("SELECT city FROM leads WHERE mobile = '9811100001'").city, 'Satara',
    'the update did not land');
});

await test('a lead is matched within the book, never across it', async () => {
  /* A Bigul file carrying a mobile that exists in Bonanza must not update that
     lead. As far as this business is concerned it is a different person, and
     merging them is the one mistake that cannot be unpicked afterwards. */
  const bonanza = one("SELECT mobile FROM leads WHERE sales_org = 'BONANZA' AND mobile IS NOT NULL AND deleted_at IS NULL LIMIT 1");
  assert(bonanza, 'no Bonanza lead with a mobile, so this proves nothing');

  const r = await post('/leads/import/preview', {
    header: HEADER, rows: [['Someone Else', bonanza.mobile, 'Mumbai', 'x']],
    mapping: MAPPING, mode: 'update', sales_org: 'BIGUL',
  });

  if (r.status === 403) return;          // this admin cannot reach Bigul at all
  assert.equal(r.body.updated, 0, 'a Bigul import matched a Bonanza lead');
});

/* ------------------------------------------------------- the record (P3-34) */

await test('the result can be read again afterwards', async () => {
  assert(runId, 'no run to read');
  const r = await get(`/leads/import/runs/${runId}`);

  assert.equal(r.status, 200, `the run could not be read: HTTP ${r.status}`);
  assert.equal(r.body.filename, 'probe.csv');
  assert.equal(r.body.total, 4);
  assert.equal(r.body.created, 2);
  assert.equal(r.body.failed, 2);
  assert.equal(r.body.list_name, 'Import probe list', 'the run does not remember its list');
});

await test('the failed rows are still identifiable, with their reasons', async () => {
  const r = await get(`/leads/import/runs/${runId}`);
  const byRow = new Map(r.body.failures.map((f) => [f.row_no, f.reason]));

  assert.equal(r.body.failures.length, 2, `kept ${r.body.failures.length} failures`);
  assert(/name/i.test(byRow.get(3) ?? ''), 'row 3 lost its reason');
  assert(/mobile/i.test(byRow.get(4) ?? ''), 'row 4 lost its reason');
});

await test('the run appears in the list of earlier imports', async () => {
  const r = await get('/leads/import/runs');
  assert(r.body.runs.some((x) => x.id === runId), 'the run is not listed');
});

await test('an import from another book cannot be read', async () => {
  /* A run names a business and quotes the rows it failed on, which is client
     data arriving by a different route. */
  run("UPDATE import_run SET sales_org = 'BIGUL' WHERE id = ?", [runId]);
  try {
    const r = await get(`/leads/import/runs/${runId}`);
    assert.equal(r.status, 404, `a Bonanza admin read a Bigul import: HTTP ${r.status}`);
  } finally {
    run("UPDATE import_run SET sales_org = 'BONANZA' WHERE id = ?", [runId]);
  }
});

clean();
run('DELETE FROM import_failure WHERE run_id IN (SELECT id FROM import_run WHERE filename = ?)', ['probe.csv']);
run('DELETE FROM import_run WHERE filename = ?', ['probe.csv']);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
