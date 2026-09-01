/**
 * API credentials — the Open API half of P2-02.
 *
 * A KEY IS A WAY FOR A USER TO AUTHENTICATE, NOT A NEW KIND OF ACTOR
 *
 * Every credential is bound to a real user row, and authenticating with it
 * produces the same `req.user` a sign-in would. That is the whole design, and
 * it is deliberate: a separate authorization model for machines would mean the
 * book boundary, the field masking and the capability checks all needing a
 * second implementation, and the second one is the one that gets it wrong. This
 * way an API caller is scoped by exactly the machinery that scopes a person.
 *
 * Scopes NARROW and never widen. A key may carry a list of capabilities, and
 * the caller gets the intersection of that list with what its user could
 * already do. There is no way to write a key that can do more than the person
 * it belongs to — which means issuing one can never be an escalation, and the
 * question "what can this key do?" is answerable by looking at one role.
 *
 * WHY THE SECRET IS SHA-256 AND NOT SCRYPT
 *
 * Passwords are hashed with scrypt because people choose guessable ones and the
 * work factor is what stops an offline attack. An API secret is 32 bytes from
 * the system CSPRNG — there is no dictionary, and no work factor changes that.
 * What scrypt would add is 50-100ms on every single API request, which on a
 * machine-driven endpoint is a self-inflicted denial of service. SHA-256 with a
 * constant-time compare is the right tool for a high-entropy secret, and this
 * paragraph exists so nobody "fixes" it later.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { all, one, run } from '../db.js';

/** Public half. Prefixed so a leaked string is recognisable in a log or a paste. */
const newKeyId = () => `bnz_${randomBytes(9).toString('hex')}`;

/** Secret half. Never stored, never recoverable, shown once. */
const newSecret = () => `sk_${randomBytes(32).toString('base64url')}`;

const digest = (secret) => createHash('sha256').update(String(secret)).digest();

/** Constant-time. A length mismatch must not answer faster than a value one. */
function secretMatches(presented, storedHex) {
  if (!storedHex) return false;
  const a = digest(presented);
  const b = Buffer.from(storedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------- issuing */

/**
 * Mint a credential. The secret is returned exactly once, here.
 *
 * If it is lost it cannot be recovered, only rotated — which is the property
 * that makes the stored half worthless to anyone who reads the database.
 */
export function issue({ label, userId, scopes = null, createdBy = null }) {
  const keyId = newKeyId();
  const secret = newSecret();

  run(
    `INSERT INTO api_credential (key_id, secret_hash, label, user_id, scopes, created_by)
     VALUES (?,?,?,?,?,?)`,
    [
      keyId,
      digest(secret).toString('hex'),
      String(label).trim(),
      userId,
      scopes && scopes.length ? JSON.stringify(scopes) : null,
      createdBy,
    ],
  );

  return { key_id: keyId, secret, label };
}

/** Rotate: same row, same bindings, new secret. The old one stops working now. */
export function rotate(id) {
  const cred = one('SELECT * FROM api_credential WHERE id = ?', [id]);
  if (!cred) return null;
  const secret = newSecret();
  run("UPDATE api_credential SET secret_hash = ?, rotated_at = datetime('now') WHERE id = ?",
    [digest(secret).toString('hex'), id]);
  return { key_id: cred.key_id, secret, label: cred.label };
}

export function revoke(id) {
  return run("UPDATE api_credential SET active = 0, revoked_at = datetime('now') WHERE id = ?", [id]).changes;
}

/* ---------------------------------------------------------- presenting */

/**
 * The list, without anything secret in it.
 *
 * An integrations page that prints credentials is a credential leak with a nice
 * interface. Presence, ownership and last use are what an administrator needs;
 * the secret is not recoverable even here.
 */
export const list = (orgs = []) => all(
  `SELECT c.id, c.key_id, c.label, c.active, c.created_at, c.last_used_at, c.rotated_at, c.revoked_at,
          c.scopes, u.name AS user_name, u.role AS user_role, u.sales_org,
          (SELECT COUNT(*) FROM request_log r WHERE r.api_credential_id = c.id) AS calls
   FROM api_credential c
   JOIN users u ON u.id = c.user_id
   WHERE u.sales_org IN (${orgs.map(() => '?').join(',') || "''"})
   ORDER BY c.active DESC, c.created_at DESC`,
  orgs,
).map((c) => ({ ...c, scopes: c.scopes ? JSON.parse(c.scopes) : null }));

/* ------------------------------------------------------ authenticating */

/**
 * Resolve a key pair to the user it acts as.
 *
 * Returns null for anything wrong — unknown key, bad secret, revoked
 * credential, deactivated user — without saying which. A caller learning that
 * a key id exists but the secret is wrong learns something worth knowing.
 */
export function authenticate(keyId, secret) {
  if (!keyId || !secret) return null;

  const cred = one('SELECT * FROM api_credential WHERE key_id = ?', [keyId]);
  if (!cred || !cred.active) return null;
  if (!secretMatches(secret, cred.secret_hash)) return null;

  const user = one('SELECT * FROM users WHERE id = ? AND active = 1', [cred.user_id]);
  if (!user) return null;

  /* Deactivating the person deactivates their keys, without anybody having to
     remember to. A service account that outlives its owner is how an integration
     keeps working for a leaver. */
  run("UPDATE api_credential SET last_used_at = datetime('now') WHERE id = ?", [cred.id]);

  return {
    user,
    credential: cred,
    scopes: cred.scopes ? JSON.parse(cred.scopes) : null,
  };
}

/**
 * What this caller may do: the key's scopes intersected with its user's.
 *
 * Intersected, never unioned. A scope naming a capability the user does not
 * have is silently dropped rather than granted — writing one is a mistake, and
 * the safe reading of a mistake is fewer permissions, not more.
 */
export function scopedCapabilities(userCaps, scopes) {
  if (!scopes || !scopes.length) return userCaps;
  return new Set([...scopes].filter((s) => userCaps.has(s)));
}
