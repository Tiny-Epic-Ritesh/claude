import { useMemo, useRef, useState } from 'react';
import { Icon, useDismiss } from './ui.jsx';

/**
 * Choose a field by typing its name. P3-04.
 *
 * It was a native `<select>`, and a native select cannot hold a search box —
 * which is fine at a dozen options and unusable at the real number. The
 * production tenant carries 338 lead fields; finding "Alternate mobile" in that
 * meant scrolling a list with no way to jump.
 *
 * So: a button that reads like the select it replaces, opening a panel with a
 * search box and the same two groups the select had. Dismissal is the shared
 * hook from P3-31, so this closes on an outside click and on Escape like every
 * other popover in the product rather than inventing a third behaviour.
 *
 * Keyboard: type to narrow, arrows to move, Enter to choose, Escape to leave.
 * A picker you can only use with a mouse is a step backwards from the select.
 */
export default function FieldPicker({ fields = [], value, onChange, placeholder = 'Choose a field…' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef(null);

  const wrap = useDismiss(open, () => { setOpen(false); setQ(''); });

  const selected = fields.find((f) => f.api_name === value);

  /* Matched on the label and the API name both: somebody who knows the field as
     `alt_mobile` should not have to guess that it is shown as "Alternate
     mobile", and somebody who only knows the label should not have to know
     there is an API name at all. */
  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return fields;
    return fields.filter((f) => `${f.label} ${f.api_name}`.toLowerCase().includes(term));
  }, [fields, q]);

  const core = matches.filter((f) => !f.custom);
  const custom = matches.filter((f) => f.custom);
  const ordered = [...core, ...custom];

  const choose = (f) => {
    onChange(f.api_name);
    setOpen(false);
    setQ('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => {
        const next = e.key === 'ArrowDown' ? c + 1 : c - 1;
        return Math.max(0, Math.min(ordered.length - 1, next));
      });
      return;
    }
    if (e.key === 'Enter' && ordered[cursor]) {
      e.preventDefault();
      choose(ordered[cursor]);
    }
  };

  const renderGroup = (rows, label) => rows.length > 0 && (
    <>
      {label && <div className="launcher-section">{label}</div>}
      {rows.map((f) => {
        const index = ordered.indexOf(f);
        return (
          <button
            key={f.api_name}
            type="button"
            className={`fieldpicker-item ${index === cursor ? 'is-cursor' : ''} ${f.api_name === value ? 'is-chosen' : ''}`}
            onMouseEnter={() => setCursor(index)}
            onClick={() => choose(f)}
          >
            <span>{f.label}</span>
            {/* The API name, quietly. It is what an integration binds to, and
                two fields can share a label after a rename in Setup. */}
            <span className="tiny muted">{f.api_name}</span>
          </button>
        );
      })}
    </>
  );

  return (
    <div className="fieldpicker" ref={wrap}>
      <button
        type="button"
        className="qfield fieldpicker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setCursor(0); }}
      >
        <span className={selected ? '' : 'muted'}>{selected?.label ?? placeholder}</span>
        <Icon name="expand_more" size={15} />
      </button>

      {open && (
        <div className="popover fieldpicker-panel" role="listbox">
          <div style={{ padding: '6px 6px 8px' }}>
            <input
              type="search"
              autoFocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setCursor(0); }}
              onKeyDown={onKeyDown}
              placeholder={`Search ${fields.length} fields…`}
              aria-label="Search fields"
            />
          </div>

          <div className="fieldpicker-list" ref={listRef}>
            {ordered.length === 0 ? (
              <div className="tiny muted" style={{ padding: '10px 12px' }}>
                No field matches “{q}”.
              </div>
            ) : (
              <>
                {renderGroup(core, custom.length ? 'Fields' : null)}
                {renderGroup(custom, 'Added in Setup')}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
