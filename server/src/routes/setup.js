/**
 * Setup — users, roles, permission sets and access simulation.
 *
 * The audit's Part 4 complaint is that four overlapping mechanisms decide
 * access and no screen answers "what can this person actually see?". Everything
 * here exists to make that question answerable:
 *
 *   GET /setup/users/:id/access   the answer, with its provenance
 *
 * Two mechanisms only — role (what the persona does) and permission set
 * (the exceptions) — and both are editable by an administrator.
 *
 * DEACTIVATE, NEVER DELETE
 * ------------------------
 * A user who has logged calls, owned leads and signed off KYC steps cannot be
 * removed without destroying the attribution on all of it. So there is no user
 * delete: `active = 0` blocks sign-in and stops new work being routed, while
 * every historical record keeps its author. The audit's Finding 7 is about
 * exactly this — attribution that cannot be traced to a human.
 */

import { Router } from 'express';
import { all, one, run, audit, transact, SALES_ORGS, CARD_STATES } from '../db.js';
import {
  requireUser, requirePermission, orgsFor, mayUseOrg, can, permissionsFor,
} from '../auth.js';
import { hashPassword, validate } from '../security.js';
import {
  invalidate, explainAccess, dataScope, CAPABILITY_CATALOGUE,
} from '../engine/access.js';
import { vendorStatus } from '../vendors/config.js';
import { explainVisibility } from '../engine/sharing.js';
import {
  entities, entityDef, fieldsOf, fieldDef, picklistValues, historyFor,
  stageDurations, auditConfig, typeOf, FIELD_TYPES,
} from '../engine/metadata.js';
import {
  validateFormula, validateRollup, describeFormula, describeRollup, catalogue,
} from '../engine/formulas.js';

import {
  matrix as tabMatrix, setRoleTab, clearRoleTab, setUserTab, clearUserTab,
  overridesFor, resolveTab, shippedDefault, overrideCount,
  FEATURE_KEYS, FEATURE_LABEL,
} from '../engine/tabs.js';
import { TABS } from './apps.js';
import {
  MASKABLE, FIELD_LABEL, maskingMatrix, setMasking, clearMasking, maskedFieldsFor,
} from '../engine/masking.js';
const router = Router();
router.use(requireUser);

/* ---------------------------------------------------------- catalogue */

/** The capability catalogue, grouped for the permissions matrix screen. */
router.get('/capabilities', requirePermission('admin.roles'), (_req, res) => {
  const rows = all('SELECT * FROM capabilities ORDER BY sort_order');
  const grouped = new Map();
  for (const c of rows) {
    if (!grouped.has(c.category)) grouped.set(c.category, []);
    grouped.get(c.category).push(c);
  }
  res.json({
    categories: [...grouped.entries()].map(([category, capabilities]) => ({ category, capabilities })),
    total: rows.length,
  });
});

/* -------------------------------------------------------------- roles */

router.get('/roles', requirePermission('admin.roles'), (_req, res) => {
  const roles = all('SELECT * FROM roles ORDER BY sort_order, name');
  res.json(roles.map((r) => ({
    ...r,
    capabilities: all('SELECT capability FROM role_capabilities WHERE role_code = ?', [r.code])
      .map((c) => c.capability),
    user_count: one('SELECT COUNT(*) n FROM users WHERE role = ? AND active = 1', [r.code]).n,
  })));
});

/**
 * Create a role. This is the capability the legacy system lacked entirely —
 * four fixed roles meant every new persona became a "Permission Template",
 * which is how one question ended up spread across four mechanisms.
 */
router.post('/roles', requirePermission('admin.roles'), (req, res) => {
  const { code, name, description, data_scope: scope = 'own', capabilities = [], clone_from: cloneFrom } = req.body;

  const invalid = validate(req.body, { code: ['required', 'max:40'], name: ['required', 'max:80'] });
  if (invalid) return res.status(400).json(invalid);

  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    return res.status(400).json({ error: 'Code must be lowercase letters, digits and underscores', field: 'code' });
  }
  if (one('SELECT code FROM roles WHERE code = ?', [code])) {
    return res.status(409).json({ error: `A role with code "${code}" already exists`, field: 'code' });
  }
  if (!['own', 'team', 'product', 'org'].includes(scope)) {
    return res.status(400).json({ error: 'data_scope must be own, team, product or org', field: 'data_scope' });
  }

  run(
    `INSERT INTO roles (code, name, description, data_scope, is_system, sort_order)
     VALUES (?,?,?,?,0,(SELECT COALESCE(MAX(sort_order),0)+1 FROM roles))`,
    [code, name, description ?? null, scope],
  );

  // Cloning is how an administrator actually works: start from the nearest
  // existing persona and adjust, rather than tick forty boxes from empty.
  const grants = cloneFrom
    ? all('SELECT capability FROM role_capabilities WHERE role_code = ?', [cloneFrom]).map((c) => c.capability)
    : capabilities;

  for (const c of grants) {
    if (one('SELECT code FROM capabilities WHERE code = ?', [c])) {
      run('INSERT OR IGNORE INTO role_capabilities (role_code, capability) VALUES (?,?)', [code, c]);
    }
  }

  invalidate();
  audit(req.user.id, 'role_created', 'role', null, { code, scope, cloned_from: cloneFrom ?? null, grants: grants.length });
  return res.status(201).json(one('SELECT * FROM roles WHERE code = ?', [code]));
});

/** Update a role's capabilities and scope. System roles may be edited, not deleted. */
router.patch('/roles/:code', requirePermission('admin.roles'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE code = ?', [req.params.code]);
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const { name, description, data_scope: scope, capabilities, active } = req.body;

  /* COALESCE keeps an omitted name, but an empty string is not null, so a blank
     one would be stored and the role would lose its name in every list that
     shows it. Absent is fine; present and blank is not. */
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'A role needs a name', field: 'name' });
  }

  if (scope && !['own', 'team', 'product', 'org'].includes(scope)) {
    return res.status(400).json({ error: 'data_scope must be own, team, product or org', field: 'data_scope' });
  }

  // Locking yourself out is the classic administration accident, and it is
  // unrecoverable without database access. Refuse it.
  if (capabilities && role.code === req.user.role && !capabilities.includes('admin.roles')) {
    return res.status(400).json({
      error: 'That would remove your own ability to manage roles. Grant it to another role first.',
      field: 'capabilities',
    });
  }
  if (active === 0 && role.is_system) {
    return res.status(400).json({ error: 'System roles cannot be deactivated' });
  }

  run(
    `UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description),
                      data_scope = COALESCE(?, data_scope), active = COALESCE(?, active)
     WHERE code = ?`,
    [name ?? null, description ?? null, scope ?? null, active ?? null, role.code],
  );

  if (Array.isArray(capabilities)) {
    const valid = new Set(all('SELECT code FROM capabilities').map((c) => c.code));
    run('DELETE FROM role_capabilities WHERE role_code = ?', [role.code]);
    for (const c of capabilities) {
      if (valid.has(c)) run('INSERT OR IGNORE INTO role_capabilities (role_code, capability) VALUES (?,?)', [role.code, c]);
    }
  }

  invalidate();
  audit(req.user.id, 'role_updated', 'role', null, { code: role.code, scope: scope ?? role.data_scope });
  return res.json(one('SELECT * FROM roles WHERE code = ?', [role.code]));
});

