/**
 * KRA scorecards and incentive payouts.
 *
 * Both ship with worked examples so the screens have something real to show,
 * and both are configuration — what a role is measured on, and what that earns,
 * is a business decision that gets revised, not one encoded in a deploy.
 *
 * The actuals are computed from live records wherever the data exists, which is
 * the part that makes a scorecard worth opening. A target with no way to
 * measure against it is a spreadsheet, and the business already has those.
 */

import { all, one, run, SALES_ORGS } from '../db.js';
import { leadScope, clientScope, partnerScope, can, userCan, orgsFor } from '../auth.js';
import { reportsOf } from './sharing.js';
import { csatFigure, notEnoughAnswers } from './csat.js';
import { resolveRange, inRange } from './daterange.js';

/* ------------------------------------------------------------ shipped KRA */

/**
 * The example scorecard.
 *
 * Written to be plausible for an Indian retail broking desk rather than
 * aspirational — a caller making 60 dials a day, an RM opening 8 accounts a
 * month. Every figure here is a placeholder for the real one, and the Setup
 * screen exists so the business can replace them without asking anybody.
 *
 * Weights within a role sum to 100 so the score reads as a percentage of a
 * whole. Nothing enforces that; it is simply what makes the number mean
 * something, and the screen shows the sum so a mistake is visible.
 */
export const SHIPPED_KRA = {
  caller: [
    ['calls_made', 'Calls made', 'calls_logged', 'count', 1200, 35, 'higher', 'Dials logged in the month.'],
    ['connect_rate', 'Connect rate', 'connect_rate', 'percent', 35, 25, 'higher', 'Connected calls as a share of dials.'],
    ['qualified', 'Leads qualified', 'leads_qualified', 'count', 40, 30, 'higher', 'Moved to Qualified after a conversation.'],
    ['followups_kept', 'Follow-ups kept', 'followups_kept', 'percent', 90, 10, 'higher', 'Callbacks honoured on the day promised.'],
  ],
  sales_rm: [
    ['accounts', 'Accounts opened', 'accounts_opened', 'count', 8, 35, 'higher', 'UCCs activated in the month.'],
    ['brokerage', 'Brokerage generated', 'brokerage_ytd', 'rupees', 250000, 30, 'higher', 'From the book you own.'],
    ['conversion', 'Conversion', 'conversion_pct', 'percent', 25, 20, 'higher', 'Won over everything that reached a decision.'],
    ['unattended', 'Leads left unattended', 'unattended', 'count', 5, 15, 'lower', 'No contact logged in 48 hours. Lower is better.'],
  ],
  sales_supervisor: [
    ['team_accounts', 'Team accounts opened', 'accounts_opened', 'count', 40, 40, 'higher', 'Across everyone reporting to you.'],
    ['team_brokerage', 'Team brokerage', 'brokerage_ytd', 'rupees', 1200000, 30, 'higher', 'The desk total.'],
    ['unattended', 'Unattended across the desk', 'unattended', 'count', 15, 20, 'lower', 'The number nobody owns until you ask.'],
    ['kyc_stalled', 'KYC stalled over 7 days', 'kyc_stalled', 'count', 5, 10, 'lower', 'Applications that have stopped moving.'],
  ],
  dealer: [
    ['active_clients', 'Active clients', 'active_clients', 'count', 60, 40, 'higher', 'Traded within 90 days.'],
    ['dormant', 'Dormant accounts', 'dormant', 'count', 10, 30, 'lower', 'Funded but not trading. Lower is better.'],
    ['brokerage', 'Brokerage generated', 'brokerage_ytd', 'rupees', 400000, 30, 'higher', 'From accounts you deal for.'],
  ],
  product_rm: [
    ['cards_engaged', 'Products engaged', 'cards_engaged', 'count', 25, 40, 'higher', 'Cards you have taken forward.'],
    ['product_conversion', 'Product conversion', 'conversion_pct', 'percent', 30, 40, 'higher', 'Engaged to active.'],
    ['stalled_cards', 'Cards stalled over 14 days', 'stalled_cards', 'count', 8, 20, 'lower', 'Not moved in a fortnight.'],
  ],
  /* B22 (ruled 19 Nov): each description says what is counted. They promised
     "partners who sourced something this month" and "stuck part-way through",
     and counted partners with Active status and every partner onboarding. A
     metric an Admin has edited keeps its own words (seedKra below). */
  partner_rm: [
    ['partners_active', 'Active partners', 'partners_active', 'count', 12, 35, 'higher', 'Partners with Active status.'],
    ['partner_leads', 'Partner-sourced leads', 'partner_leads', 'count', 60, 35, 'higher', 'Referrals received.'],
    ['onboarding_stalled', 'Onboarding stalled', 'onboarding_stalled', 'count', 3, 30, 'lower', 'Partners still onboarding.'],
  ],
  /* B21 (ruled 19 Nov): who did the work -- the person, and anyone reporting
     to them -- with the desk's figure beside each, not scored. */
  customer_care: [
    ['resolved', 'Cases resolved', 'cases_resolved', 'count', 180, 35, 'higher', 'Cases you resolved in the period.'],
    ['sla_breaches', 'SLA breaches', 'sla_breaches', 'count', 5, 35, 'lower', 'Cases that went past their deadline while they were yours.'],
    ['csat', 'CSAT', 'csat', 'percent', 85, 30, 'higher', 'Share of customers\' answers that were 4 or 5, on cases you resolved. Scored from 10 answers.'],
  ],
};

