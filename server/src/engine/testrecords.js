/**
 * Retire test records (QA-37; the auditor's section 9).
 *
 * "The developer should provide a scoped, auditable cleanup mechanism for
 * retained test entities that the UI cannot retire. Preview exact IDs and
 * dependencies before cleanup; retain the evidence needed to retest fixes."
 * Ritesh, 14 Oct: an explicit test-record mark that an Admin sets.
 *
 * So: an Admin marks a record as test data, by kind and number. The screen
 * previews, for every marked record, what retiring will do to it -- or what
 * stops it -- and retiring then takes each one out of use through its own
 * lifecycle, the same one a person would use: a lead to the recycle bin, a
 * case closed, a list, rule, flow or library item archived, a task
 * cancelled, a template retired, a partner's portal access withdrawn and the
 * record archived. Nothing is deleted, so the evidence stays; the mark and
 * the outcome stay too, as the account of what was done.
 *
 * A partner's state is not changed here. Suspending or terminating is the
 * closure approval's (Ritesh, 14 Oct), and a test record is no reason to step
 * round it.
 */

import { all, one, run, audit } from '../db.js';
import { withdrawPortalAccess } from '../routes/partners-support.js';
import { cancelReminders } from './followups.js';

const now = "datetime('now')";

/**
 * Each kind of record that can be marked: how to read it, what retiring will
 * do (or why it cannot yet), and the doing. `book` is the business it belongs
 * to, null for configuration that has none.
 */
