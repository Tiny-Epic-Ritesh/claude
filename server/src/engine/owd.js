/**
 * Organisation-wide defaults — the floor beneath every grant.
 *
 * NON-NEGOTIABLE 7: one restrictive floor, then grant-only layers.
 *
 * WHAT WAS ACTUALLY MISSING
 * -------------------------
 * The grant-only layers were built, and so was a floor -- `leadScope`,
 * `clientScope` and `ticketScope` each start from "your own records" and OR
 * grants on top. What did not exist was the floor being *declared*. It lived
 * inside three functions, which meant three things:
 *
 *   - an administrator could not see what the default was, let alone change it;
 *   - the objects could drift apart, because nothing held them to one shape;
 *   - and there was no way to say anything at all about external viewers.
 *
 * So this is not a new restriction. It is the existing one written down, in the
 * one place the reference model puts it, with a knob an administrator can
 * actually reach.
 *
 * TWO LEVELS, NOT THREE
 * ---------------------
 * The reference model has Private, Public Read Only and Public Read/Write. This
 * offers the first two.
 *
 * `read_write` is deliberately absent rather than accepted-and-ignored. Write
 * in this product is gated by capabilities (`lead.edit`, `client.edit`), not by
 * the visibility floor, so an OWD of Public Read/Write would change nothing
 * about who can edit — and a setting that says "read/write" while granting only
 * read is worse than a setting that is not offered. When write gating moves
 * under the same floor, this is where the third level goes.
 *
 * WHAT THE FLOOR CANNOT DO
 * ------------------------
 * It cannot cross the book boundary, and this is structural rather than
 * checked. Every scope function computes `reach` (the grants, ORed) and then
 * ANDs it with `orgScope`. An OWD grant joins the OR-list, so widening a
 * default to Public Read shows an internal user everything **in the books they
 * are already entitled to** and nothing outside them. A Bonanza user made
 * org-wide still sees no Bigul record.
 *
 * That is the property worth stating plainly, because "make leads public" is
 * exactly the sort of setting somebody reaches for at five o'clock, and the
 * cross-book exposure we are already holding an incident report about must not
 * be one checkbox away.
 */

import { all, one, run } from '../db.js';

/** The floor levels, most restrictive first. */
export const OWD_LEVELS = [
  {
    value: 'private',
    label: 'Private',
    blurb: 'Only the owner, plus whatever role scope, management chain or queue grants.',
  },
  {
    value: 'read',
    label: 'Public Read Only',
    blurb: 'Everyone in the same book may read every record. Editing is unchanged.',
  },
];

const LEVEL_VALUES = OWD_LEVELS.map((l) => l.value);

export const isLevel = (value) => LEVEL_VALUES.includes(value);

/** Objects whose floor is enforced. Others carry the columns but nothing reads them. */
export const OWD_ENTITIES = ['lead', 'client', 'case'];

/**
 * The declared defaults for one object.
 *
 * Falls back to private when the row is missing rather than to open. An object
 * that has not been configured yet is not a reason to show everybody
 * everything, and a typo'd api_name must fail closed.
 */
export function defaultsFor(apiName) {
  const row = one(
    'SELECT owd_internal, owd_external FROM entity_def WHERE api_name = ?',
    [apiName],
  );
  const clean = (v) => (isLevel(v) ? v : 'private');
  return {
    internal: clean(row?.owd_internal),
    external: clean(row?.owd_external),
  };
}

/** Every object's defaults, for the Setup screen. */
export const allDefaults = () => all(
  `SELECT api_name, label, label_plural, owd_internal, owd_external
     FROM entity_def WHERE active = 1 ORDER BY sort_order, api_name`,
).map((r) => ({
  ...r,
  enforced: OWD_ENTITIES.includes(r.api_name),
}));

/**
 * Why the external default is pinned to Private.
 *
 * A partner session never reaches `leadScope` at all. `requireUser` puts staff
 * on `req.user` and partners on `req.partner`, and the partner portal reads its
 * records through a hard `partner_id = ?` filter — a partner sees the leads
 * they sourced and nothing else, in code, with no scope function in the path.
 *
 * That is already the strictest possible floor, so the external column records
 * it rather than controlling it. Making it settable would be worse than leaving
 * it out: the setting would either do nothing, or — if someone later wired it
 * up without reading this — let one partner see another partner's book, or the
 * firm's.
 *
 * The pin lifts when partner reads go through a scope function like everything
 * else. Until then this is a declaration, and `setDefaults` refuses to move it.
 */
export const EXTERNAL_PINNED = 'private';

export const EXTERNAL_PIN_REASON = 'Partner portal reads are filtered to the partner\'s own '
  + 'sourced records in code, without passing through a scope function, so an external default '
  + 'above Private would not be enforced. It stays Private until partner reads move under the '
  + 'same floor as staff reads.';

/**
 * A partner-portal session is external; a staff session is internal.
 *
 * Kept because the distinction is real and the column records it — but note
 * that nothing reaching `owdGrant` today is external, for the reason above.
 */
export const isExternal = (user) => Boolean(user?.partner_id || user?.kind === 'partner');

/**
 * The floor's contribution to a scope, or null when it grants nothing.
 *
 * Returning null rather than `1=0` matters: these are ORed together, and a
 * `1=0` in an OR-list is noise in every query plan and every debug log for a
 * setting that is doing nothing. Private adds no clause because private *is*
 * the absence of a grant.
 */
export function owdGrant(apiName, user) {
  if (!OWD_ENTITIES.includes(apiName)) return null;

  /* External callers do not arrive here (see EXTERNAL_PIN_REASON), but if one
     ever does, it must not pick up the internal default by omission. */
  if (isExternal(user)) return null;

  const level = defaultsFor(apiName).internal;

  /* `1=1` widens to everything the surrounding query already reaches, which is
     one book, because the caller ANDs org scope around this. */
  return level === 'read' ? { sql: '1=1', params: [] } : null;
}

/**
 * Change an object's defaults.
 *
 * Refuses an unknown level rather than storing it: a value outside the list
 * would read back as private through `defaultsFor`, so the setting would appear
 * to save and then silently not apply.
 */
export function setDefaults(apiName, { internal, external } = {}) {
  const def = one('SELECT api_name FROM entity_def WHERE api_name = ?', [apiName]);
  if (!def) return { ok: false, error: `There is no object called "${apiName}"` };

  if (external !== undefined && external !== EXTERNAL_PINNED) {
    return { ok: false, error: EXTERNAL_PIN_REASON };
  }

  const sets = [];
  const params = [];
  for (const [field, value] of [['owd_internal', internal], ['owd_external', external]]) {
    if (value === undefined) continue;
    if (!isLevel(value)) {
      return { ok: false, error: `"${value}" is not a sharing default. Use one of: ${LEVEL_VALUES.join(', ')}` };
    }
    sets.push(`${field} = ?`);
    params.push(value);
  }
  if (!sets.length) return { ok: false, error: 'Nothing to change' };

  run(`UPDATE entity_def SET ${sets.join(', ')} WHERE api_name = ?`, [...params, apiName]);
  return { ok: true, api_name: apiName, ...defaultsFor(apiName) };
}
