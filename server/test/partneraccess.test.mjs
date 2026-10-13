/**
 * Partner portal access and the partner's business -- five defects found
 * beside the Round 4 fixes, each with its own id:
 *
 *   OPS-15  every partner activated from the screen got the portal password
 *           `partner<id>`, and the response handed it back in plain text
 *   OPS-16  every partner code was BNZ-P, Bigul's included
 *   OPS-17  a new partner was never given a business, so it was Bonanza's
 *   OPS-25  an elevation approval activated a partner with no onboarding
 *           done, and was raised without checking the partner's book
 *   OPS-26  partner responses, the Partner RM cockpit and the copilot's context
 *           carried the stored portal-password hash
 *
 * Every test here drives the shipped routes. The start-up withdrawal is the
 * exception: it runs before the server listens, so it is called directly on a
 * row planted the way the old code wrote one.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import * as db from '../src/db.js';
import { hashPasswordSync } from '../src/security.js';
import { copilotSnapshot, partnerInsightContext } from '../src/ai/index.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const { all, one, run } = db;
const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nPartner portal access and the partner\'s business (OPS-15, 16, 17, 25, 26)');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `PA probe ${RUN}`;

const sweep = () => {
  for (const p of all("SELECT id FROM partners WHERE name LIKE 'PA probe %'")) {
    run('DELETE FROM approvals WHERE entity = ? AND entity_id = ?', ['partner', p.id]);
    run('DELETE FROM sessions WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partner_steps WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partner_lms WHERE partner_id = ?', [p.id]);
    run('DELETE FROM activities WHERE partner_id = ?', [p.id]);
    run('DELETE FROM partners WHERE id = ?', [p.id]);
  }
};
sweep();

const SUPER = await probeAdmin('partneraccess-super', { role: 'superadmin' });
const ADMIN = await probeAdmin('partneraccess-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL_ADMIN = await probeAdmin('partneraccess-bigul-admin', { role: 'admin', sales_org: 'BIGUL' });
const PRM = await probeAdmin('partneraccess-prm', { role: 'partner_rm', sales_org: 'BONANZA' });
const BIGUL_PRM = await probeAdmin('partneraccess-bigul-prm', { role: 'partner_rm', sales_org: 'BIGUL' });

const as = (who) => async (method, url, body, extra = {}) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: { ...who.headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const superCall = as(SUPER);
const adminCall = as(ADMIN);
const bigulAdminCall = as(BIGUL_ADMIN);
const prmCall = as(PRM);
const bigulPrmCall = as(BIGUL_PRM);

const portal = async (method, url, body, token) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const signIn = (email, password) => portal('POST', '/auth/partner-login', { email, password });

let seq = 0;
const makePartner = async (call, extra = {}) => {
  seq += 1;
  const res = await call('POST', '/partners', {
    name: `${MARK} ${seq}`, business_name: `${MARK} Securities`, partner_model: 'Remisier', city: 'Pune',
    email: `pa-${RUN}-${seq}@partner.test`, mobile: `9${DIGITS}${String(seq).padStart(3, '0')}`, commission_pct: 30,
    ...extra,
  });
  assert.equal(res.status, 201, `create answered ${res.status}: ${res.body?.error}`);
  return res.body;
};
const finishOnboarding = async (call, id) => {
  for (const s of all('SELECT code FROM partner_steps WHERE partner_id = ? ORDER BY sort_order', [id])) {
    const done = await call('POST', `/partners/${id}/steps/${s.code}`, {});
    assert.equal(done.status, 200, `step ${s.code} answered ${done.status}: ${done.body?.error}`);
  }
};
const activate = async (call, extra = {}) => {
  const partner = await makePartner(call, extra);
  await finishOnboarding(call, partner.id);
  const res = await call('POST', `/partners/${partner.id}/elevate`, {});
  assert.equal(res.status, 200, `elevation answered ${res.status}: ${res.body?.error}`);
  return { partner, res: res.body };
};

/** The hash, anywhere in a response, under any key. */
const carriesHash = (body) => {
  const text = JSON.stringify(body ?? null);
  return text.includes('"portal_password"') || text.includes('scrypt$');
};

