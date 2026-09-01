import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import TabVisibility from './TabVisibility.jsx';
import Dispositions from './Dispositions.jsx';
import KraSetup from './KraSetup.jsx';
import FieldMasking from './FieldMasking.jsx';
import { api, appUrl, token, rupees, dateTime, shortDate, ROLE_LABEL } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Tabs, Icon, useDropUp } from '../components/ui.jsx';
import ObjectManager from './ObjectManager.jsx';
import RolesSetup from './RolesSetup.jsx';
import { stashParentToken } from './GhostBar.jsx';
import Telephony from './Telephony.jsx';
import Logs from './Logs.jsx';
import Database from './Database.jsx';

export default function Admin({ session }) {
  const has = (p) => session.permissions.includes(p);
  const tabs = [
    has('admin.users') && { key: 'users', label: 'Users' },
    { key: 'roles', label: 'Roles & permissions' },
    has('admin.roles') && { key: 'navigation', label: 'Navigation' },
    has('admin.users') && { key: 'masking', label: 'Field masking' },
    has('admin.objects') && { key: 'objects', label: 'Objects & fields' },
    has('admin.products') && { key: 'products', label: 'Products' },
    has('admin.kyc.journeys') && { key: 'journeys', label: 'KYC journeys' },
    has('admin.rules') && { key: 'rules', label: 'Rule builder' },
    has('admin.rules') && { key: 'outcomes', label: 'Call outcomes' },
    has('admin.rules') && { key: 'targets', label: 'Targets & incentives' },
    has('admin.sla') && { key: 'sla', label: 'SLA & categories' },
    has('admin.sla') && { key: 'calendars', label: 'Working calendars' },
    has('admin.templates') && { key: 'templates', label: 'Templates' },
    has('admin.content') && { key: 'content', label: 'Content library' },
    has('campaign.manage') && { key: 'campaigns', label: 'Campaigns' },
    has('admin.system') && { key: 'telephony', label: 'Telephony' },
    { key: 'integrations', label: 'Integrations' },
    has('admin.system') && { key: 'meta', label: 'Facebook & Instagram' },
    { key: 'residency', label: 'Data residency' },
    has('report.system') && { key: 'logs', label: 'API & logs' },
    has('report.system') && { key: 'database', label: 'Database' },
    has('report.system') && { key: 'audit', label: 'Audit log' },
  ].filter(Boolean);

  /* The tab lives in the URL rather than in state.
   *
   * `?tab=objects` looked supported and was not — it was read by nothing, so a
   * link into a particular tab silently landed on Users. That matters now the
   * object screen links to the settings that belong to it, and it means an
   * administrator can bookmark or send "the SLA screen" like any other page. */
  const [search, setSearch] = useSearchParams();
  const wanted = search.get('tab');
  const tab = tabs.some((t) => t.key === wanted) ? wanted : tabs[0]?.key;
  const setTab = (key) => setSearch((prev) => {
    const next = new URLSearchParams(prev);
    next.set('tab', key);
    return next;
  }, { replace: true });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <p>Configuration is data, not code — products, journeys, rules and SLAs are all editable here.</p>
        </div>
      </div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'users' && <Users />}
      {tab === 'roles' && <RolesSetup />}
      {tab === 'navigation' && <TabVisibility />}
      {tab === 'masking' && <FieldMasking />}
      {tab === 'objects' && <ObjectManager />}
      {tab === 'products' && <Products />}
      {tab === 'journeys' && <Journeys />}
      {tab === 'rules' && <Rules />}
      {tab === 'outcomes' && <Dispositions />}
      {tab === 'targets' && <KraSetup />}
      {tab === 'sla' && <Sla />}
      {tab === 'calendars' && <Calendars />}
      {tab === 'templates' && <Templates />}
      {tab === 'content' && <Content />}
      {tab === 'campaigns' && <Campaigns />}
      {tab === 'telephony' && <Telephony />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'meta' && <MetaConnector />}
      {tab === 'residency' && <Residency session={session} />}
      {tab === 'logs' && <Logs />}
      {tab === 'database' && <Database />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

/* ---------------------------------------------------------------- users */

function Users() {
  const [users, { loading, error, reload }] = useApi('/admin/users');
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState(null);
  const [problem, setProblem] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <section className="card">
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {link && <ResetLink issued={link} onClose={() => setLink(null)} />}
      <div className="card-head"><h2>{users.length} users</h2><button className="btn-sm btn-primary" onClick={() => setCreating(true)}>Create user</button></div>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Product</th><th>Manager</th><th className="num">Leads</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={{ fontWeight: 545 }}>{u.name}</td>
              <td className="small muted">{u.email}</td>
              <td><span className="badge badge-blue">{ROLE_LABEL[u.role] || u.role}</span></td>
              <td className="small">{u.product_name || '—'}</td>
              <td className="small muted">{u.manager_name || '—'}</td>
              <td className="num">{u.lead_count}</td>
              <td className="num">
                <UserActions user={u} reload={reload} onLink={setLink} onError={setProblem} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating && <NewUser onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />}
    </section>
  );
}

/**
 * What an administrator can do to a user record (P2-04).
 *
 * Sign in as, send a reset link, disable. Deliberately not a menu of twenty
 * things: these are the three that come up, and burying the dangerous one in a
 * list is how it gets clicked by accident.
 */
function UserActions({ user, reload, onLink, onError }) {
  const [busy, setBusy] = useState(null);

  const ghost = async () => {
    setBusy('ghost');
    try {
      const r = await api.post(`/setup/users/${user.id}/ghost`, {});
      /* The administrator's own token is stashed, not discarded, so leaving is
         a swap back rather than a second sign-in. sessionStorage, so closing
         the tab cannot leave it lying about. */
      stashParentToken(token.get('crm'));
      token.set('crm', r.token);
      window.location.assign(appUrl('/'));
    } catch (err) { onError(err.message); setBusy(null); }
  };

  const resetLink = async () => {
    setBusy('reset');
    try { onLink(await api.post(`/setup/users/${user.id}/reset-link`, {})); }
    catch (err) { onError(err.message); }
    finally { setBusy(null); }
  };

  return (
    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      {Boolean(user.active) && (
        <>
          <button className="btn-sm" disabled={busy} onClick={ghost} title={`See the product as ${user.name} sees it`}>
            {busy === 'ghost' ? <Spinner /> : 'Sign in as'}
          </button>
          <button className="btn-sm" disabled={busy} onClick={resetLink}>
            {busy === 'reset' ? <Spinner /> : 'Reset link'}
          </button>
        </>
      )}
      <button className="btn-sm" onClick={async () => { await api.patch(`/admin/users/${user.id}`, { active: user.active ? 0 : 1 }); reload(); }}>
        {user.active ? 'Disable' : 'Enable'}
      </button>
    </span>
  );
}

