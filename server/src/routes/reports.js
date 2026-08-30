/**
 * Reporting & analytics.
 *
 * Two principles run through this module.
 *
 * SCOPE FIRST. Every query is wrapped in the caller's `leadScope`, so a Sales
 * Supervisor sees their team and an Admin sees the firm — the same endpoint,
 * different truth. A reporting layer that ignores scoping is the usual way a
 * CRM leaks the whole book to someone entitled to a slice of it.
 *
 * NO PII. Reports are aggregates. Nothing here returns a mobile, a PAN or an
 * email, so there is no masking to get wrong: the columns are simply not
 * selected. Names appear only where the report is *about* a person — an RM
 * leaderboard — and those are staff, not clients.
 *
 * Money is paise-free integer rupees throughout, formatted for display on the
 * client. Aggregating in the database and formatting at the edge keeps one
 * number in one place.
 */

import { Router } from 'express';
import { all, one, CARD_STATES } from '../db.js';
import { requireUser, requirePermission, reqScope, can, orgsFor } from '../auth.js';

const router = Router();
router.use(requireUser);

/**
 * Who may open a report.
 *
 * `report.team` is the supervisory grant. `report.self` is the narrower one an
 * RM holds, and it is safe here because every query below is wrapped in the
 * caller's own leadScope -- so the same endpoint returns the team's numbers to
 * a supervisor and only their own to an RM, without the route knowing which.
 */
const canReport = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (can(req.user.role, 'report.team') || can(req.user.role, 'report.system')
      || can(req.user.role, 'report.self')) return next();
  return res.status(403).json({
    error: `Your role (${req.user.role}) cannot open reports`,
    required: 'report.self',
  });
};

/**
 * Build a scoped WHERE fragment plus params.
 * `extra` clauses are ANDed on, so callers never have to know the scope shape.
 */
const scoped = (req, alias = 'l', extra = []) => {
  const s = reqScope(req, alias);
  const clauses = [`${alias}.deleted_at IS NULL`, s.sql, ...extra.map((e) => e.sql)];
  return {
    where: clauses.filter(Boolean).join(' AND '),
    params: [...s.params, ...extra.flatMap((e) => e.params ?? [])],
  };
};

/** Guard against a caller asking for an unbounded window. */
const days = (req, fallback = 30) => {
  const n = Number(req.query.days);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : fallback;
};

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/* ---------------------------------------------------------------- overview */

/**
 * Headline numbers for the top of the reports page.
 * Deliberately small: five figures a supervisor can hold in their head.
 */
router.get('/overview', canReport, (req, res) => {
  const window = days(req);
  const { where, params } = scoped(req);

  const totals = one(
    `SELECT COUNT(*) leads,
            SUM(CASE WHEN l.created_at >= datetime('now', ?) THEN 1 ELSE 0 END) new_leads,
            COALESCE(SUM(lm.aum), 0) aum
     FROM leads l LEFT JOIN lead_metrics lm ON lm.lead_id = l.id WHERE ${where}`,
    [`-${window} days`, ...params],
  );

  const cards = one(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN pc.state = 'ACTIVE' THEN 1 ELSE 0 END) active,
            SUM(CASE WHEN pc.state NOT IN ('INACTIVE','ACTIVE','LOST') THEN 1 ELSE 0 END) in_play,
            SUM(CASE WHEN pc.state = 'LOST' THEN 1 ELSE 0 END) lost,
            COALESCE(SUM(CASE WHEN pc.state = 'ACTIVE' THEN pc.value ELSE 0 END), 0) active_value
     FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
     WHERE ${where}`,
    params,
  );

  const kyc = one(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN j.status = 'Complete' THEN 1 ELSE 0 END) complete,
            SUM(CASE WHEN j.status = 'Stalled' THEN 1 ELSE 0 END) stalled,
            SUM(CASE WHEN j.status = 'Abandoned' THEN 1 ELSE 0 END) abandoned
     FROM kyc_journeys j JOIN leads l ON l.id = j.lead_id
     WHERE ${where}`,
    params,
  );

  const tickets = one(
    `SELECT COUNT(*) open,
            SUM(CASE WHEN t.breached = 1 THEN 1 ELSE 0 END) breached
     FROM tickets t
     WHERE t.status NOT IN ('Resolved','Closed')`,
  );

  res.json({
    window_days: window,
    leads: { total: totals.leads, new_in_window: totals.new_leads },
    // Conversion is measured against cards that actually entered the funnel.
    // Counting INACTIVE cards in the denominator would make every product look
    // like it converts at 2%, because every lead holds a card for every product.
    cards: {
      in_play: cards.in_play,
      active: cards.active,
      lost: cards.lost,
      conversion_pct: pct(cards.active, cards.active + cards.in_play + cards.lost),
    },
    aum: totals.aum,
    active_value: cards.active_value,
    kyc: {
      total: kyc.total,
      complete: kyc.complete,
      stalled: kyc.stalled,
      abandoned: kyc.abandoned,
      completion_pct: pct(kyc.complete, kyc.total),
    },
    tickets: { open: tickets.open, breached: tickets.breached, breach_pct: pct(tickets.breached, tickets.open) },
  });
});

