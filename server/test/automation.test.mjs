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
