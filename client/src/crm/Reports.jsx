/**
 * Reports & analytics.
 *
 * Every figure here is scoped by the API to what the signed-in role may see, so
 * a Sales Supervisor and an Admin open the same page and read different truths.
 * Nothing on this page is client PII — these are aggregates, and the only names
 * shown are staff on the leaderboard.
 *
 * The visual grammar is deliberately restrained: this is a page a supervisor
 * scans between calls, so the numbers carry the weight and colour is reserved
 * for the two things that need action — a breach and a stall.
 */

import { useState } from 'react';
import { useApi, Loading, ErrorBanner, Empty, Tabs } from '../components/ui.jsx';
import { rupees, rupeesCompact, ROLE_LABEL } from '../api.js';

const STATE_LABEL = {
  INACTIVE: 'Inactive',
  EXPLORING: 'Exploring',
  WARM: 'Warm',
  PRODUCT_RM_ENGAGED: 'RM engaged',
  KYC_IN_PROGRESS: 'KYC',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  LOST: 'Lost',
};

/** Colour follows the BRD's card semantics, not the brand palette. */
const STATE_CLASS = {
  EXPLORING: 'badge',
  WARM: 'badge-amber',
  PRODUCT_RM_ENGAGED: 'badge-blue',
  KYC_IN_PROGRESS: 'badge-blue',
  ACTIVE: 'badge-green',
  ON_HOLD: 'badge-amber',
  LOST: 'badge-red',
};

