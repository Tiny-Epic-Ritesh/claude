import { useEffect, useRef, useState } from 'react';
import { api, money, mins, STATE_LABEL } from '../api.js';
import { useApi, ErrorBanner, Spinner, Empty, Progress } from '../components/ui.jsx';

/**
 * In-Call Cockpit (BRD §5) + AI call summary and auto-disposition (§6.1).
 *
 * Telephony is simulated, so the transcript is supplied here instead of arriving
 * from the switch. Everything downstream — the AI proposal, the confirm screen,
 * and what gets written on confirmation — is the real flow.
 */

const SAMPLE_TRANSCRIPTS = [
  ['Interested — wants to start a SIP',
    'Agent: Good morning, this is Priya from Bonanza. Is this a good time?\nClient: Yes, go ahead.\nAgent: You had enquired about mutual funds on our website. Are you looking at lump sum or SIP?\nClient: SIP. I can do about 5,000 a month, maybe 10,000 later.\nAgent: That works well. We would look at a flexi-cap to start.\nClient: What is the lock-in on this?\nAgent: Only ELSS has a three-year lock-in. Everything else you can redeem any time.\nClient: Okay that is good. Send me the details on WhatsApp and the account opening link, I am ready to start this month.'],
  ['Callback requested — driving',
    'Agent: Hello, am I speaking with Mr Gupta?\nClient: Yes, but I am driving right now.\nAgent: No problem, when would be a good time?\nClient: Call me Monday after 11.\nAgent: Noted, I will call Monday at 11.'],
  ['Complaint — payout not credited',
    'Client: I raised a withdrawal on the 12th and it is still not in my account. This is the third time I am calling.\nAgent: I am sorry about that, let me check the status.\nClient: I want this escalated. If it is not resolved today I am going to complain to SEBI.\nAgent: I understand. I am raising this with the operations head right now and will update you by evening.'],
  ['Not interested — has another broker',
    'Agent: We are calling about your account opening enquiry.\nClient: I already opened an account with another broker last month. I am not looking to move.\nAgent: Understood. May I check back in six months?\nClient: You can, but do not call before that.'],
];