router.delete('/roles/:code', requirePermission('admin.roles'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE code = ?', [req.params.code]);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'System roles cannot be deleted' });

  const holders = one('SELECT COUNT(*) n FROM users WHERE role = ?', [role.code]).n;
  if (holders > 0) {
    return res.status(409).json({
      error: `${holders} user${holders === 1 ? '' : 's'} still hold this role. Move them first.`,
      user_count: holders,
    });
  }

  run('DELETE FROM roles WHERE code = ?', [role.code]);
  invalidate();
  audit(req.user.id, 'role_deleted', 'role', null, { code: role.code });
  return res.status(204).end();
});

/* --------------------------------------------------- permission sets */

router.get('/permission-sets', requirePermission('admin.roles'), (req, res) => {
  const orgs = orgsFor(req.user);
  const rows = all(
    `SELECT * FROM permission_sets
     WHERE active = 1 AND (sales_org IS NULL OR sales_org IN (${orgs.map(() => '?').join(',') || 'NULL'}))
     ORDER BY name`,
    orgs,
  );
  res.json(rows.map((s) => ({
    ...s,
    capabilities: all('SELECT capability FROM permission_set_capabilities WHERE set_id = ?', [s.id]).map((c) => c.capability),
    holders: one('SELECT COUNT(*) n FROM user_permission_sets WHERE set_id = ?', [s.id]).n,
  })));
});

router.post('/permission-sets', requirePermission('admin.roles'), (req, res) => {
  const { name, description, sales_org: org = null, capabilities = [] } = req.body;
  const invalid = validate(req.body, { name: ['required', 'max:80'] });
  if (invalid) return res.status(400).json(invalid);
  if (org && !mayUseOrg(req.user, org)) return res.status(403).json({ error: `You cannot create sets in ${org}` });

  const result = run(
    'INSERT INTO permission_sets (name, description, sales_org, created_by) VALUES (?,?,?,?)',
    [name, description ?? null, org, req.user.id],
  );
  const id = Number(result.lastInsertRowid);

  const valid = new Set(all('SELECT code FROM capabilities').map((c) => c.code));
  for (const c of capabilities) {
    if (valid.has(c)) run('INSERT OR IGNORE INTO permission_set_capabilities (set_id, capability) VALUES (?,?)', [id, c]);
  }

  invalidate();
  audit(req.user.id, 'permission_set_created', 'permission_set', id, { name, capabilities });
  return res.status(201).json(one('SELECT * FROM permission_sets WHERE id = ?', [id]));
});

/** Grant a set to a person. Dated, attributed and reasoned — it is an audit trail. */
router.post('/users/:id/permission-sets', requirePermission('admin.roles'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!mayUseOrg(req.user, user.sales_org)) return res.status(403).json({ error: 'That user is outside your sales org' });

  const { set_id: setId, reason } = req.body;
  const set = one('SELECT * FROM permission_sets WHERE id = ? AND active = 1', [setId]);
  if (!set) return res.status(404).json({ error: 'Permission set not found' });

  run(
    'INSERT OR REPLACE INTO user_permission_sets (user_id, set_id, granted_by, reason) VALUES (?,?,?,?)',
    [user.id, set.id, req.user.id, reason ?? null],
  );
  audit(req.user.id, 'permission_set_granted', 'user', user.id, { set: set.name, reason: reason ?? null });
  return res.status(201).json(explainAccess(one('SELECT * FROM users WHERE id = ?', [user.id])));
});

router.delete('/users/:id/permission-sets/:setId', requirePermission('admin.roles'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!mayUseOrg(req.user, user.sales_org)) return res.status(403).json({ error: 'That user is outside your sales org' });

  run('DELETE FROM user_permission_sets WHERE user_id = ? AND set_id = ?', [user.id, req.params.setId]);
  audit(req.user.id, 'permission_set_revoked', 'user', user.id, { set_id: Number(req.params.setId) });
  return res.json(explainAccess(one('SELECT * FROM users WHERE id = ?', [user.id])));
});

/* -------------------------------------------------------------- users */

router.get('/users', requirePermission('admin.users'), (req, res) => {
  const orgs = orgsFor(req.user);
  const placeholders = orgs.map(() => '?').join(',') || 'NULL';

  const rows = all(
    `SELECT u.id, u.name, u.email, u.role, u.active, u.employee_code, u.branch,
            u.sales_org, u.org_access, u.manager_id, u.product_type_id, u.phone,
            u.phone_extension, u.created_at,
            m.name AS manager_name, pt.name AS product_name, r.name AS role_name,
            (SELECT COUNT(*) FROM leads WHERE owner_id = u.id AND deleted_at IS NULL) AS lead_count,
            (SELECT COUNT(*) FROM user_permission_sets WHERE user_id = u.id) AS grant_count
     FROM users u
     LEFT JOIN users m ON m.id = u.manager_id
     LEFT JOIN product_types pt ON pt.id = u.product_type_id
     LEFT JOIN roles r ON r.code = u.role
     WHERE u.sales_org IN (${placeholders})
     ORDER BY u.active DESC, u.name`,
    orgs,
  );

  // Licensing note: there is deliberately no seat cap. The legacy tenant is
  // capped at 132 and running 83; the brief asked for no user limit.
  res.json({ users: rows, total: rows.length, active: rows.filter((u) => u.active).length });
});

