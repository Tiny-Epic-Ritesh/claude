/**
 * Clients — the account book.
 *
 * Deliberately not a second Leads screen. A lead list answers "who should I
 * call next"; this answers "how is this account doing" — so the columns are
 * UCC, segments, holdings and last trade, and the tile that matters most is
 * Dormant. A dormant account is revenue already won and quietly leaving, and
 * it is the number nobody notices until something puts it in front of them.
 *
 * Every tile is a link into this same list, filtered (Q-05).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { rupeesCompact, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Stat } from '../components/ui.jsx';

/** Stable colours so the eye learns a segment across rows. */
const SEGMENT_BADGE = {
  Equity: 'badge-blue',
  Derivatives: 'badge-amber',
  Commodity: 'badge-red',
  Currency: 'badge-accent',
  'Mutual Fund': 'badge-green',
  Global: 'badge-accent',
};

export default function Clients() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();

  // Filters live in the URL, so a drill-through arrives already filtered and
  // the filtered view stays shareable and survives a refresh.
  const filters = useMemo(() => ({
    q: search.get('q') ?? '',
    status: search.get('status') ?? '',
    segment: search.get('segment') ?? '',
    dormant: search.get('dormant') ?? '',
  }), [search]);

  // The search box needs to keep up with typing without refetching per key.
  const [typed, setTyped] = useState(filters.q);
  useEffect(() => { setTyped(filters.q); }, [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (typed === filters.q) return;
      const next = new URLSearchParams(search);
      if (typed) next.set('q', typed); else next.delete('q');
      setSearch(next, { replace: true });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    p.set('limit', '200');
    return p.toString();
  }, [filters]);

  const [rows, { loading, error }] = useApi(`/clients?${query}`, [query]);
  const [summary] = useApi('/clients/summary');
  const [meta] = useApi('/clients/meta');

  const setFilter = (key, value) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    setSearch(next, { replace: true });
  };

  const applied = Object.entries(filters).filter(([, v]) => v);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <p className="muted">
            Live accounts — a UCC, a ledger and a trading history. Prospects live in Leads.
          </p>
        </div>
      </div>

      {summary && (
        <div className="grid-auto" style={{ marginBottom: 18 }}>
          <Stat label="Accounts" value={summary.total ?? 0} to="/clients"
            sub={`${summary.opened_this_month ?? 0} opened this month`} />
          <Stat label="Trading" value={summary.active ?? 0} tone="good" to="/clients"
            sub="Traded in the last 90 days" />
          <Stat label="Dormant" value={summary.dormant ?? 0} tone="warn"
            to="/clients?dormant=true" sub="No trade in 90 days — worth a call" />
          <Stat label="Holdings" value={rupeesCompact(summary.holding_value)}
            sub={`${rupeesCompact(summary.brokerage_ytd)} brokerage YTD`} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 240px' }}>
            <label htmlFor="client-q">Search</label>
            <input id="client-q" placeholder="Name, UCC, mobile or email"
              value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="client-segment">Segment</label>
            <select id="client-segment" value={filters.segment}
              onChange={(e) => setFilter('segment', e.target.value)}>
              <option value="">All segments</option>
              {(meta?.segments ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="client-status">Status</label>
            <select id="client-status" value={filters.status}
              onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Any status</option>
              {(meta?.statuses ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* The applied filter is always visible and always removable. A list
            that is silently filtered reads as a bug — "where did my other
            accounts go?" (Q-05). */}
        {applied.length > 0 && (
          <div className="card-body row wrap" style={{ gap: 6, paddingTop: 0 }}>
            <span className="tiny muted">Filtered by</span>
            {applied.map(([k, v]) => (
              <button key={k} type="button" className="chip chip-active"
                onClick={() => setFilter(k, '')}
                title="Remove this filter">
                {k === 'dormant' ? 'No trade in 90 days' : `${k}: ${v}`}
                <Icon name="close" size={13} />
              </button>
            ))}
          </div>
        )}
      </div>

      <ErrorBanner error={error} />
      {loading && <Loading label="Loading accounts…" />}

      {!loading && rows && rows.length === 0 && (
        <Empty>
          {applied.length
            ? 'No accounts match these filters. Try removing one above.'
            : 'No accounts yet. A client appears here once a lead converts and a UCC is issued.'}
        </Empty>
      )}

      {!loading && rows && rows.length > 0 && (
        <div className="card">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>UCC</th>
                  <th>Segments</th>
                  <th className="num">Holdings</th>
                  <th className="num">Brokerage YTD</th>
                  <th>Last trade</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="row-link" onClick={() => navigate(`/clients/${c.id}`)}>
                    <td>
                      <div>{c.name}</div>
                      <div className="small muted">{c.mobile}</div>
                    </td>
                    <td className="mono">{c.client_code}</td>
                    <td>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {(c.segments ?? []).map((s) => (
                          <span key={s} className={`badge ${SEGMENT_BADGE[s] || ''}`}>{s}</span>
                        ))}
                      </div>
                    </td>
                    <td className="num">{rupeesCompact(c.holding_value)}</td>
                    <td className="num">{rupeesCompact(c.brokerage_ytd)}</td>
                    <td>
                      {c.activity_status === 'Dormant' ? (
                        <span className="badge badge-amber" title={`${c.days_since_trade} days since last trade`}>
                          Dormant · {c.days_since_trade}d
                        </span>
                      ) : (
                        <span className="muted">{shortDate(c.last_traded_at)}</span>
                      )}
                    </td>
                    <td className="muted">{c.owner_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