export const TEST_KINDS = {
  lead: {
    label: 'Lead',
    load: (id) => one('SELECT id, name AS label, sales_org AS book, deleted_at FROM leads WHERE id = ?', [id]),
    plan: (r) => (r.deleted_at ? { done: 'Already in the recycle bin' } : { will: 'Moved to the recycle bin, restorable' }),
    retire: (r, why, userId) => {
      run(`UPDATE leads SET deleted_at = ${now} WHERE id = ?`, [r.id]);
      audit(userId, 'lead_deleted', 'lead', r.id, { test_record: true, reason: why });
      return 'Moved to the recycle bin';
    },
  },
  case: {
    label: 'Case',
    load: (id) => one("SELECT id, COALESCE(ref || ' ', '') || subject AS label, sales_org AS book, status FROM tickets WHERE id = ?", [id]),
    plan: (r) => (r.status === 'Closed' ? { done: 'Already closed' } : { will: 'Closed, with the reason as an internal note' }),
    retire: (r, why, userId) => {
      run(`UPDATE tickets SET status = 'Closed', closed_at = ${now}, updated_at = ${now} WHERE id = ?`, [r.id]);
      run("INSERT INTO ticket_replies (ticket_id, body, author_type, user_id, internal) VALUES (?, ?, 'system', ?, 1)",
        [r.id, `Closed as a test record: ${why}`, userId]);
      audit(userId, 'ticket_updated', 'ticket', r.id, { status: 'Closed', test_record: true, reason: why });
      return 'Closed';
    },
  },
  list: {
    label: 'Lead list',
    load: (id) => one('SELECT id, name AS label, sales_org AS book, archived_at FROM lead_lists WHERE id = ?', [id]),
    plan: (r) => (r.archived_at ? { done: 'Already archived' } : { will: 'Archived; its members are not touched' }),
    retire: (r, why, userId) => {
      run(`UPDATE lead_lists SET archived_at = ${now}, archived_by = ?, archive_reason = ? WHERE id = ?`, [userId, why, r.id]);
      audit(userId, 'list.archive', 'lead_list', r.id, { test_record: true, reason: why });
      return 'Archived';
    },
  },
  campaign: {
    label: 'Campaign',
    load: (id) => one('SELECT id, name AS label, sales_org AS book, status FROM campaigns WHERE id = ?', [id]),
    plan: (r) => {
      if (r.status === 'Archived') return { done: 'Already archived' };
      if (r.status === 'Sending') return { blocked: 'It is sending now. Pause it first.' };
      return { will: 'Archived' };
    },
    retire: (r, why, userId) => {
      run("UPDATE campaigns SET status = 'Archived' WHERE id = ?", [r.id]);
      audit(userId, 'campaign_archived', 'campaign', r.id, { test_record: true, reason: why });
      return 'Archived';
    },
  },
  content: {
    label: 'Library item',
    load: (id) => one('SELECT id, name AS label, sales_org AS book, status FROM content_items WHERE id = ?', [id]),
    plan: (r) => {
      if (r.status === 'archived') return { done: 'Already archived' };
      return { will: r.status === 'approved' || r.status === 'pending' ? 'Withdrawn, then archived' : 'Archived' };
    },
    retire: (r, why, userId) => {
      run(`UPDATE content_items SET status = 'archived', withdrawn_at = COALESCE(withdrawn_at, ${now}),
             withdrawn_by = COALESCE(withdrawn_by, ?), withdraw_reason = COALESCE(withdraw_reason, ?) WHERE id = ?`,
        [userId, why, r.id]);
      audit(userId, 'content_archived', 'content_item', r.id, { test_record: true, reason: why });
      return r.status === 'approved' || r.status === 'pending' ? 'Withdrawn and archived' : 'Archived';
    },
  },
  partner: {
    label: 'Partner',
    load: (id) => one(
      'SELECT id, name AS label, sales_org AS book, state_code, archived_at, portal_password FROM partners WHERE id = ?', [id],
    ),
    plan: (r) => {
      if (r.archived_at) return { done: 'Already archived' };
      const unpaid = one("SELECT COUNT(*) n FROM commissions WHERE partner_id = ? AND status <> 'Paid'", [r.id]).n;
      if (unpaid) return { blocked: `${unpaid} commission${unpaid === 1 ? ' is' : 's are'} not yet paid. Settle ${unpaid === 1 ? 'it' : 'them'} first.` };
      return { will: `${r.portal_password ? 'Portal access withdrawn and sessions ended; record ' : 'Record '}archived. Its state (${r.state_code}) is left to the closure approval.` };
    },
    retire: (r, why, userId) => {
      if (r.portal_password) withdrawPortalAccess(one('SELECT * FROM partners WHERE id = ?', [r.id]), userId, `Test record: ${why}`);
      run(`UPDATE partners SET archived_at = ${now}, archived_by = ?, archive_reason = ? WHERE id = ?`, [userId, `Test record: ${why}`, r.id]);
      audit(userId, 'partner_archived', 'partner', r.id, { test_record: true, reason: why });
      return r.portal_password ? 'Portal access withdrawn; archived' : 'Archived';
    },
  },
  rule: {
    label: 'Automation rule',
    load: (id) => one('SELECT id, name AS label, NULL AS book, enabled, archived_at FROM rules WHERE id = ?', [id]),
    plan: (r) => (r.archived_at ? { done: 'Already archived' } : { will: r.enabled ? 'Switched off, then archived' : 'Archived' }),
    retire: (r, why, userId) => {
      run(`UPDATE rules SET enabled = 0, archived_at = ${now}, archived_by = ?, archive_reason = ? WHERE id = ?`, [userId, why, r.id]);
      audit(userId, 'rule_archived', 'rule', r.id, { test_record: true, reason: why });
      return r.enabled ? 'Switched off and archived' : 'Archived';
    },
  },
  automation: {
    label: 'Automation flow',
    load: (id) => one('SELECT id, name AS label, sales_org AS book, status, archived_at FROM automation WHERE id = ?', [id]),
    plan: (r) => {
      if (r.archived_at) return { done: 'Already archived' };
      const live = one("SELECT COUNT(*) n FROM automation_run WHERE automation_id = ? AND status IN ('running','waiting')", [r.id]).n;
      if (live) return { blocked: `${live} lead${live === 1 ? ' is' : 's are'} still inside it. Pause it and let them finish.` };
      return { will: r.status === 'active' ? 'Paused, then archived' : 'Archived' };
    },
    retire: (r, why, userId) => {
      run(`UPDATE automation SET status = CASE WHEN status = 'active' THEN 'paused' ELSE status END,
             archived_at = ${now}, archived_by = ?, archive_reason = ?, updated_at = ${now} WHERE id = ?`, [userId, why, r.id]);
      audit(userId, 'automation_archived', 'automation', r.id, { test_record: true, reason: why });
      return r.status === 'active' ? 'Paused and archived' : 'Archived';
    },
  },
  task: {
    label: 'Task',
    load: (id) => one(
      `SELECT t.id, t.title AS label, l.sales_org AS book, t.status FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.id = ?`, [id],
    ),
    plan: (r) => (r.status === 'Cancelled' ? { done: 'Already cancelled' } : { will: 'Cancelled, with the reason; its reminders stop' }),
    retire: (r, why, userId) => {
      run(`UPDATE tasks SET status = 'Cancelled', cancelled_at = ${now}, cancel_reason = ?, updated_at = ${now} WHERE id = ?`,
        [`Test record: ${why}`, r.id]);
      cancelReminders(r.id, 'task cancelled');
      audit(userId, 'task_cancelled', 'task', r.id, { test_record: true, reason: why });
      return 'Cancelled';
    },
  },
  template: {
    label: 'Message template',
    load: (id) => one('SELECT id, name AS label, sales_org AS book, retired_at FROM templates WHERE id = ?', [id]),
    plan: (r) => (r.retired_at ? { done: 'Already retired' } : { will: 'Retired: out of every picker and every new send' }),
    retire: (r, why, userId) => {
      run(`UPDATE templates SET retired_at = ${now}, retired_by = ?, retire_reason = ? WHERE id = ?`, [userId, why, r.id]);
      audit(userId, 'template_retired', 'template', r.id, { test_record: true, reason: why });
      return 'Retired';
    },
  },
};

