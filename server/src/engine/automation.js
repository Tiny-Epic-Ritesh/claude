/**
 * Automations: a flow a lead walks through, not a rule that fires once (P3-16).
 *
 * The rules engine beside this one evaluates conditions and performs actions in
 * a single pass, then forgets. That covers "when X, do Y" and nothing else. What
 * this covers is "when X, do Y, wait two days, and if they still have not
 * replied, do Z" -- which means a lead is *inside* an automation for two days,
 * and where every lead stands is state the system has to keep.
 *
 * WHY THE POSITION IS IN THE DATABASE
 *
 * A timer in memory dies on deploy. If a lead is asleep in a Wait card when the
 * server restarts, the only record that it should ever wake up is the row in
 * `automation_run`. So a run holds its own step id and the time it is due, the
 * tick asks the database what is due, and a restart costs nothing but the time
 * between ticks.
 *
 * ONE ACTIVE RUN PER LEAD PER AUTOMATION
 *
 * The safeguard that matters most here. Bonanza's busiest LeadSquared
 * automation has fired 14 million times and the second, on Activity Added, 8.5
 * million. An automation that re-enters a lead on every activity will send that
 * lead the same message repeatedly, and the recipient is a client. A re-trigger
 * arriving while a run is live is counted and dropped.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It never picks an owner. Assignment has one home -- `engine/assignment.js` --
 * because Salesforce's rule is that one assignment rule is active at a time with
 * its ordering internal to it, and Bonanza already has three "Lead Updated"
 * automations racing on overlapping populations. An automation may hand a lead
 * to the assignment engine; it may not choose.
 */

import { all, one, run, audit } from '../db.js';
import { leadFacts, runAction } from './rules.js';
/* conditions.js exports this as `evaluate`, and rules.js exports a different
   `evaluate` for its own flat condition list. Aliased so the two cannot be
   confused at a glance -- this one takes the nested tree. */
import { evaluate as evaluateTree, toSql } from './conditions.js';

/* ------------------------------------------------------------- triggers */

/**
 * What can start an automation.
 *
 * Cross-checked against the trigger vocabulary actually in use in Bonanza's
 * LeadSquared tenant: Lead Created, Lead Updated, Activity Added, At Regular
 * Intervals, On WorkDay End and Sub Automation are all live there.
 */
export const TRIGGERS = [
  { key: 'lead.created', label: 'A lead is created', family: 'Lead' },
  {
    key: 'lead.updated',
    label: 'A lead is updated',
    family: 'Lead',
    /* Must name its fields. "Lead Updated" firing on any change at all is how
       the legacy tenant reached 8.5 million executions. */
    needs_fields: true,
  },
  { key: 'lead.stage_changed', label: 'A lead changes stage', family: 'Lead' },
  { key: 'activity.added', label: 'An activity is logged', family: 'Activity' },
  { key: 'task.created', label: 'A task is created', family: 'Task' },
  { key: 'task.overdue', label: 'A task goes overdue', family: 'Task' },
  { key: 'task.completed', label: 'A task is completed', family: 'Task' },
  {
    key: 'user.workday_end',
    label: 'A user ends their workday',
    family: 'User',
    /* Nothing enters leads for this yet, and it is not lead-shaped: a workday
       ends for a person, and deciding which of that person's leads should walk
       into a flow is a business question, not one to guess at. Marked rather
       than hidden, so the screen can say why -- and `validate` refuses to
       activate a flow that uses it, which is better than one that looks live
       and never runs. */
    unwired: 'A workday ending belongs to a person rather than to a lead, so which leads it should start has not been settled yet.',
  },
  { key: 'schedule.interval', label: 'At regular intervals', family: 'Schedule' },
  { key: 'sub', label: 'Called by another automation', family: 'Composition' },
];

const TRIGGER_KEYS = new Set(TRIGGERS.map((t) => t.key));
export const isTrigger = (key) => TRIGGER_KEYS.has(key);

/* ---------------------------------------------------------------- steps */

