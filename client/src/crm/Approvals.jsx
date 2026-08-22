/**
 * Approvals — what is waiting on me, and what I am waiting on.
 *
 * Two lists, kept apart on purpose. "What needs my decision?" and "what have I
 * asked for?" are different questions with different urgency, and merging them
 * makes both harder to answer at a glance.
 *
 * Every request shows why its scope needs approving at all. An approver who
 * does not know what they are protecting approves everything.
 */

import { useState } from 'react';
import { api, dateTime } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Icon } from '../components/ui.jsx';

const TONE = { Pending: '', Approved: 'badge-green', Rejected: 'badge-red', Withdrawn: 'badge-amber' };

export default function Approvals() {
  const [data, { loading, reload }] = useApi('/approvals');
  const [deciding, setDeciding] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  if (loading || !data) return <Loading />;

  const withdraw = async (id) => {
    setError(null);
    try {
      await api.post(`/approvals/${id}/withdraw`);
      setNotice('Withdrawn.');
      reload();
    } catch (err) { setError(err.message); }
  };

  const pending = data.my_requests.filter((r) => r.status === 'Pending').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>
            Money and access move through here. Nothing is applied until somebody
            other than the requester decides it.
          </p>
        </div>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between" style={{ marginBottom: 'var(--gap)' }}>
          <span>{notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <section className="card section-card">
        <div className="section-head">
          <div>
            <h2>Waiting on you</h2>
            <p>{data.waiting_on_me.length} to decide</p>
          </div>
        </div>

        {data.waiting_on_me.length === 0 ? (
          <Empty>Nothing needs your decision.</Empty>
        ) : (
          <ul className="ctx-list">
            {data.waiting_on_me.map((r) => (
              <li key={r.id}>
                <span className="state-pill state-warm">{r.label}</span>
                <div>
                  <strong>{r.summary}</strong>
                  <div className="tiny muted">{r.requested_by_name} · {dateTime(r.created_at)}</div>
                  <p className="tiny" style={{ margin: '4px 0 0' }}>{r.reason}</p>
                  {r.why && <p className="tiny muted" style={{ margin: '2px 0 0' }}>{r.why}</p>}
                </div>
                {r.can_decide && (
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setDeciding({ ...r, approve: false })}>
                      Reject
                    </button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setDeciding({ ...r, approve: true })}>
                      Approve
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card section-card">
        <div className="section-head">
          <div>
            <h2>Your requests</h2>
            <p>{pending} still pending</p>
          </div>
        </div>

        {data.my_requests.length === 0 ? (
          <Empty>You have not asked for anything.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>What</th><th>Why</th><th>Status</th><th>Decided by</th><th /></tr>
              </thead>
              <tbody>
                {data.my_requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.summary}</strong>
                      <div className="tiny muted">{dateTime(r.created_at)}</div>
                    </td>
                    <td className="small muted">{r.reason}</td>
                    <td><span className={`badge ${TONE[r.status] ?? ''}`}>{r.status}</span></td>
                    <td className="small muted">
                      {r.decided_by_name || '—'}
                      {r.decision_reason && <div className="tiny">{r.decision_reason}</div>}
                    </td>
                    <td>
                      {r.status === 'Pending' && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => withdraw(r.id)}>
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deciding && (
        <DecideModal
          request={deciding}
          onClose={() => setDeciding(null)}
          onDone={(msg) => { setDeciding(null); setNotice(msg); reload(); }}
        />
      )}
    </>
  );
}

function DecideModal({ request: r, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/approvals/${r.id}/decide`, { approve: r.approve, reason });
      onDone(r.approve ? 'Approved, and the change has been applied.' : 'Rejected.');
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title={r.approve ? 'Approve this' : 'Reject this'} subtitle={r.summary} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <div className="glass notice span-2">
          <Icon name={r.approve ? 'verified' : 'block'} />
          <div className="tiny">
            <strong>{r.requested_by_name}</strong> asked: {r.reason}
            {r.why && <div className="muted" style={{ marginTop: 3 }}>{r.why}</div>}
          </div>
        </div>

        <label className="span-2">
          <span>{r.approve ? 'Note (optional)' : 'Why are you rejecting it?'}</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required={!r.approve}
            placeholder={r.approve
              ? 'Checked against the signed agreement'
              : 'What needs to change before this can go ahead'}
          />
          {!r.approve && (
            <small className="muted">The requester sees this, so it has to tell them what to fix.</small>
          )}
        </label>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className={r.approve ? 'btn btn-primary' : 'btn btn-danger'}
            disabled={busy || (!r.approve && !reason.trim())}
          >
            {busy ? <Spinner /> : r.approve ? 'Approve and apply' : 'Reject'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
