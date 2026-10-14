/**
 * Two of Ritesh's answers of 14 Oct, both as Business policies an Admin or
 * Superadmin changes in Setup:
 *
 *   How a cross-business referral is paid -- by default under the plan of
 *   the business whose product it is, the way the industry pays a referral;
 *   or the partner's own plan, a share of the product business's plan, or a
 *   fixed incentive per account. The basis in force is recorded on each
 *   referral as it is made.
 *
 *   How long data is kept -- clients at least eight years (SEBI Stock Brokers
 *   Regulations, 2026, regulation 16), which cannot be set lower; leads that
 *   never became clients three years without activity (the DPDP Rules' own
 *   period), after which an Admin may erase them from the recycle bin, with a
 *   reason (QA-37).
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { hashPasswordSync } from '../src/security.js';
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

console.log('\nReferral commission across the businesses, and how long data is kept');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `RR probe ${RUN}`;
const KEYS = ['partner_referral_cross_book.BONANZA', 'referral_commission.cross_book', 'referral_commission.cross_book_split_pct',
  'referral_commission.cross_book_incentive_inr', 'retention.lead_years', 'retention.client_years'];
const saved = all(`SELECT * FROM business_policy WHERE key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
run(`DELETE FROM business_policy WHERE key IN (${KEYS.map(() => '?').join(',')})`, KEYS);

const ADMIN = await probeAdmin('rr-admin', { role: 'admin', sales_org: 'BONANZA' });
const RM = await probeAdmin('rr-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const setPolicy = (key, value, who = ADMIN) => as(who)('PUT', `/setup/policies/${encodeURIComponent(key)}`, { value });

const PASSWORD = `rr-own-${RUN}`;
const partner = Number(run(
  `INSERT INTO partners (sales_org, partner_code, name, partner_model, state_code, email, portal_password,
                         portal_password_temp, portal_password_set_at, onboarded_at)
   VALUES ('BONANZA', ?, ?, 'Associate', 'ACTIVE', ?, ?, 0, datetime('now'), datetime('now'))`,
  [`BNZ-P8${DIGITS.slice(-3)}`, `${MARK} partner`, `rr-${RUN}@partner.test`, hashPasswordSync(PASSWORD)],
).lastInsertRowid);
const login = await (await fetch(`${BASE}/api/auth/partner-login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `rr-${RUN}@partner.test`, password: PASSWORD }),
})).json();
const portal = async (method, url, payload) => {
  const r = await fetch(`${BASE}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let seq = 0;
const mobile = () => { seq += 1; return `9${DIGITS}${String(seq).padStart(3, '0')}`; };
const bigulProduct = one("SELECT id FROM product_types WHERE sales_org = 'BIGUL' AND active = 1 ORDER BY id LIMIT 1");
const bonanzaProduct = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");
const basisOf = (leadId) => JSON.parse(one('SELECT referral_commission_basis b FROM leads WHERE id = ?', [leadId]).b ?? 'null');

const made = [];
const oldLead = (org, extra = {}) => {
  const id = Number(run(
    `INSERT INTO leads (sales_org, name, source, stage, created_at, updated_at, deleted_at, client_code)
     VALUES (?, ?, 'Website', 'New', datetime('now', '-5 years'), datetime('now', '-5 years'), datetime('now', '-4 years'), ?)`,
    [org, `${MARK} ${org} old`, extra.client_code ?? null],
  ).lastInsertRowid);
  made.push(id);
  return id;
};

try {
  /* ============================================================ the policies */

  await test('the policies start at the industry defaults', async () => {
    const res = await as(ADMIN)('GET', '/setup/policies');
    const by = Object.fromEntries(res.body.policies.map((p) => [p.key, p]));
    assert.equal(by['referral_commission.cross_book'].value, 'product_business_plan');
    assert.equal(by['referral_commission.cross_book_split_pct'].value, 50);
    assert.equal(by['retention.lead_years'].value, 3);
    assert.equal(by['retention.client_years'].value, 8);
  });

  await test('a retention cannot go below the law, and a number must be a number', async () => {
    assert.equal((await setPolicy('retention.client_years', 7)).status, 400, 'client records could be kept for less than eight years');
    assert.equal((await setPolicy('retention.client_years', 21)).status, 400);
    assert.equal((await setPolicy('retention.lead_years', 0)).status, 400);
    assert.equal((await setPolicy('retention.lead_years', 'three')).status, 400);
    assert.equal((await setPolicy('referral_commission.cross_book_split_pct', 0)).status, 400);
    assert.equal((await setPolicy('retention.client_years', 10)).status, 200);
    assert.equal((await setPolicy('retention.client_years', 10, RM)).status, 403, 'a Sales RM changed a business policy');
  });

  /* ============================================================ referrals */

  await test('a cross-business referral records the basis it is paid under', async () => {
    assert.equal((await setPolicy('partner_referral_cross_book.BONANZA', true)).status, 200);
    const res = await portal('POST', '/portal/referrals', { name: `${MARK} cross`, mobile: mobile(), product_type_id: bigulProduct.id });
    assert.equal(res.status, 201, `the referral answered ${res.status}: ${res.body?.error}`);
    made.push(res.body.lead_id);
    const basis = basisOf(res.body.lead_id);
    assert.equal(basis.basis, 'product_business_plan');
    assert.equal(basis.product_business, 'BIGUL');
    assert.equal(basis.referrer_business, 'BONANZA');
    assert.match(res.body.message, /paid under the plan of the business whose product it is/);
  });

  await test('changing the basis applies to the next referral, not to the last one', async () => {
    const first = made[made.length - 1];
    assert.equal((await setPolicy('referral_commission.cross_book', 'split')).status, 200);
    assert.equal((await setPolicy('referral_commission.cross_book_split_pct', 40)).status, 200);
    const res = await portal('POST', '/portal/referrals', { name: `${MARK} split`, mobile: mobile(), product_type_id: bigulProduct.id });
    made.push(res.body.lead_id);
    assert.deepEqual([basisOf(res.body.lead_id).basis, basisOf(res.body.lead_id).split_pct], ['split', 40]);
    assert.equal(basisOf(first).basis, 'product_business_plan', 'an earlier referral was rewritten by a policy change');
  });

  await test('a referral within the partner\'s own business records no cross-business basis', async () => {
    const res = await portal('POST', '/portal/referrals', { name: `${MARK} own`, mobile: mobile(), product_type_id: bonanzaProduct.id });
    assert.equal(res.status, 201);
    made.push(res.body.lead_id);
    assert.equal(basisOf(res.body.lead_id), null);
  });

  /* ============================================================ retention */

  const stale = oldLead('BONANZA');
  const recent = oldLead('BONANZA');
  run("INSERT INTO activities (lead_id, type, direction, subject) VALUES (?, 'Note', 'outbound', ?)", [recent, `${MARK} touched`]);
  const account = oldLead('BONANZA', { client_code: `RR${DIGITS}` });
  const otherBook = oldLead('BIGUL');

  await test('a deleted, never-converted lead untouched for the retention period can be purged', async () => {
    const res = await as(ADMIN)('GET', '/recycle-bin/purgeable');
    assert.equal(res.status, 200);
    const ids = res.body.leads.map((l) => l.id);
    assert(ids.includes(stale), 'a lead past its retention is not purgeable');
    assert(!ids.includes(recent), 'a lead touched this year is purgeable');
    assert(!ids.includes(account), 'a lead that became an account is purgeable');
    assert(!ids.includes(otherBook), 'a Bonanza Admin can purge a Bigul lead');
  });

  await test('the retention period is the policy\'s', async () => {
    assert.equal((await setPolicy('retention.lead_years', 5)).status, 200);
    const ids = (await as(ADMIN)('GET', '/recycle-bin/purgeable')).body.leads.map((l) => l.id);
    assert(!made.some((id) => ids.includes(id)), 'a lead last touched four years ago is purgeable under a five-year retention');
    assert.equal((await setPolicy('retention.lead_years', 3)).status, 200);
  });

  await test('a purge needs a reason and the word PURGE, and erases only what is purgeable', async () => {
    assert.equal((await as(ADMIN)('POST', '/recycle-bin/purge', { confirm: 'PURGE' })).status, 400, 'a purge with no reason was accepted');
    assert.equal((await as(ADMIN)('POST', '/recycle-bin/purge', { reason: `${MARK} retention run out`, confirm: 'yes' })).status, 400);
    assert.equal((await as(RM)('POST', '/recycle-bin/purge', { reason: `${MARK} retention run out`, confirm: 'PURGE' })).status, 403);
    const res = await as(ADMIN)('POST', '/recycle-bin/purge', { reason: `${MARK} retention run out`, confirm: 'PURGE', ids: [stale, account] });
    assert.equal(res.status, 200, `the purge answered ${res.status}: ${res.body?.error}`);
    assert.deepEqual(res.body.ids, [stale]);
    assert.deepEqual(res.body.refused, [account], 'an account\'s lead was not reported as refused');
    assert.equal(one('SELECT id FROM leads WHERE id = ?', [stale]), undefined, 'the stale lead is still there');
    assert(one('SELECT id FROM leads WHERE id = ?', [account]), 'an account\'s lead was erased');
    const audit = one("SELECT detail FROM audit_log WHERE action = 'leads_purged' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(JSON.parse(audit.detail).ids, [stale]);
    assert(!audit.detail.includes(`${MARK} BONANZA old`), 'the audit of an erasure carries the erased lead\'s name');
  });

  await test('Setup shows numbers, and the recycle bin offers the purge (source check)', async () => {
    assert(/p\.type === 'number'/.test(source('crm/BusinessPolicies.jsx')), 'Setup cannot show a number policy');
    assert(/\/recycle-bin\/purge/.test(source('crm/DataTools.jsx')), 'the recycle bin has no purge');
    assert(/Type PURGE to confirm/.test(source('crm/DataTools.jsx')));
  });
} finally {
  run(`DELETE FROM business_policy WHERE key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
  for (const r of saved) {
    run('INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,?)', [r.key, r.value, r.updated_by, r.updated_at]);
  }
  for (const id of made) {
    run('DELETE FROM activities WHERE lead_id = ?', [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  run('DELETE FROM sessions WHERE partner_id = ?', [partner]);
  run('DELETE FROM activities WHERE partner_id = ?', [partner]);
  run('DELETE FROM partners WHERE id = ?', [partner]);
  for (const p of [ADMIN, RM]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
