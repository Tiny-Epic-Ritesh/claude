/**
 * Who may export what, and what the file is allowed to contain (P3-35).
 *
 * Three separate promises, and the export is the one place where breaking any
 * of them cannot be walked back. A screen can be closed and a permission
 * revoked; a CSV has already been attached to an email.
 *
 *   ownership   a person exports what they could already read, and no more
 *   masking     a field masked for them on screen is masked in the file
 *   the right   export rights are per role AND per object, so letting a
 *               supervisor take their team's leads out does not also let them
 *               take every client record out
 *
 * The scope test compares the export against the list rather than against a
 * number written here. A hardcoded count passes for the wrong reason the moment
 * the seed changes; "the file is the screen" is the actual promise.
 */

import { strict as assert } from 'node:assert';
import { all, one } from '../src/db.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

/* Its own administrator. Several test files and the e2e run all signed in as
   admin@bonanza.test, and ten a minute is the limiter's budget for one account --
   so the eleventh attempt was refused and the failure looked like a broken
   feature. A test that needs to sign in as somebody brings its own somebody. */
const PROBE = await probeAdmin('exportrights');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nExport rights');

const login = async (email, password = 'bonanza') => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  return (await res.json()).token;
};

const headers = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

/**
 * One sign-in per identity for the whole file.
 *
 * The login limiter allows ten a minute per account. Signing in per test is
 * both slower and, once a few files do it, enough to lock the account for the
 * run that follows -- which then fails with 401s that look like broken
 * features.
 */
const tokens = new Map();
const tokenFor = async (email) => {
  if (!tokens.has(email)) tokens.set(email, await login(email));
  return tokens.get(email);
};
const userIn = (role) => one('SELECT email FROM users WHERE role = ? AND active = 1 LIMIT 1', [role]);

const exportLeads = async (token, body = { columns: ['name'] }) => {
  const res = await fetch(`${BASE}/api/leads/export`, {
    method: 'POST', headers: headers(token), body: JSON.stringify(body),
  });
  return { status: res.status, text: res.status === 200 ? (await res.text()).replace(/^﻿/, '') : null, json: res.status === 200 ? null : await res.json().catch(() => null) };
};

const rowsOf = (csv) => csv.trim().split('\n').slice(1);

/* ------------------------------------------------------------ the right */

await test('a role without the right is refused, and told which one it needs', async () => {
  /* "Attempting to export without the right produces a clear, permission-based
     message." A 403 saying nothing is what sends somebody to raise a ticket
     about a broken button. */
  const rm = userIn('sales_rm');
  const res = await exportLeads(await tokenFor(rm.email));

  assert.equal(res.status, 403, `a sales RM exported leads: HTTP ${res.status}`);
  assert.equal(res.json?.required, 'export.lead', `the refusal did not name the capability: ${JSON.stringify(res.json)}`);
});

await test('the old blanket export permission is gone, not just unused', async () => {
  /* `data.export` gated clients, cases, partners and advanced search together,
     and `client.export` was in the catalogue and enforced nowhere. A capability
     left in the catalogue is a switch an administrator can tick that changes
     nothing, which is worse than no switch. */
  const codes = new Set(all('SELECT code FROM capabilities').map((c) => c.code));
  assert(!codes.has('data.export'), 'data.export is still offered in the roles screen');
  assert(!codes.has('client.export'), 'client.export is still offered in the roles screen');

  const grants = all("SELECT role_code FROM role_capabilities WHERE capability IN ('data.export','client.export')");
  assert.equal(grants.length, 0, `${grants.length} role(s) still hold a retired capability`);
});

