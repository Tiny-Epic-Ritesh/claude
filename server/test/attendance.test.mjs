/**
 * Check-in, check-out and the hours (P3-09).
 *
 * Two things carry the weight here.
 *
 * INTERVALS. "Capture the duration and intervals overall" is why a day is
 * several rows. Somebody who checks out for lunch and back in has two, and one
 * row per day either loses the second or counts the lunch as worked.
 *
 * THE FORGOTTEN CHECK-OUT. The ticket asks for this to be settled before
 * building, and it is the number most easily made up. The legacy system closed
 * everybody at 8pm — 128,482 times — which credits hours to anybody who left
 * earlier. The default here closes at the last thing the person actually did,
 * and the test that matters is that this produces a DIFFERENT number from the
 * cap: an implementation that quietly falls back to the ceiling is a fixed-time
 * auto-checkout wearing another name, and that is exactly the bug this had on
 * the first attempt.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

const PROBE = await probeAdmin('attendance');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nAttendance');

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

const login = async (email) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'bonanza' }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  return (await res.json()).token;
};

const call = async (token, method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* Its own people, so no seeded account's login budget is spent and no seeded
   person's attendance is disturbed. */
const seeded = one("SELECT password FROM users WHERE email = 'admin@bonanza.test'");
const make = async (slug, role, managerId = null) => {
  const email = `attend-${slug}@bonanza.test`;
  await write('DELETE FROM users WHERE email = ?', [email]);
  await write(
    `INSERT INTO users (name, email, password, role, sales_org, active, manager_id)
     VALUES (?,?,?,?,'BONANZA',1,?)`,
    [`Attend ${slug}`, email, seeded.password, role, managerId],
  );
  const u = one('SELECT id FROM users WHERE email = ?', [email]);
  return { ...u, email, token: await login(email) };
};

/* Cleared before as well as after. A run that died partway leaves a manager
   with somebody still pointing at them, and the next run's DELETE then fails on
   the foreign key rather than on anything to do with attendance. */
await write("UPDATE users SET manager_id = NULL WHERE email LIKE 'attend-%@bonanza.test'");
await write("DELETE FROM users WHERE email LIKE 'attend-%@bonanza.test'");

const boss = await make('boss', 'sales_supervisor');
const mine = await make('mine', 'sales_rm', boss.id);
const other = await make('other', 'sales_rm');          // reports to nobody

const cleanup = async () => {
  /* Reports first, or rather their link to a manager first: users.manager_id is
     a foreign key with no cascade, so deleting the supervisor while somebody
     still points at them fails. */
  await write("UPDATE users SET manager_id = NULL WHERE email LIKE 'attend-%@bonanza.test'");
  await write("DELETE FROM users WHERE email LIKE 'attend-%@bonanza.test'");
};

/* ------------------------------------------------------------- the basics */

await test('a sales user is prompted, and an administrator is not', async () => {
  /* Attendance is a sales-team requirement. Prompting somebody it does not
     apply to every morning is how everybody learns to dismiss the prompt. */
  const rm = await call(mine.token, 'GET', '/attendance/me');
  assert.equal(rm.body.applies, true, 'a sales RM is not asked to check in');
  assert.equal(rm.body.prompt, true, 'a checked-out sales RM was not prompted');

  const admin = await call(PROBE.token, 'GET', '/attendance/me');
  assert.equal(admin.body.applies, false, 'an administrator is being asked to check in');
  assert.equal(admin.body.prompt, false, 'an administrator was prompted');
});

await test('checking in twice does not start a second interval', async () => {
  /* Two tabs open is the ordinary way this happens, and two overlapping
     intervals would double every hour of that day. */
  const first = await call(mine.token, 'POST', '/attendance/check-in', {});
  assert.equal(first.status, 201, `check-in failed: ${JSON.stringify(first.body)}`);

  const again = await call(mine.token, 'POST', '/attendance/check-in', {});
  assert.equal(again.status, 200, 'a second check-in was treated as new');
  assert.equal(again.body.already, true, 'the existing interval was not returned');

  const open = all('SELECT id FROM attendance_session WHERE user_id = ? AND checked_out_at IS NULL', [mine.id]);
  assert.equal(open.length, 1, `${open.length} intervals are open at once`);
});

