/**
 * Custom dashboard panels (P2-17b).
 *
 * A panel is a saved question — "how many warm leads by source, this quarter" —
 * and this compiles it to SQL and runs it. Three things make that harder than
 * it sounds, and all three are why this file exists rather than a query builder
 * on the client.
 *
 * 1. A SHARED DASHBOARD SHOWS EACH VIEWER THEIR OWN DATA
 *
 * Q-13, and the whole reason the definition is stored rather than the result. A
 * supervisor builds "my team's pipeline by stage" and shares it; every viewer
 * runs the same definition through their own scope, so an RM sees their book
 * and the supervisor sees the team's. Sharing a dashboard must never share the
 * rows behind it. The scope is applied here, on every panel, every time — never
 * baked into the saved definition where it could go stale or be edited out.
 *
 * 2. FIELD NAMES REACH SQL, VALUES NEVER DO
 *
 * A grouping is a column name and cannot be a bound parameter. So every field
 * an administrator names is checked against `field_def` for that entity before
 * it is interpolated, and anything not found is refused. Values are always
 * parameters. That whitelist is the entire injection defence and is the reason
 * nothing here builds a string from user input without a lookup first.
 *
 * 3. A PANEL MUST NOT BE ABLE TO HURT THE DATABASE
 *
 * Groupings are capped, results are capped, and a panel that names an unknown
 * field fails loudly rather than returning everything. P2-17d's lesson applies:
 * a panel that fails must say so rather than quietly not being there.
 */

import { all, one } from '../db.js';
import { leadScope, clientScope, orgsFor, activeOrg } from '../auth.js';
import { fieldsOf } from './metadata.js';
import { OPERATORS } from './validation.js';

/** How many groups a chart may return, whatever the administrator asks for. */
export const MAX_GROUPS = 20;

/**
 * What a panel can be built from.
 *
 * `scope` is the function that narrows rows to what the viewer may see. Every
 * source must have one — a source without a scope is a cross-book leak with a
 * chart on top, so this is a required field rather than an optional refinement.
 */
export const SOURCES = {
  lead: {
    label: 'Leads',
    entity: 'lead',
    table: 'leads',
    alias: 'l',
    dateColumn: 'created_at',
    soft: 'l.deleted_at IS NULL',
    scope: (user, org) => leadScope(user, 'l', org),
  },
  client: {
    label: 'Clients',
    entity: 'client',
    table: 'clients',
    alias: 'c',
    dateColumn: 'created_at',
    soft: 'c.deleted_at IS NULL',
    scope: (user, org) => clientScope(user, 'c', org),
  },
  case: {
    label: 'Cases',
    entity: 'case',
    table: 'tickets',
    alias: 't',
    dateColumn: 'created_at',
    soft: 't.merged_into IS NULL',
    /* Cases carry their own book. There is no capability gate on reading them
       today — recorded as §6a of the security record and awaiting a decision —
       so this holds the boundary that does exist. */
    scope: (user) => {
      const orgs = orgsFor(user);
      return { sql: `t.sales_org IN (${orgs.map(() => '?').join(',') || "''"})`, params: orgs };
    },
  },
  activity: {
    label: 'Interactions',
    entity: 'interaction',
    table: 'activities',
    alias: 'a',
    dateColumn: 'created_at',
    soft: '1=1',
    /* An interaction has no book of its own; it belongs to its lead. Scoping
       through the lead is the only correct answer, and it is why this is a
       subquery rather than a column comparison. */
    scope: (user, org) => {
      const inner = leadScope(user, 'il', org);
      return {
        sql: `(a.lead_id IS NULL OR EXISTS (SELECT 1 FROM leads il WHERE il.id = a.lead_id
               AND il.deleted_at IS NULL AND ${inner.sql}))`,
        params: inner.params,
      };
    },
  },
};

/** The measures a panel can take. `count` needs no field; the rest do. */
export const MEASURES = {
  count: { label: 'Number of records', needsField: false, sql: () => 'COUNT(*)' },
  sum: { label: 'Total of', needsField: true, numeric: true, sql: (col) => `COALESCE(SUM(${col}), 0)` },
  avg: { label: 'Average of', needsField: true, numeric: true, sql: (col) => `COALESCE(AVG(${col}), 0)` },
  max: { label: 'Highest', needsField: true, numeric: true, sql: (col) => `COALESCE(MAX(${col}), 0)` },
  distinct: { label: 'Distinct values of', needsField: true, sql: (col) => `COUNT(DISTINCT ${col})` },
};

