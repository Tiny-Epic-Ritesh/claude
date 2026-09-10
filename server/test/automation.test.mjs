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
import { runAction, ACTION_TYPES, leadFacts } from '../src/engine/rules.js';
import { conditionSchema, evaluate as evaluateTree, valueOf } from '../src/engine/conditions.js';
import { probeAdmin } from './helpers/probeadmin.mjs';
import {
  TRIGGERS, STEP_KINDS, isTrigger, enter, advance, tick, fire, report, whatRunsOn, validate, detect,
} from '../src/engine/automation.js';

const BASE = process.env.TEST_BASE || 'http://localhost:4100';
const PROBE = await probeAdmin('automation');

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROBE.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
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
  /* Watermarks too. A run that left one pointing past the rows the next run
     creates would see nothing new and the detection tests would pass without
     detecting anything. */
  run('DELETE FROM automation_watermark');
  run("DELETE FROM lead_lists WHERE name LIKE 'probe_auto%'");
  run("DELETE FROM webhook_endpoint WHERE name LIKE 'probe_auto%'");
  /* Notifications too. Counting them is how the nudge test proves it
     de-duplicates, and rows left by the last run make that count a lie. */
  run("DELETE FROM notifications WHERE body LIKE 'probe_auto%'");
  run("DELETE FROM activities WHERE subject LIKE 'probe_auto%'");
  run("DELETE FROM tasks WHERE title LIKE 'probe_auto%'");
  run("DELETE FROM attendance_session WHERE note LIKE 'probe_auto%'");
  run("DELETE FROM automation WHERE name LIKE 'probe_rule%'");
  run("DELETE FROM rules WHERE name LIKE 'probe_rule%'");
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

