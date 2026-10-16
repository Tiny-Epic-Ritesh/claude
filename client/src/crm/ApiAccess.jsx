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
import { api, dmyTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Modal, Spinner, Empty, announce } from '../components/ui.jsx';

export default function ApiAccess() {
  const [data, { loading, error, reload }] = useApi('/setup/api-credentials');
  const [issuing, setIssuing] = useState(false);
  const [scoping, setScoping] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const [problem, setProblem] = useState(null);

  if (error) return <ErrorBanner error={error} />;
  if (loading || !data) return <Loading />;

  const rotate = async (c) => {
    try {
      const r = await api.post(`/setup/api-credentials/${c.id}/rotate`, {});
      setRevealed({ ...r, rotated: true });
      reload();
    } catch (err) { setProblem(err.message); }
  };

  const revoke = async (c) => {
    try {
      await api.del(`/setup/api-credentials/${c.id}`);
      // Part 4, item 8.4.
      announce('Key revoked', [`"${c.label}" stops working on its next request. Whatever uses it needs a new key.`]);
      reload();
    }
    catch (err) { setProblem(err.message); }
  };

  /* OPS-42. Keys issued before a scope was required still act with everything
     their user can do. Said at the top, because each one is an integration
     holding a whole role, and narrowing it costs no new secret. */
  const unscoped = data.credentials.filter((c) => c.active && !c.scopes);

  return (
    <section className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      {Boolean(unscoped.length) && (
        <div className="glass notice notice-danger">
          <Icon name="warning" size={16} />
          <div className="small">
            <strong>{unscoped.length === 1 ? '1 credential has' : `${unscoped.length} credentials have`} no scope.</strong>{' '}
            {unscoped.length === 1 ? 'It acts' : 'Each acts'} with everything its user can do — for an
            administrator, the whole administrator role. Set scopes to what the integration
            needs, or revoke it if nothing uses it. Setting scopes keeps the same key and secret.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Where an integration connects</h2>
            <span className="tiny muted">Give this to whoever is building against the API.</span>
          </div>
        </div>
        <dl className="setup-facts">
          {/* QA-12. Configured (CRM_PUBLIC_URL), or the origin this screen is
              itself calling the API on -- the one address whose scheme is
              known to be right behind the TLS proxy. It used to be guessed
              from the request and came out http://. */}
          <div><dt>Base URL</dt><dd className="api-name">{data.base_url ?? window.location.origin}</dd></div>
          <div><dt>Key header</dt><dd className="api-name">X-Api-Key</dd></div>
          <div><dt>Secret header</dt><dd className="api-name">X-Api-Secret</dd></div>
        </dl>
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>
          A credential acts as the user it is bound to, so it sees what that person
          sees — the same book, the same masking — and can do only the capabilities it
          is scoped to, out of what that person can. There is no separate permission
          model for integrations, which is deliberate: a second one is the one that
          gets it wrong.
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
                      ? <span title={c.scopes.join(', ')}>
                          {c.scopes.length === 1 ? <span className="api-name">{c.scopes[0]}</span> : `${c.scopes.length} capabilities`}
                        </span>
                      : <>
                          <span className="badge badge-red">Unscoped</span>
                          <div className="tiny muted">everything that user can do</div>
                        </>}
                  </td>
                  <td className="num small">{c.calls}</td>
                  <td className="small">
                    {c.last_used_at
                      ? dmyTime(c.last_used_at)
                      /* Worth calling out. A credential nobody has used is one
                         nobody will miss, and revoking it costs nothing. */
                      : <span className="warn-text">never</span>}
                  </td>
                  <td className="num">
                    {c.active && (
                      <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-sm" onClick={() => setScoping(c)}>{c.scopes ? 'Scopes' : 'Set scopes'}</button>
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

      {scoping && (
        <ScopeDialog
          credential={scoping}
          data={data}
          onClose={() => setScoping(null)}
          onSaved={() => { setScoping(null); reload(); }}
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
  const [form, setForm] = useState({ label: '', user_id: '' });
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
        scopes: [...scopes],
      });
      onIssued(r);
    } catch (err) { onError(err.message); setBusy(false); }
  };

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
          <select value={form.user_id} onChange={(e) => { set('user_id', e.target.value); setScopes(new Set()); }}>
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

        {chosen && (
          <ScopePicker
            capabilities={data.capabilities}
            allowed={new Set(chosen.capabilities)}
            scopes={scopes}
            onChange={setScopes}
          />
        )}

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"
            disabled={busy || !form.label.trim() || !form.user_id || !scopes.size}
            onClick={create}>
            {busy ? <Spinner /> : 'Issue credential'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- scopes */

/* OPS-42. What a key is for, out of what its user can do. A capability the
   user lacks is not offered: the server refuses it, and a key cannot do more
   than the person it acts as anyway. */
function ScopePicker({ capabilities, allowed, scopes, onChange }) {
  const byCategory = {};
  for (const c of capabilities) if (allowed.has(c.code)) (byCategory[c.category] ??= []).push(c);
  const toggle = (code) => {
    const next = new Set(scopes);
    if (next.has(code)) next.delete(code); else next.add(code);
    onChange(next);
  };

  return (
    <div className="field">
      <span className="field-label">What it is for ({scopes.size} chosen)</span>
      <span className="tiny muted">
        Choose the least the integration needs. A key that can do one thing can only be
        misused for one thing. Only what this user can do is listed.
      </span>
      <div className="cap-groups">
        {Object.entries(byCategory).map(([cat, caps]) => (
          <div key={cat} className="cap-group">
            <div className="cap-group-head"><span>{cat}</span></div>
            {caps.map((c) => (
              <label key={c.code} className="cap-row">
                <input type="checkbox" checked={scopes.has(c.code)} onChange={() => toggle(c.code)} />
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
  );
}

function ScopeDialog({ credential, data, onClose, onSaved, onError }) {
  const user = data.users.find((u) => u.id === credential.user_id);
  /* An unscoped key starts with nothing ticked, not everything: what it needs
     is the question being asked, and "all of it" is the answer being replaced. */
  const [scopes, setScopes] = useState(new Set(credential.scopes ?? []));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/setup/api-credentials/${credential.id}`, { scopes: [...scopes] });
      announce('Key narrowed', [`"${credential.label}" can now do ${scopes.size} thing${scopes.size === 1 ? '' : 's'}, from its next request.`]);
      onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="What this key is for" subtitle={credential.label} onClose={onClose} wide>
      <div className="stack" style={{ gap: 13 }}>
        <div className="glass notice">
          <Icon name="info" size={16} />
          <div className="small">
            Acts as <strong>{credential.user_name}</strong> ({credential.user_role}, {credential.sales_org}).
            The key and secret stay the same, so whatever uses it keeps working for what you
            tick here and is refused everything else from the next call.
          </div>
        </div>

        {user
          ? <ScopePicker capabilities={data.capabilities} allowed={new Set(user.capabilities)}
              scopes={scopes} onChange={setScopes} />
          : <p className="small muted">
              {credential.user_name} is no longer an active user, so this key already works for
              nothing. Revoke it.
            </p>}

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={busy || !user || !scopes.size} onClick={save}>
            {busy ? <Spinner /> : 'Save scopes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
