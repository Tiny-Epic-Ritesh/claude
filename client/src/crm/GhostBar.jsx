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

export const stashParentToken = (t) => sessionStorage.setItem(PARENT_KEY, t);
export const hasParentToken = () => Boolean(sessionStorage.getItem(PARENT_KEY));

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
    try {
      await api.post('/setup/ghost/exit', {});
    } catch {
      /* Already expired, or already gone. Either way the right thing now is to
         put the administrator back in their own session rather than strand
         them in somebody else's. */
    }
    const parent = sessionStorage.getItem(PARENT_KEY);
    sessionStorage.removeItem(PARENT_KEY);
    if (parent) tokenStore.set('crm', parent);
    onLeave?.(parent ?? null);
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
        Leave and return
      </button>
    </div>
  );
}
