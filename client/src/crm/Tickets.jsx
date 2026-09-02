import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, dateTime, shortDate } from '../api.js';
import {
  useApi, Icon, Loading, ErrorBanner, Empty, Spinner, PriorityBadge, Tabs, Modal,
} from '../components/ui.jsx';

const STATUSES = ['Open', 'Pending', 'Waiting on Client', 'Resolved', 'Closed'];

/* Rows per page. The queue used to ask for whatever the server would give and
   render all of it — three hundred, silently, with no count and nothing saying
   there were more. */
const PAGE = 50;

/** Hand the browser a file without a round trip to the server for it. */
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Tickets({ session }) {
  const { id } = useParams();
  return id ? <TicketDetail id={id} session={session} /> : <TicketQueue session={session} />;
}

/**
 * A sortable column header.
 *
 * Declared here rather than inside the queue on purpose: a component defined in
 * a render body is a new type on every render, so React tears down the whole
 * header row and builds it again — on every keystroke of the search box, and
 * between one click of a header and the next.
 */
function Th({ label, col, className, sort, dir, onSort }) {
  if (!col) return <th className={className}>{label}</th>;
  return (
    <th className={className} aria-sort={sort === col ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" aria-label={`Sort by ${label}`} onClick={() => onSort(col)}>
        {label}
        <Icon name={sort !== col ? 'unfold_more' : dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={13} />
      </button>
    </th>
  );
}

/* ---------------------------------------------------------------- queue */

function TicketQueue({ session }) {
  const [filter, setFilter] = useState(session.role === 'customer_care' ? 'mine' : 'open');
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);

  // A request per keystroke against a desk with thousands of cases.
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  // Changing tab is a different question; page 4 of the old one means nothing.
  useEffect(() => { setOffset(0); }, [filter]);

  const base = { mine: { mine: 'true', open: 'true' }, open: { open: 'true' }, breached: { breached: 'true' }, all: {} }[filter];
  const params = new URLSearchParams({ ...base, limit: String(PAGE), offset: String(offset) });
  if (sort) { params.set('sort', sort); params.set('dir', dir); }
  if (q) params.set('q', q);
  const query = `?${params}`;

  const [tickets, { loading, error, reload, total }] = useApi(`/tickets${query}`, [query]);
  const [report] = useApi(session.permissions.includes('report.team') ? '/tickets/reports/summary' : null);
  const [meta] = useApi('/tickets/meta');
  const navigate = useNavigate();

  const count = total ?? tickets?.length ?? 0;
  const orderBy = (key) => {
    setDir(sort === key && dir === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setOffset(0);
  };



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

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'center' }}>
          {/* The queue had no way to find one case except paging to it. */}
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search ref, subject or who it is for"
            aria-label="Search this queue"
            style={{ flex: '1 1 260px' }}
          />
          <span className="tiny muted">
            {q ? `${count} matching` : `${count} case${count === 1 ? '' : 's'}`}
          </span>
          <span style={{ flex: 1 }} />
          {sort && (
            <button className="btn-ghost btn-sm" onClick={() => { setSort(null); setOffset(0); }}>
              <Icon name="close" size={14} /> Back to queue order
            </button>
          )}
          {meta?.may_export && (
            <button className="btn-ghost btn-sm" onClick={() => setExporting(true)}>
              <Icon name="download" size={15} /> Export
            </button>
          )}
        </div>
      </div>

      <ErrorBanner error={error} />

      <section className="card">
        {loading ? <Loading /> : !tickets?.length ? (
          <Empty>{q ? `No case matches "${q}".` : 'No tickets here.'}</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <Th label="Ref" col="ref" sort={sort} dir={dir} onSort={orderBy} />
                {/* A subject is a paragraph and the SLA is computed per row
                    after the query, so neither is something to order by. */}
                <Th label="Subject & AI summary" />
                <Th label="Linked to" col="lead_name" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="Priority" col="priority" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="Status" col="status" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="SLA" className="num" />
              </tr>
            </thead>
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

        {/* Where you are in the queue. Three hundred cases rendered as though
            they were all of them is how a desk loses track of its backlog. */}
        {!loading && count > 0 && (count > PAGE || offset > 0) && (
          <div className="card-foot row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="tiny muted">
              {offset + 1}–{offset + (tickets?.length ?? 0)} of {count.toLocaleString('en-IN')}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn-ghost btn-sm" disabled={offset === 0}
                onClick={() => { setOffset(Math.max(offset - PAGE, 0)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                <Icon name="chevron_left" size={15} /> Previous
              </button>
              <button className="btn-ghost btn-sm" disabled={offset + (tickets?.length ?? 0) >= count}
                onClick={() => { setOffset(offset + PAGE); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                Next <Icon name="chevron_right" size={15} />
              </button>
            </div>
          </div>
        )}
      </section>

      {exporting && (
        <ExportCases meta={meta} count={count} query={query}
          onClose={() => setExporting(false)} />
      )}

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

/**
 * Export the queue, as filtered.
 *
 * The desk's own record of how it performed — first response, breach, CSAT —
 * which is exactly what gets asked for when somebody outside support wants to
 * see the month, and which used to be answerable only with a screenshot. The
 * queue's query string goes with it, so what leaves is what was on screen.
 */
function ExportCases({ meta, count, query, onClose }) {
  const columns = meta?.columns ?? [];
  const [picked, setPicked] = useState(
    ['ref', 'subject', 'status', 'priority', 'assignee_name', 'created_at', 'resolution_due', 'breached'],
  );
  const [unmask, setUnmask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const toggle = (key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const hasPii = picked.some((k) => columns.find((c) => c.key === k)?.pii);

  const run = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await api.post(`/tickets/export${query}`, { columns: picked, unmask });
      download(r.filename, r.csv);
      onClose();
    } catch (e) { setProblem(e.message); setBusy(false); }
  };

  return (
    <Modal title="Export cases"
      subtitle={`${count.toLocaleString('en-IN')} case${count === 1 ? '' : 's'}, as currently filtered`}
      onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

        <div className="stack" style={{ gap: 2, maxHeight: '40vh', overflowY: 'auto' }}>
          {columns.map((c) => (
            <label key={c.key} className="row" style={{ gap: 8, padding: '6px 2px', cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.includes(c.key)} onChange={() => toggle(c.key)} />
              <span style={{ flex: 1 }}>{c.label}</span>
              {c.pii && <span className="chip chip-muted tiny">Identifier</span>}
            </label>
          ))}
        </div>

        {hasPii && (
          meta?.may_unmask ? (
            <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={unmask} onChange={(e) => setUnmask(e.target.checked)} />
              <span className="small">
                Include the client's mobile in full.
                <span className="muted"> Recorded against your name in the audit log.</span>
              </span>
            </label>
          ) : (
            <div className="tiny muted">
              <Icon name="lock" size={13} /> The mobile leaves masked — unmasking is a separate permission.
            </div>
          )
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !picked.length} onClick={run}>
            {busy ? 'Building…' : 'Download CSV'}
          </button>
        </div>
      </div>
    </Modal>
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
