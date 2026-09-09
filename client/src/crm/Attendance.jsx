/**
 * Check-in and check-out (P3-09).
 *
 * "When a user logs in, a pop-up prompts them to check in." So the prompt is
 * the first thing a sales user meets, and it is worth being careful about what
 * that costs: a dialog in front of the work, every morning, for people whose
 * job is speed.
 *
 * It can therefore be dismissed. Somebody who is not ready — signing in from a
 * train, opening the CRM at home to look something up — is not made to lie
 * about starting their day before they can read a lead. The chip in the header
 * stays visible while they are not checked in, so nothing is hidden by
 * dismissing it, and the prompt returns on the next sign-in.
 *
 * Whether it appears at all is the server's answer, not this component's:
 * `/attendance/me` returns `prompt`, decided from the policy for that business
 * and that role. The mobile app asks the same question and gets the same
 * answer.
 */

import { useState } from 'react';
import { api, dateTime } from '../api.js';
import { useApi, Icon, Modal, Spinner, ErrorBanner } from '../components/ui.jsx';

/** "7h 20m" — hours people can read, not a decimal they have to convert. */
export function readableMinutes(mins) {
  const m = Math.max(0, Math.round(mins ?? 0));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export default function Attendance() {
  const [state, { reload }] = useApi('/attendance/me');
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  if (!state?.applies) return null;

  const act = async (what) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/attendance/${what}`, {});
      setDismissed(false);
      setOpen(false);
      reload();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const prompting = state.prompt && !dismissed;

  return (
    <>
      {/* The chip. Present whether or not they are checked in, so the state is
          never a thing they have to go looking for. */}
      <button
        type="button"
        className={`attend-chip ${state.checked_in ? 'is-in' : 'is-out'}`}
        onClick={() => setOpen(true)}
        title={state.checked_in ? `Checked in at ${dateTime(state.since)}` : 'Not checked in'}
      >
        <span className="attend-dot" />
        {state.checked_in
          ? readableMinutes(state.today.minutes)
          : 'Check in'}
      </button>

      {prompting && (
        <Modal
          title="Start your day"
          subtitle="Your checked-in hours are recorded from now"
          onClose={() => setDismissed(true)}
        >
          <ErrorBanner error={error} />
          <p className="muted">
            {state.today.minutes > 0
              ? `You have ${readableMinutes(state.today.minutes)} recorded today already.`
              : 'Nothing recorded today yet.'}
          </p>
          <p className="hint">
            You can check out and back in as many times as you need — lunch, a client
            visit — and the day adds them up.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setDismissed(true)}>Not yet</button>
            <button className="btn-primary" disabled={busy} onClick={() => act('check-in')}>
              {busy ? <Spinner /> : 'Check in'}
            </button>
          </div>
        </Modal>
      )}

      {open && (
        <Modal
          title="Your day"
          subtitle={state.checked_in ? `Checked in since ${dateTime(state.since)}` : 'Not checked in'}
          onClose={() => setOpen(false)}
        >
          <ErrorBanner error={error} />

          <div className="importsum" style={{ marginBottom: 12 }}>
            <div className="importsum-cell">
              <strong>{readableMinutes(state.today.minutes)}</strong>
              <span>Today</span>
            </div>
            <div className="importsum-cell">
              <strong>{state.today.intervals.length}</strong>
              <span>Interval{state.today.intervals.length === 1 ? '' : 's'}</span>
            </div>
          </div>

          {state.today.intervals.length > 0 && (
            <div className="table-scroll" style={{ maxHeight: 200 }}>
              <table className="table">
                <thead><tr><th>In</th><th>Out</th><th className="num">Time</th></tr></thead>
                <tbody>
                  {state.today.intervals.map((i) => (
                    <tr key={i.id}>
                      <td>{dateTime(i.checked_in_at)}</td>
                      <td>
                        {i.checked_out_at ? dateTime(i.checked_out_at) : <em className="muted">still open</em>}
                        {/* An hour a rule inferred is not an hour somebody
                            vouched for, and the two should never look alike. */}
                        {i.closed_by === 'auto' && <span className="badge" style={{ marginLeft: 6 }}>auto</span>}
                      </td>
                      <td className="num">{readableMinutes(i.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" onClick={() => setOpen(false)}>Close</button>
            {state.checked_in ? (
              <button className="btn-primary" disabled={busy} onClick={() => act('check-out')}>
                {busy ? <Spinner /> : 'Check out'}
              </button>
            ) : (
              <button className="btn-primary" disabled={busy} onClick={() => act('check-in')}>
                {busy ? <Spinner /> : 'Check in'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------- the report */

/**
 * Checked-in hours, under Reports (P3-09).
 *
 * Scoped on the server to the user, their manager's team, or the whole
 * business — the route says which, and the screen repeats it in words so
 * nobody wonders whether they are looking at everybody.
 */
export function AttendanceReport() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [data, { loading, error }] = useApi(`/attendance/report?from=${from}&to=${to}`);
  const [shown, setShown] = useState(null);

  const columns = data?.columns ?? [];
  const visible = shown ?? new Set(data?.default ?? []);

  const download = async () => {
    const keys = columns.filter((c) => visible.has(c.key)).map((c) => c.key);
    const blob = await api.blob(`/attendance/report/export?from=${from}&to=${to}&columns=${keys.join(',')}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (error) return <ErrorBanner error={error} />;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="btn-sm" onClick={download} disabled={loading || !data?.rows?.length}>
          <Icon name="download" size={15} /> Export
        </button>
      </div>

      <span className="tiny muted">{data?.note}</span>

      {/* Which columns the table shows. P3-09 asks for configurable fields, and
          the same set drives the export. */}
      <div className="pick-grid">
        {columns.map((c) => (
          <label key={c.key} className="pick-row">
            <input
              type="checkbox"
              checked={visible.has(c.key)}
              onChange={() => {
                const next = new Set(visible);
                if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
                setShown(next);
              }}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>

      {data && (
        <div className="importsum">
          <div className="importsum-cell"><strong>{data.totals.hours}</strong><span>Hours</span></div>
          <div className="importsum-cell"><strong>{data.totals.people}</strong><span>People</span></div>
          <div className="importsum-cell"><strong>{data.totals.days}</strong><span>Days</span></div>
          <div className={`importsum-cell ${data.totals.inferred_hours ? 'is-bad' : ''}`}>
            <strong>{data.totals.inferred_hours}</strong><span>Inferred</span>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>{columns.filter((c) => visible.has(c.key)).map((c) => <th key={c.key}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r) => (
              <tr key={`${r.user_id}-${r.day}`}>
                {columns.filter((c) => visible.has(c.key)).map((c) => (
                  <td key={c.key} className={typeof r[c.key] === 'number' ? 'num' : ''}>
                    {c.key === 'open' ? (r.open ? 'Yes' : 'No') : (r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && !data?.rows?.length && (
        <p className="tiny muted">Nobody checked in between those dates.</p>
      )}
    </div>
  );
}
