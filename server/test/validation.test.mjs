/**
 * Validation rules.
 *
 * The rule engine decides whether a save is refused, so its edges are the
 * edges of "can this person record what just happened". Two failure modes
 * matter in opposite directions: a rule that does not fire lets bad data in
 * quietly, and a rule that fires when it should not blocks an RM from doing
 * their job and gets the whole feature switched off.
 */

import { strict as assert } from 'node:assert';
import { matches, validateRule, assertValid, OPERATORS } from '../src/engine/validation.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nValidation rules');

/* ------------------------------------------------------------ matching */

test('a rule fires when its condition matches, which is when something is wrong', () => {
  const c = { all: [{ field: 'stage', op: 'eq', value: 'Won' }, { field: 'pan', op: 'is_blank' }] };
  assert.equal(matches(c, { stage: 'Won', pan: null }), true, 'Won with no PAN should be refused');
  assert.equal(matches(c, { stage: 'Won', pan: 'AAAPZ1234C' }), false, 'Won with a PAN is fine');
  assert.equal(matches(c, { stage: 'New', pan: null }), false, 'not Won, so the rule is irrelevant');
});

test('all means all, any means any', () => {
  const clauses = [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '2' }];
  assert.equal(matches({ all: clauses }, { a: '1', b: '9' }), false);
  assert.equal(matches({ any: clauses }, { a: '1', b: '9' }), true);
});

test('an empty condition never fires', () => {
  // Otherwise a half-written rule refuses every save of every record.
  assert.equal(matches({ all: [] }, { anything: 1 }), false);
  assert.equal(matches(null, {}), false);
  assert.equal(matches(undefined, {}), false);
  assert.equal(matches({}, {}), false);
});

test('an unknown operator never fires', () => {
  /* Fails open, deliberately, and only here. A rule the engine cannot
     understand must not block every save on the object — the rule is broken,
     the business is not. It shows as a rule that never fires, which is
     visible; refusing everything would look like an outage. */
  assert.equal(matches({ all: [{ field: 'x', op: 'wat', value: 1 }] }, { x: 1 }), false);
});

test('blankness treats whitespace as blank', () => {
  for (const v of [null, undefined, '', '   ', '\t']) {
    assert.equal(OPERATORS.is_blank.test(v), true, `${JSON.stringify(v)} should be blank`);
  }
  assert.equal(OPERATORS.is_blank.test('0'), false, '"0" is a value, not blank');
  assert.equal(OPERATORS.is_blank.test(0), false, 'zero is a value, not blank');
});

test('comparison ignores case and surrounding space', () => {
  // Picklist values arrive from imports with both.
  assert.equal(OPERATORS.eq.test(' Won ', 'won'), true);
  assert.equal(OPERATORS.ne.test('Won', 'Lost'), true);
  assert.equal(OPERATORS.in.test('Won', 'Lost, Won, New'), true);
  assert.equal(OPERATORS.not_in.test('Won', 'Lost, New'), true);
});

test('a numeric comparison on non-numeric text does not fire', () => {
  /* "greater than 0" against the text "abc" must be false, not NaN-truthy.
     A ledger balance that failed to parse should not be treated as a balance
     the client owes. */
  assert.equal(OPERATORS.gt.test('abc', '0'), false);
  assert.equal(OPERATORS.gt.test(null, '0'), false);
  assert.equal(OPERATORS.gt.test('5', '0'), true);
  assert.equal(OPERATORS.lt.test('', '10'), false);
});

test('a broken pattern does not throw on every save', () => {
  /* A regex an administrator typo'd runs on every write to the object. It has
     to fail to match, not take the object down. */
  assert.doesNotThrow(() => matches({ all: [{ field: 'x', op: 'matches', value: '([' }] }, { x: 'a' }));
  assert.equal(matches({ all: [{ field: 'x', op: 'matches', value: '([' }] }, { x: 'a' }), false);
});

/* -------------------------------------------------- the record as saved */

test('rules see the record as it would be, not as it is', () => {
  /* The one that decides whether this works at all. An administrator writing
     "refuse when stage is Won and PAN is blank" means the resulting record.
     Evaluating the stored row would let the offending save straight through,
     because the stored row is not Won yet. */
  const existing = { stage: 'New', pan: null, sales_org: 'BONANZA' };
  const failures = assertValid('lead', { existing, patch: { stage: 'Won' } });
  assert(failures, 'the save that creates the bad state was allowed');
  assert(/PAN/i.test(failures[0].message), `unexpected message: ${failures[0].message}`);
});

test('a patch that fixes the problem in the same save is allowed', () => {
  // Otherwise the only way to fix a record is a sequence of saves that are
  // each individually refused.
  const existing = { stage: 'New', pan: null, sales_org: 'BONANZA' };
  assert.equal(assertValid('lead', { existing, patch: { stage: 'Won', pan: 'AAAPZ1234C' } }), null);
});

test('an undefined field in the patch does not erase the stored value', () => {
  // JSON bodies carry undefined for "not mentioned"; treating that as a clear
  // would make every partial update trip every not-blank rule.
  const existing = { stage: 'New', pan: 'AAAPZ1234C', sales_org: 'BONANZA' };
  assert.equal(assertValid('lead', { existing, patch: { stage: 'Won', pan: undefined } }), null);
});

/* ---------------------------------------------------------- authoring */

test('a rule must name fields the object actually has', () => {
  const bad = validateRule('lead', {
    message: 'nope', condition: { all: [{ field: 'not_a_field', op: 'is_blank' }] },
  });
  assert(bad, 'an unknown field was accepted');
  assert(/not a field/i.test(bad.error), bad.error);
});

test('a rule must carry a message somebody can act on', () => {
  for (const message of ['', '   ', undefined]) {
    const bad = validateRule('lead', { message, condition: { all: [{ field: 'pan', op: 'is_blank' }] } });
    assert(bad, `a rule with message ${JSON.stringify(message)} was accepted`);
  }
});

test('an operator that needs a value is refused without one', () => {
  const bad = validateRule('lead', {
    message: 'm', condition: { all: [{ field: 'stage', op: 'eq', value: '' }] },
  });
  assert(bad, 'eq with no value was accepted');
});

test('a numeric operator is refused a non-number', () => {
  const bad = validateRule('lead', {
    message: 'm', condition: { all: [{ field: 'aum', op: 'gt', value: 'lots' }] },
  });
  assert(bad, '"greater than lots" was accepted');
});

test('a valid rule passes authoring checks', () => {
  assert.equal(validateRule('lead', {
    message: 'A lead cannot be Won without a PAN.',
    condition: { all: [{ field: 'stage', op: 'eq', value: 'Won' }, { field: 'pan', op: 'is_blank' }] },
  }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