await test('a day is the sum of its intervals', async () => {
  /* Lunch. The requirement says "intervals overall", and this is what that
     means in practice: out and back in, and the day adds them up. */
  await call(mine.token, 'POST', '/attendance/check-out', { note: 'lunch' });
  await call(mine.token, 'POST', '/attendance/check-in', {});

  const me = await call(mine.token, 'GET', '/attendance/me');
  assert.equal(me.body.today.intervals.length, 2, `expected 2 intervals, got ${me.body.today.intervals.length}`);
  assert.equal(me.body.today.open, true, 'the second interval should still be running');

  const sum = me.body.today.intervals.reduce((s, i) => s + i.minutes, 0);
  assert.equal(me.body.today.minutes, sum, 'the day does not equal its intervals');
});

await test('checking out when you are not checked in says so', async () => {
  await call(mine.token, 'POST', '/attendance/check-out', {});
  const again = await call(mine.token, 'POST', '/attendance/check-out', {});
  assert.equal(again.status, 400, 'a second check-out was accepted');
  assert(/not checked in/i.test(again.body.error), `unhelpful message: ${again.body.error}`);
});

/* ------------------------------------------------- the forgotten check-out */

await test('an abandoned day closes at the last real activity, not at the cap', async () => {
  /* The test the whole policy rests on.
   *
   * The first implementation looked for the latest activity AFTER the
   * check-in with no upper bound, so a live session from this morning
   * answered for yesterday, and every abandoned day closed at max_hours. It
   * passed a naive "did it close" check while being a fixed-time auto-checkout
   * under another name.
   *
   * So this asserts the number is the evidence, and separately that it is NOT
   * the ceiling. */
  await write('DELETE FROM attendance_session WHERE user_id = ?', [other.id]);
  await write(
    `INSERT INTO attendance_session (user_id, sales_org, checked_in_at)
     VALUES (?, 'BONANZA', datetime('now','-1 day','start of day','+9 hours'))`,
    [other.id],
  );
  await write(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, created_at)
     VALUES (?, 'attendance_probe', 'user', ?, datetime('now','-1 day','start of day','+17 hours'))`,
    [other.id, other.id],
  );

  // Reading the report is what closes abandoned days.
  await call(PROBE.token, 'GET', '/attendance/report');

  const row = one('SELECT checked_in_at, checked_out_at, closed_by FROM attendance_session WHERE user_id = ?', [other.id]);
  assert(row.checked_out_at, 'the abandoned day was never closed');
  assert.equal(row.closed_by, 'auto', `closed_by is ${row.closed_by}`);

  const hours = (new Date(`${row.checked_out_at}Z`) - new Date(`${row.checked_in_at}Z`)) / 3600000;
  assert(Math.abs(hours - 8) < 0.1, `closed after ${hours.toFixed(2)}h; the last activity was 8h in`);
  assert(hours < 11.9, 'it closed at the 12-hour cap, so the evidence was ignored');
});

await test('a day with no evidence at all is not credited with hours', async () => {
  /* Checked in, did nothing anybody can see, never checked out. An unknown is
     not an hour, so it closes where it opened rather than at a default. */
  await write('DELETE FROM attendance_session WHERE user_id = ?', [other.id]);
  await write('DELETE FROM audit_log WHERE user_id = ?', [other.id]);
  await write(
    `INSERT INTO attendance_session (user_id, sales_org, checked_in_at)
     VALUES (?, 'BONANZA', datetime('now','-2 days','start of day','+9 hours'))`,
    [other.id],
  );

  await call(PROBE.token, 'GET', '/attendance/report');

  const row = one('SELECT checked_in_at, checked_out_at FROM attendance_session WHERE user_id = ?', [other.id]);
  const hours = (new Date(`${row.checked_out_at}Z`) - new Date(`${row.checked_in_at}Z`)) / 3600000;
  assert(hours < 0.1, `a day with no activity was credited ${hours.toFixed(2)} hours`);
});

await test('a day still running today is left alone', async () => {
  /* Somebody checked in this morning and still working has an open interval,
     and that is correct rather than a fault to be tidied away. */
  await call(mine.token, 'POST', '/attendance/check-in', {});
  await call(PROBE.token, 'GET', '/attendance/report');

  const open = one(
    "SELECT id FROM attendance_session WHERE user_id = ? AND checked_out_at IS NULL AND date(checked_in_at) = date('now')",
    [mine.id],
  );
  assert(open, "today's open interval was closed by the sweep");
});

/* ------------------------------------------------------------ visibility */

await test('a manager sees their own team and nobody else', async () => {
  /* The ticket: "scoped so that a manager sees only their own team". `other`
     reports to nobody, so if they appear the scope is not a scope. */
  const r = await call(boss.token, 'GET', '/attendance/report');
  assert.equal(r.body.scope, 'team', `scope is ${r.body.scope}`);

  const ids = new Set(r.body.rows.map((x) => x.user_id));
  assert(ids.has(mine.id), "the manager cannot see their own report's hours");
  assert(!ids.has(other.id), 'the manager sees somebody outside their team');
});

await test('a sales user sees only themselves', async () => {
  const r = await call(mine.token, 'GET', '/attendance/report');
  assert.equal(r.body.scope, 'self', `scope is ${r.body.scope}`);

  const ids = new Set(r.body.rows.map((x) => x.user_id));
  assert(!ids.size || (ids.size === 1 && ids.has(mine.id)),
    'a sales RM saw somebody else in the attendance report');
});

await test('an administrator sees the business, and the export is scoped the same way', async () => {
  const r = await call(PROBE.token, 'GET', '/attendance/report');
  assert.equal(r.body.scope, 'org', `scope is ${r.body.scope}`);

  /* The export is the report written to a file, so a different scope there
     would be the whole point of scoping it undone. */
  const res = await fetch(`${BASE}/api/attendance/report/export?columns=user_name,day,hours`, {
    headers: { Authorization: `Bearer ${boss.token}` },
  });
  assert.equal(res.status, 200, `the manager could not export: HTTP ${res.status}`);
  const csv = (await res.text()).replace(/^﻿/, '');
  assert(!csv.includes('Attend other'), 'the export carried somebody outside the manager\'s team');
});

/* ---------------------------------------------------------------- policy */

await test('the policy is configurable, and refuses nonsense', async () => {
  /* The ticket asks for the abandoned-session behaviour to be agreed rather
     than assumed, so it is a setting — Ritesh's answer changes a default
     rather than causing a rebuild. */
  const bad = await call(PROBE.token, 'PATCH', '/attendance/policy/BONANZA', { unclosed: 'whatever' });
  assert.equal(bad.status, 400, 'an unknown policy was accepted');

  const badTime = await call(PROBE.token, 'PATCH', '/attendance/policy/BONANZA', { auto_close_at: '25:00' });
  assert.equal(badTime.status, 400, '25:00 was accepted as a time');

  const badHours = await call(PROBE.token, 'PATCH', '/attendance/policy/BONANZA', { max_hours: 40 });
  assert.equal(badHours.status, 400, 'a 40-hour day was accepted');

  const before = (await call(PROBE.token, 'GET', '/attendance/policy')).body.policies.find((p) => p.sales_org === 'BONANZA');
  try {
    const ok = await call(PROBE.token, 'PATCH', '/attendance/policy/BONANZA', { unclosed: 'leave_open', max_hours: 10 });
    assert.equal(ok.status, 200, `a valid change was refused: ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.unclosed, 'leave_open');
    assert.equal(ok.body.max_hours, 10);
  } finally {
    await call(PROBE.token, 'PATCH', '/attendance/policy/BONANZA', {
      unclosed: before.unclosed, max_hours: before.max_hours, auto_close_at: before.auto_close_at,
    });
  }
});

await test('leave_open really does leave it open', async () => {
  await call(PROBE.token, 'PATCH', '/attendance/policy/BONANZA', { unclosed: 'leave_open' });
  try {
    await write('DELETE FROM attendance_session WHERE user_id = ?', [other.id]);
    await write(
      `INSERT INTO attendance_session (user_id, sales_org, checked_in_at)
       VALUES (?, 'BONANZA', datetime('now','-3 days','start of day','+9 hours'))`,
      [other.id],
    );

    await call(PROBE.token, 'GET', '/attendance/report');
    const row = one('SELECT checked_out_at FROM attendance_session WHERE user_id = ?', [other.id]);
    assert.equal(row.checked_out_at, null, 'leave_open closed the day anyway');
  } finally {
    await call(PROBE.token, 'PATCH', '/attendance/policy/BONANZA', { unclosed: 'last_activity' });
  }
});

await cleanup();

/* And the borrowed administrator, which `cleanup` above does not cover — it
   deals with this file's `attend-` users. */
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
