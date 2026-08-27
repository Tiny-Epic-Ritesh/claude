/**
 * Pipeline (BUG-20).
 *
 * The tab was empty because nothing served it — there was no /api/pipeline, and
 * the SPA fallback answered the fetch with index.html, so the page rendered
 * nothing and read as broken rather than unbuilt.
 *
 * What moves through this board is the **product card**, not the lead: one lead
 * can be Active on equity and still Exploring on mutual funds, and a single
 * lead-level stage cannot hold both. So each column is a card state, each card
 * is one product opportunity, and the column header carries the money — which
 * is the number anyone opening a pipeline came to see.
 */

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { rupeesCompact, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty } from '../components/ui.jsx';

const DOT = {
  green: 'dot-green', yellow: 'dot-yellow', red: 'dot-red', grey: 'dot-grey',
};

export default function Pipeline() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();

  const productId = search.get('product_id') || '';
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (productId) p.set('product_id', productId);
    return p.toString();
  }, [productId]);

  const [data, { loading, error }] = useApi(`/pipeline?${query}`, [query]);

  const setProduct = (v) => {
    const next = new URLSearchParams(search);
    if (v) next.set('product_id', v); else next.delete('product_id');
    setSearch(next, { replace: true });
  };

  if (error) return <ErrorBanner error={error} />;
  if (loading && !data) return <Loading label="Loading pipeline…" />;
  if (!data) return null;

  const empty = data.total_cards === 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p className="muted">
            Every product opportunity you can see, by stage. One lead can appear
            more than once — a client can be active on equity and still exploring
            mutual funds.
          </p>
        </div>
      </div>

      <div className="grid-auto" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="stat-label">Open pipeline</div>
          <div className="stat-value">{rupeesCompact(data.open_value)}</div>
          <div className="stat-sub">Weighted by stage, excluding won and lost</div>
        </div>
        <div className="card stat tone-good">
          <div className="stat-label">Won</div>
          <div className="stat-value">{rupeesCompact(data.won_value)}</div>
          <div className="stat-sub">Active product cards</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Opportunities</div>
          <div className="stat-value">{data.total_cards}</div>
          <div className="stat-sub">Across {data.columns.length} stages</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="pipe-product">Product</label>
            <select id="pipe-product" value={productId} onChange={(e) => setProduct(e.target.value)}>
              <option value="">All products</option>
              {(data.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {productId && (
            <button type="button" className="chip chip-active" onClick={() => setProduct('')}>
              Filtered <Icon name="close" size={13} />
            </button>
          )}
        </div>
      </div>

      {empty ? (
        <Empty>
          Nothing in the pipeline yet. A card appears here once it moves off
          Not&nbsp;started — mark one Exploring or Warm from a lead.
        </Empty>
      ) : (
        <div className="board">
          {data.columns.map((col) => (
            <Column key={col.code} col={col} onOpen={(id) => navigate(`/leads/${id}`)} />
          ))}
        </div>
      )}

      {/* Outcomes, not stages — kept out of the board so they cannot be read as
          somewhere work is still moving. */}
      {data.terminal.some((c) => c.count > 0) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><h2 style={{ fontSize: 15 }}>Closed</h2></div>
          <div className="card-body row wrap" style={{ gap: 10 }}>
            {data.terminal.map((c) => (
              <span key={c.code} className="chip chip-muted">
                <span className={`dot ${DOT[c.colour] || 'dot-grey'}`} /> {c.label}: {c.count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Column({ col, onOpen }) {
  return (
    <div className="board-col">
      <div className="board-head">
        <div className="row" style={{ gap: 6 }}>
          <span className={`dot ${DOT[col.colour] || 'dot-grey'}`} />
          <span className="board-title">{col.label}</span>
          <span className="board-count">{col.count}</span>
        </div>
        <div className="tiny muted">{rupeesCompact(col.value)}</div>
      </div>

      <div className="board-cards">
        {col.cards.length === 0 && <div className="tiny muted" style={{ padding: '8px 2px' }}>Empty</div>}
        {col.cards.map((c) => (
          <button key={c.id} type="button" className="board-card" onClick={() => onOpen(c.lead_id)}>
            <div className="board-card-top">
              <span className="board-card-name">{c.lead_name}</span>
              {c.value > 0 && <span className="board-card-value">{rupeesCompact(c.value)}</span>}
            </div>
            <div className="tiny muted">{c.product_name}</div>
            <div className="row wrap" style={{ gap: 5, marginTop: 5 }}>
              <span className="badge">{c.sales_org}</span>
              {/* Days in stage is the tell a supervisor scans for: a card that
                  has not moved in a fortnight is the one worth asking about. */}
              {c.days_in_state > 14 && (
                <span className="badge badge-amber" title="Has not moved in over two weeks">
                  {c.days_in_state}d
                </span>
              )}
              {c.product_rm_name && <span className="tiny muted">{c.product_rm_name}</span>}
            </div>
          </button>
        ))}
        {col.count > col.cards.length && (
          <div className="tiny muted" style={{ padding: '6px 2px' }}>
            +{col.count - col.cards.length} more
          </div>
        )}
      </div>
    </div>
  );
}
