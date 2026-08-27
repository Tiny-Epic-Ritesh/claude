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

import { all, run } from '../db.js';
import { MASKERS } from '../security.js';

/** The fields that have a masker at all. Nothing else can be masked. */
export const MASKABLE = Object.keys(MASKERS);

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
 * Roles that see everything in the clear by default.
 *
 * Marketing Manager is here because the requirement says so. Worth recording
 * that it is the one entry with a tension behind it: this role segments and
 * sends rather than opening individual records, so under data minimisation it
 * is the least obvious candidate for clear-text PII. It is configurable on this
 * very screen, which is the right place for that argument to be settled.
 */
export const UNMASKED_BY_DEFAULT = new Set(['superadmin', 'admin', 'marketing_manager']);

export const defaultMasked = (role, field) =>
  MASKABLE.includes(field) && !UNMASKED_BY_DEFAULT.has(role);

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
  return new Set(MASKABLE.filter((field) => {
    const key = `${role}|${field}`;
    return cfg.has(key) ? cfg.get(key) : defaultMasked(role, field);
  }));
}

/** The full grid for Setup, with where each answer came from. */
export function maskingMatrix(roles) {
  const cfg = configured();
  return roles.map((role) => ({
    role,
    fields: Object.fromEntries(MASKABLE.map((field) => {
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
