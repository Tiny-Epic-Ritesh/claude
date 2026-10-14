/**
 * QA-02: close the duplicate tasks and notifications the scheduler made.
 *
 *   node scripts/qa02-duplicate-tasks.mjs            preview: what would close
 *   node scripts/qa02-duplicate-tasks.mjs --apply    snapshot the database, then close them
 *   ... --ids-only                                   name leads by id, not by name
 *
 * On labs it runs from GitHub Actions, "QA-02 duplicate-task cleanup (labs)",
 * which passes --ids-only: this repository is public, so its workflow logs are
 * too, and a lead's name has no business in one.
 *
 * Until QA-02 a rule acted on every lead that matched at every five-minute
 * sweep, so a lead that stayed Warm got a new "Contact lead — warm MF card"
 * task each time -- 10,477 tasks for 41 leads on labs.tinyepic.in -- and its
 * Product RM a new notification with it.
 *
 * A duplicate is an open task a rule made (no creator, and a title one of the
 * rules' task cards uses) with the same lead, title and assignee as an older
 * open one. The oldest is kept. The rest are closed as Cancelled with a reason
 * -- not deleted -- so the history, and the auditor's evidence, survives. For
 * notifications: the same automation notice to the same person about the same
 * lead, unread; the newest stays unread and the others are marked read.
 *
 * As signed off on 13 October 2026: close, keep the history, preview first,
 * and run against labs only after Ritesh says yes. Nothing calls this; it runs
 * when somebody runs it, against the database in this checkout's .env.
 */

import 'dotenv/config';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { all, one, run, transact, db } from '../src/db.js';

export const REASON = 'Duplicate created by the scheduler (QA-02)';

/** Every title a rule's task card gives the tasks it makes. */
function ruleTaskTitles() {
  const titles = new Set(['Automated follow-up']);
  for (const r of all('SELECT actions FROM rules')) {
    let actions = [];
    try { actions = JSON.parse(r.actions || '[]'); } catch { actions = []; }
    for (const a of actions) if (a?.type === 'task' && a.params?.title) titles.add(String(a.params.title));
  }
  return [...titles];
}

const taskScope = (titles) => ({
  sql: `created_by IS NULL AND status = 'Open' AND lead_id IS NOT NULL
        AND title IN (${titles.map(() => '?').join(',')})`,
  params: titles,
});

/** What would close, grouped, without changing anything. */
export function preview() {
  const titles = ruleTaskTitles();
  const scope = taskScope(titles);
  const groups = all(
    `SELECT lead_id, title, assignee_id, COUNT(*) AS open, MIN(id) AS keep_id
       FROM tasks WHERE ${scope.sql}
      GROUP BY lead_id, title, assignee_id
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC`,
    scope.params,
  );
  const notices = all(
    `SELECT user_id, body, link, COUNT(*) AS unread, MAX(id) AS keep_id
       FROM notifications WHERE title = 'Automation' AND read = 0
      GROUP BY user_id, body, link
     HAVING COUNT(*) > 1`,
  );
  return {
    task_groups: groups,
    tasks_to_close: groups.reduce((n, g) => n + g.open - 1, 0),
    notification_groups: notices,
    notifications_to_mark_read: notices.reduce((n, g) => n + g.unread - 1, 0),
  };
}

/**
 * A whole copy of the database, taken before anything changes.
 *
 * VACUUM INTO writes the snapshot from inside SQLite, so it is consistent even
 * while the CRM goes on writing; copying the file from outside can catch it
 * half way through a write. It lands beside the database, in the same volume,
 * and the labs workflow moves it out to the box's backups folder.
 */
export function snapshot(stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const file = join(dirname(db.location()), `bonanza-before-qa02-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

/** Close the duplicates. Returns how many of each it changed. */
export function apply() {
  const titles = ruleTaskTitles();
  const scope = taskScope(titles);
  let tasks = 0;
  let notifications = 0;
  transact(() => {
    tasks = Number(run(
      `UPDATE tasks SET status = 'Cancelled', cancelled_at = datetime('now'), cancel_reason = ?
        WHERE ${scope.sql}
          AND id NOT IN (SELECT MIN(id) FROM tasks WHERE ${scope.sql} GROUP BY lead_id, title, assignee_id)`,
      [REASON, ...scope.params, ...scope.params],
    ).changes);
    notifications = Number(run(
      `UPDATE notifications SET read = 1
        WHERE title = 'Automation' AND read = 0
          AND id NOT IN (SELECT MAX(id) FROM notifications WHERE title = 'Automation' AND read = 0 GROUP BY user_id, body, link)`,
    ).changes);
    run('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (NULL, ?, ?, NULL, ?)', [
      'qa02_duplicates_closed', 'task', JSON.stringify({ tasks, notifications, reason: REASON }),
    ]);
  });
  return { tasks_closed: tasks, notifications_marked_read: notifications };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const doApply = process.argv.includes('--apply');
  const idsOnly = process.argv.includes('--ids-only');
  const p = preview();
  console.log(`Duplicate rule tasks: ${p.tasks_to_close} to close, in ${p.task_groups.length} group(s); the oldest of each is kept.`);
  for (const g of p.task_groups.slice(0, 20)) {
    const lead = idsOnly
      ? `lead ${g.lead_id}`
      : one('SELECT name FROM leads WHERE id = ?', [g.lead_id])?.name ?? `lead ${g.lead_id}`;
    console.log(`  ${String(g.open).padStart(6)} open  "${g.title}"  on ${lead}  -- keeping task ${g.keep_id}`);
  }
  if (p.task_groups.length > 20) console.log(`  ... and ${p.task_groups.length - 20} more group(s)`);
  console.log(`Duplicate automation notifications: ${p.notifications_to_mark_read} to mark read.`);

  if (!doApply) {
    console.log('\nPreview only -- nothing was changed. Run again with --apply to close these.');
  } else {
    // The workflow reads this line to move the snapshot off the volume.
    console.log(`Snapshot taken first: ${snapshot()}`);
    const done = apply();
    console.log(`\nClosed ${done.tasks_closed} task(s) as Cancelled ("${REASON}") and marked ${done.notifications_marked_read} notification(s) read.`);
  }
}
