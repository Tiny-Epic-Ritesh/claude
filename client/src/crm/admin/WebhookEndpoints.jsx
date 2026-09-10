import { useState } from 'react';
import { api, dateTime } from '../../api.js';
import { useApi, Loading, Empty, Icon, Modal, ErrorBanner } from '../../components/ui.jsx';

/**
 * Where an automation is allowed to post (P3-16).
 *
 * WHY THIS SCREEN EXISTS AT ALL
 * -----------------------------
 * The webhook action could have taken a URL. It does not, and this screen is
 * the reason: a URL typed onto an automation card is an egress path nobody
 * reviewed, chosen by whoever last edited the flow. Bonanza is a SEBI-regulated
 * broker whose client data may not leave India, so "this destination may hold
 * client data" is a decision that belongs to a named administrator, recorded
 * where somebody can be asked about it a year later.
 *
 * So the screen leads with the two things a reviewer asks — where does this go,
 * and what does it carry — and keeps them together. The field list is a
 * positive allowlist: nothing is sent unless it was ticked here, which is what
 * stops a column added to `leads` next year from quietly starting to flow.
 */
export function WebhookEndpoints() {
  const [data, { loading, error, reload }] = useApi('/setup/webhook-endpoints');
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner message={error} />;

  const endpoints = data?.endpoints ?? [];

  const remove = async (e) => {
    setProblem(null);
    try {
      await api.del(`/setup/webhook-endpoints/${e.id}`);
      reload();
    } catch (err) { setProblem(err.message); }
  };

  const toggle = async (e) => {
    setProblem(null);
    try {
      await api.patch(`/setup/webhook-endpoints/${e.id}`, { active: !e.active });
      reload();
    } catch (err) { setProblem(err.message); }
  };

  return (
    <div>
      <div className="section-head">
        <div>
          <h2>Outbound webhooks</h2>
          <p className="muted small">
            The only destinations an automation may post to. Each carries just the fields listed
            against it — nothing else leaves, whatever the automation says.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="add" /> Register an endpoint
        </button>
      </div>

      {problem && <ErrorBanner message={problem} onClose={() => setProblem(null)} />}

      {!endpoints.length ? (
        <Empty
          icon="cable"
          title="No endpoints registered"
          hint="Until one is registered, a webhook card in an automation has nowhere to post and will refuse."
        />
      ) : (
        <div className="stack">
          {endpoints.map((e) => (
            <section key={e.id} className="card">
              <div className="row-between">
                <div>
                  <strong>{e.name}</strong>
                  {!e.active && <span className="badge">paused</span>}
                  {e.has_secret
                    ? <span className="badge badge-green" title="Requests are signed so the receiver can verify them">signed</span>
                    : <span className="badge badge-amber" title="The receiver cannot prove the call came from us">unsigned</span>}
                  <div className="tiny muted mono">{e.url}</div>
                </div>
                <div className="row-actions">
                  <button className="btn btn-quiet" onClick={() => toggle(e)}>{e.active ? 'Pause' : 'Resume'}</button>
                  <button className="btn btn-quiet" onClick={() => setEditing(e)}>Edit</button>
                  <button className="btn btn-quiet" onClick={() => remove(e)}>Delete</button>
                </div>
              </div>

              <div className="field-note">
                <span className="tiny muted">Sends</span>{' '}
                {e.fields.length
                  ? e.fields.map((f) => <span key={f} className="badge badge-blue">{f}</span>)
                  : <span className="tiny">the lead id only — the receiver looks the rest up over the API</span>}
              </div>

              {e.recent?.length > 0 && (
                <details>
                  <summary className="tiny">
                    Last {e.recent.length} {e.recent.length === 1 ? 'delivery' : 'deliveries'}
                    {e.failed_count > 0 && <span className="badge badge-red">{e.failed_count} failed</span>}
                  </summary>
                  <table className="table tiny">
                    <thead>
                      <tr><th>When</th><th>Lead</th><th>Status</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {e.recent.map((d) => (
                        <tr key={d.id}>
                          <td>{dateTime(d.attempted_at)}</td>
                          <td>{d.lead_id ?? '—'}</td>
                          <td>
                            <span className={`badge ${d.status === 'sent' ? 'badge-green' : d.status === 'failed' ? 'badge-red' : ''}`}>
                              {d.status}
                            </span>
                          </td>
                          <td className="muted">{d.error || (d.http_status ? `HTTP ${d.http_status}` : '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </section>
          ))}
        </div>
      )}

      {editing && (
        <EndpointEditor
          endpoint={editing === 'new' ? null : editing}
          sendable={data?.sendable_fields ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the form */

function EndpointEditor({ endpoint, sendable, onClose, onSaved }) {
  const [name, setName] = useState(endpoint?.name ?? '');
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [secret, setSecret] = useState('');
  const [fields, setFields] = useState(endpoint?.fields ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const toggleField = (f) =>
    setFields((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, url, fields, ...(secret ? { secret } : {}) };
      if (endpoint) await api.patch(`/setup/webhook-endpoints/${endpoint.id}`, body);
      else await api.post('/setup/webhook-endpoints', body);
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <Modal
      title={endpoint ? 'Edit endpoint' : 'Register an endpoint'}
      subtitle="Where it goes, and what it is allowed to carry"
      onClose={onClose}
    >
      {error && <ErrorBanner message={error} onClose={() => setError(null)} />}

      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Partner onboarding hook" />
      </div>

      <div className="field">
        <label>URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <div className="tiny muted">Must be https. Client data over plain HTTP is client data on the wire.</div>
      </div>

      <div className="field">
        <label>Signing secret</label>
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={endpoint?.has_secret ? 'Set — type a new one to replace it' : 'Optional, but the receiver cannot verify us without it'}
        />
        <div className="tiny muted">
          Each request carries an X-Bonanza-Signature header: an HMAC-SHA256 of the exact body, so
          the receiver can prove it came from us. Never shown again once saved.
        </div>
      </div>

      <div className="field">
        <label>Fields this endpoint receives</label>
        <div className="tiny muted">
          Tick nothing and the body carries the lead id alone, and the receiver looks the rest up
          over the API — the smallest thing that works, and the safest.
        </div>
        <div className="chip-grid">
          {sendable.map((f) => (
            <label key={f} className={`chip ${fields.includes(f) ? 'is-on' : ''}`}>
              <input type="checkbox" checked={fields.includes(f)} onChange={() => toggleField(f)} />
              {f}
            </label>
          ))}
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : endpoint ? 'Save' : 'Register'}
        </button>
      </div>
    </Modal>
  );
}

export default WebhookEndpoints;