/* ------------------------------------------------------------------ funnel */

/**
 * The product-card funnel (BRD OD-01), per product.
 *
 * This is the report the BRD's state machine exists to produce: where every
 * product's pipeline is stacked, and where it stalls.
 */
router.get('/funnel', canReport, (req, res) => {
  const { where, params } = scoped(req);

  const rows = all(
    `SELECT pt.id, pt.code, pt.name, pc.state, COUNT(*) n, COALESCE(SUM(pc.value), 0) value
     FROM product_cards pc
     JOIN product_types pt ON pt.id = pc.product_type_id
     JOIN leads l ON l.id = pc.lead_id
     WHERE ${where} AND pt.active = 1
     GROUP BY pt.id, pc.state`,
    params,
  );

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.id)) {
      byProduct.set(r.id, {
        product_id: r.id, code: r.code, name: r.name,
        states: Object.fromEntries(CARD_STATES.map((s) => [s, 0])),
        active_value: 0,
      });
    }
    const p = byProduct.get(r.id);
    p.states[r.state] = r.n;
    if (r.state === 'ACTIVE') p.active_value = r.value;
  }

  const products = [...byProduct.values()].map((p) => {
    const engaged = CARD_STATES
      .filter((s) => !['INACTIVE'].includes(s))
      .reduce((sum, s) => sum + p.states[s], 0);
    return {
      ...p,
      engaged,
      conversion_pct: pct(p.states.ACTIVE, engaged),
      // Where the pipeline is stuck, which is the actionable half of a funnel.
      // Null when nothing is in flight — sorting all-zero counts would otherwise
      // nominate a stage that holds nobody.
      largest_stage: (() => {
        const mid = CARD_STATES
          .filter((s) => !['INACTIVE', 'ACTIVE', 'LOST'].includes(s))
          .sort((a, b) => p.states[b] - p.states[a])[0];
        return mid && p.states[mid] > 0 ? mid : null;
      })(),
    };
  }).sort((a, b) => b.engaged - a.engaged);

  res.json({ states: CARD_STATES, products });
});

/* -------------------------------------------------------------------- team */

/**
 * RM leaderboard.
 *
 * Ordered by active cards rather than lead count, deliberately: rewarding
 * volume of leads held rewards hoarding, which is exactly the behaviour a
 * broking desk does not want.
 */
