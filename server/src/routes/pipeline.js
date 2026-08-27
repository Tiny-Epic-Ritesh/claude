/**
 * Pipeline (BUG-20).
 *
 * The tab was empty because nothing served it — there was no /api/pipeline at
 * all, and the SPA fallback answered the client's fetch with index.html, so the
 * page rendered nothing and looked broken rather than unbuilt.
 *
 * What a pipeline means here is a decision, so it is worth stating. In a broking
 * CRM the thing that moves and carries money is the **product card**, not the
 * lead: one lead may be Won on equity and still Exploring on mutual funds, and a
 * single lead-level stage cannot represent that. So the pipeline is the card
 * board — every product opportunity, by state, with its value.
 *
 * That is also non-negotiable #9: one pipeline with record types, rather than a
 * pipeline per product. The legacy tenant has 35 opportunity pipelines
 * (docs/legacy-leadsquared/opportunities.md), which is what pipeline sprawl
 * looks like after five years — most of them differing only by a filter.
 */

import { Router } from 'express';
import { all, one } from '../db.js';
import { requireUser, leadScope, activeOrg } from '../auth.js';
import { maskRecords } from '../security.js';
import { maskedFieldsFor } from '../engine/masking.js';
import { CARD_STATES, CARD_COLOUR } from '../db.js';

const router = Router();
router.use(requireUser);

/**
 * The columns, in the order work actually moves.
 *
 * INACTIVE is excluded: a card exists for every product on every lead from the
 * moment the lead is created, so INACTIVE is the resting state of the entire
 * catalogue rather than a stage anyone works. Including it would put tens of
 * thousands of untouched cards in the first column and bury the real pipeline.
 */
export const PIPELINE_STATES = [
  'EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED', 'KYC_IN_PROGRESS', 'ACTIVE',
];

/** Shown separately, because they are outcomes rather than steps. */
export const TERMINAL_STATES = ['ON_HOLD', 'LOST'];

const STATE_LABEL = {
  EXPLORING: 'Exploring',
  WARM: 'Warm',
  PRODUCT_RM_ENGAGED: 'Product RM engaged',
  KYC_IN_PROGRESS: 'KYC in progress',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  LOST: 'Lost',
  INACTIVE: 'Not started',
};

router.get('/meta', (_req, res) => res.json({
  states: [...PIPELINE_STATES, ...TERMINAL_STATES].map((code) => ({
    code, label: STATE_LABEL[code], colour: CARD_COLOUR[code] || 'grey',
    terminal: TERMINAL_STATES.includes(code),
  })),
  all_states: CARD_STATES,
}));

/**
 * The board.
 *
 * Set-based, like the lead list: one aggregate query for the column headers and
 * one page query for the cards. The naive shape — a query per column — is six
 * round trips that get slower as the business grows, and the lead list already
 * taught this codebase that lesson at 1,150 queries a page.
 */
router.get('/', (req, res) => {
  const scope = leadScope(req.user, 'l', activeOrg(req));
  const where = [
    'l.deleted_at IS NULL',
    scope.sql,
    `pc.state IN (${[...PIPELINE_STATES, ...TERMINAL_STATES].map(() => '?').join(',')})`,
  ];
  const params = [...scope.params, ...PIPELINE_STATES, ...TERMINAL_STATES];

  const { product_id: productId, owner_id: ownerId, q } = req.query;
  if (productId) { where.push('pc.product_type_id = ?'); params.push(productId); }
  if (ownerId) { where.push('l.owner_id = ?'); params.push(ownerId); }
  if (q) { where.push('l.name LIKE ?'); params.push(`%${q}%`); }

  const clause = where.join(' AND ');

  // Column totals over the whole pipeline, not just the page — otherwise the
  // header count would describe the sample rather than the book.
  const totals = all(
    `SELECT pc.state, COUNT(*) AS n, COALESCE(SUM(pc.value), 0) AS value
       FROM product_cards pc
       JOIN leads l ON l.id = pc.lead_id
      WHERE ${clause}
      GROUP BY pc.state`,
    params,
  );
  const byState = new Map(totals.map((t) => [t.state, t]));

  // Cards per column are capped: a column with four thousand entries is not a
  // board anyone scrolls, and the count in the header already tells the truth.
  const perColumn = Math.min(Math.max(Number(req.query.per_column) || 50, 1), 200);

  const cards = all(
    `SELECT * FROM (
       SELECT pc.id, pc.state, pc.value, pc.last_state_at, pc.lead_id,
              pt.name AS product_name, pt.code AS product_code,
              l.name AS lead_name, l.mobile, l.sales_org, l.stage AS lead_stage,
              u.name AS owner_name,
              rm.name AS product_rm_name,
              CAST(julianday('now') - julianday(pc.last_state_at) AS INTEGER) AS days_in_state,
              ROW_NUMBER() OVER (PARTITION BY pc.state ORDER BY pc.last_state_at DESC) AS rn
         FROM product_cards pc
         JOIN leads l ON l.id = pc.lead_id
         JOIN product_types pt ON pt.id = pc.product_type_id
         LEFT JOIN users u ON u.id = l.owner_id
         LEFT JOIN users rm ON rm.id = pc.product_rm_id
        WHERE ${clause}
     ) WHERE rn <= ?`,
    [...params, perColumn],
  );

  const grouped = new Map();
  for (const c of maskRecords(cards, { unmask: false, fields: maskedFieldsFor(req.user.role) })) {
    if (!grouped.has(c.state)) grouped.set(c.state, []);
    grouped.get(c.state).push(c);
  }

  const column = (code) => ({
    code,
    label: STATE_LABEL[code],
    colour: CARD_COLOUR[code] || 'grey',
    terminal: TERMINAL_STATES.includes(code),
    count: byState.get(code)?.n ?? 0,
    value: byState.get(code)?.value ?? 0,
    cards: grouped.get(code) ?? [],
  });

  const columns = PIPELINE_STATES.map(column);
  const terminal = TERMINAL_STATES.map(column);

  res.json({
    columns,
    terminal,
    // The headline is open pipeline value: what is in play, excluding what has
    // already converted or been lost.
    open_value: columns
      .filter((c) => c.code !== 'ACTIVE')
      .reduce((s, c) => s + c.value, 0),
    won_value: byState.get('ACTIVE')?.value ?? 0,
    total_cards: columns.reduce((s, c) => s + c.count, 0),
    products: all(
      `SELECT DISTINCT pt.id, pt.name FROM product_types pt
        WHERE pt.active = 1 ORDER BY pt.sort_order`,
    ),
  });
});

export default router;
