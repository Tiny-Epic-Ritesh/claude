/**
 * Field masking, per field and per role (ENH-16).
 *
 * Two separate things are often confused here, so they are named apart:
 *
 *   masking   — whether a value arrives at the browser obscured. A standing
 *               property of the role, configured on this screen.
 *   unmasking — an explicit, audited act by someone who holds `pii.unmask`,
 *               asking to see one record in the clear. Unchanged by this file.
 *
 * A role that is not masked for a field never needed to unmask it; a role that
 * is masked can still reveal one record and leave a trail. Both exist because
 * "show me this client's number" and "show me every client's number" are
 * different requests and should not cost the same.
 *
 * Defaults follow the confirmed requirement: Admin, Superadmin and Marketing
 * Manager see these fields in the clear, everyone else does not. A row is
 * written only when an administrator decides otherwise, so absence means
 * "use the default" and a later change to that default is not silently
 * overwritten.
 */

import { all, one, run } from '../db.js';
import { MASKERS, MASK_STRATEGIES, registerMaskers } from '../security.js';

/** The seven that ship. These cannot be removed from Setup. */
export const BUILT_IN = Object.keys(MASKERS);

/**
 * The additions, cached (P3-11).
 *
 * maskRecord() runs on every row of every list, so the configured set cannot be
 * a query. It is read once, kept here, and rebuilt when an administrator
 * changes it -- which is rare enough that a stale cache is not a risk worth
 * paying a query per record to avoid.
 */
let custom = [];
let cachedAt = 0;
let maskerMap = {};

/**
 * How long the cache and the table may disagree.
 *
 * Small enough that nobody watches a field they just added stay in the clear,
 * large enough that a page of five hundred leads is one query rather than five
 * hundred. The list changes a few times a year.
 */
const TTL_MS = 5000;

/**
 * Re-read the table and hand security.js the maskers it should apply.
 *
 * The cache is per process, refreshed by whichever process served the change.
 * The server is a single process today, so that is the whole story -- but if it
 * is ever run as workers, a field added on one would not take on the others
 * until they restarted, and this would need a signal between them.
 */
export function refreshMaskable() {
  try {
    custom = all('SELECT field, label, strategy FROM maskable_field ORDER BY field');
  } catch {
    /* The table is missing on a database older than this migration. An empty
       list is right: the built-ins still mask, which fails safe. */
    custom = [];
  }

  const map = {};
  for (const row of custom) {
    const mask = MASK_STRATEGIES[row.strategy];
    // An unknown strategy is skipped rather than defaulted -- silently masking
    // by the wrong shape is how a value leaks while looking obscured.
    if (mask) map[row.field] = mask;
  }
  maskerMap = map;
  cachedAt = Date.now();
  return custom;
}

/** The maskers, re-read if this copy has gone stale. */
function currentMaskers() {
  if (Date.now() - cachedAt > TTL_MS) refreshMaskable();
  return maskerMap;
}

/* security.js asks through this, so it can never hold a copy that has gone out
   of date without anything being able to tell it. */
registerMaskers(currentMaskers);

/** Every maskable field, shipped and configured, for the Setup screen. */
export function maskableFields() {
  return [
    ...BUILT_IN.map((f) => ({ field: f, label: FIELD_LABEL[f] ?? f, strategy: null, custom: false })),
    ...custom.map((r) => ({ field: r.field, label: r.label, strategy: r.strategy, custom: true })),
  ];
}

/** Can this field be masked at all? */
export const isMaskable = (field) => BUILT_IN.includes(field) || custom.some((r) => r.field === field);

/**
 * Kept for callers that want only the names.
 *
 * A getter rather than an array, because the set now changes at runtime and a
 * snapshot taken at import time would be wrong the moment a field is added.
 */
export const maskableNames = () => maskableFields().map((f) => f.field);

export const FIELD_LABEL = {
  mobile: 'Mobile number',
  alt_contact: 'Alternate contact',
  phone: 'Phone',
  pan: 'PAN',
  email: 'Email address',
  bank_account: 'Bank account number',
  account_number: 'Account number',
};

/**
 * What each role sees in the clear, before any configuration.
 *
 * Per field rather than per role, because the interesting answer is rarely
 * all-or-nothing. Marketing Manager is the case that forced it: they need an
 * email address to run a campaign, and have no business reading a client's PAN
 * or mobile. A blanket "unmasked role" flag could express neither half of that.
 *
 * `'ALL'` means every maskable field. An array names the exceptions. A role
 * absent from this map sees nothing in the clear, which is the safe default for
 * anything added later.
 */
