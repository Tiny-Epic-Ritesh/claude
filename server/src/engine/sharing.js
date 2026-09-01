/**
 * Sharing — the grant layer above a Private floor.
 *
 * NON-NEGOTIABLE 7: one restrictive floor, then grant-only layers.
 *
 * WHAT CHANGES, AND WHY IT IS THE RISKY ONE
 * -----------------------------------------
 * `lead.view.all` used to short-circuit the whole visibility question: hold it
 * and you saw every lead in your org, whatever your role's declared scope said.
 * Six roles held it, which meant the `data_scope` column was decorative for
 * most of the product.
 *
 * Under a Private floor nothing is visible by default and every sight-line has
 * to be granted:
 *
 *     visible(user, lead) =
 *          owns(lead)                       -- the floor: your own book
 *       OR roleScope(user) admits it        -- own | team | product | org
 *       OR manages(user, owner(lead))       -- this file, at any depth
 *       OR queue you can take from          -- engine/queues.js
 *
 * Five of the six roles that held `lead.view.all` also carry `data_scope: org`,
 * so they are unaffected. The one that genuinely changes is Sales Supervisor,
 * which is declared `team` — it stops seeing the whole org and starts seeing
 * everyone beneath it in the management chain. That is the correct reading of
 * "supervisor", and it is a real reduction in what one role can see, which is
 * why it was worth stating before building.
 *
 * WHY A RECURSIVE CHAIN AND NOT ONE LEVEL
 * ---------------------------------------
 * The old `team` scope was `owner_id IN (SELECT id FROM users WHERE manager_id
 * = me)` — direct reports only. A regional head above two desk supervisors saw
 * neither desk's leads, because their reports are supervisors and the leads
 * belong to the RMs beneath them. A hierarchy that only works one level deep is
 * not a hierarchy.
 */

import { all } from '../db.js';

/**
 * Everyone beneath this user, at any depth.
 *
 * A recursive CTE rather than a loop in JS: it is one query however deep the
 * tree, and `UNION` (not `UNION ALL`) makes a cycle in the data terminate
 * instead of hanging — and a two-person management loop is one bad edit away in
 * any admin screen.
 */
export function reportsOf(userId) {
  if (!userId) return [];
  return all(
    `WITH RECURSIVE reports(id) AS (
       SELECT id FROM users WHERE manager_id = ?
       UNION
       SELECT u.id FROM users u JOIN reports r ON u.manager_id = r.id
     )
     SELECT id FROM reports`,
    [userId],
  ).map((r) => r.id);
}

/** Does `user` manage `otherId`, at any depth? */
export const manages = (userId, otherId) =>
  Boolean(userId) && Boolean(otherId) && reportsOf(userId).includes(Number(otherId));

/**
 * The SQL grant for "leads owned by someone I manage".
 *
 * Returns null when the user manages nobody, so the caller can leave the clause
 * out entirely rather than emitting `owner_id IN ()`, which SQLite rejects.
 */
export function managerScopeSql(user, alias = 'l', column = 'owner_id') {
  const reports = reportsOf(user?.id);
  if (!reports.length) return null;
  return {
    sql: `${alias}.${column} IN (${reports.map(() => '?').join(',')})`,
    params: reports,
  };
}

/**
 * Explain what a person can see and why.
 *
 * The question the audit says nobody could answer. Every grant is listed
 * separately so "why can they see this?" has an answer that names one rule
 * rather than shrugging at a combined WHERE clause.
 */
export function explainVisibility(user, dataScope) {
  const reports = reportsOf(user?.id);

  const grants = [
    { grant: 'Own book', detail: 'Leads where they are the owner. This is the floor — it is never removed.' },
  ];

  switch (dataScope) {
    case 'org':
      grants.push({ grant: 'Org-wide', detail: 'Their role is declared org scope, so every lead in the sales orgs they work in.' });
      break;
    case 'team':
      grants.push({ grant: 'Team', detail: 'Leads owned by their direct reports.' });
      break;
    case 'product':
      grants.push({ grant: 'Product', detail: 'Leads carrying their product, whoever owns them.' });
      break;
    default:
      break;
  }

  if (reports.length) {
    grants.push({
      grant: 'Management chain',
      detail: `Leads owned by any of the ${reports.length} people beneath them, at any depth.`,
      people: reports.length,
    });
  }

  grants.push({
    grant: 'Queues',
    detail: 'Work waiting in any queue their role may take from.',
  });

  return {
    floor: 'Private — nothing is visible unless one of these grants applies.',
    grants,
    manages: reports.length,
  };
}
