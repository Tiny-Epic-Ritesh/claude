/**
 * A20 (B26, ruled 20 Nov 2026): a Caller or Dealer hands a qualified lead to
 * a Sales RM.
 *
 * There was no way to do it (found in A5, at BRD gate P1). The Dealer's home
 * offered "Hand to Sales RM" and the Caller's "Flag for Sales RM"; both opened
 * the lead list and stopped there. And the Caller's "Leads qualified" counted
 * their leads standing at Qualified, a stage they could not set.
 *
 * Ruled: "Hand to a Sales RM" on a lead they own. They choose a Sales RM in
 * the lead's business, or let the routing rules choose -- the same rules,
 * Sales RMs only, in the team's own order on a rotation of its own, else the
 * least-loaded Sales RM there. They write what the Sales RM needs to know. It
 * moves at once, at Qualified at least (a Won or Lost lead is not handed
 * over), with no approval, and their supervisor is told. Their open tasks on
 * the lead go with it. The Sales RM gets a notice and a High-priority task.
 * The Caller's "Leads qualified" counts the hand-overs they made.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import { all, one, run } from '../src/db.js';
import { scheduleReminders } from '../src/engine/followups.js';
import { leastLoadedForRole } from '../src/engine/assignment.js';
import { probeAdmin } from './helpers/probeadmin.mjs';

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
const MARK = `Handover ${stamp}`;
const probes = [];
const probe = async (slug, role, extra = {}) => {
  const p = await probeAdmin(`ho-${slug}`, { role, sales_org: extra.sales_org ?? 'BONANZA' });
  const sets = Object.keys(extra).filter((k) => k !== 'sales_org');
  if (sets.length) run(`UPDATE users SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...sets.map((k) => extra[k]), p.id]);
  probes.push(p);
  return p;
};
const leads = [];
let n = 0;
const leadOf = (owner, cols = {}) => {
  n += 1;
  const id = Number(run(
    "INSERT INTO leads (sales_org, name, mobile, source, stage, owner_id) VALUES (?, ?, ?, ?, ?, ?)",
    [cols.sales_org ?? 'BONANZA', `${MARK} lead ${n}`, `93${stamp}${n}`.slice(0, 10), cols.source ?? 'Referral', cols.stage ?? 'Contacted', owner.id],
  ).lastInsertRowid);
  leads.push(id);
  return id;
};
const lead = (id) => one('SELECT * FROM leads WHERE id = ?', [id]);
const note = (who) => `${MARK}: wants a SIP of 5,000 a month; free after 6 pm (${who})`;
const at = (modifier) => one("SELECT datetime('now', ?) t", [modifier]).t;
const made = [];

console.log('\nA20: a Caller or Dealer hands a lead to a Sales RM (B26)');

try {
  const SUP = await probe('sup', 'sales_supervisor');
  const CALLER = await probe('caller', 'caller', { manager_id: SUP.id });
  const DEALER = await probe('dealer', 'dealer');
  const RM1 = await probe('rm1', 'sales_rm');
  const RM2 = await probe('rm2', 'sales_rm');
  const RM3 = await probe('rm3', 'sales_rm');
  const QUIET_RM = await probe('rm-quiet', 'sales_rm', { active: 0 });
  const CALLER2 = await probe('caller2', 'caller');
  const BIGUL_RM = await probe('rm-bigul', 'sales_rm', { sales_org: 'BIGUL' });
  const handOver = (who, id, body) => as(who)('POST', `/leads/${id}/handover`, body);
  const qualified = async (who) => {
    const m = ((await as(who)('GET', '/kra')).body?.metrics ?? []).find((x) => x.source === 'leads_qualified');
    assert.ok(Number.isInteger(m?.actual), `no Leads qualified figure: ${JSON.stringify(m)}`);
    return m.actual;
  };

  /* ------------------------------------------------- the hand-over */
  const first = leadOf(CALLER);
  const mine = Number(run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status, priority) VALUES (?,?,?,?,?, 'Open', 'Normal')",
    [`${MARK} callback`, first, CALLER.id, CALLER.id, at('+1 days')]).lastInsertRowid);
  scheduleReminders({ taskId: mine, leadId: first, userId: CALLER.id, dueAt: at('+1 days'), detail: `${MARK} callback` });
  const done = Number(run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status) VALUES (?,?,?,?,?, 'Done')",
    [`${MARK} done`, first, CALLER.id, CALLER.id, at('-1 days')]).lastInsertRowid);
  const theirs = Number(run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status) VALUES (?,?,?,?,?, 'Open')",
    [`${MARK} someone else's`, first, RM3.id, RM3.id, at('+2 days')]).lastInsertRowid);
  const elsewhere = Number(run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status) VALUES (?,?,?,?,?, 'Open')",
    [`${MARK} another lead`, leadOf(CALLER), CALLER.id, CALLER.id, at('+1 days')]).lastInsertRowid);
  const countedBefore = await qualified(CALLER);
  let handed = null;

  await test('a Caller hands their own lead to a Sales RM they choose: it is theirs at once, at Qualified', async () => {
    const res = await handOver(CALLER, first, { to_user_id: RM1.id, needs_to_know: note('chosen') });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    handed = res.body;
    const l = lead(first);
    assert.equal(l.owner_id, RM1.id, 'the lead did not move');
    assert.equal(l.stage, 'Qualified', `the lead is at ${l.stage}`);
    const h = one('SELECT * FROM lead_handovers WHERE lead_id = ?', [first]);
    assert.ok(h && h.from_user_id === CALLER.id && h.to_user_id === RM1.id && h.how === 'chosen', `the hand-over record: ${JSON.stringify(h)}`);
    assert.equal(h.needs_to_know, note('chosen'));
  });

  await test('...in the lead\'s history, by the Caller; the stage change on the timeline, the owner change not', async () => {
    const changed = (field) => one("SELECT * FROM field_history WHERE entity = 'lead' AND record_id = ? AND field = ? ORDER BY id DESC LIMIT 1", [first, field]);
    assert.equal(Number(changed('owner_id')?.new_value), RM1.id, 'no owner change in the history');
    assert.equal(changed('owner_id').actor_id, CALLER.id, 'the owner change is not the Caller\'s');
    assert.equal(changed('stage')?.new_value, 'Qualified', 'no stage change in the history');
    assert.ok(one("SELECT id FROM activities WHERE lead_id = ? AND subject = 'Stage changed' AND body = 'Contacted → Qualified'", [first]),
      'the stage change is not on the timeline');
    assert.ok(one("SELECT id FROM audit_log WHERE action = 'lead_handed_over' AND entity_id = ?", [first]), 'not audited');
  });

  await test('the Sales RM gets a notice and a High-priority task, due in 4 hours, with the note in it', async () => {
    assert.ok(one('SELECT id FROM notifications WHERE user_id = ? AND link = ? AND title LIKE ?', [RM1.id, `/leads/${first}`, 'Lead handed to you%']),
      'the Sales RM was not told');
    const task = one("SELECT * FROM tasks WHERE lead_id = ? AND assignee_id = ? AND title LIKE 'Hand-over:%'", [first, RM1.id]);
    assert.ok(task, 'no task for the Sales RM');
    assert.equal(task.priority, 'High');
    const hours = (new Date(`${task.due_at.replace(' ', 'T')}Z`) - Date.now()) / 3_600_000;
    assert.ok(hours > 3.9 && hours <= 4.01, `due in ${hours.toFixed(2)} hours`);
    assert.match(task.description, /What you need to know: Handover .*wants a SIP of 5,000 a month/);
  });

  await test('the Caller\'s supervisor is told', async () => {
    assert.ok(one('SELECT id FROM notifications WHERE user_id = ? AND link = ? AND title LIKE ?', [SUP.id, `/leads/${first}`, 'Lead handed over%']),
      'the supervisor was not told');
    assert.ok(handed.effects.some((e) => /was told, as your supervisor/.test(e)), `the Caller is not told so: ${handed.effects}`);
  });

  await test('their open tasks on the lead go with it, reminders and all -- and nothing else moves', async () => {
    assert.equal(one('SELECT assignee_id FROM tasks WHERE id = ?', [mine]).assignee_id, RM1.id, 'their open callback stayed with them');
    assert.equal(one('SELECT assignee_id FROM tasks WHERE id = ?', [done]).assignee_id, CALLER.id, 'a finished task moved');
    assert.equal(one('SELECT assignee_id FROM tasks WHERE id = ?', [theirs]).assignee_id, RM3.id, 'somebody else\'s task moved');
    assert.equal(one('SELECT assignee_id FROM tasks WHERE id = ?', [elsewhere]).assignee_id, CALLER.id, 'a task on another lead moved');
    const pending = all("SELECT user_id FROM reminders WHERE task_id = ? AND status = 'Pending'", [mine]);
    assert.ok(pending.length && pending.every((r) => r.user_id === RM1.id), `reminders still go to the Caller: ${JSON.stringify(pending)}`);
    /* A task's assignee is not a tracked field in Setup, so the record of the
       move is the hand-over's own and the audit's. */
    assert.equal(one('SELECT tasks_moved FROM lead_handovers WHERE lead_id = ?', [first]).tasks_moved, 1);
    const audited = JSON.parse(one("SELECT detail FROM audit_log WHERE action = 'lead_handed_over' AND entity_id = ?", [first]).detail);
    assert.deepEqual(audited.tasks_moved, [mine], `the audit does not name the task that moved: ${JSON.stringify(audited)}`);
    assert.ok(handed.effects.some((e) => e.includes(`${MARK} callback`)), 'the Caller is not told the task went too');
  });

  await test('it leaves the Caller\'s list, and counts on their scorecard', async () => {
    const opened = await as(CALLER)('GET', `/leads/${first}`);
    assert.ok([403, 404].includes(opened.status), `the Caller still opens it: HTTP ${opened.status}`);
    assert.equal(await qualified(CALLER), countedBefore + 1, '"Leads qualified" does not count the hand-over');
  });

  await test('...and keeps counting it once the Sales RM moves the lead on', async () => {
    run("UPDATE leads SET stage = 'In Progress' WHERE id = ?", [first]);
    assert.equal(await qualified(CALLER), countedBefore + 1, 'the hand-over stopped counting when the stage moved on');
  });

  /* -------------------------------------------------------- refused */
  await test('only the owner, only with a note, only to an active Sales RM in the lead\'s business', async () => {
    const someoneElses = leadOf(CALLER2);
    const still = leadOf(CALLER);
    const cases = [
      [CALLER, someoneElses, { to_user_id: RM1.id, needs_to_know: note('x') }, 403, 'another Caller\'s lead'],
      [CALLER, still, { to_user_id: RM1.id, needs_to_know: '   ' }, 400, 'no note'],
      [CALLER, still, { needs_to_know: note('x') }, 400, 'nobody chosen'],
      [CALLER, still, { to_user_id: CALLER2.id, needs_to_know: note('x') }, 400, 'a Caller, not a Sales RM'],
      [CALLER, still, { to_user_id: BIGUL_RM.id, needs_to_know: note('x') }, 400, 'a Sales RM in the other business'],
      [CALLER, still, { to_user_id: QUIET_RM.id, needs_to_know: note('x') }, 400, 'an inactive Sales RM'],
    ];
    for (const [who, id, body, want, why] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const res = await handOver(who, id, body);
      assert.equal(res.status, want, `${why}: HTTP ${res.status} ${res.body?.error}`);
    }
    assert.equal(lead(still).owner_id, CALLER.id, 'a refused hand-over moved the lead');
    assert.equal(lead(someoneElses).owner_id, CALLER2.id);
    assert.equal(one('SELECT COUNT(*) n FROM lead_handovers WHERE lead_id IN (?, ?)', [still, someoneElses]).n, 0, 'a refusal was recorded as a hand-over');
  });

  await test('a Sales RM cannot use it; a Dealer can', async () => {
    const rmLead = leadOf(RM1);
    const res = await handOver(RM1, rmLead, { to_user_id: RM2.id, needs_to_know: note('rm') });
    assert.equal(res.status, 403);
    assert.equal(res.body?.required, 'lead.handover');
    const dealt = leadOf(DEALER);
    const ok = await handOver(DEALER, dealt, { to_user_id: RM2.id, needs_to_know: note('dealer') });
    assert.equal(ok.status, 200, `the Dealer was refused: ${ok.body?.error}`);
    assert.equal(lead(dealt).owner_id, RM2.id);
  });

  await test('a lead further on keeps its stage; a Won or Lost lead is not handed over', async () => {
    const further = leadOf(CALLER, { stage: 'In Progress' });
    assert.equal((await handOver(CALLER, further, { to_user_id: RM1.id, needs_to_know: note('further') })).status, 200);
    assert.equal(lead(further).stage, 'In Progress', 'a lead further on was moved back');
    for (const stage of ['Won', 'Lost']) {
      const settled = leadOf(CALLER, { stage });
      // eslint-disable-next-line no-await-in-loop
      const res = await handOver(CALLER, settled, { to_user_id: RM1.id, needs_to_know: note(stage) });
      assert.equal(res.status, 409, `${stage}: HTTP ${res.status}`);
      assert.match(res.body.error, /a settled lead is not handed over/);
      assert.equal(lead(settled).owner_id, CALLER.id);
    }
  });

  /* ------------------------------------------------- routing chooses */
  const team = Number(run("INSERT INTO teams (name, strategy, sales_org, rr_cursor) VALUES (?, 'round_robin', 'BONANZA', 0)", [`${MARK} desk`]).lastInsertRowid);
  made.push(['teams', team]);
  // A Caller first in the rota, as on the Digital Desk.
  [[CALLER2, 0], [RM2, 1], [RM3, 2]].forEach(([p, i]) => run('INSERT INTO team_members (team_id, user_id, sort_order) VALUES (?,?,?)', [team, p.id, i]));
  const source = `${MARK} source`;
  const rule = Number(run(
    "INSERT INTO assignment_rules (name, conditions, strategy, team_id, priority, sales_org) VALUES (?, ?, 'team', ?, -1000, 'BONANZA')",
    [`${MARK} rule`, JSON.stringify({ op: 'AND', children: [{ field: 'source', operator: 'eq', value: source }] }), team],
  ).lastInsertRowid);
  made.push(['assignment_rules', rule]);

  await test('the routing rules choose from the matched team\'s Sales RMs, never its Callers, in turn', async () => {
    const a = leadOf(CALLER, { source });
    const b = leadOf(CALLER, { source });
    const preview = await as(CALLER)('GET', `/leads/${a}/handover`);
    assert.equal(preview.status, 200, `the preview answered ${preview.status}: ${preview.body?.error}`);
    assert.equal(preview.body.routed?.id, RM2.id, `the preview would choose ${JSON.stringify(preview.body.routed)}`);
    assert.match(preview.body.routed.said, new RegExp(`by the rule "${MARK} rule"`));
    const one1 = await handOver(CALLER, a, { auto: true, needs_to_know: note('routed 1') });
    const one2 = await handOver(CALLER, b, { auto: true, needs_to_know: note('routed 2') });
    assert.equal(one1.status, 200, `HTTP ${one1.status}: ${one1.body?.error}`);
    assert.deepEqual([lead(a).owner_id, lead(b).owner_id], [RM2.id, RM3.id], 'not the team\'s Sales RMs in turn');
    assert.equal(one('SELECT routed_by FROM lead_handovers WHERE lead_id = ?', [a]).routed_by, `${MARK} rule`);
  });

  await test('asking first moves no rotation, and hand-overs do not move the one new leads are dealt from', async () => {
    const c = leadOf(CALLER, { source });
    const cursors = () => ({ ...one('SELECT * FROM teams WHERE id = ?', [team]) });
    const before = cursors();
    await as(CALLER)('GET', `/leads/${c}/handover`);
    await as(CALLER)('GET', `/leads/${c}/handover`);
    assert.deepEqual(cursors(), before, 'the preview moved a rotation');
    assert.equal(before.rr_cursor, 0, 'a hand-over moved the rota new leads are dealt from');
    assert.equal(one('SELECT fire_count FROM assignment_rules WHERE id = ?', [rule]).fire_count, 0, 'a hand-over counted as the rule routing a new lead');
  });

  await test('a matched team with no Sales RM is passed over; with none anywhere, the least-loaded Sales RM in the business', async () => {
    const callersOnly = Number(run("INSERT INTO teams (name, strategy, sales_org) VALUES (?, 'round_robin', 'BONANZA')", [`${MARK} callers`]).lastInsertRowid);
    made.push(['teams', callersOnly]);
    run('INSERT INTO team_members (team_id, user_id) VALUES (?,?)', [callersOnly, CALLER2.id]);
    run('UPDATE assignment_rules SET team_id = ? WHERE id = ?', [callersOnly, rule]);
    // Passed over: the next rule that matches, with a Sales RM on its team, decides.
    const passed = (await as(CALLER)('GET', `/leads/${leadOf(CALLER, { source })}/handover`)).body?.routed;
    assert.ok(passed && passed.id !== CALLER2.id, `the Caller-only team's Caller was chosen: ${JSON.stringify(passed)}`);
    assert.ok(!passed.said.includes(`${MARK} rule`), `the Caller-only team decided: ${passed.said}`);
    assert.equal(one('SELECT role FROM users WHERE id = ?', [passed.id]).role, 'sales_rm');
    const enabled = all("SELECT id FROM assignment_rules WHERE sales_org = 'BONANZA' AND enabled = 1 AND id != ?", [rule]).map((r) => r.id);
    try {
      run(`UPDATE assignment_rules SET enabled = 0 WHERE id IN (${enabled.map(() => '?').join(',') || '0'})`, enabled);
      const d = leadOf(CALLER, { source });
      const least = leastLoadedForRole('sales_rm', 'BONANZA');
      const res = await handOver(CALLER, d, { auto: true, needs_to_know: note('fallback') });
      assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
      assert.equal(lead(d).owner_id, least, 'not the least-loaded Sales RM');
      assert.ok(res.body.effects.some((e) => /No routing rule's team has a Sales RM in Bonanza/.test(e)), `says: ${res.body.effects}`);
      assert.notEqual(lead(d).owner_id, CALLER2.id, 'handed to a Caller');
    } finally {
      run(`UPDATE assignment_rules SET enabled = 1 WHERE id IN (${enabled.map(() => '?').join(',') || '0'})`, enabled);
    }
  });

  /* --------------------------------------------- credit and the homes */
  await test('a Caller with reports counts their team\'s hand-overs too (B21)', async () => {
    const LEAD_CALLER = await probe('caller-lead', 'caller');
    const JUNIOR = await probe('caller-junior', 'caller', { manager_id: LEAD_CALLER.id });
    const before = await qualified(LEAD_CALLER);
    const res = await handOver(JUNIOR, leadOf(JUNIOR), { to_user_id: RM1.id, needs_to_know: note('junior') });
    assert.equal(res.status, 200, `HTTP ${res.status}: ${res.body?.error}`);
    assert.equal(await qualified(LEAD_CALLER), before + 1, 'the team lead does not count their report\'s hand-over');
  });

  await test('the Caller\'s and the Dealer\'s home shortcut is the hand-over', async () => {
    for (const who of [CALLER, DEALER]) {
      // eslint-disable-next-line no-await-in-loop
      const home = (await as(who)('GET', '/cockpit')).body;
      const shortcut = (home?.actions ?? []).find((x) => x.label === 'Hand to Sales RM');
      assert.ok(shortcut, `${who === CALLER ? 'the Caller' : 'the Dealer'} has no Hand to Sales RM: ${(home?.actions ?? []).map((x) => x.label)}`);
      assert.match(shortcut.hint, /Actions → Hand to a Sales RM/);
    }
    const rmHome = (await as(RM1)('GET', '/cockpit')).body;
    assert.ok(!(rmHome?.actions ?? []).some((x) => x.label === 'Hand to Sales RM'), 'a Sales RM is offered the hand-over');
  });
} finally {
  for (const id of leads) {
    run('DELETE FROM notifications WHERE link = ?', [`/leads/${id}`]);
    for (const t of all('SELECT id FROM tasks WHERE lead_id = ?', [id])) run("DELETE FROM field_history WHERE entity = 'task' AND record_id = ?", [t.id]);
    run("DELETE FROM field_history WHERE entity = 'lead' AND record_id = ?", [id]);
    run("DELETE FROM audit_log WHERE entity = 'lead' AND entity_id = ?", [id]);
    run('DELETE FROM leads WHERE id = ?', [id]);
  }
  for (const [table, id] of [...made].reverse()) run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  if (probes.length) run(`UPDATE users SET manager_id = NULL WHERE id IN (${probes.map(() => '?').join(',')})`, probes.map((p) => p.id));
  for (const p of [...probes].reverse()) p.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
