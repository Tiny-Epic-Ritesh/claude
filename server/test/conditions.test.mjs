/**
 * Condition tree tests.
 *
 * The load-bearing test in this file is the last section: `evaluate()` and
 * `toSql()` must agree on the same data. They are two independent
 * implementations of the same language, and if they drift then a segment
 * previews two hundred leads and acts on a hundred and ninety — which is worse
 * than having no segments at all.
 *
 * Everything above it exists to make the nesting the audit's Finding 8 demands
 * actually work: `(A AND B) OR (C AND D)`, which LeadSquared cannot express and
 * which is why that tenant has 4,810 static lists.
 */

import assert from 'node:assert/strict';
import { db, all, run } from '../src/db.js';
import {
  evaluate, toSql, validateTree, fromLegacy, describe, conditionSchema, FIELDS,
} from '../src/engine/conditions.js';

const results = [];
const test = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};

/* --------------------------------------------------------- the nesting */

const NESTED = {
  op: 'OR',
  children: [
    { op: 'AND', children: [
      { field: 'city', operator: 'eq', value: 'Mumbai' },
      { field: 'stage', operator: 'eq', value: 'Qualified' },
    ] },
    { op: 'AND', children: [
      { field: 'city', operator: 'eq', value: 'Pune' },
      { field: 'lead_age_days', operator: 'gt', value: 30 },
    ] },
  ],
};

test('(A AND B) OR (C AND D) — the expression LeadSquared cannot make', () => {
  assert.equal(evaluate(NESTED, { city: 'Mumbai', stage: 'Qualified', lead_age_days: 2 }), true);
  assert.equal(evaluate(NESTED, { city: 'Pune', stage: 'New', lead_age_days: 45 }), true);
  // Matches half of each branch — must be false.
  assert.equal(evaluate(NESTED, { city: 'Mumbai', stage: 'New', lead_age_days: 45 }), false);
  assert.equal(evaluate(NESTED, { city: 'Pune', stage: 'Qualified', lead_age_days: 2 }), false);
});

test('nesting goes deeper than two levels', () => {
  const deep = {
    op: 'AND',
    children: [
      { field: 'sales_org', operator: 'eq', value: 'BONANZA' },
      { op: 'OR', children: [
        { field: 'stage', operator: 'eq', value: 'Won' },
        { op: 'AND', children: [
          { field: 'stage', operator: 'eq', value: 'Qualified' },
          { field: 'connect_count', operator: 'gte', value: 3 },
        ] },
      ] },
    ],
  };
  assert.equal(evaluate(deep, { sales_org: 'BONANZA', stage: 'Won', connect_count: 0 }), true);
  assert.equal(evaluate(deep, { sales_org: 'BONANZA', stage: 'Qualified', connect_count: 5 }), true);
  assert.equal(evaluate(deep, { sales_org: 'BONANZA', stage: 'Qualified', connect_count: 1 }), false);
  assert.equal(evaluate(deep, { sales_org: 'BIGUL', stage: 'Won', connect_count: 9 }), false);
});

test('an empty group means everyone for AND and nobody for OR', () => {
  assert.equal(evaluate({ op: 'AND', children: [] }, {}), true);
  assert.equal(evaluate({ op: 'OR', children: [] }, {}), false);
  assert.equal(toSql({ op: 'AND', children: [] }).sql, '1=1');
  assert.equal(toSql({ op: 'OR', children: [] }).sql, '1=0');
});

/* ------------------------------------------------------------ operators */

test('text operators behave as a user would expect', () => {
  const f = { city: 'Mumbai' };
  assert.equal(evaluate({ field: 'city', operator: 'contains', value: 'umb' }, f), true);
  assert.equal(evaluate({ field: 'city', operator: 'starts_with', value: 'mum' }, f), true);
  assert.equal(evaluate({ field: 'city', operator: 'not_contains', value: 'delhi' }, f), true);
  assert.equal(evaluate({ field: 'city', operator: 'eq', value: 'MUMBAI' }, f), true, 'should be case-insensitive');
});

test('"is not" is true when the field is empty', () => {
  // A user asking for "stage is not Won" means to include records with no
  // stage. SQL's NULL semantics disagree, which is why both sides special-case it.
  assert.equal(evaluate({ field: 'stage', operator: 'neq', value: 'Won' }, { stage: null }), true);
  const { sql } = toSql({ field: 'stage', operator: 'neq', value: 'Won' });
  assert.ok(sql.includes('IS NULL'), `SQL must handle NULL: ${sql}`);
});

