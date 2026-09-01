/**
 * API credentials (P2-02).
 *
 * This is the one feature in the product that hands a machine the ability to
 * act as a person, so the tests are about the properties that make that safe
 * rather than about the happy path:
 *
 *   the stored half is worthless to whoever reads the database
 *   a wrong secret is refused in constant time and says nothing useful
 *   scopes narrow and can never widen
 *   rotation and revocation take effect immediately
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { all, one, run } from '../src/db.js';
import {
  issue, rotate, revoke, list, authenticate, scopedCapabilities,
} from '../src/engine/apikeys.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('\nAPI credentials');

const rm = one("SELECT id, name, sales_org FROM users WHERE role = 'sales_rm' AND active = 1 LIMIT 1");
const made = [];
const mint = (opts = {}) => {
  const c = issue({ label: `test-${Date.now()}-${made.length}`, userId: rm.id, ...opts });
  made.push(c.key_id);
  return c;
};

test('the secret is returned once and never stored in a readable form', () => {
  const c = mint();
  const row = one('SELECT * FROM api_credential WHERE key_id = ?', [c.key_id]);

  assert(c.secret && c.secret.startsWith('sk_'), 'no secret was returned');
  assert(!Object.values(row).some((v) => String(v).includes(c.secret)),
    'the secret itself is stored somewhere on the row');
  assert.equal(row.secret_hash.length, 64, 'the stored hash is not a SHA-256 digest');
});

test('nothing secret appears in the list an administrator reads', () => {
  /* An integrations page that prints credentials is a credential leak with a
     nice interface. */
  const rows = list([rm.sales_org]);
  const blob = JSON.stringify(rows);
  assert(!/sk_/.test(blob), 'a secret appeared in the credential list');
  assert(!/secret_hash/.test(blob), 'the stored hash appeared in the credential list');
});

test('a correct pair authenticates as the user it is bound to', () => {
  const c = mint();
  const auth = authenticate(c.key_id, c.secret);
  assert(auth, 'a valid credential did not authenticate');
  assert.equal(auth.user.id, rm.id, 'authenticated as somebody else');
});

test('a wrong secret, an unknown key and a revoked one all fail the same way', () => {
  /* Returning null for every failure rather than distinguishing them: a caller
     learning that a key id exists but the secret is wrong learns something
     worth knowing. */
  const c = mint();
  assert.equal(authenticate(c.key_id, 'sk_wrong'), null, 'a wrong secret authenticated');
  assert.equal(authenticate('bnz_does_not_exist', c.secret), null, 'an unknown key authenticated');
  assert.equal(authenticate(null, null), null);
  assert.equal(authenticate(c.key_id, ''), null, 'an empty secret authenticated');

  const row = one('SELECT id FROM api_credential WHERE key_id = ?', [c.key_id]);
  revoke(row.id);
  assert.equal(authenticate(c.key_id, c.secret), null, 'a revoked credential still authenticated');
});

test('rotation invalidates the old secret immediately', () => {
  const c = mint();
  const row = one('SELECT id FROM api_credential WHERE key_id = ?', [c.key_id]);
  const fresh = rotate(row.id);

  assert.equal(authenticate(c.key_id, c.secret), null, 'the old secret still works after rotation');
  assert(authenticate(c.key_id, fresh.secret), 'the new secret does not work');
  assert.equal(fresh.key_id, c.key_id, 'rotation changed the public key id as well');
});

test('deactivating the person deactivates their keys', () => {
  /* Without anybody having to remember to. A service account that outlives its
     owner is how an integration keeps working for a leaver. */
  const c = mint();
  run('UPDATE users SET active = 0 WHERE id = ?', [rm.id]);
  try {
    assert.equal(authenticate(c.key_id, c.secret), null, 'a key belonging to a deactivated user still worked');
  } finally {
    run('UPDATE users SET active = 1 WHERE id = ?', [rm.id]);
  }
});

test('scopes narrow and can never widen', () => {
  /* The property that makes issuing a key safe: it can never be an escalation.
     A scope naming something the user cannot do is dropped, not granted. */
  const userCaps = new Set(['lead.view.own', 'lead.contact']);

  assert.deepEqual([...scopedCapabilities(userCaps, ['lead.view.own'])], ['lead.view.own'],
    'a narrowing scope did not narrow');
  assert.deepEqual([...scopedCapabilities(userCaps, ['admin.system'])], [],
    'a scope granted a capability the user does not have');
  assert.deepEqual([...scopedCapabilities(userCaps, ['lead.contact', 'admin.roles'])], ['lead.contact'],
    'a mixed scope leaked the capability the user lacks');
  assert.equal(scopedCapabilities(userCaps, null), userCaps, 'no scopes should mean everything the user has');
  assert.equal(scopedCapabilities(userCaps, []), userCaps, 'an empty scope list should mean the same');
});

test('the comparison is constant-time, not a string equality', () => {
  /* Asserted on the source, because a timing difference is not observable from
     a unit test on a laptop and would be a real leak in production. */
  const src = readFileSync(new URL('../src/engine/apikeys.js', import.meta.url), 'utf8');
  assert(/timingSafeEqual/.test(src), 'secret comparison does not use timingSafeEqual');
  const fn = src.slice(src.indexOf('function secretMatches'), src.indexOf('/* ------', src.indexOf('function secretMatches')));
  assert(!/===\s*storedHex|storedHex\s*===/.test(fn), 'the secret is compared with ===');
});

test('use is recorded, so a key nobody uses can be found and revoked', () => {
  const c = mint();
  authenticate(c.key_id, c.secret);
  const row = one('SELECT last_used_at FROM api_credential WHERE key_id = ?', [c.key_id]);
  assert(row.last_used_at, 'last use was not recorded');
});

test('the access log can say which key made a call, not just which user', () => {
  // A key authenticates AS a user, so an integration and its owner are
  // indistinguishable in the log without this column.
  const cols = all('PRAGMA table_info(request_log)').map((c) => c.name);
  assert(cols.includes('api_credential_id'), 'request_log cannot attribute a call to a credential');
});

// Clean up everything this file minted.
for (const keyId of made) run('DELETE FROM api_credential WHERE key_id = ?', [keyId]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
