/**
 * Handing over a book when somebody leaves (P3-19).
 *
 * There was already a version of this, hidden inside deactivation: pass
 * `reassign_to` and every open lead and open task went to one person. It is
 * the right instinct and too small a version of it. What it left behind:
 *
 *   - won and lost leads, still owned by somebody who cannot sign in, so the
 *     clients they became have no reachable RM
 *   - clients, tickets, product cards and partners, all of which have owners
 *   - direct reports, which matter more than they look: team visibility
 *     resolves through `users.manager_id`, so a departing supervisor leaves
 *     their reports under a manager who no longer exists and nobody above them
 *     can see the team
 *   - any way to see what would happen before it happened
 *   - any way to put it back
 *   - any way to split a book, so the only option was to drop several thousand
 *     leads on one person
 *
 * WHY MOVING CLOSED LEADS IS SAFE
 *
 * It looks like rewriting history, and it would be if credit came from
 * `leads.owner_id`. It does not: KRA and every activity report attribute to
 * `activities.user_id`, which is who actually made the call. Ownership is who
 * is responsible now, and a Won lead owned by somebody who left is a client
 * with nobody to ring.
 *
 * WHAT IS DELIBERATELY LEFT BEHIND
 *
 * Personal artefacts: a private dashboard, a personal email template, a lead
 * list somebody built for themselves. Those are the departing person's own
 * working notes rather than the firm's book, and handing them to a colleague
 * is a different decision from handing over clients. They are counted and
 * reported as left behind rather than moved silently.
 */

import { all, one, run } from '../db.js';

/**
 * Everything a person can own, and what counts as still live.
 *
 * A registry rather than seven bespoke queries, so adding an owned object is a
 * row here and so undo can find its way back to the table without guessing.
 */
export const OBJECTS = [
  {
    key: 'leads_open',
    label: 'Open leads',
    table: 'leads',
    column: 'owner_id',
    where: "deleted_at IS NULL AND stage NOT IN ('Won','Lost')",
    note: true,
  },
  {
    key: 'leads_closed',
    label: 'Won and lost leads',
    table: 'leads',
    column: 'owner_id',
    where: "deleted_at IS NULL AND stage IN ('Won','Lost')",
    note: true,
    hint: 'A won lead with no owner is a client nobody is responsible for. Credit for the win is unaffected — that comes from the activity log.',
  },
  {
    key: 'clients', label: 'Clients', table: 'clients', column: 'owner_id', where: '1 = 1',
  },
  {
    key: 'product_cards',
    label: 'Product cards',
    table: 'product_cards',
    column: 'product_rm_id',
    where: "state != 'INACTIVE'",
  },
  {
    key: 'tasks', label: 'Open tasks', table: 'tasks', column: 'assignee_id', where: "status = 'Open'",
  },
  {
    key: 'tickets',
    label: 'Open tickets',
    table: 'tickets',
    column: 'assignee_id',
    where: "status NOT IN ('Closed', 'Resolved')",
  },
  {
    key: 'partners', label: 'Partners', table: 'partners', column: 'owner_id', where: '1 = 1',
  },
  {
    key: 'reports',
    label: 'Direct reports',
    table: 'users',
    column: 'manager_id',
    where: 'active = 1',
    hint: 'Team visibility resolves through the manager chain. Reports left under someone who has gone are invisible to everyone above them.',
  },
];

const byKey = new Map(OBJECTS.map((o) => [o.key, o]));

/** What stays with the person who is leaving, and is worth saying so. */
export const LEFT_BEHIND = [
  { key: 'lead_lists', label: 'Lead lists', table: 'lead_lists', column: 'owner_id' },
  { key: 'dashboards', label: 'Personal dashboards', table: 'custom_dashboard', column: 'owner_id' },
  { key: 'templates', label: 'Personal templates', table: 'templates', column: 'owner_id' },
];

const countIn = (o, userId) => one(
  `SELECT COUNT(*) AS n FROM ${o.table} WHERE ${o.column} = ? AND (${o.where ?? '1 = 1'})`,
  [userId],
).n;

/** Everything this person holds, with the counts that decide whether to bother. */
export function bookOf(userId) {
  return {
    objects: OBJECTS.map((o) => ({
      key: o.key, label: o.label, hint: o.hint ?? null, count: countIn(o, userId),
    })),
    left_behind: LEFT_BEHIND.map((o) => ({
      key: o.key,
      label: o.label,
      count: one(`SELECT COUNT(*) AS n FROM ${o.table} WHERE ${o.column} = ?`, [userId]).n,
    })).filter((o) => o.count > 0),
  };
}

/** The rows themselves, in a fixed order so a preview and its run agree. */
const rowsIn = (o, userId) => all(
  `SELECT id FROM ${o.table} WHERE ${o.column} = ? AND (${o.where ?? '1 = 1'}) ORDER BY id`,
  [userId],
).map((r) => r.id);

