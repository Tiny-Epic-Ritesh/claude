/**
 * The Dashboard (ENH-24).
 *
 * Placement (ENH-24b): this renders on the homepage, which was the stated
 * preference, and the same component also backs the /dashboards tab. One
 * implementation, two doors — rather than two dashboards that drift apart.
 *
 * Every tile is a link. The server decides where each one goes, because it is
 * the side that knows what the figure counted; the client guessing the filter
 * is how a tile ends up drilling through to a different number than it showed.
 *
 * Tiles that need attention today are sorted first and toned, because a
 * dashboard where the urgent figure sits fourth gets skimmed rather than acted
 * on.
 */

import { Link, useSearchParams } from 'react-router-dom';
import { useApi, Icon, Loading, ErrorBanner, Segmented } from '../components/ui.jsx';
import { Funnel, BarChart, Donut } from '../components/charts.jsx';

const TONE_CLASS = { good: 'tone-good', warn: 'tone-warn', bad: 'tone-bad' };

export default function Dashboard({ embedded = false }) {
  const [search, setSearch] = useSearchParams();
  const range = search.get('range') || 'mtd';

  const [data, { loading, error }] = useApi(`/dashboard?range=${encodeURIComponent(range)}`, [range]);

  const setRange = (code) => {
    const next = new URLSearchParams(search);
    if (code === 'mtd') next.delete('range'); else next.set('range', code);
    setSearch(next, { replace: true });
  };

  if (error) return <ErrorBanner error={error} />;
  if (loading && !data) return <Loading label="Building your dashboard…" />;
  if (!data) return null;

  return (
    <section>
      <div className="row-between wrap" style={{ marginBottom: 14, gap: 12 }}>
        <div>
          {!embedded && <h1>Dashboard</h1>}
          {embedded && <h2 style={{ margin: 0, fontSize: 18 }}>Your numbers</h2>}
          <span className="tiny muted">
            {data.range.label} · {data.range.from} to {data.range.to}
          </span>
        </div>

        {/* Range picker, on the existing segmented control rather than a new
            one. Financial year runs April to March, so FY means what the
            business means by it. */}
        <Segmented
          value={data.range.code}
          onChange={setRange}
          options={(data.ranges ?? [])
            .filter((r) => r.code !== 'custom')
            .map((r) => ({
              value: r.code,
              label: { today: 'Today', mtd: 'Month', qtd: 'Quarter', fytd: 'FY' }[r.code] ?? r.label,
            }))} />
      </div>

      <div className="grid-auto" style={{ marginBottom: 18 }}>
        {data.tiles.map((t) => {
          const body = (
            <>
              <div className="stat-label">
                {t.alert && <Icon name="priority_high" size={14} className="stat-alert" />}
                {t.label}
              </div>
              <div className="stat-value">
                {t.value}
                {t.to && <Icon name="arrow_forward" size={15} className="stat-go" />}
              </div>
              <div className="stat-sub">
                {t.trend != null && (
                  <span className={`delta ${(t.trend > 0) === (t.goodWhen === 'up') ? 'is-good' : 'is-bad'}`}>
                    <Icon name={t.trend > 0 ? 'trending_up' : t.trend < 0 ? 'trending_down' : 'trending_flat'} size={13} />
                    {Math.abs(t.trend)}%
                  </span>
                )}
                {t.sub}
              </div>
            </>
          );

          const cls = `card stat ${TONE_CLASS[t.tone] ?? ''} ${t.to ? 'is-linked' : ''}`;
          return t.to
            ? <Link key={t.label} to={t.to} className={cls}>{body}</Link>
            : <div key={t.label} className={cls}>{body}</div>;
        })}
      </div>

      {data.charts.length > 0 && (
        <div className="grid-2">
          {data.charts.map((c) => (
            <div key={c.title} className="card">
              <div className="card-head"><h2 style={{ fontSize: 15 }}>{c.title}</h2></div>
              <div className="card-body">
                {c.kind === 'funnel' && <Funnel stages={c.stages} />}
                {c.kind === 'bar' && <BarChart data={c.data} />}
                {c.kind === 'donut' && (
                  <Donut
                    segments={c.data.map((d, i) => ({ ...d, colour: DONUT_COLOURS[i % DONUT_COLOURS.length] }))}
                    centre={c.data.reduce((s, d) => s + d.value, 0)}
                    caption="active" />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const DONUT_COLOURS = [
  'var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--info)', 'var(--ink-3)', 'var(--hairline)',
];
