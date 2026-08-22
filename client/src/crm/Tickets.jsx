import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, dateTime, shortDate } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Spinner, PriorityBadge, Tabs } from '../components/ui.jsx';

const STATUSES = ['Open', 'Pending', 'Waiting on Client', 'Resolved', 'Closed'];

export default function Tickets({ session }) {
  const { id } = useParams();
  return id ? <TicketDetail id={id} session={session} /> : <TicketQueue session={session} />;
}

/* ---------------------------------------------------------------- queue */

function TicketQueue({ session }) {
  const [filter, setFilter] = useState(session.role === 'customer_care' ? 'mine' : 'open');
  const query = { mine: '?mine=true&open=true', open: '?open=true', breached: '?breached=true', all: '' }[filter];
  const [tickets, { loading, error, reload }] = useApi(`/tickets${query}`);
  const [report] = useApi(session.permissions.includes('report.team') ? '/tickets/reports/summary' : null);
  const navigate = useNavigate();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tickets</h1>
          <p>SLA timers count business hours only and pause while a ticket is waiting on the client.</p>
        </div>
        <button onClick={async () => { await api.post('/tickets/sweep'); reload(); }}>Run SLA sweep</button>
      </div>

      {report && (
        <div className="metrics">
          <div className="card stat"><div className="stat-label">Open</div><div className="stat-value">{report.totals.open}</div></div>
          <div className="card stat tone-danger"><div className="stat-label">Breached</div><div className="stat-value">{report.totals.breached}</div></div>
          <div className="card stat tone-good"><div className="stat-label">Resolved today</div><div className="stat-value">{report.totals.resolved_today}</div></div>
          <div className="card stat"><div className="stat-label">Avg CSAT</div><div className="stat-value">{report.totals.avg_csat ?? '—'}</div></div>
        </div>
      )}

      <Tabs
        tabs={[{ key: 'mine', label: 'Assigned to me' }, { key: 'open', label: 'All open' }, { key: 'breached', label: 'Breached' }, { key: 'all', label: 'Everything' }]}
        active={filter}
        onChange={setFilter}
      />

      <ErrorBanner error={error} />

      <section className="card">
        {loading ? <Loading /> : !tickets?.length ? <Empty>No tickets here.</Empty> : (
          <table>
            <thead><tr><th>Ref</th><th>Subject & AI summary</th><th>Linked to</th><th>Priority</th><th>Status</th><th className="num">SLA</th></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} className="row-link" onClick={() => navigate(`/tickets/${t.id}`)}>
                  <td>
                    <div style={{ fontWeight: 620 }}>{t.ref}</div>
                    <div className="tiny muted">{t.channel} · {shortDate(t.created_at)}</div>
                  </td>
                  <td style={{ maxWidth: 460 }}>
                    <div style={{ fontWeight: 545 }}>{t.subject}</div>
                    <div className="tiny muted" style={{ whiteSpace: 'pre-wrap' }}>{t.ai_summary}</div>
                  </td>
                  <td className="small">
                    {t.lead_name || t.partner_name || <span className="muted">—</span>}
                    {t.product_name && <div className="tiny muted">{t.product_name}</div>}
                  </td>
                  <td><PriorityBadge priority={t.priority} /></td>
                  <td><span className={`badge ${t.status === 'Resolved' ? 'badge-green' : ''}`}>{t.status}</span></td>
                  <td className="num">
                    {t.breached ? <span className="badge badge-red">Breached</span>
                      : t.sla_remaining_mins != null ? <span className="badge">{Math.max(0, Math.round(t.sla_remaining_mins / 60))}h</span>
                        : <span className="tiny muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {report && (
        <div className="grid grid-2" style={{ marginTop: 14 }}>
          <section className="card">
            <div className="card-head"><h2>By category</h2></div>
            <table>
              <thead><tr><th>Category</th><th className="num">Tickets</th><th className="num">Breached</th><th className="num">Avg hours</th></tr></thead>
              <tbody>
                {report.by_category.map((c) => (
                  <tr key={c.category}>
                    <td>{c.category}</td><td className="num">{c.n}</td>
                    <td className="num">{c.breached}</td>
                    <td className="num">{c.avg_hours ? c.avg_hours.toFixed(1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card">
            <div className="card-head"><h2>By agent</h2></div>
            <table>
              <thead><tr><th>Agent</th><th className="num">Total</th><th className="num">Open</th><th className="num">Breached</th><th className="num">CSAT</th></tr></thead>
              <tbody>
                {report.by_agent.map((a) => (
                  <tr key={a.agent}>
                    <td>{a.agent}</td><td className="num">{a.n}</td><td className="num">{a.open}</td>
                    <td className="num">{a.breached}</td><td className="num">{a.avg_csat ? a.avg_csat.toFixed(1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------- detail */

function TicketDetail({ id, session }) {
  const [ticket, { loading, error, reload }] = useApi(`/tickets/${id}`);
  const [meta] = useApi('/meta');
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const can = (p) => session.permissions.includes(p);

  async function act(fn) {
    setBusy(true);
    setActionError(null);
    try { await fn(); reload(); }
    catch (err) { setActionError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/tickets" className="small muted">← Tickets</Link>
          <h1 style={{ marginTop: 5 }}>{ticket.ref} · {ticket.subject}</h1>
          <div className="row wrap small muted" style={{ marginTop: 5 }}>
            <PriorityBadge priority={ticket.priority} />
            <span className={`badge ${ticket.breached ? 'badge-red' : ''}`}>{ticket.status}</span>
            <span>· {ticket.category_name || 'Uncategorised'}</span>
            <span>· via {ticket.channel}</span>
            {ticket.lead_name && <span>· <Link to={`/leads/${ticket.lead_id}`} style={{ color: 'var(--brand)' }}>{ticket.lead_name}</Link></span>}
            {ticket.partner_name && <span>· partner: {ticket.partner_name}</span>}
            {ticket.product_name && <span className="badge badge-blue">{ticket.product_name}</span>}
          </div>
        </div>
        <div className="row wrap">
          {can('ticket.escalate') && <button onClick={() => act(() => api.post(`/tickets/${id}/escalate`, { reason: 'Escalated from ticket view' }))} disabled={busy}>Escalate</button>}
          {can('ticket.reply') && ticket.status !== 'Resolved' && (
            <button className="btn-primary" onClick={() => act(() => api.patch(`/tickets/${id}`, { status: 'Resolved' }))} disabled={busy}>Mark resolved</button>
          )}
        </div>
      </div>

      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />

      {ticket.ai_summary && (
        <section className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent)' }}>
          <div className="card-body">
            <div className="tiny muted" style={{ fontWeight: 640, textTransform: 'uppercase', letterSpacing: '.05em' }}>AI summary</div>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{ticket.ai_summary}</div>
          </div>
        </section>
      )}

      <div className="metrics">
        <div className="card stat"><div className="stat-label">Response due</div><div className="stat-value" style={{ fontSize: 15 }}>{dateTime(ticket.response_due)}</div></div>
        <div className={`card stat ${ticket.breached ? 'tone-danger' : ''}`}><div className="stat-label">Resolution due</div><div className="stat-value" style={{ fontSize: 15 }}>{dateTime(ticket.resolution_due)}</div></div>
        <div className="card stat"><div className="stat-label">SLA remaining</div><div className="stat-value" style={{ fontSize: 15 }}>{ticket.breached ? 'Breached' : ticket.sla_remaining_mins != null ? `${Math.round(ticket.sla_remaining_mins / 60)}h` : '—'}</div></div>
        <div className="card stat"><div className="stat-label">Assignee</div><div className="stat-value" style={{ fontSize: 15 }}>{ticket.assignee_name || 'Unassigned'}</div></div>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>Conversation</h2><span className="tiny muted">{ticket.replies.length} messages</span></div>
          <div className="card-body stack">
            <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 12 }}>
              <div className="tiny muted">Original · {dateTime(ticket.created_at)}</div>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{ticket.description}</div>
            </div>
            {ticket.replies.map((r) => (
              <div key={r.id} style={{ borderLeft: `2px solid ${r.internal ? 'var(--accent)' : r.author_type === 'client' ? 'var(--brand)' : 'var(--border)'}`, paddingLeft: 12 }}>
                <div className="tiny muted">
                  {r.user_name || r.author_type} · {dateTime(r.created_at)}
                  {r.internal ? <span className="badge badge-accent" style={{ marginLeft: 6 }}>Internal</span> : null}
                </div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.body}</div>
              </div>
            ))}

            {can('ticket.reply') && (
              <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) act(async () => { await api.post(`/tickets/${id}/replies`, { body: reply, internal }); setReply(''); }); }}>
                <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" />
                <div className="row-between" style={{ marginTop: 8 }}>
                  <label className="row small" style={{ marginBottom: 0 }}>
                    <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} style={{ width: 15, height: 15 }} />
                    Internal note
                  </label>
                  <button className="btn-primary" disabled={busy || !reply.trim()}>{busy ? <Spinner /> : 'Send reply'}</button>
                </div>
              </form>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Manage</h2></div>
          <div className="card-body">
            <div className="field">
              <label>Status</label>
              <select value={ticket.status} onChange={(e) => act(() => api.patch(`/tickets/${id}`, { status: e.target.value }))} disabled={busy}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
              <div className="hint">Moving to “Waiting on Client” pauses the SLA clock.</div>
            </div>
            <div className="field">
              <label>Priority</label>
              <select value={ticket.priority} onChange={(e) => act(() => api.patch(`/tickets/${id}`, { priority: e.target.value }))} disabled={busy}>
                {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            {can('ticket.reassign') && (
              <div className="field">
                <label>Assignee</label>
                <select value={ticket.assignee_id || ''} onChange={(e) => act(() => api.patch(`/tickets/${id}`, { assignee_id: Number(e.target.value) }))} disabled={busy}>
                  <option value="">Unassigned</option>
                  {(meta?.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            )}
            {ticket.csat && <div className="notice">CSAT received: {ticket.csat}/5</div>}
            {ticket.merged?.length > 0 && (
              <div className="notice">{ticket.merged.length} ticket(s) merged into this one: {ticket.merged.map((m) => m.ref).join(', ')}</div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
