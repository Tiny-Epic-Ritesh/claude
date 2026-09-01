/**
 * API access (P2-02).
 *
 * A credential is bound to a user and authenticates as them, which is the whole
 * design and the thing the screen has to make obvious. "Acts as Ananya Rao
 * (Sales RM)" tells an administrator what the key can do without them having to
 * reason about a second permission model — because there isn't one.
 *
 * THE SECRET IS SHOWN ONCE
 *
 * Not because it is inconvenient to store, but because a secret that can be
 * read back is a secret that anyone with the screen can read. The panel that
 * shows it says so plainly and does not let itself be reopened; losing it means
 * rotating, which is one click and safe.
 *
 * Nothing here offers a copy-to-clipboard on the secret without also saying it
 * will not be shown again. An administrator who copies it, closes the panel and
 * then discovers they pasted the key id instead has learned the hard way what
 * this sentence would have told them.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Modal, Spinner, Empty } from '../components/ui.jsx';

export default function ApiAccess() {
  const [data, { loading, error, reload }] = useApi('/setup/api-credentials');
  const [issuing, setIssuing] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const [problem, setProblem] = useState(null);

  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const rotate = async (c) => {
    try {
      const r = await api.post(`/setup/api-credentials/${c.id}/rotate`, {});
      setRevealed({ ...r, rotated: true });
      reload();
    } catch (err) { setProblem(err.message); }
  };

  const revoke = async (c) => {
    try { await api.del(`/setup/api-credentials/${c.id}`); reload(); }
    catch (err) { setProblem(err.message); }
  };

  return (
    <section className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Where an integration connects</h2>
            <span className="tiny muted">Give this to whoever is building against the API.</span>
          </div>
        </div>
        <dl className="setup-facts">
          <div><dt>Base URL</dt><dd className="api-name">{data.base_url}</dd></div>
          <div><dt>Key header</dt><dd className="api-name">X-Api-Key</dd></div>
          <div><dt>Secret header</dt><dd className="api-name">X-Api-Secret</dd></div>
        </dl>
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>
          A credential acts as the user it is bound to, so it sees exactly what that
          person sees — the same book, the same masking, the same permissions. There is
          no separate permission model for integrations, which is deliberate: a second
          one is the one that gets it wrong.
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>{data.credentials.filter((c) => c.active).length} active credentials</h2>
            <span className="tiny muted">Secrets are stored hashed and cannot be shown again after issue.</span>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setIssuing(true)}>
            <Icon name="add" size={15} /> Issue a credential
          </button>
        </div>

        {!data.credentials.length && (
          <Empty>No credentials issued. Nothing outside the CRM can call the API.</Empty>
        )}

        {Boolean(data.credentials.length) && (
          <table>
            <thead>
              <tr><th>Label</th><th>Key</th><th>Acts as</th><th>Scope</th><th className="num">Calls</th><th>Last used</th><th /></tr>
            </thead>
            <tbody>
              {data.credentials.map((c) => (
                <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{c.label}</div>
                    {!c.active && <span className="badge badge-amber">Revoked</span>}
                  </td>
                  <td className="api-name small">{c.key_id}</td>
                  <td className="small">
                    {c.user_name}
                    <div className="tiny muted">{c.user_role} · {c.sales_org}</div>
                  </td>
                  <td className="small">
                    {c.scopes
                      ? <span title={c.scopes.join(', ')}>{c.scopes.length} capabilities</span>
                      : <span className="muted">everything that user can do</span>}
                  </td>
                  <td className="num small">{c.calls}</td>
                  <td className="small">
                    {c.last_used_at
                      ? String(c.last_used_at).slice(0, 16)
                      /* Worth calling out. A credential nobody has used is one
                         nobody will miss, and revoking it costs nothing. */
                      : <span className="warn-text">never</span>}
                  </td>
                  <td className="num">
                    {c.active && (
                      <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-sm" onClick={() => rotate(c)}>Rotate</button>
                        <button className="btn-ghost btn-sm is-danger" onClick={() => revoke(c)}>Revoke</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {issuing && (
        <IssueDialog
          data={data}
          onClose={() => setIssuing(false)}
          onIssued={(r) => { setIssuing(false); setRevealed(r); reload(); }}
          onError={setProblem}
        />
      )}

      {revealed && <SecretOnce credential={revealed} onClose={() => setRevealed(null)} />}
    </section>
  );
}

/* ------------------------------------------------------- the one look */

