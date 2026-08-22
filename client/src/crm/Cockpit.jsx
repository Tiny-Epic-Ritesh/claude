import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { money, rupees, shortDate, dateTime, mins, STATE_LABEL, ROLE_LABEL } from '../api.js';
import { useApi, Loading, ErrorBanner, Stat, Empty, CardStrip, AgeBadge, PriorityBadge, Progress, Tabs } from '../components/ui.jsx';

/**
 * One component renders all eleven cockpits.
 *
 * The server decides each role's three zones (BRD §4), so adding a role or
 * changing a metric is a server-side config change, not a new screen.
 */
export default function Cockpit({ session }) {
  const [data, { loading, error, reload }] = useApi('/cockpit');
  const [view, setView] = useState('primary');
  const navigate = useNavigate();

  if (loading) return <Loading label="Building your cockpit…" />;
  if (error) return <ErrorBanner error={error} />;

  const secondary = data.worklist?.secondary;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{data.title}</h1>
          <p>{data.subtitle}</p>
        </div>
        <div className="row wrap">
          {data.read_only && <span className="badge badge-amber">Read-only role</span>}
          <span className="badge badge-blue">{ROLE_LABEL[data.role] || data.role}</span>
          <button onClick={reload}>Refresh</button>
        </div>
      </div>

      {/* Zone 1 — metrics strip */}
      <div className="metrics">
        {data.metrics.map((m) => <Stat key={m.label} {...m} />)}
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        {/* Zone 3 — action pane. Actions are the role's most frequent moves. */}
        <section className="card">
          <div className="card-head"><h2>Actions</h2><span className="tiny muted">One click from the work list</span></div>
          <div className="card-body row wrap" style={{ gap: 6 }}>
            {data.actions.map((a) => <span key={a} className="badge">{a}</span>)}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Tasks due</h2>
            <span className="tiny muted">{data.tasks.length} open</span>
          </div>
          {data.tasks.length === 0 ? <Empty>Nothing due.</Empty> : (
            <table>
              <tbody>
                {data.tasks.slice(0, 6).map((t) => {
                  const overdue = new Date(t.due_at) < new Date();
                  return (
                    <tr key={t.id} className={t.lead_id ? 'row-link' : ''} onClick={() => t.lead_id && navigate(`/leads/${t.lead_id}`)}>
                      <td>
                        <div>{t.title}</div>
                        <div className="tiny muted">{t.lead_name || 'No lead'}</div>
                      </td>
                      <td className="num"><span className={`badge ${overdue ? 'badge-red' : ''}`}>{shortDate(t.due_at)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {data.notifications?.length > 0 && (
        <section className="card" style={{ marginBottom: 14 }}>
          <div className="card-head"><h2>Notifications</h2><span className="tiny muted">{data.notifications.length} unread</span></div>
          <div className="card-body stack">
            {data.notifications.slice(0, 5).map((n) => (
              <div key={n.id} className="row-between">
                <div>
                  <div style={{ fontWeight: 570 }}>{n.title}</div>
                  <div className="tiny muted">{n.body}</div>
                </div>
                <span className="tiny muted">{shortDate(n.created_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Zone 2 — primary work list */}
      <section className="card">
        <div className="card-head">
          <h2>{view === 'primary' ? data.worklist.title : secondary.title}</h2>
          {secondary && (
            <Tabs
              tabs={[{ key: 'primary', label: data.worklist.title }, { key: 'secondary', label: secondary.title }]}
              active={view}
              onChange={setView}
            />
          )}
        </div>
        <WorkList list={view === 'primary' ? data.worklist : secondary} navigate={navigate} session={session} />
      </section>
    </>
  );
}

/* ------------------------------------------------------------ renderers */

function WorkList({ list, navigate, session }) {
  if (!list?.rows?.length) return <Empty>Nothing here yet.</Empty>;

  switch (list.type) {
    case 'leads': return <LeadRows rows={list.rows} navigate={navigate} />;
    case 'tickets': return <TicketRows rows={list.rows} navigate={navigate} />;
    case 'cards': return <CardRows rows={list.rows} navigate={navigate} />;
    case 'kyc': return <KycRows rows={list.rows} />;
    case 'partners': return <PartnerRows rows={list.rows} navigate={navigate} />;
    case 'scorecard': return <ScorecardRows rows={list.rows} />;
    case 'users': return <UserRows rows={list.rows} />;
    case 'audit': return <AuditRows rows={list.rows} />;
    case 'campaigns': return <CampaignRows rows={list.rows} />;
    case 'sources': return <SourceRows rows={list.rows} />;
    default: return <Empty>Unsupported list type: {list.type}</Empty>;
  }
}

function LeadRows({ rows, navigate }) {
  return (
    <table>
      <thead><tr><th>Lead</th><th>Stage</th><th>Product cards</th><th>Age</th><th>Last contact</th><th className="num">Score</th></tr></thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.id} className="row-link" onClick={() => navigate(`/leads/${l.id}`)}>
            <td>
              <div style={{ fontWeight: 570 }}>{l.name}</div>
              <div className="tiny muted">
                {l.mobile} · {l.city || '—'}
                {l.open_tickets > 0 && <span className="badge badge-red" style={{ marginLeft: 6 }}>{l.open_tickets} ticket</span>}
                {l.callback_at && <span className="badge badge-amber" style={{ marginLeft: 6 }}>Callback {shortDate(l.callback_at)}</span>}
              </div>
            </td>
            <td><span className="badge">{l.stage}</span></td>
            <td><CardStrip cards={l.cards} /></td>
            <td><AgeBadge band={l.age_band} days={l.age_days} /></td>
            <td className="small muted">{l.days_since_contact == null ? 'never' : `${l.days_since_contact}d ago`}</td>
            <td className="num">{l.score}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TicketRows({ rows, navigate }) {
  return (
    <table>
      <thead><tr><th>Ticket</th><th>AI summary</th><th>Priority</th><th>Status</th><th className="num">SLA</th></tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className="row-link" onClick={() => navigate(`/tickets/${t.id}`)}>
            <td>
              <div style={{ fontWeight: 570 }}>{t.ref}</div>
              <div className="tiny muted">{t.lead_name || t.partner_name || 'Unlinked'}</div>
            </td>
            <td style={{ maxWidth: 420 }}>
              <div style={{ fontWeight: 540 }}>{t.subject}</div>
              <div className="tiny muted" style={{ whiteSpace: 'pre-wrap' }}>{t.ai_summary}</div>
            </td>
            <td><PriorityBadge priority={t.priority} /></td>
            <td><span className="badge">{t.status}</span></td>
            <td className="num">
              {t.breached ? <span className="badge badge-red">Breached</span>
                : t.sla_remaining_mins != null ? <span className="badge">{Math.round(t.sla_remaining_mins / 60)}h left</span>
                  : <span className="tiny muted">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CardRows({ rows, navigate }) {
  return (
    <table>
      <thead><tr><th>Lead</th><th>Card state</th><th>Sales RM</th><th>Age</th><th>KYC</th><th>Last activity</th></tr></thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id} className="row-link" onClick={() => navigate(`/leads/${c.lead_id}`)}>
            <td style={{ fontWeight: 545 }}>{c.lead_name}</td>
            <td>
              <span className="row" style={{ gap: 6 }}>
                <span className={`dot dot-${c.colour}`} />
                <span className="small">{STATE_LABEL[c.state] || c.state}</span>
              </span>
            </td>
            <td className="small">{c.sales_rm_name || <span className="muted">unassigned</span>}</td>
            <td><AgeBadge band={c.age_band} days={c.age_days} /></td>
            <td className="small">
              {c.kyc_status
                ? <span className={`badge ${c.kyc_status === 'Stalled' || c.kyc_status === 'Abandoned' ? 'badge-red' : c.kyc_status === 'Complete' ? 'badge-green' : 'badge-blue'}`}>{c.kyc_status}</span>
                : <span className="muted">—</span>}
            </td>
            <td className="small muted">{c.last_card_activity ? shortDate(c.last_card_activity) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KycRows({ rows }) {
  return (
    <table>
      <thead><tr><th>Applicant</th><th>Product</th><th>Status</th><th>Current step</th><th style={{ width: 150 }}>Progress</th><th className="num">On step</th><th className="num">Elapsed</th></tr></thead>
      <tbody>
        {rows.map((j) => (
          <tr key={j.id}>
            <td style={{ fontWeight: 545 }}>{j.lead_name || <span className="muted">Walk-in applicant</span>}</td>
            <td className="small">{j.product_name}</td>
            <td>
              <span className={`badge ${j.status === 'Complete' ? 'badge-green' : ['Stalled', 'Abandoned'].includes(j.status) ? 'badge-red' : 'badge-blue'}`}>
                {j.status}
              </span>
            </td>
            <td className="small">{j.current_step_label || '—'}</td>
            <td><Progress pct={j.progress_pct} /></td>
            <td className="num small">{mins(j.seconds_on_step)}</td>
            <td className="num small muted">{mins(j.elapsed_s)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartnerRows({ rows, navigate }) {
  return (
    <table>
      <thead><tr><th>Partner</th><th>Model</th><th>State</th><th style={{ width: 140 }}>Onboarding</th><th className="num">Sourced</th><th className="num">This month</th></tr></thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id} className="row-link" onClick={() => navigate(`/partners/${p.id}`)}>
            <td>
              <div style={{ fontWeight: 570 }}>{p.name}</div>
              <div className="tiny muted">{p.business_name || p.city || '—'}{p.partner_code ? ` · ${p.partner_code}` : ''}</div>
            </td>
            <td className="small">{p.partner_model}</td>
            <td>
              <span className={`badge ${p.state_code === 'ACTIVE' ? 'badge-green' : ['SUSPENDED', 'TERMINATED'].includes(p.state_code) ? 'badge-red' : 'badge-amber'}`}>
                {p.state_code}
              </span>
            </td>
            <td><Progress pct={p.steps_total ? Math.round((p.steps_done / p.steps_total) * 100) : 0} /></td>
            <td className="num">{p.sourced_count}</td>
            <td className="num">{p.sourced_this_month}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScorecardRows({ rows }) {
  const cols = Object.keys(rows[0]).filter((k) => !['id'].includes(k));
  return (
    <table>
      <thead><tr>{cols.map((c) => <th key={c} className={typeof rows[0][c] === 'number' ? 'num' : ''}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id ?? i}>
            {cols.map((c) => (
              <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}>
                {c === 'overdue_tasks' && r[c] > 0 ? <span className="badge badge-red">{r[c]}</span>
                  : c === 'stalled' && r[c] > 0 ? <span className="badge badge-red">{r[c]}</span>
                    : c === 'conversion' ? `${r[c]}%`
                      : c === 'role' ? <span className="badge">{ROLE_LABEL[r[c]] || r[c]}</span>
                        : r[c] ?? '—'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UserRows({ rows }) {
  return (
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Product</th><th className="num">Leads</th><th>Status</th></tr></thead>
      <tbody>
        {rows.map((u) => (
          <tr key={u.id}>
            <td style={{ fontWeight: 545 }}>{u.name}</td>
            <td className="small muted">{u.email}</td>
            <td><span className="badge badge-blue">{ROLE_LABEL[u.role] || u.role}</span></td>
            <td className="small">{u.product_name || '—'}</td>
            <td className="num">{u.lead_count}</td>
            <td>{u.active ? <span className="badge badge-green">Active</span> : <span className="badge">Disabled</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditRows({ rows }) {
  return (
    <table>
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id}>
            <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td>
            <td className="small">{a.user_name || 'system'}<div className="tiny muted">{ROLE_LABEL[a.user_role] || ''}</div></td>
            <td><span className="badge">{a.action}</span></td>
            <td className="small muted">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
            <td className="tiny muted" style={{ maxWidth: 320, wordBreak: 'break-word' }}>{a.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CampaignRows({ rows }) {
  return (
    <table>
      <thead><tr><th>Campaign</th><th>Channel</th><th>List</th><th>Status</th><th className="num">Sent</th><th className="num">Opened</th><th className="num">Clicked</th></tr></thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <td style={{ fontWeight: 545 }}>{c.name}</td>
            <td className="small">{c.channel}</td>
            <td className="small muted">{c.list_name || '—'}</td>
            <td><span className={`badge ${c.status === 'Sent' ? 'badge-green' : ''}`}>{c.status}</span></td>
            <td className="num">{c.sent}</td>
            <td className="num">{c.opened}</td>
            <td className="num">{c.clicked}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SourceRows({ rows }) {
  const max = Math.max(...rows.map((r) => r.n), 1);
  return (
    <table>
      <thead><tr><th>Source</th><th className="num">Total</th><th className="num">This month</th><th style={{ width: 200 }}>Share</th></tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.source}>
            <td style={{ fontWeight: 545 }}>{s.source}</td>
            <td className="num">{s.n}</td>
            <td className="num">{s.this_month}</td>
            <td><Progress pct={Math.round((s.n / max) * 100)} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
