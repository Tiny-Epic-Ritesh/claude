/**
 * Roles and permissions, editable (P2-05).
 *
 * The write API has existed since the access model was built: create, edit,
 * clone, retire, all permission-gated and audited. What did not exist was a
 * screen that called any of it — Setup rendered a permission matrix of dots
 * you could read and not change, so "roles are not editable" was true of the
 * product while being false of the server.
 *
 * WHAT IS EDITABLE, AND WHY THE LIMITS ARE WHERE THEY ARE
 *
 * Object and field level are set here. Record level is not, because it is
 * already decided by `data_scope` — own / team / product / org — which
 * leadScope() and clientScope() read on every query. Offering a second place
 * to express record visibility would be the LeadSquared mistake exactly:
 * one question, two mechanisms, and no way to answer "why can this person see
 * that record" without checking both.
 *
 * A system role can be renamed and re-granted but never deleted and never
 * deactivated. Its code is referenced by seeded configuration and by the
 * defaults in engine/access.js, so deleting `sales_rm` breaks things weeks
 * later in ways nobody connects back to this screen. Cloning is offered
 * instead, which is what people actually want when they reach for delete.
 */

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Modal, Spinner, Empty } from '../components/ui.jsx';
import { Roles as PermissionMatrix } from './Admin.jsx';

const SCOPES = [
  { value: 'own', label: 'Own records', hint: 'Only what they own' },
  { value: 'team', label: "Their team's", hint: 'Their own and their reports’' },
  { value: 'product', label: 'By product', hint: 'Records carrying their product' },
  { value: 'org', label: 'Whole business', hint: 'Everything in their book' },
];

