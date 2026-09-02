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
import {
  requireUser, requirePermission, reqScope, reqClientScope, reqTicketScope, orgsFor, maskFor, can,
} from '../auth.js';
import { maskRecords } from '../security.js';
import {
  SEARCHABLE, registryFor, validateTree, compile, runSearch, searchIds,
  operatorsFor, describe, searchableObjects, capabilityFor, OPERATORS,
} from '../engine/search.js';
import { picklistValues, fieldDef } from '../engine/metadata.js';
import { defaultExpiry } from '../engine/leadlists.js';

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

  /* Clients carry their own scope for the same reason leads do: the generic
     branch below only applies the sales_org boundary, and client visibility is
     also a role question. Falling through would have let a role holding
     client.view.own read the whole book through the search box — the search
     path quietly granting what the list path refuses. */
  if (entity === 'client') {
    const s = reqClientScope(req, 'l');
    return { sql: s.sql, params: s.params };
  }

  /* Cases, for the same reason, and it was not hypothetical here. `tickets`
     carries a sales_org column, so the generic branch below found one and
     applied the book boundary — which made the gap invisible while leaving
     every role rule off. A dealer who could open one case in the Cases tab
     could read all twelve in the business through the search box; a caller,
     three of twelve. Search is a different way to ask, never a different
     answer. */
  if (entity === 'case') {
    const s = reqTicketScope(req, 'l');
    return { sql: s.sql, params: s.params };
  }

  /* Tasks and interactions carry no sales_org of their own, and the generic
     branch below gives up when it cannot find that column — it returns no
     scope at all rather than failing closed. So advanced search over these two
     returned every task and every interaction in the system, both books, to
     anybody signed in: 194 interactions with their subjects, bodies,
     dispositions, recording URLs and captured locations, and 46 tasks each
     labelled with its lead's name.

     Both hang off a lead, and a lead carries the book. This is the same rule
     the /tasks list already applies — and the comment there describes exactly
     this shape of bug, from the last time a list route was assumed filtered. */
  if (entity === 'interaction') {
    const lead = reqScope(req, 'sl');
    const orgs = orgsFor(req.user);
    /* An interaction with no lead is a partner interaction — 18 of them here
       and no other kind. A partner carries a book, so it is scoped through
       that rather than left visible for want of a lead. */
    const partner = orgs.length
      ? `EXISTS (SELECT 1 FROM partners sp WHERE sp.id = l.partner_id
                  AND sp.sales_org IN (${orgs.map(() => '?').join(',')}))`
      : '1=0';
    return {
      sql: `(EXISTS (SELECT 1 FROM leads sl WHERE sl.id = l.lead_id
                      AND sl.deleted_at IS NULL AND ${lead.sql})
             OR (l.lead_id IS NULL AND ${partner}))`,
      params: [...lead.params, ...(orgs.length ? orgs : [])],
    };
  }

  if (entity === 'task') {
    const lead = reqScope(req, 'sl');
    const where = [`(l.lead_id IS NULL OR EXISTS (
      SELECT 1 FROM leads sl WHERE sl.id = l.lead_id AND sl.deleted_at IS NULL AND ${lead.sql}))`];
    const params = [...lead.params];
    /* The Tasks list shows your own unless you hold report.team and ask for
       everyone's. Search has no "ask for everyone's", so it grants the wider
       view to exactly the people the list would. */
    if (!can(req.user.role, 'report.team')) {
      where.push('l.assignee_id = ?');
      params.push(req.user.id);
    }
    return { sql: where.join(' AND '), params };
  }

  /* Partners narrow twice: by book, and — for a Partner RM — to the partners
     they own, which is what the Partners tab does. The generic branch below
     applies only the first, so an RM would have read the whole book's partners
     here while their own tab showed them theirs. */
  if (entity === 'partner') {
    const orgs = orgsFor(req.user);
    const where = orgs.length ? [`l.sales_org IN (${orgs.map(() => '?').join(',')})`] : ['1=0'];
    const params = orgs.length ? [...orgs] : [];
    if (req.user.role === 'partner_rm') {
      where.push('l.owner_id = ?');
      params.push(req.user.id);
    }
    return { sql: where.join(' AND '), params };
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

/**
 * The capability an object requires before it may be searched at all.
 *
 * Search-advanced had no per-object gate: it required a session and nothing
 * else, so any signed-in user could read every partner and every campaign
 * through it while the tabs those objects live on answered 403. Applied as
 * middleware on every route that names an entity, because the hole was not one
 * route being wrong — it was the check never existing, and adding it to the
 * search route alone would leave count, ids, save and export open.
 */
function requireSearchable(req, res, next) {
  const { entity } = req.params;
  const needed = capabilityFor(entity);
  if (needed && !req.caps?.has(needed)) {
    return res.status(403).json({
      error: `Your role (${req.user.role}) cannot search ${SEARCHABLE[entity]?.label ?? entity}`,
      required: needed,
    });
  }
  return next();
}

/* ---------------------------------------------------------- the fields */

/** What can be searched, and with which operators. */
router.get('/objects', (req, res) => res.json(searchableObjects(req.caps)));


/**
 * Ready-made filters (ENH-15).
 *
 * The complaint was that nobody knew what to do with an empty builder. A
 * starter is not a shortcut around learning it -- it loads a real tree into the
 * builder, so the first thing somebody sees is a working example of the thing
 * they were being asked to construct from nothing. Editing one is how most
 * people will learn the grammar.
 *
 * Only starters whose fields actually exist for this user are offered, so a
 * field hidden by field-level security never appears as a broken suggestion.
 */
const STARTERS = {
  lead: [
    {
      name: 'Qualified, no follow-up booked',
      why: 'Interest with nothing scheduled behind it -- the most common way a warm lead goes cold.',
      tree: { op: 'AND', children: [
        { field: 'stage', operator: 'in', value: ['Qualified'] },
        { field: 'next_follow_up_at', operator: 'is_blank' },
      ] },
    },
    {
      name: 'Arrived in the last 30 days',
      why: 'Everything new, whoever owns it.',
      tree: { op: 'AND', children: [
        { field: 'created_at', operator: 'in_last_days', value: 30 },
      ] },
    },
    {
      name: 'No mobile on record',
      why: 'Data to fix before a calling campaign.',
      tree: { op: 'AND', children: [
        { field: 'mobile', operator: 'is_blank' },
      ] },
    },
    {
      name: 'Must be excluded from a send',
      why: 'Opted out of marketing, or the number is flagged bad.',
      tree: { op: 'OR', children: [
        { field: 'marketing_opt_out', operator: 'is_true' },
        { field: 'mobile_invalid', operator: 'is_true' },
      ] },
    },
  ],
};

/**
 * Offer only starters that actually work for this user.
 *
 * Validated against the live registry rather than eyeballed, because a starter
 * naming a field that does not exist, or an operator that does not apply to its
 * type, is worse than no starter at all -- it is a suggestion that fails the
 * moment somebody trusts it. Two of the first four written here did exactly
 * that, and this is what caught them.
 *
 * It also means a field hidden from this user by field-level security silently
 * removes the starters that depend on it, rather than showing them a broken one.
 */
function startersFor(entity, registry) {
  return (STARTERS[entity] ?? []).filter((s) => {
    const problem = validateTree(s.tree, registry);
    if (problem) {
      console.warn(`[search] starter "${s.name}" is not valid and was not offered: ${problem}`);
      return false;
    }
    return true;
  });
}

router.get('/fields/:entity', requireSearchable, (req, res) => {
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
    starters: startersFor(req.params.entity, registry),
  });
});

