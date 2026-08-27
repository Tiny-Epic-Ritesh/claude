/**
 * Tab visibility (ENH-08).
 *
 * Role-level defaults, with a per-user override on top. Confirmed model.
 *
 * Worth stating where the code can see it: **hiding a tab is navigation, not
 * security.** The API enforces capability independently, so removing a tab
 * tidies someone's screen and does not protect a single record — a user without
 * `lead.view.all` still cannot read other people's leads by typing the URL.
 * The two work together and neither substitutes for the other. Anyone reading
 * this file to answer "is that person locked out of X?" is reading the wrong
 * file; the answer is in engine/access.js.
 *
 * Resolution order, most specific first:
 *
 *   1. a user row      — an administrator's decision about one person
 *   2. a role row      — an administrator's decision about a role
 *   3. the shipped default below
 *
 * Absence at every level means "fall through", which is why nothing is written
 * at install time. A shipped default can then change in a later release without
 * silently overwriting a choice somebody made.
 */

import { all, one, run } from '../db.js';

/**
 * The confirmed matrix, as the roles that see each tab.
 *
 * Stored this way round because it is how the decisions were actually made —
 * "who should see Approvals?" — and because a tab added later needs one line
 * here rather than an edit to eleven role lists.
 */
export const DEFAULT_VISIBILITY = {
  home: 'ALL',
  tasks: 'ALL',

  // Marketing needs to sanity-check a segment before sending. They get the tab
  // read-only and masked rather than building blind and asking an RM to look.
  leads: ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor', 'marketing_manager'],

  clients: ['superadmin', 'admin', 'dealer', 'sales_rm', 'sales_supervisor',
    'product_rm', 'product_supervisor', 'customer_care'],

  pipeline: ['superadmin', 'admin', 'dealer', 'sales_rm', 'sales_supervisor',
    'product_rm', 'product_supervisor'],

  products: ['superadmin', 'admin', 'dealer', 'sales_rm', 'sales_supervisor',
    'product_rm', 'product_supervisor'],

  lists: ['superadmin', 'admin', 'sales_rm', 'sales_supervisor', 'marketing_manager'],

  calendar: ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor', 'customer_care'],

  tickets: ['superadmin', 'admin', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor', 'customer_care'],

  ccm: ['superadmin', 'admin', 'customer_care'],

  kyc: ['superadmin', 'admin', 'sales_rm', 'sales_supervisor', 'product_rm', 'product_supervisor'],

  // A supervisor asking why the team's numbers moved needs to see which partner
  // sourced the leads. Read-only; onboarding stays with Partner RM.
  partners: ['superadmin', 'admin', 'sales_supervisor', 'partner_rm'],

  // Four approvers, not five. Partner RM raises and can watch their own
  // requests, but a supervisor or admin approves — maker-checker separation.
  approvals: ['superadmin', 'admin', 'sales_supervisor', 'product_supervisor', 'partner_rm'],

  // Not Customer Care: an agent who glances at a price move and offers a view
  // has given unsolicited investment advice. Marketing does get it — campaign
  // timing keys off Budget day, a large IPO, a volatility spike.
  market: ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor', 'marketing_manager'],

  campaigns: ['superadmin', 'admin', 'marketing_manager'],

  content: ['superadmin', 'admin', 'sales_rm', 'sales_supervisor', 'partner_rm',
    'product_rm', 'product_supervisor', 'customer_care', 'marketing_manager'],

  // Customer Care is an agent role, not a supervisor, so no Team.
  team: ['superadmin', 'admin', 'sales_supervisor', 'partner_rm', 'product_supervisor'],

  // Sales RM sees their own numbers. Hiding them creates a standing dependency
  // on the supervisor for trivial questions, which is how teams end up in Excel.
  revenue: ['superadmin', 'admin', 'sales_rm', 'sales_supervisor', 'partner_rm', 'product_supervisor'],

  kra: ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor', 'customer_care'],

  // Incentives here is revenue-linked payout, and a service agent would see
  // zero on it forever. KRA carries their measures instead.
  incentives: ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor'],

  reports: ['superadmin', 'admin', 'sales_rm', 'sales_supervisor', 'partner_rm',
    'product_supervisor', 'customer_care', 'marketing_manager'],

  dashboards: ['superadmin', 'admin', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor', 'customer_care', 'marketing_manager'],

  data: ['superadmin', 'admin', 'sales_supervisor', 'marketing_manager'],

  setup: ['superadmin', 'admin'],

  /* Not a tab -- a feature, carried on the same mechanism (ENH-04).
   *
   * The market ticker appears on every page, so it has no tab of its own to
   * hang visibility from. Rather than build a second configuration surface with
   * its own table, its own audit path and its own bugs, it is a row here: the
   * resolution order, the per-user override and the audit trail are all already
   * correct, and an administrator learns one screen instead of two.
   *
   * Same default as the Market tab. A service desk does not get it, for the
   * same reason: an agent who glances at a price move and offers a view has
   * given unsolicited investment advice. */
  market_ticker: ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor',
    'partner_rm', 'product_rm', 'product_supervisor', 'marketing_manager'],
};

/**
 * Keys that are features rather than tabs.
 *
 * They resolve through exactly the same rules; they simply have no destination,
 * so navigation must not try to render them as somewhere to go.
 */
export const FEATURE_KEYS = ['market_ticker'];

export const FEATURE_LABEL = {
  market_ticker: 'Market ticker (all pages)',
};

/** The shipped answer for one role and tab, before any configuration. */
export function shippedDefault(role, tabId) {
  const rule = DEFAULT_VISIBILITY[tabId];
  // A tab with no rule is visible. A new tab appearing invisible to everybody
  // looks exactly like a broken deploy, and someone loses an afternoon to it.
  if (rule === undefined) return true;
  if (rule === 'ALL') return true;
  return rule.includes(role);
}

const rowsFor = (scopeType, scopeKey) => {
  const map = new Map();
  for (const r of all(
    'SELECT tab_id, visible FROM tab_visibility WHERE scope_type = ? AND scope_key = ?',
    [scopeType, String(scopeKey)],
  )) map.set(r.tab_id, Boolean(r.visible));
  return map;
};

/**
 * Is this tab visible to this user?
 *
 * Returns the answer and, more usefully, where it came from — so Setup can show
 * an administrator *why* someone sees a tab rather than only that they do. The
 * audit found that "why can they see this?" was the question nobody could
 * answer in the legacy tenant.
 */
export function resolveTab(user, tabId, cache = null) {
  const userRows = cache?.user ?? rowsFor('user', user.id);
  if (userRows.has(tabId)) {
    return { visible: userRows.get(tabId), source: 'user' };
  }
  const roleRows = cache?.role ?? rowsFor('role', user.role);
  if (roleRows.has(tabId)) {
    return { visible: roleRows.get(tabId), source: 'role' };
  }
  return { visible: shippedDefault(user.role, tabId), source: 'default' };
}

/** A cache so resolving twenty-four tabs is two queries, not forty-eight. */
export const visibilityCache = (user) => ({
  user: rowsFor('user', user.id),
  role: rowsFor('role', user.role),
});

/** The set of tab ids this user may see. */
export function visibleTabs(user, tabIds) {
  const cache = visibilityCache(user);
  return new Set(tabIds.filter((id) => resolveTab(user, id, cache).visible));
}

/* ------------------------------------------------------------- writing */

function write(scopeType, scopeKey, tabId, visible, actorId) {
  run(
    `INSERT INTO tab_visibility (scope_type, scope_key, tab_id, visible, updated_by, updated_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(scope_type, scope_key, tab_id) DO UPDATE SET
       visible = excluded.visible, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [scopeType, String(scopeKey), tabId, visible ? 1 : 0, actorId ?? null],
  );
}

export const setRoleTab = (role, tabId, visible, actorId) =>
  write('role', role, tabId, visible, actorId);

export const setUserTab = (userId, tabId, visible, actorId) =>
  write('user', userId, tabId, visible, actorId);

/**
 * Drop an override so the person falls back to their role.
 *
 * Distinct from setting it to visible: "same as their role" and "explicitly
 * granted to this person" are different decisions, and only one of them should
 * survive a change to the role.
 */
export const clearUserTab = (userId, tabId) =>
  run('DELETE FROM tab_visibility WHERE scope_type = ? AND scope_key = ? AND tab_id = ?',
    ['user', String(userId), tabId]);

export const clearRoleTab = (role, tabId) =>
  run('DELETE FROM tab_visibility WHERE scope_type = ? AND scope_key = ? AND tab_id = ?',
    ['role', role, tabId]);

/** Every override on one user, for the Setup screen. */
export const overridesFor = (userId) =>
  all('SELECT tab_id, visible FROM tab_visibility WHERE scope_type = ? AND scope_key = ?',
    ['user', String(userId)]);

/** The full grid for Setup: one row per role, one column per tab. */
export function matrix(roles, tabIds) {
  const configured = new Map();
  for (const r of all("SELECT scope_key, tab_id, visible FROM tab_visibility WHERE scope_type = 'role'")) {
    configured.set(`${r.scope_key}|${r.tab_id}`, Boolean(r.visible));
  }

  return roles.map((role) => ({
    role,
    tabs: Object.fromEntries(tabIds.map((tabId) => {
      const key = `${role}|${tabId}`;
      const isConfigured = configured.has(key);
      return [tabId, {
        visible: isConfigured ? configured.get(key) : shippedDefault(role, tabId),
        source: isConfigured ? 'role' : 'default',
      }];
    })),
  }));
}

/** How many people have an exception, so Setup can surface it. */
export const overrideCount = () =>
  one("SELECT COUNT(DISTINCT scope_key) n FROM tab_visibility WHERE scope_type = 'user'").n;
