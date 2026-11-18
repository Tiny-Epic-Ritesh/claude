/**
 * N-12: a write by record id holds the business boundary.
 *
 * Ruled 12 Oct: classify every POST and PATCH that takes a record id, then fix
 * whatever that turns up. On 18 Nov every write route taking a path parameter
 * was driven as a Bigul Admin -- who holds nearly every capability, so a
 * refusal can only be the business rule -- against Bonanza records. These went
 * through, and each is checked here: the attempt is refused, and nothing on
 * the Bonanza record changed. The last group checks that Bonanza's own Admin
 * still can.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { assignToQueue } from '../src/engine/queues.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nN-12: writes by record id hold the business boundary');

const MARK = `N12W probe ${Date.now().toString(36)}`;
const BNZ = await probeAdmin('n12w-bnz', { role: 'admin', sales_org: 'BONANZA' });
const BGL = await probeAdmin('n12w-bgl', { role: 'admin', sales_org: 'BIGUL' });

const call = async (who, method, url, body, extra = {}) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { ...who.headers, ...(extra.headers ?? {}) },
    body: extra.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const refused = (r, what) => assert.ok([403, 404].includes(r.status), `${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);

/* Bonanza records of the test's own, so a missing guard cannot spoil the seed. */
const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const made = await call(BNZ, 'POST', '/leads', { name: MARK, mobile: `9${String(Date.now()).slice(-9)}`, source: 'Manual', route: false });
assert.equal(made.status, 201, JSON.stringify(made.body));
const leadId = made.body.id;
const task = (await call(BNZ, 'POST', '/tasks', { title: `${MARK} follow-up`, lead_id: leadId, due_at: `${due} 11:00` })).body;
const partnerId = one("SELECT id FROM partners WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1").id;
const partnerTask = (await call(BNZ, 'POST', '/tasks', { title: `${MARK} partner task`, partner_id: partnerId, due_at: `${due} 12:00` })).body;
assert.ok(task?.id && partnerTask?.id, 'fixture tasks were not made');

const bonanzaList = one("SELECT id FROM lead_lists WHERE sales_org = 'BONANZA' AND kind = 'static' ORDER BY id LIMIT 1").id;
const bigulList = one("SELECT id FROM lead_lists WHERE sales_org = 'BIGUL' ORDER BY id LIMIT 1")?.id;
const product = one("SELECT id, name FROM product_types WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");
const item = one("SELECT id, name, status FROM content_items WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");
const metric = one("SELECT id, label, active FROM kra_metrics WHERE sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");
const plan = one("SELECT id, name FROM incentive_plans WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");
const queue = one("SELECT id FROM queues WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");
const bigulQueue = one("SELECT id FROM queues WHERE sales_org = 'BIGUL' ORDER BY id LIMIT 1");
const bonanzaUser = one("SELECT id FROM users WHERE sales_org = 'BONANZA' AND role = 'sales_rm' AND active = 1 ORDER BY id LIMIT 1").id;
const queueMembers = () => all('SELECT * FROM queue_members WHERE queue_id = ? ORDER BY 1', [queue.id]);
const membersBefore = queueMembers();
const marked = await call(BNZ, 'POST', '/admin/test-records', { entity: 'lead', record_id: leadId, note: MARK });
assert.equal(marked.status, 201, JSON.stringify(marked.body));
const markId = one("SELECT id FROM test_records WHERE entity = 'lead' AND record_id = ?", [leadId]).id;

