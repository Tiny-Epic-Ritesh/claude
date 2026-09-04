import { useMemo, useState } from 'react';
import { api, dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty } from '../../components/ui.jsx';
import FilterBar from '../../components/FilterBar.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Residency({ session }) {
  /* P3-25. The screen showed every capability with no way to narrow to the
     ones being asked about -- and the question put to this screen is almost
     always the narrow one: which capabilities send anything outside India. */
  const [filters, setFilters] = useState({ q: '', data_class: '', leaves_india: '' });
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  }, [filters]);

  const [data, { loading, error }] = useApi(`/ai/residency${query ? `?${query}` : ''}`, [query]);

  const download = async () => {
    setExporting(true);
    setProblem(null);
    try {
      const blob = await api.blob(`/ai/residency/export${query ? `?${query}` : ''}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `data-residency-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) { setProblem(err.message); } finally { setExporting(false); }
  };
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

      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}

      <section className="card">
        <div className="card-head">
          <h2>Where each AI capability is processed</h2>
          <span className="tiny muted">
            {leaving.length} of {data.capabilities.length} shown route outside India, de-identified
            {data.capabilities_total !== data.capabilities.length
              && ` · ${data.capabilities.length} of ${data.capabilities_total} capabilities shown`}
          </span>
        </div>

        <FilterBar
          fields={[
            { name: 'q', label: 'Capability', type: 'text', placeholder: 'Name or reason' },
            {
              name: 'data_class',
              label: 'Data class',
              type: 'select',
              options: (data.data_classes ?? []).map((c) => ({ value: c, label: c.replace('CLASS_', '') })),
            },
            {
              name: 'leaves_india',
              label: 'Leaves India',
              type: 'select',
              blank: 'Either',
              options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
            },
          ]}
          values={filters}
          onChange={setFilters}
          onExport={session?.permissions?.includes('report.system') ? download : null}
          busy={exporting}
        />
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