/**
 * The cards a flow is built from.
 *
 * `exit` is explicit rather than implied by a null `next_step_id`, because
 * "this branch ends here on purpose" and "somebody forgot to connect this" look
 * identical otherwise, and only one of them is a bug.
 */
export const STEP_KINDS = [
  { kind: 'action', label: 'Do something', exits: ['next'] },
  { kind: 'branch', label: 'If / Else', exits: ['next', 'else'] },
  { kind: 'wait', label: 'Wait a fixed time', exits: ['next'] },
  { kind: 'wait_activity', label: 'Wait for an activity', exits: ['next', 'else'] },
  { kind: 'exit', label: 'End the flow', exits: [] },
];

/* ------------------------------------------------------------ the flow */

const stepsOf = (automationId) => all(
  'SELECT * FROM automation_step WHERE automation_id = ? ORDER BY sort_order, id',
  [automationId],
);

const parse = (json, fallback) => {
  try { return JSON.parse(json ?? '') ?? fallback; } catch { return fallback; }
};

/** Write down what happened at a card, so the report can say where leads stall. */
const record = (runId, stepId, outcome, detail) => run(
  'INSERT INTO automation_run_step (run_id, step_id, outcome, detail) VALUES (?,?,?,?)',
  [runId, stepId ?? null, outcome, detail ? JSON.stringify(detail) : null],
);

/**
 * Put a lead into an automation.
 *
 * Returns null when it does not enter — already inside, entry conditions not
 * met, or the automation is not active. Every one of those is an ordinary
 * outcome rather than an error.
 */
export function enter(automationId, leadId, { force = false } = {}) {
  const auto = one('SELECT * FROM automation WHERE id = ?', [automationId]);
  if (!auto || (auto.status !== 'active' && !force)) return null;

  /* Already walking through it. Counted, not repeated. */
  const live = one(
    "SELECT id FROM automation_run WHERE automation_id = ? AND lead_id = ? AND status IN ('running','waiting')",
    [automationId, leadId],
  );
  if (live) return null;

  const facts = leadFacts(leadId);
  if (!facts) return null;

  /* The book boundary. An automation belongs to one business and must not fire
     on the other's leads -- the same rule as every other object. */
  if (facts._lead.sales_org && facts._lead.sales_org !== auto.sales_org) return null;

  const conditions = parse(auto.entry_conditions, null);
  if (conditions && !evaluateTree(conditions, facts)) return null;

  const info = run(
    'INSERT INTO automation_run (automation_id, lead_id, step_id, status) VALUES (?,?,?,?)',
    [automationId, leadId, auto.first_step_id ?? null, 'running'],
  );
  const runId = Number(info.lastInsertRowid);
  record(runId, null, 'entered');

  return advance(runId);
}

/**
 * Walk a run forward until it stops.
 *
 * It stops for exactly three reasons: it hit a Wait, it reached an exit, or a
 * step failed. Anything else and it keeps going, so a flow of ten actions
 * completes in one pass rather than ten ticks.
 *
 * The step budget is not paranoia. A branch whose two exits point back above it
 * is a loop, and a loop in a flow that sends WhatsApp messages is a loop that
 * sends a client WhatsApp messages until somebody notices.
 */
