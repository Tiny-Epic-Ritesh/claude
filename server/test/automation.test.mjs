/**
 * The automation flow engine (P3-16).
 *
 * The rules engine beside this one is a filter: conditions, actions, done. This
 * is a process a lead is *inside* — so the things worth testing are not that an
 * action fires, but that a lead asleep in a Wait card wakes up on the right
 * step after a restart, that a flow which loops is stopped rather than left to
 * message a client forever, and that a lead already walking through an
 * automation is not walked through it a second time.
 *
 * That last one is the safeguard that matters most. Bonanza's busiest
 * LeadSquared automation has fired 14 million times and the second, on Activity
 * Added, 8.5 million. Re-entering on every activity means the same client gets
 * the same WhatsApp on a loop.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import {
  TRIGGERS, STEP_KINDS, isTrigger, enter, advance, tick, fire, report, whatRunsOn,
} from '../src/engine/automation.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nAutomation');

/* ------------------------------------------------------------- fixtures */

const clean = () => {
  run("DELETE FROM automation_run_step WHERE run_id IN (SELECT id FROM automation_run WHERE automation_id IN (SELECT id FROM automation WHERE name LIKE 'probe_auto%'))");
  run("DELETE FROM automation_run WHERE automation_id IN (SELECT id FROM automation WHERE name LIKE 'probe_auto%')");
  run("DELETE FROM automation_step WHERE automation_id IN (SELECT id FROM automation WHERE name LIKE 'probe_auto%')");
  run("DELETE FROM automation WHERE name LIKE 'probe_auto%'");
  run("DELETE FROM leads WHERE name LIKE 'Automation probe%'");
};
clean();

const LEAD = Number(run(
  `INSERT INTO leads (name, mobile, email, source, stage, sales_org)
   VALUES ('Automation probe lead', '9800000001', 'probe@automation.test', 'Referral', 'New', 'BONANZA')`,
).lastInsertRowid);

/** Build an automation and return { id, step } where step names the ids made. */
const build = (name, triggerType, steps, { status = 'active', org = 'BONANZA', conditions = null } = {}) => {
  const autoId = Number(run(
    `INSERT INTO automation (name, sales_org, trigger_type, entry_conditions, status)
     VALUES (?,?,?,?,?)`,
    [name, org, triggerType, conditions ? JSON.stringify(conditions) : null, status],
  ).lastInsertRowid);

  /* Two passes: create every step so the ids exist, then wire next/else. A flow
     is a graph and a graph cannot be built in one pass without forward
     references. */
  const ids = steps.map((s, i) => Number(run(
    'INSERT INTO automation_step (automation_id, kind, config, label, sort_order) VALUES (?,?,?,?,?)',
    [autoId, s.kind, JSON.stringify(s.config ?? {}), s.label ?? s.kind, i],
  ).lastInsertRowid));

  steps.forEach((s, i) => {
    const next = s.next === undefined ? (i + 1 < ids.length ? ids[i + 1] : null) : (s.next === null ? null : ids[s.next]);
    const els = s.else === undefined ? null : (s.else === null ? null : ids[s.else]);
    run('UPDATE automation_step SET next_step_id = ?, else_step_id = ? WHERE id = ?', [next, els, ids[i]]);
  });

  run('UPDATE automation SET first_step_id = ? WHERE id = ?', [ids[0], autoId]);
  return { id: autoId, ids };
};

/* risk_profile is the marker, because update_lead deliberately whitelists
   stage, score and risk_profile only -- an automation must not write a derived
   field like kyc_status, which would be overwritten on the next read. Using
   `source` here failed for exactly that reason, which is the whitelist working. */
const noteAction = (subject) => ({
  kind: 'action',
  config: { type: 'update_lead', params: { field: 'risk_profile', value: subject } },
});
const marker = () => one('SELECT risk_profile FROM leads WHERE id = ?', [LEAD]).risk_profile;

/* -------------------------------------------------------- the vocabulary */

test('the trigger list matches what the business actually uses', () => {
  /* Cross-checked against the LeadSquared audit: Lead Created, Lead Updated,
     Activity Added, At Regular Intervals, On WorkDay End and Sub Automation are
     all live in the tenant today. */
  for (const key of ['lead.created', 'lead.updated', 'activity.added', 'schedule.interval', 'user.workday_end', 'sub']) {
    assert(isTrigger(key), `${key} is not a trigger`);
  }
  assert(!isTrigger('nonsense'), 'an unknown trigger was accepted');
  assert(TRIGGERS.every((t) => t.family), 'a trigger has no family to group it under');
  assert(STEP_KINDS.some((k) => k.kind === 'exit'), 'there is no explicit exit card');
});

/* ------------------------------------------------------------ the walk */

