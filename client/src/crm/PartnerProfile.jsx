import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money, rupees, shortDate, dateTime } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Progress, Tabs } from '../components/ui.jsx';
import BackLink from '../components/BackLink.jsx';

/** Partner Profile View (BRD §12) — replaces the lead detail view for partners. */
export default function PartnerProfile({ session }) {
  const { id } = useParams();
  const [partner, { loading, error, reload }] = useApi(`/partners/${id}`);
  const [tab, setTab] = useState('onboarding');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [insight, setInsight] = useState(null);
  const [elevated, setElevated] = useState(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const can = (p) => session.permissions.includes(p);
  const isActive = partner.state_code === 'ACTIVE';

  async function act(fn) {
    setBusy(true);
    setActionError(null);
    try { await fn(); reload(); }
    catch (err) { setActionError(err.message); }
    finally { setBusy(false); }
  }

  const tabs = [
    { key: 'onboarding', label: 'Onboarding & training' },
    { key: 'leads', label: 'Sourced leads', count: partner.sourced_leads.length },
    { key: 'commission', label: 'Commission' },
    { key: 'activity', label: 'Activity', count: partner.activities.length },
    { key: 'notes', label: 'Notes', count: partner.notes.length },
    { key: 'tickets', label: 'Tickets', count: partner.tickets.length },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <BackLink to="/partners" label="Partners" />
          <h1 style={{ marginTop: 5 }}>{partner.name}</h1>
          <div className="row wrap small muted" style={{ marginTop: 5 }}>
            {partner.business_name && <span>{partner.business_name} ·</span>}
            <span className="badge">{partner.partner_model}</span>
            <span className={`badge ${isActive ? 'badge-green' : ['SUSPENDED', 'TERMINATED'].includes(partner.state_code) ? 'badge-red' : 'badge-amber'}`}>{partner.state_code}</span>
            {partner.partner_code && <span className="badge badge-blue">{partner.partner_code}</span>}
            <span>· {partner.city || '—'}</span>
            <span>· {partner.mobile}</span>
            {partner.has_portal_login && <span className="badge badge-accent">Portal access</span>}
          </div>
        </div>
        <div className="row wrap">
          <button onClick={async () => { setBusy(true); try { setInsight(await api.get(`/partners/${id}/insight`)); } finally { setBusy(false); } }} disabled={busy}>
            {busy ? <Spinner /> : 'AI health check'}
          </button>
          {can('partner.elevate.request') && !isActive && partner.state_code !== 'TERMINATED' && (
            <button onClick={() => act(() => api.post(`/partners/${id}/request-elevation`))} disabled={busy}>Request elevation</button>
          )}
          {can('partner.elevate') && !isActive && (
            <button className="btn-primary" onClick={() => act(async () => { setElevated(await api.post(`/partners/${id}/elevate`, {})); })} disabled={busy}>
              Elevate to partner entity
            </button>
          )}
        </div>
      </div>

      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />

      {elevated && (
        <div className="notice">
          <strong>{partner.name} is now an active partner.</strong> Code {elevated.partner_code} issued.
          Portal sign-in: <code>{elevated.portal_login.email}</code> / <code>{elevated.portal_login.password}</code>
        </div>
      )}

      {insight && (
        <section className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent)' }}>
          <div className="card-body">
            <div className="row-between">
              <h3>{insight.headline}</h3>
              <div className="row">
                <span className={`badge ${insight.health === 'Strong' ? 'badge-green' : insight.health === 'At risk' ? 'badge-red' : 'badge-amber'}`}>{insight.health}</span>
                <button className="btn-ghost btn-sm" onClick={() => setInsight(null)}>Dismiss</button>
              </div>
            </div>
            <div className="grid grid-2" style={{ marginTop: 8 }}>
              <div>
                <h4 className="muted">Strengths</h4>
                <ul className="small" style={{ marginTop: 4, paddingLeft: 18 }}>{insight.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
              <div>
                <h4 className="muted">Concerns</h4>
                <ul className="small" style={{ marginTop: 4, paddingLeft: 18 }}>{insight.concerns.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            </div>
            <p className="small" style={{ marginBottom: 0 }}><strong>Do this:</strong> {insight.recommended_action}</p>
          </div>
        </section>
      )}

      <div className="metrics">
        <div className="card stat"><div className="stat-label">Leads sourced</div><div className="stat-value">{partner.sourced_count}</div><div className="stat-sub">{partner.sourced_this_month} this month</div></div>
        <div className="card stat tone-good"><div className="stat-label">Converted</div><div className="stat-value">{partner.converted_count}</div><div className="stat-sub">{partner.sourced_count ? Math.round((partner.converted_count / partner.sourced_count) * 100) : 0}% conversion</div></div>
        <div className="card stat"><div className="stat-label">AUM attributed</div><div className="stat-value" style={{ fontSize: 19 }}>{money(partner.aum_attributed)}</div></div>
        <div className="card stat"><div className="stat-label">Commission (month)</div><div className="stat-value" style={{ fontSize: 19 }}>{rupees(partner.commission_month)}</div><div className="stat-sub">at {partner.commission_pct}%</div></div>
        <div className="card stat"><div className="stat-label">Partner RM</div><div className="stat-value" style={{ fontSize: 15 }}>{partner.owner_name || '—'}</div></div>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'onboarding' && (
        <div className="grid grid-2">
          <section className="card">
            <div className="card-head"><h2>Qualification & onboarding</h2><span className="tiny muted">{partner.steps_done}/{partner.steps_total}</span></div>
            <div className="card-body">
              <Progress pct={partner.steps_total ? Math.round((partner.steps_done / partner.steps_total) * 100) : 0} />
              <div className="stack" style={{ marginTop: 12 }}>
                {partner.steps.map((s) => (
                  <div key={s.code} className="row-between">
                    <span className="row">
                      <span className={`rail-dot ${s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : ''}`} style={{ width: 16, height: 16 }}>
                        {s.status === 'done' ? '✓' : ''}
                      </span>
                      <span className="small" style={{ opacity: s.status === 'pending' ? .6 : 1 }}>{s.label}</span>
                    </span>
                    {s.status === 'active' && can('partner.create') && (
                      <button className="btn-sm" onClick={() => act(() => api.post(`/partners/${id}/steps/${s.code}`))} disabled={busy}>Mark complete</button>
                    )}
                    {s.status === 'done' && <span className="tiny muted">{shortDate(s.completed_at)}</span>}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2>LMS training</h2></div>
            <table>
              <tbody>
                {partner.lms.map((m) => (
                  <tr key={m.module}>
                    <td>{m.module}</td>
                    <td className="num">
                      <span className={`badge ${m.status === 'Completed' ? 'badge-green' : m.status === 'In Progress' ? 'badge-amber' : ''}`}>{m.status}</span>
                    </td>
                    <td className="num small">{m.score ?? '—'}</td>
                    <td className="num">
                      {m.status !== 'Completed' && can('partner.create') && (
                        <button className="btn-sm" onClick={() => act(() => api.post(`/partners/${id}/lms/${encodeURIComponent(m.module)}`, { score: 85 }))} disabled={busy}>Mark done</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {tab === 'leads' && (
        <section className="card">
          {!partner.sourced_leads.length ? <Empty>No leads sourced yet.</Empty> : (
            <table>
              <thead><tr><th>Lead</th><th>Stage</th><th>Active products</th><th>Sourced</th></tr></thead>
              <tbody>
                {partner.sourced_leads.map((l) => (
                  <tr key={l.id}>
                    <td><Link to={`/leads/${l.id}`} style={{ color: 'var(--brand)', fontWeight: 570 }}>{l.name}</Link></td>
                    <td><span className="badge">{l.stage}</span></td>
                    <td className="small muted">{l.cards || '—'}</td>
                    <td className="small muted">{shortDate(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'commission' && (
        <section className="card">
          {!partner.commissions.length ? <Empty>No commission recorded.</Empty> : (
            <table>
              <thead><tr><th>Period</th><th>Product</th><th className="num">Gross</th><th className="num">Payout</th><th>Status</th></tr></thead>
              <tbody>
                {partner.commissions.map((c) => (
                  <tr key={c.id}>
                    <td>{c.period}</td>
                    <td className="small">{c.product_name || '—'}</td>
                    <td className="num">{rupees(c.gross)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{rupees(c.payout)}</td>
                    <td><span className={`badge ${c.status === 'Paid' ? 'badge-green' : ''}`}>{c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'activity' && (
        <section className="card">
          {!partner.activities.length ? <Empty>No activity logged.</Empty> : (
            <table>
              <tbody>
                {partner.activities.map((a) => (
                  <tr key={a.id}>
                    <td className="tiny muted" style={{ width: 130 }}>{dateTime(a.created_at)}</td>
                    <td style={{ width: 140 }}><span className="badge">{a.type}</span></td>
                    <td><div style={{ fontWeight: 545 }}>{a.subject}</div>{a.body && <div className="small muted">{a.body}</div>}</td>
                    <td className="small muted" style={{ width: 120 }}>{a.user_name || 'system'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'notes' && <PartnerNotes partner={partner} reload={reload} />}

      {tab === 'tickets' && (
        <section className="card">
          {!partner.tickets.length ? <Empty>No tickets raised by this partner.</Empty> : (
            <table>
              <tbody>
                {partner.tickets.map((t) => (
                  <tr key={t.id}>
                    <td style={{ width: 110 }}><Link to={`/tickets/${t.id}`} style={{ color: 'var(--brand)', fontWeight: 600 }}>{t.ref}</Link></td>
                    <td><div style={{ fontWeight: 545 }}>{t.subject}</div><div className="tiny muted" style={{ whiteSpace: 'pre-wrap' }}>{t.ai_summary}</div></td>
                    <td style={{ width: 120 }}><span className="badge">{t.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </>
  );
}

function PartnerNotes({ partner, reload }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <section className="card">
      <div className="card-body">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!body.trim()) return;
            setBusy(true);
            try { await api.post('/notes', { partner_id: partner.id, body }); setBody(''); reload(); }
            finally { setBusy(false); }
          }}
          style={{ marginBottom: 14 }}
        >
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Note — visible to Partner RM and Admin." />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn-primary" disabled={busy || !body.trim()}>{busy ? <Spinner /> : 'Add note'}</button>
          </div>
        </form>
        {!partner.notes.length ? <Empty>No notes.</Empty> : (
          <div className="stack">
            {partner.notes.map((n) => (
              <div key={n.id} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 12 }}>
                <div className="tiny muted">{n.user_name} · {dateTime(n.created_at)}</div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
