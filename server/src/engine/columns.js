/**
 * Which columns a list shows, per role and per person.
 *
 * WHY THIS RIDES `tab_visibility` RATHER THAN A NEW TABLE
 * ------------------------------------------------------
 * A column is a visibility decision keyed by scope, which is exactly what that
 * table stores: `(scope_type, scope_key, tab_id) -> visible`. The resolve chain
 * it already implements — a person's own choice beats their role's default,
 * which beats what shipped — is the chain a column chooser wants, and it is
 * worth having one of those in the product rather than two that drift.
 *
 * The ids are prefixed for the same reason Setup screens are: `clients` is
 * already a tab id, and an unprefixed column called `name` would collide with
 * anything else that ever wants a setting called `name`.
 *
 * WHY THE ACCOUNT BOOK DOES NOT GET A "CLIENT LIST" OBJECT
 * -------------------------------------------------------
 * A lead list owns its columns because a lead list *is* a row — it has an
 * owner, a name and sharing, so there is something for the choice to belong to.
 * The account book is a tab: a place, not a saved view. Inventing a Client List
 * object solely to have somewhere to hang six booleans would be building the
 * artefact instead of the capability, which is the standing rule in CLAUDE.md.
 *
 * When saved, shareable client views are actually wanted, that is when a Client
 * List earns its place — and it will own its columns the way a lead list does.
 *
 * WHAT A HIDDEN COLUMN IS NOT
 * ---------------------------
 * It is not security. Hiding a column is tidying: the field is still returned by
 * the API, still masked by whatever field-level rules apply to the person asking,
 * and showing it again grants nothing that was not already granted. This is the
 * same sentence as the tab rule, and there is a test that holds it — because
 * "just hide the column" is a tempting answer to a masking request and it is
 * always the wrong one.
 */

import { all, one, run } from '../db.js';

/** Column ids live under this prefix so they cannot collide with tab ids. */
export const COLUMN_PREFIX = 'cols:';

export const columnTabId = (list, key) => `${COLUMN_PREFIX}${list}:${key}`;

/**
 * The catalogue.
 *
 * `label` is duplicated from the client's own render table on purpose: the
 * server needs it for the Setup grid, and the client needs its own rendering
 * details (which column is numeric, which is sortable). A test asserts the two
 * agree, the same way one already does for Setup screens — duplication that is
 * checked is cheaper here than a rendering concern moved onto the server.
 *
 * `always: true` means the column cannot be hidden. A row with nothing
 * identifying left on it is a row nobody can act on, so the name stays.
 */
export const LIST_COLUMNS = {
  client: [
    { key: 'name', label: 'Client', default: true, always: true },
    { key: 'client_code', label: 'UCC', default: true },
    { key: 'holding_value', label: 'Holdings', default: true },
    { key: 'brokerage_ytd', label: 'Brokerage YTD', default: true },
    { key: 'last_traded_at', label: 'Last trade', default: true },
    { key: 'owner_name', label: 'Owner', default: true },
  ],

  /* The lead list. P3-38.
   *
   * Ritesh settled the mandatory set on 4 Sep: the lead's name and nothing
   * else. Every other column is somebody's noise -- a caller does not need AUM,
   * a dealer does not need Source -- but a row you cannot identify is not a row.
   *
   * The eight that shipped default on, so nobody's list changes on the day this
   * arrives. The rest are available and off, which is the point of the ticket:
   * they were in the payload already and there was no way to see them. */
  lead: [
    { key: 'name', label: 'Lead', default: true, always: true },
    { key: 'stage', label: 'Stage', default: true },
    { key: 'products', label: 'Products', default: true },
    { key: 'age_days', label: 'Age', default: true },
    { key: 'owner_name', label: 'Owner', default: true },
    { key: 'partner_name', label: 'Partner', default: true },
    { key: 'aum', label: 'AUM', default: true },
    { key: 'score', label: 'Score', default: true },

    // Present in the list payload, never shown until now.
    { key: 'mobile', label: 'Mobile', default: false },
    { key: 'email', label: 'Email', default: false },
    { key: 'city', label: 'City', default: false },
    { key: 'state', label: 'State', default: false },
    { key: 'source', label: 'Source', default: false },
    { key: 'language', label: 'Language', default: false },
    { key: 'risk_profile', label: 'Risk profile', default: false },
    { key: 'kyc_status', label: 'KYC status', default: false },
    { key: 'client_code', label: 'UCC', default: false },
    { key: 'created_at', label: 'Created', default: false },
    { key: 'updated_at', label: 'Last updated', default: false },
    { key: 'callback_at', label: 'Callback due', default: false },
  ],
};

export const isList = (list) => Object.hasOwn(LIST_COLUMNS, list);

const catalogue = (list) => LIST_COLUMNS[list] ?? [];

