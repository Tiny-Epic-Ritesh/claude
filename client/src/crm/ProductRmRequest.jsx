/**
 * Ask for a Product RM, with a handover (Part 4, items 8.2 and 8.3).
 *
 * The button used to ask at once: a High-priority task appeared on every
 * Product RM's list, with a notification and an SMS, and the person who
 * pressed it was told none of that, nor who had been asked, nor how they had
 * been chosen -- and the Product RM got the client's name and nothing else.
 *
 * Now it says who will be asked and why them, what each of them gets, and
 * takes the handover: where the lead and the product stand and what has been
 * said, both drafted from the record for the owner to correct, and what the
 * Product RM needs to know before approaching the client, which only the owner
 * can write. The handover goes into each Product RM's task and stays on the
 * product, where both sides see it (ProductPanel's "Handovers").
 */

import { useEffect, useState } from 'react';
import { api, dateTime } from '../api.js';
import { useApi, Loading, Confirm, Outcome } from '../components/ui.jsx';

/* The request and then what it did, as one flow for screens that hold no
   outcome of their own -- the lead header's next step. */
export function ProductRmFlow({ cardId, onClose, onDone }) {
  const [outcome, setOutcome] = useState(null);
  if (outcome) return <Outcome title={outcome.title} lines={outcome.lines} onClose={() => { onDone?.(); onClose?.(); }} />;
  return <RequestProductRm cardId={cardId} onCancel={onClose} onDone={setOutcome} />;
}

export default function RequestProductRm({ cardId, onCancel, onDone }) {
  const [info, { loading, error }] = useApi(`/cards/${cardId}/product-rm-request`, [cardId]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    if (info && !form) {
      setForm({ status_summary: info.draft.status_summary, conversations: info.draft.conversations, needs_to_know: '' });
    }
  }, [info, form]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const ready = info?.asked?.length > 0 && form?.needs_to_know.trim().length >= 10;

  async function confirm() {
    setBusy(true);
    setFailed(null);
    try {
      const r = await api.post(`/cards/${cardId}/request-product-rm`, { handover: form });
      const names = r.product_rms.join(' and ');
      const one = r.product_rms.length === 1;
      onDone({
        title: 'Product RM requested',
        lines: [
          `Asked ${names}, the ${r.product} Product RM${one ? '' : 's'}.`,
          `A High-priority task is on ${one ? 'their' : 'each of their'} list${one ? '' : 's'}, due ${dateTime(r.task_due_at)}, with your handover in it.`,
          `${one ? 'They were' : 'Each was'} notified in the CRM${r.texted ? `, and ${r.texted} by SMS` : ''}.`,
          `The card stays Warm until ${one ? 'they take' : 'one of them takes'} it on. Your handover is under Handovers on ${r.product}, where you can message them too.`,
        ],
      });
    } catch (err) { setFailed(err.message); setBusy(false); }
  }

  return (
    <Confirm title="Ask for a Product RM?" subtitle={info ? `${info.lead} · ${info.product}` : undefined}
      confirmLabel="Send request" busy={busy} error={failed || error} disabled={!ready}
      onConfirm={confirm} onCancel={onCancel}>
      {loading && !info && <Loading label="Finding the Product RMs…" />}
      {info && form && (
        <>
          <p className="confirm-lead">
            {info.asked.length
              ? `This asks ${info.asked.map((a) => a.name).join(' and ')} to help with ${info.lead} on ${info.product}.`
              : `Nobody can be asked about ${info.product} yet.`}
          </p>
          <div>
            <h3>Who is asked</h3>
            <p className="small" style={{ margin: 0 }}>{info.how}</p>
          </div>
          {info.asked.length > 0 && (
            <div>
              <h3>Each of them gets</h3>
              <ul>{info.each_gets.map((e) => <li key={e}>{e}</li>)}</ul>
              <p className="tiny muted" style={{ margin: '6px 0 0' }}>{info.stays}</p>
            </div>
          )}
          {info.previous.length > 0 && (
            <div className="notice">
              <p>
                Asked before: {info.previous.map((p) => `${dateTime(p.created_at)} by ${p.requested_by_name ?? 'someone'}`).join('; ')}.
                The latest handover is on the product.
              </p>
            </div>
          )}
          {info.asked.length > 0 && (
            <div className="stack" style={{ gap: 10 }}>
              <h3>Handover</h3>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="rm-needs">What they need to know before approaching {info.lead}</label>
                <textarea id="rm-needs" value={form.needs_to_know} onChange={set('needs_to_know')} autoFocus
                  placeholder="Wants a SIP of about ₹10,000 a month; worried about lock-in; best reached after 6 pm in Hindi." style={{ minHeight: 76 }} />
                {form.needs_to_know.trim().length < 10 && (
                  <div className="hint">A sentence at least: this is the part only you can write.</div>
                )}
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="rm-status">Where the lead and the product stand</label>
                <textarea id="rm-status" value={form.status_summary} onChange={set('status_summary')} style={{ minHeight: 56 }} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="rm-talk">Conversations so far</label>
                <textarea id="rm-talk" value={form.conversations} onChange={set('conversations')} style={{ minHeight: 96 }} />
                <div className="hint">Drafted from the latest interactions on the lead. Change anything that is wrong.</div>
              </div>
            </div>
          )}
        </>
      )}
    </Confirm>
  );
}
