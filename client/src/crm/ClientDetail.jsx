/**
 * A client account.
 *
 * The thing worth getting right here is the timeline. A client's history did
 * not begin at conversion — the calls that won the account sit on the lead, and
 * an RM opening the account expects to see them. So the server unions the two
 * (engine/clients.js) rather than copying rows across, and each entry says
 * which side of conversion it came from.
 *
 * That marker is not decoration. "Before the account opened" and "since" are
 * different conversations, and an RM reading a two-year history needs to know
 * which one they are looking at.
 */

import { useParams, Link, useNavigate } from 'react-router-dom';
import { rupees, rupeesCompact, shortDate, dateTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty } from '../components/ui.jsx';

const SEGMENT_BADGE = {
  Equity: 'badge-blue',
  Derivatives: 'badge-amber',
  Commodity: 'badge-red',
  Currency: 'badge-accent',
  'Mutual Fund': 'badge-green',
  Global: 'badge-accent',
};

const STATUS_BADGE = {
  Active: 'badge-green',
  Dormant: 'badge-amber',
  Suspended: 'badge-red',
  Closed: 'badge-red',
};

export default function ClientDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client, { loading, error }] = useApi(`/clients/${id}`, [id]);

  if (loading) return <Loading label="Loading account…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!client) return <Empty>That account does not exist, or you do not have access to it.</Empty>;

  const dormant = client.activity_status === 'Dormant';

  return (
    <div>
      <div className="page-head">
        <div>
          <button className="btn-ghost btn-sm" onClick={() => navigate('/clients')}>
            <Icon name="arrow_back" size={15} /> Clients
          </button>
          <h1 style={{ marginTop: 6 }}>{client.name}</h1>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="mono">{client.client_code}</span>
            <span className={`badge ${STATUS_BADGE[client.status] || ''}`}>{client.status}</span>
            {dormant && client.status === 'Active' && (
              <span className="badge badge-amber" title="No trade in the last 90 days">
                Dormant
              </span>
            )}
            <span className="badge">{client.sales_org}</span>
          </div>
        </div>
      </div>

      {/* Dormancy is the one thing on this page that asks for an action, so it
          gets said in words rather than left for someone to infer from a date. */}
      {dormant && client.status === 'Active' && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          <Icon name="schedule" size={17} />
          <span>
            No trade since {shortDate(client.last_traded_at) || 'the account opened'}.
            This account is still funded — worth a call before it closes.
          </span>
        </div>
      )}

      <div className="grid-auto" style={{ marginBottom: 18 }}>
        <div className="card stat">
          <div className="stat-label">Holdings</div>
          <div className="stat-value">{rupeesCompact(client.holding_value)}</div>
          <div className="stat-sub">{rupees(client.holding_value)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Brokerage YTD</div>
          <div className="stat-value">{rupeesCompact(client.brokerage_ytd)}</div>
          <div className="stat-sub">{client.trades_last_year} trades in 12 months</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Ledger balance</div>
          <div className="stat-value">{rupeesCompact(client.ledger_balance)}</div>
          <div className="stat-sub">{rupeesCompact(client.margin_available)} margin available</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Last trade</div>
          <div className="stat-value">{shortDate(client.last_traded_at) || '—'}</div>
          <div className="stat-sub">Opened {shortDate(client.activated_at)}</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Account</h2></div>
            <div className="card-body detail-grid">
              <div className="detail-item"><span className="tiny muted">UCC</span><div className="mono">{client.client_code}</div></div>
              <div className="detail-item"><span className="tiny muted">Demat / DP ID</span><div className="mono">{client.demat_id || '—'}</div></div>
              <div className="detail-item"><span className="tiny muted">PAN</span><div className="mono">{client.pan || '—'}</div></div>
              <div className="detail-item"><span className="tiny muted">Mobile</span><div>{client.mobile || '—'}</div></div>
              <div className="detail-item"><span className="tiny muted">Email</span><div>{client.email || '—'}</div></div>
              <div className="detail-item"><span className="tiny muted">Risk profile</span><div>{client.risk_profile || '—'}</div></div>
              <div className="detail-item"><span className="tiny muted">Nominee</span><div>{client.nominee_name || '—'}</div></div>
              <div className="detail-item"><span className="tiny muted">Owner</span><div>{client.owner_name || 'Unassigned'}</div></div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Segments</h2>
              <span className="tiny muted">{(client.segments ?? []).length} enabled</span>
            </div>
            <div className="card-body row wrap" style={{ gap: 6 }}>
              {(client.segments ?? []).length === 0 && <span className="muted">No segments enabled.</span>}
              {(client.segments ?? []).map((s) => (
                <span key={s.segment} className={`badge ${SEGMENT_BADGE[s.segment] || ''}`}
                  title={s.activated_at ? `Enabled ${shortDate(s.activated_at)}` : undefined}>
                  {s.segment}
                </span>
              ))}
            </div>
          </div>

          {/* Attribution. Long after nobody is working the lead, this is what
              answers "where did this client actually come from?". */}
          <div className="card">
            <div className="card-head"><h2>Origin</h2></div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {client.origin_lead ? (
                <>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="tiny muted">Converted from</span>
                    <Link to={`/leads/${client.origin_lead.id}`}>{client.origin_lead.name}</Link>
                    <span className="badge">{client.origin_lead.source || 'Unknown source'}</span>
                  </div>
                  <span className="tiny muted">
                    Enquired {shortDate(client.origin_lead.created_at)} · account opened {shortDate(client.activated_at)}
                  </span>
                </>
              ) : (
                <span className="muted">No originating lead recorded.</span>
              )}
              {client.partner_name && (
                <div className="row wrap" style={{ gap: 8 }}>
                  <span className="tiny muted">Sourced by partner</span>
                  <span>{client.partner_name}</span>
                </div>
              )}
              {client.open_cases > 0 && (
                <div className="row wrap" style={{ gap: 8 }}>
                  <span className="badge badge-amber">{client.open_cases} open case{client.open_cases === 1 ? '' : 's'}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Timeline</h2>
            <span className="tiny muted">{(client.timeline ?? []).length} entries, newest first</span>
          </div>
          <div className="card-body stack" style={{ gap: 0 }}>
            {(client.timeline ?? []).length === 0 && (
              <Empty>Nothing logged against this account yet.</Empty>
            )}
            {(client.timeline ?? []).map((a) => (
              <div key={`${a.origin}-${a.id}`} className="tl-item">
                <div className="tl-rail">
                  <span className={`tl-dot ${a.outcome === 'Connected' ? 'tl-dot-ok' : a.outcome === 'Not Connected' ? 'tl-dot-warn' : ''}`} />
                </div>
                <div style={{ minWidth: 0, paddingBottom: 16 }}>
                  <div className="row wrap" style={{ gap: 7 }}>
                    <span className={`badge ${a.ai_generated ? 'badge-accent' : ''}`}>{a.type}</span>
                    {/* Which side of conversion this happened on. */}
                    {a.origin === 'lead' && (
                      <span className="badge" title="Logged before the account was opened">
                        Pre-conversion
                      </span>
                    )}
                    <span className="tiny muted">· {dateTime(a.created_at)}</span>
                    {a.user_name && <span className="tiny muted">· {a.user_name}</span>}
                  </div>
                  {a.subject && <div style={{ marginTop: 4 }}>{a.subject}</div>}
                  {a.body && <div className="small muted" style={{ marginTop: 2 }}>{a.body}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
