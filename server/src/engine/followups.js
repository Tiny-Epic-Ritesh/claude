/**
 * Follow-ups and reminders.
 *
 * THE ONE RULE
 * ------------
 * A commitment made on a call must become a dated, owned, reminded task before
 * the request finishes. Not a note. Not a field the rep is trusted to revisit.
 * If the RM says "I will call Tuesday", Tuesday exists in the system with their
 * name on it, and the system chases them — not the other way round.
 *
 * Everything here follows from that. Reminders are rows so "was the rep
 * actually chased?" is answerable afterwards, which is the question a manager
 * asks when a follow-up was missed. Escalation is a row too, so "did the
 * manager know?" is equally answerable.
 */

import { all, one, run, audit, notify } from '../db.js';
import { send } from '../integrations.js';
import { nextWorkingTime } from './calendar.js';

/* ------------------------------------------------------------ business */

/** Bonanza's desk hours (BRD §OD-08): 09:00–19:00, Monday to Saturday. */
const OPEN_HOUR = 9;
const CLOSE_HOUR = 19;

const sql = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Nudge a due time into working hours.
 *
 * A retry scheduled for 02:00 because the last call was at 22:00 is a task that
 * shows up already overdue at the start of the shift. Callers may opt out with
 * `respectHours: false` when the client themselves named the time — the client's
 * stated preference beats our office convention.
 */
export function withinBusinessHours(when) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return when;
  // The office calendar, so a follow-up never lands on Diwali either. Holidays
  // cluster, which is why this walks the calendar rather than adding a day.
  return sql(nextWorkingTime(d, 'office'));
}

/* ---------------------------------------------------------- reminders */

/**
 * Channels, and when each fires relative to the task.
 *
 * The offsets are the point. One reminder at the moment something is due is
 * useless to somebody already on a call; a nudge the evening before is what
 * actually changes behaviour. Escalation waits four hours past due, long enough
 * to be a real miss rather than a rep at lunch.
 */
const CHANNELS = [
  { channel: 'bell', offsetH: -0.25 },
  { channel: 'bell', offsetH: 0 },
  { channel: 'email', offsetH: -14 },      // evening-before digest
  { channel: 'whatsapp', offsetH: -0.5 },
  { channel: 'manager', offsetH: 4 },      // escalation, past due
];

/**
 * Schedule every reminder for a task.
 * Channels the deployment cannot yet deliver are still recorded — they queue
 * visibly rather than vanishing, so nothing is silently lost when SMTP or the
 * WhatsApp template arrives later.
 */
export function scheduleReminders({ taskId, leadId, userId, dueAt, detail }) {
  const base = new Date(dueAt).getTime();
  if (Number.isNaN(base)) return 0;

  let created = 0;
  for (const c of CHANNELS) {
    const at = new Date(base + c.offsetH * 3600_000);

    // A reminder whose moment has already passed would fire instantly and
    // teach people to ignore the bell.
    if (at.getTime() < Date.now() - 60_000 && c.offsetH < 0) continue;

    run(
      `INSERT INTO reminders (task_id, lead_id, user_id, channel, due_at, detail)
       VALUES (?,?,?,?,?,?)`,
      [taskId, leadId, userId, c.channel, sql(at), detail ?? null],
    );
    created += 1;
  }
  return created;
}

/** Cancel outstanding reminders — the task was done, or the date moved. */
export function cancelReminders(taskId, why = 'task closed') {
  const n = run(
    "UPDATE reminders SET status = 'Cancelled', detail = COALESCE(detail,'') || ' · ' || ? WHERE task_id = ? AND status = 'Pending'",
    [why, taskId],
  ).changes;
  return n;
}

/* -------------------------------------------------------- the follow-up */

const KIND_TITLE = {
  follow_up: 'Follow up with',
  retry: 'Retry call to',
  meeting: 'Meeting with',
};

/**
 * Create the next commitment from a logged activity.
 *
 * Returns the task so the caller can show the rep exactly what was scheduled —
 * confirming the commitment back to them is what makes the automation feel like
 * help rather than surveillance.
 */