test('list operators accept a string or an array', () => {
  const node = { field: 'source', operator: 'in', value: 'Google,Facebook' };
  assert.equal(evaluate(node, { source: 'Facebook' }), true);
  assert.equal(evaluate(node, { source: 'Website' }), false);
  assert.equal(evaluate({ field: 'source', operator: 'in', value: ['Google', 'Website'] }, { source: 'Website' }), true);
});

test('presence operators need no value', () => {
  assert.equal(evaluate({ field: 'email', operator: 'is_set' }, { email: 'a@b.c' }), true);
  assert.equal(evaluate({ field: 'email', operator: 'is_set' }, { email: '  ' }), false);
  assert.equal(evaluate({ field: 'email', operator: 'is_empty' }, { email: null }), true);
});

test('boolean operators read dirty values the way the audit warns about', () => {
  // 113 legacy Text fields hold flags, so "Yes"/"true"/1 all arrive.
  for (const v of [1, true, 'Yes', 'TRUE']) {
    assert.equal(evaluate({ field: 'mobile_invalid', operator: 'is_true' }, { mobile_invalid: v }), true, `failed on ${v}`);
  }
  for (const v of [0, false, null, '', 'No']) {
    assert.equal(evaluate({ field: 'mobile_invalid', operator: 'is_false' }, { mobile_invalid: v }), true, `failed on ${v}`);
  }
});

/* ----------------------------------------------------------- validation */

test('validation reports every problem, not just the first', () => {
  const errors = validateTree({
    op: 'AND',
    children: [
      { field: 'nonsense', operator: 'eq', value: 'x' },
      { field: 'city', operator: 'made_up', value: 'y' },
      { field: 'city', operator: 'eq' },
    ],
  });
  assert.equal(errors.length, 3, JSON.stringify(errors));
  assert.ok(errors.every((e) => e.path && e.error), 'each error needs a path and a message');
});

test('an operator that does not suit the field type is refused', () => {
  const errors = validateTree({ field: 'lead_age_days', operator: 'contains', value: 'x' });
  assert.ok(errors.some((e) => /cannot be used on a number/.test(e.error)), JSON.stringify(errors));
});

test('a valid tree reports no errors', () => {
  assert.deepEqual(validateTree(NESTED), []);
});

/* ------------------------------------------------------------- safety */

test('an unknown field can never reach the SQL', () => {
  // The injection surface. A field name not in the registry must compile to a
  // constant, never to the caller's string.
  const { sql, params } = toSql({ field: "l.name; DROP TABLE leads;--", operator: 'eq', value: 'x' });
  assert.equal(sql, '1=0');
  assert.deepEqual(params, []);
});

test('values are always bound, never interpolated', () => {
  const attack = "'; DROP TABLE leads;--";
  const { sql, params } = toSql({ field: 'city', operator: 'eq', value: attack });

  // The security property: nothing from the value reaches the statement.
  assert.ok(!/drop/i.test(sql), `value leaked into SQL: ${sql}`);
  assert.equal((sql.match(/\?/g) || []).length, 1, 'the value must be a bound parameter');

  // It arrives as a parameter, case-folded because this is a text comparison.
  assert.equal(params.length, 1);
  assert.equal(params[0].toLowerCase(), attack.toLowerCase());
});

test('an IN list binds one parameter per value', () => {
  const { sql, params } = toSql({ field: 'source', operator: 'in', value: 'a,b,c' });
  assert.equal(params.length, 3);
  assert.equal((sql.match(/\?/g) || []).length, 3);
});

/* ----------------------------------------------------------- migration */

test('a legacy all-AND rule lifts unchanged', () => {
  const tree = fromLegacy([
    { field: 'source', op: 'eq', value: 'Google' },
    { field: 'city', op: 'eq', value: 'Mumbai' },
  ]);
  assert.equal(tree.op, 'AND');
  assert.equal(tree.children.length, 2);
  assert.equal(evaluate(tree, { source: 'Google', city: 'Mumbai' }), true);
  assert.equal(evaluate(tree, { source: 'Google', city: 'Pune' }), false);
});

