/**
 * An import is a writer like any other.
 *
 * WHY THIS FILE EXISTS
 *
 * OPS-14 was ruled on 18 September — Setup's picklist decides what may go into
 * Source, Language and Risk profile — and every writer a person reaches was
 * fixed on 6 October except this one. A CSV could still put "Banana" in Source,
 * which is the whole defect, arriving through the one door that carries 495,118
 * rows at a time.
 *
 * WHY IT IS NOT JUST A REFUSAL
 *
 * Refusing the file would be useless on the data this exists for: the legacy
 * export carries nineteen sources, most of which are not on the new list, and
 * 78.7% of rows carry none at all. So the preview says which values are not on
 * the list and how many rows carry each, and the run refuses to start until
 * every one has an answer — map it to a value that is on the list, or leave the
 * column blank. Ritesh's answers 1, 3 and 4 to the migration mapping are three
 * such decisions rather than three rules in the code.
 *
 * THE ONE THAT WOULD HAVE BITTEN
 *
 * The run writes row by row with no transaction around it. Refusing partway
 * through would leave half a file imported, so the decision is checked before
 * anything — including before the list the import creates. The test below
 * imports a file with one bad value and then counts both the leads and the
 * lists.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { runImport, unknownValues, importChoices } from '../src/engine/leadimport.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nImporting values a picklist governs');

const ADMIN = await probeAdmin('importvalues', { role: 'admin', sales_org: 'BONANZA' });

const call = async (method, path, body, headers = ADMIN.headers) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const NAME = 'Import values probe';
const STAMP = String(Date.now()).slice(-5);
const LIST = `${NAME} list`;

const clear = () => {
  run('DELETE FROM lead_list_members WHERE list_id IN (SELECT id FROM lead_lists WHERE name LIKE ?)', [`${NAME}%`]);
  run('DELETE FROM lead_lists WHERE name LIKE ?', [`${NAME}%`]);
  run('DELETE FROM leads WHERE name LIKE ?', [`${NAME}%`]);
  run('DELETE FROM import_run WHERE filename LIKE ?', [`${NAME}%`]);
};
clear();

const HEADER = ['Full name', 'Phone', 'Where from', 'Speaks'];
const MAPPING = {
  'Full name': 'name', Phone: 'mobile', 'Where from': 'source', Speaks: 'language',
};

let serial = 0;
const mob = () => { serial += 1; return `6${STAMP}${String(serial).padStart(4, '0')}`; };

/** A value that is on the Source list, and one that is not. */
const GOOD_SOURCE = importChoices('BONANZA').source[0];
const GOOD_LANGUAGE = importChoices('BONANZA').language[0];
const STRAY = 'Self';                    /* the legacy value from answer 1 */
const ALSO_STRAY = 'Fresh Insurance';    /* and answer 3 */

const leadByMobile = (m) => one('SELECT * FROM leads WHERE mobile = ?', [m]);

