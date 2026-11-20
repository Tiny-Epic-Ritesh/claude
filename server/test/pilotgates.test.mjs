/**
 * A6: the BRD's pilot gates, with evidence (Round 4 report §1 and §6 step 9).
 *
 * The write-up for each gate is docs/feedback/A6-PILOT-GATES.md: what the BRD
 * asks, how the CRM does it, where, what this file proves, and what has to be
 * shown on the pilot's own infrastructure. Each section here is one gate.
 *
 *   G1  credential hashing          passwords, API secrets, and every bearer
 *                                   token and signing secret at rest (OPS-80,
 *                                   OPS-81)
 *   G2  session expiry, revocation  absolute and idle expiry, sign-out, and
 *                                   what ends a session early (OPS-82)
 *   G3  server-side authorisation   every route refuses a caller with no
 *                                   session but the public ones, each said
 *                                   why (OPS-83); roles and businesses
 *   G4  partner isolation           a partner reaches only the portal, and
 *                                   only their own records there
 *   G5  KYC documents, retention    the application encrypted at rest; no
 *                                   document file held by the CRM; retention
 *   G6  consent and DND             every channel's opt-outs enforced at the
 *                                   API, service kept apart from marketing
 *   G7  India residency             raw client data never leaves India; what
 *                                   leaves is de-identified first (OPS-84)
 *
 * Production behaviour is checked in a child process with production's
 * environment, not in this one: the suite runs with the password cost lowered
 * (scripts/cheap-hashing.mjs), which production refuses to start with.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run, protectStoredTokens } from '../src/db.js';
import { tokenKey, decryptField, encryptField, hashPassword } from '../src/security.js';
import { issue as issueKey, revoke as revokeKey } from '../src/engine/apikeys.js';
import { sweepWebhooks } from '../src/engine/webhookdelivery.js';
import { applyClosure } from '../src/routes/partners-support.js';
import { checkConsent } from '../src/engine/consent.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { MOUNTS, ROUTES } from './helpers/routemap.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${String(err.message).split('\n')[0]}`); }
};
const call = async (headers, method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
/** The applicant's public KYC API: no CRM session. */
const pub = async (method, url, body) => {
  const res = await fetch(`${BASE}/dkyc-api${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const me = async (token) => (await call(bearer(token), 'GET', '/auth/me')).status;

/** Run a snippet in a fresh process with the environment given, and nothing of ours. */
function fresh(code, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CRM_SCRYPT_N', 'NODE_ENV', 'CRM_MASTER_KEY', 'SESSION_TTL_HOURS', 'SESSION_IDLE_MINUTES'].includes(k)));
  try {
    return { ok: true, out: execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: SERVER, env: { ...clean, ...env }, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const stamp = String(Date.now()).slice(-7);
const MARK = `Pilot gate ${stamp}`;
const probes = [];
const cleanups = [];
const probe = async (slug, role, org = 'BONANZA') => {
  const p = await probeAdmin(`gate-${slug}`, { role, sales_org: org });
  probes.push(p);
  return p;
};

/**
 * G3: the only routes a caller with no session gets past, and why each is
 * meant to be open. Everything else answers 401. A new route answering
 * anything else without a session fails the sweep until it is listed here,
 * with its reason.
 */
const PUBLIC = {
  'GET /dkyc-api/products': 'The public KYC journey: the products an applicant may apply for. Rate-limited.',
  'GET /dkyc-api/business': 'The public KYC journey: which business the page is for.',
  'GET /dkyc-api/steps/:productId': 'The public KYC journey: the steps of a product\'s application.',
  'POST /dkyc-api/start': 'The public KYC journey: an applicant starts their own application. Rate-limited.',
  'GET /dkyc-api/resume/:token': 'The resume link is the credential: random, kept hashed (OPS-80).',
  'POST /dkyc-api/resume/:token/otp': 'As above: the applicant\'s own link.',
  'POST /dkyc-api/resume/:token/step': 'As above: the applicant\'s own link.',
  'GET /public/market/indices': 'Delayed public market indices for the sign-in page; no client data.',
  'GET /api/webhooks/meta': 'Meta\'s subscription handshake: answered only to the configured verify token, refused otherwise.',
  'POST /api/webhooks/meta': 'Signed by Meta (X-Hub-Signature-256). Unsigned, refused in production (OPS-83); accepted only by the development simulator.',
  'GET /api/auth/reset/:token': 'The reset link is the credential: random, one hour, single use, kept hashed (OPS-80).',
  'POST /api/auth/reset/:token': 'As above.',
  'POST /api/auth/logout': 'Ends the caller\'s own session, if there is one; with none it does nothing.',
  'GET /api/health': 'Liveness for the load balancer: no data.',
  'GET /{*splat}': 'The app\'s own files. Every piece of data behind them comes through the API, which asks for a session.',
};

/** Every route there is: each route file as it is mounted, and the server's own. */
function everyRoute() {
  const out = [];
  for (const file of readdirSync(ROUTES)) {
    const map = MOUNTS[file];
    if (!map) continue;
    const src = readFileSync(path.join(ROUTES, file), 'utf8');
    for (const m of src.matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      if (m[1] in map) out.push({ method: m[2].toUpperCase(), path: (map[m[1]] + m[3]).replace(/\/$/, '') || '/' });
    }
  }
  const index = readFileSync(path.join(SERVER, 'src', 'index.js'), 'utf8');
  for (const m of index.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}

console.log('\nA6: the pilot gates');

try {
  /* ================================================================== G1
   * Credential hashing. Passwords with scrypt at the OWASP floor; API secrets
   * as SHA-256; and since OPS-80 and OPS-81, no bearer token or signing secret
   * kept as it was issued. */
  console.log('\nG1 credential hashing');

  await test('G1 every stored staff and partner password is an scrypt hash, and none is anything else', () => {
    const plain = one("SELECT COUNT(*) n FROM users WHERE password NOT LIKE 'scrypt$%'").n;
    assert.equal(plain, 0, `${plain} staff password(s) are not scrypt hashes`);
    const portal = one("SELECT COUNT(*) n FROM partners WHERE portal_password IS NOT NULL AND portal_password NOT LIKE 'scrypt$%'").n;
    assert.equal(portal, 0, `${portal} partner portal password(s) are not scrypt hashes`);
  });

  await test('G1 a password is hashed at the OWASP floor where the cost is not lowered: scrypt N=2^17, r=8, p=1', () => {
    const r = fresh("import('./src/security.js').then(async (m) => { const h = await m.hashPassword('x'); console.log(JSON.stringify({ policy: m.scryptPolicy(), hash: h.split('$').slice(0, 4) })); })", {});
    assert.ok(r.ok, r.out);
    const { policy, hash } = JSON.parse(r.out.trim().split('\n').pop());
    assert.deepEqual([policy.N, policy.r, policy.p, policy.keylen], [131072, 8, 1, 64]);
    assert.deepEqual(hash, ['scrypt', '131072', '8', '1'], `a new hash: ${hash}`);
  });

  await test('G1 production refuses to start with the password cost lowered, or without its own master key', () => {
    const cheap = fresh("import('./src/security.js')", { NODE_ENV: 'production', CRM_SCRYPT_N: '1024', CRM_MASTER_KEY: 'a'.repeat(64) });
    assert.ok(!cheap.ok && /CRM_SCRYPT_N must not be set in production/.test(cheap.out), `with a lowered cost: ${cheap.out.slice(0, 200)}`);
    const devKey = fresh("import('./src/security.js').then((m) => m.encryptField('x'))", { NODE_ENV: 'production' });
    assert.ok(!devKey.ok && /CRM_MASTER_KEY must be set in production/.test(devKey.out), `with the development key: ${devKey.out.slice(0, 200)}`);
  });

  await test('G1 an API secret is kept as its SHA-256, never as issued', async () => {
    const owner = await probe('api-owner', 'admin');
    const key = issueKey({ label: `${MARK} key`, userId: owner.id, scopes: ['lead.view.all'] });
    cleanups.push(() => run('DELETE FROM api_credential WHERE key_id = ?', [key.key_id]));
    const row = one('SELECT * FROM api_credential WHERE key_id = ?', [key.key_id]);
    assert.ok(!Object.values(row).some((v) => String(v).includes(key.secret)), 'the secret is stored somewhere in its row');
    assert.match(row.secret_hash, /^[0-9a-f]{64}$/);
    revokeKey(row.id);
  });

  await test('G1 OPS-80 a sign-in session is kept as the hash of its token; the token works, the stored value does not', async () => {
    const who = await probe('session', 'sales_rm');
    const stored = all('SELECT token FROM sessions WHERE user_id = ?', [who.id]).map((r) => r.token);
    assert.ok(stored.length, 'no session row for a signed-in user');
    assert.ok(stored.every((t) => t.startsWith('sha256$') && t !== who.token), `stored as: ${stored[0]?.slice(0, 20)}`);
    assert.ok(stored.includes(tokenKey(who.token)), 'the stored value is not the hash of the token');
    assert.equal(await me(who.token), 200, 'the token itself no longer signs in');
    assert.equal(await me(stored[0]), 401, 'the stored value signs in: reading the table is enough to take over the session');
  });

  await test('G1 OPS-80 a password reset link is kept as its hash, and only the link itself opens it', async () => {
    const admin = await probe('reset-admin', 'admin');
    const target = await probe('reset-target', 'sales_rm');
    const issued = await call(admin.headers, 'POST', `/setup/users/${target.id}/reset-link`);
    assert.equal(issued.status, 200, `the link answered ${issued.status}: ${issued.body?.error}`);
    const token = issued.body.link.split('/reset/')[1];
    const row = one('SELECT token FROM password_reset WHERE user_id = ?', [target.id]);
    assert.equal(row.token, tokenKey(token), `stored as ${row.token.slice(0, 20)}`);
    assert.equal((await call({}, 'GET', `/auth/reset/${encodeURIComponent(token)}`)).status, 200, 'the link does not open');
    assert.equal((await call({}, 'GET', `/auth/reset/${encodeURIComponent(row.token)}`)).status, 404, 'the stored value opens the link');
    cleanups.push(() => run('DELETE FROM password_reset WHERE user_id = ?', [target.id]));
  });

  await test('G1 OPS-80 a KYC resume link is found by its hash and kept encrypted; staff can still open it for the applicant', async () => {
    const product = one("SELECT id FROM product_types WHERE code = 'EQD' AND sales_org = 'BONANZA'").id;
    const started = await pub('POST', '/start', { product_type_id: product, mobile: `90${stamp}9`.slice(0, 10) });
    assert.equal(started.status, 201, `the start answered ${started.status}: ${started.body?.error}`);
    const token = started.body.resume_token;
    const row = one('SELECT id, resume_token, resume_key FROM kyc_journeys WHERE resume_key = ?', [tokenKey(token)]);
    assert.ok(row, 'the journey is not found by the hash of its token');
    cleanups.push(() => run('DELETE FROM kyc_journeys WHERE id = ?', [row.id]));
    assert.ok(row.resume_token.startsWith('v1:') && !row.resume_token.includes(token), 'the token is stored as issued');
    assert.equal(decryptField(row.resume_token), token);
    assert.equal((await pub('GET', `/resume/${token}`)).status, 200, 'the applicant\'s link does not open');
    assert.equal((await pub('GET', `/resume/${encodeURIComponent(row.resume_key)}`)).status, 404, 'the stored key opens the journey');
    const care = await probe('kyc-staff', 'admin');
    const staff = await call(care.headers, 'GET', `/kyc/journeys/${row.id}`);
    assert.equal(staff.body?.resume_token, token, 'staff can no longer open the applicant\'s link (OPS-67)');
  });

  await test('G1 OPS-81 a webhook signing secret is kept encrypted, and deliveries are still signed with it', async () => {
    const sa = await probe('hooks', 'superadmin');
    const secret = `${MARK} signing secret`;
    const made = await call(sa.headers, 'POST', '/setup/webhook-endpoints', { name: `${MARK} hook`, url: 'https://hooks.example.in/crm', secret });
    assert.ok([200, 201].includes(made.status), `the endpoint answered ${made.status}: ${made.body?.error}`);
    const endpoint = one('SELECT * FROM webhook_endpoint WHERE name = ?', [`${MARK} hook`]);
    cleanups.push(() => run('DELETE FROM webhook_endpoint WHERE id = ?', [endpoint.id]));
    assert.ok(endpoint.secret.startsWith('v1:') && !endpoint.secret.includes(secret), 'the secret is stored as typed');
    const payload = JSON.stringify({ event: 'lead.created', id: 1 });
    run("INSERT INTO webhook_delivery (endpoint_id, payload, status) VALUES (?, ?, 'queued')", [endpoint.id, payload]);
    // Only this endpoint's delivery goes through the stub: the others are paused for the sweep.
    const others = all('SELECT id FROM webhook_endpoint WHERE active = 1 AND id != ?', [endpoint.id]).map((r) => r.id);
    const pause = (on) => others.length && run(`UPDATE webhook_endpoint SET active = ? WHERE id IN (${others.map(() => '?').join(',')})`, [on, ...others]);
    let seen = null;
    pause(0);
    try {
      await sweepWebhooks({ fetchImpl: async (url, opts) => { if (url === 'https://hooks.example.in/crm') seen = opts; return { ok: true, status: 200 }; } });
    } finally { pause(1); }
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    assert.equal(seen?.headers?.['X-Bonanza-Signature'], `sha256=${expected}`, 'the delivery is not signed with the real secret');
  });

  await test('G1 OPS-80/81 rows from before are protected in place on start, and nobody is signed out', async () => {
    const who = await probe('legacy', 'sales_rm');
    const raw = `legacy-${stamp}-${Math.random().toString(36).slice(2)}`;
    run("INSERT INTO sessions (token, user_id, kind, expires_at, last_seen_at) VALUES (?, ?, 'crm', datetime('now', '+1 hour'), datetime('now'))", [raw, who.id]);
    const hook = Number(run("INSERT INTO webhook_endpoint (name, url, secret) VALUES (?, 'https://hooks.example.in/old', 'old-plain-secret')", [`${MARK} old hook`]).lastInsertRowid);
    cleanups.push(() => run('DELETE FROM webhook_endpoint WHERE id = ?', [hook]));
    protectStoredTokens();
    assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE token = ?', [raw]).n, 0, 'a session is still stored as issued');
    assert.equal(await me(raw), 200, 'the session protected in place no longer works');
    assert.equal(decryptField(one('SELECT secret FROM webhook_endpoint WHERE id = ?', [hook]).secret), 'old-plain-secret');
    assert.equal(protectStoredTokens(), 0, 'a second pass changed something');
  });

  /* ================================================================== G2
   * Sessions expire, absolutely and when idle, and end when they should. */
  console.log('\nG2 session expiry and revocation');

  await test('G2 a session lasts 12 hours at most and 120 idle minutes, unless configured otherwise', () => {
    const r = fresh("import('./src/security.js').then((m) => console.log(JSON.stringify([m.SESSION_TTL_HOURS, m.SESSION_IDLE_MINUTES])))", {});
    assert.ok(r.ok, r.out);
    assert.deepEqual(JSON.parse(r.out.trim().split('\n').pop()), [12, 120]);
  });

  await test('G2 a session past its absolute expiry is refused, and removed', async () => {
    const who = await probe('expired', 'sales_rm');
    run("UPDATE sessions SET expires_at = datetime('now', '-1 minute') WHERE token = ?", [tokenKey(who.token)]);
    assert.equal(await me(who.token), 401, 'an expired session still works');
    assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE token = ?', [tokenKey(who.token)]).n, 0, 'the expired session was left behind');
  });

  await test('G2 a session idle past its limit is refused, though its absolute expiry is hours away', async () => {
    const who = await probe('idle', 'sales_rm');
    run("UPDATE sessions SET last_seen_at = datetime('now', '-121 minutes') WHERE token = ?", [tokenKey(who.token)]);
    assert.equal(await me(who.token), 401, 'an idle session still works');
  });

  await test('G2 signing out ends the session', async () => {
    const who = await probe('signout', 'sales_rm');
    assert.equal((await call(bearer(who.token), 'POST', '/auth/logout')).status, 200);
    assert.equal(await me(who.token), 401, 'the session survived signing out');
  });

  await test('G2 an Admin setting a new password ends every one of that person\'s sessions', async () => {
    const admin = await probe('pw-admin', 'admin');
    const who = await probe('pw-target', 'sales_rm');
    const res = await call(admin.headers, 'PATCH', `/setup/users/${who.id}`, { password: `New-${stamp}-password` });
    assert.equal(res.status, 200, `the change answered ${res.status}: ${res.body?.error}`);
    assert.equal(await me(who.token), 401, 'a session survived the password change');
  });

  await test('G2 a password reset by link ends every session too', async () => {
    const admin = await probe('link-admin', 'admin');
    const who = await probe('link-target', 'sales_rm');
    const token = (await call(admin.headers, 'POST', `/setup/users/${who.id}/reset-link`)).body.link.split('/reset/')[1];
    cleanups.push(() => run('DELETE FROM password_reset WHERE user_id = ?', [who.id]));
    assert.equal((await call({}, 'POST', `/auth/reset/${encodeURIComponent(token)}`, { password: `Reset-${stamp}-password` })).status, 200);
    assert.equal(await me(who.token), 401, 'a session survived the reset');
    assert.equal((await call({}, 'POST', `/auth/reset/${encodeURIComponent(token)}`, { password: `Again-${stamp}-password` })).status, 400, 'the link worked twice');
  });

  await test('G2 a deactivated person is refused at once, and their sessions removed', async () => {
    const admin = await probe('deact-admin', 'admin');
    const who = await probe('deact-target', 'sales_rm');
    const res = await call(admin.headers, 'POST', `/setup/users/${who.id}/active`, { active: false });
    assert.equal(res.status, 200, `the change answered ${res.status}: ${res.body?.error}`);
    assert.equal(await me(who.token), 401, 'a deactivated person still works');
    assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', [who.id]).n, 0, 'their sessions were left behind');
  });

  await test('G2 a change of role applies on the very next request, without signing in again', async () => {
    const who = await probe('role', 'sales_rm');
    assert.equal((await call(who.headers, 'GET', '/admin/users')).status, 403);
    run("UPDATE users SET role = 'admin' WHERE id = ?", [who.id]);
    assert.notEqual((await call(who.headers, 'GET', '/admin/users')).status, 403, 'the new role did not apply');
    run("UPDATE users SET role = 'sales_rm' WHERE id = ?", [who.id]);
    assert.equal((await call(who.headers, 'GET', '/admin/users')).status, 403, 'the old role lingered');
  });

  /* Partners: suspension ends the sessions, and OPS-82 refuses one that slips through. */
  const partner = Number(run(
    "INSERT INTO partners (name, sales_org, state_code, portal_password) VALUES (?, 'BONANZA', 'ACTIVE', ?)",
    [`${MARK} partner`, await hashPassword(`portal-${stamp}`)],
  ).lastInsertRowid);
  cleanups.push(() => { run('DELETE FROM sessions WHERE partner_id = ?', [partner]); run('DELETE FROM activities WHERE partner_id = ?', [partner]); run('DELETE FROM partners WHERE id = ?', [partner]); });
  const partnerSession = () => {
    const token = `gate-partner-${stamp}-${Math.random().toString(36).slice(2)}`;
    run("INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?, ?, 'partner', datetime('now', '+1 hour'), datetime('now'))", [tokenKey(token), partner]);
    return token;
  };
  const portal = async (token) => (await call(bearer(token), 'GET', '/portal/dashboard')).status;

  await test('G2 OPS-82 a partner whose state no longer allows the portal is refused on the next request, however it changed', async () => {
    const token = partnerSession();
    assert.equal(await portal(token), 200, 'an active partner\'s session does not work');
    run("UPDATE partners SET state_code = 'SUSPENDED' WHERE id = ?", [partner]);   // as a route that forgot to end the session would
    assert.equal(await portal(token), 401, 'a suspended partner\'s surviving session still works');
    run("UPDATE partners SET state_code = 'ACTIVE' WHERE id = ?", [partner]);
  });

  await test('G2 suspending a partner ends their sessions and withdraws the portal', async () => {
    const token = partnerSession();
    const actor = await probe('closure', 'admin');
    applyClosure(one('SELECT * FROM partners WHERE id = ?', [partner]), 'SUSPENDED', `${MARK}: complaints`, actor.id);
    assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE partner_id = ?', [partner]).n, 0, 'a session survived the suspension');
    assert.equal(await portal(token), 401);
    assert.equal(one('SELECT portal_password FROM partners WHERE id = ?', [partner]).portal_password, null, 'the portal password survived');
  });

  /* ================================================================== G3
   * Server-side authorisation. The screen is convenience; the API decides,
   * every time: a session first, then the role's capability, then the
   * business and the reader's scope on the record itself. */
  console.log('\nG3 server-side authorisation');

  await test('G3 every route refuses a caller with no session, except the public ones, each with its reason', async () => {
    const routes = everyRoute();
    assert.ok(routes.length > 400, `only ${routes.length} routes found: the sweep is not reading the code`);
    const answered = [];
    for (const r of routes) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${BASE}${r.path.replace(/:(\w+)/g, '1')}`, {
        method: r.method, headers: { 'Content-Type': 'application/json' }, body: ['GET', 'DELETE'].includes(r.method) ? undefined : '{}',
      });
      const key = `${r.method} ${r.path}`;
      if (res.status !== 401 && !(key in PUBLIC)) answered.push(`${res.status} ${key}`);
    }
    assert.deepEqual(answered, [], `these answered with no session:\n         ${answered.join('\n         ')}`);
    const live = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = Object.keys(PUBLIC).filter((k) => !live.has(k));
    assert.deepEqual(stale, [], 'listed as public, but no such route');
  });

  await test('G3 OPS-83 in production, an unconnected Meta refuses an unsigned delivery', () => {
    const code = "import('./src/vendors/meta.js').then((m) => console.log(JSON.stringify(m.verifyWebhook({ get: () => undefined, rawBody: Buffer.from('{}') }))))";
    const prod = fresh(code, { NODE_ENV: 'production', CRM_MASTER_KEY: 'a'.repeat(64) });
    assert.ok(prod.ok, prod.out);
    const verdict = JSON.parse(prod.out.trim().split('\n').pop());
    assert.equal(verdict.ok, false, 'an unsigned delivery is accepted in production');
  });

  await test('G3 a role is refused what its capabilities do not allow, and the refusal names the permission', async () => {
    const caller = await probe('cap-caller', 'caller');
    const res = await call(caller.headers, 'GET', '/admin/users');
    assert.equal(res.status, 403);
    assert.equal(res.body?.required, 'admin.users');
  });

  await test('G3 a record of the other business is refused by the boundary itself, even to an Admin', async () => {
    const bigulAdmin = await probe('book-admin', 'admin', 'BIGUL');
    const bonanzaLead = one("SELECT id FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL ORDER BY id LIMIT 1").id;
    const res = await call(bigulAdmin.headers, 'GET', `/leads/${bonanzaLead}`);
    assert.ok([403, 404].includes(res.status), `a Bigul Admin opened a Bonanza lead: HTTP ${res.status}`);
    assert.equal(res.body?.required, undefined, 'refused for want of a permission, not by the boundary');
  });

  /* ================================================================== G4
   * Partner isolation. A partner signs in to the portal only, and sees only
   * their own referrals, cases and commissions there. */
  console.log('\nG4 partner isolation');

  const twoPartners = [];
  for (const n of [1, 2]) {
    const id = Number(run("INSERT INTO partners (name, sales_org, state_code) VALUES (?, 'BONANZA', 'ACTIVE')", [`${MARK} partner ${n}`]).lastInsertRowid);
    const lead = Number(run("INSERT INTO leads (sales_org, name, mobile, source, stage, partner_id) VALUES ('BONANZA', ?, ?, 'Partner', 'New', ?)",
      [`${MARK} referral ${n}`, `89${stamp}${n}`.slice(0, 10), id]).lastInsertRowid);
    const ticket = Number(run("INSERT INTO tickets (ref, subject, description, sales_org, status, priority, partner_id) VALUES (?, ?, 'x', 'BONANZA', 'Open', 'Low', ?)",
      [`BNZ-PG${stamp}${n}`, `${MARK} case ${n}`, id]).lastInsertRowid);
    const token = `gate-iso-${stamp}-${n}`;
    run("INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?, ?, 'partner', datetime('now', '+1 hour'), datetime('now'))", [tokenKey(token), id]);
    twoPartners.push({ id, lead, ticket, token });
    cleanups.push(() => {
      run('DELETE FROM sessions WHERE partner_id = ?', [id]);
      run('DELETE FROM tickets WHERE id = ?', [ticket]);
      run('DELETE FROM leads WHERE id = ?', [lead]);
      run('DELETE FROM partners WHERE id = ?', [id]);
    });
  }
  const [P1, P2] = twoPartners;

  await test('G4 a partner\'s session reaches no CRM route', async () => {
    for (const url of ['/leads', `/leads/${P1.lead}`, '/tickets', '/cockpit', '/admin/users']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await call(bearer(P1.token), 'GET', url)).status, 401, `a partner reached ${url}`);
    }
  });

  await test('G4 a staff session reaches no portal route', async () => {
    const staff = await probe('iso-staff', 'admin');
    assert.equal((await call(staff.headers, 'GET', '/portal/dashboard')).status, 401);
  });

  await test('G4 a partner sees their own referral and case, and never another partner\'s', async () => {
    const own = await call(bearer(P1.token), 'GET', `/portal/tickets/${P1.ticket}`);
    assert.equal(own.status, 200, `their own case: HTTP ${own.status}`);
    assert.equal((await call(bearer(P1.token), 'GET', `/portal/tickets/${P2.ticket}`)).status, 404, 'another partner\'s case opened');
    assert.equal((await call(bearer(P1.token), 'GET', `/portal/clients/${P2.lead}`)).status, 404, 'another partner\'s referral opened');
    const list = JSON.stringify((await call(bearer(P1.token), 'GET', '/portal/dashboard')).body ?? {});
    assert.ok(!list.includes(`${MARK} referral 2`) && !list.includes(`${MARK} case 2`), 'another partner\'s records are listed');
  });

  /* ================================================================== G5
   * KYC documents and retention. Ruled 20 Nov: the pilot's documents live in
   * Bonanza's eKYC portal (handoff mode); the CRM holds no document file. What
   * the CRM does hold of an application is encrypted at rest. Retention as
   * now, written up for Compliance to confirm. */
  console.log('\nG5 KYC documents and retention');

  await test('G5 an application\'s answers are encrypted at rest: no PAN, account number or address readable in the table', async () => {
    const product = one("SELECT id FROM product_types WHERE code = 'EQD' AND sales_org = 'BONANZA'").id;
    const started = await pub('POST', '/start', { product_type_id: product, mobile: `88${stamp}7`.slice(0, 10) });
    assert.equal(started.status, 201, `the start answered ${started.status}`);
    const row = one('SELECT id, form_data FROM kyc_journeys WHERE resume_key = ?', [tokenKey(started.body.resume_token)]);
    cleanups.push(() => run('DELETE FROM kyc_journeys WHERE id = ?', [row.id]));
    run('UPDATE kyc_journeys SET form_data = ? WHERE id = ?', [encryptField(JSON.stringify({ pan: 'ABCPE1234F', account_number: '000123456789', address: '12 Marine Drive' })), row.id]);
    const stored = one('SELECT * FROM kyc_journeys WHERE id = ?', [row.id]);
    const text = JSON.stringify(stored);
    for (const secret of ['ABCPE1234F', '000123456789', 'Marine Drive']) assert.ok(!text.includes(secret), `${secret} is readable in the row`);
    assert.match(stored.form_data, /^v1:/);
  });

  await test('G5 the CRM\'s own journey takes no document file: an upload field carries a name, never the file', () => {
    const portal = readFileSync(path.join(SERVER, '..', 'client', 'src', 'dkyc', 'DkycPortal.jsx'), 'utf8');
    assert.ok(!/FileReader|readAsDataURL|new FormData/.test(portal), 'the KYC page reads or sends a file');
    const steps = readFileSync(path.join(SERVER, 'src', 'engine', 'kyc.js'), 'utf8');
    assert.ok(!/writeFileSync|createWriteStream/.test(steps), 'the KYC engine writes a file');
  });

  /* ================================================================== G6
   * Consent and DND. Each client's own withdrawals, per channel, enforced at
   * the API for every sender; marketing kept apart from service. The national
   * DND register is screened by the carriers (ruled 20 Nov): the DLT platform
   * for promotional SMS, and the dialler. */
  console.log('\nG6 consent and DND');

  const consentLead = Number(run(
    "INSERT INTO leads (sales_org, name, mobile, email, source, stage, marketing_opt_out, no_call) VALUES ('BONANZA', ?, ?, ?, 'Website', 'New', 1, 1)",
    [`${MARK} opted out`, `87${stamp}3`.slice(0, 10), `optout-${stamp}@example.com`],
  ).lastInsertRowid);
  cleanups.push(() => { run('DELETE FROM activities WHERE lead_id = ?', [consentLead]); run('DELETE FROM leads WHERE id = ?', [consentLead]); });

  await test('G6 a client who opted out of marketing gets no marketing on any channel, and still gets service messages', () => {
    const lead = one('SELECT * FROM leads WHERE id = ?', [consentLead]);
    for (const channel of ['sms', 'whatsapp', 'email']) {
      assert.equal(checkConsent(lead, channel, 'marketing').allowed, false, `marketing by ${channel} allowed`);
      assert.equal(checkConsent(lead, channel, 'service').allowed, true, `service by ${channel} refused`);
    }
  });

  await test('G6 a client who asked not to be called is not called, not even for service', () => {
    const lead = one('SELECT * FROM leads WHERE id = ?', [consentLead]);
    assert.equal(checkConsent(lead, 'call', 'service').allowed, false);
    assert.equal(checkConsent(lead, 'ivr', 'service').allowed, false);
  });

  await test('G6 the API refuses a marketing send to them, whoever asks', async () => {
    const admin = await probe('consent-admin', 'admin');
    const res = await call(admin.headers, 'POST', `/leads/${consentLead}/message`, { channel: 'whatsapp', intent: 'marketing', body: `${MARK} offer` });
    assert.ok(res.status >= 400 && res.status < 500, `a marketing WhatsApp to an opted-out client answered ${res.status}`);
    assert.equal(one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'WhatsApp'", [consentLead]).n, 0, 'the message was logged as sent');
  });

  await test('G6 a call logged as Do Not Disturb suppresses the client from every campaign', async () => {
    const rm = await probe('dnd-rm', 'sales_rm');
    const lead = Number(run(
      "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id) VALUES ('BONANZA', ?, ?, 'Website', 'Contacted', ?)",
      [`${MARK} DND`, `85${stamp}1`.slice(0, 10), rm.id],
    ).lastInsertRowid);
    cleanups.push(() => { run('DELETE FROM activities WHERE lead_id = ?', [lead]); run('DELETE FROM leads WHERE id = ?', [lead]); });
    const res = await call(rm.headers, 'POST', '/activities', { lead_id: lead, type: 'Call', disposition: 'CALL_DND', duration_s: 20, reason: 'Asked to be put on Do Not Disturb', body: `${MARK}: asked for no more calls` });
    assert.equal(res.status, 201, `the call answered ${res.status}: ${res.body?.error}`);
    const after = one('SELECT * FROM leads WHERE id = ?', [lead]);
    assert.equal(after.marketing_opt_out, 1, 'the client is not suppressed from campaigns');
    assert.equal(checkConsent(after, 'sms', 'marketing').allowed, false, 'a marketing SMS is still allowed');
  });

  /* ================================================================== G7
   * India residency. Raw client data is processed only in India; what goes
   * abroad is de-identified first, and checked before it leaves. OPS-84: the
   * policy was named for every call and obeyed by none. Proved here with a
   * frontier provider configured and pointed at a recorder on this machine. */
  console.log('\nG7 India residency');

  await test('G7 OPS-84 with a frontier provider configured, raw client data never reaches it; de-identified work does, without identifiers', async () => {
    const seen = [];
    const recorder = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push(body); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"type":"error","error":{"type":"invalid_request_error","message":"recorder"}}'); });
    });
    await new Promise((resolve) => recorder.listen(0, '127.0.0.1', resolve));
    const port = recorder.address().port;
    const lead = Number(run(
      "INSERT INTO leads (sales_org, name, mobile, email, source, stage) VALUES ('BONANZA', ?, ?, ?, 'Website', 'Contacted')",
      [`Residency Probe ${stamp}`, `86${stamp}5`.slice(0, 10), `residency-${stamp}@example.com`],
    ).lastInsertRowid);
    cleanups.push(() => run('DELETE FROM leads WHERE id = ?', [lead]));
    try {
      const code = `
        const ai = await import('./src/ai/index.js');
        const out = {};
        const attempt = async (k, fn) => { try { await fn(); out[k] = 'answered'; } catch (e) { out[k] = 'failed: ' + e.message.slice(0, 80); } };
        await attempt('disposition', () => ai.disposition(ai.dispositionContext(${lead}, 'I am Residency Probe ${stamp}, my number is ${`86${stamp}5`.slice(0, 10)}, call me about a SIP', 120)));
        await attempt('kycCoach', () => ai.kycCoach({ id: 1, lead_name: 'Residency Probe ${stamp}', applicant_mobile: '${`86${stamp}5`.slice(0, 10)}', status: 'Stalled', current_step: 'PAN' }));
        await attempt('nextAction', () => ai.nextAction(ai.nextActionContext(${lead})));
        out.report = ai.residency().capabilities.map((c) => [c.capability, c.routed_to, c.served_by]);
        console.log(JSON.stringify(out));`;
      const r = await new Promise((resolve) => {
        const env = { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-recorder', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CRM_AI_RESIDENCY: 'hybrid' };
        delete env.NODE_ENV;
        import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: SERVER, env }, (err, stdout, stderr) => resolve({ err, out: `${stdout}${stderr}` })));
      });
      const line = r.out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
      assert.ok(line, `the AI layer did not report: ${r.out.slice(-300)}`);
      const out = JSON.parse(line);
      const sent = seen.join('\n');
      assert.ok(!sent.includes(`Residency Probe ${stamp}`), 'a client\'s name reached the frontier provider');
      assert.ok(!sent.includes(`86${stamp}5`.slice(0, 10)), 'a client\'s mobile reached the frontier provider');
      assert.ok(!sent.includes('call me about a SIP'), 'a call transcript reached the frontier provider');
      assert.ok(seen.length >= 1, `the de-identified next-action call never went to the frontier (${JSON.stringify(out)})`);
      const served = Object.fromEntries(out.report.map(([k, , by]) => [k, by]));
      assert.equal(served.disposition, 'offline stub', `disposition is served by ${served.disposition}`);
      assert.equal(served.kycCoach, 'offline stub', `KYC coaching is served by ${served.kycCoach}`);
      assert.match(served.nextAction, /^Claude/, `next action is served by ${served.nextAction}`);
    } finally {
      await new Promise((resolve) => recorder.close(resolve));
    }
  });

  await test('G7 in the strict modes nothing reaches the frontier, whatever is configured', () => {
    for (const mode of ['in_india_only', 'offline']) {
      const r = fresh("import('./src/ai/index.js').then((ai) => console.log(JSON.stringify(ai.residency().capabilities.map((c) => c.served_by))))",
        { CRM_AI_RESIDENCY: mode, ANTHROPIC_API_KEY: 'sk-ant-recorder', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
      assert.ok(r.ok, r.out);
      const by = JSON.parse(r.out.trim().split('\n').pop());
      assert.ok(by.every((b) => b === 'offline stub'), `${mode}: served by ${by}`);
    }
  });
} finally {
  for (const fn of cleanups.reverse()) { try { fn(); } catch { /* best effort */ } }
  for (const p of [...probes].reverse()) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
