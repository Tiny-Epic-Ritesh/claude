/**
 * Conditions — one recursive query model, shared by everything that filters.
 *
 * WHY THIS EXISTS
 * ---------------
 * The audit's Finding 8 is the clearest cause-and-effect in the whole document.
 * LeadSquared's Advanced Search offers a flat "Any Criteria / All Criteria"
 * across rows — you cannot express `(A AND B) OR (C AND D)`. So people leave the
 * product, segment in Excel, and re-import the result as a static list. The
 * tenant has **4,810 lists against 495,118 leads**, with names like
 * `All Active Clients 210826.csv`.
 *
 * The lists are the symptom. The missing nesting is the disease.
 *
 * Before this module the CRM had both halves of the same trap: rule conditions
 * were a flat array, the assignment engine ANDed them unconditionally, and lead
 * lists stored membership rows. This replaces all three with one tree.
 *
 * THE SHAPE
 * ---------
 *   group  { op: 'AND' | 'OR', children: [ node, ... ] }
 *   leaf   { field, operator, value }
 *
 * Arbitrarily nested, so `(A AND B) OR (C AND D)` is expressible, and so is
 * anything else the desk can think of.
 *
 * TWO EVALUATORS, ONE TREE
 * ------------------------
 *   evaluate()  in memory, against a facts object — for automation rules
 *               deciding about one record they already hold.
 *   toSql()     compiled to SQL — for segments, which must run over the whole
 *               book without loading it.
 *
 * They must agree. A segment that previews 200 leads and then acts on 190 is
 * worse than no segment, so the two are tested against each other rather than
 * assumed equivalent.
 *
 * SAFETY
 * ------
 * `toSql()` builds SQL from user input, which is the classic injection surface.
 * Two rules make it safe, and neither may be relaxed:
 *   1. Field names are looked up in FIELDS. Anything not in the registry is
 *      rejected — the caller's string never reaches the query.
 *   2. Values are always bound parameters. Never interpolated. Not once.
 */

import { kycStatusSql } from './kycstatus.js';

/* ------------------------------------------------------------ registry */

/**
 * Every field a condition may test, with the SQL that reaches it.
 *
 * `sql` is a fragment against `leads l`. Anything requiring a join is written
 * as a correlated subquery, so the caller never has to know the shape.
 */
