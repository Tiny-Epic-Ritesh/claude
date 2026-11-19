/**
 * A17 (B23, ruled 19 Nov): what a retention purge takes with a lead.
 *
 *   cases     a lead a case names -- directly, or through one of its product
 *             interests -- is not purged, however long it has been untouched,
 *             and the recycle bin says which and why. A case is never deleted
 *             (QA-37, 14 Oct); the purge used to delete them with the lead,
 *             open ones included (OPS-71)
 *   tasks     go with the lead, as they always have
 *   history   the field history and custom field values of the lead, its
 *             product interests, its tasks and its interactions go in the same
 *             step (OPS-70, OPS-72). Both name a record by type and number,
 *             not by a link, so the cascade never reached them
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const ADMIN = await probeAdmin('purge-admin', { role: 'admin', sales_org: 'BONANZA' });
const as = async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: ADMIN.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stamp = String(Date.now()).slice(-6);
const MARK = `Purge probe ${stamp}`;
const made = [];
const insert = (table, cols) => {
  const keys = Object.keys(cols);
  const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols)).lastInsertRowid);
  made.push([table, id]);
  return id;
};
const LONG_AGO = "datetime('now', '-5 years')";
/** A Bonanza lead in the bin, untouched for five years, never an account: past any retention the policy allows. */
const expired = (label) => {
  const id = Number(run(
    `INSERT INTO leads (sales_org, name, source, stage, created_at, updated_at, deleted_at)
     VALUES ('BONANZA', ?, 'Website', 'New', ${LONG_AGO}, ${LONG_AGO}, datetime('now', '-4 years'))`,
    [`${MARK} ${label}`],
  ).lastInsertRowid);
  made.push(['leads', id]);
  return id;
};
let serial = 0;
const caseOn = (cols) => {
  serial += 1;
  return insert('tickets', { ref: `BNZ-PG${stamp}${serial}`, subject: `${MARK} case`, sales_org: 'BONANZA', ...cols });
};
const product = one('SELECT id FROM product_types ORDER BY id LIMIT 1').id;
const cardOf = (lead) => insert('product_cards', { lead_id: lead, product_type_id: product });
const fieldOf = (entity) => one('SELECT id FROM field_def WHERE entity = ? ORDER BY is_custom DESC, id LIMIT 1', [entity]).id;
const history = (entity, recordId) => insert('field_history', {
  entity, record_id: recordId, field: 'probe', old_value: 'before', new_value: 'after', source: 'ui',
});
const value = (entity, recordId) => run(
  'INSERT INTO field_value (entity, record_id, field_id, text_value) VALUES (?,?,?,?)',
  [entity, recordId, fieldOf(entity), `${MARK} value`],
);
const left = (table, entity, recordId) => one(
  `SELECT COUNT(*) n FROM ${table} WHERE entity = ? AND record_id = ?`, [entity, recordId],
).n;

console.log('\nA17: what a retention purge takes with a lead (B23)');

