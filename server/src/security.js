/**
 * Security primitives — password hashing, field encryption, masking, blind indexes.
 *
 * Everything here uses node:crypto only. No third-party crypto dependency, which
 * matters for a regulated deployment where every library is an audit item.
 *
 * WHAT IS ENCRYPTED, AND WHY THAT SET
 * -----------------------------------
 * Disk encryption protects a stolen drive. Column encryption protects a leaked
 * database dump, which is the realistic incident. We column-encrypt the fields
 * whose exposure is individually harmful and which are never range-searched:
 *
 *   leads.pan            identity document number
 *   partners.pan         identity document number
 *   partners.bank_account, partners.bank_ifsc
 *   kyc_journeys.form_data   the whole KYC payload — address, income, nominee,
 *                            bank details, document references
 *
 * Mobile and email stay queryable in clear text because duplicate detection,
 * DKYC applicant matching and RM search all depend on them. They are MASKED in
 * every API response unless the caller holds `pii.unmask`, and that unmask is
 * audited. `blindIndex()` below is the migration path to encrypting them too:
 * store HMAC(value) for exact lookup alongside the ciphertext, and convert
 * search from LIKE to exact-or-last-4.
 *
 * Aadhaar is never stored in any form — only the DigiLocker reference id.
 *
 * KEY MANAGEMENT
 * --------------
 * The master key comes from CRM_MASTER_KEY (64 hex chars). In production this is
 * a KMS-held key — and for Indian data-residency the KMS key must be created in
 * an India region so the key never leaves the country with the data.
 */

import {
  randomBytes, scrypt, scryptSync, timingSafeEqual, createCipheriv,
  createDecipheriv, createHmac, randomUUID,
} from 'node:crypto';
import { promisify } from 'node:util';

/* ------------------------------------------------------------------ keys */

const DEV_KEY = '0'.repeat(64);   // deterministic dev key; refused in production