await test('export rights are per object, not one switch', async () => {
  /* The point of the ticket. Taken away through the roles API rather than the
     table, because the server caches role capabilities in its own process and
     would not see a direct write. */
  const admin = await tokenFor(PROBE.email);
  const before = all("SELECT capability FROM role_capabilities WHERE role_code = 'sales_supervisor'")
    .map((r) => r.capability);
  assert(before.includes('export.lead'), 'setup: the supervisor should start with export.lead');
  assert(before.includes('export.client'), 'setup: the supervisor should start with export.client');

  const setCaps = (caps) => fetch(`${BASE}/api/setup/roles/sales_supervisor`, {
    method: 'PATCH', headers: headers(admin), body: JSON.stringify({ capabilities: caps }),
  });

  try {
    // Leads yes, clients no — the distinction that could not be expressed before.
    await setCaps(before.filter((c) => c !== 'export.client'));

    const sup = await tokenFor(userIn('sales_supervisor').email);
    const leads = await exportLeads(sup);
    assert.equal(leads.status, 200, `losing export.client also broke the lead export: ${leads.status}`);

    const clients = await fetch(`${BASE}/api/clients/export`, {
      method: 'POST', headers: headers(sup), body: JSON.stringify({}),
    });
    assert.equal(clients.status, 403, `a supervisor without export.client exported clients: HTTP ${clients.status}`);
  } finally {
    await setCaps(before);
  }
});

/* --------------------------------------------------------- the ownership */

await test('an export contains exactly what that person\'s list contains', async () => {
  /* Compared against the list rather than a number written here, because "the
     file is the screen" is the promise, and a hardcoded count would pass for
     the wrong reason the first time the seed changed. */
  for (const role of ['sales_supervisor', 'admin', 'superadmin']) {
    const who = userIn(role);
    if (!who) continue;

    const token = await tokenFor(who.email);
    const list = await (await fetch(`${BASE}/api/leads?limit=500`, { headers: headers(token) })).json();
    const file = await exportLeads(token);
    assert.equal(file.status, 200, `${role} could not export: HTTP ${file.status}`);

    assert.equal(rowsOf(file.text).length, list.length,
      `${role} sees ${list.length} leads and exports ${rowsOf(file.text).length}`);
  }
});

await test('a filter on the screen is a filter on the file', async () => {
  /* The export takes the same query the list does, through the same code. If
     these two ever disagreed the report would be "the export is missing leads",
     which is a hard thing to believe and a harder thing to find. */
  const token = await tokenFor(PROBE.email);
  const q = '?stage=New';

  const list = await (await fetch(`${BASE}/api/leads${q}&limit=500`, { headers: headers(token) })).json();
  const res = await fetch(`${BASE}/api/leads/export${q}`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ columns: ['name', 'stage'] }),
  });
  const rows = rowsOf((await res.text()).replace(/^﻿/, ''));

  assert.equal(rows.length, list.length, `filtered list has ${list.length} rows and the file has ${rows.length}`);
  for (const r of rows) assert(/,New$/.test(r.trim()), `a row outside the filter reached the file: ${r}`);
});

/* ----------------------------------------------------------- the masking */

await test('a field masked on screen is masked in the file', async () => {
  /* The ticket's words: "Actual values must never appear in the export." The
     way to be sure of that is not a careful export -- it is an export that
     cannot see more than the screen, which is why it goes through the same
     maskRecords call. */
  const sup = await tokenFor(userIn('sales_supervisor').email);
  const file = await exportLeads(sup, { columns: ['name', 'mobile', 'email'] });
  assert.equal(file.status, 200);

  const rows = rowsOf(file.text);
  assert(rows.length, 'nothing was exported, so this proves nothing');

  for (const row of rows.slice(0, 10)) {
    const [, mobile, email] = row.split(',');
    if (mobile?.trim()) {
      assert(!/^\d{10}$/.test(mobile.trim()), `a mobile reached the file in the clear: ${mobile}`);
      assert(/[•*]/.test(mobile), `a mobile is neither masked nor empty: ${mobile}`);
    }
    if (email?.trim()) {
      assert(/[•*]/.test(email), `an email reached the file in the clear: ${email}`);
    }
  }
});

await test('exporting leads is recorded', async () => {
  const before = one("SELECT COUNT(*) n FROM audit_log WHERE action = 'leads_exported'").n;
  await exportLeads(await tokenFor(PROBE.email));
  const after = one("SELECT COUNT(*) n FROM audit_log WHERE action = 'leads_exported'").n;

  assert.equal(after, before + 1, 'a lead export left no trace');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
