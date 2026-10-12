/**
 * Cleaning up a picklist: add a stray value back, or merge it away.
 *
 * WHY THIS FILE EXISTS
 *
 * The values editor has listed "on records but not on the list" since P2-21 and
 * could do nothing about them. Those orphans are what retiring a value in use
 * leaves behind, and what imports and integrations wrote before OPS-14 checked
 * those writers — on the legacy data they are most of the Source column. A
 * screen that names the problem and offers neither way out is half a screen,
 * and the remainder of OPS-14 is the other half.
 *
 * WHAT IT CHECKS
 *
 * Both ways out. Adding a value back, including the retired-value case where it
 * is the same row reactivated rather than a second one. Merging, which moves
 * the records AND retires the value that was merged away, because leaving it
 * offered after its records have gone is how a list grows duplicates. Then the
 * refusals, and the one that matters most: a merge stays inside the
 * administrator's own books, so a Bigul administrator tidying their Source list
 * cannot rewrite Bonanza's records.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nPicklist cleanup');

const SUPER = await probeAdmin('picklistcleanup', { role: 'superadmin' });

const call = async (method, path, body, headers = SUPER.headers) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const NAME = 'Picklist cleanup probe';
const STRAY = 'Walkin (probe)';          /* on records, never on the list */
const RETIRED = 'Retired source (probe)'; /* on the list, then taken off it */
const KEEP = 'Walk-in branch (probe)';    /* the value things are merged into */

const SOURCE = one("SELECT id FROM field_def WHERE entity = 'lead' AND api_name = 'source'").id;

const sourceValues = () => all(
  'SELECT value, label, active, sort_order, sales_org FROM picklist_value WHERE field_id = ? ORDER BY sort_order',
  [SOURCE],
);
const valueRow = (v) => sourceValues().find((r) => r.value === v);

const clear = () => {
  run('DELETE FROM leads WHERE name LIKE ?', [`${NAME}%`]);
  run('DELETE FROM picklist_value WHERE field_id = ? AND value IN (?,?,?)', [SOURCE, STRAY, RETIRED, KEEP]);
};
clear();

const STAMP = String(Date.now()).slice(-5);
let serial = 0;
const lead = (source, org = 'BONANZA') => {
  serial += 1;
  return Number(run(
    "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,?,'New',?,?)",
    [`${NAME} ${serial}`, `9${STAMP}${String(serial).padStart(4, '0')}`, source, org, SUPER.id],
  ).lastInsertRowid);
};
const sourceOf = (id) => one('SELECT source FROM leads WHERE id = ?', [id]).source;

/* KEEP is on the list; RETIRED was and is not; STRAY never was. */
run(
  `INSERT INTO picklist_value (field_id, value, label, sort_order, active) VALUES (?,?,?,960,1)
   ON CONFLICT(field_id, value) DO UPDATE SET active = 1`,
  [SOURCE, KEEP, KEEP],
);
run(
  `INSERT INTO picklist_value (field_id, value, label, sort_order, active) VALUES (?,?,?,961,0)
   ON CONFLICT(field_id, value) DO UPDATE SET active = 0`,
  [SOURCE, RETIRED, RETIRED],
);

