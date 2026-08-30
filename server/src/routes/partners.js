/**
 * Partner module — pre-onboarding pipeline, elevation to entity, and the
 * post-onboarding partner profile.
 *
 * Partners are NOT CRM users (BRD OD-10). Their own login lives on the Partner
 * Portal (routes/portal.js), which is a separate authenticated surface.
 */

import { Router } from 'express';
import { all, one, run, audit, notify, daysSince, PARTNER_STATES } from '../db.js';
import { requireUser, requirePermission, can, unmaskRequested, maskFor, orgsFor, mayUseOrg } from '../auth.js';
import { encryptField, decryptField, maskRecord, maskRecords, validate } from '../security.js';
import { send, lmsSync } from '../integrations.js';
import { hashPassword } from '../security.js';
import * as ai from '../ai/index.js';
import { applyFieldSecurity } from '../engine/metadata.js';
import { lockRefusal } from '../engine/approvals.js';

const router = Router();
router.use(requireUser);

export const ONBOARDING_STEPS = [
  { code: 'PROFILE', label: 'Business profile captured' },
  { code: 'KYC_DOCS', label: 'KYC documents collected (PAN, address, bank)' },
  { code: 'AGREEMENT', label: 'Partner agreement signed' },
  { code: 'COMPLIANCE', label: 'Compliance & background check cleared' },
  { code: 'SEBI_REG', label: 'SEBI / exchange registration verified' },
  { code: 'LMS_ENROL', label: 'Enrolled in LMS' },
  { code: 'LMS_COMPLETE', label: 'Training modules completed' },
  { code: 'CODE_ISSUED', label: 'Partner code issued' },
];

export const LMS_MODULES = [
  'Bonanza product suite',
  'SEBI code of conduct & compliance',
  'Client onboarding and KYC',
  'Trading platforms — MyEtrade & Bigul',
  'Risk management basics',
];

const decorate = (p) => {
  const month = new Date().toISOString().slice(0, 7);
  // Encrypted at rest; decrypted here, masked at the response boundary.
  p = { ...p, pan: decryptField(p.pan), bank_account: decryptField(p.bank_account), bank_ifsc: decryptField(p.bank_ifsc) };
  return {
    ...p,
    owner_name: p.owner_id ? one('SELECT name FROM users WHERE id = ?', [p.owner_id])?.name : null,
    sourced_count: one('SELECT COUNT(*) n FROM leads WHERE partner_id = ? AND deleted_at IS NULL', [p.id]).n,
    sourced_this_month: one("SELECT COUNT(*) n FROM leads WHERE partner_id = ? AND strftime('%Y-%m', created_at) = ?", [p.id, month]).n,
    converted_count: one("SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id WHERE l.partner_id = ? AND pc.state = 'ACTIVE'", [p.id]).n,
    aum_attributed: one("SELECT COALESCE(SUM(pc.value),0) v FROM product_cards pc JOIN leads l ON l.id = pc.lead_id WHERE l.partner_id = ? AND pc.state = 'ACTIVE'", [p.id]).v,
    commission_month: one('SELECT COALESCE(SUM(payout),0) v FROM commissions WHERE partner_id = ? AND period = ?', [p.id, month]).v,
    steps_done: one("SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ? AND status = 'done'", [p.id]).n,
    steps_total: one('SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ?', [p.id]).n,
    last_activity: one('SELECT MAX(created_at) at FROM activities WHERE partner_id = ?', [p.id]).at,
    age_days: daysSince(p.created_at),
    has_portal_login: Boolean(p.portal_password),
  };
};

/* ------------------------------------------------------------ pipeline */

