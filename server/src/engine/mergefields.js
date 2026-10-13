/**
 * Merge fields for templates and composed email (P2-09).
 *
 * The LeadSquared audit found copy keyed to fields that did not exist — five
 * forms and three processes referencing names nobody could resolve. A merge
 * field that resolves to nothing does not fail loudly; it sends a client an
 * email addressed to a blank space. So the list of what may be merged is
 * derived from the field registry, and a template naming anything outside it
 * is refused at save rather than discovered in somebody's inbox.
 *
 * NOT EVERY FIELD IS OFFERABLE, and the exclusions matter more than the list:
 *
 *   • Encrypted fields are excluded outright. `pan` is in the registry and a
 *     PAN in the body of an email is a data-protection incident, not a
 *     personalisation feature. Nothing here can put one there.
 *   • Fields behind a read capability are excluded for the same reason one
 *     level down: a merge field would resolve for whoever composed it and
 *     bypass the masking that applies to everyone else reading the record.
 *   • Checkboxes are excluded because "Opted Out of Marketing: 0" is not a
 *     sentence anybody meant to send.
 *   • Lookups are excluded raw and offered resolved instead — {{owner}} is the
 *     RM's name, never the integer in owner_id.
 */

import { all, one } from '../db.js';
import { maskedFieldsFor } from './masking.js';

/** Types that read sensibly in a sentence written to a client. */
const MERGEABLE_TYPES = new Set([
  'text', 'email', 'phone', 'picklist', 'currency', 'number', 'date', 'datetime',
]);

/**
 * Fields the CRM computes rather than stores, offered alongside the real ones.
 *
 * `name` is the first name on purpose: "Dear Aarav Malhotra," reads like a
 * bank letter, and the whole point of a merge field is that it should not.
 */
export const COMPUTED = {
  name: { label: 'First name', example: 'Aarav', of: (lead) => (lead.name || '').split(' ')[0] },
  full_name: { label: 'Full name', example: 'Aarav Malhotra', of: (lead) => lead.name },
  rm: { label: 'Your name', example: 'Sneha Kulkarni', of: (_lead, user) => user?.name },
  org: {
    label: 'Business',
    example: 'Bonanza',
    of: (lead) => (lead.sales_org === 'BIGUL' ? 'Bigul' : 'Bonanza'),
  },
  owner: {
    label: "Lead's owner",
    example: 'Vikram Rathore',
    of: (lead) => (lead.owner_id
      ? one('SELECT name FROM users WHERE id = ?', [lead.owner_id])?.name ?? null
      : null),
  },
};

/**
 * Everything a template may reference, with a label and an example.
 *
 * The example is not decoration: an RM choosing between {{name}} and
 * {{full_name}} is choosing between "Aarav" and "Aarav Malhotra", and showing
 * them that is quicker than explaining it.
 */
export function availableMergeFields(entity = 'lead') {
  const computed = Object.entries(COMPUTED).map(([token, spec]) => ({
    token,
    label: spec.label,
    example: spec.example,
    source: 'computed',
  }));

  const stored = all(
    `SELECT api_name, label, type FROM field_def
      WHERE entity = ? AND active = 1
        AND encrypted = 0
        AND read_capability IS NULL
      ORDER BY sort_order, label`,
    [entity],
  )
    .filter((f) => MERGEABLE_TYPES.has(f.type))
    // Already offered, better, as a computed token.
    .filter((f) => !['name', 'sales_org'].includes(f.api_name))
    .map((f) => ({
      token: f.api_name,
      label: f.label,
      example: null,
      source: 'field',
      type: f.type,
    }));

  return [...computed, ...stored];
}

/**
 * Fill a body for one lead and one sender (QA-11).
 *
 * The one resolver. The composer built its own four-entry list and sent
 * {{owner}}, {{city}}, {{mobile}} and {{email}} literally although its own
 * picker offered them; a campaign replaced {{name}} and nothing else. Both
 * now come here, so what the picker offers is what gets filled.
 *
 * The same substitution the composer's merge() makes: an offered field with
 * no value becomes empty (valuesFor's rule, below), and a token nothing
 * offers is left as written. Saving a template refuses unknown tokens;
 * sending does not, so one typed into a composed message goes out as typed.
 */
export function fill(text, lead, user) {
  const vars = valuesFor(lead, user);
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => (
    vars[key] != null ? String(vars[key]) : m
  ));
}

/**
 * Tokens this sender may not merge (QA-11).
 *
 * A field masked for the sender's role, who may not unmask it, cannot be
 * merged: the filled message lands on the timeline, where the same person
 * reads it back unmasked. Refused before sending, by name.
 */
export function maskedTokens(text, role, mayUnmask) {
  if (mayUnmask) return [];
  const masked = maskedFieldsFor(role);
  return tokensIn(text).filter((t) => masked.has(t));
}

/** Every {{token}} in a body or subject, in the order they appear. */
export const tokensIn = (text) => [
  ...new Set(
    [...String(text ?? '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]),
  ),
];

/**
 * Which tokens in this text cannot be resolved.
 *
 * Returned as a list rather than thrown so the composer can mark the offending
 * ones instead of showing one opaque message about a template it will not save.
 */
export function unknownTokens(text, entity = 'lead') {
  const known = new Set(availableMergeFields(entity).map((f) => f.token));
  return tokensIn(text).filter((t) => !known.has(t));
}

/**
 * The values for one lead, ready to substitute.
 *
 * A field with no value resolves to an empty string rather than being left as
 * the raw token: a client seeing "Hello {{name}}" knows something is broken,
 * and would rather not.
 */
export function valuesFor(lead, user, entity = 'lead') {
  const out = {};
  for (const field of availableMergeFields(entity)) {
    if (field.source === 'computed') {
      out[field.token] = COMPUTED[field.token].of(lead, user) ?? '';
    } else {
      const v = lead?.[field.token];
      out[field.token] = v == null ? '' : String(v);
    }
  }
  return out;
}
