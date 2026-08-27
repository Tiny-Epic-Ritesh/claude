/**
 * Lead Lists — three kinds, one resolver.
 *
 * The kinds differ in exactly one way: when membership is decided.
 *
 *   static       at creation. Changes only when a person adds or removes.
 *   refreshable  from a saved filter, but only when someone refreshes it or
 *                the schedule runs.
 *   dynamic      every time it is opened.
 *
 * That single axis is the whole design. Everything else — bulk actions,
 * campaign sends, the member count — reads through resolve() and does not care
 * which kind it was handed.
 *
 * Why refreshable exists at all, given dynamic is always current: because a
 * campaign needs membership to hold still. If the set shifts mid-send, the send
 * log and the list disagree and you can no longer state who was contacted. For
 * a SEBI-regulated broker that is not a preference.
 */

import { all, one, run, audit } from '../db.js';
import { toSql, validateTree } from './conditions.js';

export const LIST_KINDS = ['static', 'refreshable', 'dynamic'];

export const KIND_LABEL = {
  static: 'Static',
  refreshable: 'Refreshable',
  dynamic: 'Dynamic',
};

export const KIND_HELP = {
  static: 'Fixed at creation. Only changes when someone adds or removes a lead. Auditable — you can prove exactly who was in it.',
  refreshable: 'Built from a filter, re-evaluated on demand or at 06:00 IST. Will not shift underneath a running campaign.',
  dynamic: 'Evaluated live every time it is opened. Always current, never stale — and never safe to send a campaign to.',
};

/**
 * A campaign may not send to a dynamic list.
 *
 * Enforced here rather than trusted to the caller, because there are three
 * paths to a send and the rule has to hold on all of them.
 */
export const MAY_RECEIVE_CAMPAIGN = new Set(['static', 'refreshable']);

/** Legacy rows used 'newsletter'. Treat anything unrecognised as static —
 *  the conservative choice, since static never surprises anyone. */
export const normaliseKind = (kind) =>
  (LIST_KINDS.includes(kind) ? kind : 'static');

/**
 * The SQL that selects a list's members.
 *
 * Returns a fragment against `leads l`, so every caller can AND it with their
 * own visibility scope. That composition is deliberate: a list is a saved
 * question, not a grant. Sharing a list with someone does not let them see
 * leads they could not otherwise open, and a supervisor and an RM opening the
 * same list will correctly see different numbers of rows.
 */
export function membersSql(list) {
  const kind = normaliseKind(list?.kind);

  if (kind === 'dynamic') {
    let criteria = null;
    try { criteria = list.criteria ? JSON.parse(list.criteria) : null; } catch { criteria = null; }
    // A dynamic list with no criteria matches nothing, rather than everything.
    // The alternative fails open, and "everything" is the worst possible
    // default for a thing people attach bulk actions to.
    if (!criteria) return { sql: '1=0', params: [] };
    return toSql(criteria);
  }

  return {
    sql: 'EXISTS (SELECT 1 FROM lead_list_members m WHERE m.lead_id = l.id AND m.list_id = ?)',
    params: [list.id],
  };
}

/**
 * Recompute a refreshable list's membership from its criteria.
 *
 * Static lists are refused rather than silently ignored: someone pressing
 * Refresh on a static list has misunderstood what it is, and telling them is
 * more useful than doing nothing and looking broken.
 */
