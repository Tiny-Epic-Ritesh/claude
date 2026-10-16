import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, dateTime, shortDate, dmy } from '../api.js';
import {
  useApi, Icon, Loading, ErrorBanner, Empty, Spinner, PriorityBadge, Tabs, Modal, Stat, Confirm, Outcome, announce,
} from '../components/ui.jsx';
import BackLink from '../components/BackLink.jsx';
import { CorrectionList, CorrectButton, correctedStyle } from '../components/Corrections.jsx';

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

/* QA-05. The filters a figure links here with, beyond its tab, and how each
   reads as a chip. Every one is a filter the list API applies, so the count
   on the figure and the count here are the same query. */
const LINKED = ['mine', 'breached', 'status', 'due_today', 'rated', 'resolved_from', 'resolved_to', 'created_from', 'created_to'];
const VIEWS = ['mine', 'open', 'breached', 'all'];
const dmyOf = (iso) => (iso ? dmy(iso) : '…');
function chipsFor(linked) {
  const out = [];
  if (linked.get('mine') === 'true') out.push({ keys: ['mine'], label: 'Assigned to me' });
  if (linked.get('breached') === 'true') out.push({ keys: ['breached'], label: 'SLA breached' });
  if (linked.get('status')) out.push({ keys: ['status'], label: `Status: ${linked.get('status')}` });
  if (linked.get('due_today') === 'true') out.push({ keys: ['due_today'], label: 'Due today' });
  if (linked.get('rated') === 'true') out.push({ keys: ['rated'], label: 'Rated by the client' });
  if (linked.get('resolved_from') || linked.get('resolved_to')) {
    out.push({ keys: ['resolved_from', 'resolved_to'], label: `Resolved ${dmyOf(linked.get('resolved_from'))} – ${dmyOf(linked.get('resolved_to'))}` });
  }
  if (linked.get('created_from') || linked.get('created_to')) {
    out.push({ keys: ['created_from', 'created_to'], label: `Created ${dmyOf(linked.get('created_from'))} – ${dmyOf(linked.get('created_to'))}` });
  }
  return out;
}