export function advance(runId, { budget = 50 } = {}) {
  let r = one('SELECT * FROM automation_run WHERE id = ?', [runId]);
  if (!r || !['running', 'waiting'].includes(r.status)) return r;

  const steps = new Map(stepsOf(r.automation_id).map((s) => [s.id, s]));
  let spent = 0;

  while (spent < budget) {
    spent += 1;

    if (!r.step_id) return finish(runId, 'done');

    const step = steps.get(r.step_id);
    if (!step) {
      /* The flow points at a card that is not there -- deleted mid-flight. Fail
         loudly rather than treating it as the end. */
      return finish(runId, 'failed', { error: `step ${r.step_id} no longer exists` });
    }

    const facts = leadFacts(r.lead_id);
    if (!facts) return finish(runId, 'exited', { reason: 'the lead is gone' });

    const config = parse(step.config, {});

    switch (step.kind) {
      case 'exit':
        record(runId, step.id, 'exited', config.reason ? { reason: config.reason } : null);
        return finish(runId, 'exited', config.reason ? { reason: config.reason } : null);

      case 'branch': {
        const met = config.conditions ? evaluateTree(config.conditions, facts) : false;
        record(runId, step.id, 'branched', { met });
        r = move(runId, met ? step.next_step_id : step.else_step_id);
        break;
      }

      case 'wait': {
        /* The offset is stored, not the wake time, so a flow edited while leads
           are asleep inside it does not silently reschedule them. */
        const hours = Number(config.hours) || 0;
        const minutes = Number(config.minutes) || 0;
        run(
          "UPDATE automation_run SET status = 'waiting', resume_at = datetime('now', ?), step_id = ? WHERE id = ?",
          [`+${hours * 60 + minutes} minutes`, step.next_step_id ?? null, runId],
        );
        record(runId, step.id, 'waited', { hours, minutes });
        return one('SELECT * FROM automation_run WHERE id = ?', [runId]);
      }

      case 'wait_activity': {
        /* Every wait-for needs a giving-up arm, or a lead who never replies
           stays inside the automation for ever and the report counts them as
           active work. */
        const hours = Number(config.timeout_hours) || 72;
        run(
          `UPDATE automation_run SET status = 'waiting', resume_at = datetime('now', ?),
                  step_id = ?, wait_for = ? WHERE id = ?`,
          [`+${hours} hours`, step.id, JSON.stringify({
            activity_type: config.activity_type ?? null,
            since: new Date().toISOString().slice(0, 19).replace('T', ' '),
            on_timeout: step.else_step_id ?? null,
            on_seen: step.next_step_id ?? null,
          }), runId],
        );
        record(runId, step.id, 'waited', { for: config.activity_type ?? 'any activity', timeout_hours: hours });
        return one('SELECT * FROM automation_run WHERE id = ?', [runId]);
      }

      case 'action': {
        try {
          /* Composition is performed here rather than in rules.js: it puts the
             lead into another flow, and a flat rule has no flow to put it into.
             (rules.js already imports this file; importing it back would make
             the pair circular.)

             No recursion guard is needed. A calling B calling A is stopped by
             the invariant that matters most in this file -- a lead inside a
             live run cannot enter that automation again. A's run is still
             running when B asks, so enter() declines and the chain ends. */
          if (config.type === 'sub_automation') {
            record(runId, step.id, ...subAutomation(r, config.params ?? {}));
            r = move(runId, step.next_step_id);
            break;
          }

          const out = runAction({ type: config.type, params: config.params ?? {} }, facts, { dryRun: false });

          /* runAction returns `skipped` rather than throwing for an action type
             it does not know. That is right for the rules engine, which should
             not break a run over one bad row -- but in a flow it means a card
             somebody configured does nothing at all, silently, for ever. Here
             it is a failure, so the report names it. */
          if (out?.skipped) {
            record(runId, step.id, 'failed', { error: out.skipped, action: config.type });
          } else {
            record(runId, step.id, 'done', out);
          }
        } catch (err) {
          /* One dead template does not abort the flow, for the same reason the
             rules engine captures rather than throws: a failure that stops
             everything behind it is worse than a failure that is written down. */
          record(runId, step.id, 'failed', { error: err.message, action: config.type });
          run(
            `INSERT INTO rule_failures (rule_id, lead_id, action_type, error, payload)
             VALUES (NULL,?,?,?,?)`,
            [r.lead_id, config.type ?? 'unknown', err.message, JSON.stringify(config.params ?? {})],
          );
        }
        r = move(runId, step.next_step_id);
        break;
      }

      default:
        return finish(runId, 'failed', { error: `unknown step kind "${step.kind}"` });
    }

    if (!r) return one('SELECT * FROM automation_run WHERE id = ?', [runId]);
  }

  /* Out of budget: this flow loops. Stopping it is the kind thing. */
  return finish(runId, 'failed', { error: `stopped after ${budget} steps — the flow appears to loop` });
}

