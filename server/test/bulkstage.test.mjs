/**
 * A change of stage through a bulk edit needs the stage capability. OPS-12.
 *
 * WHY THIS FILE EXISTS
 *
 * `PATCH /leads/:id` refuses a stage change without `lead.stage.change`, which
 * only superadmin, admin and sales_supervisor hold, and `POST
 * /lists/:id/bulk/stage` requires it. Two other routes set the stage and took
 * `lead.edit` alone, which Sales RMs and dealers hold:
 *
 *   POST /leads/bulk/field       with field: stage
 *   POST /lists/:id/bulk/field   whose editable fields include stage
 *
 * So a Sales RM whom PATCH refused could set the same lead to Won in bulk.
 *
 * WHAT IT CHECKS
 *
 * Each refusal, and the halves that make them worth having: an RM can still
 * bulk-set an ordinary field on both routes, a holder of lead.stage.change
 * still sets the stage on both, and neither dialog offers Stage to someone the
 * write would refuse. A guard that refused everything would pass the refusals
 * alone.
 */

import { strict as assert } from 'node:assert';
import { one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nBulk edit of the stage');

/* One account per role, each signing in once: the login limiter counts per
   account, and the shared seeded ones belong to the rest of the suite. */
const RM = await probeAdmin('bulkstage-rm', { role: 'sales_rm' });
const DEALER = await probeAdmin('bulkstage-dealer', { role: 'dealer' });
const ADMIN = await probeAdmin('bulkstage');

const call = async (who, method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const NAME = 'Bulk stage probe';
const LIST = 'Bulk stage probe list';
const clearLists = () => {
  run('DELETE FROM lead_list_members WHERE list_id IN (SELECT id FROM lead_lists WHERE name = ?)', [LIST]);
  run('DELETE FROM lead_lists WHERE name = ?', [LIST]);
};
const clear = () => {
  clearLists();
  run('DELETE FROM leads WHERE name LIKE ?', [`${NAME}%`]);
};
clear();

const STAMP = String(Date.now()).slice(-5);
let serial = 0;
const leads = (n, owner) => Array.from({ length: n }, () => {
  serial += 1;
  return Number(run(
    "INSERT INTO leads (name, mobile, source, stage, sales_org, owner_id) VALUES (?,?,'Referral','New','BONANZA',?)",
    [`${NAME} ${serial}`, `8${STAMP}${String(serial).padStart(4, '0')}`, owner],
  ).lastInsertRowid);
});
const lead = (id) => one('SELECT stage, city FROM leads WHERE id = ?', [id]);
const stages = (ids) => ids.map((id) => lead(id).stage);

/* A static list of the caller's own leads, in the caller's book: the list
   route's own visibility rules let them in, so any refusal is the capability. */
const listOf = (owner, ids) => {
  const id = Number(run(
    "INSERT INTO lead_lists (name, kind, owner_id, created_by, sales_org) VALUES (?, 'static', ?, ?, 'BONANZA')",
    [LIST, owner, owner],
  ).lastInsertRowid);
  for (const leadId of ids) run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [id, leadId]);
  return id;
};

/* ------------------------------------------- POST /leads/bulk/field */

await test('PATCH refuses the Sales RM a stage change -- the rule the bulk routes must match', async () => {
  const [id] = leads(1, RM.id);
  const r = await call(RM, 'PATCH', `/leads/${id}`, { stage: 'Won' });

  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(lead(id).stage, 'New', 'PATCH moved the stage');
});

await test('a Sales RM cannot set leads to Won through bulk update', async () => {
  const ids = leads(2, RM.id);
  const r = await call(RM, 'POST', '/leads/bulk/field', { field: 'stage', value: 'Won', mode: 'ids', ids });

  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.required, 'lead.stage.change', `the refusal names ${r.body.required}`);
  assert.deepEqual(stages(ids), ['New', 'New'], 'the stage moved anyway');
});