/**
 * The reset link, shown once.
 *
 * Not emailed: SMTP is configured per environment, and a link that silently
 * fails to send is worse than one the administrator can see they are holding —
 * they know whether they delivered it.
 */
function ResetLink({ issued, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Password reset link" subtitle={`${issued.user.name} · ${issued.user.email}`} onClose={onClose}>
      <div className="stack" style={{ gap: 13 }}>
        <div className="glass notice notice-warn">
          <Icon name="warning" size={16} />
          <div>
            Send this to {issued.user.name} yourself — nothing was emailed. It works
            once and expires in {issued.expires_in_minutes} minutes, and using it ends
            every session they currently have.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input readOnly value={issued.link} className="api-name" onFocus={(e) => e.target.select()} />
          <button className="btn-ghost btn-sm" onClick={async () => {
            try { await navigator.clipboard.writeText(issued.link); setCopied(true); } catch { setCopied(false); }
          }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

function NewUser({ onClose, onCreated }) {
  const [meta] = useApi('/meta');
  const [form, setForm] = useState({ name: '', email: '', role: 'sales_rm', product_type_id: '', password: 'bonanza' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal title="Create user" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await api.post('/admin/users', { ...form, product_type_id: form.product_type_id || undefined }); onCreated(); }
        catch (err) { setError(err.message); setBusy(false); }
      }}>
        <ErrorBanner error={error} />
        <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} required autoFocus /></div>
        <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} required /></div>
        <div className="field-row">
          <div className="field">
            <label>Role</label>
            <select value={form.role} onChange={set('role')}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Product (Product RM only)</label>
            <select value={form.product_type_id} onChange={set('product_type_id')}>
              <option value="">—</option>
              {(meta?.products || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field"><label>Password</label><input value={form.password} onChange={set('password')} /></div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- roles */

/**
 * The read-only matrix. Superseded as the roles screen by RolesSetup (P2-05),
 * kept because it answers a question the editor does not: "who can do X"
 * across every role at once, which is the question an auditor asks.
 *
 * Exported so RolesSetup can render it beneath the editable list.
 */
export function Roles() {
  const [data, { loading }] = useApi('/admin/roles');
  if (loading || !data) return <Loading />;

  const permissions = Object.keys(data.matrix).sort();
  return (
    <section className="card" style={{ overflowX: 'auto' }}>
      <div className="card-head">
        <h2>Permission matrix</h2>
        <span className="tiny muted">Every role at once — enforced at the API, not hidden in the UI</span>
      </div>
      <table style={{ minWidth: 900 }}>
        <thead>
          <tr>
            <th>Permission</th>
            {data.roles.map((r) => <th key={r.code} className="num" style={{ writingMode: 'vertical-rl', height: 110 }}>{r.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {permissions.map((p) => (
            <tr key={p}>
              <td className="small" style={{ fontWeight: 545 }}>{p}</td>
              {data.roles.map((r) => (
                <td key={r.code} className="num" style={{ color: data.matrix[p].includes(r.code) ? 'var(--green)' : 'var(--border)' }}>
                  {data.matrix[p].includes(r.code) ? '●' : '·'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------- products */

function Products() {
  const [products, { loading, reload }] = useApi('/admin/products');
  if (loading) return <Loading />;

  return (
    <section className="card">
      <div className="card-head"><h2>{products.length} product types</h2><span className="tiny muted">Each generates a permanent card on every lead</span></div>
      <table>
        <thead><tr><th>Product</th><th>Category</th><th className="num">Minimum</th><th>Lock-in</th><th>Risk</th><th>KYC</th><th /></tr></thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>
                <div style={{ fontWeight: 570 }}>{p.name}</div>
                <div className="tiny muted">{p.code}</div>
              </td>
              <td className="small">{p.category}</td>
              <td className="num small">{p.min_investment ? rupees(p.min_investment) : '—'}</td>
              <td className="small muted">{p.lock_in || '—'}</td>
              <td className="small">{p.risk_category || '—'}</td>
              <td>{p.requires_kyc ? <span className="badge badge-blue">Required</span> : <span className="badge">Not required</span>}</td>
              <td className="num">
                <button className="btn-sm" onClick={async () => { await api.patch(`/admin/products/${p.id}`, { active: p.active ? 0 : 1 }); reload(); }}>
                  {p.active ? 'Disable' : 'Enable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------- KYC composer */

function Journeys() {
  const [data, { loading }] = useApi('/admin/kyc/journeys');
  if (loading || !data) return <Loading />;

  return (
    <div className="stack">
      <div className="notice">
        The journey composer picks which of the {data.master_steps.length} master steps apply to each product, in what order,
        with per-step timers. Conditional steps (bank proof, income proof) only appear when the applicant's data triggers them.
      </div>
      {data.journeys.map((j) => (
        <section className="card" key={j.product.id}>
          <div className="card-head">
            <h2>{j.product.name}</h2>
            <span className="badge">{j.steps.length} steps</span>
          </div>
          <div className="card-body">
            <div className="row wrap" style={{ gap: 5 }}>
              {j.steps.map((s, i) => {
                const master = data.master_steps.find((m) => m.code === s.step_code);
                return (
                  <span key={s.step_code} className={`badge ${s.conditional_on ? 'badge-amber' : ''}`} title={s.conditional_on ? `Conditional: ${s.conditional_on}` : ''}>
                    {i + 1}. {master?.label || s.step_code}
                  </span>
                );
              })}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- rules */

function Rules() {
  const [data, { loading, reload }] = useApi('/admin/rules');
  const [meta] = useApi('/meta');
  const [result, setResult] = useState(null);
  const [editing, setEditing] = useState(null);   // rule | 'new'
  const [busy, setBusy] = useState(false);
  if (loading || !data) return <Loading />;

  const dryRun = async (id) => {
    setBusy(true);
    try { setResult(await api.post(`/admin/rules/${id}/run`, { dry_run: true })); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="notice">
        IF / AND / THEN automation. <strong>Dry-run</strong> evaluates every lead and reports what would happen without sending anything.
      </div>

      <div className="row-between" style={{ marginBottom: 'var(--gap)' }}>
        <span className="tiny muted">{data.rules.length} rules · {data.rules.filter((r) => r.enabled).length} enabled</span>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
          <Icon name="add" /> New rule
        </button>
      </div>

      <div className="stack">
        {data.rules.map((r) => (
          <section className="card" key={r.id}>
            <div className="card-head">
              <div>
                <h2>{r.name}</h2>
                <div className="tiny muted">{r.description}</div>
              </div>
              <div className="row">
                <span className={`badge ${r.enabled ? 'badge-green' : ''}`}>{r.enabled ? 'Enabled' : 'Disabled'}</span>
                <span className="badge">fired {r.fire_count}×</span>
                <button className="btn-sm" disabled={busy} onClick={() => dryRun(r.id)}>Dry run</button>
                <button className="btn-sm" onClick={() => setEditing(r)}>Edit</button>
                <button className="btn-sm" onClick={async () => {
                  await api.post('/admin/rules', {
                    name: `${r.name} (copy)`, description: r.description,
                    conditions: r.conditions, actions: r.actions, enabled: 0, priority: r.priority,
                  });
                  reload();
                }}>Duplicate</button>
                <button className="btn-sm" onClick={async () => { await api.patch(`/admin/rules/${r.id}`, { enabled: r.enabled ? 0 : 1 }); reload(); }}>
                  {r.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
            <div className="card-body">
              <div className="small">
                <strong>IF</strong>{' '}
                {r.conditions.map((c, i) => (
                  <span key={i}>
                    {i > 0 && <em className="muted"> {c.join || 'AND'} </em>}
                    <code>{c.field}{c.product_code ? `(${c.product_code})` : ''} {c.op} {String(c.value)}</code>
                  </span>
                ))}
              </div>
              <div className="small" style={{ marginTop: 6 }}>
                <strong>THEN</strong>{' '}
                {r.actions.map((a, i) => <span key={i} className="badge badge-blue" style={{ marginRight: 4 }}>{a.type}</span>)}
              </div>
            </div>
          </section>
        ))}
      </div>

      {editing && (
        <RuleBuilder
          rule={editing === 'new' ? null : editing}
          fields={data.condition_fields}
          actionTypes={data.action_types}
          templates={meta?.templates ?? []}
          products={meta?.products ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id, thenDryRun) => {
            setEditing(null);
            reload();
            if (thenDryRun) dryRun(id);
          }}
        />
      )}

      {result && (
        <Modal title={`Dry run — ${result.rule}`} subtitle={`${result.matched_count} of ${result.evaluated} leads matched. Nothing was sent.`} onClose={() => setResult(null)} wide>
          {!result.matched.length ? <Empty>No leads matched these conditions.</Empty> : (
            <table>
              <thead><tr><th>Lead</th><th>Actions that would run</th></tr></thead>
              <tbody>
                {result.matched.map((m) => (
                  <tr key={m.lead_id}>
                    <td style={{ fontWeight: 545 }}>{m.lead_name}</td>
                    <td className="small">
                      {m.actions.map((a, i) => (
                        <div key={i}><span className="badge badge-blue">{a.action}</span> <span className="muted">{JSON.stringify(a.params).slice(0, 120)}</span></div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ SLA */

function Sla() {
  const [sla, { loading }] = useApi('/admin/sla');
  const [cats] = useApi('/admin/categories');
  if (loading || !sla) return <Loading />;

  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head"><h2>SLA policies</h2><span className="tiny muted">Business hours only · per product</span></div>
        <table>
          <thead><tr><th>Product</th><th>Priority</th><th className="num">Response</th><th className="num">Resolution</th></tr></thead>
          <tbody>
            {sla.policies.map((p) => (
              <tr key={p.id}>
                <td className="small">{p.product_name || 'All products'}</td>
                <td><span className="badge">{p.priority}</span></td>
                <td className="num small">{p.response_mins} min</td>
                <td className="num small">{Math.round(p.resolution_mins / 60)} h</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="card-body tiny muted">
          Defaults where no policy exists: {Object.entries(sla.defaults).map(([k, v]) => `${k} ${v.response_mins}m/${Math.round(v.resolution_mins / 60)}h`).join(' · ')}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Ticket categories</h2><span className="tiny muted">Drive auto-assignment</span></div>
        <table>
          <tbody>
            {(cats || []).map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="num"><span className="badge badge-blue">{ROLE_LABEL[c.auto_assign_role] || c.auto_assign_role || 'unassigned'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ templates */

function Templates() {
  const [rows, { loading, reload }] = useApi('/admin/templates');
  if (loading) return <Loading />;
  return (
    <section className="card">
      <div className="card-head"><h2>{rows.length} templates</h2></div>
      <table>
        <thead><tr><th>Name</th><th>Channel</th><th>Body</th><th>Approved</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td style={{ fontWeight: 545 }}>{t.name}</td>
              <td><span className="badge">{t.channel}</span></td>
              <td className="small muted" style={{ maxWidth: 460 }}>{t.body.slice(0, 150)}{t.body.length > 150 ? '…' : ''}</td>
              <td className="num">
                <button className="btn-sm" onClick={async () => { await api.patch(`/admin/templates/${t.id}`, { approved: t.approved ? 0 : 1 }); reload(); }}>
                  {t.approved ? 'Approved' : 'Approve'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* -------------------------------------------------------------- content */

function Content() {
  const [rows, { loading }] = useApi('/admin/content');
  if (loading) return <Loading />;
  return (
    <section className="card">
      <div className="card-head"><h2>Content library</h2><span className="tiny muted">Surfaces in the in-call pitch panel</span></div>
      <table>
        <thead><tr><th>Item</th><th>Type</th><th>Product</th><th>Owner role</th><th>Expiry</th><th className="num">Sends</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td style={{ fontWeight: 545 }}>{c.name}<div className="tiny muted">v{c.version}{c.kyc_step_code ? ` · step ${c.kyc_step_code}` : ''}</div></td>
              <td><span className="badge">{c.type}</span></td>
              <td className="small">{c.product_name || '—'}</td>
              <td className="small muted">{ROLE_LABEL[c.owner_role] || c.owner_role}</td>
              <td>
                {c.expired ? <span className="badge badge-red">Expired</span>
                  : c.expiring_soon ? <span className="badge badge-amber">{shortDate(c.expiry_date)}</span>
                    : <span className="small muted">{shortDate(c.expiry_date)}</span>}
              </td>
              <td className="num">{c.send_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------ campaigns */

/**
 * Campaigns.
 *
 * This screen was read-only but for a Send button — no way to create a campaign
 * even though the API accepted one, and no edit at any layer. A Marketing
 * Manager holding `campaign.manage` could look at campaigns and send them, and
 * nothing else.
 *
 * The audience preview is the part worth arguing for. Consent rules that
 * silently drop recipients teach nobody anything; showing "412 excluded, 388 of
 * them opted out" before the send makes the rule visible at the moment it
 * matters, and stops a marketer wondering why the reach was short afterwards.
 */
function Campaigns() {
  const [rows, { loading, reload }] = useApi('/admin/campaigns');
  const [editing, setEditing] = useState(null);   // campaign | 'new'
  const [audience, setAudience] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  if (loading) return <Loading />;

  const act = async (id, verb, fn) => {
    setBusy(`${id}:${verb}`);
    setError(null);
    try { const r = await fn(); if (r?.note) setNotice(r.note); reload(); }
    catch (err) { setError(err.message); }
    finally { setBusy(null); }
  };

  const STATUS_TONE = {
    Sent: 'badge-green', Scheduled: 'badge-accent', Paused: 'badge-amber', Draft: '',
  };

  return (
    <>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between" style={{ marginBottom: 'var(--gap)' }}>
          <span>{notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Campaigns</h2>
            <p className="tiny muted" style={{ margin: '2px 0 0' }}>
              {rows.length} active · every send respects marketing opt-outs
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            <Icon name="add" /> New campaign
          </button>
        </div>

        {rows.length === 0 ? (
          <Empty>No campaigns yet. Create one to reach a lead list.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th><th>Channel</th><th>List</th><th>Status</th>
                  <th className="num">Sent</th><th className="num">Opened</th><th className="num">Clicked</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const sent = c.status === 'Sent';
                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 545 }}>{c.name}</div>
                        <div className="tiny muted">
                          {c.template_name || 'No template'}
                          {c.scheduled_at && ` · scheduled ${shortDate(c.scheduled_at)}`}
                          {c.created_by_name && ` · by ${c.created_by_name}`}
                        </div>
                      </td>
                      <td><span className="badge">{c.channel}</span></td>
                      <td className="small muted">
                        {c.list_name || '—'}
                        {c.list_size > 0 && <div className="tiny muted">{c.list_size} on the list</div>}
                      </td>
                      <td><span className={`badge ${STATUS_TONE[c.status] ?? ''}`}>{c.status}</span></td>
                      <td className="num">{c.sent}</td>
                      <td className="num">{c.opened}</td>
                      <td className="num">{c.clicked}</td>
                      <td className="col-actions">
                        <CampaignActions
                          campaign={c}
                          busy={busy}
                          onEdit={() => setEditing(c)}
                          onPreview={() => setAudience(c)}
                          onAct={act}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <CampaignEditor
          campaign={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      {audience && (
        <AudiencePreview
          campaign={audience}
          onClose={() => setAudience(null)}
          onSend={async () => {
            const c = audience;
            setAudience(null);
            await act(c.id, 'send', () => api.post(`/admin/campaigns/${c.id}/send`));
          }}
        />
      )}
    </>
  );
}

/** Every action a campaign can take, in the state it is currently in. */
function CampaignActions({ campaign: c, busy, onEdit, onPreview, onAct }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const sent = c.status === 'Sent';
  const working = busy?.startsWith(`${c.id}:`);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  const items = [
    !sent && { key: 'edit', label: 'Edit', icon: 'edit', run: onEdit },
    { key: 'preview', label: 'Preview recipients', icon: 'group', run: onPreview },
    !sent && { key: 'test', label: 'Test send to me', icon: 'send_and_archive',
      run: () => onAct(c.id, 'test', () => api.post(`/admin/campaigns/${c.id}/test`)) },
    { key: 'duplicate', label: 'Duplicate', icon: 'content_copy',
      run: () => onAct(c.id, 'duplicate', () => api.post(`/admin/campaigns/${c.id}/duplicate`)) },
    c.status === 'Scheduled' && { key: 'pause', label: 'Pause', icon: 'pause',
      run: () => onAct(c.id, 'pause', () => api.post(`/admin/campaigns/${c.id}/pause`)) },
    c.status === 'Paused' && { key: 'resume', label: 'Resume', icon: 'play_arrow',
      run: () => onAct(c.id, 'resume', () => api.post(`/admin/campaigns/${c.id}/resume`)) },
    { key: 'delete', label: sent ? 'Archive' : 'Delete', icon: sent ? 'inventory_2' : 'delete', danger: !sent,
      run: () => onAct(c.id, 'delete', () => api.del(`/admin/campaigns/${c.id}`)) },
  ].filter(Boolean);

  const menuRef = useRef(null);
  const dropUp = useDropUp(open, wrap, menuRef, [items.length]);

  return (
    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      {!sent && (
        <button
          className="btn-sm btn-primary"
          disabled={working}
          onClick={onPreview}
        >
          {working ? <Spinner /> : 'Send'}
        </button>
      )}

      <div className="action-menu" ref={wrap}>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Actions for ${c.name}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="more_vert" />
        </button>
        {open && (
          /* P2-24: the row this sits on is often near the foot of the table,
             where a menu pinned below the trigger runs off the bottom of the
             window. Same hook as the record ActionMenu, so the two cannot
             drift apart again. */
          <div
            ref={menuRef}
            className={`popover action-popover align-end ${dropUp ? 'drop-up' : ''}`}
            role="menu"
          >
            {items.map((i) => (
              <button
                key={i.key}
                type="button"
                role="menuitem"
                className={`action-item ${i.danger ? 'is-danger' : ''}`}
                onClick={() => { setOpen(false); i.run(); }}
              >
                <Icon name={i.icon} />
                <span className="action-label">{i.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- editor */

function CampaignEditor({ campaign, onClose, onSaved }) {
  const [meta] = useApi('/meta');
  const [lists] = useApi('/lists');
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    channel: campaign?.channel ?? 'whatsapp',
    template_id: campaign?.template_id ?? '',
    list_id: campaign?.list_id ?? '',
    scheduled_at: campaign?.scheduled_at?.slice(0, 16).replace(' ', 'T') ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const templates = (meta?.templates ?? []).filter((t) => t.channel === form.channel);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = {
        ...form,
        template_id: form.template_id || null,
        scheduled_at: form.scheduled_at ? form.scheduled_at.replace('T', ' ') : null,
      };
      if (campaign) await api.patch(`/admin/campaigns/${campaign.id}`, body);
      else await api.post('/admin/campaigns', body);
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal
      title={campaign ? `Edit ${campaign.name}` : 'New campaign'}
      subtitle="Nothing sends until you choose to send it."
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <label className="span-2">
          <span>Campaign name</span>
          <input value={form.name} onChange={set('name')} required autoFocus
            placeholder="Diwali PMS push" />
        </label>

        <label>
          <span>Channel</span>
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value, template_id: '' })}>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
          <small className="muted">WhatsApp goes through Smartping.</small>
        </label>

        <label>
          <span>Send to</span>
          <select value={form.list_id} onChange={set('list_id')} required>
            <option value="">Choose a list…</option>
            {(lists ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.member_count != null ? ` (${l.member_count})` : ''}</option>
            ))}
          </select>
        </label>

        <label className="span-2">
          <span>Template <span className="muted">(optional)</span></span>
          <select value={form.template_id} onChange={set('template_id')}>
            <option value="">No template — a plain update</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {templates.length === 0 && (
            <small className="muted">No approved {form.channel} templates yet. Add one under Templates.</small>
          )}
        </label>

        <label className="span-2">
          <span>Schedule <span className="muted">(leave empty to keep it a draft)</span></span>
          <input type="datetime-local" value={form.scheduled_at} onChange={set('scheduled_at')} />
        </label>

        <div className="glass notice span-2">
          <Icon name="shield" />
          <div className="tiny">
            Anyone on the list who has opted out of marketing, has no contact details,
            or has a number flagged invalid will be skipped automatically. You can see
            exactly who before you send.
          </div>
        </div>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.list_id}>
            {busy ? <Spinner /> : campaign ? 'Save changes' : 'Create campaign'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- audience */

const EXCLUSION_LABEL = {
  opted_out: 'Opted out of marketing',
  invalid_destination: 'Mobile flagged invalid',
  no_destination: 'No contact details',
  unknown_channel: 'Channel unavailable',
};

function AudiencePreview({ campaign, onClose, onSend }) {
  const [data] = useApi(`/admin/campaigns/${campaign.id}/audience`);
  const sent = campaign.status === 'Sent';

  if (!data) return <Modal title="Who this reaches" onClose={onClose}><Loading /></Modal>;

  return (
    <Modal title="Who this reaches" subtitle={campaign.name} onClose={onClose} wide>
      <div className="stat-strip" style={{ marginBottom: 'var(--gap)' }}>
        <div className="glass stat-tile">
          <div className="stat-tile-label">On the list</div>
          <div className="stat-tile-value">{data.list_size}</div>
        </div>
        <div className="glass stat-tile tone-ok">
          <div className="stat-tile-label">Will receive it</div>
          <div className="stat-tile-value">{data.reachable}</div>
        </div>
        <div className={`glass stat-tile ${data.excluded ? 'tone-warn' : ''}`}>
          <div className="stat-tile-label">Skipped</div>
          <div className="stat-tile-value">{data.excluded}</div>
        </div>
      </div>

      {data.excluded > 0 && (
        <>
          <div className="form-divider"><span>Why they are skipped</span></div>
          <ul className="ctx-list" style={{ marginBottom: 'var(--gap)' }}>
            {Object.entries(data.excluded_by_reason).map(([code, n]) => (
              <li key={code}>
                <span className="state-pill state-risk">{n}</span>
                <div><strong>{EXCLUSION_LABEL[code] ?? code}</strong></div>
              </li>
            ))}
          </ul>
          <p className="tiny muted">
            These are enforced by the API, not by this screen — an import or an
            automation sending to the same list is refused in exactly the same way.
          </p>
        </>
      )}

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        {!sent && (
          <button type="button" className="btn btn-primary" onClick={onSend} disabled={data.reachable === 0}>
            {data.reachable === 0 ? 'Nobody to send to' : `Send to ${data.reachable}`}
          </button>
        )}
      </div>
    </Modal>
  );
}

function Residency({ session }) {
  const [data, { loading, error }] = useApi('/ai/residency');
  const canAudit = session.permissions.includes('audit.read');
  const [log] = useApi(canAudit ? '/ai/residency/log?limit=25' : null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Empty>No policy published.</Empty>;

  const leaving = data.capabilities.filter((c) => c.leaves_india);

  return (
    <>
      <div className="notice">
        <strong>Mode: {data.mode}</strong> — {data.effective_note}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Where each AI capability is processed</h2>
          <span className="tiny muted">{leaving.length} of {data.capabilities.length} route outside India, de-identified</span>
        </div>
        <table>
          <thead>
            <tr><th>Capability</th><th>Data class</th><th>Processed</th><th>Why</th></tr>
          </thead>
          <tbody>
            {data.capabilities.map((c) => (
              <tr key={c.capability}>
                <td style={{ fontWeight: 545 }}>{c.capability}</td>
                <td>
                  <span className={`badge ${c.data_class === 'CLASS_PII_RAW' ? 'badge-amber' : 'badge-blue'}`}>
                    {c.data_class.replace('CLASS_', '')}
                  </span>
                </td>
                <td>
                  {c.leaves_india
                    ? <span className="badge badge-blue">Outside India · de-identified</span>
                    : <span className="badge badge-green">In India</span>}
                </td>
                <td className="tiny muted">{c.classification_reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>{data.note}</p>
      </section>

      {canAudit && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2>Egress evidence</h2>
            <span className="tiny muted">What was removed before each cross-border call</span>
          </div>
          {!log?.length ? <Empty>No cross-border AI calls yet.</Empty> : (
            <table>
              <thead>
                <tr><th>When</th><th>Capability</th><th>Outcome</th><th>Identifiers removed</th></tr>
              </thead>
              <tbody>
                {log.map((e) => (
                  <tr key={e.id}>
                    <td className="tiny muted num" style={{ width: 150 }}>{dateTime(e.created_at)}</td>
                    <td className="small">{e.meta?.capability}</td>
                    <td>
                      {e.action === 'ai_egress_blocked'
                        ? <span className="badge badge-red">Blocked</span>
                        : <span className="badge badge-green">Sent</span>}
                    </td>
                    <td className="tiny">
                      {Object.entries(e.meta?.redacted || {}).map(([kind, n]) => (
                        <span key={kind} className="badge" style={{ marginRight: 4 }}>{kind} ×{n}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>
            Counts only — the log records what kind of identifier was removed and how many, never the values.
            A log that stored the values would simply be a second copy of the data it exists to protect.
          </p>
        </section>
      )}
    </>
  );
}

function Integrations() {
  const [data, { loading, reload }] = useApi('/admin/integrations');
  if (loading || !data) return <Loading />;

  return (
    <>
      <div className="notice">
        Each adapter is <strong>live</strong> when its credentials are set and <strong>simulated</strong> when they are
        not — same code either way, so nothing runs in production that was never exercised in test. Bonanza's stack is
        Cube QuickCall (dialler), Smartping WhatsApp and the Bonanza eKYC portal.
      </div>
      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>Adapters</h2></div>
          <table>
            <thead><tr><th>Integration</th><th>Status</th><th>Production contract</th></tr></thead>
            <tbody>
              {data.integrations.map((i) => (
                <tr key={i.key}>
                  <td style={{ fontWeight: 545 }}>{i.name}</td>
                  <td>
                    <span className={`badge ${
                      i.status === 'live' ? 'badge-green'
                        : i.status === 'configurable' ? 'badge-blue'
                          : 'badge-amber'}`}
                    >
                      {i.status}
                    </span>
                  </td>
                  <td className="tiny muted">{i.contract}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head"><h2>Vendor endpoints</h2></div>
          {!data.vendors ? <Empty>No vendor configuration reported.</Empty> : (
            <table>
              <thead><tr><th>Vendor</th><th>State</th><th>Endpoint</th><th>Signed callbacks</th></tr></thead>
              <tbody>
                {Object.entries(data.vendors).filter(([k]) => k !== 'forced_simulation').map(([key, v]) => (
                  <tr key={key}>
                    <td style={{ fontWeight: 545 }}>{key.replace(/_/g, ' ')}</td>
                    <td>
                      <span className={`badge ${String(v.state).startsWith('live') ? 'badge-green' : 'badge-amber'}`}>{v.state}</span>
                    </td>
                    <td className="tiny muted">{v.endpoint || '—'}</td>
                    <td>
                      {v.signed_callbacks
                        ? <span className="badge badge-green">yes</span>
                        : <span className="badge badge-red">no</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>
            Callbacks write to client records, so an unsigned webhook is refused rather than trusted. Credentials are
            never sent to this page — only whether they are present.
          </p>
        </section>

        <section className="card">
          <div className="card-head"><h2>Outbox</h2><button className="btn-sm" onClick={reload}>Refresh</button></div>
          {!data.outbox.length ? <Empty>Nothing sent yet.</Empty> : (
            <table>
              <tbody>
                {data.outbox.slice(0, 25).map((o) => (
                  <tr key={o.id}>
                    <td style={{ width: 110 }}><span className="badge">{o.channel}</span></td>
                    <td>
                      <div className="small">{o.to}</div>
                      <div className="tiny muted">{String(o.body || '').slice(0, 110)}</div>
                    </td>
                    <td className="tiny muted num" style={{ width: 90 }}>{new Date(o.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- audit */

function Audit() {
  const [rows, { loading }] = useApi('/admin/audit');
  if (loading) return <Loading />;
  return (
    <section className="card">
      <div className="card-head"><h2>Audit log</h2><span className="tiny muted">Last 300 events</span></div>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td>
              <td className="small">{a.user_name || 'system'}</td>
              <td><span className="badge">{a.action}</span></td>
              <td className="small muted">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
              <td className="tiny muted" style={{ maxWidth: 380, wordBreak: 'break-word' }}>{a.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* --------------------------------------------------------- connectors */

/**
 * Meta — Facebook and Instagram.
 *
 * The screen exists to answer two questions honestly: what is actually wired,
 * and which capability is switched off on purpose rather than by omission.
 * A connector page that shows four green ticks when nothing is configured is
 * how integrations get signed off before they work.
 */
function MetaConnector() {
  const [data, { loading, reload }] = useApi('/admin/connectors/meta');
  const [leads] = useApi('/admin/connectors/meta/leads');
  if (loading || !data) return <Loading />;

  const CAP_LABEL = {
    lead_ads: 'Lead Ads → CRM',
    messaging: 'Messenger & Instagram DMs',
    ad_campaigns: 'Publish ad campaigns',
    custom_audiences: 'Custom Audiences',
  };

  return (
    <>
      <div className={`glass notice ${data.live ? '' : 'notice-warn'}`}>
        <Icon name={data.live ? 'check_circle' : 'pending'} />
        <div>
          <strong>{data.live ? 'Connected to Meta.' : 'Running the simulator.'}</strong>
          <p className="tiny muted" style={{ margin: '3px 0 0' }}>{data.note}</p>
        </div>
      </div>

      <div className="portal-grid is-split">
        <section className="card section-card">
          <div className="section-head">
            <div>
              <h2>Capabilities</h2>
              <p>What this connector can do once it is live</p>
            </div>
          </div>
          <ul className="ctx-list">
            {Object.entries(data.capabilities).map(([k, on]) => (
              <li key={k}>
                <span className={`state-pill ${on ? 'state-active' : 'state-risk'}`}>{on ? 'on' : 'off'}</span>
                <div>
                  <strong>{CAP_LABEL[k] ?? k}</strong>
                  {k === 'custom_audiences' && !on && (
                    <div className="tiny muted">
                      Off deliberately — sending a segment to Meta means hashed client
                      identifiers leaving India. Needs compliance sign-off and
                      <code> CRM_META_AUDIENCES_ENABLED=true</code>.
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className={`notice ${data.audiences_enabled ? 'notice-warn' : ''}`} style={{ marginTop: 4 }}>
            <Icon name="public_off" />
            <div className="tiny">{data.residency_note}</div>
          </div>
        </section>

        <section className="card section-card">
          <div className="section-head">
            <div>
              <h2>Setup</h2>
              <p>Credentials go into <code>server/.env</code>, never through this screen</p>
            </div>
          </div>

          <div className="field">
            <label>Webhook URL — paste this into your Meta app</label>
            <input readOnly value={`${window.location.origin}/api/webhooks/meta`} onFocus={(e) => e.target.select()} />
          </div>

          {data.needs.length > 0 ? (
            <ul className="ctx-list">
              {data.needs.map((n) => (
                <li key={n.key}>
                  <span className={`state-pill ${n.have ? 'state-active' : 'state-risk'}`}>
                    {n.have ? 'set' : 'missing'}
                  </span>
                  <div>
                    <strong>{n.label}</strong>
                    <div className="tiny muted"><code>{n.key}</code></div>
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty>Everything is configured.</Empty>}
        </section>
      </div>

      <section className="card section-card">
        <div className="section-head">
          <div>
            <h2>Leads from Meta</h2>
            <p>{leads?.length ?? 0} most recent — proof the connector is working</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={reload}>Refresh</button>
        </div>
        {!leads?.length ? (
          <Empty>Nothing has arrived from Facebook or Instagram yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Name</th><th>Mobile</th><th>Source</th><th>Stage</th><th>Arrived</th></tr></thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td><strong>{l.name}</strong></td>
                    <td className="small muted">{l.mobile || '—'}</td>
                    <td><span className="badge">{l.source}</span></td>
                    <td><span className="badge">{l.stage}</span></td>
                    <td className="small muted">{shortDate(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ----------------------------------------------------------- calendars */

/**
 * Working calendars.
 *
 * Two of them, because a broking firm runs on two weeks that do not coincide —
 * the office is open Saturdays, the exchange is not; Maharashtra Day closes one
 * and not the other. The SLA clock and every follow-up reschedule read these.
 *
 * The list is editable rather than shipped because the dates that matter most
 * move: Holi, Diwali, Eid and Dussehra follow the lunar calendar and come out
 * in an NSE circular each year. Guessing them in code would be worse than
 * leaving them out.
 */
function Calendars() {
  const [data, { loading, reload }] = useApi('/admin/calendars');
  const [adding, setAdding] = useState(null);   // kind
  const [error, setError] = useState(null);
  if (loading || !data) return <Loading />;

  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const drop = async (id) => {
    setError(null);
    try { await api.del(`/admin/calendars/days/${id}`); reload(); }
    catch (err) { setError(err.message); }
  };

  return (
    <>
      <div className="glass notice">
        <Icon name="event" />
        <div className="tiny">{data.note}</div>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="portal-grid">
        {data.calendars.map((c) => (
          <section key={c.kind} className="card section-card">
            <div className="section-head">
              <div>
                <h2>{c.label}</h2>
                <p>
                  {String(c.open_hour).padStart(2, '0')}:00–{String(c.close_hour).padStart(2, '0')}:00 ·{' '}
                  {c.week.map((d) => DAY[d]).join(' ')}
                </p>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(c.kind)}>
                <Icon name="add" size={16} /> Add a day
              </button>
            </div>

            {c.days.length === 0 ? (
              <Empty>No closures recorded. Paste this year&apos;s list from the NSE circular.</Empty>
            ) : (
              <ul className="ctx-list">
                {c.days.map((d) => (
                  <li key={d.id}>
                    <span className={`state-pill ${d.half_day ? 'state-warm' : 'state-risk'}`}>
                      {d.half_day ? `to ${d.close_hour}:00` : 'closed'}
                    </span>
                    <div>
                      <strong>{d.name}</strong>
                      <div className="tiny muted">
                        {d.on_date}
                        {d.source === 'seed' && ' · shipped'}
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-icon" aria-label={`Remove ${d.name}`}
                      onClick={() => drop(d.id)}>
                      <Icon name="close" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {adding && (
        <AddCalendarDay
          kind={adding}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); reload(); }}
        />
      )}
    </>
  );
}

function AddCalendarDay({ kind, onClose, onSaved }) {
  const [form, setForm] = useState({ on_date: '', name: '', half_day: false, close_hour: 13 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <Modal title={`Add a day to the ${kind} calendar`} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError(null);
          try {
            await api.post(`/admin/calendars/${kind}/days`, {
              ...form, close_hour: form.half_day ? Number(form.close_hour) : null,
            });
            onSaved();
          } catch (err) { setError(err.message); setBusy(false); }
        }}
      >
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <label>
          <span>Date</span>
          <input type="date" value={form.on_date} onChange={set('on_date')} required autoFocus />
        </label>
        <label>
          <span>What is it?</span>
          <input value={form.name} onChange={set('name')} required placeholder="Diwali — Laxmi Pujan" />
        </label>

        <div className="check-row span-2">
          <label className="inline">
            <input type="checkbox" checked={form.half_day} onChange={set('half_day')} />
            <span>Open, but closing early</span>
          </label>
          {form.half_day && (
            <label className="inline">
              <span>Closes at</span>
              <input type="number" min="1" max="23" value={form.close_hour} onChange={set('close_hour')}
                style={{ width: 70 }} />
            </label>
          )}
        </div>

        <p className="tiny muted span-2">
          {form.half_day
            ? 'A short day still counts as a working day — Muhurat trading is the usual case.'
            : 'A closed day is skipped by the SLA clock and by every follow-up reschedule.'}
        </p>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.on_date || !form.name.trim()}>
            {busy ? <Spinner /> : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------- rule builder */

/**
 * Building an automation without writing JSON.
 *
 * The screen was read-only: you could see a rule, dry-run it and toggle it, but
 * the only way to create one was a POST by hand. That is the difference between
 * a platform an operations lead can change and one that needs a developer for
 * every "chase leads that went quiet".
 *
 * The vocabulary comes from the server — `condition_fields` and `action_types`
 * ride along on GET /admin/rules — so this form does not know what a rule means.
 * Adding a condition field or an action type on the server makes it appear here
 * with no change to this file.
 *
 * DRY RUN IS THE PRIMARY BUTTON, NOT SAVE
 * ---------------------------------------
 * A rule that fires on 495,118 leads is a rule you want to have tested first.
 * The builder makes dry-run the obvious path and creates every rule disabled,
 * so the sequence is always: build, see who it would hit, then enable. Nothing
 * a person types here can send a message until they deliberately turn it on.
 */

const OPS_BY_TYPE = {
  number: [['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'],
    ['lte', 'is at most'], ['eq', 'equals'], ['neq', 'does not equal']],
  text: [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains'], ['in', 'is any of']],
  enum: [['eq', 'is'], ['neq', 'is not'], ['in', 'is any of']],
  bool: [['eq', 'is']],
  card: [['eq', 'is'], ['neq', 'is not']],
};

const blankCondition = () => ({ field: '', op: 'eq', value: '', join: 'AND' });
const blankAction = () => ({ type: '', params: {} });

function RuleBuilder({ rule, fields, actionTypes, templates, products, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    priority: rule?.priority ?? 100,
  });
  const [conditions, setConditions] = useState(
    rule?.conditions?.length ? rule.conditions.map((c) => ({ ...c })) : [blankCondition()],
  );
  const [actions, setActions] = useState(
    rule?.actions?.length ? rule.actions.map((a) => ({ ...a, params: { ...a.params } })) : [blankAction()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fieldDef = (name) => fields.find((f) => f.field === name);

  const setCond = (i, patch) => setConditions((cs) =>
    cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const setAct = (i, patch) => setActions((as) =>
    as.map((a, n) => (n === i ? { ...a, ...patch } : a)));

  /** Complete enough to save? Reported inline rather than on submit. */
  const problems = [];
  if (!form.name.trim()) problems.push('Give the rule a name');
  conditions.forEach((c, i) => {
    if (!c.field) problems.push(`Condition ${i + 1} has no field`);
    else if (c.value === '' && c.op !== 'is_blank') problems.push(`Condition ${i + 1} has no value`);
  });
  actions.forEach((a, i) => {
    if (!a.type) problems.push(`Action ${i + 1} has no type`);
  });

  async function save(thenDryRun) {
    setBusy(true); setError(null);
    try {
      const body = {
        ...form,
        conditions,
        actions,
        // Always created disabled. Enabling is a separate, deliberate click.
        enabled: rule?.enabled ?? 0,
      };
      const saved = rule
        ? (await api.patch(`/admin/rules/${rule.id}`, body), { id: rule.id })
        : await api.post('/admin/rules', body);
      onSaved(saved.id, thenDryRun);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal
      title={rule ? `Edit — ${rule.name}` : 'New automation rule'}
      subtitle="Nothing runs until you enable it. Dry-run first."
      onClose={onClose}
      wide
    >
      <div className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <label className="span-2">
          <span>What does this rule do?</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Chase leads that have gone quiet for a week" autoFocus />
        </label>

        <label className="span-2">
          <span>Notes <span className="muted">(optional)</span></span>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Why this exists, and who asked for it" />
        </label>

        {/* ---------------------------------------------------- IF */}
        <div className="span-2 rule-block">
          <div className="rule-block-head">
            <span className="rule-kw">IF</span>
            <span className="tiny muted">every condition must hold unless you set OR</span>
          </div>

          {conditions.map((c, i) => {
            const def = fieldDef(c.field);
            const ops = OPS_BY_TYPE[def?.type ?? 'text'] ?? OPS_BY_TYPE.text;
            return (
              <div key={i} className="rule-row">
                {i > 0 && (
                  <select
                    className="rule-join"
                    value={c.join ?? 'AND'}
                    onChange={(e) => setCond(i, { join: e.target.value })}
                  >
                    <option>AND</option>
                    <option>OR</option>
                  </select>
                )}
                {i === 0 && <span className="rule-join is-first">when</span>}

                <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value, value: '' })}>
                  <option value="">Choose a field…</option>
                  {fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                </select>

                <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} disabled={!c.field}>
                  {ops.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>

                {/* The value control follows the field's type, so a picklist
                    never invites free text and a boolean never invites a date. */}
                {def?.type === 'enum' ? (
                  <select value={c.value} onChange={(e) => setCond(i, { value: e.target.value })}>
                    <option value="">Choose…</option>
                    {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : def?.type === 'bool' ? (
                  <select value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value === 'true' })}>
                    <option value="true">yes</option>
                    <option value="false">no</option>
                  </select>
                ) : def?.type === 'card' ? (
                  <>
                    <select value={c.product_code ?? ''} onChange={(e) => setCond(i, { product_code: e.target.value })}>
                      <option value="">any product</option>
                      {products.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                    </select>
                    <select value={c.value} onChange={(e) => setCond(i, { value: e.target.value })}>
                      <option value="">Choose a state…</option>
                      {['INACTIVE', 'EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED', 'ACTIVE', 'ON_HOLD', 'LOST']
                        .map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </>
                ) : (
                  <input
                    type={def?.type === 'number' ? 'number' : 'text'}
                    value={c.value}
                    onChange={(e) => setCond(i, { value: def?.type === 'number' ? Number(e.target.value) : e.target.value })}
                    placeholder={def?.type === 'number' ? '7' : 'value'}
                    disabled={!c.field}
                  />
                )}

                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Remove condition ${i + 1}`}
                  disabled={conditions.length === 1}
                  onClick={() => setConditions((cs) => cs.filter((_, n) => n !== i))}
                >
                  <Icon name="close" />
                </button>
              </div>
            );
          })}

          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => setConditions((cs) => [...cs, blankCondition()])}>
            <Icon name="add" /> Add condition
          </button>
        </div>

        {/* -------------------------------------------------- THEN */}
        <div className="span-2 rule-block">
          <div className="rule-block-head">
            <span className="rule-kw is-then">THEN</span>
            <span className="tiny muted">run these, in order, for every lead that matched</span>
          </div>

          {actions.map((a, i) => {
            const def = actionTypes.find((t) => t.type === a.type);
            return (
              <div key={i} className="rule-row is-action">
                <select value={a.type} onChange={(e) => setAct(i, { type: e.target.value, params: {} })}>
                  <option value="">Choose an action…</option>
                  {actionTypes.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                </select>

                {(def?.params ?? []).map((p) => (
                  <ActionParam
                    key={p}
                    name={p}
                    value={a.params?.[p] ?? ''}
                    templates={templates}
                    actionType={a.type}
                    onChange={(v) => setAct(i, { params: { ...a.params, [p]: v } })}
                  />
                ))}

                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Remove action ${i + 1}`}
                  disabled={actions.length === 1}
                  onClick={() => setActions((as) => as.filter((_, n) => n !== i))}
                >
                  <Icon name="close" />
                </button>
              </div>
            );
          })}

          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => setActions((as) => [...as, blankAction()])}>
            <Icon name="add" /> Add action
          </button>
        </div>

        {problems.length > 0 && (
          <div className="glass notice notice-warn span-2">
            <Icon name="edit_note" />
            <div className="tiny">{problems.slice(0, 3).join(' · ')}</div>
          </div>
        )}

        <div className="glass notice span-2">
          <Icon name="shield" />
          <div className="tiny">
            Messaging actions still respect marketing opt-outs and invalid numbers.
            A rule cannot send to someone the CRM would otherwise refuse.
          </div>
        </div>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy || problems.length > 0}
            onClick={() => save(false)}>
            {busy ? <Spinner /> : 'Save as draft'}
          </button>
          {/* The primary action is to test, not to ship. */}
          <button type="button" className="btn btn-primary" disabled={busy || problems.length > 0}
            onClick={() => save(true)}>
            {busy ? <Spinner /> : 'Save and dry-run'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One action parameter, rendered by what it is rather than as raw text. */
function ActionParam({ name, value, templates, actionType, onChange }) {
  if (name === 'template_id') {
    const opts = templates.filter((t) => t.channel === actionType);
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a template…</option>
        {opts.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    );
  }
  if (name === 'due_in_hours') {
    return (
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[1, 4, 24, 48, 72, 168].map((h) => (
          <option key={h} value={h}>{h < 24 ? `in ${h}h` : `in ${h / 24} day${h > 24 ? 's' : ''}`}</option>
        ))}
      </select>
    );
  }
  if (name === 'role_or_user' || name === 'assignee' || name === 'role') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        <option value="owner">the lead&apos;s owner</option>
        {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    );
  }
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={name.replace(/_/g, ' ')}
    />
  );
}
