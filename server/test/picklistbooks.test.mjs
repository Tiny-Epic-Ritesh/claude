/**
 * A picklist value can belong to one business.
 *
 * WHY THIS FILE EXISTS
 *
 * Bonanza runs two LeadSquared tenants with different lists -- 30 lead stages
 * in one, 24 in the other, nineteen live sources on one side alone -- and one
 * CRM serves both books. Ritesh, 12 October 2026: each business keeps its own
 * list.
 *
 * So a value now carries a business, null meaning both, and "which values are
 * there?" has two answers depending on whose record is being asked about. The
 * failure this guards against is a quiet one: a Bonanza RM offered a Bigul-only
 * source, or a bulk update that writes a value to the leads of one book and
 * leaves the rest of the selection holding something else.
 *
 * WHAT IT CHECKS
 *
 * Both directions on every writer -- a one-business value refused on the other
 * book's record and accepted on its own: creating a lead, editing one, the bulk
 * field update, a list's bulk field and bulk stage, and an automation card.
 * A selection spanning both books is refused whole rather than in part, and a
 * shared (null) value still reaches everything.
 *
 * Then every reader, because a picker offering a value the write refuses is the
 * same defect seen from the other side: the bulk dialog, both /meta stage
 * lists, the list filter builder, advanced search, and the lead form -- which
 * asks about the record in front of it rather than about the reader.
 *
 * Then the wording (another business, not "no such value"), and the Setup
 * screen: the per-business flag it draws the column from, the business it
 * stores, the three refusals, and an administrator of one book still being
 * able to save a list that carries the other book's values.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { runAction, leadFacts } from '../src/engine/rules.js';
import { columnPicklist, columnRefusal } from '../src/engine/metadata.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nPicklist values that belong to one business');

/* Superadmin: the one role that holds both books, so a single probe can act on
   a Bonanza record and a Bigul one in the same test. */
const SUPER = await probeAdmin('picklistbooks', { role: 'superadmin' });

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: SUPER.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const NAME = 'Picklist book probe';
const BONANZA_SOURCE = 'Bonanza walk-up (probe)';
const BIGUL_SOURCE = 'Bigul app push (probe)';
const SHARED_SOURCE = 'Shared campaign (probe)';
const BONANZA_RISK = 'Bonanza balanced (probe)';
const BIGUL_STAGE = 'Bigul activation (probe)';

const fieldId = (entity, apiName) => one(
  'SELECT id FROM field_def WHERE entity = ? AND api_name = ?', [entity, apiName],
).id;
const SOURCE = fieldId('lead', 'source');
const RISK = fieldId('lead', 'risk_profile');
const STAGE = fieldId('lead', 'stage');

const addValue = (field, value, org) => run(
  `INSERT INTO picklist_value (field_id, value, label, sort_order, sales_org) VALUES (?,?,?,950,?)
   ON CONFLICT(field_id, value) DO UPDATE SET active = 1, sales_org = excluded.sales_org`,
  [field, value, value, org],
);

const PROBE_VALUES = [
  [SOURCE, BONANZA_SOURCE], [SOURCE, BIGUL_SOURCE], [SOURCE, SHARED_SOURCE],
  [RISK, BONANZA_RISK], [STAGE, BIGUL_STAGE],
];

const clear = () => {
  /* Task priority is the stand-in for "a field that keeps one list for both
     businesses", so this file is only honest about it if it starts with none.
     Reset rather than assumed: a mutation run, which breaks a guard on purpose,
     leaves a business stored there and every later run then read its own
     leftovers as the starting state. */
  run("UPDATE picklist_value SET sales_org = NULL WHERE field_id = (SELECT id FROM field_def WHERE entity = 'task' AND api_name = 'priority')");
  run('DELETE FROM lead_list_members WHERE list_id IN (SELECT id FROM lead_lists WHERE name = ?)', [NAME]);
  run('DELETE FROM lead_lists WHERE name = ?', [NAME]);
  run('DELETE FROM leads WHERE name LIKE ?', [`${NAME}%`]);
  for (const [field, value] of PROBE_VALUES) {
    run('DELETE FROM picklist_value WHERE field_id = ? AND value = ?', [field, value]);
  }
};