export const FIELDS = {
  // --- lead columns -------------------------------------------------
  name: { label: 'Name', type: 'text', sql: 'l.name' },
  mobile: { label: 'Mobile', type: 'text', sql: 'l.mobile' },
  email: { label: 'Email', type: 'text', sql: 'l.email' },
  city: { label: 'City', type: 'text', sql: 'l.city' },
  state: { label: 'State', type: 'text', sql: 'l.state' },
  language: { label: 'Language', type: 'enum', sql: 'l.language' },
  source: { label: 'Source', type: 'enum', sql: 'l.source' },
  stage: { label: 'Stage', type: 'enum', sql: 'l.stage' },
  risk_profile: { label: 'Risk profile', type: 'enum', sql: 'l.risk_profile' },
  sales_org: { label: 'Sales org', type: 'enum', sql: 'l.sales_org' },
  owner_id: { label: 'Owner', type: 'user', sql: 'l.owner_id' },
  client_code: { label: 'Client code', type: 'text', sql: 'l.client_code' },

  // --- flags --------------------------------------------------------
  mobile_invalid: { label: 'Mobile flagged invalid', type: 'boolean', sql: 'l.mobile_invalid' },
  marketing_opt_out: { label: 'Opted out of marketing', type: 'boolean', sql: 'l.marketing_opt_out' },
  partner_linked: {
    label: 'Sourced by a partner', type: 'boolean',
    sql: 'CASE WHEN l.partner_id IS NOT NULL THEN 1 ELSE 0 END',
  },

  // --- dates and ages -----------------------------------------------
  created_at: { label: 'Created', type: 'date', sql: 'l.created_at' },
  updated_at: { label: 'Last updated', type: 'date', sql: 'l.updated_at' },
  next_follow_up_at: { label: 'Next follow-up', type: 'date', sql: 'l.next_follow_up_at' },
  lead_age_days: {
    label: 'Lead age (days)', type: 'number',
    sql: "CAST(julianday('now') - julianday(l.created_at) AS INTEGER)",
  },
  days_since_contact: {
    label: 'Days since last contact', type: 'number',
    sql: `COALESCE(CAST(julianday('now') - julianday((
            SELECT MAX(created_at) FROM activities a
            WHERE a.lead_id = l.id
              AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
          )) AS INTEGER), 9999)`,
  },

  // --- derived counts -----------------------------------------------
  open_ticket_count: {
    label: 'Open cases', type: 'number',
    sql: "(SELECT COUNT(*) FROM tickets t WHERE t.lead_id = l.id AND t.status NOT IN ('Resolved','Closed'))",
  },
  activity_count: {
    label: 'Total activities', type: 'number',
    sql: '(SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id)',
  },
  connect_count: {
    label: 'Connected calls', type: 'number',
    sql: "(SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id AND a.outcome = 'Connected')",
  },
  active_product_count: {
    label: 'Products held', type: 'number',
    sql: "(SELECT COUNT(*) FROM product_cards pc WHERE pc.lead_id = l.id AND pc.state = 'ACTIVE')",
  },

  // --- related-entity tests -----------------------------------------
  product_card_state: {
    label: 'Has a card in state', type: 'enum',
    // The value is the state; the operator is implicitly "has a card that is".
    sql: `(SELECT GROUP_CONCAT(pc.state) FROM product_cards pc WHERE pc.lead_id = l.id AND pc.state != 'INACTIVE')`,
    multi: true,
  },
  kyc_status: {
    label: 'KYC status', type: 'enum',
    // One definition, shared with every other reader — see engine/kycstatus.js.
    sql: kycStatusSql('l'),
  },
  last_disposition: {
    label: 'Last call outcome', type: 'enum',
    sql: `(SELECT a.sub_disposition FROM activities a
           WHERE a.lead_id = l.id AND a.sub_disposition IS NOT NULL
           ORDER BY a.created_at DESC LIMIT 1)`,
  },
};

/* ----------------------------------------------------------- operators */

/**
 * Each operator carries both implementations, side by side, so a change to one
 * without the other is visible in review rather than discovered in production.
 */
