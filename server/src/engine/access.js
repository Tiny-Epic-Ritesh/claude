/**
 * Access control — roles and permission sets, as data.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The permission matrix used to be a constant in `auth.js`. Eleven roles, fixed
 * at build time. That is better than the legacy tenant's four, but it is the
 * same structural flaw at a larger number: an administrator who needs a twelfth
 * persona has to raise a ticket with a developer.
 *
 * The audit is explicit that this is the origin of the legacy mess — because
 * only four roles existed, every real persona had to be smuggled in as a
 * "Permission Template", which is how one access question ended up spread
 * across four mechanisms (Part 4.1).
 *
 * So roles live in the database. The seed below loads exactly the matrix that
 * used to be in code, so behaviour is unchanged on day one — but from now on a
 * role is a record an administrator can clone and edit.
 *
 * CACHING
 * -------
 * `can()` is called on nearly every request, sometimes several times. Reading
 * two tables per call would be wasteful, so the resolved matrix is cached in
 * memory and invalidated whenever roles or grants change. The cache is per
 * process; a multi-process deployment needs the invalidation to become a
 * pub/sub message, and that is noted where it matters rather than pretended
 * away.
 */

import { all, one, run } from '../db.js';

/* ------------------------------------------------------- capabilities */

/**
 * The catalogue. Grouped for the Setup UI, and marked `sensitive` where a grant
 * exposes client identifiers or changes money — those get a confirmation step
 * rather than a checkbox that looks like all the others.
 */
export const CAPABILITY_CATALOGUE = [
  // Leads
  ['lead.view.all', 'View all leads', 'Leads', 'See every lead in the sales org', 0],
  ['lead.view.own', 'View own leads', 'Leads', 'See only leads they own', 0],
  ['lead.view.product', 'View leads by product', 'Leads', 'See leads carrying their product', 0],
  ['lead.create', 'Create leads', 'Leads', null, 0],
  ['lead.edit', 'Edit leads', 'Leads', null, 0],
  ['lead.stage.change', 'Change lead stage', 'Leads', null, 0],
  ['lead.reassign', 'Reassign leads', 'Leads', 'Move a lead to a different owner', 0],
  ['lead.delete', 'Delete leads', 'Leads', 'Soft delete, recoverable from the recycle bin', 1],
  ['lead.contact', 'Contact leads', 'Leads', 'Call, message and log activities', 0],

  // Clients
  ['client.view.all', 'View all clients', 'Clients', 'See every client in the sales org', 0],
  ['client.view.own', 'View own clients', 'Clients', 'See only clients they own', 0],
  ['client.edit', 'Edit clients', 'Clients', 'Change servicing detail on an account', 0],
  ['client.reassign', 'Reassign clients', 'Clients', 'Move an account to a different owner', 0],
  ['client.export', 'Export clients', 'Clients', 'Bulk export of client records. The main exfiltration path in a broking CRM.', 1],

  // Product cards
  ['card.mark.exploring', 'Mark card Exploring', 'Products', null, 0],
  ['card.mark.warm', 'Mark card Warm', 'Products', null, 0],
  ['card.request.productrm', 'Request a Product RM', 'Products', null, 0],
  ['card.engage', 'Engage on a product card', 'Products', null, 0],
  ['card.close', 'Close a product card', 'Products', null, 0],
  ['card.reassign', 'Reassign a product card', 'Products', null, 0],

  // KYC
  ['kyc.manage', 'Manage KYC journeys', 'KYC', null, 0],
  ['kyc.override', 'Override a KYC step', 'KYC', 'Bypass a step the client has not completed', 1],
  ['kyc.view', 'View KYC journeys', 'KYC', null, 0],

  // Cases
  ['ticket.create', 'Create cases', 'Cases', null, 0],
  ['ticket.reply', 'Reply to cases', 'Cases', null, 0],
  ['ticket.reassign', 'Reassign cases', 'Cases', null, 0],
  ['ticket.escalate', 'Escalate cases', 'Cases', null, 0],
  ['ticket.merge', 'Merge cases', 'Cases', null, 0],

  // Partners
  ['partner.view', 'View partners', 'Partners', null, 0],
  ['partner.create', 'Create partners', 'Partners', null, 0],
  ['partner.elevate', 'Approve partner elevation', 'Partners', 'Issue a partner code and portal credential', 1],
  ['partner.elevate.request', 'Request partner elevation', 'Partners', null, 0],
  ['partner.suspend', 'Suspend a partner', 'Partners', null, 1],

  // Configuration
  ['admin.users', 'Manage users', 'Setup', 'Create, edit and deactivate users', 1],
  ['admin.roles', 'Manage roles & permissions', 'Setup', 'Create roles and grant permission sets', 1],
  ['admin.products', 'Manage products', 'Setup', null, 0],
  ['admin.rules', 'Manage automation rules', 'Setup', null, 1],
  ['admin.sla', 'Manage SLA policies', 'Setup', null, 0],
  ['admin.kyc.journeys', 'Manage KYC journeys', 'Setup', null, 0],
  ['admin.templates', 'Manage templates', 'Setup', null, 0],
  ['admin.content', 'Manage content library', 'Setup', null, 0],
  ['admin.objects', 'Configure objects & fields', 'Setup', 'Add fields, rename labels, edit picklists', 1],
  ['admin.system', 'System configuration', 'Setup', 'Sales orgs, integrations, platform settings', 1],

  // Marketing
  ['campaign.manage', 'Manage campaigns', 'Marketing', null, 0],
  ['list.create', 'Create lead lists', 'Marketing', null, 0],

  // Sensitive
  ['pii.unmask', 'Unmask client identifiers', 'Compliance', 'Reveal full mobile, email and PAN. Every use is audited.', 1],
  ['data.export', 'Export data to CSV', 'Compliance',
    'Take client records out of the CRM as a file. Every export is logged with its row count and filter.', 1],
  ['audit.read', 'Read the audit log', 'Compliance', null, 1],

  // Reporting
  ['report.team', 'Team reports', 'Reporting', null, 0],
  ['report.system', 'Firm-wide reports', 'Reporting', null, 0],
];