clear();
addValue(SOURCE, BONANZA_SOURCE, 'BONANZA');
addValue(SOURCE, BIGUL_SOURCE, 'BIGUL');
addValue(SOURCE, SHARED_SOURCE, null);
addValue(RISK, BONANZA_RISK, 'BONANZA');
addValue(STAGE, BIGUL_STAGE, 'BIGUL');

const STAMP = String(Date.now()).slice(-5);
let serial = 0;
const lead = (org) => {
  serial += 1;
  return Number(run(
    "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,'Manual','New',?,?)",
    [`${NAME} ${serial}`, `5${STAMP}${String(serial).padStart(4, '0')}`, org, SUPER.id],
  ).lastInsertRowid);
};
const colOf = (id, col) => one(`SELECT ${col} AS v FROM leads WHERE id = ?`, [id]).v;
const sourceOf = (id) => colOf(id, 'source');

const listOf = (org, ids) => {
  const id = Number(run(
    "INSERT INTO lead_lists (name, kind, owner_id, created_by, sales_org) VALUES (?, 'static', ?, ?, ?)",
    [NAME, SUPER.id, SUPER.id, org],
  ).lastInsertRowid);
  for (const leadId of ids) run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [id, leadId]);
  return id;
};

/**
 * A field's live values, in the shape the Setup screen sends them back.
 *
 * Read from the database rather than from the value-usage route because that
 * route does not report `is_default` -- a payload built from it would save the
 * field with no default at all, quietly changing seeded configuration for every
 * test that runs after this one.
 */
const rowsOf = (field) => all(
  `SELECT value, label, controlling_value, colour, is_default, sales_org
     FROM picklist_value WHERE field_id = ? AND active = 1 ORDER BY sort_order, label`,
  [field],
);

