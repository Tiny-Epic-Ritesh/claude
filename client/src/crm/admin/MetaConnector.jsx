import { useEffect, useState } from 'react';
import { api, shortDate } from '../../api.js';
import { useApi, Loading, Empty, Icon, ErrorBanner, Modal, Spinner } from '../../components/ui.jsx';

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
 *   Ad campaigns what has been published from here, and what it has spent
 *   Audiences    the one capability that breaks the data-residency rule, so
 *                the conflict is on the screen that does it and the history of
 *                what left the country is on the same screen
 *   Messages     Messenger and Instagram conversations, unclaimed ones first
 *
 * The last three had working routes and no screen at all, which is how a
 * connector comes to be signed off while one of its capabilities silently
 * discards everything it receives — see the DM section.
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
      <AdCampaigns onError={setProblem} />
      <Audiences onError={setProblem} />
      <Messages onError={setProblem} />
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

/* ----------------------------------------------------- 6 · ad campaigns */

const money = (n) => (n === null || n === undefined ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);

/* Spend over leads, or nothing at all — a campaign that has spent and produced
   no leads yet would otherwise divide by zero and read as infinite cost. */
const costPerLead = (insights) => (insights?.leads
  ? money(Math.round(insights.spend / insights.leads))
  : '—');

/**
 * Ad campaigns published from here.
 *
 * Every one is created PAUSED, and the screen says so rather than leaving it
 * to be discovered: a CRM button that starts spending the second it is pressed
 * is a bad idea however good the confirmation dialog, so a human starts it in
 * Ads Manager having seen it.
 *
 * Spend is pulled on request, not on load. It is a paid API call against a
 * rate limit and yesterday's spend does not change, so the number is cached
 * with the time it was taken and the screen says how old it is.
 */