const OPERATORS = {
  eq: {
    ci: true,
    label: 'is',
    types: ['text', 'enum', 'number', 'boolean', 'user', 'date'],
    test: (a, b) => norm(a) === norm(b),
    sql: (col) => `${col} = ?`,
    params: (v) => [v],
  },
  neq: {
    ci: true,
    label: 'is not',
    types: ['text', 'enum', 'number', 'boolean', 'user', 'date'],
    // NULL is "not equal to X" in the sense a user means, which SQL disagrees with.
    test: (a, b) => norm(a) !== norm(b),
    sql: (col) => `(${col} IS NULL OR ${col} != ?)`,
    params: (v) => [v],
  },
  contains: {
    ci: true,
    label: 'contains',
    types: ['text'],
    test: (a, b) => norm(a).includes(norm(b)),
    sql: (col) => `${col} LIKE ?`,
    params: (v) => [`%${v}%`],
  },
  not_contains: {
    ci: true,
    label: 'does not contain',
    types: ['text'],
    test: (a, b) => !norm(a).includes(norm(b)),
    sql: (col) => `(${col} IS NULL OR ${col} NOT LIKE ?)`,
    params: (v) => [`%${v}%`],
  },
  starts_with: {
    ci: true,
    label: 'starts with',
    types: ['text'],
    test: (a, b) => norm(a).startsWith(norm(b)),
    sql: (col) => `${col} LIKE ?`,
    params: (v) => [`${v}%`],
  },
  in: {
    ci: true,
    label: 'is any of',
    types: ['text', 'enum', 'user'],
    test: (a, b) => list(b).includes(norm(a)),
    sql: (col, v) => `${col} IN (${list(v).map(() => '?').join(',') || 'NULL'})`,
    params: (v) => list(v),
  },
  not_in: {
    ci: true,
    label: 'is none of',
    types: ['text', 'enum', 'user'],
    test: (a, b) => !list(b).includes(norm(a)),
    sql: (col, v) => `(${col} IS NULL OR ${col} NOT IN (${list(v).map(() => '?').join(',') || 'NULL'}))`,
    params: (v) => list(v),
  },
  gt: { label: 'is greater than', types: ['number', 'date'], test: (a, b) => num(a) > num(b), sql: (c) => `${c} > ?`, params: (v) => [v] },
  gte: { label: 'is at least', types: ['number', 'date'], test: (a, b) => num(a) >= num(b), sql: (c) => `${c} >= ?`, params: (v) => [v] },
  lt: { label: 'is less than', types: ['number', 'date'], test: (a, b) => num(a) < num(b), sql: (c) => `${c} < ?`, params: (v) => [v] },
  lte: { label: 'is at most', types: ['number', 'date'], test: (a, b) => num(a) <= num(b), sql: (c) => `${c} <= ?`, params: (v) => [v] },
  between: {
    label: 'is between',
    types: ['number', 'date'],
    test: (a, b) => { const [lo, hi] = list(b); return num(a) >= num(lo) && num(a) <= num(hi); },
    sql: (col) => `${col} BETWEEN ? AND ?`,
    params: (v) => list(v).slice(0, 2),
  },
  is_set: {
    label: 'has a value',
    types: ['text', 'enum', 'number', 'date', 'user'],
    test: (a) => a != null && String(a).trim() !== '',
    sql: (col) => `(${col} IS NOT NULL AND ${col} != '')`,
    params: () => [],
  },
  is_empty: {
    label: 'is empty',
    types: ['text', 'enum', 'number', 'date', 'user'],
    test: (a) => a == null || String(a).trim() === '',
    sql: (col) => `(${col} IS NULL OR ${col} = '')`,
    params: () => [],
  },
  is_true: {
    label: 'is yes',
    types: ['boolean'],
    test: (a) => a === 1 || a === true || norm(a) === 'yes' || norm(a) === 'true',
    sql: (col) => `${col} = 1`,
    params: () => [],
  },
  is_false: {
    label: 'is no',
    types: ['boolean'],
    test: (a) => !(a === 1 || a === true || norm(a) === 'yes' || norm(a) === 'true'),
    sql: (col) => `(${col} = 0 OR ${col} IS NULL)`,
    params: () => [],
  },
  within_days: {
    label: 'is within the last (days)',
    types: ['date'],
    test: (a, b) => {
      if (!a) return false;
      const at = new Date(String(a).replace(' ', 'T') + (String(a).endsWith('Z') ? '' : 'Z')).getTime();
      return Number.isFinite(at) && Date.now() - at <= num(b) * 86_400_000;
    },
    sql: (col) => `${col} >= datetime('now', ?)`,
    params: (v) => [`-${Math.abs(num(v))} days`],
  },
  // For fields that hold several values at once (a lead's set of card states).
  has_any: {
    ci: true,
    label: 'includes any of',
    types: ['enum'],
    test: (a, b) => list(a).some((x) => list(b).includes(x)),
    sql: (col, v) => `(${list(v).map(() => `${col} LIKE ?`).join(' OR ') || '1=0'})`,
    params: (v) => list(v).map((x) => `%${x}%`),
  },
};

const norm = (v) => String(v ?? '').trim().toLowerCase();
const num = (v) => (v == null ? NaN : Number(v));
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => norm(x)).filter((x) => x !== '');

export const operatorsForType = (type) =>
  Object.entries(OPERATORS)
    .filter(([, o]) => o.types.includes(type))
    .map(([code, o]) => ({ code, label: o.label }));

