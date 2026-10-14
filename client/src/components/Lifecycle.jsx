/**
 * Archive or delete a configured thing (QA-37).
 *
 * Archiving asks why, because it takes the thing out of use. Deleting asks
 * for its name, because it cannot be undone -- and the server refuses it for
 * anything that has run, which is kept as the record of what it did; the
 * refusal says to archive instead, and this offers it in place.
 *
 * `what` is 'archiving' or 'deleting'. `confirmLabel` asks for the name in
 * the screen's own words.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { Modal, ErrorBanner } from './ui.jsx';

export function ArchiveOrDelete({ confirmLabel, name, what, archivePath, deletePath, archiveNote, deleteNote, onSwitch, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [archiveInstead, setArchiveInstead] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (what === 'archiving') {
        await api.post(archivePath, { reason });
        onDone(`"${name}" is archived. It is kept, read-only, and can be restored.`);
      } else {
        await api.del(deletePath, { confirm_name: typed });
        onDone(`Deleted "${name}".`);
      }
    } catch (err) {
      setError(err.message);
      setArchiveInstead(Boolean(err.payload?.archive_instead));
      setBusy(false);
    }
  }

  const ready = what === 'archiving' ? reason.trim().length >= 5 : typed === name;

  return (
    <Modal title={what === 'archiving' ? `Archive "${name}"` : `Delete "${name}"`} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <ErrorBanner error={error} />
        {archiveInstead && onSwitch && (
          <button type="button" className="btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => { setError(null); setArchiveInstead(false); onSwitch('archiving'); }}>
            Archive it instead
          </button>
        )}
        {what === 'archiving' ? (
          <>
            <p className="small">{archiveNote}</p>
            <div className="field">
              <label htmlFor="archive-reason">Why</label>
              <input id="archive-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </div>
          </>
        ) : (
          <>
            <p className="small">{deleteNote}</p>
            <div className="field">
              <label htmlFor="delete-name">{confirmLabel}</label>
              <input id="delete-name" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} autoFocus />
            </div>
          </>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={what === 'deleting' ? 'btn-danger' : 'btn-primary'} disabled={busy || !ready}>
            {busy ? 'Working…' : what === 'archiving' ? 'Archive' : 'Delete for good'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