test('a lead walks the whole flow in one pass', () => {
  /* Ten actions should not take ten ticks. Only a wait stops the walk. */
  const a = build('probe_auto_walk', 'lead.created', [
    noteAction('step-one'),
    noteAction('step-two'),
    { kind: 'exit', config: { reason: 'finished' } },
  ]);

  const r = enter(a.id, LEAD);
  assert(r, 'the lead did not enter');
  assert.equal(r.status, 'exited', `run ended as ${r.status}`);

  const steps = all('SELECT outcome FROM automation_run_step WHERE run_id = ? ORDER BY id', [r.id]);
  assert.deepEqual(steps.map((s) => s.outcome), ['entered', 'done', 'done', 'exited'], JSON.stringify(steps));
});

test('a branch takes the else path when the condition fails', () => {
  const a = build('probe_auto_branch', 'lead.created', [
    {
      kind: 'branch',
      config: { conditions: { type: 'group', op: 'AND', children: [{ field: 'lead_stage', operator: 'equals', value: 'Won' }] } },
      next: 1,
      else: 2,
    },
    noteAction('took-the-yes'),
    noteAction('took-the-no'),
  ]);

  const r = enter(a.id, LEAD);
  
  assert.equal(marker(), 'took-the-no', `the lead is New, not Won, so it should take else — marker is ${marker()}`);

  const branched = all("SELECT detail FROM automation_run_step WHERE run_id = ? AND outcome = 'branched'", [r.id]);
  assert.equal(branched.length, 1, 'the branch was not recorded');
});

/* -------------------------------------------------------------- waiting */

test('a wait parks the lead on the next step, not the wait itself', () => {
  /* The subtle one. If the run stays pointed at the wait card it re-waits every
     tick and never moves — an automation that looks alive and does nothing. */
  const a = build('probe_auto_wait', 'lead.created', [
    { kind: 'wait', config: { hours: 48 } },
    noteAction('after-the-wait'),
  ]);

  const r = enter(a.id, LEAD);
  assert.equal(r.status, 'waiting', `run is ${r.status}`);
  assert.equal(r.step_id, a.ids[1], 'the run is parked on the wait card rather than on what follows it');
  assert(r.resume_at, 'no wake-up time was set');
});

test('a wait that is not due yet is left alone', () => {
  const before = one("SELECT COUNT(*) n FROM automation_run WHERE status = 'waiting'").n;
  tick();
  const after = one("SELECT COUNT(*) n FROM automation_run WHERE status = 'waiting'").n;
  assert.equal(after, before, 'the tick woke a run that was not due');
});

test('a wait that has come due resumes and finishes', () => {
  /* Wound back rather than slept through, because a test that waits 48 hours is
     a test nobody runs. */
  const r = one("SELECT * FROM automation_run WHERE automation_id = (SELECT id FROM automation WHERE name = 'probe_auto_wait') ORDER BY id DESC LIMIT 1");
  run("UPDATE automation_run SET resume_at = datetime('now', '-1 minute') WHERE id = ?", [r.id]);

  const out = tick();
  assert(out.resumed >= 1, 'nothing resumed');

  const after = one('SELECT * FROM automation_run WHERE id = ?', [r.id]);
  assert.equal(after.status, 'done', `run ended as ${after.status}`);
  assert.equal(marker(), 'after-the-wait',
    'the step after the wait never ran');
});

test('the run survives a restart, because the position is in the database', () => {
  /* There is no in-memory timer to lose. A fresh read of the row is all a new
     process needs to carry on. */
  const a = build('probe_auto_restart', 'lead.created', [
    { kind: 'wait', config: { hours: 1 } },
    noteAction('resumed-after-restart'),
  ]);
  const r = enter(a.id, LEAD);

  const fromDisk = one('SELECT * FROM automation_run WHERE id = ?', [r.id]);
  assert.equal(fromDisk.status, 'waiting');
  assert(fromDisk.step_id, 'the row does not say where to carry on from');

  run("UPDATE automation_run SET resume_at = datetime('now', '-1 minute') WHERE id = ?", [r.id]);
  tick();
  assert.equal(one('SELECT status FROM automation_run WHERE id = ?', [r.id]).status, 'done');
});

/* ------------------------------------------------------- the safeguards */

test('a lead already inside an automation does not enter it again', () => {
  /* The safeguard that matters most: 8.5 million Activity Added triggers in the
     legacy tenant, and a client on the other end of every message. */
  const a = build('probe_auto_reentry', 'activity.added', [
    { kind: 'wait', config: { hours: 24 } },
    noteAction('should-run-once'),
  ]);

  assert(enter(a.id, LEAD), 'the first entry was refused');
  assert.equal(enter(a.id, LEAD), null, 'the lead entered a second time while still inside');
  assert.equal(enter(a.id, LEAD), null, 'and a third');

  const runs = all("SELECT id FROM automation_run WHERE automation_id = ? AND status IN ('running','waiting')", [a.id]);
  assert.equal(runs.length, 1, `${runs.length} live runs for one lead`);
});

