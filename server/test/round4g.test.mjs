/**
 * Round 4, QA-07 -- Ritesh's Part 4, items 1 to 4 (16 Oct 2026).
 *
 *   1  Escalate and Mark resolved ask first, and say what they will do
 *   2  the conversation panel shows at most 50 entries; Show more has them all
 *   3  Manage holds its changes until Save, which asks first; the Waiting on
 *      Client note belongs to Status; an internal note says who sees it
 *   4  the SLA sweep says what it does, asks, and says what it did
 *
 * And the rulings and defects found on the way:
 *   ruled 16 Oct  a change of priority, an escalation's included, redoes the
 *                 deadlines from when the case was opened
 *   ruled 16 Oct  resolved cases close after 72 hours by themselves
 *   OPS-44        an escalation with no manager went to a Sales Supervisor in
 *                 either business
 *   OPS-45        the sweep closed and flagged cases in both businesses
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { orgsFor } from '../src/auth.js';
import { applySla } from '../src/engine/sla.js';
// Read, not imported by name, so the unfixed code reports each failure rather than stopping here.
const sla = await import('../src/engine/sla.js');
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...rel) => fs.readFileSync(path.join(HERE, '..', '..', ...rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nRound 4, QA-07: Part 4 items 1-4, OPS-44, OPS-45');

const RUN = Date.now().toString(36);
const MARK = `R4G probe ${RUN}`;
const call = async (who, method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...(who?.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const CARE = await probeAdmin('r4g-care', { role: 'customer_care', sales_org: 'BONANZA' });
const BIGUL_ADMIN = await probeAdmin('r4g-bigul', { role: 'admin', sales_org: 'BIGUL' });
const BIGUL_CARE = await probeAdmin('r4g-bigul-care', { role: 'customer_care', sales_org: 'BIGUL' });
const probes = [CARE, BIGUL_ADMIN, BIGUL_CARE];

const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const ago = (hours) => sql(new Date(Date.now() - hours * 3600_000));
const tickets = [];
const makeCase = (cols = {}) => {
  const id = Number(run(
    `INSERT INTO tickets (ref, subject, description, priority, status, assignee_id, sales_org, lead_id, created_at, resolved_at, breached)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [`R4G-${RUN}-${tickets.length}`, `${MARK} ${tickets.length}`, 'probe', cols.priority ?? 'Medium', cols.status ?? 'Open',
      cols.assignee ?? CARE.id, cols.org ?? 'BONANZA', cols.lead ?? null, cols.created ?? ago(1), cols.resolved ?? null, cols.breached ?? 0],
  ).lastInsertRowid);
  tickets.push(id);
  applySla(id);
  return one('SELECT * FROM tickets WHERE id = ?', [id]);
};
const row = (id) => one('SELECT * FROM tickets WHERE id = ?', [id]);
const lead = one("SELECT id, name FROM leads WHERE sales_org = 'BONANZA' AND mobile IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1");
const tickets_jsx = read('client', 'src', 'crm', 'Tickets.jsx');

try {
  await test('Item 1/3: opening Escalate, Mark resolved or a Manage save changes nothing', async () => {
    const t = makeCase({ lead: lead.id });
    const before = JSON.stringify(row(t.id));
    const replies = one('SELECT COUNT(*) n FROM ticket_replies WHERE ticket_id = ?', [t.id]).n;
    for (const url of [`/tickets/${t.id}/escalation`, `/tickets/${t.id}/resolution-check`,
      `/tickets/${t.id}/change-preview?status=Waiting%20on%20Client&priority=High&assignee_id=`]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(CARE, 'GET', url);
      assert.equal(r.status, 200, `${url} answered ${r.status}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(JSON.stringify(row(t.id)), before, 'the case changed');
    assert.equal(one('SELECT COUNT(*) n FROM ticket_replies WHERE ticket_id = ?', [t.id]).n, replies, 'a reply was written');
  });

  await test('Item 1: the escalation dialog names who it goes to, each level above, the deadlines, and what happens next', async () => {
    const t = makeCase({ priority: 'Medium' });
    const { status, body } = await call(CARE, 'GET', `/tickets/${t.id}/escalation`);
    assert.equal(status, 200);
    assert(body.to?.name, 'nobody named');
    assert.deepEqual(body.priority, { from: 'Medium', to: 'High' });
    assert(body.chain.length >= 2 && body.chain[0].current, 'no path');
    assert.equal(body.chain[1].who.id, body.to.id, 'level 2 is not who it goes to');
    assert.equal(body.chain[1].resolution_due, sla.deadlinesFor?.(row(t.id), 'High')?.resolution_due, 'level 2 deadline is not High\'s');
    assert(body.if_unresolved.some((l) => /marked breached/.test(l)), 'does not say what happens if unresolved');
    const done = await call(CARE, 'POST', `/tickets/${t.id}/escalate`, { reason: 'probe' });
    assert.equal(done.status, 200);
    assert.equal(row(t.id).assignee_id, body.to.id, 'the escalation went somewhere the dialog did not say');
    assert.equal(done.body.priority, 'High');
  });

  await test('OPS-44: with no manager, a case goes to a Sales Supervisor in its own business, or is refused', async () => {
    // BIGUL_CARE has no manager.
    const t = makeCase({ org: 'BIGUL', assignee: BIGUL_CARE.id });
    const preview = await call(BIGUL_ADMIN, 'GET', `/tickets/${t.id}/escalation`);
    const done = await call(BIGUL_ADMIN, 'POST', `/tickets/${t.id}/escalate`, { reason: 'probe' });
    const to = one('SELECT * FROM users WHERE id = ?', [row(t.id).assignee_id]);
    if (done.status === 200) {
      assert(orgsFor(to).includes('BIGUL'), `a Bigul case was escalated to ${to.name}, who works in ${orgsFor(to).join(', ')}`);
      assert.equal(preview.body?.to?.id, to.id, 'the dialog named somebody else');
    }

    /* And with nobody in the business to take it: refused, the case as it was. */
    const supervisors = all("SELECT * FROM users WHERE role = 'sales_supervisor' AND active = 1").filter((u) => orgsFor(u).includes('BIGUL'));
    const lone = makeCase({ org: 'BIGUL', assignee: BIGUL_CARE.id });
    try {
      for (const u of supervisors) run('UPDATE users SET active = 0 WHERE id = ?', [u.id]);
      const before = JSON.stringify(row(lone.id));
      const refused = await call(BIGUL_ADMIN, 'POST', `/tickets/${lone.id}/escalate`, { reason: 'probe' });
      assert.equal(refused.status, 400, `escalated to ${one('SELECT name, sales_org FROM users WHERE id = ?', [row(lone.id).assignee_id])?.sales_org}`);
      assert.match(refused.body.error, /no active Sales Supervisor/);
      assert.equal(JSON.stringify(row(lone.id)), before, 'the refused case changed');
      const asked = await call(BIGUL_ADMIN, 'GET', `/tickets/${lone.id}/escalation`);
      assert.match(asked.body?.refusal ?? '', /no active Sales Supervisor/, 'the dialog does not say why it cannot');
    } finally {
      for (const u of supervisors) run('UPDATE users SET active = 1 WHERE id = ?', [u.id]);
    }
  });

  await test('Ruled 16 Oct: a change of priority redoes the deadlines from when the case was opened', async () => {
    const t = makeCase({ priority: 'Low', created: ago(48) });
    assert(typeof sla.deadlinesFor === 'function', 'no deadlinesFor in engine/sla.js');
    const want = sla.deadlinesFor(row(t.id), 'Critical');
    const r = await call(CARE, 'PATCH', `/tickets/${t.id}`, { priority: 'Critical' });
    assert.equal(r.status, 200);
    const after = row(t.id);
    assert.equal(after.resolution_due, want.resolution_due, `resolution due stayed ${after.resolution_due}`);
    assert.notEqual(after.resolution_due, t.resolution_due, 'the deadline did not move');
    // Two days in, Critical's two business hours are long gone: breached at once.
    assert.equal(after.breached, 1, 'past its new deadline but not marked breached');
  });

  await test('Ruled 16 Oct: an escalation raises the priority and redoes the deadlines with it', async () => {
    const t = makeCase({ priority: 'Low', created: ago(1) });
    const want = sla.deadlinesFor?.(row(t.id), 'Medium')?.resolution_due;
    assert.equal((await call(CARE, 'POST', `/tickets/${t.id}/escalate`, { reason: 'probe' })).status, 200);
    assert.equal(row(t.id).priority, 'Medium');
    assert.equal(row(t.id).resolution_due, want, 'escalated, and still on Low\'s clock');
  });

  await test('Item 1: Mark resolved says what is outstanding and what resolving sets off', async () => {
    const t = makeCase({ lead: lead.id });
    run("INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal, created_at) VALUES (?, 'we are on it', 'agent', ?, 0, ?)", [t.id, CARE.id, ago(3)]);
    run("INSERT INTO ticket_replies (ticket_id, body, author_type, internal, created_at) VALUES (?, 'still not credited', 'client', 0, ?)", [t.id, ago(1)]);
    run("INSERT INTO tasks (title, ticket_id, assignee_id, created_by, due_at) VALUES (?,?,?,?,datetime('now','+1 day'))", [`${MARK} call back`, t.id, CARE.id, CARE.id]);
    const { status, body } = await call(CARE, 'GET', `/tickets/${t.id}/resolution-check`);
    assert.equal(status, 200);
    const said = body.checks.map((c) => c.text).join(' | ');
    assert.match(said, /last message.*has no reply after it/, said);
    assert.match(said, /1 open task/, said);
    assert(body.effects.some((e) => e.includes(lead.name) && /rate/.test(e)), 'does not say the client is asked for a rating');
    assert(body.effects.some((e) => /72 hours/.test(e)), 'does not say it closes by itself');
    assert.equal(body.summary.client_messages, 1);
    assert.equal(body.summary.replies, 1);
  });

  await test('Item 3: the Save dialog lists each change and what it does', async () => {
    const t = makeCase({ priority: 'Medium' });
    const { status, body } = await call(CARE, 'GET', `/tickets/${t.id}/change-preview?status=Waiting%20on%20Client&priority=High`);
    assert.equal(status, 200);
    assert.deepEqual(body.changes.map((c) => [c.field, c.from, c.to]), [['status', 'Open', 'Waiting on Client'], ['priority', 'Medium', 'High']]);
    const said = body.effects.map((e) => e.text).join(' | ');
    assert.match(said, /SLA clock pauses/);
    assert.match(said, /redone under High/);
  });

  await test('The dialogs keep to the reader\'s business and scope', async () => {
    const t = makeCase({});
    for (const url of [`/tickets/${t.id}/escalation`, `/tickets/${t.id}/resolution-check`, `/tickets/${t.id}/change-preview?priority=High`]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(BIGUL_ADMIN, 'GET', url);
      assert.equal(r.status, 403, `a Bigul Admin read ${url}`);
    }
  });

  await test('OPS-45: the sweep acts on the business being looked at, not the other one', async () => {
    const bigulResolved = makeCase({ org: 'BIGUL', assignee: BIGUL_CARE.id, status: 'Resolved', resolved: ago(96) });
    const bigulLate = makeCase({ org: 'BIGUL', assignee: BIGUL_CARE.id, created: ago(24 * 20), priority: 'Critical' });
    const ownResolved = makeCase({ status: 'Resolved', resolved: ago(96) });
    const r = await call(CARE, 'POST', '/tickets/sweep');
    assert.equal(r.status, 200);
    assert('checked' in r.body && 'breached' in r.body, 'the result lost its shape');
    assert(!(r.body.closed_refs ?? []).includes(bigulResolved.ref), 'a Bonanza press closed a Bigul case');
    assert(!(r.body.breached_refs ?? []).includes(bigulLate.ref), 'a Bonanza press flagged a Bigul case');
    /* The server's own minute may have reached them first; if so, it says so. */
    const closedBy = (id) => one("SELECT action FROM audit_log WHERE entity = 'ticket' AND entity_id = ? AND action = 'ticket_auto_closed'", [id]);
    if (row(bigulResolved.id).status === 'Closed') assert(closedBy(bigulResolved.id), 'the Bigul case was closed, and not by the 72-hour rule');
    assert.equal(row(ownResolved.id).status, 'Closed', 'its own 72-hour case is still open');
    assert(closedBy(ownResolved.id), 'the close is not in the audit');
    const history = one("SELECT old_value, new_value FROM field_history WHERE entity = 'case' AND record_id = ? AND field = 'status'", [ownResolved.id]);
    assert.deepEqual(history && [history.old_value, history.new_value], ['Resolved', 'Closed'], 'the close is not in the case history');
  });

  await test('Ruled 16 Oct: the 72-hour close runs by itself, with the breach check', async () => {
    const index = read('server', 'src', 'index.js');
    assert(/closeResolved\(\)/.test(index), 'the server never closes resolved cases by itself');
    const t = makeCase({ status: 'Resolved', resolved: ago(80) });
    assert(typeof sla.closeResolved === 'function', 'no closeResolved');
    sla.closeResolved();
    assert.equal(row(t.id).status, 'Closed');
  });

  await test('Item 4: the sweep preview says what a check would find, and changes nothing', async () => {
    const t = makeCase({ status: 'Resolved', resolved: ago(96) });
    const r = await call(CARE, 'GET', '/tickets/sweep/preview');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert(Number.isInteger(r.body.open) && Number.isInteger(r.body.past_due) && Number.isInteger(r.body.to_close));
    assert.deepEqual(r.body.businesses.length, 1);
    assert.equal(row(t.id).status, 'Resolved', 'the preview closed a case');
    assert.equal((await call(BIGUL_CARE, 'GET', '/tickets/sweep/preview')).status, 200);
  });

  await test('Items 1-4 on the page: nothing changes without a confirmation, 50 entries, the notes (source check)', async () => {
    const src = tickets_jsx;
    // Escalate and Mark resolved open a dialog; the writes live in the dialogs' confirm.
    assert(!/onClick=\{\(\) => act\(\(\) => api\.post\(`\/tickets\/\$\{id\}\/escalate`/.test(src), 'Escalate still writes on the click');
    assert(!/onClick=\{\(\) => act\(\(\) => api\.patch\(`\/tickets\/\$\{id\}`, \{ status: 'Resolved' \}\)\)\}/.test(src), 'Mark resolved still writes on the click');
    assert(!/<select[^>]*onChange=\{\(e\) => act\(\(\) => api\.patch/.test(src), 'a Manage field still saves on change');
    assert(/function EscalateCase/.test(src) && /function ResolveCase/.test(src) && /function ChangeCase/.test(src), 'a dialog is missing');
    assert(/const THREAD_LIMIT = 50;/.test(src) && /Show more/.test(src), 'no 50-entry limit with Show more');
    assert(/Internal notes are for your team's reference only\. They are not shared with the client or customer\./.test(src), 'no internal note explanation');
    assert(/Moving this ticket to “Waiting on Client” pauses the SLA clock\./.test(src), 'no Waiting on Client note');
    assert(/className="btn" onClick=\{\(\) => setChecking\(true\)\}/.test(src) && /Check SLAs now/.test(src), 'the sweep button is still bare text that runs on the click');
  });
} finally {
  for (const id of tickets) {
    run('DELETE FROM tasks WHERE ticket_id = ?', [id]);
    run('DELETE FROM ticket_replies WHERE ticket_id = ?', [id]);
    run('DELETE FROM field_history WHERE entity = ? AND record_id = ?', ['case', id]);
    run('DELETE FROM tickets WHERE id = ?', [id]);
  }
  run('DELETE FROM tickets WHERE subject LIKE ?', [`${MARK}%`]);
  for (const p of probes) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