function TicketQueue({ session }) {
  /* QA-05. Home's "Open cases 4" links here as ?open=true and landed on
     "Assigned to me · 2", because the view came from the role alone. A link
     names its view now; ?view= takes any tab, and ?open=true is kept for
     links already sent. The view and any linked filters live in the address,
     so a second figure clicked while already here is followed too, and each
     filter shows as a chip that can be removed. */
  const [linked, setLinked] = useSearchParams();
  const askedView = linked.get('view')
    ?? (linked.get('open') === 'true' ? 'open' : linked.get('breached') === 'true' ? 'breached' : null);
  const filter = VIEWS.includes(askedView) ? askedView : session.role === 'customer_care' ? 'mine' : 'open';
  // A tab is a different question: choosing one starts it without the linked filters.
  const setFilter = (view) => setLinked(new URLSearchParams({ view }));
  const dropChip = (keys) => {
    const next = new URLSearchParams(linked);
    for (const k of keys) next.delete(k);
    if (!next.get('view')) next.set('view', filter);
    next.delete('open');
    setLinked(next);
  };
  const chips = chipsFor(linked);
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(null);

  // A request per keystroke against a desk with thousands of cases.
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  // Changing tab or a linked filter is a different question; page 4 of the old one means nothing.
  const linkedKey = LINKED.map((k) => linked.get(k) ?? '').join('|');
  useEffect(() => { setOffset(0); }, [filter, linkedKey]);

  const base = { mine: { mine: 'true', open: 'true' }, open: { open: 'true' }, breached: { breached: 'true' }, all: {} }[filter];
  const params = new URLSearchParams({ ...base, limit: String(PAGE), offset: String(offset) });
  for (const k of LINKED) if (linked.get(k)) params.set(k, linked.get(k));
  // A resolved window asks about closed cases, which "open" would hide.
  if (linked.get('resolved_from') || linked.get('resolved_to')) params.delete('open');
  if (sort) { params.set('sort', sort); params.set('dir', dir); }
  if (q) params.set('q', q);
  const query = `?${params}`;

  const [tickets, { loading, error, reload, total }] = useApi(`/tickets${query}`, [query]);
  const [report, { reload: reloadReport }] = useApi(session.permissions.includes('report.team') ? '/tickets/reports/summary' : null);
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
        {/* OPS-29: offered to those the sweep accepts. Part 4, item 4: it ran
            on a click with nothing to show for it, styled as bare text; it says
            what it will do, asks, and says what it did. */}
        {(session.permissions.includes('ticket.reassign') || session.permissions.includes('admin.sla')) && (
          <button type="button" className="btn" onClick={() => setChecking(true)}>
            <Icon name="schedule" size={16} /> Check SLAs now
          </button>
        )}
      </div>

      {report && (
        /* QA-05: each opens the list on the cases it counts, across the team's books. */
        <div className="metrics">
          <Stat label="Open" value={report.totals.open} sub="All open, in your books" to="/tickets?view=open" />
          <Stat label="Breached" value={report.totals.breached} sub="Open and past the resolution time" tone="danger" to="/tickets?view=breached" />
          <Stat label="Resolved today" value={report.totals.resolved_today} sub="In your books" tone="good"
            to={`/tickets?view=all&resolved_from=${report.today}&resolved_to=${report.today}`} />
          <Stat label="Avg CSAT" value={report.totals.avg_csat ?? '—'} sub="Rated cases, in your books" to="/tickets?view=all&rated=true" />
        </div>
      )}

      {checking && (
        <CheckSlas
          onCancel={() => setChecking(false)}
          onDone={(result) => { setChecking(false); setChecked(result); reload(); reloadReport(); }}
        />
      )}
      {checked && <Outcome title={checked.title} lines={checked.lines} tone={checked.tone} onClose={() => setChecked(null)} />}

      <Tabs
        tabs={[{ key: 'mine', label: 'Assigned to me' }, { key: 'open', label: 'All open' }, { key: 'breached', label: 'Breached' }, { key: 'all', label: 'Everything' }]}
        active={filter}
        onChange={setFilter}
      />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'center' }}>
          {/* QA-05: what a figure linked with, visible and removable. */}
          {chips.map((c) => (
            <span key={c.label} className="badge" style={{ alignSelf: 'center' }}>
              {c.label}
              <button type="button" className="btn-ghost btn-sm" aria-label={`Clear ${c.label}`} onClick={() => dropChip(c.keys)}>×</button>
            </span>
          ))}
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
      // Part 4, item 8.4: what went into the file.
      announce('Cases exported', [
        `${r.rows} case${r.rows === 1 ? '' : 's'} in ${r.filename}${r.unmasked ? ', with identifiers in the clear' : ', identifiers masked'}.`,
        r.truncated ? 'Capped: there were more than one export holds.' : null,
        'The export is in the audit log.',
      ], r.truncated ? 'warn' : 'ok');
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

/**
 * The SLA check, asked first (Part 4, item 4).
 *
 * The server does this by itself every minute, so the button is for "now",
 * and for seeing what it found. It covers the business being looked at.
 */