function masterKey() {
  const hex = process.env.CRM_MASTER_KEY || DEV_KEY;

  if (hex === DEV_KEY && process.env.NODE_ENV === 'production') {
    throw new Error('CRM_MASTER_KEY must be set in production — refusing to start with the development key');
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('CRM_MASTER_KEY must be 64 hexadecimal characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export const usingDevKey = () => (process.env.CRM_MASTER_KEY || DEV_KEY) === DEV_KEY;

/** Generate a key for an operator to paste into their secret store. */
export const generateMasterKey = () => randomBytes(32).toString('hex');

/* -------------------------------------------------------------- passwords */

/**
 * Cost parameters. N=2^17 with r=8 and p=1 is the OWASP floor for scrypt, and
 * the default; see configuredN below for the one way it is allowed to differ.
 *
 * Two things follow from raising N that are easy to get wrong. Memory is
 * 128*N*r, so 128 MiB per call, and Node caps that at 32 MiB unless `maxmem`
 * says otherwise -- without it every call throws
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS, which `verifyPassword` would report as a
 * failed sign-in rather than as a fault. And one hash is roughly 600ms of
 * arithmetic, so `scryptSync` would hold the event loop for that long and make
 * every other request in flight wait; the async form runs on the libuv pool
 * instead. The sync variant below is kept only for the callers where nothing is
 * waiting on the loop.
 *
 * `maxmem` is also the ceiling on what a stored hash can ask us to allocate,
 * since the N in the row decides the work, not the N here.
 */
const DEFAULT_N = 131072;
const MAXMEM = 256 * 1024 * 1024;

/**
 * The OWASP floor, unless CRM_SCRYPT_N lowers it.
 *
 * The knob exists because the test suite signs in constantly and each sign-in
 * is otherwise 600ms of real work, which took the suite from about 50s to about
 * 170s. It is a convenience with an obvious failure mode: a setting that makes
 * things cheap is a setting somebody leaves on. So it is refused outright in
 * production, by the same rule and for the same reason as the development
 * master key above, rather than warned about and tolerated.
 *
 * Validated rather than trusted. scrypt requires N to be a power of two, and an
 * invalid one makes every call throw -- which `verifyPassword` catches and
 * reports as a wrong password, so a typo here would look like every account in
 * the system having the wrong credentials. Better to refuse to start.
 */
function configuredN() {
  const raw = process.env.CRM_SCRYPT_N;
  if (!raw) return DEFAULT_N;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRM_SCRYPT_N must not be set in production - refusing to start with a reduced password cost');
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || (n & (n - 1)) !== 0) {
    throw new Error(`CRM_SCRYPT_N must be a power of two of at least 1024, not ${JSON.stringify(raw)}`);
  }
  return n;
}

const SCRYPT = { N: configuredN(), r: 8, p: 1, keylen: 64 };

/** What we are actually hashing at, and the floor we would hash at untold. */
export const scryptPolicy = () => ({ ...SCRYPT, maxmem: MAXMEM, default_N: DEFAULT_N });
export const usingReducedCost = () => SCRYPT.N < DEFAULT_N;

const scryptAsync = promisify(scrypt);

const options = ({ N, r, p }) => ({ N, r, p, maxmem: MAXMEM });
const encode = (salt, hash) => `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;

/** Returns `scrypt$N$r$p$salt$hash`. Off the event loop. */
export async function hashPassword(plain) {
  const salt = randomBytes(16);
  return encode(salt, await scryptAsync(String(plain), salt, SCRYPT.keylen, options(SCRYPT)));
}

/**
 * The same, blocking.
 *
 * For the three callers where holding the event loop costs nothing and going
 * async would cost something: the startup migration in db.js, which runs before
 * the server listens and sits at module top level; the seed, which is a script;
 * and `issuePortalCredential`, which runs inside the approvals engine's
 * transaction, where an await would let another request's statements land
 * between this BEGIN and its COMMIT. Everything reached by an HTTP request
 * should use `hashPassword`.
 */
export function hashPasswordSync(plain) {
  const salt = randomBytes(16);
  return encode(salt, scryptSync(String(plain), salt, SCRYPT.keylen, options(SCRYPT)));
}

/** True when a stored hash was made under weaker parameters than we now demand. */
const belowPolicy = (n, r, p, keylen) =>
  n < SCRYPT.N || r < SCRYPT.r || p < SCRYPT.p || keylen < SCRYPT.keylen;

/**
 * Constant-time verify. Returns { ok, needsRehash }.
 *
 * `needsRehash` is true when the password was right but the stored hash was
 * made under weaker parameters than SCRYPT now demands, so sign-in can upgrade
 * it. That is the only moment an upgrade is possible: rehashing needs the
 * plaintext, and the database deliberately does not have it. Rows therefore
 * strengthen as their owners appear, and a dormant account keeps its old cost
 * until someone signs in.
 *
 * Anything that is not an scrypt hash fails. Until September 2026 a stored
 * value not starting with `scrypt$` was compared as cleartext and flagged for
 * upgrade on the next sign-in, so a pre-hardening seed kept working. That also
 * meant a stored value which compared equal needed no cracking at all, which is
 * what turned the admin routes writing cleartext into a full credential
 * disclosure rather than a weak hash. Every write path hashes now and the
 * existing rows were migrated, so the fallback could only have accepted a
 * cleartext value written by some later mistake.
 *
 * Fails closed on purpose. If cleartext ever reaches the column again that
 * account cannot sign in, and a lockout is the loud failure; quietly accepting
 * the plaintext is the one nobody notices.
 */
export async function verifyPassword(plain, stored) {
  const value = String(stored ?? '');
  if (!value.startsWith('scrypt$')) return { ok: false, needsRehash: false };

  try {
    const [, n, r, p, saltHex, hashHex] = value.split('$');
    const expected = Buffer.from(hashHex, 'hex');
    // The row's own parameters, not ours: an old hash has to be checked the way
    // it was made, which is the whole point of storing them alongside it.
    const actual = await scryptAsync(String(plain), Buffer.from(saltHex, 'hex'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
    // A truncated hash would make two empty buffers compare equal.
    const ok = expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
    // Only worth reporting when it is true, since an upgrade needs the verified
    // plaintext and the caller only has that on a successful sign-in.
    return { ok, needsRehash: ok && belowPolicy(Number(n), Number(r), Number(p), expected.length) };
  } catch {
    // A malformed scrypt$ value: wrong field count, bad hex, unusable
    // parameters, or one asking for more memory than MAXMEM allows.
    return { ok: false, needsRehash: false };
  }
}

/* ------------------------------------------------------ field encryption */

const VERSION = 'v1';

/**
 * AES-256-GCM with a random IV. Output: `v1:<iv>:<tag>:<ciphertext>` in base64url.
 * Randomised, so the same PAN encrypts differently each time — no frequency analysis.
 */
export function encryptField(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':');
}

export function decryptField(stored) {
  if (stored === null || stored === undefined || stored === '') return stored;
  if (typeof stored !== 'string' || !stored.startsWith(`${VERSION}:`)) return stored;  // plaintext legacy row

  try {
    const [, ivB64, tagB64, dataB64] = stored.split(':');
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Tampered ciphertext or wrong key. Never return the raw value.
    return null;
  }
}

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(`${VERSION}:`);

/**
 * Deterministic HMAC for exact-match lookup on an encrypted column.
 * Not reversible; safe to index. This is how mobile/email get encrypted later
 * without losing duplicate detection.
 */
export const blindIndex = (value) =>
  value ? createHmac('sha256', masterKey()).update(String(value).trim().toLowerCase()).digest('base64url') : null;

/* ---------------------------------------------------------------- masking */

export const maskMobile = (v) => {
  const s = String(v ?? '');
  return s.length < 4 ? s : `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
};

export const maskPan = (v) => {
  const s = String(v ?? '');
  return s.length < 4 ? s : `${s.slice(0, 2)}${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-2)}`;
};

export const maskEmail = (v) => {
  const s = String(v ?? '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '•••' : s;
  const name = s.slice(0, at);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'•'.repeat(Math.max(1, name.length - head.length))}${s.slice(at)}`;
};

export const maskAccount = (v) => {
  const s = String(v ?? '');
  return s.length < 4 ? s : `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
};

/**
 * Everything at all, for a field with no safe partial.
 *
 * A date of birth or a full name cannot show its last four characters and stay
 * private, so an administrator adding one needs a strategy that reveals the
 * presence of a value and nothing else.
 */
export const maskAll = (v) => (String(v ?? '') ? '••••••' : '');

/**
 * The strategies an administrator may choose from, by name (P3-11).
 *
 * Named rather than offered as functions because the choice is stored in a
 * table and has to survive a restart. `last4` is maskMobile and maskAccount,
 * which are the same implementation under two names.
 */
export const MASK_STRATEGIES = {
  last4: maskAccount,
  ends: maskPan,
  email: maskEmail,
  hide: maskAll,
};

export const STRATEGY_LABEL = {
  last4: 'Show the last four characters',
  ends: 'Show the first two and last two',
  email: 'Show the first two letters and the domain',
  hide: 'Hide it entirely',
};

/** Which masker applies to which field name. */
export const MASKERS = {
  mobile: maskMobile,
  alt_contact: maskMobile,
  phone: maskMobile,
  pan: maskPan,
  email: maskEmail,
  bank_account: maskAccount,
  account_number: maskAccount,
};

/**
 * Fields made maskable from Setup, filled in by masking.js (P3-11).
 *
 * This module does not read the database and masking.js does, so the list
 * arrives here rather than being fetched here -- importing masking.js from this
 * file would be a cycle. Empty until registerMaskers() is called, which means
 * the built-ins work normally even if the table is unreadable.
 */
let customMaskers = {};

/** Replace the configured set. Called on boot and after any change. */
export function registerMaskers(map) {
  customMaskers = map ?? {};
}

/**
 * Every masker in force: the seven that ship, plus whatever was configured.
 *
 * Built-ins are spread last, so a row in the table can never quietly change how
 * `pan` or `mobile` is obscured -- a configuration mistake should be unable to
 * make an existing field LESS masked than it shipped.
 */
export const activeMaskers = () => ({ ...customMaskers, ...MASKERS });

/**
 * Mask PII on an outbound record unless the caller may unmask.
 * Adds `_pii_masked: true` so the client can render an "unmask" affordance
 * rather than silently showing dots.
 */
export function maskRecord(row, { unmask = false, fields = null } = {}) {
  if (!row || typeof row !== 'object' || unmask) return row;

  const out = { ...row };
  let masked = false;
  for (const [field, mask] of Object.entries(activeMaskers())) {
    // `fields` is the role's masked set (ENH-16). Omitted means mask
    // everything, which keeps every existing caller behaving as before.
    if (fields && !fields.has(field)) continue;
    if (out[field]) { out[field] = mask(out[field]); masked = true; }
  }
  if (masked) out._pii_masked = true;
  return out;
}

export const maskRecords = (rows, opts) => (Array.isArray(rows) ? rows.map((r) => maskRecord(r, opts)) : rows);

/* ------------------------------------------------------------- sessions */

/** Sessions expire; idle sessions are swept. Both are configurable. */
export const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
export const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 120);

