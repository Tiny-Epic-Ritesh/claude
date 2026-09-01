/**
 * Content libraries and their approval queue (P2-20 + P2-22).
 *
 * These were raised as two items and are one screen: `/content` is labelled
 * Marketing Hub, so "manage content libraries" and "edit and configuration in
 * the Marketing Hub" are the same place. Added as a second tab on that screen
 * rather than as a new one, for the reason Q-02 gave about API access and logs:
 * two screens over the same collateral means one of them drifts.
 *
 * WHAT THIS SCREEN IS FOR
 *
 * Not filing. A library carries the two things that decide whether a document
 * should still be in front of a client — who may use it, and when it stops
 * being true — and the approval queue is where somebody other than the author
 * says it may go out at all.
 *
 * The queue leads, because an item waiting for approval is somebody blocked.
 * Everything else here can wait a day; that cannot.
 */

import { useState } from 'react';
import { api, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal, Spinner } from '../components/ui.jsx';

const STATUS_TONE = {
  approved: 'badge-green', pending: 'badge-amber', rejected: 'badge-amber',
  draft: '', archived: '',
};

export default function Libraries() {
  const [data, { loading, error, reload }] = useApi('/libraries');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState(null);

  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const waiting = data.libraries.reduce((s, l) => s + l.awaiting, 0);

  return (
    <section className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between">
          <span><Icon name="check_circle" size={16} /> {notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {/* An item waiting for approval is somebody blocked. */}
      {waiting > 0 && (
        <div className="glass notice notice-warn">
          <Icon name="pending_actions" size={16} />
          <div>
            <strong>{waiting}</strong> item{waiting === 1 ? '' : 's'} waiting for approval.
            Nobody can send {waiting === 1 ? 'it' : 'them'} until somebody other than the author
            has looked.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Libraries</h2>
            <span className="tiny muted">
              Who may use a document, and when it stops being true.
            </span>
          </div>
          {data.may_manage && (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              <Icon name="add" size={15} /> New library
            </button>
          )}
        </div>

        {!data.libraries.length && <Empty>No libraries yet.</Empty>}

        {Boolean(data.libraries.length) && (
          <table>
            <thead>
              <tr>
                <th>Library</th><th>Owned by</th><th>Readable by</th>
                <th>Approval</th><th>Default expiry</th><th className="num">Items</th><th />
              </tr>
            </thead>
            <tbody>
              {data.libraries.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{l.name}</div>
                    {l.description && <div className="tiny muted">{l.description}</div>}
                  </td>
                  <td className="small">{l.owner_role}</td>
                  <td className="small">
                    {l.shared_with === null
                      ? <span className="muted">Every role</span>
                      : l.shared_with.length
                        ? l.shared_with.join(', ')
                        : <span className="muted">Owner only</span>}
                  </td>
                  <td className="small">
                    {l.requires_approval
                      ? <span className="badge badge-amber">Required</span>
                      : <span className="muted">Not needed</span>}
                  </td>
                  <td className="small">
                    {l.default_expiry_days
                      ? `${l.default_expiry_days} days`
                      /* Worth naming rather than showing a dash: "never" is a
                         decision somebody made, and an empty cell is not. */
                      : <span className="muted">Never</span>}
                  </td>
                  <td className="num">
                    {l.item_count}
                    {l.awaiting > 0 && <div className="tiny warn-text">{l.awaiting} waiting</div>}
                  </td>
                  <td className="num"><button className="btn-sm" onClick={() => setOpen(l.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {Boolean(data.unfiled.length) && (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Not in any library</h2>
              {/* Shown rather than hidden: content belonging to no library is
                  exactly what nobody reviews. */}
              <span className="tiny muted">
                Nothing governs these — no owner, no approval, no default expiry.
              </span>
            </div>
          </div>
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Expires</th></tr></thead>
            <tbody>
              {data.unfiled.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td className="small">{i.type}</td>
                  <td><span className={`badge ${STATUS_TONE[i.status] ?? ''}`}>{i.status}</span></td>
                  <td className="small">{i.expiry_date ? shortDate(i.expiry_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <LibraryView
          id={open}
          statuses={data.statuses}
          onBack={() => { setOpen(null); reload(); }}
          onError={setProblem}
          onNotice={setNotice}
        />
      )}

      {creating && (
        <NewLibrary
          roles={data.roles}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); }}
          onError={setProblem}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------- one library */

function LibraryView({ id, onBack, onError, onNotice }) {
  const [data, { loading, error, reload }] = useApi(`/libraries/${id}`);
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState(null);

  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const move = async (item, status, reason = null) => {
    try {
      await api.post(`/libraries/items/${item.id}/status`, { status, reason });
      onNotice(`${item.name} is now ${status}.`);
      reload();
    } catch (err) { onError(err.message); }
  };

  const l = data.library;

  return (
    <Modal title={l.name} subtitle={`Owned by ${l.owner_role}`} onClose={onBack} wide>
      <div className="stack" style={{ gap: 13 }}>
        <dl className="setup-facts">
          <div><dt>Approval</dt><dd>{l.requires_approval ? 'Required before sending' : 'Not required'}</dd></div>
          <div><dt>Default expiry</dt><dd>{l.default_expiry_days ? `${l.default_expiry_days} days` : 'Never'}</dd></div>
          <div><dt>Readable by</dt><dd>{l.shared_with === null ? 'Every role' : (l.shared_with.join(', ') || 'Owner only')}</dd></div>
        </dl>

        {data.may_manage && (
          <div className="row-between">
            <span className="tiny muted">{data.items.length} items</span>
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <Icon name="add" size={15} /> Add
            </button>
          </div>
        )}

        {!data.items.length && <Empty>Nothing in this library yet.</Empty>}

        {Boolean(data.items.length) && (
          <table>
            <thead><tr><th>Item</th><th>Status</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div style={{ fontWeight: 545 }}>{i.name}</div>
                    <div className="tiny muted">{i.type} · v{i.version} · sent {i.send_count}×</div>
                    {i.rejected_reason && <div className="tiny warn-text">Sent back: {i.rejected_reason}</div>}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_TONE[i.status] ?? ''}`}>{i.status}</span>
                    {i.approved_by_name && <div className="tiny muted">by {i.approved_by_name}</div>}
                  </td>
                  <td className="small">
                    {i.expired
                      ? <span className="warn-text">Expired {shortDate(i.expiry_date)}</span>
                      : i.expiring_soon
                        ? <span className="warn-text">{shortDate(i.expiry_date)}</span>
                        : (i.expiry_date ? shortDate(i.expiry_date) : <span className="muted">Never</span>)}
                  </td>
                  <td className="num">
                    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      {data.may_manage && (i.status === 'draft' || i.status === 'rejected') && (
                        <button className="btn-sm" onClick={() => move(i, 'pending')}>Send for approval</button>
                      )}
                      {i.status === 'pending' && (
                        <>
                          <button className="btn-sm" onClick={() => move(i, 'approved')}>Approve</button>
                          <button className="btn-ghost btn-sm" onClick={() => setRejecting(i)}>Send back</button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {adding && (
          <AddItem
            libraryId={id}
            library={l}
            onClose={() => setAdding(false)}
            onAdded={() => { setAdding(false); reload(); }}
            onError={onError}
          />
        )}

        {rejecting && (
          <RejectItem
            item={rejecting}
            onClose={() => setRejecting(null)}
            onSent={(reason) => { setRejecting(null); move(rejecting, 'rejected', reason); }}
          />
        )}
      </div>
    </Modal>
  );
}

function RejectItem({ item, onClose, onSent }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Send back ${item.name}`} onClose={onClose}>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>What needs changing</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="The brokerage figures are last year's" maxLength={200} />
          {/* Required by the server too. An unexplained refusal is one the
              author cannot act on, so it comes back again unchanged. */}
          <span className="tiny muted">The person who wrote it cannot fix an unexplained refusal.</span>
        </label>
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!reason.trim()} onClick={() => onSent(reason)}>
            Send back
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddItem({ libraryId, library, onClose, onAdded, onError }) {
  const [form, setForm] = useState({ name: '', type: 'PDF', url: '', expiry_date: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const add = async () => {
    setBusy(true);
    try { await api.post(`/libraries/${libraryId}/items`, form); onAdded(); }
    catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="Add to this library" onClose={onClose}>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />
        </label>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <label>
            <span>Type</span>
            <select value={form.type} onChange={(e) => set('type', e.target.value)}>
              {['PDF', 'Video', 'Link', 'PPT'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>
            <span>Expires</span>
            <input type="date" value={form.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} />
            <span className="tiny muted">
              {library.default_expiry_days
                ? `Left empty, it takes the library's ${library.default_expiry_days} days.`
                : 'This library sets no default, so empty means never.'}
            </span>
          </label>
        </div>
        <label>
          <span>Where it lives</span>
          <input value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…" />
        </label>

        <p className="tiny muted" style={{ margin: 0 }}>
          {library.requires_approval
            ? 'This library requires approval, so it starts as a draft and cannot be sent until somebody else approves it.'
            : 'This library does not require approval, so it can be sent as soon as it is added.'}
        </p>

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={add}>
            {busy ? <Spinner /> : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewLibrary({ roles, onClose, onCreated, onError }) {
  const [form, setForm] = useState({
    name: '', description: '', owner_role: '', shared_with: null,
    requires_approval: false, default_expiry_days: '',
  });
  const [busy, setBusy] = useState(false);
  const [restrict, setRestrict] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const create = async () => {
    setBusy(true);
    try {
      await api.post('/libraries', {
        ...form,
        shared_with: restrict ? (form.shared_with ?? []) : null,
        default_expiry_days: form.default_expiry_days || null,
      });
      onCreated();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="New library" onClose={onClose}>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={80}
            placeholder="Client collateral" />
        </label>
        <label>
          <span>What it holds</span>
          <input value={form.description} onChange={(e) => set('description', e.target.value)} />
        </label>
        <label>
          <span>Owned by</span>
          <select value={form.owner_role} onChange={(e) => set('owner_role', e.target.value)}>
            <option value="">Choose a role…</option>
            {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
          <span className="tiny muted">That role decides what goes in it and what comes out.</span>
        </label>

        <label className="check-one">
          <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
          <span>Restrict who can read it<em className="tiny muted"> — otherwise every role can</em></span>
        </label>

        {restrict && (
          <label>
            <span>Readable by</span>
            <select multiple size={6} value={form.shared_with ?? []}
              onChange={(e) => set('shared_with', [...e.target.selectedOptions].map((o) => o.value))}>
              {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
          </label>
        )}

        <label className="check-one">
          <input type="checkbox" checked={form.requires_approval}
            onChange={(e) => set('requires_approval', e.target.checked)} />
          <span>
            Require approval before anything here can be sent
            {/* Per library, not global — forcing it on an internal battlecard
                is how approval becomes a rubber stamp. */}
            <em className="tiny muted"> — for anything a regulator or a client sees</em>
          </span>
        </label>

        <label>
          <span>Default expiry</span>
          <input type="number" min="1" max="3650" value={form.default_expiry_days}
            onChange={(e) => set('default_expiry_days', e.target.value)} placeholder="365" />
          <span className="tiny muted">
            Days, applied when nobody sets one. The failure this prevents is not a bad
            expiry — it is nobody choosing at all, and a library full of documents
            nobody has checked in four years.
          </span>
        </label>

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"
            disabled={busy || !form.name.trim() || !form.owner_role} onClick={create}>
            {busy ? <Spinner /> : 'Create library'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
