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

/** Objects with a row-level floor of their own, enforced by a scope function. */
export const OWD_ENTITIES = ['lead', 'client', 'case', 'task', 'partner'];

/**
 * Objects whose visibility is derived, and which must NOT have a floor.
 *
 * An interaction is visible if and only if its lead is; a product card the
 * same. That is not a gap waiting to be closed, it is the correct rule, and
 * giving either one a row-level default would break the lead's floor rather
 * than add to it: Public Read on `interaction` would show somebody the calls
 * logged against leads they cannot see, which is a worse leak than the one the
 * floor exists to prevent, because an interaction carries what was said.
 *
 * They are named here rather than left out, so the Setup screen can say
 * "follows the lead" instead of showing a Private badge beside the word "no" --
 * which reads like an omission and invites somebody to fix it.
 */
export const DERIVED_ENTITIES = {
  interaction: 'Follows the lead. An interaction is visible exactly when its lead is.',
  product_interest: 'Follows the lead. A product card is visible exactly when its lead is.',
};

export const isDerived = (apiName) => Object.hasOwn(DERIVED_ENTITIES, apiName);

/**
 * A fixed number per object, because `approvals.entity_id` is an INTEGER and
 * these objects are keyed by name.
 *
 * Written out rather than derived from the array's index or from a hash. An
 * index would shift the moment somebody reorders the list, and a pending
 * request would then attach itself to a different object than the one it was
 * raised against — silently, since the payload would still read correctly. A
 * hash would be stable and unreadable in an audit row.
 *
 * These numbers are permanent. Add to them; never renumber. There is a test.
 */
export const OWD_APPROVAL_KEY = { lead: 1, client: 2, case: 3, task: 4, partner: 5 };

export const approvalKeyFor = (apiName) => OWD_APPROVAL_KEY[apiName] ?? null;

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
  derived: isDerived(r.api_name),
  derived_note: DERIVED_ENTITIES[r.api_name] ?? null,
}));

/**
 * The external default, and why it is no longer pinned.
 *
 * It used to be fixed at Private, because a partner session never reached a
 * scope function: `requireUser` puts staff on `req.user` and partners on
 * `req.partner`, and the portal filtered on `partner_id` in code. A setting
 * that cannot be enforced is worse than one not offered, so it was refused.
 *
 * Portal lead reads now go through `portalLeadScope`, which is shaped like
 * every other scope: the floor is the leads you sourced, grants OR on top, and
 * the partner's own book is ANDed around the outside. So the column governs
 * behaviour rather than describing it, and the pin is gone.
 *
 * ONE INVARIANT REPLACES IT
 * -------------------------
 * **External may never exceed internal.** An outside party cannot be given more
 * reach than the firm's own staff, and without this rule that is one careless
 * PATCH away: leads Private internally and Public Read externally would show a
 * partner every lead in the book while an RM still saw only their own. It reads
 * like a smaller setting than it is, which is exactly why it needs a rule rather
 * than a convention.
 */
export const LEVEL_RANK = { private: 0, read: 1 };

export const exceedsInternal = (external, internal) =>
  (LEVEL_RANK[external] ?? 0) > (LEVEL_RANK[internal] ?? 0);

/**
 * A partner-portal session is external; a staff session is internal.
 *
 * Read from the session shape rather than from a role, because a partner has no
 * role in the staff sense at all -- `partnerLogin` issues a session carrying
 * `partner_id`, and that is the only thing telling the two apart.
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

  /* Which default applies depends on which side of the firm the caller is on,
     and the two are never mixed: an external caller reads the external default
     or nothing, never the internal one by omission. */
  const defaults = defaultsFor(apiName);
  const level = isExternal(user) ? defaults.external : defaults.internal;

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

  /* External may never exceed internal. Checked against what internal will be
     after this call, not what it is now, so setting both at once cannot slip
     an inversion through on ordering. */
  const current = defaultsFor(apiName);
  const nextInternal = internal ?? current.internal;
  const nextExternal = external ?? current.external;
  if (exceedsInternal(nextExternal, nextInternal)) {
    /* Two different mistakes reach here and they want different advice. Widening
       external past internal is the one the invariant exists for. Narrowing
       internal below an external that is already wider is the same inversion
       arrived at from the other side, and the fix is an ordering rather than a
       refusal -- so say which. */
    const narrowing = internal !== undefined;
    return {
      ok: false,
      error: narrowing
        ? `Narrow the partner-portal default first: it is "${nextExternal}", and internal `
          + `cannot go below it. An outside party would be left with more reach than staff.`
        : `The partner portal cannot be given more reach than staff: `
          + `external "${nextExternal}" is wider than internal "${nextInternal}".`,
    };
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
