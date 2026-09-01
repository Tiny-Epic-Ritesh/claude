/**
 * Setup → Products.
 *
 * What the firm sells. Every product type generates a permanent card on every
 * lead, so this list is the shape of the pipeline itself — and until now it was
 * read-only apart from one Enable/Disable button, even though the API has
 * always accepted a full update. Eleven editable fields, none of them editable.
 *
 * ON STAGES
 * The Setup home description promised "the stages each product moves through",
 * and that was wrong: product card states (EXPLORING, WARM, KYC_IN_PROGRESS,
 * ACTIVE, ON_HOLD, LOST…) are one shared set across every product, not a
 * per-product sequence. There is nothing per-product to edit, so this does not
 * pretend there is. The states themselves are configured as a picklist under
 * Objects & fields, where every other controlled vocabulary lives.
 *
 * A disabled product is drawn as disabled, which the old screen did not do —
 * the same defect the Users list had, and the same consequence: "why is this
 * not appearing on leads" with no answer visible on the screen that controls it.
 */

import { useMemo, useState } from 'react';
import { api, rupees } from '../api.js';
import { useApi, Icon, Modal, ErrorBanner, Spinner } from '../components/ui.jsx';
import SetupSkeleton from '../setup/SetupSkeleton.jsx';

const ORG_LABEL = { BONANZA: 'Bonanza', BIGUL: 'Bigul' };
const RISKS = ['Low', 'Moderate', 'High', 'Very High'];

