/**
 * Bulk update on the lead list view (P3-39).
 *
 * The dangerous one. Every other bulk action here works on rows somebody
 * ticked; this one can reach the whole result, so the two things worth proving
 * are that it touches what was asked for and nothing else.
 *
 *   the count is real       "1,501 must be rejected where only 1,500 exist",
 *                           and the 1,500 is recounted at the write rather than
 *                           taken from the request — the number on somebody's
 *                           screen is from whenever their page loaded
 *
 *   ids prove nothing       they arrive from a browser, so they are ANDed into
 *                           the scoped filter rather than trusted. A caller can
 *                           post any id; they can only ever update one the
 *                           filter would already have shown them
 */

import { strict as assert } from 'node:assert';
import { all, one, run, transact } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

const PROBE = await probeAdmin('bulkupdate');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nBulk update');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* Restored afterwards, because this suite writes to real seeded leads and the
   files that run after it read them. */
const snapshot = all("SELECT id, source, stage FROM leads WHERE deleted_at IS NULL AND sales_org = 'BONANZA'");
/**
 * Put the seeded leads back.
 *
 * One transaction, not one statement per lead. These tests share the database
 * file with a running server, and SQLite refuses a writer while a reader holds
 * the lock — so several hundred separate writes is several hundred chances to
 * lose that race, and losing it once killed the run with "database is locked".
 * The whole thing is retried, because a transaction can still start at a busy
 * moment; the difference is that it is now one attempt rather than a race per
 * row.
 */
const restore = async () => {
  for (let i = 0; i < 20; i += 1) {
    try {
      transact(() => {
        for (const l of snapshot) {
          run('UPDATE leads SET source = ?, stage = ? WHERE id = ?', [l.source, l.stage, l.id]);
        }
      });
      return;
    } catch (err) {
      if (!/locked|busy/i.test(err.message) || i === 19) throw err;
      await new Promise((r) => setTimeout(r, 120));      // eslint-disable-line no-await-in-loop
    }
  }
};

const filtered = async (q = 'stage=New') => (await call('GET', `/leads?${q}&limit=500`)).body;

/* ------------------------------------------------------------ the options */

await test('the fields on offer are the ones the write accepts', async () => {
  /* A dialog offering a field the write refuses teaches people that the error
     message is noise. */
  const opts = (await call('GET', '/leads/bulk/options')).body;
  assert(opts.fields.length, 'no fields offered');

  const bad = await call('POST', '/leads/bulk/field?stage=New', {
    field: 'mobile', value: '9999999999', mode: 'all',
  });
  assert.equal(bad.status, 400, 'mobile can be set in bulk — that destroys the matching key');
  assert(!opts.fields.some((f) => f.key === 'mobile'), 'mobile is offered in the dialog');
});

await test('a field with fixed values will not take another one', async () => {
  const bad = await call('POST', '/leads/bulk/field?stage=New', {
    field: 'stage', value: 'Nonsense', mode: 'all',
  });
  assert.equal(bad.status, 400, 'an invalid stage was accepted');
});

/* -------------------------------------------------------------- the count */

await test('a number larger than the result is refused, and says the real one', async () => {
  const rows = await filtered();
  const over = await call('POST', '/leads/bulk/field?stage=New', {
    field: 'source', value: 'Probe', mode: 'first', limit: rows.length + 1,
  });

  assert.equal(over.status, 400, `${rows.length + 1} was accepted against ${rows.length} leads`);
  assert.equal(over.body.available, rows.length, 'the refusal does not carry the real count');
  assert(String(over.body.error).includes(String(rows.length)),
    `the message does not name the real number: ${over.body.error}`);
});

await test('an empty or zero count is refused rather than treated as all', async () => {
  for (const limit of [undefined, 0, -5, 'abc']) {
    const r = await call('POST', '/leads/bulk/field?stage=New', {
      field: 'source', value: 'Probe', mode: 'first', limit,
    });
    assert.equal(r.status, 400, `limit ${JSON.stringify(limit)} was accepted`);
  }
});

/* --------------------------------------------------------- the three scopes */

