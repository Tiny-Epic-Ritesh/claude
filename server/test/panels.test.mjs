/**
 * Custom dashboard panels (P2-17b).
 *
 * A panel is user-authored SQL by another name, which makes this the most
 * dangerous feature in the product after ghost login. Three properties carry
 * the whole thing:
 *
 *   a shared dashboard shows each viewer THEIR OWN data
 *   a field name reaching SQL has been checked against field_def first
 *   a panel that cannot work is refused rather than saved
 *
 * The first is a data-leak test wearing a chart. The second is the injection
 * defence — a grouping is a column name and cannot be a bound parameter, so the
 * whitelist is the only thing standing there.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import {
  SOURCES, MEASURES, columnsFor, compileFilters, validatePanel, runPanel, kindsFor,
  MAX_GROUPS, MAX_SERIES,
} from '../src/engine/panels.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nDashboard panels');

const userBy = (role) => one('SELECT * FROM users WHERE role = ? AND active = 1 LIMIT 1', [role]);
const asReq = (user) => ({ user, headers: {}, get: () => null, query: {} });

/* ------------------------------------------------------------ scoping */

test('every source narrows rows to the viewer, without exception', () => {
  /* A source without a scope is a cross-book leak with a chart on top. This is
     structural: adding one without a scope function fails here rather than in
     production. */
  for (const [key, src] of Object.entries(SOURCES)) {
    assert.equal(typeof src.scope, 'function', `source "${key}" has no scope function`);
    const scope = src.scope(userBy('sales_rm'), null);
    assert(scope.sql && scope.sql !== '1=1',
      `source "${key}" scopes to everything for a Sales RM`);
  }
});

test('the same panel gives a supervisor and an RM different numbers', () => {
  /* THE property. A shared dashboard shares the question, never the answer —
     otherwise publishing one would be publishing the rows behind it. */
  const panel = { title: 'Leads', source: 'lead', kind: 'tile', measure: { fn: 'count' } };
  const sup = runPanel(asReq(userBy('sales_supervisor')), panel, null).value;
  const rm = runPanel(asReq(userBy('sales_rm')), panel, null).value;

  assert(sup > 0 && rm > 0, `expected both to see something: supervisor ${sup}, rm ${rm}`);
  assert(rm < sup, `an RM should see fewer leads than their supervisor: ${rm} vs ${sup}`);
});

test('a panel never reaches across the book boundary', () => {
  const bigulRm = one("SELECT * FROM users WHERE role = 'sales_rm' AND sales_org = 'BIGUL' AND active = 1 LIMIT 1");
  if (!bigulRm) return;

  const bonanzaOnly = one("SELECT COUNT(*) n FROM leads WHERE sales_org = 'BONANZA' AND deleted_at IS NULL").n;
  const seen = runPanel(asReq(bigulRm), { title: 'x', source: 'lead', kind: 'tile', measure: { fn: 'count' } }, null).value;
  const bigulTotal = one("SELECT COUNT(*) n FROM leads WHERE sales_org = 'BIGUL' AND deleted_at IS NULL").n;

  assert(seen <= bigulTotal,
    `a Bigul RM counted ${seen} leads when Bigul only has ${bigulTotal} — the other book leaked in`);
  assert(bonanzaOnly > 0, 'fixture problem: no Bonanza leads to leak');
});

/* -------------------------------------------------------- the whitelist */

test('a field name that is not a field is refused, not interpolated', () => {
  /* The injection defence, stated as the test it is. */
  for (const attempt of [
    'stage; DROP TABLE leads--',
    "stage' OR '1'='1",
    '(SELECT password FROM users LIMIT 1)',
    '../../etc/passwd',
  ]) {
    const bad = validatePanel({ title: 'x', source: 'lead', kind: 'bar', group_by: attempt });
    assert(bad, `grouping by ${JSON.stringify(attempt)} was accepted`);
    assert.throws(() => compileFilters('lead', { all: [{ field: attempt, op: 'eq', value: '1' }] }, 'l'),
      `filtering on ${JSON.stringify(attempt)} did not throw`);
  }
});

