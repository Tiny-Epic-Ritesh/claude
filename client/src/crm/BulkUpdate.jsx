/**
 * Bulk update on the lead list view (P3-39).
 *
 * Three ways to choose what gets updated, and the whole point of separating
 * them is that they are genuinely different intentions:
 *
 *   the ticked rows        "these twenty-five"
 *   everything matching    "all 1,500 in this result"
 *   the first N            "the oldest 900 of them"
 *
 * The counts in the labels are real — the selection count from the table, the
 * total from the same query the list is showing — because a label that says
 * "all leads" over a number the person cannot see is how somebody updates
 * fifteen hundred records meaning to update fifty.
 *
 * WHAT THIS SCREEN REFUSES TO GUESS
 * ---------------------------------
 * The field list and the values each field allows come from the server. A
 * dialog that offers a field the write rejects, or a value it will not accept,
 * teaches people that the error message is noise. The value control stays
 * disabled until a field is chosen, which the ticket asks for and which also
 * happens to be the only honest state: until there is a field, there is no such
 * thing as a valid value.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Modal, Spinner, ErrorBanner, Icon } from '../components/ui.jsx';

export default function BulkUpdate({ selected, total, query, onClose, onDone }) {
  const [options] = useApi('/leads/bulk/options');
  const [mode, setMode] = useState('ids');
  const [limit, setLimit] = useState('');
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const fields = options?.fields ?? [];
  const chosen = fields.find((f) => f.key === field);

  /* Checked here as well as on the server, so the person is told before they
     press the button rather than after. The server checks again against a
     freshly counted total, because rows move between a page loading and
     somebody acting on it. */
  const overCount = mode === 'first' && limit !== '' && Number(limit) > total;
  const noCount = mode === 'first' && (limit === '' || Number(limit) < 1);

  const ready = field && !overCount && !noCount
    && (mode !== 'ids' || selected.length > 0)
    && value !== '';

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { field, value, mode };
      if (mode === 'ids') body.ids = selected;
      if (mode === 'first') body.limit = Number(limit);

      const out = await api.post(`/leads/bulk/field${query ? `?${query}` : ''}`, body);
      setDone(out);
      onDone?.(out);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <Modal title="Updated" onClose={onClose}>
        <div className="importsum" style={{ marginBottom: 12 }}>
          <div className="importsum-cell is-good"><strong>{done.changed}</strong><span>Changed</span></div>
          <div className="importsum-cell"><strong>{done.unchanged}</strong><span>Already set</span></div>
          <div className="importsum-cell"><strong>{done.matched}</strong><span>Matched</span></div>
        </div>
        <p className="muted">
          {chosen?.label ?? done.field} set to <strong>{String(done.value)}</strong>.
          {done.unchanged > 0 && ' Leads already holding that value were left alone, so their history is unchanged.'}
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Bulk update" subtitle="Choose which leads, then what to set" onClose={onClose} wide>
      <ErrorBanner error={error} />

      {/* ------------------------------------------------------ which leads */}
      <div className="stack" style={{ gap: 6, marginBottom: 14 }}>
        <label className={`pick-row ${mode === 'ids' ? 'is-chosen' : ''}`}>
          <input type="radio" name="bulkmode" checked={mode === 'ids'} onChange={() => setMode('ids')} disabled={!selected.length} />
          <span>
            <strong>
              {selected.length
                ? `Update ${selected.length.toLocaleString('en-IN')} lead${selected.length === 1 ? '' : 's'}`
                : 'Update the selected leads'}
            </strong>
            <div className="tiny muted">The ones ticked on this page.</div>
          </span>
        </label>

        <label className={`pick-row ${mode === 'all' ? 'is-chosen' : ''}`}>
          <input type="radio" name="bulkmode" checked={mode === 'all'} onChange={() => setMode('all')} />
          <span>
            <strong>Select all {total.toLocaleString('en-IN')} leads across all pages</strong>
            <div className="tiny muted">Everything this filter matches, not just what is on screen.</div>
          </span>
        </label>

        <label className={`pick-row ${mode === 'first' ? 'is-chosen' : ''}`}>
          <input type="radio" name="bulkmode" checked={mode === 'first'} onChange={() => setMode('first')} />
          <span>
            <strong>Update a specific number</strong>
            <div className="tiny muted">The first this many of the result.</div>
          </span>
        </label>

        {mode === 'first' && (
          <div className="field" style={{ marginLeft: 30 }}>
            <input
              type="number"
              min="1"
              max={total}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder={`Up to ${total.toLocaleString('en-IN')}`}
              autoFocus
            />
            {overCount && (
              <p className="err-text">
                There {total === 1 ? 'is' : 'are'} only {total.toLocaleString('en-IN')} lead
                {total === 1 ? '' : 's'} in this result.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------- what to set */}
      <div className="field-row">
        <div className="field">
          <label>Field</label>
          <select
            value={field}
            onChange={(e) => { setField(e.target.value); setValue(''); }}
          >
            <option value="">Choose a field…</option>
            {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Value</label>
          {/* Disabled until a field is chosen. Until then there is no such thing
              as a valid value, so an enabled box could only collect a wrong one. */}
          {chosen?.free ? (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              list={`bulk-${chosen.key}`}
              placeholder="Type or pick"
            />
          ) : (
            <select value={value} onChange={(e) => setValue(e.target.value)} disabled={!chosen}>
              <option value="">{chosen ? 'Choose a value…' : 'Choose a field first'}</option>
              {(chosen?.values ?? []).map((v) => {
                const val = typeof v === 'object' ? v.value : v;
                const label = typeof v === 'object' ? v.label : v;
                return <option key={val} value={val}>{label}</option>;
              })}
            </select>
          )}
          {chosen?.free && (
            <datalist id={`bulk-${chosen.key}`}>
              {(chosen.values ?? []).map((v) => <option key={v} value={v} />)}
            </datalist>
          )}
        </div>
      </div>

      <p className="hint">
        Every change is recorded against the lead it touched. Leads already holding the
        value are left alone.
      </p>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!ready || busy} onClick={apply}>
          {busy ? <Spinner /> : <><Icon name="edit" size={15} /> Update</>}
        </button>
      </div>
    </Modal>
  );
}
