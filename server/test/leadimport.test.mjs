/**
 * The lead import sample (P3-41).
 *
 * "A sample .csv is downloadable from the same screen and reflects the current
 * field set and expected values."
 *
 * "Reflects" is the word that matters, and it is not something a human notices
 * going stale. The sample used to be a string in the client, so the day the
 * importer gained or lost a column the sample would have gone on describing the
 * old one and the person following it would have been the last to find out.
 *
 * So the test is not that a sample exists. It is that the sample, fed back into
 * the importer unchanged, is accepted -- which is the only version of "reflects"
 * that cannot rot.
 */

import { strict as assert } from 'node:assert';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

/* Its own administrator. Several test files and the e2e run all signed in as
   admin@bonanza.test, and ten a minute is the limiter's budget for one account --
   so the eleventh attempt was refused and the failure looked like a broken
   feature. A test that needs to sign in as somebody brings its own somebody. */
const PROBE = await probeAdmin('leadimport');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nLead import');

const login = async (email, password = 'bonanza') => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  return (await res.json()).token;
};

const token = await login(PROBE.email);
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

/** The same minimal parse the screen does, so the test reads the file as a person would. */
const parse = (csv) => {
  const [head, ...body] = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const keys = head.split(',').map((k) => k.trim());
  return body.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? '').trim()]));
  });
};

const sample = async () => {
  const res = await fetch(`${BASE}/api/leads/import/sample`, { headers: H });
  assert.equal(res.status, 200, `the sample returned HTTP ${res.status}`);
  return res.text();
};

await test('the sample is a file, not a screenful of text', async () => {
  const res = await fetch(`${BASE}/api/leads/import/sample`, { headers: H });
  const disposition = res.headers.get('content-disposition') ?? '';
  assert(/attachment/.test(disposition), `not sent as a download: ${disposition}`);
  assert(/\.csv/.test(disposition), `not named as a csv: ${disposition}`);
});

await test('the sample names exactly the columns the importer describes', async () => {
  const format = await (await fetch(`${BASE}/api/leads/import/format`, { headers: H })).json();
  const header = (await sample()).replace(/^﻿/, '').split(/\r?\n/)[0];

  assert.deepEqual(
    header.split(',').map((h) => h.trim()),
    format.columns.map((c) => c.key),
    `the sample header is "${header}" and the importer describes ${format.columns.map((c) => c.key)}`,
  );
});

await test('the sample imports cleanly, unchanged', async () => {
  /* The point of the whole ticket. Somebody downloads this, types over the
     rows and imports it -- so the untouched version has to be accepted, or the
     sample is teaching a format the importer rejects. Dry run: commit is false,
     so nothing is created. */
  const rows = parse(await sample());
  assert.equal(rows.length, 3, `expected 3 sample rows, got ${rows.length}`);

  const res = await fetch(`${BASE}/api/leads/import`, {
    method: 'POST', headers: H, body: JSON.stringify({ rows, commit: false }),
  });
  assert.equal(res.status, 200, `the importer returned HTTP ${res.status}`);

  const report = await res.json();
  assert.equal(report.invalid.length, 0,
    `the importer rejected its own sample: ${JSON.stringify(report.invalid)}`);
  assert.equal(report.valid, 3, `only ${report.valid} of 3 sample rows were valid`);
  assert.equal(report.imported, 0, 'a dry run created leads');
});

await test('the sample obeys the rules the importer enforces', async () => {
  /* Cheap to state and easy to get wrong when somebody edits the example
     values: a sample carrying a nine-digit mobile would be rejected on its own
     terms the moment anybody imported it. */
  const rows = parse(await sample());
  for (const r of rows) {
    assert(r.name?.trim(), 'a sample row has no name, which the importer requires');
    assert(/^[6-9]\d{9}$/.test(r.mobile), `sample mobile "${r.mobile}" is not one the importer accepts`);
  }
});

await test('a column the importer does not know is ignored, not fatal', async () => {
  /* Somebody exports from the old system and imports the lot. Extra columns
     are normal and must not stop the run. */
  const rows = parse(await sample()).map((r) => ({ ...r, lead_score_v2: 'nonsense', notes: 'x' }));
  const res = await fetch(`${BASE}/api/leads/import`, {
    method: 'POST', headers: H, body: JSON.stringify({ rows, commit: false }),
  });

  assert.equal(res.status, 200, `unknown columns broke the import: HTTP ${res.status}`);
  assert.equal((await res.json()).valid, 3, 'unknown columns cost valid rows');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
