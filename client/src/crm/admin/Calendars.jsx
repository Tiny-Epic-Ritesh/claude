import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Icon } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Calendars() {
  const [data, { loading, reload }] = useApi('/admin/calendars');
  const [adding, setAdding] = useState(null);   // kind
  const [error, setError] = useState(null);
  if (loading || !data) return <Loading />;

  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const drop = async (id) => {
    setError(null);
    try { await api.del(`/admin/calendars/days/${id}`); reload(); }
    catch (err) { setError(err.message); }
  };

  return (
    <>
      <div className="glass notice">
        <Icon name="event" />
        <div className="tiny">{data.note}</div>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="portal-grid">
        {data.calendars.map((c) => (
          <section key={c.kind} className="card section-card">
            <div className="section-head">
              <div>
                <h2>{c.label}</h2>
                <p>
                  {String(c.open_hour).padStart(2, '0')}:00–{String(c.close_hour).padStart(2, '0')}:00 ·{' '}
                  {c.week.map((d) => DAY[d]).join(' ')}
                </p>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(c.kind)}>
                <Icon name="add" size={16} /> Add a day
              </button>
            </div>

            {c.days.length === 0 ? (
              <Empty>No closures recorded. Paste this year&apos;s list from the NSE circular.</Empty>
            ) : (
              <ul className="ctx-list">
                {c.days.map((d) => (
                  <li key={d.id}>
                    <span className={`state-pill ${d.half_day ? 'state-warm' : 'state-risk'}`}>
                      {d.half_day ? `to ${d.close_hour}:00` : 'closed'}
                    </span>
                    <div>
                      <strong>{d.name}</strong>
                      <div className="tiny muted">
                        {d.on_date}
                        {d.source === 'seed' && ' · shipped'}
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-icon" aria-label={`Remove ${d.name}`}
                      onClick={() => drop(d.id)}>
                      <Icon name="close" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {adding && (
        <AddCalendarDay
          kind={adding}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); reload(); }}
        />
      )}
    </>
  );
}

function AddCalendarDay({ kind, onClose, onSaved }) {
  const [form, setForm] = useState({ on_date: '', name: '', half_day: false, close_hour: 13 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <Modal title={`Add a day to the ${kind} calendar`} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError(null);
          try {
            await api.post(`/admin/calendars/${kind}/days`, {
              ...form, close_hour: form.half_day ? Number(form.close_hour) : null,
            });
            onSaved();
          } catch (err) { setError(err.message); setBusy(false); }
        }}
      >
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <label>
          <span>Date</span>
          <input type="date" value={form.on_date} onChange={set('on_date')} required autoFocus />
        </label>
        <label>
          <span>What is it?</span>
          <input value={form.name} onChange={set('name')} required placeholder="Diwali — Laxmi Pujan" />
        </label>

        <div className="check-row span-2">
          <label className="inline">
            <input type="checkbox" checked={form.half_day} onChange={set('half_day')} />
            <span>Open, but closing early</span>
          </label>
          {form.half_day && (
            <label className="inline">
              <span>Closes at</span>
              <input type="number" min="1" max="23" value={form.close_hour} onChange={set('close_hour')}
                style={{ width: 70 }} />
            </label>
          )}
        </div>

        <p className="tiny muted span-2">
          {form.half_day
            ? 'A short day still counts as a working day — Muhurat trading is the usual case.'
            : 'A closed day is skipped by the SLA clock and by every follow-up reschedule.'}
        </p>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.on_date || !form.name.trim()}>
            {busy ? <Spinner /> : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------- rule builder */

/**
 * Building an automation without writing JSON.
 *
 * The screen was read-only: you could see a rule, dry-run it and toggle it, but
 * the only way to create one was a POST by hand. That is the difference between
 * a platform an operations lead can change and one that needs a developer for
 * every "chase leads that went quiet".
 *
 * The vocabulary comes from the server — `condition_fields` and `action_types`
 * ride along on GET /admin/rules — so this form does not know what a rule means.
 * Adding a condition field or an action type on the server makes it appear here
 * with no change to this file.
 *
 * DRY RUN IS THE PRIMARY BUTTON, NOT SAVE
 * ---------------------------------------
 * A rule that fires on 495,118 leads is a rule you want to have tested first.
 * The builder makes dry-run the obvious path and creates every rule disabled,
 * so the sequence is always: build, see who it would hit, then enable. Nothing
 * a person types here can send a message until they deliberately turn it on.
 */