export const newSessionToken = () => `${randomUUID()}.${randomBytes(24).toString('base64url')}`;

/* --------------------------------------------------------- rate limiting */

const buckets = new Map();

/**
 * Fixed-window limiter. In a multi-instance deployment this moves to Redis —
 * the interface stays the same.
 */
export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

/** Express middleware factory. `by` derives the bucket key from the request. */
export const rateLimiter = ({ limit, windowMs, by, name }) => (req, res, next) => {
  const key = `${name}:${by ? by(req) : (req.ip || 'anon')}`;
  const result = rateLimit({ key, limit, windowMs });

  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));

  if (!result.allowed) {
    res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
    return res.status(429).json({
      error: 'Too many attempts. Please wait a moment and try again.',
      retry_after_seconds: Math.ceil(result.retryAfterMs / 1000),
    });
  }
  next();
};

/** Clears counters — used by the test suite so limits don't leak between runs. */
export const resetRateLimits = () => buckets.clear();

/* -------------------------------------------------------------- validation */

export const V = {
  mobile: (v) => /^[6-9]\d{9}$/.test(String(v ?? '').trim()),
  pan: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(v ?? '').trim().toUpperCase()),
  ifsc: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v ?? '').trim().toUpperCase()),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v ?? '').trim()),
  pincode: (v) => /^[1-9]\d{5}$/.test(String(v ?? '').trim()),
  nonEmpty: (v) => String(v ?? '').trim().length > 0,
  maxLen: (n) => (v) => String(v ?? '').length <= n,
};