await test('nor can a dealer', async () => {
  const [id] = leads(1, DEALER.id);
  const r = await call(DEALER, 'POST', '/leads/bulk/field', { field: 'stage', value: 'Won', mode: 'ids', ids: [id] });

  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(lead(id).stage, 'New', 'the stage moved anyway');
});

await test('a Sales RM can still bulk-set an ordinary field', async () => {
  const [id] = leads(1, RM.id);
  const r = await call(RM, 'POST', '/leads/bulk/field', { field: 'city', value: 'Nashik', mode: 'ids', ids: [id] });

  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(lead(id).city, 'Nashik', 'the city did not change');
});

await test('a holder of lead.stage.change still sets the stage in bulk', async () => {
  const ids = leads(2, ADMIN.id);
  const r = await call(ADMIN, 'POST', '/leads/bulk/field', { field: 'stage', value: 'Contacted', mode: 'ids', ids });

  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.changed, 2, `changed ${r.body.changed}`);
  assert.deepEqual(stages(ids), ['Contacted', 'Contacted'], 'the stage did not move');
});

await test('Stage is offered only to a role that may change it', async () => {
  const rmOptions = (await call(RM, 'GET', '/leads/bulk/options')).body;
  const adminOptions = (await call(ADMIN, 'GET', '/leads/bulk/options')).body;

  assert(rmOptions.fields.length, 'the RM was offered no fields at all');
  assert(!rmOptions.fields.some((f) => f.key === 'stage'), 'a Sales RM is offered Stage, which the write refuses');
  assert(rmOptions.fields.some((f) => f.key === 'city'), 'a Sales RM is no longer offered City');
  assert(adminOptions.fields.some((f) => f.key === 'stage'), 'an administrator is not offered Stage');
});

/* ------------------------------------------- POST /lists/:id/bulk/field */

await test('a Sales RM cannot set the stage through a list\'s bulk edit', async () => {
  const ids = leads(2, RM.id);
  const list = listOf(RM.id, ids);
  const r = await call(RM, 'POST', `/lists/${list}/bulk/field`, { field: 'stage', value: 'Won' });

  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.required, 'lead.stage.change', `the refusal names ${r.body.required}`);
  assert.deepEqual(stages(ids), ['New', 'New'], 'the stage moved anyway');
});

await test('but can still set an ordinary field through it', async () => {
  const ids = leads(2, RM.id);
  const list = listOf(RM.id, ids);
  const r = await call(RM, 'POST', `/lists/${list}/bulk/field`, { field: 'city', value: 'Pune' });

  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.changed, 2, `changed ${r.body.changed}`);
  assert.deepEqual(ids.map((id) => lead(id).city), ['Pune', 'Pune'], 'the city did not change');
});

await test('a holder of lead.stage.change still sets the stage through a list', async () => {
  const ids = leads(2, ADMIN.id);
  const list = listOf(ADMIN.id, ids);
  const r = await call(ADMIN, 'POST', `/lists/${list}/bulk/field`, { field: 'stage', value: 'Qualified' });

  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.changed, 2, `changed ${r.body.changed}`);
  assert.deepEqual(stages(ids), ['Qualified', 'Qualified'], 'the stage did not move');
});

await test('a list\'s editable fields offer Stage only to a role that may change it', async () => {
  const rmMeta = (await call(RM, 'GET', '/lists/meta')).body;
  const adminMeta = (await call(ADMIN, 'GET', '/lists/meta')).body;

  assert(!rmMeta.bulk_editable.includes('stage'), 'a Sales RM is offered Stage, which the write refuses');
  assert(rmMeta.bulk_editable.includes('city'), 'a Sales RM is no longer offered City');
  assert(adminMeta.bulk_editable.includes('stage'), 'an administrator is not offered Stage');
});

clear();
RM.cleanup();
DEALER.cleanup();
ADMIN.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
