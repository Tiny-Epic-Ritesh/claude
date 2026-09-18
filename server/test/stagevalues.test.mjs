/**
 * A lead's stage is a value of the Stage picklist. OPS-13.
 *
 * WHY THIS FILE EXISTS
 *
 * The stage was checked in two places and against the wrong list. PATCH
 * /leads/:id checked who may change a stage and never what to, so an
 * administrator could store "Banana"; POST /lists/:id/bulk/field did the same.
 * The two routes that did check -- /leads/bulk/field and /lists/:id/bulk/stage
 * -- checked the six stages written into the code, while the Stage picklist,
 * which an administrator edits in Setup and which the lead's own dialogs
 * already offered, could say something else.
 *
 * Ritesh ruled on 18 Sep: the Setup picklist decides. So every writer asks it,
 * and every dialog that offers a stage offers it.
 *
 * WHAT IT CHECKS
 *
 * Each writer -- PATCH, both bulk field routes, the list bulk stage, and the
 * automation card -- refuses a value the picklist does not hold, and takes one
 * it does. Then the picklist is changed the way Setup changes it: a value
 * added is accepted and offered everywhere, a value retired is refused and
 * offered nowhere. A check against the six written into the code passes the
 * first half and fails the second.
 */

import { strict as assert } from 'node:assert';
import { one, run } from '../src/db.js';
import { runAction, leadFacts } from '../src/engine/rules.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nA stage is a value of the Stage picklist');

const ADMIN = await probeAdmin('stagevalues');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: ADMIN.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ------------------------------------------------------------- fixtures */

const NAME = 'Stage values probe';
const LIST = 'Stage values probe list';
const ADDED = 'Dormant (probe)';
const RETIRED = 'In Progress';

const STAGE_FIELD = one("SELECT id FROM field_def WHERE entity = 'lead' AND api_name = 'stage'").id;
const retiredWas = one('SELECT active FROM picklist_value WHERE field_id = ? AND value = ?', [STAGE_FIELD, RETIRED]);

const clear = () => {
  run('DELETE FROM lead_list_members WHERE list_id IN (SELECT id FROM lead_lists WHERE name = ?)', [LIST]);
  run('DELETE FROM lead_lists WHERE name = ?', [LIST]);
  run('DELETE FROM leads WHERE name LIKE ?', [`${NAME}%`]);
  run('DELETE FROM picklist_value WHERE field_id = ? AND value = ?', [STAGE_FIELD, ADDED]);
};
clear();

const STAMP = String(Date.now()).slice(-5);
let serial = 0;
const lead = (stage = 'New') => {
  serial += 1;
  return Number(run(
    "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,'Referral',?,'BONANZA',?)",
    [`${NAME} ${serial}`, `6${STAMP}${String(serial).padStart(4, '0')}`, stage, ADMIN.id],
  ).lastInsertRowid);
};
const stageOf = (id) => one('SELECT stage FROM leads WHERE id = ?', [id]).stage;

const listOf = (ids) => {
  const id = Number(run(
    "INSERT INTO lead_lists (name, kind, owner_id, created_by, sales_org) VALUES (?, 'static', ?, ?, 'BONANZA')",
    [LIST, ADMIN.id, ADMIN.id],
  ).lastInsertRowid);
  for (const leadId of ids) run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [id, leadId]);
  return id;
};

/* Every writer, as one call each, so the same value can be put to all five. */
const WRITERS = {
  'PATCH /leads/:id': async (value) => {
    const id = lead();
    const r = await call('PATCH', `/leads/${id}`, { stage: value });
    return { id, status: r.status, error: r.body?.error };
  },
  'POST /leads/bulk/field': async (value) => {
    const id = lead();
    const r = await call('POST', '/leads/bulk/field', { field: 'stage', value, mode: 'ids', ids: [id] });
    return { id, status: r.status, error: r.body?.error };
  },
  'POST /lists/:id/bulk/field': async (value) => {
    const id = lead();
    const r = await call('POST', `/lists/${listOf([id])}/bulk/field`, { field: 'stage', value });
    return { id, status: r.status, error: r.body?.error };
  },
  'POST /lists/:id/bulk/stage': async (value) => {
    const id = lead();
    const r = await call('POST', `/lists/${listOf([id])}/bulk/stage`, { stage: value });
    return { id, status: r.status, error: r.body?.error };
  },
  'automation update_lead': async (value) => {
    const id = lead();
    const out = runAction({ type: 'update_lead', params: { field: 'stage', value } }, leadFacts(id), { dryRun: false });
    return { id, status: out.skipped ? 'skipped' : 'applied', error: out.skipped };
  },
};