function CheckSlas({ onCancel, onDone }) {
  const [now, { loading, error }] = useApi('/tickets/sweep/preview');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const where = now?.businesses?.join(' and ') ?? 'your business';

  async function confirm() {
    setBusy(true);
    setFailed(null);
    try {
      const r = await api.post('/tickets/sweep');
      onDone({
        title: 'SLA check done',
        tone: r.breached ? 'warn' : 'ok',
        lines: [
          `Checked ${r.checked} open case${r.checked === 1 ? '' : 's'} in ${r.businesses.join(' and ')}.`,
          r.breached
            ? `Newly past their resolution time, now marked breached, assignees and managers told: ${r.breached_refs.join(', ')}.`
            : 'No case was newly past its resolution time.',
          r.closed
            ? `Closed, 72 hours after being resolved: ${r.closed_refs.join(', ')}.`
            : 'No resolved case was due to close.',
        ],
      });
    } catch (err) { setFailed(err.message); setBusy(false); }
  }

  return (
    <Confirm title="Check SLAs now?" subtitle={`Cases in ${where}`} confirmLabel="Check now"
      busy={busy} error={failed || error} disabled={!now} onConfirm={confirm} onCancel={onCancel}>
      {loading && !now && <Loading />}
      {now && (
        <>
          <p className="confirm-lead">Checks every open case in {where} against its resolution time, now.</p>
          <div>
            <h3>What it does</h3>
            <ul>
              <li>A case past its resolution time is marked breached, and its assignee and their manager are told.</li>
              <li>A case resolved more than 72 hours ago, and not reopened, is closed. The client is not messaged.</li>
              <li>A case waiting on the client is left alone: its clock is paused.</li>
              <li>Nothing else changes: no priority, assignee or deadline.</li>
            </ul>
          </div>
          <div>
            <h3>Right now</h3>
            <ul>
              <li>{now.open} open case{now.open === 1 ? '' : 's'}.</li>
              <li>{now.past_due} past due and not yet marked breached.</li>
              <li>{now.to_close} resolved more than 72 hours ago.</li>
            </ul>
          </div>
          <div className="notice">
            <Icon name="info" />
            <p>The server does the same by itself every minute, so these are usually 0. Use this to see the result at once.</p>
          </div>
        </>
      )}
    </Confirm>
  );
}

/* --------------------------------------------------------------- detail */

/* Part 4, item 2: the panel shows at most this many entries, the original
   included; Show all opens the whole thread in a dialog of its own. */
const THREAD_LIMIT = 50;