export function seedKra() {
  let n = 0;
  /* Once per business, not once overall.
   *
   * The unique key is (role_code, code, sales_org), so this table was built to
   * hold a metric per business — but the insert never named a book, so every
   * shipped metric landed on the column default and Bigul had none at all.
   * `routes/kra.js` reads `WHERE role_code = ? AND sales_org = ?`, so a Bigul
   * RM opened their scorecard and saw an empty one. Nothing was broken in a way
   * anybody could see from Bonanza, which is why it lasted.
   *
   * A business that later edits a metric keeps its edit: the WHERE on the
   * upsert is unchanged, and the two books' rows are separate. */
  for (const org of SALES_ORGS) {
  for (const [role, metrics] of Object.entries(SHIPPED_KRA)) {
    metrics.forEach(([code, label, source, unit, target, weight, direction, description], i) => {
      run(
        `INSERT INTO kra_metrics
           (role_code, code, label, description, source, unit, target, weight, direction, sort_order, sales_org)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(role_code, code, sales_org) DO UPDATE SET
           label = excluded.label, description = excluded.description,
           source = excluded.source, unit = excluded.unit,
           target = excluded.target, weight = excluded.weight,
           direction = excluded.direction, sort_order = excluded.sort_order
         WHERE kra_metrics.edited_at IS NULL`,
        [role, code, label, description, source, unit, target, weight, direction, i, org],
      );
      n += 1;
    });
  }
  }
  return n;
}

/* ------------------------------------------------------- shipped incentives */

/**
 * A worked example of how an Indian retail broker actually pays a desk.
 *
 * Three bases, because one alone distorts behaviour. Brokerage alone rewards
 * churning an existing book; accounts alone rewards opening accounts that never
 * fund; AUM alone rewards sitting on assets and never selling. Together they
 * pull against each other, which is the point.
 *
 * Slabs are MARGINAL. Each band pays its own rate on the portion of production
 * inside it, so one rupee more never changes the whole payout -- a cliff
 * structure is both unfair at the boundary and an active incentive to hold
 * business back until next month.
 */
export const SHIPPED_PLANS = [
  {
    name: 'Sales RM — standard',
    role: 'sales_rm',
    description: 'Brokerage share, an acquisition fee per activated account, and a trail on assets.',
    clawback_months: 6,
    slabs: [
      ['brokerage', 0, 100000, 10, 'percent'],
      ['brokerage', 100000, 300000, 12.5, 'percent'],
      ['brokerage', 300000, null, 15, 'percent'],
      ['accounts', 0, 5, 500, 'flat'],
      ['accounts', 5, 15, 750, 'flat'],
      ['accounts', 15, null, 1000, 'flat'],
      ['aum', 0, null, 5, 'bps'],
    ],
  },
  {
    name: 'Caller — acquisition',
    role: 'caller',
    description: 'Paid on qualified handoffs rather than brokerage, which a caller does not control.',
    clawback_months: 3,
    slabs: [
      ['accounts', 0, 20, 250, 'flat'],
      ['accounts', 20, null, 400, 'flat'],
    ],
  },
  {
    name: 'Dealer — activity',
    role: 'dealer',
    description: 'Brokerage share on the book dealt for, with a lower entry band.',
    clawback_months: 6,
    slabs: [
      ['brokerage', 0, 200000, 8, 'percent'],
      ['brokerage', 200000, null, 11, 'percent'],
      ['aum', 0, null, 3, 'bps'],
    ],
  },
];

