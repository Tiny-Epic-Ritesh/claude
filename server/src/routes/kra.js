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
import { all, one, run } from '../db.js';
import { requireUser, requirePermission, clientScope, leadScope, can, activeOrg } from '../auth.js';
import { resolveRange, inRange, RANGES, DEFAULT_RANGE } from '../engine/daterange.js';
import { actualFor, scoreOf, applySlabs } from '../engine/kra.js';
import { auditConfig } from '../engine/metadata.js';

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


/* ---------------------------------------------------------- validation */

const UNITS = ['count', 'rupees', 'percent', 'days'];
const DIRECTIONS = ['higher', 'lower'];
const BASES = ['brokerage', 'accounts', 'aum'];
const RATE_KINDS = ['percent', 'flat', 'bps'];

/**
 * Check a set of bands before it is saved.
 *
 * Two faults matter and neither shows up until payday.
 *
 * A GAP means production landing in it earns nothing, silently — somebody
 * producing 150,000 against bands of 0–100,000 and 200,000–up is paid on
 * 100,000 and nobody notices until they query the payslip.
 *
 * An OVERLAP means the same rupee is paid twice, which is worse, because it
 * looks generous rather than broken and the first person to spot it will be an
 * auditor.
 *
 * Returned as a list rather than thrown, so the screen can mark the offending
 * band instead of showing one opaque message.
 */
export function validateSlabs(slabs) {
  const problems = [];

  for (const basis of new Set(slabs.map((s) => s.basis))) {
    const bands = slabs
      .filter((s) => s.basis === basis)
      .sort((a, b) => Number(a.from_value) - Number(b.from_value));

    bands.forEach((b, i) => {
      const from = Number(b.from_value);
      const to = b.to_value == null || b.to_value === '' ? null : Number(b.to_value);

      if (Number.isNaN(from) || from < 0) problems.push(`${basis}: a band starts at an invalid value`);
      if (to != null && to <= from) problems.push(`${basis}: a band ends at or before it starts`);
      if (Number(b.rate) < 0) problems.push(`${basis}: a negative rate`);
      if (!RATE_KINDS.includes(b.rate_kind)) problems.push(`${basis}: unknown rate type "${b.rate_kind}"`);

      const next = bands[i + 1];
      if (!next) {
        // The last band should be open-ended, or production above it earns
        // nothing at all — which is a cliff nobody intended.
        if (to != null) problems.push(`${basis}: the top band ends at ${to}, so anything above it earns nothing. Leave the upper bound empty.`);
        return;
      }
      const nextFrom = Number(next.from_value);
      if (to == null) { problems.push(`${basis}: an open-ended band sits below another band`); return; }
      if (nextFrom > to) problems.push(`${basis}: nothing is paid between ${to} and ${nextFrom}`);
      if (nextFrom < to) problems.push(`${basis}: bands overlap between ${nextFrom} and ${to}, so that portion pays twice`);
    });

    if (bands.length && Number(bands[0].from_value) !== 0) {
      problems.push(`${basis}: the first band starts at ${bands[0].from_value}, so production below that earns nothing`);
    }
  }

  return [...new Set(problems)];
}

/* --------------------------------------------------------- KRA writes */

