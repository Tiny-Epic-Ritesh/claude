/**
 * Choose the columns, then download the file.
 *
 * The third screen to need this — users, leads, and whatever comes next — so it
 * stopped being a detail of one screen and became a component. The shape is the
 * same every time: the server owns the column list and the defaults, the person
 * ticks what they want, and the file is named for what it holds.
 *
 * The server owning the list is the part that matters. A picker built from a
 * list written in the client offers columns the export may have stopped
 * supporting, and drops ones it has gained, and nobody finds out until they open
 * the file looking for something that is not there.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Modal, Spinner, ErrorBanner, Icon } from './ui.jsx';

/**
 * @param title     what the dialog is called
 * @param subtitle  a line under it, usually the scope or the count
 * @param columnsFrom  endpoint returning { columns: [{key,label}], default: [key] }
 * @param download  (columnKeys) => Promise<Blob>
 * @param filename  what the saved file is called
 * @param note      an optional line above the buttons, e.g. about masking
 */
export default function ExportDialog({
  title, subtitle, columnsFrom, download, filename, note, onClose,
}) {
  const [meta] = useApi(columnsFrom);
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /* Null until the defaults arrive, so the first paint is not an empty
     selection that fills in a moment later and reads as a glitch. */
  const columns = meta?.columns ?? [];
  const picked = chosen ?? new Set(meta?.default ?? []);

  const toggle = (key) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key); else next.add(key);
    setChosen(next);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      /* In the column list's order, not the order they were ticked. Somebody
         who ticks Email last still expects it where the list says it goes. */
      const keys = columns.filter((c) => picked.has(c.key)).map((c) => c.key);
      const blob = await download(keys);

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
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
    <Modal title={title} subtitle={subtitle} onClose={onClose} wide>
      <ErrorBanner error={error} />

      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="tiny muted">{picked.size} of {columns.length} fields</span>
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
            <input type="checkbox" checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>

      {(note || meta?.note) && <p className="hint">{note ?? meta.note}</p>}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || picked.size === 0} onClick={run}>
          {busy ? <Spinner /> : <><Icon name="download" size={15} /> Download CSV</>}
        </button>
      </div>
    </Modal>
  );
}