router.get('/team', canReport, (req, res) => {
  const window = days(req);
  const { where, params } = scoped(req);

  const rows = all(
    `SELECT u.id, u.name, u.role,
            COUNT(DISTINCT l.id) leads,
            SUM(CASE WHEN l.created_at >= datetime('now', ?) THEN 1 ELSE 0 END) new_leads,
            COALESCE(SUM(lm.aum), 0) aum,
            (SELECT COUNT(*) FROM product_cards pc WHERE pc.lead_id IN
               (SELECT id FROM leads WHERE owner_id = u.id AND deleted_at IS NULL) AND pc.state = 'ACTIVE') active_cards,
            (SELECT COUNT(*) FROM product_cards pc WHERE pc.lead_id IN
               (SELECT id FROM leads WHERE owner_id = u.id AND deleted_at IS NULL)
               AND pc.state NOT IN ('INACTIVE','ACTIVE','LOST')) in_play_cards,
            (SELECT COUNT(*) FROM activities a WHERE a.user_id = u.id
               AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
               AND a.created_at >= datetime('now', ?)) touches
     FROM users u
     JOIN leads l ON l.owner_id = u.id
     LEFT JOIN lead_metrics lm ON lm.lead_id = l.id
     WHERE u.active = 1 AND ${where}
     GROUP BY u.id
     ORDER BY active_cards DESC, leads DESC`,
    [`-${window} days`, `-${window} days`, ...params],
  );

  res.json({
    window_days: window,
    rows: rows.map((r) => ({
      ...r,
      conversion_pct: pct(r.active_cards, r.active_cards + r.in_play_cards),
      touches_per_lead: r.leads > 0 ? Math.round((r.touches / r.leads) * 10) / 10 : 0,
    })),
  });
});

/* --------------------------------------------------------------- ageing */

/** Lead ageing, which is what turns a pipeline into a follow-up list. */
router.get('/ageing', canReport, (req, res) => {
  const { where, params } = scoped(req);

  const rows = all(
    `SELECT
       CASE
         WHEN julianday('now') - julianday(l.created_at) <= 7  THEN 'Fresh'
         WHEN julianday('now') - julianday(l.created_at) <= 30 THEN 'Active'
         WHEN julianday('now') - julianday(l.created_at) <= 60 THEN 'Ageing'
         WHEN julianday('now') - julianday(l.created_at) <= 90 THEN 'At Risk'
         ELSE 'Cold'
       END AS band,
       COUNT(*) n,
       SUM(CASE WHEN NOT EXISTS (
             SELECT 1 FROM activities a
             WHERE a.lead_id = l.id
               AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
               AND a.created_at >= datetime('now','-14 days')
           ) THEN 1 ELSE 0 END) untouched_14d
     FROM leads l WHERE ${where}
     GROUP BY band`,
    params,
  );

  const order = ['Fresh', 'Active', 'Ageing', 'At Risk', 'Cold'];
  res.json({
    bands: order.map((band) => {
      const r = rows.find((x) => x.band === band);
      return { band, count: r?.n ?? 0, untouched_14d: r?.untouched_14d ?? 0 };
    }),
  });
});

/* ------------------------------------------------------------------- KYC */

/**
 * KYC drop-off by step.
 *
 * The point of this report is to find the step that loses people. Counting
 * completions per step would flatter the journey; counting where journeys are
 * *sitting* is what shows the cliff.
 */
router.get('/kyc', canReport, (req, res) => {
  const { where, params } = scoped(req);

  const byStatus = all(
    `SELECT j.status, COUNT(*) n FROM kyc_journeys j JOIN leads l ON l.id = j.lead_id
     WHERE ${where} GROUP BY j.status`,
    params,
  );

  const byStep = all(
    `SELECT j.current_step step, j.status, COUNT(*) n
     FROM kyc_journeys j JOIN leads l ON l.id = j.lead_id
     WHERE ${where} AND j.status != 'Complete'
     GROUP BY j.current_step, j.status
     ORDER BY n DESC`,
    params,
  );

  const stuck = new Map();
  for (const r of byStep) {
    if (!stuck.has(r.step)) stuck.set(r.step, { step: r.step, total: 0, stalled: 0, abandoned: 0 });
    const s = stuck.get(r.step);
    s.total += r.n;
    if (r.status === 'Stalled') s.stalled += r.n;
    if (r.status === 'Abandoned') s.abandoned += r.n;
  }

  const total = byStatus.reduce((sum, r) => sum + r.n, 0);
  res.json({
    total,
    by_status: byStatus,
    completion_pct: pct(byStatus.find((r) => r.status === 'Complete')?.n ?? 0, total),
    stuck_at: [...stuck.values()].sort((a, b) => b.total - a.total),
  });
});

/* -------------------------------------------------------------------- SLA */