/**
 * Hand the lead to another flow.
 *
 * Returns the pair `record()` wants — outcome and detail — so the caller reads
 * as one line. Declining is an ordinary outcome, not a failure: a lead already
 * inside that automation is exactly what the one-run-per-lead rule is for, and
 * saying so is more use in the report than a bare "done".
 */
function subAutomation(r, params) {
  const subId = Number(params.automation_id);
  const sub = subId ? one('SELECT * FROM automation WHERE id = ?', [subId]) : null;
  const parentOrg = one('SELECT sales_org FROM automation WHERE id = ?', [r.automation_id])?.sales_org;

  const problem = !sub ? 'that sub-automation does not exist'
    : sub.id === r.automation_id ? 'an automation cannot call itself'
      : sub.status !== 'active' ? `${sub.name} is not active`
        : sub.sales_org !== parentOrg ? `${sub.name} belongs to another book`
          : null;

  if (problem) return ['failed', { error: problem, action: 'sub_automation' }];

  const child = enter(sub.id, r.lead_id);
  return ['done', {
    action: 'sub_automation',
    automation_id: sub.id,
    entered: Boolean(child),
    note: child ? null : 'the lead was already inside that automation',
  }];
}

const move = (runId, toStepId) => {
  run('UPDATE automation_run SET step_id = ? WHERE id = ?', [toStepId ?? null, runId]);
  return one('SELECT * FROM automation_run WHERE id = ?', [runId]);
};

function finish(runId, status, detail) {
  run(
    "UPDATE automation_run SET status = ?, step_id = NULL, resume_at = NULL, finished_at = datetime('now'), detail = ? WHERE id = ?",
    [status, detail ? JSON.stringify(detail) : null, runId],
  );
  return one('SELECT * FROM automation_run WHERE id = ?', [runId]);
}

/* -------------------------------------------------------------- the tick */

/**
 * Wake everything that is due.
 *
 * Called on the server's timer. Everything it needs is in the database, so a
 * restart loses nothing but the seconds since the last tick.
 */
export function tick({ limit = 200 } = {}) {
  /* Detect first, then resume. A lead that entered this tick and has nothing to
     wait for should finish in this tick rather than the next one. */
  const fired = detect();

  const due = all(
    "SELECT * FROM automation_run WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= datetime('now') ORDER BY resume_at LIMIT ?",
    [limit],
  );

  let resumed = 0;
  for (const r of due) {
    const waitFor = parse(r.wait_for, null);

    if (waitFor) {
      /* A wait-for-activity that came due: did the thing happen, or did we give
         up? Both are real answers and they take different exits. */
      const seen = one(
        `SELECT id FROM activities WHERE lead_id = ? AND created_at > ?
           ${waitFor.activity_type ? 'AND type = ?' : ''} LIMIT 1`,
        waitFor.activity_type ? [r.lead_id, waitFor.since, waitFor.activity_type] : [r.lead_id, waitFor.since],
      );
      const to = seen ? waitFor.on_seen : waitFor.on_timeout;
      record(r.id, r.step_id, 'resumed', { seen: Boolean(seen) });
      run("UPDATE automation_run SET status = 'running', resume_at = NULL, wait_for = NULL, step_id = ? WHERE id = ?", [to ?? null, r.id]);
    } else {
      record(r.id, r.step_id, 'resumed');
      run("UPDATE automation_run SET status = 'running', resume_at = NULL WHERE id = ?", [r.id]);
    }

    advance(r.id);
    resumed += 1;
  }

  return { resumed, fired };
}

/**
 * Something happened; start whatever was waiting for it.
 *
 * Automations are taken in priority order so that two watching the same event
 * run in a stated sequence rather than by row id -- non-negotiable 12, and the
 * race the audit found in the legacy tenant.
 */
