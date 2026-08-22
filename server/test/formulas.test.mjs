/**
 * Formula and Roll-Up fields.
 *
 * Non-negotiable 3: computed values are schema, not automation. What is worth
 * proving is not that the arithmetic works — it is that a bad definition is
 * refused at creation rather than failing on a record months later, and that a
 * roll-up agrees with the SQL a human would have written by hand.
 */

import { strict as assert } from 'node:assert';
import { all, one, run, db } from '../src/db.js';
import { seedMetadata, fieldsOf } from '../src/engine/metadata.js';
import {
  validateFormula, validateRollup, derivedValues, describeFormula, describeRollup,
  catalogue, FORMULA_KINDS, ROLLUP_AGGS, ROLLUP_SOURCES,
} from '../src/engine/formulas.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

seedMetadata();

const leadId = one('SELECT id FROM leads ORDER BY id LIMIT 1').id;
const OWN = [];

/** Create a derived field for one test and remember it for cleanup. */
function makeField(apiName, type, def, extra = {}) {
  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, ${type}, purpose, history_tracked, is_custom)
     VALUES ('lead', ?, ?, ?, 'derived', ?, 'test', ?, 1)`,
    [apiName, apiName, type, JSON.stringify(def), extra.history_tracked ?? 0],
  );
  OWN.push(apiName);
}

/* ------------------------------------------------------- the catalogue */

console.log('\nCatalogue');

test('every formula kind declares what it needs', () => {
  for (const [key, k] of Object.entries(FORMULA_KINDS)) {
    assert(k.label, `${key} has no label`);
    assert(Array.isArray(k.inputs), `${key} declares no inputs`);
    assert(k.returns, `${key} does not say what it returns`);
    for (const i of k.inputs) {
      assert(i.name && i.label && i.type, `${key} has an incomplete input`);
    }
  }
});

test('every roll-up source points at a real table with a real column', () => {
  for (const [entity, sources] of Object.entries(ROLLUP_SOURCES)) {
    for (const s of sources) {
      const cols = new Set(all('SELECT name FROM pragma_table_info(?)', [s.table]).map((c) => c.name));
      assert(cols.size > 0, `${entity}.${s.key} points at missing table ${s.table}`);
      assert(cols.has(s.fk), `${s.table} has no ${s.fk} to join on`);
      for (const f of Object.keys(s.fields)) {
        assert(cols.has(f), `${s.table} has no column ${f}`);
      }
    }
  }
});

test('the Setup form gets everything it needs to render itself', () => {
  const c = catalogue('lead');
  assert(Object.keys(c.formulas).length > 0);
  assert(Object.keys(c.aggregates).length > 0);
  assert(c.sources.length > 0);
  assert(c.fields.length > 0, 'no fields offered to build a formula from');
  // A formula must never be offered another formula as an input.
  assert(!c.fields.some((f) => ['formula', 'rollup', 'auto_number'].includes(f.type)),
    'the picker offers a derived field as an input');
});

/* --------------------------------------------------------- validation */

console.log('\nRefused at creation, not at runtime');

test('an unknown field is refused', () => {
  const r = validateFormula('lead', { kind: 'days_since', field: 'not_a_field' });
  assert(!r.ok);
  assert.match(r.error, /not a field/);
});

test('the wrong field type is refused, and says what it wanted', () => {
  const r = validateFormula('lead', { kind: 'days_since', field: 'name' });
  assert(!r.ok);
  assert.match(r.error, /date/);
});

test('a formula over another formula is refused', () => {
  // This is how a dependency cycle starts. Refusing it here means the compute
  // path never has to detect one.
  makeField('probe_days', 'formula', { kind: 'days_since', field: 'created_at' });
  const r = validateFormula('lead', { kind: 'days_since', field: 'probe_days' });
  assert(!r.ok);
  assert.match(r.error, /itself computed/);
});

test('a missing required input is refused', () => {
  const r = validateFormula('lead', { kind: 'days_between', from: 'created_at' });
  assert(!r.ok);
  assert.match(r.error, /required/i);
});

test('dividing by a literal zero is refused', () => {
  // Lead carries no numeric core column, so arithmetic needs a custom one —
  // which is also the realistic case, since numbers people divide tend to be
  // fields an administrator added.
  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, purpose, is_custom)
     VALUES ('lead','f_amount','Amount','number','value','test',1)`,
  );
  OWN.push('f_amount');

  const r = validateFormula('lead', { kind: 'arithmetic', left: 'f_amount', op: '/', right: '0' });
  assert(!r.ok, 'division by zero was accepted');
  assert.match(r.error, /zero/i);

  const ok = validateFormula('lead', { kind: 'arithmetic', left: 'f_amount', op: '/', right: '2' });
  assert(ok.ok, `dividing by two should be fine: ${ok.error}`);
});

