/**
 * Setup → Users.
 *
 * The old screen was one table of every user in role order, with no search, no
 * filter, and no indication of whether anybody was still active. On 28 seeded
 * users that reads as tidy. On the 83 this replaces — and on the 495,118 leads
 * they own between them — it is a wall.
 *
 * Three things it now answers that it could not:
 *
 *   Who is this?          search by name, email or employee code
 *   Who are these?        filter by role, business and status
 *   Is this one still on?  a deactivated user looked exactly like an active one
 *
 * The last was the real defect. One of the seeded users is deactivated and the
 * screen drew them identically to everybody else, so "why can they not sign in"
 * had no answer visible anywhere on the page that manages signing in.
 *
 * WHY THE FILTERS ARE CHIPS AND NOT A DROPDOWN
 * Every filter shows its own count. An administrator asking "how many Callers
 * do we have" gets the answer without applying anything, and a filter that
 * would return nothing says so before it is clicked rather than after.
 */

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ROLE_LABEL } from '../api.js';
import { useApi, Icon, ErrorBanner, Empty, Spinner } from '../components/ui.jsx';
import SetupSkeleton from '../setup/SetupSkeleton.jsx';
import { UserActions, ResetLink, NewUser } from './admin/users.jsx';
import { ExportUsers, RequiredFields } from './admin/UserExport.jsx';

/** The primary action, rendered into the shell's header slot. */
function HeaderAction({ children }) {
  const slot = document.getElementById('setup-actions');
  return slot ? createPortal(children, slot) : children;
}

const ORG_LABEL = { BONANZA: 'Bonanza', BIGUL: 'Bigul' };

