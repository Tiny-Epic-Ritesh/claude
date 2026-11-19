/**
 * A3: what re-reading the write actions found (OPS-47 to OPS-54, and on).
 *
 * The eight defects found on 16 Oct reading the 283 write actions for Part 4
 * item 8.4 were ruled to be fixed one commit each and never written down.
 * On 19 Nov the same 283 calls were read again, each with the server code
 * that answers it, asking what actually happens. Each check here is one
 * defect, driven as the screen or the API drives it, and expects the right
 * behaviour: each failed before its fix.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { createFollowUp, sweepReminders } from '../src/engine/followups.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const made = [];
const make = (table, cols) => {
  const keys = Object.keys(cols);
  const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols)).lastInsertRowid);
  made.push([table, id]);
  return id;
};
const stamp = String(Date.now()).slice(-6);
let serial = 0;
const mobile = () => { serial += 1; return `8${stamp}${String(serial).padStart(3, '0')}`; };
const lead = (extra = {}) => make('leads', {
  name: 'A3 probe', mobile: mobile(), source: 'Referral', stage: 'New', sales_org: 'BONANZA', ...extra,
});

const call = async (who, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
};

const ADMIN = await probeAdmin('a3-admin', { role: 'admin', sales_org: 'BONANZA' });
const BOTH = await probeAdmin('a3-both', { role: 'admin', sales_org: 'BONANZA' });
run('UPDATE users SET org_access = ? WHERE id = ?', ['["BONANZA","BIGUL"]', BOTH.id]);
const RM = await probeAdmin('a3-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const BIGUL_RM = await probeAdmin('a3-bigul-rm', { role: 'sales_rm', sales_org: 'BIGUL' });
const probes = [ADMIN, BOTH, RM, BIGUL_RM];
const inAnHour = () => one("SELECT datetime('now', '+1 hour') t").t;

console.log('\nA3: defects found re-reading the write actions');

try {
  // checks are added with their fixes, one commit each
  await test('an email from a lead goes to its email address, a WhatsApp to its mobile', async () => {
    const number = mobile();
    const a = lead({ mobile: number, email: `a3-${stamp}@example.in`, owner_id: ADMIN.id, marketing_opt_out: 0 });
    const email = await call(ADMIN, 'POST', `/api/leads/${a}/message`, { channel: 'email', subject: 'A3 probe', body: 'A3 probe', intent: 'service' });
    assert.equal(email.status, 201, `email: HTTP ${email.status} ${JSON.stringify(email.body).slice(0, 120)}`);
    assert.equal(email.body.to, `a3-${stamp}@example.in`, `the email was addressed to ${email.body.to}`);
    const wa = await call(ADMIN, 'POST', `/api/leads/${a}/message`, { channel: 'whatsapp', body: 'A3 probe', intent: 'service' });
    assert.equal(wa.status, 201, `whatsapp: HTTP ${wa.status} ${JSON.stringify(wa.body).slice(0, 120)}`);
    assert.equal(wa.body.to, number, `the WhatsApp was addressed to ${wa.body.to}`);
    const noMobile = lead({ mobile: null, email: `a3b-${stamp}@example.in`, owner_id: ADMIN.id });
    const sms = await call(ADMIN, 'POST', `/api/leads/${noMobile}/message`, { channel: 'sms', body: 'A3 probe', intent: 'service' });
    assert.notEqual(sms.body?.to, `a3b-${stamp}@example.in`, 'an SMS was addressed to an email address');
  });

  await test('editing a follow-up\'s time or person moves its reminders and the lead\'s next follow-up', async () => {
    const a = lead({ owner_id: ADMIN.id });
    const task = createFollowUp({ leadId: a, userId: ADMIN.id, kind: 'follow_up', dueAt: inAnHour(), note: 'A3 probe', respectHours: false });
    made.push(['tasks', task.id]);
    const out = await call(ADMIN, 'PATCH', `/api/tasks/${task.id}`, { due_at: '2026-12-02 15:00', assignee_id: ADMIN2().id });
    assert.equal(out.status, 200, `HTTP ${out.status} ${JSON.stringify(out.body).slice(0, 120)}`);
    const now = one('SELECT due_at FROM tasks WHERE id = ?', [task.id]).due_at;
    const pending = all("SELECT user_id, due_at FROM reminders WHERE task_id = ? AND status = 'Pending'", [task.id]);
    assert.ok(pending.length, 'no reminders are waiting for the new time');
    const earliest = pending.map((r) => r.due_at).sort()[0];
    assert.ok(pending.every((r) => r.due_at > inAnHour()) && earliest <= now,
      `reminders still at the old time: ${pending.map((r) => r.due_at).join(', ')} for a task due ${now}`);
    assert.ok(pending.every((r) => r.user_id === ADMIN2().id), 'reminders still go to the person it was taken from');
    assert.equal(one('SELECT next_follow_up_at FROM leads WHERE id = ?', [a]).next_follow_up_at, now, 'the lead\'s next follow-up is still the old time');
    await call(ADMIN, 'PATCH', `/api/tasks/${task.id}`, { status: 'Done' });
    assert.equal(one('SELECT next_follow_up_at FROM leads WHERE id = ?', [a]).next_follow_up_at, null, 'a done follow-up is still the lead\'s next one');
  });

  await test('reminders for a task on a lead in the recycle bin do not go out', () => {
    const binned = lead({ owner_id: ADMIN.id });
    const task = createFollowUp({ leadId: binned, userId: ADMIN.id, kind: 'follow_up', dueAt: one("SELECT datetime('now', '-1 hour') t").t, note: 'A3 probe', respectHours: false });
    made.push(['tasks', task.id]);
    run("UPDATE reminders SET due_at = datetime('now', '-1 minute') WHERE task_id = ?", [task.id]);
    run("UPDATE leads SET deleted_at = datetime('now') WHERE id = ?", [binned]);
    const before = one('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND link = ?', [ADMIN.id, `/leads/${binned}`]).n;
    sweepReminders();
    const after = one('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND link = ?', [ADMIN.id, `/leads/${binned}`]).n;
    assert.equal(after, before, 'a reminder rang for a follow-up on a lead in the bin');
    const left = one("SELECT COUNT(*) n FROM reminders WHERE task_id = ? AND status = 'Pending'", [task.id]).n;
    assert.equal(left, 0, `${left} reminder(s) still waiting to go out`);
  });

  await test('a note mentions only people who may open its lead', async () => {
    const a = lead({ owner_id: ADMIN.id });
    const out = await call(ADMIN, 'POST', '/api/notes', { lead_id: a, body: 'A3 private note about the client', mentions: [BIGUL_RM.id] });
    if (out.status === 201) made.push(['notes', out.body.id]);
    const told = one("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND body LIKE 'A3 private note%'", [BIGUL_RM.id]).n;
    assert.equal(told, 0, 'someone in the other business was sent the note');
  });

  await test('a case links only records from its own business', async () => {
    const a = lead({ owner_id: ADMIN.id });
    const partner = make('partners', { name: 'A3 Bigul partner', sales_org: 'BIGUL', state_code: 'ACTIVE' });
    const out = await call(ADMIN, 'POST', '/api/tickets', { subject: 'A3 probe', lead_id: a, partner_id: partner });
    if (out.status === 201) made.push(['tickets', out.body.id]);
    assert.ok([400, 403, 404].includes(out.status), `a Bonanza case was linked to a Bigul partner: HTTP ${out.status}`);
  });
} finally {
  for (const [table, id] of [...made].reverse()) {
    try { run(`DELETE FROM ${table} WHERE id = ?`, [id]); } catch { /* removed with its parent */ }
  }
  for (const p of probes) p.cleanup();
}

function ADMIN2() {
  ADMIN2.row ??= one("SELECT id FROM users WHERE role = 'admin' AND sales_org = 'BONANZA' AND active = 1 AND email NOT LIKE 'probe-%' ORDER BY id LIMIT 1");
  return ADMIN2.row;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
