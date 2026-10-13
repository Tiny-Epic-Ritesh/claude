/**
 * OPS-27 to OPS-31 -- five gaps found while fixing Round 4, fixed on Ritesh's
 * yes of 13 Oct:
 *
 *   OPS-27  the copilot listed partners from both businesses
 *   OPS-28  the case report summary counted both businesses
 *   OPS-29  any signed-in user could run the case sweep
 *   OPS-30  an automation's notice to a role reached that role in both businesses
 *   OPS-31  the KYC health board read both businesses' journeys, for anyone
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import * as ai from '../src/ai/index.js';
import { runRule } from '../src/engine/rules.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nOPS-27 to OPS-31 — five gaps at the book boundary');

const RUN = String(Date.now()).slice(-6);
const MARK = `BG probe ${RUN}`;

const sweep = () => {
  for (const r of all("SELECT id FROM rules WHERE name LIKE 'BG probe %'")) run('DELETE FROM rules WHERE id = ?', [r.id]);
  run("DELETE FROM notifications WHERE body LIKE 'BG probe %'");
  for (const l of all("SELECT id FROM leads WHERE name LIKE 'BG probe %'")) {
    run('DELETE FROM tickets WHERE lead_id = ?', [l.id]);
    run('DELETE FROM kyc_journeys WHERE lead_id = ?', [l.id]);
    run('DELETE FROM leads WHERE id = ?', [l.id]);
  }
  run("DELETE FROM tickets WHERE subject LIKE 'BG probe %'");
  run("DELETE FROM partners WHERE name LIKE 'BG probe %'");
};
sweep();

const SUP = await probeAdmin('bookgaps-sup', { role: 'sales_supervisor', sales_org: 'BONANZA' });
const SUPER = await probeAdmin('bookgaps-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('bookgaps-admin', { role: 'admin', sales_org: 'BONANZA' });
const RM = await probeAdmin('bookgaps-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const CALLER = await probeAdmin('bookgaps-caller', { role: 'caller', sales_org: 'BONANZA' });
const CARE = await probeAdmin('bookgaps-care', { role: 'customer_care', sales_org: 'BONANZA' });
const MARKETING = await probeAdmin('bookgaps-mkt', { role: 'marketing_manager', sales_org: 'BONANZA' });
const PSUP = await probeAdmin('bookgaps-psup', { role: 'product_supervisor', sales_org: 'BONANZA' });
const BNZ_PRM = await probeAdmin('bookgaps-prm-bnz', { role: 'product_rm', sales_org: 'BONANZA' });
const BGL_PRM = await probeAdmin('bookgaps-prm-bgl', { role: 'product_rm', sales_org: 'BIGUL' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const bigulLead = Number(run("INSERT INTO leads (sales_org, name, source, stage) VALUES ('BIGUL', ?, 'Website', 'New')", [`${MARK} bigul`]).lastInsertRowid);
const bigulProduct = one("SELECT id FROM product_types WHERE sales_org = 'BIGUL' AND requires_kyc = 1 ORDER BY id LIMIT 1");
const bigulJourney = Number(run(
  "INSERT INTO kyc_journeys (lead_id, product_type_id, status, current_step) VALUES (?, ?, 'In Progress', 'BANK')",
  [bigulLead, bigulProduct.id],
).lastInsertRowid);

try {
  /* ============================================================ OPS-27 */

  await test('OPS-27 a Bonanza administrator\'s copilot lists Bonanza\'s partners only', async () => {
    run("INSERT INTO partners (sales_org, name, partner_model, state_code) VALUES ('BIGUL', ?, 'Associate', 'ACTIVE')", [`${MARK} partner`]);
    const user = one('SELECT * FROM users WHERE id = ?', [ADMIN.id]);
    const snap = ai.copilotSnapshot(user);
    assert(snap.partners.length, 'no partners in the snapshot, so this proves nothing');
    assert(snap.partners.every((p) => p.sales_org === 'BONANZA'), 'a Bigul partner reached a Bonanza administrator\'s copilot');
  });

  /* ============================================================ OPS-28 */

  await test('OPS-28 the case report counts only the reader\'s business', async () => {
    const before = (await as(SUP)('GET', '/tickets/reports/summary')).body.totals.open;
    const superBefore = (await as(SUPER)('GET', '/tickets/reports/summary')).body.totals.open;
    run("INSERT INTO tickets (subject, status, priority, sales_org, lead_id) VALUES (?, 'Open', 'Low', 'BIGUL', ?)", [`${MARK} case`, bigulLead]);
    const after = (await as(SUP)('GET', '/tickets/reports/summary')).body.totals.open;
    const superAfter = (await as(SUPER)('GET', '/tickets/reports/summary')).body.totals.open;
    assert.equal(after - before, 0, 'a Bigul case counted in a Bonanza supervisor\'s report');
    assert.equal(superAfter - superBefore, 1, 'someone in both books did not see it, so this proves nothing');
  });

  /* ============================================================ OPS-29 */

  await test('OPS-29 the case sweep belongs to whoever manages the queue', async () => {
    assert.equal((await as(RM)('POST', '/tickets/sweep', {})).status, 403, 'a Sales RM ran the case sweep');
    assert.equal((await as(CARE)('POST', '/tickets/sweep', {})).status, 200, 'Customer Care cannot run it');
    assert.equal((await as(ADMIN)('POST', '/tickets/sweep', {})).status, 200);
  });

  /* ============================================================ OPS-30 */

  await test('OPS-30 a notice to a role reaches that role in the lead\'s business only', async () => {
    const message = `${MARK} notice`;
    const rule = Number(run(
      'INSERT INTO rules (name, conditions, actions, enabled, priority) VALUES (?,?,?,0,500)',
      [`${MARK} rule`, JSON.stringify([{ field: 'lead_stage', op: 'eq', value: 'New' }]),
        JSON.stringify([{ type: 'notify', params: { role_or_user: 'product_rm', message } },
          { type: 'nudge_users', params: { role_or_users: 'product_rm', message: `${message} nudge` } }])],
    ).lastInsertRowid);
    runRule(rule, { leadIds: [bigulLead] });
    const got = (u) => one('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND body LIKE ?', [u.id, `${MARK}%`]).n;
    assert.equal(got(BNZ_PRM), 0, 'a Bonanza Product RM was notified about a Bigul lead');
    assert.equal(got(BGL_PRM), 2, 'the Bigul Product RM was not notified, so this proves nothing');
  });

  /* ============================================================ OPS-31 */

  await test('OPS-31 the KYC health board needs kyc.view and shows the reader\'s business only', async () => {
    const mkt = await as(MARKETING)('GET', '/kyc/health');
    assert.equal(mkt.status, 403, `a role without kyc.view read the board (${mkt.status})`);
    const board = await as(CALLER)('GET', '/kyc/health');
    assert.equal(board.status, 200);
    assert(!board.body.some((j) => j.id === bigulJourney), 'a Bigul applicant is on a Bonanza caller\'s board');
    const both = await as(SUPER)('GET', '/kyc/health');
    assert(both.body.some((j) => j.id === bigulJourney), 'someone in both books cannot see it, so this proves nothing');
  });

  await test('OPS-31 the Product Supervisor\'s cockpit reads the same board, in their business', async () => {
    const cockpit = await as(PSUP)('GET', '/cockpit');
    assert.equal(cockpit.status, 200, `cockpit answered ${cockpit.status}`);
    assert(!JSON.stringify(cockpit.body).includes(`${MARK} bigul`), 'a Bigul applicant is on a Bonanza Product Supervisor\'s cockpit');
  });
} finally {
  sweep();
  for (const p of [SUP, SUPER, ADMIN, RM, CALLER, CARE, MARKETING, PSUP, BNZ_PRM, BGL_PRM]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
