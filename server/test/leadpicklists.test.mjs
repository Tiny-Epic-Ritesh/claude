/**
 * Source, Language and Risk profile are values of their picklists. OPS-14.
 *
 * WHY THIS FILE EXISTS
 *
 * OPS-13 held Stage to the Stage picklist in Setup. The other three core lead
 * picklists were not held to anything: `PATCH /leads/:id`, `POST /leads` and
 * both bulk field routes stored "Banana" as a Source, a Language and a Risk
 * profile, and the bulk dialog offered whatever values were already on records
 * -- so one typo became a choice everybody else could pick.
 *
 * Ritesh, 18 September: Source is a dropdown that admins and superadmins
 * maintain, and the same rule reads across to Language and Risk profile.
 * Records already holding something else keep it (the cleanup is its own
 * piece of work); what is refused is writing a new one.
 *
 * WHAT IT CHECKS
 *
 * Each writer refuses a value the picklist does not hold and takes one it
 * does; a blank is refused only where the field is required, which is Stage
 * and not these three; a lead holding an unlisted value can still be saved;
 * and the dialog offers the picklist rather than what is in use. Then the
 * picklist is edited as Setup edits it, and the writers follow.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { runAction, leadFacts } from '../src/engine/rules.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nSource, Language and Risk profile follow their picklists');

const ADMIN = await probeAdmin('leadpicklists');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: ADMIN.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const NAME = 'Lead picklist probe';
const LIST = 'Lead picklist probe list';
const ADDED = 'Trade show (probe)';
const RETIRE = 'Webinar';

const COLUMNS = [
  { field: 'source', label: 'Source', good: 'Webinar', added: ADDED },
  { field: 'language', label: 'Language', good: 'Marathi', added: 'Konkani (probe)' },
  { field: 'risk_profile', label: 'Risk Profile', good: 'Aggressive', added: 'Balanced (probe)' },
];

const fieldId = (apiName) => one(
  "SELECT id FROM field_def WHERE entity = 'lead' AND api_name = ?", [apiName],
).id;
const retiredWas = one(
  'SELECT active FROM picklist_value WHERE field_id = ? AND value = ?', [fieldId('source'), RETIRE],
);

const clear = () => {
  run('DELETE FROM lead_list_members WHERE list_id IN (SELECT id FROM lead_lists WHERE name = ?)', [LIST]);
  run('DELETE FROM lead_lists WHERE name = ?', [LIST]);
  run('DELETE FROM leads WHERE name LIKE ?', [`${NAME}%`]);
  for (const c of COLUMNS) run('DELETE FROM picklist_value WHERE field_id = ? AND value = ?', [fieldId(c.field), c.added]);
};
clear();

const STAMP = String(Date.now()).slice(-5);
let serial = 0;
const lead = (extra = {}) => {
  serial += 1;
  /* Merged rather than concatenated: `extra` overrides a default here, and
     naming the same column twice in one INSERT is a SQLite error. */
  const row = {
    name: `${NAME} ${serial}`,
    mobile: `7${STAMP}${String(serial).padStart(4, '0')}`,
    source: 'Manual',
    stage: 'New',
    sales_org: 'BONANZA',
    owner_id: ADMIN.id,
    ...extra,
  };
  const columns = Object.keys(row);
  return Number(run(
    `INSERT INTO leads (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    Object.values(row),
  ).lastInsertRowid);
};
const valueOf = (id, field) => one(`SELECT ${field} AS v FROM leads WHERE id = ?`, [id]).v;

const listOf = (ids) => {
  const id = Number(run(
    "INSERT INTO lead_lists (name, kind, owner_id, created_by, sales_org) VALUES (?, 'static', ?, ?, 'BONANZA')",
    [LIST, ADMIN.id, ADMIN.id],
  ).lastInsertRowid);
  for (const leadId of ids) run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [id, leadId]);
  return id;
};

/* Every way a person sets one of these columns. */
const writers = (field) => ({
  'PATCH /leads/:id': async (value) => {
    const id = lead();
    const r = await call('PATCH', `/leads/${id}`, { [field]: value });
    return { id, ok: r.status === 200, status: r.status, error: r.body?.error };
  },
  'POST /leads': async (value) => {
    serial += 1;
    const r = await call('POST', '/leads', {
      name: `${NAME} ${serial}`, mobile: `7${STAMP}${String(serial).padStart(4, '0')}`, [field]: value,
    });
    return { id: r.body?.id ?? null, ok: r.status === 201, status: r.status, error: r.body?.error };
  },
  'POST /leads/bulk/field': async (value) => {
    const id = lead();
    const r = await call('POST', '/leads/bulk/field', { field, value, mode: 'ids', ids: [id] });
    return { id, ok: r.status === 200, status: r.status, error: r.body?.error };
  },
  'POST /lists/:id/bulk/field': async (value) => {
    const id = lead();
    const r = await call('POST', `/lists/${listOf([id])}/bulk/field`, { field, value });
    return { id, ok: r.status === 200, status: r.status, error: r.body?.error };
  },
});

const refusesEverywhere = async (field, value, why) => {
  for (const [name, write] of Object.entries(writers(field))) {
    const r = await write(value);                           // eslint-disable-line no-await-in-loop
    assert.equal(r.status, 400, `${field} via ${name} took ${JSON.stringify(value)}: HTTP ${r.status}`);
    assert.equal(r.error, why, `${field} via ${name} gave the reason ${JSON.stringify(r.error)}`);
    if (r.id) assert.notEqual(String(valueOf(r.id, field)), String(value), `${field} via ${name} stored it anyway`);
  }
};
const acceptsEverywhere = async (field, value) => {
  for (const [name, write] of Object.entries(writers(field))) {
    const r = await write(value);                           // eslint-disable-line no-await-in-loop
    assert(r.ok, `${field} via ${name} refused ${JSON.stringify(value)}: HTTP ${r.status} ${r.error}`);
    assert.equal(valueOf(r.id, field), value, `${field} via ${name} stored ${valueOf(r.id, field)}`);
  }
};

try {
  /* ------------------------------------------------- the three columns */

  for (const c of COLUMNS) {
    await test(`${c.label}: every writer refuses a value the picklist does not hold`, async () => {
      await refusesEverywhere(c.field, 'Banana', `"Banana" is not a permitted value for ${c.label}`);
    });

    await test(`${c.label}: every writer takes a value it does hold`, async () => {
      await acceptsEverywhere(c.field, c.good);
    });
  }

  await test('blank is allowed on these three, and still refused on Stage', async () => {
    /* The difference is the field\'s own required flag in Setup, not a list in
       the code: Stage is required, these three are not. */
    const id = lead({ language: 'Hindi' });
    const cleared = await call('PATCH', `/leads/${id}`, { language: '' });
    assert.equal(cleared.status, 200, `clearing Language: HTTP ${cleared.status} ${cleared.body?.error}`);
    assert.equal(valueOf(id, 'language'), null, 'Language was not cleared');

    const stage = await call('PATCH', `/leads/${id}`, { stage: '' });
    assert.equal(stage.status, 400, `a blank stage: HTTP ${stage.status}`);
    assert.equal(stage.body?.error, 'Stage is required', `the reason was ${stage.body?.error}`);
  });

  await test('a lead already holding an unlisted value can still be saved', async () => {
    /* The migrated book is full of these. Ritesh, 18 September: they keep what
       they hold, and the cleanup is its own job -- so re-sending the value a
       lead already has must not stop the rest of the edit. */
    const id = lead({ source: 'Carrier Pigeon' });
    const r = await call('PATCH', `/leads/${id}`, { source: 'Carrier Pigeon', city: 'Nagpur' });

    assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(one('SELECT city FROM leads WHERE id = ?', [id]).city, 'Nagpur', 'the rest of the edit was lost');
    assert.equal(valueOf(id, 'source'), 'Carrier Pigeon', 'the stored value was changed');
  });

  /* ------------------------------------------------- what the dialog offers */

  await test('the bulk dialog offers the picklist, not whatever is in use', async () => {
    lead({ source: 'Carrier Pigeon' });                     // in use, not in the list
    const fields = (await call('GET', '/leads/bulk/options')).body.fields;

    for (const c of COLUMNS) {
      const offered = fields.find((f) => f.key === c.field)?.values ?? [];
      assert(offered.includes(c.good), `${c.label} does not offer ${c.good}: ${JSON.stringify(offered)}`);
      assert(!offered.includes('Carrier Pigeon'), `${c.label} offers "Carrier Pigeon", which the write refuses`);
      assert(!fields.find((f) => f.key === c.field)?.free, `${c.label} is still offered as free text`);
    }
    /* City has no picklist and keeps its in-use list, so this did not simply
       turn every field into a dropdown. */
    const city = fields.find((f) => f.key === 'city');
    assert(city?.free, 'City stopped being a free-text field');
  });

  /* ------------------------------------------------- Setup decides */

  await test('a value added in Setup is accepted by every writer', async () => {
    for (const c of COLUMNS) {
      run('INSERT INTO picklist_value (field_id, value, label, sort_order) VALUES (?,?,?,99)',
        [fieldId(c.field), c.added, c.added]);
      await acceptsEverywhere(c.field, c.added);            // eslint-disable-line no-await-in-loop
    }
  });

  await test('a value retired in Setup is refused and no longer offered', async () => {
    run('UPDATE picklist_value SET active = 0 WHERE field_id = ? AND value = ?', [fieldId('source'), RETIRE]);
    await refusesEverywhere('source', RETIRE, `"${RETIRE}" is not a permitted value for Source`);

    const fields = (await call('GET', '/leads/bulk/options')).body.fields;
    const offered = fields.find((f) => f.key === 'source')?.values ?? [];
    assert(offered.length, 'Source offers nothing at all');
    assert(!offered.includes(RETIRE), `Source still offers the retired ${RETIRE}`);
  });

  /* ------------------------------------------------- the automation card */

  await test('an automation card is held to the picklist too', async () => {
    const id = lead();
    const bad = runAction(
      { type: 'update_lead', params: { field: 'risk_profile', value: 'Banana' } }, leadFacts(id), { dryRun: false },
    );
    assert.equal(bad.skipped, '"Banana" is not a permitted value for Risk Profile', `skipped: ${bad.skipped}`);
    assert.equal(valueOf(id, 'risk_profile'), null, 'the card wrote it anyway');

    const good = runAction(
      { type: 'update_lead', params: { field: 'risk_profile', value: 'Moderate' } }, leadFacts(id), { dryRun: false },
    );
    assert(!good.skipped, `a valid risk profile was skipped: ${good.skipped}`);
    assert.equal(valueOf(id, 'risk_profile'), 'Moderate', 'the card did not write a valid value');

    /* Score has no picklist, so the card still writes it. */
    const score = runAction(
      { type: 'update_lead', params: { field: 'score', value: 42 } }, leadFacts(id), { dryRun: false },
    );
    assert(!score.skipped, `the score write was skipped: ${score.skipped}`);
  });
} finally {
  run('UPDATE picklist_value SET active = ? WHERE field_id = ? AND value = ?',
    [retiredWas?.active ?? 1, fieldId('source'), RETIRE]);
  clear();
  ADMIN.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
