/**
 * Sales groups (P3-08).
 *
 * "There is no option for groups or sales groups in the CRM." Half right, and
 * the half that was wrong changed the work: the `teams` table has existed since
 * the beginning with exactly the shape the ticket asks for, and the assignment
 * engine already routes work through it. What was missing was any way to make
 * one — two read routes, and the only thing that ever created a group was the
 * seed.
 *
 * So the risk here was never "can we store a group". It was inventing a second
 * grouping alongside the one that already drives assignment, which would have
 * given the product two answers to "who works to whom" — the legacy failure
 * this build exists to avoid.
 *
 * The other thing worth holding: a group routes work, it does not grant sight.
 * Membership must not quietly become visibility, because then two mechanisms
 * answer the same question and disagree the first time somebody is in a group
 * but not in the reporting chain.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nSales groups');

let token = null;
const admin = async () => {
  if (token) return token;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@bonanza.test', password: 'bonanza' }),
  });
  if (!res.ok) throw new Error(`could not sign in: HTTP ${res.status}`);
  token = (await res.json()).token;
  return token;
};

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await admin()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const NAME = 'Groups probe desk';
const clean = () => run('DELETE FROM teams WHERE name LIKE ?', ['Groups probe%']);
clean();

let groupId = null;

/* ------------------------------------------------------------ the basics */

await test('a group can be created with a manager', async () => {
  const manager = one("SELECT id, name FROM users WHERE role = 'sales_supervisor' AND sales_org = 'BONANZA' AND active = 1 LIMIT 1");
  assert(manager, 'no supervisor to manage the desk');

  const r = await call('POST', '/setup/groups', { name: NAME, description: 'Made by a test', manager_id: manager.id });
  assert.equal(r.status, 201, `create failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.name, NAME);
  assert.equal(r.body.manager_name, manager.name, 'the manager did not stick');

  groupId = r.body.id;
});

await test('a group without a name is refused', async () => {
  const r = await call('POST', '/setup/groups', { name: '   ' });
  assert.equal(r.status, 400, `a nameless group was created: HTTP ${r.status}`);
});

await test('people can be put on the desk and taken off it', async () => {
  const rm = one("SELECT id, name FROM users WHERE role = 'sales_rm' AND sales_org = 'BONANZA' AND active = 1 LIMIT 1");

  let r = await call('POST', `/setup/groups/${groupId}/members`, { user_id: rm.id });
  assert.equal(r.status, 200, `adding failed: ${JSON.stringify(r.body)}`);
  assert(r.body.members.some((m) => m.id === rm.id), 'the member is not on the desk');

  // Twice is not an error and does not duplicate.
  r = await call('POST', `/setup/groups/${groupId}/members`, { user_id: rm.id });
  assert.equal(r.body.members.filter((m) => m.id === rm.id).length, 1, 'adding twice duplicated the member');

  r = await call('DELETE', `/setup/groups/${groupId}/members/${rm.id}`);
  assert(!r.body.members.some((m) => m.id === rm.id), 'the member is still on the desk');

  /* Taken off a desk, not out of the CRM. */
  assert(one('SELECT id FROM users WHERE id = ?', [rm.id]), 'removing a member deleted the user');
});

await test('a group can be renamed, given a new manager, and deactivated', async () => {
  const other = one("SELECT id, name FROM users WHERE role = 'admin' AND sales_org = 'BONANZA' LIMIT 1");

  const r = await call('PATCH', `/setup/groups/${groupId}`, {
    name: 'Groups probe renamed', manager_id: other.id, active: 0,
  });
  assert.equal(r.status, 200, `patch failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.name, 'Groups probe renamed');
  assert.equal(r.body.manager_name, other.name);
  assert.equal(r.body.active, 0);
});

/* ------------------------------------------------------------ the boundary */

await test('a manager from the other business is refused', async () => {
  /* Otherwise a group exists whose own manager cannot see it, which nothing
     else in the product can produce. */
  const bigul = one("SELECT id FROM users WHERE sales_org = 'BIGUL' AND active = 1 LIMIT 1");
  if (!bigul) return;

  const r = await call('PATCH', `/setup/groups/${groupId}`, { manager_id: bigul.id });
  assert.equal(r.status, 400, `a Bigul manager was set on a Bonanza group: HTTP ${r.status}`);
});

