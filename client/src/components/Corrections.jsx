/**
 * Correct by adding (QA-37).
 *
 * A note, an activity or a case reply is never edited once saved. Its author
 * adds a correction linked to it, and the original stays where it was, marked
 * as corrected, with what it should have said underneath. Every screen that
 * shows one of those entries uses these two pieces, so a correction reads the
 * same wherever it turns up.
 */

import { useState } from 'react';
import { api, dateTime } from '../api.js';
import { Icon, Modal, ErrorBanner } from './ui.jsx';

/** What an entry should have said, under the entry itself. */
export function CorrectionList({ corrections }) {
  if (!corrections?.length) return null;
  return (
    <div className="stack" style={{ gap: 6, marginTop: 6 }}>
      {corrections.map((c) => (
        <div key={c.id} className="notice notice-warn" style={{ padding: '6px 10px' }}>
          <Icon name="edit_note" size={16} />
          <div style={{ minWidth: 0 }}>
            <div className="tiny muted">
              Corrected {dateTime(c.created_at)}{c.user_name ? ` by ${c.user_name}` : ''}
              {c.reason ? ` — ${c.reason}` : ''}
            </div>
            {c.body == null
              ? <div className="small muted">The correction is hidden from you, as the original is.</div>
              : <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Whether to dim an entry because something later says it was wrong. */
export const correctedStyle = (entry) => (entry?.corrections?.length ? { opacity: 0.62 } : undefined);

/**
 * The Correct button and its form, for the entry's author only.
 *
 * `path` is the entry's correct route. The form starts from the original text,
 * because a correction is usually the same words with one thing changed.
 */
export function CorrectButton({ entry, session, path, onDone }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!entry?.user_id || entry.user_id !== session?.id) return null;

  const start = () => {
    const latest = entry.corrections?.length ? entry.corrections.at(-1).body : entry.body;
    setBody(latest ?? '');
    setReason('');
    setError(null);
    setOpen(true);
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(path, { body, reason });
      setOpen(false);
      onDone?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className="btn-ghost btn-sm" onClick={start}>Correct</button>
      {open && (
        <Modal title="Correct this entry" onClose={() => setOpen(false)}>
          <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
            <ErrorBanner error={error} />
            <p className="small muted">
              Saved entries are not edited. The original stays, marked as corrected, with this underneath it.
            </p>
            <div className="field">
              <label htmlFor="correction-body">What it should say</label>
              <textarea id="correction-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label htmlFor="correction-reason">What was wrong</label>
              <input id="correction-reason" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="Wrong callback date" />
            </div>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <button className="btn-primary" disabled={busy || !body.trim() || reason.trim().length < 5}>
                {busy ? 'Saving…' : 'Add correction'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
