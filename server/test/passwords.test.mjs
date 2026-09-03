/**
 * Password storage and verification.
 *
 * `verifyPassword` used to accept a stored value that was not an scrypt hash by
 * comparing it as cleartext, then flagging it for upgrade on the next sign-in.
 * That was a migration affordance for a pre-hardening seed, and it is what made
 * the cleartext written by the admin user routes a complete credential
 * disclosure rather than a weak hash: the stored value compared equal, so there
 * was nothing to crack.
 *
 * The branch is gone. These tests exist so it does not come back quietly — the
 * dangerous case is the one where a stored cleartext value matches the password
 * typed at the sign-in box, because that is the case that used to succeed.
 */

import { strict as assert } from 'node:assert';
import { hashPassword, verifyPassword } from '../src/security.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nPasswords — what may and may not authenticate');

test('a password verifies against its own hash', () => {
  assert.equal(verifyPassword('bonanza', hashPassword('bonanza')).ok, true);
});

test('a wrong password does not', () => {
  assert.equal(verifyPassword('bonanzo', hashPassword('bonanza')).ok, false);
  assert.equal(verifyPassword('', hashPassword('bonanza')).ok, false);
});

test('the same password hashes differently every time', () => {
  // A per-row salt, so two people sharing a password do not share a hash and
  // one cracked row does not reveal the other.
  const a = hashPassword('bonanza');
  const b = hashPassword('bonanza');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('bonanza', a).ok, true);
  assert.equal(verifyPassword('bonanza', b).ok, true);
});

test('a cleartext stored value never authenticates, even when it matches', () => {
  // The case that used to succeed, and the reason this file exists.
  assert.equal(verifyPassword('bonanza', 'bonanza').ok, false);
  assert.equal(verifyPassword('partner', 'partner').ok, false);
  assert.equal(verifyPassword('Zx9-QuetzalPassphrase', 'Zx9-QuetzalPassphrase').ok, false);
});

test('nor does anything else that is not an scrypt hash', () => {
  for (const stored of ['', null, undefined, 'md5$abc', '$2b$10$abcdefghijklmnop', 'scrypt', 'SCRYPT$16384$8$1$aa$bb']) {
    assert.equal(verifyPassword('bonanza', stored).ok, false, `accepted ${JSON.stringify(stored)}`);
  }
});

test('a malformed scrypt value fails rather than throwing', () => {
  // These reach the parser rather than the prefix check, so a 500 on the login
  // route is the failure mode to avoid here.
  for (const stored of [
    'scrypt$',
    'scrypt$16384$8$1',
    'scrypt$16384$8$1$$',
    'scrypt$16384$8$1$nothex$nothex',
    'scrypt$0$0$0$aa$bb',
    'scrypt$notanumber$8$1$aa$bb',
  ]) {
    assert.equal(verifyPassword('bonanza', stored).ok, false, `accepted ${stored}`);
  }
});

test('a hash from another password is not accepted', () => {
  assert.equal(verifyPassword('bonanza', hashPassword('partner')).ok, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
