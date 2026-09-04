/**
 * Validation rules — refuse a save that would store something the business
 * says is wrong.
 *
 * WHY THIS IS NOT THE RULE BUILDER
 *
 * `engine/conditions.js` already evaluates conditions, and reusing it was the
 * first instinct. It cannot be reused: its FIELDS map is lead-specific down to
 * the SQL — `l.name`, `l.mobile` — because it exists to compile segment queries
 * over the leads table. Validation has to work identically on Lead, Client and
 * Ticket, so it is driven by `field_def` instead, which is the metadata layer
 * every other part of object configuration already speaks.
 *
 * That is also why the two are not merged. A rule that routes a lead and a rule
 * that refuses a save answer different questions, and giving them one editor
 * would mean one screen whose options half apply — which is the shape the
 * legacy audit kept finding.
 *
 * WHICH WAY THE CONDITION POINTS
 *
 * A rule fires — and the save is refused — when its condition MATCHES. The
 * condition describes the thing that is wrong, not the thing that is required.
 * "Refuse when stage is Won and PAN is blank" rather than "require PAN when
 * stage is Won". Both express the same rule, and the first is the one that can
 * be read off the screen without inverting it in your head.
 *
 * WHERE IT IS ENFORCED
 *
 * At the API, on every write path, never in the form. A form check is a
 * courtesy; imports, rules, bulk actions and the API itself all reach the same
 * routes and none of them render a form. Non-negotiable #11.
 */

import { all, one, run } from '../db.js';
import { fieldsOf } from './metadata.js';

/**
 * The operators a rule may use.
 *
 * Deliberately few. Every one of these can be explained in a sentence on the
 * screen, and an administrator who cannot predict what a rule will do will not
 * write one. `matches` is the exception and is the reason `safeRegex` exists
 * below — a pattern typed into a config screen runs on every save.
 */
export const OPERATORS = {
  is_blank: { label: 'is empty', takesValue: false, test: (v) => isBlank(v) },
  is_not_blank: { label: 'is not empty', takesValue: false, test: (v) => !isBlank(v) },
  eq: { label: 'is', test: (v, x) => norm(v) === norm(x) },
  ne: { label: 'is not', test: (v, x) => norm(v) !== norm(x) },
  in: { label: 'is one of', list: true, test: (v, x) => toList(x).some((i) => norm(i) === norm(v)) },
  not_in: { label: 'is none of', list: true, test: (v, x) => !toList(x).some((i) => norm(i) === norm(v)) },
  gt: { label: 'is greater than', numeric: true, test: (v, x) => num(v) !== null && num(x) !== null && num(v) > num(x) },
  lt: { label: 'is less than', numeric: true, test: (v, x) => num(v) !== null && num(x) !== null && num(v) < num(x) },
  longer_than: { label: 'is longer than (characters)', numeric: true, test: (v, x) => String(v ?? '').length > Number(x) },
  shorter_than: { label: 'is shorter than (characters)', numeric: true, test: (v, x) => String(v ?? '').trim().length < Number(x) },
  matches: { label: 'matches the pattern', test: (v, x) => safeRegex(x)?.test(String(v ?? '')) ?? false },
  not_matches: { label: 'does not match the pattern', test: (v, x) => !(safeRegex(x)?.test(String(v ?? '')) ?? true) },
};

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const norm = (v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());
/* Blank is not zero. Number('') and Number(null) are both 0, so without this
   guard "balance is less than 10" fires on a record that has no balance at
   all — and "refuse a save when the balance is under the minimum" would then
   refuse every record nobody has filled in yet. */
