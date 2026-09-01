/**
 * The ghost session banner (P2-04).
 *
 * The failure mode this exists for is not malice. It is an administrator
 * opening a colleague's view to answer a question, being interrupted, and
 * carrying on working as that person for the rest of the afternoon — every
 * record they touch attributed to somebody who was at lunch.
 *
 * So it is loud, it is fixed to the top of the window, and it does not
 * collapse. A banner that can be dismissed is a banner that will be, by the
 * person most likely to need it. The sixty-minute cap is the backstop for when
 * this is ignored anyway; the countdown is here so the end is not a surprise
 * that loses somebody's half-written note.
 */

import { useEffect, useState } from 'react';
import { api, token as tokenStore } from '../api.js';
import { Icon } from '../components/ui.jsx';

/** Where the administrator's own token waits while they are somebody else. */
const PARENT_KEY = 'bnz_crm_token_parent';
/** And where they were standing when they left, so returning is a round trip. */
const RETURN_KEY = 'bnz_crm_ghost_return';
/** Who they are, so the banner can name them before any request comes back. */
const PARENT_NAME_KEY = 'bnz_crm_ghost_parent_name';

export const stashParentToken = (t, { name = null, returnTo = null } = {}) => {
  sessionStorage.setItem(PARENT_KEY, t);
  if (name) sessionStorage.setItem(PARENT_NAME_KEY, name);
  if (returnTo) sessionStorage.setItem(RETURN_KEY, returnTo);
};

export const hasParentToken = () => Boolean(sessionStorage.getItem(PARENT_KEY));
export const parentName = () => sessionStorage.getItem(PARENT_NAME_KEY);
export const ghostReturnTo = () => sessionStorage.getItem(RETURN_KEY);

/**
 * Hand the administrator back their own session.
 *
 * Shared by the banner and the profile menu, because both are now the same act
 * and having two of them was how one could end the session outright.
 */
export async function leaveGhost() {
  try {
    await api.post('/setup/ghost/exit', {});
  } catch {
    /* Already expired, or already gone. Either way the right thing now is to
       put the administrator back in their own session rather than strand them
       in somebody else's. */
  }
  const parent = sessionStorage.getItem(PARENT_KEY);
  const back = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(PARENT_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  sessionStorage.removeItem(PARENT_NAME_KEY);
  if (parent) tokenStore.set('crm', parent);
  return { restored: Boolean(parent), returnTo: back };
}

export default function GhostBar({ ghostOf, actingAs, onLeave }) {
  const [left, setLeft] = useState(null);
  const [busy, setBusy] = useState(false);

  /* Counts down from whenever the session started, which the server caps at
     sixty minutes. Approximate on purpose — the server decides, and a client
     clock that disagrees should not be the thing anybody trusts. */
  useEffect(() => {
    const started = Date.now();
    const tick = () => setLeft(Math.max(0, 60 - Math.floor((Date.now() - started) / 60000)));
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  const leave = async () => {
    setBusy(true);
    const { restored, returnTo } = await leaveGhost();
    onLeave?.(restored, returnTo);
  };

  return (
    <div className="ghostbar" role="status">
      <Icon name="visibility" size={16} />
      <span>
        You are signed in as <strong>{actingAs}</strong>
        {ghostOf && <> on behalf of <strong>{ghostOf}</strong></>}.
        {' '}Everything you do here is recorded against both names.
        {left !== null && left <= 10 && (
          <> <strong>{left === 0 ? 'Ending now.' : `Ends in ${left} min.`}</strong></>
        )}
      </span>
      <button className="btn btn-sm" disabled={busy} onClick={leave}>
        {busy ? 'Returning…' : `Return to ${parentName() ?? ghostOf ?? 'your account'}`}
      </button>
    </div>
  );
}