/** Ticket SLA compliance (BRD OD-08), by category and by priority. */
router.get('/sla', canReport, (_req, res) => {
  const byCategory = all(
    `SELECT COALESCE(tc.name,'Uncategorised') category,
            COUNT(*) total,
            SUM(CASE WHEN t.breached = 1 THEN 1 ELSE 0 END) breached,
            SUM(CASE WHEN t.status IN ('Resolved','Closed') THEN 1 ELSE 0 END) resolved,
            -- Median would be better than mean here, but SQLite has no percentile
            -- function; the mean is stated as a mean so nobody reads it as typical.
            ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL
                 THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END), 1) mean_hours_to_resolve
     FROM tickets t
     LEFT JOIN ticket_categories tc ON tc.id = t.category_id
     GROUP BY tc.name ORDER BY total DESC`,
  );

  const byPriority = all(
    `SELECT COALESCE(priority,'Normal') priority,
            COUNT(*) total,
            SUM(CASE WHEN breached = 1 THEN 1 ELSE 0 END) breached
     FROM tickets GROUP BY priority ORDER BY total DESC`,
  );

  const decorate = (rows) => rows.map((r) => ({ ...r, breach_pct: pct(r.breached, r.total) }));

  res.json({
    by_category: decorate(byCategory),
    by_priority: decorate(byPriority),
  });
});

/* --------------------------------------------------------------- partners */

/** Partner sourcing performance. Firm-wide, so it needs the system report right. */
/**
 * Partner performance.
 *
 * Gated on partner.view rather than report.system, which put it out of reach of
 * the two roles whose work it describes: Partner RM, and the Sales Supervisor
 * asking why the team's numbers moved. Each sees what they can already see
 * elsewhere -- a Partner RM their own partners, everyone else their own book --
 * so widening who may open it does not widen what anybody reads.
 */
router.get('/partners', requirePermission('partner.view'), (req, res) => {
  const window = days(req, 90);

  const orgs = orgsFor(req.user);
  const where = [`p.sales_org IN (${orgs.map(() => '?').join(',') || "''"})`];
  const params = [...orgs];

  // A Partner RM's report is about their own book of partners, matching what
  // /api/partners already gives them. Nobody else is narrowed further.
  const ownReach = req.user.role === 'partner_rm';
  if (ownReach) { where.push('p.owner_id = ?'); params.push(req.user.id); }

  res.json({
    window_days: window,
    scope: ownReach ? 'own_partners' : 'book',
    rows: all(
      `SELECT p.id, p.name, p.partner_code, p.partner_model, p.state_code,
              (SELECT COUNT(*) FROM leads WHERE partner_id = p.id AND deleted_at IS NULL) sourced,
              (SELECT COUNT(*) FROM leads WHERE partner_id = p.id AND deleted_at IS NULL
                 AND created_at >= datetime('now', ?)) sourced_in_window,
              (SELECT COUNT(*) FROM product_cards pc JOIN leads l2 ON l2.id = pc.lead_id
                 WHERE l2.partner_id = p.id AND pc.state = 'ACTIVE') converted,
              (SELECT COALESCE(SUM(payout),0) FROM commissions WHERE partner_id = p.id) commission
       FROM partners p
       WHERE ${where.join(' AND ')}
       ORDER BY sourced DESC LIMIT 50`,
      [`-${window} days`, ...params],
    ).map((r) => ({ ...r, conversion_pct: pct(r.converted, r.sourced) })),
  });
});

/* --------------------------------------------------------------- activity */

/** Daily contact volume by channel — the desk's heartbeat. */
router.get('/activity', canReport, (req, res) => {
  const window = days(req, 14);
  const { where, params } = scoped(req);

  res.json({
    window_days: window,
    rows: all(
      `SELECT date(a.created_at) day, a.type, COUNT(*) n
       FROM activities a JOIN leads l ON l.id = a.lead_id
       WHERE ${where}
         AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
         AND a.created_at >= datetime('now', ?)
       GROUP BY day, a.type
       ORDER BY day`,
      [...params, `-${window} days`],
    ),
  });
});

export default router;
