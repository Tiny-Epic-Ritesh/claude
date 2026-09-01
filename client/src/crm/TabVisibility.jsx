/**
 * Setup → Navigation (ENH-08).
 *
 * The role-to-tab matrix, editable. Role-level defaults with per-user
 * exceptions, which is the model that was confirmed.
 *
 * The notice at the top is not decoration. The most expensive mistake available
 * on this screen is an administrator hiding a tab and believing they have
 * restricted data — so the screen says, before anything else, that this is
 * navigation and the API enforces access separately.
 *
 * Cells show whether the answer came from the shipped default or from a
 * decision somebody made, because "why can they see this?" was the question the
 * legacy audit found nobody could answer.
 */

import { Fragment, useState } from 'react';
import { useDraft } from '../components/useDraft.js';
import PendingBar from '../components/PendingBar.jsx';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty } from '../components/ui.jsx';

/* What each row of the grid actually is. Three mechanisms share one table
   because they share one storage shape, not because they are one thing. */
const KIND_LABEL = {
  tab: 'CRM tabs',
  feature: 'Features',
  setup: 'Setup screens',
};

export default function TabVisibility() {
  const [data, { loading, error, reload }] = useApi('/setup/tab-visibility');
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const [person, setPerson] = useState(null);

  const draft = useDraft(
    async (changes) => {
      for (const c of changes) {
        // eslint-disable-next-line no-await-in-loop
        await api.post('/setup/tab-visibility/role', { role: c.role, tab_id: c.tabId, visible: c.value });
      }
      reload();
    },
    (c) => `${c.role}|${c.tabId}`,
  );

  if (loading && !data) return <Loading label="Loading navigation settings…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  /* P2-06. Held as a draft rather than written per toggle.
   *
   * Hiding a tab from a role is invisible to the administrator doing it and
   * very visible to the eleven people who lose it. Setting up a role means a
   * dozen cells, and a write per cell is a dozen chances to leave it half
   * applied. `null` means "back to the shipped default". */
  const toggle = (role, tabId, current) => draft.set({ role, tabId }, !current);
  const reset = (role, tabId) => draft.set({ role, tabId }, null);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="notice notice-warn">
        <Icon name="info" size={17} />
        <span>{data.note}</span>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      <div className="card">
        <div className="card-head">
          <h2>Tabs by role</h2>
          <span className="tiny muted">
            {data.roles.length} roles · {data.tabs.length} tabs
            {data.user_overrides > 0 && ` · ${data.user_overrides} person-level exception${data.user_overrides === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className="card-body stack" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 12 }}>
            <span className="tiny muted"><span className="vis-key vis-on" /> Visible</span>
            <span className="tiny muted"><span className="vis-key vis-off" /> Hidden</span>
            <span className="tiny muted"><span className="vis-key vis-set" /> Set by an administrator — click again to reset to the default</span>
          </div>
        </div>

        <div className="table-scroll">
          <table className="table matrix">
            <thead>
              <tr>
                <th className="matrix-corner">Tab</th>
                {data.roles.map((r) => (
                  <th key={r.code} className="matrix-role" title={r.name}>
                    <span>{r.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tabs.map((t, i) => (
                <Fragment key={t.id}>
                {/* Three kinds ride this one grid: CRM tabs, the banner
                    features that use the same mechanism, and the Setup screens.
                    Without a heading between them "Users" the Setup screen sits
                    beside "Leads" the CRM tab and reads as the same kind of
                    thing. */}
                {t.kind !== data.tabs[i - 1]?.kind && (
                  <tr className="matrix-section">
                    <th scope="row" colSpan={data.roles.length + 1}>{KIND_LABEL[t.kind] ?? t.kind}</th>
                  </tr>
                )}
                <tr>
                  <th scope="row" className="matrix-tab">
                    <Icon name={t.icon} size={15} /> {t.label}
                  </th>
                  {data.roles.map((r) => {
                    const stored = data.matrix.find((m) => m.role === r.code)?.tabs[t.id]
                      ?? { visible: false, source: 'default' };
                    const key = `${r.code}|${t.id}`;
                    /* A pending change shows immediately, so the grid reads as
                       what it will be rather than what it was. */
                    const pending = draft.valueOf({ role: r.code, tabId: t.id }, undefined);
                    const cell = pending === undefined
                      ? stored
                      : { visible: pending === null ? stored.visible : pending,
                          source: pending === null ? 'default' : 'role' };
                    const set = cell.source === 'role';
                    return (
                      <td key={r.code} className="matrix-cell">
                        <button
                          type="button"
                          disabled={draft.saving}
                          className={`vis ${cell.visible ? 'vis-on' : 'vis-off'} ${set ? 'vis-set' : ''}`}
                          aria-pressed={cell.visible}
                          aria-label={`${t.label} for ${r.name}: ${cell.visible ? 'visible' : 'hidden'}${set ? ', set by an administrator' : ', shipped default'}`}
                          title={set
                            ? `Set by an administrator. Shift-click to reset to the default.`
                            : 'Shipped default'}
                          onClick={(e) => (set && e.shiftKey
                            ? reset(r.code, t.id)
                            : toggle(r.code, t.id, cell.visible))}
                        >
                          <Icon name={cell.visible ? 'check' : 'remove'} size={14} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <PersonOverrides person={person} onPick={setPerson} />

      {/* The save bar belongs to the role grid above, which is the only thing
          on this screen held as a draft — PersonOverrides writes immediately.
          It had been placed inside PersonOverrides instead, where `draft` is
          not in scope, so rendering this screen threw a ReferenceError and took
          the whole page down with it. */}
      <PendingBar draft={draft} what="navigation changes" />
    </div>
  );
}

/**
 * Per-user exceptions.
 *
 * Kept separate from the grid because they are rare and consequential: an
 * exception is a decision about one person that survives changes to their role,
 * and it should not be as easy to make by accident as flipping a role cell.
 */
function PersonOverrides({ person, onPick }) {
  const [users] = useApi('/setup/users');
  const [detail, { loading, reload }] = useApi(person ? `/setup/users/${person}/tabs` : null, [person]);
  const [problem, setProblem] = useState(null);

  const list = Array.isArray(users) ? users : users?.users ?? users?.rows ?? [];

  const set = async (tabId, visible) => {
    setProblem(null);
    try { await api.post(`/setup/users/${person}/tabs`, { tab_id: tabId, visible }); reload(); }
    catch (e) { setProblem(e.message); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Exceptions for one person</h2>
        <span className="tiny muted">Overrides the role default for this user only</span>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="field" style={{ maxWidth: 340 }}>
          <label htmlFor="ovr-user">User</label>
          <select id="ovr-user" value={person ?? ''} onChange={(e) => onPick(e.target.value || null)}>
            <option value="">Choose a user…</option>
            {list.filter((u) => u.active).map((u) => (
              <option key={u.id} value={u.id}>{u.name} — {u.role}</option>
            ))}
          </select>
        </div>

        <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

        {!person && <Empty>Choose a user to give them a tab their role does not have, or take one away.</Empty>}
        {person && loading && <Loading label="Loading…" />}

        {person && detail && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Tab</th><th>Their role</th><th>This person</th><th /></tr>
              </thead>
              <tbody>
                {detail.tabs.map((t) => (
                  <tr key={t.id}>
                    <td><Icon name={t.icon} size={15} /> {t.label}</td>
                    <td className="muted">{t.role_default ? 'Visible' : 'Hidden'}</td>
                    <td>
                      <span className={`badge ${t.visible ? 'badge-green' : ''}`}>
                        {t.visible ? 'Visible' : 'Hidden'}
                      </span>
                      {t.overridden && <span className="badge badge-amber" style={{ marginLeft: 6 }}>Exception</span>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn-sm" onClick={() => set(t.id, !t.visible)}>
                          {t.visible ? 'Hide' : 'Show'}
                        </button>
                        {t.overridden && (
                          <button className="btn-ghost btn-sm" onClick={() => set(t.id, null)}
                            title="Remove the exception and follow the role again">
                            Reset
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
