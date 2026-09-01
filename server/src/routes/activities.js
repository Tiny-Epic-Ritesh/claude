/**
 * Activity capture — the screen a sales desk uses more than any other.
 *
 * THE FLOW THIS IMPLEMENTS
 * ------------------------
 *   RM calls  →  logs a Call activity
 *             →  picks outcome (Connected / Not Connected)
 *             →  picks sub-disposition (Pitch Done, Callback Requested…)
 *             →  the sub-disposition decides what is REQUIRED next
 *             →  saving creates that next step as a dated, owned, reminded task
 *
 * The obligation is enforced here, not in the browser. "Callback Requested"
 * without a date/time is rejected by the API, because a validation that only
 * lives in the UI is a validation that a stale tab, a retry or a direct API
 * call walks straight past — and the entire value of this module rests on the
 * follow-up actually existing.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { requireUser, requirePermission, reqScope } from '../auth.js';
import { validate } from '../security.js';
import { applyScore } from '../engine/rules.js';
import { applyFieldSecurity } from '../engine/metadata.js';
import {
  dispositionsFor, validateDisposition, nextStepAt, applyEffects, dispositionByCode,
} from '../engine/dispositions.js';
import {
  createFollowUp, followUpBoard, cancelReminders, scheduleReminders, withinBusinessHours,
} from '../engine/followups.js';
import * as geolocation from '../engine/geolocation.js';

const router = Router();
router.use(requireUser);

/** Activity types an RM may log by hand. */
export const MANUAL_TYPES = ['Call', 'Meeting', 'WhatsApp', 'Email', 'SMS', 'Visit', 'Note'];

/* ------------------------------------------------------------- metadata */

/**
 * Everything the capture form needs to render itself.
 * Served rather than hard-coded so an administrator can retire a disposition
 * and have every client pick it up on next load.
 */
router.get('/meta', (_req, res) => {
  res.json({
    types: MANUAL_TYPES,
    dispositions: Object.fromEntries(
      MANUAL_TYPES.map((t) => [t, dispositionsFor(t)]).filter(([, groups]) => groups.length),
    ),
    meeting_modes: ['Physical', 'Virtual', 'Branch Visit'],
    sentiments: ['Positive', 'Neutral', 'Negative'],
    /* P2-01. The form asks for a position only when told to, and shows the
       notice while it asks. One wording, served from one place, rather than
       each screen inventing its own -- notice is a DPDP requirement and it is
       also just fair. */
    geolocation: {
      enabled: geolocation.isEnabled(),
      modes: [...geolocation.PHYSICAL_MODES],
      notice: geolocation.notice(),
    },
  });
});

/* -------------------------------------------------------------- reading */

/** The timeline for one lead, newest first. */
router.get('/lead/:id', (req, res) => {
  const scope = reqScope(req, 'l');
  const lead = one(
    `SELECT l.id FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL AND ${scope.sql}`,
    [req.params.id, ...scope.params],
  );
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const rows = all(
    `SELECT a.*, u.name AS user_name, u.role AS user_role,
            pt.name AS product_name, pt.code AS product_code,
            t.due_at AS follow_up_due, t.status AS follow_up_status
     FROM activities a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN product_cards pc ON pc.id = a.card_id
     LEFT JOIN product_types pt ON pt.id = pc.product_type_id
     LEFT JOIN tasks t ON t.id = a.follow_up_task_id
     WHERE a.lead_id = ?
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ?`,
    [req.params.id, Number(req.query.limit) || 100],
  );

  // The interaction split: everyone who can see the lead sees that a call
  // happened and how it went; the notes body, the reason and the recording
  // need ownership or supervision.
  return res.json(applyFieldSecurity('interaction', rows, req.user, { caps: req.caps }));
});

/** The signed-in RM's follow-up board — overdue, today, upcoming. */
router.get('/follow-ups', (req, res) => res.json(followUpBoard(req.user.id)));

/* -------------------------------------------------------------- writing */

