import { useEffect, useMemo, useRef, useState } from 'react';
import { api, money, STATE_LABEL } from '../api.js';
import { Icon, Spinner, ErrorBanner, useApi, announce } from '../components/ui.jsx';
import ActivityComposer from './ActivityComposer.jsx';
import ActionModal from './ActionModals.jsx';

/**
 * The call panel (A4: QA-10 and Part 4 item 9; preview approved 19 Nov).
 *
 * What the auditor found, and what this does instead:
 *
 *   - It was a translucent overlay (the page showed through it) and its End
 *     call was white on white: its colours came from `var(--brand)`, which the
 *     stylesheet never defined. It is now a solid panel, docked beside the
 *     page on a laptop so the lead stays readable, and full-screen on a phone,
 *     with End call a solid red button that never scrolls away.
 *   - Start call never dialled: the header button opened a simulated cockpit,
 *     while the list's call button dialled CUBE and opened a different form.
 *     Every "call" now opens this, and this dials -- through the consent
 *     checks the server makes -- and says what happened: your phone is
 *     ringing, the call can't be made and why, or (no dialler on this server)
 *     a call clearly marked as simulated. Nobody is offered their own phone
 *     instead (ruled 19 Nov): a refused dial is retried, or logged.
 *   - Twelve products pushed everything off-screen. One is in focus -- the one
 *     the call was started from, else the latest in progress -- with its
 *     pitch; the rest are a count and a click away.
 *   - Its actions were placeholders ("indicative"). Each now does the real
 *     thing, through the same dialog it uses everywhere else, and is listed
 *     under "Done on this call". One that does not apply is hidden or greyed
 *     out with the reason.
 *   - The wrap-up could be skipped, so a call could go unrecorded. It is
 *     required (ruled 19 Nov), and it is the CRM's own call form, with
 *     Setup's outcomes. A call the AI drafts is saved the same way, as a call
 *     (ruled 19 Nov, OPS-74).
 */

const CALL_EVENT = 'crm:call';
const OPEN_EVENT = 'crm:call-open';
export const LEAD_CHANGED_EVENT = 'crm:lead-changed';

/** Start a call from anywhere -- the lead page, a list row, a product card. */
export function startCall({ leadId, productTypeId = null }) {
  window.dispatchEvent(new CustomEvent(CALL_EVENT, { detail: { leadId: Number(leadId), productTypeId } }));
}

/** Whether a call is open, for the buttons that would start another. */
export function useCallOpen() {
  const [open, setOpen] = useState(() => Boolean(window.__crmCallOpen));
  useEffect(() => {
    const on = (e) => setOpen(Boolean(e.detail?.open));
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  return open;
}

/**
 * One panel for the whole CRM, mounted by the shell, so a call survives moving
 * to another page while it is going on.
 */
export default function CallHost({ session }) {
  const [call, setCall] = useState(null);
  const current = useRef(null);
  current.current = call;

  useEffect(() => {
    const on = (e) => {
      if (current.current) {
        announce('A call is already open', ['Finish and save it before starting another.'], 'warn');
        return;
      }
      setCall({ ...e.detail, key: Date.now() });
    };
    window.addEventListener(CALL_EVENT, on);
    return () => window.removeEventListener(CALL_EVENT, on);
  }, []);

  useEffect(() => {
    window.__crmCallOpen = Boolean(call);
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { open: Boolean(call) } }));
    document.body.classList.toggle('has-call-panel', Boolean(call));
    return () => document.body.classList.remove('has-call-panel');
  }, [call]);

  if (!call || !session) return null;
  return <CallPanel key={call.key} leadId={call.leadId} productTypeId={call.productTypeId} session={session} onClose={() => setCall(null)} />;
}

/* Sample transcripts for a simulated call only: with no dialler, there is no
   recording to draft from. Never shown on a call CUBE placed. */
