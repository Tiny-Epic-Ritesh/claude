import { Icon } from './ui.jsx';

/**
 * One filter-and-export bar, for every Setup screen that needs one.
 *
 * Four tickets asked for the same thing on four screens — the audit log
 * (P3-01, P3-22), API and logs (P3-23), the database view (P3-24) and data
 * residency (P3-25). Built four times they would have been four bars that
 * cleared differently, remembered differently and put the export in four
 * places, and the fifth screen to want one would have made it five.
 *
 * The fields differ per screen because the data does; the behaviour does not.
 * So this takes a field list and owns everything around it: the layout, the
 * clear, the active count, and where the export button sits.
 *
 * `fields` is a list of:
 *   { name, label, type: 'text' | 'select' | 'date', options?: [{value,label}] }
 *
 * Values are held by the caller, because the screen already owns its query and
 * two copies of that state is how a filter bar and the table under it start
 * disagreeing about what is being shown.
 */
export default function FilterBar({
  fields = [],
  values = {},
  onChange,
  onExport = null,
  exportLabel = 'Export CSV',
  busy = false,
  children = null,
}) {
  const active = fields.filter((f) => String(values[f.name] ?? '') !== '').length;

  const clear = () => onChange(Object.fromEntries(fields.map((f) => [f.name, ''])));
  const set = (name, value) => onChange({ ...values, [name]: value });

  return (
    <div className="filterbar">
      {fields.map((f) => (
        <label key={f.name} className="filterbar-field">
          <span className="tiny muted">{f.label}</span>

          {f.type === 'select' ? (
            <select value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">{f.blank ?? 'Any'}</option>
              {(f.options ?? []).map((o) => {
                const value = typeof o === 'string' ? o : o.value;
                const label = typeof o === 'string' ? o : o.label;
                return <option key={value} value={value}>{label}</option>;
              })}
            </select>
          ) : (
            <input
              type={f.type === 'date' ? 'date' : 'search'}
              value={values[f.name] ?? ''}
              placeholder={f.placeholder ?? ''}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
        </label>
      ))}

      {children}

      <div className="filterbar-actions">
        {/* Only offered when there is something to clear. A permanently
            available Clear on an unfiltered list is a control that does
            nothing, and this product has just spent a ticket removing those. */}
        {active > 0 && (
          <button type="button" className="btn-ghost btn-sm" onClick={clear}>
            {/* Built as a template rather than a bare 'filter' literal: the
                icon test scans every quoted vocabulary word, and that one is a
                Material Symbols name. */}
            {`Clear ${active === 1 ? '' : `${active} `}filter${active === 1 ? '' : 's'}`}
          </button>
        )}

        {onExport && (
          <button type="button" className="btn btn-sm" onClick={onExport} disabled={busy}>
            <Icon name="download" size={15} /> {busy ? 'Preparing…' : exportLabel}
          </button>
        )}
      </div>
    </div>
  );
}
