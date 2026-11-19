/**
 * A16 (B21, ruled 19 Nov 2026): a Customer Care scorecard counts who did the
 * work.
 *
 *   resolved   the cases a person resolved, whoever holds them now
 *   breaches   the breaches in the period while the case was theirs
 *   csat       the share of answers in the period that were 4 or 5, on cases
 *              they resolved, scored from 10 answers
 *   team       anyone with reports counts their team's work too
 *   desk       the desk's figure beside each, for context, never scored
 *   one CSAT   the home tile and the case report show the scorecard's CSAT,
 *              and the tile opens on exactly the cases it counts
 *
 * Before, each counted everything its reader could see -- the whole desk,
 * the same number for every agent -- and CSAT was an all-time average by
 * whoever held the case now.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { scoreOf } from '../src/engine/kra.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const made = [];
const make = (table, cols) => {
  const keys = Object.keys(cols);
  const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols)).lastInsertRowid);
  made.push([table, id]);
  return id;
};
const stamp = String(Date.now()).slice(-6);
let serial = 0;
const now = (modifier = '+0 minutes') => one('SELECT datetime(\'now\', ?) t', [modifier]).t;

const call = async (who, path) => {
  const res = await fetch(`${BASE}${path}`, { headers: who.headers });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json, total: Number(res.headers.get('x-total-count')) };
};

const A = await probeAdmin('card-a', { role: 'customer_care', sales_org: 'BIGUL' });
const B = await probeAdmin('card-b', { role: 'customer_care', sales_org: 'BIGUL' });
const M = await probeAdmin('card-m', { role: 'customer_care', sales_org: 'BIGUL' });
const ADMIN = await probeAdmin('card-admin', { role: 'admin', sales_org: 'BIGUL' });
run('UPDATE users SET manager_id = ? WHERE id = ?', [M.id, A.id]);
const probes = [A, B, M, ADMIN];

/** A scorecard's metric by source, as the screen reads it. */
const card = async (who) => Object.fromEntries(((await call(who, '/api/kra')).body?.metrics ?? []).map((m) => [m.source, m]));
const ticket = (extra) => {
  serial += 1;
  return make('tickets', { ref: `BGL-K${stamp}${serial}`, subject: 'Scorecard probe', sales_org: 'BIGUL', status: 'Open', ...extra });
};

console.log('\nA16: Customer Care scorecards count who did the work');