const num = (v) => {
  if (isBlank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toList = (x) => (Array.isArray(x) ? x : String(x ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/**
 * Compile a pattern, or nothing.
 *
 * A bad pattern must not throw on every save of every record — a rule an
 * administrator typo'd should fail to match, be visible as a rule that never
 * fires, and be fixable. It must not take the object down.
 */
function safeRegex(pattern) {
  try { return new RegExp(String(pattern)); } catch { return null; }
}

/* ---------------------------------------------------------- evaluating */

/**
 * Does this rule's condition match the record?
 *
 * `{ all: [...] }` or `{ any: [...] }`, one level, no nesting. Nesting is where
 * a condition builder stops being readable, and a rule nobody can read is a
 * rule nobody will trust enough to leave switched on.
 */
export function matches(condition, record) {
  if (!condition) return false;
  const mode = Array.isArray(condition.any) ? 'any' : 'all';
  const clauses = condition[mode];
  if (!Array.isArray(clauses) || clauses.length === 0) return false;

  const hit = (c) => {
    const op = OPERATORS[c.op];
    if (!op) return false;              // unknown operator never fires
    return Boolean(op.test(record?.[c.field], c.value));
  };

  return mode === 'any' ? clauses.some(hit) : clauses.every(hit);
}

/** The active rules for one object, in the order they will be reported. */
export const rulesFor = (entity, salesOrg = null) => all(
  `SELECT * FROM validation_rule
   WHERE entity = ? AND active = 1
     AND (sales_org IS NULL OR sales_org = ?)
   ORDER BY sort_order, id`,
  [entity, salesOrg],
);

/**
 * Check a record about to be written.
 *
 * Returns every rule that fired, not just the first. Being told about one
 * problem, fixing it, and being told about the next is how a form becomes
 * something people work around.
 */
export function check(entity, record, salesOrg = null) {
  return rulesFor(entity, salesOrg)
    .filter((r) => {
      let condition = null;
      try { condition = JSON.parse(r.condition); } catch { return false; }
      return matches(condition, record);
    })
    .map((r) => ({ rule: r.name, message: r.message, id: r.id }));
}

/**
 * The guard the write routes call.
 *
 * `patch` is what the caller is changing; `existing` is the record as stored.
 * A rule is evaluated against the record as it WOULD be — an administrator
 * writing "refuse when stage is Won and PAN is blank" means the resulting
 * record, not the one already there, and evaluating the old row would let the
 * offending save straight through.
 */
export function assertValid(entity, { existing = {}, patch = {}, salesOrg = null } = {}) {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) merged[k] = v;
  }
  const failures = check(entity, merged, salesOrg ?? merged.sales_org ?? null);
  return failures.length ? failures : null;
}

/* --------------------------------------------------------- authoring */

/**
 * Check a rule before it is stored.
 *
 * A rule that can never fire, or that names a field the object does not have,
 * is worse than no rule: it sits on the screen looking like protection.
 */
export function validateRule(entity, { condition, message } = {}) {
  if (!message || !String(message).trim()) {
    return { error: 'A rule needs a message — it is what the person saving will read', field: 'message' };
  }
  if (String(message).length > 300) {
    return { error: 'Keep the message under 300 characters', field: 'message' };
  }

  const mode = Array.isArray(condition?.any) ? 'any' : 'all';
  const clauses = condition?.[mode];
  if (!Array.isArray(clauses) || clauses.length === 0) {
    return { error: 'A rule needs at least one condition', field: 'condition' };
  }
  if (clauses.length > 10) {
    return { error: 'Ten conditions is the limit — split it into two rules', field: 'condition' };
  }

  const known = new Set(fieldsOf(entity).map((f) => f.api_name));
  for (const c of clauses) {
    if (!known.has(c.field)) {
      return { error: `"${c.field}" is not a field of this object`, field: 'condition' };
    }
    const op = OPERATORS[c.op];
    if (!op) return { error: `"${c.op}" is not an operator`, field: 'condition' };
    if (op.takesValue !== false && isBlank(c.value)) {
      return { error: `"${op.label}" needs a value`, field: 'condition' };
    }
    if (op.numeric && num(c.value) === null) {
      return { error: `"${op.label}" needs a number, not "${c.value}"`, field: 'condition' };
    }
    if ((c.op === 'matches' || c.op === 'not_matches') && !safeRegex(c.value)) {
      return { error: `"${c.value}" is not a valid pattern`, field: 'condition' };
    }
  }
  return null;
}

/** The operator catalogue, for the authoring screen. */
export const operatorCatalogue = () =>
  Object.entries(OPERATORS).map(([op, d]) => ({
    op, label: d.label, takes_value: d.takesValue !== false, list: Boolean(d.list), numeric: Boolean(d.numeric),
  }));

/**
 * Would this rule refuse records that already exist?
 *
 * Shown when a rule is written, because the answer is nearly always yes and
 * nearly always a surprise. A rule that refuses four hundred existing records
 * blocks every edit to all of them — including the edit that would fix them.
 */
export function wouldRefuseExisting(entity, condition, limit = 500) {
  const def = one('SELECT table_name FROM entity_def WHERE api_name = ?', [entity]);
  if (!def) return null;

  const cols = new Set(all(`PRAGMA table_info(${def.table_name})`).map((c) => c.name));
  const soft = cols.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';
  const rows = all(`SELECT * FROM ${def.table_name} ${soft} LIMIT ${Number(limit)}`);

  const hits = rows.filter((r) => matches(condition, r));
  return { checked: rows.length, failing: hits.length, capped: rows.length === limit };
}

/* ------------------------------------------------ required fields (P3-03/Q3)
 *
 * "Mandatory" is not a separate concept from validation, it is the simplest
 * possible rule: refuse when the field is empty. Storing it as one means the
 * toggle on the Users screen and the rules screen are showing the same thing,
 * rather than two settings that can disagree about whether a mobile number is
 * required.
 */

/** The shape a required rule has, so it can be recognised again later. */
const REQUIRED_CONDITION = (field) => JSON.stringify({ all: [{ field, op: 'is_blank' }] });

/** Is this rule one of the "field is required" ones, and for which field? */
export function requiredFieldOf(rule) {
  let condition = null;
  try { condition = JSON.parse(rule.condition); } catch { return null; }

  const clauses = condition?.all;
  if (!Array.isArray(clauses) || clauses.length !== 1) return null;
  if (clauses[0]?.op !== 'is_blank') return null;
  return clauses[0].field ?? null;
}

/** Which fields on an entity are currently required. */
export function requiredFields(entity) {
  return new Set(
    rulesFor(entity)
      .map(requiredFieldOf)
      .filter(Boolean),
  );
}

/**
 * Make a field required, or stop requiring it.
 *
 * Removing deletes the rule rather than deactivating it, so a field that is not
 * required leaves nothing behind to be switched on by accident later.
 */
export function setRequired(entity, field, required, label, userId) {
  const existing = rulesFor(entity).filter((r) => requiredFieldOf(r) === field);

  if (!required) {
    for (const r of existing) run('DELETE FROM validation_rule WHERE id = ?', [r.id]);
    return { ok: true, required: false };
  }

  if (existing.length) return { ok: true, required: true };

  run(
    `INSERT INTO validation_rule (entity, name, description, condition, message, created_by)
     VALUES (?,?,?,?,?,?)`,
    [
      entity,
      `${label || field} is required`,
      'Created from the required-fields control.',
      REQUIRED_CONDITION(field),
      `${label || field} is required`,
      userId ?? null,
    ],
  );
  return { ok: true, required: true };
}