test('a flow that loops is stopped rather than left running', () => {
  /* A branch whose exits point back above it sends a client WhatsApp messages
     until somebody notices. The budget is what notices. */
  const a = build('probe_auto_loop', 'lead.created', [
    noteAction('loop'),
  ]);
  run('UPDATE automation_step SET next_step_id = id WHERE automation_id = ?', [a.id]);

  const r = enter(a.id, LEAD);
  assert.equal(r.status, 'failed', `a looping flow ended as ${r.status}`);
  assert(/loop/i.test(r.detail ?? ''), `the reason does not name the loop: ${r.detail}`);
});

test('an automation does not fire on the other book', () => {
  const a = build('probe_auto_bigul', 'lead.created', [noteAction('should-not-happen')], { org: 'BIGUL' });
  assert.equal(enter(a.id, LEAD), null, 'a Bigul automation entered a Bonanza lead');
});

test('a draft automation does not run', () => {
  const a = build('probe_auto_draft', 'lead.created', [noteAction('draft')], { status: 'draft' });
  assert.equal(enter(a.id, LEAD), null, 'a draft automation ran');
});

test('a failing action does not stop the steps behind it', () => {
  /* One dead template must not abort the flow — the same reasoning the rules
     engine already applies. The failure is written down instead. */
  const a = build('probe_auto_failure', 'lead.created', [
    { kind: 'action', config: { type: 'nonsense_action', params: {} } },
    noteAction('ran-anyway'),
  ]);

  const r = enter(a.id, LEAD);
  assert.equal(marker(), 'ran-anyway',
    'a failing action stopped the flow');

  const failures = all("SELECT * FROM automation_run_step WHERE run_id = ? AND outcome = 'failed'", [r.id]);
  assert.equal(failures.length, 1, 'the failure was not recorded against the step');
});

/* ---------------------------------------------------------- the trigger */

test('firing a trigger enters every active automation watching it, in priority order', () => {
  const first = build('probe_auto_prio_a', 'lead.stage_changed', [noteAction('first')]);
  const second = build('probe_auto_prio_b', 'lead.stage_changed', [noteAction('second')]);
  run('UPDATE automation SET priority = 10 WHERE id = ?', [first.id]);
  run('UPDATE automation SET priority = 20 WHERE id = ?', [second.id]);

  const out = fire('lead.stage_changed', { leadId: LEAD });
  assert.equal(out.entered, 2, `${out.entered} automations entered`);

  /* Ordering is stated, not emergent: the lower priority ran first, so the
     later one left its mark. */
  assert.equal(marker(), 'second');
});

test('a field-watching trigger ignores changes to fields it does not watch', () => {
  /* "Lead Updated" firing on any change is how the legacy tenant reached 8.5
     million executions. */
  const a = build('probe_auto_fields', 'lead.updated', [noteAction('watched')]);
  run(`UPDATE automation SET trigger_config = '{"fields":["stage"]}' WHERE id = ?`, [a.id]);

  assert.equal(fire('lead.updated', { leadId: LEAD, fields: ['city'] }).entered, 0,
    'an automation watching stage fired on a city change');
  assert.equal(fire('lead.updated', { leadId: LEAD, fields: ['stage'] }).entered, 1,
    'an automation watching stage did not fire on a stage change');
});

/* -------------------------------------------------------------- reports */

test('the report says which step leads are standing on', () => {
  /* "1,000 entered and 40 finished" is only useful with the other 960 located. */
  const a = build('probe_auto_report', 'lead.created', [
    { kind: 'wait', config: { hours: 72 } },
    noteAction('later'),
  ]);
  enter(a.id, LEAD);

  const rep = report(a.id);
  assert.equal(rep.entered, 1);
  assert.equal(rep.waiting, 1, `waiting is ${rep.waiting}`);
  assert(rep.waiting_at.length, 'the report does not say where they are waiting');
  assert(rep.waiting_at[0].n === 1, JSON.stringify(rep.waiting_at));
});

test('what runs on a trigger is answerable in one call', () => {
  /* The Salesforce reference names the absence of this as the reason nobody can
     see what touches a field in the legacy tenant. */
  const rows = whatRunsOn('lead.stage_changed');
  assert(rows.length >= 2, `only ${rows.length} automations listed`);
  assert(rows[0].priority <= rows[1].priority, 'not returned in the order they would run');
});

clean();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
