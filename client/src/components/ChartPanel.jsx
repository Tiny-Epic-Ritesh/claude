/**
 * A chart with its own type switcher (P2-17a).
 *
 * WHY THE SWITCHER ONLY OFFERS SOME TYPES
 *
 * The feedback asks for "whichever are applicable to the data being displayed",
 * so applicability is computed rather than left to the reader. A pie chart of a
 * time series is not a choice, it is a trap; a donut of an average does not add
 * up to anything, so part-to-whole types are offered only for counts. The rule
 * lives on the server in panels.js — one implementation, so the builder and the
 * viewer cannot disagree about what a panel may be shown as.
 *
 * WHERE THE CHOICE IS KEPT
 *
 * On a custom panel the owner's choice is saved, because it is their panel. On
 * the fixed role dashboard the reader does not own the panel, so the choice
 * lives in this component and lasts as long as they are looking — changing how
 * a shared figure is drawn for everybody is not a thing a reader should do by
 * clicking a chart.
 */

import { useState } from 'react';
import { BarChart, Donut, LineChart, Treemap } from './charts.jsx';
import { Icon } from './ui.jsx';

const ICON = {
  bar: 'bar_chart',
  line: 'show_chart',
  area: 'area_chart',
  donut: 'donut_small',
  pie: 'pie_chart',
  treemap: 'grid_view',
};

const LABEL = {
  bar: 'Bar', line: 'Line', area: 'Area', donut: 'Donut', pie: 'Pie', treemap: 'Treemap',
};

/**
 * Which types suit this data, mirroring engine/panels.js kindsFor().
 *
 * Duplicated deliberately and kept small: the server decides what a panel may
 * be SAVED as, and this decides what a reader may switch to right now. A
 * round-trip to ask permission for a redraw would make the switcher feel broken
 * on a slow connection.
 */
export function applicableKinds({ grain, groupBy, measureFn = 'count', points = 0 }) {
  if (grain) return ['line', 'area', 'bar'];
  if (!groupBy) return [];
  const partToWhole = measureFn === 'count';
  const kinds = ['bar'];
  if (partToWhole && points <= 8) kinds.push('donut', 'pie');
  kinds.push('treemap');
  return kinds;
}


/**
 * The theme's accent at a given alpha, as a value an SVG attribute accepts.
 *
 * Reads the live custom property so it follows light and dark, and falls back
 * to the shipped green if the variable cannot be read — a chart with a
 * hard-coded colour is better than one with none.
 */
function accentAlpha(alpha) {
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

export default function ChartPanel({
  data = [], kind = 'bar', grain = null, groupBy = null, measureFn = 'count',
  format = (v) => v, onPick, onKindChange, height = 170,
}) {
  const [local, setLocal] = useState(kind);
  const shown = onKindChange ? kind : local;

  const kinds = applicableKinds({ grain, groupBy, measureFn, points: data.length });

  const pick = (k) => {
    if (onKindChange) onKindChange(k);
    else setLocal(k);
  };

  /* Donut colours each arc from a `colour` on the segment, and panel data has
     none — so every arc came out the same accent green and the chart could not
     be read at all.
     
     Computed in JS rather than with color-mix(): these become SVG `stroke`
     PRESENTATION ATTRIBUTES, and a CSS colour function does not resolve there.
     color-mix() produced eight distinct strings in the DOM and an invisible
     grey ring on screen — distinct values that all failed to parse. Reading the
     live custom property keeps it theme-aware; graduated alpha keeps the
     product's single-hue look while making eight arcs tellable apart. */
  const shaded = data.map((d, i) => ({
    ...d,
    colour: accentAlpha(Math.max(0.28, 1 - i * 0.11)),
  }));

  const body = () => {
    switch (shown) {
      case 'line': return <LineChart data={data} height={height} format={format} />;
      case 'area': return <LineChart data={data} height={height} filled format={format} />;
      // A pie is a donut whose hole is closed. One geometry, two looks.
      case 'pie': return <Donut segments={shaded} thickness={75} size={150} />;
      case 'donut': return <Donut segments={shaded} />;
      case 'treemap': return <Treemap data={data} height={height} format={format} />;
      default: return <BarChart data={data} height={height} format={format} onPick={onPick} />;
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {kinds.length > 1 && (
        <div className="chart-kinds" role="group" aria-label="Chart type">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={shown === k ? 'is-on' : ''}
              onClick={() => pick(k)}
              title={`Show as ${LABEL[k].toLowerCase()}`}
              aria-pressed={shown === k}
            >
              <Icon name={ICON[k]} size={14} /> {LABEL[k]}
            </button>
          ))}
        </div>
      )}
      {body()}
    </div>
  );
}
