import { api, shortDate } from '../../api.js';
import { useApi, Loading, Empty, Icon } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

/* --------------------------------------------------------- connectors */

/**
 * Meta — Facebook and Instagram.
 *
 * The screen exists to answer two questions honestly: what is actually wired,
 * and which capability is switched off on purpose rather than by omission.
 * A connector page that shows four green ticks when nothing is configured is
 * how integrations get signed off before they work.
 */
export function MetaConnector() {
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