router.post('/users', requirePermission('admin.users'), (req, res) => {
  const {
    name, email, role, password, sales_org: org, org_access: orgAccess,
    manager_id: managerId, product_type_id: productTypeId,
    employee_code: employeeCode, branch, phone, phone_extension: ext, whatsapp,
  } = req.body;

  const invalid = validate(req.body, {
    name: ['required', 'max:120'], email: ['required', 'email'], role: ['required'],
  });
  if (invalid) return res.status(400).json(invalid);

  if (one('SELECT id FROM users WHERE lower(email) = lower(?)', [email])) {
    return res.status(409).json({ error: 'That email already belongs to a user', field: 'email' });
  }
  if (!one('SELECT code FROM roles WHERE code = ? AND active = 1', [role])) {
    return res.status(400).json({ error: `"${role}" is not an active role`, field: 'role' });
  }

  const targetOrg = org || req.user.sales_org || 'BONANZA';
  if (!mayUseOrg(req.user, targetOrg)) {
    return res.status(403).json({ error: `You cannot create users in ${targetOrg}`, field: 'sales_org' });
  }

  // Cross-org access is granted, never inherited — the default is the user's
  // own book and nothing else.
  let access = null;
  if (Array.isArray(orgAccess) && orgAccess.length) {
    const bad = orgAccess.filter((o) => !SALES_ORGS.includes(o) || !mayUseOrg(req.user, o));
    if (bad.length) return res.status(403).json({ error: `You cannot grant access to ${bad.join(', ')}`, field: 'org_access' });
    access = JSON.stringify(orgAccess);
  }

  if (employeeCode && one('SELECT id FROM users WHERE employee_code = ?', [employeeCode])) {
    return res.status(409).json({ error: 'That employee code is already in use', field: 'employee_code' });
  }

  // A password is set by the administrator; there is no self-signup.
  const initial = password && String(password).length >= 8
    ? String(password)
    : `Bnz-${Math.random().toString(36).slice(2, 10)}`;

  const result = run(
    `INSERT INTO users (name, email, password, role, product_type_id, manager_id, phone,
                        sales_org, org_access, employee_code, branch, phone_extension, whatsapp, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      name, email, hashPassword(initial), role, productTypeId ?? null, managerId ?? null,
      phone ?? null, targetOrg, access, employeeCode ?? null, branch ?? null, ext ?? null, whatsapp ?? null,
    ],
  );
  const id = Number(result.lastInsertRowid);

  audit(req.user.id, 'user_created', 'user', id, { name, role, sales_org: targetOrg });

  return res.status(201).json({
    user: one('SELECT id, name, email, role, sales_org, employee_code, active FROM users WHERE id = ?', [id]),
    // Returned once, never stored in the clear, so the administrator can hand it over.
    initial_password: password ? null : initial,
  });
});

router.patch('/users/:id', requirePermission('admin.users'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!mayUseOrg(req.user, user.sales_org)) return res.status(403).json({ error: 'That user is outside your sales org' });

  const {
    name, role, manager_id: managerId, product_type_id: productTypeId,
    employee_code: employeeCode, branch, phone, phone_extension: ext, whatsapp,
    org_access: orgAccess, password,
  } = req.body;

  if (role && !one('SELECT code FROM roles WHERE code = ? AND active = 1', [role])) {
    return res.status(400).json({ error: `"${role}" is not an active role`, field: 'role' });
  }
  if (managerId && Number(managerId) === user.id) {
    return res.status(400).json({ error: 'A user cannot report to themselves', field: 'manager_id' });
  }

  let access;
  if (Array.isArray(orgAccess)) {
    const bad = orgAccess.filter((o) => !SALES_ORGS.includes(o) || !mayUseOrg(req.user, o));
    if (bad.length) return res.status(403).json({ error: `You cannot grant access to ${bad.join(', ')}`, field: 'org_access' });
    access = orgAccess.length ? JSON.stringify(orgAccess) : null;
  }

  run(
    `UPDATE users SET
       name = COALESCE(?, name), role = COALESCE(?, role),
       manager_id = COALESCE(?, manager_id), product_type_id = COALESCE(?, product_type_id),
       employee_code = COALESCE(?, employee_code), branch = COALESCE(?, branch),
       phone = COALESCE(?, phone), phone_extension = COALESCE(?, phone_extension),
       whatsapp = COALESCE(?, whatsapp),
       org_access = ${access === undefined ? 'org_access' : '?'}
     WHERE id = ?`,
    access === undefined
      ? [name ?? null, role ?? null, managerId ?? null, productTypeId ?? null, employeeCode ?? null,
        branch ?? null, phone ?? null, ext ?? null, whatsapp ?? null, user.id]
      : [name ?? null, role ?? null, managerId ?? null, productTypeId ?? null, employeeCode ?? null,
        branch ?? null, phone ?? null, ext ?? null, whatsapp ?? null, access, user.id],
  );

  if (password) {
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters', field: 'password' });
    }
    run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(String(password)), user.id]);
    run("DELETE FROM sessions WHERE user_id = ?", [user.id]);   // force re-auth everywhere
    audit(req.user.id, 'user_password_reset', 'user', user.id, {});
  }

  audit(req.user.id, 'user_updated', 'user', user.id, { fields: Object.keys(req.body) });
  return res.json(one('SELECT id, name, email, role, sales_org, employee_code, branch, active FROM users WHERE id = ?', [user.id]));
});

/**
 * Activate or deactivate. There is deliberately no delete.
 *
 * A user who has logged calls and owned leads cannot be removed without
 * destroying attribution on all of it — which is Finding 7's complaint about
 * the legacy shared accounts, arrived at from the other direction.
 */
router.post('/users/:id/active', requirePermission('admin.users'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!mayUseOrg(req.user, user.sales_org)) return res.status(403).json({ error: 'That user is outside your sales org' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate yourself' });

  const active = req.body.active ? 1 : 0;

  // Deactivating someone holding live work silently orphans it. Say so, and
  // require the caller to acknowledge or hand the book over first.
  if (!active) {
    const openLeads = one(
      "SELECT COUNT(*) n FROM leads WHERE owner_id = ? AND deleted_at IS NULL AND stage NOT IN ('Won','Lost')",
      [user.id],
    ).n;
    const openTasks = one("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'Open'", [user.id]).n;

    if ((openLeads || openTasks) && !req.body.reassign_to && !req.body.acknowledge_orphans) {
      return res.status(409).json({
        error: 'This user still holds live work.',
        open_leads: openLeads,
        open_tasks: openTasks,
        hint: 'Pass reassign_to with a user id to hand the book over, or acknowledge_orphans to proceed anyway.',
      });
    }

    if (req.body.reassign_to) {
      const target = one('SELECT id, name, sales_org FROM users WHERE id = ? AND active = 1', [req.body.reassign_to]);
      if (!target) return res.status(400).json({ error: 'The user to reassign to is not active', field: 'reassign_to' });
      if (target.sales_org !== user.sales_org) {
        return res.status(400).json({ error: 'Cannot hand a book to a different sales org', field: 'reassign_to' });
      }
      run("UPDATE leads SET owner_id = ? WHERE owner_id = ? AND deleted_at IS NULL AND stage NOT IN ('Won','Lost')", [target.id, user.id]);
      run("UPDATE tasks SET assignee_id = ? WHERE assignee_id = ? AND status = 'Open'", [target.id, user.id]);
      audit(req.user.id, 'book_reassigned', 'user', user.id, { to: target.id, leads: openLeads, tasks: openTasks });
    }

    // Sessions die immediately; a deactivated user must not keep working.
    run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    run('UPDATE team_members SET accepting = 0 WHERE user_id = ?', [user.id]);
  } else {
    run('UPDATE team_members SET accepting = 1 WHERE user_id = ?', [user.id]);
  }

  run('UPDATE users SET active = ? WHERE id = ?', [active, user.id]);
  audit(req.user.id, active ? 'user_activated' : 'user_deactivated', 'user', user.id, {
    reassigned_to: req.body.reassign_to ?? null,
  });

  return res.json(one('SELECT id, name, email, role, active FROM users WHERE id = ?', [user.id]));
});

/* -------------------------------------------------- access simulation */

/**
 * "What can this person actually see?" — audit Part 4.1.
 *
 * Answered with provenance: which capabilities come from the role, which from a
 * named grant and who granted it, what the data scope means in words, and which
 * grants are redundant because the role already carries them. That last one is
 * how permission sprawl gets cleaned up rather than accumulated.
 */
router.get('/users/:id/access', requirePermission('admin.roles'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!mayUseOrg(req.user, user.sales_org)) return res.status(403).json({ error: 'That user is outside your sales org' });

  const explained = explainAccess(user);

  // What the scope resolves to in practice, so the answer is a number and not
  // just a word. Built as a small lookup rather than nested ternaries, because
  // the person reading this next needs to check it against leadScope().
  const scopeSql = () => {
    if (can(user.role, 'lead.view.all') || dataScope(user.role) === 'org') {
      return { sql: '1=1', params: [] };
    }
    if (dataScope(user.role) === 'team') {
      return {
        sql: '(l.owner_id = ? OR l.owner_id IN (SELECT id FROM users WHERE manager_id = ?))',
        params: [user.id, user.id],
      };
    }
    if (dataScope(user.role) === 'product') {
      return {
        sql: 'EXISTS (SELECT 1 FROM product_cards pc WHERE pc.lead_id = l.id AND pc.product_type_id = ?)',
        params: [user.product_type_id ?? -1],
      };
    }
    return { sql: 'l.owner_id = ?', params: [user.id] };
  };

  const scope = scopeSql();
  const visible = one(
    `SELECT COUNT(*) n FROM leads l
     WHERE l.deleted_at IS NULL AND l.sales_org = ? AND (${scope.sql})`,
    [user.sales_org, ...scope.params],
  ).n;

  return res.json({
    ...explained,
    orgs: orgsFor(user),
    leads_visible: visible,
    total_in_org: one('SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND sales_org = ?', [user.sales_org]).n,
  });
});

/** My own access — available to everyone, so anyone can see what they hold. */
router.get('/me/access', (req, res) => res.json({
  ...explainAccess(req.user),
  // The floor and every grant above it, named one at a time — so "why can
  // they see this?" has an answer that points at a rule.
  visibility: explainVisibility(req.user, dataScope(req.user.role)),
  orgs: orgsFor(req.user),
}));

/* ==================================================== object manager */

/**
 * The configuration surface every entity shares.
 *
 * One set of routes for all six entities, and for anything an administrator
 * creates later. That uniformity is the point: learn to configure Leads and you
 * can configure Cases, because there is nothing entity-specific here.
 */

/** Everything an admin needs to render the object list. */
router.get('/objects', requirePermission('admin.objects'), (req, res) => {
  res.json(entities().map((e) => ({
    ...e,
    field_count: fieldsOf(e.api_name).length,
    custom_field_count: fieldsOf(e.api_name).filter((f) => f.is_custom).length,
  })));
});

/** One object, its fields, and the picklist values behind each. */
router.get('/objects/:entity', requirePermission('admin.objects'), (req, res) => {
  const def = entityDef(req.params.entity);
  if (!def) return res.status(404).json({ error: 'No such object' });

  const fields = fieldsOf(req.params.entity, { includeInactive: true }).map((f) => ({
    ...f,
    type_label: typeOf(f.type)?.label ?? f.type,
    values: (f.type === 'picklist' || f.type === 'multipicklist') ? picklistValues(f.id) : undefined,
    // A derived field says what it computes, in words, wherever it is listed.
    derived_as: f.type === 'formula'
      ? describeFormula(req.params.entity, JSON.parse(f.formula || 'null'))
      : f.type === 'rollup'
        ? describeRollup(req.params.entity, JSON.parse(f.rollup || 'null'))
        : undefined,
    controlling_field_name: f.controlling_field
      ? one('SELECT api_name FROM field_def WHERE id = ?', [f.controlling_field])?.api_name
      : null,
  }));

  return res.json({ object: def, fields, types: FIELD_TYPES });
});

/** Rename an object's labels. The API name never moves. */
router.patch('/objects/:entity', requirePermission('admin.objects'), (req, res) => {
  const def = entityDef(req.params.entity);
  if (!def) return res.status(404).json({ error: 'No such object' });

  const { label, label_plural, description, icon } = req.body ?? {};
  run(
    `UPDATE entity_def SET label = COALESCE(?, label), label_plural = COALESCE(?, label_plural),
            description = COALESCE(?, description), icon = COALESCE(?, icon)
     WHERE api_name = ?`,
    [label ?? null, label_plural ?? null, description ?? null, icon ?? null, req.params.entity],
  );

  const after = entityDef(req.params.entity);
  auditConfig('entity', req.params.entity, 'updated', def, after, req.user.id);
  return res.json(after);
});

/**
 * Add a field.
 *
 * Two identifiers from the start: the label is what people see and may rename
 * forever after; the API name is derived once and then frozen. The legacy tenant
 * carries `mx_Subscription_End_dtae` in perpetuity because it never made this
 * distinction — a typo at creation became a permanent integration contract.
 *
 * The governance gate is here too. 289 custom fields with 8+ duplicate pairs and
 * four test fields in production is what happens when anyone can add a field
 * and nobody owns it afterwards. Purpose and owner are required.
 */
router.post('/objects/:entity/fields', requirePermission('admin.objects'), (req, res) => {
  const def = entityDef(req.params.entity);
  if (!def) return res.status(404).json({ error: 'No such object' });

  const {
    label, api_name: requested, type, required = 0, help_text, description,
    purpose, owner_user_id, length, precision, scale, values = [],
    controlling_field, encrypted = 0, read_scope = 'record', read_capability,
    history_tracked = 0, default_value, retire_at,
  } = req.body ?? {};

  if (!label?.trim()) return res.status(400).json({ error: 'Label is required' });
  if (!typeOf(type)) return res.status(400).json({ error: `Unknown field type "${type}"` });
  if (!purpose?.trim()) {
    return res.status(400).json({
      error: 'Purpose is required',
      detail: 'Every field needs a stated reason to exist and someone who owns it. '
        + 'This is the gate that stops the field list growing without limit.',
    });
  }

  // Derived once from the label, then immutable.
  const apiName = (requested ?? label).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!apiName) return res.status(400).json({ error: 'Label produced an empty API name' });

  if (fieldDef(req.params.entity, apiName)) {
    return res.status(409).json({ error: `${def.label} already has a field named "${apiName}"` });
  }

  // Duplicate detection by label, not just by name — "Client PAN" and
  // "PAN Number" are the pair the audit found eight times over.
  const similar = fieldsOf(req.params.entity).filter((f) => {
    const a = f.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    const b = label.toLowerCase().replace(/[^a-z0-9]/g, '');
    return a.includes(b) || b.includes(a);
  });

  const type_def = typeOf(type);
  const isDerived = Boolean(type_def.derived);

  /**
   * A derived field is checked before it is saved, not when it first runs.
   *
   * A curated set makes this possible: every input is known, so a formula that
   * would fail on a record months from now is refused at creation with a
   * sentence saying why.
   */
  let formulaJson = null;
  let rollupJson = null;

  if (type === 'formula') {
    const check = validateFormula(req.params.entity, req.body.formula);
    if (!check.ok) return res.status(400).json({ error: check.error, field: 'formula' });
    formulaJson = JSON.stringify(req.body.formula);
  }
  if (type === 'rollup') {
    const check = validateRollup(req.params.entity, req.body.rollup);
    if (!check.ok) return res.status(400).json({ error: check.error, field: 'rollup' });
    rollupJson = JSON.stringify(req.body.rollup);
  }
  if ((type === 'formula' || type === 'rollup') && !(formulaJson || rollupJson)) {
    return res.status(400).json({ error: `A ${type} field needs its definition` });
  }

  const id = transact(() => {
    const info = run(
      `INSERT INTO field_def
         (entity, api_name, label, type, storage, required, length, precision, scale,
          default_value, help_text, description, controlling_field, encrypted,
          read_scope, read_capability, history_tracked, owner_user_id, purpose,
          retire_at, formula, rollup, is_custom, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [
        req.params.entity, apiName, label.trim(), type,
        isDerived ? 'derived' : 'value',
        required ? 1 : 0, length ?? null, precision ?? null, scale ?? null,
        default_value ?? null, help_text ?? null, description ?? null,
        controlling_field ?? null,
        // An encrypted type is encrypted whatever the caller passed.
        (encrypted || type_def.sensitive) ? 1 : 0,
        read_scope, read_capability ?? null, history_tracked ? 1 : 0,
        owner_user_id ?? req.user.id, purpose.trim(), retire_at ?? null,
        formulaJson, rollupJson,
        req.user.id,
      ],
    );
    const fieldId = info.lastInsertRowid;

    values.forEach((v, i) => {
      run(
        `INSERT INTO picklist_value (field_id, value, label, controlling_value, colour, is_default, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
        [
          fieldId, v.value ?? v.label, v.label ?? v.value,
          v.controlling_value ?? null, v.colour ?? null, v.is_default ? 1 : 0, i,
        ],
      );
    });

    return fieldId;
  });

  const created = one('SELECT * FROM field_def WHERE id = ?', [id]);
  auditConfig('field', `${req.params.entity}.${apiName}`, 'created', null, created, req.user.id);

  return res.status(201).json({
    field: created,
    // Surfaced, not enforced: the admin may have a good reason, but they should
    // see the near-duplicate before they commit to it.
    warnings: similar.length
      ? [`${def.label} already has ${similar.map((f) => `"${f.label}"`).join(', ')}. Is this the same thing under another name?`]
      : [],
  });
});

/**
 * Change a field.
 *
 * Label, help text, requiredness and governance may all move. Type, API name and
 * storage may not — those are contracts that integrations and stored data depend
 * on, and a CRM that lets you change a field's type in place is a CRM that
 * silently corrupts the column.
 */
router.patch('/objects/:entity/fields/:apiName', requirePermission('admin.objects'), (req, res) => {
  const field = fieldDef(req.params.entity, req.params.apiName);
  if (!field) return res.status(404).json({ error: 'No such field' });

  const frozen = ['api_name', 'type', 'storage', 'entity'];
  const attempted = frozen.filter((k) => k in (req.body ?? {}) && req.body[k] !== field[k]);
  if (attempted.length) {
    return res.status(400).json({
      error: `Cannot change ${attempted.join(', ')} on an existing field`,
      detail: 'Integrations bind to the API name and stored values match the type. '
        + 'Deactivate this field and create a replacement instead.',
    });
  }

  if (!field.is_custom && 'active' in req.body && !req.body.active) {
    return res.status(400).json({ error: `${field.label} is a core field and cannot be deactivated` });
  }

  const {
    label, help_text, description, required, default_value,
    read_scope, read_capability, history_tracked, indexed,
    owner_user_id, purpose, retire_at, active, sort_order,
  } = req.body ?? {};

  run(
    `UPDATE field_def SET
       label = COALESCE(?, label), help_text = COALESCE(?, help_text),
       description = COALESCE(?, description), required = COALESCE(?, required),
       default_value = COALESCE(?, default_value), read_scope = COALESCE(?, read_scope),
       read_capability = COALESCE(?, read_capability),
       history_tracked = COALESCE(?, history_tracked), indexed = COALESCE(?, indexed),
       owner_user_id = COALESCE(?, owner_user_id), purpose = COALESCE(?, purpose),
       retire_at = COALESCE(?, retire_at), active = COALESCE(?, active),
       sort_order = COALESCE(?, sort_order)
     WHERE id = ?`,
    [
      label ?? null, help_text ?? null, description ?? null,
      required == null ? null : (required ? 1 : 0), default_value ?? null,
      read_scope ?? null, read_capability ?? null,
      history_tracked == null ? null : (history_tracked ? 1 : 0),
      indexed == null ? null : (indexed ? 1 : 0),
      owner_user_id ?? null, purpose ?? null, retire_at ?? null,
      active == null ? null : (active ? 1 : 0), sort_order ?? null,
      field.id,
    ],
  );

  const after = one('SELECT * FROM field_def WHERE id = ?', [field.id]);
  auditConfig('field', `${req.params.entity}.${req.params.apiName}`, 'updated', field, after, req.user.id);
  return res.json(after);
});

/**
 * Deactivate a field. Never delete — the values stay, and so does the history.
 *
 * A deleted field takes its data with it and leaves every report that referenced
 * it silently wrong. Deactivation removes it from layouts and pickers while the
 * record of what it once held survives.
 */
router.delete('/objects/:entity/fields/:apiName', requirePermission('admin.objects'), (req, res) => {
  const field = fieldDef(req.params.entity, req.params.apiName);
  if (!field) return res.status(404).json({ error: 'No such field' });
  if (!field.is_custom) {
    return res.status(400).json({ error: `${field.label} is a core field and cannot be removed` });
  }

  const used = one('SELECT COUNT(*) n FROM field_value WHERE field_id = ?', [field.id]).n;
  run('UPDATE field_def SET active = 0 WHERE id = ?', [field.id]);
  auditConfig('field', `${req.params.entity}.${req.params.apiName}`, 'deactivated', field, null, req.user.id);

  return res.json({
    ok: true,
    deactivated: field.label,
    values_retained: used,
    note: used
      ? `${used} stored value${used === 1 ? '' : 's'} kept. Reactivating the field restores them.`
      : 'No stored values.',
  });
});

/**
 * What a derived field may be built from, on this object.
 *
 * The Setup form renders itself from this — it does not know what a formula
 * means, only what inputs each kind declares.
 */
router.get('/objects/:entity/derivable', requirePermission('admin.objects'), (req, res) => {
  if (!entityDef(req.params.entity)) return res.status(404).json({ error: 'No such object' });
  res.json(catalogue(req.params.entity));
});

/** Picklist values, including the cascade. */
router.put('/objects/:entity/fields/:apiName/values', requirePermission('admin.objects'), (req, res) => {
  const field = fieldDef(req.params.entity, req.params.apiName);
  if (!field) return res.status(404).json({ error: 'No such field' });
  if (field.type !== 'picklist' && field.type !== 'multipicklist') {
    return res.status(400).json({ error: `${field.label} is not a picklist` });
  }

  const before = picklistValues(field.id);
  const values = Array.isArray(req.body?.values) ? req.body.values : [];

  transact(() => {
    // Deactivate rather than delete: a value in use on live records must not
    // vanish from those records just because it is retired from the picker.
    run('UPDATE picklist_value SET active = 0 WHERE field_id = ?', [field.id]);
    values.forEach((v, i) => {
      run(
        `INSERT INTO picklist_value (field_id, value, label, controlling_value, colour, is_default, active, sort_order)
         VALUES (?,?,?,?,?,?,1,?)
         ON CONFLICT(field_id, value) DO UPDATE SET
           label = excluded.label, controlling_value = excluded.controlling_value,
           colour = excluded.colour, is_default = excluded.is_default,
           active = 1, sort_order = excluded.sort_order`,
        [
          field.id, v.value ?? v.label, v.label ?? v.value, v.controlling_value ?? null,
          v.colour ?? null, v.is_default ? 1 : 0, i,
        ],
      );
    });
  });

  const after = picklistValues(field.id);
  auditConfig('field', `${req.params.entity}.${req.params.apiName}.values`, 'updated', before, after, req.user.id);
  return res.json(after);
});

/** The change history of one record — first-class, not reconstructed. */
router.get('/history/:entity/:id', (req, res) => {
  res.json({
    changes: historyFor(req.params.entity, Number(req.params.id)),
    // Derived from the same history rather than stamped into date fields by
    // automation, which is what six of the legacy jobs exist to do.
    stages: stageDurations(req.params.entity, Number(req.params.id),
      req.params.entity === 'product_interest' ? 'state' : 'stage'),
  });
});

/** Who changed the configuration, and to what. */
router.get('/config-audit', requirePermission('admin.objects'), (req, res) => {
  const { area, limit = 100 } = req.query;
  res.json(all(
    `SELECT c.*, u.name AS actor_name FROM config_audit c
     LEFT JOIN users u ON u.id = c.actor_id
     ${area ? 'WHERE c.area = ?' : ''}
     ORDER BY c.at DESC, c.id DESC LIMIT ?`,
    area ? [area, Number(limit)] : [Number(limit)],
  ));
});

/**
 * Field hygiene — the report the legacy tenant could not produce.
 *
 * 289 custom fields, no owner, no stated purpose, no usage figure. This makes
 * all three visible, so the list can be pruned on evidence.
 */
router.get('/field-usage/:entity', requirePermission('admin.objects'), (req, res) => {
  const fields = fieldsOf(req.params.entity, { includeInactive: true });
  const def = entityDef(req.params.entity);
  if (!def) return res.status(404).json({ error: 'No such object' });

  const total = def.table_name
    ? one(`SELECT COUNT(*) n FROM ${def.table_name}`).n
    : 0;

  const rows = fields.map((f) => {
    let filled = null;
    if (f.storage === 'value') {
      filled = one(
        `SELECT COUNT(*) n FROM field_value
         WHERE field_id = ? AND COALESCE(text_value, num_value, date_value, bool_value) IS NOT NULL`,
        [f.id],
      ).n;
    } else if (f.storage === 'column' && def.table_name) {
      // Core column: ask the table directly. The name comes from our own
      // registry, never from the request.
      const safe = /^[a-z_][a-z0-9_]*$/i.test(f.api_name);
      if (safe) {
        try {
          filled = one(`SELECT COUNT(*) n FROM ${def.table_name} WHERE ${f.api_name} IS NOT NULL AND ${f.api_name} != ''`).n;
        } catch { filled = null; }
      }
    }

    return {
      api_name: f.api_name,
      label: f.label,
      type: f.type,
      is_custom: Boolean(f.is_custom),
      active: Boolean(f.active),
      owner: f.owner_user_id ? one('SELECT name FROM users WHERE id = ?', [f.owner_user_id])?.name : null,
      purpose: f.purpose,
      retire_at: f.retire_at,
      filled,
      fill_rate: filled != null && total ? Math.round((filled / total) * 1000) / 10 : null,
    };
  });

  return res.json({
    object: def.label,
    records: total,
    fields: rows,
    // The two questions worth asking of any field list.
    unused: rows.filter((r) => r.fill_rate === 0 && r.is_custom).map((r) => r.label),
    unowned: rows.filter((r) => r.is_custom && !r.owner).map((r) => r.label),
  });
});


/* ================================================== tab visibility (ENH-08)
 *
 * Role-level defaults with a per-user override, which is the model confirmed
 * for this. Every change is written to the configuration audit log, so
 * "who gave them Setup?" has an answer.
 *
 * The screen states plainly that this is navigation and not security, because
 * the single most expensive misunderstanding available here is an administrator
 * hiding a tab and believing they have restricted data.
 */

const TAB_LIST = () => [
  ...Object.values(TABS).map((t) => ({ id: t.id, label: t.label, icon: t.icon, kind: 'tab' })),
  // Features ride the same mechanism and appear in the same grid, marked so an
  // administrator can see that turning one off hides a banner rather than a
  // destination (ENH-04).
  ...FEATURE_KEYS.map((k) => ({ id: k, label: FEATURE_LABEL[k] ?? k, icon: 'monitoring', kind: 'feature' })),
];

router.get('/tab-visibility', requirePermission('admin.roles'), (_req, res) => {
  const roles = all('SELECT code, name FROM roles ORDER BY sort_order, code');
  const tabs = TAB_LIST();
  res.json({
    tabs,
    roles,
    matrix: tabMatrix(roles.map((r) => r.code), tabs.map((t) => t.id)),
    user_overrides: overrideCount(),
    note: 'Hiding a tab is navigation, not security. The API enforces capability separately, so a hidden tab tidies a screen and protects nothing on its own.',
  });
});

router.post('/tab-visibility/role', requirePermission('admin.roles'), (req, res) => {
  const { role, tab_id: tabId, visible } = req.body ?? {};
  if (!role || !tabId) return res.status(400).json({ error: 'Give a role and a tab' });
  if (!TABS[tabId] && !FEATURE_KEYS.includes(tabId)) return res.status(400).json({ error: `There is no tab called "${tabId}"` });

  const before = shippedDefault(role, tabId);

  // `null` means 'stop deciding' -- fall back to the shipped default, which is
  // a different thing from choosing the same value the default happens to have.
  if (visible === null) clearRoleTab(role, tabId);
  else setRoleTab(role, tabId, Boolean(visible), req.user.id);

  auditConfig('tabs', `${role}.${tabId}`, visible === null ? 'reset' : 'set',
    { visible: before }, { visible: visible === null ? shippedDefault(role, tabId) : Boolean(visible) },
    req.user.id);

  res.json({ ok: true });
});

router.get('/users/:id/tabs', requirePermission('admin.roles'), (req, res) => {
  const user = one('SELECT id, name, role FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const overrides = new Map(overridesFor(user.id).map((o) => [o.tab_id, Boolean(o.visible)]));
  res.json({
    user,
    tabs: TAB_LIST().map((t) => {
      const r = resolveTab(user, t.id);
      return {
        ...t,
        visible: r.visible,
        // Where the answer came from, so an administrator can see WHY this
        // person sees a tab rather than only that they do.
        source: r.source,
        overridden: overrides.has(t.id),
        role_default: resolveTab({ id: -1, role: user.role }, t.id).visible,
      };
    }),
  });
});

router.post('/users/:id/tabs', requirePermission('admin.roles'), (req, res) => {
  const user = one('SELECT id, name, role FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { tab_id: tabId, visible } = req.body ?? {};
  if (!TABS[tabId] && !FEATURE_KEYS.includes(tabId)) return res.status(400).json({ error: `There is no tab called "${tabId}"` });

  const before = resolveTab(user, tabId);
  if (visible === null) clearUserTab(user.id, tabId);
  else setUserTab(user.id, tabId, Boolean(visible), req.user.id);
  const after = resolveTab(user, tabId);

  auditConfig('tabs', `user:${user.id}.${tabId}`, visible === null ? 'reset' : 'set',
    before, after, req.user.id);

  res.json({ ok: true, ...after });
});


/* ================================================== dispositions (ENH-21c)
 *
 * The Connected / Not Connected values, and what each one obliges the RM to do
 * next. These drive the follow-up engine, so editing one is a business decision
 * rather than a cosmetic rename -- which is why the screen shows the effects
 * beside the label rather than hiding them behind an Advanced section.
 *
 * A shipped row that gets edited is marked, and seedDispositions() then leaves
 * it alone on every subsequent boot.
 */

const DISPOSITION_FIELDS = [
  'label', 'outcome', 'next_step', 'follow_up_hours', 'requires_datetime',
  'requires_reason', 'sets_card_state', 'flags_mobile_invalid',
  'suppress_marketing', 'score_delta', 'hint', 'sort_order', 'active',
];

router.get('/dispositions', requirePermission('admin.rules'), (_req, res) => {
  const rows = all('SELECT * FROM dispositions ORDER BY activity_type, sort_order');
  res.json({
    dispositions: rows,
    outcomes: [...new Set(rows.map((r) => r.outcome))],
    activity_types: [...new Set(rows.map((r) => r.activity_type))],
    card_states: CARD_STATES,
    next_steps: ['follow_up', 'meeting', 'retry', 'none'],
    note: 'These decide what happens after a call is logged. Changing an obligation changes what the follow-up engine creates.',
  });
});

router.patch('/dispositions/:id', requirePermission('admin.rules'), (req, res) => {
  const row = one('SELECT * FROM dispositions WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Disposition not found' });

  const sets = [];
  const params = [];
  for (const f of DISPOSITION_FIELDS) {
    if (!(f in req.body)) continue;
    sets.push(`${f} = ?`);
    params.push(typeof req.body[f] === 'boolean' ? (req.body[f] ? 1 : 0) : req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

  // A card state that does not exist would fail silently at apply time, long
  // after whoever typed it has moved on.
  if (req.body.sets_card_state && !CARD_STATES.includes(req.body.sets_card_state)) {
    return res.status(400).json({ error: `Card state must be one of: ${CARD_STATES.join(', ')}` });
  }

  sets.push("edited_at = datetime('now')", 'edited_by = ?');
  params.push(req.user.id);

  run(`UPDATE dispositions SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);
  const after = one('SELECT * FROM dispositions WHERE id = ?', [row.id]);

  auditConfig('dispositions', row.code, 'updated', row, after, req.user.id);
  res.json(after);
});

router.post('/dispositions', requirePermission('admin.rules'), (req, res) => {
  const { code, label, activity_type: type, outcome } = req.body ?? {};
  if (!code || !label || !type || !outcome) {
    return res.status(400).json({ error: 'A disposition needs a code, a label, an activity type and an outcome' });
  }
  if (one('SELECT id FROM dispositions WHERE code = ?', [code])) {
    return res.status(409).json({ error: `"${code}" already exists` });
  }

  const next = one('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dispositions WHERE activity_type = ?', [type]).n;
  const r = run(
    `INSERT INTO dispositions
       (code, activity_type, outcome, label, next_step, follow_up_hours,
        requires_datetime, requires_reason, sets_card_state, score_delta, hint,
        sort_order, is_custom, edited_at, edited_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1, datetime('now'), ?)`,
    [code, type, outcome, label, req.body.next_step ?? 'none',
      req.body.follow_up_hours ?? null,
      req.body.requires_datetime ? 1 : 0, req.body.requires_reason ? 1 : 0,
      req.body.sets_card_state ?? null, req.body.score_delta ?? 0,
      req.body.hint ?? null, next, req.user.id],
  );

  const created = one('SELECT * FROM dispositions WHERE id = ?', [Number(r.lastInsertRowid)]);
  auditConfig('dispositions', code, 'created', null, created, req.user.id);
  res.status(201).json(created);
});

/**
 * Retire rather than delete.
 *
 * Activities already logged reference the code, and deleting the row would
 * leave those records describing an outcome nobody can look up. Deactivating
 * takes it out of the picker and leaves the history readable.
 */
router.delete('/dispositions/:id', requirePermission('admin.rules'), (req, res) => {
  const row = one('SELECT * FROM dispositions WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Disposition not found' });

  const used = one('SELECT COUNT(*) n FROM activities WHERE sub_disposition = ?', [row.code]).n;
  run("UPDATE dispositions SET active = 0, edited_at = datetime('now'), edited_by = ? WHERE id = ?",
    [req.user.id, row.id]);
  auditConfig('dispositions', row.code, 'retired', row, { ...row, active: 0 }, req.user.id);

  res.json({
    ok: true,
    retired: true,
    used_by: used,
    note: used
      ? `Kept for ${used} logged ${used === 1 ? 'activity' : 'activities'} that reference it, and removed from the picker.`
      : 'Removed from the picker.',
  });
});


/* =================================================== field masking (ENH-16)
 *
 * Which PII fields each role sees in the clear.
 *
 * Gated on admin.users rather than admin.roles: deciding who may read a
 * client's PAN is a people decision, and it belongs with the screen that
 * manages people.
 */

router.get('/field-masking', requirePermission('admin.users'), (_req, res) => {
  const roles = all('SELECT code, name FROM roles ORDER BY sort_order, code');
  res.json({
    fields: MASKABLE.map((f) => ({ field: f, label: FIELD_LABEL[f] ?? f })),
    roles,
    matrix: maskingMatrix(roles.map((r) => r.code)),
    note: 'Masking is the standing state for a role. Someone who holds the unmask capability can still reveal a single record, and that act is logged.',
  });
});

router.post('/field-masking', requirePermission('admin.users'), (req, res) => {
  const { role, field, masked } = req.body ?? {};
  if (!role || !field) return res.status(400).json({ error: 'Give a role and a field' });
  if (!MASKABLE.includes(field)) {
    return res.status(400).json({ error: `"${field}" is not a maskable field` });
  }
  if (!one('SELECT code FROM roles WHERE code = ?', [role])) {
    return res.status(400).json({ error: `There is no role called "${role}"` });
  }

  const before = maskedFieldsFor(role).has(field);

  // null means stop deciding and follow the shipped default -- a different
  // thing from choosing the value the default currently happens to have.
  if (masked === null) clearMasking(role, field);
  else setMasking(role, field, Boolean(masked), req.user.id);

  const after = maskedFieldsFor(role).has(field);
  auditConfig('masking', `${role}.${field}`, masked === null ? 'reset' : 'set',
    { masked: before }, { masked: after }, req.user.id);

  res.json({ ok: true, masked: after });
});

/* ------------------------------------------------------------ telephony
 *
 * Two things the dialler needs that nothing could previously set.
 *
 * The CUBE agent id is one. It has been a column since the integration was
 * written and there has never been a screen for it, so every call went out
 * unattributed -- or worse, carrying our internal user id, which CUBE would
 * either reject or pin on whichever of its agents is called "2".
 *
 * The campaign registry is the other. CUBE has no endpoint that lists its
 * campaigns, so the values cannot be discovered, only configured. Without
 * somewhere to put them the whole firm shares one environment variable, and
 * the cross-campaign requirement -- a call carries its queue per request so
 * different desks dial into different queues -- has no data to work from.
 *
 * Gated on admin.system rather than admin.users: this is integration
 * configuration that happens to live on a user row, and splitting it across
 * two screens is how the two drift apart.
 */

/** Everything the telephony screen needs, in one call. */
router.get('/dialler', requirePermission('admin.system'), (req, res) => {
  const orgs = orgsFor(req.user);
  const marks = orgs.map(() => '?').join(',') || 'NULL';

  res.json({
    connection: vendorStatus().quickcall,
    campaigns: all(
      `SELECT c.*, pt.name AS product_name
       FROM dialler_campaigns c
       LEFT JOIN product_types pt ON pt.id = c.product_type_id
       WHERE c.sales_org IN (${marks})
       ORDER BY c.sales_org, c.is_default DESC, c.label`,
      orgs,
    ),
    /* Only the roles that actually dial. Listing all 83 users on a telephony
       screen buries the eight who need an extension among the rest. */
    agents: all(
      `SELECT u.id, u.name, u.email, u.role, u.sales_org, u.branch,
              u.cti_agent_id, u.phone_extension, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.code = u.role
       WHERE u.active = 1 AND u.sales_org IN (${marks})
         AND u.role IN ('sales_rm','caller','dealer','sales_supervisor','product_supervisor')
       ORDER BY u.cti_agent_id IS NULL DESC, u.name`,
      orgs,
    ),
    products: all('SELECT id, name FROM product_types ORDER BY name'),
    orgs,
  });
});

router.post('/dialler/campaigns', requirePermission('admin.system'), (req, res) => {
  const {
    cube_campaign_id: cubeId, label, sales_org: org = 'BONANZA',
    product_type_id: productTypeId = null, is_default: isDefault = 0,
  } = req.body;

  const invalid = validate(req.body, {
    cube_campaign_id: ['required', 'max:80'], label: ['required', 'max:80'],
  });
  if (invalid) return res.status(400).json(invalid);

  if (!SALES_ORGS.includes(org)) return res.status(400).json({ error: 'Unknown business', field: 'sales_org' });
  if (!mayUseOrg(req.user, org)) return res.status(403).json({ error: 'That business is outside your access', field: 'sales_org' });

  if (one('SELECT id FROM dialler_campaigns WHERE cube_campaign_id = ? AND sales_org = ?', [cubeId, org])) {
    return res.status(409).json({ error: `${cubeId} is already registered for ${org}`, field: 'cube_campaign_id' });
  }

  const result = transact(() => {
    // One default per book, or "the book's default queue" has no answer.
    if (Number(isDefault)) {
      run('UPDATE dialler_campaigns SET is_default = 0 WHERE sales_org = ?', [org]);
    }
    return run(
      `INSERT INTO dialler_campaigns (cube_campaign_id, label, sales_org, product_type_id, is_default)
       VALUES (?,?,?,?,?)`,
      [String(cubeId).trim(), String(label).trim(), org, productTypeId || null, Number(isDefault) ? 1 : 0],
    );
  });

  audit(req.user.id, 'dialler_campaign_created', 'dialler_campaign', null, { cube_campaign_id: cubeId, sales_org: org });
  return res.status(201).json(one('SELECT * FROM dialler_campaigns WHERE id = ?', [Number(result.lastInsertRowid)]));
});

router.patch('/dialler/campaigns/:id', requirePermission('admin.system'), (req, res) => {
  const row = one('SELECT * FROM dialler_campaigns WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Campaign not found' });
  if (!mayUseOrg(req.user, row.sales_org)) return res.status(403).json({ error: 'That campaign belongs to another business' });

  const { label, product_type_id: productTypeId, is_default: isDefault, active } = req.body;
  if (label !== undefined && !String(label).trim()) {
    return res.status(400).json({ error: 'A campaign needs a label', field: 'label' });
  }

  /* cube_campaign_id is deliberately not editable. Calls have been placed
     against it and the call log is queried by it, so changing the string
     silently detaches this row from its own history. Retire it and add
     another. */

  transact(() => {
    if (Number(isDefault)) run('UPDATE dialler_campaigns SET is_default = 0 WHERE sales_org = ?', [row.sales_org]);
    run(
      `UPDATE dialler_campaigns SET
         label = COALESCE(?, label),
         product_type_id = ?,
         is_default = COALESCE(?, is_default),
         active = COALESCE(?, active)
       WHERE id = ?`,
      [
        label ?? null,
        productTypeId === undefined ? row.product_type_id : (productTypeId || null),
        isDefault === undefined ? null : (Number(isDefault) ? 1 : 0),
        active === undefined ? null : (Number(active) ? 1 : 0),
        row.id,
      ],
    );
  });

  audit(req.user.id, 'dialler_campaign_updated', 'dialler_campaign', null, { id: row.id });
  return res.json(one('SELECT * FROM dialler_campaigns WHERE id = ?', [row.id]));
});

router.delete('/dialler/campaigns/:id', requirePermission('admin.system'), (req, res) => {
  const row = one('SELECT * FROM dialler_campaigns WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Campaign not found' });
  if (!mayUseOrg(req.user, row.sales_org)) return res.status(403).json({ error: 'That campaign belongs to another business' });

  run('DELETE FROM dialler_campaigns WHERE id = ?', [row.id]);
  audit(req.user.id, 'dialler_campaign_deleted', 'dialler_campaign', null, { cube_campaign_id: row.cube_campaign_id });
  return res.status(204).end();
});