try {
  await test('the field list says what each picklist column will accept', async () => {
    const { status, body } = await call('GET', '/leads/import/fields');
    assert.equal(status, 200);
    assert.equal(body.sales_org, 'BONANZA');
    assert(body.choices?.source?.length, 'no Source values offered');
    assert(body.choices?.language?.length, 'no Language values offered');
    assert(body.choices.source.includes(GOOD_SOURCE));
    /* Stage is not an import field and must not appear: a new lead starts at
       the column default, and an import does not set somebody's pipeline. */
    assert(!('stage' in body.choices), 'the import offers to set a stage');
  });

  await test('the preview names the values that are not on the list, with counts', async () => {
    const rows = [
      [`${NAME} a`, mob(), STRAY, GOOD_LANGUAGE],
      [`${NAME} b`, mob(), STRAY, GOOD_LANGUAGE],
      [`${NAME} c`, mob(), ALSO_STRAY, GOOD_LANGUAGE],
      [`${NAME} d`, mob(), GOOD_SOURCE, GOOD_LANGUAGE],
    ];

    const { status, body } = await call('POST', '/leads/import/preview', { header: HEADER, rows, mapping: MAPPING });
    assert.equal(status, 200, `HTTP ${status}: ${JSON.stringify(body)}`);

    const source = body.unknown_values?.source ?? [];
    assert.equal(source.length, 2, `${source.length} unknown Source values reported`);
    /* Commonest first: a decision about 41,000 rows is not the one to bury. */
    assert.equal(source[0].value, STRAY);
    assert.equal(source[0].rows, 2);
    assert.equal(source[1].rows, 1);
    assert(!body.unknown_values?.language, 'a value that is on the list was reported as unknown');

    /* Nothing written — it is a preview. */
    assert.equal(all('SELECT id FROM leads WHERE name LIKE ?', [`${NAME}%`]).length, 0);
  });

  await test('a mapped value stops being unknown, and is what gets stored', async () => {
    const m = mob();
    const rows = [[`${NAME} mapped`, m, STRAY, GOOD_LANGUAGE]];
    const valueMap = { source: { [STRAY]: GOOD_SOURCE } };

    const pre = await call('POST', '/leads/import/preview',
      { header: HEADER, rows, mapping: MAPPING, value_map: valueMap });
    assert.equal(pre.status, 200);
    assert.equal(Object.keys(pre.body.unknown_values ?? {}).length, 0,
      `still unknown: ${JSON.stringify(pre.body.unknown_values)}`);

    const r = await call('POST', '/leads/import/run',
      { header: HEADER, rows, mapping: MAPPING, value_map: valueMap, filename: `${NAME}.csv` });
    assert.equal(r.status, 201, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.created, 1);
    assert.equal(leadByMobile(m).source, GOOD_SOURCE,
      'the mapping step decided one thing and the import stored another');
  });

  await test('a value can be mapped to blank, which is answer 4', async () => {
    const m = mob();
    const rows = [[`${NAME} blanked`, m, ALSO_STRAY, GOOD_LANGUAGE]];

    const r = await call('POST', '/leads/import/run', {
      header: HEADER, rows, mapping: MAPPING, filename: `${NAME}.csv`,
      value_map: { source: { [ALSO_STRAY]: '' } },
    });
    assert.equal(r.status, 201, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);

    /* Blank because somebody said so. The "Import" default is for a row that
       named no source at all; this row named one and the mapping step answered
       "leave it out", and overriding that with a default would be the CRM
       deciding it knew better. */
    assert.equal(leadByMobile(m).source, null,
      'a value mapped to blank was stored as something else');
  });

  await test('a blank column can be told to stay blank', async () => {
    const m = mob();
    const rows = [[`${NAME} nosource`, m, '', GOOD_LANGUAGE]];

    const kept = await call('POST', '/leads/import/run', {
      header: HEADER, rows, mapping: MAPPING, filename: `${NAME}.csv`,
      value_map: { source: { '': '' } },
    });
    assert.equal(kept.status, 201, `HTTP ${kept.status}: ${JSON.stringify(kept.body)}`);
    assert.equal(leadByMobile(m).source, null,
      'a row told to keep its empty source took the Import default anyway');

    /* And without that instruction, the long-standing default still applies. */
    const m2 = mob();
    const dflt = await call('POST', '/leads/import/run', {
      header: HEADER, rows: [[`${NAME} default`, m2, '', GOOD_LANGUAGE]], mapping: MAPPING, filename: `${NAME}.csv`,
    });
    assert.equal(dflt.status, 201);
    assert.equal(leadByMobile(m2).source, 'Import', 'the default changed for an ordinary import');
  });

  await test('the run refuses before it writes anything, or makes a list', async () => {
    const before = all('SELECT id FROM leads WHERE name LIKE ?', [`${NAME}%`]).length;
    const rows = [
      [`${NAME} ok1`, mob(), GOOD_SOURCE, GOOD_LANGUAGE],
      [`${NAME} bad`, mob(), STRAY, GOOD_LANGUAGE],
      [`${NAME} ok2`, mob(), GOOD_SOURCE, GOOD_LANGUAGE],
    ];

    const r = await call('POST', '/leads/import/run', {
      header: HEADER, rows, mapping: MAPPING, filename: `${NAME}.csv`, list_name: LIST,
    });

    assert.equal(r.status, 400, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.unknown_values?.source?.length, 'the refusal does not say which values');
    assert(r.body.choices?.source?.length, 'the refusal does not say what is allowed');
    assert(/not on their list/i.test(r.body.error), `the reason reads: ${r.body.error}`);

    /* Nothing at all: not the two good rows, and not the list either. The run
       writes row by row with no transaction, so this check has to happen first
       or a refusal leaves half a file imported. */
    assert.equal(all('SELECT id FROM leads WHERE name LIKE ?', [`${NAME}%`]).length, before,
      'rows were written before the refusal');
    assert.equal(all('SELECT id FROM lead_lists WHERE name = ?', [LIST]).length, 0,
      'the import created its list and then refused');
  });

  await test('a stray value is refused per row if it reaches the writer anyway', () => {
    /* The route refuses first, so this is the engine's own guard — what
       protects a direct API call, and a list edited while an import is being
       mapped. */
    const report = runImport({
      header: HEADER,
      rows: [[`${NAME} direct`, mob(), 'Banana', GOOD_LANGUAGE]],
      mapping: MAPPING,
      salesOrg: 'BONANZA',
      ownerId: ADMIN.id,
      commit: true,
    });
    assert.equal(report.created, 0, 'a value no picker offers was imported');
    assert.equal(report.failed, 1);
    assert(/not a permitted value for Source/i.test(report.failures[0].reason),
      `the row failed for: ${report.failures[0].reason}`);
  });

  await test('the other business\'s value is unknown here', () => {
    /* The per-business lists from 12 October. A Bigul-only source is a real
       value, and importing it into Bonanza's book is still wrong. */
    const field = one("SELECT id FROM field_def WHERE entity = 'lead' AND api_name = 'source'").id;
    const BIGUL_ONLY = 'Bigul only import probe';
    run(
      `INSERT INTO picklist_value (field_id, value, label, sort_order, sales_org) VALUES (?,?,?,970,'BIGUL')
       ON CONFLICT(field_id, value) DO UPDATE SET active = 1, sales_org = 'BIGUL'`,
      [field, BIGUL_ONLY, BIGUL_ONLY],
    );
    try {
      const found = unknownValues({
        header: HEADER,
        rows: [[`${NAME} x`, mob(), BIGUL_ONLY, GOOD_LANGUAGE]],
        mapping: MAPPING,
        salesOrg: 'BONANZA',
      });
      assert(found.source?.length, "a Bigul value was accepted into Bonanza's book");

      const ok = unknownValues({
        header: HEADER,
        rows: [[`${NAME} y`, mob(), BIGUL_ONLY, GOOD_LANGUAGE]],
        mapping: MAPPING,
        salesOrg: 'BIGUL',
      });
      assert.equal(Object.keys(ok).length, 0, 'a Bigul value was unknown in Bigul');
    } finally {
      run('DELETE FROM picklist_value WHERE field_id = ? AND value = ?', [field, BIGUL_ONLY]);
    }
  });

  await test('an unmapped column is not checked at all', () => {
    /* Only the columns somebody actually mapped. A file with a "Source" heading
       nobody mapped should not be judged on it. */
    const found = unknownValues({
      header: HEADER,
      rows: [[`${NAME} z`, mob(), 'Banana', GOOD_LANGUAGE]],
      mapping: { 'Full name': 'name', Phone: 'mobile', Speaks: 'language' },
      salesOrg: 'BONANZA',
    });
    assert.equal(Object.keys(found).length, 0, 'a column nobody mapped was checked');
  });
} finally {
  clear();
  ADMIN.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