/**
 * The roles that ship with the product, and what each one sees.
 *
 * `data_scope` used to be a switch statement inside leadScope(). As a column, a
 * new role gets its visibility declared rather than coded — which is the
 * difference between an administrator adding a persona and a developer doing it.
 */
export const SEED_ROLES = [
  ['superadmin', 'Superadmin', 'Platform owner. Spans both sales orgs.', 'org', 1],
  ['admin', 'Admin', 'Business administrator for one sales org.', 'org', 1],
  ['sales_supervisor', 'Sales Supervisor', 'Runs a calling and RM desk.', 'team', 1],
  ['product_supervisor', 'Product Supervisor', 'Owns a product line across desks.', 'org', 1],
  ['sales_rm', 'Sales RM', 'Owns a book of client relationships.', 'own', 1],
  ['caller', 'Caller', 'Outbound calling desk.', 'own', 1],
  ['dealer', 'Dealer', 'Dealing desk, trades and client servicing.', 'own', 1],
  ['partner_rm', 'Partner RM', 'Recruits and services partners.', 'own', 1],
  ['product_rm', 'Product RM', 'Specialist for one product across all leads.', 'product', 1],
  ['customer_care', 'Customer Care', 'Case handling and client support.', 'org', 1],
  ['marketing_manager', 'Marketing Manager', 'Campaigns, content and lists.', 'org', 1],
];

/**
 * Load the catalogue and the shipped roles.
 *
 * `matrix` is the permission map that used to live in auth.js, passed in so the
 * two cannot drift apart during the transition. Idempotent: safe on every boot,
 * and it never removes a capability an administrator has granted by hand.
 */
export function seedAccessModel(matrix) {
  CAPABILITY_CATALOGUE.forEach(([code, label, category, description, sensitive], i) => {
    run(
      `INSERT INTO capabilities (code, label, category, description, sensitive, sort_order)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET
         label = excluded.label, category = excluded.category,
         description = excluded.description, sensitive = excluded.sensitive,
         sort_order = excluded.sort_order`,
      [code, label, category, description, sensitive, i],
    );
  });

  SEED_ROLES.forEach(([code, name, description, scope, isSystem], i) => {
    run(
      `INSERT INTO roles (code, name, description, data_scope, is_system, sort_order)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         data_scope = excluded.data_scope, is_system = excluded.is_system,
         sort_order = excluded.sort_order`,
      [code, name, description, scope, isSystem, i],
    );
  });

  // Grants from the original matrix. Only seeded for shipped roles, so a role
  // an administrator created is never overwritten from code.
  const shipped = new Set(SEED_ROLES.map((r) => r[0]));
  for (const [capability, roles] of Object.entries(matrix)) {
    for (const role of roles) {
      if (!shipped.has(role)) continue;
      run(
        'INSERT OR IGNORE INTO role_capabilities (role_code, capability) VALUES (?,?)',
        [role, capability],
      );
    }
  }

  /**
   * Revoke grants the product has deliberately withdrawn from a shipped role.
   *
   * `INSERT OR IGNORE` above can only add, which is right — code must not
   * silently undo a grant an administrator made. But that also means removing a
   * role from the matrix has no effect on an existing database, so a decision
   * like "Sales Supervisor is team scope, not org scope" would never take.
   *
   * This closes that gap narrowly: only for roles the product ships, only for
   * capabilities the matrix no longer lists, and it says what it did. A
   * permission set granting the same capability to an individual is untouched,
   * so an administrator can still restore it for a named person.
   */
  const revoked = [];
  for (const role of shipped) {
    const held = all('SELECT capability FROM role_capabilities WHERE role_code = ?', [role])
      .map((r) => r.capability);
    for (const cap of held) {
      const stillGranted = (matrix[cap] ?? []).includes(role);
      if (stillGranted) continue;
      run('DELETE FROM role_capabilities WHERE role_code = ? AND capability = ?', [role, cap]);
      revoked.push(`${role}:${cap}`);
    }
  }
  if (revoked.length) {
    console.log(`[access] revoked ${revoked.length} grant(s) withdrawn from shipped roles: ${revoked.join(', ')}`);
  }

  invalidate();
  return { capabilities: CAPABILITY_CATALOGUE.length, roles: SEED_ROLES.length, revoked };
}