test('age_in_stage needs the field to be history-tracked', () => {
  const ok = validateFormula('lead', { kind: 'age_in_stage', field: 'stage' });
  assert(ok.ok, `stage is tracked, so this should pass: ${ok.error}`);

  const bad = validateFormula('lead', { kind: 'age_in_stage', field: 'source' });
  assert(!bad.ok, 'an untracked field was accepted');
  assert.match(bad.error, /tracking/i);
});

test('a roll-up over an unregistered table is refused', () => {
  const r = validateRollup('lead', { source: 'sessions', agg: 'count' });
  assert(!r.ok);
  assert.match(r.error, /not available/);
});

test('summing a text column is refused', () => {
  const r = validateRollup('lead', { source: 'interactions', agg: 'sum', field: 'type' });
  assert(!r.ok);
  assert.match(r.error, /cannot be summed/);
});

test('filtering a roll-up on an unregistered column is refused', () => {
  const r = validateRollup('lead', { source: 'interactions', agg: 'count', where: { secret: 1 } });
  assert(!r.ok);
  assert.match(r.error, /Cannot filter/);
});

/* ------------------------------------------------------------ compute */

console.log('\nComputation');

test('days_since counts whole days from a real timestamp', () => {
  makeField('f_days', 'formula', { kind: 'days_since', field: 'created_at' });
  const lead = one('SELECT * FROM leads WHERE id = ?', [leadId]);
  const v = derivedValues('lead', lead).f_days;

  const expected = Math.floor((Date.now() - Date.parse(`${lead.created_at.replace(' ', 'T')}Z`)) / 86_400_000);
  assert.equal(v, expected, `got ${v}, expected ${expected}`);
});

test('a roll-up agrees with the SQL a human would write', () => {
  makeField('f_call_secs', 'rollup', { source: 'interactions', agg: 'sum', field: 'duration_s', where: { type: 'Call' } });
  const lead = one('SELECT * FROM leads WHERE id = ?', [leadId]);

  const mine = derivedValues('lead', lead).f_call_secs;
  const theirs = one("SELECT SUM(duration_s) v FROM activities WHERE lead_id = ? AND type = 'Call'", [leadId]).v;
  assert.equal(mine, theirs == null ? null : Math.round(theirs * 100) / 100);
});

test('count needs no field and counts every child', () => {
  makeField('f_acts', 'rollup', { source: 'interactions', agg: 'count' });
  const lead = one('SELECT * FROM leads WHERE id = ?', [leadId]);

  assert.equal(
    derivedValues('lead', lead).f_acts,
    one('SELECT COUNT(*) v FROM activities WHERE lead_id = ?', [leadId]).v,
  );
});

test('arithmetic guards a divisor that is zero on this record', () => {
  // Validation cannot see this: the divisor is a field, and it happens to be
  // zero on some rows. Returning null beats returning Infinity.
  makeField('f_div', 'formula', { kind: 'arithmetic', left: 'mobile_invalid', op: '/', right: 'marketing_opt_out' });
  const lead = { id: leadId, mobile_invalid: 1, marketing_opt_out: 0 };
  assert.equal(derivedValues('lead', lead).f_div, null);
});