/** The dialler identity on one user. */
router.patch('/dialler/agents/:id', requirePermission('admin.system'), (req, res) => {
  const user = one('SELECT id, name, sales_org FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!mayUseOrg(req.user, user.sales_org)) return res.status(403).json({ error: 'That user is outside your access' });

  const agentId = req.body.cti_agent_id;
  const ext = req.body.phone_extension;

  /* An agent id is unique on the switch. Two CRM users sharing one would make
     every call from either indistinguishable in CUBE's own reporting, which is
     the shared-login problem arriving through a different door. */
  if (agentId) {
    const clash = one(
      'SELECT id, name FROM users WHERE cti_agent_id = ? AND id != ?',
      [String(agentId).trim(), user.id],
    );
    if (clash) {
      return res.status(409).json({
        error: `${clash.name} already uses the agent id "${agentId}"`,
        field: 'cti_agent_id',
      });
    }
  }

  // An empty string clears the mapping; undefined leaves it alone.
  run(
    `UPDATE users SET
       cti_agent_id = ${agentId === undefined ? 'cti_agent_id' : '?'},
       phone_extension = ${ext === undefined ? 'phone_extension' : '?'}
     WHERE id = ?`,
    [
      ...(agentId === undefined ? [] : [String(agentId).trim() || null]),
      ...(ext === undefined ? [] : [String(ext).trim() || null]),
      user.id,
    ],
  );

  audit(req.user.id, 'dialler_agent_mapped', 'user', user.id, { cti_agent_id: agentId ?? null });
  return res.json(one('SELECT id, name, cti_agent_id, phone_extension FROM users WHERE id = ?', [user.id]));
});

export default router;