function SecretOnce({ credential, onClose }) {
  const [copied, setCopied] = useState(null);
  const copy = async (what, value) => {
    try { await navigator.clipboard.writeText(value); setCopied(what); }
    catch { setCopied(null); }
  };

  return (
    <Modal
      title={credential.rotated ? 'New secret' : 'Credential issued'}
      subtitle={credential.label}
      onClose={onClose}
    >
      <div className="stack" style={{ gap: 13 }}>
        <div className="glass notice notice-warn">
          <Icon name="warning" size={16} />
          <div>
            <strong>This is the only time the secret is shown.</strong> It is stored
            hashed and cannot be recovered — if it is lost, rotate the credential and
            update whatever was using it.
            {credential.rotated && ' The previous secret stopped working just now.'}
          </div>
        </div>

        {[['Key', credential.key_id], ['Secret', credential.secret]].map(([what, value]) => (
          <label key={what}>
            <span>{what}</span>
            <div className="row" style={{ gap: 8 }}>
              <input readOnly value={value} className="api-name" onFocus={(e) => e.target.select()} />
              <button className="btn-ghost btn-sm" onClick={() => copy(what, value)}>
                {copied === what ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>
        ))}

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={onClose}>I have saved it</button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ issuing */

function IssueDialog({ data, onClose, onIssued, onError }) {
  const [form, setForm] = useState({ label: '', user_id: '', narrow: false });
  const [scopes, setScopes] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const chosen = data.users.find((u) => String(u.id) === String(form.user_id));

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/setup/api-credentials', {
        label: form.label,
        user_id: Number(form.user_id),
        scopes: form.narrow && scopes.size ? [...scopes] : null,
      });
      onIssued(r);
    } catch (err) { onError(err.message); setBusy(false); }
  };

  const byCategory = {};
  for (const c of data.capabilities) (byCategory[c.category] ??= []).push(c);

  return (
    <Modal title="Issue an API credential" onClose={onClose} wide>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>What is it for</span>
          <input value={form.label} onChange={(e) => set('label', e.target.value)}
            placeholder="Website lead capture" maxLength={80} />
          <span className="tiny muted">
            This is how you will know what you are revoking in a year. "Integration" is
            not a label.
          </span>
        </label>

        <label>
          <span>Acts as</span>
          <select value={form.user_id} onChange={(e) => set('user_id', e.target.value)}>
            <option value="">Choose a user…</option>
            {data.users.map((u) => (
              <option key={u.id} value={u.id}>{u.name} — {u.role} — {u.sales_org}</option>
            ))}
          </select>
          <span className="tiny muted">
            The credential sees exactly what this person sees. Prefer a service account
            over a real person: a key bound to somebody who leaves is a key that
            outlives them — though deactivating them does switch it off.
          </span>
        </label>

        {chosen && (
          <div className="glass notice">
            <Icon name="info" size={16} />
            <div className="small">
              This credential will be able to act on <strong>{chosen.sales_org}</strong> records
              only, as a <strong>{chosen.role}</strong>.
            </div>
          </div>
        )}

        <label className="check-one">
          <input type="checkbox" checked={form.narrow} onChange={(e) => set('narrow', e.target.checked)} />
          <span>
            Narrow it further
            <em className="tiny muted"> — otherwise it can do everything that user can</em>
          </span>
        </label>

        {form.narrow && (
          <div className="field">
            <span className="field-label">Allow only these ({scopes.size} chosen)</span>
            {/* Narrowing only. Ticking something the user cannot do has no
                effect — the server drops it rather than granting it. */}
            <span className="tiny muted">
              Anything ticked here that the chosen user cannot do is ignored, not granted.
            </span>
            <div className="cap-groups">
              {Object.entries(byCategory).map(([cat, caps]) => (
                <div key={cat} className="cap-group">
                  <div className="cap-group-head"><span>{cat}</span></div>
                  {caps.map((c) => (
                    <label key={c.code} className="cap-row">
                      <input
                        type="checkbox"
                        checked={scopes.has(c.code)}
                        onChange={() => setScopes((s) => {
                          const next = new Set(s);
                          if (next.has(c.code)) next.delete(c.code); else next.add(c.code);
                          return next;
                        })}
                      />
                      <span>
                        <strong>{c.label}</strong>
                        <em className="api-name">{c.code}</em>
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"
            disabled={busy || !form.label.trim() || !form.user_id}
            onClick={create}>
            {busy ? <Spinner /> : 'Issue credential'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
