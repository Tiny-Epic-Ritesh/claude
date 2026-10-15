/**
 * QA-09, QA-24, QA-35 -- each status read from the record that decides it
 * (docs/feedback/QA-09-DEFINITIONS.md).
 *
 * The auditor saw a partner's client read Trading beside a lead at New, a
 * lifetime commission that counted money nobody had been paid, Won leads with
 * no account, and "no active products" beside an Active card. Each label came
 * from whatever record was nearest, not the one that decides it.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { hashPasswordSync, encryptField } from '../src/security.js';
import * as clients from '../src/engine/clients.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-09, 24, 35 — each status from the record that decides it');

const RUN = String(Date.now()).slice(-6);
const MARK = `SD probe ${RUN}`;
const POLICY = 'lead_won_requires_account';
const hadPolicyTable = Boolean(one("SELECT 1 v FROM sqlite_master WHERE type = 'table' AND name = 'business_policy'"));
const saved = hadPolicyTable ? one('SELECT * FROM business_policy WHERE key = ?', [POLICY]) : null;

const sweep = () => {
  for (const l of all("SELECT id FROM leads WHERE name LIKE 'SD probe %'")) {
    run('DELETE FROM clients WHERE converted_from_lead_id = ?', [l.id]);
    run('DELETE FROM commissions WHERE lead_id = ?', [l.id]);
    run('DELETE FROM leads WHERE id = ?', [l.id]);
  }
  for (const p of all("SELECT id FROM partners WHERE name LIKE 'SD probe %'")) {
    run('DELETE FROM commissions WHERE partner_id = ?', [p.id]);
    run('DELETE FROM sessions WHERE partner_id = ?', [p.id]);
    run('DELETE FROM activities WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partners WHERE id = ?', [p.id]);
  }
};
sweep();

const ADMIN = await probeAdmin('statusdefs-admin', { role: 'admin', sales_org: 'BONANZA' });
// OPS-43: the Won policy applies to both businesses, so a Superadmin switches it.
const SUPER = await probeAdmin('statusdefs-super', { role: 'superadmin' });
const superCall = async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: SUPER.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const adminCall = async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: ADMIN.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let seq = 0;
const seedLead = (extra = {}) => {
  seq += 1;
  return Number(run(
    /* With a PAN: Setup's seeded validation rule refuses Won without one. */
    `INSERT INTO leads (sales_org, name, mobile, pan, source, stage, owner_id, partner_id, client_code)
     VALUES ('BONANZA', ?, ?, ?, 'Website', ?, ?, ?, ?)`,
    [`${MARK} ${seq}`, `7${RUN}${String(seq).padStart(3, '0')}`, encryptField('ABCDE1234F'), extra.stage ?? 'Qualified', ADMIN.id,
      extra.partner ?? null, extra.client_code ?? null],
  ).lastInsertRowid);
};

