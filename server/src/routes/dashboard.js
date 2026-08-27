/**
 * The Dashboard (ENH-24).
 *
 * Every figure here is computed under the caller's own scope, so a number can
 * never describe records the person could not open. That is not only a privacy
 * rule — it is what makes the tiles clickable. A tile that drills through to a
 * list showing fewer rows than the tile claimed is a tile nobody trusts twice.
 *
 * Tiles carry a destination rather than the client inferring one, for the same
 * reason the cockpit's actions do: the server knows what a figure counted, and
 * the client should not have to guess the filter that reproduces it.
 *
 * The per-role tile sets are the ones confirmed in
 * docs/RECOMMENDATIONS-ROUND-1.md. The bolded ones there — leads unattended,
 * dormant accounts, SLA breaches, cards untouched — are the "something is wrong
 * and nobody has noticed yet" figures, and they are why the tiles are ordered
 * the way they are rather than alphabetically or by magnitude.
 */

import { Router } from 'express';
import { all, one } from '../db.js';
import { requireUser, leadScope, clientScope, activeOrg, can } from '../auth.js';
import {
  RANGES, DEFAULT_RANGE, resolveRange, inRange, inPrevRange, delta,
} from '../engine/daterange.js';
import { dormantSql } from '../engine/clients.js';

const router = Router();
router.use(requireUser);

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const compact = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(0)} K`;
  return `₹${v}`;
};

/**
 * A tile.
 *
 * `alert` marks the ones that mean somebody should do something today. They are
 * toned differently and sorted first, because a dashboard where the urgent
 * figure sits fourth is a dashboard that gets skimmed.
 */
const tile = (label, value, opts = {}) => ({
  label,
  value,
  sub: opts.sub ?? null,
  to: opts.to ?? null,
  trend: opts.trend ?? null,
  tone: opts.tone ?? null,
  goodWhen: opts.goodWhen ?? 'up',
  alert: Boolean(opts.alert),
});

/* ------------------------------------------------------------ builders */

function leadTiles(req, range) {
  const scope = leadScope(req.user, 'l', activeOrg(req));
  const base = `FROM leads l WHERE l.deleted_at IS NULL AND ${scope.sql}`;
  const p = scope.params;

  const created = inRange('l.created_at', range);
  const prev = inPrevRange('l.created_at', range);

  const now = one(`SELECT COUNT(*) n ${base} AND ${created.sql}`, [...p, ...created.params]).n;
  const before = one(`SELECT COUNT(*) n ${base} AND ${prev.sql}`, [...p, ...prev.params]).n;

  const won = one(
    `SELECT COUNT(*) n ${base} AND l.stage = 'Won' AND ${created.sql}`,
    [...p, ...created.params],
  ).n;

  /**
   * Leads nobody has touched in two days.
   *
   * Deliberately not date-ranged. "Unattended" is a present-tense fact about
   * the book, and filtering it to the current month would hide exactly the
   * leads that have been ignored longest.
   */
  const unattended = one(
    `SELECT COUNT(*) n ${base}
       AND l.stage NOT IN ('Won','Lost')
       AND NOT EXISTS (
         SELECT 1 FROM activities a
          WHERE a.lead_id = l.id
            AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
            AND a.created_at > datetime('now','-2 days'))`,
    p,
  ).n;

  const overdue = one(
    `SELECT COUNT(*) n FROM tasks t
      JOIN leads l ON l.id = t.lead_id
     WHERE t.status = 'Open' AND t.due_at < datetime('now')
       AND l.deleted_at IS NULL AND ${scope.sql}`,
    p,
  ).n;

  return [
    tile('New leads', now, {
      sub: range.label, trend: delta(now, before),
      to: '/leads',
    }),
    tile('Won', won, { sub: range.label, tone: 'good', to: '/leads?stage=Won' }),
    tile('Conversion', now ? `${Math.round((won / now) * 100)}%` : '—', {
      sub: `${won} of ${now} created ${range.label.toLowerCase()}`,
    }),
    tile('Unattended over 48h', unattended, {
      sub: 'No contact logged — worth a call today',
      tone: 'warn', goodWhen: 'down', alert: unattended > 0,
      to: '/leads?band=At Risk',
    }),
    tile('Overdue follow-ups', overdue, {
      sub: 'Tasks past their due date', tone: overdue ? 'warn' : null,
      goodWhen: 'down', alert: overdue > 0, to: '/tasks',
    }),
  ];
}

function clientTiles(req, range) {
  if (!can(req.user.role, 'client.view.all') && !can(req.user.role, 'client.view.own')) return [];

  const scope = clientScope(req.user, 'c', activeOrg(req));
  const base = `FROM clients c WHERE c.deleted_at IS NULL AND ${scope.sql}`;
  const p = scope.params;

  const opened = inRange('c.activated_at', range);
  const prevOpened = inPrevRange('c.activated_at', range);

  const now = one(`SELECT COUNT(*) n ${base} AND ${opened.sql}`, [...p, ...opened.params]).n;
  const before = one(`SELECT COUNT(*) n ${base} AND ${prevOpened.sql}`, [...p, ...prevOpened.params]).n;

  const row = one(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN ${dormantSql('c')} = 'Dormant' THEN 1 ELSE 0 END) AS dormant,
           COALESCE(SUM(c.brokerage_ytd), 0) AS brokerage,
           COALESCE(SUM(c.holding_value), 0) AS holdings
    ${base}`, p);

  return [
    tile('Accounts opened', now, { sub: range.label, trend: delta(now, before), to: '/clients' }),
    // Revenue already won, quietly leaving. The single most actionable number
    // on a broking desk, and the one nobody looks at unaided.
    tile('Dormant accounts', row.dormant ?? 0, {
      sub: 'No trade in 90 days', tone: 'warn', goodWhen: 'down',
      alert: (row.dormant ?? 0) > 0, to: '/clients?dormant=true',
    }),
    tile('Brokerage YTD', compact(row.brokerage), { sub: rupees(row.brokerage) }),
    tile('Holdings', compact(row.holdings), { sub: `${row.total} account${row.total === 1 ? '' : 's'}` }),
  ];
}