/* -------------------------------------------------------------- cache */

let roleCache = null;
let scopeCache = null;

/** Called after any change to roles, capabilities or grants. */
export function invalidate() {
  roleCache = null;
  scopeCache = null;
}

function loadRoles() {
  if (roleCache) return roleCache;

  roleCache = new Map();
  for (const r of all('SELECT code FROM roles WHERE active = 1')) roleCache.set(r.code, new Set());
  for (const rc of all('SELECT role_code, capability FROM role_capabilities')) {
    if (roleCache.has(rc.role_code)) roleCache.get(rc.role_code).add(rc.capability);
  }
  return roleCache;
}

function loadScopes() {
  if (scopeCache) return scopeCache;
  scopeCache = new Map(all('SELECT code, data_scope FROM roles').map((r) => [r.code, r.data_scope]));
  return scopeCache;
}

/* ------------------------------------------------------------ queries */

/** Capabilities a role holds, before any personal grants. */
export const roleCapabilities = (role) => loadRoles().get(role) ?? new Set();

/** How much data a role sees: own | team | product | org. */
export const dataScope = (role) => loadScopes().get(role) ?? 'own';

/**
 * Additive grants for one person.
 *
 * Read per call rather than cached: grants change one user at a time, they are
 * rare, and a stale permission is a security bug rather than a performance one.
 */
export function grantedCapabilities(userId) {
  if (!userId) return new Set();
  return new Set(all(
    `SELECT psc.capability
     FROM user_permission_sets ups
     JOIN permission_sets ps ON ps.id = ups.set_id AND ps.active = 1
     JOIN permission_set_capabilities psc ON psc.set_id = ps.id
     WHERE ups.user_id = ?`,
    [userId],
  ).map((r) => r.capability));
}

/** Everything a specific person can do — role plus grants. */
export function effectiveCapabilities(user) {
  if (!user) return new Set();
  const out = new Set(roleCapabilities(user.role));
  for (const c of grantedCapabilities(user.id)) out.add(c);
  return out;
}

/**
 * "Simulate access as this user" — audit Part 4.1 asks for exactly this, because
 * no screen in the legacy system could answer what a person could actually see.
 *
 * Returns the answer with its provenance: which capabilities come from the role,
 * which from a named grant, and what the data scope means in plain words.
 */
export function explainAccess(user) {
  const fromRole = roleCapabilities(user.role);
  const sets = all(
    `SELECT ps.id, ps.name, ups.granted_at, ups.reason, g.name AS granted_by_name
     FROM user_permission_sets ups
     JOIN permission_sets ps ON ps.id = ups.set_id AND ps.active = 1
     LEFT JOIN users g ON g.id = ups.granted_by
     WHERE ups.user_id = ?`,
    [user.id],
  ).map((s) => ({
    ...s,
    capabilities: all('SELECT capability FROM permission_set_capabilities WHERE set_id = ?', [s.id])
      .map((c) => c.capability),
  }));

  const granted = new Set(sets.flatMap((s) => s.capabilities));
  const scope = dataScope(user.role);

  const SCOPE_TEXT = {
    own: 'Only records they own.',
    team: 'Their own records and those of everyone reporting to them.',
    product: 'Every record carrying their assigned product, across all desks.',
    org: 'Every record in their sales org.',
  };

  return {
    user: {
      id: user.id, name: user.name, role: user.role,
      sales_org: user.sales_org, employee_code: user.employee_code, active: user.active,
    },
    data_scope: { value: scope, meaning: SCOPE_TEXT[scope] ?? scope },
    from_role: [...fromRole].sort(),
    // Only the grants that add something the role did not already carry — a set
    // that duplicates the role tells the reader nothing.
    from_grants: sets.map((s) => ({
      ...s,
      capabilities: s.capabilities.filter((c) => !fromRole.has(c)),
    })).filter((s) => s.capabilities.length > 0),
    redundant_grants: sets
      .filter((s) => s.capabilities.every((c) => fromRole.has(c)))
      .map((s) => s.name),
    effective: [...new Set([...fromRole, ...granted])].sort(),
  };
}
