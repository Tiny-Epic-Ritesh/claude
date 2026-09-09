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
        <div className="row-between" style={{ marginBottom: 12 }}>
          <span className="tiny muted">
            A product carries a permanent code. Cards, KYC journeys and dialler campaigns bind to it.
          </span>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>
            <Icon name="add" size={16} /> New product
          </button>
        </div>

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
  /* An empty object means "new". The screen opens the same form either way,
     because a product being created and a product being changed are the same
     set of decisions — only the code differs, and that is issued rather than
     typed. */
  const making = !product?.id;
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
      const body = {
        ...form,
        name: form.name.trim(),
        // Empty means "not set", which is a different thing from zero.
        min_investment: form.min_investment === '' ? null : Number(form.min_investment),
        requires_kyc: form.requires_kyc ? 1 : 0,
      };
      if (making) await api.post('/admin/products', body);
      else await api.patch(`/admin/products/${product.id}`, body);
      onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal
      title={making ? 'New product' : product.name}
      subtitle={making ? 'It will be given a permanent code' : product.code}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="form-grid">
        <div className="glass notice span-2">
          <Icon name="lock" size={16} />
          <div>
            {making ? (
              <>
                The code issued here never changes. Every product card on every lead,
                the KYC journeys and the dialler campaigns will bind to it, so the name
                stays free to change afterwards and the code does not.
              </>
            ) : (
              <>
                The code <code>{product.code}</code> never changes — every product card on
                every lead, the KYC journeys and the dialler campaigns all bind to it.
                Renaming below changes what people read, not what anything depends on.
              </>
            )}
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

        {/* P3-15. Only once the product exists: a file has to belong to
            something, and there is no id to attach it to until it is saved. */}
        {!making && <Brochure productId={product.id} onError={onError} />}

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

/**
 * The brochure on a product (P3-15).
 *
 * Two jobs, and they decided that the file is stored rather than linked: it has
 * to open while somebody is on a call, and it has to be attachable to an email.
 * A URL to somebody else's host is unreliable for the first and impossible for
 * the second.
 */
function Brochure({ productId, onError }) {
  const [meta] = useApi('/admin/products/brochure-formats');
  const [current, { reload }] = useApi(`/products/brochures`);
  const [busy, setBusy] = useState(false);

  const mine = (current?.brochures ?? []).find((b) => b.product_type_id === productId);

  const upload = async (file) => {
    setBusy(true);
    try {
      await api.upload(`/admin/products/${productId}/brochure`, file);
      reload();
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/admin/products/${productId}/brochure`);
      reload();
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="span-2">
      <span className="field-name">Brochure</span>
      {mine ? (
        <div className="row-between" style={{ gap: 8, marginTop: 4 }}>
          <span className="tiny">
            <Icon name="description" size={15} /> {mine.filename}
            <span className="muted"> · {(mine.size / 1024).toFixed(0)} KB</span>
          </span>
          <div className="row" style={{ gap: 6 }}>
            <a className="btn-sm" href={`/api/products/${productId}/brochure`} target="_blank" rel="noreferrer">Open</a>
            <button type="button" className="btn-sm" disabled={busy} onClick={remove}>Remove</button>
          </div>
        </div>
      ) : (
        <label className="filedrop" style={{ marginTop: 4 }}>
          <input
            type="file"
            accept={meta?.accept}
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }}
          />
          <Icon name="upload" size={17} />
          <span>{busy ? 'Uploading…' : 'Attach a brochure'}</span>
        </label>
      )}
      {/* The formats come from the server, so this cannot promise one the
          upload refuses. */}
      <p className="hint">
        {meta ? `${meta.formats.map((f) => f.label).join(', ')} · up to ${Math.round(meta.max_bytes / 1024 / 1024)} MB.` : ' '}
        {' '}Stored in the CRM, so it opens on a call and can be emailed to a client.
      </p>
    </div>
  );
}
