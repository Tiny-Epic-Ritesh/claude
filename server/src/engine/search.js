/**
 * Advanced search — the same condition tree, over every object.
 *
 * WHAT THIS ADDS TO `conditions.js`
 * ---------------------------------
 * The condition engine already does the hard part: a recursive AND/OR tree with
 * nested groups, two evaluators kept honest against each other, and a registry
 * that makes SQL injection structurally impossible. It was lead-only, with 27
 * hand-written field definitions.
 *
 * This generalises that in three ways:
 *
 *   1. **Per-entity registries.** Each searchable object declares its base
 *      table and how a field maps to SQL.
 *   2. **Derived from metadata.** Registries are built from `field_def`, so a
 *      field an administrator adds in Setup becomes filterable with no code —
 *      the payoff for having built the metadata layer.
 *   3. **Custom fields.** A field in the value store is reached by a correlated
 *      subquery, so it filters like any column.
 *
 * A FILTER IS AN EXFILTRATION CHANNEL
 * -----------------------------------
 * This is the part nobody asks for and everybody needs. Someone who cannot read
 * a PAN must not be able to binary-search it either:
 *
 *     pan starts_with "A"   → 400 results
 *     pan starts_with "AB"  → 31
 *     pan starts_with "ABC" → 2
 *
 * Three dozen queries and the field is recovered without ever being displayed.
 * So field-level security applies to *filterable* fields, not only to returned
 * ones: a field the caller may not read is not in their registry at all, and a
 * condition naming it is rejected exactly like an unknown field.
 */

import { all, one } from '../db.js';
import { fieldsOf, entityDef, FIELD_TYPES } from './metadata.js';

/* --------------------------------------------------------- the objects */

/**
 * Every object advanced search can run over.
 *
 * `scope` names the function that narrows results to what the caller is
 * entitled to see. Search must never widen visibility — it is a different way
 * to ask, not a different answer.
 */
export const SEARCHABLE = {
  lead: {
    label: 'Leads',
    table: 'leads l',
    id: 'l.id',
    select: 'l.id, l.name, l.mobile, l.email, l.city, l.stage, l.source, l.owner_id, l.created_at',
    soft_delete: 'l.deleted_at IS NULL',
    scope: 'lead',
  },
  interaction: {
    label: 'Interactions',
    table: 'activities l',
    id: 'l.id',
    select: 'l.id, l.lead_id, l.type, l.direction, l.subject, l.disposition, l.duration_s, l.created_at, l.user_id',
    scope: 'interaction',
  },
  case: {
    label: 'Cases',
    table: 'tickets l',
    id: 'l.id',
    select: 'l.id, l.ref, l.subject, l.priority, l.status, l.assignee_id, l.lead_id, l.created_at',
    scope: 'none',
  },
  task: {
    label: 'Tasks',
    table: 'tasks l',
    id: 'l.id',
    select: 'l.id, l.title, l.kind, l.due_at, l.priority, l.status, l.assignee_id, l.lead_id',
    scope: 'none',
  },
  partner: {
    label: 'Partners',
    table: 'partners l',
    id: 'l.id',
    select: 'l.id, l.name, l.business_name, l.partner_code, l.partner_model, l.state_code, l.owner_id',
    scope: 'none',
  },
  campaign: {
    label: 'Campaigns',
    table: 'campaigns l',
    id: 'l.id',
    select: 'l.id, l.name, l.channel, l.status, l.sent, l.opened, l.clicked, l.scheduled_at, l.created_at',
    scope: 'none',
  },
  product_interest: {
    label: 'Product interests',
    table: 'product_cards l',
    id: 'l.id',
    select: 'l.id, l.lead_id, l.product_type_id, l.state, l.value, l.product_rm_id',
    scope: 'none',
  },
};

/* --------------------------------------------------------- operators */

const txt = (v) => (v == null ? '' : String(v));
const num = (v) => (v == null || v === '' ? NaN : Number(v));

/**
 * Every operator, with a SQL form and an in-memory form.
 *
 * The pair matters: the same tree must select the same rows whether it is
 * compiled to SQL for a search or evaluated in memory for a rule. Keeping both
 * beside each other is what makes a divergence obvious in review.
 */
