import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, shortDate, appUrl } from '../api.js';
import {
  useApi, Icon, Loading, ErrorBanner, Empty, Modal, Spinner, Progress, Tabs,
} from '../components/ui.jsx';

const MODELS = ['Remisier', 'Agent', 'Trainee Entrepreneur', 'Associate', 'Authorised Person'];
const STATES = ['PROSPECT', 'QUALIFYING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'];

/* Rows per page. The list used to come back whole — no LIMIT on the route at
   all — and the two tabs were made by splitting that array in the browser. */
const PAGE = 50;

/** Hand the browser a file without a round trip to the server for it. */
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * A sortable column header.
 *
 * At module scope, not in the render body: a component declared inside one is a
 * new type on every render, and React tears down and rebuilds the whole header
 * row — on every keystroke of the search box, among other things.
 */
function Th({ label, col, className, sort, dir, onSort }) {
  if (!col) return <th className={className}>{label}</th>;
  return (
    <th className={className} aria-sort={sort === col ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" aria-label={`Sort by ${label}`} onClick={() => onSort(col)}>
        {label}
        <Icon name={sort !== col ? 'unfold_more' : dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={13} />
      </button>
    </th>
  );
}

export default function Partners({ session }) {
  const [tab, setTab] = useState('pipeline');
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const navigate = useNavigate();

  // A request per keystroke, against a book that can run to thousands.
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  // A different tab is a different question; page 4 of the old one means nothing.
  useEffect(() => { setOffset(0); }, [tab]);

  const params = new URLSearchParams({ group: tab, limit: String(PAGE), offset: String(offset) });
  if (sort) { params.set('sort', sort); params.set('dir', dir); }
  if (q) params.set('q', q);
  const query = `?${params}`;

  const [partners, { loading, error, reload, total }] = useApi(`/partners${query}`, [query]);
  /* The tiles and the tab counts come from the server over the whole book. They
     used to be computed from the array the browser happened to be holding,
     which was honest only while that array was everything. */
  const [summary] = useApi('/partners/summary');
  const [meta] = useApi('/partners/meta');

  if (loading && !partners) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const rows = partners ?? [];
  const count = total ?? rows.length;
  const orderBy = (key) => {
    setDir(sort === key && dir === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setOffset(0);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Partners</h1>
          <p>
            Partners are entities in the CRM, not users of it. Their own login lives on the
            {' '}<a href={appUrl("/portal")} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)' }}>Partner Portal</a>.
          </p>
        </div>
        {session.permissions.includes('partner.create') && (
          <button className="btn-primary" onClick={() => setCreating(true)}>Add partner prospect</button>
        )}
      </div>

      <div className="metrics">
        <div className="card stat"><div className="stat-label">In pipeline</div><div className="stat-value">{summary?.pipeline ?? '—'}</div></div>
        <div className="card stat tone-good"><div className="stat-label">Active</div><div className="stat-value">{summary?.active ?? '—'}</div></div>
        <div className="card stat"><div className="stat-label">Leads sourced</div><div className="stat-value">{summary?.sourced ?? '—'}</div></div>
        <div className="card stat"><div className="stat-label">This month</div><div className="stat-value">{summary?.this_month ?? '—'}</div></div>
      </div>

      <Tabs
        tabs={[{ key: 'pipeline', label: 'Onboarding pipeline' }, { key: 'active', label: 'Partner entities' }]}
        active={tab}
        onChange={setTab}
      />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'center' }}>
          {/* There was no way to find one partner except reading the table. */}
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search name, business, code or mobile"
            aria-label="Search partners"
            style={{ flex: '1 1 260px' }}
          />
          <span className="tiny muted">
            {q ? `${count} matching` : `${count} partner${count === 1 ? '' : 's'}`}
          </span>
          <span style={{ flex: 1 }} />
          {sort && (
            <button className="btn-ghost btn-sm" onClick={() => { setSort(null); setOffset(0); }}>
              <Icon name="close" size={14} /> Newest first
            </button>
          )}
          {meta?.may_export && (
            <button className="btn-ghost btn-sm" onClick={() => setExporting(true)}>
              <Icon name="download" size={15} /> Export
            </button>
          )}
        </div>
      </div>

      <section className="card">
        {!rows.length ? (
          <Empty>{q ? `No partner matches "${q}".` : 'Nothing here.'}</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <Th label="Partner" col="name" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="Model" col="partner_model" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="State" col="state_code" sort={sort} dir={dir} onSort={orderBy} />
                {/* Progress and the sourced counts are computed per row after
                    the query, so there is no column to order them by. */}
                <Th label={tab === 'pipeline' ? 'Onboarding' : 'Sourced / converted'} />
                <Th label="Leads" className="num" />
                <Th label="This month" className="num" />
                <Th label="Last activity" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="row-link" onClick={() => navigate(`/partners/${p.id}`)}>
                  <td>
                    <div style={{ fontWeight: 570 }}>{p.name}</div>
                    <div className="tiny muted">{p.business_name || p.city}{p.partner_code ? ` · ${p.partner_code}` : ''}</div>
                  </td>
                  <td className="small">{p.partner_model}</td>
                  <td>
                    <span className={`badge ${p.state_code === 'ACTIVE' ? 'badge-green' : ['SUSPENDED', 'TERMINATED'].includes(p.state_code) ? 'badge-red' : 'badge-amber'}`}>
                      {p.state_code}
                    </span>
                  </td>
                  <td>
                    {tab === 'pipeline'
                      ? <Progress pct={p.steps_total ? Math.round((p.steps_done / p.steps_total) * 100) : 0} />
                      : <span className="small">{p.converted_count} of {p.sourced_count} converted</span>}
                  </td>
                  <td className="num">{p.sourced_count}</td>
                  <td className="num">{p.sourced_this_month}</td>
                  <td className="small muted">{p.last_activity ? shortDate(p.last_activity) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Where you are in the book. Without this the tab showed a page and
            called it everything. */}
        {count > 0 && (count > PAGE || offset > 0) && (
          <div className="card-foot row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="tiny muted">
              {offset + 1}–{offset + rows.length} of {count.toLocaleString('en-IN')}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn-ghost btn-sm" disabled={offset === 0}
                onClick={() => { setOffset(Math.max(offset - PAGE, 0)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                <Icon name="chevron_left" size={15} /> Previous
              </button>
              <button className="btn-ghost btn-sm" disabled={offset + rows.length >= count}
                onClick={() => { setOffset(offset + PAGE); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                Next <Icon name="chevron_right" size={15} />
              </button>
            </div>
          </div>
        )}
      </section>

      {creating && <NewPartner onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); navigate(`/partners/${id}`); }} />}
      {exporting && <ExportPartners meta={meta} count={count} query={query} onClose={() => setExporting(false)} />}
    </>
  );
}

/**
 * Export the partner list, as filtered.
 *
 * The tab's own query string goes with it, so what leaves is what was on
 * screen — the same group, the same search, the same book. PAN and bank account
 * are not in the column list at all: both are encrypted at rest, so an export
 * of them would carry ciphertext.
 */
function ExportPartners({ meta, count, query, onClose }) {
  const columns = meta?.columns ?? [];
  const [picked, setPicked] = useState(
    ['partner_code', 'name', 'business_name', 'partner_model', 'state_code', 'city', 'created_at'],
  );
  const [unmask, setUnmask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const toggle = (key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const hasPii = picked.some((k) => columns.find((c) => c.key === k)?.pii);

  const run = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await api.post(`/partners/export${query}`, { columns: picked, unmask });
      download(r.filename, r.csv);
      onClose();
    } catch (e) { setProblem(e.message); setBusy(false); }
  };

  return (
    <Modal title="Export partners"
      subtitle={`${count.toLocaleString('en-IN')} partner${count === 1 ? '' : 's'}, as currently filtered`}
      onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

        <div className="stack" style={{ gap: 2, maxHeight: '40vh', overflowY: 'auto' }}>
          {columns.map((c) => (
            <label key={c.key} className="row" style={{ gap: 8, padding: '6px 2px', cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.includes(c.key)} onChange={() => toggle(c.key)} />
              <span style={{ flex: 1 }}>{c.label}</span>
              {c.pii && <span className="chip chip-muted tiny">Identifier</span>}
            </label>
          ))}
        </div>

        {hasPii && (
          meta?.may_unmask ? (
            <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={unmask} onChange={(e) => setUnmask(e.target.checked)} />
              <span className="small">
                Include mobile and email in full.
                <span className="muted"> Recorded against your name in the audit log.</span>
              </span>
            </label>
          ) : (
            <div className="tiny muted">
              <Icon name="lock" size={13} /> Mobile and email leave masked — unmasking is a separate permission.
            </div>
          )
        )}

        <div className="tiny muted">
          <Icon name="lock" size={13} /> PAN and bank details are never exported — they are encrypted at rest.
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !picked.length} onClick={run}>
            {busy ? 'Building…' : 'Download CSV'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewPartner({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', business_name: '', partner_model: 'Remisier', mobile: '', email: '', city: '', state: '', pan: '', sebi_reg_no: '', commission_pct: 25 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try { const p = await api.post('/partners', form); onCreated(p.id); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Add partner prospect" subtitle="Enters the qualification pipeline; onboarding steps are created automatically." onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBanner error={error} />
        <div className="field-row">
          <div className="field"><label>Contact name</label><input value={form.name} onChange={set('name')} required autoFocus /></div>
          <div className="field"><label>Business name</label><input value={form.business_name} onChange={set('business_name')} /></div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Partner model</label>
            <select value={form.partner_model} onChange={set('partner_model')}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select>
            <div className="hint">The four models Bonanza publishes, plus Authorised Person.</div>
          </div>
          <div className="field"><label>Commission %</label><input type="number" value={form.commission_pct} onChange={set('commission_pct')} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Mobile</label><input value={form.mobile} onChange={set('mobile')} /></div>
          <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>City</label><input value={form.city} onChange={set('city')} /></div>
          <div className="field"><label>State</label><input value={form.state} onChange={set('state')} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>PAN</label><input value={form.pan} onChange={set('pan')} /></div>
          <div className="field"><label>SEBI registration (if any)</label><input value={form.sebi_reg_no} onChange={set('sebi_reg_no')} /></div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Create prospect'}</button>
        </div>
      </form>
    </Modal>
  );
}
