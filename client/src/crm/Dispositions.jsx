/**
 * Setup → Call outcomes (ENH-21c).
 *
 * These are not labels. Each one decides what the follow-up engine does after a
 * call is logged — whether a date is compulsory, whether a reason is, whether
 * the product card moves, whether marketing is suppressed. So the obligations
 * sit beside the label rather than behind an "Advanced" disclosure: an
 * administrator renaming something should be able to see, without clicking,
 * that they are looking at the row which creates every callback in the system.
 *
 * Rows the business has edited are marked. The seeder skips those on boot, so
 * a change made here survives a deploy.
 */

import { useState } from 'react';
import { api, dateTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Modal } from '../components/ui.jsx';

const OUTCOME_BADGE = {
  Connected: 'badge-green',
  'Not Connected': 'badge-amber',
  Other: '',
};

export default function Dispositions() {
  const [data, { loading, error, reload }] = useApi('/setup/dispositions');
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState(null);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState(null);

  if (loading && !data) return <Loading label="Loading call outcomes…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  const retire = async (d) => {
    setProblem(null); setDone(null);
    try {
      const r = await api.del(`/setup/dispositions/${d.id}`);
      // The server says how many logged activities still reference it. That is
      // the answer to "did I just break my history?", so it gets shown rather
      // than swallowed.
      setDone(`"${d.label}" retired. ${r.note ?? ''}`.trim());
      reload();
    } catch (e) { setProblem(e.message); }
  };

  const byType = new Map();
  for (const d of data.dispositions) {
    if (!byType.has(d.activity_type)) byType.set(d.activity_type, []);
    byType.get(d.activity_type).push(d);
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="notice notice-warn">
        <Icon name="info" size={17} />
        <span>{data.note}</span>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {done && (
        <div className="notice notice-ok">
          <Icon name="check_circle" size={17} /> <span>{done}</span>
        </div>
      )}

      <div className="row-between wrap" style={{ gap: 10 }}>
        <span className="tiny muted">
          {data.dispositions.filter((d) => d.active).length} in use
          {' · '}
          {data.dispositions.filter((d) => d.edited_at).length} edited by your team
        </span>
        <button className="btn-primary btn-sm" onClick={() => setCreating(true)}>
          <Icon name="add" size={15} /> New outcome
        </button>
      </div>

      {[...byType].map(([type, rows]) => (
        <div key={type} className="card">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>{type}</h2>
            <span className="tiny muted">{rows.filter((r) => r.active).length} active</span>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>What it obliges</th>
                  <th>Effect on the record</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className={d.active ? '' : 'is-retired'}>
                    <td>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <span className={`badge ${OUTCOME_BADGE[d.outcome] ?? ''}`}>{d.outcome}</span>
                        <strong>{d.label}</strong>
                        {d.is_custom ? <span className="badge badge-blue">Yours</span> : null}
                        {d.edited_at && !d.is_custom
                          ? <span className="badge badge-amber" title={`Edited ${dateTime(d.edited_at)}`}>Edited</span>
                          : null}
                        {!d.active ? <span className="badge">Retired</span> : null}
                      </div>
                      <div className="small muted mono">{d.code}</div>
                      {d.hint && <div className="small muted">{d.hint}</div>}
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {d.requires_datetime ? <span className="badge badge-amber">Date &amp; time</span> : null}
                        {d.requires_reason ? <span className="badge badge-amber">A reason</span> : null}
                        {d.next_step && d.next_step !== 'none'
                          ? <span className="badge">{d.next_step.replace('_', ' ')}</span> : null}
                        {d.follow_up_hours
                          ? <span className="tiny muted">retry in {d.follow_up_hours}h</span> : null}
                        {!d.requires_datetime && !d.requires_reason
                          && (!d.next_step || d.next_step === 'none')
                          && <span className="tiny muted">nothing</span>}
                      </div>
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {d.sets_card_state ? <span className="badge badge-blue">card → {d.sets_card_state}</span> : null}
                        {d.flags_mobile_invalid ? <span className="badge badge-red">flags bad number</span> : null}
                        {d.suppress_marketing ? <span className="badge badge-red">suppresses marketing</span> : null}
                        {d.score_delta ? <span className="badge">{d.score_delta > 0 ? '+' : ''}{d.score_delta} score</span> : null}
                        {!d.sets_card_state && !d.flags_mobile_invalid
                          && !d.suppress_marketing && !d.score_delta
                          && <span className="tiny muted">none</span>}
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn-sm" onClick={() => setEditing(d)}>Edit</button>
                        {d.active && (
                          <button className="btn-ghost btn-sm" onClick={() => retire(d)}
                            title="Take it out of the picker. Activities already logged keep it.">
                            Retire
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {editing && (
        <EditOutcome d={editing} meta={data}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onError={(m) => { setEditing(null); setProblem(m); }} />
      )}
      {creating && (
        <NewOutcome meta={data}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }}
          onError={(m) => { setCreating(false); setProblem(m); }} />
      )}
    </div>
  );
}

function EditOutcome({ d, meta, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    label: d.label, hint: d.hint ?? '', outcome: d.outcome,
    next_step: d.next_step ?? 'none',
    follow_up_hours: d.follow_up_hours ?? '',
    requires_datetime: !!d.requires_datetime,
    requires_reason: !!d.requires_reason,
    sets_card_state: d.sets_card_state ?? '',
    score_delta: d.score_delta ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/setup/dispositions/${d.id}`, {
        ...form,
        follow_up_hours: form.follow_up_hours === '' ? null : Number(form.follow_up_hours),
        sets_card_state: form.sets_card_state || null,
        score_delta: Number(form.score_delta) || 0,
      });
      onSaved();
    } catch (err) { onError(err.message); }
  };

  return (
    <Modal title={d.label} subtitle={d.code} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 13 }}>
        <div className="field">
          <label htmlFor="d-label">Label</label>
          <input id="d-label" value={form.label} onChange={(e) => set('label', e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="d-outcome">Group</label>
          <select id="d-outcome" value={form.outcome} onChange={(e) => set('outcome', e.target.value)}>
            {meta.outcomes.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className="tiny muted">Connected and Not Connected are the first choice an RM makes.</span>
        </div>

        <div className="field">
          <label htmlFor="d-hint">Hint</label>
          <input id="d-hint" value={form.hint} onChange={(e) => set('hint', e.target.value)}
            placeholder="Shown under the option when someone is choosing" />
        </div>

        <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">What it obliges the RM to do</legend>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={form.requires_datetime}
              onChange={(e) => set('requires_datetime', e.target.checked)} />
            <span>Must pick a date and time</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={form.requires_reason}
              onChange={(e) => set('requires_reason', e.target.checked)} />
            <span>Must give a reason</span>
          </label>
        </fieldset>

        <div className="field">
          <label htmlFor="d-next">Next step</label>
          <select id="d-next" value={form.next_step} onChange={(e) => set('next_step', e.target.value)}>
            {meta.next_steps.map((n) => <option key={n} value={n}>{n.replace('_', ' ')}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="d-hours">Automatic retry, in hours</label>
          <input id="d-hours" type="number" min="0" step="0.5" value={form.follow_up_hours}
            onChange={(e) => set('follow_up_hours', e.target.value)}
            placeholder="Leave blank for none" />
        </div>

        <div className="field">
          <label htmlFor="d-card">Move the product card to</label>
          <select id="d-card" value={form.sets_card_state} onChange={(e) => set('sets_card_state', e.target.value)}>
            <option value="">Leave it alone</option>
            {meta.card_states.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="d-score">Score change</label>
          <input id="d-score" type="number" value={form.score_delta}
            onChange={(e) => set('score_delta', e.target.value)} />
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !form.label.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewOutcome({ meta, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    code: '', label: '', activity_type: meta.activity_types[0] ?? 'Call',
    outcome: meta.outcomes[0] ?? 'Connected', requires_datetime: false, requires_reason: false,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try { await api.post('/setup/dispositions', form); onSaved(); }
    catch (err) { onError(err.message); }
  };

  return (
    <Modal title="New call outcome" onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 13 }}>
        <div className="field">
          <label htmlFor="n-label">Label</label>
          <input id="n-label" autoFocus value={form.label}
            onChange={(e) => {
              set('label', e.target.value);
              // A code nobody has to invent is a code nobody gets wrong.
              if (!form.code || form.code === slug(form.label)) set('code', slug(e.target.value));
            }} />
        </div>
        <div className="field">
          <label htmlFor="n-code">Code</label>
          <input id="n-code" className="mono" value={form.code}
            onChange={(e) => set('code', e.target.value.toUpperCase())} />
          <span className="tiny muted">Used by reports and the follow-up engine. It cannot be changed later.</span>
        </div>
        <div className="field">
          <label htmlFor="n-type">Activity type</label>
          <select id="n-type" value={form.activity_type} onChange={(e) => set('activity_type', e.target.value)}>
            {meta.activity_types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="n-outcome">Group</label>
          <select id="n-outcome" value={form.outcome} onChange={(e) => set('outcome', e.target.value)}>
            {meta.outcomes.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary"
            disabled={saving || !form.label.trim() || !form.code.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const slug = (s) => String(s).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
