/**
 * Advanced search.
 *
 * Three things are worth proving:
 *
 *   1. The compiled SQL and the in-memory evaluator select the same rows. They
 *      are two implementations of one meaning, and the first condition compiler
 *      shipped with a case-folding bug that made them disagree on 17 rows.
 *   2. A field the caller cannot read cannot be filtered on either. A filter is
 *      an exfiltration channel: `pan starts_with A`, `AB`, `ABC` recovers a
 *      value that is never displayed.
 *   3. Search narrows to what the caller may see. It is a different way to ask,
 *      not a different answer.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run, db } from '../src/db.js';
import { seedMetadata, seedPicklists } from '../src/engine/metadata.js';
import {
  registryFor, validateTree, compile, evaluate, runSearch, searchIds,
  operatorsFor, describe, OPERATORS, SEARCHABLE,
} from '../src/engine/search.js';

/* Source read from disk, so line endings are whatever git checked out --
   CRLF on Windows. Every pattern below is written with \n, so normalise once
   here rather than in each assertion. */
const CRLF = /\r\n/g;

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

seedMetadata();
seedPicklists();

const holder = { id: 1 };
const caps = new Set(['pii.unmask']);
const noCaps = new Set();
const reg = registryFor('lead', holder, caps);

/* --------------------------------------------------------- the registry */

console.log('\nRegistry');

test('every searchable object points at a real table', () => {
  for (const [key, spec] of Object.entries(SEARCHABLE)) {
    const table = spec.table.split(' ')[0];
    const cols = all('SELECT name FROM pragma_table_info(?)', [table]);
    assert(cols.length > 0, `${key} points at missing table ${table}`);
  }
});

test('every registered field maps to a type the operators understand', () => {
  for (const entity of Object.keys(SEARCHABLE)) {
    const r = registryFor(entity, holder, caps);
    for (const [name, f] of Object.entries(r)) {
      assert(operatorsFor(f.type).length > 0, `${entity}.${name} is ${f.type}, which has no operators`);
    }
  }
});

test('the operators the user asked for by name exist', () => {
  for (const key of ['contains', 'not_contains', 'is_blank', 'is_not_blank', 'eq']) {
    assert(OPERATORS[key], `${key} is missing`);
  }
  const textOps = operatorsFor('text').map((o) => o.key);
  for (const key of ['contains', 'not_contains', 'is_blank', 'is_not_blank']) {
    assert(textOps.includes(key), `${key} is not offered on a text field`);
  }
});

test('an operator that needs no value says so', () => {
  const blank = operatorsFor('text').find((o) => o.key === 'is_blank');
  assert(blank.noValue, 'is_blank asks for a value it cannot use');
});

/* ------------------------------------------ the two evaluators agree */

console.log('\nThe compiler and the evaluator agree');

/** Run one tree both ways over the same rows and require the same answer. */
function agree(tree, label) {
  const err = validateTree(tree, reg);
  assert(!err, `${label}: ${err}`);

  const { sql, params } = compile(tree, reg);
  const fromSql = all(
    `SELECT l.id FROM leads l WHERE l.deleted_at IS NULL AND ${sql} ORDER BY l.id`, params,
  ).map((r) => r.id);

  const rows = all('SELECT * FROM leads l WHERE l.deleted_at IS NULL ORDER BY l.id');
  const fromJs = rows.filter((r) => evaluate(tree, r, reg)).map((r) => r.id);

  assert.deepEqual(fromSql, fromJs,
    `${label}: SQL matched ${fromSql.length} rows, the evaluator matched ${fromJs.length}`);
  return fromSql.length;
}

test('equality agrees, and is case-insensitive on both sides', () => {
  agree({ op: 'AND', children: [{ field: 'stage', operator: 'eq', value: 'New' }] }, 'eq New');
  agree({ op: 'AND', children: [{ field: 'stage', operator: 'eq', value: 'new' }] }, 'eq lowercase');
  agree({ op: 'AND', children: [{ field: 'stage', operator: 'eq', value: 'NEW' }] }, 'eq uppercase');
});

test('contains and does-not-contain agree, and partition the rows', () => {
  const yes = agree({ op: 'AND', children: [{ field: 'source', operator: 'contains', value: 'a' }] }, 'contains');
  const no = agree({ op: 'AND', children: [{ field: 'source', operator: 'not_contains', value: 'a' }] }, 'not_contains');
  const total = one('SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL').n;
  assert.equal(yes + no, total, `${yes} + ${no} != ${total} — rows were lost or double-counted`);
});

test('blank and not-blank agree, and partition the rows', () => {
  const blank = agree({ op: 'AND', children: [{ field: 'email', operator: 'is_blank' }] }, 'is_blank');
  const filled = agree({ op: 'AND', children: [{ field: 'email', operator: 'is_not_blank' }] }, 'is_not_blank');
  const total = one('SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL').n;
  assert.equal(blank + filled, total, `${blank} + ${filled} != ${total}`);
});

