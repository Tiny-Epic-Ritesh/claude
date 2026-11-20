/**
 * A21 (B27, ruled 20 Nov 2026): every change of a lead's owner takes the
 * previous owner's open tasks on it to the new owner, reminders and all.
 *
 * B26's hand-over did so; the CRM's other ways a lead changes owner did not --
 * a supervisor's Change owner, an approved lead transfer, and a bulk reassign,
 * made alone (from the leads list or a lead list) or approved. Each left the
 * previous owner's open tasks and reminders behind, often on a lead they could
 * no longer open, so a callback promised to the client was reminded to
 * somebody who could not act on it.
 *
 * For each door: the previous owner's open task on the lead moves, and its
 * reminders are re-planned for the new owner; their finished task, other
 * people's tasks on the lead, and their tasks on other leads stay where they
 * are; and the door says what moved.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { scheduleReminders } from '../src/engine/followups.js';
import { request } from '../src/engine/approvals.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stamp = String(Date.now()).slice(-7);
const MARK = `Owner tasks ${stamp}`;
const probes = [];
const probe = async (slug, role, extra = {}) => {
  const p = await probeAdmin(`ot-${slug}`, { role, sales_org: 'BONANZA' });
  const sets = Object.keys(extra);
  if (sets.length) run(`UPDATE users SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...sets.map((k) => extra[k]), p.id]);
  probes.push(p);
  return p;
};
const at = (modifier) => one("SELECT datetime('now', ?) t", [modifier]).t;
const leads = [];
const made = [];
let n = 0;
const task = (leadId, who, status = 'Open', title = 'task') => Number(run(
  'INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status) VALUES (?,?,?,?,?,?)',
  [`${MARK} ${title}`, leadId, who.id, who.id, at('+1 days'), status],
).lastInsertRowid);

/** A lead owned by `owner`, with the four tasks every door is checked against. */
function setUp(owner, OTHER) {
  n += 1;
  const lead = Number(run(
    "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id) VALUES ('BONANZA', ?, ?, 'Referral', 'Qualified', ?)",
    [`${MARK} lead ${n}`, `91${stamp}${n}`.slice(0, 10), owner.id],
  ).lastInsertRowid);
  const elsewhere = Number(run(
    "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id) VALUES ('BONANZA', ?, ?, 'Referral', 'Qualified', ?)",
    [`${MARK} other lead ${n}`, `90${stamp}${n}`.slice(0, 10), owner.id],
  ).lastInsertRowid);
  leads.push(lead, elsewhere);
  const open = task(lead, owner, 'Open', `callback ${n}`);
  scheduleReminders({ taskId: open, leadId: lead, userId: owner.id, dueAt: at('+1 days'), detail: `${MARK} callback ${n}` });
  return {
    lead,
    open,
    done: task(lead, owner, 'Done', `done ${n}`),
    theirs: task(lead, OTHER, 'Open', `someone else's ${n}`),
    elsewhere: task(elsewhere, owner, 'Open', `another lead ${n}`),
  };
}

const holder = (id) => one('SELECT assignee_id FROM tasks WHERE id = ?', [id]).assignee_id;
/** The previous owner's open task moved, reminders and all; nothing else did. */
function movedOnly(t, from, to, OTHER) {
  assert.equal(holder(t.open), to.id, 'the previous owner\'s open task on the lead stayed with them');
  const pending = all("SELECT user_id FROM reminders WHERE task_id = ? AND status = 'Pending'", [t.open]);
  assert.ok(pending.length && pending.every((r) => r.user_id === to.id), `its reminders still go to the previous owner: ${JSON.stringify(pending)}`);
  assert.equal(holder(t.done), from.id, 'a finished task moved');
  assert.equal(holder(t.theirs), OTHER.id, 'somebody else\'s task on the lead moved');
  assert.equal(holder(t.elsewhere), from.id, 'a task on another lead moved');
  const audited = one("SELECT detail FROM audit_log WHERE action = 'lead_tasks_moved' AND entity_id = ? ORDER BY id DESC LIMIT 1", [t.lead]);
  assert.ok(audited && JSON.parse(audited.detail).tasks.includes(t.open), 'the move is not audited');
}

console.log('\nA21: every change of owner takes the previous owner\'s open tasks (B27)');

