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

import { bandWidth, fitLabel } from './chartLayout.js';

/* --------------------------------------------------------- primitives */

const money = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${Math.round(v / 1e3)}k`;
  return `₹${v}`;
};

/**
 * The theme's accent at a given alpha, as a value an SVG attribute accepts.
 *
 * Reads the live custom property so it follows light and dark, and falls back
 * to the shipped green if the variable cannot be read — a chart with a
 * hard-coded colour is better than one with none.
 *
 * `color-mix()` is not an option here: it does not resolve inside an SVG
 * presentation attribute, and the failure is silent — the attribute is simply
 * ignored and the shape falls back to black.
 */
export function accentAlpha(alpha) {
  let raw = '';
  try { raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); } catch { /* no DOM */ }

  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = raw.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map((v) => parseFloat(v));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(82, 170, 110, ${alpha})`;
}

/**
 * The colour of the nth series, wherever series are drawn.
 *
 * One definition so a donut slice, a legend swatch and a stacked segment for
 * the same series cannot drift to different greens. The floor keeps the last
 * series visible: past roughly a quarter alpha it is indistinguishable from
 * the card behind it.
 */
export function seriesShade(i) {
  return accentAlpha(Math.max(0.28, 1 - i * 0.11));
}

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
  const H = height;
  const foot = 26;

  /* P2-17. The band is sized from the longest label, not fixed at 56px.
     The rule lives in chartLayout.js so it can be tested — a component that
     renders is not proof that two words do not collide. */
  const band = bandWidth(data.map((d) => d.label));
  const W = Math.max(data.length * band, 240);
  const bw = Math.min(band * 0.52, 34);
  const fit = (label) => fitLabel(label, band);

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
              <text x={x + bw / 2} y={H - 8} className="bar-label">{fit(d.label)}</text>
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

/* ------------------------------------------------- P2-17a chart types */

/**
 * Line and area, for a panel grouped by time.
 *
 * One component with a `filled` prop rather than two, because an area chart IS
 * a line chart with the region beneath it shaded — duplicating the geometry
 * would mean two places for the axis arithmetic to drift apart.
 *
 * Only every nth label is drawn. Fifty-two weekly labels along an axis overlap
 * into a grey smear, which is the same defect P2-17 fixed on the bar chart,
 * arriving from a different direction.
 */
export function LineChart({ data = [], height = 170, filled = false, format = (v) => v }) {
  if (!data.length) return <div className="chart-empty">Nothing to show yet</div>;
  if (data.length === 1) {
    // A line needs two points. One is a number, so say the number.
    return <div className="stat-value" style={{ fontSize: '1.6rem' }}>{format(data[0].value)}</div>;
  }

  const W = 520;
  const H = height;
  const pad = { top: 12, right: 10, bottom: 26, left: 40 };
  const max = Math.max(...data.map((d) => d.value), 1);
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const x = (i) => pad.left + (i * innerW) / (data.length - 1);
  const y = (v) => pad.top + innerH - (v / max) * innerH;

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;

  // Aim for about eight labels whatever the point count.
  const every = Math.max(1, Math.ceil(data.length / 8));

  return (
    <div className="chart-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${data.length} points`}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={pad.left} x2={W - pad.right}
            y1={pad.top + innerH * f} y2={pad.top + innerH * f} className="grid-line" />
        ))}
        <text x={pad.left - 6} y={pad.top + 4} className="axis-label" textAnchor="end">{format(max)}</text>
        <text x={pad.left - 6} y={pad.top + innerH} className="axis-label" textAnchor="end">0</text>

        {filled && <path d={area} className="area-fill" />}
        <path d={line} className="line-path" />

        {data.map((d, i) => (
          <circle key={d.label} cx={x(i)} cy={y(d.value)} r="2.5" className="line-dot">
            <title>{`${d.label}: ${format(d.value)}`}</title>
          </circle>
        ))}

        {data.map((d, i) => (i % every === 0 ? (
          <text key={`l-${d.label}`} x={x(i)} y={H - 8} className="bar-label" textAnchor="middle">
            {String(d.label).replace(/^\d{4}-/, '')}
          </text>
        ) : null))}
      </svg>
    </div>
  );
}

/**
 * Treemap, by slice-and-dice rather than squarified.
 *
 * Squarified layout produces better aspect ratios and needs a good deal more
 * code; with a cap of eight boxes the difference is not visible, and the simpler
 * algorithm is one somebody can read and check. Alternating the split direction
 * is what stops it degenerating into stripes.
 */