const refuses = async (value, why) => {
  for (const [name, write] of Object.entries(WRITERS)) {
    const r = await write(value);                       // eslint-disable-line no-await-in-loop
    assert([400, 'skipped'].includes(r.status), `${name} took ${JSON.stringify(value)}: ${r.status}`);
    assert.equal(stageOf(r.id), 'New', `${name} stored ${JSON.stringify(stageOf(r.id))}`);
    if (why && name !== 'POST /lists/:id/bulk/stage') {
      assert.equal(r.error, why, `${name} gave the reason ${JSON.stringify(r.error)}`);
    }
  }
};
const accepts = async (value) => {
  for (const [name, write] of Object.entries(WRITERS)) {
    const r = await write(value);                       // eslint-disable-line no-await-in-loop
    assert([200, 'applied'].includes(r.status), `${name} refused ${JSON.stringify(value)}: ${r.status} ${r.error}`);
    assert.equal(stageOf(r.id), value, `${name} left the stage at ${stageOf(r.id)}`);
  }
};

/* What each dialog that sets a stage is given to offer. */
const offered = async () => {
  const bulk = (await call('GET', '/leads/bulk/options')).body;
  return {
    'the bulk update dialog': bulk.fields.find((f) => f.key === 'stage')?.values ?? [],
    'the lead screens (/meta)': (await call('GET', '/meta')).body.stages ?? [],
    'the list screens (/lists/meta)': (await call('GET', '/lists/meta')).body.stages ?? [],
  };
};

/* ------------------------------------------------ the picklist as seeded */

try {
  await test('every writer refuses a stage the picklist does not hold', async () => {
    await refuses('Banana', '"Banana" is not a permitted value for Stage');
  });

  await test('and a blank one, which the single-lead edit used to fail on as a server error', async () => {
    await refuses('', 'Stage is required');
    const id = lead();
    const r = await call('PATCH', `/leads/${id}`, { stage: null });
    assert.equal(r.status, 400, `a null stage: HTTP ${r.status}`);
    assert.equal(stageOf(id), 'New', 'a null stage was stored');
  });

  await test('every writer takes a stage the picklist holds', async () => {
    await accepts('Contacted');
  });

  /* ---------------------------------------- the picklist, as Setup edits it */

  await test('a stage added in Setup is accepted by every writer', async () => {
    run('INSERT INTO picklist_value (field_id, value, label, sort_order) VALUES (?,?,?,99)', [STAGE_FIELD, ADDED, ADDED]);
    await accepts(ADDED);
  });

  await test('and offered by every dialog that sets a stage', async () => {
    for (const [where, values] of Object.entries(await offered())) {
      assert(values.includes(ADDED), `${where} does not offer ${ADDED}: ${JSON.stringify(values)}`);
    }
  });

  await test('a stage retired in Setup is refused by every writer', async () => {
    run('UPDATE picklist_value SET active = 0 WHERE field_id = ? AND value = ?', [STAGE_FIELD, RETIRED]);
    await refuses(RETIRED, `"${RETIRED}" is not a permitted value for Stage`);
  });

  await test('and offered by none of them', async () => {
    for (const [where, values] of Object.entries(await offered())) {
      assert(values.length, `${where} offers no stages at all`);
      assert(!values.includes(RETIRED), `${where} still offers ${RETIRED}`);
    }
  });

  await test('a lead already at a retired stage can still be saved', async () => {
    /* Retiring a value leaves it on the records that hold it (Setup warns how
       many). Re-sending the stage a lead already has is not a change, so it
       must not stop someone correcting the city. */
    const id = lead(RETIRED);
    const r = await call('PATCH', `/leads/${id}`, { stage: RETIRED, city: 'Thane' });
    assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(one('SELECT city FROM leads WHERE id = ?', [id]).city, 'Thane', 'the rest of the edit was lost');
    assert.equal(stageOf(id), RETIRED);
  });
} finally {
  run('UPDATE picklist_value SET active = ? WHERE field_id = ? AND value = ?', [retiredWas?.active ?? 1, STAGE_FIELD, RETIRED]);
  clear();
  ADMIN.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
