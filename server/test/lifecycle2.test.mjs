/**
 * QA-37, batch 2: what records the work -- tasks, cases, and the notes,
 * activities and case replies that make up their history.
 *
 *   Task         title, due date and assignee change; cancelled with a
 *                reason, never deleted; by the assignee, the creator or a
 *                supervisor.
 *   Case         details change while it is open; resolve, close, reopen --
 *                and reopening says why; never deleted.
 *   Notes, activities, case replies
 *                no edit after saving; the author corrects with an entry
 *                linked to it, and the original is shown as corrected.
 *
 * A correction is its own row. Written as another activity, a corrected call
 * would be a second call to every count, and new activities are what
 * automation listens for -- so the activity count is part of the test.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { one, run } from '../src/db.js';
import { hashPasswordSync } from '../src/security.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
const source = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-37 lifecycle: tasks, cases and corrections');

const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-6);
const MARK = `LC2 probe ${RUN}`;

const RM = await probeAdmin('lc2-rm', { role: 'sales_rm', sales_org: 'BONANZA' });
const OTHER = await probeAdmin('lc2-other', { role: 'sales_rm', sales_org: 'BONANZA' });
const ADMIN = await probeAdmin('lc2-admin', { role: 'admin', sales_org: 'BONANZA' });
const BIGUL = await probeAdmin('lc2-bigul', { role: 'admin', sales_org: 'BIGUL' });
const as = (who) => async (method, url, body) => {
  const res = await fetch(`${BASE}/api${url}`, { method, headers: who.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const lead = Number(run(
  "INSERT INTO leads (sales_org, name, source, stage, owner_id, mobile) VALUES ('BONANZA', ?, 'Website', 'New', ?, ?)",
  [`${MARK} lead`, RM.id, `9${DIGITS}101`],
).lastInsertRowid);
const PASSWORD = `lc2-own-${RUN}`;
const partner = Number(run(
  `INSERT INTO partners (sales_org, partner_code, name, partner_model, state_code, email, portal_password,
                         portal_password_temp, portal_password_set_at, onboarded_at)
   VALUES ('BONANZA', ?, ?, 'Associate', 'ACTIVE', ?, ?, 0, datetime('now'), datetime('now'))`,
  [`BNZ-L2${DIGITS.slice(-3)}`, `${MARK} partner`, `lc2-${RUN}@partner.test`, hashPasswordSync(PASSWORD)],
).lastInsertRowid);

const tasks = [];
const makeTask = (extra = {}) => {
  const id = Number(run(
    `INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status)
     VALUES (?, ?, ?, ?, datetime('now', '+2 days'), 'Open')`,
    [`${MARK} task`, extra.lead === undefined ? lead : extra.lead, extra.assignee ?? ADMIN.id, extra.creator ?? RM.id],
  ).lastInsertRowid);
  tasks.push(id);
  return id;
};
const tickets = [];
const makeTicket = (status = 'Open') => {
  const id = Number(run(
    `INSERT INTO tickets (ref, subject, description, priority, status, lead_id, partner_id, assignee_id, sales_org)
     VALUES (?, ?, 'The client asked where the refund is', 'Medium', ?, ?, ?, ?, 'BONANZA')`,
    [`LC2-${RUN}-${tickets.length}`, `${MARK} case`, status, lead, partner, RM.id],
  ).lastInsertRowid);
  tickets.push(id);
  return id;
};
const ticketRow = (id) => one('SELECT * FROM tickets WHERE id = ?', [id]);
const activityCount = () => one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [lead]).n;

try {
  /* ------------------------------------------------------------- tasks */

  await test('the creator changes a task\'s title and due date; somebody unrelated cannot', async () => {
    const t = makeTask();
    const res = await as(RM)('PATCH', `/tasks/${t}`, { title: `${MARK} renamed`, due_at: '2030-01-02 10:00' });
    assert.equal(res.status, 200, `the creator was refused: HTTP ${res.status} ${res.body?.error}`);
    assert.equal(one('SELECT title FROM tasks WHERE id = ?', [t]).title, `${MARK} renamed`);
    assert.equal((await as(RM)('PATCH', `/tasks/${t}`, { title: '  ' })).status, 400, 'a task was given an empty title');
    /* A task with no lead, so the book lets the colleague reach it and only
       the assignee-or-creator rule stands in the way. */
    const standalone = makeTask({ lead: null });
    assert.equal((await as(OTHER)('PATCH', `/tasks/${standalone}`, { title: 'not mine' })).status, 403, 'a colleague changed a task that is not theirs');
    assert.equal((await as(OTHER)('POST', `/tasks/${standalone}/cancel`, { reason: 'Not my task at all' })).status, 403);
    assert.equal((await as(RM)('PATCH', `/tasks/${standalone}`, { title: `${MARK} mine` })).status, 200, 'the creator of a standalone task was refused');
  });

  await test('a task is cancelled with a reason, its reminders stop, and then it stays as it is', async () => {
    const t = makeTask();
    run("INSERT INTO reminders (task_id, lead_id, user_id, channel, due_at, detail) VALUES (?, ?, ?, 'bell', datetime('now', '+1 day'), 'probe')",
      [t, lead, ADMIN.id]);
    assert.equal((await as(RM)('PATCH', `/tasks/${t}`, { status: 'Cancelled' })).status, 400, 'cancelled without a reason');
    assert.equal((await as(RM)('POST', `/tasks/${t}/cancel`, { reason: 'no' })).status, 400, 'a two-letter reason was accepted');

    const res = await as(RM)('POST', `/tasks/${t}/cancel`, { reason: 'Client already sent the documents' });
    assert.equal(res.status, 200, `cancel answered ${res.status}: ${res.body?.error}`);
    const row = one('SELECT * FROM tasks WHERE id = ?', [t]);
    assert.equal(row.status, 'Cancelled');
    assert.equal(row.cancel_reason, 'Client already sent the documents');
    assert(row.cancelled_at, 'no cancelled time');
    assert.equal(one("SELECT COUNT(*) n FROM reminders WHERE task_id = ? AND status = 'Pending'", [t]).n, 0, 'a reminder is still pending');
    assert(one("SELECT id FROM audit_log WHERE action = 'task_cancelled' AND entity_id = ?", [t]), 'the cancel was not audited');

    assert.equal((await as(RM)('PATCH', `/tasks/${t}`, { status: 'Open' })).status, 409, 'a cancelled task was reopened');
    assert.equal((await as(RM)('POST', `/tasks/${t}/cancel`, { reason: 'Cancelled twice' })).status, 409);
    assert.equal((await as(ADMIN)('DELETE', `/tasks/${t}`)).status, 404, 'there is a way to delete a task');
    assert(one('SELECT id FROM tasks WHERE id = ?', [t]), 'the task went');
  });

  /* ------------------------------------------------------------- cases */

  await test('a resolved or closed case keeps its details; it closes, but is not set back to Resolved', async () => {
    const c = makeTicket('Resolved');
    for (const patch of [{ priority: 'High' }, { assignee_id: ADMIN.id }]) {
      const res = await as(ADMIN)('PATCH', `/tickets/${c}`, patch);
      assert.equal(res.status, 409, `a resolved case changed ${Object.keys(patch)[0]}: HTTP ${res.status}`);
      assert.equal(res.body.reopen_first, true);
    }
    assert.equal((await as(ADMIN)('POST', `/tickets/${c}/escalate`, { reason: 'probe' })).status, 409, 'a resolved case was escalated');
    assert.equal((await as(ADMIN)('PATCH', `/tickets/${c}`, { status: 'Closed' })).status, 200, 'a resolved case could not close');
    assert.equal((await as(ADMIN)('PATCH', `/tickets/${c}`, { status: 'Resolved' })).status, 409, 'a closed case went back to Resolved');
    assert.equal(ticketRow(c).priority, 'Medium');
  });

  await test('reopening says why, clears the finished times, and is written on the case', async () => {
    const c = makeTicket('Open');
    assert.equal((await as(ADMIN)('PATCH', `/tickets/${c}`, { status: 'Resolved' })).status, 200);
    assert.equal((await as(ADMIN)('PATCH', `/tickets/${c}`, { status: 'Closed' })).status, 200);
    assert(ticketRow(c).closed_at && ticketRow(c).resolved_at);

    assert.equal((await as(ADMIN)('PATCH', `/tickets/${c}`, { status: 'Open' })).status, 400, 'reopened without a reason');
    const res = await as(ADMIN)('PATCH', `/tickets/${c}`, { status: 'Open', reason: 'Refund has not arrived' });
    assert.equal(res.status, 200, `reopen answered ${res.status}: ${res.body?.error}`);
    const row = ticketRow(c);
    assert.equal(row.status, 'Open');
    assert.equal(row.resolved_at, null);
    assert.equal(row.closed_at, null);
    const note = one("SELECT * FROM ticket_replies WHERE ticket_id = ? AND internal = 1 AND body LIKE 'Reopened by %'", [c]);
    assert(note && /Refund has not arrived/.test(note.body), 'the reason is not on the case');
    assert(one("SELECT id FROM audit_log WHERE action = 'ticket_reopened' AND entity_id = ?", [c]));
    assert.equal((await as(ADMIN)('PATCH', `/tickets/${c}`, { priority: 'High' })).status, 200, 'a reopened case is still frozen');
  });

  /* ------------------------------------------------------- corrections */

  await test('nothing in the history can be edited after saving', async () => {
    const note = Number(run('INSERT INTO notes (lead_id, body, user_id) VALUES (?, ?, ?)', [lead, `${MARK} note`, RM.id]).lastInsertRowid);
    assert.equal((await as(RM)('PATCH', `/notes/${note}`, { body: 'rewritten' })).status, 404);
    assert.equal((await as(RM)('DELETE', `/notes/${note}`)).status, 404);
    const act = Number(run("INSERT INTO activities (lead_id, type, body, user_id) VALUES (?, 'Call', 'Spoke', ?)", [lead, RM.id]).lastInsertRowid);
    assert.equal((await as(RM)('PATCH', `/activities/${act}`, { body: 'rewritten' })).status, 404);
  });

  await test('the author corrects a note: the original stays, marked, with the correction under it', async () => {
    const note = Number(run('INSERT INTO notes (lead_id, body, user_id) VALUES (?, ?, ?)', [lead, 'Client wants a call on Monday', RM.id]).lastInsertRowid);
    assert.equal((await as(RM)('POST', `/notes/${note}/correct`, { body: 'Tuesday', reason: '' })).status, 400, 'corrected with no reason');
    assert([403, 404].includes((await as(OTHER)('POST', `/notes/${note}/correct`, { body: 'x', reason: 'not the author' })).status),
      'a colleague corrected somebody else\'s note');
    assert.equal((await as(ADMIN)('POST', `/notes/${note}/correct`, { body: 'x', reason: 'not the author' })).status, 403,
      'somebody other than the author corrected it');

    const res = await as(RM)('POST', `/notes/${note}/correct`, { body: 'Client wants a call on Tuesday', reason: 'Wrong day' });
    assert.equal(res.status, 201, `correct answered ${res.status}: ${res.body?.error}`);
    assert.equal(one('SELECT body FROM notes WHERE id = ?', [note]).body, 'Client wants a call on Monday', 'the original was edited');

    const detail = await as(RM)('GET', `/leads/${lead}`);
    const shown = detail.body.notes.find((n) => n.id === note);
    assert.equal(shown.corrections.length, 1);
    assert.equal(shown.corrections[0].body, 'Client wants a call on Tuesday');
    assert.equal(shown.corrections[0].reason, 'Wrong day');
    const audit = one("SELECT detail FROM audit_log WHERE action = 'note_corrected' AND entity_id = ? ORDER BY id DESC LIMIT 1", [note]);
    assert(audit && !audit.detail.includes('Tuesday'), 'the audit carries the text of the correction');
  });

  await test('correcting a call adds no activity, and the timeline shows it as corrected', async () => {
    const act = Number(run(
      "INSERT INTO activities (lead_id, type, direction, body, outcome, user_id) VALUES (?, 'Call', 'outbound', 'Client agreed to SIP of 5000', 'Connected', ?)",
      [lead, RM.id],
    ).lastInsertRowid);
    const before = activityCount();
    const res = await as(RM)('POST', `/activities/${act}/correct`, { body: 'Client agreed to SIP of 2000', reason: 'Wrong amount' });
    assert.equal(res.status, 201, `correct answered ${res.status}: ${res.body?.error}`);
    assert.equal(activityCount(), before, 'a correction was written as another activity, so every count sees a second call');

    const timeline = await as(RM)('GET', `/activities/lead/${lead}`);
    const shown = timeline.body.find((a) => a.id === act);
    assert.equal(shown.body, 'Client agreed to SIP of 5000', 'the original was edited');
    assert.equal(shown.corrections[0].body, 'Client agreed to SIP of 2000');

    const system = Number(run("INSERT INTO activities (lead_id, type, direction, body) VALUES (?, 'KYC Event', 'system', 'probe')", [lead]).lastInsertRowid);
    const refused = await as(RM)('POST', `/activities/${system}/correct`, { body: 'x', reason: 'system entry' });
    assert.equal(refused.status, 409, `a system entry was corrected: HTTP ${refused.status}`);
    assert.equal((await as(BIGUL)('POST', `/activities/${act}/correct`, { body: 'x', reason: 'other book' })).status, 404);
  });

  await test('where a reader cannot see the call notes, they cannot see the correction either', async () => {
    const act = Number(run("INSERT INTO activities (lead_id, type, body, user_id) VALUES (?, 'Call', 'Private detail', ?)", [lead, RM.id]).lastInsertRowid);
    assert.equal((await as(RM)('POST', `/activities/${act}/correct`, { body: 'Corrected private detail', reason: 'Typo in detail' })).status, 201);
    const timeline = await as(ADMIN)('GET', `/activities/lead/${lead}`);
    const shown = timeline.body.find((a) => a.id === act);
    assert(shown, 'the admin cannot see the activity at all');
    /* Call notes are the author's and their managers'; this admin is neither. */
    assert(shown._restricted?.includes('body'), `precondition: the admin reads the call notes (${JSON.stringify(shown._restricted)})`);
    assert.equal(shown.corrections[0].body, null, 'the correction leaked notes the reader may not see');
    assert.equal(shown.corrections[0].reason, null);

    /* And the author still reads both. */
    const own = (await as(RM)('GET', `/activities/lead/${lead}`)).body.find((a) => a.id === act);
    assert.equal(own.corrections[0].body, 'Corrected private detail');
  });

  await test('an agent corrects their own reply; the partner sees the correction, not the reason or the name', async () => {
    const c = makeTicket('Open');
    const reply = Number(run(
      "INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?, 'Your refund leaves on the 5th', 'agent', ?, 0)",
      [c, RM.id],
    ).lastInsertRowid);
    const client = Number(run("INSERT INTO ticket_replies (ticket_id, body, author_type, internal) VALUES (?, 'Thanks', 'partner', 0)", [c]).lastInsertRowid);

    assert.equal((await as(RM)('POST', `/tickets/${c}/replies/${client}/correct`, { body: 'x', reason: 'not ours' })).status, 409,
      'the partner\'s own words were corrected by staff');
    const res = await as(RM)('POST', `/tickets/${c}/replies/${reply}/correct`, { body: 'Your refund leaves on the 7th', reason: 'Wrong date' });
    assert.equal(res.status, 201, `correct answered ${res.status}: ${res.body?.error}`);

    const detail = await as(RM)('GET', `/tickets/${c}`);
    assert.equal(detail.body.replies.find((r) => r.id === reply).corrections[0].body, 'Your refund leaves on the 7th');

    const login = await (await fetch(`${BASE}/api/auth/partner-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `lc2-${RUN}@partner.test`, password: PASSWORD }),
    })).json();
    const portal = await (await fetch(`${BASE}/api/portal/tickets/${c}`, { headers: { Authorization: `Bearer ${login.token}` } })).json();
    const seen = portal.replies.find((r) => r.body === 'Your refund leaves on the 5th');
    assert(seen, 'the partner cannot see the original reply');
    assert.deepEqual(Object.keys(seen.corrections[0]).sort(), ['body', 'created_at'], 'the partner sees more than the correction');
    assert.equal(seen.corrections[0].body, 'Your refund leaves on the 7th');
  });

  await test('erasing a lead erases its corrections with it', async () => {
    const gone = Number(run("INSERT INTO leads (sales_org, name, source, stage, owner_id) VALUES ('BONANZA', ?, 'Website', 'New', ?)",
      [`${MARK} erased`, RM.id]).lastInsertRowid);
    const note = Number(run('INSERT INTO notes (lead_id, body, user_id) VALUES (?, ?, ?)', [gone, 'PAN ABCDE1234F', RM.id]).lastInsertRowid);
    run("INSERT INTO corrections (note_id, body, reason, user_id) VALUES (?, 'PAN ABCDE1234G', 'typo', ?)", [note, RM.id]);
    run('DELETE FROM leads WHERE id = ?', [gone]);
    assert.equal(one('SELECT COUNT(*) n FROM corrections WHERE note_id = ?', [note]).n, 0, 'a correction outlived the lead it was about');
  });

  await test('the screens offer it: Correct, Reopen, and Cancel with a reason (source check)', async () => {
    const corrections = source('components/Corrections.jsx');
    assert(/\/correct|path/.test(corrections) && /reason/.test(corrections));
    for (const screen of ['crm/LeadDetail.jsx', 'crm/Tickets.jsx', 'crm/PartnerProfile.jsx']) {
      assert(/CorrectButton/.test(source(screen)), `${screen} offers no Correct`);
    }
    assert(/status: 'Open', reason/.test(source('crm/Tickets.jsx')), 'the case screen cannot reopen with a reason');
    assert(/\/cancel`/.test(source('crm/Tasks.jsx')), 'the Tasks screen cannot cancel');
  });
} finally {
  for (const id of tickets) {
    run('DELETE FROM ticket_replies WHERE ticket_id = ?', [id]);
    run('DELETE FROM tickets WHERE id = ?', [id]);
  }
  for (const id of tasks) {
    run('DELETE FROM reminders WHERE task_id = ?', [id]);
    run('DELETE FROM tasks WHERE id = ?', [id]);
  }
  run('DELETE FROM notes WHERE lead_id = ?', [lead]);
  run('DELETE FROM activities WHERE lead_id = ?', [lead]);
  run('DELETE FROM leads WHERE id = ?', [lead]);
  run("DELETE FROM leads WHERE name LIKE ?", [`${MARK}%`]);
  run('DELETE FROM sessions WHERE partner_id = ?', [partner]);
  run('DELETE FROM activities WHERE partner_id = ?', [partner]);
  run('DELETE FROM partners WHERE id = ?', [partner]);
  for (const p of [RM, OTHER, ADMIN, BIGUL]) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