await test('a member from the other business is refused', async () => {
  const bigul = one("SELECT id FROM users WHERE sales_org = 'BIGUL' AND active = 1 LIMIT 1");
  if (!bigul) return;

  const r = await call('POST', `/setup/groups/${groupId}/members`, { user_id: bigul.id });
  assert.equal(r.status, 400, `a Bigul user joined a Bonanza desk: HTTP ${r.status}`);
});

await test('a group in another business cannot be touched', async () => {
  const before = one('SELECT sales_org FROM teams WHERE id = ?', [groupId]).sales_org;
  run("UPDATE teams SET sales_org = 'BIGUL' WHERE id = ?", [groupId]);
  try {
    const r = await call('PATCH', `/setup/groups/${groupId}`, { name: 'Reached across the book' });
    assert.equal(r.status, 403, `a Bonanza admin edited a Bigul group: HTTP ${r.status}`);
    assert.notEqual(one('SELECT name FROM teams WHERE id = ?', [groupId]).name, 'Reached across the book');
  } finally {
    run('UPDATE teams SET sales_org = ? WHERE id = ?', [before, groupId]);
  }
});

/* ------------------------------------------------- what a group must not do */

await test('membership does not grant sight of records', async () => {
  /* The distinction the screen states and the code has to keep. An RM put on a
     supervisor's desk must not thereby see the supervisor's leads: visibility
     follows the reporting line, and a second mechanism answering the same
     question is how the legacy tenant ended up granting access through the
     manager slot. */
  /* Its own RM rather than a seeded one. The login limiter allows ten a minute
     per account, and salesrm@bonanza.test is used by several test files and by
     the e2e run that follows — between them they spent its budget and a later
     check failed as "collaterally locked out". A test that needs to sign in as
     somebody should bring its own somebody. */
  const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
  const email = 'groups-probe-rm@bonanza.test';
  run('DELETE FROM users WHERE email = ?', [email]);
  run(`INSERT INTO users (name, email, password, role, sales_org, active)
       VALUES ('Groups Probe RM', ?, ?, 'sales_rm', 'BONANZA', 1)`, [email, seeded.password]);
  const rm = one('SELECT id FROM users WHERE email = ?', [email]);

  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'bonanza' }),
    });
    assert.equal(res.status, 200, `the probe RM could not sign in: HTTP ${res.status}`);
    const rmToken = (await res.json()).token;

    const leads = async () => (await (await fetch(`${BASE}/api/leads?limit=500`, {
      headers: { Authorization: `Bearer ${rmToken}` },
    })).json()).length;

    const before = await leads();
    await call('POST', `/setup/groups/${groupId}/members`, { user_id: rm.id });
    const after = await leads();

    assert.equal(after, before,
      `joining a group changed what an RM can see: ${before} leads before, ${after} after`);
  } finally {
    run('DELETE FROM users WHERE email = ?', [email]);
  }
});

await test('the assignment engine still reads the same table', async () => {
  /* The reason this was built on `teams` instead of a new table. If a second
     grouping ever appears, the product has two answers to who works to whom. */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/engine/assignment.js', import.meta.url), 'utf8');
  assert(/team_members/.test(src), 'the assignment engine no longer reads group membership');
});

/* ---------------------------------------------------------------- deleting */

await test('deleting a group takes its membership and leaves the people', async () => {
  const rm = one("SELECT id FROM users WHERE role = 'sales_rm' AND sales_org = 'BONANZA' AND active = 1 LIMIT 1");
  await call('POST', `/setup/groups/${groupId}/members`, { user_id: rm.id });   // no sign-in needed

  const r = await call('DELETE', `/setup/groups/${groupId}`);
  assert.equal(r.status, 200, `delete failed: ${JSON.stringify(r.body)}`);

  assert(!one('SELECT id FROM teams WHERE id = ?', [groupId]), 'the group is still there');
  assert.equal(all('SELECT user_id FROM team_members WHERE team_id = ?', [groupId]).length, 0,
    'the membership rows outlived the group');
  assert(one('SELECT id FROM users WHERE id = ?', [rm.id]), 'deleting a group deleted a user');
});

clean();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
