/**
 * Advanced search.
 *
 * One builder over every object. The interesting decisions are not in the query
 * — `engine/search.js` owns that — but in what a search is allowed to see and
 * what may be done with the result.
 *
 * SEARCH NEVER WIDENS VISIBILITY
 * ------------------------------
 * A search is a different way to ask, not a different answer. Every query is
 * narrowed by the same scope the ordinary list uses, so a Sales RM filtering
 * "owner is anyone" still sees only their own book. Without that, advanced
 * search becomes the way around the permission model.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { requireUser, requirePermission, reqScope, orgsFor } from '../auth.js';
import {
  SEARCHABLE, registryFor, validateTree, compile, runSearch, searchIds,
  operatorsFor, describe, searchableObjects, OPERATORS,
} from '../engine/search.js';
import { picklistValues, fieldDef } from '../engine/metadata.js';

const router = Router();
router.use(requireUser);

/**
 * How each object is narrowed to what the caller may see.
 *
 * Leads reuse the existing lead scope, which already composes role scope with
 * sales-org scope. Everything else is narrowed by org, because an object with
 * no owner concept still belongs to one business or the other.
 */
function scopeFor(entity, req) {
  if (entity === 'lead') {
    const s = reqScope(req);
    return { sql: s.sql, params: s.params };
  }

  const orgs = orgsFor(req.user);
  const spec = SEARCHABLE[entity];
  if (!spec) return { sql: null, params: [] };

  // Only if the table actually carries a sales_org; not all of them do.
  const table = spec.table.split(' ')[0];
  const hasOrg = all('SELECT name FROM pragma_table_info(?)', [table]).some((c) => c.name === 'sales_org');
  if (!hasOrg || !orgs.length) return { sql: null, params: [] };

  return { sql: `l.sales_org IN (${orgs.map(() => '?').join(',')})`, params: orgs };
}

/* ---------------------------------------------------------- the fields */

/** What can be searched, and with which operators. */
router.get('/objects', (_req, res) => res.json(searchableObjects()));

router.get('/fields/:entity', (req, res) => {
  const registry = registryFor(req.params.entity, req.user, req.caps);
  if (!registry) return res.status(404).json({ error: `${req.params.entity} cannot be searched` });

  const fields = Object.entries(registry).map(([api_name, f]) => {
    const def = fieldDef(req.params.entity, api_name);
    return {
      api_name,
      label: f.label,
      type: f.type,
      custom: f.custom,
      operators: operatorsFor(f.type),
      // Picklist values so the value box becomes a dropdown rather than a
      // free-text field the user has to guess the spelling for.
      values: def && (def.type === 'picklist' || def.type === 'multipicklist')
        ? picklistValues(def.id).map((v) => ({ value: v.value, label: v.label }))
        : undefined,
    };
  });

  return res.json({
    entity: req.params.entity,
    label: SEARCHABLE[req.params.entity].label,
    fields: fields.sort((a, b) => Number(a.custom) - Number(b.custom) || a.label.localeCompare(b.label)),
  });
});

/* --------------------------------------------------------------- run */

router.post('/:entity', (req, res) => {
  const { entity } = req.params;
  const registry = registryFor(entity, req.user, req.caps);
  if (!registry) return res.status(404).json({ error: `${entity} cannot be searched` });

  const tree = req.body?.where ?? null;
  if (tree) {
    const err = validateTree(tree, registry);
    if (err) return res.status(400).json({ error: err });
  }

  const scope = scopeFor(entity, req);
  const result = runSearch(entity, tree, {
    registry,
    scopeSql: scope.sql,
    scopeParams: scope.params,
    limit: req.body?.limit,
    offset: req.body?.offset,
    sort: req.body?.sort,
    dir: req.body?.dir,
  });

  return res.json({
    ...result,
    described: tree ? describe(tree, registry) : 'Everything you can see',
  });
});

/** Just the count — for the builder's live "matches N records" line. */
router.post('/:entity/count', (req, res) => {
  const registry = registryFor(req.params.entity, req.user, req.caps);
  if (!registry) return res.status(404).json({ error: 'Not searchable' });

  const tree = req.body?.where ?? null;
  if (tree) {
    const err = validateTree(tree, registry);
    if (err) return res.status(400).json({ error: err });
  }

  const scope = scopeFor(req.params.entity, req);
  const { total } = runSearch(req.params.entity, tree, {
    registry, scopeSql: scope.sql, scopeParams: scope.params, limit: 1,
  });
  return res.json({ total });
});

/* ------------------------------------------------------ saved segments */

/**
 * Save a search as a segment.
 *
 * Stored as a query, never as a membership list — non-negotiable 10. A segment
 * saved today and opened in March returns March's answer, which is the only
 * behaviour anyone actually wants from something called "at-risk leads".
 */