try {
  const ADMIN = await probe('admin', 'admin');
  const SUP = await probe('sup', 'sales_supervisor');
  const A = await probe('a', 'sales_rm', { manager_id: SUP.id });
  const B = await probe('b', 'sales_rm', { manager_id: SUP.id });
  const OTHER = await probe('other', 'sales_rm', { manager_id: SUP.id });

  await test('Change owner: the previous owner\'s open task on the lead goes to the new owner, and it says so', async () => {
    const t = setUp(A, OTHER);
    const res = await as(SUP)('PATCH', `/leads/${t.lead}`, { owner_id: B.id });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    movedOnly(t, A, B, OTHER);
    assert.deepEqual((res.body.tasks_moved ?? []).map((x) => x.id), [t.open], `it does not say what moved: ${JSON.stringify(res.body.tasks_moved)}`);
  });

  await test('Change owner to nobody moves nothing', async () => {
    const t = setUp(A, OTHER);
    const res = await as(SUP)('PATCH', `/leads/${t.lead}`, { owner_id: '' });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(holder(t.open), A.id, 'a task moved to nobody');
    assert.equal(res.body.tasks_moved, undefined);
  });

  await test('an approved lead transfer: the task goes too, and the previous owner is told', async () => {
    const t = setUp(A, OTHER);
    const asked = request({
      scope: 'lead_transfer', entityId: t.lead, subjectName: B.name ?? 'Probe ot-b',
      payload: { from_owner_id: A.id, to_user_id: B.id, lead_name: `${MARK} lead` },
      reason: `${MARK}: I spoke to the client last week`, requestedBy: B.id, targetUserId: A.id,
    });
    assert.ok(asked.ok, `could not ask: ${asked.error}`);
    made.push(['approvals', asked.request.id]);
    const res = await as(SUP)('POST', `/approvals/${asked.request.id}/decide`, { approve: true });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(one('SELECT owner_id FROM leads WHERE id = ?', [t.lead]).owner_id, B.id);
    movedOnly(t, A, B, OTHER);
    assert.equal(res.body.applied?.tasks_moved, 1, `the decision does not say what moved: ${JSON.stringify(res.body.applied)}`);
    assert.ok(one("SELECT id FROM notifications WHERE user_id = ? AND title LIKE 'Lead transferred%' AND body LIKE '%open task on it went with it%'", [A.id]),
      'the previous owner is not told their task went');
  });

  await test('a bulk reassign from the leads list: each lead\'s previous owner\'s open tasks go with it', async () => {
    const t = setUp(A, OTHER);
    const res = await as(SUP)('POST', '/leads/bulk/field', { field: 'owner_id', value: B.id, mode: 'ids', ids: [t.lead] });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.changed, 1);
    movedOnly(t, A, B, OTHER);
    assert.equal(res.body.tasks_moved, 1, `it does not say what moved: ${JSON.stringify(res.body)}`);
  });

  await test('a bulk reassign from a lead list: the same', async () => {
    const t = setUp(A, OTHER);
    const list = Number(run("INSERT INTO lead_lists (name, kind, owner_id) VALUES (?, 'static', ?)", [`${MARK} list`, SUP.id]).lastInsertRowid);
    made.push(['lead_lists', list]);
    run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list, t.lead]);
    const res = await as(SUP)('POST', `/lists/${list}/bulk/reassign`, { owner_id: B.id });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.moved, 1, `moved ${res.body.moved}`);
    movedOnly(t, A, B, OTHER);
    assert.equal(res.body.tasks_moved, 1, `it does not say what moved: ${JSON.stringify(res.body)}`);
  });

  await test('an approved bulk reassign: the same, and the decision says so', async () => {
    const t = setUp(A, OTHER);
    const asked = request({
      scope: 'bulk_reassign', entityId: B.id, subjectName: B.name ?? 'Probe ot-b',
      payload: { lead_ids: [t.lead], owner_id: B.id }, reason: `${MARK}: rebalancing the desk`, requestedBy: SUP.id,
    });
    assert.ok(asked.ok, `could not ask: ${asked.error}`);
    made.push(['approvals', asked.request.id]);
    const res = await as(ADMIN)('POST', `/approvals/${asked.request.id}/decide`, { approve: true });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    movedOnly(t, A, B, OTHER);
    assert.equal(res.body.applied?.tasks_moved, 1, `the decision does not say what moved: ${JSON.stringify(res.body.applied)}`);
  });
} finally {
  for (const [table, id] of [...made].reverse()) run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  for (const id of leads) {
    run('DELETE FROM notifications WHERE link = ?', [`/leads/${id}`]);
    for (const t of all('SELECT id FROM tasks WHERE lead_id = ?', [id])) run("DELETE FROM field_history WHERE entity = 'task' AND record_id = ?", [t.id]);
    run("DELETE FROM field_history WHERE entity = 'lead' AND record_id = ?", [id]);
    run("DELETE FROM audit_log WHERE entity = 'lead' AND entity_id = ?", [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  run("DELETE FROM notifications WHERE body LIKE ?", [`%${MARK}%`]);
  if (probes.length) run(`UPDATE users SET manager_id = NULL WHERE id IN (${probes.map(() => '?').join(',')})`, probes.map((p) => p.id));
  for (const p of [...probes].reverse()) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
