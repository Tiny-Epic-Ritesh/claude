/**
 * KRA scorecard and incentive payout.
 *
 * Both read configuration and compute against live records, so what a person
 * sees here is their own book measured against targets the business set —
 * rather than a static sheet somebody maintains by hand and nobody trusts.
 *
 * Everything is scoped to the reader. A supervisor's scorecard measures their
 * chain because leadScope says so, not because a separate query was written for
 * them, which is what keeps the two consistent.
 */

import { Router } from 'express';
import { all, one } from '../db.js';
import { requireUser, requirePermission, clientScope, leadScope, can, activeOrg } from '../auth.js';
import { resolveRange, inRange, RANGES, DEFAULT_RANGE } from '../engine/daterange.js';
import { actualFor, scoreOf, applySlabs } from '../engine/kra.js';

const router = Router();
router.use(requireUser);

/* ------------------------------------------------------------ scorecard */

router.get('/', (req, res) => {
  const range = resolveRange(req.query.range || DEFAULT_RANGE, {
    from: req.query.from, to: req.query.to,
  });

  const metrics = all(
    `SELECT * FROM kra_metrics
      WHERE role_code = ? AND active = 1 AND sales_org = ?
      ORDER BY sort_order`,
    [req.user.role, req.user.sales_org],
  );

  const rows = metrics.map((m) => {
    const actual = actualFor(m.source, req.user, range);
    const score = scoreOf(m, actual);
    return {
      ...m,
      actual,
      score,
      // Separated from `actual == null` deliberately: a metric with no source
      // is a configuration gap, one with a source that returned nothing is a
      // data gap, and they are fixed by different people.
      measurable: Boolean(m.source) && actual !== null,
      reason: !m.source ? 'No source configured for this metric'
        : actual === null ? 'Nothing to measure it from yet'
          : null,
    };
  });

  /**
   * The overall score, over measurable metrics only.
   *
   * Counting an unmeasurable metric as zero would punish somebody for a feed
   * that has not been connected. The response says how much of the scorecard
   * the number actually covers, so a 78% over half the metrics cannot be
   * mistaken for a full picture.
   */
  const scored = rows.filter((r) => r.score !== null);
  const weight = scored.reduce((s, r) => s + r.weight, 0);
  const overall = weight
    ? Math.round(scored.reduce((s, r) => s + r.score * r.weight, 0) / weight)
    : null;

  res.json({
    range: { code: range.code, label: range.label, from: range.from, to: range.to },
    ranges: RANGES,
    role: req.user.role,
    metrics: rows,
    overall,
    coverage: {
      measured: scored.length,
      total: rows.length,
      weight_covered: weight,
      weight_total: rows.reduce((s, r) => s + r.weight, 0),
    },
  });
});

/* -------------------------------------------------------------- payout */

router.get('/incentives', (req, res) => {
  const range = resolveRange(req.query.range || DEFAULT_RANGE, {
    from: req.query.from, to: req.query.to,
  });

  const plan = one(
    `SELECT * FROM incentive_plans
      WHERE role_code = ? AND active = 1 AND sales_org = ?
        AND effective_from <= date('now')
        AND (effective_to IS NULL OR effective_to >= date('now'))
      ORDER BY effective_from DESC LIMIT 1`,
    [req.user.role, req.user.sales_org],
  );

  if (!plan) {
    return res.json({
      plan: null,
      note: 'No incentive plan is configured for your role yet.',
      range: { code: range.code, label: range.label },
      ranges: RANGES,
    });
  }

  const slabs = all('SELECT * FROM incentive_slabs WHERE plan_id = ? ORDER BY basis, from_value', [plan.id]);

  const maySeeClients = can(req.user.role, 'client.view.all') || can(req.user.role, 'client.view.own');
  const cScope = maySeeClients ? clientScope(req.user, 'c', activeOrg(req)) : null;

  /* Production, per basis. */
  const opened = inRange('c.activated_at', range);
  const production = {
    brokerage: cScope
      ? one(`SELECT COALESCE(SUM(c.brokerage_ytd),0) v FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql}`,
        cScope.params).v
      : 0,
    accounts: cScope
      ? one(`SELECT COUNT(*) v FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql} AND ${opened.sql}`,
        [...cScope.params, ...opened.params]).v
      : 0,
    aum: cScope
      ? one(`SELECT COALESCE(SUM(c.holding_value),0) v FROM clients c WHERE c.deleted_at IS NULL AND ${cScope.sql}`,
        cScope.params).v
      : 0,
  };

  const bases = [...new Set(slabs.map((s) => s.basis))].map((basis) => {
    const applied = applySlabs(slabs.filter((s) => s.basis === basis), production[basis] ?? 0);
    return {
      basis,
      production: production[basis] ?? 0,
      ...applied,
    };
  });

  /**
   * At risk of clawback: accounts opened inside the clawback window that have
   * never traded. Not deducted -- an account that has not traded yet may still
   * trade -- but named, because the alternative is a surprise on a payslip.
   */
  const atRisk = cScope
    ? one(
      `SELECT COUNT(*) n FROM clients c
        WHERE c.deleted_at IS NULL AND ${cScope.sql}
          AND c.last_traded_at IS NULL
          AND julianday('now') - julianday(c.activated_at) < ?`,
      [...cScope.params, plan.clawback_months * 30],
    ).n
    : 0;

  res.json({
    range: { code: range.code, label: range.label, from: range.from, to: range.to },
    ranges: RANGES,
    plan: {
      id: plan.id, name: plan.name, description: plan.description,
      clawback_months: plan.clawback_months,
    },
    bases,
    total: bases.reduce((s, b) => s + b.total, 0),
    at_risk: {
      accounts: atRisk,
      note: atRisk
        ? `${atRisk} account${atRisk === 1 ? '' : 's'} opened recently that have not traded. If they stay dormant past ${plan.clawback_months} months the acquisition fee is clawed back.`
        : null,
    },
    /* Shown so somebody can check the arithmetic rather than trust it. */
    slabs,
  });
});

/* --------------------------------------------------------------- config */

router.get('/config', requirePermission('admin.rules'), (_req, res) => {
  const roles = all('SELECT code, name FROM roles ORDER BY sort_order, code');
  res.json({
    roles,
    metrics: all('SELECT * FROM kra_metrics ORDER BY role_code, sort_order'),
    plans: all('SELECT * FROM incentive_plans ORDER BY role_code, name').map((p) => ({
      ...p,
      slabs: all('SELECT * FROM incentive_slabs WHERE plan_id = ? ORDER BY basis, from_value', [p.id]),
    })),
    note: 'These ship as a worked example. Every target, weight and slab is meant to be replaced with the real figures from the business.',
  });
});

export default router;
