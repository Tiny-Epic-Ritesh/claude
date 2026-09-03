/**
 * Content libraries and approval (P2-20 + P2-22).
 *
 * The compliance failure this exists to prevent is not somebody sending the
 * wrong document on purpose. It is a brochure quoting last year's brokerage
 * still sitting in the library four years later, because nobody set an expiry
 * and nobody was asked to look at it.
 *
 * So the properties worth testing are the ones that make that impossible to
 * reach by inaction: an expiry gets set even when nobody chooses one, an item
 * cannot be sent until somebody OTHER than its author says so, and an expired
 * item is not offered for sending at all.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run } from '../src/db.js';
import {
  mayRead, mayManage, mayTransition, expiryFor, isSendable, STATUSES,
} from '../src/engine/library.js';

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

console.log('\nContent libraries');

const userBy = (role) => one('SELECT * FROM users WHERE role = ? AND active = 1 LIMIT 1', [role]);
const libBy = (name) => one('SELECT * FROM content_library WHERE name = ?', [name]);

/* -------------------------------------------------------- the gate */

test('nothing is sendable until it is approved', () => {
  /* The composer looks for `approved`. It used to look for `active`, which
     meant "exists" rather than "somebody said this may go to a client" — a
     distinction worth having in the word itself. */
  for (const [code, s] of Object.entries(STATUSES)) {
    if (code === 'approved') { assert(s.sendable, 'approved is not sendable'); continue; }
    assert(!s.sendable, `"${code}" is sendable and should not be`);
  }
});

test('the email composer only offers approved, in-date collateral', () => {
  // Asserted on the query, because this is the one place the gate is enforced
  // for real and a change here would be silent.
  const src = readFileSync(new URL('../src/routes/email.js', import.meta.url), 'utf8').replace(CRLF, '\n');
  const offers = src.slice(src.indexOf('FROM content_items'));
  assert(/status = 'approved'/.test(offers), 'the composer no longer requires approval');
  assert(/expiry_date IS NULL OR expiry_date >= date\('now'\)/.test(offers),
    'the composer no longer excludes expired collateral');
});

test('an expired item is not sendable however approved it was', () => {
  assert.equal(isSendable({ status: 'approved', expiry_date: '2020-01-01' }), false);
  assert.equal(isSendable({ status: 'approved', expiry_date: null }), true);
  assert.equal(isSendable({ status: 'draft', expiry_date: null }), false);
});

/* ---------------------------------------------------- the author rule */

test('the person who added an item cannot be the one who approves it', () => {
  /* A second pair of eyes that belongs to the same head is not a second pair
     of eyes, and this is the entire reason the flow exists for regulatory
     collateral. */
  const admin = userBy('admin');
  const lib = libBy('Regulatory');
  const item = { id: 1, status: 'pending', created_by: admin.id };

  const refusal = mayTransition(item, lib, admin, 'approved');
  assert(refusal, 'an author approved their own item');
  assert(/other than the person who added it/i.test(refusal), refusal);

  const other = userBy('superadmin');
  assert.equal(mayTransition(item, lib, other, 'approved'), null,
    'somebody else could not approve it');
});

test('an item cannot skip the queue', () => {
  // Straight from draft to approved is how approval becomes a field somebody
  // sets on themselves.
  const other = userBy('superadmin');
  const lib = libBy('Regulatory');
  const refusal = mayTransition({ id: 1, status: 'draft', created_by: 999 }, lib, other, 'approved');
  assert(refusal, 'a draft was approved without ever being submitted');
  assert(/waiting for approval/i.test(refusal), refusal);
});

test('approving needs the content capability, not just any signed-in user', () => {
  const rm = userBy('sales_rm');
  const lib = libBy('Regulatory');
  assert(mayTransition({ id: 1, status: 'pending', created_by: 999 }, lib, rm, 'approved'),
    'a Sales RM approved client-facing collateral');
});

/* --------------------------------------------------------- expiry */

test('an expiry is set even when nobody chooses one', () => {
  /* The failure is not a bad expiry, it is nobody choosing at all. A library
     default answers the question by omission. */
  const withDefault = libBy('Client collateral');
  assert(withDefault.default_expiry_days, 'fixture: expected a default expiry');
  const derived = expiryFor(withDefault, null);
  assert(derived, 'no expiry was derived from the library default');
  assert(new Date(derived) > new Date(), 'the derived expiry is in the past');

  // An explicit choice always wins over the default.
  assert.equal(expiryFor(withDefault, '2030-01-01'), '2030-01-01');

  // A library with no default means never, which is a decision, not an absence.
  assert.equal(expiryFor(libBy('Regulatory'), null), null);
});

/* ---------------------------------------------------------- access */

test('a library shared with nobody is the owner role and administrators only', () => {
  const lib = { owner_role: 'marketing_manager', shared_with: '[]', sales_org: null };
  assert(mayRead(lib, userBy('marketing_manager')), 'the owner cannot read their own library');
  assert(mayRead(lib, userBy('admin')), 'an administrator cannot read it');
  assert(!mayRead(lib, userBy('sales_rm')), 'a library shared with nobody was readable by an RM');
});

test('a library shared with nobody named is readable by everyone', () => {
  // NULL and [] mean different things, and the difference is the whole point.
  const lib = { owner_role: 'admin', shared_with: null, sales_org: null };
  assert(mayRead(lib, userBy('sales_rm')), 'an unrestricted library was not readable');
});

test('a library belonging to one book is invisible in the other', () => {
  const bigulOnly = { owner_role: 'admin', shared_with: null, sales_org: 'BIGUL' };
  const bonanzaRm = one("SELECT * FROM users WHERE role = 'sales_rm' AND sales_org = 'BONANZA' AND active = 1 LIMIT 1");
  if (!bonanzaRm) return;
  assert(!mayRead(bigulOnly, bonanzaRm), 'a Bigul library was readable from Bonanza');
});

test('only the owning role or an administrator changes a library', () => {
  const lib = libBy('Client collateral');
  assert(mayManage(lib, userBy('marketing_manager')), 'the owner cannot manage their library');
  assert(mayManage(lib, userBy('admin')), 'an administrator cannot manage it');
  assert(!mayManage(lib, userBy('sales_rm')), 'an RM could manage a library they only read');
});

/* ------------------------------------------------------- the fixture */

test('the seeded libraries show the differences that matter', () => {
  // A fixture where every library is configured the same way demonstrates
  // nothing and hides a bug in whichever branch is never taken.
  const libs = all('SELECT * FROM content_library');
  assert(libs.some((l) => l.requires_approval), 'no library requires approval');
  assert(libs.some((l) => !l.requires_approval), 'every library requires approval');
  assert(libs.some((l) => l.default_expiry_days), 'no library sets a default expiry');
  assert(libs.some((l) => !l.default_expiry_days), 'every library sets a default expiry');
  assert(libs.some((l) => l.shared_with), 'no library restricts who may read it');
});

test('a seeded approval was granted by somebody other than the author', () => {
  const bad = all(
    'SELECT id, name FROM content_items WHERE approved_by IS NOT NULL AND approved_by = created_by',
  );
  assert.equal(bad.length, 0,
    `${bad.length} item(s) approved by their own author: ${bad.map((b) => b.name).join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
