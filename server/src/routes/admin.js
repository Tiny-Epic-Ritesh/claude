/**
 * Admin & configuration — users, products, SLA, categories, templates,
 * content library, KYC journey composer, rule builder, integrations, audit.
 */

import { Router } from 'express';
import { all, one, run, audit, ROLES, ROLE_LABELS } from '../db.js';
import { requireUser, requirePermission, permissionsFor, orgsFor, activeOrg, PERMISSIONS } from '../auth.js';
import { hashPassword } from '../security.js';
import { CONDITION_FIELDS, ACTION_TYPES, runRule } from '../engine/rules.js';
import { MASTER_STEPS } from '../engine/kyc.js';
import { integrationRegistry, getOutbox, syncTradingDb, vendorStatus } from '../integrations.js';
import { DEFAULT_SLA } from '../engine/sla.js';
import { checkConsent } from '../engine/consent.js';
import { MAY_RECEIVE_CAMPAIGN, normaliseKind } from '../engine/leadlists.js';
import * as meta from '../vendors/meta.js';
import { healthReport } from '../engine/conflicts.js';
import {
  ARTEFACTS, snapshot, versionsOf, byId as versionById, diff as versionDiff,
  restore as restoreVersion, recentVersions,
} from '../engine/versioning.js';
import {
  packageBundle, inspect as inspectBundle, apply as applyBundle,
  recent as recentPromotions, environment as currentEnvironment, PROMOTABLE, KEEP as PROMOTIONS_KEPT,
} from '../engine/promotion.js';
import {
  accessLogSummary, crossBookReads, activityOf, readersOf, RETENTION_DAYS,
} from '../engine/accesslog.js';
import {
  listCalendars, updateCalendar, addDay, removeDay, isWorkingDay,
  nextWorkingTime, addWorkingMinutes, CALENDAR_KINDS,
} from '../engine/calendar.js';

const router = Router();
router.use(requireUser);

/* --------------------------------------------------------------- users */

router.get('/users', requirePermission('admin.users'), (_req, res) => {
  res.json(all(`
    SELECT u.*, pt.name AS product_name, m.name AS manager_name,
           (SELECT COUNT(*) FROM leads WHERE owner_id = u.id AND deleted_at IS NULL) AS lead_count
    FROM users u
    LEFT JOIN product_types pt ON pt.id = u.product_type_id
    LEFT JOIN users m ON m.id = u.manager_id
    ORDER BY u.role, u.name`).map(({ password, ...u }) => u));
});