export default function RolesSetup() {
  const [roles, { loading, error, reload }] = useApi('/setup/roles');
  const [caps] = useApi('/setup/capabilities');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(null);
  const [problem, setProblem] = useState(null);

  /* Keep the open role in step with a reload, or saving shows the values that
     were on screen before the save rather than the ones that were stored. */
  useEffect(() => {
    if (!selected || !roles) return;
    const fresh = roles.find((r) => r.code === selected.code);
    if (fresh && fresh !== selected) setSelected(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  if (loading || !roles || !caps) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <section className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between">
          <span><Icon name="check_circle" size={16} /> {notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>{roles.length} roles</h2>
            <span className="tiny muted">
              Enforced at the API on every request, not hidden in the interface
            </span>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Icon name="add" size={15} /> New role
          </button>
        </div>

        <table>
          <thead>
            <tr>
              <th>Role</th><th>Sees</th><th className="num">Permissions</th>
              <th className="num">People</th><th />
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.code}>
                <td>
                  <div style={{ fontWeight: 570 }}>
                    {r.name}
                    {Boolean(r.is_system) && <span className="badge" style={{ marginLeft: 6 }}>System</span>}
                    {!r.active && <span className="badge badge-amber" style={{ marginLeft: 6 }}>Retired</span>}
                  </div>
                  <div className="tiny muted api-name">{r.code}</div>
                </td>
                <td className="small">
                  {SCOPES.find((s) => s.value === r.data_scope)?.label ?? r.data_scope}
                </td>
                <td className="num">{r.capabilities.length}</td>
                <td className="num">{r.user_count}</td>
                <td className="num">
                  <button className="btn-sm" onClick={() => setSelected(r)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The whole grid, underneath. Editing is one role at a time; "who can
          do X" is every role at once, and an auditor only ever asks the
          second. */}
      <PermissionMatrix />

      {selected && (
        <RoleEditor
          role={selected}
          caps={caps}
          roles={roles}
          onClose={() => setSelected(null)}
          onSaved={(msg) => { setSelected(null); setNotice(msg); reload(); }}
          onError={setProblem}
        />
      )}

      {creating && (
        <NewRole
          roles={roles}
          onClose={() => setCreating(false)}
          onSaved={(msg) => { setCreating(false); setNotice(msg); reload(); }}
          onError={setProblem}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------- editing */

function RoleEditor({ role, caps, roles, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: role.name,
    description: role.description ?? '',
    data_scope: role.data_scope,
  });
  const [granted, setGranted] = useState(new Set(role.capabilities));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (code) => setGranted((g) => {
    const next = new Set(g);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const dirty = form.name !== role.name
    || (form.description ?? '') !== (role.description ?? '')
    || form.data_scope !== role.data_scope
    || granted.size !== role.capabilities.length
    || role.capabilities.some((c) => !granted.has(c));

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/setup/roles/${role.code}`, { ...form, capabilities: [...granted] });
      onSaved(`${form.name} saved.`);
    } catch (err) {
      // The server refuses a change that would lock the administrator out of
      // role management. That refusal is the useful part, so it is shown as-is.
      onError(err.message);
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/setup/roles/${role.code}`);
      onSaved(`${role.name} removed.`);
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal
      title={role.name}
      subtitle={`${role.code}${role.is_system ? ' · system role' : ''} · ${role.user_count} ${role.user_count === 1 ? 'person' : 'people'}`}
      onClose={onClose}
      wide
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <label>
            <span>Name</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />
          </label>
          <label>
            <span>Code</span>
            {/* Frozen, including on a system role. Seeded configuration and the
                access-model defaults reference these strings; renaming one is a
                migration, not an edit. */}
            <input value={role.code} disabled />
            <span className="tiny muted">Referenced by configuration — cannot be changed</span>
          </label>
        </div>

        <label>
          <span>Description</span>
          <input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="What this role is for"
          />
        </label>

        <div className="field">
          <span className="field-label">Which records they can see</span>
          <div className="scope-options">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`scope-opt ${form.data_scope === s.value ? 'is-on' : ''}`}
                onClick={() => set('data_scope', s.value)}
              >
                <strong>{s.label}</strong>
                <em>{s.hint}</em>
              </button>
            ))}
          </div>
          <span className="tiny muted">
            Record visibility is decided here and nowhere else — every lead and client
            query reads it. The permissions below say what may be done, not what may be seen.
          </span>
        </div>

        <CapabilityPicker caps={caps} granted={granted} onToggle={toggle} />

        <div className="modal-actions">
          {!role.is_system && !confirmDelete && (
            <button className="btn-ghost btn-sm is-danger" onClick={() => setConfirmDelete(true)}>
              Delete role
            </button>
          )}
          {confirmDelete && (
            <span className="row" style={{ gap: 8 }}>
              <span className="tiny">Delete {role.name}?</span>
              <button className="btn-sm is-danger" disabled={busy} onClick={remove}>Yes, delete</button>
              <button className="btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>No</button>
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>
            {dirty ? 'Discard changes' : 'Close'}
          </button>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>
            {busy ? <Spinner /> : 'Save changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ creating */

function NewRole({ roles, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: '', code: '', description: '', data_scope: 'own', clone_from: '',
  });
  const [busy, setBusy] = useState(false);
  /* Whether the code has been typed into directly. Tracked separately from its
     value: keying off `code` being non-empty would freeze the suggestion at the
     first character, because after typing "R" the code is already "r". */
  const [codeEdited, setCodeEdited] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const slug = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  /* Suggest the code from the name rather than asking twice — until somebody
     types their own, after which the name stops overwriting it. */
  const onName = (v) => setForm((f) => ({
    ...f,
    name: v,
    code: codeEdited ? f.code : slug(v),
  }));
  const onCode = (v) => { setCodeEdited(true); set('code', slug(v)); };

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/setup/roles', {
        ...form,
        clone_from: form.clone_from || undefined,
        code: form.code,
      });
      onSaved(`${r.name} created. Open it to adjust what it can do.`);
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="New role" subtitle="Start from an existing one and adjust" onClose={onClose}>
      <div className="stack" style={{ gap: 13 }}>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <label>
            <span>Name</span>
            <input value={form.name} onChange={(e) => onName(e.target.value)} placeholder="Regional Supervisor" />
          </label>
          <label>
            <span>Code</span>
            <input
              value={form.code}
              onChange={(e) => onCode(e.target.value)}
              placeholder="regional_supervisor"
            />
            <span className="tiny muted">Lowercase, digits and underscores. Permanent.</span>
          </label>
        </div>

        <label>
          <span>Description</span>
          <input value={form.description} onChange={(e) => set('description', e.target.value)} />
        </label>

        <label>
          <span>Copy permissions from</span>
          <select value={form.clone_from} onChange={(e) => set('clone_from', e.target.value)}>
            <option value="">Start with none</option>
            {roles.map((r) => (
              <option key={r.code} value={r.code}>{r.name} ({r.capabilities.length})</option>
            ))}
          </select>
          {/* Cloning is how this is actually done: start from the nearest
              existing persona and adjust, rather than tick forty boxes from
              empty and discover the two that were missed a fortnight later. */}
          <span className="tiny muted">Then adjust — nothing is shared with the role you copied.</span>
        </label>

        <label>
          <span>Which records they can see</span>
          <select value={form.data_scope} onChange={(e) => set('data_scope', e.target.value)}>
            {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>)}
          </select>
        </label>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !form.name.trim() || !form.code.trim()}
            onClick={create}
          >
            {busy ? <Spinner /> : 'Create role'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- capabilities */

function CapabilityPicker({ caps, granted, onToggle }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();

  const categories = (caps.categories ?? [])
    .map((c) => ({
      ...c,
      capabilities: c.capabilities.filter(
        (cap) => !q || cap.code.toLowerCase().includes(q) || (cap.label ?? '').toLowerCase().includes(q),
      ),
    }))
    .filter((c) => c.capabilities.length);

  return (
    <div className="field">
      <div className="row-between" style={{ alignItems: 'baseline' }}>
        <span className="field-label" style={{ margin: 0 }}>
          What they can do <span className="muted">({granted.size} of {caps.total})</span>
        </span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter permissions…"
          style={{ width: 200 }}
        />
      </div>

      {!categories.length && <Empty>No permission matches “{filter}”.</Empty>}

      <div className="cap-groups">
        {categories.map((c) => {
          const all_ = c.capabilities.map((x) => x.code);
          const on = all_.filter((x) => granted.has(x)).length;
          return (
            <div key={c.category} className="cap-group">
              <div className="cap-group-head">
                <span>{c.category}</span>
                <span className="tiny muted">{on}/{all_.length}</span>
              </div>
              {c.capabilities.map((cap) => (
                <label key={cap.code} className="cap-row">
                  <input
                    type="checkbox"
                    checked={granted.has(cap.code)}
                    onChange={() => onToggle(cap.code)}
                  />
                  <span>
                    <strong>
                      {cap.label ?? cap.code}
                      {/* The capability table has always carried this flag and
                          nothing ever showed it. Granting "view PAN" or
                          "export clients" should not look the same as granting
                          "view own leads" to the person doing the granting. */}
                      {Boolean(cap.sensitive) && (
                        <span className="badge badge-amber" style={{ marginLeft: 6 }}>Sensitive</span>
                      )}
                    </strong>
                    {/* Both identifiers, always. The label is what an
                        administrator recognises; the code is what appears in a
                        refusal message and in the audit log, and somebody
                        reading either needs to find it here. */}
                    <em className="api-name">{cap.code}</em>
                    {cap.description && <span className="tiny muted">{cap.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
