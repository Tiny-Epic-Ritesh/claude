/**
 * QA-02 -- a rule fires once per change, not once per sweep.
 *
 * The auditor found 48,243 firings of the KYC waterfall, 10,431 of the Warm
 * rule and 10,477 tasks against 41 leads: every five minutes each enabled rule
 * acted on every lead that matched, with nothing recording that it already
 * had. These drive `runRule` the way the five-minute tick does, with the clock
 * passed in so a day can be walked in a second.
 *
 * Each test's rule is created disabled, so the server's own tick never runs it
 * alongside the test. The seeded waterfall is the exception -- it is the thing
 * under test -- and is disabled for the few seconds this file needs it, then
 * put back.
 */

import { strict as assert } from 'node:assert';
import 'dotenv/config';
import * as db from '../src/db.js';
import * as rules from '../src/engine/rules.js';
import { isWorkingTime } from '../src/engine/calendar.js';
import { LOG_KINDS, purge, retention } from '../src/engine/logs.js';

const { all, one, run } = db;
const { runRule } = rules;
// Loaded this way so the file still runs, and fails test by test, on code without it.
const duplicates = await import('../scripts/qa02-duplicate-tasks.mjs').catch(() => null);

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nQA-02 — rules fire once per change, not once per sweep');

const RUN = Date.now().toString(36);
const MARK = `QA02 probe ${RUN}`;
const SOURCE = `qa02-${RUN}`;

const sweep = () => {
  for (const r of all("SELECT id FROM rules WHERE name LIKE 'QA02 probe %'")) {
    run('DELETE FROM rule_failures WHERE rule_id = ?', [r.id]);
    run('DELETE FROM rules WHERE id = ?', [r.id]);
  }
  run("DELETE FROM tasks WHERE title LIKE 'QA02 probe %'");
  run("DELETE FROM notifications WHERE body LIKE 'QA02 probe %'");
  run("DELETE FROM leads WHERE name LIKE 'QA02 probe %'");
};
sweep();

const owner = one("SELECT id FROM users WHERE role = 'sales_rm' AND sales_org = 'BONANZA' AND active = 1 ORDER BY id LIMIT 1");

let leadSeq = 0;
const seedLead = (extra = {}) => {
  leadSeq += 1;
  return Number(run(
    `INSERT INTO leads (sales_org, name, source, stage, owner_id, mobile)
     VALUES ('BONANZA', ?, ?, 'New', ?, ?)`,
    [`${MARK} ${leadSeq}`, extra.source ?? SOURCE, owner.id, `7${String(Date.now()).slice(-6)}${String(leadSeq).padStart(3, '0')}`],
  ).lastInsertRowid);
};

const makeRule = (actions, schedule = null, conditions = [{ field: 'lead_source', op: 'eq', value: SOURCE }]) => Number(run(
  'INSERT INTO rules (name, conditions, actions, schedule, enabled, priority) VALUES (?,?,?,?,0,500)',
  [`${MARK} rule ${Math.random().toString(36).slice(2, 7)}`, JSON.stringify(conditions), JSON.stringify(actions),
    schedule ? JSON.stringify(schedule) : null],
).lastInsertRowid);

const taskAction = (title, extra = {}) => ({ type: 'task', params: { title, assignee: 'owner', due_in_hours: 4 }, ...extra });
const tasksTitled = (lead, title) => all('SELECT * FROM tasks WHERE lead_id = ? AND title = ?', [lead, title]);
const at = (base, minutes) => new Date(base.getTime() + minutes * 60_000);

/* A moment the office calendar is open and one it is not, found by asking the
   calendar rather than assumed, so a holiday cannot make these flaky. */
const findTime = (wantOpen) => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  for (let h = 0; h < 24 * 21; h += 1) {
    const t = new Date(d.getTime() + h * 3_600_000);
    const weekend = [0, 6].includes(t.getDay());
    if (wantOpen ? (isWorkingTime(t, 'office') && !weekend) : !isWorkingTime(t, 'office')) return t;
  }
  throw new Error(`no ${wantOpen ? 'open' : 'closed'} office hour in three weeks`);
};
const OPEN = at(findTime(true), 30);   // half past an open hour