test('an encrypted field is not offered and cannot be named', () => {
  /* Grouping by PAN would produce a chart whose axis labels are client
     identifiers — a masking bypass drawn as a bar chart. */
  for (const src of ['lead', 'client']) {
    assert(!columnsFor(src).some((c) => c.api_name === 'pan'),
      `${src} offers PAN as a groupable column`);
    assert(validatePanel({ title: 'x', source: src, kind: 'bar', group_by: 'pan' }),
      `${src} accepted a grouping by PAN`);
  }
});

test('every offered column is a real column of the real table', () => {
  for (const [key, src] of Object.entries(SOURCES)) {
    const real = new Set(all(`PRAGMA table_info(${src.table})`).map((c) => c.name));
    for (const col of columnsFor(key)) {
      assert(real.has(col.api_name), `${key} offers "${col.api_name}", which ${src.table} does not have`);
    }
  }
});

test('a value is always a parameter, never part of the SQL', () => {
  const { sql, params } = compileFilters('lead',
    { all: [{ field: 'stage', op: 'eq', value: "Won'; DROP TABLE leads--" }] }, 'l');
  assert(!sql.includes('DROP'), `the value was interpolated into SQL: ${sql}`);
  assert(params.includes("Won'; DROP TABLE leads--"), 'the value was not passed as a parameter');
});

/* --------------------------------------------------------- authoring */

test('a panel that cannot work is refused before it is saved', () => {
  assert(validatePanel({ source: 'lead', kind: 'tile' }), 'a panel with no title was accepted');
  assert(validatePanel({ title: 'x', source: 'nope' }), 'an unknown source was accepted');
  assert(validatePanel({ title: 'x', source: 'lead', measure: { fn: 'sum' } }),
    'a total with nothing to total was accepted');
  assert(validatePanel({ title: 'x', source: 'lead', measure: { fn: 'sum', field: 'stage' } }),
    'a total of a text field was accepted');
  assert(validatePanel({ title: 'x', source: 'lead', kind: 'bar' }),
    'a chart with nothing to group by was accepted');
  assert.equal(validatePanel({ title: 'Leads by stage', source: 'lead', kind: 'bar', group_by: 'stage' }), null);
});

test('free text cannot be grouped by', () => {
  // One bar per record is not a chart, it is a list with extra steps.
  const textField = columnsFor('lead').find((c) => !c.groupable);
  if (!textField) return;
  assert(validatePanel({ title: 'x', source: 'lead', kind: 'bar', group_by: textField.api_name }),
    `grouping by the free-text field ${textField.api_name} was accepted`);
});

/* ------------------------------------------------------------ running */

test('a chart cannot return more points than a chart can draw', () => {
  const res = runPanel(asReq(userBy('superadmin')),
    { title: 'x', source: 'lead', kind: 'bar', group_by: 'name', limit: 500 }, null);
  assert(res.data.length <= MAX_GROUPS, `returned ${res.data.length} points`);
});

test('an empty result is zero, not an error and not a blank', () => {
  const res = runPanel(asReq(userBy('sales_rm')), {
    title: 'x', source: 'lead', kind: 'tile', measure: { fn: 'count' },
    filters: { all: [{ field: 'stage', op: 'eq', value: 'NoSuchStageAnywhere' }] },
  }, null);
  assert.equal(res.value, 0);
});

test('a total over no rows is zero rather than null', () => {
  // COALESCE, so a tile reads "0" instead of an empty box.
  const res = runPanel(asReq(userBy('sales_rm')), {
    title: 'x', source: 'lead', kind: 'tile', measure: { fn: 'sum', field: 'aum' },
    filters: { all: [{ field: 'stage', op: 'eq', value: 'NoSuchStageAnywhere' }] },
  }, null);
  assert.equal(res.value, 0);
  assert(Number.isFinite(res.value), 'a sum over nothing was not a number');
});

test('every measure produces a finite number', () => {
  for (const [fn, m] of Object.entries(MEASURES)) {
    const panel = {
      title: 'x', source: 'lead', kind: 'tile',
      measure: m.needsField ? { fn, field: m.numeric ? 'aum' : 'stage' } : { fn },
    };
    const res = runPanel(asReq(userBy('superadmin')), panel, null);
    assert(Number.isFinite(res.value), `measure "${fn}" produced ${res.value}`);
  }
});

/* ------------------------------------------------- the second dimension */