/**
 * Validate a body against a spec. Returns null when valid, else a 400 payload.
 *   validate(req.body, { name: ['required'], mobile: ['mobile'], pan: ['pan'] })
 */
export function validate(body, spec) {
  const errors = [];

  for (const [field, rules] of Object.entries(spec)) {
    const value = body?.[field];
    const present = value !== undefined && value !== null && String(value).trim() !== '';

    for (const rule of rules) {
      if (rule === 'required' && !present) { errors.push({ field, message: `${field} is required` }); break; }
      if (!present) continue;
      if (rule === 'mobile' && !V.mobile(value)) errors.push({ field, message: 'Enter a valid 10-digit Indian mobile number' });
      if (rule === 'pan' && !V.pan(value)) errors.push({ field, message: 'PAN must look like ABCDE1234F' });
      if (rule === 'ifsc' && !V.ifsc(value)) errors.push({ field, message: 'Enter a valid IFSC code' });
      if (rule === 'email' && !V.email(value)) errors.push({ field, message: 'Enter a valid email address' });
      if (rule === 'pincode' && !V.pincode(value)) errors.push({ field, message: 'Enter a valid 6-digit PIN code' });
      if (typeof rule === 'string' && rule.startsWith('max:') && !V.maxLen(Number(rule.slice(4)))(value)) {
        errors.push({ field, message: `${field} is too long (max ${rule.slice(4)} characters)` });
      }
    }
  }

  return errors.length ? { error: errors[0].message, errors } : null;
}
