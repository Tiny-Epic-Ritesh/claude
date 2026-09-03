import { useApi, Loading, Empty } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Integrations() {
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