test('splitting does not change the totals', () => {
  /* The property that makes a split trustworthy. If the same question answered
     two ways disagrees, one of the two is wrong and a reader has no way to
     tell which — so a stacked column has to come to exactly what the plain bar
     did. */
  const req = asReq(userBy('superadmin'));
  const base = { title: 'x', source: 'lead', measure: { fn: 'count' }, group_by: 'stage' };

  const plain = runPanel(req, { ...base, kind: 'bar' }, null);
  const split = runPanel(req, { ...base, kind: 'stacked', split_by: 'source' }, null);

  const plainTotals = new Map(plain.data.map((d) => [d.label, d.value]));
  for (const point of split.data) {
    const summed = Object.values(point.values).reduce((a, b) => a + b, 0);
    assert.equal(summed, plainTotals.get(point.label),
      `"${point.label}" sums to ${summed} split but ${plainTotals.get(point.label)} unsplit`);
  }
  assert.equal(split.data.length, plain.data.length, 'the split lost or gained an axis point');
});

test('the tail is folded into Other rather than dropped', () => {
  const split = runPanel(asReq(userBy('superadmin')),
    { title: 'x', source: 'lead', kind: 'grouped', group_by: 'stage', split_by: 'source' }, null);

  assert(split.series.length <= MAX_SERIES + 1, `${split.series.length} series is more than a chart can show`);
  if (split.folded > 0) {
    assert(split.series.includes('Other'), 'a tail was folded away with nowhere to put it');
  }
});

test('every axis point carries a value for every series', () => {
  /* A stacked bar with a hole in it is not a shorter bar — it is a bar that
     silently means something different from its neighbours. */
  const split = runPanel(asReq(userBy('superadmin')),
    { title: 'x', source: 'lead', kind: 'stacked', group_by: 'stage', split_by: 'source' }, null);

  for (const point of split.data) {
    for (const name of split.series) {
      assert(Number.isFinite(point.values[name]),
        `"${point.label}" has no value for series "${name}"`);
    }
  }
});

test('a split is scoped like everything else', () => {
  // A second dimension is a second chance to forget the scope.
  const sup = runPanel(asReq(userBy('sales_supervisor')),
    { title: 'x', source: 'lead', kind: 'grouped', group_by: 'stage', split_by: 'source' }, null);
  const rm = runPanel(asReq(userBy('sales_rm')),
    { title: 'x', source: 'lead', kind: 'grouped', group_by: 'stage', split_by: 'source' }, null);

  const total = (r) => r.data.reduce((acc, p) => acc + Object.values(p.values).reduce((a, b) => a + b, 0), 0);
  assert(total(rm) < total(sup), `an RM saw ${total(rm)} and their supervisor ${total(sup)}`);
});

test('a split over time keeps its buckets in order', () => {
  const split = runPanel(asReq(userBy('superadmin')),
    { title: 'x', source: 'lead', kind: 'stacked', grain: 'month', split_by: 'source' }, null);
  const labels = split.data.map((d) => d.label);
  assert.deepEqual(labels, [...labels].sort(), 'time buckets came back out of order');
});

test('a split needs something to split, and something else to split by', () => {
  assert(validatePanel({ title: 'x', source: 'lead', kind: 'grouped', split_by: 'source' }),
    'a split with no grouping was accepted');
  assert(validatePanel({ title: 'x', source: 'lead', kind: 'grouped', group_by: 'stage', split_by: 'stage' }),
    'a panel split by the field it is already grouped by was accepted');
  assert(validatePanel({ title: 'x', source: 'lead', kind: 'grouped', group_by: 'stage', split_by: 'nope' }),
    'a split by an unknown field was accepted');
  assert.equal(validatePanel({ title: 'x', source: 'lead', kind: 'grouped', group_by: 'stage', split_by: 'source' }), null);
});

test('a split panel is only offered charts that can draw two dimensions', () => {
  // A pie of two dimensions is a Marimekko, one of the four left out on purpose.
  const kinds = kindsFor({ group_by: 'stage', split_by: 'source' });
  assert.deepEqual([...kinds].sort(), ['grouped', 'stacked']);
  for (const bad of ['pie', 'donut', 'treemap', 'tile']) {
    assert(!kinds.includes(bad), `a split panel was offered "${bad}"`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
