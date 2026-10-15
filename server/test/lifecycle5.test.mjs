/**
 * QA-37, batch 5: partners, KYC journeys and retiring test records -- with
 * Ritesh's answers of 14 Oct.
 *
 *   Partner      suspend or terminate with a reason through the existing
 *                closure approval; archive only once every commission is
 *                paid; never deleted. Editing no longer changes a partner's
 *                state at all.
 *   KYC journey  versioned, applying to new journeys only; retire a step.
 *                "With Compliance": not now, but a Business policy an Admin
 *                or Superadmin can switch on, holding changes for approval.
 *   Test records an explicit mark an Admin sets; a preview of what retiring
 *                does; retired through each record's own lifecycle, never
 *                deleted (the auditor's section 9).
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { applyJourneySteps } from '../src/engine/journeyconfig.js';
import { hashPasswordSync } from '../src/security.js';
import { createJourney, journeyStepsFor } from '../src/engine/kyc.js';
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

console.log('\nQA-37 lifecycle: partners, KYC journeys and test records');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-5);
const MARK = `LC5 probe ${RUN}`;
const POLICY = 'kyc_journey.compliance_approval';

const PRM = await probeAdmin('lc5-prm', { role: 'partner_rm', sales_org: 'BONANZA' });
const ADMIN = await probeAdmin('lc5-admin', { role: 'admin', sales_org: 'BONANZA' });
const ADMIN2 = await probeAdmin('lc5-admin2', { role: 'admin', sales_org: 'BONANZA' });
const COMPLIANCE = await probeAdmin('lc5-compliance', { role: 'compliance', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('lc5-bigul', { role: 'admin', sales_org: 'BIGUL' });
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let seq = 0;
const makePartner = (state = 'ACTIVE', { portal = false } = {}) => {
  seq += 1;
  return Number(run(
    `INSERT INTO partners (sales_org, partner_code, name, partner_model, state_code, owner_id, email, portal_password, portal_password_temp, onboarded_at)
     VALUES ('BONANZA', ?, ?, 'Associate', ?, ?, ?, ?, 0, datetime('now'))`,
    [state === 'ACTIVE' || state === 'SUSPENDED' ? `BNZ-L5${DIGITS}${seq}` : null, `${MARK} partner ${seq}`, state, PRM.id,
      `lc5-${RUN}-${seq}@partner.test`, portal ? hashPasswordSync(`lc5-${RUN}`) : null],
  ).lastInsertRowid);
};
const partner = (id) => one('SELECT * FROM partners WHERE id = ?', [id]);
const askClosure = (who, id, to, reason = 'Compliance review of this partner') => as(who)('POST', '/approvals', {
  scope: 'partner_closure', entity_id: id, payload: { state_code: to }, reason,
});
const decide = (who, approvalId, approve = true) => as(who)('POST', `/approvals/${approvalId}/decide`, { approve, reason: 'Checked and agreed' });

const product = one("SELECT id, name FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1");
/* The rows as configured, timers and conditions included, so what the test
   puts back is exactly what was there. */
const stepsBefore = all(
  'SELECT step_code, timer_override_s, conditional_on FROM kyc_journey_steps WHERE product_type_id = ? ORDER BY sort_order',
  [product.id],
);
if (!stepsBefore.length) throw new Error('the probe product has no configured KYC journey');
const policyBefore = one('SELECT * FROM business_policy WHERE key = ?', [POLICY]);
const liveSteps = () => journeyStepsFor(product.id).map((s) => s.step_code ?? s.code);

const made = { journeys: [], leads: [], lists: [], tasks: [], rules: [], autos: [] };