/** Every mark, newest first, each with what retiring it would do now. */
export function listTestRecords(mayReadBook) {
  return all(
    `SELECT t.*, mb.name AS marked_by_name, rb.name AS retired_by_name
       FROM test_records t
       LEFT JOIN users mb ON mb.id = t.marked_by
       LEFT JOIN users rb ON rb.id = t.retired_by
      ORDER BY t.retired_at IS NOT NULL, t.marked_at DESC, t.id DESC`,
  ).map((t) => {
    const kind = TEST_KINDS[t.entity];
    const record = kind?.load(t.record_id);
    if (record && record.book && !mayReadBook(record.book)) return null;
    const plan = t.retired_at ? null : (record ? kind.plan(record) : { blocked: 'The record no longer exists' });
    return { ...t, kind_label: kind?.label ?? t.entity, current_label: record?.label ?? null, book: record?.book ?? null, plan };
  }).filter(Boolean);
}

/** Mark a record as test data. */
export function markTestRecord(entity, recordId, note, user, mayReadBook) {
  const kind = TEST_KINDS[entity];
  if (!kind) return { status: 400, error: `Choose what kind of record it is: ${Object.values(TEST_KINDS).map((k) => k.label.toLowerCase()).join(', ')}` };
  const record = kind.load(Number(recordId) || -1);
  if (!record || (record.book && !mayReadBook(record.book))) return { status: 404, error: `There is no ${kind.label.toLowerCase()} number ${recordId} in your business` };
  if (one('SELECT id FROM test_records WHERE entity = ? AND record_id = ?', [entity, record.id])) {
    return { status: 409, error: `${kind.label} ${record.id} is already marked as a test record` };
  }
  const id = Number(run(
    'INSERT INTO test_records (entity, record_id, label, note, marked_by) VALUES (?,?,?,?,?)',
    [entity, record.id, record.label ?? null, String(note ?? '').trim() || null, user.id],
  ).lastInsertRowid);
  audit(user.id, 'test_record_marked', entity, record.id, { mark: id });
  return { mark: one('SELECT * FROM test_records WHERE id = ?', [id]), plan: kind.plan(record) };
}

/**
 * Retire every marked record not yet retired, or the ones named. Each is
 * done or reported on its own: one blocked record does not stop the rest,
 * and the answer says which was which.
 */
export function retireTestRecords({ ids = null, reason, user, mayReadBook }) {
  const why = String(reason ?? '').trim();
  if (why.length < 5) return { status: 400, error: 'Say why these are being retired, in a few words', field: 'reason' };
  const marks = all('SELECT * FROM test_records WHERE retired_at IS NULL ORDER BY id')
    .filter((m) => !ids || ids.map(Number).includes(m.id));
  const results = [];
  for (const m of marks) {
    const kind = TEST_KINDS[m.entity];
    const record = kind?.load(m.record_id);
    if (!record) { results.push({ id: m.id, entity: m.entity, record_id: m.record_id, skipped: 'The record no longer exists' }); continue; }
    if (record.book && !mayReadBook(record.book)) continue;
    const plan = kind.plan(record);
    if (plan.blocked) { results.push({ id: m.id, entity: m.entity, record_id: m.record_id, skipped: plan.blocked }); continue; }
    const outcome = plan.done ?? kind.retire(record, why, user.id);
    run(`UPDATE test_records SET retired_at = ${now}, retired_by = ?, retire_reason = ?, outcome = ? WHERE id = ?`,
      [user.id, why, outcome, m.id]);
    results.push({ id: m.id, entity: m.entity, record_id: m.record_id, outcome });
  }
  audit(user.id, 'test_records_retired', 'test_record', null, {
    reason: why, retired: results.filter((r) => r.outcome).map((r) => r.id), skipped: results.filter((r) => r.skipped).map((r) => r.id),
  });
  return { results };
}

/** Take a mark off a record not yet retired -- it was marked by mistake. */
export function unmarkTestRecord(markId, user) {
  const mark = one('SELECT * FROM test_records WHERE id = ?', [Number(markId) || -1]);
  if (!mark) return { status: 404, error: 'No such mark' };
  if (mark.retired_at) return { status: 409, error: 'It has been retired; the mark stays as the record of that' };
  run('DELETE FROM test_records WHERE id = ?', [mark.id]);
  audit(user.id, 'test_record_unmarked', mark.entity, mark.record_id, { mark: mark.id });
  return { ok: true };
}
