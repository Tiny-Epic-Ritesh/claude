/**
 * Marketing Hub — the approved collateral, with its version and expiry.
 *
 * The library already existed and the API already tracked version, expiry and
 * owning role. What it lacked was a reader's view: the Setup screen is where an
 * administrator maintains it, and an RM about to send a brochure is not going
 * to Setup.
 *
 * Expiry leads, because that is the thing that makes a document a liability
 * rather than an asset. A brochure quoting last year's brokerage plan is worse
 * than no brochure, and it is exactly what nobody notices on their own.
 */

import { useMemo, useState } from 'react';
import { shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty } from '../components/ui.jsx';
import Libraries from './Libraries.jsx';

const TYPE_ICON = {
  PDF: 'picture_as_pdf', Video: 'play_circle', Link: 'link', PPT: 'slideshow',
};

/**
 * The Marketing Hub, in two halves (P2-20 + P2-22).
 *
 * "Browse" is what an RM opens: the approved collateral, with the date it stops
 * being safe to send. "Libraries" is where that collateral is governed — who
 * may use it, when it expires, and who approved it.
 *
 * One screen with two tabs rather than two screens, for the reason Q-02 gave
 * about API access and logs: two places over the same collateral means one of
 * them drifts, and the one that drifts is the one nobody opens.
 */
export default function Content() {
  const [tab, setTab] = useState('collateral');
  return (
    <div>
      <div className="tabs tabs-sub" style={{ marginBottom: 12 }}>
        <button className={tab === 'collateral' ? 'is-active' : ''} onClick={() => setTab('collateral')}>Browse</button>
        <button className={tab === 'libraries' ? 'is-active' : ''} onClick={() => setTab('libraries')}>Libraries</button>
      </div>
      {tab === 'collateral' ? <Browse /> : <Libraries />}
    </div>
  );
}

function Browse() {
  const [rows, { loading, error }] = useApi('/admin/content');
  const [filter, setFilter] = useState('current');
  const [q, setQ] = useState('');

  const shown = useMemo(() => (rows ?? []).filter((c) => {
    if (q && !c.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'current') return c.status === 'active' && !c.expired;
    if (filter === 'expiring') return c.expiring_soon && !c.expired;
    if (filter === 'expired') return c.expired;
    return true;
  }), [rows, filter, q]);

  if (loading && !rows) return <Loading label="Loading the library…" />;
  if (error) return <ErrorBanner error={error} />;

  const all = rows ?? [];
  const expiring = all.filter((c) => c.expiring_soon && !c.expired).length;
  const expired = all.filter((c) => c.expired).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Marketing Hub</h1>
          <p className="muted">
            Approved brochures, circulars and creatives — with the version and the
            date they stop being safe to send.
          </p>
        </div>
      </div>

      {/* Expired collateral is a compliance problem, not a housekeeping one, so
          it is stated before the library rather than filtered away inside it. */}
      {expired > 0 && (
        <div className="notice notice-warn" style={{ marginBottom: 14 }}>
          <Icon name="warning" size={17} />
          <span>
            <strong>{expired}</strong> document{expired === 1 ? ' has' : 's have'} passed
            their expiry date. They are not offered in the email composer, and should
            not be sent from anywhere else either.
          </span>
        </div>
      )}

      <div className="grid-auto" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="stat-label">In the library</div>
          <div className="stat-value">{all.length}</div>
        </div>
        <div className={`card stat ${expiring ? 'tone-warn' : ''}`}>
          <div className="stat-label">Expiring within 30 days</div>
          <div className="stat-value">{expiring}</div>
          <div className="stat-sub">Worth re-approving now</div>
        </div>
        <div className={`card stat ${expired ? 'tone-bad' : ''}`}>
          <div className="stat-label">Out of date</div>
          <div className="stat-value">{expired}</div>
          <div className="stat-sub">Withdrawn from sending</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label htmlFor="ct-q">Search</label>
            <input id="ct-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Document name" />
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {[['current', 'Current'], ['expiring', 'Expiring'], ['expired', 'Out of date'], ['all', 'Everything']]
              .map(([k, label]) => (
                <button key={k} type="button" className={`chip ${filter === k ? 'chip-active' : ''}`}
                  onClick={() => setFilter(k)}>{label}</button>
              ))}
          </div>
        </div>
      </div>

      {shown.length === 0 && (
        <Empty>
          {filter === 'expired' ? 'Nothing is out of date.' : 'Nothing matches.'}
        </Empty>
      )}

      <div className="grid-auto">
        {shown.map((c) => (
          <div key={c.id} className={`card ${c.expired ? 'is-retired' : ''}`}>
            <div className="card-body stack" style={{ gap: 8 }}>
              <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
                <Icon name={TYPE_ICON[c.type] ?? 'description'} size={20} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong className="truncate">{c.name}</strong>
                  <div className="tiny muted">
                    {c.type} · v{c.version}{c.product_name ? ` · ${c.product_name}` : ''}
                  </div>
                </div>
              </div>

              <div className="row wrap" style={{ gap: 5 }}>
                {c.expired
                  ? <span className="badge badge-red">Expired {shortDate(c.expiry_date)}</span>
                  : c.expiring_soon
                    ? <span className="badge badge-amber">Expires {shortDate(c.expiry_date)}</span>
                    : c.expiry_date
                      ? <span className="badge">Valid to {shortDate(c.expiry_date)}</span>
                      : <span className="badge">No expiry</span>}
                {c.owner_role && <span className="badge">{c.owner_role}</span>}
                {c.send_count > 0 && <span className="tiny muted">sent {c.send_count}×</span>}
              </div>

              {c.url && !c.expired && (
                <a className="btn btn-sm" href={c.url} target="_blank" rel="noopener noreferrer">
                  <Icon name="open_in_new" size={14} /> Open
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