await test('the first N updates exactly N', async () => {
  try {
    const rows = await filtered();
    const n = Math.min(3, rows.length);

    const r = await call('POST', '/leads/bulk/field?stage=New', {
      field: 'source', value: 'Probe first', mode: 'first', limit: n,
    });
    assert.equal(r.status, 200, `refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.matched, n, `matched ${r.body.matched}, asked for ${n}`);

    const set = one("SELECT COUNT(*) n FROM leads WHERE source = 'Probe first'").n;
    assert.equal(set, n, `${set} leads were changed, not ${n}`);
  } finally { await restore(); }
});

await test('all updates everything the filter matches, and nothing outside it', async () => {
  try {
    const rows = await filtered();
    const r = await call('POST', '/leads/bulk/field?stage=New', {
      field: 'source', value: 'Probe all', mode: 'all',
    });
    assert.equal(r.body.matched, rows.length, `matched ${r.body.matched} of ${rows.length}`);

    /* The filter was stage=New, so nothing in another stage may have moved. */
    const strays = one(
      "SELECT COUNT(*) n FROM leads WHERE source = 'Probe all' AND stage != 'New'",
    ).n;
    assert.equal(strays, 0, `${strays} leads outside the filter were updated`);
  } finally { await restore(); }
});

await test('an id outside the filter cannot be reached by sending it', async () => {
  /* Ids come from a browser and prove nothing. They are ANDed into the scoped
     filter, so posting one from another stage updates nothing. */
  const outside = one("SELECT id, source FROM leads WHERE stage = 'Won' AND deleted_at IS NULL LIMIT 1");
  if (!outside) return;

  try {
    const r = await call('POST', '/leads/bulk/field?stage=New', {
      field: 'source', value: 'Should not happen', mode: 'ids', ids: [outside.id],
    });
    assert.equal(r.body.matched, 0, 'a lead outside the filter was matched');
    assert.equal(one('SELECT source FROM leads WHERE id = ?', [outside.id]).source, outside.source,
      'a lead outside the filter was changed');
  } finally { await restore(); }
});

await test('a lead in another book cannot be reached either', async () => {
  const bigul = one("SELECT id, source FROM leads WHERE sales_org = 'BIGUL' AND deleted_at IS NULL LIMIT 1");
  if (!bigul) return;

  try {
    const r = await call('POST', '/leads/bulk/field', {
      field: 'source', value: 'Crossed the book', mode: 'ids', ids: [bigul.id],
    });
    assert.equal(r.body.matched, 0, 'a Bonanza administrator reached a Bigul lead');
    assert.equal(one('SELECT source FROM leads WHERE id = ?', [bigul.id]).source, bigul.source,
      'a Bigul lead was changed by a Bonanza administrator');
  } finally { await restore(); }
});

/* ------------------------------------------------------------- the record */

await test('a lead already holding the value is left alone', async () => {
  /* Writing it anyway would put a change on its history and move its
     last-modified for a change that did not happen. */
  try {
    await call('POST', '/leads/bulk/field?stage=New', { field: 'source', value: 'Same', mode: 'all' });
    const again = await call('POST', '/leads/bulk/field?stage=New', { field: 'source', value: 'Same', mode: 'all' });

    assert.equal(again.body.changed, 0, `${again.body.changed} leads were rewritten with the value they had`);
    assert(again.body.unchanged > 0, 'nothing was reported as already set');
  } finally { await restore(); }
});

await test('every changed lead is recorded individually', async () => {
  /* One audit row per lead, not one for the batch. "Who changed this lead's
     stage" has to be answerable from the lead, and a single row naming a
     filter is not an answer. */
  try {
    const before = one("SELECT COUNT(*) n FROM audit_log WHERE action = 'lead.bulk.field'").n;
    const r = await call('POST', '/leads/bulk/field?stage=New', {
      field: 'source', value: 'Probe audit', mode: 'first', limit: 2,
    });
    const after = one("SELECT COUNT(*) n FROM audit_log WHERE action = 'lead.bulk.field'").n;

    assert.equal(after - before, r.body.changed, `${r.body.changed} leads changed but ${after - before} rows were written`);
  } finally { await restore(); }
});

await restore();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