/* ------------------------------------------------------ the whitelist */

/**
 * Columns of this source that a panel may name.
 *
 * Only fields the metadata layer knows about, and only ones stored as a real
 * column — a `value`-stored custom field lives in another table and grouping by
 * it needs a join this does not do. Encrypted fields are excluded outright:
 * grouping by PAN would produce a chart whose labels are client identifiers.
 */
export function columnsFor(sourceKey) {
  const src = SOURCES[sourceKey];
  if (!src) return [];
  const real = new Set(all(`PRAGMA table_info(${src.table})`).map((c) => c.name));

  return fieldsOf(src.entity)
    .filter((f) => f.storage === 'column' && real.has(f.api_name) && !f.encrypted)
    .map((f) => ({
      api_name: f.api_name,
      label: f.label,
      type: f.type,
      groupable: !['textarea', 'richtext'].includes(f.type),
      numeric: ['number', 'currency', 'percent'].includes(f.type),
    }));
}

const columnOf = (sourceKey, apiName) =>
  columnsFor(sourceKey).find((c) => c.api_name === apiName) ?? null;

/* --------------------------------------------------------- compiling */

/**
 * A panel's filters, as SQL.
 *
 * Reuses the operator vocabulary from validation rules so an administrator
 * meets the same words in both places. A third condition language would be the
 * legacy audit's "one question, several mechanisms" all over again.
 */
export function compileFilters(sourceKey, condition, alias) {
  if (!condition) return { sql: '1=1', params: [] };
  const mode = Array.isArray(condition.any) ? 'any' : 'all';
  const clauses = condition[mode];
  if (!Array.isArray(clauses) || clauses.length === 0) return { sql: '1=1', params: [] };

  const parts = [];
  const params = [];

  for (const c of clauses) {
    const col = columnOf(sourceKey, c.field);
    // Refused, not skipped. A filter that silently does nothing shows a number
    // for a question nobody asked.
    if (!col) throw new Error(`"${c.field}" is not a field of ${SOURCES[sourceKey].label}`);
    if (!OPERATORS[c.op]) throw new Error(`"${c.op}" is not an operator`);

    const q = `${alias}.${col.api_name}`;
    switch (c.op) {
      case 'is_blank': parts.push(`(${q} IS NULL OR TRIM(${q}) = '')`); break;
      case 'is_not_blank': parts.push(`(${q} IS NOT NULL AND TRIM(${q}) != '')`); break;
      case 'eq': parts.push(`${q} = ?`); params.push(c.value); break;
      case 'ne': parts.push(`(${q} IS NULL OR ${q} != ?)`); params.push(c.value); break;
      case 'gt': parts.push(`CAST(${q} AS REAL) > ?`); params.push(Number(c.value)); break;
      case 'lt': parts.push(`CAST(${q} AS REAL) < ?`); params.push(Number(c.value)); break;
      case 'in':
      case 'not_in': {
        const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
        if (!list.length) { parts.push(c.op === 'in' ? '1=0' : '1=1'); break; }
        parts.push(`${q} ${c.op === 'in' ? 'IN' : 'NOT IN'} (${list.map(() => '?').join(',')})`);
        params.push(...list);
        break;
      }
      case 'matches': parts.push(`${q} LIKE ?`); params.push(`%${c.value}%`); break;
      case 'not_matches': parts.push(`(${q} IS NULL OR ${q} NOT LIKE ?)`); params.push(`%${c.value}%`); break;
      default:
        throw new Error(`"${c.op}" cannot be used in a dashboard filter`);
    }
  }

  return { sql: `(${parts.join(mode === 'any' ? ' OR ' : ' AND ')})`, params };
}

/**
 * Check a panel before it is stored, so a broken one cannot be saved.
 *
 * Returns null when fine, or the reason. The same rule as validation rules: a
 * definition that can never work is worse than none, because it sits on a
 * dashboard looking like a number.
 */