/**
 * Log an activity.
 *
 * One endpoint for every type. The disposition decides what else is required
 * and what happens next, so adding an outcome later needs no new route.
 */
router.post('/', requirePermission('lead.contact'), (req, res) => {
  const {
    lead_id, card_id, type, direction = 'outbound', subject, body,
    disposition: code, duration_s, sentiment,
    follow_up_at, meeting_at, meeting_mode, meeting_location, reason,
    geo = null,
    respect_business_hours = true,
  } = req.body;

  const invalid = validate(req.body, { type: ['required'], subject: ['max:200'] });
  if (invalid) return res.status(400).json(invalid);

  if (!MANUAL_TYPES.includes(type)) {
    return res.status(400).json({ error: `"${type}" is not an activity a user can log` });
  }

  // The lead must be one this caller can actually see.
  const scope = reqScope(req, 'l');
  const lead = one(
    `SELECT l.* FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL AND ${scope.sql}`,
    [lead_id, ...scope.params],
  );
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // A disposition is mandatory on contact activities — an untagged call is a
  // call nobody can report on, and it leaves the pipeline unmeasurable.
  const needsDisposition = ['Call', 'Meeting', 'WhatsApp'].includes(type);
  if (needsDisposition && !code) {
    return res.status(400).json({ error: `A ${type} activity needs an outcome`, field: 'disposition' });
  }

  let disposition = null;
  if (code) {
    const check = validateDisposition(code, req.body);
    if (!check.ok) return res.status(400).json({ error: 'This outcome needs more detail', fields: check.errors });
    disposition = check.disposition;

    if (disposition.activity_type !== type) {
      return res.status(400).json({ error: `"${disposition.label}" is not an outcome for a ${type}` });
    }
  }

  /* ---- write the activity ---- */

  const result = run(
    `INSERT INTO activities
       (lead_id, card_id, type, direction, subject, body, outcome, duration_s, user_id,
        disposition, sub_disposition, follow_up_at, meeting_at, meeting_mode,
        meeting_location, reason, sentiment,
        geo_status, geo_lat, geo_lng, geo_accuracy_m, geo_address, geo_captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      lead.id, card_id ?? null, type, direction,
      subject || disposition?.label || type,
      body ?? null,
      disposition?.outcome ?? null,
      Number(duration_s) || 0,
      req.user.id,
      disposition?.outcome ?? null,
      disposition?.label ?? null,
      follow_up_at ?? null,
      meeting_at ?? null,
      meeting_mode ?? null,
      meeting_location ?? null,
      reason ?? null,
      sentiment ?? null,
      /* P2-01. Only for a meeting held in person, and only when Compliance has
         turned the capture on. `wants()` answers both questions, so a refusal
         on a phone call is not even asked for -- and every outcome, including
         a refusal, is stored as a value rather than blocking the save. */
      ...(geolocation.wants(type, meeting_mode)
        ? (() => {
          const g = geolocation.normalise(geo ?? { status: 'unavailable' });
          return [g.status, g.lat, g.lng, g.accuracy_m, g.address, new Date().toISOString()];
        })()
        : [null, null, null, null, null, null]),
    ],
  );
  const activityId = Number(result.lastInsertRowid);

  /* ---- score, effects, next step ---- */

  const scoreDelta = applyScore(lead.id, type, disposition?.score_delta ?? 0);

  const effects = disposition
    ? applyEffects({
      disposition, leadId: lead.id, cardId: card_id, userId: req.user.id, reason,
    })
    : [];

  // Speed to first contact — recorded once, on the first outbound touch.
  if (!lead.first_response_at && direction === 'outbound') {
    run("UPDATE leads SET first_response_at = datetime('now') WHERE id = ?", [lead.id]);
  }

  let followUp = null;
  if (disposition && disposition.next_step && disposition.next_step !== 'none') {
    const dueAt = nextStepAt(disposition, req.body);
    if (dueAt) {
      followUp = createFollowUp({
        leadId: lead.id,
        cardId: card_id,
        userId: req.user.id,
        activityId,
        kind: disposition.next_step,
        dueAt,
        note: body || disposition.label,
        // When the client named the time, honour it exactly. Only our own
        // automatic retries get nudged into office hours.
        respectHours: respect_business_hours && !disposition.requires_datetime,
      });
    }
  }

  run("UPDATE leads SET updated_at = datetime('now') WHERE id = ?", [lead.id]);
  audit(req.user.id, 'activity_logged', 'lead', lead.id, {
    type, disposition: disposition?.code ?? null, follow_up: followUp?.due_at ?? null,
  });

  return res.status(201).json({
    activity: one('SELECT * FROM activities WHERE id = ?', [activityId]),
    follow_up: followUp,
    effects,
    score_delta: scoreDelta,
    // The rep should see exactly what the system committed them to.
    confirmation: followUp
      ? `${followUp.title} — ${followUp.due_at}`
      : 'Logged. No follow-up was required for this outcome.',
  });
});

/**
 * Reschedule a follow-up.
 *
 * The old reminders are cancelled and a fresh set scheduled against the new
 * time. Cancelling without rescheduling would leave a live commitment that
 * nothing chases, which is precisely the failure this module exists to prevent.
 */
router.patch('/follow-ups/:taskId', requirePermission('lead.contact'), (req, res) => {
  const task = one('SELECT * FROM tasks WHERE id = ?', [req.params.taskId]);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const mayReschedule = task.assignee_id === req.user.id
    || ['sales_supervisor', 'product_supervisor', 'admin', 'superadmin'].includes(req.user.role);
  if (!mayReschedule) {
    return res.status(403).json({ error: 'You can only reschedule your own follow-ups' });
  }

  const { due_at: dueAt, note } = req.body;
  if (!dueAt || Number.isNaN(Date.parse(dueAt))) {
    return res.status(400).json({ error: 'A valid new date and time is required', field: 'due_at' });
  }
  if (new Date(dueAt).getTime() < Date.now() - 60_000) {
    return res.status(400).json({ error: 'That is in the past — pick a future date and time', field: 'due_at' });
  }

  cancelReminders(task.id, 'rescheduled');

  const when = withinBusinessHours(dueAt);
  run(
    "UPDATE tasks SET due_at = ?, description = COALESCE(?, description), updated_at = datetime('now') WHERE id = ?",
    [when, note ?? null, task.id],
  );
  run(
    `UPDATE leads SET next_follow_up_at = (
       SELECT MIN(due_at) FROM tasks WHERE lead_id = ? AND status = 'Open'
     ) WHERE id = ?`,
    [task.lead_id, task.lead_id],
  );

  scheduleReminders({
    taskId: task.id,
    leadId: task.lead_id,
    userId: task.assignee_id,
    dueAt: when,
    detail: `${task.title} (rescheduled)`,
  });

  audit(req.user.id, 'followup_rescheduled', 'lead', task.lead_id, {
    task_id: task.id, from: task.due_at, to: when,
  });

  return res.json(one('SELECT * FROM tasks WHERE id = ?', [task.id]));
});

/**
 * Complete a follow-up. Outstanding reminders stop immediately — a chased
 * reminder for work already done is how people learn to ignore the bell.
 */
router.post('/follow-ups/:taskId/complete', requirePermission('lead.contact'), (req, res) => {
  const task = one('SELECT * FROM tasks WHERE id = ?', [req.params.taskId]);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  run("UPDATE tasks SET status = 'Done', updated_at = datetime('now') WHERE id = ?", [task.id]);
  cancelReminders(task.id, 'completed');

  run(
    `UPDATE leads SET next_follow_up_at = (
       SELECT MIN(due_at) FROM tasks WHERE lead_id = ? AND status = 'Open'
     ) WHERE id = ?`,
    [task.lead_id, task.lead_id],
  );

  audit(req.user.id, 'followup_completed', 'lead', task.lead_id, { task_id: task.id });
  return res.json(one('SELECT * FROM tasks WHERE id = ?', [task.id]));
});

export default router;
