/**
 * Activity capture — the form a sales desk uses more than any other screen.
 *
 * THE DESIGN PROBLEM
 * ------------------
 * A rep finishing a call has about fifteen seconds of patience. Ask for too
 * much and they stop logging; ask for too little and the pipeline becomes
 * unreportable and the follow-up is lost. So the form asks for almost nothing
 * up front — type, outcome, sub-outcome — and only reveals the fields the
 * chosen outcome actually obliges.
 *
 * Pick "Ringing" and you are done in two clicks; the retry schedules itself.
 * Pick "Callback Requested" and a date and time appear, required, because that
 * is a promise to a client. The rep is never shown a field they do not need,
 * and never allowed to skip one that matters.
 *
 * The obligations are mirrored from the server rather than duplicated: the
 * matrix arrives from /activities/meta and drives what renders. The API
 * enforces the same rules again, so a stale tab cannot slip past them.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { capture, describe as describeGeo, wants as wantsGeo } from '../location.js';
import { Icon, Spinner, ErrorBanner } from '../components/ui.jsx';

const TYPE_ICON = {
  Call: 'call',
  Meeting: 'groups',
  WhatsApp: 'chat',
  Email: 'mail',
  SMS: 'sms',
  Visit: 'location_on',
  Note: 'sticky_note_2',
};

/** Local datetime string for an <input type="datetime-local">. */
const localInput = (d) => {
  const dt = new Date(d);
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  return dt.toISOString().slice(0, 16);
};

/** Quick presets, because most callbacks are "later today" or "tomorrow". */
const PRESETS = [
  { label: 'In 2 hours', hours: 2 },
  { label: 'Tomorrow 10am', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; } },
  { label: 'Tomorrow 4pm', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(16, 0, 0, 0); return d; } },
  { label: 'In 3 days', hours: 72 },
  { label: 'Next week', hours: 168 },
];

/**
 * How each outcome group presents itself.
 *
 * Connected and Not Connected carry the weight — they decide whether a
 * follow-up is created and what the disposition matrix does next — so they get
 * the colour and the size. Other is deliberately quieter.
 */
const OUTCOME_META = {
  Connected: { icon: 'phone_in_talk', cls: 'is-connected' },
  'Not Connected': { icon: 'phone_missed', cls: 'is-not-connected' },
  Other: { icon: 'more_horiz', cls: 'is-other' },
};

