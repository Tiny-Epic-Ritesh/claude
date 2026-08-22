/**
 * Lead metrics — signals and score, computed rather than stamped.
 *
 * WHAT THIS REPLACES
 * ------------------
 * `applyScore()` did `UPDATE leads SET score = score + ?` on every activity.
 * That is the same shape as the legacy tenant's `Activity Score` automation at
 * **8,023,974 lifetime triggers**, and the same shape as `mx_ConnectedAttempts`,
 * `mx_WhatsApp_Count` and the rest of the counters the audit lists under
 * "should be computed aggregates over the timeline" (Part 2.3).
 *
 * The specific harm of an incrementing counter is that it is the only record of
 * its own derivation. Retune a weight and every historical value is silently
 * wrong, with no way to recompute and no way to tell which values predate the
 * change. That is unrecoverable, which is why the audit puts it near the top.
 *
 * WHAT IS HERE INSTEAD
 * --------------------
 *   SIGNALS   four things a supervisor can argue with — how long since we
 *             spoke, how often they pick up, how much they hold, how much
 *             they could hold. Each is a plain aggregate over the timeline.
 *
 *   SCORE     one number built from those signals, for sorting and
 *             leaderboards. The formula lives in `score_models` as versioned
 *             data, so a reweighting is a new version rather than a silent
 *             rewrite, and any historical score can be reproduced by replaying
 *             the model it was computed under.
 *
 * Nothing here increments. `rebuild()` over the whole book must produce exactly
 * what incremental updates produced, because there are no incremental updates.
 */

import { all, one, run, transact } from '../db.js';

/* -------------------------------------------------------- score model */

/**
 * The default weighting, as data.
 *
 * Every component is capped, so no single signal can dominate, and the caps sum
 * to 100 — which makes "62" mean something a supervisor can decompose rather
 * than an unbounded tally that only compares to other tallies.
 *
 * These numbers are a starting point and should be argued with. That is the
 * point of them being data: the argument ends in a new version, not a code
 * change and a silent migration.
 */
export const DEFAULT_MODEL = {
  version: 1,
  name: 'Balanced v1',
  description: 'Recency and engagement lead; breadth and headroom follow.',
  weights: {
    // Recency — how long since anyone spoke to them. Decays to zero at 60 days.
    recency: { max: 30, zero_at_days: 60 },
    // Engagement — of the calls we placed, how many connected.
    engagement: { max: 25, min_attempts: 2 },
    // Breadth — products already held. Diminishing after four.
    breadth: { max: 20, per_product: 5 },
    // Headroom — products they could still take. This is upside, not achievement.
    headroom: { max: 10, per_product: 2 },
    // Progress — furthest point reached in any product journey.
    progress: {
      max: 15,
      by_state: {
        EXPLORING: 3, WARM: 6, PRODUCT_RM_ENGAGED: 9, KYC_IN_PROGRESS: 12, ACTIVE: 15,
      },
    },
  },
};

/** Load the active model, seeding the default on first use. */
export function activeModel() {
  const row = one('SELECT * FROM score_models WHERE active = 1 ORDER BY version DESC LIMIT 1');
  if (row) {
    return { ...row, weights: JSON.parse(row.weights) };
  }

  run(
    'INSERT INTO score_models (version, name, description, weights, active) VALUES (?,?,?,?,1)',
    [DEFAULT_MODEL.version, DEFAULT_MODEL.name, DEFAULT_MODEL.description, JSON.stringify(DEFAULT_MODEL.weights)],
  );
  return { ...DEFAULT_MODEL, id: 1 };
}

/* ------------------------------------------------------------ signals */

/**
 * The raw aggregates, in one query per lead.
 *
 * Written as correlated subqueries rather than joins so the same SQL can be
 * used for one lead or for the whole book without changing shape.
 */