export function validatePanel(panel = {}) {
  const src = SOURCES[panel.source];
  if (!src) return { error: 'Choose what the panel counts', field: 'source' };

  const measure = MEASURES[panel.measure?.fn ?? 'count'];
  if (!measure) return { error: `"${panel.measure?.fn}" is not a measure`, field: 'measure' };

  if (measure.needsField) {
    const col = columnOf(panel.source, panel.measure?.field);
    if (!col) return { error: `${measure.label} needs a field of ${src.label}`, field: 'measure' };
    if (measure.numeric && !col.numeric) {
      return { error: `${col.label} is not a number, so it cannot be totalled or averaged`, field: 'measure' };
    }
  }

  if (panel.group_by) {
    const col = columnOf(panel.source, panel.group_by);
    if (!col) return { error: `"${panel.group_by}" is not a field of ${src.label}`, field: 'group_by' };
    if (!col.groupable) {
      return { error: `${col.label} is free text — grouping by it makes one bar per record`, field: 'group_by' };
    }
  }

  if (!panel.group_by && panel.kind && panel.kind !== 'tile') {
    return { error: 'A chart needs something to group by. Without one this is a single number.', field: 'group_by' };
  }

  try {
    compileFilters(panel.source, panel.filters, src.alias);
  } catch (err) {
    return { error: err.message, field: 'filters' };
  }

  if (!panel.title || !String(panel.title).trim()) {
    return { error: 'Give the panel a title — it is what a reader sees', field: 'title' };
  }
  return null;
}

/* ----------------------------------------------------------- running */

/**
 * Run one panel for one viewer.
 *
 * `range` narrows by the source's own date column when the panel asks it to.
 * A panel that ignores the window is legitimate — "clients by segment" is a
 * standing figure, not a period one — so it is opt-in rather than assumed.
 */
export function runPanel(req, panel, range = null) {
  const src = SOURCES[panel.source];
  if (!src) throw new Error(`Unknown source "${panel.source}"`);

  const org = activeOrg(req);
  const scope = src.scope(req.user, org);
  const filters = compileFilters(panel.source, panel.filters, src.alias);

  const where = [src.soft, scope.sql, filters.sql];
  const params = [...scope.params, ...filters.params];

  if (range && panel.use_range !== false) {
    where.push(`date(${src.alias}.${src.dateColumn}) BETWEEN date(?) AND date(?)`);
    params.push(range.from, range.to);
  }

  const measure = MEASURES[panel.measure?.fn ?? 'count'];
  const measureCol = measure.needsField
    ? `${src.alias}.${columnOf(panel.source, panel.measure.field).api_name}`
    : null;
  const value = measure.sql(measureCol);

  if (!panel.group_by) {
    const row = one(
      `SELECT ${value} AS v FROM ${src.table} ${src.alias} WHERE ${where.join(' AND ')}`,
      params,
    );
    return { kind: 'tile', value: Number(row?.v ?? 0) };
  }

  const groupCol = `${src.alias}.${columnOf(panel.source, panel.group_by).api_name}`;
  const limit = Math.min(Number(panel.limit) || 8, MAX_GROUPS);

  const rows = all(
    `SELECT COALESCE(NULLIF(TRIM(${groupCol}), ''), 'Not set') AS label, ${value} AS value
       FROM ${src.table} ${src.alias}
      WHERE ${where.join(' AND ')}
      GROUP BY label
      ORDER BY value DESC
      LIMIT ${limit}`,
    params,
  );

  return {
    kind: panel.kind ?? 'bar',
    data: rows.map((r) => ({ label: String(r.label), value: Number(r.value) || 0 })),
  };
}

/** The catalogue the builder screen needs to offer choices without guessing. */
export const catalogue = () => ({
  sources: Object.entries(SOURCES).map(([key, s]) => ({
    key, label: s.label, columns: columnsFor(key),
  })),
  measures: Object.entries(MEASURES).map(([fn, m]) => ({
    fn, label: m.label, needs_field: m.needsField, numeric: Boolean(m.numeric),
  })),
  operators: Object.entries(OPERATORS)
    // Only the ones this file can compile to SQL.
    .filter(([op]) => !['longer_than', 'shorter_than'].includes(op))
    .map(([op, d]) => ({ op, label: d.label, takes_value: d.takesValue !== false })),
  kinds: [
    { kind: 'tile', label: 'A single number' },
    { kind: 'bar', label: 'Bar chart' },
    { kind: 'donut', label: 'Donut' },
  ],
  max_groups: MAX_GROUPS,
});
