/**
 * Custom dashboards (P2-17b).
 *
 * WHO MAY DO WHAT (Q-13)
 *
 * Anyone may build a personal dashboard — a rep arranging their own view harms
 * nobody. Publishing one to a role is a different act and needs `report.team`,
 * because it puts a question in front of people who did not ask it and will
 * assume somebody checked the arithmetic.
 *
 * WHAT SHARING DOES AND DOES NOT SHARE
 *
 * It shares the QUESTION, never the answer. Every panel is run through the
 * viewer's own scope at the moment they open it, so a supervisor's "pipeline by
 * stage" shows each RM their own book. This is the single most important
 * property of the feature and it is asserted in dashboards.test.mjs, because
 * getting it wrong would turn a convenience into a data leak that looks like a
 * chart.
 */

import { Router } from 'express';
import { all, one, run, audit, transact, SALES_ORGS } from '../db.js';
import { requireUser, requirePermission, can, orgsFor, mayUseOrg } from '../auth.js';
import { runPanel, validatePanel, catalogue } from '../engine/panels.js';
import { resolveRange, RANGES, DEFAULT_RANGE } from '../engine/daterange.js';

const router = Router();
router.use(requireUser);

const parse = (t, fallback = null) => { try { return t ? JSON.parse(t) : fallback; } catch { return fallback; } };

const shape = (d) => ({
  ...d,
  shared_with: parse(d.shared_with),
  mine: undefined,
});

/** Dashboards this person may open: their own, plus anything published to them. */
const visibleTo = (user) => all(
  `SELECT d.*, u.name AS owner_name FROM custom_dashboard d
   JOIN users u ON u.id = d.owner_id
   WHERE d.owner_id = ? OR d.shared_with IS NOT NULL
   ORDER BY d.name`,
  [user.id],
).filter((d) => {
  if (d.owner_id === user.id) return true;
  const roles = parse(d.shared_with, []);
  /* Published to a role, and within a book the viewer works in. A dashboard
     built for Bigul has no business appearing on a Bonanza desk even though
     the panels would scope its rows away — an empty chart somebody cannot
     explain is its own kind of wrong. */
  if (!Array.isArray(roles) || !roles.includes(user.role)) return false;
  return !d.sales_org || orgsFor(user).includes(d.sales_org);
});

const load = (id, user) => visibleTo(user).find((d) => String(d.id) === String(id)) ?? null;
const isOwner = (d, user) => d.owner_id === user.id;

/* ------------------------------------------------------------- reading */

router.get('/catalogue', (_req, res) => res.json(catalogue()));

router.get('/', (req, res) => {
  const rows = visibleTo(req.user);
  res.json({
    dashboards: rows.map((d) => ({
      ...shape(d),
      mine: isOwner(d, req.user),
      panel_count: one('SELECT COUNT(*) n FROM dashboard_panel WHERE dashboard_id = ?', [d.id]).n,
    })),
    may_share: can(req.user.role, 'report.team'),
    /* The roles a dashboard can be published to, served here rather than from
       /setup/roles — publishing needs report.team, which a supervisor has and
       admin.roles, which they do not. Making the share control depend on a
       Setup endpoint would have 403'd for exactly the people it is for. */
    roles: can(req.user.role, 'report.team')
      ? all('SELECT code, name FROM roles WHERE active = 1 ORDER BY sort_order, name')
      : [],
  });
});

/**
 * Render one dashboard for whoever is asking.
 *
 * Every panel is run here, through this viewer's scope. A panel that fails is
 * named rather than silently dropped — P2-17d's lesson, and it matters more on
 * a dashboard somebody built themselves, because they are the one who can fix
 * it and cannot if they never learn it broke.
 */
router.get('/:id', (req, res) => {
  const dash = load(req.params.id, req.user);
  if (!dash) return res.status(404).json({ error: 'No such dashboard' });

  const range = resolveRange(req.query.range || DEFAULT_RANGE, { from: req.query.from, to: req.query.to });
  const panels = all('SELECT * FROM dashboard_panel WHERE dashboard_id = ? ORDER BY sort_order, id', [dash.id]);

  const broken = [];
  const rendered = panels.map((p) => {
    const def = {
      ...p,
      measure: parse(p.measure, { fn: 'count' }),
      filters: parse(p.filters),
      use_range: Boolean(p.use_range),
      limit: p.point_limit,
    };
    try {
      return { id: p.id, title: p.title, source: p.source, ...runPanel(req, def, range), definition: def };
    } catch (err) {
      console.error(`[dashboards] panel ${p.id} "${p.title}" failed:`, err.message);
      broken.push(p.title);
      return { id: p.id, title: p.title, source: p.source, kind: 'error', error: err.message, definition: def };
    }
  });

  return res.json({
    dashboard: { ...shape(dash), mine: isOwner(dash, req.user) },
    range: { code: range.code, label: range.label, from: range.from, to: range.to },
    ranges: RANGES,
    panels: rendered,
    broken: broken.length ? broken : null,
  });
});

/* ------------------------------------------------------------ writing */