export function fire(triggerKey, { leadId, fields = [] } = {}) {
  if (!isTrigger(triggerKey) || !leadId) return { entered: 0 };

  const candidates = all(
    "SELECT * FROM automation WHERE status = 'active' AND trigger_type = ? ORDER BY priority, id",
    [triggerKey],
  );

  let entered = 0;
  for (const auto of candidates) {
    const config = parse(auto.trigger_config, {});

    /* A field-watching trigger only fires for the fields it named. */
    if (config.fields?.length && fields.length
        && !config.fields.some((f) => fields.includes(f))) continue;

    if (enter(auto.id, leadId)) entered += 1;
  }

  return { entered };
}

/* ----------------------------------------------------------- validation */

/**
 * Everything wrong with an automation, before it is allowed to run.
 *
 * Activating a broken flow is not like saving a broken draft. A card wired to
 * nothing silently ends the flow there; a loop sends a client the same message
 * until somebody notices; a wait with no next step parks leads for ever and the
 * report counts them as live work. All three look fine on a canvas.
 *
 * Returns every problem rather than the first, for the same reason the template
 * builder does: being told about one, fixing it, and being told about the next
 * is how a screen becomes something people work around.
 */
export function validate(automationId) {
  const auto = one('SELECT * FROM automation WHERE id = ?', [automationId]);
  if (!auto) return [{ message: 'That automation does not exist' }];

  const problems = [];
  const steps = stepsOf(automationId);
  const byId = new Map(steps.map((s) => [s.id, s]));

  if (!isTrigger(auto.trigger_type)) {
    problems.push({ field: 'trigger', message: `"${auto.trigger_type}" is not a trigger` });
  }

  /* A trigger nothing fires is a flow that looks live and never runs, which is
     the worst of the three possible states -- worse than a draft, and worse
     than a refusal, because nobody goes looking for it. */
  const unwired = TRIGGERS.find((t) => t.key === auto.trigger_type)?.unwired;
  if (unwired) problems.push({ field: 'trigger', message: unwired });

  /* A field-watching trigger with no fields watches everything, which is the
     8.5-million-executions shape. */
  const trigger = TRIGGERS.find((t) => t.key === auto.trigger_type);
  if (trigger?.needs_fields) {
    const config = parse(auto.trigger_config, {});
    if (!config.fields?.length) {
      problems.push({
        field: 'trigger',
        message: 'Name the fields this watches. A lead-updated trigger with no fields fires on every change to every lead.',
      });
    }
  }

  if (!steps.length) {
    problems.push({ field: 'steps', message: 'An automation with no steps does nothing' });
    return problems;
  }

  if (!auto.first_step_id || !byId.has(auto.first_step_id)) {
    problems.push({ field: 'steps', message: 'Nothing is marked as the first step' });
  }

  for (const step of steps) {
    const kind = STEP_KINDS.find((k) => k.kind === step.kind);
    if (!kind) {
      problems.push({ step_id: step.id, message: `"${step.kind}" is not a kind of step` });
      continue;
    }

    /* A dangling exit ends the flow there, which is either deliberate or a
       mistake — and an `exit` card is how you say deliberate. */
    for (const exit of kind.exits) {
      const target = exit === 'next' ? step.next_step_id : step.else_step_id;
      if (target && !byId.has(target)) {
        problems.push({ step_id: step.id, message: `${step.label || step.kind}: its ${exit} path points at a step that no longer exists` });
      }
      if (!target) {
        problems.push({
          step_id: step.id,
          message: `${step.label || step.kind}: nothing follows its ${exit} path. Add an End card if that is deliberate.`,
        });
      }
    }

    const config = parse(step.config, {});
    if (step.kind === 'action' && !config.type) {
      problems.push({ step_id: step.id, message: 'An action card with no action does nothing' });
    }
    if (step.kind === 'branch' && !config.conditions) {
      problems.push({ step_id: step.id, message: 'A branch with no condition always takes the same path' });
    }
    if (step.kind === 'wait' && !Number(config.hours) && !Number(config.minutes)) {
      problems.push({ step_id: step.id, message: 'A wait of zero is not a wait' });
    }

    /* A sub-automation card is checked here rather than left to fail at run
       time, because it is the one action whose target can be deleted, paused or
       moved to the other book long after the flow was built — and a flow that
       hands leads to nothing looks, on the canvas, exactly like one that works. */
    if (step.kind === 'action' && config.type === 'sub_automation') {
      const subId = Number(config.params?.automation_id);
      const sub = subId ? one('SELECT id, name, status, sales_org FROM automation WHERE id = ?', [subId]) : null;
      const label = step.label || 'Sub-automation';

      if (!sub) {
        problems.push({ step_id: step.id, message: `${label}: no sub-automation is chosen, or the one chosen has been deleted` });
      } else if (sub.id === auto.id) {
        problems.push({ step_id: step.id, message: `${label}: an automation cannot call itself` });
      } else if (sub.sales_org !== auto.sales_org) {
        problems.push({ step_id: step.id, message: `${label}: ${sub.name} belongs to another book` });
      } else if (sub.status !== 'active') {
        problems.push({ step_id: step.id, message: `${label}: ${sub.name} is ${sub.status}, so leads sent to it would go nowhere` });
      }
    }
  }

  /* Walk it for a cycle. A loop is the one problem that cannot be seen by
     looking at a single card. */
  const seen = new Set();
  let cursor = auto.first_step_id;
  while (cursor && byId.has(cursor)) {
    if (seen.has(cursor)) {
      problems.push({ step_id: cursor, message: 'These steps loop back on themselves — a lead would never leave' });
      break;
    }
    seen.add(cursor);
    cursor = byId.get(cursor).next_step_id;
  }

  return problems;
}

