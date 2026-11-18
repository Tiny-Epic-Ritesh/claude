/**
 * Who may change a task -- one rule for every route that changes one.
 *
 * The Tasks page's routes decided it here (QA-37: "assignee, creator, their
 * supervisor"); the two follow-up routes each had their own -- rescheduling
 * named four roles, completing asked nobody, so anybody who may contact leads
 * could mark another person's follow-up done, silently taking it off their
 * list and stopping its reminders. Ruled 18 Nov (B13): one rule for both
 * (A12). It is this one:
 *
 *   - the task's lead, if it has one, must be one the reader may see
 *   - every record it is linked to must be in the reader's books (N-12)
 *   - and the reader is its assignee, its creator, or holds report.team
 *     (whoever manages a team: Superadmin, Admin and both supervisors)
 *   - a cancelled task is where a task ends, so nothing about it changes
 *
 * `loadInBook` alone is not the tool: a task with no lead has no book of its
 * own, and refusing those would take standalone reminders from the people
 * they belong to.
 */

import { one } from '../db.js';
import { reqScope, userCan } from '../auth.js';
import { taskOutOfBook } from './bookscope.js';

/** The task by id if this request may change it: `{ task }`, or `{ status, body }`. */
export function taskFor(req, id = req.params.id) {
  const scope = reqScope(req, 'l');
  const task = one(
    `SELECT t.* FROM tasks t
      WHERE t.id = ?
        AND (t.lead_id IS NULL OR EXISTS (
          SELECT 1 FROM leads l WHERE l.id = t.lead_id AND l.deleted_at IS NULL AND ${scope.sql}))`,
    [id, ...scope.params],
  );
  if (!task) return { status: 404, body: { error: 'Task not found' } };
  const outOfBook = taskOutOfBook(req, task);
  if (outOfBook) return { status: outOfBook.status, body: { error: outOfBook.error } };
  if (task.assignee_id !== req.user.id && task.created_by !== req.user.id && !userCan(req.user, 'report.team')) {
    return { status: 403, body: { error: 'That task belongs to somebody else', required: 'report.team' } };
  }
  if (task.status === 'Cancelled') {
    return { status: 409, body: { error: `"${task.title}" was cancelled, so it stays as it is. Add a new task instead.` } };
  }
  return { task };
}