try {
  // A closed complaint on the lead itself, and an open one on its product interest only.
  const withCase = expired('with a case');
  const closedCase = caseOn({ lead_id: withCase, status: 'Closed', created_at: "2021-01-04 10:00:00", updated_at: "2021-01-05 10:00:00" });
  const withCardCase = expired('with a case on its product interest');
  const openCase = caseOn({ lead_id: null, card_id: cardOf(withCardCase), status: 'Open' });
  const plain = expired('with nothing on it');

  await test('a lead a case names is kept, however long untouched, and the recycle bin says why', async () => {
    const res = await as('GET', '/recycle-bin/purgeable');
    assert.equal(res.status, 200, `HTTP ${res.status}`);
    const purgeable = res.body.leads.map((l) => l.id);
    assert(purgeable.includes(plain), 'a lead past its retention with no case is not offered for erasure');
    assert(!purgeable.includes(withCase), 'a lead with a closed case on it is offered for erasure');
    assert(!purgeable.includes(withCardCase), 'a lead with an open case on its product interest is offered for erasure');
    const kept = Object.fromEntries((res.body.kept ?? []).map((l) => [l.id, l.cases]));
    const refOf = (id) => one('SELECT ref FROM tickets WHERE id = ?', [id]).ref;
    assert.deepEqual(kept[withCase], [refOf(closedCase)], `the bin does not say the case keeps it: ${JSON.stringify(res.body.kept)}`);
    assert.deepEqual(kept[withCardCase], [refOf(openCase)], 'the bin does not say the product interest\'s case keeps it');
  });

  await test('a purge refuses a lead a case names, and its case stays', async () => {
    const res = await as('POST', '/recycle-bin/purge', { reason: `${MARK} retention run out`, confirm: 'PURGE', ids: [withCase, withCardCase] });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.deepEqual(res.body.ids, [], `it erased ${JSON.stringify(res.body.ids)}`);
    assert.deepEqual(res.body.refused.sort(), [withCase, withCardCase].sort(), 'the leads kept for their cases were not reported as refused');
    for (const id of [withCase, withCardCase]) assert(one('SELECT id FROM leads WHERE id = ?', [id]), `lead ${id} was erased`);
    for (const id of [closedCase, openCase]) assert(one('SELECT id FROM tickets WHERE id = ?', [id]), `case ${id} was erased`);
  });

  await test('a purge erases the history and custom fields of the lead and of everything that goes with it', async () => {
    const card = cardOf(plain);
    const task = insert('tasks', { title: `${MARK} call back`, lead_id: plain, status: 'Open', due_at: '2021-01-10 10:00:00', created_at: '2021-01-04 10:00:00' });
    const cardTask = insert('tasks', { title: `${MARK} card task`, lead_id: plain, card_id: card, status: 'Open', due_at: '2021-01-10 10:00:00', created_at: '2021-01-04 10:00:00' });
    const call = insert('activities', { lead_id: plain, type: 'Call', direction: 'outbound', subject: `${MARK} call`, created_at: '2021-01-04 10:00:00' });
    const goes = [['lead', plain], ['product_interest', card], ['task', task], ['task', cardTask], ['interaction', call]];
    for (const [entity, id] of goes) { history(entity, id); value(entity, id); }
    // Another lead's history and values are not this purge's to touch.
    const other = { lead: withCase };
    history('lead', other.lead);
    value('lead', other.lead);

    const res = await as('POST', '/recycle-bin/purge', { reason: `${MARK} retention run out`, confirm: 'PURGE', ids: [plain] });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.deepEqual(res.body.ids, [plain], `it erased ${JSON.stringify(res.body.ids)}`);
    for (const [entity, id] of goes) {
      assert.equal(left('field_history', entity, id), 0, `the ${entity}'s field history outlived the purge`);
      assert.equal(left('field_value', entity, id), 0, `the ${entity}'s custom field values outlived the purge`);
    }
    assert.equal(left('field_history', 'lead', other.lead), 1, 'another lead\'s history was erased');
    assert.equal(left('field_value', 'lead', other.lead), 1, 'another lead\'s custom field values were erased');
  });

  await test('a purge still takes the lead\'s tasks with it, as ruled', async () => {
    assert.equal(one('SELECT COUNT(*) n FROM tasks WHERE lead_id = ? OR title LIKE ?', [plain, `${MARK}%`]).n, 0, 'a task outlived its lead');
  });

  await test('the recycle bin shows what is kept and why (source check)', async () => {
    const screen = fs.readFileSync(path.join(CLIENT, 'crm/DataTools.jsx'), 'utf8');
    assert(/function KeptForCases/.test(screen) && /<KeptForCases kept=\{data\.kept\} \/>/.test(screen), 'the purge panel does not show kept leads');
    assert(/because a case names/.test(screen), 'the purge panel does not say why a lead is kept');
  });
} finally {
  for (const [table, id] of [...made].reverse()) {
    try { run(`DELETE FROM ${table} WHERE id = ?`, [id]); } catch { /* gone with its parent */ }
  }
  run('DELETE FROM field_value WHERE text_value = ?', [`${MARK} value`]);
  run("DELETE FROM field_history WHERE field = 'probe' AND old_value = 'before' AND new_value = 'after'");
  ADMIN.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