export default function UsersSetup() {
  const [users, { loading, error, reload }] = useApi('/admin/users');
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [requiring, setRequiring] = useState(false);
  const [link, setLink] = useState(null);
  const [problem, setProblem] = useState(null);

  const [query, setQuery] = useState('');
  const [role, setRole] = useState(null);
  const [org, setOrg] = useState(null);
  const [status, setStatus] = useState('active');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(users) ? users : [];

  /* Counts come from the whole list, not the filtered one, so a chip says how
     many there are rather than how many survive the filters already applied. */
  const counts = useMemo(() => {
    const roles = new Map();
    const orgs = new Map();
    let active = 0;
    for (const u of list) {
      roles.set(u.role, (roles.get(u.role) ?? 0) + 1);
      if (u.sales_org) orgs.set(u.sales_org, (orgs.get(u.sales_org) ?? 0) + 1);
      if (u.active) active += 1;
    }
    return { roles, orgs, active, inactive: list.length - active };
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((u) => {
      if (status === 'active' && !u.active) return false;
      if (status === 'inactive' && u.active) return false;
      if (role && u.role !== role) return false;
      if (org && u.sales_org !== org) return false;
      if (!q) return true;
      return [u.name, u.email, u.employee_code, u.branch]
        .some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [list, query, role, org, status]);

  if (loading) return <SetupSkeleton rows={8} />;
  if (error) return <ErrorBanner error={error} />;

  const toggle = (id) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const shownIds = shown.map((u) => u.id);
  const allShownPicked = shownIds.length > 0 && shownIds.every((id) => picked.has(id));

  /* Applied one at a time on purpose. Each user is a separate audited decision
     with its own refusal — deactivating somebody holding open leads is refused
     by the server unless it is acknowledged, and a bulk call would either lose
     that or apply it to everybody at once. */
  const setActive = async (active) => {
    setBusy(true);
    setProblem(null);
    const failed = [];
    for (const id of picked) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await api.post(`/setup/users/${id}/active`, { active, acknowledge: true });
      } catch (err) {
        failed.push(`${list.find((u) => u.id === id)?.name ?? id}: ${err.message}`);
      }
    }
    setBusy(false);
    setPicked(new Set());
    if (failed.length) setProblem(`${failed.length} could not be changed — ${failed[0]}`);
    reload();
  };

  const chip = (label, count, on, onClick) => (
    <button
      key={label}
      type="button"
      className={`filter-chip${on ? ' is-on' : ''}`}
      onClick={onClick}
      aria-pressed={on}
      disabled={count === 0 && !on}
    >
      {label}
      <span className="filter-count">{count}</span>
    </button>
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <HeaderAction>
        <button type="button" className="btn" onClick={() => setRequiring(true)}>
          <Icon name="rule" size={16} /> Required fields
        </button>
        <button type="button" className="btn" onClick={() => setExporting(true)}>
          <Icon name="download" size={16} /> Export
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="add" size={16} /> Create user
        </button>
      </HeaderAction>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {link && <ResetLink issued={link} onClose={() => setLink(null)} />}

      <div className="filter-bar">
        <div className="filter-search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, employee code"
            aria-label="Search users"
          />
          {query && (
            <button type="button" className="filter-clear" onClick={() => setQuery('')} aria-label="Clear search">
              <Icon name="close" size={15} />
            </button>
          )}
        </div>

        <div className="filter-row">
          {chip('Active', counts.active, status === 'active', () => setStatus(status === 'active' ? 'all' : 'active'))}
          {chip('Deactivated', counts.inactive, status === 'inactive', () => setStatus(status === 'inactive' ? 'all' : 'inactive'))}
          {counts.orgs.size > 1 && [...counts.orgs].map(([code, n]) => (
            chip(ORG_LABEL[code] ?? code, n, org === code, () => setOrg(org === code ? null : code))
          ))}
        </div>

        <div className="filter-row">
          {[...counts.roles]
            .sort((a, b) => b[1] - a[1])
            .map(([code, n]) => chip(ROLE_LABEL[code] ?? code, n, role === code, () => setRole(role === code ? null : code)))}
        </div>
      </div>

      {picked.size > 0 && (
        /* Appears only when something is selected, and says exactly how many it
           will act on. A bulk bar that is always present is a bulk action
           waiting to be clicked by accident. */
        <div className="bulk-bar">
          <strong>{picked.size} selected</strong>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setActive(true)}>
            {busy ? <Spinner /> : 'Activate'}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setActive(false)}>
            {busy ? <Spinner /> : 'Deactivate'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>
            {shown.length === list.length
              ? `${list.length} users`
              : `${shown.length} of ${list.length} users`}
          </h2>
          {(query || role || org || status !== 'active') && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => { setQuery(''); setRole(null); setOrg(null); setStatus('active'); }}
            >
              Reset filters
            </button>
          )}
        </div>

        {shown.length === 0 ? (
          <div className="setup-empty">
            <Icon name="search" size={30} />
            <strong>No user matches that</strong>
            <p>
              {query ? `Nothing matches “${query}”.` : 'No user matches these filters.'}
              {status === 'active' && counts.inactive > 0 && ' Deactivated users are hidden — try that filter.'}
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th className="pick-col">
                    <input
                      type="checkbox"
                      checked={allShownPicked}
                      onChange={() => setPicked(allShownPicked ? new Set() : new Set(shownIds))}
                      aria-label="Select every user shown"
                    />
                  </th>
                  <th>User</th>
                  <th>Role</th>
                  <th>Business</th>
                  <th>Reports to</th>
                  <th className="num">Leads</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id} className={u.active ? '' : 'row-inactive'}>
                    <td className="pick-col">
                      <input
                        type="checkbox"
                        checked={picked.has(u.id)}
                        onChange={() => toggle(u.id)}
                        aria-label={`Select ${u.name}`}
                      />
                    </td>
                    <td>
                      <div className="user-cell">
                        <strong>{u.name}</strong>
                        {/* The thing the old screen never showed. */}
                        {!u.active && <span className="chip chip-muted">Deactivated</span>}
                      </div>
                      <span className="tiny muted">{u.email}</span>
                    </td>
                    <td><span className="badge badge-blue">{ROLE_LABEL[u.role] || u.role}</span></td>
                    <td className="small muted">
                      {ORG_LABEL[u.sales_org] ?? u.sales_org ?? '—'}
                      {u.product_name && <span className="tiny muted"> · {u.product_name}</span>}
                    </td>
                    <td className="small muted">{u.manager_name || '—'}</td>
                    <td className="num">{u.lead_count}</td>
                    <td className="num">
                      <UserActions user={u} reload={reload} onLink={setLink} onError={setProblem} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {creating && <NewUser onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />}
      {exporting && <ExportUsers onClose={() => setExporting(false)} />}
      {/* Reloaded on close: making a field required changes what the create
          form marks, and the form reads that list when it opens. */}
      {requiring && <RequiredFields onClose={() => { setRequiring(false); reload(); }} />}
    </div>
  );
}