export function refreshList(listId, userId = null) {
  const list = one('SELECT * FROM lead_lists WHERE id = ?', [listId]);
  if (!list) return { ok: false, error: 'List not found' };

  const kind = normaliseKind(list.kind);
  if (kind === 'static') {
    return { ok: false, error: 'A static list has fixed membership. Change its kind to Refreshable to rebuild it from a filter.' };
  }
  if (kind === 'dynamic') {
    return { ok: false, error: 'A dynamic list is evaluated every time it is opened, so there is nothing to refresh.' };
  }

  let criteria = null;
  try { criteria = list.criteria ? JSON.parse(list.criteria) : null; } catch { criteria = null; }
  if (!criteria) {
    const error = 'This list has no filter saved, so there is nothing to rebuild it from.';
    run('UPDATE lead_lists SET refresh_error = ? WHERE id = ?', [error, listId]);
    return { ok: false, error };
  }

  // validateTree returns an array of problems — an empty one means valid. It is
  // truthy either way, so the length is the test.
  const problems = validateTree(criteria);
  if (problems.length) {
    // A field renamed out from under a saved filter is the usual cause. Record
    // it on the list so it shows on screen instead of failing quietly.
    const error = `The saved filter is no longer valid: ${problems[0].error}`;
    run('UPDATE lead_lists SET refresh_error = ? WHERE id = ?', [error, listId]);
    return { ok: false, error };
  }

  const { sql, params } = toSql(criteria);

  /* Rebuild inside a transaction. A half-rebuilt list is worse than a stale
     one — a campaign firing against it would hit an arbitrary subset. */
  const before = one('SELECT COUNT(*) n FROM lead_list_members WHERE list_id = ?', [listId]).n;

  run('BEGIN');
  try {
    run('DELETE FROM lead_list_members WHERE list_id = ?', [listId]);
    run(
      `INSERT OR IGNORE INTO lead_list_members (list_id, lead_id)
       SELECT ?, l.id FROM leads l WHERE l.deleted_at IS NULL AND (${sql})`,
      [listId, ...params],
    );
    run(
      `UPDATE lead_lists
          SET last_refreshed_at = datetime('now'), last_refreshed_by = ?, refresh_error = NULL
        WHERE id = ?`,
      [userId, listId],
    );
    run('COMMIT');
  } catch (e) {
    run('ROLLBACK');
    run('UPDATE lead_lists SET refresh_error = ? WHERE id = ?', [e.message, listId]);
    return { ok: false, error: e.message };
  }

  const after = one('SELECT COUNT(*) n FROM lead_list_members WHERE list_id = ?', [listId]).n;
  audit(userId, 'list.refresh', 'lead_list', listId, { before, after });
  return { ok: true, before, after, added: after - before };
}

/**
 * The 06:00 IST rebuild.
 *
 * Six, so lists are current before the market opens and the day's calling
 * starts. A list refreshed at midnight has already missed a night of feed
 * updates by the time anyone dials from it.
 *
 * IST is fixed at UTC+5:30 and observes no daylight saving, so the offset is a
 * constant rather than a timezone lookup.
 */
export const IST_OFFSET_MIN = 5 * 60 + 30;

export const istHour = (now = new Date()) =>
  new Date(now.getTime() + IST_OFFSET_MIN * 60_000).getUTCHours();

let lastSweepDay = null;

export function sweepListRefresh(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const day = ist.toISOString().slice(0, 10);
  if (ist.getUTCHours() !== 6 || lastSweepDay === day) return { ran: false };

  lastSweepDay = day;
  const lists = all("SELECT id FROM lead_lists WHERE kind = 'refreshable'");
  let refreshed = 0;
  for (const l of lists) {
    const r = refreshList(l.id, null);
    if (r.ok) refreshed += 1;
  }
  return { ran: true, lists: lists.length, refreshed };
}

/** Reset point for tests, which need to run the sweep more than once a day. */
export const resetSweep = () => { lastSweepDay = null; };

/**
 * Who may see a list.
 *
 * Owner, anyone it is shared with by role or by user id, and administrators.
 * Sharing controls whether the list is visible — never which leads it yields,
 * which stays with the reader's own scope.
 */
export function mayReadList(list, user) {
  if (!list || !user) return false;
  if (list.owner_id === user.id || list.created_by === user.id) return true;
  if (['superadmin', 'admin'].includes(user.role)) return true;
  let shared = [];
  try { shared = JSON.parse(list.shared_with || '[]'); } catch { shared = []; }
  return shared.some((s) => s === user.role || s === user.id || String(s) === String(user.id));
}

export const mayWriteList = (list, user) =>
  Boolean(list && user && (list.owner_id === user.id || list.created_by === user.id
    || ['superadmin', 'admin'].includes(user.role)));
