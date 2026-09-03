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