/* --------------------------------------------------------------- run */

router.post('/:entity', requireSearchable, (req, res) => {
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
router.post('/:entity/count', requireSearchable, (req, res) => {
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
  // The plain-English reading travels with the count (ENH-15). The builder
  // shows both together, so somebody who cannot parse a nested AND/OR tree can
  // still read what they have built and see how many it finds.
  return res.json({
    total,
    described: tree ? describe(tree, registry) : 'Everything you can see',
  });
});

/* ------------------------------------------------------ saved segments */

/**
 * Save a search as a segment.
 *
 * Stored as a query, never as a membership list — non-negotiable 10. A segment
 * saved today and opened in March returns March's answer, which is the only
 * behaviour anyone actually wants from something called "at-risk leads".
 */
router.post('/:entity/save', requireSearchable, requirePermission('list.create'), (req, res) => {
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

router.get('/saved/:entity', requireSearchable, (req, res) => {
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
router.post('/:entity/ids', requireSearchable, (req, res) => {
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

  /* This freezes a search into rows, which makes it a snapshot like any other,
     so it carries the same two obligations: a reason, and a date it stops being
     trusted. Saving a search is the easiest way in the product to make a list,
     and a route that skipped governance here would be the hole the whole rule
     drains through — 4,810 lists in the legacy tenant were made exactly this
     way. The reason writes itself, because the search itself is the reason. */
  const list = run(
    `INSERT INTO lead_lists
       (name, description, created_by, owner_id, kind, sales_org, snapshot_reason, expires_at)
     VALUES (?,?,?,?, 'static', ?,?,?)`,
    [name.trim(), where ? describe(where, registry) : 'Everything visible',
      req.user.id, req.user.id, req.user.sales_org,
      'Saved from an advanced search', defaultExpiry()],
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
 *
 * That last sentence described an intention rather than the code for as long as
 * this route existed: rows went from the query straight into the CSV, so every
 * mobile and email left in the clear for anybody holding data.export, on every
 * object. Unmasking is a second permission and a deliberate act — `?unmask=true`
 * with pii.unmask — and it writes its own audit row when used.
 */
router.post('/:entity/export', requireSearchable, requirePermission('data.export'), (req, res) => {
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
    // Whether identifiers left in the clear is the first thing asked about an
    // export after the fact, so it is recorded rather than inferred.
    unmasked: req.query?.unmask === 'true',
  });

  /* The same masking the list screens apply. An export that skipped it would be
     the one path in the product where field-level security did not hold, and it
     is the path that puts the data on a laptop. */
  const visible = maskRecords(rows, maskFor(req, entity));

  const headers = visible.length ? Object.keys(visible[0]) : [];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    headers.join(','),
    ...visible.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${entity}-export.csv"`);
  return res.send(csv);
});

void compile;
void OPERATORS;
export default router;
