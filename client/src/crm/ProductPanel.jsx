/**
 * One product, against one lead (ENH-10b, ENH-10c, ENH-10d).
 *
 * The pop-up this replaces showed a pitch list and a row of state buttons. That
 * is a reference card, not a working surface: it did not say how long the card
 * had been sitting, what had already been tried on it, whether the client could
 * lawfully be contacted, or — the actual complaint — what "Move Forward" meant.
 *
 * The order here is the order the questions get asked on a call:
 *
 *   1. What should I do next, and why?          the directive (10b)
 *   2. How do I do it right now?                quick actions (10d)
 *   3. What do I need to know to say it well?   the product (10c)
 *   4. What has already been tried?             history (10c)
 *
 * Every channel is consent-checked before it is offered, so a button that would
 * be refused after the click is shown disabled with the reason instead. An RM
 * learns something from "no WhatsApp — they opted out"; they learn nothing from
 * a button that fails.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rupees, dateTime, shortDate, appUrl, STATE_LABEL } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal, Outcome } from '../components/ui.jsx';
import RequestProductRm from './ProductRmRequest.jsx';

const CHANNEL = {
  call: { label: 'Start a call', icon: 'call' },
  whatsapp: { label: 'Send a WhatsApp', icon: 'chat' },
  sms: { label: 'Send an SMS', icon: 'sms' },
  email: { label: 'Send an email', icon: 'mail' },
};

const STATE_BADGE = {
  ACTIVE: 'badge-green',
  WARM: 'badge-amber',
  PRODUCT_RM_ENGAGED: 'badge-amber',
  KYC_IN_PROGRESS: 'badge-blue',
  EXPLORING: 'badge-blue',
  LOST: 'badge-red',
  ON_HOLD: 'badge-amber',
};

export default function ProductPanel({ cardId, me, onClose, onDone, onContact, onCrossSell }) {
  const navigate = useNavigate();
  const [d, { loading, error, reload }] = useApi(cardId ? `/cards/${cardId}/detail` : null, [cardId]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState(null);
  /* Part 4, items 8.2 to 8.4: the handover dialog, and what an action did. */
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState(null);

  if (loading && !d) return <Modal title="Loading…" onClose={onClose}><Loading /></Modal>;
  if (error) return <Modal title="Product" onClose={onClose}><ErrorBanner error={error} /></Modal>;
  if (!d) return null;

  /* What it did, until OK; then the panel closes and the lead reloads. */
  if (outcome) return <Outcome title={outcome.title} lines={outcome.lines} tone={outcome.tone} onClose={() => onDone?.()} />;
  if (asking) {
    return (
      <RequestProductRm cardId={d.id} onCancel={() => setAsking(false)}
        onDone={(result) => { setAsking(false); setOutcome(result); }} />
    );
  }

  /* QA-42. A refusal went to the lead page, behind this panel, so a move that
     failed looked like a button that did nothing. It is said here, where the
     button is. Part 4, item 8.4: and what worked says what it did. */
  const act = async (fn) => {
    setBusy(true);
    setFailed(null);
    try { const said = await fn(); if (said) setOutcome(said); else onDone?.(); }
    catch (e) { setFailed(e.message); setBusy(false); }
  };

  // QA-42: a move that worked says so. Part 4, item 8.4: and everything it set off.
  const move = (to) => act(async () => {
    const r = await api.post(`/cards/${d.id}/state`, { state: to, note: note || undefined });
    return { title: `${d.product_name} is now ${STATE_LABEL[r.to] ?? r.to}`, lines: r.effects ?? [`${d.product_name} is now ${STATE_LABEL[r.to] ?? r.to}.`] };
  });

  const perform = async (action) => {
    if (!action || !action.allowed) return;
    switch (action.kind) {
      case 'state': return move(action.to);
      // Part 4, items 8.2 and 8.3: who is asked, what they get, and the handover -- before anything is sent.
      case 'rm': return setAsking(true);
      case 'kyc': return act(async () => {
        const j = await api.post('/kyc/journeys', { lead_id: d.lead_id, card_id: d.id });
        window.open(appUrl(`/dkyc/resume/${j.resume_token}`), '_blank', 'noopener');
        return {
          title: 'KYC started',
          lines: [
            `A KYC application for ${d.product_name} was started for ${d.lead_name}.`,
            'It opened in a new tab, at its first step. Its progress shows on this product and on the KYC board.',
          ],
        };
      });
      case 'kyc_view':
        if (d.kyc?.resume_token) {
          window.open(appUrl(`/dkyc/resume/${d.kyc.resume_token}`), '_blank', 'noopener');
        }
        return undefined;
      /* Close the panel and open the products the lead is not on. The list is
         already there, collapsed, a scroll below -- this is the button that
         admits it exists. */
      case 'cross_sell':
        onCrossSell?.();
        return undefined;
      case 'review': return act(async () => {
        const t = await api.post('/tasks', {
          title: `Review ${d.product_name}`,
          description: note || null,
          lead_id: d.lead_id,
          card_id: d.id,
          due_at: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 19).replace('T', ' '),
        });
        return { title: 'Review scheduled', lines: [`A task “${t.title}” is on your list, due ${dateTime(t.due_at)}.`] };
      });
      default: return undefined;
    }
  };

  /* Part 4, item 8.2: talk it over with the people on a handover. */
  const message = async (userId) => {
    setFailed(null);
    try {
      const out = await api.post('/messages/conversations', { user_id: userId });
      navigate(`/messages?c=${out.id}`);
    } catch (e) { setFailed(e.message); }
  };

  const next = d.next;
  const at = next.path.findIndex((p) => p.code === d.state);
  const recommended = next.primary?.kind === 'state' ? next.primary.to : null;

  return (
    <Modal
      title={d.product_name}
      subtitle={`${d.lead_name} · ${next.state_label}${next.days_in_state ? ` for ${next.days_in_state} days` : ''}`}
      onClose={onClose}
      wide
    >
      <div className="stack" style={{ gap: 14 }}>
        <ErrorBanner error={failed} onDismiss={() => setFailed(null)} />

        {/* Part 4, item 8.1: where the card is on the road. */}
        <div>
          <ol className="stage-track" aria-label="Stages">
            {next.path.map((p, i) => (
              <li key={p.code} className={i === at ? 'is-current' : at > -1 && i < at ? 'is-done' : undefined}
                aria-current={i === at ? 'true' : undefined}>
                {p.label}
              </li>
            ))}
          </ol>
          {at === -1 && (
            <div className="tiny muted" style={{ marginTop: 6 }}>
              Now <strong>{next.state_label}</strong>, which is off the road above.
            </div>
          )}
        </div>

        {/* 1 — the directive. Named, not implied. */}
        <div className={`next-step ${next.urgent ? 'is-urgent' : ''}`}>
          <div className="next-step-head">
            <Icon name={next.urgent ? 'priority_high' : 'arrow_forward'} size={18} />
            <span className="next-step-title">Recommended: {next.headline}</span>
          </div>
          <p className="next-step-why">{next.why}</p>

          <div className="row wrap" style={{ gap: 8 }}>
            {next.primary && next.primary.kind !== 'none' && (
              <button className="btn-primary" disabled={busy || !next.primary.allowed}
                title={next.primary.blocked_reason ?? undefined}
                onClick={() => perform(next.primary)}>
                {busy ? 'Working…' : next.primary.label}
              </button>
            )}
            {next.second && (
              <button className="btn" disabled={busy || !next.second.allowed}
                title={next.second.hint ?? next.second.blocked_reason ?? undefined}
                onClick={() => perform(next.second)}>
                {next.second.label}
              </button>
            )}
          </div>
          {next.primary?.kind === 'rm' && (
            <p className="tiny muted" style={{ margin: '8px 0 0' }}>
              You see who is asked and what they get, and write the handover, before anything is sent.
            </p>
          )}
        </div>

        {/* Part 4, item 8.1: every move from here, what it means and what it
            sets off -- not hidden behind a button. The legal moves are the
            server's (engine/nextaction.js), so what is offered is what the
            move will accept. */}
        {next.alternatives.length > 0 && (
          <div className="moves">
            <div className="row-between" style={{ alignItems: 'baseline' }}>
              <div className="field-label">Every move from {next.state_label}</div>
              <span className="tiny muted">Choose by what the client said</span>
            </div>
            <div className="move-list">
              {next.alternatives.map((a) => (
                <div key={a.to} className={`move ${a.allowed === false ? 'is-blocked' : ''}`}>
                  <div className="move-text">
                    <strong>
                      {a.label}
                      {a.to === recommended && <span className="badge badge-accent" style={{ marginLeft: 6 }}>Recommended</span>}
                    </strong>
                    <span className="small">{a.means}</span>
                    {a.sets_off && <span className="tiny muted">{a.sets_off}</span>}
                    {a.allowed === false && <span className="tiny muted">Your role cannot make this move.</span>}
                  </div>
                  <button type="button" className="btn btn-sm" disabled={busy || a.allowed === false}
                    title={a.blocked_reason ?? undefined} onClick={() => move(a.to)}>
                    Move to {a.label}
                  </button>
                </div>
              ))}
            </div>
            <div className="field" style={{ marginBottom: 0, marginTop: 10 }}>
              <label htmlFor="pp-note">Why (optional, kept in the card history)</label>
              <input id="pp-note" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="They want to wait until their bonus in March" />
            </div>
          </div>
        )}

        {/* Part 4, item 8.2: the handovers on this product, for the owner and
            the Product RM alike, and a way to talk it over. */}
        {d.rm_requests?.length > 0 && (
          <div className="card">
            <div className="card-head">
              <h3 style={{ fontSize: 14, margin: 0 }}>Handovers</h3>
              <span className="tiny muted">{d.rm_requests.length} Product RM request{d.rm_requests.length === 1 ? '' : 's'}</span>
            </div>
            <div className="card-body stack" style={{ gap: 12 }}>
              {d.rm_requests.map((r) => {
                const people = [{ id: r.requested_by, name: r.requested_by_name }, ...r.asked]
                  .filter((p, i, all) => p.id && p.id !== me && all.findIndex((q) => q.id === p.id) === i);
                return (
                  <div key={r.id} className="handover">
                    <div className="tiny muted">{dateTime(r.created_at)} · {r.requested_by_name ?? 'Someone'} asked {r.asked.map((a) => a.name).join(', ')}</div>
                    <div className="small"><strong>Needs to know:</strong> {r.needs_to_know}</div>
                    {r.status_summary && <div className="small muted">{r.status_summary}</div>}
                    {r.conversations && (
                      <details>
                        <summary className="tiny">Conversations so far</summary>
                        <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.conversations}</div>
                      </details>
                    )}
                    {people.length > 0 && (
                      <div className="row wrap" style={{ gap: 6 }}>
                        {people.map((p) => (
                          <button key={p.id} type="button" className="btn btn-sm" onClick={() => message(p.id)}>
                            <Icon name="chat" size={15} /> Message {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2 — do it now (ENH-10d). */}
        <div>
          <div className="field-label">Reach them now</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {d.channels.map((c) => {
              const meta = CHANNEL[c.channel];
              return (
                <button key={c.channel} className="btn-sm" disabled={!c.allowed}
                  title={c.allowed ? undefined : c.reason}
                  onClick={() => onContact?.(c.channel)}>
                  <Icon name={meta.icon} size={15} /> {meta.label}
                </button>
              );
            })}
          </div>
          {d.channels.some((c) => !c.allowed) && (
            <div className="tiny muted" style={{ marginTop: 5 }}>
              A greyed channel is a consent or contact-detail problem, not a fault — hover to see which.
            </div>
          )}
        </div>

        {/* 3 — what to say. */}
        <div className="grid-2">
          <div className="card">
            <div className="card-head"><h3 style={{ fontSize: 14, margin: 0 }}>Pitch</h3></div>
            <div className="card-body">
              {d.pitch_points.length === 0 && <span className="muted small">No pitch points recorded.</span>}
              <ul className="small" style={{ margin: 0, paddingLeft: 17 }}>
                {d.pitch_points.map((p, i) => <li key={i} style={{ marginBottom: 4 }}>{p}</li>)}
              </ul>
              <div className="row wrap" style={{ gap: 5, marginTop: 9 }}>
                {d.min_investment > 0 && <span className="badge">Min {rupees(d.min_investment)}</span>}
                {d.lock_in && <span className="badge">Lock-in {d.lock_in}</span>}
                {d.risk_category && <span className="badge">{d.risk_category} risk</span>}
                {d.value > 0 && <span className="badge badge-green">{rupees(d.value)} booked</span>}
                {d.product_rm_name && <span className="badge badge-blue">RM {d.product_rm_name}</span>}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3 style={{ fontSize: 14, margin: 0 }}>If they push back</h3></div>
            <div className="card-body stack" style={{ gap: 9 }}>
              {d.objections.length === 0 && <span className="muted small">No objections recorded.</span>}
              {d.objections.map((o, i) => (
                <div key={i}>
                  <div className="small" style={{ fontWeight: 600 }}>“{o.objection ?? o}”</div>
                  {o.response && <div className="small muted">{o.response}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 4 — what has already been tried. */}
        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h3 style={{ fontSize: 14, margin: 0 }}>Already tried</h3>
              <span className="tiny muted">{d.activities.length} on this product</span>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {d.activities.length === 0 && (
                <Empty>Nothing logged against this product yet.</Empty>
              )}
              {d.activities.slice(0, 6).map((a) => (
                <div key={a.id}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="badge">{a.type}</span>
                    {a.sub_disposition && <span className="badge badge-amber">{a.sub_disposition}</span>}
                    <span className="tiny muted">{dateTime(a.created_at)}</span>
                  </div>
                  {a.body && <div className="small muted">{a.body.slice(0, 140)}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3 style={{ fontSize: 14, margin: 0 }}>How it got here</h3>
              <span className="tiny muted">{d.history.length} changes</span>
            </div>
            <div className="card-body stack" style={{ gap: 7 }}>
              {d.history.length === 0 && <Empty>No stage changes yet.</Empty>}
              {d.history.slice(0, 6).map((h, i) => (
                <div key={i} className="small">
                  <span className="muted">{h.from_state || '—'}</span>
                  {' → '}
                  <strong>{h.to_state}</strong>
                  <span className="tiny muted"> · {shortDate(h.created_at)}{h.user_name ? ` · ${h.user_name}` : ''}</span>
                  {h.note && <div className="tiny muted">{h.note}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {d.kyc && (
          <div className="notice notice-ok">
            <Icon name="verified_user" size={17} />
            <span>
              KYC journey is <strong>{d.kyc.status}</strong>
              {d.kyc.current_step ? ` at "${d.kyc.current_step}"` : ''}.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