try {
  /* ---------------------------------------------------------- partners */

  await test('editing a partner no longer changes its state -- not even to ACTIVE past onboarding', async () => {
    const p = makePartner('PROSPECT');
    for (const to of ['ACTIVE', 'SUSPENDED', 'TERMINATED']) {
      const res = await as(ADMIN)('PATCH', `/partners/${p}`, { state_code: to });
      assert.equal(res.status, 409, `PATCH set ${to}: HTTP ${res.status}`);
    }
    assert.equal(partner(p).state_code, 'PROSPECT');
    assert.equal((await as(ADMIN)('PATCH', `/partners/${p}`, { city: 'Pune' })).status, 200, 'an ordinary edit was refused');
  });

  await test('suspending goes through the closure approval, keeps the reason, and withdraws portal access', async () => {
    const p = makePartner('ACTIVE', { portal: true });
    run("INSERT INTO sessions (token, partner_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", [`lc5-${RUN}-session`, p]);
    const asked = await askClosure(PRM, p, 'SUSPENDED', 'Complaints from three clients this month');
    assert.equal(asked.status, 201, `the request answered ${asked.status}: ${asked.body?.error}`);
    assert.equal(partner(p).state_code, 'ACTIVE', 'the request suspended the partner by itself');

    const granted = await decide(ADMIN, asked.body.id);
    assert.equal(granted.status, 200, `granting answered ${granted.status}: ${granted.body?.error}`);
    const row = partner(p);
    assert.equal(row.state_code, 'SUSPENDED');
    assert.equal(row.state_reason, 'Complaints from three clients this month');
    assert.equal(row.state_changed_by, ADMIN.id);
    assert.equal(row.portal_password, null, 'a suspended partner can still sign in');
    assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE partner_id = ?', [p]).n, 0, 'a suspended partner kept a session');
    assert(one("SELECT id FROM activities WHERE partner_id = ? AND subject = 'Suspended'", [p]), 'nothing on the partner\'s timeline');
  });

  await test('a closure request says at once if the move cannot be made; terminated is final', async () => {
    assert.equal((await askClosure(PRM, makePartner('ACTIVE'), 'ACTIVE')).status, 409, 'an active partner was asked to be reinstated');
    assert.equal((await askClosure(PRM, makePartner('PROSPECT'), 'SUSPENDED')).status, 409, 'a prospect was asked to be suspended');
    const ended = await askClosure(PRM, makePartner('TERMINATED'), 'ACTIVE');
    assert.equal(ended.status, 409);
    assert.match(ended.body.error, /final/);
  });

  await test('a suspended partner is reinstated by approval, without its portal access coming back by itself', async () => {
    const p = makePartner('SUSPENDED');
    const asked = await askClosure(PRM, p, 'ACTIVE', 'The complaints were resolved');
    assert.equal(asked.status, 201, asked.body?.error);
    const granted = await decide(ADMIN, asked.body.id);
    assert.equal(granted.status, 200, granted.body?.error);
    assert.equal(partner(p).state_code, 'ACTIVE');
    assert.equal(partner(p).portal_password, null);
  });

  await test('a partner is archived only once terminated and every commission is paid; archived, it is read-only', async () => {
    const p = makePartner('ACTIVE');
    assert.equal((await as(ADMIN)('POST', `/partners/${p}/archive`, { reason: 'Agreement ended' })).status, 409, 'an active partner was archived');
    const asked = await askClosure(PRM, p, 'TERMINATED', 'Agreement ended on 30 September');
    assert.equal((await decide(ADMIN, asked.body.id)).status, 200);
    run("INSERT INTO commissions (partner_id, period, gross, payout, status) VALUES (?, '2026-09', 1000, 300, 'Accrued')", [p]);
    const unsettled = await as(ADMIN)('POST', `/partners/${p}/archive`, { reason: 'Agreement ended' });
    assert.equal(unsettled.status, 409, 'a partner owed commission was archived');
    assert.match(unsettled.body.error, /not yet paid/);
    run("UPDATE commissions SET status = 'Paid' WHERE partner_id = ?", [p]);

    assert.equal((await as(PRM)('POST', `/partners/${p}/archive`, { reason: 'Agreement ended' })).status, 403, 'a Partner RM archived');
    assert.equal((await as(BIGUL)('POST', `/partners/${p}/archive`, { reason: 'Agreement ended' })).status, 403, 'the other business archived');
    const res = await as(ADMIN)('POST', `/partners/${p}/archive`, { reason: 'Agreement ended and settled' });
    assert.equal(res.status, 200, `archive answered ${res.status}: ${res.body?.error}`);
    const list = (await as(ADMIN)('GET', '/partners?group=active&limit=500')).body;
    assert(!list.some((x) => x.id === p), 'an archived partner is still in the working list');
    assert((await as(ADMIN)('GET', '/partners?archived=only&limit=500')).body.some((x) => x.id === p), 'the archived view does not show it');
    assert.equal((await as(ADMIN)('PATCH', `/partners/${p}`, { city: 'Pune' })).status, 409, 'an archived partner was edited');
    assert.equal((await askClosure(PRM, p, 'TERMINATED')).status, 409);
    assert.equal((await as(ADMIN)('POST', `/partners/${p}/restore`)).status, 200);
    assert.equal(partner(p).archived_at, null);
    assert.equal((await as(ADMIN)('DELETE', `/partners/${p}`)).status, 404, 'there is a way to delete a partner');
  });

  /* ------------------------------------------------------- KYC journeys */

  await test('retiring a step needs a reason, reaches new journeys only, and can be undone by adding it back', async () => {
    run('DELETE FROM business_policy WHERE key = ?', [POLICY]);
    const before = createJourney({ productTypeId: product.id });
    made.journeys.push(before.id);
    const pinned = one('SELECT journey_version_id v FROM kyc_journeys WHERE id = ?', [before.id]).v;
    const retiring = stepsBefore.filter((s) => s.step_code !== 'SEGMENTS');
    assert.notEqual(retiring.length, stepsBefore.length, 'the probe product has no SEGMENTS step to retire');

    assert.equal((await as(ADMIN)('POST', `/admin/kyc/journeys/${product.id}`, { steps: retiring })).status, 400, 'changed with no reason');
    assert.equal((await as(ADMIN)('POST', `/admin/kyc/journeys/${product.id}`, { steps: [{ step_code: 'NOPE' }], reason: 'Probing a bad step' })).status, 400);
    const res = await as(ADMIN)('POST', `/admin/kyc/journeys/${product.id}`, { steps: retiring, reason: 'Segments asked at activation instead' });
    assert.equal(res.status, 200, `retire answered ${res.status}: ${res.body?.error}`);
    assert(!liveSteps().includes('SEGMENTS'), 'the step is still in new journeys');
    if (pinned) {
      assert(journeyStepsFor(product.id, pinned).some((s) => (s.step_code ?? s.code) === 'SEGMENTS'), 'a journey already started lost the step');
    }
    const back = await as(ADMIN)('POST', `/admin/kyc/journeys/${product.id}`, { steps: stepsBefore, reason: 'Probe: putting it back' });
    assert.equal(back.status, 200, back.body?.error);
    assert(liveSteps().includes('SEGMENTS'));
  });

  await test('with the Business policy on, a journey change waits for Compliance; the asker cannot grant it', async () => {
    assert.equal((await as(ADMIN)('PUT', `/setup/policies/${POLICY}`, { value: true })).status, 200);
    const retiring = stepsBefore.filter((s) => s.step_code !== 'SEGMENTS');
    const res = await as(ADMIN)('POST', `/admin/kyc/journeys/${product.id}`, { steps: retiring, reason: 'Segments asked at activation instead' });
    assert.equal(res.status, 202, `the change applied at once: HTTP ${res.status}`);
    assert(liveSteps().includes('SEGMENTS'), 'the journey changed before Compliance approved');
    assert.equal((await as(ADMIN2)('POST', `/admin/kyc/journeys/${product.id}`, { steps: stepsBefore, reason: 'A second change meanwhile' })).status, 409,
      'a second change went in while one waits');
    const listing = (await as(ADMIN)('GET', '/admin/kyc/journeys')).body;
    assert.equal(listing.compliance_approval, true);
    assert(listing.journeys.find((j) => j.product.id === product.id).pending, 'the screen cannot see what is waiting');

    assert.equal((await decide(ADMIN, res.body.approval_id)).status, 409, 'the person who asked approved it');
    assert.equal((await decide(ADMIN2, res.body.approval_id)).status, 409, 'an Admin without the Compliance capability approved it');
    const granted = await decide(COMPLIANCE, res.body.approval_id);
    assert.equal(granted.status, 200, `Compliance could not approve: ${granted.body?.error}`);
    assert(!liveSteps().includes('SEGMENTS'), 'the approved change did not apply');
    assert.equal((await as(ADMIN)('POST', '/approvals', { scope: 'kyc_journey_change', entity_id: product.id, payload: { steps: [] }, reason: 'Straight through' })).status, 400,
      'a journey change was raised past Setup\'s checks');
  });

  /* ------------------------------------------------------ test records */

  await test('an Admin marks records as test data, within their own business, and sees what retiring will do', async () => {
    const lead = Number(run("INSERT INTO leads (sales_org, name, source, stage) VALUES ('BONANZA', ?, 'Website', 'New')", [`${MARK} lead`]).lastInsertRowid);
    made.leads.push(lead);
    assert.equal((await as(ADMIN)('POST', '/admin/test-records', { entity: 'spaceship', record_id: 1 })).status, 400);
    assert.equal((await as(ADMIN)('POST', '/admin/test-records', { entity: 'lead', record_id: 999999999 })).status, 404);
    assert.equal((await as(BIGUL)('POST', '/admin/test-records', { entity: 'lead', record_id: lead })).status, 404, 'the other business marked it');
    assert.equal((await as(PRM)('POST', '/admin/test-records', { entity: 'lead', record_id: lead })).status, 403);
    const res = await as(ADMIN)('POST', '/admin/test-records', { entity: 'lead', record_id: lead, note: 'Auditor round 4' });
    assert.equal(res.status, 201, `mark answered ${res.status}: ${res.body?.error}`);
    assert.match(res.body.plan.will, /recycle bin/);
    assert.equal((await as(ADMIN)('POST', '/admin/test-records', { entity: 'lead', record_id: lead })).status, 409, 'marked twice');
  });

  await test('retiring takes each record out of use its own way, deletes nothing, and leaves the blocked ones be', async () => {
    const lead = made.leads[0];
    const list = Number(run("INSERT INTO lead_lists (name, kind, owner_id, created_by, shared_with, sales_org, snapshot_reason, expires_at) VALUES (?, 'static', ?, ?, '[]', 'BONANZA', 'probe', date('now', '+30 days'))",
      [`${MARK} list`, ADMIN.id, ADMIN.id]).lastInsertRowid);
    made.lists.push(list);
    const task = Number(run("INSERT INTO tasks (title, assignee_id, created_by, due_at, status) VALUES (?, ?, ?, datetime('now', '+1 day'), 'Open')",
      [`${MARK} task`, ADMIN.id, ADMIN.id]).lastInsertRowid);
    made.tasks.push(task);
    const rule = Number(run(`INSERT INTO rules (name, conditions, actions, enabled) VALUES (?, '[]', '[]', 1)`, [`${MARK} rule`]).lastInsertRowid);
    made.rules.push(rule);
    const p = makePartner('ACTIVE', { portal: true });
    const auto = Number(run("INSERT INTO automation (name, sales_org, trigger_type, status) VALUES (?, 'BONANZA', 'lead.created', 'active')", [`${MARK} flow`]).lastInsertRowid);
    made.autos.push(auto);
    run("INSERT INTO automation_run (automation_id, lead_id, status) VALUES (?, ?, 'waiting')", [auto, lead]);

    for (const [entity, id] of [['list', list], ['task', task], ['rule', rule], ['partner', p], ['automation', auto]]) {
      assert.equal((await as(ADMIN)('POST', '/admin/test-records', { entity, record_id: id })).status, 201, `${entity} was not marked`);
    }
    const preview = (await as(ADMIN)('GET', '/admin/test-records')).body.records;
    assert.match(preview.find((r) => r.entity === 'automation' && r.record_id === auto).plan.blocked, /still inside/);

    assert.equal((await as(ADMIN)('POST', '/admin/test-records/retire', { reason: '' })).status, 400, 'retired with no reason');
    const res = await as(ADMIN)('POST', '/admin/test-records/retire', { reason: 'Round 4 audit closed; evidence kept' });
    assert.equal(res.status, 200, `retire answered ${res.status}: ${res.body?.error}`);

    assert(one('SELECT deleted_at FROM leads WHERE id = ?', [lead]).deleted_at, 'the lead is not in the recycle bin');
    assert(one('SELECT archived_at FROM lead_lists WHERE id = ?', [list]).archived_at, 'the list is not archived');
    assert.equal(one('SELECT status FROM tasks WHERE id = ?', [task]).status, 'Cancelled');
    const r = one('SELECT enabled, archived_at FROM rules WHERE id = ?', [rule]);
    assert.equal(r.enabled, 0); assert(r.archived_at);
    const pr = partner(p);
    assert(pr.archived_at, 'the partner is not archived');
    assert.equal(pr.portal_password, null, 'the test partner can still sign in');
    assert.equal(pr.state_code, 'ACTIVE', 'retiring a test record changed a partner\'s state past the closure approval');
    assert.equal(one('SELECT archived_at FROM automation WHERE id = ?', [auto]).archived_at, null, 'a flow with a lead inside was archived');
    assert(res.body.results.some((x) => x.entity === 'automation' && /still inside/.test(x.skipped)), 'the skipped flow was not reported');
    for (const [table, id] of [['leads', lead], ['lead_lists', list], ['tasks', task], ['rules', rule], ['partners', p]]) {
      assert(one(`SELECT id FROM ${table} WHERE id = ?`, [id]), `a ${table} row was deleted`);
    }

    const marks = (await as(ADMIN)('GET', '/admin/test-records')).body.records;
    const leadMark = marks.find((m) => m.entity === 'lead' && m.record_id === lead);
    assert.match(leadMark.outcome, /recycle bin/);
    assert.equal((await as(ADMIN)('DELETE', `/admin/test-records/${leadMark.id}`)).status, 409, 'a retired mark was taken off');
    const autoMark = marks.find((m) => m.entity === 'automation' && m.record_id === auto);
    assert.equal((await as(ADMIN)('DELETE', `/admin/test-records/${autoMark.id}`)).status, 200, 'an open mark could not be taken off');
  });

  await test('the screens offer it: closure requests and archive, step retire and add back, the test-record list (source check)', async () => {
    const page = source('crm/PartnerProfile.jsx');
    assert(/scope: 'partner_closure'/.test(page) && /\/archive`/.test(page) && /\/restore`/.test(page));
    assert(/archived: 'only'/.test(source('crm/Partners.jsx')));
    const journeys = source('crm/admin/Journeys.jsx');
    assert(/Retire/.test(journeys) && /Add back/.test(journeys) && /reason/.test(journeys));
    const tr = source('crm/admin/TestRecords.jsx');
    assert(/\/admin\/test-records\/retire/.test(tr) && /plan\?\.blocked/.test(tr));
  });
} finally {
  run('DELETE FROM business_policy WHERE key = ?', [POLICY]);
  if (policyBefore) {
    run('INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,?)',
      [policyBefore.key, policyBefore.value, policyBefore.updated_by, policyBefore.updated_at]);
  }
  run('DELETE FROM approvals WHERE entity = ? AND entity_id = ? AND status = ?', ['product_type', product.id, 'Pending']);
  /* Put the journey back as a version, not just as rows: a new journey pins
     the latest version, so restoring the rows alone left every journey
     started afterwards on the probe's -- the e2e applicant was never asked
     for segments, and never reached income proof. */
  applyJourneySteps(product.id, stepsBefore, { note: 'lifecycle5 probe: restored as it was' });
  for (const id of made.journeys) run('DELETE FROM kyc_journeys WHERE id = ?', [id]);
  run('DELETE FROM test_records WHERE label LIKE ? OR record_id IN (SELECT id FROM partners WHERE name LIKE ?)', [`${MARK}%`, `${MARK}%`]);
  for (const id of made.autos) run('DELETE FROM automation WHERE id = ?', [id]);
  for (const id of made.rules) run('DELETE FROM rules WHERE id = ?', [id]);
  for (const id of made.tasks) run('DELETE FROM tasks WHERE id = ?', [id]);
  for (const id of made.lists) run('DELETE FROM lead_lists WHERE id = ?', [id]);
  for (const id of made.leads) { run('DELETE FROM activities WHERE lead_id = ?', [id]); run('DELETE FROM leads WHERE id = ?', [id]); }
  const partners = `SELECT id FROM partners WHERE name LIKE '${MARK.replace(/'/g, "''")}%'`;
  run(`DELETE FROM approvals WHERE entity = 'partner' AND entity_id IN (${partners})`);
  run(`DELETE FROM commissions WHERE partner_id IN (${partners})`);
  run(`DELETE FROM sessions WHERE partner_id IN (${partners})`);
  run(`DELETE FROM activities WHERE partner_id IN (${partners})`);
  run(`DELETE FROM partners WHERE name LIKE ?`, [`${MARK}%`]);
  for (const p of [PRM, ADMIN, ADMIN2, COMPLIANCE, BIGUL]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