export function seedIncentives() {
  /* Once per business, for the same reason as the metrics above: this looked up
     'BONANZA' by name and inserted without a book, so a second business had no
     plans and its desk had nothing to be paid against. */
  for (const org of SALES_ORGS) {
  for (const plan of SHIPPED_PLANS) {
    const existing = one('SELECT id, edited_at FROM incentive_plans WHERE name = ? AND sales_org = ?',
      [plan.name, org]);
    // An edited plan is the business's, not ours. Leave it entirely alone.
    if (existing?.edited_at) continue;

    const id = existing
      ? existing.id
      : Number(run(
        `INSERT INTO incentive_plans (name, role_code, description, clawback_months, sales_org)
         VALUES (?,?,?,?,?)`,
        [plan.name, plan.role, plan.description, plan.clawback_months, org],
      ).lastInsertRowid);

    run('DELETE FROM incentive_slabs WHERE plan_id = ?', [id]);
    plan.slabs.forEach(([basis, from, to, rate, kind], i) => {
      run(
        `INSERT INTO incentive_slabs (plan_id, basis, from_value, to_value, rate, rate_kind, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
        [id, basis, from, to, rate, kind, i],
      );
    });
  }
  }
  return SHIPPED_PLANS.length * SALES_ORGS.length;
}

/* ---------------------------------------------------------------- actuals */

/**
 * Compute one metric from live data.
 *
 * Returns null rather than 0 for anything it cannot measure. Zero and "not
 * measured" look identical on a scorecard and mean opposite things -- one is
 * bad performance, the other is a missing feed, and showing a red zero for the
 * second is how a scorecard loses its audience.
 */
/* --------------------------------------- Customer Care: who did the work */

/** The person and everyone reporting to them, at any depth: a manager's scorecard is the team's. */
const creditedTo = (user) => [user.id, ...reportsOf(user.id)];

/**
 * Who held a case when it breached: its assignee at breached_at, read from
 * the case's history (D9), or its assignee now when nothing has moved since.
 */
const HELD_AT_BREACH = `CAST(COALESCE(
  (SELECT h.new_value FROM field_history h
    WHERE h.entity = 'case' AND h.record_id = t.id AND h.field = 'assignee_id' AND h.changed_at <= t.breached_at
    ORDER BY h.changed_at DESC, h.id DESC LIMIT 1),
  (SELECT h.old_value FROM field_history h
    WHERE h.entity = 'case' AND h.record_id = t.id AND h.field = 'assignee_id' AND h.changed_at > t.breached_at
    ORDER BY h.changed_at ASC, h.id ASC LIMIT 1),
  t.assignee_id) AS INTEGER)`;

/**
 * Cases resolved, SLA breaches and CSAT, credited to `people` -- or to
 * everybody in the reader's businesses (the desk) when `people` is null.
 *
 *   resolved   cases resolved in the period by them (resolved_by, stamped
 *              since A15; before it, whoever held the case)
 *   breaches   cases that breached in the period while they held them
 *   csat       the share of answers in the period that are 4 or 5, on cases
 *              they resolved, scored from CSAT_MIN_ANSWERS answers
 */
function caseFigure(source, user, range, people) {
  const orgs = orgsFor(user);
  const inBooks = { sql: `t.sales_org IN (${orgs.map(() => '?').join(',') || "''"})`, params: orgs };
  const who = (expr) => (people
    ? { sql: `${expr} IN (${people.map(() => '?').join(',')})`, params: people }
    : { sql: '1=1', params: [] });
  const count = (sql, params) => one(sql, params)?.n ?? null;

  if (source === 'cases_resolved') {
    const r = inRange('t.resolved_at', range);
    const w = who('COALESCE(t.resolved_by, t.assignee_id)');
    return count(
      `SELECT COUNT(*) n FROM tickets t WHERE t.resolved_at IS NOT NULL AND ${r.sql} AND ${w.sql} AND ${inBooks.sql}`,
      [...r.params, ...w.params, ...inBooks.params],
    );
  }
  if (source === 'sla_breaches') {
    const r = inRange('t.breached_at', range);
    const w = who(HELD_AT_BREACH);
    return count(
      `SELECT COUNT(*) n FROM tickets t WHERE t.breached_at IS NOT NULL AND ${r.sql} AND ${w.sql} AND ${inBooks.sql}`,
      [...r.params, ...w.params, ...inBooks.params],
    );
  }
  return csatFigure({ people, orgs, range }).pct;
}

/**
 * What a figure carries beside its number: the desk's figure, for the three
 * counted by who did the work, and why a CSAT is not scored yet.
 */
export function detailFor(source, user, range) {
  if (!['cases_resolved', 'sla_breaches', 'csat'].includes(source)) return null;
  const desk = caseFigure(source, user, range, null);
  if (source !== 'csat') return { desk };
  const own = csatFigure({ people: creditedTo(user), orgs: orgsFor(user), range });
  return { desk, answers: own.answers, note: own.pct === null ? notEnoughAnswers(own.answers) : null };
}

export function actualFor(source, user, range) {
  const lScope = leadScope(user, 'l');
  const maySeeClients = userCan(user, 'client.view.all') || userCan(user, 'client.view.own');
  const cScope = maySeeClients ? clientScope(user, 'c') : null;
  const created = inRange('l.created_at', range);
  /* A2d. Cases, partners and KYC applications were counted across the whole
     firm -- both businesses, and everybody's -- so a Bigul scorecard carried
     Bonanza's figures, and a Partner RM's "Active partners" was every active
     partner there is. Partners and KYC applications are counted through the
     reader's own scope, as the lead and account figures above always were;
     cases, since B21, by who did the work, in the reader's businesses
     (caseFigure, above). */
  const pScope = partnerScope(user, 'p');

  const num = (sql, params) => {
    try { return one(sql, params)?.n ?? null; } catch { return null; }
  };

  switch (source) {
    case 'calls_logged':
      return num(
        `SELECT COUNT(*) n FROM activities a JOIN leads l ON l.id = a.lead_id
          WHERE a.type = 'Call' AND a.user_id = ? AND ${inRange('a.created_at', range).sql}`,
        [user.id, ...inRange('a.created_at', range).params],
      );

    case 'connect_rate': {
      const r = inRange('a.created_at', range);
      const total = num(`SELECT COUNT(*) n FROM activities a WHERE a.type='Call' AND a.user_id = ? AND ${r.sql}`,
        [user.id, ...r.params]);
      if (!total) return null;
      const conn = num(
        `SELECT COUNT(*) n FROM activities a WHERE a.type='Call' AND a.outcome='Connected' AND a.user_id = ? AND ${r.sql}`,
        [user.id, ...r.params]);
      return Math.round((conn / total) * 100);
    }

    case 'leads_qualified':
      return num(
        `SELECT COUNT(*) n FROM leads l WHERE l.deleted_at IS NULL AND ${lScope.sql}
           AND l.stage = 'Qualified' AND ${created.sql}`,
        [...lScope.params, ...created.params]);

    case 'accounts_opened': {
      if (!cScope) return null;
      const r = inRange('c.activated_at', range);
      return num(`SELECT COUNT(*) n FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql} AND ${r.sql}`,
        [...cScope.params, ...r.params]);
    }

    case 'brokerage_ytd':
      if (!cScope) return null;
      return num(`SELECT COALESCE(SUM(c.brokerage_ytd),0) n FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql}`,
        cScope.params);

    case 'conversion_pct': {
      const won = num(`SELECT COUNT(*) n FROM leads l WHERE l.deleted_at IS NULL AND ${lScope.sql} AND l.stage='Won'`, lScope.params);
      const decided = num(
        `SELECT COUNT(*) n FROM leads l WHERE l.deleted_at IS NULL AND ${lScope.sql} AND l.stage IN ('Won','Lost')`,
        lScope.params);
      return decided ? Math.round((won / decided) * 100) : null;
    }

    case 'unattended':
      return num(
        `SELECT COUNT(*) n FROM leads l WHERE l.deleted_at IS NULL AND ${lScope.sql}
           AND l.stage NOT IN ('Won','Lost')
           AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id
             AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
             AND a.created_at > datetime('now','-2 days'))`,
        lScope.params);

    case 'active_clients':
      if (!cScope) return null;
      return num(
        `SELECT COUNT(*) n FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql}
           AND c.last_traded_at IS NOT NULL AND julianday('now') - julianday(c.last_traded_at) <= 90`,
        cScope.params);

    case 'dormant':
      if (!cScope) return null;
      return num(
        `SELECT COUNT(*) n FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql}
           AND (c.last_traded_at IS NULL OR julianday('now') - julianday(c.last_traded_at) > 90)`,
        cScope.params);

    case 'cards_engaged':
      return num(
        `SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
          WHERE pc.state NOT IN ('INACTIVE','LOST') AND l.deleted_at IS NULL AND ${lScope.sql}`,
        lScope.params);

    case 'stalled_cards':
      return num(
        `SELECT COUNT(*) n FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
          WHERE pc.state NOT IN ('INACTIVE','ACTIVE','LOST') AND l.deleted_at IS NULL AND ${lScope.sql}
            AND julianday('now') - julianday(pc.last_state_at) > 14`,
        lScope.params);

    case 'kyc_stalled':
      // An application is the desk's through its lead, as "Unattended" is.
      return num(
        `SELECT COUNT(*) n FROM kyc_journeys j JOIN leads l ON l.id = j.lead_id
          WHERE j.status NOT IN ('Complete','Abandoned')
            AND julianday('now') - julianday(j.started_at) > 7
            AND l.deleted_at IS NULL AND ${lScope.sql}`, lScope.params);

    case 'partners_active':
      return num(`SELECT COUNT(*) n FROM partners p WHERE p.state_code = 'ACTIVE' AND ${pScope.sql}`, pScope.params);

    case 'partner_leads':
      /* Referrals from the partners the reader looks after, in that partner's
         own business. */
      return num(
        `SELECT COUNT(*) n FROM leads l JOIN partners p ON p.id = l.partner_id
          WHERE l.deleted_at IS NULL AND l.sales_org = p.sales_org AND ${created.sql} AND ${pScope.sql}`,
        [...created.params, ...pScope.params]);

    case 'onboarding_stalled':
      return num(`SELECT COUNT(*) n FROM partners p WHERE p.state_code = 'ONBOARDING' AND ${pScope.sql}`, pScope.params);

    /* B21 (ruled 19 Nov): Customer Care's three count who did the work --
       the person, and anyone reporting to them -- not every case the reader
       can see. The desk's figure is beside each (detailFor), not scored. */
    case 'cases_resolved':
    case 'sla_breaches':
    case 'csat':
      return caseFigure(source, user, range, creditedTo(user));

    case 'followups_kept':
      // No completion timestamp on reminders yet, so this is honestly unknown
      // rather than optimistically 100.
      return null;

    default:
      return null;
  }
}

/** Score one metric: how far the actual got toward its target, capped at 100. */
export function scoreOf(metric, actual) {
  if (actual == null || !metric.target) return null;
  const pct = metric.direction === 'lower'
    // Lower-is-better: at or under target is full marks, and it degrades from
    // there rather than falling off a cliff at target + 1.
    ? (actual <= metric.target ? 100 : Math.max(0, Math.round((metric.target / actual) * 100)))
    : Math.round((actual / metric.target) * 100);
  return Math.max(0, Math.min(pct, 100));
}

/* --------------------------------------------------------------- payout */

/**
 * Apply marginal slabs to a production figure.
 *
 * Each band pays its own rate on the portion inside it, so the total is the sum
 * of the parts rather than one rate applied to everything.
 */
export function applySlabs(slabs, value) {
  const lines = [];
  let total = 0;

  for (const s of slabs.sort((a, b) => a.from_value - b.from_value)) {
    const top = s.to_value == null ? Infinity : s.to_value;
    if (value <= s.from_value) continue;
    const portion = Math.min(value, top) - s.from_value;
    if (portion <= 0) continue;

    const amount = s.rate_kind === 'percent' ? (portion * s.rate) / 100
      : s.rate_kind === 'bps' ? (portion * s.rate) / 10000
        : portion * s.rate;

    total += amount;
    lines.push({
      from: s.from_value,
      to: s.to_value,
      rate: s.rate,
      rate_kind: s.rate_kind,
      portion,
      amount: Math.round(amount),
    });
  }

  return { total: Math.round(total), lines };
}
