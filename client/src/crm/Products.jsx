/**
 * Product desks.
 *
 * The catalogue was editable in Setup and visible on a lead, but there was
 * nowhere to stand inside a product and ask how it is doing — which is the
 * question a Product RM has all day.
 *
 * Two levels, deliberately. The grid answers "which of my products is moving",
 * and a desk answers "what is stuck on this one, and what do I say when I ring
 * about it". Both under the reader's own scope, so an RM sees their book and a
 * supervisor sees theirs from the same screen.
 */

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { rupeesCompact } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty } from '../components/ui.jsx';
import { Funnel } from '../components/charts.jsx';
import { productIcon } from '../components/ProductCard.jsx';

export default function Products() {
  const [search, setSearch] = useSearchParams();
  const category = search.get('category') || '';
  const openId = search.get('open') || '';

  const [data, { loading, error }] = useApi('/products');

  const setParam = (k, v) => {
    const next = new URLSearchParams(search);
    if (v) next.set(k, v); else next.delete(k);
    setSearch(next, { replace: true });
  };

  const shown = useMemo(() => (data?.products ?? [])
    .filter((p) => !category || p.category === category), [data, category]);

  if (loading && !data) return <Loading label="Loading products…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  const totals = shown.reduce((a, p) => ({
    inPlay: a.inPlay + p.in_play,
    active: a.active + p.active,
    open: a.open + p.open_value,
  }), { inPlay: 0, active: 0, open: 0 });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p className="muted">
            Every product you can sell, and how it is actually moving through your book.
          </p>
        </div>
      </div>

      <div className="grid-auto" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="stat-label">In play</div>
          <div className="stat-value">{totals.inPlay}</div>
          <div className="stat-sub">{rupeesCompact(totals.open)} of open value</div>
        </div>
        <div className="card stat tone-good">
          <div className="stat-label">Active</div>
          <div className="stat-value">{totals.active}</div>
          <div className="stat-sub">Products live on a client</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Catalogue</div>
          <div className="stat-value">{shown.length}</div>
          <div className="stat-sub">{data.categories.length} categories</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <span className="tiny muted">Category</span>
          <button type="button" className={`chip ${!category ? 'chip-active' : ''}`}
            onClick={() => setParam('category', '')}>All</button>
          {data.categories.map((c) => (
            <button key={c} type="button" className={`chip ${category === c ? 'chip-active' : ''}`}
              onClick={() => setParam('category', c)}>{c}</button>
          ))}
        </div>
      </div>

      {shown.length === 0 && <Empty>No products in this category.</Empty>}

      <div className="product-grid">
        {shown.map((p) => (
          <button key={p.id} type="button" className="glass product-card is-clickable"
            onClick={() => setParam('open', String(p.id))}>
            <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
              <span className="material-symbols-rounded">{productIcon(p)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong className="truncate">{p.name}</strong>
                <div className="tiny muted">{p.category}{p.risk_category ? ` · ${p.risk_category} risk` : ''}</div>
              </div>
            </div>

            <div className="product-facts" style={{ marginTop: 10 }}>
              <div className="product-fact">
                <dt>In play</dt>
                <dd>{p.in_play}</dd>
              </div>
              <div className="product-fact">
                <dt>Active</dt>
                <dd>{p.active}</dd>
              </div>
              <div className="product-fact">
                <dt>Converts</dt>
                {/* Null, not zero. A product nobody has decided on yet has no
                    conversion rate, and showing 0% reads as failure. */}
                <dd>{p.conversion_pct == null ? '—' : `${p.conversion_pct}%`}</dd>
              </div>
            </div>

            {p.open_value > 0 && (
              <div className="tiny muted" style={{ marginTop: 7 }}>
                {rupeesCompact(p.open_value)} open · {rupeesCompact(p.won_value)} won
              </div>
            )}
          </button>
        ))}
      </div>

      {openId && <Desk id={openId} onClose={() => setParam('open', '')} />}
    </div>
  );
}