test('if_then picks the branch it should', () => {
  makeField('f_flag', 'formula', {
    kind: 'if_then', field: 'stage', op: 'equals', value: 'Won',
    then: 'Converted', otherwise: 'In flight',
  });
  assert.equal(derivedValues('lead', { id: leadId, stage: 'Won' }).f_flag, 'Converted');
  assert.equal(derivedValues('lead', { id: leadId, stage: 'New' }).f_flag, 'In flight');
});

test('concat skips empty parts rather than leaving separators', () => {
  makeField('f_where', 'formula', { kind: 'concat', fields: ['city', 'state'], separator: ', ' });
  assert.equal(derivedValues('lead', { id: leadId, city: 'Pune', state: 'MH' }).f_where, 'Pune, MH');
  assert.equal(derivedValues('lead', { id: leadId, city: 'Pune', state: null }).f_where, 'Pune');
  assert.equal(derivedValues('lead', { id: leadId, city: null, state: null }).f_where, null);
});

test('a missing input yields null, not a crash or a wrong number', () => {
  makeField('f_gap', 'formula', { kind: 'days_since', field: 'next_follow_up_at' });
  assert.equal(derivedValues('lead', { id: leadId, next_follow_up_at: null }).f_gap, null);
});

test('a broken definition empties one field, not the whole record', () => {
  run(
    `INSERT INTO field_def (entity, api_name, label, type, storage, formula, purpose, is_custom)
     VALUES ('lead','f_broken','Broken','formula','derived','{ not json', 'test', 1)`,
  );
  OWN.push('f_broken');

  const lead = one('SELECT * FROM leads WHERE id = ?', [leadId]);
  const out = derivedValues('lead', lead);
  assert('f_days' in out, 'a broken sibling took the good fields down with it');
  assert.equal(out.f_broken, undefined, 'an unparseable definition produced a value');
});

test('nothing derived is ever stored', () => {
  // The whole argument: there is nothing to go stale.
  const stored = one(
    `SELECT COUNT(*) n FROM field_value v JOIN field_def f ON f.id = v.field_id
     WHERE f.storage = 'derived'`,
  ).n;
  assert.equal(stored, 0, 'a derived field wrote a stored value');
});

/* ------------------------------------------------------- descriptions */

console.log('\nDescriptions');

test('every formula describes itself in words', () => {
  const cases = [
    { kind: 'days_since', field: 'created_at' },
    { kind: 'days_between', from: 'created_at', to: 'next_follow_up_at' },
    { kind: 'if_then', field: 'stage', op: 'equals', value: 'Won', then: 'Yes', otherwise: 'No' },
    { kind: 'concat', fields: ['city', 'state'], separator: ', ' },
    { kind: 'age_in_stage', field: 'stage' },
  ];
  for (const c of cases) {
    const text = describeFormula('lead', c);
    assert(text && text !== 'Computed', `${c.kind} has no description`);
    // It should read in labels, not api names.
    assert(!text.includes('_at') || c.kind === 'days_between', `${c.kind} leaked an api name: ${text}`);
  }
});

test('a roll-up describes itself, filter included', () => {
  const text = describeRollup('lead', { source: 'interactions', agg: 'sum', field: 'duration_s', where: { type: 'Call' } });
  assert.match(text, /Sum of/);
  assert.match(text, /Interactions/);
  assert.match(text, /Call/);
});

/* --------------------------------------------------------- cleanup */

const list = OWN.map(() => '?').join(',');
if (OWN.length) {
  run(`DELETE FROM field_value WHERE field_id IN (SELECT id FROM field_def WHERE entity='lead' AND api_name IN (${list}))`, OWN);
  run(`DELETE FROM field_def WHERE entity='lead' AND api_name IN (${list})`, OWN);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
void fieldsOf;
void ROLLUP_AGGS;
db.close();
process.exit(failed ? 1 : 0);