try {
  const before = { A: await card(A), B: await card(B), M: await card(M) };
  for (const [who, c] of Object.entries(before)) {
    for (const source of ['cases_resolved', 'sla_breaches', 'csat']) assert.ok(c[source], `${who} has no ${source} metric`);
  }

  await test('cases resolved counts what each person resolved, whoever holds the case now', async () => {
    ticket({ status: 'Resolved', resolved_at: now(), resolved_by: A.id, assignee_id: B.id });
    const a = (await card(A)).cases_resolved.actual;
    const b = (await card(B)).cases_resolved.actual;
    assert.equal(a, before.A.cases_resolved.actual + 1, `A resolved it and has ${a}, was ${before.A.cases_resolved.actual}`);
    assert.equal(b, before.B.cases_resolved.actual, `B holds it now and has ${b}, was ${before.B.cases_resolved.actual}`);
  });

  await test('an SLA breach counts for whoever held the case when it breached', async () => {
    const t = ticket({ status: 'Open', breached: 1, breached_at: now('-60 minutes'), assignee_id: B.id });
    // Breached in A's hands; moved to B half an hour later.
    make('field_history', { entity: 'case', record_id: t, field: 'assignee_id', old_value: String(A.id), new_value: String(B.id), source: 'ui', changed_at: now('-30 minutes') });
    const a = (await card(A)).sla_breaches.actual;
    const b = (await card(B)).sla_breaches.actual;
    assert.equal(a, before.A.sla_breaches.actual + 1, `A held it when it breached and has ${a}`);
    assert.equal(b, before.B.sla_breaches.actual, `B was given it afterwards and has ${b}`);
  });

  await test('anyone with reports counts their team\'s work as well as their own', async () => {
    const m = await card(M);
    assert.equal(m.cases_resolved.actual, before.M.cases_resolved.actual + 1, 'the manager does not count what A resolved');
    assert.equal(m.sla_breaches.actual, before.M.sla_breaches.actual + 1, 'the manager does not count A\'s breach');
    const a = await card(A);
    assert.equal(a.cases_resolved.actual, before.A.cases_resolved.actual + 1, 'A counts more than their own');
  });

  await test('CSAT is the share of answers that were 4 or 5, scored from 10 answers', async () => {
    const answer = (score) => {
      const t = ticket({ status: 'Resolved', resolved_at: now(), resolved_by: A.id, assignee_id: A.id });
      make('csat_surveys', { ticket_id: t, sales_org: 'BIGUL', channel: 'whatsapp', resolved_by: A.id, status: 'Answered', score, answered_at: now(), sent_at: now('-1 hour') });
    };
    for (const score of [5, 5, 5, 5, 4, 4, 4, 4, 2]) answer(score);
    const nine = (await card(A)).csat;
    assert.equal(nine.actual, null, `scored from 9 answers: ${nine.actual}`);
    assert.match(String(nine.reason), /9 answers so far; scored from 10/, `says: ${nine.reason}`);
    answer(3);
    const ten = (await card(A)).csat;
    assert.equal(ten.actual, 80, `8 of 10 answers were 4 or 5, and it says ${ten.actual}`);
    assert.equal((await card(B)).csat.actual, before.B.csat.actual, 'B is credited with cases A resolved');
  });

  await test('the desk\'s figure sits beside each, and is not scored', async () => {
    const a = await card(A);
    for (const source of ['cases_resolved', 'sla_breaches', 'csat']) {
      assert.ok(a[source].desk !== undefined, `${source} carries no desk figure`);
    }
    const desk = one(
      `SELECT COUNT(*) n FROM tickets WHERE sales_org = 'BIGUL' AND resolved_at >= datetime(date('now', '+330 minutes', 'start of month'), '-330 minutes')`,
    ).n;
    assert.equal(a.cases_resolved.desk, desk, `the desk resolved ${desk} this month; the card says ${a.cases_resolved.desk}`);
    assert.ok(a.cases_resolved.desk >= a.cases_resolved.actual, 'the desk is smaller than one of its own');
    for (const source of ['cases_resolved', 'sla_breaches', 'csat']) {
      const m = a[source];
      assert.equal(m.score, scoreOf(m, m.actual), `${source}: the score is not the person's own figure's`);
    }
  });

  await test('the Customer Care home and the case report show the scorecard\'s CSAT', async () => {
    const tiles = (await call(A, '/api/cockpit')).body?.metrics ?? [];
    const tile = tiles.find((t) => /^CSAT/.test(t.label));
    assert.ok(tile, `no CSAT tile among ${tiles.map((t) => t.label).join(', ')}`);
    assert.equal(tile.value, '80%', `the home says ${tile.value}; the scorecard says 80%`);
    const report = (await call(ADMIN, '/api/tickets/reports/summary')).body;
    const row = report.by_agent.find((r) => r.agent_id === A.id);
    assert.equal(row?.csat_pct, 80, `the case report says ${row?.csat_pct} for A`);
    assert.ok('csat_pct' in report.totals, 'the report has no desk CSAT');
  });

  await test('the home tile opens on exactly the cases it counts', async () => {
    const tile = ((await call(A, '/api/cockpit')).body?.metrics ?? []).find((t) => /^CSAT/.test(t.label));
    const list = await call(A, `/api${tile.to.replace(/^\/tickets/, '/tickets')}`);
    assert.equal(list.status, 200, `HTTP ${list.status}`);
    assert.equal(list.total, 10, `the tile counts 10 answers; its link lists ${list.total} cases`);
  });
} finally {
  run('UPDATE users SET manager_id = NULL WHERE id = ?', [A.id]);
  for (const [table, id] of [...made].reverse()) {
    try { run(`DELETE FROM ${table} WHERE id = ?`, [id]); } catch { /* removed with its parent */ }
  }
  for (const p of probes) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