const SIGNAL_SQL = `
  SELECT
    l.id AS lead_id,
    l.sales_org,

    COALESCE(CAST(julianday('now') - julianday((
      SELECT MAX(created_at) FROM activities a
      WHERE a.lead_id = l.id AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
    )) AS INTEGER), 9999) AS days_since_contact,

    (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id AND a.type = 'Call') AS call_attempts,
    (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id AND a.outcome = 'Connected') AS call_connects,
    (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id) AS activity_count,

    (SELECT COUNT(*) FROM product_cards pc
      WHERE pc.lead_id = l.id AND pc.state = 'ACTIVE') AS products_held,

    (SELECT COUNT(*) FROM product_types pt
      WHERE pt.active = 1 AND pt.sales_org = l.sales_org
        AND NOT EXISTS (
          SELECT 1 FROM product_cards pc
          WHERE pc.lead_id = l.id AND pc.product_type_id = pt.id AND pc.state = 'ACTIVE'
        )) AS untapped_products,

    (SELECT COUNT(*) FROM tickets t
      WHERE t.lead_id = l.id AND t.status NOT IN ('Resolved','Closed')) AS open_cases,

    -- AUM is the sum of what they actually hold. Previously stamped by a nightly
    -- sweep; now derived, so it can never disagree with the cards it comes from.
    (SELECT COALESCE(SUM(pc.value), 0) FROM product_cards pc
      WHERE pc.lead_id = l.id AND pc.state = 'ACTIVE') AS aum,

    -- Furthest state reached in any product, as a rank we can map to points.
    (SELECT MAX(CASE pc.state
        WHEN 'ACTIVE' THEN 5 WHEN 'KYC_IN_PROGRESS' THEN 4
        WHEN 'PRODUCT_RM_ENGAGED' THEN 3 WHEN 'WARM' THEN 2
        WHEN 'EXPLORING' THEN 1 ELSE 0 END)
      FROM product_cards pc WHERE pc.lead_id = l.id) AS furthest_rank
  FROM leads l
`;

const RANK_STATE = { 5: 'ACTIVE', 4: 'KYC_IN_PROGRESS', 3: 'PRODUCT_RM_ENGAGED', 2: 'WARM', 1: 'EXPLORING' };

/** Signals for one lead, or for every lead when `leadId` is null. */
export function signals(leadId = null) {
  const rows = leadId
    ? all(`${SIGNAL_SQL} WHERE l.id = ?`, [leadId])
    : all(`${SIGNAL_SQL} WHERE l.deleted_at IS NULL`);

  return rows.map((r) => ({
    ...r,
    connect_rate: r.call_attempts > 0 ? Math.round((r.call_connects / r.call_attempts) * 100) : null,
    furthest_state: RANK_STATE[r.furthest_rank] ?? null,
  }));
}

/* -------------------------------------------------------------- score */

/**
 * Score one signal set under a model.
 *
 * Returns the components as well as the total, because the whole reason for
 * having a model is that somebody can ask "why 62?" and get an answer.
 */
export function scoreFrom(sig, model) {
  const w = model.weights;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));

  // Recency: full marks today, nothing at all after the decay window.
  const recency = sig.days_since_contact >= w.recency.zero_at_days
    ? 0
    : clamp(Math.round(w.recency.max * (1 - sig.days_since_contact / w.recency.zero_at_days)), w.recency.max);

  // Engagement: unknown until there is enough evidence. One answered call out
  // of one is not a 100% connect rate in any useful sense.
  const engagement = (sig.call_attempts ?? 0) < w.engagement.min_attempts
    ? 0
    : clamp(Math.round(w.engagement.max * ((sig.connect_rate ?? 0) / 100)), w.engagement.max);

  const breadth = clamp((sig.products_held ?? 0) * w.breadth.per_product, w.breadth.max);
  const headroom = clamp((sig.untapped_products ?? 0) * w.headroom.per_product, w.headroom.max);
  const progress = clamp(w.progress.by_state[sig.furthest_state] ?? 0, w.progress.max);

  const components = { recency, engagement, breadth, headroom, progress };
  return {
    score: Object.values(components).reduce((a, b) => a + b, 0),
    components,
  };
}

