/**
 * What other systems ask the CRM (OPS-42).
 *
 * Not the CRM's own screens: each route here is called by another system with
 * an API key bound to an API integration account, and guarded by the one
 * capability it answers for. Kept apart from /api/clients so that what a key
 * can reach is a short list in one file rather than a route hidden among the
 * ones people use -- the integration spec for each lives in docs/integrations.
 */

import { Router } from 'express';
import { one } from '../db.js';
import { requireUser, requirePermission, mayUseOrg } from '../auth.js';
import { nominationPrompt } from '../engine/nominations.js';

const router = Router();
router.use(requireUser);

/**
 * The first-log-in-of-the-day pop-up (SEBI, May 2026, 10.2(b)).
 *
 * The client logs into the trading platform, not the CRM, so the platform
 * asks here on each log-in, by UCC and business. The answer is "show" once a
 * day for an account without a nomination, an opt-out included, with the
 * wording to show; never for one with a nomination.
 *
 * docs/integrations/NOMINATION-POPUP.md is what the trading platform's team is
 * given.
 */
router.get('/nomination-prompt', requirePermission('client.nomination.prompt'), (req, res) => {
  const code = String(req.query.client_code ?? '').trim();
  const business = String(req.query.business ?? '').trim().toUpperCase();
  if (!code || !business) return res.status(400).json({ error: 'Give the client_code (UCC) and the business' });
  if (!mayUseOrg(req.user, business)) return res.status(404).json({ error: 'No such account' });
  const client = one(
    "SELECT * FROM clients WHERE client_code = ? AND sales_org = ? AND deleted_at IS NULL AND status <> 'Closed'",
    [code, business],
  );
  if (!client) return res.status(404).json({ error: 'No such account' });
  return res.json({ client_code: client.client_code, ...nominationPrompt(client) });
});

export default router;
