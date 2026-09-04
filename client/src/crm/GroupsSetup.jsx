/**
 * Setup → Sales groups (P3-08).
 *
 * "Ten RMs report to a single supervisor: I need to create a group, assign
 * those RMs to it, and designate a manager for that group."
 *
 * The table behind this has existed since the beginning and the assignment
 * engine already routes work through it. What was missing was any way to make
 * one — the API had two read routes and the only thing that ever created a
 * group was the seed. So this screen is the missing half of something that
 * already worked, not a new idea bolted alongside.
 *
 * WHAT THIS SCREEN IS CAREFUL TO SAY
 * ---------------------------------
 * A group routes work; it does not grant sight of records. Visibility follows
 * the reporting line. Somebody setting up a desk here will reasonably assume
 * membership means "can see", and the legacy audit shows exactly where that
 * assumption leads: the manager slot became the only way to grant visibility,
 * and one team ended up with twelve managers and a single member.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Spinner, Modal } from '../components/ui.jsx';

export default function GroupsSetup() {
  const [data, { loading, error, reload }] = useApi('/setup/groups');
  const [people] = useApi('/setup/users');
  const [making, setMaking] = useState(false);
  const [open, setOpen] = useState(null);
  const [problem, setProblem] = useState(null);

  if (loading && !data) return <Loading label="Loading groups…" />;
  if (error) return <ErrorBanner error={error} />;

  const groups = data?.groups ?? [];
  const users = people?.users ?? [];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between">
        <span className="tiny muted">{data?.note}</span>
        <button className="btn btn-primary" onClick={() => setMaking(true)}>
          <Icon name="add" size={16} /> New group
        </button>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      {!groups.length ? (
        <Empty>No groups yet. A group maps a set of RMs to the person who runs their desk.</Empty>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {groups.map((g) => (
            <section className="card" key={g.id}>
              <div className="card-head">
                <div>
                  <h2>
                    {g.name}
                    {!g.active && <span className="badge" style={{ marginLeft: 8 }}>Inactive</span>}
                  </h2>
                  <span className="tiny muted">
                    {g.manager_name ? `Run by ${g.manager_name}` : 'No manager set'}
                    {' · '}{g.members.length} member{g.members.length === 1 ? '' : 's'}
                    {' · '}{g.sales_org}
                  </span>
                </div>
                <button className="btn-sm" onClick={() => setOpen(g)}>Edit</button>
              </div>

              {g.description && <div className="card-body"><p className="muted">{g.description}</p></div>}

              <div className="card-body">
                {!g.members.length ? (
                  <p className="tiny muted">Nobody on this desk yet.</p>
                ) : (
                  <div className="row wrap" style={{ gap: 6 }}>
                    {g.members.map((m) => (
                      <span key={m.id} className="badge badge-blue">{m.name}</span>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {making && (
        <GroupForm
          users={users}
          onClose={() => setMaking(false)}
          onSaved={() => { setMaking(false); reload(); }}
          onError={setProblem}
        />
      )}
      {open && (
        <GroupForm
          group={open}
          users={users}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); reload(); }}
          onError={setProblem}
        />
      )}
    </div>
  );
}

/**
 * Make a group, or change one.
 *
 * Members are added and removed one at a time against the server rather than
 * held as a draft and saved at the end. A desk is a live thing — somebody is
 * either on it and receiving work or not — and a half-applied membership change
 * sitting in an unsaved form is how an RM stops getting leads without anybody
 * meaning it.
 */
function GroupForm({ group, users, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: group?.name ?? '',
    description: group?.description ?? '',
    manager_id: group?.manager_id ?? '',
  });
  const [members, setMembers] = useState(group?.members ?? []);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const inGroup = new Set(members.map((m) => m.id));
  const available = users.filter((u) => !inGroup.has(u.id) && u.active);

  const addMember = async (userId) => {
    setBusy(true);
    try {
      const next = await api.post(`/setup/groups/${group.id}/members`, { user_id: Number(userId) });
      setMembers(next.members);
      setAdding('');
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  const removeMember = async (userId) => {
    setBusy(true);
    try {
      const next = await api.del(`/setup/groups/${group.id}/members/${userId}`);
      setMembers(next.members);
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/setup/groups/${group.id}`);
      onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal
      title={group ? `Edit ${group.name}` : 'New group'}
      subtitle={group ? null : 'A set of people and the person who runs their desk'}
      onClose={onClose}
      wide
    >
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const body = { ...form, manager_id: form.manager_id === '' ? null : Number(form.manager_id) };
          if (group) await api.patch(`/setup/groups/${group.id}`, body);
          else await api.post('/setup/groups', body);
          onSaved();
        } catch (err) { onError(err.message); setBusy(false); }
      }}>
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={set('name')} required autoFocus placeholder="Mumbai Equity Desk" />
        </div>

        <div className="field">
          <label>Manager</label>
          <select value={form.manager_id ?? ''} onChange={set('manager_id')}>
            <option value="">—</option>
            {users.filter((u) => u.active).map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          <p className="hint">Who runs this desk. Setting it here does not by itself let them see the members&rsquo; records — that follows the reporting line on each person.</p>
        </div>

        <div className="field">
          <label>Description</label>
          <input value={form.description} onChange={set('description')} placeholder="Optional" />
        </div>

        {group && (
          <div className="field">
            <label>Members</label>
            {!members.length ? (
              <p className="tiny muted">Nobody on this desk yet.</p>
            ) : (
              <div className="stack" style={{ gap: 2 }}>
                {members.map((m) => (
                  <div key={m.id} className="pick-row">
                    <span>{m.name} <span className="tiny muted">{m.role}</span></span>
                    <button type="button" className="btn-sm" disabled={busy} onClick={() => removeMember(m.id)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <select value={adding} onChange={(e) => setAdding(e.target.value)} style={{ flex: 1 }}>
                <option value="">Add somebody…</option>
                {available.map((u) => <option key={u.id} value={u.id}>{u.name} — {u.role}</option>)}
              </select>
              <button type="button" className="btn-sm" disabled={!adding || busy} onClick={() => addMember(adding)}>
                Add
              </button>
            </div>
          </div>
        )}

        <div className="row-between">
          {group ? (
            <button type="button" className="btn-sm" disabled={busy} onClick={remove}>
              Delete group
            </button>
          ) : <span />}
          <div className="row">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || !form.name.trim()}>
              {busy ? <Spinner /> : group ? 'Save' : 'Create group'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