test('a legacy rule with an OR join becomes a real OR', () => {
  const tree = fromLegacy([
    { field: 'source', op: 'eq', value: 'Google' },
    { field: 'source', op: 'eq', value: 'Facebook', join: 'OR' },
  ]);
  assert.equal(tree.op, 'OR');
  assert.equal(evaluate(tree, { source: 'Facebook' }), true);
});

test('an empty legacy rule becomes a catch-all, not a match-nothing', () => {
  const tree = fromLegacy([]);
  assert.equal(evaluate(tree, {}), true, 'a rule with no conditions matched everyone before, and must still');
});

/* --------------------------------------------------------- description */

test('a tree renders as something a human can check', () => {
  const text = describe(NESTED);
  assert.ok(text.includes('City is Mumbai'), text);
  assert.ok(text.includes(' or '), text);
  assert.ok(text.includes(' and '), text);
});

/* --------------------------------------------- the two must agree */

/**
 * The important one.
 *
 * Run the same tree through both implementations over the seeded database and
 * require identical result sets. This is what stops a segment preview from
 * disagreeing with what the segment then does.
 */
function agree(tree, label) {
  const compiled = toSql(tree);
  const viaSql = all(
    `SELECT l.id FROM leads l WHERE l.deleted_at IS NULL AND (${compiled.sql}) ORDER BY l.id`,
    compiled.params,
  ).map((r) => r.id);

  // The same fields, resolved per lead, then evaluated in memory.
  const factSql = Object.entries(FIELDS)
    .map(([code, f]) => `${f.sql} AS "${code}"`)
    .join(', ');
  const rows = all(`SELECT l.id, ${factSql} FROM leads l WHERE l.deleted_at IS NULL ORDER BY l.id`);
  const viaJs = rows.filter((r) => evaluate(tree, r)).map((r) => r.id);

  assert.deepEqual(
    viaJs, viaSql,
    `${label}: in-memory returned ${viaJs.length} rows, SQL returned ${viaSql.length}`,
  );
  return viaSql.length;
}

test('evaluate() and toSql() agree — simple equality', () => {
  agree({ field: 'sales_org', operator: 'eq', value: 'BONANZA' }, 'sales_org eq');
});

test('evaluate() and toSql() agree — nested AND/OR', () => {
  agree({
    op: 'OR',
    children: [
      { op: 'AND', children: [
        { field: 'sales_org', operator: 'eq', value: 'BONANZA' },
        { field: 'stage', operator: 'in', value: 'Qualified,In Progress' },
      ] },
      { op: 'AND', children: [
        { field: 'sales_org', operator: 'eq', value: 'BIGUL' },
        { field: 'lead_age_days', operator: 'gt', value: 20 },
      ] },
    ],
  }, 'nested');
});

test('evaluate() and toSql() agree — negation and emptiness', () => {
  agree({ field: 'stage', operator: 'neq', value: 'Won' }, 'stage neq');
  agree({ field: 'client_code', operator: 'is_empty' }, 'client_code empty');
  agree({ field: 'email', operator: 'is_set' }, 'email set');
});

test('evaluate() and toSql() agree — derived counts and subqueries', () => {
  agree({ field: 'open_ticket_count', operator: 'gt', value: 0 }, 'open tickets');
  agree({ field: 'active_product_count', operator: 'gte', value: 1 }, 'products held');
  agree({ field: 'days_since_contact', operator: 'gt', value: 14 }, 'gone quiet');
});

test('evaluate() and toSql() agree — booleans and partner linkage', () => {
  agree({ field: 'partner_linked', operator: 'is_true' }, 'partner linked');
  agree({ field: 'marketing_opt_out', operator: 'is_false' }, 'not opted out');
});

test('evaluate() and toSql() agree — the KYC status derived from journeys', () => {
  // Derived, never read from a stamped column — gap-analysis 1.1.
  agree({ field: 'kyc_status', operator: 'neq', value: 'Not Started' }, 'kyc started');
});

test('the schema exposed to the query builder is complete', () => {
  const schema = conditionSchema();
  assert.ok(schema.fields.length > 20, `only ${schema.fields.length} fields exposed`);
  for (const f of schema.fields) {
    assert.ok(f.operators.length > 0, `${f.code} has no usable operators`);
  }
});

/* ------------------------------------------------------------- output */

console.log('\ncondition tree');
for (const r of results) {
  console.log(`  ${r.ok ? '  ok' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n         → ${r.error}`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}\n`);
void db;
void run;
process.exit(failed ? 1 : 0);