function activityTiles(req, range) {
  const scope = leadScope(req.user, 'l', activeOrg(req));
  const p = scope.params;
  const logged = inRange('a.created_at', range);

  const calls = one(
    `SELECT COUNT(*) n FROM activities a
       JOIN leads l ON l.id = a.lead_id
      WHERE a.type = 'Call' AND l.deleted_at IS NULL AND ${scope.sql} AND ${logged.sql}`,
    [...p, ...logged.params],
  ).n;

  const connected = one(
    `SELECT COUNT(*) n FROM activities a
       JOIN leads l ON l.id = a.lead_id
      WHERE a.type = 'Call' AND a.outcome = 'Connected'
        AND l.deleted_at IS NULL AND ${scope.sql} AND ${logged.sql}`,
    [...p, ...logged.params],
  ).n;

  return [
    tile('Calls logged', calls, { sub: range.label, to: '/leads' }),
    tile('Connect rate', calls ? `${Math.round((connected / calls) * 100)}%` : '—', {
      sub: `${connected} connected of ${calls}`,
    }),
  ];
}

function caseTiles(req, range) {
  const orgs = activeOrg(req) ? [activeOrg(req)] : null;
  const orgSql = orgs ? 'AND t.sales_org = ?' : '';
  const orgParams = orgs || [];

  const open = one(`SELECT COUNT(*) n FROM tickets t WHERE t.status NOT IN ('Resolved','Closed') ${orgSql}`, orgParams).n;
  // `breached` is maintained by the SLA sweep; the due-date test catches
  // anything that has slipped since the sweep last ran, so the tile is right
  // between sweeps rather than up to fifteen minutes stale.
  const breached = one(
    `SELECT COUNT(*) n FROM tickets t
      WHERE t.status NOT IN ('Resolved','Closed')
        AND (t.breached = 1
             OR (t.resolution_due IS NOT NULL AND t.resolution_due < datetime('now'))) ${orgSql}`,
    orgParams,
  ).n;
  const resolved = (() => {
    const r = inRange('t.resolved_at', range);
    return one(
      `SELECT COUNT(*) n FROM tickets t WHERE t.resolved_at IS NOT NULL AND ${r.sql} ${orgSql}`,
      [...r.params, ...orgParams],
    ).n;
  })();

  return [
    tile('Open cases', open, { to: '/tickets' }),
    tile('SLA breached', breached, {
      sub: 'Past the promised response time', tone: 'warn',
      goodWhen: 'down', alert: breached > 0, to: '/tickets',
    }),
    tile('Resolved', resolved, { sub: range.label, tone: 'good', to: '/tickets' }),
  ];
}

function partnerTiles(req, range) {
  if (!can(req.user.role, 'partner.view')) return [];
  const orgs = activeOrg(req) ? [activeOrg(req)] : null;
  const orgSql = orgs ? 'AND p.sales_org = ?' : '';
  const orgParams = orgs || [];

  const active = one(`SELECT COUNT(*) n FROM partners p WHERE p.state_code = 'ACTIVE' ${orgSql}`, orgParams).n;
  const onboarding = one(`SELECT COUNT(*) n FROM partners p WHERE p.state_code = 'ONBOARDING' ${orgSql}`, orgParams).n;
  // Commission is booked to a YYYY-MM period rather than a timestamp, so the
  // range is matched on the period string. Anything finer would imply a
  // precision the data does not have.
  const commission = one(
    `SELECT COALESCE(SUM(c.payout),0) v FROM commissions c
      JOIN partners p ON p.id = c.partner_id
     WHERE c.period >= ? AND c.period <= ? ${orgSql}`,
    [range.from.slice(0, 7), range.to.slice(0, 7), ...orgParams],
  ).v;

  return [
    tile('Active partners', active, { to: '/partners' }),
    tile('Onboarding', onboarding, { sub: 'Not yet activated', to: '/partners' }),
    tile('Commission', compact(commission), { sub: range.label }),
  ];
}