export default function ProductsSetup() {
  const [products, { loading, error, reload }] = useApi('/admin/products');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState(null);

  const list = Array.isArray(products) ? products : [];

  const counts = useMemo(() => {
    const active = list.filter((p) => p.active).length;
    return { active, inactive: list.length - active };
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (status === 'active' && !p.active) return false;
      if (status === 'inactive' && p.active) return false;
      if (!q) return true;
      return [p.name, p.code, p.category].some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [list, query, status]);

  if (loading) return <SetupSkeleton rows={6} />;
  if (error) return <ErrorBanner error={error} />;

  const toggle = async (p) => {
    setProblem(null);
    try {
      await api.patch(`/admin/products/${p.id}`, { active: p.active ? 0 : 1 });
      reload();
    } catch (err) { setProblem(err.message); }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      <div className="filter-bar">
        <div className="filter-search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search product or code"
            aria-label="Search products"
          />
          {query && (
            <button type="button" className="filter-clear" onClick={() => setQuery('')} aria-label="Clear">
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
        <div className="filter-row">
          <button
            type="button"
            className={`filter-chip${status === 'active' ? ' is-on' : ''}`}
            aria-pressed={status === 'active'}
            onClick={() => setStatus(status === 'active' ? 'all' : 'active')}
          >
            On sale<span className="filter-count">{counts.active}</span>
          </button>
          <button
            type="button"
            className={`filter-chip${status === 'inactive' ? ' is-on' : ''}`}
            aria-pressed={status === 'inactive'}
            disabled={counts.inactive === 0 && status !== 'inactive'}
            onClick={() => setStatus(status === 'inactive' ? 'all' : 'inactive')}
          >
            Withdrawn<span className="filter-count">{counts.inactive}</span>
          </button>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>{shown.length === list.length ? `${list.length} products` : `${shown.length} of ${list.length} products`}</h2>
            <span className="tiny muted">Each generates a permanent card on every lead</span>
          </div>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th><th>Category</th><th>Business</th>
                <th className="num">Minimum</th><th>Lock-in</th><th>Risk</th><th>KYC</th><th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className={p.active ? '' : 'row-inactive'}>
                  <td>
                    <div className="user-cell">
                      <strong>{p.name}</strong>
                      {!p.active && <span className="chip chip-muted">Withdrawn</span>}
                    </div>
                    <code className="api-name">{p.code}</code>
                  </td>
                  <td className="small">{p.category || '—'}</td>
                  <td className="small muted">{ORG_LABEL[p.sales_org] ?? p.sales_org ?? 'Both'}</td>
                  <td className="num small">{p.min_investment ? rupees(p.min_investment) : '—'}</td>
                  <td className="small muted">{p.lock_in || '—'}</td>
                  <td className="small">{p.risk_category || '—'}</td>
                  <td>
                    {p.requires_kyc
                      ? <span className="badge badge-blue">Required</span>
                      : <span className="badge">Not required</span>}
                  </td>
                  <td className="num">
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="btn-sm" onClick={() => setEditing(p)}>Edit</button>
                      <button type="button" className="btn-sm" onClick={() => toggle(p)}>
                        {p.active ? 'Withdraw' : 'Put on sale'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {shown.length === 0 && (
          <div className="setup-empty">
            <Icon name="inventory_2" size={30} />
            <strong>No product matches that</strong>
            <p>{query ? `Nothing matches “${query}”.` : 'No product matches these filters.'}</p>
          </div>
        )}
      </section>

      {editing && (
        <ProductEditor
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onError={setProblem}
        />
      )}
    </div>
  );
}

/**
 * Editing one product.
 *
 * The code is frozen for the reason every API name in this product is frozen:
 * `product_cards` rows, the KYC journey definitions and the dialler campaign
 * mapping all bind to it. The name above it is free to change.
 */
function ProductEditor({ product, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: product.name ?? '',
    category: product.category ?? '',
    min_investment: product.min_investment ?? '',
    lock_in: product.lock_in ?? '',
    risk_category: product.risk_category ?? '',
    brochure_url: product.brochure_url ?? '',
    apply_url: product.apply_url ?? '',
    requires_kyc: Boolean(product.requires_kyc),
  });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({
    ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
  }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { onError('A product needs a name'); return; }
    setBusy(true);
    try {
      await api.patch(`/admin/products/${product.id}`, {
        ...form,
        name: form.name.trim(),
        // Empty means "not set", which is a different thing from zero.
        min_investment: form.min_investment === '' ? null : Number(form.min_investment),
        requires_kyc: form.requires_kyc ? 1 : 0,
      });
      onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title={product.name} subtitle={product.code} onClose={onClose} wide>
      <form onSubmit={submit} className="form-grid">
        <div className="glass notice span-2">
          <Icon name="lock" size={16} />
          <div>
            The code <code>{product.code}</code> never changes — every product card on
            every lead, the KYC journeys and the dialler campaigns all bind to it.
            Renaming below changes what people read, not what anything depends on.
          </div>
        </div>

        <label>
          <span>Name</span>
          <input value={form.name} onChange={set('name')} required />
        </label>

        <label>
          <span>Category</span>
          <input value={form.category} onChange={set('category')} placeholder="Equity, Mutual Fund, PMS…" />
        </label>

        <label>
          <span>Minimum investment</span>
          <input
            type="number" min="0" step="1000"
            value={form.min_investment}
            onChange={set('min_investment')}
            placeholder="Leave empty for no minimum"
          />
        </label>

        <label>
          <span>Lock-in</span>
          <input value={form.lock_in} onChange={set('lock_in')} placeholder="3 years, None…" />
        </label>

        <label>
          <span>Risk category</span>
          <select value={form.risk_category} onChange={set('risk_category')}>
            <option value="">Not stated</option>
            {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {/* SEBI-regulated: the risk label on a product is what an RM repeats
              to a client, so it comes from a fixed list rather than free text. */}
          <span className="tiny muted">Shown to the RM beside the product on every lead.</span>
        </label>

        <label>
          <span>Brochure URL</span>
          <input value={form.brochure_url} onChange={set('brochure_url')} placeholder="https://…" />
        </label>

        <label>
          <span>Apply URL</span>
          <input value={form.apply_url} onChange={set('apply_url')} placeholder="https://…" />
        </label>

        <label className="check-row span-2">
          <input type="checkbox" checked={form.requires_kyc} onChange={set('requires_kyc')} />
          <span>
            <strong>Requires KYC before it can be sold</strong>
            <span className="tiny muted">
              A lead cannot reach an active card on this product until their KYC journey completes.
            </span>
          </span>
        </label>

        <div className="modal-actions span-2">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : 'Save product'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