try {
  /* ============================================================ QA-24 */

  await test('QA-24 an account opening makes its lead Won, in the lead\'s history', async () => {
    const lead = seedLead({ stage: 'Qualified' });
    const out = clients.convertLead(lead, { clientCode: `SD${RUN}01` });
    assert(out.ok && out.created, `the account did not open: ${out.error}`);
    assert.equal(one('SELECT stage FROM leads WHERE id = ?', [lead]).stage, 'Won');
    const h = one("SELECT * FROM field_history WHERE entity = 'lead' AND record_id = ? AND field = 'stage' ORDER BY id DESC LIMIT 1", [lead]);
    assert(h, 'the change is not in the lead\'s history');
    assert.equal(h.old_value, 'Qualified');
    assert.equal(h.new_value, 'Won');
    assert.equal(h.source, 'account_opening');
  });

  await test('QA-24 with the policy off (the default), an RM may still mark Won by hand', async () => {
    run('DELETE FROM business_policy WHERE key = ?', [POLICY]);
    const lead = seedLead();
    const res = await adminCall('PATCH', `/leads/${lead}`, { stage: 'Won' });
    assert.equal(res.status, 200, `answered ${res.status}: ${res.body?.error}`);
  });

  await test('QA-24 with the policy on, Won needs an opened account', async () => {
    const set = await superCall('PUT', `/setup/policies/${POLICY}`, { value: true });
    assert.equal(set.status, 200, `the policy could not be set: ${set.body?.error}`);
    const none = seedLead();
    const refused = await adminCall('PATCH', `/leads/${none}`, { stage: 'Won' });
    assert.equal(refused.status, 400, `a lead with no account was set to Won (${refused.status})`);
    assert.equal(refused.body.field, 'stage');
    assert.equal(one('SELECT stage FROM leads WHERE id = ?', [none]).stage, 'Qualified');

    const opened = seedLead({ client_code: `SD${RUN}02` });
    const ok = await adminCall('PATCH', `/leads/${opened}`, { stage: 'Won' });
    assert.equal(ok.status, 200, `a lead with its UCC was refused: ${ok.body?.error}`);

    const bulk = await adminCall('POST', '/leads/bulk/field', { field: 'stage', value: 'Won', mode: 'ids', ids: [none, opened] });
    assert.equal(bulk.status, 400, `a bulk Won carrying a lead with no account went through (${bulk.status})`);
    await superCall('PUT', `/setup/policies/${POLICY}`, { value: false });
  });

  /* ============================================================ QA-09 */

  const PASSWORD = `sd-own-${RUN}`;
  const partner = Number(run(
    `INSERT INTO partners (sales_org, partner_code, name, partner_model, state_code, email, portal_password,
                           portal_password_temp, portal_password_set_at, onboarded_at, commission_pct)
     VALUES ('BONANZA', ?, ?, 'Associate', 'ACTIVE', ?, ?, 0, datetime('now'), datetime('now'), 30)`,
    [`BNZ-P8${RUN.slice(-3)}`, `${MARK} partner`, `sd-${RUN}@partner.test`, hashPasswordSync(PASSWORD)],
  ).lastInsertRowid);
  const trading = seedLead({ partner, stage: 'New' });
  clients.convertLead(trading, { clientCode: `SD${RUN}03` });
  run("UPDATE clients SET last_traded_at = datetime('now', '-3 days') WHERE converted_from_lead_id = ?", [trading]);
  const dormant = seedLead({ partner });
  clients.convertLead(dormant, { clientCode: `SD${RUN}04`, activatedAt: '2025-01-01 10:00:00' });
  run("UPDATE clients SET last_traded_at = datetime('now', '-200 days') WHERE converted_from_lead_id = ?", [dormant]);
  const cardOnly = seedLead({ partner });
  const product = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");
  run("INSERT INTO product_cards (lead_id, product_type_id, state, value) VALUES (?, ?, 'ACTIVE', 50000)", [cardOnly, product.id]);
  const period = new Date().toISOString().slice(0, 7);
  run("INSERT INTO commissions (partner_id, lead_id, period, gross, payout, status) VALUES (?, ?, ?, 1000, 300, 'Paid')", [partner, trading, period]);
  run("INSERT INTO commissions (partner_id, lead_id, period, gross, payout, status) VALUES (?, ?, ?, 500, 150, 'Accrued')", [partner, trading, period]);

  const signIn = await fetch(`${BASE}/api/auth/partner-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `sd-${RUN}@partner.test`, password: PASSWORD }),
  }).then((r) => r.json());
  const dashboard = await fetch(`${BASE}/api/portal/dashboard`, { headers: { Authorization: `Bearer ${signIn.token}` } }).then((r) => r.json());
  const row = (id) => dashboard.sourced_leads?.find((l) => l.id === id);

  await test('QA-09 a partner\'s client is Trading only for an account that traded recently', async () => {
    assert.equal(row(trading)?.account_status, 'Active');
    assert(row(trading)?.client_code, 'the account\'s UCC is not on the row');
    assert.equal(row(dormant)?.account_status, 'Dormant');
    assert.equal(row(cardOnly)?.account_status ?? null, null, 'an Active product card was read as an account');
  });

  await test('QA-09 converted counts accounts opened, not Active product cards', async () => {
    assert.equal(dashboard.metrics.converted, 2);
    const profile = await adminCall('GET', `/partners/${partner}`);
    assert.equal(profile.body.converted_count, 2);
  });

  await test('QA-09 commission paid and accrued are told apart', async () => {
    assert.equal(dashboard.metrics.commission_paid, 300);
    assert.equal(dashboard.metrics.commission_accrued, 150);
    assert.equal(dashboard.metrics.commission_lifetime, 450);
  });

  /* ============================================================ QA-35 */

  await test('QA-35 the lead page counts Active products and shows the account apart (source check)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'crm', 'LeadDetail.jsx'), 'utf8');
    assert(/c\.state === 'ACTIVE'/.test(src), 'the AUM tile does not count Active products');
    assert(/label="Account"/.test(src), 'there is no Account tile');
  });

  await test('the definitions are written down, each with the record that decides it', async () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'feedback', 'QA-09-DEFINITIONS.md'), 'utf8');
    for (const term of ['Won', 'Trading', 'Account opened', 'Product Active', 'Commission accrued', 'Commission paid']) {
      assert(doc.includes(`**${term}**`), `${term} is not defined`);
    }
  });

  await test('the seed hands out Won only through an opened account (source check)', async () => {
    const seed = fs.readFileSync(path.join(ROOT, 'server', 'src', 'seed.js'), 'utf8');
    assert(/const STAGES = \['New', 'Contacted', 'Qualified', 'In Progress'\];/.test(seed), 'the seed still assigns Won at random');
  });
} finally {
  if (one("SELECT 1 v FROM sqlite_master WHERE type = 'table' AND name = 'business_policy'")) {
    run('DELETE FROM business_policy WHERE key = ?', [POLICY]);
    if (saved) run('INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,?)', [saved.key, saved.value, saved.updated_by, saved.updated_at]);
  }
  sweep();
  ADMIN.cleanup();
  SUPER.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
