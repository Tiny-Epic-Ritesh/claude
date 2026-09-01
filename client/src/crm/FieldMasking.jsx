/**
 * Setup → Field masking (ENH-16).
 *
 * Which client identifiers each role sees in the clear.
 *
 * The distinction the note makes is the one that matters: masking is the
 * standing state for a role, while the unmask capability is an audited request
 * to reveal one record. Somebody reading this screen needs to know that turning
 * a cell on does not stop a privileged user seeing a number — it stops them
 * seeing every number without asking.
 */

import { useState } from 'react';
import { useDraft } from '../components/useDraft.js';
import PendingBar from '../components/PendingBar.jsx';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner } from '../components/ui.jsx';

export default function FieldMasking() {
  const [data, { loading, error, reload }] = useApi('/setup/field-masking');
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  const draft = useDraft(
    async (changes) => {
      for (const c of changes) {
        // eslint-disable-next-line no-await-in-loop
        await api.post('/setup/field-masking', { role: c.role, field: c.field, masked: c.value });
      }
      reload();
    },
    (c) => `${c.role}|${c.field}`,
  );

  if (loading && !data) return <Loading label="Loading masking settings…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  /* P2-06. Held as a draft rather than written per toggle.
   *
   * Q-07 named this screen exactly: a wrong masking rule affects everybody at
   * once and nobody notices for a week. Setting up a role means a dozen cells,
   * and a write per cell means a dozen chances to leave it half-applied. */
  const change = (role, field, masked) => draft.set({ role, field }, masked);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="notice notice-warn">
        <Icon name="info" size={17} />
        <span>{data.note}</span>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      <div className="card">
        <div className="card-head">
          <h2>Masked fields by role</h2>
          <span className="tiny muted">
            A filled cell means the role sees dots. Shift-click a set cell to reset it.
          </span>
        </div>

        <div className="card-body row wrap" style={{ gap: 12 }}>
          <span className="tiny muted"><span className="vis-key vis-off" /> Sees the value</span>
          <span className="tiny muted"><span className="vis-key vis-on" /> Masked</span>
          <span className="tiny muted"><span className="vis-key vis-set" /> Set by an administrator</span>
        </div>

        <div className="table-scroll">
          <table className="table matrix">
            <thead>
              <tr>
                <th className="matrix-corner">Field</th>
                {data.roles.map((r) => (
                  <th key={r.code} className="matrix-role" title={r.name}><span>{r.name}</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.fields.map((f) => (
                <tr key={f.field}>
                  <th scope="row" className="matrix-tab">
                    {f.label}
                    <div className="small muted mono">{f.field}</div>
                  </th>
                  {data.roles.map((r) => {
                    const stored = data.matrix.find((m) => m.role === r.code)?.fields[f.field]
                      ?? { masked: true, source: 'default' };
                    const key = `${r.code}|${f.field}`;
                    /* A pending change shows immediately, so the grid reads as
                       what it will be rather than what it was. */
                    const pending = draft.valueOf({ role: r.code, field: f.field }, undefined);
                    const cell = pending === undefined
                      ? stored
                      : { masked: pending, source: pending === null ? 'default' : 'configured' };
                    const set = cell.source === 'configured';
                    return (
                      <td key={r.code} className="matrix-cell">
                        <button
                          type="button"
                          disabled={draft.saving}
                          className={`vis ${cell.masked ? 'vis-on' : 'vis-off'} ${set ? 'vis-set' : ''}`}
                          aria-pressed={cell.masked}
                          aria-label={`${f.label} for ${r.name}: ${cell.masked ? 'masked' : 'visible'}${set ? ', set by an administrator' : ', shipped default'}`}
                          title={set ? 'Set by an administrator. Shift-click to reset.' : 'Shipped default'}
                          onClick={(e) => (set && e.shiftKey
                            ? change(r.code, f.field, null)
                            : change(r.code, f.field, !cell.masked))}
                        >
                          <Icon name={cell.masked ? 'visibility_off' : 'visibility'} size={14} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <PendingBar draft={draft} what="masking changes" />
    </div>
  );
}
