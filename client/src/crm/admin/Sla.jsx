import { useState } from 'react';
import { api, ROLE_LABEL, dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner, Modal, announce } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

/* ------------------------------------------------------------------ SLA */

export function Sla() {
  const [sla, { loading }] = useApi('/admin/sla');
  const [cats, { reload: reloadCats }] = useApi('/admin/categories');
  const [changing, setChanging] = useState(null);
  const [problem, setProblem] = useState(null);
  if (loading || !sla) return <Loading />;

  const restore = async (c) => {
    setProblem(null);
    try {
      await api.post(`/admin/categories/${c.id}/restore`);
      // Part 4, item 8.4.
      announce('Category restored', [`"${c.name}" can be chosen for new cases again.`]);
      reloadCats();
    }
    catch (err) { setProblem(err.message); }
  };

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
          <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
          <table>
            <tbody>
              {(cats || []).map((c) => (
                <tr key={c.id} style={c.active ? undefined : { opacity: 0.65 }}>
                  <td>
                    {c.name}
                    {!c.active && (
                      <div className="tiny muted">
                        Retired{c.retired_at ? ` ${dateTime(c.retired_at)}` : ''}{c.retire_reason ? ` — ${c.retire_reason}` : ''}. Cases that have it keep it.
                      </div>
                    )}
                  </td>
                  <td className="num"><span className="badge badge-blue">{ROLE_LABEL[c.auto_assign_role] || c.auto_assign_role || 'unassigned'}</span></td>
                  <td className="num">
                    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button className="btn-ghost btn-sm" onClick={() => setChanging({ category: c, what: 'rename' })}>Rename</button>
                      {c.active
                        ? <button className="btn-ghost btn-sm" onClick={() => setChanging({ category: c, what: 'retiring' })}>Retire</button>
                        : <button className="btn-ghost btn-sm" onClick={() => restore(c)}>Restore</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <ComplianceFlags categories={(cats || []).filter((c) => c.active)} />

      {changing && (
        <CategoryLifecycle category={changing.category} what={changing.what}
          onClose={() => setChanging(null)} onDone={() => { setChanging(null); reloadCats(); }} />
      )}
    </div>
  );
}

/**
 * Rename or retire a case category (QA-37).
 *
 * Never deleted -- cases point at it. Retired, it leaves every picker and goes
 * on no new case, and it can be restored. A category a compliance flag opens
 * cases in is refused until the flag is routed elsewhere, and the refusal says
 * which flag.
 */
function CategoryLifecycle({ category, what, onClose, onDone }) {
  const [name, setName] = useState(category.name);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (what === 'rename') await api.patch(`/admin/categories/${category.id}`, { name });
      else await api.post(`/admin/categories/${category.id}/retire`, { reason });
      announce(what === 'rename' ? 'Category renamed' : 'Category retired', [what === 'rename'
        ? `"${category.name}" is now "${name.trim()}", on every case that has it.`
        : `"${category.name}" stays on the cases that have it, and goes on no new one.`]);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const ready = what === 'rename' ? Boolean(name.trim()) && name.trim() !== category.name : reason.trim().length >= 5;

  return (
    <Modal title={what === 'rename' ? `Rename "${category.name}"` : `Retire "${category.name}"`} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <ErrorBanner error={error} />
        {what === 'rename' ? (
          <div className="field">
            <label htmlFor="category-name">Name</label>
            <input id="category-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
        ) : (
          <>
            <p className="small">It leaves every picker and goes on no new case. Cases that already have it keep it. It can be restored.</p>
            <div className="field">
              <label htmlFor="category-reason">Why</label>
              <input id="category-reason" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="Merged into Account changes" autoFocus />
            </div>
          </>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy || !ready}>{busy ? 'Saving…' : what === 'rename' ? 'Save' : 'Retire'}</button>
        </div>
      </form>
    </Modal>
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
      announce('Compliance flag saved', [`"${r.flag}" is updated for calls flagged from now on.`]);
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
