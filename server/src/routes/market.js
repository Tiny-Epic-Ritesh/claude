/**
 * Market data endpoints.
 *
 * Split into two routers on purpose:
 *
 *   `publicIndices`  the login page, before anyone has signed in. Serves the
 *                    index strip and nothing else — no news, no calendars, no
 *                    identifiers, and certainly nothing derived from the book.
 *                    An unauthenticated endpoint on a broker's CRM should be
 *                    able to leak nothing, because it will be found.
 *
 *   `router`         everything else, behind a session.
 *
 * Both serve delayed figures with the delay and the timestamp attached, because
 * the envelope is applied in the adapter rather than here — a new endpoint
 * cannot forget it.
 */

import { Router } from 'express';
import { requireUser } from '../auth.js';
import { one, all } from '../db.js';
import {
  indices, news, corporateActions, issues, snapshot, status, DISCLAIMER, DELAY_MINUTES,
} from '../vendors/marketdata.js';

/* ------------------------------------------------------------- public */

/**
 * The login-page strip. Deliberately the narrowest possible surface: four
 * index levels that are already fifteen minutes old and are published on every
 * financial website in the country.
 */
export const publicIndices = Router();

publicIndices.get('/indices', (_req, res) => {
  const data = indices();
  res.json({
    indices: data.indices,
    as_of: data.as_of,
    delayed_minutes: data.delayed_minutes,
    disclaimer: data.disclaimer,
    simulated: data.simulated,
    stale: data.stale ?? false,
  });
});

/* ---------------------------------------------------------- internal */

const router = Router();
router.use(requireUser);

router.get('/indices', (_req, res) => res.json(indices()));
router.get('/news', (req, res) => res.json(news(Number(req.query.limit) || 8)));
router.get('/corporate-actions', (_req, res) => res.json(corporateActions()));
router.get('/issues', (_req, res) => res.json(issues()));

/** Everything, for the Market tab — one round trip rather than four. */
router.get('/snapshot', (_req, res) => res.json(snapshot()));

/** Whether a real feed is wired, for the integrations screen. */
router.get('/status', (_req, res) => res.json(status()));

/**
 * Market context for one lead.
 *
 * WHAT THIS IS NOT, YET
 * ---------------------
 * It is not "your client holds Reliance and results are Tuesday". That needs
 * instrument-level positions, and no such table exists — so this does not
 * pretend to. Claiming a holding we cannot see would be worse than saying
 * nothing on a screen an RM is about to call a client from.
 *
 * WHAT IT IS
 * ----------
 * The lead's recorded product interest, matched to what is happening in that
 * part of the market. A lead with an open Mutual Funds card gets the NFOs; one
 * looking at Equity gets the results calendar. That is a call reason drawn from
 * data we actually hold.
 */
router.get('/context/:leadId', (req, res) => {
  const lead = one('SELECT id, name FROM leads WHERE id = ? AND deleted_at IS NULL', [req.params.leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const cards = all(
    `SELECT pt.code, pt.name, pt.category, pc.state
     FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
     WHERE pc.lead_id = ? AND pc.state != 'INACTIVE'`,
    [lead.id],
  );

  const categories = new Set(cards.map((c) => c.category));
  const wantsFunds = categories.has('Investment');
  const wantsEquity = categories.has('Broking') || categories.has('Advisory');

  const allIssues = issues().issues;
  const relevantIssues = allIssues.filter((i) =>
    (wantsFunds && i.kind === 'NFO') || (wantsEquity && i.kind === 'IPO'));

  const data = indices();

  return res.json({
    lead: { id: lead.id, name: lead.name },
    // The indices an RM would mention on a call, whatever the lead holds.
    indices: data.indices.slice(0, 3),
    // Only where the lead has shown interest — an untargeted calendar is noise.
    issues: relevantIssues,
    actions: wantsEquity ? corporateActions().actions.slice(0, 4) : [],
    interests: cards.map((c) => ({ code: c.code, name: c.name, state: c.state })),
    basis: cards.length
      ? 'Matched to this lead’s recorded product interest.'
      : 'No product interest recorded yet, so this is general market context.',
    as_of: data.as_of,
    delayed_minutes: DELAY_MINUTES,
    disclaimer: DISCLAIMER,
    simulated: data.simulated,
  });
});

export default router;