export function createFollowUp({
  leadId, cardId, userId, activityId, kind, dueAt, note, respectHours = true,
}) {
  if (!dueAt) return null;

  const lead = one('SELECT id, name, owner_id, sales_org FROM leads WHERE id = ?', [leadId]);
  if (!lead) return null;

  const when = respectHours ? withinBusinessHours(dueAt) : sql(new Date(dueAt));
  const owner = userId ?? lead.owner_id;
  const title = `${KIND_TITLE[kind] ?? 'Follow up with'} ${lead.name}`;

  const result = run(
    `INSERT INTO tasks (title, description, lead_id, card_id, assignee_id, due_at,
                        priority, status, kind, activity_id, auto_created)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    [
      title, note ?? null, leadId, cardId ?? null, owner, when,
      kind === 'meeting' ? 'High' : 'Medium', 'Open', kind, activityId ?? null,
    ],
  );
  const taskId = Number(result.lastInsertRowid);

  // Denormalised onto the lead so a work list can order by "what is due next"
  // without a correlated subquery per row.
  run(
    `UPDATE leads SET next_follow_up_at = ?
     WHERE id = ? AND (next_follow_up_at IS NULL OR next_follow_up_at > ?)`,
    [when, leadId, when],
  );

  if (activityId) run('UPDATE activities SET follow_up_task_id = ? WHERE id = ?', [taskId, activityId]);

  scheduleReminders({
    taskId, leadId, userId: owner, dueAt: when,
    detail: `${title} — ${note ?? kind}`,
  });

  audit(userId, 'followup_created', 'lead', leadId, { task_id: taskId, kind, due_at: when });
  return one('SELECT * FROM tasks WHERE id = ?', [taskId]);
}

/* ------------------------------------------------------------- delivery */

/**
 * Deliver every reminder now due. Called on the engine tick.
 *
 * Each channel fails independently: a missing WhatsApp template must not stop
 * the bell from ringing.
 */
export function sweepReminders() {
  const due = all(
    `SELECT r.*, t.title, t.due_at AS task_due, t.status AS task_status,
            l.name AS lead_name, u.name AS user_name, u.email AS user_email,
            u.whatsapp, u.manager_id
     FROM reminders r
     LEFT JOIN tasks t ON t.id = r.task_id
     LEFT JOIN leads l ON l.id = r.lead_id
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.status = 'Pending' AND r.due_at <= datetime('now')
     ORDER BY r.due_at LIMIT 200`,
  );

  const stats = { sent: 0, cancelled: 0, failed: 0 };

  for (const r of due) {
    // The task was completed before the reminder came round. Nothing to say.
    if (r.task_status && r.task_status !== 'Open') {
      run("UPDATE reminders SET status = 'Cancelled', detail = 'task already closed' WHERE id = ?", [r.id]);
      stats.cancelled += 1;
      continue;
    }

    try {
      if (r.channel === 'bell') {
        notify(r.user_id, 'Follow-up due', `${r.title ?? r.detail}`, r.lead_id ? `/leads/${r.lead_id}` : '/tasks');
      } else if (r.channel === 'email' && r.user_email) {
        send('email', {
          to: r.user_email,
          subject: `Follow-up due: ${r.lead_name ?? ''}`.trim(),
          body: `${r.title ?? r.detail}\n\nDue ${r.task_due}.\n\nOpen the CRM to log the outcome.`,
        });
      } else if (r.channel === 'whatsapp' && r.whatsapp) {
        send('whatsapp', {
          to: r.whatsapp,
          body: `Reminder: ${r.title ?? r.detail} (due ${r.task_due})`,
        });
      } else if (r.channel === 'manager') {
        // Escalation only matters if it is genuinely still open and overdue.
        if (r.manager_id) {
          notify(
            r.manager_id,
            'Follow-up missed',
            `${r.user_name ?? 'An RM'} has not actioned: ${r.title ?? r.detail}`,
            r.lead_id ? `/leads/${r.lead_id}` : '/tasks',
          );
          run("UPDATE reminders SET escalated = 1 WHERE id = ?", [r.id]);
        } else {
          run("UPDATE reminders SET status = 'Cancelled', detail = 'no manager to escalate to' WHERE id = ?", [r.id]);
          stats.cancelled += 1;
          continue;
        }
      } else {
        // The channel is not reachable for this user — no email, no WhatsApp.
        run(
          "UPDATE reminders SET status = 'Failed', detail = ? WHERE id = ?",
          [`no ${r.channel} address on the user record`, r.id],
        );
        stats.failed += 1;
        continue;
      }

      run("UPDATE reminders SET status = 'Sent', sent_at = datetime('now') WHERE id = ?", [r.id]);
      stats.sent += 1;
    } catch (err) {
      run("UPDATE reminders SET status = 'Failed', detail = ? WHERE id = ?", [String(err.message).slice(0, 180), r.id]);
      stats.failed += 1;
    }
  }

  return stats;
}

/**
 * The RM's follow-up picture: overdue first, then today, then ahead.
 * This is what the dashboard highlights and the work list sorts by.
 */
export function followUpBoard(userId) {
  const rows = all(
    `SELECT t.*, l.name AS lead_name, l.mobile, l.stage, l.score, l.sales_org,
            a.sub_disposition, a.body AS last_note
     FROM tasks t
     LEFT JOIN leads l ON l.id = t.lead_id
     LEFT JOIN activities a ON a.id = t.activity_id
     WHERE t.assignee_id = ? AND t.status = 'Open'
     ORDER BY t.due_at`,
    [userId],
  );

  const now = Date.now();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const bucket = (t) => {
    const due = new Date(`${String(t.due_at).replace(' ', 'T')}Z`).getTime();
    if (due < now) return 'overdue';
    if (due <= endOfDay.getTime()) return 'today';
    return 'upcoming';
  };

  const out = { overdue: [], today: [], upcoming: [] };
  for (const t of rows) out[bucket(t)].push(t);

  return {
    ...out,
    counts: { overdue: out.overdue.length, today: out.today.length, upcoming: out.upcoming.length },
  };
}