function TicketDetail({ id, session }) {
  const [ticket, { loading, error, reload }] = useApi(`/tickets/${id}`);
  const [meta] = useApi('/meta');
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [reopening, setReopening] = useState(false);
  /* Part 4, items 1 and 3: Escalate, Mark resolved and a Manage change each
     ask first. Which dialog is open, and what the last action did. */
  const [asking, setAsking] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [showAll, setShowAll] = useState(false);
  /* Part 4, item 3.1: Manage holds its changes until Save. */
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (ticket) setDraft({ status: ticket.status, priority: ticket.priority, assignee_id: ticket.assignee_id ?? null });
  }, [ticket]);

  if (loading && !ticket) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!ticket || !draft) return null;

  const can = (p) => session.permissions.includes(p);
  /* QA-37: details change while a case is open; resolved or closed, the way
     back is Reopen, which asks why. */
  const finished = ticket.status === 'Resolved' || ticket.status === 'Closed';
  const statusChoices = !finished ? STATUSES : ticket.status === 'Resolved' ? ['Resolved', 'Closed'] : ['Closed'];

  const changed = {};
  if (draft.status !== ticket.status) changed.status = draft.status;
  if (draft.priority !== ticket.priority) changed.priority = draft.priority;
  if ((draft.assignee_id ?? null) !== (ticket.assignee_id ?? null)) changed.assignee_id = draft.assignee_id;
  const dirty = Object.keys(changed).length > 0;
  const discard = () => setDraft({ status: ticket.status, priority: ticket.priority, assignee_id: ticket.assignee_id ?? null });

  async function act(fn) {
    setBusy(true);
    setActionError(null);
    try { await fn(); reload(); }
    catch (err) { setActionError(err.message); }
    finally { setBusy(false); }
  }

  const done = (result) => { setAsking(null); setOutcome(result); reload(); };

  /* The original, then the replies; the panel keeps the original and the
     latest entries after it. */
  const entries = ticket.replies.length + 1;
  const visibleReplies = entries > THREAD_LIMIT ? ticket.replies.slice(-(THREAD_LIMIT - 1)) : ticket.replies;
  const earlier = ticket.replies.length - visibleReplies.length;

  return (
    <>
      <div className="page-head">
        <div>
          <BackLink to="/tickets" label="Tickets" />
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
          {can('ticket.escalate') && !finished && (
            <button type="button" className="btn" onClick={() => setAsking('escalating')} disabled={busy}>
              <Icon name="trending_up" size={16} /> Escalate
            </button>
          )}
          {can('ticket.reply') && !finished && (
            <button type="button" className="btn btn-primary" onClick={() => setAsking('resolving')} disabled={busy}>Mark resolved</button>
          )}
          {can('ticket.reply') && finished && (
            <button type="button" className="btn btn-primary" onClick={() => setReopening(true)} disabled={busy}>Reopen</button>
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
          <div className="card-head">
            <h2>Conversation</h2>
            <span className="tiny muted">{entries} {entries === 1 ? 'entry' : 'entries'}</span>
          </div>
          <div className="card-body stack">
            <ThreadEntry original ticket={ticket} />
            {earlier > 0 && (
              <div className="thread-gap">
                <span>{earlier} earlier {earlier === 1 ? 'entry is' : 'entries are'} not shown here. This panel shows the latest {THREAD_LIMIT}.</span>
                <button type="button" className="btn btn-sm" onClick={() => setShowAll(true)}>Show more</button>
              </div>
            )}
            {visibleReplies.map((r) => <ThreadEntry key={r.id} entry={r} ticketId={id} session={session} onDone={reload} />)}
            {earlier > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(true)}>
                Show more: all {entries} entries
              </button>
            )}

            {can('ticket.reply') && (
              <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) act(async () => { await api.post(`/tickets/${id}/replies`, { body: reply, internal }); setReply(''); }); }}>
                <textarea value={reply} onChange={(e) => setReply(e.target.value)}
                  placeholder={internal ? 'Write a note for your team…' : 'Write a reply to the client…'} />
                <div className="row-between" style={{ marginTop: 8 }}>
                  <label className="row small" style={{ marginBottom: 0 }}>
                    <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} style={{ width: 15, height: 15 }} />
                    Internal note
                  </label>
                  <button className="btn-primary" disabled={busy || !reply.trim()}>{busy ? <Spinner /> : internal ? 'Add internal note' : 'Send reply'}</button>
                </div>
                {/* Part 4, item 3.3. */}
                {internal && (
                  <div className="field-note" role="note">
                    <Icon name="lock" />
                    <span>Internal notes are for your team's reference only. They are not shared with the client or customer.</span>
                  </div>
                )}
              </form>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Manage</h2></div>
          <div className="card-body stack">
            <div className="manage-fields">
              <div className="field">
                <label htmlFor="case-status">Status</label>
                <select id="case-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                  disabled={busy || statusChoices.length < 2}>
                  {statusChoices.map((s) => <option key={s}>{s}</option>)}
                </select>
                {/* Part 4, item 3.2: the note belongs to Status, and looks it. */}
                {finished ? (
                  <div className="field-note" role="note">
                    <Icon name="lock" />
                    <span>This case is {ticket.status.toLowerCase()}. Its details stay as they are unless it is reopened.</span>
                  </div>
                ) : draft.status === 'Waiting on Client' && ticket.status !== 'Waiting on Client' ? (
                  <div className="field-note field-note-warn" role="note">
                    <Icon name="pause_circle" />
                    <span>Moving this ticket to “Waiting on Client” pauses the SLA clock.</span>
                  </div>
                ) : ticket.status === 'Waiting on Client' && draft.status === 'Waiting on Client' ? (
                  <div className="field-note field-note-warn" role="note">
                    <Icon name="pause_circle" />
                    <span>The SLA clock is paused while this case waits on the client.</span>
                  </div>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="case-priority">Priority</label>
                <select id="case-priority" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} disabled={busy || finished}>
                  {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              {can('ticket.reassign') && (
                <div className="field">
                  <label htmlFor="case-assignee">Assignee</label>
                  <select id="case-assignee" value={draft.assignee_id ?? ''}
                    onChange={(e) => setDraft({ ...draft, assignee_id: e.target.value ? Number(e.target.value) : null })} disabled={busy || finished}>
                    <option value="">Unassigned</option>
                    {(meta?.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            {dirty && (
              <div className="manage-save">
                <span className="tiny muted">Not saved yet.</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={busy}>Discard</button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setAsking('changing')} disabled={busy}>Save</button>
              </div>
            )}
            {ticket.csat && <div className="notice">CSAT received: {ticket.csat}/5</div>}
            {ticket.merged?.length > 0 && (
              <div className="notice">{ticket.merged.length} ticket(s) merged into this one: {ticket.merged.map((m) => m.ref).join(', ')}</div>
            )}
          </div>
        </section>
      </div>

      {asking === 'escalating' && <EscalateCase ticket={ticket} onCancel={() => setAsking(null)} onDone={done} />}
      {asking === 'resolving' && <ResolveCase ticket={ticket} onCancel={() => setAsking(null)} onDone={done} />}
      {asking === 'changing' && <ChangeCase ticket={ticket} changed={changed} onCancel={() => setAsking(null)} onDone={done} />}
      {outcome && <Outcome title={outcome.title} lines={outcome.lines} tone={outcome.tone} onClose={() => setOutcome(null)} />}
      {showAll && (
        <Modal title={`${ticket.ref} · the whole conversation`} subtitle={`${entries} entries, oldest first`} onClose={() => setShowAll(false)} wide>
          <div className="thread-all stack">
            <ThreadEntry original ticket={ticket} />
            {ticket.replies.map((r) => <ThreadEntry key={r.id} entry={r} ticketId={id} session={session} onDone={reload} />)}
          </div>
        </Modal>
      )}
      {reopening && (
        <Reopen ticket={ticket} onClose={() => setReopening(false)} onDone={() => {
          setReopening(false); reload();
          // Part 4, item 8.4.
          announce(`${ticket.ref} reopened`, ['It is Open again; its resolved and closed times are cleared, and your reason is an internal note on the case.']);
        }} />
      )}
    </>
  );
}

/* One entry in the conversation: the original description, or a reply. */
function ThreadEntry({ original, ticket, entry, ticketId, session, onDone }) {
  if (original) {
    return (
      <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 12 }}>
        <div className="tiny muted">Original · {dateTime(ticket.created_at)}</div>
        <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{ticket.description}</div>
      </div>
    );
  }
  const r = entry;
  return (
    <div style={{ borderLeft: `2px solid ${r.internal ? 'var(--accent)' : r.author_type === 'client' ? 'var(--brand)' : 'var(--border)'}`, paddingLeft: 12 }}>
      <div className="row-between">
        <div className="tiny muted">
          {r.user_name || r.author_type} · {dateTime(r.created_at)}
          {r.internal ? <span className="badge badge-accent" style={{ marginLeft: 6 }}>Internal</span> : null}
          {r.corrections?.length > 0 && <span className="badge badge-amber" style={{ marginLeft: 6 }}>Corrected</span>}
        </div>
        {r.author_type === 'agent' && session.permissions.includes('ticket.reply') && (
          <CorrectButton entry={r} session={session} path={`/tickets/${ticketId}/replies/${r.id}/correct`} onDone={onDone} />
        )}
      </div>
      <div className="small" style={{ whiteSpace: 'pre-wrap', ...correctedStyle(r) }}>{r.body}</div>
      <CorrectionList corrections={r.corrections} />
    </div>
  );
}

/* A server note, coloured by what it is. */
function Said({ items }) {
  if (!items?.length) return null;
  return items.map((item, i) => (
    <div key={i} className={`notice ${item.tone === 'warn' ? 'notice-warn' : item.tone === 'ok' ? 'notice-ok' : ''}`}>
      <Icon name={item.tone === 'warn' ? 'warning' : item.tone === 'ok' ? 'check_circle' : 'info'} />
      <p>{item.text}</p>
    </div>
  ));
}

/**
 * Escalate, asked first (Part 4, item 1).
 *
 * What it shows comes from the server's own rules: who it goes to (OPS-44),
 * every level above them in the manager hierarchy and the deadline at each
 * priority, and what happens if the case stays unresolved.
 */
function EscalateCase({ ticket, onCancel, onDone }) {
  const [info, { loading, error }] = useApi(`/tickets/${ticket.id}/escalation`);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  async function confirm() {
    setBusy(true);
    setFailed(null);
    try {
      const r = await api.post(`/tickets/${ticket.id}/escalate`, { reason: reason.trim() || 'Escalated from the case page' });
      onDone({
        title: `${ticket.ref} escalated`,
        lines: [
          `It is now with ${r.escalated_to}, who has been notified.`,
          r.priority !== ticket.priority ? `Its priority went from ${ticket.priority} to ${r.priority}.` : `Its priority stays ${r.priority}.`,
          `It is due to be resolved by ${dateTime(r.resolution_due)}.`,
          r.breached ? 'That time has already passed, so it is marked breached.' : null,
          'An internal note on the case records the escalation.',
        ],
      });
    } catch (err) { setFailed(err.message); setBusy(false); }
  }

  return (
    <Confirm title={`Escalate ${ticket.ref}?`} subtitle={ticket.subject} confirmLabel="Escalate"
      busy={busy} error={failed || error} disabled={!info || Boolean(info.refusal)}
      onConfirm={confirm} onCancel={onCancel}>
      {loading && !info && <Loading label="Working out the escalation…" />}
      {info && (
        <>
          {info.refusal ? (
            <div className="notice notice-danger"><Icon name="warning" /><p>{info.refusal}</p></div>
          ) : (
            <>
              <p className="confirm-lead">This case will be escalated to {info.to.name} ({info.to.role_label}).</p>
              <ul>{info.effects.map((e) => <li key={e}>{e}</li>)}</ul>
              <Said items={info.sla} />
            </>
          )}
          <div>
            <h3>Escalation path in {info.business}</h3>
            <div className="confirm-wrap">
              <table className="confirm-table">
                <thead><tr><th>Level</th><th>Who</th><th>Priority</th><th>Resolve by</th></tr></thead>
                <tbody>
                  {info.chain.map((l) => (
                    <tr key={l.level} className={l.current ? 'is-current' : undefined}>
                      <td>{l.level}{l.current ? ' · now' : ''}</td>
                      <td>{l.who ? `${l.who.name}, ${l.who.role_label}` : 'Unassigned'}</td>
                      <td>{l.priority}</td>
                      <td>{dateTime(l.resolution_due)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tiny muted" style={{ margin: '6px 0 0' }}>
              The path is the manager hierarchy set in Setup; the times are this case's SLA policy, counted in business hours from when it was opened.
            </p>
          </div>
          {info.if_unresolved.length > 0 && (
            <div>
              <h3>If it stays unresolved</h3>
              <ul>{info.if_unresolved.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}
          {!info.refusal && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="escalate-why">Why (kept as an internal note)</label>
              <input id="escalate-why" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="The client has called three times about the refund" />
            </div>
          )}
        </>
      )}
    </Confirm>
  );
}

/**
 * Mark resolved, asked first (Part 4, item 1): what the case has been
 * through, what to check, and what resolving sets off.
 */
function ResolveCase({ ticket, onCancel, onDone }) {
  const [info, { loading, error }] = useApi(`/tickets/${ticket.id}/resolution-check`);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  async function confirm() {
    setBusy(true);
    setFailed(null);
    try {
      const r = await api.patch(`/tickets/${ticket.id}`, { status: 'Resolved' });
      const closes = r.resolved_at ? new Date(new Date(`${r.resolved_at.replace(' ', 'T')}Z`).getTime() + 72 * 3600_000) : null;
      onDone({
        title: `${ticket.ref} resolved`,
        lines: [
          `Resolved at ${dateTime(r.resolved_at)}.`,
          info?.effects?.[1] ?? null,
          closes ? `It closes by itself at ${dateTime(closes.toISOString())} unless somebody reopens it.` : null,
        ],
      });
    } catch (err) { setFailed(err.message); setBusy(false); }
  }

  const s = info?.summary;
  return (
    <Confirm title={`Mark ${ticket.ref} resolved?`} subtitle={ticket.subject} confirmLabel="Mark resolved"
      busy={busy} error={failed || error} disabled={!info} onConfirm={confirm} onCancel={onCancel}>
      {loading && !info && <Loading label="Reading the case…" />}
      {info && (
        <>
          <p className="confirm-lead">This case will be marked as resolved.</p>
          <div>
            <h3>The case so far</h3>
            <ul>
              <li>Opened {dateTime(s.opened)} via {s.channel}, priority {s.priority}.</li>
              <li>{s.client_messages} {s.client_messages === 1 ? 'message' : 'messages'} from the client, {s.replies} {s.replies === 1 ? 'reply' : 'replies'} to them, {s.internal_notes} internal {s.internal_notes === 1 ? 'note' : 'notes'}.</li>
              {s.last_client && <li>Last from the client, {dateTime(s.last_client.at)}: “{s.last_client.excerpt}{s.last_client.excerpt.length >= 160 ? '…' : ''}”</li>}
              {s.last_reply_at && <li>Last reply to the client: {dateTime(s.last_reply_at)}.</li>}
            </ul>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <h3>Check before resolving</h3>
            <Said items={info.checks} />
          </div>
          <div>
            <h3>What resolving does</h3>
            <ul>{info.effects.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        </>
      )}
    </Confirm>
  );
}

/**
 * Save a Manage change, asked first (Part 4, item 3.1): the changes, what
 * each one does, and what to do before saving.
 */
function ChangeCase({ ticket, changed, onCancel, onDone }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(changed)) q.set(k, v ?? '');
  const [info, { loading, error }] = useApi(`/tickets/${ticket.id}/change-preview?${q}`, [q.toString()]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  async function confirm() {
    setBusy(true);
    setFailed(null);
    try {
      const r = await api.patch(`/tickets/${ticket.id}`, changed);
      onDone({
        title: `${ticket.ref} saved`,
        lines: [
          ...info.changes.map((c) => `${c.label}: ${c.from} → ${c.to}.`),
          changed.priority ? `It is now due to be resolved by ${dateTime(r.resolution_due)}.` : null,
          changed.priority && r.breached && !ticket.breached ? 'That time has already passed, so it is marked breached.' : null,
          changed.assignee_id ? 'The new assignee has been notified.' : null,
        ],
      });
    } catch (err) { setFailed(err.message); setBusy(false); }
  }

  return (
    <Confirm title={`Save changes to ${ticket.ref}?`} subtitle={ticket.subject} confirmLabel="Save"
      busy={busy} error={failed || error} disabled={!info} onConfirm={confirm} onCancel={onCancel}>
      {loading && !info && <Loading label="Working out what changes…" />}
      {info && (
        <>
          <div className="confirm-wrap">
            <table className="confirm-table">
              <thead><tr><th>Field</th><th>Now</th><th>After saving</th></tr></thead>
              <tbody>{info.changes.map((c) => <tr key={c.field}><td>{c.label}</td><td>{c.from}</td><td><strong>{c.to}</strong></td></tr>)}</tbody>
            </table>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <h3>What this changes</h3>
            <Said items={info.effects} />
          </div>
          {info.checks.length > 0 && (
            <div>
              <h3>Before you save</h3>
              <ul>{info.checks.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </Confirm>
  );
}

/**
 * Reopen a resolved or closed case (QA-37).
 *
 * The client was told it was done, so reopening says why; the reason is put
 * on the case as an internal note and in the audit trail.
 */
function Reopen({ ticket, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await api.patch(`/tickets/${ticket.id}`, { status: 'Open', reason }); onDone(); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title={`Reopen ${ticket.ref}`} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <ErrorBanner error={error} />
        <p className="small">It goes back to Open, and its resolved and closed times are cleared.</p>
        <div className="field">
          <label htmlFor="reopen-reason">Why</label>
          <input id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="The client says the refund has not arrived" autoFocus />
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy || reason.trim().length < 5}>{busy ? 'Reopening…' : 'Reopen'}</button>
        </div>
      </form>
    </Modal>
  );
}
