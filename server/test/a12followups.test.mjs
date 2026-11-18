/**
 * A12 (B13, ruled 18 Nov 2026): one rule for a follow-up's Complete and
 * Reschedule -- the rule every task change asks.
 *
 * Rescheduling named four roles; completing asked nobody, so anybody who may
 * contact leads could mark another person's follow-up done: off their list,
 * reminders stopped, and nobody the wiser. Now both ask what /tasks/:id asks:
 * the reader may see the lead, every link is in their books, and they are
 * the assignee, the creator or a team manager (report.team).
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nA12: one rule for completing and rescheduling a follow-up');

const MARK = `A12 probe ${Date.now().toString(36)}`;
const OWNER = await probeAdmin('a12-owner', { role: 'sales_rm', sales_org: 'BONANZA' });
const OTHER = await probeAdmin('a12-other', { role: 'sales_rm', sales_org: 'BONANZA' });
const CALLER = await probeAdmin('a12-caller', { role: 'caller', sales_org: 'BONANZA' });
const ADMIN = await probeAdmin('a12-admin', { role: 'admin', sales_org: 'BONANZA' });

const call = async (who, method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const refused = (r, what) => assert.ok([403, 404].includes(r.status), `${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);

const due = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const lead = await call(OWNER, 'POST', '/leads', { name: MARK, mobile: `9${String(Date.now()).slice(-9)}`, source: 'Manual', route: false });
assert.equal(lead.status, 201, JSON.stringify(lead.body));
const newTask = async (title) => {
  const t = await call(OWNER, 'POST', '/tasks', { title: `${MARK} ${title}`, lead_id: lead.body.id, due_at: `${due} 11:00` });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  return t.body.id;
};
const status = (id) => one('SELECT status, due_at FROM tasks WHERE id = ?', [id]);

try {
  await test('another RM cannot complete or move somebody\'s follow-up', async () => {
    const id = await newTask('theirs');
    const before = status(id);
    refused(await call(OTHER, 'POST', `/activities/follow-ups/${id}/complete`), 'complete');
    refused(await call(OTHER, 'PATCH', `/activities/follow-ups/${id}`, { due_at: `${due} 15:00` }), 'reschedule');
    assert.deepEqual({ ...status(id) }, { ...before }, 'the follow-up changed');
  });

  await test('nor can a Caller, who may contact leads but manages nobody', async () => {
    const id = await newTask('caller');
    refused(await call(CALLER, 'POST', `/activities/follow-ups/${id}/complete`), 'complete');
    assert.equal(status(id).status, 'Open');
  });

  await test('the person it is assigned to completes and moves their own', async () => {
    const moved = await newTask('own move');
    const m = await call(OWNER, 'PATCH', `/activities/follow-ups/${moved}`, { due_at: `${due} 15:00` });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(status(moved).due_at, `${due} 09:30:00`, 'typed as 15:00 India time, stored as UTC (OPS-46)');
    const done = await newTask('own done');
    const d = await call(OWNER, 'POST', `/activities/follow-ups/${done}/complete`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(status(done).status, 'Done');
  });

  await test('a team manager may complete one for the team', async () => {
    const id = await newTask('manager');
    const r = await call(ADMIN, 'POST', `/activities/follow-ups/${id}/complete`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(status(id).status, 'Done');
  });

  await test('a cancelled follow-up stays as it is', async () => {
    const id = await newTask('cancelled');
    const c = await call(OWNER, 'POST', `/tasks/${id}/cancel`, { reason: 'No longer needed' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await call(OWNER, 'POST', `/activities/follow-ups/${id}/complete`)).status, 409);
    assert.equal((await call(OWNER, 'PATCH', `/activities/follow-ups/${id}`, { due_at: `${due} 15:00` })).status, 409);
    assert.equal(status(id).status, 'Cancelled');
  });
} finally {
  run('DELETE FROM reminders WHERE lead_id = ?', [lead.body.id]);
  run('DELETE FROM tasks WHERE lead_id = ?', [lead.body.id]);
  run('DELETE FROM leads WHERE id = ?', [lead.body.id]);
  for (const p of [OWNER, OTHER, CALLER, ADMIN]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
