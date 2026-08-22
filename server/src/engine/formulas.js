/**
 * Formula and Roll-Up fields — computed as schema, never by automation.
 *
 * NON-NEGOTIABLE 3, AND WHY IT IS ONE
 * -----------------------------------
 * The legacy tenant maintains computed values with scheduled jobs: six
 * automations exist only to stamp a date into an `mx_` field, and the busiest
 * of them recomputes a score. Every one of those can be wrong — between runs,
 * after a failed run, or forever if someone edits the field by hand. A field
 * that is *defined* by its computation cannot drift, because there is nothing
 * to drift from.
 *
 * A CURATED SET, NOT A LANGUAGE
 * -----------------------------
 * An administrator picks a formula kind and fills in its blanks. There is no
 * expression to type, which means:
 *
 *   • no parser, and therefore no injection surface
 *   • no infinite loop, because nothing can reference another derived field
 *   • no expression an administrator writes on Tuesday that nobody can debug
 *     on Friday
 *
 * The storage contract is the one a full parser would use, so a parser can be
 * added behind this later without touching a single field definition already
 * created. That was the point of choosing curated-now rather than curated-only.
 *
 * SAFETY
 * ------
 * Every column name reaching SQL comes from the metadata registry, matched
 * against the entity's own field list. Nothing from the request body is ever
 * interpolated — the same discipline as the condition compiler, for the same
 * reason.
 */

import { all, one } from '../db.js';
import { entityDef, fieldsOf, FIELD_TYPES } from './metadata.js';

/* -------------------------------------------------------- the catalogue */

/**
 * What an administrator may choose, and what each needs.
 *
 * `inputs` drives the Setup form: the UI renders one control per input and does
 * not need to know what any formula means.
 */
export const FORMULA_KINDS = {
  days_since: {
    label: 'Days since',
    help: 'Whole days between a date field and today.',
    returns: 'number',
    inputs: [{ name: 'field', label: 'Date field', type: 'field', of: ['date', 'datetime'] }],
  },
  days_between: {
    label: 'Days between two dates',
    help: 'Whole days from the first date to the second. Negative if the second is earlier.',
    returns: 'number',
    inputs: [
      { name: 'from', label: 'From', type: 'field', of: ['date', 'datetime'] },
      { name: 'to', label: 'To', type: 'field', of: ['date', 'datetime'] },
    ],
  },
  arithmetic: {
    label: 'Arithmetic on two fields',
    help: 'Add, subtract, multiply or divide. The second operand may be a fixed number.',
    returns: 'number',
    inputs: [
      { name: 'left', label: 'First value', type: 'field', of: ['number', 'currency', 'percent'] },
      { name: 'op', label: 'Operation', type: 'choice', values: ['+', '-', '*', '/'] },
      { name: 'right', label: 'Second value', type: 'field_or_number', of: ['number', 'currency', 'percent'] },
    ],
  },
  if_then: {
    label: 'If / then',
    help: 'One test on one field, and a value for each outcome.',
    returns: 'text',
    inputs: [
      { name: 'field', label: 'Field to test', type: 'field' },
      { name: 'op', label: 'Test', type: 'choice', values: ['equals', 'not equals', 'is empty', 'is not empty', 'greater than', 'less than'] },
      { name: 'value', label: 'Compared with', type: 'text', optional: true },
      { name: 'then', label: 'Then show', type: 'text' },
      { name: 'otherwise', label: 'Otherwise show', type: 'text' },
    ],
  },
  concat: {
    label: 'Join text fields',
    help: 'Several fields joined by a separator, skipping any that are empty.',
    returns: 'text',
    inputs: [
      { name: 'fields', label: 'Fields', type: 'field_list' },
      { name: 'separator', label: 'Separator', type: 'text', optional: true },
    ],
  },
  age_in_stage: {
    label: 'Days in current stage',
    help: 'Read from field history — needs the field to be history-tracked.',
    returns: 'number',
    inputs: [{ name: 'field', label: 'Stage field', type: 'field', of: ['picklist'] }],
  },
};