try {
  /* ------------------------------------------------- the screen sees them */

  await test('a value on records but not on the list is reported as one', async () => {
    const id = lead(STRAY);
    const { body } = await call('GET', '/setup/objects/lead/fields/source/value-usage');
    const row = body.values.find((v) => v.value === STRAY);
    assert(row, 'the stray value is missing from the usage report');
    assert.equal(row.defined, false, 'a value that was never on the list is reported as defined');
    assert.equal(row.records, 1);
    assert.equal(sourceOf(id), STRAY);
  });

  /* ------------------------------------------------- adding one back */

  await test('a stray value can be added to the list, at the end', async () => {
    const before = sourceValues().filter((v) => v.active).length;
    const r = await call('POST', '/setup/objects/lead/fields/source/values/add', { value: STRAY });

    assert.equal(r.status, 201, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.restored, false, 'a value that was never on the list was reported as restored');

    const row = valueRow(STRAY);
    assert.equal(row.active, 1, 'the value was not activated');
    assert.equal(sourceValues().filter((v) => v.active).length, before + 1);

    /* At the end, not in the middle: on Stage the order is the pipeline, and
       inserting into it would silently reorder somebody's board. */
    const live = sourceValues().filter((v) => v.active);
    assert.equal(live[live.length - 1].value, STRAY, 'the value was not added at the end');

    /* And the picker now offers it, which is the point. */
    const { body } = await call('GET', '/leads/bulk/options?org=BONANZA');
    const offered = body.fields.find((f) => f.key === 'source').values;
    assert(offered.includes(STRAY), 'the value was added and the dialog still does not offer it');
  });

  await test('a retired value is restored, not added a second time', async () => {
    const r = await call('POST', '/setup/objects/lead/fields/source/values/add', { value: RETIRED });
    assert.equal(r.status, 201, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.restored, true, 'restoring a retired value was reported as adding a new one');

    const rows = sourceValues().filter((v) => v.value === RETIRED);
    assert.equal(rows.length, 1, `the value exists ${rows.length} times`);
    assert.equal(rows[0].active, 1);
  });

  await test('adding one that is already there is refused, not duplicated', async () => {
    const r = await call('POST', '/setup/objects/lead/fields/source/values/add', { value: KEEP });
    assert.equal(r.status, 409, `HTTP ${r.status}`);
    assert.equal(sourceValues().filter((v) => v.value === KEEP).length, 1);
  });

  await test('a value needs a name, and a business only where one is honoured', async () => {
    const blank = await call('POST', '/setup/objects/lead/fields/source/values/add', { value: '   ' });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.field, 'value');

    const perBook = await call('POST', '/setup/objects/lead/fields/source/values/add',
      { value: 'Bigul only (probe)', sales_org: 'BIGUL' });
    assert.equal(perBook.status, 201, `HTTP ${perBook.status}: ${JSON.stringify(perBook.body)}`);
    assert.equal(valueRow('Bigul only (probe)').sales_org, 'BIGUL');
    run('DELETE FROM picklist_value WHERE field_id = ? AND value = ?', [SOURCE, 'Bigul only (probe)']);

    /* Task priority keeps one list for both books, so a business is refused
       there — the same rule the whole-list save applies. */
    const wrong = await call('POST', '/setup/objects/task/fields/priority/values/add',
      { value: 'Probe priority', sales_org: 'BONANZA' });
    assert.equal(wrong.status, 400, `HTTP ${wrong.status}`);
    assert(/one list for both businesses/i.test(wrong.body?.error ?? ''), `the reason reads: ${wrong.body?.error}`);
  });

  /* ------------------------------------------------- merging one away */

  await test('a merge moves the records and retires what it merged away', async () => {
    const ids = [lead(STRAY), lead(STRAY), lead(KEEP)];

    /* Counted rather than assumed: an earlier test in this file left a lead on
       the stray value, and hardcoding "2" asserted my bookkeeping instead of
       the merge. Every record holding it should move, whatever put them there. */
    const holding = one('SELECT COUNT(*) n FROM leads WHERE source = ? AND deleted_at IS NULL', [STRAY]).n;
    assert(holding >= 2, `only ${holding} records hold the stray value, so this proves little`);

    const r = await call('POST', '/setup/objects/lead/fields/source/values/merge', { from: STRAY, to: KEEP });
    assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.moved, holding, `${r.body.moved} of ${holding} records moved`);
    assert.equal(one('SELECT COUNT(*) n FROM leads WHERE source = ? AND deleted_at IS NULL', [STRAY]).n, 0,
      'records were left holding the value that was merged away');

    assert.deepEqual(ids.map(sourceOf), [KEEP, KEEP, KEEP]);
    /* Retired, because two values became one. Leaving it offered after its
       records have gone is how the list grew the duplicate. */
    assert.equal(valueRow(STRAY).active, 0, 'the merged-away value is still on the list');

    const { body } = await call('GET', '/leads/bulk/options?org=BONANZA');
    assert(!body.fields.find((f) => f.key === 'source').values.includes(STRAY),
      'the dialog still offers a value that was merged away');
  });

  await test('a merge only ever moves records in your own books', async () => {
    /* The reason this is scoped at all: the counts beside each value are, so an
       administrator is shown a number and must not be able to act beyond it. */
    const bonanza = lead(STRAY);
    const bigul = lead(STRAY, 'BIGUL');

    const admin = await probeAdmin('picklistcleanup-bz', { role: 'admin', sales_org: 'BONANZA' });
    try {
      const r = await call('POST', '/setup/objects/lead/fields/source/values/merge',
        { from: STRAY, to: KEEP }, admin.headers);
      assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.moved, 1, `${r.body.moved} records moved, so it reached outside the book`);
      assert(/another business keep the old value/i.test(r.body.note ?? ''),
        'the response does not say records elsewhere were left alone');
    } finally { admin.cleanup(); }

    assert.equal(sourceOf(bonanza), KEEP);
    assert.equal(sourceOf(bigul), STRAY, "a Bonanza administrator rewrote a Bigul lead");
  });

  await test('the refusals', async () => {
    const same = await call('POST', '/setup/objects/lead/fields/source/values/merge', { from: KEEP, to: KEEP });
    assert.equal(same.status, 400, `HTTP ${same.status}`);

    const nowhere = await call('POST', '/setup/objects/lead/fields/source/values/merge',
      { from: STRAY, to: 'Not on the list (probe)' });
    assert.equal(nowhere.status, 400, 'records were merged onto a value no picker offers');
    assert.equal(nowhere.body.field, 'to');

    const half = await call('POST', '/setup/objects/lead/fields/source/values/merge', { from: '', to: KEEP });
    assert.equal(half.status, 400);
  });

  await test('neither route is open to somebody who cannot configure objects', async () => {
    const rm = await probeAdmin('picklistcleanup-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
    try {
      const add = await call('POST', '/setup/objects/lead/fields/source/values/add',
        { value: 'Sneaky (probe)' }, rm.headers);
      assert.equal(add.status, 403, `HTTP ${add.status}`);
      const merge = await call('POST', '/setup/objects/lead/fields/source/values/merge',
        { from: KEEP, to: 'Manual' }, rm.headers);
      assert.equal(merge.status, 403, `HTTP ${merge.status}`);
      assert.equal(valueRow('Sneaky (probe)'), undefined, 'a Sales RM added a picklist value');
    } finally { rm.cleanup(); }
  });

  await test('both are written to the configuration audit', async () => {
    const rows = all(
      `SELECT action FROM config_audit WHERE area = 'field' AND target = 'lead.source.values'
        ORDER BY id DESC LIMIT 6`,
    ).map((r) => r.action);
    assert(rows.includes('values_merged'), `no merge in the audit: ${rows.join(', ')}`);
    assert(rows.some((a) => a === 'value_added' || a === 'value_restored'),
      `no add in the audit: ${rows.join(', ')}`);
  });
} finally {
  clear();
  SUPER.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
