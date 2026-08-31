/**
 * Telephony setup — the dialler queues, and who is mapped to the switch.
 *
 * Two settings the integration has always needed and nothing could ever set.
 *
 * The CUBE agent id has been a column since the dialler was first wired up and
 * has never had a screen. Without it a call goes out unattributed, and the
 * version of this that shipped earlier was worse than that: it fell back to our
 * internal user id, so CUBE would either reject the call or pin it on whichever
 * of its own agents happens to be called "2".
 *
 * The campaign registry is the other. CUBE has no endpoint that lists its
 * campaigns — the values cannot be discovered, only configured — so without a
 * table the whole firm shares one environment variable. That makes the
 * cross-campaign requirement unbuildable: a call carries its queue per request
 * precisely so a Bigul desk and a Bonanza desk can dial into different queues.
 *
 * WHY A QUEUE CARRIES A BOOK
 *
 * Every queue belongs to one business. A Bigul desk dialling from a Bonanza
 * queue would put both books' calls in one place in Cube's own reporting, which
 * is the same boundary failure as any cross-book query — just on the vendor's
 * side of the line, where we cannot fix it afterwards.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Modal, Spinner, Empty } from '../components/ui.jsx';

export default function Telephony() {
  const [data, { loading, error, reload }] = useApi('/setup/dialler');
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState(null);

  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const done = (msg) => { setNotice(msg); reload(); };

  return (
    <section className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between">
          <span><Icon name="check_circle" size={16} /> {notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <Connection state={data.connection} />
      <Queues data={data} onSaved={done} onError={setProblem} />
      <Agents agents={data.agents} onSaved={done} onError={setProblem} />
    </section>
  );
}

/* ---------------------------------------------------------- connection */

