/**
 * QA-13 -- what a partner may refer is a business policy, and the public
 * account-opening page is a page per business.
 *
 * Ritesh, 13 Oct 2026: a Bonanza partner cannot refer Bigul products today,
 * and the business wants to be able to allow it later, from Setup, by an Admin
 * or Superadmin. And the DKYC page that said "Open your Bonanza account" over
 * both businesses' products becomes one page per business.
 *
 * Every policy this file turns on is put back in `finally`.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import * as db from '../src/db.js';
import { hashPasswordSync } from '../src/security.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const { all, one, run } = db;
const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-13 — partner referral across the books, and a DKYC page per business');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `BP probe ${RUN}`;
const KEYS = ['partner_referral_cross_book.BONANZA', 'partner_referral_cross_book.BIGUL'];
const hadPolicyTable = Boolean(one("SELECT 1 v FROM sqlite_master WHERE type = 'table' AND name = 'business_policy'"));
const saved = hadPolicyTable ? all(`SELECT * FROM business_policy WHERE key IN (${KEYS.map(() => '?').join(',')})`, KEYS) : [];

const sweep = () => {
  for (const l of all("SELECT id FROM leads WHERE name LIKE 'BP probe %'")) {
    run('DELETE FROM activities WHERE lead_id = ?', [l.id]);
    run('DELETE FROM leads WHERE id = ?', [l.id]);
  }
  for (const p of all("SELECT id FROM partners WHERE name LIKE 'BP probe %'")) {
    run('DELETE FROM sessions WHERE partner_id = ?', [p.id]);
    run('DELETE FROM activities WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partners WHERE id = ?', [p.id]);
  }
};
sweep();

const ADMIN = await probeAdmin('bpolicy-admin', { role: 'admin', sales_org: 'BONANZA' });
const SUPER = await probeAdmin('bpolicy-super', { role: 'superadmin' });
const PRM = await probeAdmin('bpolicy-prm', { role: 'partner_rm', sales_org: 'BONANZA' });
const SUP = await probeAdmin('bpolicy-sup', { role: 'sales_supervisor', sales_org: 'BONANZA' });

const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const adminCall = as(ADMIN);
const superCall = as(SUPER);
const setPolicy = (key, value) => adminCall('PUT', `/setup/policies/${encodeURIComponent(key)}`, { value });

const PASSWORD = `bp-own-${RUN}`;
const makePartner = (org) => Number(run(
  `INSERT INTO partners (sales_org, partner_code, name, partner_model, state_code, email, portal_password,
                         portal_password_temp, portal_password_set_at, onboarded_at)
   VALUES (?, ?, ?, 'Associate', 'ACTIVE', ?, ?, 0, datetime('now'), datetime('now'))`,
  [org, `${org === 'BIGUL' ? 'BGL' : 'BNZ'}-P9${DIGITS.slice(-3)}`, `${MARK} ${org}`, `bp-${RUN}-${org.toLowerCase()}@partner.test`,
    hashPasswordSync(PASSWORD)],
).lastInsertRowid);
const portalAs = async (org) => {
  const res = await fetch(`${BASE}/api/auth/partner-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `bp-${RUN}-${org.toLowerCase()}@partner.test`, password: PASSWORD }),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`partner sign-in answered ${res.status}: ${body?.error}`);
  return async (method, url, payload) => {
    const r = await fetch(`${BASE}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
};
const dkyc = async (method, url, payload) => {
  const r = await fetch(`${BASE}/dkyc-api${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const bigulProduct = one("SELECT id, code FROM product_types WHERE sales_org = 'BIGUL' AND active = 1 ORDER BY sort_order, id LIMIT 1");
const bonanzaProduct = one("SELECT id, code FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 ORDER BY sort_order, id LIMIT 1");
let mobileSeq = 0;
const mobile = () => { mobileSeq += 1; return `6${DIGITS}${String(mobileSeq).padStart(3, '0')}`; };

try {
  makePartner('BONANZA');
  makePartner('BIGUL');
  const bonanzaPartner = await portalAs('BONANZA');

  /* ============================================================ the store */

  await test('Admins and Superadmins see and change business policies; nobody else does', async () => {
    assert.equal((await adminCall('GET', '/setup/policies')).status, 200);
    assert.equal((await superCall('GET', '/setup/policies')).status, 200);
    assert.equal((await as(PRM)('GET', '/setup/policies')).status, 403, 'a Partner RM read the policies');
    assert.equal((await as(SUP)('PUT', `/setup/policies/${KEYS[0]}`, { value: true })).status, 403, 'a supervisor changed one');
  });

  await test('cross-book referral is off unless somebody turns it on', async () => {
    run(`DELETE FROM business_policy WHERE key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
    const { body } = await adminCall('GET', '/setup/policies');
    for (const key of KEYS) {
      const p = body.policies.find((x) => x.key === key);
      assert(p, `${key} is not listed`);
      assert.equal(p.value, false, `${key} defaults on`);
      assert.equal(p.is_default, true);
    }
  });

  await test('a change is validated and lands in the configuration audit', async () => {
    const bad = await setPolicy(KEYS[0], 'yes');
    assert.equal(bad.status, 400, 'a non-boolean was accepted');
    const ok = await setPolicy(KEYS[0], true);
    assert.equal(ok.status, 200, `answered ${ok.status}: ${ok.body?.error}`);
    const row = one("SELECT * FROM config_audit WHERE area = 'policy' AND target = ? ORDER BY id DESC LIMIT 1", [KEYS[0]]);
    assert(row, 'no configuration audit row');
    assert.equal(JSON.parse(row.before_json).value, false);
    assert.equal(JSON.parse(row.after_json).value, true);
    assert.equal(row.actor_id, ADMIN.id);
    await setPolicy(KEYS[0], false);
  });

  /* ============================================================ the portal */

  await test('with the policy off, a Bonanza partner is offered Bonanza products only', async () => {
    const { status, body } = await bonanzaPartner('GET', '/portal/dashboard');
    assert.equal(status, 200);
    assert(body.products.length, 'no products at all');
    assert(body.products.every((p) => p.sales_org === 'BONANZA'), 'a Bigul product was offered');
  });

  await test('with the policy off, a Bigul product cannot be referred, and nothing is created', async () => {
    const res = await bonanzaPartner('POST', '/portal/referrals', { name: `${MARK} off`, mobile: mobile(), product_type_id: bigulProduct.id });
    assert.equal(res.status, 400, `the referral answered ${res.status}`);
    assert.match(res.body.error, /Bonanza partners cannot refer Bigul products/);
    assert.equal(one('SELECT COUNT(*) n FROM leads WHERE name = ?', [`${MARK} off`]).n, 0, 'a lead was made anyway');
  });

  await test('a referral for the partner\'s own business still lands with its product flagged', async () => {
    const res = await bonanzaPartner('POST', '/portal/referrals', { name: `${MARK} own`, mobile: mobile(), product_type_id: bonanzaProduct.id });
    assert.equal(res.status, 201, `answered ${res.status}: ${res.body?.error}`);
    const lead = one('SELECT * FROM leads WHERE id = ?', [res.body.lead_id]);
    assert.equal(lead.sales_org, 'BONANZA');
    assert.equal(one('SELECT state FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [lead.id, bonanzaProduct.id])?.state, 'EXPLORING');
  });

  let crossLead = null;
  await test('with the policy on, the other business\'s products are offered, labelled, and referrable', async () => {
    await setPolicy(KEYS[0], true);
    const { body } = await bonanzaPartner('GET', '/portal/dashboard');
    const bigul = body.products.filter((p) => p.sales_org === 'BIGUL');
    assert(bigul.length, 'no Bigul product offered with the policy on');
    assert(bigul.every((p) => p.business_name === 'Bigul'), 'a Bigul product is not labelled as Bigul');

    const res = await bonanzaPartner('POST', '/portal/referrals', { name: `${MARK} cross`, mobile: mobile(), product_type_id: bigulProduct.id });
    assert.equal(res.status, 201, `answered ${res.status}: ${res.body?.error}`);
    crossLead = one('SELECT * FROM leads WHERE id = ?', [res.body.lead_id]);
    assert.equal(crossLead.sales_org, 'BIGUL', 'the lead was not made in the product\'s business');
    assert(crossLead.partner_id, 'the lead is not attributed to the partner');
    assert.equal(one('SELECT state FROM product_cards WHERE lead_id = ? AND product_type_id = ?', [crossLead.id, bigulProduct.id])?.state, 'EXPLORING');
    if (crossLead.owner_id) {
      const owner = one('SELECT sales_org, org_access FROM users WHERE id = ?', [crossLead.owner_id]);
      const books = owner.org_access ? JSON.parse(owner.org_access) : [owner.sales_org];
      assert(books.includes('BIGUL'), 'the lead was given to someone outside Bigul');
    }
    const after = await bonanzaPartner('GET', '/portal/dashboard');
    assert(after.body.sourced_leads.some((l) => l.id === crossLead.id), 'the partner cannot follow the lead they referred');
  });

  await test('turning the policy off again takes the other business back out of the portal', async () => {
    await setPolicy(KEYS[0], false);
    const { body } = await bonanzaPartner('GET', '/portal/dashboard');
    assert(body.products.every((p) => p.sales_org === 'BONANZA'));
    assert(!body.sourced_leads.some((l) => l.id === crossLead?.id), 'the other business\'s lead is still shown');
  });

  await test('the Bigul policy is its own: turning on Bonanza\'s does not open Bigul partners', async () => {
    await setPolicy(KEYS[0], true);
    const bigulPartner = await portalAs('BIGUL');
    const { body } = await bigulPartner('GET', '/portal/dashboard');
    assert(body.products.every((p) => p.sales_org === 'BIGUL'), 'a Bigul partner was offered Bonanza products');
    await setPolicy(KEYS[0], false);
  });

  /* ============================================================== DKYC */

  await test('the DKYC page is Bonanza\'s by default and Bigul\'s when it says so', async () => {
    const bonanza = await dkyc('GET', '/products');
    assert.equal(bonanza.status, 200);
    assert(bonanza.body.length && bonanza.body.every((p) => one('SELECT sales_org FROM product_types WHERE id = ?', [p.id]).sales_org === 'BONANZA'),
      'the default page offers another business\'s products');
    const bigul = await dkyc('GET', '/products?business=bigul');
    assert(bigul.body.length && bigul.body.every((p) => one('SELECT sales_org FROM product_types WHERE id = ?', [p.id]).sales_org === 'BIGUL'),
      'the Bigul page offers another business\'s products');
    const brand = await dkyc('GET', '/business?business=bigul');
    assert.equal(brand.body.name, 'Bigul');
    assert(brand.body.legal_name, 'the Bigul page has no legal entity to name');
    assert.equal((await dkyc('GET', '/business?business=nobody')).status, 404);
  });

  await test('a journey cannot start on one business\'s page with the other\'s product', async () => {
    const res = await dkyc('POST', '/start', { product_type_id: bigulProduct.id, business: 'BONANZA' });
    assert.equal(res.status, 400, `answered ${res.status}`);
  });

  await test('a resumed application says which business it is with', async () => {
    const kycBigul = one("SELECT id FROM product_types WHERE sales_org = 'BIGUL' AND active = 1 AND requires_kyc = 1 ORDER BY sort_order, id LIMIT 1");
    const started = await dkyc('POST', '/start', { product_type_id: kycBigul.id, business: 'BIGUL' });
    assert.equal(started.status, 201, `answered ${started.status}: ${started.body?.error}`);
    const resumed = await dkyc('GET', `/resume/${started.body.resume_token}`);
    assert.equal(resumed.body.business?.code, 'BIGUL');
    run('DELETE FROM kyc_journeys WHERE resume_token = ?', [started.body.resume_token]);
  });

  /* ============================================================== copy */

  await test('Bonanza\'s Equity pitch no longer sells the Bigul plan', async () => {
    const eqd = one("SELECT pitch_points FROM product_types WHERE code = 'EQD' AND sales_org = 'BONANZA'");
    assert(eqd, 'no Bonanza Equity product');
    assert(!/bigul/i.test(eqd.pitch_points), eqd.pitch_points);
  });
} finally {
  if (hadPolicyTable || one("SELECT 1 v FROM sqlite_master WHERE type = 'table' AND name = 'business_policy'")) {
    run(`DELETE FROM business_policy WHERE key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
    for (const r of saved) {
      run('INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,?)', [r.key, r.value, r.updated_by, r.updated_at]);
    }
  }
  sweep();
  for (const p of [ADMIN, SUPER, PRM, SUP]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