/**
 * Who gets what.
 *
 * Deterministic: rows are taken in id order and dealt round the targets in the
 * order given, so the preview somebody approved is the move that runs. A
 * preview that could differ from its own execution is worse than no preview,
 * because it is trusted.
 *
 * Round-robin deals per object type rather than across the whole book, so a
 * two-way split of 300 leads and 40 tickets gives 150/150 and 20/20 rather
 * than one person taking every ticket because the leads happened to end on an
 * odd number.
 */
export function planHandover({ from, targets, include, strategy = 'single' }) {
  const chosen = strategy === 'single' ? targets.slice(0, 1) : targets;
  const moves = [];
  const perObject = [];

  for (const key of include) {
    const o = byKey.get(key);
    if (!o) continue;

    const rows = rowsIn(o, from);
    const split = new Map(chosen.map((t) => [t, 0]));

    rows.forEach((rowId, i) => {
      const to = chosen[i % chosen.length];
      moves.push({ object_key: key, row_id: rowId, to_user_id: to });
      split.set(to, split.get(to) + 1);
    });

    perObject.push({
      key, label: o.label, total: rows.length, split: [...split].map(([to, n]) => ({ to, n })),
    });
  }

  return { from, strategy, targets: chosen, objects: perObject, total: moves.length, moves };
}

/**
 * Do it, and write down enough to undo it.
 *
 * The note on each lead is not decoration. Somebody arrives on Monday owning
 * three hundred leads they have never seen, and the only question they have is
 * why — so the answer is on the record rather than in an email they were not
 * copied into.
 */
export function runHandover(plan, { runBy, reason, salesOrg }) {
  const batch = run(
    `INSERT INTO handover_batch (from_user_id, sales_org, strategy, reason, moved, run_by)
     VALUES (?,?,?,?,?,?)`,
    [plan.from, salesOrg, plan.strategy, reason ?? null, plan.moves.length, runBy ?? null],
  );
  const batchId = Number(batch.lastInsertRowid);

  const leaver = one('SELECT name FROM users WHERE id = ?', [plan.from])?.name ?? 'a colleague';

  for (const m of plan.moves) {
    const o = byKey.get(m.object_key);

    /* Read the current owner rather than assuming it is `plan.from`. The
       preview may be minutes old, and a row that moved in between should be
       recorded as it actually was so undo puts it back where it actually was. */
    const current = one(`SELECT ${o.column} AS owner FROM ${o.table} WHERE id = ?`, [m.row_id])?.owner ?? null;

    run(`UPDATE ${o.table} SET ${o.column} = ? WHERE id = ?`, [m.to_user_id, m.row_id]);
    run(
      `INSERT INTO handover_move (batch_id, object_key, row_id, from_user_id, to_user_id)
       VALUES (?,?,?,?,?)`,
      [batchId, m.object_key, m.row_id, current, m.to_user_id],
    );

    if (o.note) {
      run(
        `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
         VALUES (?, 'Note', 'system', ?, ?, NULL)`,
        [m.row_id, `Reassigned from ${leaver}`,
          reason ? `${reason} — handover #${batchId}` : `Handover #${batchId}`],
      );
    }
  }

  return { batch_id: batchId, moved: plan.moves.length };
}

/**
 * Put it back, except where somebody has since decided otherwise.
 *
 * A row whose owner has changed since the handover is left alone and counted.
 * Undo is for the handover that went to the wrong person and is noticed within
 * the hour; it is not a way to overwrite a fortnight of somebody else's work
 * because the batch is still in the list.
 */
export function undoHandover(batchId, userId) {
  const batch = one('SELECT * FROM handover_batch WHERE id = ?', [batchId]);
  if (!batch) return { error: 'No such handover' };
  if (batch.undone_at) return { error: 'That handover has already been undone' };

  let restored = 0;
  const skipped = [];

  for (const m of all('SELECT * FROM handover_move WHERE batch_id = ? ORDER BY id', [batchId])) {
    const o = byKey.get(m.object_key);
    if (!o) continue;

    const current = one(`SELECT ${o.column} AS owner FROM ${o.table} WHERE id = ?`, [m.row_id])?.owner ?? null;
    if (current !== m.to_user_id) {
      skipped.push({ object_key: m.object_key, row_id: m.row_id });
      continue;
    }

    run(`UPDATE ${o.table} SET ${o.column} = ? WHERE id = ?`, [m.from_user_id, m.row_id]);
    restored += 1;
  }

  run("UPDATE handover_batch SET undone_at = datetime('now'), undone_by = ? WHERE id = ?", [userId ?? null, batchId]);

  return { restored, skipped: skipped.length, moved: batch.moved };
}

/** The handovers that have happened, for the books this user holds. */
export const listBatches = (orgs, limit = 25) => all(
  `SELECT b.*, f.name AS from_name, r.name AS run_by_name, u.name AS undone_by_name,
          (SELECT COUNT(DISTINCT to_user_id) FROM handover_move m WHERE m.batch_id = b.id) AS recipients
     FROM handover_batch b
     LEFT JOIN users f ON f.id = b.from_user_id
     LEFT JOIN users r ON r.id = b.run_by
     LEFT JOIN users u ON u.id = b.undone_by
    WHERE b.sales_org IN (${orgs.map(() => '?').join(',') || 'NULL'})
    ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
  [...orgs, limit],
);
