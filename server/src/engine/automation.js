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
import { evaluate as evaluateTree } from './conditions.js';

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
  { key: 'user.workday_end', label: 'A user ends their workday', family: 'User' },
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

  return { resumed };
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