test('not-equal includes rows where the field is null', () => {
  // Without a COALESCE, SQL silently drops null rows and disagrees with the
  // evaluator, which treats null as "not equal to anything".
  agree({ op: 'AND', children: [{ field: 'city', operator: 'neq', value: 'Mumbai' }] }, 'neq');
});

test('starts_with, ends_with and in agree', () => {
  agree({ op: 'AND', children: [{ field: 'name', operator: 'starts_with', value: 'A' }] }, 'starts_with');
  agree({ op: 'AND', children: [{ field: 'name', operator: 'ends_with', value: 'a' }] }, 'ends_with');
  agree({ op: 'AND', children: [{ field: 'stage', operator: 'in', value: 'New,Contacted' }] }, 'in');
  agree({ op: 'AND', children: [{ field: 'stage', operator: 'not_in', value: 'New,Contacted' }] }, 'not_in');
});

test('a nested AND over OR agrees', () => {
  agree({
    op: 'AND',
    children: [
      { field: 'source', operator: 'is_not_blank' },
      { op: 'OR', children: [
        { field: 'stage', operator: 'eq', value: 'New' },
        { field: 'stage', operator: 'eq', value: 'Contacted' },
      ] },
    ],
  }, 'nested');
});

test('three levels of nesting agree', () => {
  agree({
    op: 'OR',
    children: [
      { field: 'stage', operator: 'eq', value: 'Won' },
      { op: 'AND', children: [
        { field: 'source', operator: 'is_not_blank' },
        { op: 'OR', children: [
          { field: 'city', operator: 'contains', value: 'a' },
          { field: 'city', operator: 'is_blank' },
        ] },
      ] },
    ],
  }, 'three deep');
});

/* ------------------------------------------------------- the exfil gate */

console.log('\nA filter is an exfiltration channel');

test('an encrypted field is filterable by nobody, holder or not', () => {
  /* This used to assert that a pii.unmask holder could filter on PAN. They
     could — the field was offered — but the filter never matched anything:
     encryption here is randomised, so `l.pan = ?` compares a plaintext PAN
     against ciphertext that differs every time it is written. An exact, correct
     PAN returned zero rows while the builder described the filter back as "PAN
     is equal to ABCDE1000F". For a broker that is how a duplicate account gets
     opened.

     Both halves now answer the same way, which is also the stronger position
     for the exfiltration channel this section is about: a field nobody can
     filter on cannot be probed a character at a time by anybody. Exact lookup
     still exists through the blind index — see routes/ccm.js. */
  const withCap = registryFor('lead', holder, caps);
  const without = registryFor('lead', holder, noCaps);

  assert(!withCap.pan, 'PAN is offered as a filter that can only ever match nothing');
  assert(!without.pan, 'PAN is filterable without pii.unmask — it can be probed a character at a time');
});

test('the capability gate is still what hides a non-encrypted restricted field', () => {
  /* Every capability-scoped field in the schema today is encrypted, so the
     exclusion above reaches them first and this gate has nothing left to act
     on. It is still the thing standing between a restricted field and a filter,
     so it is checked directly rather than left to rot unnoticed. */
  const src = readFileSync(new URL('../src/engine/search.js', import.meta.url), 'utf8').replace(CRLF, '\n');
  assert(/read_scope === 'capability'/.test(src) && /caps\.has\(f\.read_capability\)/.test(src),
    'the capability gate has gone from registryFor');
});

test('naming a hidden field directly is rejected like an unknown one', () => {
  const without = registryFor('lead', holder, noCaps);
  const err = validateTree(
    { op: 'AND', children: [{ field: 'pan', operator: 'starts_with', value: 'AB' }] },
    without,
  );
  assert(err, 'a hidden field was accepted in a condition');
  assert.match(err, /not a field you can filter on/);
});

test('an owner-scoped field is never filterable', () => {
  // `interaction.body` is readable per record by the owner and their manager.
  // That cannot be expressed as a WHERE clause, so it is not offered at all
  // rather than being offered and enforced wrongly.
  const r = registryFor('interaction', holder, caps);
  assert(!r.body, 'the notes body is filterable — its per-record rule cannot survive a filter');
  assert(!r.recording_url, 'the recording URL is filterable');
  assert(r.type, 'the channel should still be filterable');
  assert(r.disposition, 'the outcome should still be filterable');
});

test('an unknown operator is rejected', () => {
  const err = validateTree({ op: 'AND', children: [{ field: 'name', operator: 'drop_table', value: 'x' }] }, reg);
  assert(err);
  assert.match(err, /not an operator/);
});

