/**
 * A19 (B25, ruled 20 Nov 2026): a reopened case gets fresh SLA deadlines.
 *
 * A reopened case kept the deadlines of its first round. So a case resolved
 * on time and reopened after its old deadline was flagged as breached at the
 * next sweep, a minute later: its agent and their manager were alerted, and
 * the scorecard counted the agent a breach on a case they had resolved in
 * time.
 *
 * Ruled: a reopened case gets new response and resolution deadlines under its
 * priority's policy, counted from the moment it reopened. A breach in an
 * earlier round stays on its record.
 *
 * Every way a case reopens is checked: an agent's Reopen (to Open, or straight
 * to Waiting on Client) and a partner's reply on the portal. So are what reads
 * the deadlines afterwards -- the sweep, a later change of priority, the
 * scorecard, the SLA report -- and the Reopen dialog's preview.
 *
 * OPS-79, found on the way: the SLA report and the overview's case counts
 * were the whole firm's, both businesses, whoever read them.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { policyFor, addBusinessMinutes } from '../src/engine/sla.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import { tokenKey } from '../src/security.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stamp = String(Date.now()).slice(-7);
const MARK = `Reopen SLA ${stamp}`;
const probes = [];
const probe = async (slug, role, extra = {}) => {
  const p = await probeAdmin(`reopen-${slug}`, { role, sales_org: extra.sales_org ?? 'BONANZA' });
  const sets = Object.keys(extra).filter((k) => k !== 'sales_org');
  if (sets.length) run(`UPDATE users SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...sets.map((k) => extra[k]), p.id]);
  probes.push(p);
  return p;
};
const at = (modifier) => one("SELECT datetime('now', ?) t", [modifier]).t;
const later = (a, b) => new Date(`${a.replace(' ', 'T')}Z`) > new Date(`${b.replace(' ', 'T')}Z`);
const near = (a, b, seconds) => Math.abs(new Date(`${a.replace(' ', 'T')}Z`) - new Date(`${b.replace(' ', 'T')}Z`)) <= seconds * 1000;

const tickets = [];
let n = 0;
/** A case raised three days ago, Medium, whose first-round deadline passed yesterday. */
const caseOf = (cols = {}) => {
  n += 1;
  const org = cols.sales_org ?? 'BONANZA';
  const id = Number(run(
    `INSERT INTO tickets (ref, subject, description, sales_org, status, priority, assignee_id, response_due, resolution_due, created_at, updated_at)
     VALUES (?, ?, 'Raised by the reopen check, about a refund.', ?, ?, 'Medium', ?, ?, ?, ?, datetime('now'))`,
    [`${org === 'BIGUL' ? 'BGL' : 'BNZ'}-RO${stamp}${n}`, `${MARK} case ${n}`, org, cols.status ?? 'Resolved', cols.assignee_id ?? null,
      at('-2 days'), at('-1 days'), at('-3 days')],
  ).lastInsertRowid);
  const extra = Object.keys(cols).filter((k) => !['sales_org', 'status', 'assignee_id'].includes(k));
  if (extra.length) run(`UPDATE tickets SET ${extra.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...extra.map((k) => cols[k]), id]);
  tickets.push(id);
  return id;
};
const row = (id) => one('SELECT * FROM tickets WHERE id = ?', [id]);
const breachNotices = (userId, id) => one(
  "SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND link = ? AND title LIKE '%SLA breach%'", [userId, `/tickets/${id}`],
).n;

console.log('\nA19: a reopened case gets fresh SLA deadlines (B25)');

let partner = null;
let token = null;
try {
  const SWEEPER = await probe('sweeper', 'admin');
  const MGR = await probe('mgr', 'sales_supervisor');
  const CARE = await probe('care', 'customer_care', { manager_id: MGR.id });
  const sweep = () => as(SWEEPER)('POST', '/tickets/sweep');
  /* The scorecard's SLA breaches figure: the person's own, and the desk's beside it. */
  const scorecard = async (who) => {
    const m = ((await as(who)('GET', '/kra')).body?.metrics ?? []).find((x) => x.source === 'sla_breaches');
    assert.ok(Number.isInteger(m?.actual) && Number.isInteger(m?.desk), `no SLA breaches figure on the scorecard: ${JSON.stringify(m)}`);
    return m;
  };
  const breachesOn = async (who) => (await scorecard(who)).actual;
  const reopen = (id, status = 'Open') => as(CARE)('PATCH', `/tickets/${id}`, { status, reason: `${MARK}: the client says it is not fixed` });

  /* ---------------------------------------------------- resolved on time */
  const onTime = caseOf({ assignee_id: CARE.id, resolved_at: at('-2 days'), resolved_by: CARE.id });
  const scoredBefore = await breachesOn(CARE);
  let reopened = null;

  await test('reopening gives the case fresh deadlines, counted from the reopening', async () => {
    const res = await reopen(onTime);
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    reopened = row(onTime);
    assert.equal(reopened.status, 'Open');
    assert.ok(reopened.resolution_due && later(reopened.resolution_due, at('+0 minutes')),
      `its resolution deadline is ${reopened.resolution_due}, already past: the first round's was kept`);
    assert.equal(reopened.sla_round, 2, `the case is in round ${reopened.sla_round}`);
    assert.ok(reopened.sla_started_at && near(reopened.sla_started_at, at('+0 minutes'), 60), `its round started ${reopened.sla_started_at}`);
  });

  await test('they are its priority\'s policy, measured in business time from the reopening', async () => {
    const policy = policyFor(null, 'Medium');
    const from = new Date(`${reopened.sla_started_at.replace(' ', 'T')}Z`);
    const want = (mins) => addBusinessMinutes(from, mins).toISOString().slice(0, 19).replace('T', ' ');
    assert.equal(reopened.response_due, want(policy.response_mins), 'the response deadline');
    assert.equal(reopened.resolution_due, want(policy.resolution_mins), 'the resolution deadline');
  });

  await test('the next sweep does not flag it, and nobody is told of a breach', async () => {
    const swept = await sweep();
    assert.equal(swept.status, 200, `the sweep answered ${swept.status}`);
    assert.equal(row(onTime).breached, 0, 'the case resolved on time was flagged as breached a minute after it reopened');
    assert.equal(breachNotices(CARE.id, onTime), 0, 'the agent was told of a breach');
    assert.equal(breachNotices(MGR.id, onTime), 0, 'their manager was told of a breach');
    assert.equal(one('SELECT COUNT(*) n FROM sla_breaches WHERE ticket_id = ?', [onTime]).n, 0, 'a breach is on its record');
  });

  await test('the agent\'s scorecard does not count a breach for it', async () => {
    assert.equal(await breachesOn(CARE), scoredBefore, 'the reopen cost the agent a breach on their scorecard');
  });

  await test('the case says what the new deadlines are, and the audit has them', async () => {
    const detail = (await as(CARE)('GET', `/tickets/${onTime}`)).body;
    assert.ok(detail.replies.some((r) => r.internal && /New deadlines under Medium, counted from the reopening/.test(r.body)),
      'no note on the case of the new deadlines');
    const audit = one("SELECT detail FROM audit_log WHERE action = 'ticket_reopened' AND entity_id = ? ORDER BY id DESC LIMIT 1", [onTime]);
    const said = JSON.parse(audit?.detail ?? '{}');
    assert.equal(said.round, 2);
    assert.equal(said.resolution_due, reopened.resolution_due);
  });

  /* -------------------------------------- breached in its first round */
  const late = caseOf({
    assignee_id: CARE.id, resolved_at: at('-1 hours'), resolved_by: CARE.id,
    breached: 1, breached_at: at('-2 hours'), resolution_due: at('-2 hours'),
  });
  const lateScored = await breachesOn(CARE);
  const deskBefore = (await scorecard(CARE)).desk;
  // The Admin's report: the whole business's cases.
  const report = async () => ((await as(SWEEPER)('GET', '/reports/sla')).body?.by_priority ?? []).reduce((sum, r) => sum + (r.breached ?? 0), 0);
  const reportedBefore = await report();

  await test('a breach in the first round stays on its record when the case reopens', async () => {
    assert.equal((await reopen(late)).status, 200);
    const t = row(late);
    assert.equal(t.breached, 0, 'the new round starts breached');
    const record = all('SELECT round, breached_at FROM sla_breaches WHERE ticket_id = ? ORDER BY round', [late]);
    assert.deepEqual(record.map((b) => b.round), [1], `its record of breaches: ${JSON.stringify(record)}`);
    const detail = (await as(CARE)('GET', `/tickets/${late}`)).body;
    assert.deepEqual((detail.sla_breaches ?? []).map((b) => b.round), [1], 'the case does not show its first-round breach');
    assert.ok(detail.replies.some((r) => r.internal && /Its breach in round 1 .* stays on its record/.test(r.body)),
      'the note does not say the first-round breach stands');
  });

  await test('...and still counts: on the scorecard of whoever held it, the desk\'s, and in the SLA report', async () => {
    assert.ok(lateScored >= 1 && reportedBefore >= 1, `the first-round breach was not counted to begin with (${lateScored}, ${reportedBefore})`);
    assert.equal(await breachesOn(CARE), lateScored, 'the reopen took the first-round breach off the agent\'s scorecard');
    assert.equal((await scorecard(CARE)).desk, deskBefore, 'the reopen took it off the desk\'s figure');
    assert.equal(await report(), reportedBefore, 'the SLA report stopped counting it');
  });

  await test('the reopened case is not in the Breached list until its new round breaches', async () => {
    const list = (await as(CARE)('GET', '/tickets?breached=true&limit=500')).body;
    const rows = Array.isArray(list) ? list : (list?.rows ?? list?.tickets ?? []);
    assert.ok(!rows.some((t) => t.id === late), 'it is listed as breached in a round that has not breached');
  });

  await test('the new round breaches on its own account, and both breaches count', async () => {
    run('UPDATE tickets SET resolution_due = ? WHERE id = ?', [at('-1 minutes'), late]);
    const toldBefore = breachNotices(CARE.id, late);
    await sweep();
    assert.equal(row(late).breached, 1, 'the second round\'s breach was not flagged');
    assert.deepEqual(all('SELECT round FROM sla_breaches WHERE ticket_id = ? ORDER BY round', [late]).map((b) => b.round), [1, 2]);
    assert.equal(breachNotices(CARE.id, late), toldBefore + 1, 'the agent was not told of the second breach');
    assert.equal(await breachesOn(CARE), lateScored + 1, 'the scorecard does not count the second round\'s breach');
  });

  /* ------------------------------------------- a priority change later */
  const reprice = caseOf({ assignee_id: CARE.id, resolved_at: at('-2 days'), resolved_by: CARE.id });

  await test('a change of priority after a reopen counts from the reopening, not the raising', async () => {
    assert.equal((await reopen(reprice)).status, 200);
    const preview = await as(CARE)('GET', `/tickets/${reprice}/change-preview?priority=High`);
    assert.equal(preview.status, 200, `the preview answered ${preview.status}: ${preview.body?.error}`);
    const words = JSON.stringify(preview.body);
    assert.match(words, /counted from when it was reopened on/, `the preview says: ${words.slice(0, 300)}`);
    const res = await as(CARE)('PATCH', `/tickets/${reprice}`, { priority: 'High' });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    const t = row(reprice);
    const want = addBusinessMinutes(new Date(`${t.sla_started_at.replace(' ', 'T')}Z`), policyFor(null, 'High').resolution_mins)
      .toISOString().slice(0, 19).replace('T', ' ');
    assert.equal(t.resolution_due, want, 'the High deadline is not counted from the reopening');
    await sweep();
    assert.equal(row(reprice).breached, 0, 'raised to High, the reopened case was flagged at once');
  });

  /* -------------------------------- reopened to Waiting on Client */
  const waiting = caseOf({ assignee_id: CARE.id, resolved_at: at('-2 days'), resolved_by: CARE.id, sla_paused_ms: 7_200_000 });

  await test('reopened straight to Waiting on Client, the new round\'s clock is paused from the reopening', async () => {
    assert.equal((await reopen(waiting, 'Waiting on Client')).status, 200);
    const t = row(waiting);
    assert.equal(t.status, 'Waiting on Client');
    assert.ok(t.sla_paused_at && near(t.sla_paused_at, at('+0 minutes'), 60), `paused at ${t.sla_paused_at}`);
    assert.equal(t.sla_paused_ms, 0, 'the first round\'s waiting still moves the new deadlines');
    assert.ok(later(t.resolution_due, at('+0 minutes')), 'its deadline is already past');
  });

  /* ------------------------------------------------- the Reopen dialog */
  const asked = caseOf({ assignee_id: CARE.id, resolved_at: at('-2 days'), resolved_by: CARE.id, breached: 1, breached_at: at('-30 hours') });

  await test('the Reopen dialog is told the new deadlines and the breach that stays, and asking changes nothing', async () => {
    const before = row(asked);
    const res = await as(CARE)('GET', `/tickets/${asked}/reopen-preview`);
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(res.body.round, 2);
    assert.ok(later(res.body.resolution_due, at('+0 minutes')), 'the preview offers a deadline already past');
    assert.match(res.body.said.join(' '), /It gets new deadlines under Medium, counted from when it is reopened/);
    assert.match(res.body.said.join(' '), /Its breach in round 1 .* stays on its record/);
    assert.deepEqual(row(asked), before, 'the preview changed the case');
    const open = await as(CARE)('GET', `/tickets/${onTime}/reopen-preview`);
    assert.equal(open.status, 409, 'an open case offers to reopen');
  });

  /* ---------------------------------------------- a partner's reply */
  partner = Number(run("INSERT INTO partners (name, sales_org, state_code) VALUES (?, 'BONANZA', 'ACTIVE')", [`${MARK} partner`]).lastInsertRowid);
  token = `reopen-partner-${stamp}`;
  run("INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?,?,'partner',datetime('now','+1 hours'),datetime('now'))", [tokenKey(token), partner]);
  const PARTNER = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  const theirs = caseOf({ assignee_id: CARE.id, resolved_at: at('-2 days'), resolved_by: CARE.id, partner_id: partner });

  await test('a partner\'s reply on the portal reopens it with fresh deadlines too', async () => {
    const res = await as(PARTNER)('POST', `/portal/tickets/${theirs}/replies`, { body: `${MARK}: the payout still has not arrived` });
    assert.equal(res.status, 201, `HTTP ${res.status}: ${res.body?.error}`);
    const t = row(theirs);
    assert.equal(t.status, 'Open');
    assert.equal(t.sla_round, 2, `the case is in round ${t.sla_round}`);
    assert.ok(later(t.resolution_due, at('+0 minutes')), `its resolution deadline is ${t.resolution_due}: the first round's was kept`);
    await sweep();
    assert.equal(row(theirs).breached, 0, 'the partner\'s reopened case was flagged as breached');
    assert.equal(breachNotices(CARE.id, theirs), 0, 'the agent was told of a breach');
  });

  await test('...said on the case for the agent, not to the partner, and audited', async () => {
    const staff = (await as(CARE)('GET', `/tickets/${theirs}`)).body;
    assert.ok(staff.replies.some((r) => r.internal && /Reopened by the partner's reply .*New deadlines under Medium/s.test(r.body)),
      'the agent is not told the new deadlines');
    const seen = (await as(PARTNER)('GET', `/portal/tickets/${theirs}`)).body;
    const theirReplies = seen?.replies ?? [];
    assert.ok(theirReplies.length && !theirReplies.some((r) => /New deadlines/.test(r.body)), 'the partner is shown the internal note');
    const audit = one("SELECT detail FROM audit_log WHERE action = 'ticket_reopened' AND entity_id = ?", [theirs]);
    assert.ok(audit && JSON.parse(audit.detail).by_partner === partner, 'the partner\'s reopen is not audited');
  });

  /* ---------------------------------------------------------- OPS-79 */
  await test('OPS-79: the SLA report and the overview count only the reader\'s business', async () => {
    const totals = async () => {
      const sla = await as(SWEEPER)('GET', '/reports/sla');
      const overview = await as(SWEEPER)('GET', '/reports/overview');
      assert.equal(sla.status, 200, `the SLA report answered ${sla.status}`);
      assert.equal(overview.status, 200, `the overview answered ${overview.status}`);
      return {
        sla: (sla.body?.by_priority ?? []).reduce((sum, r) => sum + r.total, 0),
        open: overview.body?.tickets?.open,
      };
    };
    const before = await totals();
    caseOf({ sales_org: 'BIGUL', status: 'Open', breached: 1, breached_at: at('-1 hours') });
    const after = await totals();
    assert.deepEqual(after, before, `a Bigul case changed a Bonanza Admin's report: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    caseOf({ status: 'Open' });
    const own = await totals();
    assert.deepEqual(own, { sla: before.sla + 1, open: before.open + 1 }, `a Bonanza case is not counted: ${JSON.stringify(own)}`);
  });
} finally {
  if (token) run('DELETE FROM sessions WHERE token = ?', [tokenKey(token)]);
  for (const id of tickets) {
    run('DELETE FROM notifications WHERE link = ?', [`/tickets/${id}`]);
    run("DELETE FROM field_history WHERE entity = 'case' AND record_id = ?", [id]);
    run("DELETE FROM audit_log WHERE entity IN ('ticket', 'case') AND entity_id = ?", [id]);
  }
  for (const id of [...tickets].reverse()) run('DELETE FROM tickets WHERE id = ?', [id]);
  if (partner) run('DELETE FROM partners WHERE id = ?', [partner]);
  if (probes.length) run(`UPDATE users SET manager_id = NULL WHERE id IN (${probes.map(() => '?').join(',')})`, probes.map((p) => p.id));
  for (const p of [...probes].reverse()) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
