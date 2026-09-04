/**
 * The Sales Supervisor's console, assignment and export (P3-42, P3-43).
 *
 * The report was "neither the Sales Console nor Lead object access is
 * available", and both were true while `GET /leads` returned 200 and handed
 * back the team's leads. That is the interesting part: it was never a
 * permissions failure. `lead.view.all` was withdrawn from this role when it was
 * declared team scope — correctly — and nothing was put in its place, so the
 * role could create, edit, reassign and change the stage of a lead it had no
 * capability to open. The navigation gates on the view capabilities; the data
 * layer gates on data_scope; and the two had drifted apart.
 *
 * So the test that matters is not "can a supervisor see the Sales Console". It
 * is that restoring the capability restored the navigation and changed nothing
 * about what they can read.
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

console.log('\nSales Supervisor');

const tokens = new Map();
const login = async (email) => {
  if (tokens.has(email)) return tokens.get(email);
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'bonanza' }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  tokens.set(email, (await res.json()).token);
  return tokens.get(email);
};

const sup = one("SELECT id, email, name FROM users WHERE role = 'sales_supervisor' AND active = 1 LIMIT 1");
assert(sup, 'no sales supervisor seeded');
const H = async () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${await login(sup.email)}` });

/* --------------------------------------------------------- P3-42: access */

await test('the Sales Console is there, with the Leads tab in it', async () => {
  const apps = await (await fetch(`${BASE}/api/apps`, { headers: await H() })).json();
  const sales = apps.apps.find((a) => a.id === 'sales');

  assert(sales, `no Sales Console; the supervisor sees ${apps.apps.map((a) => a.id).join(', ')}`);
  assert(sales.tabs.some((t) => t.id === 'leads'), 'the Sales Console has no Leads tab');
});

await test('a role that may edit a lead may also open one', async () => {
  /* The mismatch underneath the report, stated as the rule it broke. Any role
     that can change a lead must hold some view capability, or the navigation
     hides an object the API lets it write. */
  const caps = new Set(all('SELECT capability FROM role_capabilities WHERE role_code = ?', [sup.role ?? 'sales_supervisor'])
    .map((r) => r.capability));

  const writes = ['lead.create', 'lead.edit', 'lead.reassign', 'lead.stage.change'].filter((c) => caps.has(c));
  if (!writes.length) return;

  const views = ['lead.view.all', 'lead.view.own', 'lead.view.product'].filter((c) => caps.has(c));
  assert(views.length,
    `the supervisor holds ${writes.join(', ')} and no lead.view.* — it can change what it cannot open`);
});

await test('restoring the capability did not widen what they can read', async () => {
  /* Reach comes from data_scope, and only lead.view.all overrides it. If this
     ever starts returning the whole book, the capability has quietly become a
     data grant again — which is the exact confusion the role was cleaned up to
     remove. */
  const seen = await (await fetch(`${BASE}/api/leads?limit=500`, { headers: await H() })).json();
  const everything = one("SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL").n;

  assert(seen.length < everything,
    `the supervisor sees all ${everything} leads — team scope is not being applied`);
  assert(seen.length > 0, 'the supervisor sees no leads at all');
});

/* ----------------------------------------------------- P3-42: assignment */

