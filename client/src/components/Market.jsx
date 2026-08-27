/**
 * Market data on screen.
 *
 * Four surfaces, one set of components: the login strip, the cockpit banner,
 * the Market tab, and the lead sidebar. They share the delay stamp and the
 * disclaimer, because a figure that reaches a screen without its age attached
 * is the thing the compliance decision was about.
 *
 * Colour convention is Indian-market, not Western: green is up, red is down.
 * The semantic tokens happen to agree, but this is stated because a codebase
 * that uses `--ok` for "rising" will eventually be read as "good", and a
 * falling index is not bad news for a broker taking brokerage either way.
 */

import { useEffect, useState } from 'react';
import { api, publicApi } from '../api.js';
import { useApi, Spinner, Icon } from './ui.jsx';

/* --------------------------------------------------------- one index */

function IndexPill({ ix }) {
  const up = ix.change_pct > 0;
  const flat = Math.abs(ix.change_pct) < 0.005;

  return (
    <div className={`ix ${flat ? 'is-flat' : up ? 'is-up' : 'is-down'}`}>
      <span className="ix-name">{ix.name}</span>
      <span className="ix-last">{ix.last.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
      <span className="ix-chg">
        <Icon name={flat ? 'remove' : up ? 'arrow_drop_up' : 'arrow_drop_down'} size={16} />
        {Math.abs(ix.change).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        <em>({up && !flat ? '+' : ''}{ix.change_pct}%)</em>
      </span>
    </div>
  );
}

/* ------------------------------------------------------ delay stamp */

/**
 * The regulatory footer, on every surface that shows a number.
 *
 * `simulated` is surfaced rather than hidden: a demo environment showing
 * invented figures must say so, or someone will screenshot it and treat it as
 * real. That risk is worse than the untidiness of the badge.
 */
export function MarketStamp({ data, compact = false }) {
  if (!data) return null;
  const at = data.as_of ? new Date(data.as_of) : null;
  const time = at ? at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div className={`market-stamp ${compact ? 'is-compact' : ''}`}>
      <Icon name="schedule" size={13} />
      <span>As of {time} · delayed {data.delayed_minutes} min</span>
      {data.simulated && <span className="sim-badge">simulated feed</span>}
      {data.stale && <span className="sim-badge is-warn">feed stale</span>}
      {!compact && <span className="market-disclaimer">{data.disclaimer}</span>}
    </div>
  );
}

/* ------------------------------------------------- the strip (banner) */

/**
 * The thin ticker.
 *
 * `publicMode` swaps the endpoint for the unauthenticated one, so the same
 * component serves the login page without the login page having a session.
 */
export function MarketStrip({ publicMode = false, className = '' }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const p = publicMode
        ? publicApi.get('/market/indices')
        : api.get('/market/indices');
      p.then((d) => { if (!cancelled) { setData(d); setFailed(false); } })
        .catch(() => { if (!cancelled) setFailed(true); });
    };
    load();
    // Delayed data does not need a fast refresh; a minute keeps it honest
    // without turning a CRM into a polling client.
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [publicMode]);

  // A dead ticker must not push the page around or shout. It simply goes.
  if (failed && !data) return null;
  if (!data) return <div className={`market-strip is-loading ${className}`}><Spinner /></div>;

  /**
   * A continuously scrolling ticker (ENH-03).
   *
   * The old strip was a horizontally scrollable row, which meant only the first
   * few indices were ever seen — anything past the fold required a deliberate
   * drag that nobody performs on a strip they are not looking at.
   *
   * The track is rendered twice and translated by exactly -50%, so the second
   * copy arrives in the first one's place and the loop has no seam. Duplicating
   * is what makes it seamless; a single copy has to jump back.
   *
   * `aria-hidden` on the clone keeps a screen reader from announcing every
   * index twice, and the whole thing pauses on hover so a price can actually be
   * read.
   */
  const track = data.indices.map((ix) => <IndexPill key={ix.code} ix={ix} />);

  return (
    <div className={`market-strip ${className}`}>
      <div className="ticker" role="marquee" aria-label="Market indices">
        <div className="ticker-track">
          <div className="ticker-run">{track}</div>
          <div className="ticker-run" aria-hidden="true">{track}</div>
        </div>
      </div>
      <MarketStamp data={data} compact />
    </div>
  );
}

/* ------------------------------------------------------- lead sidebar */

/**
 * Market context beside a lead.
 *
 * Keyed off recorded product interest, not holdings — the CRM has no
 * instrument-level positions, and inventing "your client holds Reliance" on a
 * screen an RM is about to call from would be worse than showing less.
 */