router.get('/', requirePermission('partner.view'), (req, res) => {
  /* Scoped to the reader's book.
   *
   * partner.view is held by Admin, Partner RM and Sales Supervisor -- roles
   * that exist in both books -- so holding the capability was enough to list
   * the other book's partners, their codes and their commercial state. */
  const orgs = orgsFor(req.user);
  const where = [`sales_org IN (${orgs.map(() => '?').join(',') || "''"})`];
  const params = [...orgs];
  if (req.query.state) { where.push('state_code = ?'); params.push(req.query.state); }
  if (req.query.mine === 'true' || req.user.role === 'partner_rm') { where.push('owner_id = ?'); params.push(req.user.id); }

  const rows = all(`SELECT * FROM partners ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`, params).map(decorate);
  res.json(maskRecords(rows, maskFor(req, 'partner_list')));
});

router.get('/:id', requirePermission('partner.view'), (req, res) => {
  const partner = one('SELECT * FROM partners WHERE id = ?', [req.params.id]);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });
  if (!mayUseOrg(req.user, partner.sales_org)) {
    return res.status(403).json({ error: 'This partner belongs to another book' });
  }

  res.json({
    ...maskRecord(decorate(partner), maskFor(req, 'partner', Number(req.params.id))),
    steps: all('SELECT * FROM partner_steps WHERE partner_id = ? ORDER BY sort_order', [req.params.id]),
    lms: all('SELECT * FROM partner_lms WHERE partner_id = ?', [req.params.id]),
    sourced_leads: all(
      `SELECT l.id, l.name, l.stage, l.created_at,
              (SELECT GROUP_CONCAT(pt.code || ':' || pc.state)
               FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
               WHERE pc.lead_id = l.id AND pc.state != 'INACTIVE') AS cards
       FROM leads l WHERE l.partner_id = ? AND l.deleted_at IS NULL ORDER BY l.created_at DESC`,
      [req.params.id],
    ),
    activities: applyFieldSecurity('interaction',
      all('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.partner_id = ? ORDER BY a.created_at DESC LIMIT 50', [req.params.id]),
      req.user, { caps: req.caps }),
    notes: all('SELECT n.*, u.name AS user_name, u.role AS user_role FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.partner_id = ? ORDER BY n.pinned DESC, n.created_at DESC', [req.params.id]),
    tickets: all('SELECT * FROM tickets WHERE partner_id = ? ORDER BY created_at DESC', [req.params.id]),
    commissions: all('SELECT c.*, pt.name AS product_name FROM commissions c LEFT JOIN product_types pt ON pt.id = c.product_type_id WHERE c.partner_id = ? ORDER BY c.period DESC', [req.params.id]),
  });
});

router.post('/', requirePermission('partner.create'), (req, res) => {
  const { name, business_name, partner_model, mobile, email, city, state, pan, sebi_reg_no, commission_pct } = req.body;

  const invalid = validate(req.body, {
    name: ['required', 'max:120'], mobile: ['mobile'], email: ['email'], pan: ['pan'],
  });
  if (invalid) return res.status(400).json(invalid);

  const result = run(
    `INSERT INTO partners (name, business_name, partner_model, mobile, email, city, state, pan, sebi_reg_no, owner_id, commission_pct, state_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'PROSPECT')`,
    [name, business_name || null, partner_model || 'Remisier', mobile || null, email || null, city || null,
      state || null, encryptField(pan ? String(pan).toUpperCase() : null), sebi_reg_no || null,
      req.user.id, commission_pct || 0],
  );
  const id = Number(result.lastInsertRowid);

  ONBOARDING_STEPS.forEach((s, i) => {
    run('INSERT INTO partner_steps (partner_id, code, label, status, sort_order) VALUES (?,?,?,?,?)', [
      id, s.code, s.label, i === 0 ? 'active' : 'pending', i,
    ]);
  });
  for (const m of LMS_MODULES) {
    run('INSERT INTO partner_lms (partner_id, module) VALUES (?,?)', [id, m]);
  }

  audit(req.user.id, 'partner_created', 'partner', id, { partner_model });
  res.status(201).json(decorate(one('SELECT * FROM partners WHERE id = ?', [id])));
});

