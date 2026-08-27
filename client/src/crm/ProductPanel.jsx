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
import { api, rupees, dateTime, shortDate, appUrl } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal } from '../components/ui.jsx';

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

export default function ProductPanel({ cardId, onClose, onDone, onError, onContact }) {
  const [d, { loading, error, reload }] = useApi(cardId ? `/cards/${cardId}/detail` : null, [cardId]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [showMoves, setShowMoves] = useState(false);

  if (loading && !d) return <Modal title="Loading…" onClose={onClose}><Loading /></Modal>;
  if (error) return <Modal title="Product" onClose={onClose}><ErrorBanner error={error} /></Modal>;
  if (!d) return null;

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); onDone?.(); }
    catch (e) { onError?.(e.message); setBusy(false); }
  };

  const move = (to) => act(() => api.post(`/cards/${d.id}/state`, { state: to, note: note || undefined }));

  const perform = async (action) => {
    if (!action || !action.allowed) return;
    switch (action.kind) {
      case 'state': return move(action.to);
      case 'rm': return act(() => api.post(`/cards/${d.id}/request-product-rm`, {
        reason: note || 'Sales RM requested product expertise',
      }));
      case 'kyc': return act(async () => {
        const j = await api.post('/kyc/journeys', { lead_id: d.lead_id, card_id: d.id });
        window.open(appUrl(`/dkyc/resume/${j.resume_token}`), '_blank', 'noopener');
      });
      case 'kyc_view':
        if (d.kyc?.resume_token) {
          window.open(appUrl(`/dkyc/resume/${d.kyc.resume_token}`), '_blank', 'noopener');
        }
        return undefined;
      default: return undefined;
    }
  };

  const next = d.next;

  return (
    <Modal
      title={d.product_name}
      subtitle={`${d.lead_name} · ${next.state_label}${next.days_in_state ? ` for ${next.days_in_state} days` : ''}`}
      onClose={onClose}
      wide
    >
      <div className="stack" style={{ gap: 14 }}>

        {/* 1 — the directive. Named, not implied. */}
        <div className={`next-step ${next.urgent ? 'is-urgent' : ''}`}>
          <div className="next-step-head">
            <Icon name={next.urgent ? 'priority_high' : 'arrow_forward'} size={18} />
            <span className="next-step-title">{next.headline}</span>
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
            {/* The obvious move is not always the right one, so every legal
                transition stays beside the suggestion rather than behind it. */}
            {next.alternatives.length > 0 && (
              <button className="btn-ghost btn-sm" onClick={() => setShowMoves((v) => !v)}>
                {showMoves ? 'Hide other moves' : 'Other moves'}
              </button>
            )}
          </div>

          {showMoves && (
            <div className="stack" style={{ gap: 8, marginTop: 10 }}>
              <div className="field">
                <label htmlFor="pp-note">Note (optional)</label>
                <input id="pp-note" value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Why this move — shows in the card history" />
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {next.alternatives.map((a) => (
                  <button key={a.to} className="btn-sm" disabled={busy} onClick={() => move(a.to)}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

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
