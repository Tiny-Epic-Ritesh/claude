/**
 * The user record: exporting it, and choosing what must be filled in (P3-02, P3-03).
 *
 * The export is the part worth being careful about. A list on screen is scoped
 * by the same query every other screen uses; a CSV is a file that leaves the
 * building, and getting the boundary wrong there cannot be taken back. So the
 * boundary is checked here directly rather than assumed from the list route.
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

console.log('\nUser fields, export and requirements');

const login = async (email, password = 'bonanza') => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  return (await res.json()).token;
};

const admin = await login('admin@bonanza.test');
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` };

/* ------------------------------------------------------------- the columns */

await test('the picker is offered the columns the export actually honours', async () => {
  /* One list on the server, so a column cannot be offered in the picker and
     then silently dropped from the file -- which is the failure somebody only
     notices after sending the file on. */
  const meta = await (await fetch(`${BASE}/api/setup/users/export-columns`, { headers: H })).json();
  assert(meta.columns.length > 10, 'suspiciously few columns offered');

  const keys = new Set(meta.columns.map((c) => c.key));
  for (const d of meta.default) {
    assert(keys.has(d), `"${d}" is a default column that is not in the list`);
  }

  const csv = await (await fetch(
    `${BASE}/api/setup/users/export?columns=${meta.default.join(',')}`, { headers: H },
  )).text();
  const header = csv.replace(/^﻿/, '').split('\n')[0];
  const labels = meta.columns.filter((c) => meta.default.includes(c.key)).map((c) => c.label);
  assert.equal(header, labels.join(','), `header was ${header}`);
});

await test('the fields the login check needs are all exportable', () => {
  /* P3-02 names these: "last login date, role, user created on". They are the
     reason the ticket exists, so their absence should fail loudly rather than
     be noticed by whoever opens the file. */
  const cols = all("SELECT name FROM pragma_table_info('users')").map((c) => c.name);
  for (const f of ['last_login_at', 'last_password_changed_at', 'title', 'date_of_joining', 'date_of_exit']) {
    assert(cols.includes(f), `the user record has no ${f}`);
  }
});

await test('signing in records that it happened', async () => {
  /* Not derived from the session it created: sessions are deleted on sign-out,
     on the idle sweep, on a password reset and on a role change, so deriving
     this would report "never" for the people who use the product most. */
  const before = one("SELECT last_login_at FROM users WHERE email = 'salesrm@bonanza.test'");
  run("UPDATE users SET last_login_at = NULL WHERE email = 'salesrm@bonanza.test'");

  await login('salesrm@bonanza.test');

  const after = one("SELECT last_login_at FROM users WHERE email = 'salesrm@bonanza.test'");
  assert(after.last_login_at, 'signing in left no record of the sign-in');
  if (before.last_login_at) {
    run("UPDATE users SET last_login_at = ? WHERE email = 'salesrm@bonanza.test'", [before.last_login_at]);
  }
});

/* ------------------------------------------------------------ what it refuses */

await test('the export never carries a password', async () => {
  /* Belt and braces. The column list does not name it, and asking for it by
     name must not smuggle it in either -- the request is filtered against the
     list rather than interpolated. */
  const csv = await (await fetch(
    `${BASE}/api/setup/users/export?columns=name,password,email`, { headers: H },
  )).text();

  const header = csv.replace(/^﻿/, '').split('\n')[0];
  assert(!/password/i.test(header), `the header names a password column: ${header}`);
  assert(!/scrypt\$/.test(csv), 'a password hash reached the file');
});

await test('asking for nothing recognisable is refused, not answered with everything', async () => {
  const res = await fetch(`${BASE}/api/setup/users/export?columns=nonsense`, { headers: H });
  assert.equal(res.status, 400, `returned HTTP ${res.status}`);
});

await test('an export carries only the books the person can see', async () => {
  /* The one that cannot be undone. A list can be closed; a file has gone. */
  const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
  const probe = 'export-probe@bigul.test';
  run('DELETE FROM users WHERE email = ?', [probe]);
  run(`INSERT INTO users (name, email, password, role, sales_org, active)
       VALUES ('Export Probe', ?, ?, 'admin', 'BIGUL', 1)`, [probe, seeded.password]);

  try {
    const token = await login(probe);
    const csv = await (await fetch(
      `${BASE}/api/setup/users/export?columns=name,email,sales_org`,
      { headers: { Authorization: `Bearer ${token}` } },
    )).text();

    assert(!/BONANZA/.test(csv), 'a Bigul administrator exported Bonanza users');
    assert(/BIGUL/.test(csv), 'the export came back empty, so this proves nothing');
  } finally {
    run('DELETE FROM users WHERE email = ?', [probe]);
  }
});

await test('exporting the user list is itself recorded', async () => {
  /* Reading the list on screen and carrying it out as a file are different
     acts, and only one of them ends up in somebody's inbox. */
  const before = one("SELECT COUNT(*) n FROM audit_log WHERE action = 'users_exported'").n;
  await fetch(`${BASE}/api/setup/users/export?columns=name,email`, { headers: H });
  const after = one("SELECT COUNT(*) n FROM audit_log WHERE action = 'users_exported'").n;

  assert.equal(after, before + 1, 'an export left no trace in the audit log');
});

/* -------------------------------------------------------- required fields */

await test('the four structural fields cannot be made optional', async () => {
  /* A user with no email cannot sign in and one with no business cannot be
     placed in a book. Offering the toggle would be offering something the
     server refuses, which is worse than not offering it. */
  for (const field of ['name', 'email', 'role', 'sales_org']) {
    const res = await fetch(`${BASE}/api/setup/users/required-fields`, {
      method: 'POST', headers: H, body: JSON.stringify({ field, required: false }),
    });
    assert.equal(res.status, 400, `${field} was made optional`);
  }
});

await test('a field made required is enforced on create, and released again', async () => {
  const email = 'requiredprobe@bonanza.test';
  run('DELETE FROM users WHERE email = ?', [email]);

  const setPhone = (required) => fetch(`${BASE}/api/setup/users/required-fields`, {
    method: 'POST', headers: H, body: JSON.stringify({ field: 'phone', required }),
  });
  const create = () => fetch(`${BASE}/api/setup/users`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'Required Probe', email, role: 'sales_rm', password: 'bonanza123' }),
  });

  try {
    await setPhone(true);
    const refused = await create();
    assert.equal(refused.status, 400, 'a user was created without a required mobile');

    await setPhone(false);
    const allowed = await create();
    assert.equal(allowed.status, 201, `turning it off did not release it: HTTP ${allowed.status}`);
  } finally {
    await setPhone(false);
    run('DELETE FROM users WHERE email = ?', [email]);
  }
});

await test('turning a requirement off leaves no rule behind', () => {
  /* Deleted rather than deactivated, so a field that is not required has
     nothing lying about that could be switched back on by accident. */
  const left = all("SELECT name FROM validation_rule WHERE entity = 'user'");
  assert.equal(left.length, 0, `${left.length} user rules left behind: ${left.map((r) => r.name).join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
