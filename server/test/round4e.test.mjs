/**
 * Round 4, the open and partly fixed findings, batch one (15 Oct 2026).
 *
 *   QA-05  every case figure opens the Cases page on exactly what it counts
 *   QA-12  an API key sent over plain http is refused when the proxy says so
 *   QA-17  one date format: 15-10-2026, and 15-10-2026 14:30 IST
 *   QA-18  Marketing is not offered the Service Console; the launcher closes
 *          on any press outside it
 *   QA-22  a headline says its source and date, and that it is a sample
 *   QA-25  the page makes room for the Copilot
 *   QA-43  the KYC board and the journey agree on who sees what -- and the
 *          two writes N-12 named are held to the same rule
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
// Read, not imported by name, so the unfixed code reports each failure rather than stopping here.
const dates = await import('../src/engine/daterange.js');
const dmy = dates.dmy ?? (() => 'no formatter');
const dmyTime = dates.dmyTime ?? (() => 'no formatter');
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
const source = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nRound 4, batch one: QA-05, 12, 17, 18, 22, 25, 43');

const RUN = Date.now().toString(36);
const MARK = `R4E probe ${RUN}`;
const call = async (who, method, url, body, headers = {}) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...(who?.headers ?? {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, total: Number(res.headers.get('x-total-count') ?? NaN), body: await res.json().catch(() => null) };
};

const CARE = await probeAdmin('r4e-care', { role: 'customer_care', sales_org: 'BONANZA' });
const SUP = await probeAdmin('r4e-sup', { role: 'sales_supervisor', sales_org: 'BONANZA' });
const MKT = await probeAdmin('r4e-mkt', { role: 'marketing_manager', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('r4e-bigul', { role: 'admin', sales_org: 'BIGUL' });
const probes = [CARE, SUP, MKT, BIGUL];

const tickets = [];
const ist = (offsetMin = 0) => new Date(Date.now() + offsetMin * 60_000).toISOString().replace('T', ' ').slice(0, 19);
const makeTicket = (cols) => {
  const id = Number(run(
    `INSERT INTO tickets (ref, subject, description, priority, status, assignee_id, sales_org, resolution_due, resolved_at, breached, csat)
     VALUES (?, ?, 'probe', 'Medium', ?, ?, 'BONANZA', ?, ?, ?, ?)`,
    [`R4E-${RUN}-${tickets.length}`, `${MARK} case ${tickets.length}`, cols.status ?? 'Open', cols.assignee ?? CARE.id,
      cols.due ?? null, cols.resolved ?? null, cols.breached ?? 0, cols.csat ?? null],
  ).lastInsertRowid);
  tickets.push(id);
  return id;
};

/* What the Cases page asks the API for, given a link (client/src/crm/Tickets.jsx). */
const LINKED = ['mine', 'breached', 'status', 'due_today', 'rated', 'resolved_from', 'resolved_to', 'created_from', 'created_to'];
function listQueryFor(to, role) {
  const u = new URL(to, 'http://x');
  const view = u.searchParams.get('view') ?? (role === 'customer_care' ? 'mine' : 'open');
  const base = { mine: { mine: 'true', open: 'true' }, open: { open: 'true' }, breached: { breached: 'true' }, all: {} }[view];
  const q = new URLSearchParams({ ...base, limit: '500' });
  for (const k of LINKED) if (u.searchParams.get(k)) q.set(k, u.searchParams.get(k));
  if (q.get('resolved_from') || q.get('resolved_to')) q.delete('open');
  return `/tickets?${q}`;
}

