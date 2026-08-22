/**
 * Sales orgs — the Bonanza / Bigul switch.
 *
 * One platform, two businesses. This router tells the client which orgs the
 * signed-in user may work in and what each one looks like, so the header
 * switcher and the per-org accent colour render from data rather than from a
 * hard-coded list that drifts.
 *
 * The switcher is a VIEW FILTER, never an entitlement. Narrowing to one org
 * happens here for convenience, but every data route re-derives the allowed set
 * from the user record — a forged `?org=BIGUL` gets the user nothing they were
 * not already entitled to.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { requireUser, requirePermission, orgsFor } from '../auth.js';

const router = Router();
router.use(requireUser);

/** Orgs this user may work in, with their branding. */
router.get('/', (req, res) => {
  const allowed = orgsFor(req.user);
  if (!allowed.length) return res.json({ orgs: [], active_default: null });

  const rows = all(
    `SELECT code, name, legal_name, tagline, accent, accent_dark, model, kyc_url
     FROM sales_orgs
     WHERE active = 1 AND code IN (${allowed.map(() => '?').join(',')})
     ORDER BY sort_order`,
    allowed,
  );

  return res.json({
    orgs: rows,
    // Their home org is the sensible landing view; "ALL" is offered only when
    // they actually straddle both, because a single-org user does not need it.
    active_default: req.user.sales_org || rows[0]?.code || null,
    may_switch: rows.length > 1,
  });
});

/** Headline counts per org — drives the switcher's secondary line. */
router.get('/summary', (req, res) => {
  const allowed = orgsFor(req.user);
  if (!allowed.length) return res.json([]);

  return res.json(allowed.map((code) => {
    const leads = one(
      "SELECT COUNT(*) n FROM leads WHERE sales_org = ? AND deleted_at IS NULL",
      [code],
    ).n;
    const clients = one(
      `SELECT COUNT(DISTINCT l.id) n FROM leads l
       JOIN product_cards pc ON pc.lead_id = l.id AND pc.state = 'ACTIVE'
       WHERE l.sales_org = ? AND l.deleted_at IS NULL`,
      [code],
    ).n;
    const org = one('SELECT name, accent FROM sales_orgs WHERE code = ?', [code]);
    return { code, name: org?.name ?? code, accent: org?.accent ?? null, leads, clients };
  }));
});

/** Editing org branding is a platform-admin act, not a business one. */
router.patch('/:code', requirePermission('admin.system'), (req, res) => {
  const org = one('SELECT code FROM sales_orgs WHERE code = ?', [req.params.code]);
  if (!org) return res.status(404).json({ error: 'Unknown sales org' });

  // Fixed allowlist, so no caller-supplied string ever reaches the statement.
  const ALLOWED = ['name', 'legal_name', 'tagline', 'accent', 'accent_dark', 'kyc_url', 'active'];
  const fields = ALLOWED.filter((f) => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  run(
    `UPDATE sales_orgs SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE code = ?`,
    [...fields.map((f) => req.body[f]), req.params.code],
  );
  audit(req.user.id, 'sales_org_updated', 'sales_org', null, { code: req.params.code, fields });

  return res.json(one('SELECT * FROM sales_orgs WHERE code = ?', [req.params.code]));
});

export default router;