function AdCampaigns({ onError }) {
  const [rows, { loading, reload }] = useApi('/admin/connectors/meta/campaigns');
  const [draft, setDraft] = useState({ name: '', daily_budget: '' });
  const [busy, setBusy] = useState(false);
  if (loading) return <Loading />;

  const publish = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      await api.post('/admin/connectors/meta/campaigns', {
        name: draft.name.trim(),
        daily_budget: draft.daily_budget ? Number(draft.daily_budget) : undefined,
      });
      setDraft({ name: '', daily_budget: '' });
      reload();
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  const refresh = async (metaId) => {
    try { await api.get(`/admin/connectors/meta/campaigns/${metaId}/insights`); reload(); }
    catch (err) { onError(err.message); }
  };

  return (
    <section className="card section-card">
      <div className="section-head">
        <div>
          <h2>Ad campaigns</h2>
          <p>Published from here. Every one is created paused — start it in Ads Manager once you have reviewed it.</p>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Campaign name</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Bigul — SIP lead ads, October"
          />
        </div>
        <div className="field">
          <label>Daily budget</label>
          <input
            type="number"
            value={draft.daily_budget}
            onChange={(e) => setDraft((d) => ({ ...d, daily_budget: e.target.value }))}
            placeholder="5000"
          />
        </div>
        <div className="field" style={{ alignSelf: 'end' }}>
          <button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={publish}>
            {busy ? <Spinner /> : <Icon name="add" size={16} />} Publish paused
          </button>
        </div>
      </div>

      {!rows?.length ? (
        <Empty>Nothing has been published from here.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Campaign</th><th>Status</th><th>Book</th><th className="num">Budget/day</th>
                <th className="num">Spend</th><th className="num">Clicks</th><th className="num">Leads</th>
                <th className="num">Cost/lead</th><th>As of</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.meta_id}>
                  <td>
                    <strong>{c.name}</strong>
                    <div className="tiny muted">
                      {c.meta_id}{c.simulated ? ' · simulated' : ''}
                      {c.created_by_name ? ` · ${c.created_by_name}` : ''}
                    </div>
                  </td>
                  <td>
                    <span className={`state-pill ${c.status === 'PAUSED' ? 'state-exploring' : 'state-active'}`}>
                      {c.status || '—'}
                    </span>
                  </td>
                  <td className="small muted">{c.sales_org}</td>
                  <td className="num">{money(c.daily_budget)}</td>
                  <td className="num">{money(c.insights?.spend)}</td>
                  <td className="num">{c.insights?.clicks ?? '—'}</td>
                  <td className="num">{c.insights?.leads ?? '—'}</td>
                  {/* What a lead is costing, which is the number this table
                      exists to produce. Spend and leads separately are two
                      figures somebody has to divide. */}
                  <td className="num">{costPerLead(c.insights)}</td>
                  <td className="small muted">
                    {c.insights_at ? shortDate(c.insights_at) : 'never pulled'}
                  </td>
                  <td>
                    <button className="btn-sm" onClick={() => refresh(c.meta_id)}>Pull spend</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------- 7 · audiences */

/**
 * Custom Audiences, and the rule they break.
 *
 * Pushing a segment to Meta sends hashed client identifiers to Meta's servers
 * — client data leaving India, which contradicts the standing constraint this
 * project was set up under. It is lawful under DPDP with consent and it is
 * ordinary industry practice; it is still this firm's own rule, at a
 * SEBI-regulated broker.
 *
 * So the conflict is stated on the screen that does it rather than in a
 * document somebody read once, the capability is off unless deliberately
 * enabled, and every push is listed here — what left the country is answerable
 * from the same screen that sends it.
 */
function Audiences({ onError }) {
  const [data, { loading, reload }] = useApi('/admin/connectors/meta/audiences');
  const [draft, setDraft] = useState({ name: '', list_id: '' });
  const [busy, setBusy] = useState(false);
  if (loading || !data) return <Loading />;

  const push = async () => {
    setBusy(true);
    try {
      await api.post('/admin/connectors/meta/audiences', { name: draft.name.trim(), list_id: Number(draft.list_id) });
      setDraft({ name: '', list_id: '' });
      reload();
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <section className="card section-card">
      <div className="section-head">
        <div>
          <h2>Custom Audiences</h2>
          <p>{data.enabled ? 'Enabled — pushes send hashed identifiers to Meta.' : 'Off, deliberately.'}</p>
        </div>
      </div>

      <div className={`notice ${data.enabled ? 'notice-warn' : ''}`}>
        <Icon name="public_off" />
        <div className="tiny">
          {data.residency_note}
          {!data.enabled && (
            <> Needs compliance sign-off and <code>CRM_META_AUDIENCES_ENABLED=true</code> in <code>server/.env</code>.</>
          )}
        </div>
      </div>

      {data.enabled && (
        <div className="field-row">
          <div className="field">
            <label>Audience name</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="SIP prospects — October"
            />
          </div>
          <div className="field">
            <label>From lead list</label>
            <select value={draft.list_id} onChange={(e) => setDraft((d) => ({ ...d, list_id: e.target.value }))}>
              <option value="">Choose…</option>
              {data.lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name} ({l.members})</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button
              className="btn btn-primary"
              disabled={busy || !draft.name.trim() || !draft.list_id}
              onClick={push}
            >
              {busy ? <Spinner /> : <Icon name="upload" size={16} />} Push to Meta
            </button>
          </div>
        </div>
      )}

      {!data.pushes.length ? (
        <Empty>Nothing has been pushed to Meta.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Audience</th><th>List</th><th className="num">On the list</th>
                <th className="num">Sent</th><th className="num">Matched</th><th>Pushed by</th><th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.pushes.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td className="small muted">{p.list_name || '—'}</td>
                  <td className="num">{p.considered}</td>
                  {/* The gap between these two is everyone who opted out. */}
                  <td className="num">{p.sent}</td>
                  <td className="num">{p.matched ?? '—'}</td>
                  <td className="small muted">{p.pushed_by_name || '—'}</td>
                  <td className="small muted">{shortDate(p.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------- 8 · messages */

/**
 * Messenger and Instagram conversations.
 *
 * Every one of these was being discarded before this: the sender was looked up
 * against `leads.external_id`, which holds a Meta *leadgen* id, and a
 * page-scoped sender id is never equal to one. The connector reported zero
 * messages forever, which reads exactly like nobody having messaged.
 *
 * There is no automatic fix — Meta sends no phone number and no email with a
 * DM, deliberately — so a person who recognises a conversation says who it is,
 * and everything that sender has already sent is attached to that timeline at
 * the same time.
 */
function Messages({ onError }) {
  const [data, { loading, reload }] = useApi('/admin/connectors/meta/messages');
  const [linking, setLinking] = useState(null);
  if (loading || !data) return <Loading />;

  return (
    <section className="card section-card">
      <div className="section-head">
        <div>
          <h2>Messenger &amp; Instagram</h2>
          <p>
            {data.unmatched
              ? `${data.unmatched} conversation${data.unmatched === 1 ? '' : 's'} nobody has claimed`
              : 'Every conversation is on a timeline'}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reload}>Refresh</button>
      </div>

      {!data.rows.length ? (
        <Empty>Nothing has arrived from Messenger or Instagram yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>From</th><th>Platform</th><th>Last message</th><th className="num">Messages</th><th>When</th><th>Lead</th></tr>
            </thead>
            <tbody>
              {data.rows.map((c) => (
                <tr key={c.psid}>
                  <td className="small muted"><code>{c.psid}</code></td>
                  <td><span className="badge">{c.platform}</span></td>
                  <td className="small">{c.last_body || <span className="muted">(attachment)</span>}</td>
                  <td className="num">{c.messages}</td>
                  <td className="small muted">{shortDate(c.last_at)}</td>
                  <td>
                    {c.lead_id
                      ? <a href={`#/leads/${c.lead_id}`}>{c.lead_name}</a>
                      : (
                        <button className="btn-sm" onClick={() => setLinking(c)}>
                          <Icon name="link" size={14} /> Say who this is
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {linking && (
        <LinkSender
          conversation={linking}
          onClose={() => setLinking(null)}
          onDone={() => { setLinking(null); reload(); }}
          onError={onError}
        />
      )}
    </section>
  );
}

/**
 * Find the lead a conversation belongs to.
 *
 * Searched rather than typed as an id, because the person doing this is
 * recognising a name, not looking one up. The search is the app's own, so it
 * returns only leads this user is allowed to see — a link is a write onto
 * somebody's timeline and must not be a way to reach a record you could not
 * otherwise open.
 */
function LinkSender({ conversation, onClose, onDone, onError }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return undefined; }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/search?q=${encodeURIComponent(q.trim())}`);
        setHits(res.groups?.Leads ?? []);
      } catch { setHits([]); }
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const link = async (leadId) => {
    setBusy(true);
    try {
      const res = await api.post('/admin/connectors/meta/messages/link', {
        psid: conversation.psid, lead_id: leadId,
      });
      onDone(res);
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="Who is this?" subtitle={`${conversation.platform} · ${conversation.messages} message(s)`} onClose={onClose}>
      <p className="hint">
        Meta sends no phone number or email with a message, so this link is made by
        somebody who recognises the conversation. Everything this sender has already
        sent joins the lead&rsquo;s timeline.
      </p>

      <blockquote className="dlt-text" style={{ marginBottom: 10 }}>
        <code>{conversation.last_body || '(attachment)'}</code>
      </blockquote>

      <div className="field">
        <label>Find the lead</label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile or client code" autoFocus />
      </div>

      {q.trim().length >= 2 && !hits.length && <Empty>Nothing matches.</Empty>}

      <div className="stack" style={{ gap: 1 }}>
        {hits.map((h) => (
          <button key={h.id} type="button" className="btn-ghost row-between" disabled={busy} onClick={() => link(h.id)}>
            <span><strong>{h.title}</strong> <span className="tiny muted">{h.subtitle}</span></span>
            <span className="badge">{h.badge}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
