import { useMemo, useState } from 'react';
import { api, dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty } from '../../components/ui.jsx';
import FilterBar from '../../components/FilterBar.jsx';

/* ---------------------------------------------------------------- audit */

/**
 * The audit log. P3-01, P3-22.
 *
 * It showed the last 300 events and offered no way to narrow them, so finding
 * one action meant scrolling — on the table that exists precisely to be
 * searched after the fact. Filters and an export now, on the shared bar, so
 * this screen behaves the same way as the other three Setup screens that
 * gained one.
 *
 * The export applies the filters on screen. That is the whole point of it: a
 * file that quietly held a different set from the table above it would be worse
 * than no export, because somebody would treat it as evidence.
 */
export function Audit({ session }) {
  const [filters, setFilters] = useState({
    q: '', action: '', entity: '', from: '', to: '',
  });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  }, [filters]);

  const [log, { loading }] = useApi(`/admin/audit${query ? `?${query}` : ''}`, [query]);

  /* The ticket restricts the export to Admin and Super Admin, and the route
     enforces it. Offering a button that answers 403 would be the same class of
     defect as the dead buttons in P3-28. */
  const mayExport = session?.permissions?.includes('admin.users');

  const download = async () => {
    setExporting(true);
    setError(null);
    try {
      const blob = await api.blob(`/admin/audit/export${query ? `?${query}` : ''}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  if (loading && !log) return <Loading />;

  const rows = log?.rows ?? [];

  return (
    <section className="card">
      <div className="card-head">
        <h2>Audit log</h2>
        <span className="tiny muted">
          {log ? `${rows.length.toLocaleString('en-IN')} of ${(log.total ?? 0).toLocaleString('en-IN')}` : ''}
        </span>
      </div>

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      <FilterBar
        fields={[
          { name: 'q', label: 'Who', type: 'text', placeholder: 'Name' },
          { name: 'action', label: 'Action', type: 'select', options: log?.actions ?? [] },
          { name: 'entity', label: 'Record type', type: 'select', options: log?.entities ?? [] },
          { name: 'from', label: 'From', type: 'date' },
          { name: 'to', label: 'To', type: 'date' },
        ]}
        values={filters}
        onChange={setFilters}
        onExport={mayExport ? download : null}
        busy={exporting}
      />

      {rows.length === 0 ? (
        <Empty>Nothing matches those filters.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td>
                <td className="small">{a.user_name || 'system'}</td>
                <td><span className="badge">{a.action}</span></td>
                <td className="small muted">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
                <td className="tiny muted" style={{ maxWidth: 380, wordBreak: 'break-word' }}>{a.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