export const OPERATORS = {
  eq: {
    label: 'is equal to', types: ['text', 'enum', 'number', 'date', 'boolean', 'user'], ci: true,
    sql: (c) => `${c} = ?`, params: (v) => [v],
    test: (a, b) => txt(a).toLowerCase() === txt(b).toLowerCase(),
  },
  neq: {
    label: 'is not equal to', types: ['text', 'enum', 'number', 'date', 'boolean', 'user'], ci: true,
    // A null is "not equal to" anything a user means by it. Without the
    // COALESCE, SQL drops every null row and the result quietly disagrees with
    // what the in-memory evaluator returns.
    sql: (c) => `COALESCE(${c}, '') != ?`, params: (v) => [v],
    test: (a, b) => txt(a).toLowerCase() !== txt(b).toLowerCase(),
  },
  contains: {
    label: 'contains', types: ['text', 'enum'], ci: true,
    sql: (c) => `${c} LIKE ?`, params: (v) => [`%${v}%`],
    test: (a, b) => txt(a).toLowerCase().includes(txt(b).toLowerCase()),
  },
  not_contains: {
    label: 'does not contain', types: ['text', 'enum'], ci: true,
    sql: (c) => `COALESCE(${c}, '') NOT LIKE ?`, params: (v) => [`%${v}%`],
    test: (a, b) => !txt(a).toLowerCase().includes(txt(b).toLowerCase()),
  },
  starts_with: {
    label: 'starts with', types: ['text', 'enum'], ci: true,
    sql: (c) => `${c} LIKE ?`, params: (v) => [`${v}%`],
    test: (a, b) => txt(a).toLowerCase().startsWith(txt(b).toLowerCase()),
  },
  ends_with: {
    label: 'ends with', types: ['text', 'enum'], ci: true,
    sql: (c) => `${c} LIKE ?`, params: (v) => [`%${v}`],
    test: (a, b) => txt(a).toLowerCase().endsWith(txt(b).toLowerCase()),
  },
  in: {
    label: 'is any of', types: ['text', 'enum', 'user'], ci: true, list: true,
    sql: (c, v) => `${c} IN (${list(v).map(() => '?').join(',')})`, params: (v) => list(v),
    test: (a, b) => list(b).map((x) => txt(x).toLowerCase()).includes(txt(a).toLowerCase()),
  },
  not_in: {
    label: 'is none of', types: ['text', 'enum', 'user'], ci: true, list: true,
    sql: (c, v) => `COALESCE(${c}, '') NOT IN (${list(v).map(() => '?').join(',')})`, params: (v) => list(v),
    test: (a, b) => !list(b).map((x) => txt(x).toLowerCase()).includes(txt(a).toLowerCase()),
  },
  gt: { label: 'is greater than', types: ['number', 'date'], sql: (c) => `${c} > ?`, params: (v) => [v], test: (a, b) => num(a) > num(b) },
  gte: { label: 'is at least', types: ['number', 'date'], sql: (c) => `${c} >= ?`, params: (v) => [v], test: (a, b) => num(a) >= num(b) },
  lt: { label: 'is less than', types: ['number', 'date'], sql: (c) => `${c} < ?`, params: (v) => [v], test: (a, b) => num(a) < num(b) },
  lte: { label: 'is at most', types: ['number', 'date'], sql: (c) => `${c} <= ?`, params: (v) => [v], test: (a, b) => num(a) <= num(b) },

  between: {
    label: 'is between', types: ['number', 'date'], list: true,
    sql: (c) => `${c} BETWEEN ? AND ?`, params: (v) => list(v).slice(0, 2),
    test: (a, b) => { const [lo, hi] = list(b); return num(a) >= num(lo) && num(a) <= num(hi); },
  },

  /**
   * The operators the user asked for by name.
   *
   * "Blank" and "not defined" are the same question in a CRM: a field is either
   * carrying something or it is not, and users do not distinguish NULL from ''.
   * Treating them separately would produce two operators that look identical
   * and disagree, which is worse than one that is slightly imprecise.
   */
  is_blank: {
    label: 'is blank', types: ['text', 'enum', 'number', 'date', 'boolean', 'user'], noValue: true,
    sql: (c) => `(${c} IS NULL OR ${c} = '')`, params: () => [],
    test: (a) => a == null || a === '',
  },
  is_not_blank: {
    label: 'is not blank', types: ['text', 'enum', 'number', 'date', 'boolean', 'user'], noValue: true,
    sql: (c) => `(${c} IS NOT NULL AND ${c} != '')`, params: () => [],
    test: (a) => a != null && a !== '',
  },

  is_true: {
    label: 'is yes', types: ['boolean'], noValue: true,
    sql: (c) => `${c} = 1`, params: () => [], test: (a) => Boolean(a) === true,
  },
  is_false: {
    label: 'is no', types: ['boolean'], noValue: true,
    sql: (c) => `COALESCE(${c}, 0) = 0`, params: () => [], test: (a) => !a,
  },

  /**
   * Relative dates, because "created in the last 30 days" is what people
   * actually want and a saved search with a hard date is wrong by tomorrow.
   */
  in_last_days: {
    label: 'is within the last N days', types: ['date'],
    sql: (c) => `${c} >= datetime('now', ?)`, params: (v) => [`-${Math.abs(Number(v) || 0)} days`],
    test: (a, b) => {
      const t = Date.parse(String(a).replace(' ', 'T') + (String(a).includes('Z') ? '' : 'Z'));
      return !Number.isNaN(t) && t >= Date.now() - Math.abs(Number(b) || 0) * 86_400_000;
    },
  },
  older_than_days: {
    label: 'is older than N days', types: ['date'],
    sql: (c) => `${c} < datetime('now', ?)`, params: (v) => [`-${Math.abs(Number(v) || 0)} days`],
    test: (a, b) => {
      const t = Date.parse(String(a).replace(' ', 'T') + (String(a).includes('Z') ? '' : 'Z'));
      return !Number.isNaN(t) && t < Date.now() - Math.abs(Number(b) || 0) * 86_400_000;
    },
  },
};