const SAMPLE_TRANSCRIPTS = [
  ['Interested: wants to start a SIP',
    'Agent: Good morning, is this a good time?\nClient: Yes, go ahead.\nAgent: You had enquired about mutual funds. Lump sum or SIP?\nClient: SIP. I can do about 5,000 a month.\nClient: Send me the details on WhatsApp and the account opening link, I am ready to start this month.'],
  ['Callback requested: driving',
    'Agent: Hello, am I speaking with the client?\nClient: Yes, but I am driving right now.\nAgent: When would be a good time?\nClient: Call me back Monday after 11.'],
  ['Complaint: payout not credited',
    'Client: I raised a withdrawal on the 12th and it is still not in my account. This is the third time I am calling.\nClient: If it is not resolved today I am going to complain to SEBI.'],
];

const IN_PROGRESS = ['EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED', 'KYC_IN_PROGRESS'];
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const clock = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
/** A datetime-local value, in India time, for a callback. */
const istInput = (d) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16);
const istLabel = (d) => d.toLocaleString('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});
/** The next two working days (Monday to Friday), at 11:00 India time. */
const callbackPresets = () => {
  const today = new Date(Date.now() + 330 * 60_000);
  const out = [];
  for (let k = 1; out.length < 2 && k < 10; k += 1) {
    const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + k, 11, 0) - 330 * 60_000);
    const weekday = new Date(at.getTime() + 330 * 60_000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push({ value: istInput(at), label: istLabel(at) });
  }
  return out;
};

/** The lead's other products, counted as a caller would say it: "1 active · 9 not started". */
function otherCounts(cards, focusId) {
  const rest = cards.filter((c) => c.id !== focusId);
  const n = (test) => rest.filter(test).length;
  return [
    [n((c) => IN_PROGRESS.includes(c.state)), 'in progress'],
    [n((c) => c.state === 'ACTIVE'), 'active'],
    [n((c) => c.state === 'INACTIVE'), 'not started'],
    [n((c) => ['ON_HOLD', 'LOST'].includes(c.state)), 'on hold or lost'],
  ].filter(([k]) => k > 0).map(([k, label]) => `${k} other ${label}`.replace('other not started', 'not started')).join(' · ');
}

