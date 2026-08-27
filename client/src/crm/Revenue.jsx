/**
 * Revenue Board.
 *
 * What the book has earned, and — the part worth opening it twice for — what it
 * plausibly could. Existing clients not holding a product they should is the
 * cheapest revenue in the business, and nothing else in the CRM surfaces it.
 *
 * Everything is scoped to the reader, which is what made it safe to give an RM
 * this tab at all: the question was never whether they should see revenue, only
 * whose.
 */

import { useNavigate, useSearchParams } from 'react-router-dom';
import { rupees, rupeesCompact } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Segmented } from '../components/ui.jsx';
import { BarChart } from '../components/charts.jsx';

export default function Revenue() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const range = search.get('range') || 'mtd';
  const [d, { loading, error }] = useApi(`/revenue?range=${encodeURIComponent(range)}`, [range]);

  const setRange = (code) => {
    const next = new URLSearchParams(search);
    if (code === 'mtd') next.delete('range'); else next.set('range', code);
    setSearch(next, { replace: true });
  };

  if (loading && !d) return <Loading label="Adding it up…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!d) return null;

  const chart = d.by_product.slice(0, 8).map((p) => ({ label: p.name, value: p.value }));

  return (
    <div>
      <div className="row-between wrap" style={{ marginBottom: 14, gap: 12 }}>
        <div>
          <h1>Revenue</h1>
          <span className="tiny muted">{d.range.label} · {d.range.from} to {d.range.to}</span>
        </div>
        <Segmented
          value={d.range.code}
          onChange={setRange}
          options={d.ranges.filter((r) => r.code !== 'custom').map((r) => ({
            value: r.code,
            label: { today: 'Today', mtd: 'Month', qtd: 'Quarter', fytd: 'FY' }[r.code] ?? r.label,
          }))} />
      </div>

      <div className="grid-auto" style={{ marginBottom: 18 }}>
        <div className="card stat tone-good">
          <div className="stat-label">Active book value</div>
          <div className="stat-value">{rupeesCompact(d.earned.active_value)}</div>
          <div className="stat-sub">{rupees(d.earned.active_value)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Brokerage YTD</div>
          <div className="stat-value">{rupeesCompact(d.earned.brokerage_ytd)}</div>
          <div className="stat-sub">{d.earned.accounts} account{d.earned.accounts === 1 ? '' : 's'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Accounts opened</div>
          <div className="stat-value">{d.earned.opened_in_range}</div>
          <div className="stat-sub">
            {d.earned.opened_trend != null && (
              <span className={`delta ${d.earned.opened_trend >= 0 ? 'is-good' : 'is-bad'}`}>
                <Icon name={d.earned.opened_trend >= 0 ? 'trending_up' : 'trending_down'} size={13} />
                {Math.abs(d.earned.opened_trend)}%
              </span>
            )}
            {' '}{d.range.label.toLowerCase()}
          </div>
        </div>
        {d.rank && (
          <div className="card stat">
            <div className="stat-label">Among your peers</div>
            <div className="stat-value">#{d.rank.position}</div>
            <div className="stat-sub">of {d.rank.of} in your role</div>
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Where the value sits</h2>
            <span className="tiny muted">Active products, by value</span>
          </div>
          <div className="card-body">
            {chart.length === 0
              ? <Empty>Nothing active yet.</Empty>
              : <BarChart data={chart} height={180} format={rupeesCompact} />}
          </div>
        </div>

        {/* The reason to open this page a second time. */}
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Worth opening</h2>
            <span className="tiny muted">Clients who hold something, but not this</span>
          </div>
          {d.untapped.length === 0
            ? <Empty>Every client already holds everything they could.</Empty>
            : (
              <div className="card-body stack" style={{ gap: 8 }}>
                <p className="tiny muted" style={{ margin: 0 }}>
                  Each of these already trusts you with one product. That is the
                  cheapest conversation in the business.
                </p>
                {d.untapped.map((u) => (
                  <button key={u.id} type="button" className="row-between module-row is-clickable"
                    onClick={() => navigate(`/leads?product_id=${u.id}&card_state=INACTIVE`)}>
                    <span className="row" style={{ gap: 8 }}>
                      <Icon name="lightbulb" size={16} />
                      <span>{u.name}</span>
                    </span>
                    <span className="badge badge-green">{u.opportunity} client{u.opportunity === 1 ? '' : 's'}</span>
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head"><h2 style={{ fontSize: 15 }}>By product</h2></div>
        {d.by_product.length === 0 ? <Empty>No active products yet.</Empty> : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Product</th><th>Category</th><th className="num">Active</th><th className="num">Value</th></tr>
              </thead>
              <tbody>
                {d.by_product.map((p) => (
                  <tr key={p.id} className="row-link"
                    onClick={() => navigate(`/products?open=${p.id}`)}>
                    <td>{p.name}</td>
                    <td className="muted">{p.category || '—'}</td>
                    <td className="num">{p.active_cards}</td>
                    <td className="num">{rupeesCompact(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