/** What a roll-up may do to a child list. */
export const ROLLUP_AGGS = {
  count: { label: 'Count of records', needsField: false, returns: 'number' },
  sum: { label: 'Sum of', needsField: true, returns: 'number' },
  avg: { label: 'Average of', needsField: true, returns: 'number' },
  min: { label: 'Smallest', needsField: true, returns: 'number' },
  max: { label: 'Largest', needsField: true, returns: 'number' },
  latest: { label: 'Most recent value of', needsField: true, returns: 'text' },
};

/**
 * Which child lists a roll-up may summarise, and how each joins to its parent.
 *
 * A registry rather than free choice: an administrator picking "child table" out
 * of every table in the schema is how you get a roll-up over `sessions`.
 */
export const ROLLUP_SOURCES = {
  lead: [
    { key: 'interactions', label: 'Interactions', table: 'activities', fk: 'lead_id',
      fields: { duration_s: 'number', created_at: 'date', type: 'text', disposition: 'text' } },
    { key: 'product_interests', label: 'Product interests', table: 'product_cards', fk: 'lead_id',
      fields: { value: 'number', state: 'text' } },
    { key: 'tasks', label: 'Tasks', table: 'tasks', fk: 'lead_id',
      fields: { due_at: 'date', status: 'text' } },
    { key: 'cases', label: 'Cases', table: 'tickets', fk: 'lead_id',
      fields: { created_at: 'date', status: 'text', priority: 'text' } },
  ],
  partner: [
    { key: 'sourced_leads', label: 'Sourced leads', table: 'leads', fk: 'partner_id',
      fields: { created_at: 'date', stage: 'text' } },
    { key: 'commissions', label: 'Commissions', table: 'commissions', fk: 'partner_id',
      fields: { payout: 'number', period: 'text' } },
  ],
};

/* ---------------------------------------------------------- validation */

/**
 * Check a definition before it is saved.
 *
 * Refusing a bad formula at creation is the whole point of a curated set: it
 * cannot be saved wrong, so it cannot fail silently on a record months later.
 */
export function validateFormula(entity, def) {
  const kind = FORMULA_KINDS[def?.kind];
  if (!kind) return { ok: false, error: `Unknown formula "${def?.kind}"` };

  // Every field, then narrow — so pointing a formula at another formula can be
  // told apart from pointing it at nothing, and each gets its own message.
  const every = new Map(fieldsOf(entity).map((f) => [f.api_name, f]));
  const columns = new Map(
    [...every].filter(([, f]) => f.storage === 'column' || f.storage === 'value'),
  );

  for (const input of kind.inputs) {
    const value = def[input.name];

    if (value == null || value === '') {
      if (input.optional) continue;
      return { ok: false, error: `${input.label} is required` };
    }

    if (input.type === 'field' || input.type === 'field_or_number') {
      if (input.type === 'field_or_number' && !Number.isNaN(Number(value))) continue;

      // A formula over another formula is how a dependency cycle starts. It is
      // refused either way; the point of checking `every` first is that the
      // administrator is told which mistake they made.
      const derived = every.get(value);
      if (derived && FIELD_TYPES[derived.type]?.derived) {
        return {
          ok: false,
          error: `${derived.label} is itself computed — a formula cannot depend on another computed field`,
        };
      }

      const f = columns.get(value);
      if (!f) return { ok: false, error: `${value} is not a field on this object` };
      if (input.of && !input.of.includes(f.type)) {
        return { ok: false, error: `${f.label} is a ${f.type}; ${input.label} needs ${input.of.join(' or ')}` };
      }
      if (def.kind === 'age_in_stage' && !f.history_tracked) {
        return { ok: false, error: `${f.label} is not history-tracked, so its stage age cannot be computed. Turn on change tracking first.` };
      }
    }

    if (input.type === 'field_list') {
      const list = Array.isArray(value) ? value : [];
      if (!list.length) return { ok: false, error: `${input.label} needs at least one field` };
      for (const name of list) {
        if (!columns.has(name)) return { ok: false, error: `${name} is not a field on this object` };
      }
    }

    if (input.type === 'choice' && !input.values.includes(value)) {
      return { ok: false, error: `${value} is not a valid ${input.label}` };
    }
  }

  // Division by a literal zero is a definition error, not a runtime one.
  if (def.kind === 'arithmetic' && def.op === '/' && Number(def.right) === 0) {
    return { ok: false, error: 'Dividing by zero' };
  }

  return { ok: true, returns: kind.returns };
}

