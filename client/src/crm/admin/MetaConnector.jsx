import { useState } from 'react';
import { api, shortDate } from '../../api.js';
import { useApi, Loading, Empty, Icon, ErrorBanner } from '../../components/ui.jsx';

/**
 * Meta Lead Ads console (P3-18).
 *
 * The connector worked before this; what it could not do was let anybody see
 * or change how it worked. Leads arrived, and that was the whole of it — no
 * way to tell which form sent them, which book they should belong to, what the
 * advertiser's own questions meant, or what became of a delivery that produced
 * no lead.
 *
 * FIVE SECTIONS, AND WHY EACH ONE EXISTS
 *
 *   Connection   what is wired and what is deliberately off. Was already here.
 *   Forms        which forms are really sending leads, and whose book each one
 *                feeds. Every Meta lead used to be written into the first
 *                sales org, so a Bigul page's leads landed in Bonanza's book
 *                and were called by RMs they did not belong to.
 *   Mapping      what each question means. The map was a constant in the
 *                vendor module, so a form asking "Which product interests
 *                you?" had that answer read and dropped — the one question on
 *                the form that says why the person is interested.
 *   Deliveries   what happened to each one. Without it "the connector has
 *                stopped" and "everyone who filled the form was already a
 *                client" look identical from the lead list.
 *   Leads        the arrivals themselves.
 *
 * The three Meta capabilities that are not lead ads — publishing ad campaigns,
 * Custom Audiences, Messenger and Instagram DMs — have working routes and no
 * screen. They are not here because this console is about lead ads.
 */
export function MetaConnector() {
  const [problem, setProblem] = useState(null);

  return (
    <>
      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}
      <Connection />
      <Forms onError={setProblem} />
      <Mapping onError={setProblem} />
      <Deliveries />
      <RecentLeads />
    </>
  );
}

/* ------------------------------------------------------- 1 · connection */

const CAP_LABEL = {
  lead_ads: 'Lead Ads → CRM',
  messaging: 'Messenger & Instagram DMs',
  ad_campaigns: 'Publish ad campaigns',
  custom_audiences: 'Custom Audiences',
};

/**
 * What is actually wired, and which capability is off on purpose.
 *
 * A connector page that shows four green ticks when nothing is configured is
 * how integrations get signed off before they work.
 */
function Connection() {
  const [data, { loading }] = useApi('/admin/connectors/meta');
  if (loading || !data) return <Loading />;

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
    </>
  );
}

/* ------------------------------------------------------------ 2 · forms */

/**
 * The forms that have actually sent leads, and where those leads go.
 *
 * The book is the column that matters, and it is why this screen exists: a
 * form set to the wrong one puts a client in front of an RM who should never
 * have seen them. Changing it takes effect for leads that arrive afterwards;
 * leads already created are left where they are, because moving somebody's
 * client between books silently is worse than a mistake somebody can see.
 */