function Stat({ label, value, sub, tone }) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ''}`} style={{ fontSize: 26, fontWeight: 700, margin: '4px 0 2px' }}>
        {value}
      </div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

/** Proportional bar. Pure CSS — no chart library, nothing to load. */
function Bar({ segments, total }) {
  if (!total) return <div className="tiny muted">No data</div>;
  return (
    <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--surface-2, #eee)' }}>
      {segments.filter((s) => s.value > 0).map((s) => (
        <div
          key={s.key}
          title={`${s.label}: ${s.value}`}
          style={{ width: `${(s.value / total) * 100}%`, background: s.colour }}
        />
      ))}
    </div>
  );
}

const SEGMENT_COLOUR = {
  EXPLORING: '#9aa4b2',
  WARM: '#e0a63c',
  PRODUCT_RM_ENGAGED: '#4a83c4',
  KYC_IN_PROGRESS: '#6aa8e0',
  ACTIVE: '#81c141',
  ON_HOLD: '#c9a227',
  LOST: '#c4553d',
};

/* ------------------------------------------------------------- overview */

function Overview({ days }) {
  const [d, { loading, error }] = useApi(`/reports/overview?days=${days}`, [days]);
  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!d) return <Empty>No data.</Empty>;

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <Stat label="Leads" value={d.leads.total.toLocaleString('en-IN')} sub={`${d.leads.new_in_window} new in ${d.window_days} days`} />
        <Stat label="Cards in play" value={d.cards.in_play.toLocaleString('en-IN')} sub={`${d.cards.active} active · ${d.cards.lost} lost`} />
        <Stat
          label="Conversion"
          value={`${d.cards.conversion_pct}%`}
          sub="active ÷ everything that entered the funnel"
          tone={d.cards.conversion_pct >= 25 ? 'good' : undefined}
        />
        <Stat label="Active AUM" value={rupeesCompact(d.active_value)} sub={rupees(d.active_value)} />
        <Stat
          label="KYC completion"
          value={`${d.kyc.completion_pct}%`}
          sub={`${d.kyc.stalled} stalled · ${d.kyc.abandoned} abandoned`}
          tone={d.kyc.stalled + d.kyc.abandoned > 0 ? 'warn' : 'good'}
        />
        <Stat
          label="SLA breaches"
          value={d.tickets.breached.toLocaleString('en-IN')}
          sub={`${d.tickets.breach_pct}% of ${d.tickets.open} open tickets`}
          tone={d.tickets.breached > 0 ? 'bad' : 'good'}
        />
      </div>

      <p className="tiny muted" style={{ marginTop: 12 }}>
        Conversion counts only cards that actually entered the funnel. Every lead holds an inactive card for every
        product, so including those would make each product look like it converts at two percent.
      </p>
    </>
  );
}

/* --------------------------------------------------------------- funnel */

function Funnel() {
  const [d, { loading, error }] = useApi('/reports/funnel');
  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!d?.products?.length) return <Empty>No products yet.</Empty>;

  const stages = d.states.filter((s) => s !== 'INACTIVE');

  return (
    <section className="card">
      <div className="card-head">
        <h2>Pipeline by product</h2>
        <span className="tiny muted">The BRD OD-01 card states, per product</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th style={{ width: 190 }}>Mix</th>
            {stages.map((s) => <th key={s} className="num">{STATE_LABEL[s]}</th>)}
            <th className="num">Conv.</th>
            <th className="num">Active value</th>
          </tr>
        </thead>
        <tbody>
          {d.products.map((p) => (
            <tr key={p.product_id}>
              <td style={{ fontWeight: 545 }}>
                {p.name}
                <div className="tiny muted">
                  {p.engaged} engaged{p.largest_stage ? ` · most sit at ${STATE_LABEL[p.largest_stage]}` : ''}
                </div>
              </td>
              <td>
                <Bar
                  total={p.engaged}
                  segments={stages.map((s) => ({ key: s, label: STATE_LABEL[s], value: p.states[s], colour: SEGMENT_COLOUR[s] }))}
                />
              </td>
              {stages.map((s) => (
                <td key={s} className="num">
                  {p.states[s] > 0
                    ? <span className={`badge ${STATE_CLASS[s] || ''}`}>{p.states[s]}</span>
                    : <span className="muted">—</span>}
                </td>
              ))}
              <td className="num" style={{ fontWeight: 600 }}>{p.conversion_pct}%</td>
              <td className="num">{rupeesCompact(p.active_value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ----------------------------------------------------------------- team */

function Team({ days }) {
  const [d, { loading, error }] = useApi(`/reports/team?days=${days}`, [days]);
  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!d?.rows?.length) return <Empty>No owned leads in scope.</Empty>;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Team performance</h2>
        <span className="tiny muted">Ranked by active cards, not leads held</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Person</th><th>Role</th>
            <th className="num">Leads</th><th className="num">New</th>
            <th className="num">Active</th><th className="num">In play</th>
            <th className="num">Conv.</th><th className="num">Touches</th>
            <th className="num">Per lead</th><th className="num">AUM</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.id}>
              <td style={{ fontWeight: 545 }}>{r.name}</td>
              <td className="small muted">{ROLE_LABEL[r.role] || r.role}</td>
              <td className="num">{r.leads}</td>
              <td className="num">{r.new_leads}</td>
              <td className="num"><span className="badge badge-green">{r.active_cards}</span></td>
              <td className="num">{r.in_play_cards}</td>
              <td className="num" style={{ fontWeight: 600 }}>{r.conversion_pct}%</td>
              <td className="num">{r.touches}</td>
              <td className="num">
                {r.touches_per_lead < 1
                  ? <span className="badge badge-amber">{r.touches_per_lead}</span>
                  : r.touches_per_lead}
              </td>
              <td className="num">{rupeesCompact(r.aum)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>
        Ranked by active cards deliberately — ranking by leads held rewards hoarding, which is the opposite of
        what a broking desk wants. Fewer than one touch per lead in the window is flagged.
      </p>
    </section>
  );
}

/* --------------------------------------------------------- ageing & KYC */

function AgeingAndKyc() {
  const [ageing, { loading: l1 }] = useApi('/reports/ageing');
  const [kyc, { loading: l2 }] = useApi('/reports/kyc');
  if (l1 || l2) return <Loading />;

  const total = (ageing?.bands || []).reduce((s, b) => s + b.count, 0);

  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head"><h2>Lead ageing</h2><span className="tiny muted">and what has gone quiet</span></div>
        {!total ? <Empty>No leads in scope.</Empty> : (
          <table>
            <thead><tr><th>Band</th><th className="num">Leads</th><th className="num">No contact 14d</th><th /></tr></thead>
            <tbody>
              {ageing.bands.map((b) => (
                <tr key={b.band}>
                  <td style={{ fontWeight: 545 }}>{b.band}</td>
                  <td className="num">{b.count}</td>
                  <td className="num">
                    {b.untouched_14d > 0
                      ? <span className={`badge ${b.band === 'At Risk' || b.band === 'Cold' ? 'badge-red' : 'badge-amber'}`}>{b.untouched_14d}</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td style={{ width: 90 }}>
                    <Bar total={total} segments={[{ key: b.band, label: b.band, value: b.count, colour: '#4a83c4' }]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>KYC drop-off</h2>
          <span className="tiny muted">{kyc?.completion_pct ?? 0}% complete</span>
        </div>
        {!kyc?.stuck_at?.length ? <Empty>No journeys in progress.</Empty> : (
          <table>
            <thead><tr><th>Step where journeys are sitting</th><th className="num">Total</th><th className="num">Stalled</th><th className="num">Abandoned</th></tr></thead>
            <tbody>
              {kyc.stuck_at.map((s) => (
                <tr key={s.step}>
                  <td className="small" style={{ fontWeight: 545 }}>{s.step}</td>
                  <td className="num">{s.total}</td>
                  <td className="num">{s.stalled > 0 ? <span className="badge badge-amber">{s.stalled}</span> : '—'}</td>
                  <td className="num">{s.abandoned > 0 ? <span className="badge badge-red">{s.abandoned}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>
          Counts where journeys are <em>sitting</em>, not how many passed each step. Completions per step flatter the
          journey; this shows the cliff.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ SLA */

function Sla() {
  const [d, { loading, error }] = useApi('/reports/sla');
  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const Table = ({ title, rows, keyName }) => (
    <section className="card">
      <div className="card-head"><h2>{title}</h2></div>
      {!rows?.length ? <Empty>No tickets yet.</Empty> : (
        <table>
          <thead>
            <tr>
              <th>{keyName === 'category' ? 'Category' : 'Priority'}</th>
              <th className="num">Tickets</th><th className="num">Breached</th><th className="num">Breach %</th>
              {keyName === 'category' && <th className="num">Mean hrs to resolve</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[keyName]}>
                <td style={{ fontWeight: 545 }}>{r[keyName]}</td>
                <td className="num">{r.total}</td>
                <td className="num">{r.breached || '—'}</td>
                <td className="num">
                  <span className={`badge ${r.breach_pct === 0 ? 'badge-green' : r.breach_pct < 20 ? 'badge-amber' : 'badge-red'}`}>
                    {r.breach_pct}%
                  </span>
                </td>
                {keyName === 'category' && <td className="num">{r.mean_hours_to_resolve ?? '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );

  return (
    <div className="grid grid-2">
      <Table title="SLA by category" rows={d?.by_category} keyName="category" />
      <Table title="SLA by priority" rows={d?.by_priority} keyName="priority" />
    </div>
  );
}

/* ------------------------------------------------------------- partners */

function PartnerReport() {
  const [d, { loading, error }] = useApi('/reports/partners');
  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!d?.rows?.length) return <Empty>No partners yet.</Empty>;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Partner performance</h2>
        <span className="tiny muted">Last {d.window_days} days</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Partner</th><th>Model</th><th>State</th>
            <th className="num">Sourced</th><th className="num">In window</th>
            <th className="num">Converted</th><th className="num">Conv.</th><th className="num">Commission</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((p) => (
            <tr key={p.id}>
              <td style={{ fontWeight: 545 }}>{p.name}<div className="tiny muted">{p.partner_code}</div></td>
              <td className="small muted">{p.partner_model || '—'}</td>
              <td>
                <span className={`badge ${p.state_code === 'ACTIVE' ? 'badge-green' : p.state_code === 'SUSPENDED' ? 'badge-red' : ''}`}>
                  {p.state_code}
                </span>
              </td>
              <td className="num">{p.sourced}</td>
              <td className="num">{p.sourced_in_window}</td>
              <td className="num">{p.converted}</td>
              <td className="num" style={{ fontWeight: 600 }}>{p.conversion_pct}%</td>
              <td className="num">{rupees(p.commission)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------- activity */

function Activity({ days }) {
  const [d, { loading, error }] = useApi(`/reports/activity?days=${days}`, [days]);
  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!d?.rows?.length) return <Empty>No contact activity in the window.</Empty>;

  const byDay = new Map();
  for (const r of d.rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, total: 0, types: {} });
    const entry = byDay.get(r.day);
    entry.types[r.type] = r.n;
    entry.total += r.n;
  }
  const rows = [...byDay.values()];
  const peak = Math.max(...rows.map((r) => r.total), 1);
  const types = [...new Set(d.rows.map((r) => r.type))];
  const colour = { Call: '#4a83c4', WhatsApp: '#81c141', Email: '#9aa4b2', SMS: '#e0a63c', Meeting: '#6f5bd0' };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Contact volume</h2>
        <span className="tiny muted">Last {d.window_days} days · {types.join(' · ')}</span>
      </div>
      <table>
        <thead><tr><th>Day</th><th style={{ width: '55%' }} /><th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day}>
              <td className="small">{new Date(`${r.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td>
              <td>
                <div style={{ width: `${(r.total / peak) * 100}%`, minWidth: 2 }}>
                  <Bar total={r.total} segments={types.map((t) => ({ key: t, label: t, value: r.types[t] || 0, colour: colour[t] || '#999' }))} />
                </div>
              </td>
              <td className="num">{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ----------------------------------------------------------------- page */

export default function Reports({ session }) {
  const has = (p) => session.permissions.includes(p);
  const [days, setDays] = useState(30);

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'funnel', label: 'Pipeline' },
    { key: 'team', label: 'Team' },
    { key: 'ageing', label: 'Ageing & KYC' },
    { key: 'sla', label: 'SLA' },
    // partner.view, not report.system: the report is scoped per role on the
    // server, so the roles whose work it describes can open it.
    has('partner.view') && { key: 'partners', label: 'Partners' },
    { key: 'activity', label: 'Activity' },
  ].filter(Boolean);

  const [tab, setTab] = useState(tabs[0].key);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p>Scoped to what your role can see — a supervisor reads their team, an administrator reads the firm.</p>
        </div>
        <div>
          <label className="tiny muted" htmlFor="report-window" style={{ marginRight: 8 }}>Window</label>
          <select id="report-window" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>1 year</option>
          </select>
        </div>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'overview' && <Overview days={days} />}
      {tab === 'funnel' && <Funnel />}
      {tab === 'team' && <Team days={days} />}
      {tab === 'ageing' && <AgeingAndKyc />}
      {tab === 'sla' && <Sla />}
      {tab === 'partners' && <PartnerReport />}
      {tab === 'activity' && <Activity days={days} />}
    </>
  );
}