/* ------------------------------------------------------------- detection */

/**
 * Where the scanner has read up to, and where it should start.
 *
 * A watermark it has never seen starts at the current maximum, not at zero.
 * Starting at zero would treat every one of the existing leads as new and enter
 * all of them into every automation — the worst thing this file could do, and
 * it would be done at three in the morning by a timer.
 */
function watermark(trigger, currentMax) {
  const row = one('SELECT last_id FROM automation_watermark WHERE trigger_type = ?', [trigger]);
  if (row) return row.last_id;

  run('INSERT INTO automation_watermark (trigger_type, last_id, checked_at) VALUES (?,?,datetime(\'now\'))',
    [trigger, currentMax]);
  return currentMax;
}

const setWatermark = (trigger, id) => run(
  "UPDATE automation_watermark SET last_id = ?, checked_at = datetime('now') WHERE trigger_type = ?",
  [id, trigger],
);

/**
 * Ask the database what has happened since the last look, and fire for it.
 *
 * Batched so one quiet minute costs two queries and a busy one cannot enter ten
 * thousand leads in a single tick — the cap is the same kind of brake as the
 * step budget, and for the same reason.
 */
export function detect({ batch = 500 } = {}) {
  const fired = {};

  const sweep = (trigger, sql, rowToEvent) => {
    const max = one(sql.max)?.n ?? 0;
    const from = watermark(trigger, max);
    if (max <= from) return;

    const rows = all(sql.since, [from, batch]);
    let entered = 0;
    for (const row of rows) {
      const event = rowToEvent(row);
      if (event?.leadId) entered += fire(trigger, event).entered;
    }
    setWatermark(trigger, rows.length ? rows[rows.length - 1].id : max);
    if (entered) fired[trigger] = (fired[trigger] ?? 0) + entered;
  };

  /* A lead arriving, from anywhere: the form, the importer, the Meta webhook,
     the KYC portal. None of them has to know this exists. */
  sweep('lead.created', {
    max: 'SELECT MAX(id) AS n FROM leads',
    since: 'SELECT id FROM leads WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ?',
  }, (r) => ({ leadId: r.id }));

  sweep('activity.added', {
    max: 'SELECT MAX(id) AS n FROM activities',
    since: 'SELECT id, lead_id FROM activities WHERE id > ? AND lead_id IS NOT NULL ORDER BY id LIMIT ?',
  }, (r) => ({ leadId: r.lead_id }));

  /* Field changes come from field_history rather than from a diff we compute:
     it already records every change with its old and new value, whoever made
     it and by whatever route. */
  sweep('lead.updated', {
    max: "SELECT MAX(id) AS n FROM field_history WHERE entity = 'lead'",
    since: "SELECT id, record_id, field FROM field_history WHERE entity = 'lead' AND id > ? ORDER BY id LIMIT ?",
  }, (r) => ({ leadId: r.record_id, fields: [r.field] }));

  sweep('lead.stage_changed', {
    max: "SELECT MAX(id) AS n FROM field_history WHERE entity = 'lead' AND field = 'stage'",
    since: "SELECT id, record_id FROM field_history WHERE entity = 'lead' AND field = 'stage' AND id > ? ORDER BY id LIMIT ?",
  }, (r) => ({ leadId: r.record_id }));

  sweep('task.created', {
    max: 'SELECT MAX(id) AS n FROM tasks',
    since: 'SELECT id, lead_id FROM tasks WHERE id > ? AND lead_id IS NOT NULL ORDER BY id LIMIT ?',
  }, (r) => ({ leadId: r.lead_id }));

  /* Clock-shaped, not row-shaped: a task does not become overdue by being
     inserted, so there is no larger id to look for. */
  sweepSince('task.overdue', (from) => all(
    `SELECT lead_id FROM tasks
      WHERE lead_id IS NOT NULL AND status NOT IN ('Done', 'Completed', 'Cancelled')
        AND due_at IS NOT NULL AND due_at > ? AND due_at <= datetime('now')
      ORDER BY due_at LIMIT ?`,
    [from, batch],
  ));

  sweepSince('task.completed', (from) => all(
    `SELECT lead_id FROM tasks
      WHERE lead_id IS NOT NULL AND status IN ('Done', 'Completed')
        AND updated_at > ? AND updated_at <= datetime('now')
      ORDER BY updated_at LIMIT ?`,
    [from, batch],
  ));

  const onSchedule = interval({ batch });
  if (onSchedule) fired['schedule.interval'] = onSchedule;

  return fired;

  /* ---- the two shapes above, as functions, kept close to their callers ---- */

  /**
   * Fire for everything that happened between the last look and now.
   *
   * The window is (checked_at, now]: open at the start so nothing is counted
   * twice, closed at the end so a row landing exactly on the boundary is
   * counted once rather than never.
   */
  function sweepSince(trigger, rowsSince) {
    const now = one("SELECT datetime('now') AS t").t;
    const mark = one('SELECT checked_at FROM automation_watermark WHERE trigger_type = ?', [trigger]);

    if (!mark) {
      /* First sight starts here, not at the beginning of time -- the same
         reason the id watermarks do. Every task that ever went overdue is not
         news. */
      run(
        'INSERT INTO automation_watermark (trigger_type, last_id, checked_at) VALUES (?,0,?)',
        [trigger, now],
      );
      return;
    }

    let entered = 0;
    for (const row of rowsSince(mark.checked_at)) {
      if (row.lead_id) entered += fire(trigger, { leadId: row.lead_id }).entered;
    }
    run('UPDATE automation_watermark SET checked_at = ? WHERE trigger_type = ?', [now, trigger]);
    if (entered) fired[trigger] = (fired[trigger] ?? 0) + entered;
  }
}