try {
  /* ------------------------------------------------- the engine itself */

  await test('the list differs by business, and a shared value is on both', () => {
    const bonanza = columnPicklist('lead', 'source', 'BONANZA');
    const bigul = columnPicklist('lead', 'source', 'BIGUL');

    assert(bonanza.includes(BONANZA_SOURCE), 'Bonanza does not offer its own value');
    assert(!bonanza.includes(BIGUL_SOURCE), 'Bonanza offers a Bigul value');
    assert(bigul.includes(BIGUL_SOURCE), 'Bigul does not offer its own value');
    assert(!bigul.includes(BONANZA_SOURCE), 'Bigul offers a Bonanza value');
    assert(bonanza.includes(SHARED_SOURCE) && bigul.includes(SHARED_SOURCE),
      'the shared value is missing from a book');

    /* Asked without a business -- a screen that is not about one record --
       everything comes back, which is what the Setup list needs. */
    const everything = columnPicklist('lead', 'source');
    assert(everything.includes(BONANZA_SOURCE) && everything.includes(BIGUL_SOURCE),
      'asking without a business dropped values');
  });

  await test("the refusal says it belongs to another business, not that it doesn't exist", () => {
    const refusal = columnRefusal('lead', 'source', BIGUL_SOURCE, 'BONANZA');
    assert(refusal, 'a Bigul value was accepted on a Bonanza lead');
    assert(/another business/i.test(refusal), `the reason reads: ${refusal}`);
    assert(refusal.includes('BONANZA'), `the reason does not name the book: ${refusal}`);

    assert.equal(columnRefusal('lead', 'source', 'Nowhere (probe)', 'BONANZA'),
      '"Nowhere (probe)" is not a permitted value for Source',
      'a value that exists in neither book gets the wrong message');
  });

  /* ------------------------------------------------- the writers */

  await test("the single-lead edit is held to the lead's own business", async () => {
    const bonanza = lead('BONANZA');
    const refused = await call('PATCH', `/leads/${bonanza}`, { source: BIGUL_SOURCE });
    assert.equal(refused.status, 400, `HTTP ${refused.status}`);
    assert.equal(sourceOf(bonanza), 'Manual', 'the Bigul value was stored on a Bonanza lead');

    const ok = await call('PATCH', `/leads/${bonanza}`, { source: BONANZA_SOURCE });
    assert.equal(ok.status, 200, `its own value was refused: ${ok.body?.error}`);
    assert.equal(sourceOf(bonanza), BONANZA_SOURCE);

    /* The mirror. A rule that only ran one way round would pass the test above
       and leave half the boundary open. */
    const bigul = lead('BIGUL');
    const mirrored = await call('PATCH', `/leads/${bigul}`, { source: BONANZA_SOURCE });
    assert.equal(mirrored.status, 400, 'a Bonanza value was taken on a Bigul lead');
    assert.equal(sourceOf(bigul), 'Manual');
  });

  await test('a new lead cannot start out holding the other book\'s value', async () => {
    const create = (org, source) => call('POST', `/leads?org=${org}`, {
      name: `${NAME} created ${org}`, mobile: `6${STAMP}${org === 'BIGUL' ? '0002' : '0001'}`, source,
    });

    const refused = await create('BONANZA', BIGUL_SOURCE);
    assert.equal(refused.status, 400, `HTTP ${refused.status}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body?.field, 'source');

    const made = await create('BONANZA', BONANZA_SOURCE);
    assert.equal(made.status, 201, `its own value was refused: ${JSON.stringify(made.body)}`);
  });

  await test('the bulk update refuses a selection spanning both books, whole', async () => {
    const ids = [lead('BONANZA'), lead('BIGUL')];
    const r = await call('POST', '/leads/bulk/field', { field: 'source', value: BONANZA_SOURCE, mode: 'ids', ids });

    assert.equal(r.status, 400, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.sales_org, 'BIGUL', `the refusal names ${r.body.sales_org}`);
    assert.deepEqual(ids.map(sourceOf), ['Manual', 'Manual'],
      'part of the selection was written before the refusal');
  });

  await test('the bulk update takes a value every lead in the selection may hold', async () => {
    const ids = [lead('BONANZA'), lead('BIGUL')];
    const r = await call('POST', '/leads/bulk/field', { field: 'source', value: SHARED_SOURCE, mode: 'ids', ids });

    assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(ids.map(sourceOf), [SHARED_SOURCE, SHARED_SOURCE],
      'the shared value did not reach both leads');
  });

  await test("a list's bulk field edit is held to the list's business", async () => {
    const ids = [lead('BONANZA')];
    const list = listOf('BONANZA', ids);

    const refused = await call('POST', `/lists/${list}/bulk/field`, { field: 'source', value: BIGUL_SOURCE });
    assert.equal(refused.status, 400, `HTTP ${refused.status}`);
    assert(/another business/i.test(refused.body?.error ?? ''), `the reason reads: ${refused.body?.error}`);
    assert.equal(sourceOf(ids[0]), 'Manual', 'the Bigul value was written through a Bonanza list');

    const ok = await call('POST', `/lists/${list}/bulk/field`, { field: 'source', value: BONANZA_SOURCE });
    assert.equal(ok.status, 200, `its own value was refused: ${ok.body?.error}`);
    assert.equal(sourceOf(ids[0]), BONANZA_SOURCE);
  });

  await test("a list's bulk stage is held to the list's business", async () => {
    const ids = [lead('BONANZA')];
    const list = listOf('BONANZA', ids);

    const refused = await call('POST', `/lists/${list}/bulk/stage`, { stage: BIGUL_STAGE });
    assert.equal(refused.status, 400, `HTTP ${refused.status}`);
    assert.equal(colOf(ids[0], 'stage'), 'New', 'a Bigul stage was set on a Bonanza lead');
    /* The refusal lists what is allowed, and the Bigul-only stage is not on it. */
    assert(!String(refused.body?.error ?? '').includes(BIGUL_STAGE),
      `the refusal offers the value it just refused: ${refused.body?.error}`);
  });

  await test('an automation card is held to the lead it is acting on', () => {
    const bigul = lead('BIGUL');
    const blocked = runAction(
      { type: 'update_lead', params: { field: 'risk_profile', value: BONANZA_RISK } },
      leadFacts(bigul), { dryRun: false },
    );
    assert(blocked.skipped, 'a card wrote a Bonanza value onto a Bigul lead');
    assert(/another business/i.test(blocked.skipped), `the card reported: ${blocked.skipped}`);
    assert.equal(colOf(bigul, 'risk_profile'), null);

    const bonanza = lead('BONANZA');
    const allowed = runAction(
      { type: 'update_lead', params: { field: 'risk_profile', value: BONANZA_RISK } },
      leadFacts(bonanza), { dryRun: false },
    );
    assert(!allowed.skipped, `its own value was refused: ${allowed.skipped}`);
    assert.equal(colOf(bonanza, 'risk_profile'), BONANZA_RISK);
  });

  /* ------------------------------------------------- what a dialog offers */

  await test("the bulk dialog offers the reader's own business", async () => {
    const bonanza = (await call('GET', '/leads/bulk/options?org=BONANZA')).body;
    const offered = bonanza.fields.find((f) => f.key === 'source')?.values ?? [];
    assert(offered.includes(BONANZA_SOURCE), 'the Bonanza dialog is missing its own value');
    assert(!offered.includes(BIGUL_SOURCE), 'the Bonanza dialog offers a Bigul value');
    assert(offered.includes(SHARED_SOURCE), 'the shared value is missing from the dialog');

    const bigul = (await call('GET', '/leads/bulk/options?org=BIGUL')).body;
    const stages = bigul.fields.find((f) => f.key === 'stage')?.values ?? [];
    assert(stages.includes(BIGUL_STAGE), 'the Bigul dialog is missing its own stage');
  });

  await test('every screen that lists stages lists the reader\'s own', async () => {
    const stagesAt = async (path) => (await call('GET', path)).body?.stages ?? [];

    assert((await stagesAt('/meta?org=BIGUL')).includes(BIGUL_STAGE),
      'the lead screens do not offer Bigul its own stage');
    assert(!(await stagesAt('/meta?org=BONANZA')).includes(BIGUL_STAGE),
      'the lead screens offer Bonanza a Bigul stage');
    assert((await stagesAt('/lists/meta?org=BIGUL')).includes(BIGUL_STAGE),
      'the list screens do not offer Bigul its own stage');
    assert(!(await stagesAt('/lists/meta?org=BONANZA')).includes(BIGUL_STAGE),
      'the list screens offer Bonanza a Bigul stage');
  });

  await test('the filter builder offers what the reader could actually select', async () => {
    /* Its own promise: "a filter written against a value nobody can select is
       a filter that matches nothing". A per-business value makes that promise
       breakable without anything failing — the filter saves, runs, and returns
       nothing at all. */
    const sourcesAt = async (org) => {
      const { body } = await call('GET', `/lists/meta?org=${org}`);
      const field = body?.schema?.fields?.find((f) => f.code === 'source');
      assert(field, 'the filter builder has no Source field');
      return (field.values ?? []).map((v) => v.value);
    };

    const bonanza = await sourcesAt('BONANZA');
    assert(bonanza.includes(BONANZA_SOURCE), 'Bonanza cannot filter on its own source');
    assert(!bonanza.includes(BIGUL_SOURCE), 'Bonanza can filter on a Bigul source');
    assert(bonanza.includes(SHARED_SOURCE), 'the shared source is missing from the builder');
    assert((await sourcesAt('BIGUL')).includes(BIGUL_SOURCE), 'Bigul cannot filter on its own source');
  });

  await test('the lead form offers what the record in front of you can hold', async () => {
    /* `/meta/fields/lead` draws the edit form and the stage dialogs. A form
       bound to one record asks about that record's business, so a superadmin
       editing a Bigul lead is not shown their home book's sources. */
    const sourcesIn = async (org) => {
      const { body } = await call('GET', `/meta/fields/lead?org=${org}`);
      return (body?.fields?.find((f) => f.api_name === 'source')?.values ?? []).map((v) => v.value);
    };

    const bonanza = await sourcesIn('BONANZA');
    assert(bonanza.includes(BONANZA_SOURCE), 'the Bonanza form is missing its own source');
    assert(!bonanza.includes(BIGUL_SOURCE), 'the Bonanza form offers a Bigul source');
    assert(bonanza.includes(SHARED_SOURCE), 'the shared source is missing from the form');
    assert((await sourcesIn('BIGUL')).includes(BIGUL_SOURCE), 'the Bigul form is missing its own source');
  });

  await test('advanced search offers values a search could actually match', async () => {
    const stagesIn = async (org) => {
      const { body } = await call('GET', `/search-advanced/fields/lead?org=${org}`);
      return (body?.fields?.find((f) => f.api_name === 'stage')?.values ?? []).map((v) => v.value);
    };

    assert((await stagesIn('BIGUL')).includes(BIGUL_STAGE), 'Bigul cannot search on its own stage');
    assert(!(await stagesIn('BONANZA')).includes(BIGUL_STAGE), 'Bonanza is offered a Bigul stage to search on');
  });

  /* ------------------------------------------------- the Setup screen */

  await test('Setup says which fields keep a value per business', async () => {
    /* The screen offers the Business column on the strength of this flag. Said
       by the server so the screen that offers the column and the route that
       accepts it cannot hold different lists. */
    const perBookOf = async (entity, apiName) => (
      await call('GET', `/setup/objects/${entity}/fields/${apiName}/value-usage`)
    ).body?.per_book;

    assert.equal(await perBookOf('lead', 'source'), true);
    assert.equal(await perBookOf('lead', 'stage'), true);
    assert.equal(await perBookOf('lead', 'language'), true);
    assert.equal(await perBookOf('lead', 'risk_profile'), true);
    assert.equal(await perBookOf('task', 'priority'), false);
  });

  await test('Setup saves the business, and the pickers follow immediately', async () => {
    const before = rowsOf(SOURCE);
    const send = (rows) => call('PUT', '/setup/objects/lead/fields/source/values', {
      values: rows.map((r) => ({
        value: r.value,
        label: r.label,
        controlling_value: r.controlling_value ?? null,
        colour: r.colour ?? null,
        is_default: r.is_default ? 1 : 0,
        sales_org: r.sales_org ?? null,
      })),
    });

    /* Move the shared value into one book through the route an administrator
       actually uses. Everything else goes back exactly as it was, defaults
       included -- this screen saves the whole list at once. */
    const moved = await send(before.map((r) => (
      r.value === SHARED_SOURCE ? { ...r, sales_org: 'BIGUL' } : r
    )));
    assert.equal(moved.status, 200, `HTTP ${moved.status}: ${JSON.stringify(moved.body)}`);

    assert.equal(rowsOf(SOURCE).find((r) => r.value === SHARED_SOURCE)?.sales_org, 'BIGUL',
      'the business was not stored');
    assert(!columnPicklist('lead', 'source', 'BONANZA').includes(SHARED_SOURCE),
      'Bonanza still offers a value that now belongs to Bigul');
    assert.equal(
      await call('PATCH', `/leads/${lead('BONANZA')}`, { source: SHARED_SOURCE }).then((r) => r.status),
      400, 'a Bonanza lead still accepts a value that now belongs to Bigul',
    );

    /* And back, so the rest of the suite sees the configuration it seeded. */
    const restored = await send(before);
    assert.equal(restored.status, 200, `HTTP ${restored.status}: ${JSON.stringify(restored.body)}`);
    assert.equal(rowsOf(SOURCE).find((r) => r.value === SHARED_SOURCE)?.sales_org, null);
  });

  await test('Setup refuses a business the administrator cannot use', async () => {
    const r = await call('PUT', '/setup/objects/lead/fields/source/values', {
      values: rowsOf(SOURCE).map((v) => ({
        value: v.value, label: v.label, is_default: v.is_default ? 1 : 0,
        sales_org: v.value === SHARED_SOURCE ? 'NOWHERE' : (v.sales_org ?? null),
      })),
    });

    assert.equal(r.status, 403, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(rowsOf(SOURCE).find((v) => v.value === SHARED_SOURCE)?.sales_org, null,
      'the refused save was written anyway');
  });

  await test('an administrator of one book can still save the shared list', async () => {
    /*
     * This screen saves the whole list in one request, so a Bonanza
     * administrator's payload necessarily carries Bigul's values back with it.
     * Checking the rights on every row rather than on what actually changed
     * locked Bonanza out of the Source list altogether the moment Bigul had a
     * value of its own -- the save was refused and there was nothing they could
     * do about it from the screen.
     */
    const bonanzaOnly = await probeAdmin('picklistbooks-one', { role: 'admin', sales_org: 'BONANZA' });
    const asThem = async (rows) => {
      const res = await fetch(`${BASE}/api/setup/objects/lead/fields/source/values`, {
        method: 'PUT',
        headers: bonanzaOnly.headers,
        body: JSON.stringify({
          values: rows.map((r) => ({
            value: r.value, label: r.label, controlling_value: r.controlling_value ?? null,
            colour: r.colour ?? null, is_default: r.is_default ? 1 : 0, sales_org: r.sales_org ?? null,
          })),
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    try {
      const rows = rowsOf(SOURCE);
      const untouched = await asThem(rows);
      assert.equal(untouched.status, 200,
        `a Bonanza administrator cannot save the list: HTTP ${untouched.status} ${JSON.stringify(untouched.body)}`);
      assert.equal(rowsOf(SOURCE).find((r) => r.value === BIGUL_SOURCE)?.sales_org, 'BIGUL',
        "saving as Bonanza changed Bigul's value");

      /* What they may not do is move another book's value. */
      const moved = await asThem(rows.map((r) => (
        r.value === BIGUL_SOURCE ? { ...r, sales_org: null } : r
      )));
      assert.equal(moved.status, 403, `HTTP ${moved.status}: ${JSON.stringify(moved.body)}`);
      assert.equal(rowsOf(SOURCE).find((r) => r.value === BIGUL_SOURCE)?.sales_org, 'BIGUL',
        "a Bonanza administrator moved Bigul's value out of its book");

      /* Their own book they may. */
      const theirs = await asThem(rows.map((r) => (
        r.value === SHARED_SOURCE ? { ...r, sales_org: 'BONANZA' } : r
      )));
      assert.equal(theirs.status, 200, `HTTP ${theirs.status}: ${JSON.stringify(theirs.body)}`);
      assert.equal(rowsOf(SOURCE).find((r) => r.value === SHARED_SOURCE)?.sales_org, 'BONANZA');

      const back = await asThem(rows);
      assert.equal(back.status, 200, `HTTP ${back.status}: ${JSON.stringify(back.body)}`);
    } finally {
      bonanzaOnly.cleanup();
    }
  });

  await test('a field that keeps one list for both businesses refuses a business', async () => {
    const PRIORITY = fieldId('task', 'priority');
    const before = rowsOf(PRIORITY);
    assert(before.length, 'task priority has no values, so this proves nothing');

    const r = await call('PUT', '/setup/objects/task/fields/priority/values', {
      values: before.map((v, i) => ({
        value: v.value, label: v.label, is_default: v.is_default ? 1 : 0,
        ...(i === 0 ? { sales_org: 'BONANZA' } : {}),
      })),
    });

    assert.equal(r.status, 400, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert(/one list for both businesses/i.test(r.body?.error ?? ''), `the reason reads: ${r.body?.error}`);
    assert.equal(rowsOf(PRIORITY).find((v) => v.value === before[0].value)?.sales_org, null,
      'a business was stored on a field that does not honour one');
  });
} finally {
  clear();
  SUPER.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
