/**
 * Export the user list, and decide which fields go in it (P3-02).
 *
 * Two controls that belong together and are shown together, because they answer
 * the same administrator's question. "Export users" is the one Ritesh asked for;
 * "Required fields" is the control he asked for alongside it, so that whether a
 * mobile number is mandatory can change without a release.
 *
 * The columns are fetched rather than listed here. The server owns that list --
 * the same one the export itself filters against - so a column can never be
 * offered in the picker and then silently dropped from the file.
 */

import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, Modal, Spinner, ErrorBanner, Icon } from '../../components/ui.jsx';

/* ------------------------------------------------------------------ export */

export function ExportUsers({ onClose }) {
  const [meta] = useApi('/setup/users/export-columns');
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /* Null until the defaults arrive, so the first paint does not show an empty
     selection that then fills in and looks like a glitch. */
  const picked = chosen ?? new Set(meta?.default ?? []);
  const columns = meta?.columns ?? [];

  const toggle = (key) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key); else next.add(key);
    setChosen(next);
  };

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const order = columns.filter((c) => picked.has(c.key)).map((c) => c.key);
      const blob = await api.blob(`/setup/users/export?columns=${order.join(',')}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export users"
      subtitle="Choose what the file contains"
      onClose={onClose}
      wide
    >
      <ErrorBanner error={error} />

      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="tiny muted">
          {picked.size} of {columns.length} fields
        </span>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn-sm" onClick={() => setChosen(new Set(columns.map((c) => c.key)))}>
            Select all
          </button>
          <button type="button" className="btn-sm" onClick={() => setChosen(new Set(meta?.default ?? []))}>
            Reset
          </button>
        </div>
      </div>

      <div className="pick-grid">
        {columns.map((c) => (
          <label key={c.key} className="pick-row">
            <input
              type="checkbox"
              checked={picked.has(c.key)}
              onChange={() => toggle(c.key)}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>

      <p className="hint">
        The export is scoped to the businesses you can see, and is recorded in the audit log.
      </p>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || picked.size === 0}
          onClick={download}
        >
          {busy ? <Spinner /> : <><Icon name="download" size={15} /> Download CSV</>}
        </button>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- required fields */

/**
 * Which user fields must be filled in.
 *
 * Ritesh, 4 Sep: mobile stays optional, "but provide the control to make it
 * mandatory or non mandatory if business decides in future to change it".
 *
 * The four structural ones are shown but cannot be switched off — a user with
 * no email cannot sign in and one with no business cannot be placed in a book,
 * so offering the toggle would be offering something the server refuses.
 */
export function RequiredFields({ onClose }) {
  const [data, { reload }] = useApi('/setup/users/required-fields');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const set = async (field, required) => {
    setBusy(field);
    setError(null);
    try {
      await api.post('/setup/users/required-fields', { field, required });
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Required fields" subtitle="What must be filled in to save a user" onClose={onClose}>
      <ErrorBanner error={error} />

      <div className="stack" style={{ gap: 2 }}>
        {(data?.fields ?? []).map((f) => (
          <label key={f.field} className={`pick-row ${f.always ? 'is-locked' : ''}`}>
            <input
              type="checkbox"
              checked={f.required}
              disabled={f.always || busy === f.field}
              onChange={() => set(f.field, !f.required)}
            />
            <span>{f.label}</span>
            {f.always && <span className="tiny muted">always</span>}
          </label>
        ))}
      </div>

      {data?.note && <p className="hint">{data.note}</p>}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
