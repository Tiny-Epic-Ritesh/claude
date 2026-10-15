/**
 * An account's nomination (SEBI's circular of 29 May 2026).
 *
 * What is in force and what the holding statement prints (10.1); every
 * nomination, change and opt-out, each with the acknowledgement the investor
 * was sent (9.3); and the twice-yearly reminders an account without a
 * nominee receives (10.2). A change received on the circular's forms is
 * recorded here -- never typed over the old one, which stays in the history.
 */

import { useState } from 'react';
import { api, dateTime, shortDate } from '../api.js';
import { Modal, ErrorBanner, Icon } from '../components/ui.jsx';

const STATE = {
  nominated: { label: 'Nominated', tone: 'badge-green' },
  legacy: { label: 'Nominated (migrated)', tone: 'badge-green' },
  opted_out: { label: 'Opted out', tone: 'badge-amber' },
  none: { label: 'No nomination', tone: 'badge-red' },
};

export function NominationCard({ client, session, onChanged }) {
  const [changing, setChanging] = useState(false);
  const [done, setDone] = useState(null);
  const n = client.nomination;
  if (!n) return null;
  const state = STATE[n.state] ?? STATE.none;
  const mayRecord = session?.permissions?.includes('client.edit');

  return (
    <div className="card">
      <div className="card-head">
        <h2>Nomination</h2>
        <span className={`badge ${state.tone}`}>{state.label}</span>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {done && <div className="notice notice-ok"><Icon name="check_circle" size={17} /> <span>{done}</span></div>}
        <div className="small">
          <span className="muted">Holding statement prints:</span> <strong>{n.statement_line}</strong>
        </div>
        {n.nominees.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            {n.nominees.map((x, i) => (
              <div key={i} className="small">
                {x.name}{x.relationship ? ` · ${x.relationship}` : ''}{x.minor ? ' · minor' : ''}
                {x.share != null ? ` · ${x.share}%` : ''}
                {(x.mobile || x.email) && <span className="tiny muted"> · {[x.mobile, x.email].filter(Boolean).join(', ')}</span>}
              </div>
            ))}
          </div>
        )}
        {n.state === 'legacy' && (
          <div className="tiny muted">Migrated with only a name. It stays valid; the next change the investor makes is recorded in full.</div>
        )}
        {(n.state === 'none' || n.state === 'opted_out') && (
          <div className="tiny muted">
            Without a nominee this account is reminded twice a year by SMS and email, and asked on the first log-in of each day.
            {n.reminders.length ? ` Last reminded ${shortDate(n.reminders[0].sent_at)} (${n.reminders[0].period}).` : ''}
          </div>
        )}
        {mayRecord && (
          <div>
            <button className="btn-sm" onClick={() => { setDone(null); setChanging(true); }}>Record a change</button>
          </div>
        )}
        {n.history.length > 0 && (
          <details>
            <summary className="small">History · {n.history.length}</summary>
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Recorded</th><th>What</th><th>How</th><th>Acknowledged</th></tr></thead>
                <tbody>
                  {n.history.map((h) => (
                    <tr key={h.id} style={h.superseded_at ? { opacity: 0.6 } : undefined}>
                      <td className="tiny">{dateTime(h.recorded_at)}{h.recorded_by_name ? ` · ${h.recorded_by_name}` : ''}</td>
                      <td className="small">
                        {h.kind === 'opted_out' ? 'Opted out' : `${h.nominee_count} nominee${h.nominee_count === 1 ? '' : 's'}`}
                        {h.superseded_at ? <span className="tiny muted"> · replaced</span> : ''}
                      </td>
                      <td className="tiny">{h.mode === 'physical' ? 'Signed form' : 'Online'}{h.evidence ? ` · ${h.evidence}` : ''}</td>
                      <td className="tiny mono">{h.ack_ref ?? '—'}{h.ack_channels ? ` (${h.ack_channels})` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
      {changing && (
        <RecordNomination client={client} form={n.form} onClose={() => setChanging(false)}
          onDone={(out) => {
            setChanging(false);
            setDone(`Recorded. The investor was sent acknowledgement ${out.ack_ref}${out.ack_channels?.length ? ` by ${out.ack_channels.join(' and ')}` : ''}.`);
            onChanged();
          }} />
      )}
    </div>
  );
}

const EMPTY = { name: '', relationship: '', minor: false, dob: '', share: '', mobile: '', email: '', id_type: '', id_number: '' };

/** A nomination, change or opt-out received on the circular's forms. */
function RecordNomination({ client, form, onClose, onDone }) {
  const [kind, setKind] = useState('nominated');
  const [nominees, setNominees] = useState([{ ...EMPTY }]);
  const [shows, setShows] = useState('yes_no');
  const [mode, setMode] = useState('physical');
  const [evidence, setEvidence] = useState('');
  const [declaration, setDeclaration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const max = form?.max ?? 3;

  const update = (i, patch) => setNominees((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const out = await api.post(`/clients/${client.id}/nominations`, {
        kind, mode, evidence,
        ...(kind === 'nominated' ? { nominees, statement_shows: shows } : { declaration }),
      });
      onDone(out);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const ready = evidence.trim().length >= 5
    && (kind === 'opted_out' ? declaration : nominees.every((x) => x.name.trim() && x.relationship));

  return (
    <Modal title={`Nomination for ${client.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <ErrorBanner error={error} />
        <div className="row" style={{ gap: 14 }}>
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" checked={kind === 'nominated'} onChange={() => setKind('nominated')} /> Nominate (Annexure-A)
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" checked={kind === 'opted_out'} onChange={() => setKind('opted_out')} /> Opt out (Annexure-B)
          </label>
        </div>

        {kind === 'nominated' ? (
          <>
            {nominees.map((x, i) => (
              <fieldset key={i} className="card" style={{ padding: 12 }}>
                <legend className="row" style={{ gap: 8 }}>
                  <strong className="small">Nominee {i + 1}</strong>
                  {nominees.length > 1 && (
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setNominees((l) => l.filter((_, j) => j !== i))}>Remove</button>
                  )}
                </legend>
                <div className="row wrap" style={{ gap: 10 }}>
                  <div className="field"><label>Name</label><input value={x.name} onChange={(e) => update(i, { name: e.target.value })} /></div>
                  <div className="field">
                    <label>Relationship</label>
                    <select value={x.relationship} onChange={(e) => update(i, { relationship: e.target.value })}>
                      <option value="">Select…</option>
                      {(form?.relationships ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <label className="row" style={{ gap: 6, alignSelf: 'flex-end' }}>
                    <input type="checkbox" checked={x.minor} onChange={(e) => update(i, { minor: e.target.checked })} /> Minor
                  </label>
                  {x.minor && <div className="field"><label>Date of birth</label><input type="date" value={x.dob} onChange={(e) => update(i, { dob: e.target.value })} /></div>}
                </div>
                <div className="row wrap" style={{ gap: 10 }}>
                  <div className="field"><label>Share % (optional)</label><input type="number" min="0.01" max="100" step="0.01" value={x.share} onChange={(e) => update(i, { share: e.target.value })} /></div>
                  <div className="field"><label>Mobile (optional)</label><input value={x.mobile} maxLength={10} onChange={(e) => update(i, { mobile: e.target.value })} /></div>
                  <div className="field"><label>Email (optional)</label><input value={x.email} onChange={(e) => update(i, { email: e.target.value })} /></div>
                  <div className="field">
                    <label>Identifier (optional)</label>
                    <div className="row" style={{ gap: 6 }}>
                      <select value={x.id_type} onChange={(e) => update(i, { id_type: e.target.value, id_number: '' })}>
                        <option value="">None</option>
                        {(form?.id_types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      {x.id_type && <input value={x.id_number} onChange={(e) => update(i, { id_number: e.target.value.toUpperCase() })} aria-label="Identifier number" />}
                    </div>
                  </div>
                </div>
              </fieldset>
            ))}
            {nominees.length < max && (
              <button type="button" className="btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
                onClick={() => setNominees((l) => [...l, { ...EMPTY }])}>Add another nominee</button>
            )}
            <div className="field">
              <label>The holding statement shows</label>
              <select value={shows} onChange={(e) => setShows(e.target.value)}>
                <option value="names">The nominees' names</option>
                <option value="yes_no">Only whether a nomination was made</option>
              </select>
            </div>
          </>
        ) : (
          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={declaration} onChange={(e) => setDeclaration(e.target.checked)} style={{ marginTop: 3 }} />
            <span className="small">
              The investor has signed the Annexure-B declaration -- or agreed to it online -- confirming they understand what
              not nominating means for their heirs and for unclaimed holdings.
            </span>
          </label>
        )}

        <div className="row wrap" style={{ gap: 10 }}>
          <div className="field">
            <label>Received</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="physical">On a signed form</option>
              <option value="online">Online</option>
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label>What was received</label>
            <input value={evidence} onChange={(e) => setEvidence(e.target.value)}
              placeholder={mode === 'physical' ? 'Annexure-A, received at the Pune branch on 14 Oct' : 'Request through the trading app, OTP-verified'} />
          </div>
        </div>
        <p className="tiny muted">
          The investor is sent an acknowledgement with a reference by SMS and email. The nomination before this one stays in the history.
        </p>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy || !ready}>{busy ? 'Recording…' : 'Record'}</button>
        </div>
      </form>
    </Modal>
  );
}
