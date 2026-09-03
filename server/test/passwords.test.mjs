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
 *
 * `needsRehash` is back, meaning something different and safe: the password was
 * right, but the stored hash was made under weaker parameters than policy now
 * demands. Sign-in is the only place an upgrade can happen, since rehashing
 * needs the plaintext and the database does not have it.
 */

import { strict as assert } from 'node:assert';
import { scryptSync, randomBytes } from 'node:crypto';
import { hashPassword, hashPasswordSync, verifyPassword } from '../src/security.js';
import { login } from '../src/auth.js';
import { one, run } from '../src/db.js';

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}
       ${err.message}`); }
};

/** A hash in the format the app stored before the cost was raised. */
const legacyHash = (plain, { N = 16384, r = 8, p = 1, keylen = 64 } = {}) => {
  const salt = randomBytes(16);
  const hash = scryptSync(String(plain), salt, keylen, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
};

console.log('\nPasswords — what may and may not authenticate');

await test('a password verifies against its own hash', async () => {
  assert.equal((await verifyPassword('bonanza', await hashPassword('bonanza'))).ok, true);
});

await test('a wrong password does not', async () => {
  const stored = await hashPassword('bonanza');
  assert.equal((await verifyPassword('bonanzo', stored)).ok, false);
  assert.equal((await verifyPassword('', stored)).ok, false);
});

await test('the same password hashes differently every time', async () => {
  // A per-row salt, so two people sharing a password do not share a hash and
  // one cracked row does not reveal the other.
  const a = await hashPassword('bonanza');
  const b = await hashPassword('bonanza');
  assert.notEqual(a, b);
  assert.equal((await verifyPassword('bonanza', a)).ok, true);
  assert.equal((await verifyPassword('bonanza', b)).ok, true);
});

await test('the sync variant produces hashes the async one accepts, and vice versa', async () => {
  // Two entry points, one format. The seed and the startup migration use the
  // sync one; everything reached by a request uses the async one.
  assert.equal((await verifyPassword('bonanza', hashPasswordSync('bonanza'))).ok, true);
  assert.equal((await verifyPassword('wrong', hashPasswordSync('bonanza'))).ok, false);
});

await test('a cleartext stored value never authenticates, even when it matches', async () => {
  // The case that used to succeed, and the reason this file exists.
  assert.equal((await verifyPassword('bonanza', 'bonanza')).ok, false);
  assert.equal((await verifyPassword('partner', 'partner')).ok, false);
  assert.equal((await verifyPassword('Zx9-QuetzalPassphrase', 'Zx9-QuetzalPassphrase')).ok, false);
});

await test('nor does anything else that is not an scrypt hash', async () => {
  for (const stored of ['', null, undefined, 'md5$abc', '$2b$10$abcdefghijklmnop', 'scrypt', 'SCRYPT$16384$8$1$aa$bb']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await verifyPassword('bonanza', stored)).ok, false, `accepted ${JSON.stringify(stored)}`);
  }
});

await test('a malformed scrypt value fails rather than throwing', async () => {
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
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await verifyPassword('bonanza', stored)).ok, false, `accepted ${stored}`);
  }
});

await test('a hash from another password is not accepted', async () => {
  assert.equal((await verifyPassword('bonanza', await hashPassword('partner'))).ok, false);
});

console.log('\nCost — raising it, and carrying old rows forward');

await test('new hashes are written at the current parameters', async () => {
  const [, n, r, p] = (await hashPassword('bonanza')).split('$');
  assert.equal(n, '131072', 'N is not the OWASP floor');
  assert.equal(r, '8');
  assert.equal(p, '1');
});

await test('a hash made at the old cost still verifies', async () => {
  // Backwards compatibility is the whole reason the parameters live in the row.
  // If this breaks, every existing account is locked out.
  const stored = legacyHash('bonanza');
  assert.equal((await verifyPassword('bonanza', stored)).ok, true);
  assert.equal((await verifyPassword('wrong', stored)).ok, false);
});

await test('and it asks to be upgraded', async () => {
  assert.equal((await verifyPassword('bonanza', legacyHash('bonanza'))).needsRehash, true);
});

await test('a hash at the current cost does not', async () => {
  assert.equal((await verifyPassword('bonanza', await hashPassword('bonanza'))).needsRehash, false);
  assert.equal((await verifyPassword('bonanza', hashPasswordSync('bonanza'))).needsRehash, false);
});

await test('every weaker parameter counts, not just N', async () => {
  for (const weaker of [{ N: 16384 }, { r: 4 }, { keylen: 32 }]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, needsRehash } = await verifyPassword('bonanza', legacyHash('bonanza', { N: 131072, ...weaker }));
    assert.equal(ok, true, `${JSON.stringify(weaker)} did not verify`);
    assert.equal(needsRehash, true, `${JSON.stringify(weaker)} was not flagged for upgrade`);
  }
});

await test('a wrong password never asks for an upgrade', async () => {
  // An upgrade needs the verified plaintext. Reporting it on a failed sign-in
  // would invite a caller into rehashing with a password that was not right.
  const { ok, needsRehash } = await verifyPassword('wrong', legacyHash('bonanza'));
  assert.equal(ok, false);
  assert.equal(needsRehash, false);
});

await test('a stronger stored hash is left alone', async () => {
  // Policy going down must not quietly downgrade rows that are already better.
  // Raised through p and keylen rather than N: scrypt's memory is 128*N*r, so
  // a stronger N here would exceed MAXMEM and fail to verify at all.
  for (const stronger of [{ p: 2 }, { keylen: 128 }]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, needsRehash } = await verifyPassword('bonanza', legacyHash('bonanza', { N: 131072, ...stronger }));
    assert.equal(ok, true, `${JSON.stringify(stronger)} did not verify`);
    assert.equal(needsRehash, false, `${JSON.stringify(stronger)} was downgraded`);
  }
});

console.log('');
console.log('Upgrading a row at sign-in');

await test('signing in upgrades a hash stored at the old cost', async () => {
  // The behaviour the flag exists for, end to end: an account whose hash
  // predates the raise signs in normally and comes out stored at the new cost.
  const email = `rehash.probe.${Date.now()}@bonanza.test`;
  const stored = () => one('SELECT password FROM users WHERE lower(email) = lower(?)', [email])?.password;
  run('INSERT INTO users (name, email, password, role, active) VALUES (?,?,?,?,1)',
    ['Rehash Probe', email, legacyHash('bonanza'), 'caller']);

  try {
    const before = stored();
    assert.ok(before.startsWith('scrypt$16384$'), 'the probe did not start at the old cost');

    const result = await login(email, 'bonanza');
    assert.ok(result?.token, 'the sign-in that should have triggered the upgrade failed');

    const after = stored();
    assert.ok(after.startsWith('scrypt$131072$'), `still at the old cost: ${after.slice(0, 24)}`);
    assert.equal((await verifyPassword('bonanza', after)).ok, true,
      'the upgraded row stopped accepting the password');

    // Idempotent: a second sign-in has nothing left to do.
    await login(email, 'bonanza');
    assert.equal(stored(), after, 'the row was rewritten when it did not need to be');
  } finally {
    run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower(?))', [email]);
    run('DELETE FROM users WHERE lower(email) = lower(?)', [email]);
  }
});

await test('a failed sign-in leaves the old hash alone', async () => {
  const email = `rehash.wrong.${Date.now()}@bonanza.test`;
  const original = legacyHash('bonanza');
  run('INSERT INTO users (name, email, password, role, active) VALUES (?,?,?,?,1)',
    ['Rehash Wrong', email, original, 'caller']);

  try {
    assert.equal(await login(email, 'not-the-password'), null);
    const after = one('SELECT password FROM users WHERE lower(email) = lower(?)', [email]).password;
    assert.equal(after, original, 'a failed sign-in rewrote the stored hash');
  } finally {
    run('DELETE FROM users WHERE lower(email) = lower(?)', [email]);
  }
});


console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