/** The whole vocabulary, for the query-builder UI. */
/**
 * Operators that take no value, and operators that take several.
 *
 * A builder has to know both or it draws the wrong control: a text box beside
 * "is empty" invites somebody to type into a field that is ignored, and a
 * single-value box beside "is any of" makes a list operator behave like an
 * equality one. Declared here rather than guessed in the interface, so the
 * builder and the compiler cannot disagree about what an operator means.
 */
export const NO_VALUE_OPERATORS = new Set(['is_set', 'is_empty', 'is_true', 'is_false']);
export const LIST_OPERATORS = new Set(['in', 'not_in', 'has_any', 'between']);

export const conditionSchema = () => ({
  fields: Object.entries(FIELDS).map(([code, f]) => ({
    code, label: f.label, type: f.type, operators: operatorsForType(f.type),
  })),
  operators: Object.entries(OPERATORS).map(([code, o]) => ({
    code,
    label: o.label,
    types: o.types,
    arity: NO_VALUE_OPERATORS.has(code) ? 0 : 1,
    list: LIST_OPERATORS.has(code),
  })),
});

/* ---------------------------------------------------------- validation */

const isGroup = (node) => node && typeof node === 'object' && Array.isArray(node.children);

/**
 * Validate a tree, returning every problem rather than the first.
 *
 * A builder UI wants to mark all the broken rows at once; stopping at the first
 * error makes fixing a large rule a series of round trips.
 */
export function validateTree(node, path = 'root', errors = []) {
  if (!node || typeof node !== 'object') {
    errors.push({ path, error: 'Not a condition' });
    return errors;
  }

  if (isGroup(node)) {
    if (!['AND', 'OR'].includes(node.op)) {
      errors.push({ path, error: `Group operator must be AND or OR, got "${node.op}"` });
    }
    if (node.children.length === 0) {
      errors.push({ path, error: 'A group must contain at least one condition' });
    }
    node.children.forEach((c, i) => validateTree(c, `${path}.${i}`, errors));
    return errors;
  }

  const field = FIELDS[node.field];
  if (!field) {
    errors.push({ path, error: `Unknown field "${node.field}"` });
    return errors;
  }

  const op = OPERATORS[node.operator];
  if (!op) {
    errors.push({ path, error: `Unknown operator "${node.operator}"` });
    return errors;
  }
  if (!op.types.includes(field.type)) {
    errors.push({ path, error: `"${op.label}" cannot be used on a ${field.type} field` });
  }

  const needsValue = !['is_set', 'is_empty', 'is_true', 'is_false'].includes(node.operator);
  if (needsValue && (node.value == null || node.value === '')) {
    errors.push({ path, error: `"${op.label}" needs a value` });
  }
  if (node.operator === 'between' && list(node.value).length < 2) {
    errors.push({ path, error: '"is between" needs two values' });
  }

  return errors;
}

/* ---------------------------------------------------------- evaluation */

/**
 * Evaluate in memory against a facts object.
 * An empty group is TRUE for AND and FALSE for OR, matching how a reader
 * expects "all of nothing" and "any of nothing" to behave.
 */
export function evaluate(node, facts) {
  if (!node) return true;

  if (isGroup(node)) {
    if (node.children.length === 0) return node.op === 'AND';
    return node.op === 'AND'
      ? node.children.every((c) => evaluate(c, facts))
      : node.children.some((c) => evaluate(c, facts));
  }

  const op = OPERATORS[node.operator];
  if (!op) return false;
  return Boolean(op.test(facts[node.field], node.value));
}

/* ------------------------------------------------------------- to SQL */

/**
 * Compile to a SQL fragment plus bound parameters.
 *
 * Every field name comes from FIELDS; every value is a parameter. An unknown
 * field compiles to `1=0` rather than throwing, so one broken leaf in a large
 * segment narrows the result instead of failing the whole query — and the
 * validator will already have told the author which leaf it was.
 */
