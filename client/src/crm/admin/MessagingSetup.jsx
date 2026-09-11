import { useState } from 'react';
import { api, dateTime, ROLE_LABEL } from '../../api.js';
import { useApi, Loading, Empty, Icon, ErrorBanner } from '../../components/ui.jsx';

/**
 * Messaging, for the people who govern it (P3-21).
 *
 * Two halves with two different owners. The grid — who may message whom — is
 * configuration and needs admin.roles. Reviewing conversations needs
 * comms.monitor, which Ritesh gave to admin and superadmin on 11 September.
 * Each half renders only for somebody who can use it, so a permission set
 * granting one without the other shows exactly that one.
 *
 * Opening a conversation here is written to the audit log under the reviewer's
 * name, and the screen says so before it happens rather than after.
 */

const REACH_LABEL = { blocked: 'Blocked', same_book: 'Same business', any_book: 'Both businesses' };

export function MessagingSetup() {
  const [grid, gridState] = useApi('/messages/policy');
  const [review, reviewState] = useApi('/messages/monitor');
  const [suspended, suspendedState] = useApi('/messages/suspensions');
  const [problem, setProblem] = useState(null);

  if (gridState.loading && reviewState.loading) return <Loading />;
  if (!grid && !review) return <ErrorBanner error={gridState.error || reviewState.error} />;

  const act = async (fn, after) => {
    setProblem(null);
    try { await fn(); after?.(); } catch (err) { setProblem(err.message); }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}

      <div>
        <h2>Messaging</h2>
        <p className="tiny muted">
          Who may message whom, and reviewing what was said. Everybody using messages sees a standing
          notice: “{review?.notice ?? 'Messages here can be reviewed by compliance.'}”
        </p>
      </div>

      {grid && (
        <PolicyGrid
          grid={grid}
          onSet={(from, to, reach) => act(
            () => api.put('/messages/policy', { from_role: from, to_role: to, reach }),
            gridState.reload,
          )}
        />
      )}

      {review && (
        <Review
          review={review}
          suspended={suspended ?? []}
          act={act}
          reload={() => { reviewState.reload(); suspendedState.reload(); }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- grid */

function PolicyGrid({ grid, onSet }) {
  const cell = new Map(grid.cells.map((c) => [`${c.from_role}|${c.to_role}`, c.reach]));
  const changed = grid.cells.length;

  return (
    <section className="card stack">
      <div className="row-between">
        <div>
          <h3>Who may message whom</h3>
          <p className="tiny muted">
            Rows send, columns receive. Every cell starts at “Same business”. A reply is a message
            too, so closing a cell closes conversations already under way as well as new ones.
          </p>
        </div>
        <span className="badge">{changed ? `${changed} changed` : 'All at the default'}</span>
      </div>

      <div className="table-scroll">
        <table className="table msg-grid">
          <thead>
            <tr>
              <th>Sender</th>
              {grid.roles.map((r) => <th key={r.code}>{r.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.roles.map((from) => (
              <tr key={from.code}>
                <th scope="row">{from.name}</th>
                {grid.roles.map((to) => {
                  const value = cell.get(`${from.code}|${to.code}`) ?? grid.default;
                  return (
                    <td key={to.code}>
                      <select
                        value={value}
                        className={value === grid.default ? '' : `reach-${value}`}
                        aria-label={`${from.name} to ${to.name}`}
                        onChange={(e) => onSet(from.code, to.code, e.target.value)}
                      >
                        {grid.reach.map((r) => <option key={r} value={r}>{REACH_LABEL[r] ?? r}</option>)}
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- review */

function Review({ review, suspended, act, reload }) {
  const [thread, setThread] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [reason, setReason] = useState('');
  const [suspending, setSuspending] = useState(null);

  const open = (id) => act(async () => {
    setOpenId(id);
    setThread(null);
    setThread(await api.get(`/messages/monitor/${id}`));
  });

  const refreshOpen = () => { reload(); if (openId) open(openId); };
  const isSuspended = new Set(suspended.map((s) => s.user_id));

  return (
    <section className="card stack">
      <div>
        <h3>Review</h3>
        <p className="tiny muted">
          Conversations with anybody in your businesses. Opening one is written to the audit log
          under your name.
        </p>
      </div>

      {review.conversations.length === 0 ? (
        <Empty>No conversations yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Between</th><th className="num">Messages</th><th>Last</th><th /></tr></thead>
            <tbody>
              {review.conversations.map((c) => (
                <tr key={c.id} aria-current={c.id === openId ? 'true' : undefined}>
                  <td>
                    {c.members.map((m) => m.name).join(' and ')}
                    {c.frozen_at && <span className="badge badge-amber" style={{ marginLeft: 6 }}>frozen</span>}
                    <div className="tiny muted">{[...new Set(c.members.map((m) => m.sales_org))].join(' · ')}</div>
                  </td>
                  <td className="num">{c.messages}</td>
                  <td className="tiny muted">{dateTime(c.last_message_at ?? c.created_at)}</td>
                  <td><button type="button" className="btn-sm" onClick={() => open(c.id)}>Read</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && !thread && <Loading />}
      {thread && (
        <div className="card stack msg-review">
          <div className="row-between">
            <strong>{thread.members.map((m) => m.name).join(' and ')}</strong>
            {thread.conversation.frozen_at ? (
              <button
                type="button"
                className="btn-sm"
                onClick={() => act(() => api.post(`/messages/conversations/${openId}/unfreeze`, {}), refreshOpen)}
              >
                Reopen
              </button>
            ) : null}
          </div>

          <div className="msg-thread" style={{ maxHeight: 360 }}>
            {thread.messages.map((m) => (m.kind === 'system' ? (
              <div key={m.id} className="msg-system">{m.body}</div>
            ) : (
              <div key={m.id} className={`msg-bubble ${m.withdrawn ? 'is-withdrawn' : ''}`}>
                {m.body}
                {m.lead && (
                  <span className={`msg-chip ${m.lead.hidden ? 'is-hidden' : ''}`}>
                    <Icon name={m.lead.hidden ? 'lock' : 'person'} size={13} />
                    {m.lead.hidden ? ' A lead outside your books' : ` ${m.lead.name}`}
                  </span>
                )}
                <div className="msg-meta">
                  <span>{m.sender_name}</span>
                  <span>{dateTime(m.created_at)}</span>
                  {m.withdrawn && <span>withdrawn by the sender</span>}
                  {m.transfer && <span>transfer request · {m.transfer.status}</span>}
                </div>
              </div>
            )))}
          </div>

          {!thread.conversation.frozen_at && (
            <div className="row wrap" style={{ gap: 6 }}>
              <input
                placeholder="Why it is being frozen — both people see this"
                aria-label="Reason for freezing"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ flex: 1, minWidth: 220 }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={!reason.trim()}
                onClick={() => act(
                  () => api.post(`/messages/conversations/${openId}/freeze`, { reason }),
                  () => { setReason(''); refreshOpen(); },
                )}
              >
                <Icon name="lock" size={15} /> Freeze
              </button>
            </div>
          )}

          <div className="row wrap" style={{ gap: 6 }}>
            {thread.members.filter((m) => !isSuspended.has(m.id)).map((m) => (
              <button key={m.id} type="button" className="btn-ghost btn-sm" onClick={() => setSuspending(m)}>
                <Icon name="block" size={15} /> Stop {m.name} sending
              </button>
            ))}
          </div>

          {suspending && (
            <SuspendForm
              person={suspending}
              onCancel={() => setSuspending(null)}
              onSubmit={(why) => act(
                () => api.post('/messages/suspensions', { user_id: suspending.id, reason: why }),
                () => { setSuspending(null); reload(); },
              )}
            />
          )}
        </div>
      )}

      <div>
        <h4 style={{ margin: '4px 0' }}>Stopped from sending</h4>
        {suspended.length === 0 ? (
          <p className="tiny muted">Nobody.</p>
        ) : (
          <ul className="ctx-list">
            {suspended.map((s) => (
              <li key={s.user_id}>
                <div>
                  <strong>{s.name}</strong>
                  <div className="tiny muted">
                    {ROLE_LABEL[s.role] || s.role} · {s.sales_org} · by {s.suspended_by_name ?? 'someone'} ·{' '}
                    {dateTime(s.suspended_at)}
                  </div>
                  <p className="tiny" style={{ margin: '2px 0 0' }}>{s.reason}</p>
                </div>
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() => act(() => api.del(`/messages/suspensions/${s.user_id}`), reload)}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SuspendForm({ person, onCancel, onSubmit }) {
  const [why, setWhy] = useState('');
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <input
        autoFocus
        placeholder={`Why ${person.name} is being stopped — they are told`}
        aria-label="Reason for stopping them sending"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        style={{ flex: 1, minWidth: 220 }}
      />
      <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn btn-danger btn-sm" disabled={!why.trim()} onClick={() => onSubmit(why)}>
        Stop sending
      </button>
    </div>
  );
}