export const UNMASKED_BY_DEFAULT = {
  superadmin: 'ALL',
  admin: 'ALL',

  /**
   * Marketing segments and sends; it does not open individual records.
   *
   * Email only. PAN and mobile are masked on Ritesh's decision, and it is the
   * right one under data minimisation: a role that never needs to phone a
   * client has no reason to hold their number in the clear, and a PAN is the
   * single most sensitive identifier in the system.
   *
   * Campaign sends are unaffected -- the send path reads the stored value
   * server-side and never depends on what reached the browser.
   */
  marketing_manager: ['email'],
};

export function defaultMasked(role, field) {
  if (!isMaskable(field)) return false;
  const rule = UNMASKED_BY_DEFAULT[role];
  if (rule === 'ALL') return false;
  if (Array.isArray(rule)) return !rule.includes(field);
  return true;
}

const configured = () => {
  const map = new Map();
  for (const r of all('SELECT role_code, field, masked FROM field_masking')) {
    map.set(`${r.role_code}|${r.field}`, Boolean(r.masked));
  }
  return map;
};

/**
 * The set of fields to obscure for this role.
 *
 * Returned as a Set so the hot path — masking a page of five hundred leads — is
 * a lookup per field rather than a query per row.
 */
export function maskedFieldsFor(role) {
  const cfg = configured();
  return new Set(maskableNames().filter((field) => {
    const key = `${role}|${field}`;
    return cfg.has(key) ? cfg.get(key) : defaultMasked(role, field);
  }));
}

/** The full grid for Setup, with where each answer came from. */
export function maskingMatrix(roles) {
  const cfg = configured();
  return roles.map((role) => ({
    role,
    fields: Object.fromEntries(maskableNames().map((field) => {
      const key = `${role}|${field}`;
      const isSet = cfg.has(key);
      return [field, {
        masked: isSet ? cfg.get(key) : defaultMasked(role, field),
        source: isSet ? 'configured' : 'default',
      }];
    })),
  }));
}

export function setMasking(role, field, masked, actorId) {
  run(
    `INSERT INTO field_masking (role_code, field, masked, updated_by, updated_at)
     VALUES (?,?,?,?, datetime('now'))
     ON CONFLICT(role_code, field) DO UPDATE SET
       masked = excluded.masked, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [role, field, masked ? 1 : 0, actorId ?? null],
  );
}

export const clearMasking = (role, field) =>
  run('DELETE FROM field_masking WHERE role_code = ? AND field = ?', [role, field]);

/* ------------------------------------------------ adding and removing (P3-11) */

/**
 * A field name we are willing to store.
 *
 * Masking is by key, so this ends up compared against property names on rows
 * coming out of the database. Anything that is not a plain identifier is either
 * a mistake or an attempt to be clever with one.
 */
export const VALID_FIELD = /^[a-z][a-z0-9_]{1,48}$/;

export function addMaskable(field, label, strategy, userId) {
  if (!VALID_FIELD.test(field)) {
    return { error: 'A field name is lower case letters, digits and underscores, starting with a letter' };
  }
  if (BUILT_IN.includes(field)) {
    return { error: `"${field}" is already masked as standard` };
  }
  if (!MASK_STRATEGIES[strategy]) {
    return { error: `"${strategy}" is not a masking strategy` };
  }
  if (one('SELECT field FROM maskable_field WHERE field = ?', [field])) {
    refreshMaskable();
    return { error: `"${field}" is already in the list` };
  }

  run('INSERT INTO maskable_field (field, label, strategy, created_by) VALUES (?,?,?,?)',
    [field, label || field, strategy, userId ?? null]);
  refreshMaskable();
  return { ok: true };
}

export function removeMaskable(field) {
  if (BUILT_IN.includes(field)) {
    /* Refused rather than ignored. These are the fields the product masks by
       design, and a screen that appears to remove one and does not is worse
       than a screen that says no. */
    return { error: `"${field}" is masked as standard and cannot be removed` };
  }
  if (!one('SELECT field FROM maskable_field WHERE field = ?', [field])) {
    /* Refreshed even though nothing is being removed. Being asked to remove a
       field the table does not have is the strongest hint available that this
       process is holding a list the database does not agree with. */
    refreshMaskable();
    return { error: `"${field}" is not in the list` };
  }

  run('DELETE FROM maskable_field WHERE field = ?', [field]);
  /* The per-role decisions go too. Leaving them would mean re-adding the field
     later silently restored settings nobody could see in the meantime. */
  run('DELETE FROM field_masking WHERE field = ?', [field]);
  refreshMaskable();
  return { ok: true };
}

// Populate the cache at boot, so the first request masks correctly.
refreshMaskable();