router.post('/', (req, res) => {
  const { name, description, shared_with: shared, sales_org: org } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Give the dashboard a name', field: 'name' });
  }

  if (shared && !can(req.user.role, 'report.team')) {
    return res.status(403).json({
      error: 'Publishing a dashboard to other people needs reporting permission. You can still build one for yourself.',
      required: 'report.team',
    });
  }
  if (org && (!SALES_ORGS.includes(org) || !mayUseOrg(req.user, org))) {
    return res.status(403).json({ error: 'That business is outside your access', field: 'sales_org' });
  }

  const result = run(
    'INSERT INTO custom_dashboard (name, description, owner_id, shared_with, sales_org) VALUES (?,?,?,?,?)',
    [String(name).trim(), description ?? null, req.user.id,
      Array.isArray(shared) && shared.length ? JSON.stringify(shared) : null, org ?? null],
  );

  audit(req.user.id, 'dashboard_created', 'custom_dashboard', Number(result.lastInsertRowid), { name, shared_with: shared ?? null });
  return res.status(201).json(shape(one('SELECT * FROM custom_dashboard WHERE id = ?', [Number(result.lastInsertRowid)])));
});

router.patch('/:id', (req, res) => {
  const dash = load(req.params.id, req.user);
  if (!dash) return res.status(404).json({ error: 'No such dashboard' });
  /* Only the owner edits. A shared dashboard that any viewer can rewrite is a
     shared dashboard nobody can rely on. */
  if (!isOwner(dash, req.user)) return res.status(403).json({ error: 'Only the person who built this can change it' });

  const { name, description, shared_with: shared } = req.body;
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'Give the dashboard a name', field: 'name' });
  }
  if (shared !== undefined && shared && !can(req.user.role, 'report.team')) {
    return res.status(403).json({ error: 'Publishing a dashboard needs reporting permission', required: 'report.team' });
  }

  run(
    `UPDATE custom_dashboard SET name = COALESCE(?, name), description = COALESCE(?, description),
       shared_with = ${shared === undefined ? 'shared_with' : '?'}, updated_at = datetime('now')
     WHERE id = ?`,
    shared === undefined
      ? [name ?? null, description ?? null, dash.id]
      : [name ?? null, description ?? null,
        Array.isArray(shared) && shared.length ? JSON.stringify(shared) : null, dash.id],
  );

  audit(req.user.id, 'dashboard_updated', 'custom_dashboard', dash.id, { name: name ?? dash.name });
  return res.json(shape(one('SELECT * FROM custom_dashboard WHERE id = ?', [dash.id])));
});

router.delete('/:id', (req, res) => {
  const dash = load(req.params.id, req.user);
  if (!dash) return res.status(404).json({ error: 'No such dashboard' });
  if (!isOwner(dash, req.user)) return res.status(403).json({ error: 'Only the person who built this can delete it' });

  run('DELETE FROM custom_dashboard WHERE id = ?', [dash.id]);
  audit(req.user.id, 'dashboard_deleted', 'custom_dashboard', dash.id, { name: dash.name });
  return res.status(204).end();
});

/* ------------------------------------------------------------- panels */

router.post('/:id/panels', (req, res) => {
  const dash = load(req.params.id, req.user);
  if (!dash) return res.status(404).json({ error: 'No such dashboard' });
  if (!isOwner(dash, req.user)) return res.status(403).json({ error: 'Only the person who built this can change it' });

  const invalid = validatePanel(req.body);
  if (invalid) return res.status(400).json(invalid);

  const p = req.body;
  const result = run(
    `INSERT INTO dashboard_panel (dashboard_id, title, source, kind, measure, group_by, filters, use_range, point_limit, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM dashboard_panel WHERE dashboard_id = ?))`,
    [
      dash.id, String(p.title).trim(), p.source, p.kind ?? (p.group_by ? 'bar' : 'tile'),
      JSON.stringify(p.measure ?? { fn: 'count' }), p.group_by ?? null,
      p.filters ? JSON.stringify(p.filters) : null,
      p.use_range === false ? 0 : 1, Math.min(Number(p.limit) || 8, 20), dash.id,
    ],
  );

  return res.status(201).json(one('SELECT * FROM dashboard_panel WHERE id = ?', [Number(result.lastInsertRowid)]));
});

router.delete('/:id/panels/:panelId', (req, res) => {
  const dash = load(req.params.id, req.user);
  if (!dash) return res.status(404).json({ error: 'No such dashboard' });
  if (!isOwner(dash, req.user)) return res.status(403).json({ error: 'Only the person who built this can change it' });

  run('DELETE FROM dashboard_panel WHERE id = ? AND dashboard_id = ?', [req.params.panelId, dash.id]);
  return res.status(204).end();
});

/**
 * Try a panel without saving it.
 *
 * The builder shows the real answer as it is being defined, which is the only
 * way somebody can tell whether they have asked the question they meant. It
 * runs through the caller's own scope like any other panel — a preview that
 * ignored scope would show numbers the author could not otherwise see.
 */
router.post('/preview', (req, res) => {
  const invalid = validatePanel(req.body);
  if (invalid) return res.status(400).json(invalid);

  const range = resolveRange(req.query.range || DEFAULT_RANGE, { from: req.query.from, to: req.query.to });
  try {
    return res.json(runPanel(req, { ...req.body, limit: req.body.limit }, range));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