export function Treemap({ data = [], height = 170, format = (v) => v }) {
  if (!data.length) return <div className="chart-empty">Nothing to show yet</div>;

  const W = 520;
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return <div className="chart-empty">Nothing to show yet</div>;

  const boxes = [];
  const place = (items, x, y, w, h, horizontal) => {
    if (!items.length) return;
    if (items.length === 1) { boxes.push({ ...items[0], x, y, w, h }); return; }

    // Split the list where the running total passes half.
    const sum = items.reduce((s, d) => s + d.value, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < items.length; i += 1) {
      acc += items[i].value;
      if (acc >= sum / 2) { cut = i + 1; break; }
    }
    const headSum = items.slice(0, cut).reduce((s, d) => s + d.value, 0);
    const frac = headSum / sum;

    if (horizontal) {
      place(items.slice(0, cut), x, y, w * frac, h, !horizontal);
      place(items.slice(cut), x + w * frac, y, w * (1 - frac), h, !horizontal);
    } else {
      place(items.slice(0, cut), x, y, w, h * frac, !horizontal);
      place(items.slice(cut), x, y + h * frac, w, h * (1 - frac), !horizontal);
    }
  };
  place([...data].sort((a, b) => b.value - a.value), 0, 0, W, height, true);

  return (
    <div className="chart-scroll">
      <svg viewBox={`0 0 ${W} ${height}`} className="chart" role="img">
        {boxes.map((b, i) => (
          <g key={b.label}>
            <rect x={b.x + 1} y={b.y + 1} width={Math.max(0, b.w - 2)} height={Math.max(0, b.h - 2)}
              className={`treemap-box tone-${i % 6}`} rx="3">
              <title>{`${b.label}: ${format(b.value)}`}</title>
            </rect>
            {/* Only labelled when the box can hold the words. A truncated
                label on a small tile is noise; the tooltip still has it. */}
            {b.w > 64 && b.h > 26 && (
              <>
                <text x={b.x + 8} y={b.y + 18} className="treemap-label">{fitLabel(b.label, b.w - 12)}</text>
                <text x={b.x + 8} y={b.y + 33} className="treemap-value">{format(b.value)}</text>
              </>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

/**
 * Several series on one axis: grouped side by side, or stacked (P2-17a phase 2).
 *
 * One component with a `stacked` prop rather than two. The two differ only in
 * where each bar starts — grouped puts them next to each other, stacked puts
 * them on top — and duplicating the axis and scale arithmetic would give it two
 * places to drift apart.
 *
 * The scale differs, and that is the whole reason they are different charts:
 * grouped scales to the largest single value, because the reader compares one
 * bar with another; stacked scales to the largest column total, because the
 * reader compares wholes. Using one scale for both would make one of the two
 * silently wrong.
 */
export function MultiBar({
  data = [], series = [], stacked = false, height = 190, format = (v) => v, folded = 0,
}) {
  if (!data.length || !series.length) return <div className="chart-empty">Nothing to show yet</div>;

  const H = height;
  const foot = 30;
  const inner = H - foot;

  const max = stacked
    ? Math.max(...data.map((d) => series.reduce((s, k) => s + (d.values[k] ?? 0), 0)), 1)
    : Math.max(...data.flatMap((d) => series.map((k) => d.values[k] ?? 0)), 1);

  // Room for every series in a group, plus a gap between groups.
  const band = Math.max(stacked ? 56 : 22 * series.length + 26, bandWidth(data.map((d) => d.label)));
  const W = Math.max(data.length * band, 260);
  const barW = stacked ? Math.min(band * 0.5, 40) : Math.min((band - 18) / series.length, 22);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <ul className="legend legend-inline">
        {series.map((k, i) => (
          <li key={k}>
            <span className="swatch" style={{ background: seriesShade(i) }} />
            <span className="legend-label">{k}</span>
          </li>
        ))}
      </ul>

      <div className="chart-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
          {data.map((d, di) => {
            const x0 = di * band;
            let stackTop = inner;
            return (
              <g key={d.label}>
                {series.map((k, si) => {
                  const v = d.values[k] ?? 0;
                  const h = (v / max) * (inner - 8);
                  const x = stacked
                    ? x0 + (band - barW) / 2
                    : x0 + 9 + si * barW;
                  const y = stacked ? (stackTop -= h) : inner - h;
                  return (
                    <rect
                      key={k} x={x} y={y} width={Math.max(1, barW - (stacked ? 0 : 2))} height={Math.max(0, h)}
                      fill={seriesShade(si)} rx="2"
                    >
                      <title>{`${d.label} · ${k}: ${format(v)}`}</title>
                    </rect>
                  );
                })}
                <text x={x0 + band / 2} y={H - 9} className="bar-label" textAnchor="middle">
                  {fitLabel(d.label, band)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* The tail is summed rather than dropped, so the totals still match the
          same panel unsplit — but a reader deserves to be told it happened. */}
      {folded > 0 && (
        <p className="tiny muted" style={{ margin: 0 }}>
          {folded} smaller {folded === 1 ? 'value is' : 'values are'} summed into “Other”.
        </p>
      )}
    </div>
  );
}
