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

import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, Icon, Loading, ErrorBanner, Segmented } from '../components/ui.jsx';
import { Funnel, BarChart, Donut } from '../components/charts.jsx';

const TONE_CLASS = { good: 'tone-good', warn: 'tone-warn', bad: 'tone-bad' };

export default function Dashboard({ embedded = false }) {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const range = search.get('range') || 'mtd';

  /* P2-16. The window lives in the URL, not in component state.
   *
   * A date range somebody has picked is worth being able to send to a
   * colleague, and it should survive a refresh. Keeping it here also means the
   * tiles' drill-through carries the same window, because the server builds
   * each destination from the range it was asked for. */
  const from = search.get('from') || '';
  const to = search.get('to') || '';

  const query = range === 'custom' && from && to
    ? `/dashboard?range=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    : `/dashboard?range=${encodeURIComponent(range)}`;

  const [data, { loading, error }] = useApi(query, [range, from, to]);

  const setRange = (code) => {
    const next = new URLSearchParams(search);
    if (code === 'mtd') next.delete('range'); else next.set('range', code);

    if (code === 'custom') {
      /* Open on the month so far rather than on two empty boxes. An empty
         custom range would ask the server for nothing and show a dashboard of
         zeroes, which reads as "no data" rather than "pick a date". */
      if (!next.get('from')) next.set('from', data?.range?.from ?? '');
      if (!next.get('to')) next.set('to', data?.range?.to ?? '');
    } else {
      next.delete('from');
      next.delete('to');
    }
    setSearch(next, { replace: true });
  };

  const setBound = (which) => (e) => {
    const next = new URLSearchParams(search);
    next.set('range', 'custom');
    next.set(which, e.target.value);
    // Keep the pair in order rather than refusing it: dragging the start past
    // the end is a normal thing to do on the way to picking both.
    const f = which === 'from' ? e.target.value : next.get('from');
    const t = which === 'to' ? e.target.value : next.get('to');
    if (f && t && f > t) next.set(which === 'from' ? 'to' : 'from', e.target.value);
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
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <Segmented
            value={data.range.code}
            onChange={setRange}
            options={(data.ranges ?? []).map((r) => ({
              value: r.code,
              label: {
                today: 'Today', mtd: 'Month', qtd: 'Quarter', fytd: 'FY', custom: 'Custom',
              }[r.code] ?? r.label,
            }))} />

          {data.range.code === 'custom' && (
            <div className="custom-range">
              <label>
                <span className="tiny muted">From</span>
                <input type="date" value={from} max={to || undefined} onChange={setBound('from')} />
              </label>
              <label>
                <span className="tiny muted">To</span>
                <input type="date" value={to} min={from || undefined} onChange={setBound('to')} />
              </label>
            </div>
          )}
        </div>
      </div>

      {/* P2-17d. A panel that failed to build used to vanish, leaving a tidy
          dashboard with a hole in it — the same reader drawing the same
          conclusion from less information, without knowing any was missing.
          Named rather than counted: "2 panels failed" is not something anybody
          can act on. */}
      {data.broken && (
        <div className="glass notice notice-warn" style={{ marginBottom: 14 }}>
          <Icon name="warning" size={16} />
          <div>
            Some figures could not be calculated and are missing from this page:{' '}
            <strong>{data.broken.join(', ')}</strong>. Everything else here is current.
          </div>
        </div>
      )}

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
                {/* P2-17c: a number on a chart opens the records behind it,
                    the same promise the tiles make. */}
                {c.kind === 'funnel' && <Funnel stages={c.stages} onPick={(d) => navigate(d.to)} />}
                {c.kind === 'bar' && <BarChart data={c.data} onPick={(d) => navigate(d.to)} />}
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
