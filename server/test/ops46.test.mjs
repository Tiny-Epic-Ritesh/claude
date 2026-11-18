/**
 * OPS-46 (found 16 Oct 2026 reading for Part 4 item 8.4; ruled the same day):
 * a time a person types is India time, and the database holds UTC.
 *
 * The "Task created" message showed due 16:30 for a task typed as 11:00. The
 * routes stored the typed value as it came, and everything reading it treated
 * it as UTC. Beside it, the office calendar read hours and weekdays in the
 * server's zone -- UTC in the container -- so the office "opened" at 14:30 IST.
 *
 * The machine's zone is forced to UTC here, the container's, because on a
 * laptop set to India both defects hide.
 */

process.env.TZ = 'UTC';

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { typedToStored, storedToDate } from '../src/engine/daterange.js';
import { nextWorkingTime, isWorkingTime, isWorkingDay } from '../src/engine/calendar.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const client = (...rel) => fs.readFileSync(path.join(HERE, '..', '..', 'client', 'src', ...rel), 'utf8');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nOPS-46: typed times are India time, stored times are UTC');

/* A Wednesday three weeks or more ahead: in the future, a working day, and
   clear of any holiday another test might add for this week. */
const day = (() => {
  const d = new Date(Date.now() + 21 * 86_400_000);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();
const nextDay = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

await test('a typed time with no zone is India time', () => {
  assert.equal(typedToStored(`${day}T11:00`), `${day} 05:30:00`);
  assert.equal(typedToStored(`${day} 11:00`), `${day} 05:30:00`);
  assert.equal(typedToStored(`${day} 11:00:00`), `${day} 05:30:00`);
});

await test('a time that says its zone means what it says', () => {
  assert.equal(typedToStored(`${day}T05:30:00Z`), `${day} 05:30:00`);
  assert.equal(typedToStored(`${day}T05:30:00.000Z`), `${day} 05:30:00`);
  assert.equal(typedToStored(`${day}T11:00:00+05:30`), `${day} 05:30:00`);
});

await test('a bare day stays a day, and text is refused', () => {
  assert.equal(typedToStored(day), day);
  assert.equal(typedToStored('tomorrow'), null);
  assert.equal(typedToStored('2026-13-45 99:00'), null);
});

await test('a stored time is read as UTC, whatever the machine zone', () => {
  assert.equal(storedToDate(`${day} 05:30:00`).toISOString(), `${day}T05:30:00.000Z`);
});

await test('the office opens at 09:00 India time, not 09:00 UTC', () => {
  assert.equal(isWorkingDay(new Date(`${day}T05:30:00Z`)), true, 'the test day is not a working day');
  assert.equal(isWorkingTime(new Date(`${day}T05:30:00Z`)), true, '11:00 IST is office hours');
  assert.equal(isWorkingTime(new Date(`${day}T14:00:00Z`)), false, '19:30 IST is after closing');
  assert.equal(nextWorkingTime(new Date(`${day}T05:30:00Z`)).toISOString(), `${day}T05:30:00.000Z`, '11:00 IST moved');
  assert.equal(nextWorkingTime(new Date(`${day}T03:00:00Z`)).toISOString(), `${day}T03:30:00.000Z`, '08:30 IST should open at 09:00 IST');
});

await test('India\'s Wednesday ends at midnight India time', () => {
  // 23:00 IST Wednesday is 17:30 UTC Wednesday; 00:30 IST Thursday is 19:00 UTC Wednesday.
  assert.equal(isWorkingDay(new Date(`${day}T19:00:00Z`)), isWorkingDay(new Date(`${nextDay}T05:30:00Z`)));
  assert.equal(nextWorkingTime(new Date(`${day}T19:00:00Z`)).toISOString(), `${nextDay}T03:30:00.000Z`,
    'after midnight IST, the next opening is 09:00 IST that morning');
});

const RM = await probeAdmin('ops46-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const call = async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...RM.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const lead = await call('POST', '/leads', {
  name: `OPS-46 probe ${Date.now().toString(36)}`, mobile: `9${String(Date.now()).slice(-9)}`, source: 'Manual', route: false,
});
assert.equal(lead.status, 201, JSON.stringify(lead.body));
const leadId = lead.body.id;

await test('a task typed for 11:00 is due at 11:00 India time', async () => {
  const made = await call('POST', '/tasks', { title: 'OPS-46 probe', lead_id: leadId, due_at: `${day}T11:00` });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(one('SELECT due_at FROM tasks WHERE id = ?', [made.body.id]).due_at, `${day} 05:30:00`);
});

await test('editing a task\'s due time converts it the same way', async () => {
  const made = await call('POST', '/tasks', { title: 'OPS-46 probe edit', lead_id: leadId, due_at: `${day}T11:00` });
  const edited = await call('PATCH', `/tasks/${made.body.id}`, { due_at: `${day} 15:00` });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.due_at, `${day} 09:30:00`);
});

await test('a task with a due time that is not a time is refused', async () => {
  const made = await call('POST', '/tasks', { title: 'OPS-46 probe bad', lead_id: leadId, due_at: 'next week' });
  assert.equal(made.status, 400);
});

await test('a callback typed for 11:00 is a follow-up at 11:00 India time', async () => {
  const logged = await call('POST', '/activities', {
    lead_id: leadId, type: 'Call', disposition: 'CALL_CALLBACK', body: 'OPS-46 probe', follow_up_at: `${day} 11:00`,
  });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  const task = one("SELECT due_at FROM tasks WHERE lead_id = ? AND auto_created = 1 ORDER BY id DESC LIMIT 1", [leadId]);
  assert.equal(task?.due_at, `${day} 05:30:00`);
  const act = one('SELECT follow_up_at FROM activities WHERE id = ?', [logged.body.activity.id]);
  assert.equal(act.follow_up_at, `${day} 05:30:00`);
});

await test('the screens show stored times in India time and judge "overdue" in UTC', () => {
  const api = client('api.js');
  assert.match(api, /export const istInput/);
  assert.match(api, /export const isPast/);
  const tasks = client('crm', 'Tasks.jsx');
  assert.match(tasks, /useState\(istInput\(task\.due_at\)\)/, 'the edit form pre-fills UTC as if it were India time');
  assert.doesNotMatch(tasks, /new Date\(t\.due_at\)/);
  assert.doesNotMatch(client('crm', 'LeadDetail.jsx'), /new Date\(t\.due_at\)/);
  assert.doesNotMatch(client('crm', 'Cockpit.jsx'), /new Date\(t\.due_at\)/);
  assert.match(client('crm', 'admin', 'Campaigns.jsx'), /istInput\(campaign\?\.scheduled_at\)/);
});

/* Cleanup: the probe lead's tasks and activities go with it. */
run('DELETE FROM reminders WHERE lead_id = ?', [leadId]);
run('DELETE FROM tasks WHERE lead_id = ?', [leadId]);
run('DELETE FROM leads WHERE id = ?', [leadId]);
RM.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
