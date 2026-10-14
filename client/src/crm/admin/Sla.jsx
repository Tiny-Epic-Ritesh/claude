import { useState } from 'react';
import { api, ROLE_LABEL, dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

/* ------------------------------------------------------------------ SLA */

export function Sla() {
  const [sla, { loading }] = useApi('/admin/sla');
  const [cats] = useApi('/admin/categories');
  if (loading || !sla) return <Loading />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>SLA policies</h2><span className="tiny muted">Business hours only · per product</span></div>
          <table>
            <thead><tr><th>Product</th><th>Priority</th><th className="num">Response</th><th className="num">Resolution</th></tr></thead>
            <tbody>
              {sla.policies.map((p) => (
                <tr key={p.id}>
                  <td className="small">{p.product_name || 'All products'}</td>
                  <td><span className="badge">{p.priority}</span></td>
                  <td className="num small">{p.response_mins} min</td>
                  <td className="num small">{Math.round(p.resolution_mins / 60)} h</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card-body tiny muted">
            Defaults where no policy exists: {Object.entries(sla.defaults).map(([k, v]) => `${k} ${v.response_mins}m/${Math.round(v.resolution_mins / 60)}h`).join(' · ')}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Ticket categories</h2><span className="tiny muted">Drive auto-assignment</span></div>
          <table>
            <tbody>
              {(cats || []).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num"><span className="badge badge-blue">{ROLE_LABEL[c.auto_assign_role] || c.auto_assign_role || 'unassigned'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <ComplianceFlags categories={(cats || []).filter((c) => c.active)} />
    </div>
  );
}

/**
 * Which case each AI compliance flag opens (QA-28).
 *
 * The call summary raises one of five flags; each opens a case in a category,
 * at a priority. The defaults were set on 14 October from SEBI's Investor
 * Charter and SCORES; this is where an Admin changes them. Each row saves on
 * its own, and the change is in the configuration audit.
 */
function ComplianceFlags({ categories }) {
  const [data, { loading, error, reload }] = useApi('/admin/compliance-flags');
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(null);
  const [problem, setProblem] = useState(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const draftOf = (r) => drafts[r.flag] ?? { category_id: r.category_id, priority: r.priority };
  const changed = (r) => {
    const d = draftOf(r);
    return Number(d.category_id) !== Number(r.category_id) || d.priority !== r.priority;
  };
  const edit = (r, patch) => setDrafts((all) => ({ ...all, [r.flag]: { ...draftOf(r), ...patch } }));

  async function save(r) {
    setSaving(r.flag);
    setProblem(null);
    try {
      await api.put(`/admin/compliance-flags/${encodeURIComponent(r.flag)}`, draftOf(r));
      setDrafts((all) => { const next = { ...all }; delete next[r.flag]; return next; });
      reload();
    } catch (err) { setProblem(`${r.flag}: ${err.message}`); }
    finally { setSaving(null); }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Compliance flags</h2>
        <span className="tiny muted">The case each flag on an AI call summary opens</span>
      </div>
      <div className="card-body">
        <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
        <table>
          <thead><tr><th>Flag</th><th>Opens a case in</th><th>Priority</th><th /></tr></thead>
          <tbody>
            {data.routes.map((r) => {
              const d = draftOf(r);
              return (
                <tr key={r.flag}>
                  <td>
                    {r.flag}
                    {r.updated_by_name && (
                      <div className="tiny muted">Changed by {r.updated_by_name}, {dateTime(r.updated_at)}</div>
                    )}
                    {r.category_id && !r.category_active && (
                      <div className="tiny" style={{ color: 'var(--warn)' }}>Its category is retired, so these cases open uncategorised.</div>
                    )}
                  </td>
                  <td>
                    <select aria-label={`Category for ${r.flag}`} value={d.category_id ?? ''}
                      onChange={(e) => edit(r, { category_id: Number(e.target.value) })}>
                      {!d.category_id && <option value="">Choose a category</option>}
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}{c.auto_assign_role ? ` (${ROLE_LABEL[c.auto_assign_role] ?? c.auto_assign_role})` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`Priority for ${r.flag}`} value={d.priority} onChange={(e) => edit(r, { priority: e.target.value })}>
                      {data.priorities.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td className="num">
                    <button className="btn-sm btn-primary" disabled={!changed(r) || saving === r.flag || !d.category_id}
                      onClick={() => save(r)}>
                      {saving === r.flag ? 'Saving…' : 'Save'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          A Compliance category's case goes to the least busy Compliance user in the lead's business, or to an
          Admin of that business while nobody holds the Compliance role.
        </p>
      </div>
    </section>
  );
}