function Forms({ onError }) {
  const [data, { loading, reload }] = useApi('/admin/connectors/meta/forms');
  const [busy, setBusy] = useState(null);
  if (loading || !data) return <Loading />;

  const save = async (formId, patch) => {
    setBusy(formId);
    try { await api.patch(`/admin/connectors/meta/forms/${formId}`, patch); reload(); }
    catch (err) { onError(err.message); }
    finally { setBusy(null); }
  };

  return (
    <section className="card section-card">
      <div className="section-head">
        <div>
          <h2>Lead forms</h2>
          <p>{data.forms.length} form{data.forms.length === 1 ? '' : 's'} has sent us leads. A form is listed the first time one arrives.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reload}>Refresh</button>
      </div>

      {!data.forms.length ? (
        <Empty>No lead form has sent anything yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Form</th><th>Book</th><th>Owner</th><th>Product</th>
                <th>Source label</th><th className="num">Leads</th><th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.forms.map((f) => (
                <tr key={f.form_id} className={busy === f.form_id ? 'is-busy' : ''}>
                  <td>
                    <strong>{f.name || f.form_id}</strong>
                    {f.name && <div className="tiny muted">{f.form_id}</div>}
                    {f.page_id && <div className="tiny muted">Page {f.page_id}</div>}
                  </td>

                  <td>
                    <select
                      value={f.sales_org}
                      onChange={(e) => save(f.form_id, { sales_org: e.target.value, owner_id: null })}
                    >
                      {data.orgs.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
                    </select>
                  </td>

                  <td>
                    {/* Only owners in the form's own book — anyone else would be
                        assigned leads they cannot see. */}
                    <select
                      value={f.owner_id ?? ''}
                      onChange={(e) => save(f.form_id, { owner_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">Assignment rules</option>
                      {data.owners.filter((u) => u.sales_org === f.sales_org).map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  </td>

                  <td>
                    <select
                      value={f.product_type_id ?? ''}
                      onChange={(e) => save(f.form_id, { product_type_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">—</option>
                      {/* Only this book's products. Both books carry a "Mutual
                          Funds", and an unlabelled list shows it twice. */}
                      {data.products.filter((p) => p.sales_org === f.sales_org).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>

                  <td>
                    <input
                      defaultValue={f.source_label ?? ''}
                      placeholder="Facebook Lead Ads"
                      onBlur={(e) => {
                        if (e.target.value !== (f.source_label ?? '')) save(f.form_id, { source_label: e.target.value });
                      }}
                    />
                  </td>

                  <td className="num">
                    <strong>{f.lead_count}</strong>
                    {f.delivery_count > f.lead_count && (
                      <div className="tiny muted">of {f.delivery_count}</div>
                    )}
                  </td>
                  <td className="small muted">{f.last_seen_at ? shortDate(f.last_seen_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------- 3 · mapping */

/**
 * What the questions on a form mean.
 *
 * Two lists, because they are different jobs. `unmapped` is the working one:
 * questions that have arrived and nobody has decided about. Their answers are
 * kept as a note on the lead in the meantime, so nothing is lost while a
 * decision is pending — but a note is not a field you can filter or report on.
 */
function Mapping({ onError }) {
  const [data, { loading, reload }] = useApi('/admin/connectors/meta/field-map');
  const [adding, setAdding] = useState('');
  if (loading || !data) return <Loading />;

  const set = async (question, crmField, formId = '*') => {
    try { await api.put('/admin/connectors/meta/field-map', { form_id: formId, question, crm_field: crmField || null }); reload(); }
    catch (err) { onError(err.message); }
  };

  return (
    <section className="card section-card">
      <div className="section-head">
        <div>
          <h2>Field mapping</h2>
          <p>What each question on a form means. Answers with nowhere to go are kept as a note on the lead.</p>
        </div>
      </div>

      {data.unmapped.length > 0 && (
        <div className="notice notice-warn">
          <Icon name="help" />
          <div>
            <strong>{data.unmapped.length} question{data.unmapped.length === 1 ? ' has' : 's have'} arrived that nobody has mapped.</strong>
            <p className="tiny muted" style={{ margin: '3px 0 0' }}>
              The answers are on the leads as a note. Give one a field here and it becomes
              something you can filter and report on.
            </p>
          </div>
        </div>
      )}

      {data.unmapped.length > 0 && (
        <div className="table-scroll" style={{ marginBottom: 10 }}>
          <table>
            <thead><tr><th>Question</th><th>Form</th><th className="num">Seen</th><th>Put it in</th></tr></thead>
            <tbody>
              {data.unmapped.map((u) => (
                <tr key={`${u.form_id}-${u.question}`}>
                  <td><code>{u.question}</code></td>
                  <td className="small muted">{u.form_id}</td>
                  <td className="num">{u.count}</td>
                  <td>
                    <select defaultValue="" onChange={(e) => set(u.question, e.target.value)}>
                      <option value="">Choose…</option>
                      <option value="">Keep as a note</option>
                      {data.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className="muted">Default map</h4>
      <p className="hint">Applied to every form that has no map of its own.</p>

      <div className="table-scroll">
        <table>
          <thead><tr><th>Question Meta sends</th><th>Goes into</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.question}>
                <td><code>{r.question}</code></td>
                <td>
                  <select value={r.crm_field ?? ''} onChange={(e) => set(r.question, e.target.value)}>
                    <option value="">Keep as a note</option>
                    {data.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <input
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  placeholder="another question name"
                />
              </td>
              <td>
                <select
                  value=""
                  disabled={!adding.trim()}
                  onChange={(e) => { set(adding.trim(), e.target.value); setAdding(''); }}
                >
                  <option value="">Choose a field…</option>
                  {data.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- 4 · deliveries */

const OUTCOME = {
  created: { label: 'Lead created', short: 'created', pill: 'state-active' },
  duplicate: { label: 'Already had it', short: 'already delivered', pill: 'state-exploring' },
  repeat: { label: 'Filled the form again', short: 'already a lead', pill: 'state-exploring' },
  failed: { label: 'Failed', short: 'failed', pill: 'state-risk' },
};

/**
 * What happened to each delivery.
 *
 * A failure is the row most worth having: Meta does not resend, so this is the
 * only evidence that lead ever existed.
 */
function Deliveries() {
  const [data, { loading, reload }] = useApi('/admin/connectors/meta/deliveries');
  if (loading || !data) return <Loading />;

  const totals = data.totals ?? {};

  return (
    <section className="card section-card">
      <div className="section-head">
        <div>
          <h2>Deliveries</h2>
          <p>
            {Object.entries(totals).map(([k, n]) => `${n} ${OUTCOME[k]?.short ?? k}`).join(' · ')
              || 'Nothing has been delivered yet'}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reload}>Refresh</button>
      </div>

      {!data.rows.length ? (
        <Empty>Meta has not delivered anything yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>When</th><th>Outcome</th><th>Form</th><th>Book</th><th>Lead</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {data.rows.map((d) => {
                let detail = null;
                try { detail = d.detail ? JSON.parse(d.detail) : null; } catch { detail = null; }
                return (
                  <tr key={d.id}>
                    <td className="small muted">{shortDate(d.at)}</td>
                    <td>
                      <span className={`state-pill ${OUTCOME[d.outcome]?.pill ?? 'state-exploring'}`}>
                        {OUTCOME[d.outcome]?.label ?? d.outcome}
                      </span>
                    </td>
                    <td className="small">{d.form_name || d.form_id || '—'}</td>
                    <td className="small muted">{d.sales_org || '—'}</td>
                    <td className="small">{d.lead_name || '—'}</td>
                    <td className="tiny muted">
                      {detail?.error && <span className="err-text">{detail.error}</span>}
                      {detail?.unmapped?.length > 0 && `unmapped: ${detail.unmapped.join(', ')}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ 5 · leads */

function RecentLeads() {
  const [leads, { loading, reload }] = useApi('/admin/connectors/meta/leads');
  if (loading) return <Loading />;

  return (
    <section className="card section-card">
      <div className="section-head">
        <div>
          <h2>Leads from Meta</h2>
          <p>{leads?.length ?? 0} most recent</p>
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
  );
}
