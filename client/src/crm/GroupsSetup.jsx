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
import { useApi, Icon, Loading, ErrorBanner, Empty, Spinner, Modal, Tabs } from '../components/ui.jsx';

export default function GroupsSetup() {
  const [data, { loading, error, reload }] = useApi('/setup/groups');
  const [tree, { reload: reloadTree }] = useApi('/setup/org-tree');
  const [people] = useApi('/setup/users');
  const [making, setMaking] = useState(false);
  const [open, setOpen] = useState(null);
  const [problem, setProblem] = useState(null);
  const [view, setView] = useState('tree');

  if (loading && !data) return <Loading label="Loading groups…" />;
  if (error) return <ErrorBanner error={error} />;

  const groups = data?.groups ?? [];
  const users = people?.users ?? [];
  const refresh = () => { reload(); reloadTree(); };

  /* The tree draws lighter nodes — a member count rather than the people. The
     edit form wants the full group, so it is looked up here rather than the
     drawn node being passed through: one shape reaches the form from either
     view. Handing it the node is what threw "p.map is not a function". */
  const openFromTree = (node) => setOpen(groups.find((g) => g.id === node.id) ?? node);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between">
        <Tabs
          tabs={[{ id: 'tree', label: 'Org tree' }, { id: 'list', label: 'All groups' }]}
          active={view}
          onChange={setView}
        />
        <button className="btn btn-primary" onClick={() => setMaking(true)}>
          <Icon name="add" size={16} /> New group
        </button>
      </div>
      <span className="tiny muted">{view === 'tree' ? tree?.note : data?.note}</span>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      {view === 'tree' ? (
        <section className="card">
          <div className="card-body">
            {(tree?.roots ?? []).map((root) => (
              <div key={root.code} className="orgroot">
                <div className="orgnode is-root">
                  <span className="orgdot" style={{ background: root.accent }} />
                  <strong>{root.name}</strong>
                  <span className="tiny muted">business</span>
                </div>
                {root.children.length
                  ? <Branches nodes={root.children} onOpen={openFromTree} />
                  : <p className="tiny muted" style={{ marginLeft: 26 }}>No branches yet.</p>}
              </div>
            ))}
          </div>
        </section>
      ) : !groups.length ? (
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
          groups={groups}
          onClose={() => setMaking(false)}
          onSaved={() => { setMaking(false); refresh(); }}
          onError={setProblem}
        />
      )}
      {open && (
        <GroupForm
          group={open}
          users={users}
          groups={groups}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); refresh(); }}
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
function GroupForm({ group, users, groups, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: group?.name ?? '',
    description: group?.description ?? '',
    manager_id: group?.manager_id ?? '',
    parent_id: group?.parent_id ?? '',
  });

  /* Everything except this group. The server also refuses a parent inside this
     group's own branch, which cannot be worked out from here without walking
     the tree — so the dropdown is permissive and the refusal is specific. */
  const others = (groups ?? []).filter((g) => g.id !== group?.id && g.sales_org === (group?.sales_org ?? g.sales_org));
  /* An array, whatever arrives. Two screens hand this form a group and only
     one of them carries the people; a form that trusts the shape crashes on
     the other. */
  const [members, setMembers] = useState(Array.isArray(group?.members) ? group.members : []);
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
          const body = {
            ...form,
            manager_id: form.manager_id === '' ? null : Number(form.manager_id),
            parent_id: form.parent_id === '' ? null : Number(form.parent_id),
          };
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
          <label>Sits under</label>
          <select
            value={form.parent_id ?? ''}
            onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
          >
            <option value="">{group ? group.sales_org : 'The business'} — top level</option>
            {(others ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <p className="hint">Where this branch hangs in the org tree. The businesses are the roots.</p>
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

/**
 * One level of the tree, and the levels under it.
 *
 * Indentation rather than connector lines: the depth here is however deep
 * somebody makes it, and drawn lines that have to be right at every depth are a
 * lot of CSS to say what a left margin already says.
 */
function Branches({ nodes, onOpen, depth = 1 }) {
  return (
    <div className="orgbranch">
      {nodes.map((n) => (
        <div key={n.id}>
          <div className={`orgnode ${n.active ? '' : 'is-off'}`} role="button" tabIndex={0}
            onClick={() => onOpen(n)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(n); }}
          >
            <span className="orgdot" />
            <strong>{n.name}</strong>
            <span className="tiny muted">
              {n.manager_name ? n.manager_name : 'no manager'}
              {' · '}{n.member_count} member{n.member_count === 1 ? '' : 's'}
              {!n.active && ' · inactive'}
            </span>
          </div>
          {n.children.length > 0 && <Branches nodes={n.children} onOpen={onOpen} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}
