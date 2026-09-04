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

      <AddField
        strategies={data.strategies ?? []}
        onAdded={reload}
        onError={setProblem}
      />

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
                    {f.custom && (
                      /* Only the added ones. The seven that ship are masked by
                         design and the server refuses to remove them, so
                         offering the control here would be a button that
                         explains itself only after being pressed. */
                      <button
                        type="button"
                        className="btn-sm btn-quiet"
                        disabled={busy === f.field}
                        onClick={async () => {
                          setBusy(f.field);
                          setProblem(null);
                          try {
                            await api.del(`/setup/field-masking/fields/${f.field}`);
                            reload();
                          } catch (err) { setProblem(err.message); }
                          finally { setBusy(null); }
                        }}
                      >
                        Remove
                      </button>
                    )}
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

/**
 * Add a field to the maskable set (P3-11).
 *
 * The strategy is asked for rather than inferred. A field name says nothing
 * about the shape of what it holds, and the difference matters: showing the
 * last four characters of an account number is a courtesy, and showing the last
 * four of a date of birth is most of it.
 */
function AddField({ strategies, onAdded, onError }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ field: '', label: '', strategy: 'last4' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  if (!open) {
    return (
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn-sm" onClick={() => setOpen(true)}>
          <Icon name="add" size={15} /> Add a field
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Add a field to mask</h2>
        <span className="tiny muted">
          The field is masked everywhere it appears — on screen, in exports and in the API.
        </span>
      </div>
      <form
        className="card-body stack"
        style={{ gap: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          onError(null);
          try {
            await api.post('/setup/field-masking/fields', form);
            setForm({ field: '', label: '', strategy: 'last4' });
            setOpen(false);
            onAdded();
          } catch (err) { onError(err.message); }
          finally { setBusy(false); }
        }}
      >
        <div className="field-row">
          <div className="field">
            <label>Field name</label>
            <input
              value={form.field}
              onChange={set('field')}
              placeholder="date_of_birth"
              required
              autoFocus
            />
            <p className="hint">As the field is named in the record, not its heading.</p>
          </div>
          <div className="field">
            <label>Label</label>
            <input value={form.label} onChange={set('label')} placeholder="Date of birth" />
            <p className="hint">What this screen calls it. Defaults to the field name.</p>
          </div>
        </div>

        <div className="field">
          <label>How to mask it</label>
          {/* Not set('...') like the others: the icon-subset scanner reads any
              quoted vocabulary word as a glyph name, and this one collides. */}
          <select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
            {strategies.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => { setOpen(false); onError(null); }}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add field'}</button>
        </div>
      </form>
    </div>
  );
}