await test('assigning a task tells the person, and names the manager and the lead', async () => {
  const rm = one('SELECT id, name FROM users WHERE manager_id = ? AND active = 1 LIMIT 1', [sup.id]);
  assert(rm, 'the supervisor has no reports, so this proves nothing');

  const leads = await (await fetch(`${BASE}/api/leads?limit=1`, { headers: await H() })).json();
  const lead = leads[0];
  assert(lead, 'the supervisor can see no leads to assign');

  const before = one('SELECT COUNT(*) n FROM notifications WHERE user_id = ?', [rm.id]).n;

  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: await H(),
    body: JSON.stringify({
      title: 'Supervisor probe task', lead_id: lead.id, assignee_id: rm.id, due_at: '2026-12-31 10:00:00',
    }),
  });
  assert.equal(res.status, 201, `the task was not created: HTTP ${res.status}`);
  const task = await res.json();

  try {
    const after = one('SELECT COUNT(*) n FROM notifications WHERE user_id = ?', [rm.id]).n;
    assert.equal(after, before + 1, 'the assignee was not told');

    const note = one('SELECT title, body, link FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', [rm.id]);
    assert(note.title.includes(sup.name), `the notification does not name the manager: ${note.title}`);
    assert(note.body.includes(lead.name), `the notification does not name the lead: ${note.body}`);
    assert.equal(note.link, `/leads/${lead.id}`, `the link does not open the lead: ${note.link}`);
  } finally {
    run('DELETE FROM tasks WHERE id = ?', [task.id]);
    run("DELETE FROM notifications WHERE title LIKE '%assigned you a task%' AND user_id = ?", [rm.id]);
  }
});

await test('a task you give yourself is not news', async () => {
  /* A notification for every task somebody makes for themselves is how people
     learn to ignore the bell. */
  const before = one('SELECT COUNT(*) n FROM notifications WHERE user_id = ?', [sup.id]).n;

  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: await H(),
    body: JSON.stringify({ title: 'My own probe task', assignee_id: sup.id, due_at: '2026-12-31 10:00:00' }),
  });
  const task = await res.json();

  try {
    assert.equal(one('SELECT COUNT(*) n FROM notifications WHERE user_id = ?', [sup.id]).n, before,
      'a task somebody assigned to themselves produced a notification');
  } finally {
    run('DELETE FROM tasks WHERE id = ?', [task.id]);
  }
});

await test('the notification link is rendered, not just stored', async () => {
  /* It was stored and dropped on the floor for as long as the column existed:
     the cockpit showed the title and the body and never the link, so "clicking
     it opens that lead" was true of the data and false of the screen. */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../client/src/crm/Cockpit.jsx', import.meta.url), 'utf8');

  assert(/n\.link/.test(src), 'the cockpit never reads a notification link');
  assert(/navigate\(n\.link\)/.test(src), 'the cockpit reads the link but does not go there');
});

/* -------------------------------------------------------- P3-43: export */

await test('the supervisor can import and export leads', async () => {
  const caps = new Set(all("SELECT capability FROM role_capabilities WHERE role_code = 'sales_supervisor'")
    .map((r) => r.capability));
  assert(caps.has('lead.create'), 'the supervisor cannot import — no lead.create');
  assert(caps.has('export.lead'), 'the supervisor cannot export — no export.lead');
});

await test('the fields P3-43 names are masked in the file, or not in it at all', async () => {
  /* "mobile number, email ID, PAN number, bank account details and similar".
     Mobile and email are exportable and masked; PAN and bank details are not
     exportable at all, and asking for them by name does not add them. */
  const res = await fetch(`${BASE}/api/leads/export`, {
    method: 'POST',
    headers: await H(),
    body: JSON.stringify({ columns: ['name', 'mobile', 'email', 'pan', 'bank_account'] }),
  });
  assert.equal(res.status, 200, `the supervisor could not export: HTTP ${res.status}`);

  const csv = (await res.text()).replace(/^﻿/, '');
  const [head, ...rows] = csv.trim().split('\n');

  assert(!/pan/i.test(head), `PAN reached the export header: ${head}`);
  assert(!/bank/i.test(head), `bank details reached the export header: ${head}`);
  assert(!/[A-Z]{5}\d{4}[A-Z]/.test(csv), 'something shaped like a PAN is in the file');

  let checked = 0;
  for (const row of rows.slice(0, 10)) {
    const [, mobile, email] = row.split(',');
    if (mobile?.trim()) {
      assert(!/^\d{10}$/.test(mobile.trim()), `a mobile is in the clear: ${mobile}`);
      checked += 1;
    }
    if (email?.trim()) assert(/[•*]/.test(email), `an email is in the clear: ${email}`);
  }
  assert(checked > 0, 'no mobile numbers in the file, so this proves nothing');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