const ONE_TIME = /^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/;

try {
  /* ============================================================ OPS-15 */

  const first = await activate(adminCall);

  await test('OPS-15 activation issues a generated one-time password, not partner<id>', async () => {
    const login = first.res.portal_login;
    assert.notEqual(login.password, `partner${first.partner.id}`, 'the guessable default came back');
    assert.match(login.password, ONE_TIME, `not a generated one-time password: ${login.password}`);
    assert.equal(login.one_time, true);
    const guessed = await signIn(login.email, `partner${first.partner.id}`);
    assert.equal(guessed.status, 401, `partner<id> still signs in (${guessed.status})`);
  });

  await test('OPS-15 two activations never share a password', async () => {
    const second = await activate(adminCall);
    assert.notEqual(second.res.portal_login.password, first.res.portal_login.password);
  });

  let chosen = null;
  await test('OPS-15 a one-time password opens only the screen that replaces it', async () => {
    const login = first.res.portal_login;
    const signed = await signIn(login.email, login.password);
    assert.equal(signed.status, 200, `sign-in answered ${signed.status}: ${signed.body?.error}`);
    assert.equal(signed.body.partner.must_change_password, true);
    const token = signed.body.token;

    const blocked = await portal('GET', '/portal/dashboard', undefined, token);
    assert.equal(blocked.status, 403, `the dashboard opened on a one-time password (${blocked.status})`);
    assert.equal(blocked.body.must_change_password, true);

    const wrong = await portal('POST', '/auth/partner-password', { current_password: 'not-it', new_password: 'a-new-one-123' }, token);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.field, 'current_password');
    const short = await portal('POST', '/auth/partner-password', { current_password: login.password, new_password: 'short' }, token);
    assert.equal(short.status, 400);
    assert.equal(short.body.field, 'new_password');
    const same = await portal('POST', '/auth/partner-password', { current_password: login.password, new_password: login.password }, token);
    assert.equal(same.status, 400, 'the one-time password was accepted as the new one');

    chosen = `pa-own-${RUN}`;
    const changed = await portal('POST', '/auth/partner-password', { current_password: login.password, new_password: chosen }, token);
    assert.equal(changed.status, 200, `change answered ${changed.status}: ${changed.body?.error}`);
    const open = await portal('GET', '/portal/dashboard', undefined, token);
    assert.equal(open.status, 200, `the dashboard stayed shut after the change (${open.status})`);

    assert.equal((await signIn(login.email, login.password)).status, 401, 'the one-time password still signs in');
    const again = await signIn(login.email, chosen);
    assert.equal(again.status, 200);
    assert.equal(again.body.partner.must_change_password, false);
  });

  await test('OPS-15 a new portal password ends every open session and is one-time again', async () => {
    const before = await signIn(first.res.portal_login.email, chosen);
    assert.equal(before.status, 200);
    const issued = await adminCall('POST', `/partners/${first.partner.id}/portal-credential`, {});
    assert.equal(issued.status, 200, `re-issue answered ${issued.status}: ${issued.body?.error}`);
    assert.match(issued.body.portal_login.password, ONE_TIME);

    const old = await portal('GET', '/portal/dashboard', undefined, before.body.token);
    assert.equal(old.status, 401, `a session opened before the re-issue still works (${old.status})`);
    assert.equal((await signIn(first.res.portal_login.email, chosen)).status, 401, 'the previous password still signs in');
    const fresh = await signIn(first.res.portal_login.email, issued.body.portal_login.password);
    assert.equal(fresh.body?.partner?.must_change_password, true);
  });

  await test('OPS-15 only someone who may elevate can issue or withdraw portal access', async () => {
    const issue = await prmCall('POST', `/partners/${first.partner.id}/portal-credential`, {});
    assert.equal(issue.status, 403, `a Partner RM issued a password (${issue.status})`);
    const withdraw = await prmCall('POST', `/partners/${first.partner.id}/portal-access/withdraw`, { reason: 'x' });
    assert.equal(withdraw.status, 403);
    const across = await bigulAdminCall('POST', `/partners/${first.partner.id}/portal-credential`, {});
    assert.equal(across.status, 403, `the other business issued a password for this partner (${across.status})`);
  });

  await test('OPS-15 withdrawing access needs a reason and ends sign-in and sessions', async () => {
    const issued = await adminCall('POST', `/partners/${first.partner.id}/portal-credential`, {});
    const session = await signIn(first.res.portal_login.email, issued.body.portal_login.password);
    assert.equal(session.status, 200);

    const bare = await adminCall('POST', `/partners/${first.partner.id}/portal-access/withdraw`, {});
    assert.equal(bare.status, 400);
    assert.equal(bare.body.field, 'reason');

    const done = await adminCall('POST', `/partners/${first.partner.id}/portal-access/withdraw`, { reason: `${MARK} cleanup` });
    assert.equal(done.status, 200, `withdraw answered ${done.status}: ${done.body?.error}`);
    assert.equal((await signIn(first.res.portal_login.email, issued.body.portal_login.password)).status, 401);
    assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE partner_id = ?', [first.partner.id]).n, 0, 'a session survived');
    const profile = await adminCall('GET', `/partners/${first.partner.id}`);
    assert.equal(profile.body.has_portal_login, false);
    assert(one("SELECT id FROM activities WHERE partner_id = ? AND subject = 'Portal access withdrawn' AND body = ?",
      [first.partner.id, `${MARK} cleanup`]), 'the reason is not on the partner\'s timeline');
  });

  await test('OPS-15 a stored partner<id> password is withdrawn, with its sessions', async () => {
    const id = Number(run(
      `INSERT INTO partners (sales_org, name, partner_model, state_code, email, partner_code, onboarded_at)
       VALUES ('BONANZA', ?, 'Remisier', 'ACTIVE', ?, 'BNZ-P9999', datetime('now'))`,
      [`${MARK} legacy`, `pa-${RUN}-legacy@partner.test`],
    ).lastInsertRowid);
    // Written the way the old route wrote it: the default, hashed, and no stamp.
    run('UPDATE partners SET portal_password = ?, portal_password_set_at = NULL WHERE id = ?', [hashPasswordSync(`partner${id}`), id]);
    run("INSERT INTO sessions (token, partner_id, kind, expires_at) VALUES (?, ?, 'partner', datetime('now', '+1 hour'))", [`pa-${RUN}-legacy`, id]);

    const keep = Number(run(
      `INSERT INTO partners (sales_org, name, partner_model, state_code, email, portal_password)
       VALUES ('BONANZA', ?, 'Remisier', 'ACTIVE', ?, ?)`,
      [`${MARK} legacy-own`, `pa-${RUN}-own@partner.test`, hashPasswordSync('chosen-by-them-1')],
    ).lastInsertRowid);

    assert.equal(typeof db.withdrawGuessablePortalPasswords, 'function', 'nothing withdraws a stored partner<id> password');
    const withdrawn = db.withdrawGuessablePortalPasswords();
    assert(withdrawn.includes(id), 'the partner<id> password was not withdrawn');
    assert(!withdrawn.includes(keep), 'a password the partner chose was withdrawn');
    assert.equal(one('SELECT portal_password FROM partners WHERE id = ?', [id]).portal_password, null);
    assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE partner_id = ?', [id]).n, 0, 'its session survived');
    assert(one('SELECT portal_password FROM partners WHERE id = ?', [keep]).portal_password, 'the chosen password was cleared');
    assert(one('SELECT portal_password_set_at FROM partners WHERE id = ?', [keep]).portal_password_set_at, 'the kept row was not stamped, so it is checked at every start');
    assert(one("SELECT id FROM audit_log WHERE action = 'partner_portal_withdrawn' AND entity = 'partner' AND entity_id = ?", [id]),
      'no audit row says why');
  });

  /* ============================================================ OPS-16 */

  await test('OPS-16 a Bigul partner is issued a BGL-P code and welcomed by Bigul', async () => {
    const { partner, res } = await activate(bigulAdminCall);
    assert.match(res.partner_code, /^BGL-P\d{4}$/, `issued ${res.partner_code}`);
    const welcome = one("SELECT body FROM activities WHERE partner_id = ? AND subject = 'WHATSAPP sent' ORDER BY id DESC LIMIT 1", [partner.id]);
    assert(welcome, 'no welcome message was sent');
    assert.match(welcome.body, /^Welcome to Bigul,/, welcome.body);
    assert(!/partner\d+|password/i.test(welcome.body), 'the welcome message carries a credential');
  });

  await test('OPS-16 a Bonanza partner is still issued BNZ-P', async () => {
    assert.match(first.res.partner_code, /^BNZ-P\d{4}$/);
  });

  /* ============================================================ OPS-17 */

  await test('OPS-17 a Bigul Partner RM\'s new partner is Bigul\'s, and on their own list', async () => {
    const made = await makePartner(bigulPrmCall);
    assert.equal(one('SELECT sales_org FROM partners WHERE id = ?', [made.id]).sales_org, 'BIGUL');
    const list = await bigulPrmCall('GET', '/partners?limit=500');
    assert(list.body.some((p) => p.id === made.id), 'the Bigul Partner RM cannot see the partner they just added');
  });

  await test('OPS-17 a partner cannot be added to a business the creator does not work in', async () => {
    seq += 1;
    const res = await prmCall('POST', '/partners', { name: `${MARK} ${seq}`, sales_org: 'BIGUL' });
    assert.equal(res.status, 403, `a Bonanza Partner RM added a Bigul partner (${res.status})`);
    assert.equal(one('SELECT COUNT(*) n FROM partners WHERE name = ?', [`${MARK} ${seq}`]).n, 0);
  });

  await test('OPS-17 someone in both businesses chooses, and the switcher counts', async () => {
    const named = await makePartner(superCall, { sales_org: 'BIGUL' });
    assert.equal(one('SELECT sales_org FROM partners WHERE id = ?', [named.id]).sales_org, 'BIGUL');
    const switched = await makePartner((m, u, b) => superCall(m, u, b, { 'x-sales-org': 'BIGUL' }));
    assert.equal(one('SELECT sales_org FROM partners WHERE id = ?', [switched.id]).sales_org, 'BIGUL');
  });

  /* ============================================================ OPS-25 */

  await test('OPS-25 an elevation cannot be asked for while onboarding is incomplete', async () => {
    const partner = await makePartner(prmCall);
    const res = await prmCall('POST', '/approvals', { scope: 'partner_elevation', entity_id: partner.id, reason: `${MARK} ask` });
    assert.equal(res.status, 400, `the request was raised at 0 steps (${res.status})`);
    assert(res.body.pending > 0);
    assert.equal(one("SELECT COUNT(*) n FROM approvals WHERE entity = 'partner' AND entity_id = ?", [partner.id]).n, 0);
  });

  await test('OPS-25 a partner request is refused across the book, naming nobody', async () => {
    const partner = await makePartner(prmCall);
    await finishOnboarding(prmCall, partner.id);
    const res = await bigulPrmCall('POST', '/approvals', { scope: 'partner_elevation', entity_id: partner.id, reason: `${MARK} across` });
    assert.equal(res.status, 403, `a Bigul Partner RM raised a request on a Bonanza partner (${res.status})`);
    assert(!JSON.stringify(res.body).includes(partner.name), 'the refusal named the other book\'s partner');
  });

  await test('OPS-25 a granted elevation activates the partner and issues no password nobody sees', async () => {
    const partner = await makePartner(prmCall);
    await finishOnboarding(prmCall, partner.id);
    const asked = await prmCall('POST', '/approvals', { scope: 'partner_elevation', entity_id: partner.id, reason: `${MARK} ready` });
    assert.equal(asked.status, 201, `request answered ${asked.status}: ${asked.body?.error}`);
    const granted = await adminCall('POST', `/approvals/${asked.body.id}/decide`, { approve: true, reason: 'ok' });
    assert.equal(granted.status, 200, `grant answered ${granted.status}: ${granted.body?.error}`);
    const row = one('SELECT state_code, partner_code, portal_password FROM partners WHERE id = ?', [partner.id]);
    assert.equal(row.state_code, 'ACTIVE');
    assert.match(row.partner_code, /^BNZ-P\d{4}$/);
    assert.equal(row.portal_password, null, 'a password was issued that the approvals screen never shows');
    const issued = await adminCall('POST', `/partners/${partner.id}/portal-credential`, {});
    assert.equal(issued.status, 200, 'the partner\'s page cannot give access afterwards');
  });

  await test('OPS-25 a grant is refused if onboarding was reopened while the request waited', async () => {
    const partner = await makePartner(prmCall);
    await finishOnboarding(prmCall, partner.id);
    const asked = await prmCall('POST', '/approvals', { scope: 'partner_elevation', entity_id: partner.id, reason: `${MARK} reopen` });
    assert.equal(asked.status, 201);
    run("UPDATE partner_steps SET status = 'active' WHERE partner_id = ? AND code = 'COMPLIANCE'", [partner.id]);
    const granted = await adminCall('POST', `/approvals/${asked.body.id}/decide`, { approve: true, reason: 'ok' });
    assert.notEqual(granted.status, 200, 'the grant activated a partner with a step outstanding');
    assert.match(String(granted.body?.error), /incomplete/);
    assert.notEqual(one('SELECT state_code FROM partners WHERE id = ?', [partner.id]).state_code, 'ACTIVE');
  });

  /* ============================================================ OPS-26 */

  const held = await activate(adminCall);
  // A partner the Partner RM owns, with a password, for the cockpit.
  const owned = await makePartner(prmCall);
  await finishOnboarding(prmCall, owned.id);
  const ownedUp = await adminCall('POST', `/partners/${owned.id}/elevate`, {});
  assert.equal(ownedUp.status, 200, `elevating the owned partner answered ${ownedUp.status}`);

  await test('OPS-26 the partner list carries no password hash', async () => {
    for (const call of [adminCall, prmCall, superCall]) {
      const list = await call('GET', '/partners?limit=500');
      assert.equal(list.status, 200);
      assert(list.body.some((p) => p.has_portal_login), 'no partner with a login on the list, so this proves nothing');
      assert(!carriesHash(list.body), 'a list row carries the stored hash');
    }
  });

  await test('OPS-26 the profile, an edit and a create carry no password hash', async () => {
    const profile = await adminCall('GET', `/partners/${held.partner.id}`);
    assert.equal(profile.body.has_portal_login, true);
    assert(!carriesHash(profile.body), 'the profile carries the stored hash');
    const edited = await adminCall('PATCH', `/partners/${held.partner.id}`, { city: 'Nashik' });
    assert.equal(edited.status, 200);
    assert(!carriesHash(edited.body), 'the edit response carries the stored hash');
    const made = await makePartner(adminCall);
    assert(!carriesHash(made), 'the create response carries the field');
  });

  await test('OPS-26 the Partner RM cockpit carries no password hash', async () => {
    const cockpit = await prmCall('GET', '/cockpit');
    assert.equal(cockpit.status, 200, `cockpit answered ${cockpit.status}`);
    assert(JSON.stringify(cockpit.body).includes(owned.name), 'the owned partner is not on the cockpit, so this proves nothing');
    assert(!carriesHash(cockpit.body), 'the cockpit carries the stored hash');
  });

  await test('OPS-26 the copilot\'s context carries no password hash', async () => {
    const user = one('SELECT * FROM users WHERE id = ?', [ADMIN.id]);
    const snapshot = copilotSnapshot(user);
    assert(snapshot.partners.length, 'no partners in the snapshot, so this proves nothing');
    assert(!carriesHash(snapshot), 'the copilot snapshot carries the stored hash');
    const insight = partnerInsightContext(held.partner.id);
    assert(insight, 'no insight context');
    assert(!carriesHash(insight), 'the partner insight context carries the stored hash');
  });
} finally {
  sweep();
  for (const p of [SUPER, ADMIN, BIGUL_ADMIN, PRM, BIGUL_PRM]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