/**
 * "At regular intervals": every so often, run this on everyone who matches.
 *
 * Not a scan. The entry conditions are compiled to SQL -- the builder writes
 * registry field names, which is exactly what `toSql` takes -- so the database
 * returns the leads that match and nobody else, already excluding anyone inside
 * a live run of the same automation. Capped, and continued from a cursor, so a
 * large population is worked through over successive runs instead of the first
 * batch being re-examined for ever.
 *
 * `enter()` still applies the conditions in JavaScript, so the SQL is a
 * narrowing and never the authority. A condition it cannot compile becomes
 * `1=0` and matches nobody, which is the safe direction to fail in.
 */
function interval({ batch = 500 } = {}) {
  const due = all(
    "SELECT * FROM automation WHERE status = 'active' AND trigger_type = 'schedule.interval' ORDER BY priority, id",
  );
  if (!due.length) return 0;

  let entered = 0;

  for (const auto of due) {
    const config = parse(auto.trigger_config, {});
    const hours = Number(config.every_hours) || 24;
    const key = `schedule.interval:${auto.id}`;

    const mark = one('SELECT last_id, checked_at FROM automation_watermark WHERE trigger_type = ?', [key]);
    if (!mark) {
      /* Registered as due now rather than at the beginning of time, so turning
         an automation on does not immediately sweep the whole book. */
      run(
        "INSERT INTO automation_watermark (trigger_type, last_id, checked_at) VALUES (?,0,datetime('now'))",
        [key],
      );
      continue;
    }

    const isDue = one(
      "SELECT datetime(?, ?) <= datetime('now') AS due",
      [mark.checked_at, `+${hours} hours`],
    )?.due;
    if (!isDue) continue;

    const where = toSql(parse(auto.entry_conditions, null));
    const rows = all(
      `SELECT l.id FROM leads l
        WHERE l.deleted_at IS NULL AND l.sales_org = ? AND l.id > ? AND (${where.sql})
          AND NOT EXISTS (
            SELECT 1 FROM automation_run r
             WHERE r.automation_id = ? AND r.lead_id = l.id AND r.status IN ('running','waiting')
          )
        ORDER BY l.id LIMIT ?`,
      [auto.sales_org, mark.last_id, ...where.params, auto.id, batch],
    );

    for (const row of rows) if (enter(auto.id, row.id)) entered += 1;

    /* A short batch means the end of the book: start again from the top next
       time, so a lead that became eligible after the cursor passed it is not
       waiting for ever. */
    const next = rows.length === batch ? rows[rows.length - 1].id : 0;
    run(
      "UPDATE automation_watermark SET last_id = ?, checked_at = datetime('now') WHERE trigger_type = ?",
      [next, key],
    );
  }

  return entered;
}

