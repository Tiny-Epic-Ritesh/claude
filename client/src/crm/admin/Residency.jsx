import { dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Residency({ session }) {
  const [data, { loading, error }] = useApi('/ai/residency');
  const canAudit = session.permissions.includes('audit.read');
  const [log] = useApi(canAudit ? '/ai/residency/log?limit=25' : null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Empty>No policy published.</Empty>;

  const leaving = data.capabilities.filter((c) => c.leaves_india);

  return (
    <>
      <div className="notice">
        <strong>Mode: {data.mode}</strong> — {data.effective_note}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Where each AI capability is processed</h2>
          <span className="tiny muted">{leaving.length} of {data.capabilities.length} route outside India, de-identified</span>
        </div>
        <table>
          <thead>
            <tr><th>Capability</th><th>Data class</th><th>Processed</th><th>Why</th></tr>
          </thead>
          <tbody>
            {data.capabilities.map((c) => (
              <tr key={c.capability}>
                <td style={{ fontWeight: 545 }}>{c.capability}</td>
                <td>
                  <span className={`badge ${c.data_class === 'CLASS_PII_RAW' ? 'badge-amber' : 'badge-blue'}`}>
                    {c.data_class.replace('CLASS_', '')}
                  </span>
                </td>
                <td>
                  {c.leaves_india
                    ? <span className="badge badge-blue">Outside India · de-identified</span>
                    : <span className="badge badge-green">In India</span>}
                </td>
                <td className="tiny muted">{c.classification_reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>{data.note}</p>
      </section>

      {canAudit && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2>Egress evidence</h2>
            <span className="tiny muted">What was removed before each cross-border call</span>
          </div>
          {!log?.length ? <Empty>No cross-border AI calls yet.</Empty> : (
            <table>
              <thead>
                <tr><th>When</th><th>Capability</th><th>Outcome</th><th>Identifiers removed</th></tr>
              </thead>
              <tbody>
                {log.map((e) => (
                  <tr key={e.id}>
                    <td className="tiny muted num" style={{ width: 150 }}>{dateTime(e.created_at)}</td>
                    <td className="small">{e.meta?.capability}</td>
                    <td>
                      {e.action === 'ai_egress_blocked'
                        ? <span className="badge badge-red">Blocked</span>
                        : <span className="badge badge-green">Sent</span>}
                    </td>
                    <td className="tiny">
                      {Object.entries(e.meta?.redacted || {}).map(([kind, n]) => (
                        <span key={kind} className="badge" style={{ marginRight: 4 }}>{kind} ×{n}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>
            Counts only — the log records what kind of identifier was removed and how many, never the values.
            A log that stored the values would simply be a second copy of the data it exists to protect.
          </p>
        </section>
      )}
    </>
  );
}