router.post('/users', requirePermission('admin.users'), async (req, res) => {
  const { name, email, password, role, product_type_id, manager_id, phone } = req.body;
  if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: 'Name and email are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  if (one('SELECT id FROM users WHERE lower(email) = lower(?)', [email])) return res.status(409).json({ error: 'That email already exists' });

  const result = run(
    'INSERT INTO users (name, email, password, role, product_type_id, manager_id, phone) VALUES (?,?,?,?,?,?,?)',
    [name, email, await hashPassword(password || 'demo1234'), role, product_type_id || null, manager_id || null, phone || null],
  );
  audit(req.user.id, 'user_created', 'user', Number(result.lastInsertRowid), { role });
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

router.patch('/users/:id', requirePermission('admin.users'), async (req, res) => {
  const fields = ['name', 'email', 'role', 'product_type_id', 'manager_id', 'phone', 'active', 'password'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    if (f === 'password') {
      /* Never store what the administrator typed. A blank means leave it
         alone rather than set an empty password. */
      const next = String(req.body.password).trim();
      if (!next) continue;
      sets.push('password = ?');
      params.push(await hashPassword(next));
      continue;
    }
    sets.push(`${f} = ?`);
    params.push(req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  audit(req.user.id, 'user_updated', 'user', Number(req.params.id), { ...req.body, password: undefined });
  res.json({ ok: true });
});

/** The full permission matrix, for the Admin → Roles screen. */
router.get('/roles', requireUser, (_req, res) => {
  res.json({
    roles: ROLES.map((r) => ({ code: r, label: ROLE_LABELS[r], permissions: permissionsFor(r) })),
    matrix: PERMISSIONS,
  });
});

/* ------------------------------------------------------------ products */

router.get('/products', (_req, res) => res.json(all('SELECT * FROM product_types ORDER BY sort_order')));

router.post('/products', requirePermission('admin.products'), (req, res) => {
  const { code, name, category, min_investment, lock_in, risk_category, pitch_points, objections, requires_kyc = 1 } = req.body;
  if (!code?.trim() || !name?.trim()) return res.status(400).json({ error: 'Code and name are required' });

  const maxOrder = one('SELECT COALESCE(MAX(sort_order), 0) v FROM product_types').v;
  const result = run(
    `INSERT INTO product_types (code, name, category, min_investment, lock_in, risk_category, pitch_points, objections, requires_kyc, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [code.toUpperCase(), name, category || null, min_investment || null, lock_in || null, risk_category || null,
      JSON.stringify(pitch_points || []), JSON.stringify(objections || []), requires_kyc ? 1 : 0, maxOrder + 1],
  );
  const id = Number(result.lastInsertRowid);

  // A new product type immediately generates a card on every existing lead.
  for (const lead of all('SELECT id FROM leads WHERE deleted_at IS NULL')) {
    run('INSERT OR IGNORE INTO product_cards (lead_id, product_type_id, state) VALUES (?,?,?)', [lead.id, id, 'INACTIVE']);
  }
  audit(req.user.id, 'product_created', 'product_type', id, { code });
  res.status(201).json({ id, cards_generated: one('SELECT COUNT(*) n FROM product_cards WHERE product_type_id = ?', [id]).n });
});

router.patch('/products/:id', requirePermission('admin.products'), (req, res) => {
  const fields = ['name', 'category', 'min_investment', 'lock_in', 'risk_category', 'brochure_url', 'apply_url', 'active', 'sort_order', 'requires_kyc'];
  const sets = [];
  const params = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
  for (const j of ['pitch_points', 'objections']) {
    if (req.body[j] !== undefined) { sets.push(`${j} = ?`); params.push(JSON.stringify(req.body[j])); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  run(`UPDATE product_types SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  audit(req.user.id, 'product_updated', 'product_type', Number(req.params.id), req.body);
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- SLA */

router.get('/sla', (_req, res) => {
  res.json({
    defaults: DEFAULT_SLA,
    policies: all('SELECT s.*, pt.name AS product_name FROM sla_policies s LEFT JOIN product_types pt ON pt.id = s.product_type_id ORDER BY pt.sort_order, s.priority'),
  });
});

router.post('/sla', requirePermission('admin.sla'), (req, res) => {
  const { product_type_id, priority, response_mins, resolution_mins } = req.body;
  run(
    `INSERT INTO sla_policies (product_type_id, priority, response_mins, resolution_mins) VALUES (?,?,?,?)
     ON CONFLICT (product_type_id, priority) DO UPDATE SET response_mins = excluded.response_mins, resolution_mins = excluded.resolution_mins`,
    [product_type_id, priority, response_mins, resolution_mins],
  );
  audit(req.user.id, 'sla_updated', 'sla_policy', null, req.body);
  // Keyed on the pair the table is unique on, so each policy has its own history.
  const slaVersion = snapshot('sla_policy', `${product_type_id ?? 'null'}:${priority}`,
    { note: req.body.note ?? null, userId: req.user.id });
  res.json({ ok: true, version: slaVersion?.version ?? null });
});

/* ---------------------------------------------------------- categories */

router.get('/categories', (_req, res) => res.json(all('SELECT * FROM ticket_categories ORDER BY name')));

router.post('/categories', requirePermission('admin.sla'), (req, res) => {
  const result = run('INSERT INTO ticket_categories (name, auto_assign_role) VALUES (?,?)', [req.body.name, req.body.auto_assign_role || null]);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

/* ----------------------------------------------------------- templates */

router.get('/templates', (_req, res) => res.json(all('SELECT * FROM templates ORDER BY channel, name')));

router.post('/templates', requirePermission('admin.templates'), (req, res) => {
  const { name, channel, subject, body, product_type_id, approved = 0 } = req.body;
  if (!name?.trim() || !body?.trim()) return res.status(400).json({ error: 'Name and body are required' });

  const result = run('INSERT INTO templates (name, channel, subject, body, product_type_id, approved) VALUES (?,?,?,?,?,?)', [
    name, channel || 'whatsapp', subject || null, body, product_type_id || null, approved ? 1 : 0,
  ]);
  const templateId = Number(result.lastInsertRowid);
  audit(req.user.id, 'template_created', 'template', templateId, { channel });
  snapshot('template', templateId, { note: 'Created', userId: req.user.id });
  res.status(201).json({ id: templateId });
});

router.patch('/templates/:id', requirePermission('admin.templates'), (req, res) => {
  const fields = ['name', 'subject', 'body', 'approved', 'product_type_id'];
  const sets = [];
  const params = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
  if (sets.length) run(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  const templateVersion = sets.length
    ? snapshot('template', Number(req.params.id), { note: req.body.note ?? null, userId: req.user.id })
    : null;
  audit(req.user.id, 'template_updated', 'template', Number(req.params.id), req.body);
  res.json({ ok: true, version: templateVersion?.version ?? null });
});

/* ------------------------------------------------------ content library */

router.get('/content', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.product_id) { where.push('c.product_type_id = ?'); params.push(req.query.product_id); }
  if (req.query.status) { where.push('c.status = ?'); params.push(req.query.status); }

  res.json(all(
    `SELECT c.*, pt.name AS product_name,
            CASE WHEN c.expiry_date IS NOT NULL AND date(c.expiry_date) <= date('now', '+30 days') THEN 1 ELSE 0 END AS expiring_soon,
            CASE WHEN c.expiry_date IS NOT NULL AND date(c.expiry_date) < date('now') THEN 1 ELSE 0 END AS expired
     FROM content_items c LEFT JOIN product_types pt ON pt.id = c.product_type_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name`,
    params,
  ));
});

router.post('/content', requirePermission('admin.content'), (req, res) => {
  const { name, type, url, product_type_id, kyc_step_code, expiry_date, owner_role } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

  const result = run(
    'INSERT INTO content_items (name, type, url, product_type_id, kyc_step_code, expiry_date, owner_role) VALUES (?,?,?,?,?,?,?)',
    [name, type || 'PDF', url || null, product_type_id || null, kyc_step_code || null, expiry_date || null, owner_role || req.user.role],
  );
  audit(req.user.id, 'content_created', 'content_item', Number(result.lastInsertRowid), { name });
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

/** New version supersedes the old one, which is archived and still rollback-able. */
router.post('/content/:id/version', requirePermission('admin.content'), (req, res) => {
  const item = one('SELECT * FROM content_items WHERE id = ?', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Content item not found' });

  run("UPDATE content_items SET status = 'archived' WHERE id = ?", [req.params.id]);
  const result = run(
    'INSERT INTO content_items (name, type, url, product_type_id, kyc_step_code, version, expiry_date, owner_role) VALUES (?,?,?,?,?,?,?,?)',
    [item.name, item.type, req.body.url || item.url, item.product_type_id, item.kyc_step_code, item.version + 1, req.body.expiry_date || item.expiry_date, item.owner_role],
  );
  res.status(201).json({ id: Number(result.lastInsertRowid), version: item.version + 1 });
});

/* --------------------------------------------------- KYC journey composer */

router.get('/kyc/journeys', (_req, res) => {
  const products = all('SELECT * FROM product_types WHERE active = 1 AND requires_kyc = 1 ORDER BY sort_order');
  res.json({
    master_steps: MASTER_STEPS.map(({ fields, ...s }) => ({ ...s, field_count: fields?.length ?? 0 })),
    journeys: products.map((p) => ({
      product: p,
      steps: all('SELECT * FROM kyc_journey_steps WHERE product_type_id = ? ORDER BY sort_order', [p.id]),
    })),
  });
});

router.post('/kyc/journeys/:productId', requirePermission('admin.kyc.journeys'), (req, res) => {
  const { steps = [] } = req.body;   // [{step_code, timer_override_s, conditional_on}]
  run('DELETE FROM kyc_journey_steps WHERE product_type_id = ?', [req.params.productId]);

  steps.forEach((s, i) => {
    run('INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order, timer_override_s, conditional_on) VALUES (?,?,?,?,?)', [
      req.params.productId, s.step_code, i, s.timer_override_s || null, s.conditional_on || null,
    ]);
  });
  audit(req.user.id, 'kyc_journey_configured', 'product_type', Number(req.params.productId), { steps: steps.length });
  const journeyVersion = snapshot('kyc_journey', Number(req.params.productId),
    { note: req.body.note ?? null, userId: req.user.id });
  res.json({ ok: true, steps: steps.length, version: journeyVersion?.version ?? null });
});

/* ---------------------------------------------------------- rule builder */

router.get('/rules', requirePermission('admin.rules'), (_req, res) => {
  res.json({
    rules: all('SELECT * FROM rules ORDER BY priority, id').map((r) => ({
      ...r,
      conditions: JSON.parse(r.conditions || '[]'),
      actions: JSON.parse(r.actions || '[]'),
      schedule: r.schedule ? JSON.parse(r.schedule) : null,
    })),
    condition_fields: CONDITION_FIELDS,
    action_types: ACTION_TYPES,
  });
});

router.post('/rules', requirePermission('admin.rules'), (req, res) => {
  const { name, description, conditions, actions, schedule, enabled = 0, priority = 100 } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Rule name is required' });
  if (!conditions?.length) return res.status(400).json({ error: 'A rule needs at least one condition' });
  if (!actions?.length) return res.status(400).json({ error: 'A rule needs at least one action' });

  const result = run(
    'INSERT INTO rules (name, description, conditions, actions, schedule, enabled, priority) VALUES (?,?,?,?,?,?,?)',
    [name, description || null, JSON.stringify(conditions), JSON.stringify(actions),
      schedule ? JSON.stringify(schedule) : null, enabled ? 1 : 0, priority],
  );
  const ruleId = Number(result.lastInsertRowid);
  audit(req.user.id, 'rule_created', 'rule', ruleId, { name });
  snapshot('rule', ruleId, { note: 'Created', userId: req.user.id });
  res.status(201).json({ id: ruleId });
});

router.patch('/rules/:id', requirePermission('admin.rules'), (req, res) => {
  const sets = [];
  const params = [];
  for (const f of ['name', 'description', 'enabled', 'priority']) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
  }
  for (const j of ['conditions', 'actions', 'schedule']) {
    if (req.body[j] !== undefined) { sets.push(`${j} = ?`); params.push(JSON.stringify(req.body[j])); }
  }
  if (sets.length) run(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  audit(req.user.id, 'rule_updated', 'rule', Number(req.params.id), req.body);
  // Snapshotted after the write, so the version records what was saved rather
  // than what was asked for -- those differ wherever a default is applied.
  const ruleVersion = sets.length
    ? snapshot('rule', Number(req.params.id), { note: req.body.note ?? null, userId: req.user.id })
    : null;
  res.json({ ok: true, version: ruleVersion?.version ?? null });
});

/** Dry-run evaluates and reports without performing a single action. */
router.post('/rules/:id/run', requirePermission('admin.rules'), (req, res) => {
  res.json(runRule(Number(req.params.id), { dryRun: req.body.dry_run !== false }));
});

router.get('/rules/:id/runs', requirePermission('admin.rules'), (req, res) => {
  res.json(all('SELECT r.*, l.name AS lead_name FROM rule_runs r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.rule_id = ? ORDER BY r.created_at DESC LIMIT 100', [req.params.id]));
});

/** Automation health — conflicts, ambiguous ordering and the failure queue. */
router.get('/rules/health', requirePermission('admin.rules'), (_req, res) => {
  res.json(healthReport());
});

/**
 * Mark a failure dealt with.
 *
 * Resolving is not retrying: the underlying problem — a dead number, a deleted
 * template — usually needs fixing first, and a retry button that re-fails is
 * how a queue becomes background noise.
 */
router.post('/rules/failures/:id/resolve', requirePermission('admin.rules'), (req, res) => {
  const row = one('SELECT * FROM rule_failures WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Failure not found' });

  run("UPDATE rule_failures SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ?",
    [req.user.id, req.params.id]);
  audit(req.user.id, 'rule_failure_resolved', 'rule', row.rule_id, { action: row.action_type });
  return res.json({ ok: true });
});

/** Re-run one rule against just the lead that failed. */
router.post('/rules/failures/:id/retry', requirePermission('admin.rules'), (req, res) => {
  const row = one('SELECT * FROM rule_failures WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Failure not found' });

  const out = runRule(row.rule_id, { dryRun: false, leadIds: [row.lead_id] });
  if (!out.failed) {
    run("UPDATE rule_failures SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ?",
      [req.user.id, req.params.id]);
  }
  audit(req.user.id, 'rule_failure_retried', 'rule', row.rule_id, { failed: out.failed });
  return res.json({ ...out, resolved: !out.failed });
});

/* -------------------------------------------------------- integrations */

router.get('/integrations', (_req, res) => {
  res.json({ integrations: integrationRegistry(), vendors: vendorStatus(), outbox: getOutbox().slice(0, 60) });
});

router.post('/integrations/trading-db/sync', requirePermission('admin.system'), (req, res) => {
  audit(req.user.id, 'trading_db_sync', 'system', null, {});
  res.json(syncTradingDb());
});

/* --------------------------------------------------------------- audit */

/* ------------------------------------------------------------- versions */

/**
 * One logical artefact, many versions, an explicit current pointer, a diff and
 * a rollback. Finding 10 of the LeadSquared audit was that none of this existed
 * anywhere, so the version history was the artefact names -- "- Clone",
 * "19Aug 2025V4-", and two live copies of the same thing.
 */

router.get('/versions', requirePermission('admin.rules'), (req, res) => {
  res.json({
    kinds: Object.entries(ARTEFACTS).map(([key, a]) => ({ key, label: a.label })),
    recent: recentVersions({ kind: req.query.kind ?? null, limit: req.query.limit }),
  });
});

router.get('/versions/:kind/:logicalId', requirePermission('admin.rules'), (req, res) => {
  if (!ARTEFACTS[req.params.kind]) {
    return res.status(404).json({ error: `Nothing called "${req.params.kind}" is versioned` });
  }
  const versions = versionsOf(req.params.kind, req.params.logicalId);
  return res.json({
    kind: req.params.kind,
    label: ARTEFACTS[req.params.kind].label,
    logical_id: req.params.logicalId,
    versions,
    current: versions.find((v) => v.is_current) ?? null,
  });
});

/** What changed between two versions, field by field. */
router.get('/versions/diff', requirePermission('admin.rules'), (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  if (!a || !b) return res.status(400).json({ error: 'Give two version ids, a and b' });

  const out = versionDiff(a, b);
  if (!out) return res.status(404).json({ error: 'One of those versions does not exist' });
  if (out.error) return res.status(400).json(out);
  return res.json(out);
});

/**
 * Put an old version back, as a new one.
 *
 * The versions in between are left exactly where they are: a rollback that
 * deleted them would destroy the record of what was live last Tuesday, which is
 * the question an auditor actually asks.
 */
router.post('/versions/:id/restore', requirePermission('admin.rules'), (req, res) => {
  const out = restoreVersion(Number(req.params.id), { userId: req.user.id });
  if (!out.ok) return res.status(404).json(out);

  const v = versionById(Number(req.params.id));
  audit(req.user.id, 'version_restored', v.kind, null,
    { logical_id: v.logical_id, restored_from: out.restored_from });
  return res.json(out);
});

/* --------------------------------------------------- configuration promotion */

/**
 * Moving configuration between environments. P2-03.
 *
 * `admin.system` rather than `admin.rules`: writing a rule in UAT and putting a
 * rule into Production are different acts, and the second wants the heavier
 * permission even though it moves the same artefact.
 */

router.get('/promotions', requirePermission('admin.system'), (_req, res) => {
  res.json({
    environment: currentEnvironment(),
    promotable: PROMOTABLE,
    kept: PROMOTIONS_KEPT,
    recent: recentPromotions(),
  });
});

/** Package a selection into a bundle. The bundle is the thing that travels. */
router.post('/promotions/package', requirePermission('admin.system'), (req, res) => {
  const out = packageBundle({
    selection: req.body?.selection,
    note: req.body?.note ?? null,
    userId: req.user.id,
  });
  if (!out.ok) return res.status(400).json(out);

  audit(req.user.id, 'config_bundle_packaged', 'promotion', null, {
    bundle_id: out.bundle.bundle_id,
    entries: out.bundle.entries.length,
  });
  return res.json(out);
});

/**
 * What applying this bundle would do here, without doing any of it.
 *
 * Separate from apply rather than a flag on it, so that "show me" cannot be
 * turned into "do it" by a mistyped parameter.
 */
router.post('/promotions/inspect', requirePermission('admin.system'), (req, res) => {
  const out = inspectBundle(req.body?.bundle);
  return res.status(out.ok ? 200 : 400).json(out);
});

/** Apply a bundle to this environment. All of it, or none of it. */
router.post('/promotions/apply', requirePermission('admin.system'), (req, res) => {
  const bundle = req.body?.bundle;
  const out = applyBundle(bundle, { userId: req.user.id, note: req.body?.note ?? null });
  if (!out.ok) return res.status(400).json(out);

  audit(req.user.id, 'config_bundle_applied', 'promotion', null, {
    bundle_id: out.bundle_id,
    source_env: out.source_env,
    target_env: out.target_env,
    created: out.created,
    updated: out.updated,
  });
  return res.json(out);
});

/* ------------------------------------------------------------ access log */

/**
 * The audit log answers "who changed this". These answer "who looked at it".
 *
 * Gated on report.system, so Admin and Super Admin only. The access log is a
 * record of who read whose data, which makes it sensitive in its own right --
 * widening it would create the problem it exists to detect.
 */
router.get('/access-log', requirePermission('report.system'), (req, res) => {
  res.json({ ...accessLogSummary(), retention_days: RETENTION_DAYS });
});

/**
 * Reads of a record belonging to a business the reader is not in.
 *
 * The query the August cross-book incident needed and could not run, because
 * nothing was recording reads at the time. Empty is the expected answer.
 */
router.get('/access-log/cross-book', requirePermission('report.system'), (req, res) => {
  const rows = crossBookReads({ since: req.query.since ?? null, until: req.query.until ?? null });
  res.json({
    rows,
    note: rows.length
      ? 'Each row is a successful read of a record from the other business. Investigate every one.'
      : 'No cross-book reads recorded in this window.',
  });
});

/** Everything one person did — for an offboarding or a conduct question. */
router.get('/access-log/user/:id', requirePermission('report.system'), (req, res) => {
  const user = one('SELECT id, name, email, role, sales_org FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ user, rows: activityOf(Number(req.params.id), { limit: req.query.limit }) });
});

/**
 * Everyone who opened one record.
 *
 * Takes the API path rather than an id, because "who read this" has to be
 * answerable for any record type without this route knowing about each one.
 */
router.get('/access-log/record', requirePermission('report.system'), (req, res) => {
  const path = String(req.query.path ?? '').trim();
  if (!path.startsWith('/api/')) {
    return res.status(400).json({
      error: 'Give the API path of the record, for example /api/tickets/2',
    });
  }
  return res.json({ path, rows: readersOf(path, { limit: req.query.limit }) });
});

router.get('/audit', requirePermission('report.system'), (req, res) => {
  const where = [];
  const params = [];
  if (req.query.entity) { where.push('a.entity = ?'); params.push(req.query.entity); }
  if (req.query.user_id) { where.push('a.user_id = ?'); params.push(req.query.user_id); }

  res.json(all(
    `SELECT a.*, u.name AS user_name, u.role AS user_role
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC LIMIT 300`,
    params,
  ));
});

/* ----------------------------------------------------------- campaigns */

/**
 * Who a campaign would actually reach, and who it would skip.
 *
 * A campaign is marketing by definition, so every member is tested against the
 * marketing gate — not the service one. This is the highest-volume send path in
 * the product and it previously had no consent check at all: a campaign to a
 * ten-thousand-name list messaged every opted-out client in it.
 *
 * Shared by the preview and the send so the number an administrator is shown
 * before pressing Send is computed by the same code that then sends. A preview
 * that disagrees with the send is worse than no preview.
 */
function campaignAudience(campaign) {
  const members = all(
    `SELECT l.* FROM lead_list_members m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.list_id = ? AND l.deleted_at IS NULL`,
    [campaign.list_id],
  );

  const reachable = [];
  const excluded = [];

  for (const lead of members) {
    const verdict = checkConsent(lead, campaign.channel, 'marketing');
    if (verdict.allowed) reachable.push(lead);
    else excluded.push({ id: lead.id, name: lead.name, code: verdict.code, reason: verdict.reason });
  }

  return { members, reachable, excluded };
}

/** A campaign that has gone out is reporting history, not a draft. */
const isSent = (c) => ['Sent', 'Sending'].includes(c.status);

/**
 * The columns a campaign list can be ordered by.
 *
 * A campaign carries no personal data of its own — it names a list and a
 * template and counts what happened — so there is nothing here to mask.
 */
export const CAMPAIGN_COLUMNS = [
  { key: 'name', label: 'Name', sql: 'c.name' },
  { key: 'channel', label: 'Channel', sql: 'c.channel' },
  { key: 'status', label: 'Status', sql: 'c.status' },
  { key: 'list_name', label: 'List', sql: 'll.name' },
  { key: 'template_name', label: 'Template', sql: 't.name' },
  { key: 'sent', label: 'Sent', sql: 'c.sent' },
  { key: 'opened', label: 'Opened', sql: 'c.opened' },
  { key: 'clicked', label: 'Clicked', sql: 'c.clicked' },
  { key: 'scheduled_at', label: 'Scheduled', sql: 'c.scheduled_at' },
  { key: 'created_by_name', label: 'Created by', sql: 'u.name' },
  { key: 'created_at', label: 'Created', sql: 'c.created_at' },
];

const campaignColumn = (key) => CAMPAIGN_COLUMNS.find((col) => col.key === key);

const CAMPAIGN_FROM = `FROM campaigns c
    LEFT JOIN templates t ON t.id = c.template_id
    LEFT JOIN lead_lists ll ON ll.id = c.list_id
    LEFT JOIN users u ON u.id = c.created_by`;

router.get('/campaigns', requirePermission('campaign.manage'), (req, res) => {
  /* Scoped to the reader's book. This list never checked it: campaigns carry a
     sales_org and the query ignored it, so a Bigul marketer's campaign list
     included Bonanza's — names, audiences and results. The same shape as the
     ticket list before it was fixed. */
  const orgs = orgsFor(req.user);
  const where = ["c.status != 'Archived'", `c.sales_org IN (${orgs.map(() => '?').join(',') || "''"})`];
  const params = [...orgs];

  const q = String(req.query.q ?? '').trim();
  if (q) {
    where.push('(c.name LIKE ? OR ll.name LIKE ? OR t.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (req.query.channel) { where.push('c.channel = ?'); params.push(req.query.channel); }
  if (req.query.status) { where.push('c.status = ?'); params.push(req.query.status); }

  const clause = where.join(' AND ');
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const sortCol = campaignColumn(req.query.sort);
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortCol ? `${sortCol.sql} ${dir}, c.id ASC` : 'c.created_at DESC';

  const total = one(`SELECT COUNT(*) n ${CAMPAIGN_FROM} WHERE ${clause}`, params).n;
  res.set('X-Total-Count', String(total));

  res.json(all(
    `SELECT c.*, t.name AS template_name, ll.name AS list_name, u.name AS created_by_name,
           (SELECT COUNT(*) FROM lead_list_members m WHERE m.list_id = c.list_id) AS list_size
    ${CAMPAIGN_FROM}
    WHERE ${clause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ));
});

/** What the campaign list can be ordered by. */
router.get('/campaigns/meta', requirePermission('campaign.manage'), (_req, res) => res.json({
  columns: CAMPAIGN_COLUMNS.map(({ key, label }) => ({ key, label })),
}));

router.get('/campaigns/archived', requirePermission('campaign.manage'), (_req, res) => {
  res.json(all(`
    SELECT c.*, t.name AS template_name, ll.name AS list_name
    FROM campaigns c
    LEFT JOIN templates t ON t.id = c.template_id
    LEFT JOIN lead_lists ll ON ll.id = c.list_id
    WHERE c.status = 'Archived' ORDER BY c.created_at DESC
  `));
});

router.post('/campaigns', requirePermission('campaign.manage'), (req, res) => {
  const { name, channel, template_id, list_id, scheduled_at } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'Give the campaign a name' });
  if (!channel) return res.status(400).json({ error: 'Choose a channel' });
  if (!list_id) return res.status(400).json({ error: 'Choose a list to send to' });

  /* A campaign belongs to the book of the audience it sends to.
   *
   * `campaigns.sales_org` defaults to 'BONANZA' at the column and this route
   * never set it — the same defect the ticket route had, and the reason every
   * seeded campaign is Bonanza's. It matters more now that the campaign list
   * filters by book: a Bigul marketer's campaign would have been created into
   * Bonanza's book, hidden from the person who made it and visible to the other
   * business.
   *
   * The list decides, because that is who receives the send. */
  const audience = one('SELECT sales_org FROM lead_lists WHERE id = ?', [list_id]);
  if (!audience) return res.status(400).json({ error: 'That list does not exist' });
  const org = audience.sales_org ?? activeOrg(req) ?? req.user.sales_org;
  if (!orgsFor(req.user).includes(org)) {
    return res.status(403).json({ error: 'That list belongs to another book' });
  }

  const result = run(
    `INSERT INTO campaigns (name, channel, template_id, list_id, scheduled_at, status, created_by, sales_org)
     VALUES (?,?,?,?,?,?,?,?)`,
    [name.trim(), channel, template_id || null, list_id, scheduled_at || null,
      scheduled_at ? 'Scheduled' : 'Draft', req.user.id, org],
  );
  audit(req.user.id, 'campaign_created', 'campaign', Number(result.lastInsertRowid), { name, channel });
  res.status(201).json(one('SELECT * FROM campaigns WHERE id = ?', [result.lastInsertRowid]));
});

/**
 * Edit a campaign.
 *
 * A sent campaign is frozen: its numbers are reporting history, and letting
 * someone rename or re-target it after the fact makes every report that quoted
 * it wrong. Duplicate it instead — which is why Duplicate exists.
 */
router.patch('/campaigns/:id', requirePermission('campaign.manage'), (req, res) => {
  const campaign = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (isSent(campaign)) {
    return res.status(409).json({
      error: `"${campaign.name}" has already gone out and cannot be changed`,
      fix: 'Duplicate it to make a new version — the sent one stays as a record of what was sent.',
    });
  }

  const fields = ['name', 'channel', 'template_id', 'list_id', 'scheduled_at'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body?.[f] === undefined) continue;
    sets.push(`${f} = ?`);
    params.push(req.body[f] === '' ? null : req.body[f]);
  }
  if (!sets.length) return res.json(campaign);

  // Adding or clearing a schedule moves the campaign between Draft and
  // Scheduled without the caller having to know that.
  if (req.body.scheduled_at !== undefined) {
    sets.push('status = ?');
    params.push(req.body.scheduled_at ? 'Scheduled' : 'Draft');
  }

  run(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  audit(req.user.id, 'campaign_updated', 'campaign', Number(req.params.id), req.body);
  res.json(one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]));
});

/** Copy a campaign back to draft. The commonest way a marketer starts one. */
router.post('/campaigns/:id/duplicate', requirePermission('campaign.manage'), (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  const result = run(
    `INSERT INTO campaigns (name, channel, template_id, list_id, status, created_by)
     VALUES (?,?,?,?,'Draft',?)`,
    [`${c.name} (copy)`, c.channel, c.template_id, c.list_id, req.user.id],
  );
  audit(req.user.id, 'campaign_duplicated', 'campaign', Number(result.lastInsertRowid), { from: c.id });
  res.status(201).json(one('SELECT * FROM campaigns WHERE id = ?', [result.lastInsertRowid]));
});

router.post('/campaigns/:id/pause', requirePermission('campaign.manage'), (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  if (c.status !== 'Scheduled') {
    return res.status(409).json({ error: `Only a scheduled campaign can be paused — this one is ${c.status}` });
  }
  run("UPDATE campaigns SET status = 'Paused' WHERE id = ?", [req.params.id]);
  audit(req.user.id, 'campaign_paused', 'campaign', Number(req.params.id), {});
  res.json(one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]));
});

router.post('/campaigns/:id/resume', requirePermission('campaign.manage'), (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  if (c.status !== 'Paused') {
    return res.status(409).json({ error: `Only a paused campaign can be resumed — this one is ${c.status}` });
  }
  run("UPDATE campaigns SET status = ? WHERE id = ?", [c.scheduled_at ? 'Scheduled' : 'Draft', req.params.id]);
  audit(req.user.id, 'campaign_resumed', 'campaign', Number(req.params.id), {});
  res.json(one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]));
});

/**
 * Archive, or delete a draft outright.
 *
 * A campaign that has sent is never deleted: its reach and engagement are the
 * evidence behind numbers that have already been reported. Archiving takes it
 * off the working list and keeps the record.
 */
router.delete('/campaigns/:id', requirePermission('campaign.manage'), (req, res) => {
  const c = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  if (isSent(c) || c.sent > 0) {
    run("UPDATE campaigns SET status = 'Archived' WHERE id = ?", [req.params.id]);
    audit(req.user.id, 'campaign_archived', 'campaign', Number(req.params.id), {});
    return res.json({
      archived: true,
      note: `"${c.name}" reached ${c.sent} people. It is archived rather than deleted so the reporting stays honest.`,
    });
  }

  run('DELETE FROM campaigns WHERE id = ?', [req.params.id]);
  audit(req.user.id, 'campaign_deleted', 'campaign', Number(req.params.id), { name: c.name });
  return res.json({ deleted: true });
});

/**
 * Who this would reach, before anyone presses Send.
 *
 * The excluded list is the point. Consent rules that silently drop recipients
 * teach nobody anything; a marketer who can see "412 excluded, term opted out"
 * before sending learns what their list actually is.
 */
router.get('/campaigns/:id/audience', requirePermission('campaign.manage'), (req, res) => {
  const campaign = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { members, reachable, excluded } = campaignAudience(campaign);

  const byReason = {};
  for (const e of excluded) byReason[e.code] = (byReason[e.code] ?? 0) + 1;

  res.json({
    list_size: members.length,
    reachable: reachable.length,
    excluded: excluded.length,
    excluded_by_reason: byReason,
    // A sample, not the whole list: this is a preview, and a marketer does not
    // need ten thousand names to understand the shape of the problem.
    sample: excluded.slice(0, 25),
    channel: campaign.channel,
  });
});

/**
 * Send one message to the person pressing the button.
 *
 * Catches a broken template before ten thousand clients see it. Goes to the
 * sender's own contact details, never to a lead.
 */
router.post('/campaigns/:id/test', requirePermission('campaign.manage'), async (req, res) => {
  const campaign = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const template = campaign.template_id
    ? one('SELECT * FROM templates WHERE id = ?', [campaign.template_id]) : null;

  const to = campaign.channel === 'email' ? req.user.email : (req.user.phone || req.user.whatsapp);
  if (!to) {
    return res.status(400).json({
      error: `You have no ${campaign.channel === 'email' ? 'email' : 'mobile number'} on your user record`,
      fix: 'Add one in Setup, then try the test again.',
    });
  }

  const { send } = await import('../integrations.js');
  send(campaign.channel, {
    to,
    body: `[TEST] ${(template?.body || 'Bonanza update').replace(/\{\{name\}\}/g, req.user.name)}`,
    subject: template?.subject ? `[TEST] ${template.subject}` : undefined,
    templateId: campaign.template_id,
  });

  audit(req.user.id, 'campaign_test_sent', 'campaign', Number(req.params.id), { to });
  res.json({ sent_to: to, note: 'Sent to you only. No lead was contacted.' });
});

/** Send a campaign to every member of its list who may lawfully receive it. */
router.post('/campaigns/:id/send', requirePermission('campaign.manage'), async (req, res) => {
  const campaign = one('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (isSent(campaign)) {
    return res.status(409).json({ error: `"${campaign.name}" has already been sent` });
  }

  /**
   * A campaign may not send to a dynamic list (Q-25).
   *
   * A dynamic list is re-evaluated on every read, so its membership can change
   * between the moment the send starts and the moment it ends. The send log and
   * the list would then disagree, and the firm loses the ability to state
   * exactly who was contacted. For a SEBI-regulated broker that is not a
   * preference — so it is refused here rather than warned about.
   */
  const list = campaign.list_id
    ? one('SELECT * FROM lead_lists WHERE id = ?', [campaign.list_id]) : null;
  if (list && !MAY_RECEIVE_CAMPAIGN.has(normaliseKind(list.kind))) {
    return res.status(409).json({
      error: `"${list.name}" is a dynamic list — its membership changes as it is read, so a send could not be evidenced afterwards. Convert it to Refreshable, or snapshot it to a static list first.`,
    });
  }

  const template = campaign.template_id
    ? one('SELECT * FROM templates WHERE id = ?', [campaign.template_id]) : null;

  /**
   * The consent gate, on the path that carries the volume.
   *
   * This previously sent to every member unconditionally. Enforcing it per lead
   * rather than per campaign means one opted-out client is skipped, not that
   * the whole campaign is refused — which is what a marketer needs, and what
   * keeps the CRM out of a DND complaint.
   */
  const { reachable, excluded } = campaignAudience(campaign);

  const { send } = await import('../integrations.js');
  for (const lead of reachable) {
    send(campaign.channel, {
      to: campaign.channel === 'email' ? lead.email : lead.mobile,
      body: (template?.body || 'Bonanza update').replace(/\{\{name\}\}/g, lead.name),
      subject: template?.subject,
      leadId: lead.id,
      templateId: campaign.template_id,
    });
  }

  const opened = Math.round(reachable.length * 0.42);
  const clicked = Math.round(reachable.length * 0.11);
  run("UPDATE campaigns SET status = 'Sent', sent = ?, opened = ?, clicked = ? WHERE id = ?",
    [reachable.length, opened, clicked, req.params.id]);

  audit(req.user.id, 'campaign_sent', 'campaign', Number(req.params.id), {
    reach: reachable.length, excluded: excluded.length,
  });

  res.json({
    sent: reachable.length,
    excluded: excluded.length,
    opened,
    clicked,
    note: excluded.length
      ? `${excluded.length} ${excluded.length === 1 ? 'person was' : 'people were'} skipped — `
        + 'opted out, no contact details, or a number flagged invalid.'
      : null,
  });
});

/* ----------------------------------------------------------- connectors */

/**
 * Meta — Facebook and Instagram.
 *
 * The connector screen reads this to show what is wired and what is not, and
 * to say plainly which capability is switched off on purpose rather than by
 * omission.
 */
router.get('/connectors/meta', requirePermission('admin.system'), (_req, res) => {
  res.json({
    ...meta.status(),
    webhook_url: '/api/webhooks/meta',
    // What the business still has to supply. Named so nobody has to guess.
    needs: meta.status().live ? [] : [
      { key: 'META_APP_ID', label: 'App ID', have: Boolean(process.env.META_APP_ID) },
      { key: 'META_APP_SECRET', label: 'App secret', have: Boolean(process.env.META_APP_SECRET) },
      { key: 'META_PAGE_TOKEN', label: 'Page access token', have: Boolean(process.env.META_PAGE_TOKEN) },
      { key: 'META_VERIFY_TOKEN', label: 'Webhook verify token', have: Boolean(process.env.META_VERIFY_TOKEN) },
      { key: 'META_AD_ACCOUNT_ID', label: 'Ad account id (for publishing ads)', have: Boolean(process.env.META_AD_ACCOUNT_ID) },
    ],
  });
});

/** Recent leads that arrived from Meta, so the connector can be seen working. */
router.get('/connectors/meta/leads', requirePermission('admin.system'), (_req, res) => {
  res.json(all(
    `SELECT id, name, mobile, source, stage, owner_id, created_at
     FROM leads
     WHERE source IN ('Facebook Lead Ads', 'Instagram') AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 25`,
  ));
});

/**
 * Publish an ad campaign to Meta.
 *
 * Created paused, always. A CRM button that starts spending money the instant
 * it is pressed is a bad idea however good the confirmation dialog; a human
 * starts it in Ads Manager having seen it.
 */
router.post('/connectors/meta/campaigns', requirePermission('campaign.manage'), async (req, res, next) => {
  const { name, objective, daily_budget: dailyBudget } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'Give the ad campaign a name' });

  try {
    const out = await meta.publishCampaign({ name: name.trim(), objective, dailyBudget });
    audit(req.user.id, 'meta_campaign_published', 'campaign', null, { name, id: out.id });
    return res.status(201).json({
      ...out,
      note: out.note ?? 'Created paused. Start it in Ads Manager once you have reviewed it.',
    });
  } catch (err) {
    if (err.name === 'VendorError') return res.status(502).json({ error: err.message, vendor: 'meta' });
    return next(err);
  }
});

router.get('/connectors/meta/campaigns/:id/insights', requirePermission('campaign.manage'), async (req, res, next) => {
  try { return res.json(await meta.campaignInsights(req.params.id)); }
  catch (err) {
    if (err.name === 'VendorError') return res.status(502).json({ error: err.message, vendor: 'meta' });
    return next(err);
  }
});

/**
 * Push a lead list to Meta as a Custom Audience.
 *
 * The one capability that conflicts with this firm's own data-residency rule,
 * so it is refused unless someone has deliberately enabled it. The refusal
 * explains the conflict rather than reporting a missing setting — whoever hits
 * it needs to know it is a policy decision.
 */
router.post('/connectors/meta/audiences', requirePermission('campaign.manage'), async (req, res, next) => {
  const { name, list_id: listId } = req.body ?? {};
  if (!name?.trim() || !listId) {
    return res.status(400).json({ error: 'A name and a lead list are both required' });
  }

  if (!meta.audiencesEnabled()) {
    return res.status(409).json(await meta.pushAudience({ name, leads: [] }));
  }

  // Only members who have not opted out. An audience is marketing by
  // definition, so the same consent rule applies as to any campaign send.
  const leads = all(
    `SELECT l.id, l.mobile, l.email FROM lead_list_members m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.list_id = ? AND l.deleted_at IS NULL
       AND COALESCE(l.marketing_opt_out, 0) = 0`,
    [listId],
  );

  try {
    const out = await meta.pushAudience({ name: name.trim(), leads });
    audit(req.user.id, 'meta_audience_pushed', 'lead_list', Number(listId), {
      name, sent: out.matched, note: 'Hashed identifiers left India',
    });
    return res.json(out);
  } catch (err) {
    if (err.name === 'VendorError') return res.status(502).json({ error: err.message, vendor: 'meta' });
    return next(err);
  }
});

/* ----------------------------------------------------------- calendars */

/**
 * Working calendars.
 *
 * Editable rather than compiled in, because the dates that matter most move
 * every year: Holi, Diwali, Eid and Dussehra follow the lunar calendar and are
 * published by NSE in an annual circular. Only the fixed-date national holidays
 * ship seeded — inventing the rest would be worse than leaving them out.
 */
router.get('/calendars', requirePermission('admin.sla'), (_req, res) => {
  res.json({
    calendars: listCalendars(),
    note: 'Only fixed-date national holidays are seeded. Paste the rest from the '
      + 'NSE annual circular — festival dates move each year and are not guessed here.',
  });
});

router.patch('/calendars/:kind', requirePermission('admin.sla'), (req, res) => {
  if (!CALENDAR_KINDS.includes(req.params.kind)) {
    return res.status(404).json({ error: `No ${req.params.kind} calendar` });
  }
  const out = updateCalendar(req.params.kind, req.body ?? {});
  audit(req.user.id, 'calendar_updated', 'calendar', null, { kind: req.params.kind, ...req.body });
  return res.json(out);
});

router.post('/calendars/:kind/days', requirePermission('admin.sla'), (req, res) => {
  const out = addDay(req.params.kind, req.body ?? {});
  if (!out.ok) return res.status(400).json(out);
  audit(req.user.id, 'calendar_day_added', 'calendar', null, { kind: req.params.kind, ...req.body });
  return res.status(201).json(listCalendars().find((c) => c.kind === req.params.kind));
});

router.delete('/calendars/days/:id', requirePermission('admin.sla'), (req, res) => {
  removeDay(Number(req.params.id));
  audit(req.user.id, 'calendar_day_removed', 'calendar', Number(req.params.id), {});
  return res.json({ deleted: true });
});

/** Ask the calendar a question — used by the UI to show the effect of an edit. */
router.get('/calendars/:kind/check', requirePermission('admin.sla'), (req, res) => {
  const { date, minutes } = req.query;
  const when = date ? new Date(`${date}T10:00:00`) : new Date();
  res.json({
    date: req.query.date ?? null,
    working_day: isWorkingDay(when, req.params.kind),
    next_working_time: nextWorkingTime(when, req.params.kind).toISOString(),
    plus_minutes: minutes
      ? addWorkingMinutes(when, Number(minutes), req.params.kind).toISOString()
      : undefined,
  });
});

export default router;
