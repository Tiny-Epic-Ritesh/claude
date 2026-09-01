/**
 * Matching a call back to a person.
 *
 * CUBE's `AuthCallLog` does not return `ClientId`, though both dialling
 * endpoints accept it, so the only join back to a lead is the phone number.
 * A demat account per family member on one handset is ordinary in Indian
 * broking, which makes that join ambiguous in exactly the cases that matter.
 *
 * The rule under test is one sentence: a call attributed to the wrong family
 * member is worse than a call attributed to nobody.
 */

import { strict as assert } from 'node:assert';
import { one, run } from '../src/db.js';
import { resolveLead, recordIntent, last10, INTENT_WINDOW_MINUTES } from '../src/engine/callmatch.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nCall matching');

/* A family sharing one handset, which is the whole problem. */
const SHARED = '9812309876';
const org = one('SELECT sales_org FROM leads WHERE sales_org IS NOT NULL LIMIT 1')?.sales_org ?? 'BONANZA';
const owner = one("SELECT id FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1")?.id ?? null;

run('DELETE FROM call_intent');
run('DELETE FROM leads WHERE mobile = ?', [SHARED]);
const father = Number(run(
  'INSERT INTO leads (name, mobile, sales_org, owner_id, stage) VALUES (?,?,?,?,?)',
  ['Ramesh Patel', SHARED, org, owner, 'New'],
).lastInsertRowid);
const son = Number(run(
  'INSERT INTO leads (name, mobile, sales_org, owner_id, stage) VALUES (?,?,?,?,?)',
  ['Nikhil Patel', SHARED, org, owner, 'New'],
).lastInsertRowid);

/* ------------------------------------------------------------ the refusal */

test('a number two people share resolves to neither', () => {
  const r = resolveLead({ mobile: SHARED });
  assert.equal(r.match, 'ambiguous', `expected ambiguous, got "${r.match}"`);
  assert.equal(r.lead, null, `it picked ${r.lead?.name} instead of refusing`);
});

test('the refusal names who it could have been', () => {
  // Refusing without saying what it refused between just loses the call.
  const ids = resolveLead({ mobile: SHARED }).candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, [father, son].sort());
});

test('it does not pick the most recently created, which is what it used to do', () => {
  const r = resolveLead({ mobile: SHARED });
  assert.notEqual(r.lead?.id, son, 'still resolving to the newest matching lead');
});

/* --------------------------------------------------------- the dial intent */

test('a call we placed ourselves is matched exactly, not inferred', () => {
  /* The point of recording intent: we are not guessing who was rung, we are
     reading back what we asked the switch to do. */
  recordIntent({ mobile: SHARED, leadId: father, userId: owner, callId: 'CID-1' });
  const r = resolveLead({ mobile: SHARED });
  assert.equal(r.match, 'intent');
  assert.equal(r.lead.id, father, `resolved to ${r.lead.name}, not the person we dialled`);
});

test('the call id matches even when the number does not come back', () => {
  const r = resolveLead({ callId: 'CID-1' });
  assert.equal(r.match, 'intent');
  assert.equal(r.lead.id, father);
});

test('an intent older than the window is not used', () => {
  // Otherwise tomorrow's call to the same number is matched to today's intent.
  run('DELETE FROM call_intent');
  recordIntent({ mobile: SHARED, leadId: father, userId: owner, callId: 'CID-OLD' });
  run("UPDATE call_intent SET created_at = datetime('now', ?)", [`-${INTENT_WINDOW_MINUTES + 60} minutes`]);
  const r = resolveLead({ mobile: SHARED });
  assert.equal(r.match, 'ambiguous', 'a stale intent was used to attribute a call');
});

/* -------------------------------------------------------------- the basics */

test('an explicit lead id always wins', () => {
  const r = resolveLead({ leadId: son, mobile: SHARED });
  assert.equal(r.match, 'id');
  assert.equal(r.lead.id, son);
});

test('a number only one person holds resolves to them', () => {
  const solo = one(
    `SELECT MIN(id) AS id, mobile FROM leads
      WHERE mobile IS NOT NULL AND mobile != ? AND deleted_at IS NULL
      GROUP BY mobile HAVING COUNT(*) = 1 LIMIT 1`,
    [SHARED],
  );
  if (!solo) return;
  const r = resolveLead({ mobile: solo.mobile });
  assert.equal(r.match, 'mobile', `"${solo.mobile}" resolved as ${r.match}`);
  assert.equal(r.lead.id, solo.id);
});

test('a number nobody holds is none, not ambiguous', () => {
  const r = resolveLead({ mobile: '0000000000' });
  assert.equal(r.match, 'none');
  assert.deepEqual(r.candidates, []);
});

test('the prefix a vendor happens to send makes no difference', () => {
  for (const form of ['+919812309876', '91 98123-09876', '09812309876', '9812309876']) {
    assert.equal(last10(form), SHARED, `${form} normalised wrong`);
  }
});

test('recording an intent never throws, whatever it is handed', () => {
  // A dial that succeeded must not be reported as failed because the
  // bookkeeping behind it did not.
  assert.equal(recordIntent({ mobile: null, leadId: null }), null);
  assert.equal(recordIntent({ mobile: SHARED, leadId: null }), null);
  assert.equal(recordIntent({ mobile: SHARED, leadId: 999999999 }), null);
});

run('DELETE FROM call_intent');
run('DELETE FROM leads WHERE mobile = ?', [SHARED]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