/* --------------------------------------------------------------- charts */

function funnelChart(req) {
  const scope = leadScope(req.user, 'l', activeOrg(req));
  const stages = ['New', 'Contacted', 'Qualified', 'In Progress', 'Won'];
  const rows = all(
    `SELECT l.stage, COUNT(*) n FROM leads l
      WHERE l.deleted_at IS NULL AND ${scope.sql} GROUP BY l.stage`,
    scope.params,
  );
  const by = new Map(rows.map((r) => [r.stage, r.n]));
  return {
    kind: 'funnel',
    title: 'Lead funnel',
    // Cumulative, so the funnel can only narrow. A raw per-stage count produces
    // a "funnel" that goes up and down, which is the bug I fixed on the partner
    // portal and must not reappear here.
    stages: stages.map((s, i) => ({
      label: s,
      value: stages.slice(i).reduce((sum, name) => sum + (by.get(name) || 0), 0),
    })),
  };
}

function sourceChart(req, range) {
  const scope = leadScope(req.user, 'l', activeOrg(req));
  const r = inRange('l.created_at', range);
  const rows = all(
    `SELECT COALESCE(NULLIF(TRIM(l.source), ''), 'Unknown') AS label, COUNT(*) AS value
       FROM leads l
      WHERE l.deleted_at IS NULL AND ${scope.sql} AND ${r.sql}
      GROUP BY label ORDER BY value DESC LIMIT 8`,
    [...scope.params, ...r.params],
  );
  return { kind: 'bar', title: `Leads by source · ${range.label}`, data: rows };
}

function productChart(req) {
  const scope = leadScope(req.user, 'l', activeOrg(req));
  const rows = all(
    `SELECT pt.name AS label, COUNT(*) AS value
       FROM product_cards pc
       JOIN leads l ON l.id = pc.lead_id
       JOIN product_types pt ON pt.id = pc.product_type_id
      WHERE pc.state = 'ACTIVE' AND l.deleted_at IS NULL AND ${scope.sql}
      GROUP BY pt.name ORDER BY value DESC LIMIT 6`,
    scope.params,
  );
  return { kind: 'donut', title: 'Active products', data: rows };
}

/* ----------------------------------------------------------- assembly */

/**
 * Which tiles each role gets.
 *
 * Straight from the confirmed matrix. A Caller's set is deliberately the
 * shortest on the system: their screen should be almost entirely the work list,
 * and every extra tile is one more thing to scan past a hundred times a day.
 */
const LAYOUT = {
  superadmin: { tiles: ['lead', 'client', 'case', 'partner'], charts: ['funnel', 'source', 'product'] },
  admin: { tiles: ['lead', 'client', 'case', 'partner'], charts: ['funnel', 'source', 'product'] },
  sales_supervisor: { tiles: ['lead', 'client', 'activity'], charts: ['funnel', 'source'] },
  product_supervisor: { tiles: ['lead', 'client'], charts: ['funnel', 'product'] },
  sales_rm: { tiles: ['lead', 'client', 'activity'], charts: ['funnel', 'product'] },
  caller: { tiles: ['activity', 'lead'], charts: [] },
  dealer: { tiles: ['client', 'lead'], charts: ['product'] },
  partner_rm: { tiles: ['partner', 'lead'], charts: ['source'] },
  product_rm: { tiles: ['lead', 'client'], charts: ['product'] },
  customer_care: { tiles: ['case', 'client'], charts: [] },
  marketing_manager: { tiles: ['lead'], charts: ['source', 'funnel'] },
};

const TILE_BUILDERS = {
  lead: leadTiles,
  client: clientTiles,
  activity: activityTiles,
  case: caseTiles,
  partner: partnerTiles,
};

const CHART_BUILDERS = {
  funnel: (req) => funnelChart(req),
  source: (req, range) => sourceChart(req, range),
  product: (req) => productChart(req),
};

router.get('/', (req, res) => {
  const range = resolveRange(
    req.query.range || DEFAULT_RANGE,
    { from: req.query.from, to: req.query.to },
  );

  const layout = LAYOUT[req.user.role] ?? LAYOUT.sales_rm;

  const tiles = layout.tiles.flatMap((k) => {
    try { return TILE_BUILDERS[k]?.(req, range) ?? []; } catch { return []; }
  });

  const charts = layout.charts.map((k) => {
    try { return CHART_BUILDERS[k]?.(req, range) ?? null; } catch { return null; }
  }).filter(Boolean);

  res.json({
    range: {
      code: range.code, label: range.label, from: range.from, to: range.to, days: range.days,
    },
    ranges: RANGES,
    // Alerts first. A dashboard where the urgent figure sits fourth gets
    // skimmed rather than acted on.
    tiles: [...tiles].sort((a, b) => Number(b.alert) - Number(a.alert)),
    charts,
    role: req.user.role,
  });
});

export default router;
