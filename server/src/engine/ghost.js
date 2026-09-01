/**
 * Ghost login — seeing the product as somebody else sees it (P2-04).
 *
 * The feature is genuinely useful: "it looks wrong on my screen" is the most
 * common support call in any CRM, and the fastest answer is to look at their
 * screen. It is also the single most dangerous thing an administrator can do,
 * so the constraints matter more than the mechanism.
 *
 * WHO MAY GHOST INTO WHOM (Q-04)
 *
 * Nobody ghosts into a Super Admin — that is how impersonation becomes
 * privilege escalation, and the person who could authorise it is the person
 * doing it. Admin reaches any non-admin role. Super Admin reaches anyone below
 * Super Admin. Nobody ghosts into themselves, which sounds harmless and
 * produces a session that cannot be exited cleanly.
 *
 * THE AUDIT TRAIL EXTENDS, IT DOES NOT REPLACE
 *
 * Every row written during a ghost session carries BOTH identities — "Kavita,
 * acting as Sneha". A session that logs only the impersonated user does not
 * extend the audit trail, it destroys it: every action looks like the RM's own,
 * and the one question an auditor will ask ("who actually did this?") becomes
 * unanswerable. That is threaded through `requestContext`, not through 132 call
 * sites.
 *
 * SIXTY MINUTES, HARD
 *
 * The failure mode is not malice, it is an administrator forgetting they are
 * impersonating and working as somebody else by accident for an afternoon. The
 * banner is there for the same reason; the cap is there for when the banner is
 * ignored.
 */

import { one, run } from '../db.js';
import { newSessionToken } from '../security.js';

/** A ghost session is short by design. */
export const GHOST_MINUTES = 60;

/**
 * May `actor` ghost into `target`?
 *
 * Returns null when allowed, or the reason when not. Reasons are shown to an
 * administrator, so they say what the rule is rather than "forbidden".
 */
export function mayGhost(actor, target) {
  if (!actor || !target) return 'No such user';
  if (!target.active) return `${target.name} is deactivated`;
  if (actor.id === target.id) return 'You are already signed in as yourself';

  if (target.role === 'superadmin') {
    return 'Nobody can sign in as a Super Admin — that would make impersonation a way to gain permissions';
  }
  if (actor.role === 'superadmin') return null;

  if (actor.role === 'admin') {
    if (target.role === 'admin') {
      return 'An Admin cannot sign in as another Admin. Ask a Super Admin.';
    }
    return null;
  }
  return 'Only an Admin or Super Admin can sign in as another user';
}

/**
 * Start a ghost session.
 *
 * A new token rather than a mutation of the caller's: the administrator's own
 * session stays alive and untouched, so exiting is a swap back rather than a
 * re-login. It also means revoking the ghost cannot accidentally sign the
 * administrator out of their own account.
 */
export function start(actor, target) {
  const refusal = mayGhost(actor, target);
  if (refusal) return { error: refusal };

  const token = newSessionToken();
  run(
    `INSERT INTO sessions (token, kind, user_id, ghost_of, created_at, last_seen_at, expires_at)
     VALUES (?, 'crm', ?, ?, datetime('now'), datetime('now'), datetime('now', ?))`,
    [token, target.id, actor.id, `+${GHOST_MINUTES} minutes`],
  );

  return {
    token,
    expires_in_minutes: GHOST_MINUTES,
    acting_as: { id: target.id, name: target.name, role: target.role, sales_org: target.sales_org },
    on_behalf_of: { id: actor.id, name: actor.name },
  };
}

/** End one. Only ever the ghost session — never the administrator's own. */
export function stop(token) {
  const session = one('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!session || !session.ghost_of) return false;
  run('DELETE FROM sessions WHERE token = ?', [token]);
  return true;
}