export default function InCall({ lead, session, onClose }) {
  const [phase, setPhase] = useState('live');       // live → disposing → review
  const [seconds, setSeconds] = useState(0);
  const [selected, setSelected] = useState(lead.cards[0]?.id ?? null);
  const [transcript, setTranscript] = useState('');
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [meta] = useApi('/meta');
  const timer = useRef(null);

  useEffect(() => {
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer.current);
  }, []);

  const card = lead.cards.find((c) => c.id === selected);
  const def = (meta?.products || []).find((p) => p.id === card?.product_type_id);
  const pitch = def?.pitch_points ? JSON.parse(def.pitch_points) : [];
  const journey = lead.journeys?.[0];

  async function endCall() {
    clearInterval(timer.current);
    setPhase('disposing');
  }

  async function generate() {
    if (!transcript.trim()) { setError('Add the call transcript or your notes first.'); return; }
    setBusy(true);
    setError(null);
    try {
      setProposal(await api.post('/ai/disposition', { lead_id: lead.id, transcript, duration_s: seconds }));
      setPhase('review');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post('/ai/disposition/confirm', { ...proposal, lead_id: lead.id, duration_s: seconds });
      setSaved(result);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const update = (patch) => setProposal({ ...proposal, ...patch });

  return (
    <div className="backdrop" style={{ alignItems: 'stretch', padding: 0 }}>
      <div className="card" style={{ width: '100%', maxWidth: 1180, margin: 'auto', maxHeight: '96vh', overflowY: 'auto' }}>

        {/* Topbar */}
        <div className="card-head" style={{ background: 'var(--brand)', color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <div>
            <h2 style={{ color: '#fff' }}>{lead.name}</h2>
            <div className="tiny" style={{ opacity: .85 }}>
              {lead.mobile} · {lead.city} · {lead.stage} · KYC {lead.kyc_status} · {lead.age_band}
            </div>
          </div>
          <div className="row">
            <span className="badge" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }}>
              {phase === 'live' ? '● Live' : 'Ended'} {mins(seconds)}
            </span>
            {phase === 'live'
              ? <button onClick={endCall} style={{ background: '#fff', color: 'var(--brand)', borderColor: '#fff', fontWeight: 640 }}>End call</button>
              : <button className="btn-ghost btn-sm" style={{ color: '#fff' }} onClick={onClose}>Close</button>}
          </div>
        </div>

        <div className="card-body">
          <ErrorBanner error={error} onDismiss={() => setError(null)} />

          {saved ? (
            <Saved result={saved} proposal={proposal} onClose={onClose} />
          ) : phase === 'review' ? (
            <Review proposal={proposal} update={update} confirm={confirm} busy={busy} onBack={() => setPhase('disposing')} />
          ) : (
            <>
              <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 1fr) minmax(340px, 2fr) minmax(190px, 1fr)', gap: 14 }}>

                {/* Left — lead snapshot */}
                <div>
                  <h3>Snapshot</h3>
                  <div className="stack small" style={{ marginTop: 8 }}>
                    <Row label="Risk profile" value={lead.risk_profile || '—'} />
                    <Row label="Language" value={lead.language} />
                    <Row label="Lead score" value={lead.score} />
                    <Row label="AUM" value={lead.aum ? money(lead.aum) : '—'} />
                    <Row label="Owner" value={lead.owner_name || '—'} />
                    <Row label="Source" value={lead.source} />
                    {lead.partner_name && <Row label="Partner" value={lead.partner_name} />}
                  </div>

                  {lead.tickets?.filter((t) => !['Resolved', 'Closed'].includes(t.status)).length > 0 && (
                    <>
                      <h3 style={{ marginTop: 14 }}>Open tickets</h3>
                      {lead.tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status)).map((t) => (
                        <div key={t.id} className="warnbox" style={{ marginTop: 6 }}>
                          <div style={{ fontWeight: 620 }}>{t.ref} · {t.priority}</div>
                          <div className="tiny" style={{ whiteSpace: 'pre-wrap' }}>{t.ai_summary}</div>
                        </div>
                      ))}
                    </>
                  )}

                  <h3 style={{ marginTop: 14 }}>Last interactions</h3>
                  <div className="stack tiny muted" style={{ marginTop: 6 }}>
                    {(lead.activities || []).slice(0, 3).map((a) => (
                      <div key={a.id}>{a.subject}{a.body ? ` — ${a.body.slice(0, 90)}…` : ''}</div>
                    ))}
                  </div>
                </div>

                {/* Centre — products + pitch */}
                <div>
                  <h3>Products</h3>
                  <div className="pcards" style={{ marginTop: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
                    {lead.cards.map((c) => (
                      <div key={c.id} className={`pcard ${selected === c.id ? 'sel' : ''}`} onClick={() => setSelected(c.id)}>
                        <span className={`dot dot-${c.colour}`} />
                        <div className="pcard-name" style={{ fontSize: 12 }}>{c.product_name}</div>
                        <div className="tiny muted">{STATE_LABEL[c.state]}</div>
                      </div>
                    ))}
                  </div>

                  {card && (
                    <div className="card" style={{ marginTop: 12 }}>
                      <div className="card-head"><h3>{card.product_name} — pitch</h3><span className="badge">{STATE_LABEL[card.state]}</span></div>
                      <div className="card-body">
                        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                          {pitch.map((p, i) => <li key={i} style={{ marginBottom: 3 }}>{p}</li>)}
                        </ul>
                        <div className="row wrap tiny muted" style={{ marginTop: 8 }}>
                          {def?.min_investment > 0 && <span className="badge">Min {money(def.min_investment)}</span>}
                          {def?.lock_in && <span className="badge">Lock-in {def.lock_in}</span>}
                          {def?.risk_category && <span className="badge">{def.risk_category} risk</span>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right — actions */}
                <div>
                  <h3>Actions</h3>
                  <div className="stack" style={{ marginTop: 8 }}>
                    {['Send WhatsApp', 'Send SMS', 'Send brochure', 'Add note', 'Raise ticket'].map((a) => (
                      <button key={a} style={{ justifyContent: 'flex-start' }}>{a}</button>
                    ))}
                    {session.role === 'caller' && <button style={{ justifyContent: 'flex-start' }}>Mark callback</button>}
                    {session.permissions.includes('card.mark.warm') && <button style={{ justifyContent: 'flex-start' }}>Mark Warm</button>}
                  </div>
                  <p className="tiny muted" style={{ marginTop: 8 }}>
                    Actions are role-filtered. In this build they are indicative — the state changes happen through the card panel and the AI disposition.
                  </p>
                </div>
              </div>

              {/* KYC rail — visible to every role during any call */}
              {journey && (
                <div className="card" style={{ marginTop: 14 }}>
                  <div className="card-head">
                    <h3>KYC rail — {journey.product_name}</h3>
                    <span className={`badge ${['Stalled', 'Abandoned'].includes(journey.status) ? 'badge-red' : 'badge-blue'}`}>{journey.status}</span>
                  </div>
                  <div className="card-body">
                    <KycRail journeyId={journey.id} />
                    <p className="tiny muted" style={{ marginTop: 8, marginBottom: 0 }}>
                      Every role can see where the applicant is. Only Product RM and Product Supervisor can act on a step.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          {/* AI disposition bar */}
          {phase === 'disposing' && !saved && (
            <div className="card" style={{ marginTop: 14, borderColor: 'var(--accent)' }}>
              <div className="card-head"><h3>AI call summary & disposition</h3><span className="badge badge-accent">Call ended · {mins(seconds)}</span></div>
              <div className="card-body">
                <p className="small muted" style={{ marginTop: 0 }}>
                  In production the transcript arrives from the telephony integration automatically. Paste it here, or pick a sample.
                </p>
                <div className="row wrap" style={{ marginBottom: 8 }}>
                  {SAMPLE_TRANSCRIPTS.map(([label, text]) => (
                    <button key={label} className="btn-sm" onClick={() => setTranscript(text)}>{label}</button>
                  ))}
                </div>
                <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Call transcript or your notes…" style={{ minHeight: 140 }} />
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                  <button onClick={onClose}>Skip</button>
                  <button className="btn-accent" onClick={generate} disabled={busy}>{busy ? <><Spinner /> Generating…</> : 'Generate disposition'}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const Row = ({ label, value }) => (
  <div className="row-between"><span className="muted">{label}</span><span style={{ fontWeight: 545 }}>{value}</span></div>
);

function KycRail({ journeyId }) {
  const [j] = useApi(`/kyc/journeys/${journeyId}`);
  if (!j) return <Spinner />;
  return (
    <>
      <Progress pct={j.progress_pct} label={`${j.steps_done}/${j.steps_total} steps · elapsed ${mins(j.elapsed_s)}`} />
      <div className="rail" style={{ marginTop: 12 }}>
        {j.steps.filter((s) => s.applies).map((s) => (
          <div key={s.code} className="rail-step">
            <div className={`rail-dot ${s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : s.status === 'stalled' ? 'stalled' : ''}`}>
              {s.status === 'done' ? '✓' : ''}
            </div>
            <div className="rail-label">{s.label}</div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------- confirm screen */

function Review({ proposal, update, confirm, busy, onBack }) {
  return (
    <>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <div>
          <h2>Review the AI disposition</h2>
          <p className="small muted" style={{ margin: '3px 0 0' }}>
            Nothing is written until you confirm. Edit anything that is wrong — every edit is tracked so accuracy can be measured.
          </p>
        </div>
        <span className="badge badge-accent">{proposal.provider} · {proposal.latency_ms}ms</span>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="field">
            <label>Call outcome</label>
            <select value={proposal.outcome} onChange={(e) => update({ outcome: e.target.value })}>
              {['Connected — Interested', 'Connected — Not Interested', 'Connected — Callback Requested', 'Not Reachable', 'Wrong Number', 'Busy — Call Later', 'Do Not Call'].map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Summary (saved as the activity)</label>
            <textarea value={proposal.summary} onChange={(e) => update({ summary: e.target.value })} style={{ minHeight: 96 }} />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Next action</label>
              <select value={proposal.next_action} onChange={(e) => update({ next_action: e.target.value })}>
                {['Callback', 'Send Brochure', 'Schedule Meeting', 'Hand to Sales RM', 'Raise Ticket', 'Start KYC', 'No Action'].map((o) => <option key={o}>{o}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Due in (hours)</label>
              <input type="number" min="1" value={proposal.next_action_due_hours} onChange={(e) => update({ next_action_due_hours: Number(e.target.value) })} />
            </div>
          </div>
          <div className="field">
            <label>Follow-up task</label>
            <input value={proposal.follow_up_task} onChange={(e) => update({ follow_up_task: e.target.value })} />
          </div>
        </div>

        <div>
          <h3>Proposed card changes</h3>
          {proposal.card_changes.length === 0 ? (
            <p className="small muted">No card state changes proposed.</p>
          ) : (
            <div className="stack" style={{ marginTop: 6 }}>
              {proposal.card_changes.map((c, i) => (
                <div key={i} className="card" style={{ padding: 10 }}>
                  <div className="row-between">
                    <strong className="small">{c.product_code}</strong>
                    <span className="small">
                      {STATE_LABEL[c.from_state] || c.from_state} →{' '}
                      <select
                        value={c.to_state}
                        style={{ width: 'auto', display: 'inline-block', padding: '2px 6px' }}
                        onChange={(e) => {
                          const next = [...proposal.card_changes];
                          next[i] = { ...c, to_state: e.target.value };
                          update({ card_changes: next });
                        }}
                      >
                        {['EXPLORING', 'WARM', 'ON_HOLD', 'LOST', 'INACTIVE'].map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
                      </select>
                    </span>
                  </div>
                  <div className="tiny muted" style={{ marginTop: 4 }}>{c.evidence}</div>
                  <button
                    className="btn-ghost btn-sm"
                    style={{ marginTop: 4, padding: 0 }}
                    onClick={() => update({ card_changes: proposal.card_changes.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {proposal.products_discussed?.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Products discussed</h3>
              <div className="row wrap">{proposal.products_discussed.map((p) => <span key={p} className="badge badge-blue">{p}</span>)}</div>
            </>
          )}

          {proposal.commitments?.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Commitments made</h3>
              <ul className="small" style={{ marginTop: 4, paddingLeft: 18 }}>
                {proposal.commitments.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </>
          )}

          <h3 style={{ marginTop: 14 }}>Compliance</h3>
          <div className="field">
            <select value={proposal.compliance_flag} onChange={(e) => update({ compliance_flag: e.target.value })}>
              {['None', 'Complaint', 'Mis-selling risk', 'Guaranteed-return expectation', 'Regulatory mention', 'Urgency on funds'].map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>
          {proposal.compliance_flag !== 'None' && (
            <div className="warnbox">
              {proposal.compliance_note || 'This call is flagged for compliance review.'}
              <div style={{ marginTop: 4, fontWeight: 620 }}>A High-priority ticket will be raised on confirmation.</div>
            </div>
          )}
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={confirm} disabled={busy}>{busy ? <Spinner /> : 'Confirm & apply'}</button>
      </div>
    </>
  );
}

function Saved({ result, proposal, onClose }) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 12px' }}>
      <div style={{ fontSize: 34 }}>✓</div>
      <h2 style={{ marginTop: 8 }}>Disposition applied</h2>
      <div className="stack small" style={{ maxWidth: 460, margin: '14px auto 0', textAlign: 'left' }}>
        <div className="row-between"><span className="muted">Activity logged</span><span>AI call summary</span></div>
        <div className="row-between"><span className="muted">Lead score</span><span>+{proposal.score_signal}</span></div>
        <div className="row-between"><span className="muted">Cards updated</span><span>{result.cards_updated.length}</span></div>
        {result.cards_refused.length > 0 && (
          <div className="warnbox">
            {result.cards_refused.length} change(s) were refused by your role permissions:
            {result.cards_refused.map((c, i) => <div key={i} className="tiny">· {c.product_code} → {c.to_state}: {c.reason}</div>)}
          </div>
        )}
        {proposal.follow_up_task && <div className="row-between"><span className="muted">Task created</span><span>{proposal.follow_up_task}</span></div>}
        {result.compliance_ticket_id && (
          <div className="warnbox">Compliance ticket raised (#{result.compliance_ticket_id}) and assigned to Customer Care.</div>
        )}
      </div>
      <button className="btn-primary" style={{ marginTop: 18 }} onClick={onClose}>Done</button>
    </div>
  );
}
