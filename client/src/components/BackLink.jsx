/**
 * A back control that actually goes back (P3-26).
 *
 * The product had no true back anywhere. What it had, on five detail screens,
 * was a link to a fixed parent: "← Partners" on a partner, "← Leads" on a lead.
 * Those look like back buttons and are not one. Reach a partner from a search
 * result, a dashboard tile, a task, or the cockpit worklist, press "← Partners",
 * and you arrive somewhere you have never been — with whatever filters you had
 * set on the way in thrown away.
 *
 * That is the reported bug, and the reason it was reported against a screen
 * that already had the control.
 *
 * WHEN THERE IS NOTHING TO GO BACK TO
 * -----------------------------------
 * A record opened from a pasted URL, a bookmark, an email link or a new tab has
 * no history of ours behind it, and navigate(-1) would take the person out of
 * the product entirely — to their inbox, or to a blank tab. React Router keeps
 * its own position in the session history stack in `history.state.idx`, and 0
 * means this is the first page of the session. So the parent link is kept for
 * exactly that case: it is the right answer when there is no previous view, and
 * the wrong one whenever there is.
 *
 * The label changes with the behaviour. A control that says "Leads" and returns
 * you to the dashboard you came from is the same lie in the other direction.
 */

import { Link, useNavigate } from 'react-router-dom';

/**
 * @param to      where to go when there is no history — the screen's parent
 * @param label   what to call that parent ("Leads", "Lead Lists")
 * @param icon    optional node rendered before the text, to match the screen
 * @param className passed through so each screen keeps the styling it had
 */
export default function BackLink({ to, label, icon = null, className = 'small muted' }) {
  const navigate = useNavigate();

  /* Read at render rather than kept in state: the same component instance can
     outlive a navigation, and a stale answer here sends people the wrong way. */
  const hasHistory = (window.history.state?.idx ?? 0) > 0;

  const body = (
    <>
      {icon ?? '←'} {hasHistory ? 'Back' : label}
    </>
  );

  if (!hasHistory) {
    return <Link to={to} className={className}>{body}</Link>;
  }

  return (
    <button type="button" className={`backlink ${className}`} onClick={() => navigate(-1)}>
      {body}
    </button>
  );
}
