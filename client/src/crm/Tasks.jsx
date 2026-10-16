import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, shortDate, dateTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Spinner, Tabs, Modal, announce } from '../components/ui.jsx';

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

/**
 * The lead a new task is about (QA-08).
 *
 * The page has always said every task is linked to something, and had no way
 * to link one. Leads only, because that is what this page's tasks are about: a
 * case, partner or product task is made on that record's own screen, where
 * the link is already known. The search is the one the Leads screen uses, so
 * it offers only leads this person can open.
 */
function LeadLink({ value, onChange }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let live = true;
    const term = q.trim();
    if (term.length < 2) { setRows([]); return undefined; }
    const timer = setTimeout(() => {
      api.get(`/leads?q=${encodeURIComponent(term)}&limit=8`)
        .then((r) => { if (live) setRows(Array.isArray(r) ? r : []); })
        .catch(() => { if (live) setRows([]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  if (value) {
    return (
      <div className="row" style={{ gap: 6, alignItems: 'center', minHeight: 36 }}>
        <Icon name="person" size={16} />
        <strong className="small">{value.name}</strong>
        <button type="button" className="btn-ghost" onClick={() => { onChange(null); setQ(''); }}>Change</button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, mobile or email" aria-label="Link the task to a lead" />
      {q.trim().length >= 2 && (
        <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, marginTop: 4, padding: 4 }}>
          {rows.map((l) => (
            <button key={l.id} type="button" className="btn-ghost" style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => { onChange({ id: l.id, name: l.name }); setRows([]); setQ(''); }}>
              {l.name} <span className="tiny muted">{l.stage}{l.owner_name ? ` · ${l.owner_name}` : ''}</span>
            </button>
          ))}
          {!rows.length && <span className="tiny muted">No lead you can open matches that.</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Change or cancel a task (QA-37).
 *
 * A task's title, due date and assignee change; a task is never deleted. It
 * is cancelled with a reason, and then it stays as it is. Used here and on a
 * lead's Tasks tab, so both say the same thing.
 */
export function TaskLifecycle({ task, what, session, onClose, onDone }) {
  const team = session.permissions.includes('report.team');
  const [meta] = useApi(team ? '/meta' : null);
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(String(task.due_at ?? '').replace(' ', 'T').slice(0, 16));
  const [assignee, setAssignee] = useState(task.assignee_id ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (what === 'cancelling') {
        await api.post(`/tasks/${task.id}/cancel`, { reason });
        // Part 4, item 8.4.
        announce('Task cancelled', [`“${task.title}” is cancelled, with your reason. It stays on the list, struck through.`]);
      } else {
        const t = await api.patch(`/tasks/${task.id}`, {
          title, due_at: due.replace('T', ' '), ...(team && assignee ? { assignee_id: Number(assignee) } : {}),
        });
        announce('Task saved', [`“${t?.title ?? title}” is due ${dateTime(t?.due_at ?? due.replace('T', ' '))}${team && assignee && Number(assignee) !== task.assignee_id ? ', and it is reassigned' : ''}.`]);
      }
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const ready = what === 'cancelling' ? reason.trim().length >= 5 : Boolean(title.trim() && due);

  return (
    <Modal title={what === 'cancelling' ? `Cancel "${task.title}"` : 'Change this task'} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <ErrorBanner error={error} />
        {what === 'cancelling' ? (
          <>
            <p className="small">
              A task is not deleted. It is kept as cancelled, with your reason, and its reminders stop.
            </p>
            <div className="field">
              <label htmlFor="task-cancel-reason">Why</label>
              <input id="task-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="The client already sent the documents" autoFocus />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="task-title">Title</label>
              <input id="task-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label htmlFor="task-due">Due</label>
              <input id="task-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            {team && (
              <div className="field">
                <label htmlFor="task-assignee">Assigned to</label>
                <select id="task-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  {!(meta?.users ?? []).some((u) => u.id === task.assignee_id) && task.assignee_id && (
                    <option value={task.assignee_id}>{task.assignee_name ?? 'Current assignee'}</option>
                  )}
                  {(meta?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            )}
          </>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Back</button>
          <button className={what === 'cancelling' ? 'btn-danger' : 'btn-primary'} disabled={busy || !ready}>
            {busy ? 'Saving…' : what === 'cancelling' ? 'Cancel the task' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The two things a task row offers besides ticking it off. */
export function TaskActions({ task, onPick }) {
  if (task.status === 'Cancelled') return null;
  return (
    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
      <button type="button" className="btn-ghost btn-sm" onClick={() => onPick('edit')}>Change</button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => onPick('cancelling')}>Cancel</button>
    </div>
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
  const [linked, setLinked] = useState(null);
  const [addError, setAddError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(null);

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
    if (!form.title.trim() || !form.due_at || !linked) return;
    setBusy(true);
    setAddError(null);
    try {
      const t = await api.post('/tasks', {
        ...form, lead_id: linked.id, due_at: form.due_at.replace('T', ' '), assignee_id: form.assignee_id || undefined,
      });
      // Part 4, item 8.4: "tell the user when a task has been created".
      announce('Task created', [`“${t.title}” on ${linked.name}, due ${dateTime(t.due_at)}${form.assignee_id ? ', and its assignee is notified' : ', on your list'}.`]);
      setForm({ title: '', due_at: '', priority: 'Normal', assignee_id: '' });
      setLinked(null);
      reload();
    } catch (err) {
      // A refusal used to vanish: the add had a finally and no catch.
      setAddError(err.message);
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
          <ErrorBanner error={addError} />
          <form onSubmit={add} className="row wrap" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '2 1 260px', marginBottom: 0 }}>
              <label>New task</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Follow up on the pending KYC step…" />
            </div>
            <div className="field" style={{ flex: '2 1 240px', marginBottom: 0 }}>
              <label>Linked to</label>
              <LeadLink value={linked} onChange={setLinked} />
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
            <button className="btn-primary" disabled={busy || !form.title.trim() || !form.due_at || !linked}>{busy ? <Spinner /> : 'Add task'}</button>
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
                <th />
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
                        disabled={t.status === 'Cancelled'}
                        aria-label={t.status === 'Cancelled' ? 'Cancelled' : 'Done'}
                        style={{ width: 16, height: 16 }}
                        onChange={async () => { await api.patch(`/tasks/${t.id}`, { status: t.status === 'Open' ? 'Completed' : 'Open' }); reload(); }}
                      />
                    </td>
                    <td>
                      <div style={{ textDecoration: t.status !== 'Open' ? 'line-through' : 'none', opacity: t.status !== 'Open' ? .6 : 1 }}>{t.title}</div>
                      {t.description && <div className="tiny muted">{t.description}</div>}
                      {t.status === 'Cancelled' && (
                        <div className="tiny muted">Cancelled {t.cancelled_at ? dateTime(t.cancelled_at) : ''}{t.cancel_reason ? ` — ${t.cancel_reason}` : ''}</div>
                      )}
                    </td>
                    <td className="small">
                      {t.lead_id ? <Link to={`/leads/${t.lead_id}`} style={{ color: 'var(--brand)' }}>{t.lead_name}</Link> : <span className="muted">—</span>}
                    </td>
                    <td className="small muted">{t.assignee_name}</td>
                    <td><span className={`badge ${t.priority === 'High' ? 'badge-amber' : ''}`}>{t.priority}</span></td>
                    <td className="num"><span className={`badge ${late ? 'badge-red' : ''}`}>{shortDate(t.due_at)}</span></td>
                    <td><TaskActions task={t} onPick={(what) => setEnding({ task: t, what })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {ending && (
          <TaskLifecycle task={ending.task} what={ending.what} session={session}
            onClose={() => setEnding(null)} onDone={() => { setEnding(null); reload(); }} />
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
