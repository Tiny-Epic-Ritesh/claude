/**
 * QA-28 -- where the AI's compliance flags send their cases, and who receives them.
 *
 * Until 14 October only Complaint had a category; mis-selling, an assured-
 * return expectation, a regulatory mention and urgency on funds opened
 * uncategorised. Ritesh accepted the suggested routing and a Compliance role
 * to receive it:
 *
 *   Mis-selling risk               -> Mis-selling / misrepresentation   High      Compliance
 *   Guaranteed-return expectation  -> Assured-return claim              High      Compliance
 *   Regulatory mention             -> Regulatory escalation             Critical  Compliance
 *   Urgency on funds               -> Payout / Withdrawal               High      Customer Care
 *
 * and each is changeable in Setup by an Admin or Superadmin.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { can, mayUseOrg } from '../src/auth.js';
import { ensureComplianceRouting } from '../src/engine/compliance.js';
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

console.log('\nQA-28 — compliance flags, their categories, and the Compliance desk');

const RUN = String(Date.now()).slice(-6);
const MARK = `CD probe ${RUN}`;

const SUPER = await probeAdmin('cd-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('cd-admin', { role: 'admin', sales_org: 'BONANZA' });
const RM = await probeAdmin('cd-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const OFFICER = await probeAdmin('cd-officer', { role: 'compliance', sales_org: 'BONANZA' });
run('UPDATE users SET org_access = ? WHERE id = ?', [JSON.stringify(['BONANZA', 'BIGUL']), OFFICER.id]);

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const lead = (org) => Number(run(
  "INSERT INTO leads (sales_org, name, source, stage, mobile) VALUES (?, ?, 'Website', 'New', ?)",
  [org, `${MARK} ${org}`, `97${RUN}${org === 'BIGUL' ? '22' : '11'}`],
).lastInsertRowid);
const bonanzaLead = lead('BONANZA');
const bigulLead = lead('BIGUL');
const tickets = [];

const flagCall = async (leadId, flag) => {
  const res = await as(SUPER)('POST', '/ai/disposition/confirm', {
    lead_id: leadId, outcome: 'Connected', summary: `${MARK} call`, compliance_flag: flag,
    compliance_note: `${MARK} note`, card_changes: [],
  });
  assert.equal(res.status, 200, `the disposition answered ${res.status}: ${res.body?.error}`);
  assert(res.body.compliance_ticket_id, 'no case was opened');
  tickets.push(res.body.compliance_ticket_id);
  return one(
    `SELECT t.*, c.name AS category_name, u.role AS assignee_role, u.sales_org AS assignee_org
       FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.id = ?`,
    [res.body.compliance_ticket_id],
  );
};

const routeRow = (flag) => one('SELECT * FROM compliance_flag_routes WHERE flag = ?', [flag]);
const originalUrgency = routeRow('Urgency on funds');

try {
  await test('every flag has the route Ritesh accepted', async () => {
    const res = await as(ADMIN)('GET', '/admin/compliance-flags');
    assert.equal(res.status, 200);
    const by = Object.fromEntries(res.body.routes.map((r) => [r.flag, r]));
    const expect = {
      Complaint: ['Complaint', 'High', 'customer_care'],
      'Mis-selling risk': ['Mis-selling / misrepresentation', 'High', 'compliance'],
      'Guaranteed-return expectation': ['Assured-return claim', 'High', 'compliance'],
      'Regulatory mention': ['Regulatory escalation', 'Critical', 'compliance'],
      'Urgency on funds': ['Payout / Withdrawal', 'High', 'customer_care'],
    };
    for (const [flag, [category, priority, role]] of Object.entries(expect)) {
      assert.equal(by[flag]?.category_name, category, `${flag} opens ${by[flag]?.category_name}`);
      assert.equal(by[flag].priority, priority, `${flag} is ${by[flag].priority}`);
      assert.equal(by[flag].auto_assign_role, role, `${flag}'s category goes to ${by[flag].auto_assign_role}`);
    }
  });

  await test('a regulatory mention opens a Critical Regulatory escalation, with Compliance, in its own business', async () => {
    const t = await flagCall(bigulLead, 'Regulatory mention');
    assert.equal(t.category_name, 'Regulatory escalation');
    assert.equal(t.priority, 'Critical');
    assert.equal(t.sales_org, 'BIGUL');
    assert.equal(t.assignee_role, 'compliance', `the case went to a ${t.assignee_role}`);
    assert(t.resolution_due, 'the case has no deadline');
  });

  await test('mis-selling and an assured-return expectation each open their own category', async () => {
    assert.equal((await flagCall(bonanzaLead, 'Mis-selling risk')).category_name, 'Mis-selling / misrepresentation');
    assert.equal((await flagCall(bonanzaLead, 'Guaranteed-return expectation')).category_name, 'Assured-return claim');
  });

  await test('urgency on funds goes to Payout / Withdrawal, with Customer Care', async () => {
    const t = await flagCall(bonanzaLead, 'Urgency on funds');
    assert.equal(t.category_name, 'Payout / Withdrawal');
    assert.equal(t.priority, 'High');
    assert.equal(t.assignee_role, 'customer_care');
  });

  await test('while nobody holds the Compliance role, an Admin of the business receives the case', async () => {
    const active = all("SELECT id FROM users WHERE role = 'compliance' AND active = 1").map((u) => u.id);
    run("UPDATE users SET active = 0 WHERE role = 'compliance'");
    try {
      const t = await flagCall(bonanzaLead, 'Mis-selling risk');
      assert.equal(t.assignee_role, 'admin', `the case went to ${t.assignee_role ?? 'nobody'}`);
      const admin = one('SELECT * FROM users WHERE id = ?', [t.assignee_id]);
      assert(mayUseOrg(admin, 'BONANZA'), 'the Admin does not work in the lead\'s business');
    } finally {
      for (const id of active) run('UPDATE users SET active = 1 WHERE id = ?', [id]);
    }
  });

  await test('an Admin changes a flag\'s route in Setup, and the change is audited and used', async () => {
    const complaint = one("SELECT id FROM ticket_categories WHERE name = 'Complaint'");
    const res = await as(ADMIN)('PUT', `/admin/compliance-flags/${encodeURIComponent('Urgency on funds')}`, { category_id: complaint.id, priority: 'Critical' });
    assert.equal(res.status, 200, `the change answered ${res.status}: ${res.body?.error}`);
    const audit = one("SELECT * FROM config_audit WHERE area = 'compliance_flag' AND target = 'Urgency on funds' ORDER BY id DESC LIMIT 1");
    assert(audit && audit.actor_id === ADMIN.id, 'the change is not in the configuration audit');
    const t = await flagCall(bonanzaLead, 'Urgency on funds');
    assert.equal(t.category_name, 'Complaint');
    assert.equal(t.priority, 'Critical');
  });

  await test('a restart does not undo an Admin\'s route', async () => {
    ensureComplianceRouting();
    const complaint = one("SELECT id FROM ticket_categories WHERE name = 'Complaint'");
    assert.equal(routeRow('Urgency on funds').category_id, complaint.id);
    assert.equal(routeRow('Urgency on funds').priority, 'Critical');
  });

  await test('Setup refuses what is not a route', async () => {
    const put = (flag, body, who = ADMIN) => as(who)('PUT', `/admin/compliance-flags/${encodeURIComponent(flag)}`, body);
    const complaint = one("SELECT id FROM ticket_categories WHERE name = 'Complaint'");
    assert.equal((await put('Urgency on funds', { category_id: complaint.id, priority: 'Whenever' })).status, 400);
    assert.equal((await put('Urgency on funds', { category_id: 999999, priority: 'High' })).status, 400);
    assert.equal((await put('Not a flag', { category_id: complaint.id, priority: 'High' })).status, 404);
    assert.equal((await put('Urgency on funds', { category_id: complaint.id, priority: 'High' }, RM)).status, 403);
  });

  await test('the Compliance role reads and works cases, and changes nothing else', async () => {
    const role = one("SELECT data_scope FROM roles WHERE code = 'compliance'");
    assert.equal(role?.data_scope, 'org');
    for (const cap of ['ticket.view.all', 'ticket.reply', 'ticket.reassign', 'ticket.escalate', 'lead.view.all',
      'client.view.all', 'kyc.view', 'partner.view', 'partner.view.all', 'audit.read', 'comms.monitor', 'pii.unmask']) {
      assert(can('compliance', cap), `Compliance lacks ${cap}`);
    }
    for (const cap of ['lead.edit', 'lead.delete', 'client.edit', 'admin.users', 'admin.sla', 'admin.system',
      'export.lead', 'export.client', 'export.case', 'partner.elevate']) {
      assert(!can('compliance', cap), `Compliance holds ${cap}`);
    }
  });

  await test('an Admin can give a new user the Compliance role', async () => {
    /* The users route checks a role against a list of its own, which did not
       know the role: the role existed and nobody could be given it. */
    const email = `cd-new-${RUN}@bonanza.test`;
    try {
      const res = await as(ADMIN)('POST', '/admin/users', { name: `${MARK} officer`, email, password: `Probe-${RUN}-pass`, role: 'compliance' });
      assert.equal(res.status, 201, `the user was refused: ${res.body?.error}`);
      assert.equal(one('SELECT role FROM users WHERE id = ?', [res.body.id]).role, 'compliance');
      const roles = await as(ADMIN)('GET', '/admin/roles');
      assert(roles.body.roles.some((r) => r.code === 'compliance'), 'the roles list does not offer Compliance');
    } finally {
      run('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  await test('the officer reads the audit trail, and cannot carry it out', async () => {
    assert.equal((await as(OFFICER)('GET', '/admin/audit?limit=1')).status, 200);
    const res = await fetch(`${BASE}/api/admin/audit/export`, { headers: OFFICER.headers });
    assert.equal(res.status, 403, 'Compliance exported the audit log');
  });

  await test('the Compliance cockpit puts both businesses\' compliance cases in front of the officer', async () => {
    const res = await as(OFFICER)('GET', '/cockpit');
    assert.equal(res.status, 200, `cockpit answered ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.title, 'Compliance cockpit');
    const ids = res.body.worklist.rows.map((r) => r.id);
    const regulatory = one("SELECT t.id FROM tickets t JOIN ticket_categories c ON c.id = t.category_id WHERE c.name = 'Regulatory escalation' AND t.lead_id = ?", [bigulLead]);
    assert(ids.includes(regulatory.id), 'the Bigul regulatory case is not on the desk');
    assert(!ids.some((id) => one("SELECT c.name FROM tickets t JOIN ticket_categories c ON c.id = t.category_id WHERE t.id = ?", [id])?.name === 'Payout / Withdrawal'),
      'a Customer Care case is on the compliance desk');
    const tile = res.body.metrics.find((m) => m.label === 'Regulatory escalations');
    assert(tile && Number(tile.value) >= 1, 'the regulatory tile does not count it');
  });

  await test('identifiers reach the officer masked, until they unmask one', async () => {
    const res = await as(OFFICER)('GET', `/leads/${bonanzaLead}`);
    assert.equal(res.status, 200, `the officer cannot open the lead (${res.status})`);
    assert(!String(res.body.mobile ?? '').includes(`97${RUN}11`), 'the mobile reached Compliance in the clear');
  });

  await test('the screens know the role (source check)', async () => {
    assert(/compliance: 'Compliance'/.test(source('api.js')), 'no label for the role');
    assert(/'compliance@bonanza\.test', 'compliance'/.test(source('crm/Login.jsx')), 'no demo sign-in for the role');
    assert(/\/admin\/compliance-flags/.test(source('crm/admin/Sla.jsx')), 'Setup has no screen for the routes');
  });
} finally {
  if (originalUrgency) {
    run('UPDATE compliance_flag_routes SET category_id = ?, priority = ?, updated_by = ? WHERE flag = ?',
      [originalUrgency.category_id, originalUrgency.priority, originalUrgency.updated_by, 'Urgency on funds']);
  }
  for (const id of tickets) {
    run('DELETE FROM notifications WHERE link = ?', [`/tickets/${id}`]);
    run('DELETE FROM tickets WHERE id = ?', [id]);
  }
  for (const id of [bonanzaLead, bigulLead]) {
    run('DELETE FROM tasks WHERE lead_id = ?', [id]);
    run('DELETE FROM activities WHERE lead_id = ?', [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  for (const p of [SUPER, ADMIN, RM, OFFICER]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
