/**
 * QA-37, batch 4: automation rules and flows, as accepted on 13 Oct.
 *
 *   Rename, edit; a new version once it has run. Switch off; archive once it
 *   has run. Delete only a draft never switched on. Admin.
 *
 * "Switched on" is kept by database triggers, so a rule enabled by any door
 * -- the screen, a rollback, a migration, a direct update -- can never again
 * pass for a draft. A flow that has run changes by new versions, and each
 * lead's run records the version it went through.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { enter } from '../src/engine/automation.js';
import { snapshot } from '../src/engine/versioning.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
const source = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-37 lifecycle: automation rules and flows');

const RUN = Date.now().toString(36);
const MARK = `LC4 probe ${RUN}`;

const ADMIN = await probeAdmin('lc4-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('lc4-bigul', { role: 'admin', sales_org: 'BIGUL' });
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const makeRule = (label, enabled = 0) => Number(run(
  `INSERT INTO rules (name, conditions, actions, enabled)
   VALUES (?, '[{"field":"stage","op":"eq","value":"Nobody-${RUN}"}]', '[{"type":"task","params":{"title":"x"}}]', ?)`,
  [`${MARK} ${label}`, enabled],
).lastInsertRowid);
const rule = (id) => one('SELECT * FROM rules WHERE id = ?', [id]);

const makeFlow = (label) => {
  const id = Number(run(
    "INSERT INTO automation (name, sales_org, trigger_type, status) VALUES (?, 'BONANZA', 'lead.created', 'draft')",
    [`${MARK} ${label}`],
  ).lastInsertRowid);
  const wait = Number(run("INSERT INTO automation_step (automation_id, kind, config, label, sort_order) VALUES (?, 'wait', '{\"hours\":24}', 'wait', 0)", [id]).lastInsertRowid);
  const exit = Number(run("INSERT INTO automation_step (automation_id, kind, config, label, sort_order) VALUES (?, 'exit', '{}', 'exit', 1)", [id]).lastInsertRowid);
  run('UPDATE automation_step SET next_step_id = ? WHERE id = ?', [exit, wait]);
  run('UPDATE automation SET first_step_id = ? WHERE id = ?', [wait, id]);
  return { id, wait, exit };
};
const flow = (id) => one('SELECT * FROM automation WHERE id = ?', [id]);
const lead = Number(run("INSERT INTO leads (sales_org, name, source, stage) VALUES ('BONANZA', ?, 'Website', 'New')", [`${MARK} lead`]).lastInsertRowid);

try {
  /* ------------------------------------------------------------- rules */

  await test('a rule never switched on is deleted, with its name typed', async () => {
    const r = makeRule('draft');
    assert.equal(rule(r).first_enabled_at, null);
    assert.equal((await as(ADMIN)('DELETE', `/admin/rules/${r}`)).status, 400, 'deleted without the name typed');
    const res = await as(ADMIN)('DELETE', `/admin/rules/${r}`, { confirm_name: `${MARK} draft` });
    assert.equal(res.status, 200, `delete answered ${res.status}: ${res.body?.error}`);
    assert.equal(rule(r), undefined);
  });

  await test('switched on once by any door, a rule is never again a draft', async () => {
    const viaScreen = makeRule('screen');
    assert.equal((await as(ADMIN)('PATCH', `/admin/rules/${viaScreen}`, { enabled: 1 })).status, 200);
    assert(rule(viaScreen).first_enabled_at, 'switching it on was not recorded');
    assert.equal((await as(ADMIN)('PATCH', `/admin/rules/${viaScreen}`, { enabled: 0 })).status, 200);
    assert(rule(viaScreen).first_enabled_at, 'switching it off erased the record');
    const refused = await as(ADMIN)('DELETE', `/admin/rules/${viaScreen}`, { confirm_name: `${MARK} screen` });
    assert.equal(refused.status, 409, `a rule that had been on was deleted: HTTP ${refused.status}`);
    assert.equal(refused.body.archive_instead, true);

    const direct = makeRule('direct');
    run('UPDATE rules SET enabled = 1 WHERE id = ?', [direct]);
    assert(rule(direct).first_enabled_at, 'a direct update switched it on unrecorded');
    assert(rule(makeRule('born-on', 1)).first_enabled_at, 'a rule created switched on was unrecorded');
  });

  await test('a rule is switched off before it is archived; archived, it is read-only until restored', async () => {
    const r = makeRule('archive', 1);
    assert.equal((await as(ADMIN)('POST', `/admin/rules/${r}/archive`, { reason: 'Replaced by a flow' })).status, 409, 'a live rule was archived');
    run('UPDATE rules SET enabled = 0 WHERE id = ?', [r]);
    assert.equal((await as(ADMIN)('POST', `/admin/rules/${r}/archive`, { reason: '' })).status, 400, 'archived with no reason');
    const res = await as(ADMIN)('POST', `/admin/rules/${r}/archive`, { reason: 'Replaced by a flow' });
    assert.equal(res.status, 200, `archive answered ${res.status}: ${res.body?.error}`);
    assert.equal(rule(r).archived_by, ADMIN.id);

    assert.equal((await as(ADMIN)('PATCH', `/admin/rules/${r}`, { enabled: 1 })).status, 409, 'an archived rule was switched on');
    assert.equal((await as(ADMIN)('PATCH', `/admin/rules/${r}`, { name: 'renamed' })).status, 409);
    assert.equal((await as(ADMIN)('POST', `/admin/rules/${r}/run`, { dry_run: false })).status, 409, 'an archived rule was run for real');
    assert.equal((await as(ADMIN)('POST', `/admin/rules/${r}/run`, { dry_run: true })).status, 200, 'a dry run of an archived rule was refused');

    const v = snapshot('rule', r, { note: 'probe' });
    const rollback = await as(ADMIN)('POST', `/admin/versions/${v.id}/restore`);
    assert.equal(rollback.status, 409, 'a rollback switched an archived rule back on');
    assert.equal(rule(r).enabled, 0);

    assert.equal((await as(ADMIN)('POST', `/admin/rules/${r}/restore`)).status, 200);
    assert.equal(rule(r).archived_at, null);
    assert.equal((await as(ADMIN)('PATCH', `/admin/rules/${r}`, { name: `${MARK} back` })).status, 200, 'a restored rule is still frozen');
  });

  /* ------------------------------------------------------------- flows */

  await test('a flow never switched on is deleted, with its name typed', async () => {
    const f = makeFlow('draft');
    assert.equal((await as(ADMIN)('DELETE', `/admin/automations/${f.id}`)).status, 400, 'deleted without the name typed');
    const res = await as(ADMIN)('DELETE', `/admin/automations/${f.id}`, { confirm_name: `${MARK} draft` });
    assert.equal(res.status, 200, `delete answered ${res.status}: ${res.body?.error}`);
    assert.equal(flow(f.id), undefined);
  });

  await test('once it has run, a flow changes by new versions, and each run says which one it went through', async () => {
    const f = makeFlow('versions');
    const on = await as(ADMIN)('POST', `/admin/automations/${f.id}/activate`);
    assert.equal(on.status, 200, `activate answered ${on.status}: ${JSON.stringify(on.body)}`);
    assert(flow(f.id).first_activated_at, 'switching it on was not recorded');
    assert.equal(one('SELECT COUNT(*) n FROM automation_versions WHERE automation_id = ?', [f.id]).n, 1, 'switching it on recorded no version');

    enter(f.id, lead);
    assert.equal(one('SELECT flow_version FROM automation_run WHERE automation_id = ? AND lead_id = ?', [f.id, lead]).flow_version, 1);

    /* Moving a card or renaming the flow is not a new version of what leads go through. */
    assert.equal((await as(ADMIN)('PATCH', `/admin/automations/${f.id}`, { name: `${MARK} versions renamed` })).status, 200);
    assert.equal(flow(f.id).version, 1, 'a rename made a new version');

    const edit = await as(ADMIN)('PATCH', `/admin/automations/${f.id}/steps/${f.wait}`, { config: { hours: 48 } });
    assert.equal(edit.status, 200, `edit answered ${edit.status}: ${JSON.stringify(edit.body)}`);
    assert.equal(flow(f.id).version, 2, 'changing a card made no new version');
    const versions = (await as(ADMIN)('GET', `/admin/automations/${f.id}/versions`)).body;
    assert.deepEqual(versions.map((v) => v.version), [2, 1]);
    const waitIn = (v) => JSON.parse(v.definition.steps.find((s) => s.id === f.wait).config).hours;
    assert.equal(waitIn(versions[1]), 24, 'version 1 no longer says what its leads went through');
    assert.equal(waitIn(versions[0]), 48);
    assert.equal(versions[1].runs, 1, 'the run is not counted against the version it went through');
  });

  await test('a flow that has run is archived, not deleted; paused first; read-only until restored', async () => {
    const f = makeFlow('archive');
    assert.equal((await as(ADMIN)('POST', `/admin/automations/${f.id}/activate`)).status, 200);
    const refused = await as(ADMIN)('DELETE', `/admin/automations/${f.id}`, { confirm_name: `${MARK} archive` });
    assert.equal(refused.status, 409, `a flow that had run was deleted: HTTP ${refused.status}`);
    assert.equal(refused.body.archive_instead, true);
    assert.equal((await as(ADMIN)('POST', `/admin/automations/${f.id}/archive`, { reason: 'Superseded by v2 journey' })).status, 409, 'a running flow was archived');

    assert.equal((await as(ADMIN)('POST', `/admin/automations/${f.id}/pause`)).status, 200);
    assert.equal((await as(ADMIN)('POST', `/admin/automations/${f.id}/archive`, { reason: 'no' })).status, 400, 'archived with no reason');
    const res = await as(ADMIN)('POST', `/admin/automations/${f.id}/archive`, { reason: 'Superseded by v2 journey' });
    assert.equal(res.status, 200, `archive answered ${res.status}: ${res.body?.error}`);

    for (const [method, url, body] of [
      ['PATCH', `/admin/automations/${f.id}`, { name: 'renamed' }],
      ['POST', `/admin/automations/${f.id}/activate`],
      ['PATCH', `/admin/automations/${f.id}/steps/${f.wait}`, { config: { hours: 1 } }],
      ['POST', `/admin/automations/${f.id}/steps`, { kind: 'exit', config: {} }],
    ]) {
      const r = await as(ADMIN)(method, url, body);
      assert.equal(r.status, 409, `${method} ${url.replace(String(f.id), ':id')} changed an archived flow: HTTP ${r.status}`);
    }
    assert.equal((await as(BIGUL)('POST', `/admin/automations/${f.id}/restore`)).status, 403, 'the other business restored it');
    assert.equal((await as(ADMIN)('POST', `/admin/automations/${f.id}/restore`)).status, 200);
    assert.equal(flow(f.id).archived_at, null);
    assert.equal(flow(f.id).status, 'paused', 'restoring switched it back on');
  });

  await test('the screens offer it: archive, restore, delete only for a draft (source check)', async () => {
    const rules = source('crm/admin/Rules.jsx');
    assert(/\/archive`/.test(rules) && /\/restore`/.test(rules) && /first_enabled_at/.test(rules));
    const autos = source('crm/admin/Automations.jsx');
    assert(/\/archive`/.test(autos) && /\/restore`/.test(autos) && /first_activated_at/.test(autos));
    assert(/confirm_name: typed/.test(source('components/Lifecycle.jsx')));
  });
} finally {
  run('DELETE FROM automation_run WHERE lead_id = ?', [lead]);
  run('DELETE FROM automation WHERE name LIKE ?', [`${MARK}%`]);
  run("DELETE FROM artefact_versions WHERE kind = 'rule' AND logical_id IN (SELECT CAST(id AS TEXT) FROM rules WHERE name LIKE ?)", [`${MARK}%`]);
  run('DELETE FROM rules WHERE name LIKE ?', [`${MARK}%`]);
  run('DELETE FROM leads WHERE id = ?', [lead]);
  for (const p of [ADMIN, BIGUL]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
