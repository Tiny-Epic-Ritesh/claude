/**
 * Revenue Board — what your book has earned, and what it could.
 *
 * Scoped like everything else, so an RM sees their own numbers and a supervisor
 * sees their chain's from the same endpoint. That is what made it safe to give
 * an RM the tab at all (ENH-08): the question was never whether they should see
 * revenue, only whose.
 *
 * The untapped section is the reason this page is worth opening twice. Existing
 * clients not holding a product they plausibly should is the cheapest revenue
 * in the business, and nothing else in the CRM surfaces it.
 */

import { Router } from 'express';
import { all, one } from '../db.js';
import { requireUser, leadScope, clientScope, activeOrg, can } from '../auth.js';
import { resolveRange, inRange, inPrevRange, delta, RANGES, DEFAULT_RANGE } from '../engine/daterange.js';

const router = Router();
router.use(requireUser);

router.get('/', (req, res) => {
  const range = resolveRange(req.query.range || DEFAULT_RANGE, {
    from: req.query.from, to: req.query.to,
  });

  const lScope = leadScope(req.user, 'l', activeOrg(req));
  const maySeeClients = can(req.user.role, 'client.view.all') || can(req.user.role, 'client.view.own');
  const cScope = maySeeClients ? clientScope(req.user, 'c', activeOrg(req)) : { sql: '1=0', params: [] };

  /* ---- earned, by product ---- */
  const byProduct = all(
    `SELECT pt.id, pt.name, pt.category,
            COUNT(*) AS active_cards,
            COALESCE(SUM(pc.value), 0) AS value
       FROM product_cards pc
       JOIN leads l ON l.id = pc.lead_id
       JOIN product_types pt ON pt.id = pc.product_type_id
      WHERE pc.state = 'ACTIVE' AND l.deleted_at IS NULL AND ${lScope.sql}
      GROUP BY pt.id
      ORDER BY value DESC`,
    lScope.params,
  );

  /* ---- brokerage, from the client book ---- */
  const brokerage = maySeeClients
    ? one(
      `SELECT COALESCE(SUM(c.brokerage_ytd), 0) AS ytd,
              COALESCE(SUM(c.holding_value), 0) AS holdings,
              COUNT(*) AS accounts
         FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql}`,
      cScope.params,
    )
    : { ytd: 0, holdings: 0, accounts: 0 };

  /* ---- accounts opened in the period, against the one before it ---- */
  const opened = inRange('c.activated_at', range);
  const prevOpened = inPrevRange('c.activated_at', range);
  const nowOpened = maySeeClients
    ? one(`SELECT COUNT(*) n FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql} AND ${opened.sql}`,
      [...cScope.params, ...opened.params]).n
    : 0;
  const beforeOpened = maySeeClients
    ? one(`SELECT COUNT(*) n FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql} AND ${prevOpened.sql}`,
      [...cScope.params, ...prevOpened.params]).n
    : 0;

  /**
   * Untapped: a client who holds something, but not this.
   *
   * Restricted to clients who already hold at least one product, because a lead
   * holding nothing is a prospecting job rather than a cross-sell one, and
   * mixing the two makes the number useless for either.
   */
  const untapped = all(
    `SELECT pt.id, pt.name, COUNT(*) AS opportunity
       FROM leads l
       JOIN product_cards pc ON pc.lead_id = l.id AND pc.product_type_id = pt.id
       JOIN product_types pt ON pt.active = 1
      WHERE l.deleted_at IS NULL AND ${lScope.sql}
        AND pc.state = 'INACTIVE'
        AND EXISTS (SELECT 1 FROM product_cards h
                     WHERE h.lead_id = l.id AND h.state = 'ACTIVE')
      GROUP BY pt.id
      ORDER BY opportunity DESC
      LIMIT 8`,
    lScope.params,
  );

  /**
   * Where this person sits among their peers.
   *
   * Peers are the same role in the same business, which is the only comparison
   * that means anything -- ranking a Caller against a Product Supervisor would
   * be arithmetic rather than information. Suppressed below three peers,
   * because "2nd of 2" identifies the other person.
   */
  const peers = all(
    `SELECT u.id, u.name,
            (SELECT COALESCE(SUM(pc.value), 0)
               FROM product_cards pc JOIN leads l2 ON l2.id = pc.lead_id
              WHERE l2.owner_id = u.id AND pc.state = 'ACTIVE' AND l2.deleted_at IS NULL) AS value
       FROM users u
      WHERE u.active = 1 AND u.role = ? AND u.sales_org = ?
      ORDER BY value DESC`,
    [req.user.role, req.user.sales_org],
  );
  const myIndex = peers.findIndex((p) => p.id === req.user.id);

  res.json({
    range: { code: range.code, label: range.label, from: range.from, to: range.to },
    ranges: RANGES,
    earned: {
      active_value: byProduct.reduce((s, p) => s + p.value, 0),
      brokerage_ytd: brokerage.ytd,
      holdings: brokerage.holdings,
      accounts: brokerage.accounts,
      opened_in_range: nowOpened,
      opened_trend: delta(nowOpened, beforeOpened),
    },
    by_product: byProduct,
    untapped,
    rank: peers.length >= 3 && myIndex >= 0
      ? { position: myIndex + 1, of: peers.length, role: req.user.role }
      : null,
  });
});

export default router;
