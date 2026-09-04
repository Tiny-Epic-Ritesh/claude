import { useState } from 'react';
import { Icon, useDismiss } from './ui.jsx';

/**
 * Choose which columns a list shows. P3-38.
 *
 * Lifted out of the account book, where it was built for the client list, so
 * the lead list gets the same control rather than a second one that drifts.
 * The behaviour is identical on both and so is the wiring: the server resolves
 * role default then personal override, and this only renders what it is told.
 *
 * The choice is a preference and nothing more. The field is still returned by
 * the API and still masked by whatever applies to the person asking, so ticking
 * one back on grants nothing — which is why this needs no permission and is not
 * audited. Hiding a column is tidying.
 */
export default function ColumnChooser({ columns, onToggle, onReset, hasOwnChoice }) {
  const [open, setOpen] = useState(false);
  const wrap = useDismiss(open, () => setOpen(false));

  const hidden = columns.filter((c) => !c.visible).length;

  return (
    <div className="action-menu" ref={wrap}>
      <button
        type="button"
        className="btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="view_column" size={15} /> Columns
        {hidden > 0 && <span className="muted"> · {hidden} hidden</span>}
      </button>

      {open && (
        <div className="menu" role="menu" style={{ padding: 8, minWidth: 220, maxHeight: '22rem', overflowY: 'auto' }}>
          {columns.map((col) => (
            <label
              key={col.key}
              className="tiny"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 6px',
                cursor: col.always ? 'default' : 'pointer',
                opacity: col.always ? 0.6 : 1,
              }}
              title={col.always ? 'Every row needs something to identify it by' : undefined}
            >
              <input
                type="checkbox"
                checked={col.visible}
                disabled={col.always}
                onChange={() => onToggle(col.key, !col.visible)}
              />
              <span style={{ fontWeight: 545 }}>{col.label}</span>
              {col.source === 'role' && <span className="muted">· from your role</span>}
            </label>
          ))}

          {/* Only offered when there is something to go back to: "same as my
              role" and "I ticked them all" are different states. */}
          {hasOwnChoice && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              style={{ marginTop: 6, width: '100%' }}
              onClick={() => { onReset(); setOpen(false); }}
            >
              Back to my role&rsquo;s default
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The state behind the chooser, shared by both lists.
 *
 * Held here because it is the same on every list: fetch what the server
 * resolved, apply a tick optimistically so the table redraws at once, and put
 * it back if the save fails. Two copies of that is two chances to forget the
 * rollback.
 */
export function useColumnChoice(api, list) {
  const [override, setOverride] = useState(null);

  return {
    override,
    setOverride,

    toggle: (columns, reload) => (key, next) => {
      setOverride(columns.map((c) => (c.key === key ? { ...c, visible: next, source: 'user' } : c)));
      api.put(`/setup/columns/${list}`, { columns: { [key]: next } })
        .then(() => reload())
        .catch(() => { setOverride(null); reload(); });
    },

    reset: (reload) => () => {
      setOverride(null);
      api.del(`/setup/columns/${list}`).then(() => reload()).catch(() => reload());
    },
  };
}
