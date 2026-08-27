/**
 * KRA scorecard.
 *
 * The number at the top is only honest if it says what it covers. A metric the
 * CRM cannot measure yet is shown as unmeasured rather than scored zero —
 * counting a missing feed as a failure would punish somebody for an integration
 * nobody has connected, and it is the fastest way to make a scorecard ignored.
 *
 * The targets shipped here are a worked example. They are meant to be replaced
 * with the business's real figures, and the page says so rather than presenting
 * placeholders as policy.
 */

import { useSearchParams } from 'react-router-dom';
import { rupees, rupeesCompact } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Segmented } from '../components/ui.jsx';

const fmt = (v, unit) => {
  if (v == null) return '—';
  if (unit === 'rupees') return rupeesCompact(v);
  if (unit === 'percent') return `${v}%`;
  return Number(v).toLocaleString('en-IN');
};

const tone = (score) => {
  if (score == null) return '';
  if (score >= 90) return 'tone-good';
  if (score >= 60) return 'tone-warn';
  return 'tone-bad';
};

export default function Kra() {
  const [search, setSearch] = useSearchParams();
  const range = search.get('range') || 'mtd';
  const [d, { loading, error }] = useApi(`/kra?range=${encodeURIComponent(range)}`, [range]);

  const setRange = (code) => {
    const next = new URLSearchParams(search);
    if (code === 'mtd') next.delete('range'); else next.set('range', code);
    setSearch(next, { replace: true });
  };

  if (loading && !d) return <Loading label="Scoring your month…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!d) return null;

  if (d.metrics.length === 0) {
    return (
      <div>
        <div className="page-head"><div><h1>KRA Scorecard</h1></div></div>
        <Empty>No KRA metrics are configured for your role yet. An administrator can add them in Setup.</Empty>
      </div>
    );
  }

  const partial = d.coverage.measured < d.coverage.total;

  return (
    <div>
      <div className="row-between wrap" style={{ marginBottom: 14, gap: 12 }}>
        <div>
          <h1>KRA Scorecard</h1>
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

      <div className="grid-auto" style={{ marginBottom: 16 }}>
        <div className={`card stat ${tone(d.overall)}`}>
          <div className="stat-label">Overall</div>
          <div className="stat-value">{d.overall == null ? '—' : `${d.overall}%`}</div>
          <div className="stat-sub">
            {/* The caveat travels with the number, not in a footnote. */}
            {partial
              ? `Over ${d.coverage.weight_covered} of ${d.coverage.weight_total} points — the rest cannot be measured yet`
              : 'Across every metric on your card'}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Measured</div>
          <div className="stat-value">{d.coverage.measured}/{d.coverage.total}</div>
          <div className="stat-sub">Metrics with live data behind them</div>
        </div>
      </div>

      {partial && (
        <div className="notice notice-warn" style={{ marginBottom: 14 }}>
          <Icon name="info" size={17} />
          <span>
            Some metrics have nothing to measure against yet. They are left out
            of the score rather than counted as zero — a missing feed is not a
            missed target.
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2 style={{ fontSize: 15 }}>Your measures</h2>
          <span className="tiny muted">Weighted to {d.coverage.weight_total} points</span>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Measure</th><th className="num">Target</th><th className="num">Actual</th>
                <th className="num">Weight</th><th>Score</th>
              </tr>
            </thead>
            <tbody>
              {d.metrics.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div>{m.label}</div>
                    <div className="small muted">
                      {m.description}
                      {m.direction === 'lower' && ' · lower is better'}
                    </div>
                  </td>
                  <td className="num">{fmt(m.target, m.unit)}</td>
                  <td className="num">
                    {m.measurable
                      ? fmt(m.actual, m.unit)
                      : <span className="muted" title={m.reason}>—</span>}
                  </td>
                  <td className="num">{m.weight}</td>
                  <td>
                    {m.score == null
                      ? <span className="tiny muted">{m.reason}</span>
                      : (
                        <div className="row" style={{ gap: 7 }}>
                          <div className="kra-bar" aria-hidden>
                            <span className={tone(m.score)} style={{ width: `${m.score}%` }} />
                          </div>
                          <span className="small">{m.score}%</span>
                        </div>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body">
          <p className="tiny muted" style={{ margin: 0 }}>
            These targets ship as a worked example. Replace them with the real
            figures in Setup — the shape is right, the numbers are a placeholder.
          </p>
        </div>
      </div>
    </div>
  );
}
