/**
 * Charts, drawn as inline SVG.
 *
 * No charting library. Three reasons, in order of weight:
 *
 *   1. This is a SEBI-regulated broker and client data must not leave India.
 *      A CDN-loaded chart library is an egress path and a supply-chain surface
 *      on the one screen that renders client numbers.
 *   2. Every chart here is a handful of paths. A 90KB dependency to draw six
 *      rectangles is a bad trade at any size.
 *   3. Charts that share the page's design tokens look like the page. Library
 *      defaults never quite do, and the gap is exactly what makes a dashboard
 *      look assembled rather than designed.
 *
 * Everything below takes its colour from CSS variables, so all of it follows
 * the light/dark switch without a second code path.
 */

/* --------------------------------------------------------- primitives */

const money = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${Math.round(v / 1e3)}k`;
  return `₹${v}`;
};

/** A rounded-rectangle path, so bars can have square feet and round shoulders. */
function topRounded(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y}
          L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr}
          L${x + w},${y + h} Z`;
}

/* ------------------------------------------------------------ sparkline */

/**
 * A trend line with a filled area under it.
 *
 * Sized by viewBox and stretched by CSS, so it fits whatever column it lands in
 * without measuring the DOM.
 */
export function Sparkline({ points = [], height = 56, tone = 'accent', showLast = true }) {
  const values = points.map((p) => (typeof p === 'object' ? p.value : p));
  if (values.length < 2) return <div className="chart-empty">Not enough history yet</div>;

  const W = 300;
  const H = height;
  const pad = 4;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const xy = values.map((v, i) => [
    pad + (i * (W - pad * 2)) / (values.length - 1),
    H - pad - ((v - min) / span) * (H - pad * 2),
  ]);

  // A monotone-ish curve: midpoint control points keep it smooth without
  // overshooting into impossible values, which a naive cubic will do.
  const line = xy.reduce((d, [x, y], i) => {
    if (i === 0) return `M${x},${y}`;
    const [px, py] = xy[i - 1];
    const mx = (px + x) / 2;
    return `${d} C${mx},${py} ${mx},${y} ${x},${y}`;
  }, '');

  const area = `${line} L${xy[xy.length - 1][0]},${H} L${xy[0][0]},${H} Z`;
  const id = `spark-${tone}-${values.length}-${Math.round(max)}`;

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Trend">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`var(--${tone})`} stopOpacity="0.28" />
          <stop offset="100%" stopColor={`var(--${tone})`} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={`var(--${tone})`} strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {showLast && (
        <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3"
          fill={`var(--${tone})`} stroke="var(--ground)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------ bar chart */

/** Vertical bars with a label and value per column. */
/**
 * `onPick` makes a value openable (P2-17c).
 *
 * Passed a datum rather than a URL so the caller decides what clicking means;
 * the chart's job is to say which bar, not where it goes. A datum without a
 * `to` is not interactive, and does not pretend to be — no pointer, no focus
 * stop, nothing to raise expectations the chart cannot meet.
 */
export function BarChart({ data = [], height = 160, tone = 'accent', format = (v) => v, onPick }) {
  if (!data.length) return <div className="chart-empty">Nothing to show yet</div>;

  const max = Math.max(...data.map((d) => d.value), 1);
  const W = Math.max(data.length * 56, 240);
  const H = height;
  const foot = 26;
  const band = W / data.length;
  const bw = Math.min(band * 0.52, 34);

  return (
    <div className="chart-scroll">
      <svg className="bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart"
        style={{ minWidth: W }}>
        {/* Gridlines first, so bars sit on top of them. */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={(H - foot) * (1 - f)} y2={(H - foot) * (1 - f)}
            stroke="var(--hairline)" strokeWidth="1" />
        ))}
        {data.map((d, i) => {
          const pickable = Boolean(onPick && d.to);
          const h = Math.max(((d.value / max) * (H - foot - 18)), d.value > 0 ? 3 : 0);
          const x = i * band + (band - bw) / 2;
          const y = H - foot - h;
          return (
            <g
              key={d.label}
              className={pickable ? 'is-pickable' : ''}
              role={pickable ? 'button' : undefined}
              tabIndex={pickable ? 0 : undefined}
              aria-label={pickable ? `${d.label}: ${format(d.value)} — open these records` : undefined}
              onClick={pickable ? () => onPick(d) : undefined}
              onKeyDown={pickable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(d); }
              } : undefined}
            >
              <title>{`${d.label}: ${format(d.value)}${pickable ? ' — click to open' : ''}`}</title>
              {/* A transparent hit area over the whole column: a 34px-wide bar
                  three pixels tall is not something anybody can click. */}
              {pickable && <rect x={i * band} y="0" width={band} height={H} fill="transparent" />}
              <path d={topRounded(x, y, bw, h, 5)} fill={`var(--${d.tone ?? tone})`} opacity={d.muted ? 0.4 : 1} />
              <text x={x + bw / 2} y={y - 6} className="bar-value">{format(d.value)}</text>
              <text x={x + bw / 2} y={H - 8} className="bar-label">{d.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ---------------------------------------------------------------- donut */

/**
 * A ring, with the headline number in the middle.
 *
 * Segments are stroke-dasharray on concentric circles rather than arc paths —
 * fewer trig mistakes, and the rounded linecap comes free.
 */
export function Donut({ segments = [], size = 150, thickness = 16, centre, caption }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;

  let offset = 0;
  const arcs = segments.map((s) => {
    const frac = total ? s.value / total : 0;
    const arc = { ...s, dash: frac * c, offset };
    offset += frac * c;
    return arc;
  });

  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Breakdown">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="var(--hairline)" strokeWidth={thickness} />
        {total > 0 && arcs.map((a) => (
          <circle key={a.label} cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={a.colour ?? `var(--${a.tone ?? 'accent'})`} strokeWidth={thickness}
            strokeDasharray={`${a.dash} ${c - a.dash}`}
            strokeDashoffset={-a.offset}
            strokeLinecap={a.dash > thickness * 1.5 ? 'round' : 'butt'}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <title>{`${a.label}: ${a.value}`}</title>
          </circle>
        ))}
        {centre != null && (
          <>
            <text x={size / 2} y={size / 2 - 1} className="donut-centre">{centre}</text>
            {caption && <text x={size / 2} y={size / 2 + 17} className="donut-caption">{caption}</text>}
          </>
        )}
      </svg>
      <ul className="legend">
        {segments.map((s) => (
          <li key={s.label}>
            <span className="swatch" style={{ background: s.colour ?? `var(--${s.tone ?? 'accent'})` }} />
            <span className="legend-label">{s.label}</span>
            <span className="legend-value">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- funnel */

/**
 * Stage-by-stage drop-off.
 *
 * Each row shows its own count and the conversion from the stage above it —
 * because "40 qualified" only means something next to "out of 120 contacted".
 */
export function Funnel({ stages = [], onPick }) {
  if (!stages.length) return <div className="chart-empty">No pipeline yet</div>;
  const top = Math.max(stages[0]?.value ?? 1, 1);

  return (
    <div className="funnel">
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1].value : null;
        const stepPct = prev ? Math.round((s.value / (prev || 1)) * 100) : null;
        return (
          <div
            key={s.label}
            className={`funnel-row ${onPick && s.to ? 'is-pickable' : ''}`}
            role={onPick && s.to ? 'button' : undefined}
            tabIndex={onPick && s.to ? 0 : undefined}
            aria-label={onPick && s.to ? `${s.label}: ${s.value} — open these records` : undefined}
            onClick={onPick && s.to ? () => onPick(s) : undefined}
            onKeyDown={onPick && s.to ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s); }
            } : undefined}
          >
            <div className="funnel-meta">
              <span className="funnel-label">{s.label}</span>
              <span className="funnel-value">{s.value}</span>
            </div>
            <div className="funnel-track">
              <div className="funnel-fill" style={{
                width: `${Math.max((s.value / top) * 100, s.value > 0 ? 2 : 0)}%`,
                background: `var(--${s.tone ?? 'accent'})`,
              }} />
            </div>
            {stepPct != null && (
              <span className={`funnel-step ${stepPct < 40 ? 'is-weak' : ''}`}>{stepPct}%</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- progress ring */

/** A single completion ring — used for KYC progress and onboarding. */
export function ProgressRing({ value = 0, total = 1, size = 96, thickness = 9, label }) {
  const pct = total ? Math.min(value / total, 1) : 0;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const tone = pct >= 1 ? 'ok' : pct >= 0.5 ? 'accent' : 'warn';

  return (
    <div className="ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${Math.round(pct * 100)}% complete`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hairline)" strokeWidth={thickness} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={`var(--${tone})`} strokeWidth={thickness} strokeLinecap="round"
          strokeDasharray={`${pct * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 0.5s cubic-bezier(0.22,1,0.36,1)' }} />
        <text x={size / 2} y={size / 2 + 1} className="ring-pct">{Math.round(pct * 100)}%</text>
        {label && <text x={size / 2} y={size / 2 + 16} className="ring-label">{label}</text>}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------ stat tile */

/**
 * One number, with room for a trend beneath it.
 *
 * The delta is deliberately not coloured by sign alone — for "open tickets" a
 * rise is bad, and a green up-arrow there would be actively misleading. The
 * caller says which direction is good.
 */
export function StatTile({ label, value, sub, trend, tone, icon, goodWhen = 'up' }) {
  const dir = trend == null ? null : trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat';
  const good = dir === 'flat' ? null : dir === goodWhen;

  return (
    <div className={`stat-tile glass ${tone ? `tone-${tone}` : ''}`}>
      {icon && <span className="material-symbols-rounded stat-icon">{icon}</span>}
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
      <div className="stat-tile-foot">
        {dir && (
          <span className={`delta ${good === null ? '' : good ? 'is-good' : 'is-bad'}`}>
            <span className="material-symbols-rounded">
              {dir === 'up' ? 'trending_up' : dir === 'down' ? 'trending_down' : 'trending_flat'}
            </span>
            {Math.abs(trend)}%
          </span>
        )}
        {sub && <span className="stat-tile-sub">{sub}</span>}
      </div>
    </div>
  );
}

export { money as compactMoney };
