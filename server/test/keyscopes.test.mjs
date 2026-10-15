/**
 * OPS-42: what a request may do is what its caller holds, not its role.
 *
 * Reproduced 15 Oct: an Admin's key scoped to lead.view.own was answered on
 * /admin/rules, /admin/users and /admin/audit, because the route guards and
 * the inline checks asked can(role, ...). The same mistake from the other
 * side: a Sales RM granted a permission set with admin.rules was listed as
 * holding it by /auth/me and refused it by /admin/rules. Both now read the
 * request's capabilities -- the role, plus granted sets, narrowed by a key's
 * scopes -- and a key cannot be issued without a scope.
 *
 * Ritesh, 15 Oct, also: a dedicated API integration account for the trading
 * platform, holding only the nomination pop-up, that cannot sign in.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { issue } from '../src/engine/apikeys.js';
import { roleCapabilities } from '../src/engine/access.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nCapabilities, not roles: API key scopes and permission sets (OPS-42)');

const RUN = Date.now().toString(36);
const MARK = `KS probe ${RUN}`;

const SUPER = await probeAdmin('ks-super', { role: 'superadmin', sales_org: 'BONANZA' });
const ADMIN = await probeAdmin('ks-admin', { role: 'admin', sales_org: 'BONANZA' });
const RM = await probeAdmin('ks-rm', { role: 'sales_rm', sales_org: 'BONANZA' });

const call = async (method, url, headers, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), total: Number(res.headers.get('x-total-count') ?? 0) };
};
const as = (who) => (method, url, body) => call(method, url, who.headers, body);
const withKey = (k) => (method, url, body) => call(method, url, { 'x-api-key': k.key_id, 'x-api-secret': k.secret }, body);
const keyFor = (user, scopes, label = 'key') => issue({ label: `${MARK} ${label}`, userId: user.id, scopes });

/* The integration account, made directly: it cannot sign in, which is the
   point. The seeded administrator's hash, so its password is known. */
const PLATFORM_EMAIL = 'probe-ks-platform@bonanza.test';
run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)', [PLATFORM_EMAIL]);
run('DELETE FROM users WHERE email = ?', [PLATFORM_EMAIL]);
const PLATFORM = {
  id: Number(run(
    `INSERT INTO users (name, email, password, role, sales_org, active)
     VALUES (?, ?, (SELECT password FROM users WHERE email = 'admin@bonanza.test'), 'integration', 'BONANZA', 1)`,
    ['Probe ks-platform', PLATFORM_EMAIL],
  ).lastInsertRowid),
};

const sets = [];

