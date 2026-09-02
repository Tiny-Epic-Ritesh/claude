import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, shortDate, dateTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Spinner, Tabs } from '../components/ui.jsx';

/* Rows per page. The route had no LIMIT, so this table used to render every
   task the caller could see. */
const PAGE = 50;

/**
 * A sortable column header.
 *
 * At module scope: a component declared in a render body is a new type on every
 * render, so React tears down and rebuilds the header row each time — including
 * on every keystroke of the search box.
 */
function Th({ label, col, className, sort, dir, onSort }) {
  if (!col) return <th className={className}>{label}</th>;
  return (
    <th className={className} aria-sort={sort === col ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" aria-label={`Sort by ${label}`} onClick={() => onSort(col)}>
        {label}
        <Icon name={sort !== col ? 'unfold_more' : dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={13} />
      </button>
    </th>
  );
}

export default function Tasks({ session }) {
  const canSeeTeam = session.permissions.includes('report.team');
  const [scope, setScope] = useState('mine');
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ title: '', due_at: '', priority: 'Normal', assignee_id: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  // A different scope is a different question; page 4 of the old one is nothing.
  useEffect(() => { setOffset(0); }, [scope]);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (scope === 'team') params.set('all', 'true');
  if (sort) { params.set('sort', sort); params.set('dir', dir); }
  if (q) params.set('q', q);
  const query = `?${params}`;

  const [tasks, { loading, error, reload, total }] = useApi(`/tasks${query}`, [query]);
  /* The tiles count the whole list rather than the page. They used to be
     computed here from whatever the fetch returned, which stopped being
     everything the moment the route started paging. */
  const [summary] = useApi(`/tasks/summary${scope === 'team' ? '?all=true' : ''}`, [scope]);
  const [meta] = useApi('/meta');

  if (loading && !tasks) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const rows = tasks ?? [];
  const count = total ?? rows.length;
  const orderBy = (key) => {
    setDir(sort === key && dir === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setOffset(0);
  };

  async function add(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.due_at) return;
    setBusy(true);
    try {
      await api.post('/tasks', { ...form, due_at: form.due_at.replace('T', ' '), assignee_id: form.assignee_id || undefined });
      setForm({ title: '', due_at: '', priority: 'Normal', assignee_id: '' });
      reload();
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p>Every task is linked to something and has a due date — the BRD does not allow either to be blank.</p>
        </div>
      </div>

      <div className="metrics">
        <div className="card stat"><div className="stat-label">Open</div><div className="stat-value">{summary?.open ?? '—'}</div></div>
        <div className="card stat tone-danger"><div className="stat-label">Overdue</div><div className="stat-value">{summary?.overdue ?? '—'}</div></div>
        <div className="card stat tone-good"><div className="stat-label">Completed</div><div className="stat-value">{summary?.done ?? '—'}</div></div>
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-body">
          <form onSubmit={add} className="row wrap" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '2 1 260px', marginBottom: 0 }}>
              <label>New task</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Follow up on the pending KYC step…" />
            </div>
            <div className="field" style={{ flex: '1 1 190px', marginBottom: 0 }}>
              <label>Due</label>
              <input type="datetime-local" value={form.due_at} onChange={(e) => setForm({ ...form, due_at: e.target.value })} />
            </div>
            <div className="field" style={{ flex: '0 1 130px', marginBottom: 0 }}>
              <label>Priority</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {['High', 'Normal', 'Low'].map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            {canSeeTeam && (
              <div className="field" style={{ flex: '1 1 170px', marginBottom: 0 }}>
                <label>Assign to</label>
                <select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                  <option value="">Me</option>
                  {(meta?.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            )}
            <button className="btn-primary" disabled={busy || !form.title.trim() || !form.due_at}>{busy ? <Spinner /> : 'Add task'}</button>
          </form>
        </div>
      </section>

      {canSeeTeam && (
        <Tabs tabs={[{ key: 'mine', label: 'My tasks' }, { key: 'team', label: 'Team tasks' }]} active={scope} onChange={setScope} />
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'center' }}>
          {/* There was no way to find one task except reading the list. */}
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search a task or the lead it is for"
            aria-label="Search tasks"
            style={{ flex: '1 1 260px' }}
          />
          <span className="tiny muted">
            {q ? `${count} matching` : `${count} task${count === 1 ? '' : 's'}`}
          </span>
          <span style={{ flex: 1 }} />
          {sort && (
            <button className="btn-ghost btn-sm" onClick={() => { setSort(null); setOffset(0); }}>
              <Icon name="close" size={14} /> Back to due order
            </button>
          )}
        </div>
      </div>

      <section className="card">
        {!rows.length ? (
          <Empty>{q ? `No task matches "${q}".` : 'No tasks.'}</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }} />
                <Th label="Task" col="title" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="Linked to" col="lead_name" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="Assignee" col="assignee_name" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="Priority" col="priority" sort={sort} dir={dir} onSort={orderBy} />
                <Th label="Due" col="due_at" className="num" sort={sort} dir={dir} onSort={orderBy} />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const late = t.status === 'Open' && new Date(t.due_at) < new Date();
                return (
                  <tr key={t.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={t.status !== 'Open'}
                        style={{ width: 16, height: 16 }}
                        onChange={async () => { await api.patch(`/tasks/${t.id}`, { status: t.status === 'Open' ? 'Completed' : 'Open' }); reload(); }}
                      />
                    </td>
                    <td>
                      <div style={{ textDecoration: t.status !== 'Open' ? 'line-through' : 'none', opacity: t.status !== 'Open' ? .6 : 1 }}>{t.title}</div>
                      {t.description && <div className="tiny muted">{t.description}</div>}
                    </td>
                    <td className="small">
                      {t.lead_id ? <Link to={`/leads/${t.lead_id}`} style={{ color: 'var(--brand)' }}>{t.lead_name}</Link> : <span className="muted">—</span>}
                    </td>
                    <td className="small muted">{t.assignee_name}</td>
                    <td><span className={`badge ${t.priority === 'High' ? 'badge-amber' : ''}`}>{t.priority}</span></td>
                    <td className="num"><span className={`badge ${late ? 'badge-red' : ''}`}>{shortDate(t.due_at)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Where you are in the list. */}
        {count > 0 && (count > PAGE || offset > 0) && (
          <div className="card-foot row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="tiny muted">
              {offset + 1}–{offset + rows.length} of {count.toLocaleString('en-IN')}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn-ghost btn-sm" disabled={offset === 0}
                onClick={() => { setOffset(Math.max(offset - PAGE, 0)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                <Icon name="chevron_left" size={15} /> Previous
              </button>
              <button className="btn-ghost btn-sm" disabled={offset + rows.length >= count}
                onClick={() => { setOffset(offset + PAGE); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                Next <Icon name="chevron_right" size={15} />
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