await test('the trigger list matches what the business actually uses', () => {
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

await test('a lead walks the whole flow in one pass', () => {
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

await test('a branch takes the else path when the condition fails', () => {
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

await test('a wait parks the lead on the next step, not the wait itself', () => {
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

await test('a wait that is not due yet is left alone', () => {
  const before = one("SELECT COUNT(*) n FROM automation_run WHERE status = 'waiting'").n;
  tick();
  const after = one("SELECT COUNT(*) n FROM automation_run WHERE status = 'waiting'").n;
  assert.equal(after, before, 'the tick woke a run that was not due');
});

await test('a wait that has come due resumes and finishes', () => {
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

await test('the run survives a restart, because the position is in the database', () => {
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

await test('a lead already inside an automation does not enter it again', () => {
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

await test('a flow that loops is stopped rather than left running', () => {
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

await test('an automation does not fire on the other book', () => {
  const a = build('probe_auto_bigul', 'lead.created', [noteAction('should-not-happen')], { org: 'BIGUL' });
  assert.equal(enter(a.id, LEAD), null, 'a Bigul automation entered a Bonanza lead');
});

await test('a draft automation does not run', () => {
  const a = build('probe_auto_draft', 'lead.created', [noteAction('draft')], { status: 'draft' });
  assert.equal(enter(a.id, LEAD), null, 'a draft automation ran');
});

await test('a failing action does not stop the steps behind it', () => {
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

await test('firing a trigger enters every active automation watching it, in priority order', () => {
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

await test('a field-watching trigger ignores changes to fields it does not watch', () => {
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

await test('the report says which step leads are standing on', () => {
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

await test('what runs on a trigger is answerable in one call', () => {
  /* The Salesforce reference names the absence of this as the reason nobody can
     see what touches a field in the legacy tenant. */
  const rows = whatRunsOn('lead.stage_changed');
  assert(rows.length >= 2, `only ${rows.length} automations listed`);
  assert(rows[0].priority <= rows[1].priority, 'not returned in the order they would run');
});

/* ------------------------------------------------------- validation */

await test('a flow with a card wired to nothing is not ready to run', () => {
  /* The failure mode this exists for: a dangling exit ends the flow there,
     silently, for every lead that reaches it. It looks fine on a canvas. */
  const a = build('probe_auto_dangling', 'lead.created', [
    { kind: 'action', config: { type: 'update_lead', params: { field: 'risk_profile', value: 'x' } }, next: null },
  ]);

  const problems = validate(a.id);
  assert(problems.some((p) => /nothing follows/i.test(p.message)),
    `a dangling exit was accepted: ${JSON.stringify(problems)}`);
});

await test('a lead-updated trigger that names no fields is refused', () => {
  /* Watching every field is how the legacy tenant reached 8.5 million
     executions on one automation. */
  const a = build('probe_auto_nofields', 'lead.updated', [
    { kind: 'exit', config: {} },
  ]);
  const problems = validate(a.id);
  assert(problems.some((p) => /name the fields/i.test(p.message)),
    `a field-less lead.updated trigger was accepted: ${JSON.stringify(problems)}`);
});

await test('every problem comes back, not the first', () => {
  const a = build('probe_auto_many', 'lead.updated', [
    { kind: 'action', config: {}, next: null },
    { kind: 'wait', config: { hours: 0 }, next: null },
  ]);
  assert(validate(a.id).length >= 3, JSON.stringify(validate(a.id)));
});

/* ----------------------------------------------------------- the routes */

let made = null;

await test('an automation is created as a draft, in the creator\'s own book', async () => {
  const res = await call('POST', '/admin/automations', {
    name: 'probe_auto_route', trigger_type: 'lead.created',
  });
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.status, 'draft', `created as ${res.body.status}`);
  assert(res.body.sales_org, 'created with no book');
  made = res.body.id;
});

await test('a trigger nobody recognises is refused', async () => {
  const res = await call('POST', '/admin/automations', { name: 'probe_auto_bad', trigger_type: 'nonsense' });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
});

await test('an unfinished automation cannot be activated', async () => {
  /* It has no steps at all. Going live would mean leads entering a flow with
     nothing in it. */
  const res = await call('POST', `/admin/automations/${made}/activate`);
  assert.equal(res.status, 400, `HTTP ${res.status}`);
  assert(res.body.problems?.length, 'the refusal does not say what is wrong');
});

await test('a step is added, wired, and the automation then activates', async () => {
  const step = await call('POST', `/admin/automations/${made}/steps`, {
    kind: 'exit', config: { reason: 'done' }, label: 'End',
  });
  assert.equal(step.status, 201, JSON.stringify(step.body));

  const ok = await call('POST', `/admin/automations/${made}/activate`);
  assert.equal(ok.status, 200, `activate failed: ${JSON.stringify(ok.body)}`);
  assert.equal(ok.body.status, 'active');
});

await test('pausing stops new arrivals and says who is still inside', async () => {
  const res = await call('POST', `/admin/automations/${made}/pause`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'paused');
});

await test('a step cannot be made to follow itself', async () => {
  const step = one('SELECT id FROM automation_step WHERE automation_id = ? LIMIT 1', [made]);
  const res = await call('PATCH', `/admin/automations/${made}/steps/${step.id}`, { next_step_id: step.id });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
});

await test('deleting a step closes the gap behind it', async () => {
  /* Otherwise its neighbours point at nothing and the flow ends there for
     every lead that arrives afterwards. */
  const a = build('probe_auto_gap', 'lead.created', [
    noteAction('one'), noteAction('two'), { kind: 'exit', config: {} },
  ]);
  const res = await call('DELETE', `/admin/automations/${a.id}/steps/${a.ids[1]}`);
  assert.equal(res.status, 200, `HTTP ${res.status}`);

  const first = one('SELECT next_step_id FROM automation_step WHERE id = ?', [a.ids[0]]);
  assert.equal(first.next_step_id, a.ids[2], 'the gap was not closed');
});

await test('an automation with leads inside it cannot be deleted', async () => {
  /* Deleting it strands them mid-flow: the rows cascade away and nothing ever
     finishes what it started. */
  const a = build('probe_auto_busy', 'lead.created', [
    { kind: 'wait', config: { hours: 24 } }, noteAction('later'),
  ]);
  enter(a.id, LEAD);

  const res = await call('DELETE', `/admin/automations/${a.id}`);
  assert.equal(res.status, 409, `HTTP ${res.status}`);
  assert(res.body.live >= 1, 'the refusal does not say how many are inside');
});

await test('the spec the builder reads is the vocabulary the engine runs', async () => {
  const res = await call('GET', '/admin/automations/spec');
  assert.equal(res.status, 200);
  assert.equal(res.body.triggers.length, TRIGGERS.length, 'the trigger lists disagree');
  assert.equal(res.body.step_kinds.length, STEP_KINDS.length, 'the step lists disagree');
  assert(res.body.actions.length, 'no actions offered');

  /* Every action must be in a category. The ticket asks for actions "organised
     into categories", and the screen groups by this. */
  const loose = res.body.actions.filter((a) => !a.category).map((a) => a.type);
  assert.deepEqual(loose, [], `actions with no category: ${loose.join(', ')}`);
});

await test('the spec offers something to choose for every id-shaped parameter', async () => {
  /* Without these the builder shows a text box and asks somebody to type a
     template id. P3-17's acceptance clause is that templates are selectable
     from automation actions. */
  const { body } = await call('GET', '/admin/automations/spec');
  assert(body.pickers, 'no pickers at all');
  for (const key of ['templates', 'lists', 'endpoints', 'automations']) {
    assert(Array.isArray(body.pickers[key]), `${key} is not a list`);
  }

  const idParams = new Set();
  for (const a of body.actions) for (const p of a.params ?? []) if (p.endsWith('_id')) idParams.add(p);
  const covered = { template_id: 'templates', list_id: 'lists', endpoint_id: 'endpoints', automation_id: 'automations' };
  for (const p of idParams) assert(covered[p], `${p} has nothing to pick from`);
});

await test("the pickers do not offer the other book's things", async () => {
  const listId = Number(run(
    "INSERT INTO lead_lists (name, kind, sales_org, snapshot_reason) VALUES ('probe_auto_bigul_pick', 'static', 'BIGUL', 'test')",
  ).lastInsertRowid);
  const epId = Number(run(
    "INSERT INTO webhook_endpoint (name, url, sales_org) VALUES ('probe_auto_bigul_hook', 'https://example.invalid/b', 'BIGUL')",
  ).lastInsertRowid);
  const bigul = build('probe_auto_bigul_pick_auto', 'lead.created', [{ kind: 'exit', config: {} }], { org: 'BIGUL' });

  const { body } = await call('GET', '/admin/automations/spec');
  assert(!body.pickers.lists.some((l) => l.id === listId), "a Bigul list was offered to a Bonanza admin");
  assert(!body.pickers.endpoints.some((e) => e.id === epId), 'a Bigul webhook endpoint was offered');
  assert(!body.pickers.automations.some((a) => a.id === bigul.id), 'a Bigul automation was offered as a sub-automation');
});

await test('only static lists are offered, because only they have membership to write', () => {
  /* A refreshable or dynamic list is a live query. Offering one would offer a
     card that refuses at run time. */
  run("INSERT INTO lead_lists (name, kind, sales_org, criteria) VALUES ('probe_auto_dyn_pick', 'dynamic', 'BONANZA', '{}')");
  return call('GET', '/admin/automations/spec').then(({ body }) => {
    const offered = body.pickers.lists.map((l) => l.name);
    assert(!offered.includes('probe_auto_dyn_pick'), 'a dynamic list was offered as somewhere to add a lead');
  });
});

await test("another book's automation is out of reach", async () => {
  const bigul = build('probe_auto_otherbook', 'lead.created', [{ kind: 'exit', config: {} }], { org: 'BIGUL' });
  const res = await call('GET', `/admin/automations/${bigul.id}`);
  assert.equal(res.status, 403, `HTTP ${res.status}`);

  const list = await call('GET', '/admin/automations');
  assert(!list.body.some((x) => x.id === bigul.id), 'a Bigul automation was listed to a Bonanza admin');
});

await test('the explorer says what runs on a trigger, in order', async () => {
  const res = await call('GET', '/admin/automations/explorer/lead.stage_changed');
  assert.equal(res.status, 200);
  assert(Array.isArray(res.body), 'not a list');
});

/* ------------------------------------------------------------ detection */

await test('a fresh watermark starts at now, not at the beginning of time', () => {
  /* The single worst thing this file could do: start at zero, treat all
     495,118 existing leads as new, and enter every one of them into every
     automation — at three in the morning, on a timer. */
  run('DELETE FROM automation_watermark');

  const a = build('probe_auto_watermark', 'lead.created', [noteAction('swept')]);
  const before = one("SELECT COUNT(*) n FROM automation_run WHERE automation_id = ?", [a.id]).n;

  detect();

  const after = one("SELECT COUNT(*) n FROM automation_run WHERE automation_id = ?", [a.id]).n;
  assert.equal(after, before, `the first scan entered ${after - before} existing leads`);

  const mark = one("SELECT last_id FROM automation_watermark WHERE trigger_type = 'lead.created'");
  assert(mark && mark.last_id > 0, 'no watermark was set');
});

await test('a lead created afterwards is detected, whoever created it', () => {
  /* Written straight into the table, the way the importer and the Meta webhook
     do — no route, no fire() call. The scanner is what makes those paths work
     without each of them knowing the automation engine exists. */
  const a = build('probe_auto_detect', 'lead.created', [noteAction('detected')]);
  detect();   // set the watermark at now

  const fresh = Number(run(
    `INSERT INTO leads (name, mobile, source, stage, sales_org)
     VALUES ('Automation probe detected', '9800000002', 'Referral', 'New', 'BONANZA')`,
  ).lastInsertRowid);

  const out = detect();
  assert(out['lead.created'] >= 1, `nothing was detected: ${JSON.stringify(out)}`);

  const r = one('SELECT * FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, fresh]);
  assert(r, 'the new lead did not enter the automation');
});

await test('the same lead is not detected twice', () => {
  /* The watermark only moves forward. Without that every tick would re-enter
     everything it had already seen. */
  const out = detect();
  assert(!out['lead.created'], `a second scan re-entered ${out['lead.created']} leads`);
});

await test('a field change is detected from field_history, with the field named', () => {
  /* field_history already records every change with its old and new value,
     whoever made it and by whatever route — so the scanner reads that rather
     than computing a diff of its own. */
  const a = build('probe_auto_fieldchange', 'lead.updated', [noteAction('field-changed')]);
  run(`UPDATE automation SET trigger_config = '{"fields":["stage"]}' WHERE id = ?`, [a.id]);
  detect();

  run(
    `INSERT INTO field_history (entity, record_id, field, old_value, new_value, source)
     VALUES ('lead', ?, 'stage', 'New', 'Contacted', 'ui')`,
    [LEAD],
  );

  detect();
  assert(one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, LEAD]),
    'a stage change recorded in field_history did not reach the automation');
});

await test('a change to a field the automation does not watch is ignored', () => {
  const a = build('probe_auto_unwatched', 'lead.updated', [noteAction('should-not-fire')]);
  run(`UPDATE automation SET trigger_config = '{"fields":["pan"]}' WHERE id = ?`, [a.id]);
  detect();

  run(
    `INSERT INTO field_history (entity, record_id, field, old_value, new_value, source)
     VALUES ('lead', ?, 'city', 'Mumbai', 'Pune', 'ui')`,
    [LEAD],
  );

  detect();
  assert(!one('SELECT id FROM automation_run WHERE automation_id = ?', [a.id]),
    'an automation watching pan fired on a city change');
});

await test('the tick detects and resumes in one pass', () => {
  /* A lead that enters on this tick and has nothing to wait for should finish
     on this tick, not the next one. */
  const out = tick();
  assert(typeof out.resumed === 'number', 'the tick does not report what it resumed');
  assert(out.fired !== undefined, 'the tick does not report what it detected');
});

/* ------------------------------------------------------------- the canvas */

await test('where a card sits is remembered', async () => {
  /* Two people looking at one automation have to see the same picture, or
     "the card on the left" means nothing in a conversation. */
  const a = build('probe_auto_layout', 'lead.created', [noteAction('one'), noteAction('two')]);

  const res = await call('PATCH', `/admin/automations/${a.id}/layout`, {
    positions: [{ id: a.ids[0], x: 120, y: 40 }, { id: a.ids[1], x: 420, y: 200 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.saved, 2);

  const back = await call('GET', `/admin/automations/${a.id}`);
  const first = back.body.steps.find((x) => x.id === a.ids[0]);
  assert.equal(first.pos_x, 120);
  assert.equal(first.pos_y, 40);
});

await test('a card with no position is left null, so the builder lays it out', () => {
  /* Null is not zero. A flow built before the canvas existed must not have
     every card stacked at the origin — it is laid out from the graph instead,
     and null is how the builder knows to. */
  const a = build('probe_auto_unplaced', 'lead.created', [noteAction('one')]);
  const step = one('SELECT pos_x, pos_y FROM automation_step WHERE id = ?', [a.ids[0]]);
  assert.equal(step.pos_x, null);
  assert.equal(step.pos_y, null);
});

await test("a layout save ignores cards that are not this automation's", async () => {
  /* The client sends what it has drawn. A card deleted in another tab should
     cost somebody a card, not the rest of their layout. */
  const a = build('probe_auto_layout_mine', 'lead.created', [noteAction('one')]);
  const other = build('probe_auto_layout_theirs', 'lead.created', [noteAction('one')]);

  const res = await call('PATCH', `/admin/automations/${a.id}/layout`, {
    positions: [{ id: a.ids[0], x: 10, y: 10 }, { id: other.ids[0], x: 999, y: 999 }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.saved, 1, 'it saved a step belonging to another automation');
  assert.equal(one('SELECT pos_x FROM automation_step WHERE id = ?', [other.ids[0]]).pos_x, null);
});

await test('a card dragged out of an exit is made and wired in one go', async () => {
  /* Dropping on empty canvas. Without this the gesture takes three steps — add
     a card, open it, choose what precedes it — which is the list again with a
     drawing on top. */
  const a = build('probe_auto_dropwire', 'lead.created', [{ kind: 'branch', config: {}, next: null, else: null }]);

  const res = await call('POST', `/admin/automations/${a.id}/steps`, {
    kind: 'action', config: {}, from: a.ids[0], exit: 'else', pos_x: 500, pos_y: 300,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.pos_x, 500);

  const branch = one('SELECT next_step_id, else_step_id FROM automation_step WHERE id = ?', [a.ids[0]]);
  assert.equal(branch.else_step_id, res.body.id, 'the else exit was not wired to the new card');
  assert.equal(branch.next_step_id, null, 'wiring the else exit also moved the next one');
});

await test('dragging the start connector onto a card makes it first', async () => {
  const a = build('probe_auto_setfirst', 'lead.created', [noteAction('one'), noteAction('two')]);
  const res = await call('PATCH', `/admin/automations/${a.id}`, { first_step_id: a.ids[1] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(one('SELECT first_step_id FROM automation WHERE id = ?', [a.id]).first_step_id, a.ids[1]);
});

await test("the start connector cannot be pointed at another automation's card", async () => {
  /* A drag can land anywhere, which is what makes this reachable by ordinary
     use. Unchecked, advance() fails on the first lead with "step 412 no longer
     exists" and nothing on the screen says why. */
  const a = build('probe_auto_first_mine', 'lead.created', [noteAction('one')]);
  const other = build('probe_auto_first_theirs', 'lead.created', [noteAction('one')]);

  const res = await call('PATCH', `/admin/automations/${a.id}`, { first_step_id: other.ids[0] });
  assert.equal(res.status, 400, `HTTP ${res.status}`);
  assert.equal(one('SELECT first_step_id FROM automation WHERE id = ?', [a.id]).first_step_id, a.ids[0]);
});

await test('a card made from the start connector becomes the first step', async () => {
  const a = build('probe_auto_startdrop', 'lead.created', [noteAction('one')]);
  run('UPDATE automation SET first_step_id = NULL WHERE id = ?', [a.id]);

  const res = await call('POST', `/admin/automations/${a.id}/steps`, {
    kind: 'action', config: {}, from: 'flow-start',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(one('SELECT first_step_id FROM automation WHERE id = ?', [a.id]).first_step_id, res.body.id);
});

await test('a layout with nothing in it is refused rather than silently doing nothing', async () => {
  const a = build('probe_auto_layout_empty', 'lead.created', [noteAction('one')]);
  const res = await call('PATCH', `/admin/automations/${a.id}/layout`, {});
  assert.equal(res.status, 400, `HTTP ${res.status}`);
});

await test("another book's layout is out of reach", async () => {
  const bigul = build('probe_auto_layout_bigul', 'lead.created', [noteAction('one')], { org: 'BIGUL' });
  const res = await call('PATCH', `/admin/automations/${bigul.id}/layout`, {
    positions: [{ id: bigul.ids[0], x: 1, y: 1 }],
  });
  assert.equal(res.status, 403, `HTTP ${res.status}`);
});

/* --------------------------------------------------- migrating the rules */

const makeRule = (name, conditions, actions) => Number(run(
  'INSERT INTO rules (name, description, conditions, actions, enabled, priority) VALUES (?,?,?,?,1,100)',
  [name, 'converted by a test', JSON.stringify(conditions), JSON.stringify(actions)],
).lastInsertRowid);

await test('a rule whose conditions all translate becomes a flow', async () => {
  const id = makeRule(
    'probe_rule_clean',
    [{ field: 'lead_stage', op: 'eq', value: 'New' }, { field: 'days_since_contact', op: 'gt', value: 30, join: 'AND' }],
    [{ type: 'notify', params: { role_or_user: 'admin', message: 'chase them' } }],
  );

  const preview = await call('GET', `/admin/automations/migration/${id}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.convertible, true, preview.body.warnings?.join(' | '));
  /* lead_stage is the rules engine's name for it; the builder and toSql call
     it stage, and the flow has to carry the second. */
  assert.equal(preview.body.conditions.children[0].field, 'stage');
  assert.equal(preview.body.conditions.children[1].field, 'days_since_contact');

  const made = await call('POST', `/admin/automations/migration/${id}`, { sales_org: 'BONANZA', every_hours: 12 });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const auto = one('SELECT * FROM automation WHERE id = ?', [made.body.automation_id]);
  assert.equal(auto.status, 'draft', 'a converted rule went live on its own');
  assert.equal(auto.trigger_type, 'schedule.interval');
  assert.equal(JSON.parse(auto.trigger_config).every_hours, 12);
  assert.equal(one('SELECT COUNT(*) n FROM automation_step WHERE automation_id = ?', [auto.id]).n, 1);

  run('DELETE FROM automation_step WHERE automation_id = ?', [auto.id]);
  run('DELETE FROM automation WHERE id = ?', [auto.id]);
  run('DELETE FROM rules WHERE id = ?', [id]);
});

await test('the rule it came from is left running, and left alone', async () => {
  /* Disabling it belongs to whoever checks the flow and decides it is right --
     a different act, on a different day, by somebody who has looked at it. */
  const id = makeRule(
    'probe_rule_untouched',
    [{ field: 'lead_stage', op: 'eq', value: 'New' }],
    [{ type: 'notify', params: { role_or_user: 'admin', message: 'x' } }],
  );
  const made = await call('POST', `/admin/automations/migration/${id}`, { sales_org: 'BONANZA' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(one('SELECT enabled FROM rules WHERE id = ?', [id]).enabled, 1, 'the converter disabled the rule');

  run('DELETE FROM automation_step WHERE automation_id = ?', [made.body.automation_id]);
  run('DELETE FROM automation WHERE id = ?', [made.body.automation_id]);
  run('DELETE FROM rules WHERE id = ?', [id]);
});

await test('a rule that would lose a condition is refused, not quietly widened', async () => {
  /* The failure this converter exists to prevent. An AND group with no children
     is true for everybody, so a rule that messaged a handful becomes a flow that
     messages the whole book -- and nothing on the screen would say so. */
  const id = makeRule(
    'probe_rule_lossy',
    [{ field: 'kyc_journey_status', op: 'eq', value: 'Stalled' }],
    [{ type: 'whatsapp', params: { message: 'finish your application' } }],
  );

  const preview = await call('GET', `/admin/automations/migration/${id}`);
  assert.equal(preview.body.convertible, false, 'a rule that lost its only condition was offered as convertible');
  assert(preview.body.warnings.some((w) => w.includes('kyc_journey_status')), preview.body.warnings.join(' | '));
  assert(preview.body.warnings.some((w) => w.includes('every lead in the book')), preview.body.warnings.join(' | '));
  assert(preview.body.book_note?.includes('one book'), 'the book note is not carried apart from the warnings');

  const made = await call('POST', `/admin/automations/migration/${id}`, { sales_org: 'BONANZA' });
  assert.equal(made.status, 400, 'it converted anyway');
  assert(!one("SELECT id FROM automation WHERE name LIKE 'probe_rule_lossy%'"), 'a flow was written despite the refusal');

  run('DELETE FROM rules WHERE id = ?', [id]);
});

await test('a condition on one product card is reported rather than half-converted', async () => {
  const id = makeRule(
    'probe_rule_card',
    [{ field: 'product_card_state', product_code: 'MF', op: 'eq', value: 'WARM' }],
    [{ type: 'notify', params: { role_or_user: 'admin', message: 'warm' } }],
  );
  const preview = await call('GET', `/admin/automations/migration/${id}`);
  assert.equal(preview.body.convertible, false);
  assert(preview.body.warnings.some((w) => w.includes('MF')), preview.body.warnings.join(' | '));
  run('DELETE FROM rules WHERE id = ?', [id]);
});

await test('every rule is previewed, so the list can say which need a person', async () => {
  const { status, body } = await call('GET', '/admin/automations/migration');
  assert.equal(status, 200);
  assert(Array.isArray(body.rules) && body.rules.length, 'no rules previewed');
  for (const r of body.rules) {
    assert(r.rule?.name, 'a preview with no rule on it');
    assert(Array.isArray(r.warnings), 'a preview with no warnings array');
  }
});

await test('a converted flow cannot be pointed at the other book', async () => {
  const id = makeRule(
    'probe_rule_book',
    [{ field: 'lead_stage', op: 'eq', value: 'New' }],
    [{ type: 'notify', params: { role_or_user: 'admin', message: 'x' } }],
  );
  const made = await call('POST', `/admin/automations/migration/${id}`, { sales_org: 'BIGUL' });
  assert.equal(made.status, 403, `HTTP ${made.status}`);
  run('DELETE FROM rules WHERE id = ?', [id]);
});

/* ------------------------------------------------- the clock-shaped ones */

await test('a task that went overdue before the automation existed is not news', () => {
  /* The same safeguard the id watermarks have, in its other shape. Turning on
     "when a task goes overdue" must not sweep in every task that ever went
     overdue -- which, on a book with years of history, is most of them. */
  run('DELETE FROM automation_watermark');
  run(
    `INSERT INTO tasks (title, lead_id, due_at, status, priority)
     VALUES ('probe_auto old overdue task', ?, datetime('now', '-30 days'), 'Open', 'Normal')`,
    [LEAD],
  );

  const a = build('probe_auto_overdue_history', 'task.overdue', [noteAction('swept-history')]);
  detect();

  assert(!one('SELECT id FROM automation_run WHERE automation_id = ?', [a.id]),
    'a task overdue for thirty days entered a flow created today');
});

/* The cursor is "when we last looked", and these fire on what crossed the line
   since. A test cannot wait for a real due date to pass, so it winds the cursor
   back instead -- which is the same situation from the sweep's point of view. */
const rewind = (trigger, offset) => run(
  "UPDATE automation_watermark SET checked_at = datetime('now', ?) WHERE trigger_type = ?",
  [offset, trigger],
);

await test('a task that goes overdue afterwards is detected', () => {
  const a = build('probe_auto_overdue', 'task.overdue', [noteAction('overdue')]);
  detect();                                   // cursor to now
  rewind('task.overdue', '-1 hours');

  /* Due half an hour ago: inside the window, and already past. */
  run(
    `INSERT INTO tasks (title, lead_id, due_at, status, priority)
     VALUES ('probe_auto fresh overdue task', ?, datetime('now', '-30 minutes'), 'Open', 'Normal')`,
    [LEAD],
  );

  detect();
  assert(one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, LEAD]),
    'a task that went overdue inside the window was not detected');
});

await test('a task not yet due is left alone', () => {
  /* The earlier probe tasks are cleared first: they are genuinely overdue, and
     winding the cursor back would sweep them in and fire this automation for a
     reason that has nothing to do with what is being tested. */
  run("DELETE FROM tasks WHERE title LIKE 'probe_auto%'");

  const a = build('probe_auto_notdue', 'task.overdue', [noteAction('too-early')]);
  detect();
  rewind('task.overdue', '-1 hours');
  run(
    `INSERT INTO tasks (title, lead_id, due_at, status, priority)
     VALUES ('probe_auto future task', ?, datetime('now', '+2 days'), 'Open', 'Normal')`,
    [LEAD],
  );
  detect();
  /* Scoped to this lead rather than to the automation. The sweep looks at every
     task in the window, and the seeded book has ordinary tasks coming due all
     the time -- so "nothing at all entered" is a claim about the fixture, while
     "this lead did not enter" is the claim the test is actually making. */
  assert(!one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, LEAD]),
    'a task due in two days was treated as overdue');
});

await test('completing a task is detected, and the same task is not detected twice', () => {
  const a = build('probe_auto_completed', 'task.completed', [noteAction('completed')]);
  detect();

  const taskId = Number(run(
    `INSERT INTO tasks (title, lead_id, due_at, status, priority)
     VALUES ('probe_auto to complete', ?, datetime('now'), 'Open', 'Normal')`,
    [LEAD],
  ).lastInsertRowid);

  run("UPDATE tasks SET status = 'Done', updated_at = datetime('now') WHERE id = ?", [taskId]);
  rewind('task.completed', '-1 hours');

  detect();
  assert(one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, LEAD]),
    'a completed task did not reach the automation');

  const runs = one('SELECT COUNT(*) n FROM automation_run WHERE automation_id = ?', [a.id]).n;
  detect();
  assert.equal(one('SELECT COUNT(*) n FROM automation_run WHERE automation_id = ?', [a.id]).n, runs,
    'the same completed task was detected again on the next tick');
});

/* -------------------------------------------------- at regular intervals */

await test('turning on an interval automation does not sweep the book immediately', () => {
  /* Registering it as due now rather than at the beginning of time. Otherwise
     activating one would enter every matching lead in the same second. */
  run('DELETE FROM automation_watermark');
  const a = build('probe_auto_interval_new', 'schedule.interval', [noteAction('swept')]);
  run(`UPDATE automation SET trigger_config = '{"every_hours":24}' WHERE id = ?`, [a.id]);

  detect();
  assert(!one('SELECT id FROM automation_run WHERE automation_id = ?', [a.id]),
    'an interval automation swept the book the moment it was turned on');
  assert(one('SELECT 1 x FROM automation_watermark WHERE trigger_type = ?', [`schedule.interval:${a.id}`]),
    'no cursor was registered for it');
});

await test('an interval automation that is due enters the leads its conditions match', () => {
  const lead = one('SELECT stage FROM leads WHERE id = ?', [LEAD]);
  const a = build('probe_auto_interval_due', 'schedule.interval', [noteAction('interval-ran')], {
    conditions: { op: 'AND', children: [{ field: 'stage', operator: 'eq', value: lead.stage }] },
  });
  run(`UPDATE automation SET trigger_config = '{"every_hours":1}' WHERE id = ?`, [a.id]);

  detect();      // registers the cursor
  /* Backdate it so the next pass is due, rather than waiting an hour. */
  run(
    "UPDATE automation_watermark SET checked_at = datetime('now', '-2 hours') WHERE trigger_type = ?",
    [`schedule.interval:${a.id}`],
  );

  detect();
  assert(one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, LEAD]),
    'a due interval automation did not enter a matching lead');
});

await test('an interval automation does not enter a lead it is still walking through', () => {
  /* Still walking through, not "has ever been through". The invariant is one
     LIVE run per lead per automation, so a flow that finished is one a lead may
     enter again next interval -- which is the point of "at regular intervals".
     Parking the flow on a wait card is what makes the run live. */
  const lead = one('SELECT stage FROM leads WHERE id = ?', [LEAD]);
  const a = build('probe_auto_interval_live', 'schedule.interval', [
    { kind: 'wait', config: { hours: 48 } },
    noteAction('after-the-wait'),
  ], {
    conditions: { op: 'AND', children: [{ field: 'stage', operator: 'eq', value: lead.stage }] },
  });
  run(`UPDATE automation SET trigger_config = '{"every_hours":1}' WHERE id = ?`, [a.id]);
  const key = `schedule.interval:${a.id}`;

  detect();
  run("UPDATE automation_watermark SET checked_at = datetime('now', '-2 hours') WHERE trigger_type = ?", [key]);
  detect();

  const after = one('SELECT COUNT(*) n FROM automation_run WHERE automation_id = ?', [a.id]).n;
  assert(after > 0, 'the first interval pass entered nobody at all');
  assert.equal(
    one("SELECT COUNT(*) n FROM automation_run WHERE automation_id = ? AND status = 'waiting'", [a.id]).n,
    after, 'the runs did not park on the wait card, so this proves nothing',
  );

  /* Second pass, same population, everyone still parked. */
  run("UPDATE automation_watermark SET checked_at = datetime('now', '-2 hours'), last_id = 0 WHERE trigger_type = ?", [key]);
  detect();

  assert.equal(one('SELECT COUNT(*) n FROM automation_run WHERE automation_id = ?', [a.id]).n, after,
    'the interval sweep entered leads that were already inside the flow');
});

await test('an interval automation does not reach the other book', () => {
  const a = build('probe_auto_interval_bigul', 'schedule.interval', [noteAction('wrong-book')], { org: 'BIGUL' });
  run(`UPDATE automation SET trigger_config = '{"every_hours":1}' WHERE id = ?`, [a.id]);
  detect();
  run(
    "UPDATE automation_watermark SET checked_at = datetime('now', '-2 hours') WHERE trigger_type = ?",
    [`schedule.interval:${a.id}`],
  );
  detect();
  assert(!one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, LEAD]),
    "a Bigul interval automation swept a Bonanza lead");
});

/* ------------------------------------------------------- a day ending (A6) */

/* A workday ends for a person, and the engine can only start a run for a lead.
   The rule that bridges the two is the whole of A6: the leads they own that
   still have a task the day asked of them.

   These tests are mostly about the population, because the population is the
   only part that can quietly become half a million runs a night. */

const DAY = {
  lead: (name, owner) => Number(run(
    `INSERT INTO leads (name, mobile, email, source, stage, sales_org, owner_id)
     VALUES (?, '9800000009', ?, 'Referral', 'New', 'BONANZA', ?)`,
    [`Automation probe ${name}`, `probe-${name}@workday.test`, owner],
  ).lastInsertRowid),

  task: (leadId, assignee, due, status = 'Open') => run(
    `INSERT INTO tasks (title, lead_id, assignee_id, due_at, status, priority)
     VALUES ('probe_auto workday task', ?, ?, datetime('now', ?), ?, 'Normal')`,
    [leadId, assignee, due, status],
  ),

  /* Somebody pressing Check out. `closed_by` is what tells a button press from
     the eight o'clock policy giving up on them, which is the difference between
     a fact and a guess. */
  checkout: (userId, closedBy = 'user', org = 'BONANZA') => run(
    `INSERT INTO attendance_session (user_id, sales_org, checked_in_at, checked_out_at, closed_by, note)
     VALUES (?, ?, datetime('now', '-8 hours'), datetime('now'), ?, 'probe_auto day')`,
    [userId, org, closedBy],
  ),

  /* Every earlier test's check-out is cleared first. detect() then sets the
     cursor at now, and winding it back re-opens a window that contains only
     what this test is about to write -- without the clear, the window also
     contains the previous test's press of the button, which is how a test
     about ignoring an automatic close passes on somebody else's manual one. */
  arm: () => {
    run("DELETE FROM attendance_session WHERE note LIKE 'probe_auto%'");
    detect();
    rewind('user.workday_end', '-1 hours');
  },
};

await test('every trigger the builder offers either fires or says why it does not', async () => {
  /* The invariant the two workday tests here used to carry. A trigger that
     neither fires nor explains itself is the worst of the three states: it
     looks live, runs nothing, and nobody goes looking for it. */
  const { body } = await call('GET', '/admin/automations/spec');
  const dead = body.triggers.filter((t) => t.unwired);
  for (const t of dead) {
    const a = build(`probe_auto_dead_${t.key.replace(/\W/g, '')}`, t.key, [{ kind: 'exit', config: {} }]);
    assert(validate(a.id).some((p) => p.field === 'trigger'),
      `${t.key} is marked unavailable but activating it is not refused`);
  }
  assert(body.triggers.every((t) => t.unwired || !t.unwired),
    'a trigger is neither wired nor marked');
});

await test('a workday ending can be activated now that it has a population', () => {
  const a = build('probe_auto_day_live', 'user.workday_end', [noteAction('day-end')], { status: 'draft' });
  const problems = validate(a.id).filter((p) => p.field === 'trigger');
  assert.equal(problems.length, 0, JSON.stringify(problems));
});

await test('a day ending starts the flow for the leads that still have a task open', () => {
  const a = build('probe_auto_day_open', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  const lead = DAY.lead('day open', PROBE.id);
  DAY.task(lead, PROBE.id, '-2 hours');

  DAY.arm();
  DAY.checkout(PROBE.id);
  detect();

  assert(one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, lead]),
    'a lead with an open task due today did not enter when the day ended');
});

await test('a lead with nothing outstanding is left where it is', () => {
  /* The difference between this option and "every lead she owns". If a lead
     with no task enters, the population is the whole book again and the number
     is 5,965 per person per night. */
  const a = build('probe_auto_day_idle', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  const quiet = DAY.lead('day quiet', PROBE.id);
  const done = DAY.lead('day done', PROBE.id);
  DAY.task(done, PROBE.id, '-2 hours', 'Done');

  DAY.arm();
  DAY.checkout(PROBE.id);
  detect();

  assert(!one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, quiet]),
    'a lead with no task at all entered, which makes the population the whole book');
  assert(!one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, done]),
    'a lead whose task was finished entered, so finishing the list is not rewarded');
});

await test('a task due tomorrow is not something today asked for', () => {
  const a = build('probe_auto_day_future', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  const later = DAY.lead('day later', PROBE.id);
  DAY.task(later, PROBE.id, '+2 days');

  DAY.arm();
  DAY.checkout(PROBE.id);
  detect();

  assert(!one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, later]),
    'a task not due for two days counted as work that was missed today');
});

await test('the eight-o-clock policy giving up on somebody does not message their clients', () => {
  /* `closed_by = 'auto'` is the attendance policy guessing that a person who
     forgot to check out went home. Messaging a client off a guess is the one
     failure here that reaches outside the building. */
  const a = build('probe_auto_day_auto', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  const lead = DAY.lead('day auto', PROBE.id);
  DAY.task(lead, PROBE.id, '-2 hours');

  DAY.arm();
  DAY.checkout(PROBE.id, 'auto');
  detect();

  assert(!one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, lead]),
    'a session the policy closed was treated as somebody deciding their day was over');
});

await test('a team that never presses the button can opt into the automatic close', () => {
  const a = build('probe_auto_day_optin', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  run("UPDATE automation SET trigger_config = ? WHERE id = ?",
    [JSON.stringify({ closed_by: ['user', 'auto'] }), a.id]);
  const lead = DAY.lead('day optin', PROBE.id);
  DAY.task(lead, PROBE.id, '-2 hours');

  DAY.arm();
  DAY.checkout(PROBE.id, 'auto');
  detect();

  assert(one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, lead]),
    'the automation asked for automatic closes and did not get them');
});

await test('turning it on does not sweep every check-out ever recorded', () => {
  /* The same safeguard as every other watermark, and the one with the largest
     blast radius: 83 people times however many days the table goes back.
     The cursor is removed rather than wound back, because "never seen before"
     is the state being tested and a wound-back cursor is not that state. */
  run("DELETE FROM automation_watermark WHERE trigger_type = 'user.workday_end'");
  DAY.checkout(PROBE.id);
  const a = build('probe_auto_day_history', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  const lead = DAY.lead('day history', PROBE.id);
  DAY.task(lead, PROBE.id, '-2 hours');

  detect();   // first sight: the cursor starts here, not at the beginning

  assert(!one('SELECT id FROM automation_run WHERE automation_id = ?', [a.id]),
    'a check-out from before the automation existed entered leads into it');
});

await test('one person\'s day ending cannot enter more leads than the ceiling', () => {
  const a = build('probe_auto_day_cap', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  run("UPDATE automation SET trigger_config = ? WHERE id = ?",
    [JSON.stringify({ max_leads: 2 }), a.id]);

  for (const n of ['cap a', 'cap b', 'cap c', 'cap d']) {
    DAY.task(DAY.lead(`day ${n}`, PROBE.id), PROBE.id, '-2 hours');
  }

  DAY.arm();
  DAY.checkout(PROBE.id);
  detect();

  const n = one('SELECT COUNT(*) AS n FROM automation_run WHERE automation_id = ?', [a.id]).n;
  assert.equal(n, 2, `the ceiling was 2 and ${n} leads entered`);
});

await test('checking out twice in a day does not run the day twice', () => {
  /* Somebody who steps out for lunch has had one working day. Without a
     per-day ceiling rather than a per-check-out one, they get two. */
  const a = build('probe_auto_day_twice', 'user.workday_end', [{ kind: 'exit', config: {} }]);
  run("UPDATE automation SET trigger_config = ? WHERE id = ?",
    [JSON.stringify({ max_leads: 1 }), a.id]);
  DAY.task(DAY.lead('day twice one', PROBE.id), PROBE.id, '-2 hours');
  DAY.task(DAY.lead('day twice two', PROBE.id), PROBE.id, '-2 hours');

  DAY.arm();
  DAY.checkout(PROBE.id);
  detect();
  DAY.arm();
  DAY.checkout(PROBE.id);
  detect();

  const n = one('SELECT COUNT(*) AS n FROM automation_run WHERE automation_id = ?', [a.id]).n;
  assert.equal(n, 1, `two check-outs in one day produced ${n} runs against a ceiling of 1`);
});

await test('a workday ending in the other book does not reach this one', () => {
  const bigul = build('probe_auto_day_bigul', 'user.workday_end', [{ kind: 'exit', config: {} }], { org: 'BIGUL' });
  const lead = DAY.lead('day boundary', PROBE.id);
  DAY.task(lead, PROBE.id, '-2 hours');

  DAY.arm();
  DAY.checkout(PROBE.id);          // a BONANZA check-out
  detect();

  assert(!one('SELECT id FROM automation_run WHERE automation_id = ?', [bigul.id]),
    "a Bonanza user's day ending entered leads into a Bigul automation");
});

/* ------------------------------------------------------------ conditions */

await test('every condition field the builder offers is one the engine can read', () => {
  /* These two vocabularies drifted apart once already. The builder shows the
     registry's names -- stage, city, owner_id -- because that is what toSql
     needs; the engine evaluated against leadFacts, which calls the same things
     lead_stage and keeps the row under _lead. So `facts['stage']` was
     undefined, every condition built on this screen was false, an automation
     with entry conditions admitted nobody, and every branch took its else path.

     Nothing in the old tests caught it, because they write conditions in the
     facts vocabulary directly in code rather than through the screen. This
     walks what the screen actually offers. */
  const facts = leadFacts(LEAD);
  const unreadable = [];

  for (const f of conditionSchema().fields) {
    const actual = valueOf(f.code, facts);
    /* undefined means the field resolved to nothing at all -- neither a fact
       nor a column. A null column is a real value and fine. */
    if (actual === undefined) unreadable.push(f.code);
  }

  assert.deepEqual(unreadable, [],
    `the builder offers fields the engine cannot read: ${unreadable.join(', ')}`);
});

await test('an entry condition written the way the screen writes it admits the right lead', () => {
  const lead = one('SELECT stage, city FROM leads WHERE id = ?', [LEAD]);

  const yes = build('probe_auto_entry_yes', 'lead.created', [noteAction('admitted')], {
    conditions: { op: 'AND', children: [{ field: 'stage', operator: 'eq', value: lead.stage }] },
  });
  assert(enter(yes.id, LEAD), 'a lead matching the entry condition was turned away');

  const no = build('probe_auto_entry_no', 'lead.created', [noteAction('should-not-run')], {
    conditions: { op: 'AND', children: [{ field: 'stage', operator: 'eq', value: 'NotAStageAnybodyUses' }] },
  });
  assert(!enter(no.id, LEAD), 'a lead that does not match the entry condition was admitted');
});

await test('a branch written the way the screen writes it takes the yes path', () => {
  const lead = one('SELECT stage FROM leads WHERE id = ?', [LEAD]);
  const a = build('probe_auto_branch_ui', 'lead.created', [
    {
      kind: 'branch',
      config: { conditions: { op: 'AND', children: [{ field: 'stage', operator: 'eq', value: lead.stage }] } },
      next: 1,
      else: 2,
    },
    /* next: null on the yes card, or it falls through into the else card and
       overwrites the marker with the answer we are testing against. */
    { ...noteAction('took-the-yes-path'), next: null },
    noteAction('took-the-else-path'),
  ]);

  enter(a.id, LEAD);
  assert.equal(marker(), 'took-the-yes-path', `it took the else path: marker is ${marker()}`);
});

/* --------------------------------------------------------------- actions */

/* runAction takes facts, not a lead id, so each of these builds them the way
   the engine does. */
const factsFor = (leadId) => leadFacts(leadId);
const act = (type, params = {}, leadId = LEAD) => runAction({ type, params }, factsFor(leadId), { dryRun: false });

await test('every action the spec offers is one the engine can perform', () => {
  /* The screen reads /spec. An action listed there and not handled below is a
     card somebody can drop onto a canvas that then does nothing at all. */
  const unhandled = [];
  for (const a of ACTION_TYPES) {
    if (a.flow_only) continue;          // performed by the flow engine, not runAction
    const out = act(a.type, {});
    if (out?.skipped === 'unknown action type') unhandled.push(a.type);
  }
  assert.deepEqual(unhandled, [], `the spec offers actions nothing performs: ${unhandled.join(', ')}`);
});

await test('every action is in a category, because the ticket asks for categories', () => {
  const loose = ACTION_TYPES.filter((a) => !a.category).map((a) => a.type);
  assert.deepEqual(loose, []);
});

await test('a marketing message to someone who opted out is refused, not sent', () => {
  /* consent.js says it in its own header: hiding a button stops an RM, it does
     not stop an automation, "which is where volume sends actually come from,
     and where a DND breach would actually happen". */
  run('UPDATE leads SET marketing_opt_out = 1 WHERE id = ?', [LEAD]);
  const before = one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [LEAD]).n;

  const out = act('whatsapp', { message: 'Open a demat account today' });
  assert(out.skipped, 'an opted-out lead was sent a marketing WhatsApp');
  assert.equal(out.code, 'opted_out');
  assert.equal(one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [LEAD]).n, before,
    'nothing should have been written to the timeline');

  run('UPDATE leads SET marketing_opt_out = 0 WHERE id = ?', [LEAD]);
});

await test('a service message still reaches someone who opted out of marketing', () => {
  /* The distinction the whole consent model exists for: a client who opted out
     of marketing has not opted out of being told their KYC failed. */
  run('UPDATE leads SET marketing_opt_out = 1 WHERE id = ?', [LEAD]);
  const out = act('sms', { message: 'Your KYC needs one more document', intent: 'service' });
  assert(!out.skipped, `a service SMS was blocked: ${out.skipped}`);
  run('UPDATE leads SET marketing_opt_out = 0 WHERE id = ?', [LEAD]);
});

await test('an opt-in email goes to someone who opted out of marketing, but not to someone who closed the channel', () => {
  run('UPDATE leads SET marketing_opt_out = 1, no_email = 0 WHERE id = ?', [LEAD]);
  assert(!act('opt_in_email', { message: 'May we keep in touch, {{name}}?' }).skipped,
    'an opt-in email is the one message a marketing opt-out should not block');

  run('UPDATE leads SET no_email = 1 WHERE id = ?', [LEAD]);
  const closed = act('opt_in_email', { message: 'May we keep in touch?' });
  assert(closed.skipped, 'somebody who asked us to stop emailing them got one more email');

  run('UPDATE leads SET marketing_opt_out = 0, no_email = 0 WHERE id = ?', [LEAD]);
});

await test('an activity added by an automation lands on the shared timeline with no author', () => {
  const out = act('add_activity', { activity_type: 'Note', subject: 'probe_auto activity', body: 'Hello {{name}}' });
  assert(out.executed, out.skipped);
  const a = one("SELECT * FROM activities WHERE lead_id = ? AND subject = 'probe_auto activity'", [LEAD]);
  assert(a, 'nothing was written');
  assert.equal(a.user_id, null, 'an automated activity must not be attributed to a person');
  assert(a.body.includes('Automation probe lead'), 'the merge field was not filled');
});

await test('a lead can be added to and removed from a static list', () => {
  const listId = Number(run(
    "INSERT INTO lead_lists (name, kind, sales_org, snapshot_reason) VALUES ('probe_auto_static', 'static', 'BONANZA', 'test')",
  ).lastInsertRowid);

  assert(act('add_to_list', { list_id: listId }).executed);
  assert(one('SELECT 1 x FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [listId, LEAD]), 'not added');

  /* Twice is not an error and not a duplicate. */
  assert(act('add_to_list', { list_id: listId }).executed);
  assert.equal(one('SELECT COUNT(*) n FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [listId, LEAD]).n, 1);

  assert(act('remove_from_list', { list_id: listId }).executed);
  assert(!one('SELECT 1 x FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [listId, LEAD]), 'not removed');
});

await test('a lead cannot be added to a list whose membership is a query', () => {
  /* Non-negotiable 10: segments are live nested queries, not stored membership
     rows. Writing a member row into one succeeds and then silently vanishes at
     the next refresh, which is worse than refusing. */
  const listId = Number(run(
    "INSERT INTO lead_lists (name, kind, sales_org, criteria) VALUES ('probe_auto_dynamic', 'dynamic', 'BONANZA', '{}')",
  ).lastInsertRowid);

  const out = act('add_to_list', { list_id: listId });
  assert(out.skipped, 'a dynamic list accepted a hand-written member');
  assert(out.skipped.includes('live query'), out.skipped);
  assert(!one('SELECT 1 x FROM lead_list_members WHERE list_id = ?', [listId]), 'a row was written anyway');
});

await test('a lead cannot be added to the other book\'s list', () => {
  const listId = Number(run(
    "INSERT INTO lead_lists (name, kind, sales_org, snapshot_reason) VALUES ('probe_auto_bigul_list', 'static', 'BIGUL', 'test')",
  ).lastInsertRowid);
  const out = act('add_to_list', { list_id: listId });
  assert(out.skipped?.includes('another book'), `a Bonanza lead joined a Bigul list: ${JSON.stringify(out)}`);
});

await test('starring is readable as a condition, not only writable as an action', () => {
  assert(act('star_lead', {}).executed);
  const starred = one('SELECT starred, starred_at FROM leads WHERE id = ?', [LEAD]);
  assert.equal(starred.starred, 1);
  assert(starred.starred_at, 'starred_at was not stamped');
  assert.equal(leadFacts(LEAD).starred, true, 'a flow cannot branch on the star it just set');

  assert(act('star_lead', { starred: false }).executed);
  const cleared = one('SELECT starred, starred_at FROM leads WHERE id = ?', [LEAD]);
  assert.equal(cleared.starred, 0);
  assert.equal(cleared.starred_at, null, 'un-starring left the timestamp behind');
});

await test('an SMS to the owner does not appear on the client\'s timeline', () => {
  /* The message went to a colleague. Writing it against the lead would tell the
     next person who reads that timeline that the client received it. */
  /* Seeded users do not all carry a mobile, so the fixture provides one and
     puts it back afterwards rather than depending on which user seed ran. */
  const rm = one('SELECT id, phone FROM users WHERE active = 1 ORDER BY id LIMIT 1');
  assert(rm, 'no active user to test with');
  run("UPDATE users SET phone = COALESCE(NULLIF(phone, ''), '9820000000') WHERE id = ?", [rm.id]);
  run('UPDATE leads SET owner_id = ? WHERE id = ?', [rm.id, LEAD]);

  const before = one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [LEAD]).n;
  const out = act('notify_owner_sms', { message: 'probe_auto owner ping about {{name}}' });
  assert(out.executed, out.skipped);
  assert.equal(one('SELECT COUNT(*) n FROM activities WHERE lead_id = ?', [LEAD]).n, before,
    'an SMS sent to the RM was written onto the client timeline');
  assert(one("SELECT 1 x FROM notifications WHERE user_id = ? AND body LIKE 'probe_auto owner ping%'", [rm.id]),
    'the owner was not told in the CRM either');

  run('UPDATE users SET phone = ? WHERE id = ?', [rm.phone ?? null, rm.id]);
});

await test('an owner-SMS with no owner is refused rather than sent nowhere', () => {
  run('UPDATE leads SET owner_id = NULL WHERE id = ?', [LEAD]);
  assert(act('notify_owner_sms', { message: 'x' }).skipped);
});

await test('distributing a lead goes through the assignment engine', () => {
  /* The automation hands over; it does not pick. Two mechanisms choosing owners
     is the race the audit found three live examples of. */
  run('UPDATE leads SET owner_id = NULL, owner_queue_id = NULL WHERE id = ?', [LEAD]);
  const out = act('distribute_lead', {});
  assert(out.executed || out.skipped, 'no verdict at all');
  if (out.executed) {
    const after = one('SELECT owner_id, owner_queue_id, assigned_at FROM leads WHERE id = ?', [LEAD]);
    assert(after.owner_id || after.owner_queue_id, 'it reported success but nobody owns the lead');
    assert(after.assigned_at, 'assigned_at was not stamped, so the assignment engine did not do it');
  }
});

await test('a webhook posts only to a registered endpoint', () => {
  assert(act('webhook', { endpoint_id: 999999 }).skipped, 'an unregistered endpoint was accepted');

  const epId = Number(run(
    `INSERT INTO webhook_endpoint (name, url, secret, fields, sales_org)
     VALUES ('probe_auto_hook', 'https://example.invalid/hook', 's3cret', ?, 'BONANZA')`,
    [JSON.stringify(['name', 'stage'])],
  ).lastInsertRowid);

  const out = act('webhook', { endpoint_id: epId });
  assert(out.executed && out.queued, JSON.stringify(out));

  const d = one('SELECT * FROM webhook_delivery WHERE id = ?', [out.delivery_id]);
  assert.equal(d.status, 'queued', 'the tick posted it inline instead of queueing it');

  const payload = JSON.parse(d.payload);
  assert.equal(payload.lead_id, LEAD);
  assert.equal(payload.name, 'Automation probe lead');
  assert.equal(payload.stage, 'New');
  assert.equal(payload.mobile, undefined, 'a field the endpoint was not registered for was sent anyway');
  assert.equal(payload.pan, undefined, 'a field the endpoint was not registered for was sent anyway');
});

await test("a webhook endpoint in the other book does not receive this book's lead", () => {
  /* The reachable half of the boundary. The registry routes sit behind
     admin.system, which only superadmin holds, and a superadmin has every book
     -- so the refusal that can actually happen is this one, where the lead's
     book and the endpoint's disagree. */
  const epId = Number(run(
    "INSERT INTO webhook_endpoint (name, url, sales_org) VALUES ('probe_auto_hook_bigul', 'https://example.invalid/b', 'BIGUL')",
  ).lastInsertRowid);
  const out = act('webhook', { endpoint_id: epId });
  assert(out.skipped?.includes('another book'), `a Bonanza lead was posted to a Bigul endpoint: ${JSON.stringify(out)}`);
  assert(!one('SELECT id FROM webhook_delivery WHERE endpoint_id = ?', [epId]), 'a delivery was queued anyway');
});

await test('a webhook body carries the lead id and nothing else when no fields are registered', () => {
  const epId = Number(run(
    `INSERT INTO webhook_endpoint (name, url, sales_org) VALUES ('probe_auto_hook_bare', 'https://example.invalid/h', 'BONANZA')`,
  ).lastInsertRowid);
  const out = act('webhook', { endpoint_id: epId });
  const payload = JSON.parse(one('SELECT payload FROM webhook_delivery WHERE id = ?', [out.delivery_id]).payload);
  assert.deepEqual(Object.keys(payload).sort(), ['event', 'lead_id']);
});

await test('a nudge reaches each named person once', () => {
  const two = all('SELECT id FROM users WHERE active = 1 LIMIT 2');
  assert.equal(two.length, 2, 'need two active users');
  const spec = `${two[0].id},${two[1].id},${two[0].id}`;     // one named twice

  const out = act('nudge_users', { role_or_users: spec, message: 'probe_auto nudge' });
  assert.equal(out.nudged, 2, 'somebody named twice was nudged twice');
  assert.equal(
    one("SELECT COUNT(*) n FROM notifications WHERE body = 'probe_auto nudge'").n, 2,
  );
});

await test('a nudge with nobody named is refused', () => {
  assert(act('nudge_users', { role_or_users: '  ' }).skipped);
});

/* ------------------------------------------------------- sub-automations */

await test('a flow hands a lead to a sub-automation', () => {
  const child = build('probe_auto_child', 'sub', [noteAction('inside-the-child')]);
  const parent = build('probe_auto_parent', 'lead.created', [
    { kind: 'action', config: { type: 'sub_automation', params: { automation_id: child.id } } },
  ]);

  enter(parent.id, LEAD);
  assert(one('SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ?', [child.id, LEAD]),
    'the child automation never received the lead');
});

await test('an automation that calls itself is caught before it is allowed to run', () => {
  const a = build('probe_auto_selfcall', 'lead.created', [
    { kind: 'action', config: { type: 'sub_automation', params: {} } },
  ]);
  run(
    `UPDATE automation_step SET config = ? WHERE automation_id = ?`,
    [JSON.stringify({ type: 'sub_automation', params: { automation_id: a.id } }), a.id],
  );
  const problems = validate(a.id).map((p) => p.message).join(' | ');
  assert(problems.includes('cannot call itself'), problems);
});

await test('a chain that loops back stops itself, because a live run cannot be re-entered', () => {
  /* A -> B -> A. The guard is the invariant that was already here: a lead
     inside a live run of an automation cannot enter it again. */
  const a = build('probe_auto_loop_a', 'lead.created', [{ kind: 'action', config: { type: 'sub_automation', params: {} } }]);
  const b = build('probe_auto_loop_b', 'sub', [{ kind: 'action', config: { type: 'sub_automation', params: {} } }]);

  run('UPDATE automation_step SET config = ? WHERE automation_id = ?',
    [JSON.stringify({ type: 'sub_automation', params: { automation_id: b.id } }), a.id]);
  run('UPDATE automation_step SET config = ? WHERE automation_id = ?',
    [JSON.stringify({ type: 'sub_automation', params: { automation_id: a.id } }), b.id]);

  enter(a.id, LEAD);

  assert.equal(one('SELECT COUNT(*) n FROM automation_run WHERE automation_id = ? AND lead_id = ?', [a.id, LEAD]).n, 1,
    'the lead entered A more than once');
  const back = one(
    `SELECT s.detail FROM automation_run_step s
       JOIN automation_run r ON r.id = s.run_id
      WHERE r.automation_id = ? AND r.lead_id = ? AND s.detail LIKE '%sub_automation%'`,
    [b.id, LEAD],
  );
  assert(back, 'B never tried to call A back');
  assert.equal(JSON.parse(back.detail).entered, false, 'B re-entered the lead into A');
});

await test('a sub-automation card pointing at a paused flow is not ready to run', () => {
  const child = build('probe_auto_paused_child', 'sub', [noteAction('x')], { status: 'paused' });
  const parent = build('probe_auto_paused_parent', 'lead.created', [
    { kind: 'action', config: { type: 'sub_automation', params: { automation_id: child.id } } },
  ]);
  const problems = validate(parent.id).map((p) => p.message).join(' | ');
  assert(problems.includes('paused'), problems);
});

clean();
PROBE.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