export function validateRollup(entity, def) {
  const sources = ROLLUP_SOURCES[entity] ?? [];
  const source = sources.find((s) => s.key === def?.source);
  if (!source) return { ok: false, error: `${def?.source ?? 'No child list'} is not available on this object` };

  const agg = ROLLUP_AGGS[def?.agg];
  if (!agg) return { ok: false, error: `Unknown aggregate "${def?.agg}"` };

  if (agg.needsField) {
    if (!def.field) return { ok: false, error: `${agg.label} needs a field` };
    if (!(def.field in source.fields)) {
      return { ok: false, error: `${def.field} is not summarisable on ${source.label}` };
    }
    const type = source.fields[def.field];
    if (['sum', 'avg'].includes(def.agg) && type !== 'number') {
      return { ok: false, error: `${def.field} is ${type}; it cannot be ${def.agg === 'sum' ? 'summed' : 'averaged'}` };
    }
  }

  if (def.where) {
    const [col] = Object.keys(def.where);
    if (!(col in source.fields)) return { ok: false, error: `Cannot filter ${source.label} on ${col}` };
  }

  return { ok: true, returns: agg.returns };
}

/* ------------------------------------------------------------ compute */

const DAY = 86_400_000;

/** SQLite stores UTC without a zone marker; parse it as UTC, not local. */
const parseTs = (v) => {
  if (!v) return null;
  const s = String(v);
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const numeric = (v) => (v == null || v === '' ? null : Number(v));

function computeFormula(def, record, entity) {
  switch (def.kind) {
    case 'days_since': {
      const t = parseTs(record[def.field]);
      return t == null ? null : Math.floor((Date.now() - t) / DAY);
    }

    case 'days_between': {
      const a = parseTs(record[def.from]);
      const b = parseTs(record[def.to]);
      return a == null || b == null ? null : Math.round((b - a) / DAY);
    }

    case 'arithmetic': {
      const l = numeric(record[def.left]);
      const rRaw = Number.isNaN(Number(def.right)) ? record[def.right] : def.right;
      const r = numeric(rRaw);
      if (l == null || r == null) return null;
      switch (def.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        // Guarded at compute time too: the divisor may be a field that happens
        // to be zero on this record, which validation cannot see.
        case '/': return r === 0 ? null : Math.round((l / r) * 10_000) / 10_000;
        default: return null;
      }
    }

    case 'if_then': {
      const v = record[def.field];
      const cmp = def.value;
      let hit;
      switch (def.op) {
        case 'equals': hit = String(v ?? '') === String(cmp ?? ''); break;
        case 'not equals': hit = String(v ?? '') !== String(cmp ?? ''); break;
        case 'is empty': hit = v == null || v === ''; break;
        case 'is not empty': hit = v != null && v !== ''; break;
        case 'greater than': hit = numeric(v) != null && numeric(v) > Number(cmp); break;
        case 'less than': hit = numeric(v) != null && numeric(v) < Number(cmp); break;
        default: hit = false;
      }
      return hit ? def.then : def.otherwise;
    }

    case 'concat': {
      const parts = (def.fields ?? [])
        .map((f) => record[f])
        .filter((v) => v != null && v !== '');
      return parts.length ? parts.join(def.separator ?? ' ') : null;
    }

    case 'age_in_stage': {
      // Derived from history rather than a stamped column — the same query
      // that replaced six legacy automations.
      const row = one(
        `SELECT changed_at FROM field_history
         WHERE entity = ? AND record_id = ? AND field = ?
         ORDER BY changed_at DESC, id DESC LIMIT 1`,
        [entity, record.id, def.field],
      );
      const since = parseTs(row?.changed_at) ?? parseTs(record.created_at);
      return since == null ? null : Math.floor((Date.now() - since) / DAY);
    }

    default:
      return null;
  }
}

function computeRollup(def, record, entity) {
  const source = (ROLLUP_SOURCES[entity] ?? []).find((s) => s.key === def.source);
  if (!source) return null;

  // Every identifier below comes from the registry above, never from a request.
  const agg = def.agg;
  const params = [record.id];
  let where = `${source.fk} = ?`;

  if (def.where) {
    const [col, val] = Object.entries(def.where)[0];
    if (col in source.fields) {
      where += ` AND ${col} = ?`;
      params.push(val);
    }
  }

  if (agg === 'count') {
    return one(`SELECT COUNT(*) v FROM ${source.table} WHERE ${where}`, params).v;
  }

  if (agg === 'latest') {
    const row = one(
      `SELECT ${def.field} v FROM ${source.table} WHERE ${where}
       ORDER BY rowid DESC LIMIT 1`, params,
    );
    return row?.v ?? null;
  }

  const fn = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[agg];
  if (!fn) return null;

  const row = one(`SELECT ${fn}(${def.field}) v FROM ${source.table} WHERE ${where}`, params);
  const v = row?.v;
  return v == null ? null : Math.round(Number(v) * 100) / 100;
}

/* ------------------------------------------------------------- public */

const parse = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};