/* ------------------------------------------------------------------ desk */

function Desk({ id, onClose }) {
  const navigate = useNavigate();
  const [d, { loading, error }] = useApi(`/products/${id}`, [id]);

  if (loading && !d) return null;
  if (error) return <ErrorBanner error={error} />;
  if (!d) return null;

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="popover modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <div>
            <h2>{d.name}</h2>
            <p>{d.category}{d.risk_category ? ` · ${d.risk_category} risk` : ''}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="row wrap" style={{ gap: 5 }}>
          {d.min_investment > 0 && <span className="badge">Min {rupeesCompact(d.min_investment)}</span>}
          {d.lock_in && <span className="badge">Lock-in {d.lock_in}</span>}
          {d.requires_kyc ? <span className="badge">KYC required</span> : null}
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-head"><h3 style={{ fontSize: 14, margin: 0 }}>Where it stands</h3></div>
            <div className="card-body">
              <Funnel stages={d.funnel} />
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3 style={{ fontSize: 14, margin: 0 }}>By state</h3></div>
            <div className="card-body stack" style={{ gap: 6 }}>
              {d.states.filter((s) => s.count > 0).map((s) => (
                <div key={s.code} className="row-between">
                  <span className="row" style={{ gap: 6 }}>
                    <span className={`dot dot-${s.colour}`} />
                    <span className="small">{s.label}</span>
                  </span>
                  <span className="small">
                    {s.count}{s.value > 0 ? ` · ${rupeesCompact(s.value)}` : ''}
                  </span>
                </div>
              ))}
              {d.states.every((s) => s.count === 0) && (
                <span className="muted small">Nobody is engaged on this product yet.</span>
              )}
            </div>
          </div>
        </div>

        {/* The list this page is actually opened to find. */}
        <div className="card">
          <div className="card-head">
            <h3 style={{ fontSize: 14, margin: 0 }}>Stopped moving</h3>
            <span className="tiny muted">Over two weeks in the same state</span>
          </div>
          {d.stalled.length === 0
            ? <Empty>Nothing is stuck on this product.</Empty>
            : (
              <div className="table-scroll">
                <table className="table">
                  <thead><tr><th>Lead</th><th>State</th><th>Waiting</th><th>Owner</th></tr></thead>
                  <tbody>
                    {d.stalled.map((c) => (
                      <tr key={c.id} className="row-link" onClick={() => navigate(`/leads/${c.lead_id}`)}>
                        <td>{c.lead_name}</td>
                        <td><span className="badge">{c.state.replace(/_/g, ' ').toLowerCase()}</span></td>
                        <td><span className="badge badge-amber">{c.days_in_state}d</span></td>
                        <td className="muted">{c.owner_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-head"><h3 style={{ fontSize: 14, margin: 0 }}>Pitch</h3></div>
            <div className="card-body">
              {d.pitch_points.length === 0 && <span className="muted small">No pitch points recorded.</span>}
              <ul className="small" style={{ margin: 0, paddingLeft: 17 }}>
                {d.pitch_points.map((p, i) => <li key={i} style={{ marginBottom: 4 }}>{p}</li>)}
              </ul>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3 style={{ fontSize: 14, margin: 0 }}>If they push back</h3></div>
            <div className="card-body stack" style={{ gap: 9 }}>
              {d.objections.length === 0 && <span className="muted small">No objections recorded.</span>}
              {d.objections.map((o, i) => (
                <div key={i}>
                  <div className="small" style={{ fontWeight: 600 }}>“{o.objection ?? o}”</div>
                  {o.response && <div className="small muted">{o.response}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm"
            onClick={() => navigate(`/pipeline?product_id=${d.id}`)}>
            <Icon name="view_kanban" size={15} /> See it on the pipeline
          </button>
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => navigate(`/leads?product_id=${d.id}`)}>
            <Icon name="group_add" size={15} /> Leads carrying it
          </button>
        </div>
      </div>
    </div>
  );
}
