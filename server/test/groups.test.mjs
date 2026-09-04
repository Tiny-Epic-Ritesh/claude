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
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

/* Its own administrator. Several test files and the e2e run all signed in as
   admin@bonanza.test, and ten a minute is the limiter's budget for one account --
   so the eleventh attempt was refused and the failure looked like a broken
   feature. A test that needs to sign in as somebody brings its own somebody. */
const PROBE = await probeAdmin('groups');

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
    body: JSON.stringify({ email: PROBE.email, password: 'bonanza' }),
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

/**
 * A direct write, retried.
 *
 * These tests share the database file with a running server, and SQLite refuses
 * a writer while a reader holds the lock. Without this a write that lands in
 * the middle of a request throws "database is locked" and takes the whole run
 * with it -- which looks like a broken feature and is a busy file.
 */
const write = async (sql, params = []) => {
  for (let i = 0; i < 20; i += 1) {
    try { return run(sql, params); }
    catch (err) {
      if (!/locked|busy/i.test(err.message) || i === 19) throw err;
      await new Promise((r) => setTimeout(r, 100));      // eslint-disable-line no-await-in-loop
    }
  }
  return undefined;
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
  await write("UPDATE teams SET sales_org = 'BIGUL' WHERE id = ?", [groupId]);
  try {
    const r = await call('PATCH', `/setup/groups/${groupId}`, { name: 'Reached across the book' });
    assert.equal(r.status, 403, `a Bonanza admin edited a Bigul group: HTTP ${r.status}`);
    assert.notEqual(one('SELECT name FROM teams WHERE id = ?', [groupId]).name, 'Reached across the book');
  } finally {
    await write('UPDATE teams SET sales_org = ? WHERE id = ?', [before, groupId]);
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
  await write('DELETE FROM users WHERE email = ?', [email]);
  await write(`INSERT INTO users (name, email, password, role, sales_org, active)
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
    await write('DELETE FROM users WHERE email = ?', [email]);
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

/* ============================================================ the org tree */

/**
 * P3-07. Ritesh, 5 Sep: the roles named in the ticket were an example and do
 * not exist here — what he wants is a configurable tree with as many branches
 * as needed, hanging under Bonanza and Bigul.
 *
 * The businesses are the roots and are not rows in `teams`. A branch is a
 * group, so there is one structure describing the organisation rather than two
 * that can disagree about it.
 */

const tree = async () => (await call('GET', '/setup/org-tree')).body;
const find = (nodes, name) => {
  for (const n of nodes ?? []) {
    if (n.name === name) return n;
    const deeper = find(n.children, name);
    if (deeper) return deeper;
  }
  return null;
};

let parentId = null;
let childId = null;

await test('the businesses are the roots, and are not groups', async () => {
  const t = await tree();
  const names = t.roots.map((r) => r.name);
  assert(names.includes('Bonanza'), `Bonanza is not a root: ${names.join(', ')}`);

  /* If the roots were rows in `teams` they would appear in the groups list as
     two entries with no members, no manager and no routing, and every screen
     listing groups would have to skip them. */
  const listed = (await call('GET', '/setup/groups')).body.groups.map((g) => g.name);
  assert(!listed.includes('Bonanza'), 'the business is in the groups list as a group');
});

await test('a branch can hang under another branch, to any depth', async () => {
  let r = await call('POST', '/setup/groups', { name: 'Groups probe region' });
  assert.equal(r.status, 201, `parent create failed: ${JSON.stringify(r.body)}`);
  parentId = r.body.id;

  r = await call('POST', '/setup/groups', { name: 'Groups probe branch', parent_id: parentId });
  assert.equal(r.status, 201, `child create failed: ${JSON.stringify(r.body)}`);
  childId = r.body.id;

  const grand = await call('POST', '/setup/groups', { name: 'Groups probe desk', parent_id: childId });
  assert.equal(grand.status, 201, 'a third level was refused');

  const t = await tree();
  const region = find(t.roots.flatMap((x) => x.children), 'Groups probe region');
  assert(region, 'the region is not on the tree');
  assert(find(region.children, 'Groups probe branch'), 'the branch is not under its region');
  assert(find(region.children, 'Groups probe desk'), 'the third level is missing');
});

await test('a branch cannot be put inside its own branch', async () => {
  /* The check that has to exist before a tree is editable. Without it every
     later walk of the tree runs forever: the screen hangs, the API times out,
     and the only way back is a database edit. */
  let r = await call('PATCH', `/setup/groups/${parentId}`, { parent_id: childId });
  assert.equal(r.status, 400, `a loop was allowed: HTTP ${r.status}`);

  r = await call('PATCH', `/setup/groups/${parentId}`, { parent_id: parentId });
  assert.equal(r.status, 400, 'a group was put under itself');

  // And the tree still walks, which is the thing the guard protects.
  const t = await tree();
  assert(t.roots.length, 'the tree could not be read after the refused moves');
});

await test('a branch cannot hang under the other business', async () => {
  const bigulGroup = one("SELECT id FROM teams WHERE sales_org = 'BIGUL' LIMIT 1");
  if (!bigulGroup) return;

  const r = await call('PATCH', `/setup/groups/${childId}`, { parent_id: bigulGroup.id });
  assert.equal(r.status, 400, `a Bonanza branch hangs under a Bigul one: HTTP ${r.status}`);
});

await test('deleting a branch lifts its children rather than losing them', async () => {
  /* Deleting a region should not delete the branches under it, and a branch
     pointing at a group that no longer exists is invisible on the tree and
     cannot be fixed from the screen. */
  const before = one('SELECT parent_id FROM teams WHERE id = ?', [childId]).parent_id;
  assert.equal(before, parentId, 'setup: the child should start under the parent');

  const r = await call('DELETE', `/setup/groups/${parentId}`);
  assert.equal(r.status, 200, `delete failed: ${JSON.stringify(r.body)}`);

  const after = one('SELECT parent_id FROM teams WHERE id = ?', [childId]);
  assert(after, 'deleting the parent deleted the child');
  assert.equal(after.parent_id, null, `the child should have moved up, its parent is ${after.parent_id}`);

  // Still reachable on the tree, which is what "not lost" means in practice.
  const t = await tree();
  assert(find(t.roots.flatMap((x) => x.children), 'Groups probe branch'),
    'the child is not on the tree after its parent was deleted');
});

await test('a parent cannot dangle, and a parent in the other book does not hide a branch', async () => {
  /* Two different protections, and the first one is not mine.
     parent_id is a foreign key, so pointing it at an id that does not exist is
     refused by the database. There is no way to create the orphan this was
     originally written to survive. */
  let refused = false;
  try {
    run('UPDATE teams SET parent_id = 999999 WHERE id = ?', [childId]);
  } catch {
    refused = true;
  }
  assert(refused, 'a group was given a parent that does not exist');

  /* What IS reachable: a parent in the other business, because a group's
     sales_org can be changed. The tree puts such a child under its own business
     rather than under a parent nobody in that book can see -- a node that is
     invisible is a node nobody can move. */
  const bigulGroup = one("SELECT id FROM teams WHERE sales_org = 'BIGUL' LIMIT 1");
  if (!bigulGroup) return;

  await write('UPDATE teams SET parent_id = ? WHERE id = ?', [bigulGroup.id, childId]);
  try {
    const t = await tree();
    const bonanza = t.roots.find((r) => r.name === 'Bonanza');
    assert(find(bonanza.children, 'Groups probe branch'),
      'a branch whose parent is in the other business vanished from the tree');
  } finally {
    await write('UPDATE teams SET parent_id = NULL WHERE id = ?', [childId]);
  }
});

clean();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
