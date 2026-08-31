import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, money, shortDate, STATE_LABEL } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal, Spinner, CardStrip, AgeBadge } from '../components/ui.jsx';
import ActionMenu, { BulkBar } from '../components/ActionMenu.jsx';
import ActionModal from './ActionModals.jsx';
import { useLeadActions, CallNumber } from './leadActions.jsx';
import AdvancedSearch from '../components/AdvancedSearch.jsx';

const BANDS = ['Fresh', 'Active', 'Ageing', 'At Risk', 'Cold'];

export default function Leads({ session }) {
  /**
   * Filters seed from the URL, so a drill-through lands filtered.
   *
   * ENH-05 sends people here from a cockpit figure — `/leads?card_state=WARM`
   * has to arrive showing those leads, not the whole book. Reading the query
   * also means the filtered view is a real URL: shareable, bookmarkable, and
   * survives a refresh.
   */
  const [search] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    q: search.get('q') ?? '',
    stage: search.get('stage') ?? '',
    band: search.get('band') ?? '',
    card_state: search.get('card_state') ?? '',
    product_id: search.get('product_id') ?? '',
  }));

  // A second drill-through while already on this page changes the query but
  // not the component, so the filters have to follow the URL.
  useEffect(() => {
    setFilters({
      q: search.get('q') ?? '',
      stage: search.get('stage') ?? '',
      band: search.get('band') ?? '',
      card_state: search.get('card_state') ?? '',
      product_id: search.get('product_id') ?? '',
    });
  }, [search]);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    return params.toString();
  }, [filters]);

  const [leads, { loading, error, reload }] = useApi(`/leads${query ? `?${query}` : ''}`);
  const [meta] = useApi('/meta');
  const [creating, setCreating] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [found, setFound] = useState(null);   // { rows, total, described, where }
  const [selected, setSelected] = useState(() => new Set());
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);

  const actions = useLeadActions({
    session, reload, onError: setActionError, onNotice: setNotice,
  });

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const navigate = useNavigate();

  const canCreate = session.permissions.includes('lead.create');
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p>
            {session.role === 'product_rm'
              ? 'Every lead carrying your product, in any card state. Read-only — you are informed, not assigned.'
              : 'Your book. Every lead carries a permanent card for every product.'}
          </p>
        </div>
        {canCreate && <button className="btn-primary" onClick={() => setCreating(true)}>New lead</button>}
      </div>

      <section className="card" style={{ marginBottom: 12 }}>
        <div className="card-body row wrap" style={{ gap: 10 }}>
          <input placeholder="Search name, mobile, email or PAN…" value={filters.q} onChange={set('q')} style={{ flex: '2 1 240px' }} />
          <select value={filters.stage} onChange={set('stage')} style={{ flex: '0 1 150px' }}>
            <option value="">Any stage</option>
            {(meta?.stages || []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filters.band} onChange={set('band')} style={{ flex: '0 1 150px' }}>
            <option value="">Any age band</option>
            {BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={filters.card_state} onChange={set('card_state')} style={{ flex: '0 1 180px' }}>
            <option value="">Any card state</option>
            {(meta?.card_states || []).map((s) => <option key={s} value={s}>{STATE_LABEL[s] || s}</option>)}
          </select>
          <select value={filters.product_id} onChange={set('product_id')} style={{ flex: '0 1 190px' }}>
            <option value="">Any product</option>
            {(meta?.products || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {Object.values(filters).some(Boolean) && (
            <button onClick={() => setFilters({ q: '', stage: '', band: '', card_state: '', product_id: '' })}>Clear</button>
          )}
        </div>
      </section>

      <div className="row" style={{ gap: 8, marginBottom: 'var(--gap)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className={advanced ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
          onClick={() => { setAdvanced((v) => !v); if (advanced) setFound(null); }}
        >
          <Icon name="filter_alt" size={16} /> {advanced ? 'Hide advanced search' : 'Advanced search'}
        </button>
      </div>

      {advanced && (
        <AdvancedSearch
          entity="lead"
          session={session}
          onResults={setFound}
          onClose={() => { setAdvanced(false); setFound(null); }}
        />
      )}

      {found && (
        <div className="result-bar">
          <span className="described">
            <strong>{found.total.toLocaleString('en-IN')}</strong> matched — {found.described}
          </span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm"
              onClick={() => setSelected(new Set(found.rows.map((r) => r.id)))}>
              Select all shown
            </button>
            {session.permissions.includes('list.create') && (
              <button type="button" className="btn btn-sm" onClick={() => actions.saveAsList(found.where)}>
                <Icon name="playlist_add" size={16} /> Save as list
              </button>
            )}
            {session.permissions.includes('data.export') && (
              <button type="button" className="btn btn-sm" onClick={() => actions.exportCsv('lead', found.where)}>
                <Icon name="download" size={16} /> Export CSV
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFound(null)}>Clear</button>
          </div>
        </div>
      )}

      <ErrorBanner error={error} />
      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between" style={{ marginBottom: 'var(--gap)' }}>
          <span>{notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>{loading ? 'Loading…' : found ? `${found.rows.length} of ${found.total} shown` : `${leads?.length ?? 0} leads`}</h2>
          <button className="btn-sm" onClick={reload}>Refresh</button>
        </div>
        {loading ? <Loading /> : !(found ? found.rows : leads)?.length ? <Empty>No leads match these filters.</Empty> : (
          <table>
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all shown"
                    checked={(found ? found.rows : leads).length > 0 && selected.size === (found ? found.rows : leads).length}
                    onChange={(e) => setSelected(e.target.checked ? new Set((found ? found.rows : leads).map((l) => l.id)) : new Set())}
                  />
                </th>
                {/* P2-07: display label only. The API name stays `card_state`
                    and the table stays `product_cards`, per the ENH-10 rule
                    that a rename is a label change and never a schema one. */}
                <th>Lead</th><th>Stage</th><th>Products</th><th>Age</th><th>Owner</th><th>Partner</th>
                <th className="num">AUM</th><th className="num">Score</th><th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {(found ? found.rows : leads).map((l) => (
                <tr
                  key={l.id}
                  className={`row-link ${selected.has(l.id) ? 'is-selected' : ''}`}
                  onClick={() => navigate(`/leads/${l.id}`)}
                >
                  {/* The checkbox and the action menu both stop propagation —
                      selecting or acting on a row must not also open it. */}
                  <td className="col-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.name}`}
                      checked={selected.has(l.id)}
                      onChange={() => toggle(l.id)}
                    />
                  </td>
                  <td>
                    <div style={{ fontWeight: 570 }}>{l.name}</div>
                    <div className="tiny muted row wrap" style={{ gap: 6 }}>
                      <CallNumber
                        lead={l}
                        permissions={session.permissions}
                        onCall={(x) => actions.run('call', x)}
                        dialling={actions.dialling === l.id}
                      />
                      <span>· {l.city || '—'} · {l.source}</span>
                      {l.open_tickets > 0 && <span className="badge badge-red">{l.open_tickets} open ticket</span>}
                    </div>
                  </td>
                  <td><span className="badge">{l.stage}</span></td>
                  <td><CardStrip cards={l.cards} /></td>
                  <td><AgeBadge band={l.age_band} days={l.age_days} /></td>
                  <td className="small">{l.owner_name || <span className="muted">—</span>}</td>
                  <td className="small muted">{l.partner_name || '—'}</td>
                  <td className="num small">{l.aum ? money(l.aum) : '—'}</td>
                  <td className="num">{l.score}</td>
                  <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                    <ActionMenu
                      lead={l}
                      permissions={session.permissions}
                      onAction={actions.run}
                      listMode
                      compact
                      align="end"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <BulkBar
        count={selected.size}
        permissions={session.permissions}
        onAction={(key) => actions.runBulk(key, [...selected])}
        onClear={() => setSelected(new Set())}
      />

      <ActionModal
        state={actions.modal}
        session={session}
        onClose={() => actions.setModal(null)}
        onDone={() => { actions.setModal(null); setSelected(new Set()); reload(); }}
        onNotice={setNotice}
      />

      {creating && (
        <NewLead meta={meta} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); navigate(`/leads/${id}`); }} />
      )}
    </>
  );
}

function NewLead({ meta, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', mobile: '', email: '', city: '', source: 'Website', risk_profile: 'Moderate', language: 'English', owner_id: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const lead = await api.post('/leads', { ...form, owner_id: form.owner_id || undefined });
      onCreated(lead.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="New lead" subtitle="A card for every active product is created automatically." onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBanner error={error} />
        <div className="field-row">
          <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} required autoFocus /></div>
          <div className="field"><label>Mobile</label><input value={form.mobile} onChange={set('mobile')} placeholder="9876543210" /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} /></div>
          <div className="field"><label>City</label><input value={form.city} onChange={set('city')} /></div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Source</label>
            <select value={form.source} onChange={set('source')}>
              {['Website', 'Partner referral', 'Walk-in branch', 'Campaign — WhatsApp', 'IPO enquiry', 'Referral — existing client', 'Bigul app', 'Webinar'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Risk profile</label>
            <select value={form.risk_profile} onChange={set('risk_profile')}>
              {['Conservative', 'Moderate', 'Aggressive'].map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Owner</label>
          <select value={form.owner_id} onChange={set('owner_id')}>
            <option value="">Assign to me</option>
            {(meta?.users || []).filter((u) => ['caller', 'dealer', 'sales_rm'].includes(u.role)).map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Create lead'}</button>
        </div>
      </form>
    </Modal>
  );
}
