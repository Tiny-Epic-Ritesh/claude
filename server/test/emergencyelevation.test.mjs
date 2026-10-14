/**
 * QA-33 -- a Superadmin's emergency activation of a partner, audited.
 *
 * The auditor saw a Superadmin make a 0-of-8 prospect ACTIVE in one click.
 * 84c2c2f closed that door for everyone. Ruled 13 Oct: a Superadmin may still
 * do it when it cannot wait, but never quietly -- asked for by name, with a
 * reason, recorded on the partner and in the audit trail, told to the
 * business's Admins, and the unfinished steps left open with a task to finish
 * them.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { can } from '../src/auth.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-33 — a Superadmin\'s emergency activation, audited');

const RUN = String(Date.now()).slice(-6);
const MARK = `EE probe ${RUN}`;

const SUPER = await probeAdmin('emergency-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('emergency-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL_ADMIN = await probeAdmin('emergency-admin-bgl', { role: 'admin', sales_org: 'BIGUL' });
const OWNER = await probeAdmin('emergency-prm', { role: 'partner_rm', sales_org: 'BONANZA' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const partner = Number(run(
  "INSERT INTO partners (sales_org, name, partner_model, state_code, owner_id, email) VALUES ('BONANZA', ?, 'Associate', 'PROSPECT', ?, ?)",
  [`${MARK} partner`, OWNER.id, `ee-${RUN}@example.test`],
).lastInsertRowid);
for (const [code, label, status, i] of [['KYC', 'KYC documents', 'done', 1], ['AGREEMENT', 'Signed agreement', 'pending', 2], ['TRAINING', 'Product training', 'pending', 3]]) {
  run('INSERT INTO partner_steps (partner_id, code, label, status, sort_order) VALUES (?,?,?,?,?)', [partner, code, label, status, i]);
}
const REASON = `${MARK}: the partner's clients are waiting on a live IPO window`;

try {
  await test('only a Superadmin holds the override', async () => {
    assert(can('superadmin', 'partner.elevate.emergency'));
    for (const role of ['admin', 'partner_rm', 'sales_supervisor', 'customer_care']) {
      assert(!can(role, 'partner.elevate.emergency'), `${role} holds the emergency override`);
    }
  });

  await test('without asking for it by name, a Superadmin is refused like everyone else', async () => {
    const res = await as(SUPER)('POST', `/partners/${partner}/elevate`, {});
    assert.equal(res.status, 400);
    assert.equal(res.body.pending, 2);
    assert.equal(res.body.emergency_allowed, true, 'the refusal does not tell a Superadmin the override exists');
    const admin = await as(ADMIN)('POST', `/partners/${partner}/elevate`, {});
    assert.equal(admin.body.emergency_allowed, false, 'an Admin is told about an override they cannot use');
  });

  await test('an Admin asking for the override is refused', async () => {
    const res = await as(ADMIN)('POST', `/partners/${partner}/elevate`, { emergency: true, reason: REASON });
    assert.equal(res.status, 403);
    assert.equal(one('SELECT state_code FROM partners WHERE id = ?', [partner]).state_code, 'PROSPECT');
  });

  await test('the override needs a reason, in a sentence', async () => {
    for (const reason of [undefined, '', '   ', 'urgent']) {
      const res = await as(SUPER)('POST', `/partners/${partner}/elevate`, { emergency: true, reason });
      assert.equal(res.status, 400, `"${reason}" was accepted as a reason`);
      assert.equal(res.body.field, 'reason');
    }
    assert.equal(one('SELECT state_code FROM partners WHERE id = ?', [partner]).state_code, 'PROSPECT');
  });

  let result;
  await test('with a reason, the partner is activated and the record says it was an emergency', async () => {
    result = await as(SUPER)('POST', `/partners/${partner}/elevate`, { emergency: true, reason: REASON });
    assert.equal(result.status, 200, `the override answered ${result.status}: ${result.body?.error}`);
    assert(result.body.partner_code, 'no partner code issued');
    assert(result.body.portal_login?.password, 'no portal password issued');
    assert.deepEqual(result.body.emergency.steps_open, ['Signed agreement', 'Product training']);
    const row = one('SELECT * FROM partners WHERE id = ?', [partner]);
    assert.equal(row.state_code, 'ACTIVE');
    assert.equal(row.emergency_activated_by, SUPER.id);
    assert.equal(row.emergency_reason, REASON);
    assert.equal(row.emergency_steps_open, 2);
  });

  await test('the steps it skipped are still open', async () => {
    assert.equal(one("SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ? AND status != 'done'", [partner]).n, 2);
  });

  await test('it is in the audit trail, with the reason and the open steps', async () => {
    const row = one("SELECT user_id, detail FROM audit_log WHERE action = 'partner_emergency_activation' AND entity_id = ? ORDER BY id DESC LIMIT 1", [partner]);
    assert(row, 'no audit row');
    assert.equal(row.user_id, SUPER.id);
    const detail = JSON.parse(row.detail);
    assert.equal(detail.reason, REASON);
    assert.deepEqual(detail.steps_open, ['Signed agreement', 'Product training']);
  });

  await test('the business\'s Admins are told, and the other business\'s are not', async () => {
    const told = (u) => one("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = 'Partner activated in an emergency' AND link = ?", [u.id, `/partners/${partner}`]).n;
    assert.equal(told(ADMIN), 1, 'the Bonanza Admin was not told');
    assert.equal(told(BIGUL_ADMIN), 0, 'a Bigul Admin was told about a Bonanza partner');
    assert.equal(told(SUPER), 0, 'the Superadmin who did it was notified of their own act');
  });

  await test('the partner\'s owner has a task to finish the steps', async () => {
    const task = one("SELECT * FROM tasks WHERE partner_id = ? AND title LIKE 'Finish onboarding:%'", [partner]);
    assert(task, 'no follow-up task');
    assert.equal(task.assignee_id, OWNER.id);
    assert.equal(task.priority, 'High');
    assert(task.description.includes('Signed agreement') && task.description.includes(REASON));
    const days = (new Date(`${task.due_at}Z`) - Date.now()) / 86400000;
    assert(days > 6.9 && days < 7.1, `the task is due in ${days.toFixed(2)} days`);
  });

  await test('the profile shows who activated it, and why', async () => {
    const res = await as(ADMIN)('GET', `/partners/${partner}`);
    assert.equal(res.body.emergency_activated_by_name, one('SELECT name FROM users WHERE id = ?', [SUPER.id]).name);
    assert.equal(res.body.emergency_reason, REASON);
    const timeline = all("SELECT subject FROM activities WHERE partner_id = ? AND subject = 'Activated in an emergency'", [partner]);
    assert.equal(timeline.length, 1, 'the timeline does not say it was an emergency');
  });

  await test('the profile offers the override only to a role that holds it (source check)', async () => {
    const page = fs.readFileSync(path.join(CLIENT, 'crm', 'PartnerProfile.jsx'), 'utf8');
    assert(/can\('partner\.elevate\.emergency'\) && !isActive && openSteps\.length > 0/.test(page));
    assert(/emergency: true, reason/.test(page), 'the screen does not send the reason');
  });
} finally {
  run('DELETE FROM notifications WHERE link = ?', [`/partners/${partner}`]);
  run('DELETE FROM tasks WHERE partner_id = ?', [partner]);
  run('DELETE FROM activities WHERE partner_id = ?', [partner]);
  run('DELETE FROM sessions WHERE partner_id = ?', [partner]);
  run('DELETE FROM partners WHERE id = ?', [partner]);
  for (const p of [SUPER, ADMIN, BIGUL_ADMIN, OWNER]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