function Connection({ state }) {
  const live = state?.state === 'live';
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Connection</h2>
          <span className="tiny muted">
            Reports whether credentials are present — never what they are
          </span>
        </div>
        <span className={`badge ${live ? 'badge-green' : 'badge-amber'}`}>
          {live ? 'Live' : 'Simulated'}
        </span>
      </div>

      <dl className="setup-facts">
        <div><dt>Endpoint</dt><dd className="api-name">{state?.endpoint || '—'}</dd></div>
        <div><dt>Fallback campaign</dt><dd className="api-name">{state?.campaign || '—'}</dd></div>
        <div>
          <dt>Call callbacks</dt>
          <dd>{state?.signed_callbacks
            ? 'Signed'
            : <span className="warn-text">Unsigned — call events are refused</span>}</dd>
        </div>
      </dl>

      {!live && (
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>
          Calls are simulated end to end: the request body is built exactly as CUBE
          would receive it, and answered by a local stub. Set the CUBE credentials on
          the server to go live — nothing here changes when you do.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- queues */

function Queues({ data, onSaved, onError }) {
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  const byOrg = {};
  for (const c of data.campaigns) (byOrg[c.sales_org] ??= []).push(c);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Dialler queues</h2>
          <span className="tiny muted">
            Which CUBE campaign a call goes into. Most specific wins — a queue for the
            lead’s product, else the book’s default.
          </span>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          <Icon name="add" size={15} /> Add queue
        </button>
      </div>

      {!data.campaigns.length && (
        <Empty>
          No queues registered. Every call falls back to the single campaign in the
          server configuration, which is a placeholder rather than a real CUBE campaign.
        </Empty>
      )}

      {Object.entries(byOrg).map(([org, rows]) => (
        <div key={org} style={{ marginTop: 10 }}>
          <div className="field-label">{org}</div>
          <table>
            <thead>
              <tr>
                <th>Queue</th><th>CUBE campaign</th><th>Serves</th><th /><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                  <td style={{ fontWeight: 550 }}>{c.label}</td>
                  <td className="api-name">{c.cube_campaign_id}</td>
                  <td className="small">{c.product_name || 'Whole book'}</td>
                  <td>
                    {Boolean(c.is_default) && <span className="badge">Default</span>}
                    {!c.active && <span className="badge badge-amber">Retired</span>}
                  </td>
                  <td className="num">
                    <button className="btn-sm" onClick={() => setEditing(c)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* A book with no default queue cannot answer "where does this call go",
          so it is called out rather than left to be discovered on a dial. */}
      {data.orgs.filter((o) => !(byOrg[o] ?? []).some((c) => c.is_default && c.active)).map((o) => (
        <p key={o} className="tiny warn-text" style={{ margin: '8px 0 0' }}>
          <Icon name="warning" size={13} /> {o} has no default queue. Calls to leads
          without a product-specific queue fall back to the server configuration.
        </p>
      ))}

      {editing && (
        <QueueEditor
          queue={editing} products={data.products}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); onSaved(m); }}
          onError={onError}
        />
      )}
      {adding && (
        <QueueEditor
          products={data.products} orgs={data.orgs}
          onClose={() => setAdding(false)}
          onSaved={(m) => { setAdding(false); onSaved(m); }}
          onError={onError}
        />
      )}
    </div>
  );
}

function QueueEditor({ queue, products, orgs = [], onClose, onSaved, onError }) {
  const isNew = !queue;
  const [form, setForm] = useState({
    cube_campaign_id: queue?.cube_campaign_id ?? '',
    label: queue?.label ?? '',
    sales_org: queue?.sales_org ?? orgs[0] ?? 'BONANZA',
    product_type_id: queue?.product_type_id ?? '',
    is_default: Boolean(queue?.is_default),
    active: queue ? Boolean(queue.active) : true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        label: form.label,
        product_type_id: form.product_type_id || null,
        is_default: form.is_default ? 1 : 0,
      };
      if (isNew) {
        await api.post('/setup/dialler/campaigns', {
          ...body, cube_campaign_id: form.cube_campaign_id, sales_org: form.sales_org,
        });
        onSaved(`${form.label} registered.`);
      } else {
        await api.patch(`/setup/dialler/campaigns/${queue.id}`, { ...body, active: form.active ? 1 : 0 });
        onSaved(`${form.label} saved.`);
      }
    } catch (err) { onError(err.message); setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/setup/dialler/campaigns/${queue.id}`);
      onSaved(`${queue.label} removed.`);
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal
      title={isNew ? 'Add a dialler queue' : queue.label}
      subtitle={isNew ? 'A CUBE campaign this CRM may dial into' : queue.cube_campaign_id}
      onClose={onClose}
    >
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>Name</span>
          <input value={form.label} onChange={(e) => set('label', e.target.value)}
            placeholder="Bonanza — outbound sales" maxLength={80} />
          <span className="tiny muted">What people here call it.</span>
        </label>

        <label>
          <span>CUBE campaign id</span>
          <input
            value={form.cube_campaign_id}
            onChange={(e) => set('cube_campaign_id', e.target.value)}
            disabled={!isNew}
            placeholder="BNZ_SALES_OUT"
            maxLength={80}
          />
          {/* Frozen after creation: calls have been placed against this string
              and the call log is queried by it, so changing it silently
              detaches the queue from its own history. */}
          <span className="tiny muted">
            {isNew
              ? 'Exactly as CUBE knows it. There is no endpoint that lists campaigns, so this comes from Cube.'
              : 'Fixed — calls and call logs reference it. Retire this queue and add another instead.'}
          </span>
        </label>

        {isNew && orgs.length > 1 && (
          <label>
            <span>Business</span>
            <select value={form.sales_org} onChange={(e) => set('sales_org', e.target.value)}>
              {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <span className="tiny muted">
              Permanent. A queue serves one book, so both books’ calls never land in one
              place in Cube’s reporting.
            </span>
          </label>
        )}

        <label>
          <span>Serves</span>
          <select
            value={form.product_type_id}
            onChange={(e) => set('product_type_id', e.target.value)}
          >
            <option value="">The whole book</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="tiny muted">
            A product-specific queue is preferred over the book default when a lead
            carries that product.
          </span>
        </label>

        <label className="check-one">
          <input type="checkbox" checked={form.is_default}
            onChange={(e) => set('is_default', e.target.checked)} />
          <span>
            Default for this business
            <em className="tiny muted"> — one per book; setting this clears the other</em>
          </span>
        </label>

        {!isNew && (
          <label className="check-one">
            <input type="checkbox" checked={form.active}
              onChange={(e) => set('active', e.target.checked)} />
            <span>Active<em className="tiny muted"> — a retired queue is never dialled into</em></span>
          </label>
        )}

        <div className="modal-actions">
          {!isNew && (
            <button className="btn-ghost btn-sm is-danger" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !form.label.trim() || !form.cube_campaign_id.trim()}
            onClick={save}
          >
            {busy ? <Spinner /> : (isNew ? 'Register queue' : 'Save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- agents */

function Agents({ agents, onSaved, onError }) {
  const [editing, setEditing] = useState(null);
  const unmapped = agents.filter((a) => !a.cti_agent_id).length;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Who is on the switch</h2>
          <span className="tiny muted">
            CUBE knows an agent by its own id, not by ours. Without it a call goes out
            with nobody’s name on it.
          </span>
        </div>
        {unmapped > 0 && (
          <span className="badge badge-amber">{unmapped} unmapped</span>
        )}
      </div>

      {!agents.length && <Empty>No users hold a role that places calls.</Empty>}

      {Boolean(agents.length) && (
        <table>
          <thead>
            <tr><th>Person</th><th>Role</th><th>CUBE agent id</th><th>Extension</th><th /></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <div style={{ fontWeight: 550 }}>{a.name}</div>
                  <div className="tiny muted">{a.branch} · {a.sales_org}</div>
                </td>
                <td className="small">{a.role_name || a.role}</td>
                <td className="api-name">
                  {a.cti_agent_id || <span className="warn-text">Not mapped</span>}
                </td>
                <td className="api-name">{a.phone_extension || '—'}</td>
                <td className="num">
                  <button className="btn-sm" onClick={() => setEditing(a)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <AgentEditor
          agent={editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); onSaved(m); }}
          onError={onError}
        />
      )}
    </div>
  );
}

function AgentEditor({ agent, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    cti_agent_id: agent.cti_agent_id ?? '',
    phone_extension: agent.phone_extension ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/setup/dialler/agents/${agent.id}`, form);
      onSaved(`${agent.name} saved.`);
    } catch (err) {
      // The clash refusal — two people cannot share one agent id — is the
      // useful part, so it is shown as the server phrased it.
      onError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={agent.name} subtitle={`${agent.role_name || agent.role} · ${agent.sales_org}`} onClose={onClose}>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>CUBE agent id</span>
          <input
            value={form.cti_agent_id}
            onChange={(e) => set('cti_agent_id', e.target.value)}
            placeholder="e.g. bsingh"
            maxLength={60}
          />
          <span className="tiny muted">
            As issued by Cube. Must be unique — two people sharing one id makes every
            call from either indistinguishable in Cube’s own reporting. Leave empty to
            unmap; calls then go out unattributed rather than under someone else’s name.
          </span>
        </label>

        <label>
          <span>Extension</span>
          <input
            value={form.phone_extension}
            onChange={(e) => set('phone_extension', e.target.value)}
            placeholder="5008"
            maxLength={20}
          />
          <span className="tiny muted">
            The handset Cube rings. Fixed per agent, so it is set here once rather than
            asked for at every sign-in.
          </span>
        </label>

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
