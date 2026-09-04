import { useState } from 'react';
import { api, appUrl, token, ROLE_LABEL } from '../../api.js';
import { useApi, ErrorBanner, Modal, Spinner, Icon } from '../../components/ui.jsx';
import { stashParentToken } from '../GhostBar.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
  *
 * This one is the three user-record helpers UsersSetup renders.
 */

export function UserActions({ user, reload, onLink, onError }) {
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false);

  const ghost = async () => {
    setBusy('ghost');
    try {
      const r = await api.post(`/setup/users/${user.id}/ghost`, {});
      /* The administrator's own token is stashed, not discarded, so leaving is
         a swap back rather than a second sign-in. sessionStorage, so closing
         the tab cannot leave it lying about. */
      /* Where they were standing, so returning is a round trip rather than a
         landing. An administrator working down a list of users should come back
         to that list, not to the CRM home. */
      stashParentToken(token.get('crm'), {
        name: r.on_behalf_of?.name ?? null,
        returnTo: window.location.pathname.replace(/^.*?(\/setup)/, '$1') || '/setup/users',
      });
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
      <button className="btn-sm" onClick={() => setEditing(true)}>Edit</button>
      <button className="btn-sm" onClick={async () => { await api.patch(`/admin/users/${user.id}`, { active: user.active ? 0 : 1 }); reload(); }}>
        {user.active ? 'Disable' : 'Enable'}
      </button>
      {editing && (
        <EditUser
          user={user}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); reload(); }}
        />
      )}
    </span>
  );
}

/**
 * Edit one user.
 *
 * Posts to `/setup/users/:id` rather than `/admin/users/:id`. Both write the
 * same columns; the setup one checks the book, refuses a self-referencing
 * manager, validates the role against the active list and signs the person out
 * everywhere when their password changes. The admin one is the older twin and
 * had none of that until today.
 *
 * Blank means "leave alone" on the server (COALESCE), which is what allows this
 * form to send the whole object without wiping the fields it does not show.
 */
export function EditUser({ user, onClose, onSaved }) {
  const [meta] = useApi('/meta');
  const [people] = useApi('/setup/users');
  const [form, setForm] = useState({
    name: user.name ?? '',
    role: user.role ?? '',
    manager_id: user.manager_id ?? '',
    product_type_id: user.product_type_id ?? '',
    employee_code: user.employee_code ?? '',
    branch: user.branch ?? '',
    phone: user.phone ?? '',
    phone_extension: user.phone_extension ?? '',
    cti_agent_id: user.cti_agent_id ?? '',
    cube_campaign_id: user.cube_campaign_id ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  /* Anyone but themselves -- the server refuses a self-referencing manager and
     there is no reason to offer the option and then reject it. */
  const managers = (people?.users ?? people ?? []).filter((p) => p.id !== user.id);

  return (
    <Modal title={`Edit ${user.name}`} subtitle={user.email} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.patch(`/setup/users/${user.id}`, {
            ...form,
            manager_id: form.manager_id === '' ? null : Number(form.manager_id),
            product_type_id: form.product_type_id === '' ? null : Number(form.product_type_id),
          });
          onSaved();
        } catch (err) { setError(err.message); setBusy(false); }
      }}>
        <ErrorBanner error={error} />

        <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} required autoFocus /></div>

        <div className="field-row">
          <div className="field">
            <label>Role</label>
            <select value={form.role} onChange={set('role')}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Reports to</label>
            <select value={form.manager_id} onChange={set('manager_id')}>
              <option value="">—</option>
              {managers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Product (Product RM only)</label>
            <select value={form.product_type_id} onChange={set('product_type_id')}>
              <option value="">—</option>
              {(meta?.products || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Employee code</label><input value={form.employee_code} onChange={set('employee_code')} /></div>
        </div>

        <div className="field-row">
          <div className="field"><label>Branch</label><input value={form.branch} onChange={set('branch')} /></div>
          <div className="field"><label>Mobile</label><input value={form.phone} onChange={set('phone')} /></div>
        </div>

        <h4 className="muted">Telephony</h4>
        <div className="field-row">
          <div className="field"><label>Extension</label><input value={form.phone_extension} onChange={set('phone_extension')} /></div>
          <div className="field"><label>Agent ID</label><input value={form.cti_agent_id} onChange={set('cti_agent_id')} /></div>
        </div>
        <div className="field">
          <label>Dialler campaign</label>
          <input value={form.cube_campaign_id} onChange={set('cube_campaign_id')} placeholder="Leave blank to use the team's" />
          <p className="hint small muted">
            Outbound calls normally use the campaign set on this person's team. Set one here only
            for somebody working another desk — it overrides the team's, and clearing it hands
            them back.
          </p>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The reset link, shown once.
 *
 * Not emailed: SMTP is configured per environment, and a link that silently
 * fails to send is worse than one the administrator can see they are holding —
 * they know whether they delivered it.
 */
export function ResetLink({ issued, onClose }) {
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

export function NewUser({ onClose, onCreated }) {
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