try {
  /* ------------------------------------------------------ route guards */

  await test('a key scoped to one capability is refused what else its Admin could do', async () => {
    const key = withKey(keyFor(ADMIN, ['admin.rules'], 'rules only'));
    const admin = as(ADMIN);

    for (const url of ['/admin/rules', '/admin/users', '/admin/audit']) {
      assert.equal((await admin('GET', url)).status, 200, `the Admin's own session was refused ${url}`);
    }
    assert.equal((await key('GET', '/admin/rules')).status, 200, 'the key was refused the one thing it is for');
    for (const url of ['/admin/users', '/admin/audit']) {
      const r = await key('GET', url);
      assert.equal(r.status, 403, `a key scoped to admin.rules was answered on ${url}`);
      assert.match(r.body.error, /not scoped/i, 'the refusal does not say it is the key\'s scope');
    }
  });

  await test('the inline checks read the key\'s scopes too, not the role', async () => {
    const admin = (await as(ADMIN)('GET', '/clients/meta')).body;
    assert.equal(admin.may_unmask, true, 'precondition: an Admin may unmask');
    const key = (await withKey(keyFor(ADMIN, ['client.view.all'], 'clients'))('GET', '/clients/meta')).body;
    assert.equal(key.may_unmask, false, 'a key without pii.unmask was offered unmasking');
    assert.equal(key.may_reassign, false, 'a key without client.reassign was offered reassignment');
  });

  await test('a key\'s data scope narrows with it', async () => {
    /* leadScope asked can(role, 'lead.view.all'): an Admin's key scoped to
       rules saw the whole business's leads. */
    const session = await as(ADMIN)('GET', '/leads?limit=1');
    assert(session.total > 0, 'precondition: the Admin sees leads');
    const key = await withKey(keyFor(ADMIN, ['admin.rules'], 'no leads'))('GET', '/leads?limit=1');
    assert.equal(key.total, 0, `a key without lead.view.all saw ${key.total} leads`);
  });

  /* --------------------------------------------------- permission sets */

  await test('a granted permission set opens its route, and revoking it closes it again', async () => {
    const rm = as(RM);
    assert.equal((await rm('GET', '/admin/rules')).status, 403, 'precondition: a Sales RM cannot read rules');

    const made = await as(ADMIN)('POST', '/setup/permission-sets', {
      name: `${MARK} rules`, sales_org: 'BONANZA', capabilities: ['admin.rules'],
    });
    assert.equal(made.status, 201, made.body?.error);
    sets.push(made.body.id);

    const granted = await as(ADMIN)('POST', `/setup/users/${RM.id}/permission-sets`, { set_id: made.body.id, reason: 'OPS-42 test' });
    assert.equal(granted.status, 201, granted.body?.error);
    assert((await rm('GET', '/auth/me')).body.user.permissions.includes('admin.rules'), 'precondition: /auth/me lists the grant');
    assert.equal((await rm('GET', '/admin/rules')).status, 200, 'the grant /auth/me lists was refused by the route');

    await as(ADMIN)('DELETE', `/setup/users/${RM.id}/permission-sets/${made.body.id}`);
    assert.equal((await rm('GET', '/admin/rules')).status, 403, 'a revoked grant still opened the route');
  });

  /* ------------------------------------------------------------ issuing */

  await test('a key cannot be issued without a scope, or with one its user lacks', async () => {
    const issueVia = (body) => as(SUPER)('POST', '/setup/api-credentials', { label: `${MARK} issued`, user_id: RM.id, ...body });
    assert.equal((await issueVia({ scopes: null })).status, 400, 'a key with no scope was issued');
    assert.equal((await issueVia({ scopes: [] })).status, 400, 'a key with an empty scope was issued');
    assert.equal((await issueVia({ scopes: ['not.a.capability'] })).status, 400, 'an unknown scope was accepted');
    const beyond = await issueVia({ scopes: ['admin.system'] });
    assert.equal(beyond.status, 400, 'a scope the user lacks was accepted');
    assert.match(beyond.body.error, /cannot do admin\.system/);
    const ok = await issueVia({ scopes: ['lead.view.own'] });
    assert.equal(ok.status, 201, ok.body?.error);
    assert.throws(() => issue({ label: `${MARK} engine`, userId: RM.id }), /at least one scope/, 'the engine issued an unscoped key');
  });

  await test('a key issued before scopes were required is flagged, and narrowing it keeps its secret', async () => {
    const raw = keyFor(ADMIN, ['admin.rules'], 'legacy');
    const row = one('SELECT id FROM api_credential WHERE key_id = ?', [raw.key_id]);
    run('UPDATE api_credential SET scopes = NULL WHERE id = ?', [row.id]);   // as one issued before OPS-42
    const key = withKey(raw);

    // Until narrowed it keeps working as before, so no integration breaks on deploy.
    assert.equal((await key('GET', '/admin/users')).status, 200, 'an existing unscoped key stopped working on deploy');
    const listed = (await as(SUPER)('GET', '/setup/api-credentials')).body.credentials.find((c) => c.id === row.id);
    assert.equal(listed.scopes, null, 'the screen cannot tell the key is unscoped');
    assert.equal(listed.user_id, ADMIN.id, 'the screen cannot tell whose capabilities to offer');

    assert.equal((await as(SUPER)('PATCH', `/setup/api-credentials/${row.id}`, { scopes: [] })).status, 400, 'scopes were emptied');
    assert.equal((await as(SUPER)('PATCH', `/setup/api-credentials/${row.id}`, { scopes: ['admin.system'] })).status, 400,
      'a key was scoped beyond its user');
    const narrowed = await as(SUPER)('PATCH', `/setup/api-credentials/${row.id}`, { scopes: ['admin.rules'] });
    assert.equal(narrowed.status, 200, narrowed.body?.error);
    assert.equal((await key('GET', '/admin/users')).status, 403, 'the narrowed key still reached /admin/users');
    assert.equal((await key('GET', '/admin/rules')).status, 200, 'the narrowed key lost its secret or its scope');
    assert(one("SELECT id FROM audit_log WHERE action = 'api_credential_scoped' AND entity_id = ?", [row.id]),
      'narrowing a key was not audited');
  });

  /* --------------------------------------------------- the integration */

  await test('the API integration account cannot sign in, be signed in as, or hold a session', async () => {
    const login = await call('POST', '/auth/login', {}, { email: PLATFORM_EMAIL, password: 'bonanza' });
    assert.equal(login.status, 403, `an integration account signed in: ${login.status}`);
    assert.match(login.body.error, /integration account/i);
    assert(!login.body.token, 'a token was handed out');

    const ghost = await as(SUPER)('POST', `/setup/users/${PLATFORM.id}/ghost`, {});
    assert.equal(ghost.status, 403, 'a Superadmin signed in as the integration');

    const token = `ks-${RUN}-${Math.random().toString(36).slice(2)}`;
    run(`INSERT INTO sessions (token, user_id, kind, expires_at, last_seen_at)
         VALUES (?, ?, 'crm', datetime('now', '+1 hours'), datetime('now'))`, [token, PLATFORM.id]);
    assert.equal((await call('GET', '/auth/me', { Authorization: `Bearer ${token}` })).status, 401,
      'a session for an integration account was honoured');
  });

  await test('the integration holds the pop-up and nothing else; no person holds the pop-up', async () => {
    assert.deepEqual([...roleCapabilities('integration')], ['client.nomination.prompt']);
    for (const role of ['superadmin', 'admin']) {
      assert(!roleCapabilities(role).has('client.nomination.prompt'), `${role} still holds client.nomination.prompt`);
    }
    const key = withKey(keyFor(PLATFORM, ['client.nomination.prompt'], 'platform'));
    const list = await key('GET', '/clients');
    assert.equal(list.status === 200 ? (list.body.total ?? 0) : 0, 0, 'the integration\'s key read the client list');
    assert.equal((await key('GET', '/admin/rules')).status, 403);
    const asked = await key('GET', '/platform/nomination-prompt?client_code=NO-SUCH&business=BONANZA');
    assert.equal(asked.status, 404, `the pop-up route did not answer the integration: ${asked.status}`);
    const old = await key('GET', '/clients/nomination-prompt?client_code=NO-SUCH&business=BONANZA');
    assert(!('show' in (old.body ?? {})), 'the old path under /api/clients still answers');
  });

  /* ------------------------------------------------------------- source */

  await test('no route or rule asks the role alone (source check)', () => {
    /* The shape of the bug, so it cannot come back one call at a time. */
    const offenders = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js')) {
          const src = fs.readFileSync(p, 'utf8');
          if (/\bcan\(\s*(req\.)?user\??\.role\b/.test(src)) offenders.push(path.relative(SRC, p));
        }
      }
    };
    walk(SRC);
    assert.deepEqual(offenders, [], `asks can(user.role, ...): ${offenders.join(', ')}`);

    const screen = fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', 'crm', 'ApiAccess.jsx'), 'utf8');
    assert(/Unscoped/.test(screen) && /Set scopes/.test(screen), 'Setup does not flag unscoped keys');
  });
} finally {
  for (const id of sets) {
    run('DELETE FROM user_permission_sets WHERE set_id = ?', [id]);
    run('DELETE FROM permission_set_capabilities WHERE set_id = ?', [id]);
    run('DELETE FROM permission_sets WHERE id = ?', [id]);
  }
  run('DELETE FROM api_credential WHERE label LIKE ?', [`${MARK}%`]);
  run('DELETE FROM sessions WHERE user_id = ?', [PLATFORM.id]);
  run('DELETE FROM users WHERE id = ?', [PLATFORM.id]);
  for (const p of [SUPER, ADMIN, RM]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