function list(v) {
  if (Array.isArray(v)) return v;
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Which operators make sense for a field of this type. */
export const operatorsFor = (type) =>
  Object.entries(OPERATORS)
    .filter(([, op]) => op.types.includes(type))
    .map(([key, op]) => ({ key, label: op.label, noValue: Boolean(op.noValue), list: Boolean(op.list) }));

/* ---------------------------------------------------------- registries */

/** Metadata field types → the condition types the operators speak. */
const TYPE_MAP = {
  text: 'text', textarea: 'text', richtext: 'text', email: 'text', phone: 'text',
  url: 'text', encrypted_text: 'text', time: 'text', address: 'text',
  picklist: 'enum', multipicklist: 'enum',
  number: 'number', currency: 'number', percent: 'number',
  date: 'date', datetime: 'date',
  checkbox: 'boolean',
  lookup: 'user', polymorphic_lookup: 'text',
};

/**
 * The fields this caller may filter on, for this object.
 *
 * Built from metadata, so it follows Setup. Field-level security is applied
 * here and nowhere else — a field missing from this map cannot be named in a
 * condition, because `compile()` looks every field up in it.
 */
export function registryFor(entity, user, caps = new Set()) {
  const spec = SEARCHABLE[entity];
  if (!spec) return null;

  const reg = {};

  for (const f of fieldsOf(entity)) {
    const type = TYPE_MAP[f.type];
    if (!type) continue;
    if (FIELD_TYPES[f.type]?.derived) continue;   // computed on read, not in SQL

    // The exfiltration gate. A field the caller cannot read is not offered,
    // and therefore cannot be probed a character at a time.
    if (f.read_scope === 'capability') {
      if (!f.read_capability || !caps.has(f.read_capability)) continue;
    }
    if (f.read_scope === 'owner_or_manager') continue;   // per-record, not expressible in a filter

    reg[f.api_name] = {
      label: f.label,
      type,
      custom: f.storage === 'value',
      // A core field is a column; a custom field is a correlated subquery
      // against the value store. Both are safe because neither string comes
      // from the request.
      sql: f.storage === 'value'
        ? `(SELECT ${storeColumnFor(f.type)} FROM field_value fv
            WHERE fv.entity = '${entity}' AND fv.record_id = ${spec.id} AND fv.field_id = ${Number(f.id)})`
        : `l.${f.api_name}`,
      values: f.type === 'picklist' || f.type === 'multipicklist' ? undefined : undefined,
    };
  }

  return reg;
}

const storeColumnFor = (type) => ({
  number: 'num_value', currency: 'num_value', percent: 'num_value',
  date: 'date_value', datetime: 'date_value',
  checkbox: 'bool_value',
}[type] ?? 'text_value');

/* ------------------------------------------------------------ compile */

const MAX_DEPTH = 6;
const MAX_NODES = 60;

/**
 * Validate a tree before it is compiled.
 *
 * Depth and node caps are not arbitrary: a tree is user input, and a deeply
 * nested one is both unreadable and a way to make the planner work very hard.
 * Six levels is more than any real question needs.
 */
export function validateTree(node, registry, depth = 0, count = { n: 0 }) {
  if (!node || typeof node !== 'object') return 'A condition is missing';
  if (depth > MAX_DEPTH) return `Conditions are nested more than ${MAX_DEPTH} deep`;
  if ((count.n += 1) > MAX_NODES) return `A search may not have more than ${MAX_NODES} conditions`;

  if (node.op === 'AND' || node.op === 'OR') {
    if (!Array.isArray(node.children) || node.children.length === 0) {
      return `An ${node.op} group has no conditions in it`;
    }
    for (const child of node.children) {
      const err = validateTree(child, registry, depth + 1, count);
      if (err) return err;
    }
    return null;
  }

  const field = registry[node.field];
  if (!field) return `"${node.field}" is not a field you can filter on`;

  const op = OPERATORS[node.operator];
  if (!op) return `"${node.operator}" is not an operator`;
  if (!op.types.includes(field.type)) {
    return `${field.label} is ${field.type}; "${op.label}" does not apply to it`;
  }
  if (!op.noValue && (node.value == null || node.value === '')) {
    return `${field.label} "${op.label}" needs a value`;
  }
  return null;
}

/**
 * Tree → `{ sql, params }`.
 *
 * Two rules, neither relaxable: field names come from the registry, values are
 * always bound. The registry is built per user, so this is also where
 * field-level security ends up enforced.
 */
export function compile(node, registry) {
  if (node.op === 'AND' || node.op === 'OR') {
    const parts = node.children.map((c) => compile(c, registry));
    return {
      sql: `(${parts.map((p) => p.sql).join(` ${node.op} `)})`,
      params: parts.flatMap((p) => p.params),
    };
  }

  const field = registry[node.field];
  const op = OPERATORS[node.operator];

  // Case-insensitive comparison has to fold both sides or the two evaluators
  // disagree — the exact bug that shipped in the first condition compiler.
  const foldable = op.ci && ['text', 'enum', 'user'].includes(field.type);
  const column = foldable ? `LOWER(${field.sql})` : field.sql;
  const params = op.params(node.value);

  return {
    sql: op.sql(column, node.value),
    params: foldable ? params.map((p) => (typeof p === 'string' ? p.toLowerCase() : p)) : params,
  };
}

/** The in-memory twin, for testing the compiler against itself. */
export function evaluate(node, record, registry) {
  if (node.op === 'AND') return node.children.every((c) => evaluate(c, record, registry));
  if (node.op === 'OR') return node.children.some((c) => evaluate(c, record, registry));

  const op = OPERATORS[node.operator];
  if (!op) return false;
  return op.test(record[node.field], node.value);
}

/** Plain English, for a saved search's description. */
export function describe(node, registry, depth = 0) {
  if (node.op === 'AND' || node.op === 'OR') {
    const inner = node.children.map((c) => describe(c, registry, depth + 1)).join(` ${node.op.toLowerCase()} `);
    return depth === 0 ? inner : `(${inner})`;
  }
  const field = registry[node.field];
  const op = OPERATORS[node.operator];
  if (!field || !op) return '…';
  return op.noValue
    ? `${field.label} ${op.label}`
    : `${field.label} ${op.label} ${Array.isArray(node.value) ? node.value.join(', ') : node.value}`;
}

/* ------------------------------------------------------------- search */

const SORTABLE = /^[a-z_][a-z0-9_]*$/i;

/**
 * Run a search.
 *
 * `scopeSql` is supplied by the caller — the route knows how to narrow leads to
 * what this user may see, and search must not invent its own answer to that.
 */
export function runSearch(entity, tree, {
  registry, scopeSql = null, scopeParams = [], limit = 50, offset = 0, sort, dir = 'DESC',
}) {
  const spec = SEARCHABLE[entity];
  if (!spec) throw new Error(`${entity} is not searchable`);

  const where = [];
  const params = [];

  if (spec.soft_delete) where.push(spec.soft_delete);
  if (scopeSql) { where.push(`(${scopeSql})`); params.push(...scopeParams); }

  if (tree) {
    const compiled = compile(tree, registry);
    where.push(compiled.sql);
    params.push(...compiled.params);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = one(`SELECT COUNT(*) n FROM ${spec.table} ${clause}`, params).n;

  // Sort column comes from the registry, never from the request string.
  const sortCol = sort && registry[sort] && !registry[sort].custom ? `l.${sort}` : spec.id;
  const order = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const rows = all(
    `SELECT ${spec.select} FROM ${spec.table} ${clause} ORDER BY ${SORTABLE.test(sortCol.replace('l.', '')) ? sortCol : spec.id} ${order} LIMIT ? OFFSET ?`,
    [...params, Math.min(Number(limit) || 50, 500), Number(offset) || 0],
  );

  return { total, rows, limit: Number(limit) || 50, offset: Number(offset) || 0 };
}

/** Every id a search matches — for bulk actions and for building a list. */
export function searchIds(entity, tree, { registry, scopeSql = null, scopeParams = [], cap = 10_000 }) {
  const spec = SEARCHABLE[entity];
  const where = [];
  const params = [];

  if (spec.soft_delete) where.push(spec.soft_delete);
  if (scopeSql) { where.push(`(${scopeSql})`); params.push(...scopeParams); }
  if (tree) {
    const compiled = compile(tree, registry);
    where.push(compiled.sql);
    params.push(...compiled.params);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return all(`SELECT ${spec.id} AS id FROM ${spec.table} ${clause} LIMIT ?`, [...params, cap])
    .map((r) => r.id);
}

export const searchableObjects = () =>
  Object.entries(SEARCHABLE).map(([key, s]) => ({
    key, label: s.label, entity: entityDef(key)?.label ?? s.label,
  }));
