/**
 * Product desks.
 *
 * The catalogue was editable in Setup and readable on a lead, but there was
 * nowhere to stand *inside* a product and ask how it is doing — which is the
 * question a Product RM has all day and a Product Supervisor has at month end.
 *
 * Every figure is computed under the caller's own leadScope, so a Product RM
 * sees their product across their book and a supervisor sees it across theirs,
 * from the same endpoint. That is also what makes the funnel here agree with
 * the Pipeline board rather than quietly disagreeing with it.
 */

import { Router } from 'express';
import { all, one, CARD_COLOUR } from '../db.js';
import { requireUser, leadScope, activeOrg, orgScope } from '../auth.js';
import { PIPELINE_STATES, TERMINAL_STATES } from './pipeline.js';

const router = Router();
router.use(requireUser);

const parse = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};

/* ------------------------------------------------------------- catalogue */

router.get('/', (req, res) => {
  const scope = leadScope(req.user, 'l', activeOrg(req));
  const org = orgScope(req.user, 'pt', activeOrg(req));

  /**
   * One aggregate for every product, rather than a query per row.
   *
   * Twenty-one products with a count-per-state each is sixty round trips on a
   * page that opens on a click. The lead list already taught this codebase that
   * lesson; there is no reason to relearn it here.
   */
  const stats = new Map();
  for (const r of all(
    `SELECT pc.product_type_id AS pid, pc.state, COUNT(*) AS n,
            COALESCE(SUM(pc.value), 0) AS value
       FROM product_cards pc
       JOIN leads l ON l.id = pc.lead_id
      WHERE l.deleted_at IS NULL AND ${scope.sql}
      GROUP BY pc.product_type_id, pc.state`,
    scope.params,
  )) {
    if (!stats.has(r.pid)) stats.set(r.pid, {});
    stats.get(r.pid)[r.state] = { n: r.n, value: r.value };
  }

  const products = all(
    `SELECT pt.* FROM product_types pt
      WHERE pt.active = 1 AND ${org.sql}
      ORDER BY pt.sort_order, pt.name`,
    org.params,
  ).map((p) => {
    const byState = stats.get(p.id) ?? {};
    const count = (s) => byState[s]?.n ?? 0;
    const inPlay = PIPELINE_STATES.filter((s) => s !== 'ACTIVE').reduce((sum, s) => sum + count(s), 0);
    const active = count('ACTIVE');
    const lost = count('LOST');

    return {
      ...p,
      pitch_points: parse(p.pitch_points),
      objections: parse(p.objections),
      in_play: inPlay,
      active,
      lost,
      // Won over everything that reached a decision. Cards nobody has touched
      // are not failures and would drag every number toward zero.
      conversion_pct: (active + lost) ? Math.round((active / (active + lost)) * 100) : null,
      open_value: PIPELINE_STATES.filter((s) => s !== 'ACTIVE')
        .reduce((sum, s) => sum + (byState[s]?.value ?? 0), 0),
      won_value: byState.ACTIVE?.value ?? 0,
    };
  });

  res.json({
    products,
    categories: [...new Set(products.map((p) => p.category).filter(Boolean))],
  });
});

/* ---------------------------------------------------------------- a desk */

router.get('/:id', (req, res) => {
  const org = orgScope(req.user, 'pt', activeOrg(req));
  const product = one(
    `SELECT pt.* FROM product_types pt WHERE pt.id = ? AND ${org.sql}`,
    [req.params.id, ...org.params],
  );
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const scope = leadScope(req.user, 'l', activeOrg(req));
  const params = [product.id, ...scope.params];

  const byState = new Map(all(
    `SELECT pc.state, COUNT(*) AS n, COALESCE(SUM(pc.value), 0) AS value
       FROM product_cards pc
       JOIN leads l ON l.id = pc.lead_id
      WHERE pc.product_type_id = ? AND l.deleted_at IS NULL AND ${scope.sql}
      GROUP BY pc.state`,
    params,
  ).map((r) => [r.state, r]));

  /* Cumulative, so the funnel can only narrow. A raw per-stage count produces a
     shape that goes up and down, which is not a funnel and reads as a bug. */
  const order = PIPELINE_STATES;
  const funnel = order.map((code, i) => ({
    label: code.replace(/_/g, ' ').toLowerCase(),
    code,
    value: order.slice(i).reduce((sum, s) => sum + (byState.get(s)?.n ?? 0), 0),
  }));

  const stalled = all(
    `SELECT pc.id, pc.state, pc.value, l.id AS lead_id, l.name AS lead_name,
            CAST(julianday('now') - julianday(pc.last_state_at) AS INTEGER) AS days_in_state,
            u.name AS owner_name
       FROM product_cards pc
       JOIN leads l ON l.id = pc.lead_id
       LEFT JOIN users u ON u.id = l.owner_id
      WHERE pc.product_type_id = ? AND l.deleted_at IS NULL AND ${scope.sql}
        AND pc.state IN (${PIPELINE_STATES.filter((s) => s !== 'ACTIVE').map(() => '?').join(',')})
        AND julianday('now') - julianday(pc.last_state_at) > 14
      ORDER BY days_in_state DESC
      LIMIT 25`,
    [product.id, ...scope.params, ...PIPELINE_STATES.filter((s) => s !== 'ACTIVE')],
  );

  res.json({
    ...product,
    pitch_points: parse(product.pitch_points),
    objections: parse(product.objections),
    funnel,
    states: [...PIPELINE_STATES, ...TERMINAL_STATES].map((code) => ({
      code,
      label: code.replace(/_/g, ' ').toLowerCase(),
      colour: CARD_COLOUR[code] || 'grey',
      count: byState.get(code)?.n ?? 0,
      value: byState.get(code)?.value ?? 0,
    })),
    // The list a Product RM opens this page to find: what has stopped moving.
    stalled,
  });
});

export default router;