try {
  /* -------------------------------------------------------------- QA-05 */

  await test('QA-05: every Customer Care figure links to the cases it counts, and the counts agree', async () => {
    makeTicket({});                                                    // open, assigned
    makeTicket({ due: ist(60) });                                      // due today (an hour from now)
    makeTicket({ breached: 1, due: ist(-600) });                       // breached, open
    makeTicket({ status: 'Waiting on Client', due: ist(-600) });       // paused, past due: not breached
    makeTicket({ status: 'Resolved', resolved: ist(-5), csat: 5 });    // resolved today, rated
    makeTicket({ status: 'Resolved', resolved: ist(-5), breached: 1 }); // resolved after breaching: not "breached" now

    const cockpit = (await call(CARE, 'GET', '/cockpit')).body;
    const figures = cockpit.metrics.filter((m) => m.label !== 'CSAT (rolling)');
    assert.equal(figures.length, 5);
    for (const m of figures) {
      assert(m.to?.startsWith('/tickets?'), `"${m.label}" does not link to its cases`);
      assert(m.sub, `"${m.label}" does not say whose cases it counts`);
      const list = await call(CARE, 'GET', listQueryFor(m.to, 'customer_care'));
      assert.equal(list.total, m.value, `"${m.label}" says ${m.value}, its list holds ${list.total}`);
    }
    const csat = cockpit.metrics.find((m) => m.label === 'CSAT (rolling)');
    assert(csat.to?.includes('rated=true'), 'CSAT does not link to the rated cases');
  });

  await test('QA-05: Home\'s case tiles name their view, and "breached" means one thing', async () => {
    // Customer Care's Home carries the case tiles (the auditor's screen).
    const tiles = (await call(CARE, 'GET', '/dashboard?range=mtd')).body;
    const flat = JSON.stringify(tiles);
    assert(flat.includes('/tickets?view=breached'), 'Home\'s SLA breached tile does not name its view');
    assert(flat.includes('/tickets?view=open'), 'Home\'s open cases tile does not name its view');
    const breachedOpen = one(
      "SELECT COUNT(*) n FROM tickets t WHERE t.breached = 1 AND t.status NOT IN ('Resolved','Closed') AND t.merged_into IS NULL AND t.sales_org = 'BONANZA'",
    ).n;
    const list = await call(CARE, 'GET', listQueryFor('/tickets?view=breached', 'customer_care'));
    assert.equal(list.total, breachedOpen, 'the Breached list counts resolved or paused cases');
    const summary = (await call(SUP, 'GET', '/tickets/reports/summary')).body;
    if (summary?.totals) assert.equal(summary.totals.breached, breachedOpen, 'the team summary counts breaches differently');
  });

  await test('QA-05: the Cases page reads the linked filters and shows them as chips (source check)', () => {
    const page = source('crm/Tickets.jsx');
    for (const k of LINKED) assert(page.includes(`'${k}'`), `the Cases page ignores ${k}`);
    assert(/chipsFor/.test(page) && /dropChip/.test(page), 'the linked filters are not shown or removable');
  });

  /* -------------------------------------------------------------- QA-12 */

  await test('QA-12: a key sent over plain http is refused when the proxy says so, and only then', async () => {
    const key = { 'x-api-key': 'bnz_probe', 'x-api-secret': 'sk_probe' };
    const insecure = await call(null, 'GET', '/auth/me', undefined, { ...key, 'x-forwarded-proto': 'http' });
    assert.equal(insecure.status, 403);
    assert.equal(insecure.body.code, 'insecure_transport');
    assert.match(insecure.body.error, /rotate/i, 'the refusal does not say to rotate the exposed key');
    const secure = await call(null, 'GET', '/auth/me', undefined, { ...key, 'x-forwarded-proto': 'https' });
    assert.notEqual(secure.body?.code, 'insecure_transport');
    const unknown = await call(null, 'GET', '/auth/me', undefined, key);
    assert.notEqual(unknown.body?.code, 'insecure_transport', 'a key was refused without the proxy saying http');
  });

  /* -------------------------------------------------------------- QA-17 */

  await test('QA-17: one format -- 15-10-2026, and 15-10-2026 14:30 IST', () => {
    assert.equal(dmy('2026-10-15'), '15-10-2026', 'a bare day is not printed as the day it names');
    assert.equal(dmyTime('2026-10-15 09:00:00'), '15-10-2026 14:30 IST', 'a stored UTC time is not shown in India');
    assert.equal(dmy('2026-10-14 19:30:00'), '15-10-2026', '01:00 IST is not on its India day');
    const api = source('api.js');
    assert(/export const shortDate = dmy/.test(api) && /export const dateTime = dmyTime/.test(api), 'the shared helpers do not use the one format');
    for (const rel of ['crm/Calendar.jsx', 'crm/Reports.jsx', 'crm/admin/Integrations.jsx', 'crm/LeadImport.jsx']) {
      assert(!/toLocaleDateString\('en-IN', \{ (day|weekday): '(numeric|long)', (day: 'numeric', )?month: 'short'/.test(source(rel)), `${rel} still formats its own dates`);
    }
    assert(/\{dmy\(d\.on_date\)\}/.test(source('crm/admin/Calendars.jsx')), 'holidays still print ISO');
    assert(/dmyTime\(r\.created_at\)/.test(source('crm/LeadImport.jsx')), 'import history still prints ISO');
  });

  /* -------------------------------------------------------------- QA-18 */

  await test('QA-18: Marketing is not offered the Service Console; Customer Care is', async () => {
    const mkt = (await call(MKT, 'GET', '/apps')).body.apps.map((a) => a.id);
    assert(!mkt.includes('service'), 'Marketing is offered the Service Console');
    const care = (await call(CARE, 'GET', '/apps')).body.apps.map((a) => a.id);
    assert(care.includes('service'), 'Customer Care lost its console');
  });

  await test('QA-18: the launcher closes on any press outside it, and on navigating (source check)', () => {
    const ui = source('components/ui.jsx');
    assert(/addEventListener\('pointerdown', onDown, true\)/.test(ui), 'outside presses are not caught before the page can swallow them');
    assert(/useEffect\(\(\) => \{ setOpen\(false\); \}, \[pathname\]\)/.test(source('components/AppNav.jsx')), 'navigating leaves the launcher open');
  });

  /* ------------------------------------------------------ QA-22, QA-25 */

  await test('QA-22: a headline says its source and its date, and that it is a sample (source check)', () => {
    const market = source('components/Market.jsx');
    assert(/Source: \{n\.source\} · \{dmyTime\(n\.published_at\)\}/.test(market), 'a headline does not carry its source and date');
    assert(/Sample headlines from the simulated feed/.test(market), 'the simulated headlines are not called that');
    assert(/n\.url \?/.test(market), 'a headline with a link no longer opens it');
  });

  await test('QA-25: the page makes room for the Copilot where there is room (source check)', () => {
    assert(/with-copilot/.test(source('crm/Crm.jsx')), 'the page is not told the Copilot is open');
    assert(/\.main-content\.with-copilot \{ padding-right/.test(source('styles.css')), 'nothing reflows the page');
  });

  /* -------------------------------------------------------------- QA-43 */

  await test('QA-43: for every role that reads KYC, what the board lists opens, and nothing else does', async () => {
    const roles = all("SELECT DISTINCT role_code FROM role_capabilities WHERE capability = 'kyc.view'").map((r) => r.role_code);
    const everyJourney = all('SELECT id FROM kyc_journeys').map((j) => j.id);
    assert(everyJourney.length > 0, 'precondition: no journeys to check');
    const disagreements = [];
    for (const role of roles) {
      // eslint-disable-next-line no-await-in-loop
      const who = await probeAdmin(`r4e-kyc-${role}`, { role, sales_org: 'BONANZA' });
      probes.push(who);
      // eslint-disable-next-line no-await-in-loop
      const listed = new Set(((await call(who, 'GET', '/kyc/health')).body ?? []).map((j) => j.id));
      for (const id of everyJourney) {
        // eslint-disable-next-line no-await-in-loop
        const opened = (await call(who, 'GET', `/kyc/journeys/${id}`)).status === 200;
        if (opened !== listed.has(id)) disagreements.push(`${role} #${id}: ${listed.has(id) ? 'listed, refused' : 'not listed, opened'}`);
      }
    }
    assert.deepEqual(disagreements, [], `the board and the detail disagree:\n       ${disagreements.join('\n       ')}`);
  });

  await test('QA-43 / N-12: the other business cannot take over or force a step on an application', async () => {
    const bonanza = one(
      "SELECT j.id, j.current_step FROM kyc_journeys j JOIN product_types p ON p.id = j.product_type_id WHERE p.sales_org = 'BONANZA' LIMIT 1",
    );
    assert(bonanza, 'precondition: no Bonanza journey');
    const before = JSON.stringify(all('SELECT step_code, status FROM kyc_journey_progress WHERE journey_id = ? ORDER BY step_code', [bonanza.id]));
    assert.equal((await call(BIGUL, 'POST', `/kyc/journeys/${bonanza.id}/assist`, {})).status, 403, 'a Bigul Admin took over a Bonanza application');
    const forced = await call(BIGUL, 'POST', `/kyc/journeys/${bonanza.id}/override`, { step_code: bonanza.current_step, action: 'complete' });
    assert.equal(forced.status, 403, 'a Bigul Admin forced a step on a Bonanza application');
    const after = JSON.stringify(all('SELECT step_code, status FROM kyc_journey_progress WHERE journey_id = ? ORDER BY step_code', [bonanza.id]));
    assert.equal(after, before, 'the application changed');
  });
} finally {
  for (const id of tickets) run('DELETE FROM tickets WHERE id = ?', [id]);
  run('DELETE FROM tickets WHERE subject LIKE ?', [`${MARK}%`]);
  for (const p of probes) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