router.post('/:entity/save', requirePermission('list.create'), (req, res) => {
  const { entity } = req.params;
  const registry = registryFor(entity, req.user, req.caps);
  if (!registry) return res.status(404).json({ error: 'Not searchable' });

  const { name, where } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'Give the segment a name' });

  const err = validateTree(where, registry);
  if (err) return res.status(400).json({ error: err });

  const result = run(
    `INSERT INTO saved_searches (name, entity, tree, described, created_by, sales_org)
     VALUES (?,?,?,?,?,?)`,
    [name.trim(), entity, JSON.stringify(where), describe(where, registry),
      req.user.id, req.user.sales_org],
  );
  audit(req.user.id, 'segment_saved', 'saved_search', Number(result.lastInsertRowid), { entity, name });

  return res.status(201).json(one('SELECT * FROM saved_searches WHERE id = ?', [result.lastInsertRowid]));
});

router.get('/saved/:entity', (req, res) => {
  const orgs = orgsFor(req.user);
  res.json(all(
    `SELECT s.*, u.name AS created_by_name FROM saved_searches s
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.entity = ? AND (s.sales_org IS NULL OR s.sales_org IN (${orgs.map(() => '?').join(',') || 'NULL'}))
     ORDER BY s.created_at DESC`,
    [req.params.entity, ...orgs],
  ));
});

router.delete('/saved/:id', (req, res) => {
  const saved = one('SELECT * FROM saved_searches WHERE id = ?', [req.params.id]);
  if (!saved) return res.status(404).json({ error: 'Segment not found' });
  // Yours to delete, or an administrator's.
  if (saved.created_by !== req.user.id && !req.caps.has('admin.system')) {
    return res.status(403).json({ error: `"${saved.name}" belongs to someone else` });
  }
  run('DELETE FROM saved_searches WHERE id = ?', [req.params.id]);
  audit(req.user.id, 'segment_deleted', 'saved_search', Number(req.params.id), {});
  return res.json({ deleted: true });
});

/* ------------------------------------------------------- result actions */

/** Every matching id, so the client can run a bulk action over the result. */
router.post('/:entity/ids', (req, res) => {
  const registry = registryFor(req.params.entity, req.user, req.caps);
  if (!registry) return res.status(404).json({ error: 'Not searchable' });

  const tree = req.body?.where ?? null;
  if (tree) {
    const err = validateTree(tree, registry);
    if (err) return res.status(400).json({ error: err });
  }

  const scope = scopeFor(req.params.entity, req);
  const ids = searchIds(req.params.entity, tree, {
    registry, scopeSql: scope.sql, scopeParams: scope.params, cap: 5000,
  });
  return res.json({ ids, count: ids.length, capped: ids.length === 5000 });
});

/** Turn a result into a lead list a campaign can send to. */
router.post('/lead/to-list', requirePermission('list.create'), (req, res) => {
  const registry = registryFor('lead', req.user, req.caps);
  const { name, where } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'Give the list a name' });

  if (where) {
    const err = validateTree(where, registry);
    if (err) return res.status(400).json({ error: err });
  }

  const scope = scopeFor('lead', req);
  const ids = searchIds('lead', where, {
    registry, scopeSql: scope.sql, scopeParams: scope.params, cap: 20_000,
  });

  const list = run(
    'INSERT INTO lead_lists (name, description, created_by) VALUES (?,?,?)',
    [name.trim(), where ? describe(where, registry) : 'Everything visible', req.user.id],
  );
  for (const id of ids) {
    run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list.lastInsertRowid, id]);
  }

  audit(req.user.id, 'list_created_from_search', 'lead_list', Number(list.lastInsertRowid), { members: ids.length });
  return res.status(201).json({ id: list.lastInsertRowid, name: name.trim(), members: ids.length });
});

/**
 * CSV export.
 *
 * Gated behind its own capability and audited with the row count and the exact
 * filter used, because this is the one action that takes client data out of the
 * system and onto somebody's laptop. Masked fields stay masked — an export is
 * not a way around field-level security.
 */
router.post('/:entity/export', requirePermission('data.export'), (req, res) => {
  const { entity } = req.params;
  const registry = registryFor(entity, req.user, req.caps);
  if (!registry) return res.status(404).json({ error: 'Not searchable' });

  const tree = req.body?.where ?? null;
  if (tree) {
    const err = validateTree(tree, registry);
    if (err) return res.status(400).json({ error: err });
  }

  const scope = scopeFor(entity, req);
  const { rows, total } = runSearch(entity, tree, {
    registry, scopeSql: scope.sql, scopeParams: scope.params, limit: 5000,
  });

  audit(req.user.id, 'data_exported', entity, null, {
    rows: rows.length,
    of_total: total,
    filter: tree ? describe(tree, registry) : 'no filter',
  });

  const headers = rows.length ? Object.keys(rows[0]) : [];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${entity}-export.csv"`);
  return res.send(csv);
});

void compile;
void OPERATORS;
export default router;