try {
  await test('a follow-up on a Bonanza lead cannot be completed or moved from Bigul', async () => {
    refused(await call(BGL, 'POST', `/activities/follow-ups/${task.id}/complete`), 'complete');
    refused(await call(BGL, 'PATCH', `/activities/follow-ups/${task.id}`, { due_at: `${due} 15:00` }), 'reschedule');
    const after = one('SELECT status, due_at FROM tasks WHERE id = ?', [task.id]);
    assert.equal(after.status, 'Open');
    assert.equal(after.due_at, task.due_at);
  });

  await test('a task linked only to a Bonanza partner cannot be changed from Bigul', async () => {
    refused(await call(BGL, 'PATCH', `/tasks/${partnerTask.id}`, { title: 'moved by Bigul' }), 'PATCH /tasks/:id');
    assert.equal(one('SELECT title FROM tasks WHERE id = ?', [partnerTask.id]).title, `${MARK} partner task`);
  });

  await test('a Bonanza lead cannot be put in a queue, nor a queue restaffed, from Bigul', async () => {
    refused(await call(BGL, 'POST', `/queues/${queue.id}/place/${leadId}`), 'place');
    assert.equal(one('SELECT owner_queue_id FROM leads WHERE id = ?', [leadId]).owner_queue_id, null);
    refused(await call(BGL, 'PUT', `/queues/${queue.id}/members`, { roles: [] }), 'members');
    assert.deepEqual(queueMembers(), membersBefore);
  });

  await test('a lead never goes into the other business\'s queue, whoever asks', () => {
    const out = assignToQueue(leadId, bigulQueue.id, { actorId: BNZ.id });
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.equal(one('SELECT owner_queue_id FROM leads WHERE id = ?', [leadId]).owner_queue_id, null);
  });

  await test('a Bonanza KRA metric and incentive plan cannot be changed from Bigul', async () => {
    refused(await call(BGL, 'PATCH', `/kra/config/plans/${plan.id}`, { name: 'changed by Bigul' }), 'plan');
    refused(await call(BGL, 'PATCH', `/kra/config/metrics/${metric.id}`, { label: 'changed by Bigul' }), 'metric edit');
    refused(await call(BGL, 'DELETE', `/kra/config/metrics/${metric.id}`), 'metric retire');
    assert.equal(one('SELECT name FROM incentive_plans WHERE id = ?', [plan.id]).name, plan.name);
    assert.deepEqual({ ...one('SELECT label, active FROM kra_metrics WHERE id = ?', [metric.id]) }, { label: metric.label, active: metric.active });
  });

  await test('Bonanza content cannot be edited, approved or versioned from Bigul', async () => {
    refused(await call(BGL, 'PATCH', `/libraries/items/${item.id}`, { name: 'changed by Bigul' }), 'edit');
    refused(await call(BGL, 'POST', `/libraries/items/${item.id}/status`, { status: 'withdrawn', reason: 'by Bigul' }), 'status');
    refused(await call(BGL, 'POST', `/libraries/items/${item.id}/versions`, { url: 'https://example.invalid/n12' }), 'version');
    assert.deepEqual({ ...one('SELECT name, status FROM content_items WHERE id = ?', [item.id]) }, { name: item.name, status: item.status });
  });

  await test('a Bonanza product and its brochure cannot be changed from Bigul', async () => {
    refused(await call(BGL, 'PATCH', `/admin/products/${product.id}`, { name: 'changed by Bigul' }), 'edit');
    refused(await call(BGL, 'DELETE', `/admin/products/${product.id}/brochure`), 'brochure removal');
    refused(await call(BGL, 'POST', `/admin/products/${product.id}/brochure`, undefined, {
      raw: Buffer.from('%PDF-1.4 n12'), headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'n12.pdf' },
    }), 'brochure upload');
    assert.equal(one('SELECT name FROM product_types WHERE id = ?', [product.id]).name, product.name);
  });

  await test('a Bonanza list cannot be imported into, or copied into, from Bigul', async () => {
    const before = one('SELECT COUNT(*) n FROM lead_list_members WHERE list_id = ?', [bonanzaList]).n;
    refused(await call(BGL, 'POST', `/lists/${bonanzaList}/import`, { values: 'N12PROBE1' }), 'import');
    if (bigulList) {
      refused(await call(BGL, 'POST', `/lists/${bigulList}/bulk/membership`, { target_id: bonanzaList, action: 'add' }), 'copy into');
    }
    assert.equal(one('SELECT COUNT(*) n FROM lead_list_members WHERE list_id = ?', [bonanzaList]).n, before);
  });

  await test('a Bonanza user\'s tabs cannot be read or changed from Bigul', async () => {
    refused(await call(BGL, 'GET', `/setup/users/${bonanzaUser}/tabs`), 'read');
    refused(await call(BGL, 'POST', `/setup/users/${bonanzaUser}/tabs`, { tab_id: 'leads', visible: false }), 'write');
    assert.equal(one("SELECT COUNT(*) n FROM tab_visibility WHERE scope_type = 'user' AND scope_key = ? AND tab_id = 'leads'", [String(bonanzaUser)]).n, 0);
  });

  await test('a test mark on a Bonanza record cannot be removed from Bigul', async () => {
    refused(await call(BGL, 'DELETE', `/admin/test-records/${markId}`), 'unmark');
    assert.ok(one('SELECT id FROM test_records WHERE id = ?', [markId]), 'the mark was removed');
  });

  await test('Bonanza\'s own Admin still can', async () => {
    const done = await call(BNZ, 'POST', `/activities/follow-ups/${task.id}/complete`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const edited = await call(BNZ, 'PATCH', `/admin/products/${product.id}`, { name: product.name });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const tabs = await call(BNZ, 'GET', `/setup/users/${bonanzaUser}/tabs`);
    assert.equal(tabs.status, 200, JSON.stringify(tabs.body));
    const unmarked = await call(BNZ, 'DELETE', `/admin/test-records/${markId}`);
    assert.equal(unmarked.status, 200, JSON.stringify(unmarked.body));
  });
} finally {
  run('DELETE FROM test_records WHERE entity = ? AND record_id = ?', ['lead', leadId]);
  run('DELETE FROM reminders WHERE task_id IN (?, ?)', [task.id, partnerTask.id]);
  run('DELETE FROM tasks WHERE id IN (?, ?)', [task.id, partnerTask.id]);
  run('DELETE FROM leads WHERE id = ?', [leadId]);
  BNZ.cleanup();
  BGL.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
