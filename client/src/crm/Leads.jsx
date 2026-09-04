import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, money, shortDate, STATE_LABEL } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal, Spinner, CardStrip, AgeBadge } from '../components/ui.jsx';
import ActionMenu, { BulkBar } from '../components/ActionMenu.jsx';
import ActionModal from './ActionModals.jsx';
import { useLeadActions, CallNumber } from './leadActions.jsx';
import AdvancedSearch from '../components/AdvancedSearch.jsx';

const BANDS = ['Fresh', 'Active', 'Ageing', 'At Risk', 'Cold'];

/**
 * Which page numbers to show. P3-37.
 *
 * A window around the current page with the first and last always reachable,
 * and `null` where a gap belongs. 1,500 leads at 25 a page is sixty buttons,
 * which is not navigation.
 */
function pageWindow(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);

  const out = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pages - 1, page + 1);

  if (from > 2) out.push(null);
  for (let n = from; n <= to; n += 1) out.push(n);
  if (to < pages - 1) out.push(null);

  out.push(pages);
  return out;
}

/**
 * A column header that orders the list. P3-36.
 *
 * The arrow states the current order rather than the one a click would apply --
 * a control that shows its own destination reads as a promise, and every table
 * in this product shows its state instead.
 */
function SortTh({ col, sort, dir, onSort }) {
  const active = sort === col.key;
  return (
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" onClick={() => onSort(col.key)}
        aria-label={`Sort by ${col.label}`}>
        {col.label}
        <Icon
          name={!active ? 'unfold_more' : dir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
          size={13} />
      </button>
    </th>
  );
}

/* The sizes the ticket asked for. 50 is the default: enough to work a morning
   from without paging, small enough that the first paint is quick at 495k. */
const PAGE_SIZES = [25, 50, 100, 200];

/* Which columns can be ordered, and how each is read. Mirrors LEAD_SORTS on the
   server, which is the authority -- a key not in that table is ignored there,
   so offering one here would be a header that silently does nothing. */
const SORTABLE = [
  { key: 'name', label: 'Lead' },
  { key: 'stage', label: 'Stage' },
  { key: 'age', label: 'Age' },
  { key: 'owner', label: 'Owner' },
  { key: 'partner', label: 'Partner' },
];

export default function Leads({ session }) {
  /**
   * Filters seed from the URL, so a drill-through lands filtered.
   *
   * ENH-05 sends people here from a cockpit figure — `/leads?card_state=WARM`
   * has to arrive showing those leads, not the whole book. Reading the query
   * also means the filtered view is a real URL: shareable, bookmarkable, and
   * survives a refresh.
   */
  const [search, setSearch] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    q: search.get('q') ?? '',
    stage: search.get('stage') ?? '',
    band: search.get('band') ?? '',
    card_state: search.get('card_state') ?? '',
    product_id: search.get('product_id') ?? '',
  }));

  /* Order and position. P3-36, P3-37.
   *
   * In the URL beside the filters, for the reason the filters are there: a
   * colleague sent "the oldest unworked leads" should open on the oldest
   * unworked leads, and a refresh should not lose the reader's place. */
  const sort = search.get('sort') ?? '';
  const dir = search.get('dir') === 'asc' ? 'asc' : 'desc';
  const offset = Math.max(Number(search.get('offset')) || 0, 0);

  /* Page size is a preference rather than a view: it says how this person likes
     to read a list, not which list they are reading, so it follows them between
     screens instead of riding in a link they might send to somebody else. */
  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('bnz_lead_page_size'));
      return PAGE_SIZES.includes(saved) ? saved : 50;
    } catch { return 50; }
  });

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
    if (sort) { params.set('sort', sort); params.set('dir', dir); }
    params.set('limit', String(pageSize));
    params.set('offset', String(offset));
    return params.toString();
  }, [filters, sort, dir, offset, pageSize]);

  const [leads, { loading, error, reload, total }] = useApi(`/leads${query ? `?${query}` : ''}`);

  /* The unpaged count the route has always sent. Without it the header could
     only describe the page, and a list that says "50 leads" when there are
     1,500 is two numbers on one screen that disagree. */
  const count = total ?? leads?.length ?? 0;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.floor(offset / pageSize) + 1;

  const goto = (next) => {
    const p = new URLSearchParams(search);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') p.delete(k); else p.set(k, String(v));
    }
    setSearch(p, { replace: false });
  };

  /* A new sort starts at the first page. Staying on page 7 of a list that has
     just been reordered shows a slice of records nobody asked for. */
  const setSort = (key) => goto({
    sort: key,
    dir: sort === key && dir === 'desc' ? 'asc' : 'desc',
    offset: 0,
  });

  const choosePageSize = (n) => {
    setPageSize(n);
    try { localStorage.setItem('bnz_lead_page_size', String(n)); } catch { /* ignore */ }
    goto({ offset: 0 });
  };
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
                {/* Sortable where the server can order it, plain where it
                    cannot. Products, AUM and Score are assembled per page after
                    the query, so offering a header that only reordered the
                    fifty rows in front of you would be a sort that lies. */}
                {SORTABLE.slice(0, 2).map((c) => <SortTh key={c.key} col={c} sort={sort} dir={dir} onSort={setSort} />)}
                <th>Products</th>
                {SORTABLE.slice(2).map((c) => <SortTh key={c.key} col={c} sort={sort} dir={dir} onSort={setSort} />)}
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

        {/* Where you are in the book, and how to leave. P3-37.
            Hidden during an advanced search, which returns its own fixed result
            set rather than a page of one. */}
        {!found && !loading && (count > pageSize || offset > 0) && (
          <div className="card-foot row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="tiny muted">
              {(offset + 1).toLocaleString('en-IN')}–{Math.min(offset + pageSize, count).toLocaleString('en-IN')}
              {' of '}{count.toLocaleString('en-IN')}
            </span>

            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <label className="tiny muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Per page
                <select
                  value={pageSize}
                  onChange={(e) => choosePageSize(Number(e.target.value))}
                  aria-label="Leads per page"
                >
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>

              <button type="button" className="btn-ghost btn-sm" disabled={offset === 0}
                onClick={() => goto({ offset: Math.max(offset - pageSize, 0) })}>
                Previous
              </button>

              {/* Numbered, so page 7 of 34 is one click rather than six. A
                  window around the current page: thirty-four buttons is not
                  navigation, it is a wall. */}
              {pageWindow(page, pages).map((n, i) => (n === null
                ? <span key={`gap-${i}`} className="tiny muted">…</span>
                : (
                  <button
                    key={n}
                    type="button"
                    className={`btn-ghost btn-sm ${n === page ? 'is-active' : ''}`}
                    aria-current={n === page ? 'page' : undefined}
                    onClick={() => goto({ offset: (n - 1) * pageSize })}
                  >
                    {n}
                  </button>
                )))}

              <button type="button" className="btn-ghost btn-sm" disabled={page >= pages}
                onClick={() => goto({ offset: offset + pageSize })}>
                Next
              </button>
            </div>
          </div>
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