export function LeadMarketContext({ leadId }) {
  const [ctx] = useApi(`/market/context/${leadId}`);
  if (!ctx) return null;

  const hasIssues = ctx.issues?.length > 0;
  const hasActions = ctx.actions?.length > 0;
  if (!hasIssues && !hasActions) return null;

  return (
    <div className="glass section-card market-context">
      <div className="section-head">
        <div>
          <h2>Market context</h2>
          <p>{ctx.basis}</p>
        </div>
      </div>

      <div className="ix-stack">
        {ctx.indices.map((ix) => <IndexPill key={ix.code} ix={ix} />)}
      </div>

      {hasIssues && (
        <div className="ctx-block">
          <h3>Open and upcoming issues</h3>
          <ul className="ctx-list">
            {ctx.issues.map((i) => (
              <li key={i.name}>
                <span className={`state-pill ${i.status === 'Open' ? 'state-active' : 'state-exploring'}`}>
                  {i.status}
                </span>
                <div>
                  <strong>{i.name}</strong>
                  <div className="tiny muted">
                    {i.kind}{i.price_band ? ` · ${i.price_band}` : ''} · closes {i.closes_on}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasActions && (
        <div className="ctx-block">
          <h3>Coming up</h3>
          <ul className="ctx-list">
            {ctx.actions.map((a) => (
              <li key={`${a.symbol}-${a.kind}`}>
                <span className="state-pill">{a.kind}</span>
                <div>
                  <strong>{a.company}</strong>
                  <div className="tiny muted">{a.symbol} · {a.on}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <MarketStamp data={ctx} compact />
    </div>
  );
}

/* --------------------------------------------------------- market tab */

export default function MarketTab() {
  const [data] = useApi('/market/snapshot');
  if (!data) return <div className="empty"><Spinner /></div>;

  return (
    <>
      <div className="stat-strip">
        {data.indices.map((ix) => (
          <div key={ix.code} className={`glass stat-tile ix-tile ${ix.change_pct > 0 ? 'tone-ok' : 'tone-danger'}`}>
            <div className="stat-tile-label">{ix.name}</div>
            <div className="stat-tile-value">
              {ix.last.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
            <div className="stat-tile-foot">
              <span className={`delta ${ix.change_pct > 0 ? 'is-good' : 'is-bad'}`}>
                <Icon name={ix.change_pct > 0 ? 'trending_up' : 'trending_down'} size={15} />
                {ix.change_pct > 0 ? '+' : ''}{ix.change_pct}%
              </span>
              <span className="stat-tile-sub">{ix.exchange}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="portal-grid is-split">
        <div className="glass section-card">
          <div className="section-head">
            <div>
              <h2>Market news</h2>
              <p>Headlines an RM can open a call with</p>
            </div>
          </div>
          <ul className="news-list">
            {data.news.map((n) => (
              <li key={n.id}>
                <div className="news-meta">
                  <span className="chip chip-soft">{n.category}</span>
                  <span className="tiny muted">
                    {n.source} · {new Date(n.published_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                {/* ENH-09: the headline opens the source article.
                    `url` is null while the feed is simulated -- Global Datafeed
                    credentials are still outstanding -- so the item stays plain
                    text and says why on hover rather than pretending to be a
                    link that goes nowhere. A dead link is worse than none. */}
                {n.url ? (
                  <a className="news-link" href={n.url}
                    target="_blank" rel="noopener noreferrer">
                    <strong>{n.headline}</strong>
                    <Icon name="open_in_new" size={13} />
                  </a>
                ) : (
                  <strong title="The source link arrives with the live market feed">
                    {n.headline}
                  </strong>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="glass section-card">
          <div className="section-head">
            <div>
              <h2>Open &amp; upcoming issues</h2>
              <p>IPOs and NFOs you can pitch</p>
            </div>
          </div>
          <ul className="ctx-list">
            {data.issues.map((i) => (
              <li key={i.name}>
                <span className={`state-pill ${i.status === 'Open' ? 'state-active' : 'state-exploring'}`}>
                  {i.status}
                </span>
                <div>
                  <strong>{i.name}</strong>
                  <div className="tiny muted">
                    {i.kind}{i.price_band ? ` · ${i.price_band}` : ''} · {i.opens_on} to {i.closes_on}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="glass section-card">
        <div className="section-head">
          <div>
            <h2>Corporate actions &amp; results</h2>
            <p>Every one of these is a reason to call someone</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Company</th><th>Symbol</th><th>Event</th><th>Exchange</th><th>Date</th></tr>
            </thead>
            <tbody>
              {data.actions.map((a) => (
                <tr key={`${a.symbol}-${a.kind}`}>
                  <td><strong>{a.company}</strong></td>
                  <td><code className="api-name">{a.symbol}</code></td>
                  <td><span className="chip chip-soft">{a.kind}</span></td>
                  <td className="muted small">{a.exchange}</td>
                  <td>{a.on}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <MarketStamp data={data} />
    </>
  );
}
