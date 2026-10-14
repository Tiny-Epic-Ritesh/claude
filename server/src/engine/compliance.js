/**
 * Where each AI compliance flag sends its case (QA-28).
 *
 * The call disposition raises one of five flags. Until 14 October only
 * Complaint had a category; the other four opened uncategorised, with their
 * deadlines but nobody whose job they were. Ritesh accepted these defaults
 * that day, drawn from SEBI's Investor Charter for stock brokers, the Stock
 * Brokers Regulations' code of conduct and SCORES 2.0:
 *
 *   Complaint                      Complaint                         High      Customer Care
 *   Mis-selling risk               Mis-selling / misrepresentation   High      Compliance
 *   Guaranteed-return expectation  Assured-return claim              High      Compliance
 *   Regulatory mention             Regulatory escalation             Critical  Compliance
 *   Urgency on funds               Payout / Withdrawal               High      Customer Care
 *
 * Assured returns are their own category because a broker and its Authorised
 * Persons may not promise returns at all: a client who expects one was told
 * so by somebody, and that somebody is what gets investigated. A regulatory
 * mention is Critical because a complaint that reaches SCORES must be
 * resolved, and its action-taken report filed, within 21 calendar days.
 *
 * These are defaults. An Admin or Superadmin changes any flag's category or
 * priority in Setup -> SLA & categories, and the change is in the
 * configuration audit.
 */

import { one, run } from '../db.js';

export const COMPLIANCE_FLAGS = [
  'Complaint', 'Mis-selling risk', 'Guaranteed-return expectation', 'Regulatory mention', 'Urgency on funds',
];

export const CASE_PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

export const DEFAULT_ROUTES = [
  { flag: 'Complaint', category: 'Complaint', role: 'customer_care', priority: 'High' },
  { flag: 'Mis-selling risk', category: 'Mis-selling / misrepresentation', role: 'compliance', priority: 'High' },
  { flag: 'Guaranteed-return expectation', category: 'Assured-return claim', role: 'compliance', priority: 'High' },
  { flag: 'Regulatory mention', category: 'Regulatory escalation', role: 'compliance', priority: 'Critical' },
  { flag: 'Urgency on funds', category: 'Payout / Withdrawal', role: 'customer_care', priority: 'High' },
];

/**
 * Give every flag its default route, once.
 *
 * A flag that already has a route is left alone, whatever it says -- an
 * Admin's choice is not undone by a restart, and a category an Admin retired
 * or deleted is not quietly brought back. Only a flag with no route at all
 * gets its default, and only then is its category created if it is missing.
 */
export function ensureComplianceRouting() {
  for (const d of DEFAULT_ROUTES) {
    if (one('SELECT flag FROM compliance_flag_routes WHERE flag = ?', [d.flag])) continue;
    let category = one('SELECT id FROM ticket_categories WHERE name = ?', [d.category]);
    if (!category) {
      category = { id: Number(run('INSERT INTO ticket_categories (name, auto_assign_role) VALUES (?,?)', [d.category, d.role]).lastInsertRowid) };
    }
    run('INSERT INTO compliance_flag_routes (flag, category_id, priority) VALUES (?,?,?)', [d.flag, category.id, d.priority]);
  }
}

/**
 * The case a flag opens: its category, if that category is still live, and
 * its priority. A retired category opens the case uncategorised rather than
 * refusing it -- the client's problem still needs an owner and a deadline.
 */
export function routeFor(flag) {
  const route = one(
    `SELECT r.priority, c.id AS category_id, c.name AS category_name, c.auto_assign_role
       FROM compliance_flag_routes r
       LEFT JOIN ticket_categories c ON c.id = r.category_id AND c.active = 1
      WHERE r.flag = ?`,
    [flag],
  );
  return {
    priority: route?.priority ?? 'High',
    categoryId: route?.category_id ?? null,
    categoryName: route?.category_name ?? null,
  };
}

/** Every flag with its route, for the Setup screen. */
export function listRoutes() {
  return COMPLIANCE_FLAGS.map((flag) => {
    const r = one(
      `SELECT r.flag, r.category_id, r.priority, r.updated_at, u.name AS updated_by_name,
              c.name AS category_name, c.active AS category_active, c.auto_assign_role
         FROM compliance_flag_routes r
         LEFT JOIN ticket_categories c ON c.id = r.category_id
         LEFT JOIN users u ON u.id = r.updated_by
        WHERE r.flag = ?`,
      [flag],
    );
    return r ?? { flag, category_id: null, priority: 'High' };
  });
}

/**
 * Change a flag's route. Returns `{ error }` for anything Setup should refuse.
 * The before and after go to the configuration audit.
 */
export function setRoute(flag, { category_id: categoryId, priority }, actorId) {
  if (!COMPLIANCE_FLAGS.includes(flag)) return { error: 'There is no such compliance flag', status: 404 };
  if (!CASE_PRIORITIES.includes(priority)) {
    return { error: `Priority must be one of ${CASE_PRIORITIES.join(', ')}`, field: 'priority' };
  }
  const category = one('SELECT id, name, active FROM ticket_categories WHERE id = ?', [Number(categoryId)]);
  if (!category || !category.active) return { error: 'Choose a category that is in use', field: 'category_id' };

  const before = one('SELECT category_id, priority FROM compliance_flag_routes WHERE flag = ?', [flag]) ?? null;
  run(
    `INSERT INTO compliance_flag_routes (flag, category_id, priority, updated_by, updated_at)
     VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(flag) DO UPDATE SET category_id = excluded.category_id, priority = excluded.priority,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [flag, category.id, priority, actorId],
  );
  run(
    'INSERT INTO config_audit (area, target, action, before_json, after_json, actor_id) VALUES (?,?,?,?,?,?)',
    ['compliance_flag', flag, 'update', JSON.stringify(before), JSON.stringify({ category_id: category.id, priority }), actorId],
  );
  return { flag, category_id: category.id, category_name: category.name, priority };
}

/* At boot, the way auth.js seeds the access model: routes/ai.js imports this
   module, so every start gives a flag with no route its default. Idempotent,
   and it never changes a route that exists. */
ensureComplianceRouting();