/**
 * Every derived field on one record, keyed by api_name.
 *
 * Computed on read. There is nothing stored to go stale, and nothing scheduled
 * to fail — which is the entire argument for doing it this way.
 */
export function derivedValues(entity, record) {
  if (!record) return {};

  const out = {};
  for (const f of fieldsOf(entity)) {
    if (!FIELD_TYPES[f.type]?.derived) continue;

    try {
      if (f.type === 'formula') {
        const def = parse(f.formula);
        if (def) out[f.api_name] = computeFormula(def, record, entity);
      } else if (f.type === 'rollup') {
        const def = parse(f.rollup);
        if (def) out[f.api_name] = computeRollup(def, record, entity);
      }
    } catch {
      // One broken definition must not take the record down with it. The field
      // reads as empty; the definition is what needs fixing, in Setup.
      out[f.api_name] = null;
    }
  }
  return out;
}

/** Plain-English description, for the field list in Setup. */
export function describeFormula(entity, def) {
  const label = (name) => fieldsOf(entity).find((f) => f.api_name === name)?.label ?? name;

  switch (def?.kind) {
    case 'days_since': return `Days since ${label(def.field)}`;
    case 'days_between': return `Days from ${label(def.from)} to ${label(def.to)}`;
    case 'arithmetic': return `${label(def.left)} ${def.op} ${Number.isNaN(Number(def.right)) ? label(def.right) : def.right}`;
    case 'if_then': return `If ${label(def.field)} ${def.op}${def.value ? ` ${def.value}` : ''} then “${def.then}”, else “${def.otherwise}”`;
    case 'concat': return `${(def.fields ?? []).map(label).join(' + ')} joined by “${def.separator ?? ' '}”`;
    case 'age_in_stage': return `Days in the current ${label(def.field)}`;
    default: return 'Computed';
  }
}

export function describeRollup(entity, def) {
  const source = (ROLLUP_SOURCES[entity] ?? []).find((s) => s.key === def?.source);
  const agg = ROLLUP_AGGS[def?.agg];
  if (!source || !agg) return 'Computed';

  const filter = def.where
    ? ` where ${Object.entries(def.where).map(([k, v]) => `${k} is ${v}`).join(' and ')}`
    : '';
  return agg.needsField
    ? `${agg.label} ${def.field} across ${source.label}${filter}`
    : `${agg.label} on ${source.label}${filter}`;
}

/** The catalogue, for the Setup form. */
export const catalogue = (entity) => ({
  formulas: FORMULA_KINDS,
  aggregates: ROLLUP_AGGS,
  sources: ROLLUP_SOURCES[entity] ?? [],
  fields: fieldsOf(entity)
    .filter((f) => f.storage === 'column' && !FIELD_TYPES[f.type]?.derived)
    .map((f) => ({ api_name: f.api_name, label: f.label, type: f.type, history_tracked: Boolean(f.history_tracked) })),
});

void all;
void entityDef;
