/**
 * The unsaved-changes bar (P2-06).
 *
 * Sticks to the bottom of the screen rather than the top, because the grid it
 * belongs to is what the reader is looking at and a bar above it pushes the
 * thing they are working on down every time they touch a switch.
 *
 * It states the count. "3 changes" is what makes Save a decision rather than a
 * reflex, and it is the difference between noticing you toggled a row you did
 * not mean to and not.
 */

import { Icon, Spinner } from './ui.jsx';

export default function PendingBar({ draft, what = 'changes', onSaved }) {
  if (!draft.dirty && !draft.error) return null;

  return (
    <div className="pending-bar" role="status">
      {draft.error ? (
        <>
          <Icon name="error" size={16} />
          <span>
            <strong>Not saved.</strong> {draft.error}
            {' '}Your {what} are still here — try again, or discard them.
          </span>
        </>
      ) : (
        <>
          <Icon name="edit" size={16} />
          <span>
            <strong>{draft.count}</strong> unsaved {draft.count === 1 ? what.replace(/s$/, '') : what}.
            {' '}Nothing has changed for anybody yet.
          </span>
        </>
      )}

      <span className="row" style={{ gap: 8, marginLeft: 'auto' }}>
        <button className="btn btn-ghost btn-sm" disabled={draft.saving} onClick={draft.discard}>
          Discard
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={draft.saving || !draft.dirty}
          onClick={async () => { if (await draft.save()) onSaved?.(); }}
        >
          {draft.saving ? <Spinner /> : `Save ${draft.count}`}
        </button>
      </span>
    </div>
  );
}