/**
 * Explain a score in words. Used on the lead page and in the API, so the number
 * is never presented without its reasoning.
 */
export function explainScore(sig, model) {
  const { score, components } = scoreFrom(sig, model);

  const reasons = [
    components.recency === 0
      ? `No contact for ${sig.days_since_contact >= 9999 ? 'ever' : `${sig.days_since_contact} days`} — no recency points`
      : `Spoke ${sig.days_since_contact} day${sig.days_since_contact === 1 ? '' : 's'} ago (+${components.recency})`,
    (sig.call_attempts ?? 0) < model.weights.engagement.min_attempts
      ? 'Too few calls to judge reachability yet'
      : `Connects on ${sig.connect_rate}% of calls (+${components.engagement})`,
    sig.products_held > 0
      ? `Holds ${sig.products_held} product${sig.products_held === 1 ? '' : 's'} (+${components.breadth})`
      : 'Holds no products yet',
    `${sig.untapped_products} product${sig.untapped_products === 1 ? '' : 's'} still untapped (+${components.headroom})`,
    sig.furthest_state
      ? `Furthest point reached: ${sig.furthest_state} (+${components.progress})`
      : 'No product engaged yet',
  ];

  return { score, components, reasons, model: { version: model.version, name: model.name } };
}

/* ------------------------------------------------------------ rebuild */

/**
 * Recompute and cache. This is the only writer of `lead_metrics`.
 *
 * Called for one lead after an activity, and for the whole book on a sweep or
 * after a model change. Because it is a full recomputation either way, the two
 * paths cannot drift — which is precisely what an incremental counter cannot
 * promise.
 */
export function rebuild(leadId = null) {
  const model = activeModel();
  const rows = signals(leadId);

  // One transaction for the whole batch. A full rebuild writes a row per lead,
  // and at one commit each that is one disk flush per lead.
  return transact(() => {
    for (const sig of rows) {
    const { score, components } = scoreFrom(sig, model);
    run(
      `INSERT INTO lead_metrics
         (lead_id, days_since_contact, call_attempts, call_connects, connect_rate,
          activity_count, products_held, untapped_products, open_cases, aum,
          furthest_state, score, score_components, score_model_version, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(lead_id) DO UPDATE SET
         days_since_contact = excluded.days_since_contact,
         call_attempts = excluded.call_attempts, call_connects = excluded.call_connects,
         connect_rate = excluded.connect_rate, activity_count = excluded.activity_count,
         products_held = excluded.products_held, untapped_products = excluded.untapped_products,
         open_cases = excluded.open_cases, aum = excluded.aum,
         furthest_state = excluded.furthest_state, score = excluded.score,
         score_components = excluded.score_components,
         score_model_version = excluded.score_model_version,
         computed_at = excluded.computed_at`,
      [
        sig.lead_id, sig.days_since_contact, sig.call_attempts, sig.call_connects,
        sig.connect_rate, sig.activity_count, sig.products_held, sig.untapped_products,
        sig.open_cases, sig.aum, sig.furthest_state, score,
          JSON.stringify(components), model.version,
        ],
      );
    }
    return rows.length;
  });
}

/** Metrics for one lead, computing them first if they have never been built. */
export function metricsFor(leadId) {
  let row = one('SELECT * FROM lead_metrics WHERE lead_id = ?', [leadId]);
  if (!row) {
    rebuild(leadId);
    row = one('SELECT * FROM lead_metrics WHERE lead_id = ?', [leadId]);
  }
  if (!row) return null;

  return {
    ...row,
    score_components: row.score_components ? JSON.parse(row.score_components) : null,
  };
}

/**
 * The staleness sweep.
 *
 * Recency decays with the calendar, so a lead nobody touches still changes
 * score overnight. Rebuilding everything on a schedule is what keeps a
 * derived value honest without anyone having to remember to refresh it.
 */
export function sweepMetrics() {
  const n = rebuild(null);
  return { rebuilt: n };
}