router.patch('/config/metrics/:id', requirePermission('admin.rules'), (req, res) => {
  const row = one('SELECT * FROM kra_metrics WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Metric not found' });

  const fields = ['label', 'description', 'source', 'unit', 'target', 'weight', 'direction', 'active', 'sort_order'];
  if ('unit' in req.body && !UNITS.includes(req.body.unit)) {
    return res.status(400).json({ error: `Unit must be one of: ${UNITS.join(', ')}` });
  }
  if ('direction' in req.body && !DIRECTIONS.includes(req.body.direction)) {
    return res.status(400).json({ error: 'Direction must be higher or lower' });
  }
  if ('weight' in req.body && (Number(req.body.weight) < 0 || Number(req.body.weight) > 100)) {
    return res.status(400).json({ error: 'Weight must be between 0 and 100' });
  }

  const sets = [];
  const params = [];
  for (const f of fields) {
    if (!(f in req.body)) continue;
    sets.push(`${f} = ?`);
    params.push(typeof req.body[f] === 'boolean' ? (req.body[f] ? 1 : 0) : req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

  // Marks the row as the business's, so seedKra() stops managing it.
  sets.push("edited_at = datetime('now')", 'edited_by = ?');
  params.push(req.user.id);

  run(`UPDATE kra_metrics SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);
  const after = one('SELECT * FROM kra_metrics WHERE id = ?', [row.id]);
  auditConfig('kra', `${row.role_code}.${row.code}`, 'updated', row, after, req.user.id);
  res.json(after);
});

router.post('/config/metrics', requirePermission('admin.rules'), (req, res) => {
  const { role_code: role, code, label } = req.body ?? {};
  if (!role || !code || !label) {
    return res.status(400).json({ error: 'A metric needs a role, a code and a label' });
  }
  if (one('SELECT id FROM kra_metrics WHERE role_code = ? AND code = ? AND sales_org = ?',
    [role, code, req.user.sales_org])) {
    return res.status(409).json({ error: `"${code}" already exists for that role` });
  }

  const next = one('SELECT COALESCE(MAX(sort_order),0)+1 n FROM kra_metrics WHERE role_code = ?', [role]).n;
  const r = run(
    `INSERT INTO kra_metrics
       (role_code, code, label, description, source, unit, target, weight, direction,
        sort_order, sales_org, edited_at, edited_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'), ?)`,
    [role, code, label, req.body.description ?? null, req.body.source ?? null,
      req.body.unit ?? 'count', req.body.target ?? 0, req.body.weight ?? 10,
      req.body.direction ?? 'higher', next, req.user.sales_org, req.user.id],
  );
  const created = one('SELECT * FROM kra_metrics WHERE id = ?', [Number(r.lastInsertRowid)]);
  auditConfig('kra', `${role}.${code}`, 'created', null, created, req.user.id);
  res.status(201).json(created);
});

/**
 * Retire rather than delete.
 *
 * A scorecard already issued for last month referenced this metric. Removing
 * the row would leave that history describing a measure nobody can look up.
 */
router.delete('/config/metrics/:id', requirePermission('admin.rules'), (req, res) => {
  const row = one('SELECT * FROM kra_metrics WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Metric not found' });
  run("UPDATE kra_metrics SET active = 0, edited_at = datetime('now'), edited_by = ? WHERE id = ?",
    [req.user.id, row.id]);
  auditConfig('kra', `${row.role_code}.${row.code}`, 'retired', row, { ...row, active: 0 }, req.user.id);
  res.json({ ok: true, retired: true });
});

/* --------------------------------------------------- incentive writes */

router.patch('/config/plans/:id', requirePermission('admin.rules'), (req, res) => {
  const plan = one('SELECT * FROM incentive_plans WHERE id = ?', [req.params.id]);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const slabs = req.body.slabs;
  if (slabs !== undefined) {
    if (!Array.isArray(slabs)) return res.status(400).json({ error: 'Slabs must be a list' });
    for (const s of slabs) {
      if (!BASES.includes(s.basis)) {
        return res.status(400).json({ error: `Basis must be one of: ${BASES.join(', ')}` });
      }
    }
    const problems = validateSlabs(slabs);
    if (problems.length) return res.status(400).json({ error: problems[0], problems });
  }

  const sets = [];
  const params = [];
  for (const f of ['name', 'description', 'clawback_months', 'active', 'effective_from', 'effective_to']) {
    if (!(f in req.body)) continue;
    sets.push(`${f} = ?`);
    params.push(typeof req.body[f] === 'boolean' ? (req.body[f] ? 1 : 0) : req.body[f]);
  }
  sets.push("edited_at = datetime('now')", 'edited_by = ?');
  params.push(req.user.id);
  run(`UPDATE incentive_plans SET ${sets.join(', ')} WHERE id = ?`, [...params, plan.id]);

  if (slabs !== undefined) {
    // Replaced wholesale inside one statement sequence: a half-written slab set
    // would pay on bands nobody approved.
    run('DELETE FROM incentive_slabs WHERE plan_id = ?', [plan.id]);
    slabs.forEach((s, i) => {
      run(
        `INSERT INTO incentive_slabs (plan_id, basis, from_value, to_value, rate, rate_kind, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
        [plan.id, s.basis, Number(s.from_value) || 0,
          s.to_value === '' || s.to_value == null ? null : Number(s.to_value),
          Number(s.rate) || 0, s.rate_kind ?? 'percent', i],
      );
    });
  }

  const after = one('SELECT * FROM incentive_plans WHERE id = ?', [plan.id]);
  auditConfig('incentives', plan.name, 'updated', plan, after, req.user.id);
  res.json({
    ...after,
    slabs: all('SELECT * FROM incentive_slabs WHERE plan_id = ? ORDER BY basis, from_value', [plan.id]),
  });
});

router.post('/config/plans', requirePermission('admin.rules'), (req, res) => {
  const { name, role_code: role } = req.body ?? {};
  if (!name || !role) return res.status(400).json({ error: 'A plan needs a name and a role' });

  const r = run(
    `INSERT INTO incentive_plans (name, role_code, description, clawback_months, sales_org, edited_at, edited_by)
     VALUES (?,?,?,?,?, datetime('now'), ?)`,
    [name, role, req.body.description ?? null, req.body.clawback_months ?? 6,
      req.user.sales_org, req.user.id],
  );
  const created = one('SELECT * FROM incentive_plans WHERE id = ?', [Number(r.lastInsertRowid)]);
  auditConfig('incentives', name, 'created', null, created, req.user.id);
  res.status(201).json({ ...created, slabs: [] });
});

/**
 * A dry run of the bands against a figure.
 *
 * So somebody changing a slab can see what it pays before saving it, rather
 * than saving and waiting for the month to tell them.
 */
router.post('/config/preview', requirePermission('admin.rules'), (req, res) => {
  const { slabs = [], value = 0, basis = 'brokerage' } = req.body ?? {};
  const problems = validateSlabs(slabs.filter((s) => s.basis === basis));
  const applied = applySlabs(
    slabs.filter((s) => s.basis === basis).map((s) => ({
      ...s,
      from_value: Number(s.from_value) || 0,
      to_value: s.to_value === '' || s.to_value == null ? null : Number(s.to_value),
      rate: Number(s.rate) || 0,
    })),
    Number(value) || 0,
  );
  res.json({ ...applied, problems, basis, value: Number(value) || 0 });
});

export default router;