const rowsFor = (scopeType, scopeKey) => {
  const map = new Map();
  for (const r of all(
    'SELECT tab_id, visible FROM tab_visibility WHERE scope_type = ? AND scope_key = ?',
    [scopeType, String(scopeKey)],
  )) map.set(r.tab_id, Boolean(r.visible));
  return map;
};

/**
 * What this person sees, and where each answer came from.
 *
 * The source matters for the same reason it does on tabs: "why is this column
 * missing" is a support question, and "your role's default" and "you turned it
 * off" want different answers.
 */
export function resolveColumns(user, list) {
  if (!isList(list)) return [];

  const userRows = rowsFor('user', user.id);
  const roleRows = rowsFor('role', user.role);

  return catalogue(list).map((col) => {
    const id = columnTabId(list, col.key);

    // Never let a stored row hide a column that must not be hidden. A bad row
    // written before `always` existed would otherwise strand the list.
    if (col.always) return { ...col, visible: true, source: 'required' };

    if (userRows.has(id)) return { ...col, visible: userRows.get(id), source: 'user' };
    if (roleRows.has(id)) return { ...col, visible: roleRows.get(id), source: 'role' };
    return { ...col, visible: col.default !== false, source: 'default' };
  });
}

/** Just the keys, for a caller that only wants to filter a render list. */
export const visibleColumnKeys = (user, list) =>
  resolveColumns(user, list).filter((c) => c.visible).map((c) => c.key);

/* ------------------------------------------------------------- writing */

function write(scopeType, scopeKey, list, key, visible, actorId) {
  run(
    `INSERT INTO tab_visibility (scope_type, scope_key, tab_id, visible, updated_by, updated_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(scope_type, scope_key, tab_id) DO UPDATE SET
       visible = excluded.visible, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [scopeType, String(scopeKey), columnTabId(list, key), visible ? 1 : 0, actorId ?? null],
  );
}

/**
 * Apply a set of choices for one person.
 *
 * Takes the whole set rather than one column at a time, because that is how the
 * chooser is used — somebody opens it, ticks two things, and closes it. Sending
 * six requests for one interaction would make the list flicker through five
 * states nobody asked to see.
 *
 * A key that must always show is ignored rather than refused: the caller sent
 * the whole set, and failing the batch because it included `name` would make a
 * correct client look broken.
 */
export function setUserColumns(userId, list, choices = {}, actorId = null) {
  if (!isList(list)) return { ok: false, error: `There is no list called "${list}"` };

  const known = new Map(catalogue(list).map((c) => [c.key, c]));
  const unknown = Object.keys(choices).filter((k) => !known.has(k));
  if (unknown.length) {
    return { ok: false, error: `Not a column on this list: ${unknown.join(', ')}` };
  }

  for (const [key, visible] of Object.entries(choices)) {
    if (known.get(key).always) continue;
    write('user', userId, list, key, visible, actorId);
  }
  return { ok: true };
}

/** The role default, which a person's own choice still beats. */
export function setRoleColumns(role, list, choices = {}, actorId = null) {
  if (!isList(list)) return { ok: false, error: `There is no list called "${list}"` };

  const known = new Map(catalogue(list).map((c) => [c.key, c]));
  const unknown = Object.keys(choices).filter((k) => !known.has(k));
  if (unknown.length) {
    return { ok: false, error: `Not a column on this list: ${unknown.join(', ')}` };
  }

  for (const [key, visible] of Object.entries(choices)) {
    if (known.get(key).always) continue;
    write('role', role, list, key, visible, actorId);
  }
  return { ok: true };
}

/**
 * Drop this person's choices so they follow their role again.
 *
 * Distinct from ticking everything on: "same as my role" and "I want all six"
 * are different states, and only the first should move when the role default
 * changes.
 */
export function clearUserColumns(userId, list) {
  if (!isList(list)) return { ok: false, error: `There is no list called "${list}"` };
  run(
    `DELETE FROM tab_visibility WHERE scope_type = 'user' AND scope_key = ? AND tab_id LIKE ?`,
    [String(userId), `${COLUMN_PREFIX}${list}:%`],
  );
  return { ok: true };
}

/** Every role default for one list, for a Setup grid. */
export const roleDefaultsFor = (list) => {
  if (!isList(list)) return [];
  return all(
    `SELECT scope_key AS role, tab_id, visible FROM tab_visibility
      WHERE scope_type = 'role' AND tab_id LIKE ?`,
    [`${COLUMN_PREFIX}${list}:%`],
  ).map((r) => ({
    role: r.role,
    key: r.tab_id.slice(`${COLUMN_PREFIX}${list}:`.length),
    visible: Boolean(r.visible),
  }));
};

/** Does this user have any choice of their own on this list? */
export const hasUserChoice = (userId, list) => Boolean(one(
  `SELECT 1 AS x FROM tab_visibility
    WHERE scope_type = 'user' AND scope_key = ? AND tab_id LIKE ? LIMIT 1`,
  [String(userId), `${COLUMN_PREFIX}${list}:%`],
));