const waterfall = one("SELECT * FROM rules WHERE name = 'KYC escalation waterfall'");
const waterfallWasEnabled = waterfall?.enabled ?? 0;

try {
  /* ============================================== once per change */

  await test('ten sweeps over a lead that stays matching make one task', async () => {
    const lead = seedLead();
    const title = `${MARK} once`;
    const rule = makeRule([taskAction(title)]);
    for (let i = 0; i < 10; i += 1) runRule(rule, { leadIds: [lead], now: at(OPEN, i * 5) });
    const tasks = tasksTitled(lead, title);
    assert.equal(tasks.length, 1, `${tasks.length} tasks from ten sweeps`);
    const firing = one('SELECT * FROM rule_firings WHERE rule_id = ? AND lead_id = ? AND cleared_at IS NULL', [rule, lead]);
    assert(firing, 'no open firing records that the rule acted');
    assert.equal(tasks[0].rule_firing_id, firing.id, 'the task does not say which firing made it');
    assert.equal(one('SELECT fire_count FROM rules WHERE id = ?', [rule]).fire_count, 1, 'the fire count counted sweeps, not firings');
    assert.equal(one('SELECT COUNT(*) n FROM rule_runs WHERE rule_id = ?', [rule]).n, 1, 'a run was logged for sweeps that did nothing');
  });

  await test('a lead that stops matching and matches again is a new event', async () => {
    const lead = seedLead();
    const title = `${MARK} again`;
    const rule = makeRule([taskAction(title)]);
    runRule(rule, { leadIds: [lead], now: OPEN });
    run('UPDATE leads SET source = ? WHERE id = ?', [`${SOURCE}-elsewhere`, lead]);
    const out = runRule(rule, { leadIds: [lead], now: at(OPEN, 5) });
    assert.equal(out.cleared_count, 1, 'the firing was not closed when the lead stopped matching');
    run('UPDATE leads SET source = ? WHERE id = ?', [SOURCE, lead]);
    runRule(rule, { leadIds: [lead], now: at(OPEN, 10) });
    runRule(rule, { leadIds: [lead], now: at(OPEN, 15) });
    assert.equal(tasksTitled(lead, title).length, 2, 're-entering did not fire again, or fired more than once');
  });

  await test('a rule set to repeat fires again only after its interval', async () => {
    const lead = seedLead();
    const title = `${MARK} repeat`;
    const rule = makeRule([taskAction(title)], { repeat_hours: 24 });
    runRule(rule, { leadIds: [lead], now: OPEN });
    runRule(rule, { leadIds: [lead], now: at(OPEN, 5) });
    assert.equal(tasksTitled(lead, title).length, 1, 'repeated five minutes later');
    runRule(rule, { leadIds: [lead], now: at(OPEN, 24 * 60 + 5) });
    assert.equal(tasksTitled(lead, title).length, 2, 'did not repeat after 24 hours');
  });

  /* ============================================== stages */

  await test('a delayed stage runs once, that long after the first, while the lead still matches', async () => {
    const lead = seedLead();
    const first = `${MARK} stage one`;
    const second = `${MARK} stage two`;
    const rule = makeRule([taskAction(first), taskAction(second, { after_minutes: 30 })]);
    runRule(rule, { leadIds: [lead], now: OPEN });
    runRule(rule, { leadIds: [lead], now: at(OPEN, 10) });
    assert.equal(tasksTitled(lead, second).length, 0, 'the second stage ran early');
    runRule(rule, { leadIds: [lead], now: at(OPEN, 31) });
    runRule(rule, { leadIds: [lead], now: at(OPEN, 60) });
    assert.equal(tasksTitled(lead, first).length, 1);
    assert.equal(tasksTitled(lead, second).length, 1, 'the second stage did not run exactly once');
  });

  await test('a stage does not run for a lead that stopped matching first', async () => {
    const lead = seedLead();
    const second = `${MARK} late stage`;
    const rule = makeRule([taskAction(`${MARK} early stage`), taskAction(second, { after_minutes: 30 })]);
    runRule(rule, { leadIds: [lead], now: OPEN });
    run('UPDATE leads SET source = ? WHERE id = ?', [`${SOURCE}-resumed`, lead]);
    runRule(rule, { leadIds: [lead], now: at(OPEN, 31) });
    assert.equal(tasksTitled(lead, second).length, 0, 'the follow-up went to a lead that had already moved on');
  });

  /* ============================================== the rule's own schedule */

  await test('a rule kept to office hours waits, then acts once the office opens', async () => {
    const lead = seedLead();
    const title = `${MARK} hours`;
    const rule = makeRule([taskAction(title)], { business_hours: true });
    const closed = findTime(false);
    const held = runRule(rule, { leadIds: [lead], now: closed });
    assert.equal(held.waiting_count, 1, 'nothing reported the lead as waiting');
    assert.equal(tasksTitled(lead, title).length, 0, 'it acted outside office hours');
    runRule(rule, { leadIds: [lead], now: OPEN > closed ? OPEN : findTime(true) });
    assert.equal(tasksTitled(lead, title).length, 1, 'it did not act once the office was open');
  });

  await test('a daily limit holds a repeating rule until the next day', async () => {
    const lead = seedLead();
    const title = `${MARK} cap`;
    const rule = makeRule([taskAction(title)], { repeat_hours: 1, max_per_day: 1 });
    runRule(rule, { leadIds: [lead], now: OPEN });
    const held = runRule(rule, { leadIds: [lead], now: at(OPEN, 90) });
    assert.equal(held.waiting_count, 1, 'the second firing of the day was not held');
    assert.equal(tasksTitled(lead, title).length, 1);
    runRule(rule, { leadIds: [lead], now: at(OPEN, 24 * 60 + 90) });
    assert.equal(tasksTitled(lead, title).length, 2, 'the limit did not lift the next day');
  });

  await test('the seeded rules declare their schedule, and the engine reads it', async () => {
    const seeded = one("SELECT * FROM rules WHERE name = 'Warm → notify Product RM'");
    assert(seeded, 'the seeded Warm rule is missing');
    assert.equal(typeof rules.scheduleOf, 'function', "nothing reads a rule's schedule");
    const s = rules.scheduleOf(seeded);
    assert.equal(s.business_hours, true);
    assert.equal(s.max_per_day, 3);
    assert.equal(s.repeat_hours, null, 'the Warm rule repeats, which nobody chose');
  });

  /* ============================================== failure */

  await test('a sweep that dies halfway leaves nothing behind, and the next one acts once', async () => {
    const lead = seedLead();
    const title = `${MARK} crash`;
    const rule = makeRule([taskAction(title)]);
    run(`CREATE TEMP TRIGGER qa02_crash BEFORE INSERT ON rule_runs WHEN NEW.rule_id = ${rule}
         BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    let threw = false;
    try { runRule(rule, { leadIds: [lead], now: OPEN }); } catch { threw = true; }
    run('DROP TRIGGER qa02_crash');
    assert(threw, 'the simulated crash did not happen, so this proves nothing');
    assert.equal(tasksTitled(lead, title).length, 0, 'the task survived the crash that undid its firing');
    runRule(rule, { leadIds: [lead], now: at(OPEN, 5) });
    runRule(rule, { leadIds: [lead], now: at(OPEN, 10) });
    assert.equal(tasksTitled(lead, title).length, 1, 'the retry after the crash made more than one task');
  });

  await test('a failing action is tried three times, then left in the failure queue', async () => {
    const lead = seedLead();
    // An assignee that does not exist fails the insert on its foreign key.
    const rule = makeRule([{ type: 'task', params: { title: `${MARK} fails`, assignee: 99999999 } }]);
    for (let i = 0; i < 5; i += 1) runRule(rule, { leadIds: [lead], now: at(OPEN, i * 5) });
    const firing = one('SELECT * FROM rule_firings WHERE rule_id = ? AND lead_id = ?', [rule, lead]);
    assert.equal(JSON.parse(firing.attempts)['0'], 3, `attempted ${JSON.parse(firing.attempts)['0']} times`);
    assert.deepEqual(JSON.parse(firing.gave_up), [0]);
    assert.equal(one('SELECT COUNT(*) n FROM rule_failures WHERE rule_id = ? AND lead_id = ?', [rule, lead]).n, 1,
      'the failure queue does not hold it exactly once');
    const retried = runRule(rule, { leadIds: [lead], now: at(OPEN, 30), retry: true });
    assert.equal(retried.failed, 1, 'a retry from the queue did not try again');
  });

  /* ============================================== dry run, and history */

  await test('a dry run says who would fire and who already has, and changes nothing', async () => {
    const fresh = seedLead();
    const fired = seedLead();
    const title = `${MARK} dry`;
    const rule = makeRule([taskAction(title)]);
    runRule(rule, { leadIds: [fired], now: OPEN });
    const runsBefore = one('SELECT COUNT(*) n FROM rule_runs WHERE rule_id = ?', [rule]).n;
    const dry = runRule(rule, { dryRun: true, leadIds: [fresh, fired], now: at(OPEN, 5) });
    const state = (id) => dry.matched.find((m) => m.lead_id === id)?.state;
    assert.equal(state(fresh), 'would_fire');
    assert.equal(state(fired), 'already_fired');
    assert.equal(tasksTitled(fresh, title).length, 0, 'a dry run made a task');
    assert.equal(one('SELECT COUNT(*) n FROM rule_firings WHERE rule_id = ? AND lead_id = ?', [rule, fresh]).n, 0, 'a dry run armed a firing');
    assert.equal(one('SELECT COUNT(*) n FROM rule_runs WHERE rule_id = ?', [rule]).n, runsBefore, 'a dry run was logged as a run');
  });

  await test('a lead the rule already acted on before the ledger is not acted on again', async () => {
    const lead = seedLead();
    const title = `${MARK} history`;
    const rule = makeRule([taskAction(title)]);
    run("INSERT INTO rule_runs (rule_id, lead_id, dry_run, matched, detail, created_at) VALUES (?, ?, 0, 1, '[]', datetime('now', '-2 days'))", [rule, lead]);
    assert.equal(typeof db.adoptRuleHistory, 'function', 'nothing takes past runs as already fired');
    assert.equal(db.adoptRuleHistory(rule), 1);
    runRule(rule, { leadIds: [lead], now: OPEN });
    assert.equal(tasksTitled(lead, title).length, 0, 'the first sweep after the deploy acted again');
  });

  /* ============================================== the KYC waterfall */

  await test('the seeded waterfall is staged, service-only, and holds while a case is open', async () => {
    assert(waterfall, 'the seeded waterfall is missing');
    const conditions = JSON.parse(waterfall.conditions);
    const actions = JSON.parse(waterfall.actions);
    assert(conditions.some((c) => c.field === 'kyc_on_hold' && String(c.value) === 'false'), 'no hold on an open High or Critical case');
    const wa = actions.find((a) => a.type === 'whatsapp');
    const sms = actions.find((a) => a.type === 'sms');
    assert.equal(wa?.params?.intent, 'service');
    assert(!(Number(wa.after_minutes) > 0), 'the WhatsApp is delayed');
    assert.equal(sms?.params?.intent, 'service');
    assert.equal(Number(sms?.after_minutes), 30);
    assert(one("SELECT id FROM rules WHERE name = 'KYC abandoned → assisted completion' AND enabled = 1"), 'nothing turns an abandoned journey into a task');
  });

  await test('the waterfall sends one WhatsApp per stall, and none while a High case is open', async () => {
    run('UPDATE rules SET enabled = 0 WHERE id = ?', [waterfall.id]);
    const product = one("SELECT id FROM product_types WHERE sales_org = 'BONANZA' AND requires_kyc = 1 ORDER BY id LIMIT 1");
    const stalled = (lead) => {
      const card = Number(run("INSERT INTO product_cards (lead_id, product_type_id, state) VALUES (?, ?, 'KYC_IN_PROGRESS')", [lead, product.id]).lastInsertRowid);
      // A journey with no step in progress has no clock, so the KYC sweep leaves it as it is.
      run("INSERT INTO kyc_journeys (lead_id, card_id, product_type_id, status, current_step) VALUES (?, ?, ?, 'Stalled', 'BANK')", [lead, card, product.id]);
      return card;
    };
    const whatsapps = (lead) => one("SELECT COUNT(*) n FROM activities WHERE lead_id = ? AND type = 'WhatsApp'", [lead]).n;

    const lead = seedLead({ source: `${SOURCE}-kyc` });
    stalled(lead);
    for (let i = 0; i < 10; i += 1) runRule(waterfall.id, { leadIds: [lead], now: at(OPEN, i * 5) });
    assert.equal(whatsapps(lead), 1, `${whatsapps(lead)} WhatsApps for one stall`);

    const held = seedLead({ source: `${SOURCE}-kyc` });
    const card = stalled(held);
    run("INSERT INTO tickets (subject, status, priority, sales_org, card_id, lead_id) VALUES (?, 'Open', 'High', 'BONANZA', ?, ?)",
      [`${MARK} complaint`, card, held]);
    runRule(waterfall.id, { leadIds: [held], now: OPEN });
    assert.equal(whatsapps(held), 0, 'the applicant was messaged over an open High case');
  });

  /* ============================================== retention, and the duplicates */

  await test('automation runs are a log kept 90 days, and older rows are purged', async () => {
    const kind = LOG_KINDS.find((k) => k.source === 'rule_runs');
    assert(kind, 'rule_runs has no retention period');
    assert.equal(retention().find((k) => k.kind === kind.kind)?.days, 90);
    const lead = seedLead();
    const rule = makeRule([taskAction(`${MARK} purge`)]);
    run("INSERT INTO rule_runs (rule_id, lead_id, dry_run, matched, detail, created_at) VALUES (?, ?, 0, 1, '[]', datetime('now', '-91 days'))", [rule, lead]);
    run("INSERT INTO rule_runs (rule_id, lead_id, dry_run, matched, detail, created_at) VALUES (?, ?, 0, 1, '[]', datetime('now', '-89 days'))", [rule, lead]);
    purge();
    assert.equal(one('SELECT COUNT(*) n FROM rule_runs WHERE rule_id = ?', [rule]).n, 1, 'the purge kept the old row, or took the recent one');
  });

  await test('the duplicates script previews, then closes all but the oldest as Cancelled', async () => {
    assert(duplicates, 'there is no script to close the duplicates');
    const lead = seedLead();
    const title = 'Contact lead — warm MF card';   // a seeded rule's task title
    const ids = [1, 2, 3].map(() => Number(run(
      "INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status) VALUES (?, ?, ?, NULL, datetime('now'), 'Open')",
      [title, lead, owner.id],
    ).lastInsertRowid));
    const mine = Number(run(
      "INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, status) VALUES (?, ?, ?, ?, datetime('now'), 'Open')",
      [title, lead, owner.id, owner.id],
    ).lastInsertRowid);
    const p = duplicates.preview();
    const group = p.task_groups.find((g) => g.lead_id === lead);
    assert(group, 'the preview does not list the duplicates');
    assert.equal(group.open, 3);
    assert.equal(group.keep_id, ids[0]);
    assert.equal(one('SELECT status FROM tasks WHERE id = ?', [ids[1]]).status, 'Open', 'the preview changed something');

    duplicates.apply();
    const rows = all('SELECT id, status, cancel_reason FROM tasks WHERE id IN (?,?,?,?) ORDER BY id', [...ids, mine]);
    assert.equal(rows[0].status, 'Open', 'the oldest was closed');
    assert.equal(rows[1].status, 'Cancelled');
    assert.equal(rows[2].status, 'Cancelled');
    assert.equal(rows[1].cancel_reason, duplicates.REASON);
    assert.equal(rows[3].status, 'Open', 'a task a person made was closed');
    run('DELETE FROM tasks WHERE id IN (?,?,?,?)', [...ids, mine]);
  });
} finally {
  run('UPDATE rules SET enabled = ? WHERE id = ?', [waterfallWasEnabled, waterfall?.id ?? -1]);
  for (const l of all("SELECT id FROM leads WHERE name LIKE 'QA02 probe %'")) {
    run('DELETE FROM tickets WHERE lead_id = ?', [l.id]);
    run('DELETE FROM kyc_journeys WHERE lead_id = ?', [l.id]);
  }
  sweep();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