/* ------------------------------------------------------------ reporting */

/**
 * How an automation is doing, per step as well as overall.
 *
 * Per step because "1,000 entered and 40 finished" is only useful if you can
 * see which card the other 960 are standing on.
 */
export function report(automationId) {
  const counts = all(
    'SELECT status, COUNT(*) AS n FROM automation_run WHERE automation_id = ? GROUP BY status',
    [automationId],
  ).reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  const waitingAt = all(
    `SELECT s.id, s.kind, s.label, COUNT(*) AS n
       FROM automation_run r JOIN automation_step s ON s.id = r.step_id
      WHERE r.automation_id = ? AND r.status = 'waiting'
      GROUP BY s.id ORDER BY n DESC`,
    [automationId],
  );

  const failures = all(
    `SELECT rs.step_id, rs.detail, COUNT(*) AS n
       FROM automation_run_step rs JOIN automation_run r ON r.id = rs.run_id
      WHERE r.automation_id = ? AND rs.outcome = 'failed'
      GROUP BY rs.step_id ORDER BY n DESC LIMIT 10`,
    [automationId],
  );

  return {
    entered: Object.values(counts).reduce((a, b) => a + b, 0),
    running: counts.running ?? 0,
    waiting: counts.waiting ?? 0,
    completed: counts.done ?? 0,
    exited: counts.exited ?? 0,
    failed: counts.failed ?? 0,
    waiting_at: waitingAt,
    failures,
  };
}

/**
 * Everything that fires on a lead, in the order it would run.
 *
 * The Salesforce reference calls this a Flow Trigger Explorer and names its
 * absence as the reason nobody can see what touches a field in the legacy
 * tenant. It is cheap to provide and it is the screen somebody opens when an
 * automation does something surprising.
 */
export const whatRunsOn = (triggerKey) => all(
  `SELECT id, name, status, priority, trigger_config
     FROM automation WHERE trigger_type = ? ORDER BY priority, id`,
  [triggerKey],
);
