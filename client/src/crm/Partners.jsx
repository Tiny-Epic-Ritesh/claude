import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, shortDate, appUrl } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Progress, Tabs } from '../components/ui.jsx';

const MODELS = ['Remisier', 'Agent', 'Trainee Entrepreneur', 'Associate', 'Authorised Person'];
const STATES = ['PROSPECT', 'QUALIFYING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'];

export default function Partners({ session }) {
  const [tab, setTab] = useState('pipeline');
  const [partners, { loading, error, reload }] = useApi('/partners');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const pipeline = partners.filter((p) => ['PROSPECT', 'QUALIFYING', 'ONBOARDING'].includes(p.state_code));
  const active = partners.filter((p) => ['ACTIVE', 'SUSPENDED', 'TERMINATED'].includes(p.state_code));
  const rows = tab === 'pipeline' ? pipeline : active;

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
        <div className="card stat"><div className="stat-label">In pipeline</div><div className="stat-value">{pipeline.length}</div></div>
        <div className="card stat tone-good"><div className="stat-label">Active</div><div className="stat-value">{partners.filter((p) => p.state_code === 'ACTIVE').length}</div></div>
        <div className="card stat"><div className="stat-label">Leads sourced</div><div className="stat-value">{partners.reduce((s, p) => s + p.sourced_count, 0)}</div></div>
        <div className="card stat"><div className="stat-label">This month</div><div className="stat-value">{partners.reduce((s, p) => s + p.sourced_this_month, 0)}</div></div>
      </div>

      <Tabs
        tabs={[{ key: 'pipeline', label: 'Onboarding pipeline', count: pipeline.length }, { key: 'active', label: 'Partner entities', count: active.length }]}
        active={tab}
        onChange={setTab}
      />

      <section className="card">
        {!rows.length ? <Empty>Nothing here.</Empty> : (
          <table>
            <thead>
              <tr>
                <th>Partner</th><th>Model</th><th>State</th>
                <th style={{ width: 150 }}>{tab === 'pipeline' ? 'Onboarding' : 'Sourced / converted'}</th>
                <th className="num">Leads</th><th className="num">This month</th><th>Last activity</th>
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
      </section>

      {creating && <NewPartner onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); navigate(`/partners/${id}`); }} />}
    </>
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
