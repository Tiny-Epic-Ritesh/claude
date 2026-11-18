/**
 * Settings both businesses share are a Superadmin's; you can only give a
 * Superadmin's power if you hold it.
 *
 * Ruled 18 Nov 2026 (Ritesh): roles, fields and forms, call outcomes, working
 * calendars, case categories and SLA, automation rules, field masking, the
 * role tab grid and column defaults, the messaging grid, and picklist values,
 * validation rules and queues for both businesses, are changed by a
 * Superadmin. Each business's Admin keeps their own business.
 *
 * The ruling would mean nothing if an Admin could become a Superadmin, and
 * three doors let them: a role (any user, themselves included), a permission
 * set listing admin.system, and a password reset link -- handed to whoever
 * asks -- for a Superadmin's account. Each is closed here.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { snapshot } from '../src/engine/versioning.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nShared settings are the Superadmin\'s; a Superadmin\'s power is given only by one');

const RUN = Date.now().toString(36);
const MARK = `Shared probe ${RUN}`;
const ADMIN = await probeAdmin('shared-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('shared-bigul', { role: 'admin', sales_org: 'BIGUL' });
const SUPER = await probeAdmin('shared-super', { role: 'superadmin' });
const RM = await probeAdmin('shared-rm', { role: 'sales_rm', sales_org: 'BONANZA' });

const call = async (who, method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sharedRefusal = (r, what) => {
  assert.equal(r.status, 403, `${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.required, 'setup.shared', `${what}: refused for another reason: ${JSON.stringify(r.body)}`);
};

const madeUsers = [];
const madeSets = [];

try {
  await test('an Admin is refused every shared setting, before anything is read', async () => {
    const SHARED = [
      ['POST', '/setup/roles', {}], ['PATCH', '/setup/roles/sales_rm', {}], ['DELETE', '/setup/roles/sales_rm'],
      ['POST', '/setup/tab-visibility/role', {}], ['PUT', '/setup/columns/leads/role/sales_rm', {}],
      ['PATCH', '/setup/objects/lead', {}], ['POST', '/setup/objects/lead/fields', {}],
      ['PATCH', '/setup/objects/lead/fields/city', {}], ['DELETE', '/setup/objects/lead/fields/city'],
      ['PATCH', '/setup/objects/lead/field-order', {}], ['PATCH', '/setup/forms/Call', {}],
      ['POST', '/setup/dispositions', {}], ['PATCH', '/setup/dispositions/1', {}], ['DELETE', '/setup/dispositions/1'],
      ['POST', '/setup/field-masking', {}], ['POST', '/setup/field-masking/fields', {}], ['DELETE', '/setup/field-masking/fields/city'],
      ['POST', '/admin/sla', {}], ['POST', '/admin/categories', {}], ['PATCH', '/admin/categories/1', {}],
      ['POST', '/admin/categories/1/retire', {}], ['POST', '/admin/categories/1/restore', {}],
      ['PUT', '/admin/compliance-flags/x', {}],
      ['POST', '/admin/rules', {}], ['PATCH', '/admin/rules/1', {}], ['POST', '/admin/rules/1/run', {}],
      ['POST', '/admin/rules/1/archive', {}], ['POST', '/admin/rules/1/restore', {}], ['DELETE', '/admin/rules/1'],
      ['PATCH', '/admin/calendars/office', {}], ['POST', '/admin/calendars/office/days', {}], ['DELETE', '/admin/calendars/days/1'],
      ['PUT', '/messages/policy', { from_role: 'sales_rm', to_role: 'sales_rm', reach: 'any_book' }],
    ];
    for (const [method, url, body] of SHARED) {
      // eslint-disable-next-line no-await-in-loop
      sharedRefusal(await call(ADMIN, method, url, body), `${method} ${url}`);
    }
  });

  await test('a Superadmin is let through the same door', async () => {
    // Harmless requests: each fails on its own validation, never on the ruling.
    for (const [method, url] of [['POST', '/setup/roles'], ['POST', '/admin/rules'], ['POST', '/admin/categories']]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(SUPER, method, url, {});
      assert.notEqual(r.body?.required, 'setup.shared', `${method} ${url} refused a Superadmin`);
    }
  });

  await test('a queue serving both businesses is staffed by a Superadmin; a business\'s own queue by its Admin', async () => {
    const shared = one('SELECT id FROM queues WHERE sales_org IS NULL ORDER BY id LIMIT 1');
    const own = one("SELECT id FROM queues WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1");
    const rolesOf = (q) => all('SELECT role_code FROM queue_members WHERE queue_id = ? ORDER BY role_code', [q]).map((r) => r.role_code);
    const sharedBefore = rolesOf(shared.id);
    sharedRefusal(await call(ADMIN, 'PUT', `/queues/${shared.id}/members`, { roles: [] }), 'shared queue');
    assert.deepEqual(rolesOf(shared.id), sharedBefore);
    const mine = await call(ADMIN, 'PUT', `/queues/${own.id}/members`, { roles: rolesOf(own.id) });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const bySuper = await call(SUPER, 'PUT', `/queues/${shared.id}/members`, { roles: sharedBefore });
    assert.equal(bySuper.status, 200, JSON.stringify(bySuper.body));
  });

  await test('picklist values: a business\'s own are its Admin\'s; one both businesses use is a Superadmin\'s', async () => {
    const own = await call(ADMIN, 'POST', '/setup/objects/lead/fields/source/values/add', { value: `${MARK} own`, sales_org: 'BONANZA' });
    assert.ok([200, 201].includes(own.status), `an Admin could not add a Bonanza value: HTTP ${own.status} ${JSON.stringify(own.body)}`);
    sharedRefusal(await call(ADMIN, 'POST', '/setup/objects/lead/fields/source/values/add', { value: `${MARK} both` }), 'a value for both');
    const bySuper = await call(SUPER, 'POST', '/setup/objects/lead/fields/source/values/add', { value: `${MARK} both` });
    assert.ok([200, 201].includes(bySuper.status), `a Superadmin could not add a shared value: HTTP ${bySuper.status}`);
  });

  await test('validation rules: a business\'s own are its Admin\'s; one for both businesses is a Superadmin\'s', async () => {
    const rule = { name: `${MARK} rule`, condition: { field: 'city', op: 'is_blank' }, message: 'City is required' };
    sharedRefusal(await call(ADMIN, 'POST', '/setup/objects/lead/validation-rules', rule), 'a rule for both');
    const own = await call(ADMIN, 'POST', '/setup/objects/lead/validation-rules', { ...rule, sales_org: 'BONANZA' });
    assert.notEqual(own.body?.required, 'setup.shared', `a Bonanza rule was refused as shared: ${JSON.stringify(own.body)}`);
  });

  await test('restoring a version follows what is restored', async () => {
    const ruleId = one('SELECT id FROM rules ORDER BY id LIMIT 1').id;
    const ruleVersion = snapshot('rule', ruleId, { note: MARK });
    sharedRefusal(await call(ADMIN, 'POST', `/admin/versions/${ruleVersion.id}/restore`), 'a rule version');
    const template = one("SELECT id FROM templates WHERE sales_org = 'BONANZA' ORDER BY id LIMIT 1").id;
    const templateVersion = snapshot('template', template, { note: MARK });
    const mine = await call(ADMIN, 'POST', `/admin/versions/${templateVersion.id}/restore`);
    assert.notEqual(mine.status, 403, `a Bonanza Admin was refused their own template: ${JSON.stringify(mine.body)}`);
    const theirs = await call(BIGUL, 'POST', `/admin/versions/${templateVersion.id}/restore`);
    assert.equal(theirs.status, 403, `a Bigul Admin restored a Bonanza template: HTTP ${theirs.status}`);
  });

  await test('an Admin cannot make anybody a Superadmin -- themselves included', async () => {
    const email = `shared-new-${RUN}@bonanza.test`;
    const created = await call(ADMIN, 'POST', '/setup/users', { name: `${MARK} super`, email, role: 'superadmin', sales_org: 'BONANZA' });
    assert.equal(created.status, 403, `HTTP ${created.status} ${JSON.stringify(created.body)}`);
    const legacy = await call(ADMIN, 'POST', '/admin/users', { name: `${MARK} super2`, email: `x${email}`, role: 'superadmin', sales_org: 'BONANZA' });
    assert.equal(legacy.status, 403, `the older users route: HTTP ${legacy.status}`);
    assert.equal(one('SELECT COUNT(*) n FROM users WHERE email IN (?, ?)', [email, `x${email}`]).n, 0);
    assert.equal((await call(ADMIN, 'PATCH', `/setup/users/${ADMIN.id}`, { role: 'superadmin' })).status, 403, 'promoted themselves');
    assert.equal((await call(ADMIN, 'PATCH', `/admin/users/${ADMIN.id}`, { role: 'superadmin' })).status, 403, 'promoted themselves by the older route');
    assert.equal(one('SELECT role FROM users WHERE id = ?', [ADMIN.id]).role, 'admin');
  });

  await test('an Admin still creates the business\'s ordinary roles', async () => {
    for (const role of ['sales_rm', 'partner_rm', 'compliance']) {
      const email = `shared-${role}-${RUN}@bonanza.test`;
      // eslint-disable-next-line no-await-in-loop
      const r = await call(ADMIN, 'POST', '/setup/users', { name: `${MARK} ${role}`, email, role, sales_org: 'BONANZA' });
      assert.equal(r.status, 201, `${role}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      madeUsers.push(email);
    }
  });

  await test('a permission set holds no Superadmin power its maker lacks, and is given only by one who holds it', async () => {
    const bad = await call(ADMIN, 'POST', '/setup/permission-sets', { name: `${MARK} system`, sales_org: 'BONANZA', capabilities: ['admin.system'] });
    assert.equal(bad.status, 403, `HTTP ${bad.status} ${JSON.stringify(bad.body)}`);
    const fine = await call(ADMIN, 'POST', '/setup/permission-sets', { name: `${MARK} ordinary`, sales_org: 'BONANZA', capabilities: ['lead.view.own'] });
    assert.equal(fine.status, 201, JSON.stringify(fine.body));
    madeSets.push(fine.body.id);

    const strong = await call(SUPER, 'POST', '/setup/permission-sets', { name: `${MARK} shared`, sales_org: 'BONANZA', capabilities: ['setup.shared'] });
    assert.equal(strong.status, 201, JSON.stringify(strong.body));
    madeSets.push(strong.body.id);
    const handed = await call(ADMIN, 'POST', `/setup/users/${RM.id}/permission-sets`, { set_id: strong.body.id, reason: 'probe' });
    assert.equal(handed.status, 403, `an Admin handed out setup.shared: HTTP ${handed.status}`);
    assert.equal(one('SELECT COUNT(*) n FROM user_permission_sets WHERE user_id = ? AND set_id = ?', [RM.id, strong.body.id]).n, 0);
  });

  await test('a person holding a Superadmin power is out of an Admin\'s reach', async () => {
    const strong = madeSets[1];
    const granted = await call(SUPER, 'POST', `/setup/users/${RM.id}/permission-sets`, { set_id: strong, reason: 'probe' });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    const ghost = await call(ADMIN, 'POST', `/setup/users/${RM.id}/ghost`, {});
    assert.equal(ghost.status, 403, `an Admin signed in as them: HTTP ${ghost.status}`);
    assert.equal((await call(ADMIN, 'POST', `/setup/users/${RM.id}/reset-link`, {})).status, 403, 'a reset link was handed over');
    assert.equal((await call(ADMIN, 'POST', `/setup/users/${RM.id}/active`, { active: false })).status, 403, 'deactivated');
    assert.equal((await call(ADMIN, 'PATCH', `/setup/users/${RM.id}`, { name: 'renamed by an Admin' })).status, 403, 'edited');
    assert.equal((await call(ADMIN, 'DELETE', `/setup/users/${RM.id}/permission-sets/${strong}`)).status, 403, 'the grant was removed');
  });

  await test('a Superadmin\'s own account is out of an Admin\'s reach', async () => {
    assert.equal((await call(ADMIN, 'POST', `/setup/users/${SUPER.id}/reset-link`, {})).status, 403, 'a reset link for a Superadmin was handed over');
    assert.equal((await call(ADMIN, 'PATCH', `/setup/users/${SUPER.id}`, { password: 'Taken-over-1' })).status, 403, 'a Superadmin\'s password was set');
    assert.equal((await call(ADMIN, 'POST', `/setup/users/${SUPER.id}/active`, { active: false })).status, 403, 'a Superadmin was deactivated');
  });

  await test('the Setup screens say which settings are shared (source check)', async () => {
    const { readFileSync } = await import('node:fs');
    const registry = readFileSync(new URL('../../client/src/setup/registry.js', import.meta.url), 'utf8');
    for (const key of ['roles', 'navigation', 'masking', 'objects', 'forms', 'outcomes', 'sla', 'calendars', 'rules', 'messaging']) {
      // The section's own entry (four spaces in), not a group sharing the key.
      const at = registry.indexOf(`\n    key: '${key}',\n`);
      const end = registry.indexOf('\n  },', at);
      assert.ok(at >= 0 && /\n {4}shared: ['"]/.test(registry.slice(at, end)), `the ${key} screen does not say it is shared`);
    }
    const shell = readFileSync(new URL('../../client/src/setup/SetupShell.jsx', import.meta.url), 'utf8');
    assert.match(shell, /includes\('setup\.shared'\)/);
  });
} finally {
  run("DELETE FROM picklist_value WHERE value LIKE ?", [`${MARK}%`]);
  run('DELETE FROM validation_rule WHERE name LIKE ?', [`${MARK}%`]);
  for (const id of madeSets) {
    run('DELETE FROM user_permission_sets WHERE set_id = ?', [id]);
    run('DELETE FROM permission_set_capabilities WHERE set_id = ?', [id]);
    run('DELETE FROM permission_sets WHERE id = ?', [id]);
  }
  for (const email of madeUsers) run('DELETE FROM users WHERE email = ?', [email]);
  for (const p of [ADMIN, BIGUL, SUPER, RM]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
