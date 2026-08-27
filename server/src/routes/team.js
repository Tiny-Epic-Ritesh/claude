/**
 * My Team — who reports to whom, and how each of them is doing.
 *
 * Built off `manager_id`, which is the chain the sharing engine already uses to
 * decide visibility. That is deliberate: a supervisor seeing somebody on this
 * page and not being able to open their leads would mean the two had drifted,
 * and there would be no way to tell which was right. One source, both answers.
 *
 * The legacy audit found the opposite arrangement — `Bigul Dealer Team` had
 * twelve managers and one sales user, because the manager slot was the only way
 * to grant visibility. Reporting line and data access are separate concerns
 * here, and this page reads the reporting line.
 */

import { Router } from 'express';
import { all, one } from '../db.js';
import { requireUser, requirePermission, orgsFor, activeOrg } from '../auth.js';

const router = Router();
router.use(requireUser);

/** Everyone below this person, at any depth. */
function reportsOf(rootId) {
  const seen = new Set([rootId]);
  const queue = [rootId];
  const found = [];

  while (queue.length) {
    const id = queue.shift();
    for (const u of all('SELECT id FROM users WHERE manager_id = ? AND active = 1', [id])) {
      // A cycle in the management chain would otherwise loop here forever, and
      // a bad import is entirely capable of creating one.
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      found.push(u.id);
      queue.push(u.id);
    }
  }
  return found;
}

router.get('/', (req, res) => {
  const orgs = orgsFor(req.user);
  const narrowed = activeOrg(req);
  const scopeOrgs = narrowed ? [narrowed] : orgs;
  const orgList = scopeOrgs.map(() => '?').join(',') || "''";

  /**
   * A supervisor sees their own chain; an administrator sees the whole org.
   *
   * Anyone else sees themselves, which is not a punishment — it is what "My
   * Team" means for somebody with no reports, and an empty page would read as
   * broken.
   */
  const isAdmin = ['superadmin', 'admin'].includes(req.user.role);
  const ids = isAdmin
    ? all(`SELECT id FROM users WHERE active = 1 AND sales_org IN (${orgList})`, scopeOrgs).map((u) => u.id)
    : [req.user.id, ...reportsOf(req.user.id)];

  if (!ids.length) return res.json({ members: [], tree: [], totals: {} });
  const inList = ids.map(() => '?').join(',');

  const members = all(
    `SELECT u.id, u.name, u.email, u.role, u.sales_org, u.manager_id, u.branch,
            m.name AS manager_name,
            (SELECT COUNT(*) FROM leads l
              WHERE l.owner_id = u.id AND l.deleted_at IS NULL) AS leads,
            (SELECT COUNT(*) FROM leads l
              WHERE l.owner_id = u.id AND l.deleted_at IS NULL AND l.stage = 'Won') AS won,
            (SELECT COUNT(*) FROM clients c
              WHERE c.owner_id = u.id AND c.deleted_at IS NULL) AS clients,
            (SELECT COALESCE(SUM(c.brokerage_ytd), 0) FROM clients c
              WHERE c.owner_id = u.id AND c.deleted_at IS NULL) AS brokerage,
            (SELECT COALESCE(SUM(lm.aum), 0) FROM lead_metrics lm
               JOIN leads l ON l.id = lm.lead_id
              WHERE l.owner_id = u.id AND l.deleted_at IS NULL) AS aum,
            (SELECT COUNT(*) FROM tasks t
              WHERE t.assignee_id = u.id AND t.status = 'Open'
                AND t.due_at < datetime('now')) AS overdue
       FROM users u
       LEFT JOIN users m ON m.id = u.manager_id
      WHERE u.id IN (${inList}) AND u.active = 1
      ORDER BY u.name`,
    ids,
  ).map((u) => ({
    ...u,
    // Won over everything that has reached a decision, not over the whole book.
    conversion_pct: u.leads ? Math.round((u.won / u.leads) * 100) : null,
  }));

  /* The tree, assembled from the same rows rather than re-queried. Anyone whose
     manager is outside this set becomes a root, so a supervisor's own view is
     rooted at themselves rather than dangling under a manager they cannot see. */
  const byId = new Map(members.map((m) => [m.id, { ...m, reports: [] }]));
  const roots = [];
  for (const m of byId.values()) {
    const parent = m.manager_id && byId.get(m.manager_id);
    if (parent) parent.reports.push(m); else roots.push(m);
  }

  res.json({
    members,
    tree: roots,
    scope: isAdmin ? 'org' : 'chain',
    totals: {
      people: members.length,
      leads: members.reduce((s, m) => s + m.leads, 0),
      clients: members.reduce((s, m) => s + m.clients, 0),
      brokerage: members.reduce((s, m) => s + m.brokerage, 0),
      overdue: members.reduce((s, m) => s + m.overdue, 0),
    },
  });
});

/** The named teams, which exist alongside the reporting line. */
router.get('/groups', requirePermission('report.self'), (req, res) => {
  const orgs = orgsFor(req.user);
  const orgList = orgs.map(() => '?').join(',') || "''";

  res.json(all(
    `SELECT t.id, t.name, t.sales_org,
            (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS members
       FROM teams t
      WHERE t.sales_org IN (${orgList})
      ORDER BY t.name`,
    orgs,
  ).map((t) => ({
    ...t,
    people: all(
      `SELECT u.id, u.name, u.role FROM team_members tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? AND u.active = 1
        ORDER BY u.name`,
      [t.id],
    ),
  })));
});

export default router;