function CallPanel({ leadId, productTypeId, session, onClose }) {
  const [lead, setLead] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [phase, setPhase] = useState('dialling');  // dialling | refused | failed | ringing | live | wrap | form | saved
  const [dial, setDial] = useState(null);
  const [problem, setProblem] = useState(null);
  const [secs, setSecs] = useState(0);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(null);     // why it did not connect: no_answer | cancelled | failed
  const [focusId, setFocusId] = useState(null);
  const [others, setOthers] = useState(false);
  const [open, setOpen] = useState(null);           // the inline action showing
  const [modal, setModal] = useState(null);         // a shared action dialog
  const [log, setLog] = useState([]);
  const [notes, setNotes] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [callback, setCallback] = useState(null);   // { value, label }
  const [customWhen, setCustomWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [keep, setKeep] = useState({ changes: [], compliance: true });
  const [composerKey, setComposerKey] = useState(1);
  const [saved, setSaved] = useState(null);
  const dialled = useRef(false);

  const [meta] = useApi('/meta');
  const [brochures] = useApi('/products/brochures');
  const can = (p) => (session.permissions ?? []).includes(p);
  const done = (text) => setLog((l) => [...l, { at: clock(), text }]);

  const loadLead = () => api.get(`/leads/${leadId}`).then((l) => { setLead(l); return l; });

  async function placeCall() {
    setPhase('dialling'); setProblem(null);
    try {
      const res = await api.post(`/leads/${leadId}/call`, { product_type_id: productTypeId ?? undefined });
      setDial(res);
      if (res.simulated) { setConnected(true); setPhase('live'); } else setPhase('ringing');
    } catch (err) {
      setProblem({ message: err.message, fix: err.payload?.fix ?? null });
      setPhase(err.status === 409 ? 'refused' : 'failed');
    }
  }

  useEffect(() => {
    if (dialled.current) return;     // StrictMode runs this twice; dial once
    dialled.current = true;
    loadLead().then((l) => {
      const cards = l.cards ?? [];
      const fromCard = productTypeId && cards.find((c) => Number(c.product_type_id) === Number(productTypeId));
      const inProgress = cards.filter((c) => IN_PROGRESS.includes(c.state))
        .sort((a, b) => String(b.last_state_at ?? '').localeCompare(String(a.last_state_at ?? '')));
      setFocusId((fromCard ?? inProgress[0] ?? cards.find((c) => c.state === 'ACTIVE') ?? cards[0])?.id ?? null);
      placeCall();
    }).catch((err) => setLoadError(err.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== 'live') return undefined;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  /* A call still open is not lost to a reload without a warning. */
  useEffect(() => {
    if (!['ringing', 'live', 'wrap', 'form'].includes(phase)) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const cards = lead?.cards ?? [];
  const focus = cards.find((c) => c.id === focusId) ?? null;
  const product = (meta?.products ?? []).find((p) => p.id === focus?.product_type_id);
  const pitch = useMemo(() => {
    try { return product?.pitch_points ? JSON.parse(product.pitch_points) : []; } catch { return []; }
  }, [product]);
  const hasBrochure = (brochures?.brochures ?? []).some((b) => b.product_type_id === focus?.product_type_id);
  const simulated = Boolean(dial?.simulated);
  const openCases = (lead?.tickets ?? []).filter((t) => !['Resolved', 'Closed'].includes(t.status));

  function endCall() { setPhase('wrap'); setOpen(null); }
  function close() {
    window.dispatchEvent(new CustomEvent(LEAD_CHANGED_EVENT, { detail: { leadId } }));
    onClose();
  }

  /* ------------------------------------------------------------ actions */

  const blockedOn = (channel) => {
    const g = lead?.contactability?.[channel];
    return g && !g.service && !g.marketing ? (g.reason || `Not allowed on ${channel}`) : null;
  };
  const actions = !lead ? [] : [
    { id: 'note', icon: 'edit_note', label: 'Add a note', why: 'Saved to the timeline now' },
    can('lead.contact') && { id: 'whatsapp', icon: 'chat', label: 'Send WhatsApp', why: 'An approved template, or your own words',
      off: !lead.mobile ? 'No mobile number on file' : blockedOn('whatsapp') },
    can('lead.contact') && { id: 'sms', icon: 'sms', label: 'Send SMS', why: 'An approved template',
      off: !lead.mobile ? 'No mobile number on file' : blockedOn('sms') },
    can('lead.contact') && hasBrochure && { id: 'brochure', icon: 'description', label: 'Send brochure', why: `By email, with the ${focus?.product_name} brochure attached`,
      off: !lead.email ? 'No email address on file' : blockedOn('email') },
    can('lead.contact') && { id: 'callback', icon: 'phone_callback', label: 'Book a callback',
      why: callback ? `Set for ${callback.label}` : 'Saved with the call' },
    focus && ['INACTIVE', 'EXPLORING'].includes(focus.state) && can('card.mark.warm')
      && { id: 'warm', icon: 'trending_up', label: 'Mark Warm', why: 'Tells the Product RM desk' },
    focus && focus.state === 'WARM' && can('card.request.productrm')
      && { id: 'productrm', icon: 'support_agent', label: 'Ask for a Product RM', why: 'Hands this product over' },
    can('ticket.create') && { id: 'case', icon: 'flag', label: 'Raise a case', why: 'Routed to Customer Care' },
  ].filter(Boolean);

  function act(a) {
    if (a.off) return;
    setActionError(null);
    if (a.id === 'whatsapp' || a.id === 'sms') return setModal({ kind: 'message', lead, channel: a.id });
    if (a.id === 'brochure') return setModal({ kind: 'email', lead, brochureProductIds: [focus.product_type_id] });
    if (a.id === 'case') return setModal({ kind: 'case', lead });
    if (a.id === 'productrm') return setModal({ kind: 'product_rm', cardId: focus.id, label: focus.product_name });
    setOpen(open === a.id ? null : a.id);
  }

  async function saveNote() {
    if (!noteDraft.trim()) return;
    setBusy(true); setActionError(null);
    try {
      await api.post('/notes', { lead_id: lead.id, body: noteDraft.trim() });
      done('Note saved to the timeline.');
      setNoteDraft(''); setOpen(null);
    } catch (err) { setActionError(err.message); } finally { setBusy(false); }
  }

  async function markWarm() {
    setBusy(true); setActionError(null);
    try {
      const r = await api.post(`/cards/${focus.id}/state`, { state: 'WARM', note: 'Marked Warm on a call' });
      done((r.effects ?? [`${focus.product_name} marked Warm.`]).filter((x) => !/card history/.test(x)).join(' '));
      setOpen(null);
      await loadLead();
    } catch (err) { setActionError(err.message); } finally { setBusy(false); }
  }

  function setCallbackAt(value, label) {
    setCallback({ value, label });
    done(`Callback set for ${label}. It is saved with the call.`);
    setOpen(null);
  }

  /* ------------------------------------------------------------ wrap-up */

  async function draftWithAi() {
    setBusy(true); setActionError(null);
    try {
      const d = await api.post('/ai/disposition', { lead_id: lead.id, transcript: notes, duration_s: secs });
      setDraft(d);
      setKeep({ changes: (d.card_changes ?? []).map((c) => c.card_id), compliance: d.compliance_flag && d.compliance_flag !== 'None' });
      setComposerKey((k) => k + 1);
      setPhase('form');
    } catch (err) { setActionError(err.message); } finally { setBusy(false); }
  }

  function fillMyself() { setDraft(null); setComposerKey((k) => k + 1); setPhase('form'); }

  const minutes = connected ? Math.max(1, Math.round(secs / 60)) : 0;
  const initial = draft ? {
    type: 'Call',
    code: draft.disposition ?? '',
    body: [draft.summary, draft.follow_up_task ? `Next: ${draft.follow_up_task}` : ''].filter(Boolean).join('\n\n'),
    duration_min: minutes,
    card_id: focus?.id ?? '',
    follow_up_at: callback?.value ?? draft.follow_up_at,
    meeting_at: draft.meeting_at,
  } : {
    type: 'Call',
    code: !connected ? (attempt === 'no_answer' ? 'CALL_NO_ANSWER' : '') : callback ? 'CALL_CALLBACK' : '',
    body: notes,
    duration_min: minutes,
    card_id: focus?.id ?? '',
    follow_up_at: callback?.value,
  };

  async function onLogged(res) {
    let ai = null;
    if (draft && res?.activity?.id) {
      try {
        ai = await api.post('/ai/disposition/confirm', {
          lead_id: lead.id,
          activity_id: res.activity.id,
          card_changes: (draft.card_changes ?? []).filter((c) => keep.changes.includes(c.card_id)),
          compliance_flag: keep.compliance ? draft.compliance_flag : 'None',
          compliance_note: draft.compliance_note,
          summary: draft.summary,
        });
      } catch (err) { ai = { error: err.message }; }
    }
    setSaved({ res, ai });
    setPhase('saved');
  }

  /* ---------------------------------------------------------------- view */

  const phone = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1099px)').matches;
  const chip = (() => {
    if (phase === 'dialling') return <span className="callp-state is-ringing"><span className="dot" /> Dialling</span>;
    if (phase === 'refused') return <span className="callp-state is-blocked"><Icon name="block" size={15} /> Not called</span>;
    if (phase === 'failed') return <span className="callp-state is-blocked"><Icon name="error" size={15} /> Not placed</span>;
    if (phase === 'ringing') return <span className="callp-state is-ringing"><span className="dot" /> Ringing your phone</span>;
    if (phase === 'live') return <span className="callp-state is-live"><span className="dot" /> {simulated ? 'Simulated call' : 'On call'} <span className="callp-timer">{mmss(secs)}</span></span>;
    if (phase === 'saved') return <span className="callp-state is-saved"><Icon name="check_circle" size={15} /> Saved</span>;
    return <span className="callp-state is-ended">{connected ? 'Call ended' : 'Not connected'} · <span className="callp-timer">{mmss(secs)}</span></span>;
  })();

  return (
    <aside className="callp" role="dialog" aria-label={lead ? `Call with ${lead.name}` : 'Call'}>
      <header className="callp-head">
        <div className="callp-who">
          <span className="callp-avatar" aria-hidden="true">{(lead?.name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>
          <div className="callp-grow">
            <div className="callp-name">{lead?.name ?? 'Loading…'}</div>
            {lead && <div className="callp-sub">{[lead.mobile, lead.city, lead.language].filter(Boolean).join(' · ')}</div>}
          </div>
          {phase === 'live' && !phone && <button type="button" className="btn callp-end" onClick={endCall}>End call</button>}
          {phase === 'ringing' && !phone && <button type="button" className="btn callp-end" onClick={() => { setConnected(false); setAttempt('cancelled'); setPhase('wrap'); }}>Cancel call</button>}
          {['refused', 'failed', 'saved'].includes(phase) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={close} aria-label="Close"><Icon name="close" /></button>
          )}
        </div>
        <div className="callp-row2">
          <div className="callp-about">
            {focus && !['refused', 'failed', 'dialling'].includes(phase)
              ? <>About <b>{focus.product_name}</b> · {STATE_LABEL[focus.state] ?? focus.state}</>
              : null}
          </div>
          {chip}
        </div>
      </header>

      <div className="callp-body">
        {loadError && <ErrorBanner error={loadError} />}
        {actionError && <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />}

        {phase === 'dialling' && <div className="callp-center"><Spinner /> Placing the call…</div>}

        {phase === 'refused' && (
          <div className="callp-banner is-danger">
            <Icon name="block" />
            <div><b>Can't call {lead?.name}</b>{problem?.message}. Nothing was dialled, and nothing is logged.
              {problem?.fix && <div className="callp-small">{problem.fix}</div>}</div>
          </div>
        )}

        {phase === 'failed' && (
          <>
            <div className="callp-banner is-danger">
              <Icon name="error" />
              <div><b>The dialler didn't place the call</b>{problem?.message}
                <div className="callp-small">Try again, or log the attempt. Calls are made through the dialler only, so they are recorded and attributed.</div></div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => { setConnected(false); setAttempt('failed'); setPhase('wrap'); }}>Log the attempt</button>
              <button type="button" className="btn btn-primary" onClick={placeCall}>Try again</button>
            </div>
          </>
        )}

        {phase === 'ringing' && (
          <div className="callp-center">
            <div className="callp-ring"><Icon name="call" size={30} /></div>
            <div className="callp-big">Ringing your phone</div>
            <p className="callp-small">Pick up, and the dialler calls {lead?.name}. The call is recorded.
              {dial?.agent_mapped === false && ' You have no CUBE agent id, so this call is not attributed to you.'}</p>
            <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
              <button type="button" className="btn" onClick={() => { setConnected(false); setAttempt('no_answer'); setPhase('wrap'); }}>No answer</button>
              <button type="button" className="btn btn-primary" onClick={() => { setConnected(true); setPhase('live'); }}>They answered</button>
            </div>
          </div>
        )}

        {phase === 'live' && lead && (
          <>
            {simulated ? (
              <div className="callp-banner is-info"><Icon name="info" />
                <div><b>Simulated call</b>No call is placed: the dialler isn't connected on this server. Everything you do here is real, and saved.</div>
              </div>
            ) : (
              <div className="callp-banner is-ok"><Icon name="verified_user" /><div>Connected through CUBE. The call is being recorded.</div></div>
            )}

            {openCases.map((t) => (
              <div key={t.id} className="callp-banner is-warn"><Icon name="warning" />
                <div><b>Open case: {t.ref} · {t.priority}</b>{t.subject}</div>
              </div>
            ))}

            {focus && (
              <section className="callp-sec">
                <h3>This call is about
                  {cards.length > 1 && <button type="button" className="callp-link" onClick={() => setOthers(!others)}>{others ? 'Hide others' : 'Switch product'}</button>}
                </h3>
                <div className="callp-box">
                  <div className="row-between"><span className="callp-focus">{focus.product_name}</span>
                    <span className={`callp-chip k-${focus.state}`}>{STATE_LABEL[focus.state] ?? focus.state}</span></div>
                  {focus.product_rm_name && <div className="callp-small">Product RM: {focus.product_rm_name}</div>}
                  {pitch.length > 0 && <ul className="callp-pitch">{pitch.slice(0, 4).map((p) => <li key={p}>{p}</li>)}</ul>}
                  {product && (
                    <div className="callp-facts">
                      {product.min_investment > 0 && <span>Min {money(product.min_investment)}</span>}
                      {product.lock_in && <span>Lock-in {product.lock_in}</span>}
                      {product.risk_category && <span>{product.risk_category} risk</span>}
                    </div>
                  )}
                  {hasBrochure && (
                    <a className="btn btn-sm" style={{ marginTop: 10 }} href={`/api/products/${focus.product_type_id}/brochure`} target="_blank" rel="noreferrer">
                      <Icon name="description" size={15} /> Open brochure
                    </a>
                  )}
                  <div className="callp-others">
                    {otherCounts(cards, focus.id) || 'No other products'}
                    {others && (
                      <div className="callp-olist">
                        {[...cards].filter((c) => c.id !== focus.id)
                          .sort((a, b) => (a.state === 'INACTIVE') - (b.state === 'INACTIVE'))
                          .map((c) => (
                            <button type="button" key={c.id} onClick={() => { setFocusId(c.id); setOthers(false); setOpen(null); }}>
                              <span>{c.product_name}</span><span className={`callp-chip k-${c.state}`}>{STATE_LABEL[c.state] ?? c.state}</span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            <section className="callp-sec">
              <h3>Do it now</h3>
              <div className="callp-acts">
                {actions.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={`callp-act ${open === a.id ? 'is-open' : ''}`}
                    aria-disabled={a.off ? 'true' : undefined}
                    title={a.off || undefined}
                    onClick={() => act(a)}
                  >
                    <span className="t"><Icon name={a.icon} size={17} /> {a.label}</span>
                    <span className="why">{a.off || a.why}</span>
                  </button>
                ))}
              </div>
              {focus && focus.state === 'PRODUCT_RM_ENGAGED' && (
                <div className="callp-small">Mark Warm is not offered: {focus.product_name} is already past Warm, with a Product RM.</div>
              )}

              {open === 'note' && (
                <div className="callp-inline">
                  <textarea rows={3} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="A note for the timeline" />
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setOpen(null)}>Cancel</button>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy || !noteDraft.trim()} onClick={saveNote}>Save note</button>
                  </div>
                </div>
              )}
              {open === 'callback' && (
                <div className="callp-inline">
                  <p>When should you call back? It is saved with the call, as its follow-up.</p>
                  <div className="row wrap" style={{ gap: 6 }}>
                    {callbackPresets().map((p) => (
                      <button type="button" key={p.value} className="btn btn-sm" onClick={() => setCallbackAt(p.value, p.label)}>{p.label}</button>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <input type="datetime-local" value={customWhen} onChange={(e) => setCustomWhen(e.target.value)} aria-label="Pick a time" />
                    <button type="button" className="btn btn-sm" disabled={!customWhen}
                      onClick={() => setCallbackAt(customWhen, istLabel(new Date(`${customWhen}:00+05:30`)))}>
                      Set
                    </button>
                  </div>
                </div>
              )}
              {open === 'warm' && focus && (
                <div className="callp-inline">
                  <p>{focus.product_name}: {STATE_LABEL[focus.state] ?? focus.state} → <b>Warm</b>. Its Product RMs are told, for awareness.</p>
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setOpen(null)}>Cancel</button>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={markWarm}>Mark Warm</button>
                  </div>
                </div>
              )}
            </section>

            <section className="callp-sec">
              <h3>Call notes</h3>
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Type as you talk. They go into the wrap-up, and the AI drafts from them." />
            </section>

            <DoneOnThisCall log={log} />

            <details className="callp-sec callp-glance">
              <summary><h3>At a glance <Icon name="expand_more" size={16} /></h3></summary>
              <div className="callp-kv">
                <span>Stage</span><span>{lead.stage}{lead.kyc_status ? ` · KYC ${lead.kyc_status}` : ''}</span>
                <span>Owner</span><span>{lead.owner_name || '—'}</span>
                <span>Risk profile</span><span>{lead.risk_profile || '—'}</span>
                <span>Language</span><span>{lead.language || '—'}</span>
                {lead.activities?.[0] && <><span>Last activity</span><span>{lead.activities[0].subject}</span></>}
              </div>
            </details>
          </>
        )}

        {phase === 'wrap' && lead && (
          <>
            <section className="callp-sec">
              <h3>{connected ? 'How did it go?' : 'Log the attempt'}</h3>
              <p className="callp-small" style={{ marginTop: 0 }}>
                Every call is saved with an outcome. Draft it with the AI from your notes, or fill it in yourself.
              </p>
              <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Your call notes" />
              {simulated && (
                <details className="callp-demo">
                  <summary><span className="callp-demo-tag">Demo only</span> Use a sample transcript</summary>
                  <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                    {SAMPLE_TRANSCRIPTS.map(([label, text]) => (
                      <button type="button" key={label} className="btn btn-sm" onClick={() => setNotes(text)}>{label}</button>
                    ))}
                  </div>
                </details>
              )}
              {!simulated && connected && <p className="callp-small">CUBE's recording is attached to the call when it closes.</p>}
            </section>
            <DoneOnThisCall log={log} />
          </>
        )}

        {phase === 'form' && lead && (
          <>
            {draft && (
              <section className="callp-sec">
                <div className="callp-banner is-info"><Icon name="auto_awesome" />
                  <div><b>Drafted by the AI from your notes</b>Check it below. Nothing is saved until you save the call.
                    {!draft.disposition && ' It could not match an outcome Setup offers, so choose one.'}</div>
                </div>
                {(draft.card_changes ?? []).length > 0 && (
                  <div className="callp-box" style={{ marginTop: 10 }}>
                    <div className="callp-small" style={{ marginTop: 0, fontWeight: 600 }}>Product changes it suggests</div>
                    {draft.card_changes.map((c) => (
                      <label key={c.card_id} className="callp-check">
                        <input type="checkbox" checked={keep.changes.includes(c.card_id)}
                          onChange={(e) => setKeep((k) => ({ ...k, changes: e.target.checked ? [...k.changes, c.card_id] : k.changes.filter((x) => x !== c.card_id) }))} />
                        <span><b>{c.product_name}</b>: {STATE_LABEL[c.from_state] ?? c.from_state} → {STATE_LABEL[c.to_state] ?? c.to_state}
                          <span className="callp-evidence">{c.evidence}</span></span>
                      </label>
                    ))}
                  </div>
                )}
                {draft.compliance_flag && draft.compliance_flag !== 'None' && (
                  <label className="callp-check callp-box is-warn" style={{ marginTop: 10 }}>
                    <input type="checkbox" checked={keep.compliance} onChange={(e) => setKeep((k) => ({ ...k, compliance: e.target.checked }))} />
                    <span><b>Compliance: {draft.compliance_flag}</b> {draft.compliance_note} A case is opened for Compliance when you save.</span>
                  </label>
                )}
              </section>
            )}
            <ActivityComposer
              key={composerKey}
              lead={lead}
              cards={cards}
              lockType
              initial={initial}
              title="Save the call"
              subtitle="With one of Setup's outcomes"
              submitLabel="Save the call"
              onLogged={onLogged}
            />
          </>
        )}

        {phase === 'saved' && saved && (
          <>
            <div className="callp-center">
              <div className="callp-done"><Icon name="check" size={28} /></div>
              <div className="callp-big">Saved to {lead?.name}'s timeline</div>
            </div>
            <ul className="callp-results">
              {saved.res?.confirmation && <li><Icon name="check_circle" size={16} /> {saved.res.confirmation}</li>}
              {(saved.res?.effects ?? []).map((e, i) => <li key={`e${i}`}><Icon name="check_circle" size={16} /> {typeof e === 'string' ? e : e.text ?? JSON.stringify(e)}</li>)}
              {(saved.ai?.cards_updated ?? []).map((c) => <li key={`u${c.card_id}`}><Icon name="check_circle" size={16} /> {(c.effects ?? [])[0]}</li>)}
              {(saved.ai?.cards_refused ?? []).map((c) => <li key={`r${c.card_id}`} className="is-warn"><Icon name="warning" size={16} /> {c.product_name ?? c.product_code}: {c.reason}</li>)}
              {saved.ai?.compliance_ticket_id && <li><Icon name="flag" size={16} /> A compliance case was opened for Customer Care.</li>}
              {saved.ai?.error && <li className="is-warn"><Icon name="warning" size={16} /> The call is saved, but the AI's extras were not applied: {saved.ai.error}</li>}
            </ul>
            <DoneOnThisCall log={log} />
          </>
        )}
      </div>

      {phase === 'live' && phone && (
        <footer className="callp-foot"><button type="button" className="btn callp-end callp-end-wide" onClick={endCall}>End call · <span className="callp-timer">{mmss(secs)}</span></button></footer>
      )}
      {phase === 'ringing' && phone && (
        <footer className="callp-foot"><button type="button" className="btn callp-end callp-end-wide" onClick={() => { setConnected(false); setAttempt('cancelled'); setPhase('wrap'); }}>Cancel call</button></footer>
      )}
      {phase === 'wrap' && (
        <footer className="callp-foot">
          <button type="button" className="btn" onClick={fillMyself}>Fill it in myself</button>
          <span className="callp-grow" />
          <button type="button" className="btn btn-primary" disabled={busy || !notes.trim()} onClick={draftWithAi}
            title={notes.trim() ? undefined : 'Add your call notes first'}>
            {busy ? <Spinner /> : <Icon name="auto_awesome" size={16} />} Draft with AI
          </button>
        </footer>
      )}
      {phase === 'form' && (
        <footer className="callp-foot"><button type="button" className="btn" onClick={() => setPhase('wrap')}>Back</button></footer>
      )}
      {['refused', 'saved'].includes(phase) && (
        <footer className="callp-foot"><span className="callp-grow" /><button type="button" className="btn btn-primary" onClick={close}>Close</button></footer>
      )}

      {modal && (
        <ActionModal
          state={modal}
          session={session}
          onClose={() => setModal(null)}
          onNotice={(msg) => { if (msg) done(msg); }}
          onDone={() => {
            if (modal.kind === 'product_rm') done(`Product RM requested for ${modal.label}.`);
            setModal(null);
            loadLead();
          }}
        />
      )}
    </aside>
  );
}

function DoneOnThisCall({ log }) {
  return (
    <section className="callp-sec">
      <h3>Done on this call</h3>
      {log.length === 0
        ? <div className="callp-small">Nothing yet. What you do here is saved straight away, and listed here.</div>
        : (
          <ul className="callp-log">
            {log.map((l, i) => <li key={i}><time>{l.at}</time><Icon name="check_circle" size={16} /><span>{l.text}</span></li>)}
          </ul>
        )}
    </section>
  );
}