export function toSql(node) {
  if (!node) return { sql: '1=1', params: [] };

  if (isGroup(node)) {
    if (node.children.length === 0) return { sql: node.op === 'AND' ? '1=1' : '1=0', params: [] };

    const parts = node.children.map(toSql);
    return {
      sql: `(${parts.map((p) => p.sql).join(node.op === 'OR' ? ' OR ' : ' AND ')})`,
      params: parts.flatMap((p) => p.params),
    };
  }

  const field = FIELDS[node.field];
  const op = OPERATORS[node.operator];
  if (!field || !op) return { sql: '1=0', params: [] };

  /**
   * Case folding, and why it is here rather than left to the database.
   *
   * The in-memory evaluator compares with norm(), which lower-cases. SQLite's
   * `=` and `IN` are case-sensitive, and Postgres `LIKE` is too. Left alone the
   * two implementations quietly disagree: `stage in "Qualified"` matched 17
   * records in memory and 0 in SQL, because the parameter had been lowered and
   * the column had not.
   *
   * So text comparisons fold both sides. LOWER() rather than COLLATE NOCASE
   * because the latter does not exist in Postgres, and this has to survive the
   * move. It does cost the index on that column — when a field proves hot,
   * the answer is an expression index on LOWER(col), not silently reverting to
   * a case-sensitive compare.
   */
  const foldable = op.ci && ['text', 'enum', 'user'].includes(field.type);
  const column = foldable ? `LOWER(${field.sql})` : field.sql;

  const params = op.params(node.value);
  return {
    sql: op.sql(column, node.value),
    params: foldable ? params.map((p) => (typeof p === 'string' ? p.toLowerCase() : p)) : params,
  };
}

/* ---------------------------------------------------------- migration */

/**
 * Lift a legacy flat condition array into a tree.
 *
 * The old shape was `[{field, op, value, join}]` where `join` was meant to
 * chain rows but was ignored by the assignment engine, which ANDed everything.
 * Mixed joins are lifted as `A AND B OR C` read left to right — imperfect, but
 * it is what the old evaluator would have done, and the alternative is silently
 * changing what an existing rule means.
 */
export function fromLegacy(flat) {
  const rows = Array.isArray(flat) ? flat : [];
  if (rows.length === 0) return { op: 'AND', children: [] };

  const leaves = rows.map((r) => ({
    field: r.field,
    // The old code used `op`; the tree uses `operator`.
    operator: r.operator ?? r.op ?? 'eq',
    value: r.value,
  }));

  const anyOr = rows.some((r, i) => i > 0 && String(r.join ?? 'AND').toUpperCase() === 'OR');
  if (!anyOr) return { op: 'AND', children: leaves };

  // Left-to-right: AND binds into the current group, OR starts a new one.
  const groups = [[leaves[0]]];
  for (let i = 1; i < leaves.length; i += 1) {
    if (String(rows[i].join ?? 'AND').toUpperCase() === 'OR') groups.push([leaves[i]]);
    else groups[groups.length - 1].push(leaves[i]);
  }

  return {
    op: 'OR',
    children: groups.map((g) => (g.length === 1 ? g[0] : { op: 'AND', children: g })),
  };
}

/** Human-readable rendering, for rule lists and audit entries. */
export function describe(node, depth = 0) {
  if (!node) return 'everyone';

  if (isGroup(node)) {
    if (node.children.length === 0) return node.op === 'AND' ? 'everyone' : 'nobody';
    const inner = node.children.map((c) => describe(c, depth + 1)).join(node.op === 'AND' ? ' and ' : ' or ');
    return depth > 0 && node.children.length > 1 ? `(${inner})` : inner;
  }

  const field = FIELDS[node.field];
  const op = OPERATORS[node.operator];
  if (!field || !op) return `«unknown condition»`;

  const needsValue = !['is_set', 'is_empty', 'is_true', 'is_false'].includes(node.operator);
  return needsValue
    ? `${field.label} ${op.label} ${Array.isArray(node.value) ? node.value.join(', ') : node.value}`
    : `${field.label} ${op.label}`;
}