test('an operator that does not fit the field type is rejected', () => {
  const err = validateTree({ op: 'AND', children: [{ field: 'created_at', operator: 'contains', value: 'x' }] }, reg);
  assert(err);
  assert.match(err, /does not apply/);
});

test('a value is required when the operator needs one', () => {
  const err = validateTree({ op: 'AND', children: [{ field: 'name', operator: 'eq', value: '' }] }, reg);
  assert(err);
  assert.match(err, /needs a value/);
});

test('runaway nesting and node counts are refused', () => {
  let deep = { field: 'name', operator: 'is_not_blank' };
  for (let i = 0; i < 9; i += 1) deep = { op: 'AND', children: [deep] };
  assert(validateTree(deep, reg), 'a tree nested nine deep was accepted');

  const wide = { op: 'AND', children: Array.from({ length: 80 }, () => ({ field: 'name', operator: 'is_not_blank' })) };
  assert(validateTree(wide, reg), 'a tree with eighty conditions was accepted');
});

/* ---------------------------------------------------- values are bound */

console.log('\nValues are bound, never interpolated');

test('a quote in a value cannot break the query', () => {
  const tree = { op: 'AND', children: [{ field: 'name', operator: 'eq', value: "O'Brien'; DROP TABLE leads;--" }] };
  const { sql, params } = compile(tree, reg);

  assert(!sql.includes('DROP'), 'a value reached the SQL string');
  assert(params.some((p) => String(p).includes('brien')), 'the value was not bound');

  // And the query still runs, returning nothing rather than erroring.
  const rows = all(`SELECT id FROM leads l WHERE ${sql}`, params);
  assert.equal(rows.length, 0);
  assert(one('SELECT COUNT(*) n FROM leads').n > 0, 'the leads table is still there');
});

/* -------------------------------------------------------------- search */

console.log('\nSearching');

test('a search narrows to the scope it is given', () => {
  const unscoped = runSearch('lead', null, { registry: reg, limit: 500 });
  const scoped = runSearch('lead', null, {
    registry: reg, scopeSql: 'l.owner_id = ?', scopeParams: [2], limit: 500,
  });
  assert(scoped.total <= unscoped.total, 'a scoped search returned more than an unscoped one');
  assert.equal(scoped.total, one('SELECT COUNT(*) n FROM leads WHERE owner_id = 2 AND deleted_at IS NULL').n);
});

test('paging is stable and the total is the full count', () => {
  const first = runSearch('lead', null, { registry: reg, limit: 5, offset: 0 });
  const second = runSearch('lead', null, { registry: reg, limit: 5, offset: 5 });

  assert.equal(first.total, second.total, 'the total changed between pages');
  assert(first.rows.length <= 5);
  const overlap = first.rows.filter((r) => second.rows.some((x) => x.id === r.id));
  assert.equal(overlap.length, 0, 'the same row appeared on two pages');
});

test('searchIds returns exactly what the search matched', () => {
  const tree = { op: 'AND', children: [{ field: 'stage', operator: 'eq', value: 'New' }] };
  const ids = searchIds('lead', tree, { registry: reg });
  const { total } = runSearch('lead', tree, { registry: reg, limit: 1 });
  assert.equal(ids.length, total, `${ids.length} ids for ${total} matches`);
});

test('every object can be searched without a filter', () => {
  for (const entity of Object.keys(SEARCHABLE)) {
    const r = registryFor(entity, holder, caps);
    const out = runSearch(entity, null, { registry: r, limit: 3 });
    assert(typeof out.total === 'number', `${entity} returned no total`);
  }
});

test('a sort column comes from the registry, not from the request', () => {
  const out = runSearch('lead', null, { registry: reg, limit: 3, sort: 'name; DROP TABLE leads', dir: 'ASC' });
  assert(out.rows.length > 0, 'the search broke on a hostile sort');
  assert(one('SELECT COUNT(*) n FROM leads').n > 0, 'the leads table is gone');
});

/* --------------------------------------------------------- description */

console.log('\nDescription');

test('a tree describes itself in the labels a user chose', () => {
  const text = describe({
    op: 'AND',
    children: [
      { field: 'source', operator: 'contains', value: 'Facebook' },
      { op: 'OR', children: [
        { field: 'stage', operator: 'eq', value: 'New' },
        { field: 'stage', operator: 'eq', value: 'Contacted' },
      ] },
    ],
  }, reg);

  assert.match(text, /Source contains Facebook/);
  assert.match(text, /\(Stage is equal to New or Stage is equal to Contacted\)/);
});

test('a no-value operator describes without a dangling value', () => {
  const text = describe({ op: 'AND', children: [{ field: 'email', operator: 'is_blank' }] }, reg);
  assert.equal(text, 'Email is blank');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
void run;
db.close();
process.exit(failed ? 1 : 0);