export default function ActivityComposer({ lead, cards = [], onLogged }) {
  const [meta, setMeta] = useState(null);
  const [type, setType] = useState('Call');
  const [code, setCode] = useState('');
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [confirmation, setConfirmation] = useState(null);

  useEffect(() => {
    api.get('/activities/meta').then(setMeta).catch((e) => setError(e.message));
  }, []);

  // Changing the type invalidates the outcome — the matrix is per type.
  const [outcome, setOutcome] = useState('');
  useEffect(() => { setCode(''); setOutcome(''); setForm({}); setFieldErrors({}); }, [type]);

  const groups = meta?.dispositions?.[type] ?? [];
  const activeGroup = groups.find((g) => g.outcome === outcome) ?? null;

  /**
   * Number keys pick the group, then the outcome.
   *
   * This screen is used a hundred times a day by the same people. Reaching for
   * the mouse twice per call is the slow path, and the shortcut is discoverable
   * because every target prints its own key.
   */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Never steal a keystroke from someone typing a note.
      const t = e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;

      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;

      if (!activeGroup) {
        const g = groups[n - 1];
        if (g) { setOutcome(g.outcome); setCode(''); }
      } else {
        const o = activeGroup.options[n - 1];
        if (o) { setCode(o.code); setFieldErrors({}); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [groups, activeGroup]);
  const chosen = useMemo(
    () => groups.flatMap((g) => g.options).find((o) => o.code === code) ?? null,
    [groups, code],
  );

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setFieldErrors((e) => ({ ...e, [k]: null })); };

  const needsDateTime = chosen?.requires_datetime === 1;
  const isMeeting = chosen?.next_step === 'meeting';
  const needsReason = chosen?.requires_reason === 1;
  const dateField = isMeeting ? 'meeting_at' : 'follow_up_at';

  const applyPreset = (p) => {
    const d = p.at ? p.at() : new Date(Date.now() + p.hours * 3600_000);
    set(dateField, localInput(d));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      /* Where the meeting happened. P3-10.
       *
       * Asked for only when the server says it is wanted -- capture is on or
       * off for the deployment and applies to the physical meeting modes, so a
       * phone call never prompts. Awaited before the post rather than sent
       * afterwards, because an activity that gains a location a second later is
       * an activity somebody has already navigated away from.
       *
       * It never blocks the save. A refused permission is recorded as refused
       * and the meeting is logged, because a form that would not save without a
       * position teaches people to log visits from their desk afterwards --
       * which is worse evidence than an honest "declined". */
      const geo = wantsGeo(meta, type, form.meeting_mode) ? await capture() : null;
      const payload = {
        lead_id: lead.id,
        type,
        disposition: code || undefined,
        body: form.body || undefined,
        duration_s: form.duration_s ? Number(form.duration_s) * 60 : undefined,
        card_id: form.card_id ? Number(form.card_id) : undefined,
        reason: form.reason || undefined,
        sentiment: form.sentiment || undefined,
        meeting_mode: form.meeting_mode || undefined,
        meeting_location: form.meeting_location || undefined,
        geo: geo ?? undefined,
      };
      // datetime-local gives "YYYY-MM-DDTHH:mm"; the API wants a space.
      if (form.follow_up_at) payload.follow_up_at = form.follow_up_at.replace('T', ' ');
      if (form.meeting_at) payload.meeting_at = form.meeting_at.replace('T', ' ');

      const res = await api.post('/activities', payload);
      /* Say what happened to the location as well as to the activity. Silence
         here is how somebody discovers weeks later that none of their visits
         carry one. */
      const geoNote = describeGeo(geo);
      setConfirmation(geoNote ? `${res.confirmation} ${geoNote}` : res.confirmation);
      setCode('');
      setForm({});
      onLogged?.(res);
    } catch (e) {
      // Field-level errors mark the input; anything else is a banner.
      if (e.payload?.fields) setFieldErrors(e.payload.fields);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!meta) return <div className="card"><div className="card-body"><Spinner /> Loading outcomes…</div></div>;

  const needsOutcome = ['Call', 'Meeting', 'WhatsApp'].includes(type);
  const canSubmit = !busy && (!needsOutcome || code);

  return (
    <section className="card">
      <div className="card-head">
        <h2><Icon name="add_task" size={18} /> Log an activity</h2>
        <span className="tiny muted">The outcome decides what happens next</span>
      </div>

      <div className="card-body stack">
        {/* --- type --- */}
        <div className="row wrap" style={{ gap: 6 }}>
          {meta.types.map((t) => (
            <button
              key={t}
              className={`chip ${type === t ? 'chip-active' : ''}`}
              onClick={() => setType(t)}
            >
              <Icon name={TYPE_ICON[t] ?? 'bolt'} size={16} />
              {t}
            </button>
          ))}
        </div>

        {/* --- outcome, in two steps ---
            ENH-21a / ENH-21b.

            This was one flat wall of chips. Twenty-two dispositions, three
            group headings set in the same small grey label as everything else,
            and the Connected / Not Connected distinction — the single most
            important choice on the screen — visually indistinguishable from the
            options inside it.

            Now the group is chosen first, as three large targets, and only that
            group's outcomes appear. A caller doing a hundred calls a day makes
            two taps instead of scanning twenty-two chips, and the choice that
            drives the follow-up engine is the one the eye lands on.

            Number keys work on both steps, because on a high-frequency screen
            the mouse is the slow path. */}
        {needsOutcome && (
          <div className="outcome-picker">
            <div className="outcome-groups">
              {groups.map((g, i) => {
                const active = outcome === g.outcome;
                // Not `meta` — that name already holds the dispositions payload
                // in this component, and shadowing it here would be a trap.
                const look = OUTCOME_META[g.outcome] ?? OUTCOME_META.Other;
                return (
                  <button
                    key={g.outcome}
                    type="button"
                    className={`outcome-group ${look.cls} ${active ? 'is-on' : ''}`}
                    onClick={() => { setOutcome(g.outcome); setCode(''); setFieldErrors({}); }}
                  >
                    <Icon name={look.icon} size={20} />
                    <span className="outcome-name">{g.outcome}</span>
                    <span className="outcome-count">{g.options.length}</span>
                    <kbd>{i + 1}</kbd>
                  </button>
                );
              })}
            </div>

            {activeGroup && (
              <div className="outcome-options">
                <div className="field-label">
                  What happened? <span className="muted">— {activeGroup.outcome}</span>
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {activeGroup.options.map((o, i) => (
                    <button
                      key={o.code}
                      type="button"
                      className={`chip ${code === o.code ? 'chip-active' : ''}`}
                      onClick={() => { setCode(o.code); setFieldErrors({}); }}
                      title={o.hint}
                    >
                      {o.label}
                      {i < 9 && <kbd>{i + 1}</kbd>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* The hint tells the rep what saving will commit them to, before
            they save — the automation should never be a surprise. */}
        {chosen?.hint && (
          <div className="notice" style={{ borderLeftColor: 'var(--accent)' }}>
            <Icon name="lightbulb" size={16} style={{ color: 'var(--accent-dark)' }} /> {chosen.hint}
          </div>
        )}

        {/* --- the obligations this outcome carries --- */}
        {(needsDateTime || isMeeting) && (
          <div className="field">
            <label htmlFor="next-when">
              {isMeeting ? 'Meeting date & time' : 'Call back on'} <span className="tone-bad">*</span>
            </label>
            <input
              id="next-when"
              type="datetime-local"
              value={form[dateField] ?? ''}
              min={localInput(new Date())}
              onChange={(e) => set(dateField, e.target.value)}
            />
            <div className="row wrap" style={{ gap: 5, marginTop: 5 }}>
              {PRESETS.map((p) => (
                <button key={p.label} className="chip chip-sm" onClick={() => applyPreset(p)}>{p.label}</button>
              ))}
            </div>
            {fieldErrors[dateField] && <div className="tiny tone-bad">{fieldErrors[dateField]}</div>}
          </div>
        )}

        {isMeeting && (
          <div className="field-row">
            <div className="field">
              <label htmlFor="mode">Mode</label>
              <select id="mode" value={form.meeting_mode ?? ''} onChange={(e) => set('meeting_mode', e.target.value)}>
                <option value="">Choose…</option>
                {meta.meeting_modes.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="loc">Location / link</label>
              <input id="loc" type="text" value={form.meeting_location ?? ''} onChange={(e) => set('meeting_location', e.target.value)} />
            </div>
          </div>
        )}

        {/* Said before the browser asks, not after. P3-10.
            The server has supplied this notice all along and only the mobile app
            ever showed it -- so a web user met a bare permission prompt with no
            statement of why, how long it is kept, or that refusing is allowed.
            Under DPDP that statement is the point, not a courtesy. */}
        {wantsGeo(meta, type, form.meeting_mode) && (
          <div className="notice" style={{ borderLeftColor: 'var(--accent)' }}>
            <strong>Your location will be recorded with this meeting.</strong>
            <ul style={{ margin: '6px 0 0', paddingInlineStart: '18px' }}>
              <li className="tiny">{meta.geolocation.notice.purpose}</li>
              <li className="tiny">{meta.geolocation.notice.retention}</li>
              <li className="tiny">{meta.geolocation.notice.visibility}</li>
              <li className="tiny">{meta.geolocation.notice.optional}</li>
            </ul>
          </div>
        )}

        {needsReason && (
          <div className="field">
            <label htmlFor="reason">Reason <span className="tone-bad">*</span></label>
            <input
              id="reason"
              type="text"
              value={form.reason ?? ''}
              placeholder="Why? This is the answer a supervisor will read."
              onChange={(e) => set('reason', e.target.value)}
            />
            {fieldErrors.reason && <div className="tiny tone-bad">{fieldErrors.reason}</div>}
          </div>
        )}

        {/* --- always available --- */}
        <div className="field">
          <label htmlFor="notes">What was discussed</label>
          <textarea
            id="notes"
            rows={3}
            value={form.body ?? ''}
            placeholder="The next person to open this record reads this. Write for them."
            onChange={(e) => set('body', e.target.value)}
          />
        </div>

        <div className="field-row">
          {type === 'Call' && (
            <div className="field">
              <label htmlFor="dur">Duration (minutes)</label>
              <input id="dur" type="number" min="0" value={form.duration_s ?? ''} onChange={(e) => set('duration_s', e.target.value)} />
            </div>
          )}
          {cards.length > 0 && (
            <div className="field">
              <label htmlFor="card">About which product?</label>
              <select id="card" value={form.card_id ?? ''} onChange={(e) => set('card_id', e.target.value)}>
                <option value="">Not product-specific</option>
                {cards.filter((c) => c.state !== 'INACTIVE').map((c) => (
                  <option key={c.id} value={c.id}>{c.product_name} · {c.state}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

        {confirmation && (
          <div className="notice" style={{ borderLeftColor: 'var(--ok)' }}>
            <Icon name="check_circle" size={16} style={{ color: 'var(--ok)' }} /> {confirmation}
          </div>
        )}

        <div className="row">
          <button className="btn-primary" disabled={!canSubmit} onClick={submit}>
            {busy ? <Spinner /> : <Icon name="send" size={16} />} Log activity
          </button>
          {needsOutcome && !code && <span className="tiny muted">Pick an outcome to continue</span>}
        </div>
      </div>
    </section>
  );
}
