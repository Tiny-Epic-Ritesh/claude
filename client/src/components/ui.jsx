import { useCallback, useEffect, useState } from 'react';
import { api, STATE_LABEL } from '../api.js';
import { avatarStyle, initials, resolvedTheme, cycleTheme } from '../theme.js';

/** Data-loading hook: const [data, { loading, error, reload }] = useApi('/leads'). */
export function useApi(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) { setLoading(false); return undefined; }
    let cancelled = false;

    // Only blank the screen when there is nothing to show yet. A refetch after
    // an action used to unmount the whole page — which threw away the very
    // confirmation the user had just triggered, and made every save flash.
    setLoading((wasLoading) => (data === null ? true : wasLoading));
    api.get(path)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return [data, { loading, error, reload, setData }];
}

export const Spinner = () => <span className="spinner" aria-label="Loading" />;

export function Loading({ label = 'Loading…' }) {
  return <div className="empty"><Spinner /> <span style={{ marginLeft: 8 }}>{label}</span></div>;
}

export function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="error row-between">
      <span>{error}</span>
      {onDismiss && <button className="btn-ghost btn-sm" style={{ color: 'inherit' }} onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export function Modal({ title, subtitle, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal card ${wide ? 'modal-lg' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="tiny muted" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className={`card stat ${tone ? `tone-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** The colour marker that tells any caller a card's position at a glance. */
export function CardDot({ colour, state, showLabel }) {
  return (
    <span className="row" style={{ gap: 5 }} title={STATE_LABEL[state] || state}>
      <span className={`dot dot-${colour || 'grey'}`} />
      {showLabel && <span className="tiny">{STATE_LABEL[state] || state}</span>}
    </span>
  );
}

export function CardStrip({ cards = [], max = 12 }) {
  return (
    <span className="row" style={{ gap: 3 }}>
      {cards.slice(0, max).map((c) => (
        <span key={c.code || c.id} className={`dot dot-${c.colour || 'grey'}`} title={`${c.name}: ${STATE_LABEL[c.state] || c.state}`} />
      ))}
    </span>
  );
}

export const AgeBadge = ({ band, days }) => {
  const tone = band === 'Cold' ? 'red' : band === 'At Risk' ? 'red' : band === 'Ageing' ? 'amber' : band === 'Fresh' ? 'green' : '';
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{band}{days != null ? ` · ${days}d` : ''}</span>;
};

export const PriorityBadge = ({ priority }) => {
  const tone = priority === 'Critical' ? 'red' : priority === 'High' ? 'amber' : priority === 'Low' ? '' : 'blue';
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{priority}</span>;
};

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className={`tab ${active === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}{t.count != null ? ` (${t.count})` : ''}
        </button>
      ))}
    </div>
  );
}

/** Progress bar with a label — used for KYC and onboarding. */
export function Progress({ pct, label }) {
  return (
    <div>
      {label && <div className="row-between tiny muted" style={{ marginBottom: 3 }}><span>{label}</span><span>{pct}%</span></div>}
      <div className="bar"><div className="bar-fill" style={{ width: `${Math.min(100, pct || 0)}%` }} /></div>
    </div>
  );
}

/* ==========================================================================
   Glass design system primitives
   ========================================================================== */

/**
 * Material Symbols icon.
 *
 * The reference dashboard uses Material's icon vocabulary throughout, and
 * matching it means every icon name in that design maps across unchanged.
 * Ligature-based, so `<Icon name="trending_up" />` renders the glyph.
 */
export const Icon = ({ name, size = 18, fill = 0, weight = 400, style, className = '' }) => (
  <span
    className={`mi ${className}`}
    aria-hidden="true"
    style={{
      fontSize: size,
      fontVariationSettings: `'FILL' ${fill}, 'wght' ${weight}, 'GRAD' 0, 'opsz' 24`,
      ...style,
    }}
  >
    {name}
  </span>
);

/** Initials avatar with a stable per-person colour. */
export function Avatar({ name, size = 32, seed }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.36, ...avatarStyle(seed ?? name) }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

/**
 * Sales-org switcher.
 *
 * Only rendered when the user actually holds more than one book — a
 * single-org user has nothing to switch and the control would be noise.
 * Selecting an org repaints the accent immediately so the change of business
 * is unmistakable, then tells the caller to refetch.
 */
export function OrgSwitcher({ orgs = [], value, onChange }) {
  const [open, setOpen] = useState(false);

  // A user who holds one book has nothing to switch, so the control is not
  // rendered at all — an inert dropdown would only invite the question
  // "why can't I see the other business?"
  if (orgs.length < 2) return null;

  const active = orgs.find((o) => o.code === value);

  return (
    <div style={{ position: 'relative' }}>
      <button className="org-switch" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="org-swatch" />
        {active ? active.name : 'All businesses'}
        <Icon name={open ? 'expand_less' : 'expand_more'} size={16} />
      </button>

      {open && (
        <>
          {/* Catches the next click anywhere else so the menu closes. */}
          <div className="popover-scrim" onClick={() => setOpen(false)} />

          <div className="popover" role="listbox" style={{ top: 'calc(100% + 6px)', right: 0, minWidth: 246 }}>
            <button
              className="popover-item"
              role="option"
              aria-selected={!value}
              onClick={() => { onChange(null); setOpen(false); }}
            >
              <Icon name="apps" size={18} />
              <span style={{ flex: 1 }}>
                All businesses
                <span className="tiny muted" style={{ display: 'block', lineHeight: 1.3 }}>Combined view</span>
              </span>
              {!value && <Icon name="check" size={16} />}
            </button>

            {orgs.map((o) => (
              <button
                key={o.code}
                className="popover-item"
                role="option"
                aria-selected={value === o.code}
                onClick={() => { onChange(o.code); setOpen(false); }}
              >
                <span
                  className="org-swatch"
                  style={{ background: `linear-gradient(145deg, ${o.accent}, ${o.accent_dark || o.accent})` }}
                />
                <span style={{ flex: 1 }}>
                  {o.name}
                  <span className="tiny muted" style={{ display: 'block', lineHeight: 1.3 }}>{o.tagline}</span>
                </span>
                {value === o.code && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Light / dark toggle. Reflects the resolved theme, not the stored setting. */
export function ThemeToggle() {
  const [mode, setMode] = useState(() => resolvedTheme());
  return (
    <button
      className="btn-ghost btn-sm"
      title={mode === 'dark' ? 'Switch to light' : 'Switch to dark'}
      aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => setMode(cycleTheme())}
    >
      <Icon name={mode === 'dark' ? 'light_mode' : 'dark_mode'} size={18} />
    </button>
  );
}

/**
 * A KPI tile with an icon and an optional delta.
 * Richer than Stat, for the dashboards where a number needs context.
 */
export function KpiTile({ icon, label, value, sub, delta, tone, onClick }) {
  const deltaTone = delta == null ? null : delta >= 0 ? 'good' : 'bad';
  return (
    <div
      className={`stat ${onClick ? 'card-interactive' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
    >
      <div className="row-between">
        <span className="stat-label">{label}</span>
        {icon && <Icon name={icon} size={17} style={{ color: 'var(--ink-4)' }} />}
      </div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ''}`}>{value}</div>
      <div className="row" style={{ gap: 6 }}>
        {delta != null && (
          <span className={`tiny tone-${deltaTone}`} style={{ fontWeight: 600 }}>
            <Icon name={delta >= 0 ? 'trending_up' : 'trending_down'} size={13} />
            {' '}{delta >= 0 ? '+' : ''}{delta}%
          </span>
        )}
        {sub && <span className="stat-sub">{sub}</span>}
      </div>
    </div>
  );
}

/** Segmented control — MTD / QTD / YTD and similar. */
export function Segmented({ options, value, onChange }) {
  return (
    <div className="tabs" style={{ marginBottom: 0, display: 'inline-flex' }}>
      {options.map((o) => (
        <button
          key={o.value}
          className={`tab ${value === o.value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