router.patch('/:id', requirePermission('partner.create'), (req, res) => {
  /**
   * A record with a pending approval is frozen.
   *
   * Enforced here rather than by hiding the edit form: if a commission can
   * still be changed while a change to it awaits sign-off, the approver puts
   * their name to a number that is no longer there.
   */
  const locked = lockRefusal('partner', Number(req.params.id));
  if (locked) return res.status(409).json(locked);

  const invalid = validate(req.body, { mobile: ['mobile'], email: ['email'], pan: ['pan'], bank_ifsc: ['ifsc'] });
  if (invalid) return res.status(400).json(invalid);

  const ENCRYPTED = new Set(['pan', 'bank_account', 'bank_ifsc']);
  const fields = ['name', 'business_name', 'partner_model', 'mobile', 'email', 'city', 'state', 'pan', 'sebi_reg_no', 'commission_pct', 'bank_account', 'bank_ifsc', 'owner_id'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    sets.push(`${f} = ?`);
    params.push(ENCRYPTED.has(f) ? encryptField(req.body[f]) : req.body[f]);
  }

  if (req.body.state_code) {
    if (['SUSPENDED', 'TERMINATED'].includes(req.body.state_code) && !can(req.user.role, 'partner.suspend')) {
      return res.status(403).json({ error: 'Only an Admin can suspend or terminate a partner', required: 'partner.suspend' });
    }
    if (!PARTNER_STATES.includes(req.body.state_code)) return res.status(400).json({ error: 'Unknown partner state' });
    sets.push('state_code = ?'); params.push(req.body.state_code);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  run(`UPDATE partners SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  audit(req.user.id, 'partner_updated', 'partner', Number(req.params.id), req.body);
  res.json(decorate(one('SELECT * FROM partners WHERE id = ?', [req.params.id])));
});

/* ---------------------------------------------------------- onboarding */

router.post('/:id/steps/:code', requirePermission('partner.create'), (req, res) => {
  const partner = one('SELECT * FROM partners WHERE id = ?', [req.params.id]);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  run("UPDATE partner_steps SET status = 'done', completed_at = datetime('now') WHERE partner_id = ? AND code = ?", [req.params.id, req.params.code]);

  const next = one("SELECT * FROM partner_steps WHERE partner_id = ? AND status = 'pending' ORDER BY sort_order LIMIT 1", [req.params.id]);
  if (next) run("UPDATE partner_steps SET status = 'active' WHERE id = ?", [next.id]);

  // Progress the partner state as onboarding advances.
  if (partner.state_code === 'PROSPECT') run("UPDATE partners SET state_code = 'QUALIFYING' WHERE id = ?", [req.params.id]);
  if (req.params.code === 'AGREEMENT') run("UPDATE partners SET state_code = 'ONBOARDING' WHERE id = ?", [req.params.id]);

  run('INSERT INTO activities (partner_id, type, direction, subject, user_id) VALUES (?,?,?,?,?)', [
    req.params.id, 'Partner Activity', 'system', `Onboarding step complete: ${req.params.code}`, req.user.id,
  ]);
  audit(req.user.id, 'partner_step', 'partner', Number(req.params.id), { step: req.params.code });
  res.json({ ok: true, next_step: next?.code || null });
});

router.post('/:id/lms/:module', requirePermission('partner.create'), (req, res) => {
  run("UPDATE partner_lms SET status = 'Completed', score = ?, completed_at = datetime('now') WHERE partner_id = ? AND module = ?", [
    req.body.score ?? 80, req.params.id, decodeURIComponent(req.params.module),
  ]);
  res.json({ ok: true, modules: lmsSync(Number(req.params.id)) });
});

/**
 * Elevation is a staged, audited workflow (BRD risk register):
 * Partner RM requests → Admin approves → system creates the entity + portal login.
 */
router.post('/:id/request-elevation', requirePermission('partner.elevate.request'), (req, res) => {
  const partner = one('SELECT * FROM partners WHERE id = ?', [req.params.id]);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  const pending = one("SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ? AND status != 'done'", [req.params.id]);
  if (pending.n > 0) return res.status(400).json({ error: `${pending.n} onboarding step(s) still incomplete`, pending: pending.n });

  for (const admin of all("SELECT id FROM users WHERE role IN ('admin','superadmin') AND active = 1")) {
    notify(admin.id, 'Partner elevation requested', `${req.user.name} has requested elevation for ${partner.name}.`, `/partners/${partner.id}`);
  }
  audit(req.user.id, 'partner_elevation_requested', 'partner', partner.id, {});
  res.json({ requested: true });
});

router.post('/:id/elevate', requirePermission('partner.elevate'), (req, res) => {
  const partner = one('SELECT * FROM partners WHERE id = ?', [req.params.id]);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });
  if (partner.state_code === 'ACTIVE') return res.status(400).json({ error: 'Partner is already active' });

  const code = `BNZ-P${String(partner.id).padStart(4, '0')}`;
  const password = req.body.portal_password || `partner${partner.id}`;

  run("UPDATE partners SET state_code = 'ACTIVE', partner_code = ?, onboarded_at = datetime('now'), portal_password = ? WHERE id = ?",
    [code, hashPassword(password), req.params.id]);
  run('INSERT INTO activities (partner_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)', [
    req.params.id, 'Partner Activity', 'system', 'Elevated to Partner entity',
    `Partner code ${code} issued. Portal access enabled.`, req.user.id,
  ]);
  if (partner.mobile) {
    send('whatsapp', {
      to: partner.mobile,
      body: `Welcome to Bonanza, ${partner.name}. Your partner code is ${code}. You can now sign in to the Partner Portal.`,
      partnerId: partner.id,
    });
  }
  notify(partner.owner_id, 'Partner activated', `${partner.name} is now an active partner (${code}).`, `/partners/${partner.id}`);
  audit(req.user.id, 'partner_elevated', 'partner', partner.id, { code });

  res.json({ elevated: true, partner_code: code, portal_login: { email: partner.email, password } });
});

/* ------------------------------------------------------------ activity */

router.post('/:id/activities', requirePermission('partner.view'), (req, res) => {
  const { type = 'Partner Activity', subject, body, lead_id } = req.body;
  run('INSERT INTO activities (partner_id, lead_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,?)', [
    req.params.id, lead_id || null, type, 'outbound', subject || 'Partner activity', body || null, req.user.id,
  ]);
  res.status(201).json({ ok: true });
});

/** Attribute an existing lead to this partner. */
router.post('/:id/sourced-leads', requirePermission('partner.view'), (req, res) => {
  const { lead_id } = req.body;
  run('UPDATE leads SET partner_id = ? WHERE id = ?', [req.params.id, lead_id]);
  run('INSERT INTO activities (partner_id, lead_id, type, direction, subject, user_id) VALUES (?,?,?,?,?,?)', [
    req.params.id, lead_id, 'Partner Activity', 'inbound', 'Lead attributed to partner', req.user.id,
  ]);
  res.json({ ok: true });
});

router.get('/:id/insight', requirePermission('partner.view'), async (req, res, next) => {
  try {
    /* The sibling of /partners/:id, and it was missed when that one was fixed
     * -- the same "one of a pair" slip as /cards/:id/detail and /cards/:id/audit.
     * The insight names the partner and summarises their sourcing and accrued
     * commission, so it gives away most of what the record does. */
    const partner = one('SELECT sales_org FROM partners WHERE id = ?', [req.params.id]);
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    if (!mayUseOrg(req.user, partner.sales_org)) {
      return res.status(403).json({ error: 'This partner belongs to another book' });
    }

    const ctx = ai.partnerInsightContext(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Partner not found' });
    res.json(await ai.partnerInsight(ctx));
  } catch (err) { next(err); }
});

export default router;
