import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, shortDate, dateTime } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Spinner, Tabs } from '../components/ui.jsx';

export default function Tasks({ session }) {
  const canSeeTeam = session.permissions.includes('report.team');
  const [scope, setScope] = useState('mine');
  const [tasks, { loading, error, reload }] = useApi(`/tasks${scope === 'team' ? '?all=true' : ''}`);
  const [meta] = useApi('/meta');
  const [form, setForm] = useState({ title: '', due_at: '', priority: 'Normal', assignee_id: '' });
  const [busy, setBusy] = useState(false);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const open = tasks.filter((t) => t.status === 'Open');
  const overdue = open.filter((t) => new Date(t.due_at) < new Date());
  const done = tasks.filter((t) => t.status !== 'Open');

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
        <div className="card stat"><div className="stat-label">Open</div><div className="stat-value">{open.length}</div></div>
        <div className="card stat tone-danger"><div className="stat-label">Overdue</div><div className="stat-value">{overdue.length}</div></div>
        <div className="card stat tone-good"><div className="stat-label">Completed</div><div className="stat-value">{done.length}</div></div>
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

      <section className="card">
        {!tasks.length ? <Empty>No tasks.</Empty> : (
          <table>
            <thead><tr><th style={{ width: 40 }} /><th>Task</th><th>Linked to</th><th>Assignee</th><th>Priority</th><th className="num">Due</th></tr></thead>
            <tbody>
              {tasks.map((t) => {
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
      </section>
    </>
  );
}
