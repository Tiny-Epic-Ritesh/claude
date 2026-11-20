/**
 * A lead's previous owner's open tasks go with it to its new owner -- B27,
 * ruled by Ritesh on 20 Nov 2026, after B26's hand-over had them do so.
 *
 * Every change of a lead's owner from one person to another: a Caller's or
 * Dealer's hand-over (B26), a supervisor's Change owner, an approved lead
 * transfer, and a bulk reassign, made alone or approved. All but the
 * hand-over left the previous owner's open tasks and their reminders behind --
 * often on a lead they could no longer open, so a callback promised to the
 * client was reminded to somebody who could not act on it. A leaver's handover
 * in Setup already moved them (engine/handover.js), and still does.
 *
 * Only the previous owner's own open tasks on that lead move. Other people's
 * tasks on it stay where they are, and so do the previous owner's tasks on
 * other leads and their finished ones. The reminders of a task that moves are
 * re-planned for the new owner, as a task given to somebody else anywhere is
 * (OPS-48). A lead taken from a queue, or left with nobody, moves nothing:
 * there is no previous person, or no new one.
 *
 * A task's assignee is not a tracked field in Setup today. tracked() is used
 * anyway, so the move is in each task's history the day Setup tracks it; until
 * then it is in the audit, here, and in what each door reports back.
 */

import { all, one, run, audit } from '../db.js';
import { tracked, SOURCE } from './history.js';
import { cancelReminders, scheduleReminders } from './followups.js';

/**
 * Move `fromUserId`'s open tasks on the lead to `toUserId`.
 * Returns the tasks moved, [{ id, title, due_at }], empty when nothing moved.
 */
export function moveOpenTasks(leadId, fromUserId, toUserId, { actorId = null, source = SOURCE.ui, why = 'owner changed' } = {}) {
  if (!leadId || !fromUserId || !toUserId || Number(fromUserId) === Number(toUserId)) return [];
  const tasks = all(
    "SELECT id, title, due_at FROM tasks WHERE lead_id = ? AND assignee_id = ? AND status = 'Open' ORDER BY due_at, id",
    [leadId, fromUserId],
  );
  if (!tasks.length) return [];

  const ids = tasks.map((t) => t.id);
  tracked('task', ids, { actorId, source }, () => run(
    `UPDATE tasks SET assignee_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    [toUserId, ...ids],
  ));
  for (const t of tasks) {
    if (!one('SELECT 1 v FROM reminders WHERE task_id = ?', [t.id])) continue;
    cancelReminders(t.id, why);
    scheduleReminders({ taskId: t.id, leadId, userId: toUserId, dueAt: t.due_at, detail: `${t.title} (${why})` });
  }
  audit(actorId, 'lead_tasks_moved', 'lead', leadId, { from: Number(fromUserId), to: Number(toUserId), tasks: ids, why });
  return tasks;
}

/** "2 open tasks", for what a door says back. */
export const openTasks = (n) => (n === 1 ? '1 open task' : `${n} open tasks`);
